import { xmlStore } from "../xml-editor/xml-store.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { applyLiveProperty } from "../waxml-integration/live-property.js";
import { formatValue } from "../utils/number-format.js";
import {
	parseGainAttributeToDb,
	formatGainAttribute,
	dbToLinearRatio,
	isDbNativeGain,
	gainDbRangeForTag
} from "../waxml-integration/gain-units.js";
import { biquadResponseCurve, freqToX, xToFreq, GRAPH_FREQ_MIN, GRAPH_FREQ_MAX, BIQUAD_GAIN_TYPES, BIQUAD_Q_TYPES } from "../xml-editor/biquad-math.js";
import { compressorOutputDb } from "../xml-editor/compressor-math.js";
import { defaultBezierPoints, sampleBezierToCurve } from "../xml-editor/waveshaper-math.js";
import { wireKnobDrag } from "../utils/knob-drag.js";
import { buildParamChip, isParamVarControlled } from "../utils/param-binding.js";
import { getLiveProperty } from "../waxml-integration/live-property.js";

// Preview-panel state (see wa-preview.js) for a selected <Chain> — a
// vertical stack of small per-node-type "cards" (one per native Web Audio
// element in the chain, top-to-bottom in document order, since that's the
// exact order waxml.js's own Chain.connect() wires the signal through —
// see waxml.js's "case 'chain':" walk of firstElementChild/nextElementSibling),
// joined by downward flow arrows, node-based-programming style. Same
// "always mounted, listens to xmlStore itself" shape as wa-var-view.js/
// wa-mixer-view.js. Per Hans (2026-09-27/28): "ta höjd för det redan från
// början" — every card, even a plain unsupported one, sits in this same
// arrow-connected vertical flow, so nothing about the layout needs to
// change later to accommodate more node types.
//
// Selecting one of SUPPORTED_CHAIN_NODE_TAGS directly (not via its parent
// <Chain>) also lands here (see wa-preview.js) — shows that node's own
// parent Chain's full stack (with the selected card highlighted) when it
// has one, or just that one card alone otherwise, so e.g. a bare
// <GainNode> outside any <Chain> still gets a useful preview.
//
// Only the 5 node types Hans asked for, plus two simple bonus ones
// (StereoPannerNode, DelayNode — "du får gärna testa att skapa fler enkla
// vyer... på samma tema"), get a dedicated interactive card.
// WAXML-specific children (<Var>, <Send>, <Mixer>, <Synth>, ...) and every
// other native node without a card yet fall back to a plain label card —
// "Lämna de element som är WAXML-specifika."
//
// Every write goes through xmlStore.updateAttributes with the FULL
// attributes object (the established { ...node.attributes, ... } pattern),
// same as wa-mixer-view.js/wa-var-view.js. A drag also nudges the live
// audio graph directly via applyLiveProperty (waxml-integration/live-
// property.js) on every tick, same reasoning as wa-mixer-view.js's own
// knobs: none of these node types are in xml-store.js's
// LIVE_NUDGEABLE_COMPOSITION_TAGS (that's Composition-only machinery), so
// without this a drag would only update the XML/Code panel and never be
// heard until the next full reload.

const OSCILLATOR_TYPES = ["sine", "square", "sawtooth", "triangle", "custom"];
const BIQUAD_FILTER_TYPES = ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"];
const OVERSAMPLE_OPTIONS = ["none", "2x", "4x"];

const KNOB_PX_PER_RANGE = 160; // dragging this many px sweeps a knob's full range, same feel as wa-mixer-view.js

function readNum(node, attrName, fallback) {
	const n = parseFloat(node.attributes[attrName]);
	return Number.isFinite(n) ? n : fallback;
}

function displayTagName(tag) {
	return tag.replace(/Node$/, "");
}

function displayLabel(node) {
	return node.attributes.label || node.attributes.id || "";
}

function canvasPointFromEvent(canvas, e) {
	const rect = canvas.getBoundingClientRect();
	const sx = canvas.width / rect.width;
	const sy = canvas.height / rect.height;
	return { px: (e.clientX - rect.left) * sx, py: (e.clientY - rect.top) * sy };
}

// --- BiquadFilterNode graph pixel<->value mapping ---
const BIQUAD_DB_RANGE = 24; // shows -24..+24 dB
function biquadFreqToXPixel(w, freq) {
	return freqToX(freq) * w;
}
function biquadXPixelToFreq(w, px) {
	return xToFreq(px / w);
}
function biquadDbToYPixel(h, db) {
	const t = (db + BIQUAD_DB_RANGE) / (2 * BIQUAD_DB_RANGE);
	return h - Math.max(0, Math.min(1, t)) * h;
}
function biquadYPixelToDb(h, py) {
	const t = 1 - py / h;
	return t * 2 * BIQUAD_DB_RANGE - BIQUAD_DB_RANGE;
}
// Vertical drag also covers Q for filter types that have Q but no
// meaningful gain (lowpass/highpass/bandpass/notch/allpass) — same graph
// axis the gain-capable types (peaking/lowshelf/highshelf) use for gain,
// since a type is never both draggable-Q *and* draggable-gain except
// "peaking", which keeps gain on the drag (Q stays scroll-only there — see
// _buildBiquadCard). Per Hans (2026-09-28).
const BIQUAD_Q_DRAG_MIN = 0.1,
	BIQUAD_Q_DRAG_MAX = 20;
function biquadQToYPixel(h, q) {
	const t = (q - BIQUAD_Q_DRAG_MIN) / (BIQUAD_Q_DRAG_MAX - BIQUAD_Q_DRAG_MIN);
	return h - Math.max(0, Math.min(1, t)) * h;
}
function biquadYPixelToQ(h, py) {
	const t = 1 - py / h;
	return BIQUAD_Q_DRAG_MIN + Math.max(0, Math.min(1, t)) * (BIQUAD_Q_DRAG_MAX - BIQUAD_Q_DRAG_MIN);
}

// For 5 of the 8 filter types, the curve's own dB height at the cutoff
// frequency turns out to have an exact closed form in terms of the Y-drag
// parameter (verified numerically against computeBiquadCoeffs/
// biquadMagnitudeDb): lowpass/highpass's resonant peak at w0 is exactly
// 20*log10(Q); peaking's is exactly gainDb (by definition); lowshelf/
// highshelf's is exactly gainDb/2 (the shelf's own halfway point, per the
// RBJ cookbook's S=1 slope). That means the draggable dot can sit exactly
// ON the curve — and stay exactly under the cursor while dragging — for
// these types, by using this formula both to place the dot and to invert a
// dragged pixel position straight back into Q/gain. Per Hans (2026-09-28):
// "Sätt den lilla cirkeln man ska dra Q-värdet med på linjen så blir det
// perfekt."
//
// bandpass/notch/allpass are deliberately excluded — their response at
// *exactly* the cutoff frequency doesn't depend on Q at all (bandpass is
// always ~0dB there by Web Audio's own "constant 0dB peak gain" definition,
// notch is always a deep null, allpass preserves magnitude everywhere) — so
// there's no line for a Q-encoding dot to sit on at that point; those 3
// keep the independent, non-graph-anchored biquadQToYPixel/biquadYPixelToQ
// mapping above instead.
const BIQUAD_EXACT_CENTER_TYPES = new Set(["lowpass", "highpass", "peaking", "lowshelf", "highshelf"]);

