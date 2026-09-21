import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { computeMapPoints, mapoutPointPositions, applyConvertFn, computeConvertPoints, validateConvertExpression, mapStage1 } from "../xml-editor/var-mapper-math.js";

// Preview-panel state (see wa-preview.js) for a selected <Var> — a vertical
// chain of "node" boxes, node-based-programming style, each editing part of
// the Var's mapping pipeline (mapin/mapout, Pattern, Curve, Convert), each
// (but the first) independently toggleable on/off. Per Hans (2026-09-24).
// Same "always mounted, listens to xmlStore itself" shape as
// wa-wam-view.js/wa-mixer-view.js.
//
// Toggling a node off removes its attribute(s) from the XML but keeps the
// last value in a RAM-only cache (per Var id, this component instance's own
// lifetime — never persisted) so turning it back on restores it instead of
// a fresh default.
//
// Every write goes through xmlStore.updateAttributes with the FULL
// attributes object (the established { ...node.attributes, ... } pattern
// used throughout the app) — xml-store.js's own VAR_MAPPING_ATTRS rule
// forces a full engine reload for any of mapin/mapout/curve/pattern/convert
// changing on a Var, since none of them are wired into the live-nudge path.

const CURVE_OPTIONS = [
	"linear",
	"step",
	"easeIn",
	"easeOut",
	"easeInOut",
	"easeInQuad",
	"easeOutQuad",
	"easeInOutQuad",
	"easeInCubic",
	"easeOutCubic",
	"easeInOutCubic",
	"easeInQuart",
	"easeOutQuart",
	"easeInOutQuart",
	"easeInQuint",
	"easeOutQuint",
	"easeInOutQuint",
	"easeInSine",
	"easeOutSine",
	"easeInOutSine",
	"easeInElastic",
	"easeOutElastic",
	"easeInOutElastic",
	"bell",
	"sine",
	"half-sine"
];
const CURVE_CUSTOM = "__custom_power__";

const CONVERT_PRESETS = ["MIDI->frequency", "dB->power"];
const CONVERT_CUSTOM = "__custom_expr__";

const MAP_PADDING = 18;
const POINT_HIT_RADIUS = 9;

function parseNumberList(str) {
	if (typeof str !== "string" || str.trim() === "") return null;
	const parts = str
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map(Number);
	return parts.some((n) => Number.isNaN(n)) ? null : parts;
}

