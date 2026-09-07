import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { playerStore } from "../waxml-integration/player-store.js";
import {
	readSectionInfo,
	getLayers,
	getSegments,
	getOptions,
	readPos,
	readLength,
	parseDivision,
	secondsToLengthString,
	sectionContentDuration,
	groupCompositionSections
} from "../xml-editor/section-model.js";
import { findSrcAttribute, resolvePlayableUrl } from "../xml-editor/src-attribute.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";

// Composition preview (see wa-preview.js) — a sibling of wa-section-view.js
// at the same visual level (ruler on top, rows below, pinch/button zoom),
// but rows show <Section>s in playback sequence instead of a Section's own
// <Layer>s. Regular Sections (no from/to) play indefinitely (looping
// Layers) until another Section is triggered; "transition" Sections (from/
// to set) play automatically between two regular Sections at a sync point.
//
// Nothing is imported from wa-section-view.js itself — that file is one
// enormous class tightly coupled to Layer-rendering; only the shared,
// DOM-free math in section-model.js is reused. The zoom/ruler/drag
// *techniques* are mirrored, not imported.
//
// Engine-side auto-selection of the right transition (from/to/syncTo) is
// being built by Hans in waxml.js in parallel, with different/placeholder
// syntax for now — this view only produces schema-correct XML and does
// its best for live-trigger/pending feedback; full engine integration is
// tested once both sides land.

const MIN_PX_PER_SEC = 5;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 30;
const MIN_ROW_HEIGHT = 28;
const MAX_ROW_HEIGHT = 120;
const DEFAULT_ROW_HEIGHT = 48;
const RULER_HEIGHT = 28;

// Blank runway rendered before time 0, purely so there's always somewhere
// to scroll *into* — a row-0 transition's own left edge never actually
// moves (see _wireEdgeDrag's "scrollFollowsCursor"), so dragging it keeps
// scrolling the whole timeline instead; without this pad, scrollLeft hits
// its hard 0 floor the moment time-0 content is already at the left edge
// of the viewport, and the illusion of "the edge follows your cursor"
// visibly breaks. Fixed rather than grown live during a drag (simpler,
// and a single mouse gesture can't physically travel further than the
// screen it's on anyway) — per Hans (2026-09-07): "jag tycker den ska
// scrolla ut objekten ur vyn om man drar ... så långt till vänster."
const LEFT_PAD_PX = 4000;

const GAP_BARS_DEFAULT = 2;
const TRANSITION_LEFT_MARGIN_BARS = 1;
const DEFAULT_TRANSITION_LENGTH = "2"; // bars, per Hans (2026-09-08)

const MIN_TRANSITION_BARS = 0.25; // drag-resize floor, in bars of the transition's own tempo
const WAVEFORM_COLOR = "#4fa3ff"; // same as wa-section-view.js's own WAVEFORM_COLOR

// label > id > class > tagName, per Hans (2026-09-08, reverting the
// label/class/id order from 2026-09-07) — class shown as just its first
// token (a Section's class can hold more than one, same convention as
// firstSelector below).
function displayLabel(node) {
	const firstClass = (node.attributes.class || "").trim().split(/\s+/)[0];
	return node.attributes.label || node.attributes.id || firstClass || node.tagName;
}

function firstSelector(node) {
	const firstClass = (node.attributes.class || "").trim().split(/\s+/)[0];
	if (firstClass) return `.${firstClass}`;
	return `#${node.attributes.id}`;
}

// Grid-snapping for a transition edge drag (see _wireEdgeDrag) — same
// "finest resolution whose on-screen spacing is still usable at the
// current zoom" idea as wa-section-view.js's own _effectiveGridBeats,
// reimplemented locally (self-contained, no user-facing resolution cap
// menu here, just automatic zoom-adaptive snapping per Hans, 2026-09-05).
const GRID_RESOLUTIONS_BEATS = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
const MIN_GRID_SPACING_PX = 6;

