import { xmlStore } from "../xml-editor/xml-store.js";
import { vfs } from "../vfs/VFS.js";
import { VFS_FILE_DRAG_TYPE } from "../vfs/drag-types.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import {
	readSectionInfo,
	getLayers,
	getSegments,
	getOptions,
	readPos,
	readLength,
	readLoopLength,
	minimumTotalDuration,
	secondsToPosString
} from "../xml-editor/section-model.js";
import { findSrcAttribute, getSchemaSrcAttributeName, resolvePlayableUrl } from "../xml-editor/src-attribute.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";
import { WaxmlBridge } from "../waxml-integration/waxml-bridge.js";

// DAW-style "arrange window" for the <Section> element type: transport bar, a
// bars/beats ruler derived from the section's own tempo/timeSign, one lane per
// <Layer>, <Segment>/<Option> boxes with waveforms, and a playhead — plus
// direct editing: drag audio files from the File Manager to create/replace
// content, open a Segment to see/reorder its Options as real rows, drag
// Options around, multi-select + Delete/Backspace. Every edit goes through
// xmlStore, so the XML editor and XML code panels already stay in sync for
// free.
//
// Known limitation, called out here rather than silently faked: waxml.js has
// no seek/scrub API we could find (see chat) — Play always starts the engine
// from its own true beginning. Rewind/fast-forward are hidden for now since
// they'd have nothing real to do; Go-to-start stays visible since "stop and
// reset the visual cursor to 0" is meaningful on its own.

const bridge = new WaxmlBridge();

// Internal-only drag type for moving an <Option> box around within the
// Preview (reorder within a Segment, move to another Segment/Layer, or drop
// it somewhere new entirely) — distinct from VFS_FILE_DRAG_TYPE (a file
// dragged in from the File Manager) so drop handlers can tell the two apart.
const OPTION_DRAG_TYPE = "application/x-waw-option-node";