function isNumericString(str) {
	if (typeof str !== "string" || str.trim() === "") return false;
	return Number.isFinite(Number(str));
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			overflow: auto;
			font: 0.85rem/1.4 system-ui, sans-serif;
			box-sizing: border-box;
			padding: 0.75rem;
		}
		.header {
			margin-bottom: 0.5rem;
		}
		.node-label {
			margin: 0;
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.node-label .tag {
			color: var(--waw-accent, #4fa3ff);
		}
		.chain {
			display: flex;
			flex-direction: column;
			align-items: stretch;
			max-width: 380px;
		}
		.incoming-arrow {
			text-align: center;
			color: var(--waw-muted, #8a8a8a);
			font-size: 1.1rem;
			line-height: 1;
			padding: 0.2rem 0 0.1rem;
		}
		.connector {
			width: 1px;
			height: 0.6rem;
			background: var(--waw-border, #2f2f2f);
			margin: 0 auto;
		}
		.node {
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.03);
			margin-bottom: 0;
			overflow: hidden;
		}
		.node-header {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.4rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			background: rgba(255, 255, 255, 0.02);
		}
		.node-title {
			font-weight: 600;
			font-size: 0.78rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--waw-muted, #8a8a8a);
		}
		.node.enabled .node-title {
			color: var(--waw-fg, #e8e8e8);
		}
		.node-body {
			padding: 0.6rem;
			display: flex;
			flex-direction: column;
			gap: 0.45rem;
		}
		.node-body[hidden] {
			display: none;
		}
		.toggle {
			position: relative;
			display: inline-block;
			width: 30px;
			height: 17px;
			flex-shrink: 0;
		}
		.toggle input {
			opacity: 0;
			width: 0;
			height: 0;
		}
		.toggle-track {
			position: absolute;
			inset: 0;
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 17px;
			cursor: pointer;
			transition: background 0.12s ease;
		}
		.toggle-track::before {
			content: "";
			position: absolute;
			width: 11px;
			height: 11px;
			left: 2px;
			top: 2px;
			background: var(--waw-muted, #8a8a8a);
			border-radius: 50%;
			transition: transform 0.12s ease, background 0.12s ease;
		}
		.toggle input:checked + .toggle-track {
			background: rgba(79, 163, 255, 0.18);
			border-color: var(--waw-accent, #4fa3ff);
		}
		.toggle input:checked + .toggle-track::before {
			transform: translateX(13px);
			background: var(--waw-accent, #4fa3ff);
		}
		canvas.map-canvas {
			width: 100%;
			height: 200px;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			display: block;
			cursor: crosshair;
		}
		canvas.convert-canvas {
			width: 100%;
			height: 140px;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			display: block;
		}
		.hint {
			font-size: 0.7rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.warning {
			font-size: 0.72rem;
			color: var(--waw-danger, #e5484d);
		}
		.warning[hidden] {
			display: none;
		}
		select,
		input[type="text"],
		input[type="number"] {
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			color: inherit;
			font: inherit;
			font-size: 0.8rem;
			padding: 0.3rem 0.4rem;
			box-sizing: border-box;
			width: 100%;
		}
		.row {
			display: flex;
			gap: 0.4rem;
			align-items: center;
		}
		.axis-edit-input {
			position: absolute;
			width: 4.5rem;
			font-size: 0.72rem;
			padding: 0.1rem 0.25rem;
			z-index: 2;
		}
		.map-wrap {
			position: relative;
		}
	</style>

	<div class="header">
		<p class="node-label"><span class="tag"></span></p>
	</div>

	<div class="chain">
		<div class="incoming-arrow">&#8595; incoming data</div>
		<div class="connector"></div>

		<div class="node enabled map-node">
			<div class="node-header"><span class="node-title">Map (mapin / mapout)</span></div>
			<div class="node-body">
				<div class="map-wrap">
					<canvas class="map-canvas" width="320" height="200"></canvas>
				</div>
				<p class="warning pattern-warning" hidden>Pattern is active — this graph is read-only (its mapin/mapout points are kept, but only the axis min/max stay editable). Turn Pattern off to edit points again.</p>
				<p class="hint">Double-click the line to add a point, drag a point to move it (Shift locks to one axis), double-click a point to delete it. Double-click an axis end value to edit it.</p>
			</div>
		</div>

		<div class="connector"></div>
		<div class="node pattern-node">
			<div class="node-header">
				<label class="toggle"><input type="checkbox" class="pattern-toggle" /><span class="toggle-track"></span></label>
				<span class="node-title">Pattern</span>
			</div>
			<div class="node-body" hidden>
				<input type="text" class="pattern-input" placeholder="0,2,4,5,7,9,11,12" />
				<p class="hint">A number series (e.g. scale degrees) quantizing the mapped output between the current mapout range. While active, the Map graph above becomes read-only (only its axis min/max stay editable).</p>
				<p class="warning pattern-degenerate-warning" hidden>This pattern can't be applied (its last value must be a positive number).</p>
			</div>
		</div>

		<div class="connector"></div>
		<div class="node curve-node">
			<div class="node-header">
				<label class="toggle"><input type="checkbox" class="curve-toggle" /><span class="toggle-track"></span></label>
				<span class="node-title">Curve</span>
			</div>
			<div class="node-body" hidden>
				<select class="curve-select"></select>
				<input type="number" class="curve-power" step="0.1" placeholder="power, e.g. 2" hidden />
			</div>
		</div>

		<div class="connector"></div>
		<div class="node convert-node">
			<div class="node-header">
				<label class="toggle"><input type="checkbox" class="convert-toggle" /><span class="toggle-track"></span></label>
				<span class="node-title">Convert</span>
			</div>
			<div class="node-body" hidden>
				<select class="convert-select"></select>
				<input type="text" class="convert-custom" placeholder="x*x" hidden />
				<p class="hint">A custom expression must use "x" as the incoming value.</p>
				<p class="warning convert-error" hidden></p>
				<canvas class="convert-canvas" width="320" height="140"></canvas>
			</div>
		</div>
	</div>
`;

export class WaVarView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._tagEl = this.shadowRoot.querySelector(".tag");
		this._mapCanvas = this.shadowRoot.querySelector(".map-canvas");
		this._mapCtx = this._mapCanvas.getContext("2d");
		this._mapWrap = this.shadowRoot.querySelector(".map-wrap");
		this._patternWarning = this.shadowRoot.querySelector(".pattern-warning");

		this._patternToggle = this.shadowRoot.querySelector(".pattern-toggle");
		this._patternBody = this._patternToggle.closest(".node").querySelector(".node-body");
		this._patternInput = this.shadowRoot.querySelector(".pattern-input");
		this._patternDegenerateWarning = this.shadowRoot.querySelector(".pattern-degenerate-warning");

		this._curveToggle = this.shadowRoot.querySelector(".curve-toggle");
		this._curveBody = this._curveToggle.closest(".node").querySelector(".node-body");
		this._curveSelect = this.shadowRoot.querySelector(".curve-select");
		this._curvePower = this.shadowRoot.querySelector(".curve-power");

		this._convertToggle = this.shadowRoot.querySelector(".convert-toggle");
		this._convertBody = this._convertToggle.closest(".node").querySelector(".node-body");
		this._convertSelect = this.shadowRoot.querySelector(".convert-select");
		this._convertCustom = this.shadowRoot.querySelector(".convert-custom");
		this._convertError = this.shadowRoot.querySelector(".convert-error");
		this._convertCanvas = this.shadowRoot.querySelector(".convert-canvas");
		this._convertCtx = this._convertCanvas.getContext("2d");

		this._activeNodeId = null;
		this._ramCache = new Map(); // nodeId -> { mapin, mapout, pattern, curve, convert } (raw attribute strings)
		this._drag = null; // { index, isEndpoint, axisLock: "x"|"y"|null, startX, startY }
		this._rafId = null;
		this._disposed = false;
		this._convertDomain = null; // { min, max } — set by _render, read by the live-dot poll

		this._onStoreChange = this._onStoreChange.bind(this);
		this._onMapPointerDown = this._onMapPointerDown.bind(this);
		this._onMapPointerMove = this._onMapPointerMove.bind(this);
		this._onMapPointerUp = this._onMapPointerUp.bind(this);
		this._onMapDblClick = this._onMapDblClick.bind(this);

		this._buildCurveOptions();
		this._buildConvertOptions();
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		this._mapCanvas.addEventListener("mousedown", this._onMapPointerDown);
		this._mapCanvas.addEventListener("dblclick", this._onMapDblClick);
		window.addEventListener("mousemove", this._onMapPointerMove);
		window.addEventListener("mouseup", this._onMapPointerUp);

		this._patternToggle.addEventListener("change", () => this._onPatternToggle());
		this._patternInput.addEventListener("change", () => this._onPatternInputCommit());
		this._patternInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this._patternInput.blur();
		});

		this._curveToggle.addEventListener("change", () => this._onCurveToggle());
		this._curveSelect.addEventListener("change", () => this._onCurveSelectChange());
		this._curvePower.addEventListener("change", () => this._onCurvePowerCommit());

		this._convertToggle.addEventListener("change", () => this._onConvertToggle());
		this._convertSelect.addEventListener("change", () => this._onConvertSelectChange());
		this._convertCustom.addEventListener("change", () => this._onConvertCustomCommit());

		this._onStoreChange();
		this._rafId = requestAnimationFrame(() => this._pollLiveValue());
	}

	disconnectedCallback() {
		this._disposed = true;
		xmlStore.removeEventListener("change", this._onStoreChange);
		window.removeEventListener("mousemove", this._onMapPointerMove);
		window.removeEventListener("mouseup", this._onMapPointerUp);
		if (this._rafId) cancelAnimationFrame(this._rafId);
	}

	_buildCurveOptions() {
		this._curveSelect.innerHTML = "";
		CURVE_OPTIONS.forEach((name) => {
			const o = document.createElement("option");
			o.value = name;
			o.textContent = name;
			this._curveSelect.appendChild(o);
		});
		const custom = document.createElement("option");
		custom.value = CURVE_CUSTOM;
		custom.textContent = "Custom power…";
		this._curveSelect.appendChild(custom);
	}

	_buildConvertOptions() {
		this._convertSelect.innerHTML = "";
		CONVERT_PRESETS.forEach((name) => {
			const o = document.createElement("option");
			o.value = name;
			o.textContent = name;
			this._convertSelect.appendChild(o);
		});
		const custom = document.createElement("option");
		custom.value = CONVERT_CUSTOM;
		custom.textContent = "Custom…";
		this._convertSelect.appendChild(custom);
	}

	// wa-preview.js only shows us for a <Var> selection — bail out otherwise
	// (same shape as wa-wam-view.js's own _onStoreChange).
	_onStoreChange() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		if (node.id !== this._activeNodeId) this._patternForcedOpen = false;
		this._activeNodeId = node.id;
		this._render(node);
	}

	_cacheFor(nodeId) {
		if (!this._ramCache.has(nodeId)) this._ramCache.set(nodeId, {});
		return this._ramCache.get(nodeId);
	}

	// ── Rendering ────────────────────────────────────────────────────────
	_render(node) {
		this._tagEl.textContent = `<${node.tagName}${node.attributes.name ? ` name="${node.attributes.name}"` : ""}>`;

		const mapin = parseNumberList(node.attributes.mapin) || [0, 1];
		const mapout = parseNumberList(node.attributes.mapout) || [0, 1];
		const pattern = parseNumberList(node.attributes.pattern);
		const curve = node.attributes.curve;
		const convert = node.attributes.convert;

		this._currentMapin = mapin;
		this._currentMapout = mapout;
		this._currentPattern = pattern;
		this._currentCurve = curve;
		this._currentConvert = convert;

		this._renderPatternNode(node, pattern);
		this._renderCurveNode(node, curve);
		this._renderConvertNode(node, convert, mapout);
		this._renderMapCanvas(mapin, mapout, curve, pattern);
	}

	_renderPatternNode(node, pattern) {
		const active = pattern !== null || !!this._patternForcedOpen;
		this._patternToggle.checked = active;
		this._patternBody.hidden = !active;
		this._patternToggle.closest(".node").classList.toggle("enabled", active);
		if (document.activeElement !== this._patternInput) {
			this._patternInput.value = node.attributes.pattern || "";
		}
		this._patternWarning.hidden = !active;
	}

	_renderCurveNode(node, curve) {
		const active = curve !== undefined;
		this._curveToggle.checked = active;
		this._curveBody.hidden = !active;
		this._curveToggle.closest(".node").classList.toggle("enabled", active);
		if (!active) return;
		if (isNumericString(curve)) {
			this._curveSelect.value = CURVE_CUSTOM;
			this._curvePower.hidden = false;
			if (document.activeElement !== this._curvePower) this._curvePower.value = curve;
		} else if (CURVE_OPTIONS.includes(curve)) {
			this._curveSelect.value = curve;
			this._curvePower.hidden = true;
		} else {
			// Unrecognized custom curve name (hand-typed XML) — fall back to
			// showing it as a linear default rather than guessing further.
			this._curveSelect.value = "linear";
			this._curvePower.hidden = true;
		}
	}

	_renderConvertNode(node, convert, mapout) {
		const active = convert !== undefined;
		this._convertToggle.checked = active;
		this._convertBody.hidden = !active;
		this._convertToggle.closest(".node").classList.toggle("enabled", active);
		this._convertError.hidden = true;
		if (!active) {
			this._convertDomain = null;
			return;
		}
		if (CONVERT_PRESETS.includes(convert)) {
			this._convertSelect.value = convert;
			this._convertCustom.hidden = true;
		} else {
			this._convertSelect.value = CONVERT_CUSTOM;
			this._convertCustom.hidden = false;
			if (document.activeElement !== this._convertCustom) this._convertCustom.value = convert;
		}
		const minX = Math.min(...mapout);
		const maxX = Math.max(...mapout);
		this._convertDomain = { min: minX, max: maxX === minX ? minX + 1 : maxX };
		this._drawConvertCurve(convert, this._convertDomain);
	}

	// ── Map node canvas ──────────────────────────────────────────────────
	_mapDomain(mapin, mapout) {
		const minIn = mapin[0];
		const maxIn = mapin[mapin.length - 1];
		let minOut = Math.min(...mapout);
		let maxOut = Math.max(...mapout);
		if (minOut === maxOut) {
			minOut -= 0.5;
			maxOut += 0.5;
		}
		return { minIn, maxIn: maxIn === minIn ? minIn + 1 : maxIn, minOut, maxOut };
	}

	_toCanvasX(x, domain, w) {
		return MAP_PADDING + ((x - domain.minIn) / (domain.maxIn - domain.minIn)) * (w - 2 * MAP_PADDING);
	}
	_toCanvasY(y, domain, h) {
		return h - MAP_PADDING - ((y - domain.minOut) / (domain.maxOut - domain.minOut)) * (h - 2 * MAP_PADDING);
	}
	_fromCanvasX(px, domain, w) {
		return domain.minIn + ((px - MAP_PADDING) / (w - 2 * MAP_PADDING)) * (domain.maxIn - domain.minIn);
	}
	_fromCanvasY(py, domain, h) {
		return domain.minOut + ((h - MAP_PADDING - py) / (h - 2 * MAP_PADDING)) * (domain.maxOut - domain.minOut);
	}

	_renderMapCanvas(mapin, mapout, curve, pattern) {
		const canvas = this._mapCanvas;
		const w = canvas.width,
			h = canvas.height;
		const ctx = this._mapCtx;
		ctx.clearRect(0, 0, w, h);
		const domain = this._mapDomain(mapin, mapout);
		this._mapDomainCache = domain;

		// axes
		ctx.strokeStyle = "#333";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(MAP_PADDING, h - MAP_PADDING);
		ctx.lineTo(w - MAP_PADDING, h - MAP_PADDING);
		ctx.moveTo(MAP_PADDING, MAP_PADDING);
		ctx.lineTo(MAP_PADDING, h - MAP_PADDING);
		ctx.stroke();

		// A Pattern still renders through the exact same curve sampler
		// (computeMapPoints threads `pattern` through mapStage1's real
		// rel2Out pipeline) — its own Math.floor() quantization already
		// produces a proper staircase with no help from curve, so this is
		// always one connected line. Per Hans (2026-09-24, correcting his
		// earlier point 2.4): a Pattern no longer forces curve="step" — that
		// was a different, unrelated technique. While active, the graph is
		// read-only (see the pattern guards in _onMapPointerDown/
		// _onMapDblClick below) except for its axis min/max — so no
		// draggable point dots are drawn, just the line.
		const active = pattern !== null;
		const curvePoints = computeMapPoints({ mapin, mapout, curve, pattern }, 200);
		ctx.strokeStyle = "#4fa3ff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		curvePoints.forEach((p, i) => {
			const cx = this._toCanvasX(p.x, domain, w);
			const cy = this._toCanvasY(p.y, domain, h);
			if (i === 0) ctx.moveTo(cx, cy);
			else ctx.lineTo(cx, cy);
		});
		ctx.stroke();

		if (active) {
			this._mapPoints = [];
		} else {
			this._mapPoints = mapoutPointPositions(mapin, mapout);
			this._drawMapDots(this._mapPoints, domain, w, h, "#fff", false);
		}

		// axis min/max labels
		ctx.fillStyle = "#8a8a8a";
		ctx.font = "10px monospace";
		ctx.textAlign = "left";
		ctx.fillText(fmtNum(mapin[0]), MAP_PADDING, h - 4);
		ctx.textAlign = "right";
		ctx.fillText(fmtNum(mapin[mapin.length - 1]), w - MAP_PADDING, h - 4);
		ctx.textAlign = "left";
		ctx.fillText(fmtNum(domain.maxOut), 2, MAP_PADDING);
		ctx.fillText(fmtNum(domain.minOut), 2, h - MAP_PADDING);
	}

	_drawMapDots(points, domain, w, h, color, readOnly) {
		const ctx = this._mapCtx;
		ctx.fillStyle = color;
		points.forEach((p) => {
			const cx = this._toCanvasX(p.x, domain, w);
			const cy = this._toCanvasY(p.y, domain, h);
			ctx.beginPath();
			ctx.arc(cx, cy, readOnly ? 3 : 4.5, 0, Math.PI * 2);
			ctx.fill();
		});
	}

	_hitTestMapPoint(px, py) {
		if (!this._mapPoints || !this._mapDomainCache) return -1;
		const w = this._mapCanvas.width,
			h = this._mapCanvas.height;
		for (let i = 0; i < this._mapPoints.length; i++) {
			const cx = this._toCanvasX(this._mapPoints[i].x, this._mapDomainCache, w);
			const cy = this._toCanvasY(this._mapPoints[i].y, this._mapDomainCache, h);
			if (Math.hypot(cx - px, cy - py) <= POINT_HIT_RADIUS) return i;
		}
		return -1;
	}

	_canvasPointFromEvent(e) {
		const rect = this._mapCanvas.getBoundingClientRect();
		const sx = this._mapCanvas.width / rect.width;
		const sy = this._mapCanvas.height / rect.height;
		return { px: (e.clientX - rect.left) * sx, py: (e.clientY - rect.top) * sy };
	}

	_onMapPointerDown(e) {
		if (this._currentPattern !== null) return; // read-only while a Pattern is active
		const { px, py } = this._canvasPointFromEvent(e);
		const idx = this._hitTestMapPoint(px, py);
		if (idx === -1) return;
		e.preventDefault();
		this._drag = {
			index: idx,
			isEndpoint: idx === 0 || idx === this._mapPoints.length - 1,
			axisLock: null,
			startPx: px,
			startPy: py
		};
	}

	_onMapPointerMove(e) {
		if (!this._drag) return;
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const rect = this._mapCanvas.getBoundingClientRect();
		const sx = this._mapCanvas.width / rect.width;
		const sy = this._mapCanvas.height / rect.height;
		const px = (e.clientX - rect.left) * sx;
		const py = (e.clientY - rect.top) * sy;
		const domain = this._mapDomainCache;
		const w = this._mapCanvas.width,
			h = this._mapCanvas.height;

		if (e.shiftKey && !this._drag.axisLock) {
			const dx = Math.abs(px - this._drag.startPx);
			const dy = Math.abs(py - this._drag.startPy);
			if (dx > 3 || dy > 3) this._drag.axisLock = dx > dy ? "x" : "y";
		} else if (!e.shiftKey) {
			this._drag.axisLock = null;
		}

		const mapin = [...this._currentMapin];
		const mapout = [...this._currentMapout];
		const idx = this._drag.index;

		if (!this._drag.axisLock || this._drag.axisLock === "y") {
			let y = this._fromCanvasY(py, domain, h);
			mapout[idx] = y;
		}
		if ((!this._drag.axisLock || this._drag.axisLock === "x") && !this._drag.isEndpoint) {
			let x = this._fromCanvasX(px, domain, w);
			const lo = mapin[idx - 1];
			const hi = mapin[idx + 1];
			const eps = (hi - lo) * 0.02 || 0.001;
			x = Math.max(lo + eps, Math.min(hi - eps, x));
			mapin[idx] = x;
		}

		this._currentMapin = mapin;
		this._currentMapout = mapout;
		this._renderMapCanvas(mapin, mapout, this._currentCurve, null);
	}

	_onMapPointerUp() {
		if (!this._drag) return;
		this._drag = null;
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		this._writeAttrs(node, { mapin: this._currentMapin.join(","), mapout: this._currentMapout.join(",") });
	}

	_onMapDblClick(e) {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const { px, py } = this._canvasPointFromEvent(e);

		// axis label hit-test (bottom-left/bottom-right for mapin, top/bottom-left for mapout)
		const w = this._mapCanvas.width,
			h = this._mapCanvas.height;
		if (py > h - MAP_PADDING - 6 && px < MAP_PADDING + 30) return this._editAxisValue(node, "mapin", 0);
		if (py > h - MAP_PADDING - 6 && px > w - MAP_PADDING - 30) return this._editAxisValue(node, "mapin", this._currentMapin.length - 1);
		if (px < MAP_PADDING + 24 && py < MAP_PADDING + 10) return this._editAxisValue(node, "mapout", this._currentMapout.length - 1);
		if (px < MAP_PADDING + 24 && py > h - MAP_PADDING - 16 && py < h - MAP_PADDING + 4) return this._editAxisValue(node, "mapout", 0);

		const idx = this._hitTestMapPoint(px, py);
		if (idx !== -1) {
			if (this._currentPattern !== null) return;
			if (idx === 0 || idx === this._mapPoints.length - 1) return; // endpoints can't be deleted
			const mapin = [...this._currentMapin];
			const mapout = [...this._currentMapout];
			mapin.splice(idx, 1);
			mapout.splice(idx, 1);
			this._writeAttrs(node, { mapin: mapin.join(","), mapout: mapout.join(",") });
			return;
		}

		if (this._currentPattern !== null) {
			this._flashPatternWarning();
			return;
		}
		// add a new point on the line at this x
		const domain = this._mapDomainCache;
		const x = Math.max(domain.minIn, Math.min(domain.maxIn, this._fromCanvasX(px, domain, w)));
		const y = mapStage1(x, { mapin: this._currentMapin, mapout: this._currentMapout, curve: this._currentCurve });
		const mapin = [...this._currentMapin, x].sort((a, b) => a - b);
		const insertAt = mapin.indexOf(x);
		const mapout = [...this._currentMapout];
		mapout.splice(insertAt, 0, y);
		this._writeAttrs(node, { mapin: mapin.join(","), mapout: mapout.join(",") });
	}

	_flashPatternWarning() {
		this._patternWarning.hidden = false;
	}

	_editAxisValue(node, which, index) {
		const current = which === "mapin" ? this._currentMapin[index] : this._currentMapout[index];
		const input = document.createElement("input");
		input.type = "number";
		input.step = "any";
		input.className = "axis-edit-input";
		input.value = current;
		const rect = this._mapCanvas.getBoundingClientRect();
		input.style.left = "4px";
		input.style.top = which === "mapin" ? `${rect.height - 20}px` : "4px";
		this._mapWrap.appendChild(input);
		input.focus();
		input.select();
		const commit = () => {
			// Removing a focused element can itself trigger a second, genuine
			// "blur" on it (a real browser quirk, not just this synthetic
			// listener) — guard against running twice, which would otherwise
			// throw trying to remove an already-detached node.
			if (!input.isConnected) return;
			input.removeEventListener("blur", commit);
			const v = parseFloat(input.value);
			input.remove();
			if (!Number.isFinite(v)) return;
			const arr = which === "mapin" ? [...this._currentMapin] : [...this._currentMapout];
			arr[index] = v;
			if (which === "mapin") {
				this._writeAttrs(node, { mapin: arr.join(",") });
			} else {
				this._writeAttrs(node, { mapout: arr.join(",") });
			}
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") input.blur();
			if (e.key === "Escape") {
				input.removeEventListener("blur", commit);
				input.remove();
			}
		});
	}

	// ── Pattern node ─────────────────────────────────────────────────────
	_onPatternToggle() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const cache = this._cacheFor(node.id);
		if (this._patternToggle.checked) {
			const restored = cache.pattern;
			if (restored) {
				this._writeAttrs(node, { pattern: restored });
			} else {
				this._patternForcedOpen = true; // reveal the empty input; nothing written until the user types
				this._render(node);
				this._patternInput.focus();
			}
		} else {
			this._patternForcedOpen = false;
			cache.pattern = node.attributes.pattern;
			const next = { ...node.attributes };
			delete next.pattern;
			xmlStore.updateAttributes(node.id, next);
		}
	}

	_onPatternInputCommit() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const raw = this._patternInput.value.trim();
		this._patternDegenerateWarning.hidden = true;
		if (raw === "") {
			const next = { ...node.attributes };
			delete next.pattern;
			xmlStore.updateAttributes(node.id, next);
			return;
		}
		const parsed = parseNumberList(raw);
		if (!parsed || parsed.length < 2 || parsed[parsed.length - 1] <= 0) {
			this._patternDegenerateWarning.hidden = false;
			return;
		}
		this._writeAttrs(node, { pattern: raw });
	}

	// ── Curve node ───────────────────────────────────────────────────────
	_onCurveToggle() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const cache = this._cacheFor(node.id);
		if (this._curveToggle.checked) {
			this._writeAttrs(node, { curve: cache.curve || "linear" });
		} else {
			cache.curve = node.attributes.curve;
			const next = { ...node.attributes };
			delete next.curve;
			xmlStore.updateAttributes(node.id, next);
		}
	}

	_onCurveSelectChange() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const val = this._curveSelect.value;
		if (val === CURVE_CUSTOM) {
			this._curvePower.hidden = false;
			const v = parseFloat(this._curvePower.value);
			this._writeAttrs(node, { curve: Number.isFinite(v) ? String(v) : "2" });
		} else {
			this._curvePower.hidden = true;
			this._writeAttrs(node, { curve: val });
		}
	}

	_onCurvePowerCommit() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const v = parseFloat(this._curvePower.value);
		if (!Number.isFinite(v)) return;
		this._writeAttrs(node, { curve: String(v) });
	}

	// ── Convert node ─────────────────────────────────────────────────────
	_onConvertToggle() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const cache = this._cacheFor(node.id);
		if (this._convertToggle.checked) {
			this._writeAttrs(node, { convert: cache.convert || "MIDI->frequency" });
		} else {
			cache.convert = node.attributes.convert;
			const next = { ...node.attributes };
			delete next.convert;
			xmlStore.updateAttributes(node.id, next);
		}
	}

	_onConvertSelectChange() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const val = this._convertSelect.value;
		if (val === CONVERT_CUSTOM) {
			this._convertCustom.hidden = false;
			this._writeConvertCustom(node, this._convertCustom.value || "x");
		} else {
			this._convertCustom.hidden = true;
			this._convertError.hidden = true;
			this._writeAttrs(node, { convert: val });
		}
	}

	_onConvertCustomCommit() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		this._writeConvertCustom(node, this._convertCustom.value);
	}

	_writeConvertCustom(node, expr) {
		try {
			validateConvertExpression(expr);
		} catch {
			this._convertError.hidden = false;
			this._convertError.textContent = `Invalid expression: "${expr}" (must be valid JavaScript using "x")`;
			return;
		}
		this._convertError.hidden = true;
		this._writeAttrs(node, { convert: expr });
	}

	_drawConvertCurve(convertValue, domain) {
		const canvas = this._convertCanvas;
		const w = canvas.width,
			h = canvas.height;
		const ctx = this._convertCtx;
		ctx.clearRect(0, 0, w, h);
		const points = computeConvertPoints(convertValue, domain.min, domain.max, 150);
		let minY = Math.min(...points.map((p) => p.y));
		let maxY = Math.max(...points.map((p) => p.y));
		if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY === maxY) {
			minY = (minY || 0) - 0.5;
			maxY = (maxY || 0) + 0.5;
		}
		this._convertYDomain = { minY, maxY };

		ctx.strokeStyle = "#333";
		ctx.beginPath();
		ctx.moveTo(MAP_PADDING, h - MAP_PADDING);
		ctx.lineTo(w - MAP_PADDING, h - MAP_PADDING);
		ctx.moveTo(MAP_PADDING, MAP_PADDING);
		ctx.lineTo(MAP_PADDING, h - MAP_PADDING);
		ctx.stroke();

		ctx.strokeStyle = "#45b58c";
		ctx.lineWidth = 2;
		ctx.beginPath();
		points.forEach((p, i) => {
			const cx = MAP_PADDING + ((p.x - domain.min) / (domain.max - domain.min)) * (w - 2 * MAP_PADDING);
			const cy = h - MAP_PADDING - ((p.y - minY) / (maxY - minY)) * (h - 2 * MAP_PADDING);
			if (i === 0) ctx.moveTo(cx, cy);
			else ctx.lineTo(cx, cy);
		});
		ctx.stroke();

		ctx.fillStyle = "#8a8a8a";
		ctx.font = "10px monospace";
		ctx.textAlign = "left";
		ctx.fillText(fmtNum(domain.min), MAP_PADDING, h - 4);
		ctx.textAlign = "right";
		ctx.fillText(fmtNum(domain.max), w - MAP_PADDING, h - 4);
	}

	// ── Shared attribute write helper ───────────────────────────────────
	_writeAttrs(node, patch) {
		xmlStore.updateAttributes(node.id, { ...node.attributes, ...patch });
	}

	// ── Live dot on the Map and Convert graphs ──────────────────────────
	_pollLiveValue() {
		if (this._disposed) return;
		this._rafId = requestAnimationFrame(() => this._pollLiveValue());
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var" || !playerStore.isDocumentLoaded) return;
		const realId = node.attributes.id;
		if (!realId) return;
		let liveObj;
		try {
			const matches = playerStore.getLiveObjects(`[id='${realId}']`);
			liveObj = matches && matches[0];
		} catch {
			liveObj = null;
		}
		if (!liveObj || typeof liveObj.lastInputValue !== "number") return;
		const stage1 = mapStage1(liveObj.lastInputValue, {
			mapin: this._currentMapin,
			mapout: this._currentMapout,
			curve: this._currentCurve,
			pattern: this._currentPattern
		});
		if (!this._drag) this._drawMapDot(liveObj.lastInputValue, stage1);
		if (this._convertDomain) {
			const y = applyConvertFn(this._currentConvert, stage1);
			this._drawConvertDot(stage1, y);
		}
	}

	// Same idea as _drawConvertDot below — redraws the graph then overlays a
	// dot at the live raw input (X, mapin domain) / stage-1 mapped value (Y,
	// mapout domain), i.e. the same value the Convert node's own dot starts
	// from. Per Hans (2026-09-24): the Map node gets the same moving marker
	// the Convert node already had.
	_drawMapDot(rawInput, stage1) {
		if (!this._currentMapin || !this._currentMapout) return;
		this._renderMapCanvas(this._currentMapin, this._currentMapout, this._currentCurve, this._currentPattern);
		const domain = this._mapDomainCache;
		if (!domain) return;
		const w = this._mapCanvas.width,
			h = this._mapCanvas.height;
		const x = clampNum(rawInput, domain.minIn, domain.maxIn);
		const y = clampNum(stage1, domain.minOut, domain.maxOut);
		const cx = this._toCanvasX(x, domain, w);
		const cy = this._toCanvasY(y, domain, h);
		const ctx = this._mapCtx;
		ctx.fillStyle = "#facc15";
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(cx, cy, 5, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}

	_drawConvertDot(x, y) {
		if (!this._convertDomain || !this._convertYDomain) return;
		const canvas = this._convertCanvas;
		if (canvas.hidden || this._convertBody.hidden) return;
		const w = canvas.width,
			h = canvas.height;
		const { min, max } = this._convertDomain;
		const { minY, maxY } = this._convertYDomain;
		if (x < min || x > max) return;
		this._drawConvertCurve(this._currentConvert, this._convertDomain);
		const ctx = this._convertCtx;
		const cx = MAP_PADDING + ((x - min) / (max - min || 1)) * (w - 2 * MAP_PADDING);
		const cy = h - MAP_PADDING - ((y - minY) / (maxY - minY || 1)) * (h - 2 * MAP_PADDING);
		ctx.fillStyle = "#facc15";
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(cx, cy, 5, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}
}

function fmtNum(n) {
	return Number.isFinite(n) ? parseFloat(n.toFixed(3)) : "—";
}

function clampNum(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

customElements.define("wa-var-view", WaVarView);