// Pure layout: turns a <Composition>'s children into a flat list of boxes
// (regular Sections, transitions, "+" buttons) plus a parallel list of
// ruler columns (one per x-range slot, including blank gaps), all in
// seconds — the component converts to pixels via `_pxPerSecond` at render
// time. Left-to-right accumulation only.
function computeLayout(compositionNode) {
	const { regulars, transitionsByTargetId, orphans } = groupCompositionSections(compositionNode);
	const cells = [];
	const columns = [];
	let cursor = 0;

	regulars.forEach((section) => {
		const sectionInfo = readSectionInfo(section, compositionNode);
		const transitions = transitionsByTargetId.get(section.id) || [];

		if (transitions.length === 0) {
			const gapSeconds = sectionInfo.barDuration * GAP_BARS_DEFAULT;
			cells.push({ kind: "plus", targetId: section.id, startSeconds: cursor, durationSeconds: gapSeconds, row: 0 });
			columns.push({ kind: "gap", startSeconds: cursor, durationSeconds: gapSeconds });
			cursor += gapSeconds;
		} else {
			// Every transition stacked on this target shares one END (they're
			// mutually-exclusive alternatives for "what plays right before
			// this Section" — only ONE will actually play, but the Section
			// after them can only start at one, single instant, regardless of
			// which alternative it was). row 0 is the anchor that defines
			// where that shared end sits (`columnEnd = columnStart +
			// row0Length`) — a right-edge drag on ANY row moves this shared
			// end (see _wireEdgeDrag/_commitTransitionLength, which keeps
			// row 0's own stored `length` in sync so this formula keeps
			// producing the right answer even when a *different* row was the
			// one actually dragged). Each row's own START is independent —
			// `columnEnd - itsOwnLength` — so a left-edge drag on one row
			// (changing only *its* length) never moves the shared end or any
			// sibling; it may render as starting earlier (poking out further
			// left) than its siblings, which is expected, per Hans
			// (2026-09-06).
			const rowInfos = transitions.map((t) => readSectionInfo(t, compositionNode));
			const rowLengths = transitions.map((t, i) => {
				const raw = parseDivision(t.attributes.length, rowInfos[i]);
				return Number.isFinite(raw) && raw > 0 ? raw : rowInfos[i].barDuration;
			});
			const marginSeconds = rowInfos[0].barDuration * TRANSITION_LEFT_MARGIN_BARS;
			const columnEnd = cursor + marginSeconds + rowLengths[0];

			const rowRanges = transitions.map((t, i) => ({
				node: t,
				info: rowInfos[i],
				startSeconds: columnEnd - rowLengths[i],
				durationSeconds: rowLengths[i]
			}));

			rowRanges.forEach((r, row) => {
				cells.push({ kind: "transition", node: r.node, info: r.info, startSeconds: r.startSeconds, durationSeconds: r.durationSeconds, row, targetId: section.id, columnEnd });
			});
			cells.push({ kind: "plus", targetId: section.id, startSeconds: rowRanges[0].startSeconds, durationSeconds: rowRanges[0].durationSeconds, row: transitions.length });
			columns.push({ kind: "transitions", targetId: section.id, rowRanges, columnEnd });
			cursor = columnEnd;
		}

		const sectionDuration = sectionContentDuration(section, sectionInfo) || sectionInfo.barDuration;
		cells.push({ kind: "section", node: section, info: sectionInfo, startSeconds: cursor, durationSeconds: sectionDuration, row: 0 });
		columns.push({ kind: "section", node: section, info: sectionInfo, startSeconds: cursor, durationSeconds: sectionDuration });
		cursor += sectionDuration;
	});

	const maxRows = Math.max(1, ...[...transitionsByTargetId.values()].map((arr) => arr.length));
	return { cells, columns, orphans, regulars, transitionsByTargetId, totalSeconds: cursor, maxRows };
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
			overflow: hidden;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 0.6rem;
			padding: 0.35rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
		}
		.zoom-group {
			display: flex;
			align-items: center;
			gap: 0.15rem;
		}
		/* Pushes both zoom groups (H and V) to the toolbar's right edge —
		   an auto margin on the first flex item absorbs all the leading
		   space, same technique as wa-section-view.js's own .zoom-controls.
		   Per Hans (2026-09-08). */
		.zoom-group:first-of-type {
			margin-left: auto;
		}
		.zoom-label {
			font-size: 0.7rem;
			color: var(--waw-muted, #8a8a8a);
			margin-right: 0.15rem;
		}
		.zoom-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			width: 1.5rem;
			height: 1.5rem;
			cursor: pointer;
			font-size: 0.9rem;
			line-height: 1;
		}
		.zoom-btn:hover {
			background: #2f333a;
		}
		.empty-hint {
			margin: 1rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.comp-scroll {
			flex: 1 1 auto;
			overflow: auto;
			position: relative;
		}
		.ruler {
			position: sticky;
			top: 0;
			left: 0;
			height: ${RULER_HEIGHT}px;
			background: #16181b;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			z-index: 2;
		}
		.ruler-col {
			position: absolute;
			top: 0;
			height: 100%;
			overflow: hidden;
			border-left: 1px solid #232830;
		}
		.ruler-bar {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 1px;
			background: #3a3f45;
		}
		.ruler-bar .num {
			position: absolute;
			left: 2px;
			top: 1px;
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.ruler-beat {
			position: absolute;
			top: 60%;
			bottom: 0;
			width: 1px;
			background: #2a2e33;
		}
		.rows {
			position: relative;
		}
		.section-box, .transition-box {
			position: absolute;
			box-sizing: border-box;
			border-radius: 4px;
			overflow: hidden;
			cursor: pointer;
			display: flex;
			flex-direction: column;
		}
		.section-box {
			background: #1c2740;
			border: 1px solid #33436b;
		}
		.section-box.selected, .transition-box.selected {
			border-color: var(--waw-accent, #4fa3ff);
			box-shadow: 0 0 0 1px var(--waw-accent, #4fa3ff);
		}
		.transition-box {
			background: #2a2320;
			border: 1px solid #5a4a3a;
		}
		/* A regular Section can loop indefinitely (its own looping Layers) —
		   shown as a small glyph in its own bottom-right corner, per Hans
		   (2026-09-07). */
		.loop-icon {
			position: absolute;
			right: 2px;
			bottom: 1px;
			font-size: 0.6rem;
			line-height: 1;
			color: #7fa8e8;
			opacity: 0.8;
			pointer-events: none;
		}
		/* A transition's end (where the shared column end/the "to" Section
		   begins) gets an extra marker line just inside its right edge, per
		   Hans (2026-09-07, nudged closer to the edge 2026-09-08) —
		   distinct from .edge-handle.right, which is the wider invisible
		   drag-grab area right at the true edge. */
		.end-marker {
			position: absolute;
			top: 0;
			bottom: 0;
			right: 2px;
			width: 1px;
			background: rgba(255, 255, 255, 0.4);
			pointer-events: none;
		}
		.box-label {
			flex: 0 0 auto;
			font-size: 0.68rem;
			padding: 0.1rem 0.3rem;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			background: rgba(0, 0, 0, 0.25);
		}
		.layer-chips {
			flex: 1 1 auto;
			display: flex;
			flex-direction: column;
			gap: 1px;
			padding: 1px;
			min-height: 0;
		}
		.layer-chip {
			position: relative;
			flex: 1 1 0;
			background: #3a6ea8;
			border-radius: 2px;
			min-height: 2px;
			opacity: 0.85;
			overflow: hidden;
		}
		.waveform-canvas {
			position: absolute;
			top: 0;
			height: 100%;
		}
		.edge-handle {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 6px;
			cursor: ew-resize;
			z-index: 1;
		}
		.edge-handle.left { left: 0; }
		.edge-handle.right { right: 0; }
		.plus-btn {
			position: absolute;
			top: 4px;
			bottom: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: #24272c;
			border: 1px dashed var(--waw-border, #2f2f2f);
			border-radius: 4px;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 1rem;
		}
		.plus-btn:hover {
			background: #2f333a;
			color: var(--waw-fg, #e8e8e8);
		}
		.playhead {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 2px;
			background: #f2f2f2;
			pointer-events: none;
			z-index: 3;
		}
		.pending-marker {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 3px;
			background: rgba(232, 211, 77, 0.9);
			animation: pending-blink 0.6s ease-in-out infinite;
			pointer-events: none;
			z-index: 3;
		}
		@keyframes pending-blink {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.15; }
		}
		.orphan-strip {
			display: flex;
			gap: 0.4rem;
			padding: 0.4rem;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
			overflow-x: auto;
		}
		.orphan-strip:empty {
			display: none;
		}
		.orphan-chip {
			font-size: 0.7rem;
			padding: 0.2rem 0.5rem;
			background: #2a2320;
			border: 1px solid #5a4a3a;
			border-radius: 4px;
			cursor: pointer;
			white-space: nowrap;
		}
		.from-popup {
			position: fixed;
			z-index: 50;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
			padding: 0.3rem;
			min-width: 9rem;
		}
		.from-popup button {
			display: block;
			width: 100%;
			text-align: left;
			background: none;
			border: none;
			color: inherit;
			font: inherit;
			padding: 0.3rem 0.5rem;
			border-radius: 4px;
			cursor: pointer;
		}
		.from-popup button:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.from-popup-label {
			padding: 0.2rem 0.5rem 0.35rem;
			font-size: 0.68rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--waw-muted, #8a8a8a);
		}
	</style>
	<div class="toolbar">
		<div class="zoom-group">
			<span class="zoom-label">H</span>
			<button class="zoom-btn" data-zoom="h-out">−</button>
			<button class="zoom-btn" data-zoom="h-in">+</button>
		</div>
		<div class="zoom-group">
			<span class="zoom-label">V</span>
			<button class="zoom-btn" data-zoom="v-out">−</button>
			<button class="zoom-btn" data-zoom="v-in">+</button>
		</div>
	</div>
	<div class="empty-hint" hidden>No Sections yet.</div>
	<div class="comp-scroll" hidden>
		<div class="ruler"></div>
		<div class="rows"></div>
	</div>
	<div class="orphan-strip"></div>
`;

export class WaCompositionView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._scroll = this.shadowRoot.querySelector(".comp-scroll");
		this._ruler = this.shadowRoot.querySelector(".ruler");
		this._rows = this.shadowRoot.querySelector(".rows");
		this._emptyHint = this.shadowRoot.querySelector(".empty-hint");
		this._orphanStrip = this.shadowRoot.querySelector(".orphan-strip");

		this._pxPerSecond = DEFAULT_PX_PER_SEC;
		this._rowHeight = DEFAULT_ROW_HEIGHT;
		this._lastCompositionId = null;
		this._needsInitialScroll = true; // scrolls LEFT_PAD_PX into view once per newly-selected Composition — see _onStoreChange/_renderComposition
		this._lastSelectedTransitionIdByTarget = new Map();
		this._lastLayout = null;
		this._isPlaying = false;
		this._cursorTime = 0;
		this._playStartAudioTime = 0;
		this._playingSectionId = null;
		this._rafId = null;
		this._pendingBlinkTimer = null;
		this._pendingMarkerEl = null;
		this._bufferCache = new Map(); // resolvedUrl -> Promise<AudioBuffer|null>, same pattern as wa-section-view.js's own _decode

		this._onPlayerStoreChange = this._onPlayerStoreChange.bind(this);
	}

	connectedCallback() {
		this.shadowRoot.querySelectorAll(".zoom-btn").forEach((btn) => {
			btn.addEventListener("click", () => this._handleZoom(btn.dataset.zoom));
		});
		this.addEventListener("wheel", (e) => this._onWheelZoom(e), { passive: false });
		this._wireRulerClickOnce();
		xmlStore.addEventListener("change", () => this._onStoreChange());
		playerStore.addEventListener("change", this._onPlayerStoreChange);
		this._onStoreChange();
	}

	disconnectedCallback() {
		this._stopPositionLoop();
		this._clearPendingBlink();
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
	}

	// --- selection / sticky active Composition (same idea as wa-section-view's _lastSectionId) ---

	_onStoreChange() {
		const selected = xmlStore.getSelectedNode();
		if (selected && selected.tagName === "Composition" && selected.id !== this._lastCompositionId) {
			this._lastCompositionId = selected.id;
			this._lastSelectedTransitionIdByTarget.clear();
			this._needsInitialScroll = true; // see _renderComposition's own use of this flag
		}
		if (!this._lastCompositionId) return;

		const node = ops.findNodeById(xmlStore.root, this._lastCompositionId);
		if (!node) {
			this._lastCompositionId = null;
			this._emptyHint.hidden = false;
			this._scroll.hidden = true;
			this._orphanStrip.innerHTML = "";
			return;
		}
		this._renderComposition(node);
	}

	_getActiveCompositionNode() {
		if (!this._lastCompositionId || !xmlStore.root) return null;
		return ops.findNodeById(xmlStore.root, this._lastCompositionId);
	}

	// --- zoom ---

	_handleZoom(kind) {
		if (kind === "h-in") this._pxPerSecond = Math.min(MAX_PX_PER_SEC, this._pxPerSecond * 1.4);
		else if (kind === "h-out") this._pxPerSecond = Math.max(MIN_PX_PER_SEC, this._pxPerSecond / 1.4);
		else if (kind === "v-in") this._rowHeight = Math.min(MAX_ROW_HEIGHT, this._rowHeight * 1.25);
		else if (kind === "v-out") this._rowHeight = Math.max(MIN_ROW_HEIGHT, this._rowHeight / 1.25);
		const node = this._getActiveCompositionNode();
		if (node) this._renderComposition(node);
	}

	// Same cursor-anchored, independent-axis pinch/ctrl-wheel zoom as
	// wa-section-view.js's own _onWheelZoom — see there for the full
	// rationale; mirrored here rather than shared since that file's version
	// is written against its own Layer-scroll element.
	_onWheelZoom(e) {
		if (!e.ctrlKey) return;
		e.preventDefault();
		e.stopPropagation();
		const node = this._getActiveCompositionNode();
		if (!node) return;

		let cursorTimeSeconds = null;
		let cursorOffsetPx = null;
		cursorOffsetPx = e.clientX - this._scroll.getBoundingClientRect().left;
		cursorTimeSeconds = this._pxToTime(this._scroll.scrollLeft + cursorOffsetPx);

		// A genuine trackpad pinch synthesizes as ctrl+wheel with only
		// deltaY ever populated — a pinch isn't a directional X/Y gesture
		// the way a two-finger swipe is, so deltaX stays ~0 regardless of
		// pinch direction. Without this fallback, horizontal (time) zoom
		// was effectively unreachable via the most common "pinch to zoom"
		// gesture — only vertical (row height) ever responded. Falls back
		// to deltaY driving both axes together (a uniform zoom) whenever
		// deltaX is negligible; a genuine horizontal-only gesture (real
		// deltaX, e.g. a dedicated horizontal scroll wheel) still zooms
		// just that axis, unaffected. Per Hans (2026-09-08): "nu funkar
		// bara vertikal".
		const rawDeltaX = Math.abs(e.deltaX) > 0.01 ? e.deltaX : e.deltaY;
		const factorX = Math.exp(-rawDeltaX * 0.01);
		const factorY = Math.exp(-e.deltaY * 0.01);
		this._pxPerSecond = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, this._pxPerSecond * factorX));
		this._rowHeight = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, this._rowHeight * factorY));

		this._renderComposition(node);

		if (cursorTimeSeconds !== null) {
			this._scroll.scrollLeft = Math.max(0, this._timeToPx(cursorTimeSeconds) - cursorOffsetPx);
		}
	}

	// Converts an ABSOLUTE time (measured from the timeline's real t=0) to a
	// page-space pixel offset — i.e. anything used as a `left`/scrollLeft, or
	// summed with one, needs the LEFT_PAD_PX runway baked in so it lines up
	// with everything else on the (padded) page. Never use this for a bare
	// DURATION/width or a position *relative to* an already-positioned
	// ancestor (e.g. a ruler tick's offset within its own column) — those
	// aren't page-space coordinates, so the constant pad term would just be
	// spurious extra pixels tacked onto the value (see _secondsToPx for
	// that case instead).
	_timeToPx(seconds) {
		return seconds * this._pxPerSecond + LEFT_PAD_PX;
	}

	// Inverse of _timeToPx, for the two places that need to go the other
	// way (cursor-anchored zoom, ruler click-to-trigger).
	_pxToTime(px) {
		return (px - LEFT_PAD_PX) / this._pxPerSecond;
	}

	// Pure seconds->pixels scaling, no LEFT_PAD_PX — for a width/duration or
	// any offset already relative to a `position`ed ancestor (a ruler tick
	// within its own column, a box's own width). Using _timeToPx for these
	// instead (an easy mistake once that function existed) tacks a spurious
	// +LEFT_PAD_PX onto every one of them — the bug behind transitions/
	// plus-buttons rendering thousands of pixels too wide and the loop icon
	// scrolling off past the visible area, reported by Hans (2026-09-07).
	_secondsToPx(seconds) {
		return seconds * this._pxPerSecond;
	}

	// --- rendering ---

	_renderComposition(node) {
		const layout = computeLayout(node);
		this._lastLayout = layout;

		const hasContent = layout.regulars.length > 0;
		this._emptyHint.hidden = hasContent;
		this._scroll.hidden = !hasContent;
		if (!hasContent) {
			this._orphanStrip.innerHTML = "";
			return;
		}

		// The `clientWidth` term alone (the old formula) only guarantees no
		// *negative* scrollable width — for a small/sparse composition (few
		// bars of actual content), that left scrollWidth-clientWidth short
		// of LEFT_PAD_PX, so the initial-scroll target below (which can be
		// as large as LEFT_PAD_PX) got silently clamped by the browser to
		// less than intended, leaving far more of the blank pad visible
		// than the one-bar lead-in this is supposed to produce — read by
		// Hans as the view being "scrolled too far to the right". Adding
		// LEFT_PAD_PX here guarantees the full pad is always scrollable
		// into, regardless of how little real content exists yet. Per Hans
		// (2026-09-08).
		const totalWidth = Math.max(this._scroll.clientWidth + LEFT_PAD_PX, this._timeToPx(layout.totalSeconds) + 40);
		const totalHeight = layout.maxRows * this._rowHeight;

		this._ruler.innerHTML = "";
		this._ruler.style.width = `${totalWidth}px`;
		layout.columns.forEach((col) => this._ruler.appendChild(this._buildRulerColumn(col, node)));

		this._rows.innerHTML = "";
		this._rows.style.width = `${totalWidth}px`;
		this._rows.style.height = `${totalHeight}px`;

		layout.cells.forEach((cell) => {
			if (cell.kind === "section") this._rows.appendChild(this._buildSectionBox(cell));
			else if (cell.kind === "transition") this._rows.appendChild(this._buildTransitionBox(cell, layout));
			else if (cell.kind === "plus") this._rows.appendChild(this._buildPlusButton(cell, node));
		});

		// Scrolls the fixed pre-roll pad out of view once per newly-selected
		// Composition — see _wireEdgeDrag's own use of LEFT_PAD_PX for why
		// the pad exists. Deferred a frame: this render can run while
		// wa-preview.js's own panel-switch to "composition" (display:none ->
		// block) hasn't visually applied yet in the same synchronous
		// "change" dispatch — a scrollLeft write to a not-yet-laid-out
		// element is silently clamped to 0 and does NOT get honored once it
		// becomes visible a moment later, so this has to happen on the next
		// paint instead of inline here.
		if (this._needsInitialScroll) {
			this._needsInitialScroll = false;
			// Leaves about one bar of the pad visible rather than scrolling
			// all the way to its edge — landing exactly on LEFT_PAD_PX put
			// the very first "+" button (and the start of the timeline)
			// flush against the left edge of the view with zero lead-in,
			// which read as an odd, arbitrary offset. Per Hans (2026-09-07).
			const leadInInfo = readSectionInfo(layout.regulars[0], node);
			const leadInPx = this._secondsToPx(leadInInfo.barDuration);
			requestAnimationFrame(() => {
				this._scroll.scrollLeft = Math.max(0, LEFT_PAD_PX - leadInPx);
			});
		}

		this._orphanStrip.innerHTML = "";
		layout.orphans.forEach((orphan) => {
			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "orphan-chip";
			chip.textContent = `⚠ ${displayLabel(orphan)} (unresolved to="${orphan.attributes.to ?? ""}")`;
			chip.title = "This transition's \"to\" doesn't resolve to a regular Section in this view — click to select it anyway.";
			chip.addEventListener("click", () => xmlStore.selectNode(orphan.id));
			this._orphanStrip.appendChild(chip);
		});

		this._updatePlayheadVisual();
	}

	_buildRulerColumn(col, compositionNode) {
		const el = document.createElement("div");
		el.className = "ruler-col";

		if (col.kind === "gap") {
			el.dataset.startSeconds = String(col.startSeconds);
			el.style.left = `${this._timeToPx(col.startSeconds)}px`;
			el.style.width = `${this._secondsToPx(col.durationSeconds)}px`;
			return el; // blank, no ticks
		}

		el.dataset.targetId = col.kind === "transitions" ? col.targetId : "";

		let startSeconds, durationSeconds, info;
		if (col.kind === "transitions") {
			const selectedId = this._lastSelectedTransitionIdByTarget.get(col.targetId);
			const selected = col.rowRanges.find((r) => r.node.id === selectedId) || col.rowRanges[0];
			startSeconds = selected.startSeconds;
			durationSeconds = selected.durationSeconds;
			info = selected.info;
		} else {
			startSeconds = col.startSeconds;
			durationSeconds = col.durationSeconds;
			info = col.info;
		}

		el.dataset.startSeconds = String(startSeconds);
		el.style.left = `${this._timeToPx(startSeconds)}px`;
		el.style.width = `${this._secondsToPx(durationSeconds)}px`;
		this._populateRulerTicks(el, info, durationSeconds);
		return el;
	}

	// Bar/beat tick marks filling a ruler segment's own width — split out of
	// _buildRulerColumn so a live transition-edge drag (see _wireEdgeDrag)
	// can regenerate just this one segment's ticks as its duration changes,
	// instead of only resizing the outer container and leaving stale/sparse
	// ticks behind. Per Hans (2026-09-06): "TimeLine behöver fyllas på med
	// siffror och grid-ticks när man förlänger en transition".
	_populateRulerTicks(el, info, durationSeconds) {
		el.querySelectorAll(".ruler-bar, .ruler-beat").forEach((n) => n.remove());
		const showBeats = this._pxPerSecond * info.beatDuration > 18;
		const totalBars = Math.max(1, Math.ceil(durationSeconds / info.barDuration));
		for (let bar = 0; bar < totalBars; bar++) {
			const barTime = bar * info.barDuration;
			if (barTime > durationSeconds + info.barDuration) break;
			const barTick = document.createElement("div");
			barTick.className = "ruler-bar";
			barTick.style.left = `${this._secondsToPx(barTime)}px`;
			const num = document.createElement("span");
			num.className = "num";
			num.textContent = String(bar + 1);
			barTick.appendChild(num);
			el.appendChild(barTick);

			if (showBeats) {
				for (let beat = 1; beat < info.timeSign.numerator; beat++) {
					const beatTick = document.createElement("div");
					beatTick.className = "ruler-beat";
					beatTick.style.left = `${this._secondsToPx(barTime + beat * info.beatDuration)}px`;
					el.appendChild(beatTick);
				}
			}
		}
	}

	_buildSectionBox(cell) {
		const box = document.createElement("div");
		box.className = "section-box";
		box.dataset.nodeId = cell.node.id;
		box.dataset.startSeconds = String(cell.startSeconds);
		if (xmlStore.selectedNodeId === cell.node.id) box.classList.add("selected");
		box.style.left = `${this._timeToPx(cell.startSeconds)}px`;
		box.style.top = "0px";
		box.style.width = `${Math.max(4, this._secondsToPx(cell.durationSeconds))}px`;
		box.style.height = `${this._rowHeight}px`;

		const label = document.createElement("div");
		label.className = "box-label";
		label.textContent = displayLabel(cell.node);
		box.appendChild(label);

		const chips = document.createElement("div");
		chips.className = "layer-chips";
		getLayers(cell.node).forEach((layer) => {
			const chip = document.createElement("div");
			chip.className = "layer-chip";
			chips.appendChild(chip);
			this._renderLayerWaveform(chip, layer, cell.info);
		});
		box.appendChild(chips);

		const loopIcon = document.createElement("span");
		loopIcon.className = "loop-icon";
		loopIcon.textContent = "↻";
		loopIcon.title = "Loops indefinitely until another Section is triggered";
		box.appendChild(loopIcon);

		this._wireBoxSelection(box, cell.node);
		return box;
	}

	// A quick, static waveform preview inside a Layer's own chip — mirrors
	// wa-section-view.js's own src-resolution walk (bare Layer src, or each
	// Segment/Option's own src at its pos/length) but simplified: no drag
	// preview, no incremental timeline growth, just draw-once-per-render, per
	// Hans (2026-09-07). A chip is small, so this is a coarse preview, not a
	// full editing surface.
	_renderLayerWaveform(chip, layer, info) {
		const schema = xmlStore.schema;
		const drawAt = (srcValue, posSeconds, explicitLengthSeconds) => {
			const resolvedUrl = resolvePlayableUrl(srcValue);
			if (!resolvedUrl) return;
			const canvas = document.createElement("canvas");
			canvas.className = "waveform-canvas";
			canvas.style.left = `${this._secondsToPx(posSeconds)}px`;
			chip.appendChild(canvas);
			this._decode(resolvedUrl).then((buffer) => {
				if (!buffer || !canvas.isConnected) return;
				const durationSeconds = explicitLengthSeconds ?? buffer.duration;
				const widthPx = Math.max(1, this._secondsToPx(durationSeconds));
				canvas.width = widthPx;
				canvas.height = Math.max(1, chip.clientHeight);
				canvas.style.width = `${widthPx}px`;
				drawWaveform(canvas, buffer, WAVEFORM_COLOR);
			});
		};

		const segments = getSegments(layer);
		const directOptions = getOptions(layer);
		if (segments.length === 0 && directOptions.length === 0) {
			const srcAttr = findSrcAttribute(schema, layer);
			if (srcAttr) drawAt(srcAttr.value, 0, null);
			return;
		}
		directOptions.forEach((option) => {
			const srcAttr = findSrcAttribute(schema, option);
			if (srcAttr) drawAt(srcAttr.value, readPos(option, info), readLength(option, info));
		});
		segments.forEach((segment) => {
			const segmentPos = readPos(segment, info);
			const segmentSrcAttr = findSrcAttribute(schema, segment);
			if (segmentSrcAttr) drawAt(segmentSrcAttr.value, segmentPos, readLength(segment, info));
			getOptions(segment).forEach((option) => {
				const optionSrcAttr = findSrcAttribute(schema, option);
				if (optionSrcAttr) drawAt(optionSrcAttr.value, segmentPos, readLength(option, info));
			});
		});
	}

	// Decoded buffers are cached by URL across renders (this view fully
	// rebuilds its DOM on every xmlStore change — see _renderComposition —
	// so without this, re-selecting/scrolling would re-fetch/re-decode every
	// audio file every time); canvases themselves are always rebuilt fresh.
	_decode(url) {
		if (!this._bufferCache.has(url)) {
			this._bufferCache.set(
				url,
				decodeAudioBuffer(url, playerStore.audioContext).catch((err) => {
					console.warn("Composition view: could not decode", url, err);
					return null;
				})
			);
		}
		return this._bufferCache.get(url);
	}

	_buildTransitionBox(cell, layout) {
		const box = document.createElement("div");
		box.className = "transition-box";
		box.dataset.nodeId = cell.node.id;
		box.dataset.startSeconds = String(cell.startSeconds);
		box.dataset.targetId = cell.targetId;
		if (xmlStore.selectedNodeId === cell.node.id) box.classList.add("selected");
		box.style.left = `${this._timeToPx(cell.startSeconds)}px`;
		box.style.top = `${cell.row * this._rowHeight}px`;
		box.style.width = `${Math.max(4, this._secondsToPx(cell.durationSeconds))}px`;
		box.style.height = `${this._rowHeight}px`;

		const label = document.createElement("div");
		label.className = "box-label";
		label.textContent = displayLabel(cell.node);
		box.appendChild(label);

		const endMarker = document.createElement("div");
		endMarker.className = "end-marker";
		box.appendChild(endMarker);

		const leftHandle = document.createElement("div");
		leftHandle.className = "edge-handle left";
		box.appendChild(leftHandle);
		const rightHandle = document.createElement("div");
		rightHandle.className = "edge-handle right";
		box.appendChild(rightHandle);

		this._wireBoxSelection(box, cell.node, () => {
			this._lastSelectedTransitionIdByTarget.set(cell.targetId, cell.node.id);
			const node = this._getActiveCompositionNode();
			if (node) this._renderComposition(node);
		});
		this._wireEdgeDrag(leftHandle, cell, "left", layout);
		this._wireEdgeDrag(rightHandle, cell, "right", layout);

		return box;
	}

	// onSelectExtra: runs on plain single-click too (before the shared
	// select call) — used by transition boxes to also record "this is now
	// the stack's selected-for-ruler transition" (see _buildRulerColumn).
	_wireBoxSelection(box, node, onSelectExtra) {
		let clickTimer = null;
		box.addEventListener("click", (e) => {
			e.stopPropagation();
			if (clickTimer) {
				clearTimeout(clickTimer);
				clickTimer = null;
				return; // consumed by the dblclick handler below instead
			}
			clickTimer = setTimeout(() => {
				clickTimer = null;
				if (onSelectExtra) onSelectExtra();
				xmlStore.selectNode(node.id);
			}, 220);
		});
		box.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			if (clickTimer) {
				clearTimeout(clickTimer);
				clickTimer = null;
			}
			if (onSelectExtra) onSelectExtra();
			xmlStore.selectNode(node.id, { open: true });
		});
	}

	_buildPlusButton(cell, compositionNode) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "plus-btn";
		btn.dataset.startSeconds = String(cell.startSeconds);
		btn.dataset.targetId = cell.targetId;
		btn.textContent = "+";
		btn.title = "Add a transition Section here";
		btn.style.left = `${this._timeToPx(cell.startSeconds)}px`;
		btn.style.top = `${cell.row * this._rowHeight + 4}px`;
		btn.style.width = `${Math.max(16, this._secondsToPx(cell.durationSeconds))}px`;
		btn.style.height = `${this._rowHeight - 8}px`;
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleCreateTransition(cell.targetId, compositionNode, btn);
		});
		return btn;
	}

	// --- creating a transition ---

	// `to` is always the Section immediately to the right of the pressed "+"
	// (never a guess) — `#id`, not a class, to stay unambiguous even when
	// several Sections share a class. The FIRST transition created for a
	// given target auto-sets `from` to the id of the Section to the left
	// (no dropdown) — EXCEPT for the very first gap (before the first
	// regular Section), which has no such predecessor to guess from at all,
	// so it opens the dropdown instead, same as every subsequent "+" click
	// for a target that already has one. Per Hans (2026-09-08). Once a
	// target already has a transition, the next "+" click for that same
	// target opens the dropdown too (never auto-guessed past the first
	// one), listing every regular Section's id plus a leading "All" (omits
	// `from` entirely). No `class` is ever set here — a transition stays
	// classless unless the user adds one by hand, per Hans (2026-09-08).
	_handleCreateTransition(targetId, compositionNode, anchorEl) {
		const layout = this._lastLayout;
		const target = layout.regulars.find((r) => r.id === targetId);
		if (!target) return;
		const existing = layout.transitionsByTargetId.get(targetId) || [];
		const targetIndex = layout.regulars.indexOf(target);
		const predecessor = targetIndex > 0 ? layout.regulars[targetIndex - 1] : null;

		if (existing.length === 0 && predecessor) {
			const attrs = {
				to: `#${target.attributes.id}`,
				length: DEFAULT_TRANSITION_LENGTH,
				from: `#${predecessor.attributes.id}`
			};
			this._insertTransition(compositionNode, target, attrs);
			return;
		}

		this._openFromPopup(anchorEl, layout.regulars, (fromValue) => {
			const attrs = { to: `#${target.attributes.id}`, length: DEFAULT_TRANSITION_LENGTH };
			if (fromValue !== null) attrs.from = fromValue;
			this._insertTransition(compositionNode, target, attrs);
		});
	}

	_insertTransition(compositionNode, target, attrs) {
		const compNow = ops.findNodeById(xmlStore.root, compositionNode.id);
		if (!compNow) return;
		const targetIndex = compNow.children.findIndex((c) => c.id === target.id);
		xmlStore.insertNewChild(compNow.id, "Section", attrs, targetIndex < 0 ? undefined : targetIndex);
	}

	// onChoose(fromValue): fromValue is null for "All" (omit `from` entirely),
	// otherwise the picked Section's "#id".
	_openFromPopup(anchorEl, regulars, onChoose) {
		const popup = document.createElement("div");
		popup.className = "from-popup";
		const rect = anchorEl.getBoundingClientRect();
		popup.style.left = `${rect.left}px`;
		popup.style.top = `${rect.bottom + 4}px`;

		const label = document.createElement("div");
		label.className = "from-popup-label";
		label.textContent = "From Section:";
		popup.appendChild(label);

		const allBtn = document.createElement("button");
		allBtn.type = "button";
		allBtn.textContent = "All";
		allBtn.addEventListener("click", () => {
			onChoose(null);
			popup.remove();
		});
		popup.appendChild(allBtn);

		regulars.forEach((r) => {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = `#${r.attributes.id}`;
			btn.addEventListener("click", () => {
				onChoose(`#${r.attributes.id}`);
				popup.remove();
			});
			popup.appendChild(btn);
		});

		this.shadowRoot.appendChild(popup);
		const closeOnOutside = (e) => {
			if (!e.composedPath().includes(popup)) {
				popup.remove();
				document.removeEventListener("pointerdown", closeOnOutside, true);
			}
		};
		setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
	}

	// The finest of GRID_RESOLUTIONS_BEATS whose on-screen spacing at the
	// *current* zoom is still >= MIN_GRID_SPACING_PX — see the module-level
	// comment above GRID_RESOLUTIONS_BEATS.
	_effectiveGridSeconds(info) {
		let chosenBeats = GRID_RESOLUTIONS_BEATS[0];
		GRID_RESOLUTIONS_BEATS.forEach((beats) => {
			if (this._pxPerSecond * info.beatDuration * beats >= MIN_GRID_SPACING_PX) chosenBeats = beats;
		});
		return chosenBeats * info.beatDuration;
	}

	// --- dragging a transition's edges ---
	//
	// Purely visual during the drag — nothing is written to xmlStore until
	// pointerup. Every rendered box/plus-button/ruler-column carries its own
	// original `data-start-seconds` (set at render time) so the sweep below
	// can decide "is this before/after the dragged edge" and shift it by a
	// uniform delta without recomputing the whole layout mid-drag. Drag
	// deltas snap to _effectiveGridSeconds. Ruler ticks are regenerated
	// (not just resized) as the dragged segment's own duration changes —
	// see _populateRulerTicks — per Hans (2026-09-06): "TimeLine behöver
	// fyllas på med siffror och grid-ticks när man förlänger en transition".
	//
	// Row 0 is special: it's the formula anchor computeLayout uses for the
	// whole stack's shared end (`columnEnd = columnStart + row0Length`,
	// columnStart itself fixed by preceding content + the margin) — there's
	// no second stored number that would let row 0 *also* independently
	// extend backward the way a sibling row can, so EITHER of row 0's own
	// edges is treated as "the end-defining edge" (`behavesAsRightEdge`
	// below): its box stays start-anchored and its width is what changes,
	// rippling to siblings + everything after — exactly like a genuine
	// right-edge drag would, on either the actively-dragged row 0 handle,
	// regardless of which one it visually is. A NON-row-0 row's left edge
	// is the only case that's ever independent (moves only its own start,
	// touches nothing else); any row's right edge (row 0's included) always
	// moves the shared end. Per Hans (2026-09-06).
	_wireEdgeDrag(handle, cell, edge, layout) {
		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			try {
				handle.setPointerCapture(e.pointerId);
			} catch {}

			const box = handle.parentElement;
			const startClientX = e.clientX;
			const originalStart = cell.startSeconds;
			const originalDuration = cell.durationSeconds;
			const originalEnd = originalStart + originalDuration;
			const info = cell.info;
			const minDuration = info.barDuration * MIN_TRANSITION_BARS;
			const gridSeconds = this._effectiveGridSeconds(info);

			const siblings = layout.transitionsByTargetId.get(cell.targetId) || [];
			const isRow0 = siblings[0]?.id === cell.node.id;
			const behavesAsRightEdge = edge === "right" || isRow0;

			// Row 0's own box never actually moves (its left edge — bar 1 of
			// its own ruler — is pinned to columnStart, see the class
			// comment above _wireEdgeDrag) — so when the LEFT handle is the
			// one being dragged, the cursor would otherwise visibly detach
			// from the edge it's supposedly holding. Scrolling the whole
			// timeline by the raw (unsnapped) pixel delta instead keeps that
			// fixed edge visually glued under the cursor, left or right, per
			// Hans (2026-09-07) — a pure viewport scroll, not a layout
			// change, so it never touches _pxPerSecond or any stored data.
			const scrollFollowsCursor = edge === "left" && isRow0;
			const initialScrollLeft = this._scroll.scrollLeft;

			// Whichever row you actually grab an edge on becomes the stack's
			// "selected for ruler" row right away — previously the ruler (the
			// one shared timeline strip above a stacked column) only ever
			// synced to whatever was last *clicked*, so dragging a row that
			// wasn't already selected silently left the ruler showing a
			// different row's ticks throughout the whole drag. Per Hans
			// (2026-09-07): "TimeLine följer inte med" when dragging row 1.
			this._lastSelectedTransitionIdByTarget.set(cell.targetId, cell.node.id);
			const ownRulerCol = this._ruler.querySelector(`.ruler-col[data-target-id="${cell.targetId}"]`);
			// The ruler column is one shared DOM node per stacked target (not
			// one per row) — its ticks were last populated for whichever row
			// was selected *before* this drag, so it needs an immediate
			// resync to this row's own start/duration before onMove's
			// incremental updates take over.
			if (ownRulerCol) {
				ownRulerCol.style.left = `${this._timeToPx(originalStart)}px`;
				ownRulerCol.style.width = `${Math.max(4, this._secondsToPx(originalDuration))}px`;
				this._populateRulerTicks(ownRulerCol, info, originalDuration);
			}
			const sameColumnElements = [...this._rows.querySelectorAll(`[data-target-id="${cell.targetId}"]`)].filter((el) => el !== box);
			const others = [...this._rows.querySelectorAll("[data-start-seconds]"), ...this._ruler.querySelectorAll("[data-start-seconds]")].filter(
				(el) => el.dataset.targetId !== cell.targetId
			);

			// The .rows/.ruler containers' explicit width is only ever set at
			// full-render time (see _renderComposition's totalWidth), sized
			// just barely enough for the content that existed *then* (+40px
			// margin) — a live behavesAsRightEdge drag can push content well
			// past that without ever re-running a full render, so the
			// scrollable area's own max-scroll (governed by that stale
			// width) gets hit almost immediately and further scrollLeft
			// writes are silently clamped by the browser itself, well before
			// this handler's own Math.max(0, ...) floor is ever the limiting
			// factor. onMove grows these live, on demand, to whatever the
			// drag currently needs. Per Hans (2026-09-07): dragging row 0's
			// left edge "följer med bit, sedan släpper den".
			const growContainersTo = (widthPx) => {
				if (parseFloat(this._rows.style.width) < widthPx) this._rows.style.width = `${widthPx}px`;
				if (parseFloat(this._ruler.style.width) < widthPx) this._ruler.style.width = `${widthPx}px`;
			};

			let committedDuration = originalDuration;

			const onMove = (moveEvt) => {
				const rawDeltaSeconds = (moveEvt.clientX - startClientX) / this._pxPerSecond;
				const snappedDeltaSeconds = Math.round(rawDeltaSeconds / gridSeconds) * gridSeconds;

				// Sign convention always follows the literal handle grabbed
				// (dragging the left handle further left grows the
				// transition) — only the *rendering*/ripple direction below
				// depends on behavesAsRightEdge, not this.
				let newDuration = edge === "left" ? originalDuration - snappedDeltaSeconds : originalDuration + snappedDeltaSeconds;
				newDuration = Math.max(minDuration, newDuration);
				committedDuration = newDuration;
				const endDelta = newDuration - originalDuration;

				if (behavesAsRightEdge) {
					// Must happen before the scrollLeft write below — growing
					// the containers *after* would be too late, since the
					// browser has already clamped that write to whatever the
					// (still-stale) scrollWidth allowed at that instant.
					growContainersTo(this._timeToPx(layout.totalSeconds + endDelta) + 40);
				}

				if (scrollFollowsCursor) {
					this._scroll.scrollLeft = Math.max(0, initialScrollLeft - (moveEvt.clientX - startClientX));
				}

				if (behavesAsRightEdge) {
					box.style.left = `${this._timeToPx(originalStart)}px`;
					box.style.width = `${Math.max(4, this._secondsToPx(newDuration))}px`;
					if (ownRulerCol) {
						ownRulerCol.style.left = `${this._timeToPx(originalStart)}px`;
						ownRulerCol.style.width = `${Math.max(4, this._secondsToPx(newDuration))}px`;
						this._populateRulerTicks(ownRulerCol, info, newDuration);
					}
					sameColumnElements.forEach((el) => {
						const elStart = parseFloat(el.dataset.startSeconds);
						el.style.left = `${this._timeToPx(elStart + endDelta)}px`;
					});
					others.forEach((el) => {
						const elStart = parseFloat(el.dataset.startSeconds);
						if (elStart > originalEnd - 1e-9) el.style.left = `${this._timeToPx(elStart + endDelta)}px`;
					});
				} else {
					const startDelta = originalDuration - newDuration;
					const newStart = originalStart + startDelta;
					box.style.left = `${this._timeToPx(newStart)}px`;
					box.style.width = `${Math.max(4, this._secondsToPx(newDuration))}px`;
					if (ownRulerCol) {
						ownRulerCol.style.left = `${this._timeToPx(newStart)}px`;
						ownRulerCol.style.width = `${Math.max(4, this._secondsToPx(newDuration))}px`;
						this._populateRulerTicks(ownRulerCol, info, newDuration);
					}
					others.forEach((el) => {
						const elStart = parseFloat(el.dataset.startSeconds);
						if (elStart < originalStart - 1e-9) el.style.left = `${this._timeToPx(elStart + startDelta)}px`;
					});
				}
			};
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				const delta = behavesAsRightEdge ? committedDuration - originalDuration : 0;
				this._commitTransitionLength(cell, committedDuration, behavesAsRightEdge, delta, layout);
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});
	}

	// A row whose edit doesn't move the shared end (a non-row-0 row's left
	// edge) only ever writes its own `length` — nothing else. Anything that
	// DOES move the shared end (any right edge, or either of row 0's own
	// edges — see _wireEdgeDrag) writes the dragged row's own `length`, and
	// — since row 0 is the formula anchor computeLayout uses for the whole
	// stack's shared end — also nudges row 0's own stored `length` by the
	// same delta whenever the dragged row ISN'T row 0, purely so that
	// formula keeps producing the right shared end on the next render. No
	// other sibling's `length` is ever touched — their own rendered
	// position is always re-derived from the (now shifted) shared end at
	// render time. Per Hans (2026-09-06).
	_commitTransitionLength(cell, newDurationSeconds, movesSharedEnd, delta, layout) {
		const lengthStr = secondsToLengthString(newDurationSeconds);
		const now = ops.findNodeById(xmlStore.root, cell.node.id);
		if (now) xmlStore.updateAttributes(cell.node.id, { ...now.attributes, length: lengthStr });

		if (movesSharedEnd && Math.abs(delta) > 1e-9) {
			const row0 = (layout.transitionsByTargetId.get(cell.targetId) || [])[0];
			if (row0 && row0.id !== cell.node.id) {
				const row0Now = ops.findNodeById(xmlStore.root, row0.id);
				const compositionNode = this._getActiveCompositionNode();
				if (row0Now && compositionNode) {
					const row0Info = readSectionInfo(row0Now, compositionNode);
					const row0OldLength = parseDivision(row0Now.attributes.length, row0Info);
					const row0Base = Number.isFinite(row0OldLength) && row0OldLength > 0 ? row0OldLength : row0Info.barDuration;
					xmlStore.updateAttributes(row0.id, { ...row0Now.attributes, length: secondsToLengthString(row0Base + delta) });
				}
			}
		}
	}

	// --- click-to-trigger on the ruler ---

	_wireRulerClickOnce() {
		if (this._rulerClickWired) return;
		this._rulerClickWired = true;
		this._ruler.addEventListener("click", (e) => {
			const layout = this._lastLayout;
			if (!layout) return;
			const scrollRect = this._scroll.getBoundingClientRect();
			const clickSeconds = this._pxToTime(e.clientX - scrollRect.left + this._scroll.scrollLeft);
			const col = layout.columns.find((c) => {
				const [start, duration] = c.kind === "transitions" ? [c.rowRanges[0].startSeconds, c.rowRanges[0].durationSeconds] : [c.startSeconds, c.durationSeconds];
				return clickSeconds >= start && clickSeconds < start + duration;
			});
			if (!col || col.kind === "gap") return;

			const targetNode = col.kind === "section" ? col.node : col.rowRanges[0].node;
			this._triggerSection(targetNode);
		});
	}

	_triggerSection(targetNode) {
		const selector = firstSelector(targetNode);
		this._clearPendingBlink();

		const outgoingId = this._playingSectionId;
		const compositionNode = this._getActiveCompositionNode();
		const outgoing = outgoingId && compositionNode ? ops.findNodeById(xmlStore.root, outgoingId) : null;

		if (!playerStore.isPlaying || !outgoing) {
			playerStore.trigShortcut(selector);
			return;
		}

		const outgoingInfo = readSectionInfo(outgoing, compositionNode);
		const waitSeconds = this._estimateSyncWaitSeconds(outgoing, outgoingInfo, this._cursorTime);
		this._showPendingBlink(targetNode);
		this._pendingBlinkTimer = setTimeout(() => {
			this._pendingBlinkTimer = null;
			this._clearPendingBlink();
			playerStore.trigShortcut(selector);
		}, Math.max(0, waitSeconds) * 1000);
	}

	// v1 estimate only — waxml.js doesn't yet dispatch a live event for "a
	// Section trig is scheduled and waiting on syncTo" (unlike Mixer's solo,
	// see wa-mixer-view.js's _wireMixerUpdateListener/.standby for the real
	// thing). Mirrors the *shape* of waxml.js's own quantize-delay math
	// (Q = syncTo in seconds; wait = time left until the next Q-boundary),
	// reimplemented client-side with parseDivision (already handles syncTo's
	// exact grammar, "off" included). Swap for a real waxml.js event once
	// Hans's engine work adds one. syncTo is read only from the outgoing
	// Section's own attribute — no Composition-level inheritance (confirmed
	// with Hans, unlike tempo/timeSign).
	_estimateSyncWaitSeconds(outgoingSectionNode, outgoingInfo, elapsedSeconds) {
		const q = parseDivision(outgoingSectionNode.attributes.syncTo, outgoingInfo);
		if (!Number.isFinite(q) || q <= 0) return 0;
		return (q - (elapsedSeconds % q)) % q;
	}

	_showPendingBlink(targetNode) {
		const layout = this._lastLayout;
		if (!layout) return;
		let startSeconds = null;
		layout.columns.forEach((c) => {
			if (c.kind === "section" && c.node.id === targetNode.id) startSeconds = c.startSeconds;
			else if (c.kind === "transitions") {
				const row = c.rowRanges.find((r) => r.node.id === targetNode.id);
				if (row) startSeconds = row.startSeconds;
			}
		});
		if (startSeconds === null) return;
		const marker = document.createElement("div");
		marker.className = "pending-marker";
		marker.style.left = `${this._timeToPx(startSeconds)}px`;
		this._rows.appendChild(marker);
		this._pendingMarkerEl = marker;
	}

	_clearPendingBlink() {
		if (this._pendingBlinkTimer) {
			clearTimeout(this._pendingBlinkTimer);
			this._pendingBlinkTimer = null;
		}
		if (this._pendingMarkerEl) {
			this._pendingMarkerEl.remove();
			this._pendingMarkerEl = null;
		}
	}

	// --- playback / playhead ---
	//
	// Same shape as wa-section-view.js's own _onPlayerStoreChange/
	// _readEnginePosition/rAF loop — mirrored, not shared (that file reads
	// against its own single-Section _lastSectionId).

	_onPlayerStoreChange() {
		const isPlaying = playerStore.isPlaying;
		if (isPlaying === this._isPlaying) return;
		this._isPlaying = isPlaying;
		if (isPlaying) {
			this._cursorTime = 0;
			this._playStartAudioTime = playerStore.audioContext.currentTime;
			this._playingSectionId = playerStore.activeSectionId;
			this._startPositionLoop();
		} else {
			this._stopPositionLoop();
			this._playingSectionId = null;
			this._updatePlayheadVisual();
		}
	}

	_readEnginePosition() {
		const iMus = window.iMus;
		if (iMus && typeof iMus.getPosition === "function") {
			const pos = iMus.getPosition();
			if (pos && Number.isFinite(pos.time)) return pos.time;
		}
		return null;
	}

	_startPositionLoop() {
		this._stopPositionLoop();
		const step = () => {
			if (!this._isPlaying) return;
			const enginePos = this._readEnginePosition();
			this._cursorTime = enginePos !== null ? Math.max(0, enginePos) : playerStore.audioContext.currentTime - this._playStartAudioTime;
			this._updatePlayheadVisual();
			this._rafId = requestAnimationFrame(step);
		};
		this._rafId = requestAnimationFrame(step);
	}

	_stopPositionLoop() {
		if (this._rafId) cancelAnimationFrame(this._rafId);
		this._rafId = null;
	}

	// A regular Section with no fixed length loops audibly (its own looping
	// Layers) — the pointer mirrors that by jumping back to bar 1 of that
	// same Section every time it passes sectionContentDuration, per Hans.
	_updatePlayheadVisual() {
		this.shadowRoot.querySelectorAll(".playhead").forEach((el) => el.remove());
		if (!this._isPlaying || !this._playingSectionId || !this._lastLayout) return;

		const cell = this._lastLayout.cells.find((c) => (c.kind === "section" || c.kind === "transition") && c.node.id === this._playingSectionId);
		if (!cell) return;

		const localTime = cell.durationSeconds > 0 ? this._cursorTime % cell.durationSeconds : this._cursorTime;
		const marker = document.createElement("div");
		marker.className = "playhead";
		marker.style.left = `${this._timeToPx(cell.startSeconds + localTime)}px`;
		this._rows.appendChild(marker);
	}
}

customElements.define("wa-composition-view", WaCompositionView);
