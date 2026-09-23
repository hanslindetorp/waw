import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { computeMapPoints, mapoutPointPositions, applyConvertFn, computeConvertPoints, validateConvertExpression, mapStage1 } from "../xml-editor/var-mapper-math.js";
import { formatValue } from "../utils/number-format.js";

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

// Curve values are names ("easeIn") or numbers ("2") — parseNumberList would
// reject the names, so this keeps every comma-separated token as a raw
// string instead of coercing it. Per Hans (2026-09-24): curve can hold one
// global value or one per mapin/mapout segment ("Per point" mode).
function parseCsvStrings(str) {
	if (typeof str !== "string" || str.trim() === "") return null;
	const parts = str
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return parts.length ? parts : null;
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
		.chain {
			position: relative;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			max-width: 380px;
		}
		/* Live readouts bookending the chain — the knob's own raw input
		   (white, matches wa-var-knobs.js's "unmapped" value color), same
		   line as the "incoming data" label, and the final value after
		   everything (green, matches the Convert graph's own line) beside
		   its own small arrow to the right of the Convert block. Per Hans
		   (2026-09-25/26). */
		.incoming-row {
			display: flex;
			align-items: baseline;
			justify-content: center;
			gap: 0.5rem;
		}
		.incoming-arrow {
			color: var(--waw-muted, #8a8a8a);
			font-size: 1.1rem;
			line-height: 1;
			padding: 0.2rem 0 0.1rem;
		}
		.incoming-value,
		.outgoing-value {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.85rem;
			font-weight: 600;
		}
		.incoming-value {
			color: var(--waw-fg, #e8e8e8);
		}
		/* .node's own overflow:hidden (for its rounded corners) would clip
		   .outgoing-row below, which deliberately sits outside this box's
		   own right edge — ".node.convert-node" (2 classes) rather than
		   ".convert-node" alone, since a plain equal-specificity override
		   loses to ".node"'s own rule by source order alone (bug found
		   2026-09-30: the row was actually there, just invisibly clipped). */
		.node.convert-node {
			position: relative;
			overflow: visible;
		}
		.outgoing-row {
			position: absolute;
			left: 100%;
			top: 50%;
			transform: translateY(-50%);
			margin-left: 0.6rem;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.1rem;
			white-space: nowrap;
		}
		.outgoing-arrow {
			color: #45b58c;
			font-size: 1.1rem;
			line-height: 1;
		}
		.outgoing-value {
			color: #45b58c;
		}
		.connector {
			width: 1px;
			height: 0.6rem;
			background: var(--waw-border, #2f2f2f);
			margin: 0 auto;
		}
		/* No background line here — the flow-arrow-svg's own bracket is
		   already the visual connector to Convert (see _updateFlowArrow); a
		   second straight line running behind/through it just reads as
		   clutter. This is a plain spacer, sized to match a collapsed
		   section's height (see _updateFlowArrow's own JS measurement). */
		.connector.wide {
			background: none;
			width: auto;
		}
		.flow-arrow-svg {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			overflow: visible;
			pointer-events: none;
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
		/* Direct-child header only — Curve/Pattern are now sub-sections
		   inside .map-node (see .sub-section below), and must not inherit
		   its own always-on "enabled" look regardless of their own toggle. */
		.node.enabled > .node-header .node-title {
			color: var(--waw-fg, #e8e8e8);
		}
		/* Curve and Pattern are parameters OF the Mapping graph above them,
		   not a further processing stage like Convert — folded into the same
		   bordered box as its own sub-sections (with a divider each) rather
		   than separate connected boxes, so that relationship reads visually
		   instead of needing an explanatory line. Per Hans (2026-09-25). */
		.sub-section {
			border-top: 1px solid var(--waw-border, #2f2f2f);
		}
		.sub-section .sub-header {
			border-bottom: none;
			background: transparent;
			padding: 0.35rem 0.6rem;
		}
		.sub-section.enabled .sub-header .node-title {
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
			width: 4.5rem;
			font-size: 0.75rem;
			padding: 0.2rem 0.3rem;
		}
		.map-wrap {
			position: relative;
		}
		.map-grid {
			display: grid;
			grid-template-columns: auto auto 1fr;
			grid-template-rows: auto auto auto;
			column-gap: 0.4rem;
			row-gap: 0.2rem;
		}
		.map-mapin-label {
			grid-column: 3;
			grid-row: 1;
			text-align: center;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.68rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}
		.map-x-labels {
			grid-column: 3;
			grid-row: 2;
			display: flex;
			justify-content: space-between;
		}
		.map-mapout-label {
			grid-column: 1;
			grid-row: 3;
			writing-mode: vertical-rl;
			transform: rotate(180deg);
			display: flex;
			align-items: center;
			justify-content: center;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.68rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}
		.map-y-labels {
			grid-column: 2;
			grid-row: 3;
			display: flex;
			flex-direction: column;
			justify-content: space-between;
			align-items: flex-end;
		}
		.map-wrap {
			grid-column: 3;
			grid-row: 3;
		}
		.axis-label {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.75rem;
			color: var(--waw-fg, #e8e8e8);
			padding: 0.2rem 0.5rem;
			border-radius: 4px;
			cursor: text;
			background: rgba(255, 255, 255, 0.07);
			border: 1px solid var(--waw-border, #2f2f2f);
			white-space: nowrap;
		}
		.axis-label:hover {
			background: rgba(255, 255, 255, 0.13);
			border-color: var(--waw-accent, #4fa3ff);
		}
		.coord-tooltip {
			position: absolute;
			pointer-events: none;
			background: #0c0c0c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: var(--waw-fg, #e8e8e8);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.68rem;
			padding: 0.15rem 0.35rem;
			border-radius: 4px;
			transform: translate(10px, -100%);
			white-space: nowrap;
			z-index: 3;
		}
		.coord-tooltip[hidden] {
			display: none;
		}
		.curve-mode-row {
			font-size: 0.75rem;
			color: var(--waw-muted, #8a8a8a);
			gap: 0.9rem;
		}
		.curve-mode-row label {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			cursor: pointer;
		}
	</style>

	<div class="chain">
		<svg class="flow-arrow-svg"><path class="flow-arrow-path" fill="none" stroke="#4fa3ff" stroke-width="2" marker-end="url(#flow-arrowhead)" /><defs><marker id="flow-arrowhead" markerWidth="10" markerHeight="10" refX="7" refY="4" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#4fa3ff" /></marker></defs></svg>

		<div class="incoming-row">
			<span class="incoming-arrow">&#8595; incoming data</span>
			<span class="incoming-value">—</span>
		</div>
		<div class="connector"></div>

		<div class="node enabled map-node">
			<div class="node-header"><span class="node-title">Mapping</span></div>
			<div class="node-body">
				<div class="map-grid">
					<div class="map-mapin-label">mapin</div>
					<div class="map-x-labels">
						<span class="axis-label axis-mapin-min" data-which="mapin" data-endpoint="0" title="Double-click to edit"></span>
						<span class="axis-label axis-mapin-max" data-which="mapin" data-endpoint="last" title="Double-click to edit"></span>
					</div>
					<div class="map-mapout-label">mapout</div>
					<div class="map-y-labels">
						<span class="axis-label axis-mapout-max" data-which="mapout" data-endpoint="last" title="Double-click to edit"></span>
						<span class="axis-label axis-mapout-min" data-which="mapout" data-endpoint="0" title="Double-click to edit"></span>
					</div>
					<div class="map-wrap">
						<canvas class="map-canvas" width="320" height="200"></canvas>
						<div class="coord-tooltip" hidden></div>
					</div>
				</div>
				<p class="hint">Click a point to select it, double-click the line to add a point, drag a point to move it (Shift locks to one axis), double-click a point to delete it. Double-click an axis value to edit it.</p>
			</div>

			<div class="sub-section curve-node">
				<div class="node-header sub-header">
					<label class="toggle"><input type="checkbox" class="curve-toggle" /><span class="toggle-track"></span></label>
					<span class="node-title">Curve</span>
				</div>
				<div class="node-body" hidden>
					<div class="row curve-mode-row">
						<label><input type="radio" name="curve-mode" class="curve-mode-radio" value="all" checked /> All points</label>
						<label><input type="radio" name="curve-mode" class="curve-mode-radio" value="per" /> Per point</label>
					</div>
					<p class="hint curve-per-point-hint" hidden>Select a point (not the last one) in the Mapping graph above to edit its own curve.</p>
					<select class="curve-select"></select>
					<input type="number" class="curve-power" step="0.1" placeholder="power, e.g. 2" hidden />
				</div>
			</div>

			<div class="sub-section pattern-node">
				<div class="node-header sub-header">
					<label class="toggle"><input type="checkbox" class="pattern-toggle" /><span class="toggle-track"></span></label>
					<span class="node-title">Pattern</span>
				</div>
				<div class="node-body" hidden>
					<input type="text" class="pattern-input" placeholder="0,2,4,5,7,9,11,12" />
					<p class="hint">A number series (e.g. scale degrees) quantizing the mapped output between the current mapout range. While active, the Mapping graph above becomes read-only (only its axis min/max stay editable).</p>
					<p class="warning pattern-degenerate-warning" hidden>This pattern can't be applied (its last value must be a positive number).</p>
				</div>
			</div>
		</div>

		<div class="connector wide"></div>
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
				<div class="outgoing-row">
					<div class="outgoing-arrow">&#8594;</div>
					<div class="outgoing-value">—</div>
				</div>
			</div>
		</div>
	</div>
`;

export class WaVarView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._mapCanvas = this.shadowRoot.querySelector(".map-canvas");
		this._mapCtx = this._mapCanvas.getContext("2d");
		this._mapWrap = this.shadowRoot.querySelector(".map-wrap");
		this._coordTooltip = this.shadowRoot.querySelector(".coord-tooltip");
		this._chainEl = this.shadowRoot.querySelector(".chain");
		this._mapNodeEl = this.shadowRoot.querySelector(".map-node");
		this._convertNodeEl = this.shadowRoot.querySelector(".convert-node");
		this._flowArrowPath = this.shadowRoot.querySelector(".flow-arrow-path");
		this._incomingValueEl = this.shadowRoot.querySelector(".incoming-value");
		this._outgoingValueEl = this.shadowRoot.querySelector(".outgoing-value");
		this._wideConnectorEl = this.shadowRoot.querySelector(".connector.wide");
		this._axisLabels = {
			mapoutMax: this.shadowRoot.querySelector(".axis-mapout-max"),
			mapoutMin: this.shadowRoot.querySelector(".axis-mapout-min"),
			mapinMin: this.shadowRoot.querySelector(".axis-mapin-min"),
			mapinMax: this.shadowRoot.querySelector(".axis-mapin-max")
		};

		this._patternToggle = this.shadowRoot.querySelector(".pattern-toggle");
		this._patternBody = this._patternToggle.closest(".sub-section").querySelector(".node-body");
		this._patternInput = this.shadowRoot.querySelector(".pattern-input");
		this._patternDegenerateWarning = this.shadowRoot.querySelector(".pattern-degenerate-warning");

		this._curveToggle = this.shadowRoot.querySelector(".curve-toggle");
		this._curveBody = this._curveToggle.closest(".sub-section").querySelector(".node-body");
		this._curveModeRadios = [...this.shadowRoot.querySelectorAll(".curve-mode-radio")];
		this._curvePerPointHint = this.shadowRoot.querySelector(".curve-per-point-hint");
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
		this._drag = null; // { index, isEndpoint, axisLock: "x"|"y"|null, startX, startY, isNew }
		this._rafId = null;
		this._disposed = false;
		this._convertDomain = null; // { min, max } — set by _render, read by the live-dot poll
		this._selectedPointIndex = null; // index into mapin/mapout — see Curve node's "Per point" mode

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

		Object.values(this._axisLabels).forEach((el) => {
			el.addEventListener("dblclick", () => {
				const node = xmlStore.getSelectedNode();
				if (!node || node.tagName !== "Var") return;
				const which = el.dataset.which;
				const arr = which === "mapin" ? this._currentMapin : this._currentMapout;
				const index = el.dataset.endpoint === "last" ? arr.length - 1 : 0;
				this._editAxisValue(node, which, index, el);
			});
		});

		this._patternToggle.addEventListener("change", () => this._onPatternToggle());
		this._patternInput.addEventListener("change", () => this._onPatternInputCommit());
		this._patternInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this._patternInput.blur();
		});

		this._curveToggle.addEventListener("change", () => this._onCurveToggle());
		this._curveModeRadios.forEach((r) => r.addEventListener("change", () => this._onCurveModeChange()));
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
		if (node.id !== this._activeNodeId) {
			this._patternForcedOpen = false;
			this._selectedPointIndex = null;
		}
		this._activeNodeId = node.id;
		this._render(node);
	}

	_cacheFor(nodeId) {
		if (!this._ramCache.has(nodeId)) this._ramCache.set(nodeId, {});
		return this._ramCache.get(nodeId);
	}

	// ── Rendering ────────────────────────────────────────────────────────
	_render(node) {
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
		this._updateFlowArrow();
	}

	// A second arrow, same style as the top "incoming data" one, showing the
	// value also flows from Mapping (graph + its Curve/Pattern sub-sections,
	// now one box — see .sub-section above) straight into Convert. Routed as
	// a right-angle bracket that stays clear of the box's own right edge —
	// out, down, in — rather than a diagonal cutting across it. Per Hans
	// (2026-09-25, correcting the first attempt's diagonal-through-the-boxes
	// version). Recomputed on every render since toggling any section
	// changes the Convert node's position.
	_updateFlowArrow() {
		// The gap before Convert should read as roomy as a collapsed
		// section, not the thin 0.6rem default connector — measured off the
		// Convert node's own header (constant height whether its body is
		// open or not) rather than a guessed fixed value, so it stays
		// correct if that styling ever changes. Per Hans (2026-09-25).
		const headerEl = this._convertNodeEl.querySelector(".node-header");
		const headerHeight = headerEl?.getBoundingClientRect().height;
		if (headerHeight) this._wideConnectorEl.style.height = `${headerHeight}px`;

		const chainRect = this._chainEl.getBoundingClientRect();
		const mapRect = this._mapNodeEl.getBoundingClientRect();
		const convertRect = this._convertNodeEl.getBoundingClientRect();
		if (!chainRect.width || !mapRect.width || !convertRect.width) return;
		const GAP = 18;
		const startX = mapRect.right - chainRect.left;
		// The merged Mapping/Curve/Pattern box can be tall — starting the
		// bracket from its vertical CENTER (the old behavior) put the start
		// point arbitrarily high above Convert, forcing a long, disconnected-
		// looking vertical run down the outside edge past the whole Pattern
		// section. Starting from the box's own BOTTOM instead reads as "flow
		// exits the bottom of this block" and keeps the bracket short and
		// close to Convert, where it visually belongs. Per Hans (2026-09-30):
		// "Pilen in i nedre blocket ser fortfarande inte bra ut."
		const startY = mapRect.bottom - chainRect.top;
		const bracketX = startX + GAP;
		const convertTopY = convertRect.top - chainRect.top;
		const convertCenterX = convertRect.left + convertRect.width / 2 - chainRect.left;
		const dropY = convertTopY - 6;
		this._flowArrowPath.setAttribute(
			"d",
			`M${startX},${startY} L${bracketX},${startY} L${bracketX},${dropY} L${convertCenterX},${dropY} L${convertCenterX},${convertTopY}`
		);
	}

	_renderPatternNode(node, pattern) {
		const active = pattern !== null || !!this._patternForcedOpen;
		this._patternToggle.checked = active;
		this._patternBody.hidden = !active;
		this._patternToggle.closest(".sub-section").classList.toggle("enabled", active);
		if (document.activeElement !== this._patternInput) {
			this._patternInput.value = node.attributes.pattern || "";
		}
	}

	// Curve is "All points" mode when its value has no comma, "Per point"
	// mode when it does — the radio itself just reflects/drives that shape,
	// no separate hidden mode is tracked. Per Hans (2026-09-24).
	_renderCurveNode(node, curve) {
		const active = curve !== undefined;
		this._curveToggle.checked = active;
		this._curveBody.hidden = !active;
		this._curveToggle.closest(".sub-section").classList.toggle("enabled", active);
		if (!active) return;

		const curveArr = parseCsvStrings(curve) || ["linear"];
		const perPoint = curveArr.length > 1;
		this._curveModeRadios.forEach((r) => (r.checked = r.value === (perPoint ? "per" : "all")));

		const segmentCount = Math.max(0, this._currentMapin.length - 1);
		const canEditSelected =
			perPoint && this._selectedPointIndex !== null && this._selectedPointIndex < this._currentMapin.length - 1 && this._selectedPointIndex < segmentCount;
		this._curvePerPointHint.hidden = !perPoint || canEditSelected;
		this._curveSelect.disabled = perPoint && !canEditSelected;
		this._curvePower.disabled = perPoint && !canEditSelected;

		const effectiveValue = perPoint ? (canEditSelected ? curveArr[this._selectedPointIndex] : undefined) : curveArr[0];
		if (effectiveValue === undefined) return;
		this._renderCurveValueControl(effectiveValue);
	}

	_renderCurveValueControl(value) {
		if (isNumericString(value)) {
			this._curveSelect.value = CURVE_CUSTOM;
			this._curvePower.hidden = false;
			if (document.activeElement !== this._curvePower) this._curvePower.value = value;
		} else if (CURVE_OPTIONS.includes(value)) {
			this._curveSelect.value = value;
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

	// The Y-axis frame comes from the two mapout ENDPOINTS only (not every
	// point's value) — per Hans (2026-09-25): min/max form a fixed frame
	// that dragging an interior point is clamped inside, rather than the
	// view rescaling to chase whatever's being dragged. Only moving an
	// endpoint itself (or double-clicking its axis label) changes the frame.
	_mapDomain(mapin, mapout) {
		const minIn = mapin[0];
		const maxIn = mapin[mapin.length - 1];
		let minOut = Math.min(mapout[0], mapout[mapout.length - 1]);
		let maxOut = Math.max(mapout[0], mapout[mapout.length - 1]);
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

		// The big, editable min/max values now live outside the canvas as
		// real DOM elements (see the axis-label spans in the template) —
		// easier to hit and to show as editable (text cursor, underline) than
		// the old in-canvas fillText labels were. Per Hans (2026-09-25).
		this._axisLabels.mapinMin.textContent = fmtNum(mapin[0]);
		this._axisLabels.mapinMax.textContent = fmtNum(mapin[mapin.length - 1]);
		this._axisLabels.mapoutMax.textContent = fmtNum(domain.maxOut);
		this._axisLabels.mapoutMin.textContent = fmtNum(domain.minOut);

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
		// draggable point dots are drawn, just the line, muted to the same
		// gray used elsewhere for "disabled" (per Hans, 2026-09-25 — this
		// alone signals read-only, replacing the earlier red warning text).
		const active = pattern !== null;
		const curvePoints = computeMapPoints({ mapin, mapout, curve, pattern }, 200);
		ctx.strokeStyle = active ? "#8a8a8a" : "#4fa3ff";
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
			this._drawMapDots(this._mapPoints, domain, w, h);
			// Per Hans (2026-09-25): every point's own x/y value gets a small
			// tick mark on its axis, thinned out (never overlapping) when
			// points are close together.
			this._drawAxisTicks(mapin, mapout, domain, w, h);
		}
	}

	_drawMapDots(points, domain, w, h) {
		const ctx = this._mapCtx;
		points.forEach((p, i) => {
			const cx = this._toCanvasX(p.x, domain, w);
			const cy = this._toCanvasY(p.y, domain, h);
			ctx.fillStyle = "#fff";
			ctx.beginPath();
			ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
			ctx.fill();
			if (i === this._selectedPointIndex) {
				ctx.strokeStyle = "#facc15";
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
				ctx.stroke();
			}
		});
	}

	// Greedily keeps values whose pixel position is at least `minGap` away
	// from the last kept one (values pre-sorted by pixel position) — so
	// dense clusters of points never produce overlapping axis tick labels.
	// Endpoints are always kept.
	_selectDenseTicks(values, toPixelFn, minGap) {
		const unique = [...new Set(values)];
		const withPixel = unique.map((v) => ({ v, px: toPixelFn(v) })).sort((a, b) => a.px - b.px);
		if (withPixel.length <= 2) return withPixel.map((e) => e.v);
		const kept = [withPixel[0]];
		for (let i = 1; i < withPixel.length - 1; i++) {
			if (withPixel[i].px - kept[kept.length - 1].px >= minGap) kept.push(withPixel[i]);
		}
		const last = withPixel[withPixel.length - 1];
		if (last.px - kept[kept.length - 1].px < minGap) kept.pop();
		kept.push(last);
		return kept.map((e) => e.v);
	}

	_drawAxisTicks(mapin, mapout, domain, w, h) {
		const ctx = this._mapCtx;
		ctx.font = "8px monospace";
		ctx.fillStyle = "#666";
		ctx.strokeStyle = "#444";
		ctx.lineWidth = 1;

		const xTicks = this._selectDenseTicks(mapin, (v) => this._toCanvasX(v, domain, w), 24);
		ctx.textAlign = "center";
		xTicks.forEach((v) => {
			const cx = this._toCanvasX(v, domain, w);
			ctx.beginPath();
			ctx.moveTo(cx, h - MAP_PADDING);
			ctx.lineTo(cx, h - MAP_PADDING + 3);
			ctx.stroke();
			ctx.fillText(fmtNum(v), cx, h - MAP_PADDING + 12);
		});

		const yTicks = this._selectDenseTicks(mapout, (v) => this._toCanvasY(v, domain, h), 14);
		ctx.textAlign = "left";
		yTicks.forEach((v) => {
			const cy = this._toCanvasY(v, domain, h);
			ctx.beginPath();
			ctx.moveTo(MAP_PADDING - 3, cy);
			ctx.lineTo(MAP_PADDING, cy);
			ctx.stroke();
			ctx.fillText(fmtNum(v), 1, cy + 3);
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
		// Selecting happens on plain mousedown (click or drag-start alike) —
		// per Hans (2026-09-25): points need to be selectable so the Curve
		// node's "Per point" mode has something to edit. Clicking empty
		// canvas space deselects.
		if (this._selectedPointIndex !== idx) {
			this._selectedPointIndex = idx === -1 ? null : idx;
			this._renderMapCanvas(this._currentMapin, this._currentMapout, this._currentCurve, this._currentPattern);
			this._renderCurveNode(xmlStore.getSelectedNode(), this._currentCurve);
		}
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
			// Interior points are clamped inside the current min/max frame —
			// only dragging an endpoint itself may move the frame. Per Hans
			// (2026-09-25): the view must never rescale just because a point
			// was dragged past its edge.
			if (!this._drag.isEndpoint) y = clampNum(y, domain.minOut, domain.maxOut);
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
		this._showCoordTooltip(px, py, mapin[idx], mapout[idx]);
	}

	_onMapPointerUp() {
		if (!this._drag) return;
		this._drag = null;
		this._hideCoordTooltip();
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		this._writeAttrs(node, { mapin: this._currentMapin.join(","), mapout: this._currentMapout.join(",") });
	}

	// Per Hans (2026-09-25): a coordinate readout follows the cursor while a
	// point is being created or moved — positioned in .map-wrap's own CSS
	// pixel space (the canvas is that element's only child, at (0,0), so the
	// canvas-internal px/py just need the same width/height scale-down the
	// rest of this file already uses for the reverse conversion).
	_showCoordTooltip(px, py, x, y) {
		const rect = this._mapCanvas.getBoundingClientRect();
		const cssX = px * (rect.width / this._mapCanvas.width);
		const cssY = py * (rect.height / this._mapCanvas.height);
		this._coordTooltip.textContent = `${fmtNum(x)}, ${fmtNum(y)}`;
		this._coordTooltip.style.left = `${cssX}px`;
		this._coordTooltip.style.top = `${cssY}px`;
		this._coordTooltip.hidden = false;
	}

	_hideCoordTooltip() {
		this._coordTooltip.hidden = true;
	}

	_onMapDblClick(e) {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const { px, py } = this._canvasPointFromEvent(e);
		const w = this._mapCanvas.width,
			h = this._mapCanvas.height;

		const idx = this._hitTestMapPoint(px, py);
		if (idx !== -1) {
			if (this._currentPattern !== null) return;
			if (idx === 0 || idx === this._mapPoints.length - 1) return; // endpoints can't be deleted
			const mapin = [...this._currentMapin];
			const mapout = [...this._currentMapout];
			mapin.splice(idx, 1);
			mapout.splice(idx, 1);
			const patch = { mapin: mapin.join(","), mapout: mapout.join(",") };
			const nextCurve = this._curveArrayAfterDelete(node, idx);
			if (nextCurve !== undefined) patch.curve = nextCurve;
			if (this._selectedPointIndex === idx) this._selectedPointIndex = null;
			else if (this._selectedPointIndex !== null && this._selectedPointIndex > idx) this._selectedPointIndex--;
			this._writeAttrs(node, patch);
			return;
		}

		if (this._currentPattern !== null) return; // read-only while a Pattern is active
		// add a new point on the line at this x, then immediately continue
		// as if the user had grabbed it — see the "coordinate readout on
		// create" comment above _showCoordTooltip.
		const domain = this._mapDomainCache;
		const x = Math.max(domain.minIn, Math.min(domain.maxIn, this._fromCanvasX(px, domain, w)));
		const y = mapStage1(x, { mapin: this._currentMapin, mapout: this._currentMapout, curve: this._currentCurve });
		const mapin = [...this._currentMapin, x].sort((a, b) => a - b);
		const insertAt = mapin.indexOf(x);
		const mapout = [...this._currentMapout];
		mapout.splice(insertAt, 0, y);
		const patch = { mapin: mapin.join(","), mapout: mapout.join(",") };
		const nextCurve = this._curveArrayAfterInsert(node, insertAt);
		if (nextCurve !== undefined) patch.curve = nextCurve;
		this._currentMapin = mapin;
		this._currentMapout = mapout;
		this._selectedPointIndex = insertAt;
		this._writeAttrs(node, patch);
		this._drag = { index: insertAt, isEndpoint: false, axisLock: null, startPx: px, startPy: py };
		this._showCoordTooltip(px, py, x, y);
	}

	// Keeps a "Per point" curve array aligned with mapin/mapout when a point
	// is added/removed — splitting a segment duplicates its curve value
	// (both halves start out the same), merging two segments back into one
	// keeps the left one's. Returns undefined when curve isn't currently in
	// per-point (comma) form, meaning nothing needs adjusting.
	_curveArrayAfterInsert(node, insertAt) {
		const arr = parseCsvStrings(node.attributes.curve);
		if (!arr || arr.length <= 1) return undefined;
		const splitIdx = Math.max(0, Math.min(arr.length - 1, insertAt - 1));
		const next = [...arr];
		next.splice(splitIdx, 0, arr[splitIdx]);
		return next.join(",");
	}

	_curveArrayAfterDelete(node, deletedIdx) {
		const arr = parseCsvStrings(node.attributes.curve);
		if (!arr || arr.length <= 1) return undefined;
		const next = [...arr];
		next.splice(Math.min(deletedIdx, next.length - 1), 1);
		return next.length ? next.join(",") : "linear";
	}

	// `labelEl` is one of the DOM axis-label spans (see the template) —
	// swapped for a real <input> in place, rather than an absolutely
	// positioned overlay, per Hans (2026-09-25): easier to hit, and the
	// browser's own text cursor makes it obvious it's editable.
	_editAxisValue(node, which, index, labelEl) {
		const current = which === "mapin" ? this._currentMapin[index] : this._currentMapout[index];
		const input = document.createElement("input");
		input.type = "number";
		input.step = "any";
		input.className = "axis-edit-input";
		input.value = current;
		labelEl.replaceWith(input);
		input.focus();
		input.select();
		const commit = () => {
			// Removing a focused element can itself trigger a second, genuine
			// "blur" on it (a real browser quirk, not just this synthetic
			// listener) — guard against running twice, which would otherwise
			// throw trying to replace an already-detached node.
			if (!input.isConnected) return;
			input.removeEventListener("blur", commit);
			const v = parseFloat(input.value);
			input.replaceWith(labelEl);
			if (!Number.isFinite(v)) return;
			const arr = which === "mapin" ? [...this._currentMapin] : [...this._currentMapout];
			this._rescaleInteriorPoints(arr, index, v);
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
				input.replaceWith(labelEl);
			}
		});
	}

	// Mutates `arr` in place: sets the edited endpoint to `newValue`, then
	// rescales every interior point to keep its *relative* position between
	// the two endpoints — the curve's shape stays intact, only the numbers
	// move to fit the new range. Per Hans (2026-09-25). The other endpoint
	// never moves. A degenerate old range (both endpoints were equal) has
	// no meaningful "relative position" to preserve, so interior points are
	// left untouched in that case.
	_rescaleInteriorPoints(arr, editedIndex, newValue) {
		const otherIndex = editedIndex === 0 ? arr.length - 1 : 0;
		const oldEdited = arr[editedIndex];
		const otherValue = arr[otherIndex];
		const oldRange = otherValue - oldEdited;
		arr[editedIndex] = newValue;
		if (oldRange === 0) return;
		const newRange = otherValue - newValue;
		for (let k = 0; k < arr.length; k++) {
			if (k === editedIndex || k === otherIndex) continue;
			const t = (arr[k] - oldEdited) / oldRange;
			arr[k] = newValue + t * newRange;
		}
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

	// Switches between one curve value for every segment and one per segment
	// (Per Hans, 2026-09-24) — the shape is purely derived from the comma
	// count in the written attribute, so this just expands/collapses it.
	_onCurveModeChange() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const mode = this._curveModeRadios.find((r) => r.checked)?.value;
		const curveArr = parseCsvStrings(node.attributes.curve) || ["linear"];
		const segmentCount = Math.max(1, this._currentMapin.length - 1);
		if (mode === "per") {
			if (curveArr.length > 1) return;
			this._writeAttrs(node, { curve: Array(segmentCount).fill(curveArr[0]).join(",") });
		} else {
			if (curveArr.length <= 1) return;
			const collapsed = this._selectedPointIndex !== null && this._selectedPointIndex < curveArr.length ? curveArr[this._selectedPointIndex] : curveArr[0];
			this._writeAttrs(node, { curve: collapsed });
		}
	}

	_onCurveSelectChange() {
		const val = this._curveSelect.value;
		if (val === CURVE_CUSTOM) {
			this._curvePower.hidden = false;
			const v = parseFloat(this._curvePower.value);
			this._writeCurveValue(Number.isFinite(v) ? String(v) : "2");
		} else {
			this._curvePower.hidden = true;
			this._writeCurveValue(val);
		}
	}

	_onCurvePowerCommit() {
		const v = parseFloat(this._curvePower.value);
		if (!Number.isFinite(v)) return;
		this._writeCurveValue(String(v));
	}

	// Writes either the single global curve value, or (in "Per point" mode)
	// just the selected segment's own entry, keeping every other segment's
	// value untouched. Per Hans's spec: always written back comma-separated
	// when there's more than one value.
	_writeCurveValue(newValueStr) {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Var") return;
		const curveArr = parseCsvStrings(node.attributes.curve) || ["linear"];
		if (curveArr.length > 1) {
			if (this._selectedPointIndex === null || this._selectedPointIndex >= curveArr.length) return;
			const next = [...curveArr];
			next[this._selectedPointIndex] = newValueStr;
			this._writeAttrs(node, { curve: next.join(",") });
		} else {
			this._writeAttrs(node, { curve: newValueStr });
		}
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

		// Plain in-canvas corner labels, same "read-only, not editable" look
		// the X-axis min/max always had — per Hans (2026-09-30): a DOM chip
		// styled like the Mapping graph's own editable axis labels read as
		// interactive when these are strictly derived/read-only (input from
		// the previous block's mapout, output from the selected function).
		// formatValue (not the always-3-decimals fmtNum) so a value >= 100
		// shows no decimals at all — same shared "significant digits" rule
		// as every other live readout in the app (js/utils/number-format.js).
		// Per Hans (2026-09-30): "1046.502... är för många värdesiffror."
		const xMax = Math.max(Math.abs(domain.min), Math.abs(domain.max));
		const yMax = Math.max(Math.abs(minY), Math.abs(maxY));
		ctx.fillStyle = "#8a8a8a";
		ctx.font = "10px monospace";
		ctx.textAlign = "left";
		ctx.fillText(formatValue(maxY, yMax), MAP_PADDING, 12); // Y max, top-left
		ctx.fillText(formatValue(minY, yMax), MAP_PADDING, h - MAP_PADDING - 4); // Y min, just above the axis line
		ctx.fillText(formatValue(domain.min, xMax), MAP_PADDING, h - 4); // X min, bottom-left
		ctx.textAlign = "right";
		ctx.fillText(formatValue(domain.max, xMax), w - MAP_PADDING, h - 4); // X max, bottom-right
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
		if (!node || node.tagName !== "Var") return;
		// Self-healing: _render()'s own _updateFlowArrow() call can land
		// while this view is still hidden (0×0 — wa-preview.js hasn't
		// swapped its active state yet, e.g. right when a Var is first
		// selected), which leaves the arrow unpositioned. Redoing it every
		// frame here (cheap: a few getBoundingClientRect calls) means it's
		// always correct within one frame of actually becoming visible,
		// without needing to win a listener-order race with wa-preview.js.
		this._updateFlowArrow();
		if (!playerStore.isDocumentLoaded) return;
		const realId = node.attributes.id;
		if (!realId) return;
		let liveObj;
		try {
			const matches = playerStore.getLiveObjects(`[id='${realId}']`);
			liveObj = matches && matches[0];
		} catch {
			liveObj = null;
		}
		if (!liveObj || typeof liveObj.lastInputValue !== "number") {
			this._incomingValueEl.textContent = "—";
			this._outgoingValueEl.textContent = "—";
			return;
		}
		const stage1 = mapStage1(liveObj.lastInputValue, {
			mapin: this._currentMapin,
			mapout: this._currentMapout,
			curve: this._currentCurve,
			pattern: this._currentPattern
		});
		const finalValue = applyConvertFn(this._currentConvert, stage1); // == stage1 when Convert is off, per applyConvertFn's own passthrough
		this._incomingValueEl.textContent = formatValue(liveObj.lastInputValue, this._incomingValueMax());
		this._outgoingValueEl.textContent = formatValue(finalValue, this._outgoingValueMax());
		if (!this._drag) this._drawMapDot(liveObj.lastInputValue, stage1);
		if (this._convertDomain) this._drawConvertDot(stage1, finalValue);
	}

	// Reference magnitude for formatValue's own "decimals scale to the
	// value's own range" rule (js/utils/number-format.js) — per Hans
	// (2026-09-25), the same rule wa-var-knobs.js's knobs already use.
	_incomingValueMax() {
		const d = this._mapDomainCache;
		return d ? Math.max(Math.abs(d.minIn), Math.abs(d.maxIn)) : 1;
	}

	_outgoingValueMax() {
		if (this._convertDomain && this._convertYDomain) {
			return Math.max(Math.abs(this._convertYDomain.minY), Math.abs(this._convertYDomain.maxY));
		}
		const d = this._mapDomainCache;
		return d ? Math.max(Math.abs(d.minOut), Math.abs(d.maxOut)) : 1;
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
		ctx.fillStyle = "#4fa3ff"; // same as the Map line — still smaller than the static (4.5px) points so it reads as the live marker, not another set point
		ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(cx, cy, 4, 0, Math.PI * 2);
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
		ctx.fillStyle = "#45b58c"; // same as the Convert line, still smaller than the Map graph's static points
		ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(cx, cy, 4, 0, Math.PI * 2);
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
