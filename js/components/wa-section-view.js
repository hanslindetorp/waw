import { xmlStore } from "../xml-editor/xml-store.js";
import { readSectionInfo, getLayers, getSegments, getOptions, readPos, readLength, readLoopLength, minimumTotalDuration } from "../xml-editor/section-model.js";
import { findSrcAttribute, resolvePlayableUrl } from "../xml-editor/src-attribute.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";
import { WaxmlBridge } from "../waxml-integration/waxml-bridge.js";

// DAW-style "arrange window" for the <section> element type — a first
// sketch (per Hans's own framing): transport bar, a bars/beats ruler derived
// from the section's own tempo/timeSign, one lane per <layer>, <segment>
// (and nested <option>) boxes with waveforms, and a playhead.
//
// Known limitation, called out here rather than silently faked: waxml.js has
// no seek/scrub API we could find (see chat) — Play always starts the engine
// from its own true beginning. Rewind/fast-forward are hidden for now since
// they'd have nothing real to do; Go-to-start stays visible since "stop and
// reset the visual cursor to 0" is meaningful on its own.

const bridge = new WaxmlBridge();

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

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.8rem/1.3 system-ui, sans-serif;
			background: #101214;
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
			padding: 0 0.5rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			border-right: 1px solid var(--waw-border, #2f2f2f);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
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
		.timed-box {
			position: absolute;
			top: 2px;
			bottom: 2px;
			border-radius: 4px;
			border: 1px solid var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.12);
			overflow: hidden;
		}
		.timed-box.option-box {
			border-color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.14);
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
		<div class="empty-hint">Select a &lt;section&gt; element to see it here.</div>
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
		this._onStoreChange();
	}

	disconnectedCallback() {
		this._stopPositionLoop();
	}

	// --- reacting to selection / edits ---

	_onStoreChange() {
		const node = xmlStore.getSelectedNode();

		if (!node || node.tagName !== "section") {
			if (this._lastSectionId !== null) this._teardownActive();
			this._lastSectionId = null;
			return;
		}

		if (node.id !== this._lastSectionId) {
			this._teardownActive();
			this._cursorTime = 0;
			this._maxDecodedEnd = 0;
		}
		this._lastSectionId = node.id;
		this._renderSection(node);
	}

	_teardownActive() {
		this._handleStop();
	}

	// --- transport ---

	_handlePlay() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "section" || !xmlStore.root) return;

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
		const step = node && node.tagName === "section" ? readSectionInfo(node).barDuration : 2;
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
		if (node && node.tagName === "section") this._renderSection(node);
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
		if (!node || node.tagName !== "section") return;
		const info = readSectionInfo(node);
		const bar = Math.floor(this._cursorTime / info.barDuration) + 1;
		const beatInBar = Math.floor((this._cursorTime % info.barDuration) / info.beatDuration) + 1;
		const frac = Math.floor((this._cursorTime % info.beatDuration) / info.beatDuration * 100);
		this._positionEl.textContent = `${bar}.${beatInBar}.${String(frac).padStart(2, "0")}`;
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

		this._grid.innerHTML = "";
		const corner = document.createElement("div");
		corner.className = "corner";
		corner.style.height = `${RULER_HEIGHT}px`;
		this._grid.appendChild(corner);
		this._grid.appendChild(this._buildRuler(info, totalWidth, totalDuration));

		layers.forEach((layer) => {
			this._grid.appendChild(this._buildLayerLabel(layer));
			this._grid.appendChild(this._buildLayerLane(layer, info, totalWidth, totalDuration, token));
		});

		const playhead = document.createElement("div");
		playhead.className = "playhead";
		playhead.style.height = `${RULER_HEIGHT + layers.length * this._rowHeight}px`;
		this._grid.appendChild(playhead);
		this._playheadEl = playhead;

		this._updatePlayheadVisual();
		this._updatePositionReadout();
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
				if (n.tagName === "layer" && readLoopLength(n, info) !== null) return;

				walk(getOptions(n), abs);
				if (n.tagName === "layer") walk(getSegments(n), abs);
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
		if (node && node.tagName === "section") this._renderSection(node);
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

	_buildLayerLabel(layer) {
		const label = document.createElement("div");
		label.className = "layer-label";
		label.style.height = `${this._rowHeight}px`;
		label.textContent = layer.attributes.id || layer.attributes.class || "layer";
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
	_buildLayerLane(layer, info, totalWidth, totalDuration, token) {
		const lane = document.createElement("div");
		lane.className = "layer-lane";
		lane.style.height = `${this._rowHeight}px`;
		lane.style.minWidth = `${totalWidth}px`;

		const segments = getSegments(layer);
		const directOptions = getOptions(layer);
		const loopLength = readLoopLength(layer, info);

		const renderContentAt = (offsetSeconds, allowGrow) => {
			if (segments.length === 0 && directOptions.length === 0) {
				const srcAttr = findSrcAttribute(xmlStore.schema, layer);
				if (srcAttr) {
					this._renderWaveformOnly(lane, srcAttr.value, this._rowHeight, totalWidth, token, offsetSeconds, allowGrow);
				}
				return;
			}
			segments.forEach((segment) => this._renderTimedBox(segment, lane, info, this._rowHeight, token, "segment", offsetSeconds));
			directOptions.forEach((option) => this._renderTimedBox(option, lane, info, this._rowHeight, token, "option", offsetSeconds));
		};

		if (loopLength === null) {
			renderContentAt(0, true);
			return lane;
		}

		const repeatCount = Math.max(1, Math.ceil(totalDuration / loopLength));
		for (let i = 0; i < repeatCount; i++) {
			renderContentAt(i * loopLength, false);
		}

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

	// Renders one <segment> or <option> as a positioned box, recursing into
	// any nested <option> children as stacked "tiers" inside it (per Hans:
	// pos is interpreted relative to the parent box's own start, so DOM
	// nesting alone gives the right on-screen offset with no manual
	// coordinate math). extraOffsetSeconds shifts a looped copy of the
	// containing layer into place — it must NOT be forwarded to the
	// nested-option recursion below, since a nested option's pos is already
	// relative to its parent box's own (already-offset) position.
	_renderTimedBox(node, containerEl, info, availableHeight, token, kind, extraOffsetSeconds = 0) {
		const pos = readPos(node, info) + extraOffsetSeconds;
		const srcAttr = findSrcAttribute(xmlStore.schema, node);
		const resolvedUrl = srcAttr ? resolvePlayableUrl(srcAttr.value) : null;
		const explicitLength = readLength(node, info);

		const box = document.createElement("div");
		box.className = kind === "option" ? "timed-box option-box" : "timed-box";
		box.style.left = `${pos * this._pxPerSecond}px`;
		box.style.top = "2px";
		box.style.bottom = "2px";

		const label = document.createElement("span");
		label.className = "box-label";
		label.textContent = node.attributes.id || node.attributes.class || kind;
		box.appendChild(label);

		const applyWidth = (seconds) => {
			box.style.width = `${Math.max(seconds * this._pxPerSecond, 4)}px`;
		};
		applyWidth(explicitLength ?? info.barDuration * FALLBACK_BOX_BARS);

		containerEl.appendChild(box);

		if (resolvedUrl) {
			const canvas = document.createElement("canvas");
			box.appendChild(canvas);
			this._decode(resolvedUrl).then((buffer) => {
				if (token !== this._renderToken || !buffer) return;
				if (explicitLength === null) applyWidth(buffer.duration);
				canvas.width = Math.max(box.offsetWidth, 1);
				canvas.height = Math.max(box.offsetHeight, 1);
				drawWaveform(canvas, buffer, kind === "option" ? "#45b58c" : WAVEFORM_COLOR);
			});
		}

		const nestedOptions = getOptions(node);
		if (nestedOptions.length > 0) {
			const tierHeight = Math.max((availableHeight - 4) / nestedOptions.length, 12);
			nestedOptions.forEach((option, idx) => {
				const tierContainer = document.createElement("div");
				tierContainer.style.position = "absolute";
				tierContainer.style.left = "0";
				tierContainer.style.right = "0";
				tierContainer.style.top = `${idx * tierHeight}px`;
				tierContainer.style.height = `${tierHeight}px`;
				box.appendChild(tierContainer);
				this._renderTimedBox(option, tierContainer, info, tierHeight, token, "option");
			});
		}
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