function biquadCenterResponseDb(type, Q, gainDb) {
	switch (type) {
		case "lowpass":
		case "highpass":
			return 20 * Math.log10(Math.max(0.0001, Q));
		case "peaking":
			return gainDb;
		case "lowshelf":
		case "highshelf":
			return gainDb / 2;
		default:
			return 0;
	}
}

// Inverse of biquadCenterResponseDb, solved for whichever parameter is on
// the Y-drag axis for `type` (Q for lowpass/highpass, gain for the other 3).
function biquadCenterResponseInverse(type, targetDb) {
	switch (type) {
		case "lowpass":
		case "highpass":
			return Math.pow(10, targetDb / 20);
		case "peaking":
			return targetDb;
		case "lowshelf":
		case "highshelf":
			return targetDb * 2;
		default:
			return 0;
	}
}

// --- DynamicsCompressorNode graph pixel<->value mapping ---
const COMP_DB_MIN = -60,
	COMP_DB_MAX = 0;
function compDbToXPixel(w, db) {
	return ((db - COMP_DB_MIN) / (COMP_DB_MAX - COMP_DB_MIN)) * w;
}
function compXPixelToDb(w, px) {
	return COMP_DB_MIN + (px / w) * (COMP_DB_MAX - COMP_DB_MIN);
}
function compDbToYPixel(h, db) {
	const t = (db - COMP_DB_MIN) / (COMP_DB_MAX - COMP_DB_MIN);
	return h - Math.max(0, Math.min(1, t)) * h;
}
function compYPixelToDb(h, py) {
	const t = 1 - py / h;
	return COMP_DB_MIN + t * (COMP_DB_MAX - COMP_DB_MIN);
}