const MIN_PX_PER_SEC = 5;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 40;
const MIN_ROW_HEIGHT = 32;
const MAX_ROW_HEIGHT = 160;
const DEFAULT_ROW_HEIGHT = 56;
const LABEL_WIDTH = 140;
const RULER_HEIGHT = 32;
const FALLBACK_BOX_BARS = 1;
const WAVEFORM_COLOR = "#4fa3ff";
const DROPZONE_HEIGHT = 10;
// "Quantized to the nearest grid point (e.g. 1/4)" — this engine always
// defines one beat as 60/tempo regardless of the meter's denominator (see
// readSectionInfo), so a beat *is* a quarter note here; 1-beat granularity
// matches that literally.
const GRID_BEATS = 1;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.8rem/1.3 system-ui, sans-serif;
			background: #101214;
			user-select: none;
		}
		.transport {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.4rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
			flex-wrap: wrap;
		}
		.tp-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.55rem;
			font-size: 0.85rem;
			line-height: 1;
			cursor: pointer;
			min-width: 2rem;
		}
		.tp-btn:hover {
			background: #2f333a;
		}
		.tp-btn.active {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #06131f;
		}
		.tp-position {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			color: var(--waw-fg, #e8e8e8);
			margin-left: 0.3rem;
			white-space: nowrap;
		}
		.tp-info {
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		.zoom-controls {
			margin-left: auto;
			display: flex;
			align-items: center;
			gap: 0.25rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.zoom-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			width: 1.5rem;
			height: 1.5rem;
			line-height: 1;
			cursor: pointer;
		}
		.zoom-btn:hover {
			background: #2f333a;
		}

		.scroll-area {
			flex: 1 1 auto;
			overflow: auto;
			position: relative;
		}
		.empty-hint {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			padding: 2rem 1rem;
		}
		.grid {
			position: relative;
			display: grid;
			grid-template-columns: ${LABEL_WIDTH}px 1fr;
			width: max-content;
			min-width: 100%;
		}
		.corner,
		.ruler,
		.layer-label {
			background: var(--waw-panel-bg, #1a1a1a);
		}
		.corner {
			position: sticky;
			top: 0;
			left: 0;
			z-index: 6;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			border-right: 1px solid var(--waw-border, #2f2f2f);
		}
		.ruler {
			position: sticky;
			top: 0;
			z-index: 5;
			width: 100%;
			height: ${RULER_HEIGHT}px;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			overflow: hidden;
		}
		.ruler-tick {
			position: absolute;
			top: 0;
			bottom: 0;
			border-left: 1px solid var(--waw-tree-connector, #3a3a3a);
		}
		.ruler-tick.bar {
			border-left-color: var(--waw-muted, #8a8a8a);
		}
		.ruler-tick .tick-label {
			position: absolute;
			top: 2px;
			left: 3px;
			font-size: 0.65rem;
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		.layer-label {
			position: sticky;
			left: 0;
			z-index: 4;
			display: flex;
			align-items: center;
			gap: 0.3rem;
			padding: 0 0.5rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			border-right: 1px solid var(--waw-border, #2f2f2f);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;
		}
		.layer-label.selected {
			background: rgba(79, 163, 255, 0.18);
		}
		.layer-lane {
			position: relative;
			width: 100%;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			background: repeating-linear-gradient(
				90deg,
				rgba(255, 255, 255, 0.02) 0,
				rgba(255, 255, 255, 0.02) 1px,
				transparent 1px,
				transparent 100%
			);
			overflow: hidden;
		}
		.layer-lane.drop-active {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -2px;
		}
		.dropzone-filler {
			border-right: 1px solid var(--waw-border, #2f2f2f);
		}
		.dropzone {
			position: relative;
			height: ${DROPZONE_HEIGHT}px;
		}
		.dropzone.drop-active {
			background: var(--waw-accent, #4fa3ff);
		}
		.timed-box {
			position: absolute;
			border-radius: 4px;
			border: 1px solid var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.12);
			overflow: hidden;
			cursor: pointer;
		}
		.timed-box.option-box {
			border-color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.14);
		}
		.timed-box.selected {
			outline: 2px solid var(--waw-fg, #e8e8e8);
			outline-offset: -1px;
		}
		.timed-box.drop-active {
			outline: 2px dashed var(--waw-fg, #e8e8e8);
			outline-offset: -2px;
		}
		.timed-box canvas {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		.timed-box .box-label {
			position: absolute;
			top: 1px;
			left: 4px;
			font-size: 0.62rem;
			color: var(--waw-fg, #e8e8e8);
			opacity: 0.8;
			pointer-events: none;
			white-space: nowrap;
			z-index: 1;
		}
		.timed-box .disclosure {
			position: absolute;
			top: 1px;
			right: 2px;
			z-index: 2;
			background: none;
			border: none;
			color: var(--waw-fg, #e8e8e8);
			opacity: 0.8;
			cursor: pointer;
			font-size: 0.6rem;
			padding: 0 0.1rem;
			line-height: 1.2;
		}
		.playhead {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 0;
			border-left: 2px solid #ff5a5a;
			z-index: 3;
			pointer-events: none;
		}
	</style>
	<div class="transport">
		<button class="tp-btn" data-action="start" title="Go to start">|◀</button>
		<button class="tp-btn" data-action="rewind" title="Rewind" hidden>◀◀</button>
		<button class="tp-btn tp-play" data-action="play" title="Play">▶</button>
		<button class="tp-btn" data-action="stop" title="Stop">■</button>
		<button class="tp-btn" data-action="forward" title="Fast forward" hidden>▶▶</button>
		<span class="tp-position">1.1.00</span>
		<span class="tp-info"></span>
		<div class="zoom-controls">
			<span>H</span>
			<button class="zoom-btn" data-zoom="h-out">−</button>
			<button class="zoom-btn" data-zoom="h-in">+</button>
			<span>V</span>
			<button class="zoom-btn" data-zoom="v-out">−</button>
			<button class="zoom-btn" data-zoom="v-in">+</button>
		</div>
	</div>
	<div class="scroll-area">
		<div class="grid" hidden>
			<div class="corner"></div>
			<div class="ruler"></div>
		</div>
		<div class="empty-hint">Select a &lt;Section&gt; element to see it here.</div>
	</div>
`;

export class WaSectionView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._scrollArea = this.shadowRoot.querySelector(".scroll-area");
		this._grid = this.shadowRoot.querySelector(".grid");
		this._ruler = this.shadowRoot.querySelector(".ruler");
		this._emptyHint = this.shadowRoot.querySelector(".empty-hint");
		this._positionEl = this.shadowRoot.querySelector(".tp-position");
		this._infoEl = this.shadowRoot.querySelector(".tp-info");
		this._playBtn = this.shadowRoot.querySelector('[data-action="play"]');

		this._pxPerSecond = DEFAULT_PX_PER_SEC;
		this._rowHeight = DEFAULT_ROW_HEIGHT;
		this._cursorTime = 0;
		this._isPlaying = false;
		this._playStartAudioTime = 0;
		this._renderToken = 0;
		this._bufferCache = new Map(); // resolvedUrl -> Promise<AudioBuffer>
		this._lastSectionId = null;
		this._maxDecodedEnd = 0; // seconds; grows monotonically as bare-layer srcs decode
		this._openSegmentIds = new Set();
		this._selectedIds = new Set(); // multi-select for bulk delete (Layer/Segment/Option ids)

		this._onKeyDown = this._onKeyDown.bind(this);
	}

	connectedCallback() {
		this.shadowRoot.querySelector('[data-action="play"]').addEventListener("click", () => this._handlePlay());
		this.shadowRoot.querySelector('[data-action="stop"]').addEventListener("click", () => this._handleStop());
		this.shadowRoot.querySelector('[data-action="start"]').addEventListener("click", () => this._handleGoToStart());
		this.shadowRoot.querySelector('[data-action="rewind"]').addEventListener("click", () => this._handleSeekRelative(-1));
		this.shadowRoot.querySelector('[data-action="forward"]').addEventListener("click", () => this._handleSeekRelative(1));

		this.shadowRoot.querySelectorAll(".zoom-btn").forEach((btn) => {
			btn.addEventListener("click", () => this._handleZoom(btn.dataset.zoom));
		});

		xmlStore.addEventListener("change", () => this._onStoreChange());
		document.addEventListener("keydown", this._onKeyDown);
		this._onStoreChange();
	}

	disconnectedCallback() {
		this._stopPositionLoop();
		document.removeEventListener("keydown", this._onKeyDown);
	}

	// --- reacting to selection / edits ---

	// Which <Section> we're showing is "sticky": it only changes when the
	// user explicitly selects a *different* Section (from the XML tree, or
	// by picking a new one here). Clicking a Layer/Segment/Option box in
	// this view also updates xmlStore's global selection (so the Inspector
	// follows it), which would otherwise make getSelectedNode() stop being a
	// Section and tear this whole view down out from under the user — so we
	// track our own active section id instead of trusting "is the currently
	// selected node a Section" on every store change.
	_onStoreChange() {
		const selected = xmlStore.getSelectedNode();

		if (selected && selected.tagName === "Section" && selected.id !== this._lastSectionId) {
			this._teardownActive();
			this._cursorTime = 0;
			this._maxDecodedEnd = 0;
			this._openSegmentIds.clear();
			this._selectedIds.clear();
			this._lastSectionId = selected.id;
		}

		if (!this._lastSectionId) return;

		const node = ops.findNodeById(xmlStore.root, this._lastSectionId);
		if (!node) {
			// The section we were showing got deleted.
			this._teardownActive();
			this._lastSectionId = null;
			this._grid.hidden = true;
			this._emptyHint.hidden = false;
			return;
		}

		this._renderSection(node);
	}

	_teardownActive() {
		this._handleStop();
	}

	// --- transport ---

	_handlePlay() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Section" || !xmlStore.root) return;

		// No known seek API (see file header) — every Play starts the engine
		// from its true beginning, so the visual cursor always resets to 0 too.
		this._cursorTime = 0;
		bridge.loadDocumentTargeting(xmlStore.root, node.id).then(() => {
			bridge.play();
			this._isPlaying = true;
			this._playBtn.classList.add("active");
			this._playStartAudioTime = bridge.audioContext.currentTime;
			this._startPositionLoop();
		});
	}

	_readEnginePosition() {
		const iMus = window.iMus;
		if (iMus && typeof iMus.getPosition === "function") {
			const pos = iMus.getPosition();
			if (pos && Number.isFinite(pos.time)) return pos.time;
		}
		return null;
	}

	_handleStop() {
		if (this._isPlaying) {
			try {
				bridge.stop();
			} catch {
				// waxml not loaded / nothing playing — fine, we're stopping anyway.
			}
		}
		this._isPlaying = false;
		this._playBtn.classList.remove("active");
		this._stopPositionLoop();
		this._updatePlayheadVisual();
	}

	_handleGoToStart() {
		this._handleStop();
		this._cursorTime = 0;
		this._updatePlayheadVisual();
		this._updatePositionReadout();
	}

	_handleSeekRelative(direction) {
		this._handleStop();
		const node = xmlStore.getSelectedNode();
		const step = node && node.tagName === "Section" ? readSectionInfo(node).barDuration : 2;
		this._cursorTime = Math.max(0, this._cursorTime + direction * step);
		this._updatePlayheadVisual();
		this._updatePositionReadout();
	}

	_handleZoom(kind) {
		if (kind === "h-in") this._pxPerSecond = Math.min(MAX_PX_PER_SEC, this._pxPerSecond * 1.4);
		else if (kind === "h-out") this._pxPerSecond = Math.max(MIN_PX_PER_SEC, this._pxPerSecond / 1.4);
		else if (kind === "v-in") this._rowHeight = Math.min(MAX_ROW_HEIGHT, this._rowHeight * 1.25);
		else if (kind === "v-out") this._rowHeight = Math.max(MIN_ROW_HEIGHT, this._rowHeight / 1.25);

		const node = xmlStore.getSelectedNode();
		if (node && node.tagName === "Section") this._renderSection(node);
	}

	// --- playhead animation ---

	_startPositionLoop() {
		this._stopPositionLoop();
		const step = () => {
			if (!this._isPlaying) return;
			// window.iMus.getPosition().time is already relative to this
			// section's musical start (0s) — fall back to our own wall-clock
			// tracking only if the engine function is ever unavailable.
			const enginePos = this._readEnginePosition();
			if (enginePos !== null) {
				this._cursorTime = Math.max(0, enginePos);
			} else {
				this._cursorTime = bridge.audioContext.currentTime - this._playStartAudioTime;
			}
			this._updatePlayheadVisual();
			this._updatePositionReadout();
			this._rafId = requestAnimationFrame(step);
		};
		this._rafId = requestAnimationFrame(step);
	}

	_stopPositionLoop() {
		if (this._rafId) cancelAnimationFrame(this._rafId);
		this._rafId = null;
	}

	_updatePlayheadVisual() {
		if (this._playheadEl) {
			this._playheadEl.style.left = `${LABEL_WIDTH + this._cursorTime * this._pxPerSecond}px`;
		}
		if (this._isPlaying && this._scrollArea) {
			const targetLeft = this._cursorTime * this._pxPerSecond - this._scrollArea.clientWidth * 0.3;
			if (Math.abs(this._scrollArea.scrollLeft - targetLeft) > this._scrollArea.clientWidth * 0.6) {
				this._scrollArea.scrollLeft = Math.max(0, targetLeft);
			}
		}
	}

	_updatePositionReadout() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Section") return;
		const info = readSectionInfo(node);
		const bar = Math.floor(this._cursorTime / info.barDuration) + 1;
		const beatInBar = Math.floor((this._cursorTime % info.barDuration) / info.beatDuration) + 1;
		const frac = Math.floor((this._cursorTime % info.beatDuration) / info.beatDuration * 100);
		this._positionEl.textContent = `${bar}.${beatInBar}.${String(frac).padStart(2, "0")}`;
	}

	// --- selection & deletion ---

	_handleItemClick(id, e) {
		if (e.metaKey || e.ctrlKey) {
			if (this._selectedIds.has(id)) this._selectedIds.delete(id);
			else this._selectedIds.add(id);
		} else {
			this._selectedIds = new Set([id]);
		}
		xmlStore.selectNode(id);
		this._updateSelectionHighlight();
	}

	_updateSelectionHighlight() {
		this._grid.querySelectorAll("[data-node-id]").forEach((el) => {
			el.classList.toggle("selected", this._selectedIds.has(el.dataset.nodeId));
		});
	}

	_onKeyDown(e) {
		if (e.key !== "Delete" && e.key !== "Backspace") return;
		if (this._selectedIds.size === 0) return;
		if (this._isTextEditingFocused()) return;

		e.preventDefault();
		const ids = [...this._selectedIds];
		this._selectedIds.clear();
		ids.forEach((id) => xmlStore.removeNode(id));
	}

	// document.activeElement doesn't pierce shadow DOM — an input focused
	// inside another component's shadow root (e.g. the node inspector) would
	// otherwise report as that component's host tag, not "INPUT", and Delete/
	// Backspace meant for that field would get hijacked here instead.
	_isTextEditingFocused() {
		let el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
		if (!el) return false;
		return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
	}

	// --- layout / rendering ---

	_renderSection(node) {
		this._renderToken += 1;
		const token = this._renderToken;

		this._emptyHint.hidden = true;
		this._grid.hidden = false;

		const info = readSectionInfo(node);
		this._infoEl.textContent = `${info.tempo} BPM · ${info.timeSign.label}${info.id ? " · " + info.id : ""}`;

		const layers = getLayers(node);
		const totalDuration = Math.max(minimumTotalDuration(info), this._estimateMaxEnd(layers, info));
		const totalWidth = totalDuration * this._pxPerSecond;
		const rowsPerLayer = layers.map((layer) => this._rowsNeededForLayer(layer));

		this._grid.innerHTML = "";
		const corner = document.createElement("div");
		corner.className = "corner";
		corner.style.height = `${RULER_HEIGHT}px`;
		this._grid.appendChild(corner);
		this._grid.appendChild(this._buildRuler(info, totalWidth, totalDuration));

		this._grid.appendChild(this._buildDropZoneFiller());
		this._grid.appendChild(this._buildDropZone(node, layers, 0, info, totalWidth));

		layers.forEach((layer, idx) => {
			this._grid.appendChild(this._buildLayerLabel(layer, rowsPerLayer[idx]));
			this._grid.appendChild(this._buildLayerLane(layer, info, totalWidth, totalDuration, token, rowsPerLayer[idx]));
			this._grid.appendChild(this._buildDropZoneFiller());
			this._grid.appendChild(this._buildDropZone(node, layers, idx + 1, info, totalWidth));
		});

		const totalRowsHeight = rowsPerLayer.reduce((sum, n) => sum + n * this._rowHeight, 0);
		const dropZoneCount = layers.length + 1;
		const playhead = document.createElement("div");
		playhead.className = "playhead";
		playhead.style.height = `${RULER_HEIGHT + totalRowsHeight + dropZoneCount * DROPZONE_HEIGHT}px`;
		this._grid.appendChild(playhead);
		this._playheadEl = playhead;

		this._updatePlayheadVisual();
		this._updatePositionReadout();
		this._updateSelectionHighlight();
	}

	// A layer normally occupies one row. If one or more of its segments are
	// "open" (see the disclosure triangle in _renderSegmentBox), it grows to
	// fit whichever open segment has the most Options — closed segments just
	// keep spanning the full (now possibly taller) lane as a single box.
	_rowsNeededForLayer(layer) {
		const openSegments = getSegments(layer).filter((s) => this._openSegmentIds.has(s.id));
		if (openSegments.length === 0) return 1;
		return Math.max(...openSegments.map((s) => Math.max(getOptions(s).length, 1)));
	}

	// Provisional total length from explicit pos/length attributes, plus
	// whatever bare-layer src durations have been decoded so far
	// (this._maxDecodedEnd, grown monotonically by _growTimelineTo below —
	// segment/option boxes always have an explicit or bar-fallback width up
	// front, so only bare layers need this deferred-width handling).
	_estimateMaxEnd(layers, info, end = 0) {
		const walk = (nodes, parentPos) => {
			nodes.forEach((n) => {
				const abs = parentPos + readPos(n, info);
				const len = readLength(n, info) ?? info.barDuration * FALLBACK_BOX_BARS;
				end = Math.max(end, abs + len);

				// A looping layer's own content is tiled to fill whatever
				// duration everything else already establishes (see
				// _buildLayerLane) — it must not drive the timeline outward
				// itself, or a short loop on a long-lived section would
				// grow forever as more copies get laid out.
				if (n.tagName === "Layer" && readLoopLength(n, info) !== null) return;

				walk(getOptions(n), abs);
				if (n.tagName === "Layer") walk(getSegments(n), abs);
			});
		};
		walk(layers, 0);
		return Math.max(end, this._maxDecodedEnd);
	}

	// Called once a bare layer src finishes decoding. Only triggers a re-render
	// when it genuinely raises the known max (monotonic), so this can never
	// loop — each bare-layer src can cause at most one re-layout.
	_growTimelineTo(seconds) {
		if (seconds <= this._maxDecodedEnd) return;
		this._maxDecodedEnd = seconds;
		const node = xmlStore.getSelectedNode();
		if (node && node.tagName === "Section") this._renderSection(node);
	}

	_buildRuler(info, totalWidth, totalDuration) {
		const ruler = document.createElement("div");
		ruler.className = "ruler";
		ruler.style.minWidth = `${totalWidth}px`;

		const barCount = Math.ceil(totalDuration / info.barDuration) + 1;
		for (let bar = 0; bar < barCount; bar++) {
			const tick = document.createElement("div");
			tick.className = "ruler-tick bar";
			tick.style.left = `${bar * info.barDuration * this._pxPerSecond}px`;
			const label = document.createElement("span");
			label.className = "tick-label";
			label.textContent = String(bar + 1);
			tick.appendChild(label);
			ruler.appendChild(tick);

			if (this._pxPerSecond * info.beatDuration > 18) {
				for (let beat = 1; beat < info.timeSign.numerator; beat++) {
					const beatTick = document.createElement("div");
					beatTick.className = "ruler-tick";
					beatTick.style.left = `${(bar * info.barDuration + beat * info.beatDuration) * this._pxPerSecond}px`;
					ruler.appendChild(beatTick);
				}
			}
		}

		this._ruler = ruler;
		return ruler;
	}

	_buildLayerLabel(layer, rowsNeeded) {
		const label = document.createElement("div");
		label.className = "layer-label";
		label.dataset.nodeId = layer.id;
		label.style.height = `${this._rowHeight * rowsNeeded}px`;
		label.textContent = layer.attributes.id || layer.attributes.class || "Layer";
		label.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(layer.id, e);
		});
		return label;
	}

	// Non-looping layers render their content once, at offset 0, and are
	// allowed to grow the overall timeline (a bare src's decoded duration is
	// the only source of length info we have for it up front). A layer with
	// a loopLength instead tiles its WHOLE content (bare src, or its
	// segment/option children) every loopLength seconds, only as many times
	// as needed to fill the timeline duration already established by
	// everything else — never open-ended. Later copies are appended later in
	// DOM order, so an audio tail past loopLength or a segment with a
	// negative pos (an upbeat) naturally paints over the previous loop's
	// tail via normal stacking order, with no extra z-index bookkeeping.
	_buildLayerLane(layer, info, totalWidth, totalDuration, token, rowsNeeded) {
		const lane = document.createElement("div");
		lane.className = "layer-lane";
		lane.style.height = `${this._rowHeight * rowsNeeded}px`;
		lane.style.minWidth = `${totalWidth}px`;

		const segments = getSegments(layer);
		const directOptions = getOptions(layer);
		const loopLength = readLoopLength(layer, info);
		const laneHeight = this._rowHeight * rowsNeeded;

		const renderContentAt = (offsetSeconds, allowGrow) => {
			if (segments.length === 0 && directOptions.length === 0) {
				const srcAttr = findSrcAttribute(xmlStore.schema, layer);
				if (srcAttr) {
					this._renderWaveformOnly(lane, srcAttr.value, laneHeight, totalWidth, token, offsetSeconds, allowGrow);
				}
				return;
			}
			segments.forEach((segment) => this._renderSegmentBox(segment, lane, info, token, offsetSeconds, laneHeight));
			directOptions.forEach((option) =>
				lane.appendChild(this._renderTimedBox(option, info, token, "Option", offsetSeconds, { top: 2, height: laneHeight - 4 }))
			);
		};

		if (loopLength === null) {
			renderContentAt(0, true);
		} else {
			const repeatCount = Math.max(1, Math.ceil(totalDuration / loopLength));
			for (let i = 0; i < repeatCount; i++) {
				renderContentAt(i * loopLength, false);
			}
		}

		this._wireLaneDropTarget(lane, layer, info);
		lane.addEventListener("click", (e) => {
			if (e.target === lane) this._clearSelection();
		});

		return lane;
	}

	// A bare layer src with no segments: one continuous waveform, as wide as
	// the decoded file actually is (schema gives layers no pos/length of
	// their own). offsetSeconds shifts a looped copy into place; allowGrow is
	// false for those copies since a looping layer must fill existing bounds
	// rather than extend them (only the first/non-looping placement can grow
	// the timeline).
	_renderWaveformOnly(lane, rawSrc, heightPx, laneWidth, token, offsetSeconds = 0, allowGrow = true) {
		const resolvedUrl = resolvePlayableUrl(rawSrc);
		if (!resolvedUrl) return;

		const offsetPx = offsetSeconds * this._pxPerSecond;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(laneWidth - offsetPx, 1);
		canvas.height = heightPx;
		canvas.style.position = "absolute";
		canvas.style.left = `${offsetPx}px`;
		canvas.style.top = "0";
		lane.appendChild(canvas);

		this._decode(resolvedUrl).then((buffer) => {
			if (token !== this._renderToken || !buffer) return;
			const durationPx = buffer.duration * this._pxPerSecond;
			canvas.width = Math.max(durationPx, 1);
			canvas.style.width = `${durationPx}px`;
			drawWaveform(canvas, buffer, WAVEFORM_COLOR);
			if (allowGrow) this._growTimelineTo(offsetSeconds + buffer.duration);
		});
	}

	// A <Segment> is either a single compact box (closed, or nothing to open)
	// spanning the whole lane height, or — while "open" via its disclosure
	// triangle — expands into one full-width row per <Option> child, each
	// independently positioned/selectable/draggable. Segments themselves
	// aren't draggable (only Options are, per spec); a segment box is still a
	// valid file/option drop target when it has no Options of its own (its
	// own src gets replaced, same as dropping onto an Option).
	_renderSegmentBox(segment, lane, info, token, extraOffsetSeconds, laneHeight) {
		const isOpen = this._openSegmentIds.has(segment.id);
		const options = getOptions(segment);

		if (!isOpen || options.length === 0) {
			const box = this._renderTimedBox(segment, info, token, "Segment", extraOffsetSeconds, { top: 2, height: laneHeight - 4 });
			if (options.length > 0) box.appendChild(this._buildDisclosureButton(segment.id, true));
			lane.appendChild(box);
			return;
		}

		options.forEach((option, idx) => {
			const box = this._renderTimedBox(option, info, token, "Option", extraOffsetSeconds, {
				top: idx * this._rowHeight + 2,
				height: this._rowHeight - 4
			});
			if (idx === 0) box.appendChild(this._buildDisclosureButton(segment.id, false));
			lane.appendChild(box);
		});
	}

	_buildDisclosureButton(segmentId, isCollapsed) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "disclosure";
		btn.title = "Show/hide this Segment's Options";
		btn.textContent = isCollapsed ? "▸" : "▾";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (isCollapsed) this._openSegmentIds.add(segmentId);
			else this._openSegmentIds.delete(segmentId);
			const node = xmlStore.getSelectedNode();
			if (node && node.tagName === "Section") this._renderSection(node);
		});
		return btn;
	}

	// Renders one <Segment> or <Option> as a positioned box at an explicit
	// {top, height} within its container (the layer lane) — the caller
	// decides that layout (closed segment spans the full lane; an open
	// segment's options each get their own row; a layer's own direct option
	// spans the full lane). extraOffsetSeconds shifts a looped copy of the
	// containing layer into place.
	_renderTimedBox(node, info, token, kind, extraOffsetSeconds, layout) {
		const pos = readPos(node, info) + extraOffsetSeconds;
		const srcAttr = findSrcAttribute(xmlStore.schema, node);
		const resolvedUrl = srcAttr ? resolvePlayableUrl(srcAttr.value) : null;
		const explicitLength = readLength(node, info);

		const box = document.createElement("div");
		box.className = kind === "Option" ? "timed-box option-box" : "timed-box";
		box.dataset.nodeId = node.id;
		box.style.left = `${pos * this._pxPerSecond}px`;
		box.style.top = `${layout.top}px`;
		box.style.height = `${layout.height}px`;
		box.classList.toggle("selected", this._selectedIds.has(node.id));

		const label = document.createElement("span");
		label.className = "box-label";
		label.textContent = node.attributes.id || node.attributes.class || kind;
		box.appendChild(label);

		const applyWidth = (seconds) => {
			box.style.width = `${Math.max(seconds * this._pxPerSecond, 4)}px`;
		};
		applyWidth(explicitLength ?? info.barDuration * FALLBACK_BOX_BARS);

		if (resolvedUrl) {
			const canvas = document.createElement("canvas");
			box.appendChild(canvas);
			this._decode(resolvedUrl).then((buffer) => {
				if (token !== this._renderToken || !buffer) return;
				if (explicitLength === null) applyWidth(buffer.duration);
				canvas.width = Math.max(box.offsetWidth, 1);
				canvas.height = Math.max(box.offsetHeight, 1);
				drawWaveform(canvas, buffer, kind === "Option" ? "#45b58c" : WAVEFORM_COLOR);
			});
		}

		box.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(node.id, e);
		});

		if (kind === "Option") {
			box.draggable = true;
			box.addEventListener("dragstart", (e) => {
				e.stopPropagation();
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData(OPTION_DRAG_TYPE, node.id);
			});
		}

		this._wireBoxDropTarget(box, node, kind, info);

		return box;
	}

	// A Segment-without-options or an Option accepts a drop directly on it:
	// a file replaces its src; a dragged Option reparents alongside it
	// (same segment if `node` is an Option, or into `node` itself if it's a
	// bare Segment). stopPropagation keeps the lane's own "empty space"
	// handler (which creates a brand new Segment) from also firing.
	_wireBoxDropTarget(box, node, kind, info) {
		box.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = types.includes(VFS_FILE_DRAG_TYPE) ? "copy" : "move";
			box.classList.add("drop-active");
		});
		box.addEventListener("dragleave", () => box.classList.remove("drop-active"));
		box.addEventListener("drop", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			e.stopPropagation();
			box.classList.remove("drop-active");

			if (types.includes(VFS_FILE_DRAG_TYPE)) {
				const fileId = e.dataTransfer.getData(VFS_FILE_DRAG_TYPE);
				this._replaceBoxSrc(node.id, fileId);
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId || draggedOptionId === node.id) return;
			// Dropped on an Option -> insert just before it, in that Option's
			// Segment (this is what makes reordering within a Segment work,
			// not just moving an Option to a different one). Dropped on a
			// bare Segment (no Options) -> become its child.
			const targetParentId = kind === "Option" ? node.parent : node.id;
			const insertIndex = kind === "Option" ? this._insertIndexBefore(targetParentId, node.id, draggedOptionId) : undefined;
			xmlStore.reparentNode(draggedOptionId, targetParentId, insertIndex);
		});
	}

	// Index to pass to xmlStore.reparentNode so the dragged node lands
	// immediately before `targetId` within `parentId`'s children — accounting
	// for the fact that reparentNode removes the dragged node from the tree
	// (shifting later indices down by one) before reinserting it, which
	// matters when both nodes already share the same parent (a same-Segment
	// reorder).
	_insertIndexBefore(parentId, targetId, draggedId) {
		const parent = ops.findNodeById(xmlStore.root, parentId);
		if (!parent) return undefined;
		const rawIndex = parent.children.findIndex((c) => c.id === targetId);
		if (rawIndex === -1) return undefined;
		const draggedIndex = parent.children.findIndex((c) => c.id === draggedId);
		return draggedIndex !== -1 && draggedIndex < rawIndex ? rawIndex - 1 : rawIndex;
	}

	_replaceBoxSrc(nodeId, fileId) {
		const fileNode = vfs.getNode(fileId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);
		const node = ops.findNodeById(xmlStore.root, nodeId);
		if (!node) return;
		const existing = findSrcAttribute(xmlStore.schema, node);
		const attrName = existing?.attrName || getSchemaSrcAttributeName(xmlStore.schema, node.tagName) || "src";
		xmlStore.updateAttributes(nodeId, { ...node.attributes, [attrName]: exportPath });
	}

	// Layer background (not hitting an existing Segment/Option box): a
	// dropped file creates a brand-new <Segment><Option src="..."/></Segment>
	// at the (quantized) drop position; a dragged Option gets reparented into
	// a brand-new Segment there instead, losing its own old pos (position="0"
	// relative to the new segment, i.e. omitted, means "right at its start").
	_wireLaneDropTarget(lane, layer, info) {
		lane.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = types.includes(VFS_FILE_DRAG_TYPE) ? "copy" : "move";
			lane.classList.add("drop-active");
		});
		lane.addEventListener("dragleave", (e) => {
			if (e.target === lane) lane.classList.remove("drop-active");
		});
		lane.addEventListener("drop", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			lane.classList.remove("drop-active");

			const posString = this._dropPositionString(e, lane, info);

			if (types.includes(VFS_FILE_DRAG_TYPE)) {
				const fileId = e.dataTransfer.getData(VFS_FILE_DRAG_TYPE);
				this._createSegmentWithOption(layer.id, posString, fileId);
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId) return;
			const segment = xmlStore.insertNewChild(layer.id, "Segment", { pos: posString });
			xmlStore.reparentNode(draggedOptionId, segment.id);
			this._stripPos(draggedOptionId);
		});
	}

	_dropPositionString(e, referenceEl, info) {
		const rect = referenceEl.getBoundingClientRect();
		const seconds = Math.max(0, (e.clientX - rect.left + referenceEl.scrollLeft) / this._pxPerSecond);
		return secondsToPosString(seconds, info, GRID_BEATS);
	}

	_createSegmentWithOption(layerId, posString, fileId) {
		const fileNode = vfs.getNode(fileId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);
		const segment = xmlStore.insertNewChild(layerId, "Segment", { pos: posString });
		xmlStore.insertNewChild(segment.id, "Option", { src: exportPath });
	}

	_stripPos(nodeId) {
		const node = ops.findNodeById(xmlStore.root, nodeId);
		if (!node || node.attributes.pos === undefined) return;
		const next = { ...node.attributes };
		delete next.pos;
		xmlStore.updateAttributes(nodeId, next);
	}

	_clearSelection() {
		if (this._selectedIds.size === 0) return;
		this._selectedIds.clear();
		this._updateSelectionHighlight();
	}

	// Thin strips between (and above/below) layer rows — dropping a file or a
	// dragged Option here creates a whole new <Layer> at that vertical spot,
	// with a new Segment/Option at the (quantized) horizontal drop position.
	_buildDropZone(sectionNode, layers, zoneIndex, info, totalWidth) {
		const zone = document.createElement("div");
		zone.className = "dropzone";
		zone.style.minWidth = `${totalWidth}px`;

		zone.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = types.includes(VFS_FILE_DRAG_TYPE) ? "copy" : "move";
			zone.classList.add("drop-active");
		});
		zone.addEventListener("dragleave", () => zone.classList.remove("drop-active"));
		zone.addEventListener("drop", (e) => {
			const types = e.dataTransfer.types;
			if (!types.includes(VFS_FILE_DRAG_TYPE) && !types.includes(OPTION_DRAG_TYPE)) return;
			e.preventDefault();
			zone.classList.remove("drop-active");

			const posString = this._dropPositionString(e, zone, info);
			const insertIndex = this._layerInsertIndex(sectionNode, layers, zoneIndex);
			const layer = xmlStore.insertNewChild(sectionNode.id, "Layer", {}, insertIndex);

			if (types.includes(VFS_FILE_DRAG_TYPE)) {
				const fileId = e.dataTransfer.getData(VFS_FILE_DRAG_TYPE);
				this._createSegmentWithOption(layer.id, posString, fileId);
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId) return;
			const segment = xmlStore.insertNewChild(layer.id, "Segment", { pos: posString });
			xmlStore.reparentNode(draggedOptionId, segment.id);
			this._stripPos(draggedOptionId);
		});

		return zone;
	}

	_buildDropZoneFiller() {
		const filler = document.createElement("div");
		filler.className = "dropzone-filler";
		return filler;
	}

	_layerInsertIndex(sectionNode, layers, zoneIndex) {
		if (layers.length === 0) return sectionNode.children.length;
		if (zoneIndex === 0) return sectionNode.children.findIndex((c) => c.id === layers[0].id);
		const prevLayer = layers[zoneIndex - 1];
		return sectionNode.children.findIndex((c) => c.id === prevLayer.id) + 1;
	}

	_decode(url) {
		if (!this._bufferCache.has(url)) {
			this._bufferCache.set(
				url,
				decodeAudioBuffer(url, bridge.audioContext).catch((err) => {
					console.warn("Section view: could not decode", url, err);
					return null;
				})
			);
		}
		return this._bufferCache.get(url);
	}
}

customElements.define("wa-section-view", WaSectionView);