// --- WaveShaperNode bezier <-> pixel mapping (x/y both -1..1) ---
function wsXToPixel(w, x) {
	return ((x + 1) / 2) * w;
}
function wsPixelToX(w, px) {
	return (px / w) * 2 - 1;
}
function wsYToPixel(h, y) {
	return h - ((y + 1) / 2) * h;
}
function wsPixelToY(h, py) {
	return (1 - py / h) * 2 - 1;
}
function parseBezierAttr(str) {
	if (!str) return null;
	const nums = String(str)
		.split(",")
		.map((s) => parseFloat(s.trim()));
	if (nums.length !== 8 || nums.some((n) => !Number.isFinite(n))) return null;
	return {
		p0: { x: nums[0], y: nums[1] },
		c1: { x: nums[2], y: nums[3] },
		c2: { x: nums[4], y: nums[5] },
		p3: { x: nums[6], y: nums[7] }
	};
}
function bezierToAttr(pts) {
	const r = (n) => Math.round(n * 1000) / 1000;
	return [pts.p0.x, pts.p0.y, pts.c1.x, pts.c1.y, pts.c2.x, pts.c2.y, pts.p3.x, pts.p3.y].map(r).join(",");
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.chain-viewport {
			height: 100%;
			overflow: auto;
			padding: 0.85rem;
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
			align-items: center;
		}
		.centered {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin-top: 2rem;
			padding: 0 0.5rem;
		}
		.chain-stack {
			display: flex;
			flex-direction: column;
			align-items: center;
			width: 100%;
			max-width: 260px;
		}
		.node-card {
			width: 100%;
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			padding: 0.6rem 0.7rem;
		}
		.node-card.selected {
			border-color: var(--waw-accent, #4fa3ff);
			box-shadow: 0 0 0 1px var(--waw-accent, #4fa3ff);
		}
		.node-card-header {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 0.4rem;
			margin-bottom: 0.5rem;
			cursor: pointer;
		}
		.node-card-title {
			font-size: 0.7rem;
			font-weight: 600;
			letter-spacing: 0.02em;
			color: #cdd3d8;
		}
		.node-card-id {
			font-size: 0.58rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.node-type-select {
			width: 100%;
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			color: #cdd3d8;
			font-size: 0.65rem;
			border-radius: 3px;
			padding: 0.15rem 0.3rem;
			margin-bottom: 0.4rem;
		}
		.node-graph {
			width: 100%;
			height: 110px;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			display: block;
			touch-action: none;
		}
		.field-row-group {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			margin-top: 0.5rem;
		}
		.field-row {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			font-size: 0.65rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.field-row .field-label {
			flex: 0 0 auto;
			min-width: 4.2rem;
		}
		.field-row .field-input {
			flex: 1 1 auto;
			min-width: 0;
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			color: #cdd3d8;
			font-size: 0.65rem;
			border-radius: 3px;
			padding: 0.1rem 0.25rem;
		}
		.field-row .field-unit {
			flex: 0 0 auto;
			font-size: 0.6rem;
		}
		.hint-text {
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
			margin-top: 0.4rem;
			text-align: center;
		}
		.generic-attr-list {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.68rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.generic-attr-list div {
			padding: 0.05rem 0;
			word-break: break-all;
		}
		.connector-arrow-wrap {
			flex: 0 0 auto;
			line-height: 0;
		}

		/* Knob widget — same visual as wa-mixer-view.js's filter/gain knobs
		   (per Hans: "Gärna samma design som används för filtren i <Mixer>.
		   Grå blir snyggt.") — kept gray uniformly here rather than
		   color-coded per parameter. */
		.knob-row {
			display: flex;
			justify-content: center;
			gap: 0.7rem;
			margin-top: 0.5rem;
		}
		.knob-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.15rem;
			position: relative;
		}
		.knob {
			width: 26px;
			height: 26px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #52565c, #17191c 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
			position: relative;
			cursor: ns-resize;
			touch-action: none;
			z-index: 1;
		}
		.knob.knob-large {
			width: 36px;
			height: 36px;
		}
		.knob:hover {
			filter: brightness(1.2);
		}
		/* A knob whose attribute is currently a "$name" <Var> reference —
		   dragging it would just fight waxml.js's own Watcher, so it's
		   locked instead (same reasoning/visual language as
		   wa-mixer-view.js's own .remote-controlled). */
		.knob.remote-controlled {
			cursor: default;
			box-shadow: 0 0 0 2px rgba(120, 170, 255, 0.6), 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
		}
		.knob.remote-controlled:hover {
			filter: none;
		}
		.knob-dial {
			position: absolute;
			left: 50%;
			top: 2px;
			width: 2px;
			height: 45%;
			margin-left: -1px;
			background: #f2f2f2;
			border-radius: 1px;
			transform-origin: center bottom;
			z-index: 1;
		}
		.knob-ticks {
			position: absolute;
			pointer-events: none;
		}
		.knob-tick {
			position: absolute;
			width: 1px;
			height: 3px;
			background: #f5f5f5;
			opacity: 0.85;
		}
		.knob-label {
			font-size: 0.55rem;
			color: #aab2ba;
			letter-spacing: 0.03em;
		}
		.knob-value-label {
			font-size: 0.6rem;
			color: #cdd3d8;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}

		/* Editable/mappable value chip (see js/utils/param-binding.js) — the
		   shared way every parameter shows its raw value, accepts typed
		   text (a number, math expression, or "$name" <Var> reference), and
		   claims a click while a Var's "Map..." is armed. Per Hans
		   (2026-09-29). */
		.param-chip {
			display: inline-block;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.62rem;
			color: #cdd3d8;
			padding: 0.05rem 0.3rem;
			border-radius: 3px;
			border: 1px solid transparent;
			cursor: text;
		}
		.param-chip:hover {
			background: rgba(255, 255, 255, 0.08);
			border-color: var(--waw-border, #2f2f2f);
		}
		.param-chip.var-controlled {
			color: var(--waw-accent, #4fa3ff);
			border: 1px dashed var(--waw-accent, #4fa3ff);
			cursor: default;
		}
		.chip-row {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			justify-content: center;
			gap: 0.3rem;
			margin-top: 0.4rem;
		}
		.param-chip-input {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.62rem;
			background: #1a1c1f;
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: #cdd3d8;
			border-radius: 3px;
			padding: 0.05rem 0.3rem;
			width: 5.5rem;
		}
	</style>

	<div class="chain-viewport">
		<div class="chain-stack"></div>
	</div>
`;

export class WaChainView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._stackEl = this.shadowRoot.querySelector(".chain-stack");
		this._isLocalEdit = false;
		this._onStoreChange = this._onStoreChange.bind(this);
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onStoreChange);
	}

	_onStoreChange() {
		if (this._isLocalEdit) return;
		this._render();
	}

	// Commits on every drag tick (not just release), same wiring as
	// wa-mixer-view.js's own knobs — this component's own re-render is
	// skipped while `_isLocalEdit` is true so the card being dragged never
	// gets torn down mid-gesture; every other listener (Code panel, tree,
	// live audio) still sees each intermediate value normally.
	_commitAttributes(nodeId, attributes) {
		this._isLocalEdit = true;
		try {
			xmlStore.updateAttributes(nodeId, attributes);
		} finally {
			this._isLocalEdit = false;
		}
	}

	// Resolves what this render should show: a <Chain>'s own children, or
	// (for one of SUPPORTED_CHAIN_NODE_TAGS selected directly) its parent
	// Chain's full stack with that child highlighted, or just itself alone
	// when it has no Chain parent.
	_resolveRenderList(node) {
		if (!node) return null;
		if (node.tagName === "Chain") return { children: node.children, highlightId: null };
		if (!NODE_BUILDERS[node.tagName]) return null;
		const chainAncestor = this._findAncestorChain(node);
		if (chainAncestor) return { children: chainAncestor.children, highlightId: node.id };
		return { children: [node], highlightId: node.id };
	}

	_findAncestorChain(node) {
		let cur = node;
		while (cur && cur.parent) {
			const parent = findNodeById(xmlStore.root, cur.parent);
			if (!parent) return null;
			if (parent.tagName === "Chain") return parent;
			cur = parent;
		}
		return null;
	}

	_render() {
		const node = xmlStore.getSelectedNode();
		const resolved = this._resolveRenderList(node);
		this._stackEl.innerHTML = "";

		if (!resolved) return;

		if (resolved.children.length === 0) {
			const hint = document.createElement("p");
			hint.className = "centered";
			hint.textContent = "Empty chain — add elements in the XML editor.";
			this._stackEl.appendChild(hint);
			return;
		}

		this._stackEl.appendChild(this._buildArrow());
		resolved.children.forEach((child, i) => {
			if (i > 0) this._stackEl.appendChild(this._buildArrow());
			const builder = NODE_BUILDERS[child.tagName];
			const card = builder ? builder(this, child) : this._buildGenericCard(child);
			if (child.id === resolved.highlightId) card.classList.add("selected");
			this._stackEl.appendChild(card);
		});
		this._stackEl.appendChild(this._buildArrow());
	}

	_buildArrow() {
		const el = document.createElement("div");
		el.className = "connector-arrow-wrap";
		el.innerHTML = `<svg viewBox="0 0 24 26" width="24" height="26">
			<line x1="12" y1="0" x2="12" y2="18" stroke="#4fa3ff" stroke-width="2"/>
			<path d="M12,26 L6,16 L18,16 Z" fill="#4fa3ff"/>
		</svg>`;
		return el;
	}

	_buildCardHeader(node) {
		const header = document.createElement("div");
		header.className = "node-card-header";
		header.addEventListener("click", () => xmlStore.selectNode(node.id));

		const title = document.createElement("span");
		title.className = "node-card-title";
		title.textContent = displayTagName(node.tagName);
		header.appendChild(title);

		const idLabel = document.createElement("span");
		idLabel.className = "node-card-id";
		idLabel.textContent = displayLabel(node);
		header.appendChild(idLabel);

		return header;
	}

	_buildEnumSelect(node, attrName, options, defaultValue, onChange) {
		const select = document.createElement("select");
		select.className = "node-type-select";
		options.forEach((v) => {
			const opt = document.createElement("option");
			opt.value = v;
			opt.textContent = v;
			select.appendChild(opt);
		});
		select.value = node.attributes[attrName] || defaultValue;
		select.addEventListener("pointerdown", (e) => e.stopPropagation());
		select.addEventListener("click", (e) => e.stopPropagation());
		select.addEventListener("change", () => {
			const nodeNow = findNodeById(xmlStore.root, node.id);
			if (!nodeNow) return;
			this._commitAttributes(node.id, { ...nodeNow.attributes, [attrName]: select.value });
			if (nodeNow.attributes.id) applyLiveProperty(nodeNow.attributes.id, attrName, select.value);
			if (onChange) onChange(select.value);
		});
		return select;
	}

	// A free-text value chip (see js/utils/param-binding.js) rather than a
	// native <input type=number> — a number input outright rejects
	// anything that isn't a plain number, which made it impossible to type
	// a "$name" <Var> reference or a math expression here even though the
	// schema itself allows either (same union shape the XML Editor's own
	// Inspector already accepts for these attributes). Per Hans (2026-09-29).
	_buildNumberField(node, attrName, unit) {
		const row = document.createElement("div");
		row.className = "field-row";
		const label = document.createElement("span");
		label.className = "field-label";
		label.textContent = attrName;

		const { el: chip, render } = buildParamChip({ getNode: () => findNodeById(xmlStore.root, node.id), attrName });
		const refresh = () => {
			const nodeNow = findNodeById(xmlStore.root, node.id) || node;
			const raw = nodeNow.attributes[attrName];
			const varControlled = isParamVarControlled(nodeNow, attrName);
			chip.classList.toggle("var-controlled", varControlled);
			render(raw ?? "—");
		};
		refresh();

		const unitLabel = document.createElement("span");
		unitLabel.className = "field-unit";
		unitLabel.textContent = unit;
		row.append(label, chip, unitLabel);
		return row;
	}

	// --- shared knob widget (adapted from wa-mixer-view.js) ---

	_buildKnobSkeleton(labelText, sizePx = 26) {
		const wrap = document.createElement("div");
		wrap.className = "knob-wrap";
		wrap.appendChild(this._buildKnobTicks(sizePx));
		const knob = document.createElement("div");
		knob.className = "knob";
		if (sizePx > 30) knob.classList.add("knob-large");
		knob.style.width = `${sizePx}px`;
		knob.style.height = `${sizePx}px`;
		const dial = document.createElement("div");
		dial.className = "knob-dial";
		knob.appendChild(dial);
		wrap.appendChild(knob);
		if (labelText) {
			const labelEl = document.createElement("div");
			labelEl.className = "knob-label";
			labelEl.textContent = labelText;
			wrap.appendChild(labelEl);
		}
		return { wrap, knob, dial };
	}

	_buildKnobTicks(sizePx, count = 11) {
		const wrap = document.createElement("div");
		wrap.className = "knob-ticks";
		const outerSize = sizePx + 10;
		wrap.style.width = `${outerSize}px`;
		wrap.style.height = `${outerSize}px`;
		wrap.style.left = `-5px`;
		wrap.style.top = `-5px`;
		const radius = sizePx / 2 + 3;
		const center = outerSize / 2;
		for (let i = 0; i < count; i++) {
			const angleDeg = -135 + (i / (count - 1)) * 270;
			const angleRad = (angleDeg * Math.PI) / 180;
			const x = center + radius * Math.sin(angleRad);
			const y = center - radius * Math.cos(angleRad);
			const tick = document.createElement("div");
			tick.className = "knob-tick";
			tick.style.left = `${x}px`;
			tick.style.top = `${y}px`;
			tick.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
			wrap.appendChild(tick);
		}
		return wrap;
	}

	_applyKnobRotation(dial, value, min, max) {
		const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
		dial.style.transform = `rotate(${-135 + t * 270}deg)`;
	}

	// Delegates to the shared wireKnobDrag (js/utils/knob-drag.js) — same
	// two-directional (up/right = increase, down/left = decrease) drag every
	// knob in the app now uses. Per Hans (2026-09-28).
	_wireVerticalDrag(el, startValue, min, max, onLiveChange, onCommit, defaultValue) {
		wireKnobDrag(el, {
			getStartValue: () => startValue,
			min,
			max,
			onChange: onLiveChange,
			onCommit,
			defaultValue,
			pxPerRange: KNOB_PX_PER_RANGE
		});
	}

	// Generic knob bound straight to one numeric attribute — used for every
	// simple rotary control (Compressor's knee/attack/release, the bonus
	// StereoPannerNode/DelayNode cards, ...). Commits on every drag tick,
	// same as the gain knob. Shows a value chip (js/utils/param-binding.js)
	// below the dial instead of only a hover tooltip, so every knob can
	// also be typed into (a number, expression, or "$name" <Var>
	// reference) and claimed by an armed Var's "Map..." — per Hans
	// (2026-09-29). When the attribute is already a $var reference, the
	// knob itself is locked (dragging it would just fight waxml.js's own
	// Watcher, same reasoning as wa-mixer-view.js's own
	// _lockRemoteControlled) — the chip stays live for re-typing/re-mapping.
	_buildSimpleKnob(node, attrName, min, max, labelText, formatFn, defaultValue, onChange) {
		const { wrap, knob, dial } = this._buildKnobSkeleton(labelText, 24);
		const applyVisual = (v) => this._applyKnobRotation(dial, v, min, max);

		const { el: chip, render: renderChip } = buildParamChip({ getNode: () => findNodeById(xmlStore.root, node.id), attrName });
		chip.classList.add("knob-value-label");
		wrap.appendChild(chip);

		if (isParamVarControlled(node, attrName)) {
			knob.classList.add("remote-controlled");
			chip.classList.add("var-controlled");
			const live = getLiveProperty(node.attributes.id, attrName);
			applyVisual(Number.isFinite(live) ? live : defaultValue);
			renderChip(node.attributes[attrName]);
			return wrap;
		}

		const current = readNum(node, attrName, defaultValue);
		applyVisual(current);
		renderChip(formatFn(current));

		this._wireVerticalDrag(
			knob,
			current,
			min,
			max,
			(v) => {
				applyVisual(v);
				renderChip(formatFn(v));
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				this._commitAttributes(node.id, { ...nodeNow.attributes, [attrName]: String(Math.round(v * 1000) / 1000) });
				if (nodeNow.attributes.id) applyLiveProperty(nodeNow.attributes.id, attrName, v);
				if (onChange) onChange(v);
			},
			null,
			defaultValue
		);

		return wrap;
	}

	// --- fallback card for everything without a dedicated view ---

	_buildGenericCard(node) {
		const card = document.createElement("div");
		card.className = "node-card generic-card";
		card.appendChild(this._buildCardHeader(node));
		const list = document.createElement("div");
		list.className = "generic-attr-list";
		const entries = Object.entries(node.attributes);
		if (entries.length === 0) {
			const hint = document.createElement("div");
			hint.textContent = "No dedicated preview yet for this element.";
			list.appendChild(hint);
		} else {
			entries.forEach(([k, v]) => {
				const row = document.createElement("div");
				row.textContent = `${k}="${v}"`;
				list.appendChild(row);
			});
		}
		card.appendChild(list);
		return card;
	}

	// --- OscillatorNode: fixed (non-live) waveform shape ---

	_buildOscillatorCard(node) {
		const card = document.createElement("div");
		card.className = "node-card oscillator-card";
		card.appendChild(this._buildCardHeader(node));

		const canvas = document.createElement("canvas");
		canvas.className = "node-graph";
		canvas.width = 240;
		canvas.height = 90;

		const select = this._buildEnumSelect(node, "type", OSCILLATOR_TYPES, "sine", (type) => this._drawOscillatorWave(canvas, type));
		card.appendChild(select);
		card.appendChild(canvas);
		this._drawOscillatorWave(canvas, select.value);

		const fields = document.createElement("div");
		fields.className = "field-row-group";
		fields.appendChild(this._buildNumberField(node, "frequency", "Hz"));
		fields.appendChild(this._buildNumberField(node, "detune", "cents"));
		card.appendChild(fields);

		return card;
	}

	_drawOscillatorWave(canvas, type) {
		const ctx = canvas.getContext("2d");
		const w = canvas.width,
			h = canvas.height;
		ctx.clearRect(0, 0, w, h);
		ctx.strokeStyle = "#2a2d31";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, h / 2);
		ctx.lineTo(w, h / 2);
		ctx.stroke();

		if (type === "custom") {
			ctx.fillStyle = "#8a8a8a";
			ctx.font = "10px system-ui, sans-serif";
			ctx.textAlign = "center";
			ctx.fillText("custom (set via setPeriodicWave)", w / 2, h / 2 + 4);
			return;
		}

		ctx.strokeStyle = "#4fa3ff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		const periods = 2;
		for (let px = 0; px <= w; px++) {
			const t = (px / w) * periods;
			const phase = t - Math.floor(t);
			let y;
			switch (type) {
				case "square":
					y = phase < 0.5 ? 1 : -1;
					break;
				case "sawtooth":
					y = 2 * phase - 1;
					break;
				case "triangle":
					y = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
					break;
				case "sine":
				default:
					y = Math.sin(2 * Math.PI * phase);
					break;
			}
			const py = h / 2 - y * (h * 0.4);
			if (px === 0) ctx.moveTo(px, py);
			else ctx.lineTo(px, py);
		}
		ctx.stroke();
	}

	// --- GainNode: a single gray volume knob (same look as Mixer's filter knobs) ---

	_buildGainCard(node) {
		const card = document.createElement("div");
		card.className = "node-card gain-card";
		card.appendChild(this._buildCardHeader(node));

		const { wrap, knob, dial } = this._buildKnobSkeleton("gain", 40);
		const range = gainDbRangeForTag(node.tagName);
		const applyVisual = (db) => this._applyKnobRotation(dial, db, range.min, range.max);

		const { el: chip, render: renderChip } = buildParamChip({ getNode: () => findNodeById(xmlStore.root, node.id), attrName: "gain" });
		chip.classList.add("knob-value-label");

		if (isParamVarControlled(node, "gain")) {
			knob.classList.add("remote-controlled");
			chip.classList.add("var-controlled");
			const isLinear = !isDbNativeGain(node.tagName);
			const live = getLiveProperty(node.attributes.id, "gain");
			const liveDb = Number.isFinite(live) ? (isLinear ? 20 * Math.log10(Math.max(1e-6, live)) : live) : 0;
			applyVisual(liveDb);
			renderChip(node.attributes.gain);
			wrap.appendChild(chip);
			card.appendChild(this._singleKnobRow(wrap));
			return card;
		}

		const startDb = parseGainAttributeToDb(node.tagName, node.attributes.gain);
		applyVisual(startDb);
		renderChip(`${formatValue(startDb, 100)} dB`);

		this._wireVerticalDrag(
			knob,
			startDb,
			range.min,
			range.max,
			(db) => {
				applyVisual(db);
				renderChip(`${formatValue(db, 100)} dB`);
				const isLinear = !isDbNativeGain(node.tagName);
				if (node.attributes.id) applyLiveProperty(node.attributes.id, "gain", isLinear ? dbToLinearRatio(db) : db);
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (nodeNow) this._commitAttributes(node.id, { ...nodeNow.attributes, gain: formatGainAttribute(node.tagName, db) });
			},
			null,
			0
		);

		wrap.appendChild(chip);
		card.appendChild(this._singleKnobRow(wrap));
		return card;
	}

	// --- BiquadFilterNode: classic EQ-style frequency response curve ---

	_buildBiquadCard(node) {
		const card = document.createElement("div");
		card.className = "node-card biquad-card";
		card.appendChild(this._buildCardHeader(node));

		const canvas = document.createElement("canvas");
		canvas.className = "node-graph";
		canvas.width = 240;
		canvas.height = 120;

		// Falls back to a live-resolved value (rather than the plain default)
		// when an attribute is currently a "$name" <Var> reference — a raw
		// parseFloat("$foo") is NaN, so readNum's own fallback alone would
		// otherwise draw the curve at an arbitrary default instead of
		// whatever the variable is actually currently driving it to.
		const liveOrDefault = (attrName, fallback) => {
			if (!isParamVarControlled(node, attrName)) return readNum(node, attrName, fallback);
			const live = getLiveProperty(node.attributes.id, attrName);
			return Number.isFinite(live) ? live : fallback;
		};
		const state = {
			freq: liveOrDefault("frequency", 1000),
			Q: liveOrDefault("Q", 1),
			gainDb: liveOrDefault("gain", 0) // BiquadFilterNode.gain is native dB
		};

		// The curve's draggable point covers frequency (X, always) plus one
		// more parameter on Y: gain for the 3 types where gain shapes the
		// curve (peaking/lowshelf/highshelf), otherwise Q for the types that
		// have one (lowpass/highpass/bandpass/notch/allpass) — "peaking" has
		// both, so it keeps gain on the drag (the more directly visual of
		// the two: dragging up *is* raising the curve) and Q stays
		// scroll-only there. Per Hans (2026-09-28).
		const yDragMode = (type) => (BIQUAD_GAIN_TYPES.has(type) ? "gain" : BIQUAD_Q_TYPES.has(type) ? "q" : null);

		// Individually mappable/typeable value chips (js/utils/param-binding.js)
		// for each attribute the curve draws — replaces the old plain-text info
		// line so frequency/Q/gain can each be typed into (a number,
		// expression, or "$name" <Var> reference) or claimed by an armed Var's
		// "Map...", same as everywhere else in this view. Per Hans (2026-09-29).
		const chipRow = document.createElement("div");
		chipRow.className = "hint-text chip-row";
		const getNodeNow = () => findNodeById(xmlStore.root, node.id);
		const freqChip = buildParamChip({ getNode: getNodeNow, attrName: "frequency" });
		const qChip = buildParamChip({ getNode: getNodeNow, attrName: "Q" });
		const gainChip = buildParamChip({ getNode: getNodeNow, attrName: "gain" });

		const refreshChips = (type) => {
			const nodeNow = getNodeNow() || node;
			chipRow.innerHTML = "";
			const freqLocked = isParamVarControlled(nodeNow, "frequency");
			freqChip.el.classList.toggle("var-controlled", freqLocked);
			freqChip.render(freqLocked ? nodeNow.attributes.frequency : `${formatValue(state.freq, 10000)} Hz`);
			chipRow.appendChild(freqChip.el);

			if (BIQUAD_Q_TYPES.has(type)) {
				const qLocked = isParamVarControlled(nodeNow, "Q");
				qChip.el.classList.toggle("var-controlled", qLocked);
				qChip.render(qLocked ? nodeNow.attributes.Q : `Q ${formatValue(state.Q, 100)}`);
				chipRow.appendChild(qChip.el);
			}
			if (BIQUAD_GAIN_TYPES.has(type)) {
				const gainLocked = isParamVarControlled(nodeNow, "gain");
				gainChip.el.classList.toggle("var-controlled", gainLocked);
				gainChip.render(gainLocked ? nodeNow.attributes.gain : `${formatValue(state.gainDb, 100)} dB`);
				chipRow.appendChild(gainChip.el);
			}
			// Only "peaking" has both a draggable gain *and* a Q — Q has no
			// drag axis left there, so it stays scroll-only (see yDragMode).
			if (BIQUAD_GAIN_TYPES.has(type) && BIQUAD_Q_TYPES.has(type)) {
				const scrollHint = document.createElement("span");
				scrollHint.textContent = "(scroll = Q)";
				chipRow.appendChild(scrollHint);
			}
		};

		const select = this._buildEnumSelect(node, "type", BIQUAD_FILTER_TYPES, "lowpass", (type) => {
			this._redrawBiquadCanvas(canvas, state, type);
			refreshChips(type);
		});
		card.appendChild(select);
		card.appendChild(canvas);
		card.appendChild(chipRow);
		this._redrawBiquadCanvas(canvas, state, select.value);
		refreshChips(select.value);

		canvas.addEventListener("pointerdown", (e) => {
			const mode = yDragMode(select.value);
			// A var-controlled axis is locked against direct dragging (would
			// just fight waxml.js's own Watcher) — the whole 2D handle is
			// locked if either axis currently in play is, since a single
			// drag gesture can't sensibly move just one of the two anyway;
			// use the chips (typing) or Map to change a locked axis instead.
			const freqLocked = isParamVarControlled(node, "frequency");
			const yLocked = mode === "gain" ? isParamVarControlled(node, "gain") : mode === "q" ? isParamVarControlled(node, "Q") : false;
			if (freqLocked || yLocked) return;

			const { px, py } = canvasPointFromEvent(canvas, e);
			const hx = biquadFreqToXPixel(canvas.width, state.freq);
			const hy = this._biquadHandleY(select.value, state, canvas.height);
			if (Math.hypot(px - hx, py - hy) > 16) return;
			e.preventDefault();
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				const { px: mx, py: my } = canvasPointFromEvent(canvas, moveEvt);
				state.freq = Math.max(GRAPH_FREQ_MIN, Math.min(GRAPH_FREQ_MAX, biquadXPixelToFreq(canvas.width, mx)));
				if (BIQUAD_EXACT_CENTER_TYPES.has(select.value)) {
					// The dot sits exactly on the curve for these 5 types (see
					// BIQUAD_EXACT_CENTER_TYPES) — solve the exact inverse so it
					// also stays exactly under the cursor while dragging.
					const solved = biquadCenterResponseInverse(select.value, biquadYPixelToDb(canvas.height, my));
					if (mode === "gain") state.gainDb = Math.max(-40, Math.min(40, solved));
					else if (mode === "q") state.Q = Math.max(BIQUAD_Q_DRAG_MIN, Math.min(BIQUAD_Q_DRAG_MAX, solved));
				} else if (mode === "gain") {
					state.gainDb = Math.max(-40, Math.min(40, biquadYPixelToDb(canvas.height, my)));
				} else if (mode === "q") {
					state.Q = Math.max(BIQUAD_Q_DRAG_MIN, Math.min(BIQUAD_Q_DRAG_MAX, biquadYPixelToQ(canvas.height, my)));
				}
				this._redrawBiquadCanvas(canvas, state, select.value);
				refreshChips(select.value);

				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				const patch = { ...nodeNow.attributes, frequency: String(Math.round(state.freq)) };
				if (mode === "gain") patch.gain = formatGainAttribute(node.tagName, state.gainDb);
				else if (mode === "q") patch.Q = String(Math.round(state.Q * 10) / 10);
				this._commitAttributes(node.id, patch);
				if (nodeNow.attributes.id) {
					applyLiveProperty(nodeNow.attributes.id, "frequency", state.freq);
					if (mode === "gain") applyLiveProperty(nodeNow.attributes.id, "gain", state.gainDb);
					else if (mode === "q") applyLiveProperty(nodeNow.attributes.id, "Q", state.Q);
				}
			};
			const onUp = () => {
				canvas.removeEventListener("pointermove", onMove);
				canvas.removeEventListener("pointerup", onUp);
			};
			canvas.addEventListener("pointermove", onMove);
			canvas.addEventListener("pointerup", onUp);
		});

		canvas.addEventListener(
			"wheel",
			(e) => {
				if (!BIQUAD_Q_TYPES.has(select.value) || isParamVarControlled(node, "Q")) return;
				e.preventDefault();
				state.Q = Math.max(0.1, Math.min(20, state.Q - e.deltaY * 0.01));
				this._redrawBiquadCanvas(canvas, state, select.value);
				refreshChips(select.value);
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (nodeNow) this._commitAttributes(node.id, { ...nodeNow.attributes, Q: String(Math.round(state.Q * 10) / 10) });
				if (nodeNow?.attributes.id) applyLiveProperty(nodeNow.attributes.id, "Q", state.Q);
			},
			{ passive: false }
		);

		return card;
	}

	// The draggable dot's Y position, shared between the pointerdown hit-test
	// and _redrawBiquadCanvas so they can never drift apart. Sits exactly on
	// the curve for BIQUAD_EXACT_CENTER_TYPES (see biquadCenterResponseDb);
	// falls back to an independent Q<->pixel mapping for bandpass/notch/
	// allpass, whose response at the exact cutoff frequency doesn't depend
	// on Q at all (see BIQUAD_EXACT_CENTER_TYPES's own comment).
	_biquadHandleY(type, state, h) {
		if (BIQUAD_EXACT_CENTER_TYPES.has(type)) {
			const db = Math.max(-BIQUAD_DB_RANGE, Math.min(BIQUAD_DB_RANGE, biquadCenterResponseDb(type, state.Q, state.gainDb)));
			return biquadDbToYPixel(h, db);
		}
		if (BIQUAD_Q_TYPES.has(type)) return biquadQToYPixel(h, state.Q);
		return biquadDbToYPixel(h, 0);
	}

	_redrawBiquadCanvas(canvas, state, type) {
		const ctx = canvas.getContext("2d");
		const w = canvas.width,
			h = canvas.height;
		ctx.clearRect(0, 0, w, h);

		ctx.strokeStyle = "#2a2d31";
		ctx.lineWidth = 1;
		const zeroY = biquadDbToYPixel(h, 0);
		ctx.beginPath();
		ctx.moveTo(0, zeroY);
		ctx.lineTo(w, zeroY);
		ctx.stroke();

		const N = 128;
		const evalFreqs = [];
		for (let i = 0; i <= N; i++) evalFreqs.push(xToFreq(i / N));
		const respDb = biquadResponseCurve(type, state.freq, state.Q, state.gainDb, 44100, evalFreqs);

		ctx.strokeStyle = "#4fa3ff";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		evalFreqs.forEach((f, i) => {
			const x = (i / N) * w;
			const y = biquadDbToYPixel(h, Math.max(-BIQUAD_DB_RANGE, Math.min(BIQUAD_DB_RANGE, respDb[i])));
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.stroke();

		const hx = biquadFreqToXPixel(w, state.freq);
		const hy = this._biquadHandleY(type, state, h);
		ctx.fillStyle = "#4fa3ff";
		ctx.beginPath();
		ctx.arc(hx, hy, 4, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.7)";
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// --- DynamicsCompressorNode: classic transfer curve + knobs for the rest ---

	_buildCompressorCard(node) {
		const card = document.createElement("div");
		card.className = "node-card compressor-card";
		card.appendChild(this._buildCardHeader(node));

		const canvas = document.createElement("canvas");
		canvas.className = "node-graph";
		canvas.width = 200;
		canvas.height = 140;
		card.appendChild(canvas);

		const liveOrDefault = (attrName, fallback) => {
			if (!isParamVarControlled(node, attrName)) return readNum(node, attrName, fallback);
			const live = getLiveProperty(node.attributes.id, attrName);
			return Number.isFinite(live) ? live : fallback;
		};
		const state = {
			threshold: Math.max(COMP_DB_MIN, liveOrDefault("threshold", -24)),
			ratio: liveOrDefault("ratio", 4),
			knee: liveOrDefault("knee", 6)
		};
		this._redrawCompressorCanvas(canvas, state);

		// Individually mappable/typeable chips (js/utils/param-binding.js)
		// for the two canvas-drag-only handles — per Hans (2026-09-29).
		const getNodeNow = () => findNodeById(xmlStore.root, node.id);
		const chipRow = document.createElement("div");
		chipRow.className = "hint-text chip-row";
		const thresholdChip = buildParamChip({ getNode: getNodeNow, attrName: "threshold" });
		const ratioChip = buildParamChip({ getNode: getNodeNow, attrName: "ratio" });
		const thresholdLocked = () => isParamVarControlled(getNodeNow() || node, "threshold");
		const ratioLocked = () => isParamVarControlled(getNodeNow() || node, "ratio");
		const refreshChips = () => {
			const nodeNow = getNodeNow() || node;
			thresholdChip.el.classList.toggle("var-controlled", thresholdLocked());
			thresholdChip.render(thresholdLocked() ? nodeNow.attributes.threshold : `${formatValue(state.threshold, 100)} dB`);
			ratioChip.el.classList.toggle("var-controlled", ratioLocked());
			ratioChip.render(ratioLocked() ? nodeNow.attributes.ratio : `${formatValue(state.ratio, 100)}:1`);
		};
		chipRow.append(thresholdChip.el, ratioChip.el);
		card.appendChild(chipRow);
		refreshChips();

		canvas.addEventListener("pointerdown", (e) => {
			const { px, py } = canvasPointFromEvent(canvas, e);
			const cornerPx = compDbToXPixel(canvas.width, state.threshold);
			const cornerPy = compDbToYPixel(canvas.height, state.threshold);
			const outAt0 = compressorOutputDb(0, state.threshold, state.ratio, state.knee);
			const endPx = compDbToXPixel(canvas.width, 0);
			const endPy = compDbToYPixel(canvas.height, Math.max(COMP_DB_MIN, outAt0));

			let mode = null;
			if (Math.hypot(px - cornerPx, py - cornerPy) <= 12) mode = "threshold";
			else if (Math.hypot(px - endPx, py - endPy) <= 12) mode = "ratio";
			if (!mode) return;
			// A var-controlled handle is locked against dragging (see
			// wa-chain-view.js's other cards for the same reasoning) — type
			// into or Map the chip instead.
			if (mode === "threshold" && thresholdLocked()) return;
			if (mode === "ratio" && ratioLocked()) return;
			e.preventDefault();
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				const { px: mx, py: my } = canvasPointFromEvent(canvas, moveEvt);
				if (mode === "threshold") {
					state.threshold = Math.max(COMP_DB_MIN, Math.min(0, compXPixelToDb(canvas.width, mx)));
				} else {
					const outDb = Math.max(COMP_DB_MIN, Math.min(0, compYPixelToDb(canvas.height, my)));
					const denom = outDb - state.threshold;
					state.ratio = denom > 0.05 ? Math.max(1, Math.min(20, (0 - state.threshold) / denom)) : 20;
				}
				this._redrawCompressorCanvas(canvas, state);
				refreshChips();

				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				const patch = { ...nodeNow.attributes };
				if (mode === "threshold") patch.threshold = String(Math.round(state.threshold * 10) / 10);
				else patch.ratio = String(Math.round(state.ratio * 10) / 10);
				this._commitAttributes(node.id, patch);
				if (nodeNow.attributes.id) {
					if (mode === "threshold") applyLiveProperty(nodeNow.attributes.id, "threshold", state.threshold);
					else applyLiveProperty(nodeNow.attributes.id, "ratio", state.ratio);
				}
			};
			const onUp = () => {
				canvas.removeEventListener("pointermove", onMove);
				canvas.removeEventListener("pointerup", onUp);
			};
			canvas.addEventListener("pointermove", onMove);
			canvas.addEventListener("pointerup", onUp);
		});

		const knobRow = document.createElement("div");
		knobRow.className = "knob-row";
		knobRow.appendChild(
			this._buildSimpleKnob(node, "knee", 0, 40, "knee", (v) => `${v.toFixed(1)} dB`, 6, () => this._redrawCompressorCanvas(canvas, state))
		);
		knobRow.appendChild(this._buildSimpleKnob(node, "attack", 0, 1, "atk", (v) => `${Math.round(v * 1000)} ms`, 0.003));
		knobRow.appendChild(this._buildSimpleKnob(node, "release", 0, 1, "rel", (v) => `${Math.round(v * 1000)} ms`, 0.25));
		card.appendChild(knobRow);

		return card;
	}

	_redrawCompressorCanvas(canvas, state) {
		const ctx = canvas.getContext("2d");
		const w = canvas.width,
			h = canvas.height;
		ctx.clearRect(0, 0, w, h);

		ctx.strokeStyle = "#2a2d31";
		ctx.lineWidth = 1;
		ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(0, h);
		ctx.lineTo(w, 0);
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.strokeStyle = "#45b58c";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		const N = 100;
		for (let i = 0; i <= N; i++) {
			const inDb = COMP_DB_MIN + (i / N) * (COMP_DB_MAX - COMP_DB_MIN);
			const outDb = compressorOutputDb(inDb, state.threshold, state.ratio, state.knee);
			const x = compDbToXPixel(w, inDb);
			const y = compDbToYPixel(h, Math.max(COMP_DB_MIN, outDb));
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();

		const drawHandle = (db, outDb) => {
			const x = compDbToXPixel(w, db);
			const y = compDbToYPixel(h, Math.max(COMP_DB_MIN, outDb));
			ctx.fillStyle = "#45b58c";
			ctx.beginPath();
			ctx.arc(x, y, 4, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = "rgba(255,255,255,0.7)";
			ctx.lineWidth = 1;
			ctx.stroke();
		};
		drawHandle(state.threshold, state.threshold);
		drawHandle(0, compressorOutputDb(0, state.threshold, state.ratio, state.knee));
	}

	// --- WaveShaperNode: single-segment cubic bezier curve editor ---

	_buildWaveShaperCard(node) {
		const card = document.createElement("div");
		card.className = "node-card waveshaper-card";
		card.appendChild(this._buildCardHeader(node));

		const canvas = document.createElement("canvas");
		canvas.className = "node-graph";
		canvas.width = 200;
		canvas.height = 140;

		const oversampleSelect = this._buildEnumSelect(node, "oversample", OVERSAMPLE_OPTIONS, "none");
		card.appendChild(oversampleSelect);
		card.appendChild(canvas);

		let pts = parseBezierAttr(node.attributes.curveBezier) || defaultBezierPoints();
		this._redrawWaveShaperCanvas(canvas, pts);

		const HANDLES = ["p0", "c1", "c2", "p3"];
		canvas.addEventListener("pointerdown", (e) => {
			const { px, py } = canvasPointFromEvent(canvas, e);
			let hit = null;
			for (const key of HANDLES) {
				const hx = wsXToPixel(canvas.width, pts[key].x);
				const hy = wsYToPixel(canvas.height, pts[key].y);
				if (Math.hypot(px - hx, py - hy) <= 12) {
					hit = key;
					break;
				}
			}
			if (!hit) return;
			e.preventDefault();
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				const { px: mx, py: my } = canvasPointFromEvent(canvas, moveEvt);
				const y = Math.max(-1, Math.min(1, wsPixelToY(canvas.height, my)));
				const x = hit === "p0" ? -1 : hit === "p3" ? 1 : Math.max(-1, Math.min(1, wsPixelToX(canvas.width, mx)));
				pts = { ...pts, [hit]: { x, y } };
				this._redrawWaveShaperCanvas(canvas, pts);
			};
			const onUp = () => {
				canvas.removeEventListener("pointermove", onMove);
				canvas.removeEventListener("pointerup", onUp);
				const curve = sampleBezierToCurve(pts);
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				this._commitAttributes(node.id, {
					...nodeNow.attributes,
					curveBezier: bezierToAttr(pts),
					curve: curve.map((v) => Math.round(v * 1000) / 1000).join(",")
				});
			};
			canvas.addEventListener("pointermove", onMove);
			canvas.addEventListener("pointerup", onUp);
		});

		const hint = document.createElement("div");
		hint.className = "hint-text";
		hint.textContent = "Drag the 4 bezier points to shape the curve.";
		card.appendChild(hint);

		return card;
	}

	_redrawWaveShaperCanvas(canvas, pts) {
		const ctx = canvas.getContext("2d");
		const w = canvas.width,
			h = canvas.height;
		ctx.clearRect(0, 0, w, h);

		ctx.strokeStyle = "#2a2d31";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(w / 2, 0);
		ctx.lineTo(w / 2, h);
		ctx.moveTo(0, h / 2);
		ctx.lineTo(w, h / 2);
		ctx.stroke();

		ctx.strokeStyle = "#5a636d";
		ctx.lineWidth = 1;
		ctx.setLineDash([2, 2]);
		ctx.beginPath();
		ctx.moveTo(wsXToPixel(w, pts.p0.x), wsYToPixel(h, pts.p0.y));
		ctx.lineTo(wsXToPixel(w, pts.c1.x), wsYToPixel(h, pts.c1.y));
		ctx.moveTo(wsXToPixel(w, pts.p3.x), wsYToPixel(h, pts.p3.y));
		ctx.lineTo(wsXToPixel(w, pts.c2.x), wsYToPixel(h, pts.c2.y));
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.strokeStyle = "#c98bd6";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(wsXToPixel(w, pts.p0.x), wsYToPixel(h, pts.p0.y));
		ctx.bezierCurveTo(
			wsXToPixel(w, pts.c1.x),
			wsYToPixel(h, pts.c1.y),
			wsXToPixel(w, pts.c2.x),
			wsYToPixel(h, pts.c2.y),
			wsXToPixel(w, pts.p3.x),
			wsYToPixel(h, pts.p3.y)
		);
		ctx.stroke();

		["c1", "c2"].forEach((k) => {
			ctx.fillStyle = "#8a8a8a";
			ctx.beginPath();
			ctx.arc(wsXToPixel(w, pts[k].x), wsYToPixel(h, pts[k].y), 3.5, 0, Math.PI * 2);
			ctx.fill();
		});
		["p0", "p3"].forEach((k) => {
			ctx.fillStyle = "#c98bd6";
			ctx.beginPath();
			ctx.arc(wsXToPixel(w, pts[k].x), wsYToPixel(h, pts[k].y), 4.5, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = "rgba(255,255,255,0.7)";
			ctx.lineWidth = 1;
			ctx.stroke();
		});
	}

	// --- bonus: simple single-knob cards for two more native node types ---

	// Wraps a single knob in the same .knob-row flex container the
	// multi-knob cards (Compressor) use — a .knob-wrap left as a plain block
	// child stretches to the card's full width, which drags its absolutely-
	// positioned ticks away from the (centered) knob itself instead of
	// surrounding it. Bug per Hans (2026-09-28); see .knob-row/.knob-wrap
	// CSS above.
	_singleKnobRow(knobWrap) {
		const row = document.createElement("div");
		row.className = "knob-row";
		row.appendChild(knobWrap);
		return row;
	}

	_buildStereoPannerCard(node) {
		const card = document.createElement("div");
		card.className = "node-card panner-card";
		card.appendChild(this._buildCardHeader(node));
		card.appendChild(this._singleKnobRow(this._buildSimpleKnob(node, "pan", -1, 1, "pan", (v) => v.toFixed(2), 0)));
		return card;
	}

	_buildDelayCard(node) {
		const card = document.createElement("div");
		card.className = "node-card delay-card";
		card.appendChild(this._buildCardHeader(node));
		card.appendChild(this._singleKnobRow(this._buildSimpleKnob(node, "delayTime", 0, 10, "time", (v) => `${Math.round(v * 1000)} ms`, 0.3)));
		return card;
	}
}

const NODE_BUILDERS = {
	OscillatorNode: (view, node) => view._buildOscillatorCard(node),
	BiquadFilterNode: (view, node) => view._buildBiquadCard(node),
	GainNode: (view, node) => view._buildGainCard(node),
	DynamicsCompressorNode: (view, node) => view._buildCompressorCard(node),
	WaveShaperNode: (view, node) => view._buildWaveShaperCard(node),
	StereoPannerNode: (view, node) => view._buildStereoPannerCard(node),
	DelayNode: (view, node) => view._buildDelayCard(node)
};

export const SUPPORTED_CHAIN_NODE_TAGS = new Set(Object.keys(NODE_BUILDERS));

customElements.define("wa-chain-view", WaChainView);
