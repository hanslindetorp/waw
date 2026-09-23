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

	_buildNumberField(node, attrName, unit, min, max) {
		const row = document.createElement("div");
		row.className = "field-row";
		const label = document.createElement("span");
		label.className = "field-label";
		label.textContent = attrName;
		const input = document.createElement("input");
		input.type = "number";
		input.className = "field-input";
		input.value = node.attributes[attrName] ?? "";
		if (min !== undefined) input.min = String(min);
		if (max !== undefined) input.max = String(max);
		input.addEventListener("pointerdown", (e) => e.stopPropagation());
		input.addEventListener("change", () => {
			const nodeNow = findNodeById(xmlStore.root, node.id);
			if (!nodeNow) return;
			const val = input.value.trim();
			const nextAttrs = { ...nodeNow.attributes };
			if (val === "") delete nextAttrs[attrName];
			else nextAttrs[attrName] = val;
			this._commitAttributes(node.id, nextAttrs);
			if (val !== "" && nodeNow.attributes.id) applyLiveProperty(nodeNow.attributes.id, attrName, parseFloat(val));
		});
		const unitLabel = document.createElement("span");
		unitLabel.className = "field-unit";
		unitLabel.textContent = unit;
		row.append(label, input, unitLabel);
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

	_wireVerticalDrag(el, startValue, min, max, onLiveChange, onCommit, defaultValue) {
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const startY = e.clientY;
			let dragging = false;
			let committed = startValue;
			try {
				el.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				dragging = true;
				const deltaPx = startY - moveEvt.clientY; // up = increase
				const rawValue = startValue + (deltaPx / KNOB_PX_PER_RANGE) * (max - min);
				committed = Math.max(min, Math.min(max, rawValue));
				onLiveChange(committed);
			};
			const onUp = () => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
				if (dragging && onCommit) onCommit(committed);
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onUp);
		});

		if (defaultValue !== undefined) {
			el.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				const clamped = Math.max(min, Math.min(max, defaultValue));
				onLiveChange(clamped);
				if (onCommit) onCommit(clamped);
			});
		}
	}

	// Generic knob bound straight to one numeric attribute — used for every
	// simple rotary control (Compressor's knee/attack/release, the bonus
	// StereoPannerNode/DelayNode cards, ...). Commits on every drag tick,
	// same as the gain knob.
	_buildSimpleKnob(node, attrName, min, max, labelText, formatFn, defaultValue, onChange) {
		const { wrap, knob, dial } = this._buildKnobSkeleton(labelText, 24);
		const applyVisual = (v) => this._applyKnobRotation(dial, v, min, max);
		const current = readNum(node, attrName, defaultValue);
		applyVisual(current);
		knob.title = formatFn(current);

		this._wireVerticalDrag(
			knob,
			current,
			min,
			max,
			(v) => {
				applyVisual(v);
				knob.title = formatFn(v);
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
		fields.appendChild(this._buildNumberField(node, "frequency", "Hz", 0, 22050));
		fields.appendChild(this._buildNumberField(node, "detune", "cents", -9600, 9600));
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
		const startDb = parseGainAttributeToDb(node.tagName, node.attributes.gain);
		applyVisual(startDb);
		knob.title = "Gain";

		const valueLabel = document.createElement("div");
		valueLabel.className = "knob-value-label";
		valueLabel.textContent = `${formatValue(startDb, 100)} dB`;

		this._wireVerticalDrag(
			knob,
			startDb,
			range.min,
			range.max,
			(db) => {
				applyVisual(db);
				valueLabel.textContent = `${formatValue(db, 100)} dB`;
				const isLinear = !isDbNativeGain(node.tagName);
				if (node.attributes.id) applyLiveProperty(node.attributes.id, "gain", isLinear ? dbToLinearRatio(db) : db);
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (nodeNow) this._commitAttributes(node.id, { ...nodeNow.attributes, gain: formatGainAttribute(node.tagName, db) });
			},
			null,
			0
		);

		wrap.appendChild(valueLabel);
		card.appendChild(wrap);
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

		const state = {
			freq: readNum(node, "frequency", 1000),
			Q: readNum(node, "Q", 1),
			gainDb: readNum(node, "gain", 0) // BiquadFilterNode.gain is native dB
		};

		const infoLabel = document.createElement("div");
		infoLabel.className = "hint-text";
		const updateInfoLabel = (type) => {
			const bits = [`${formatValue(state.freq, 10000)} Hz`];
			if (BIQUAD_Q_TYPES.has(type)) bits.push(`Q ${formatValue(state.Q, 100)}`);
			if (BIQUAD_GAIN_TYPES.has(type)) bits.push(`${formatValue(state.gainDb, 100)} dB`);
			bits.push("(scroll = Q)");
			infoLabel.textContent = bits.join(" · ");
		};

		const select = this._buildEnumSelect(node, "type", BIQUAD_FILTER_TYPES, "lowpass", (type) => {
			this._redrawBiquadCanvas(canvas, state, type);
			updateInfoLabel(type);
		});
		card.appendChild(select);
		card.appendChild(canvas);
		card.appendChild(infoLabel);
		this._redrawBiquadCanvas(canvas, state, select.value);
		updateInfoLabel(select.value);

		canvas.addEventListener("pointerdown", (e) => {
			const { px, py } = canvasPointFromEvent(canvas, e);
			const gainCapable = BIQUAD_GAIN_TYPES.has(select.value);
			const hx = biquadFreqToXPixel(canvas.width, state.freq);
			const hy = gainCapable ? biquadDbToYPixel(canvas.height, state.gainDb) : biquadDbToYPixel(canvas.height, 0);
			if (Math.hypot(px - hx, py - hy) > 16) return;
			e.preventDefault();
			try {
				canvas.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				const { px: mx, py: my } = canvasPointFromEvent(canvas, moveEvt);
				state.freq = Math.max(GRAPH_FREQ_MIN, Math.min(GRAPH_FREQ_MAX, biquadXPixelToFreq(canvas.width, mx)));
				if (gainCapable) state.gainDb = Math.max(-40, Math.min(40, biquadYPixelToDb(canvas.height, my)));
				this._redrawBiquadCanvas(canvas, state, select.value);
				updateInfoLabel(select.value);

				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				const patch = { ...nodeNow.attributes, frequency: String(Math.round(state.freq)) };
				if (gainCapable) patch.gain = formatGainAttribute(node.tagName, state.gainDb);
				this._commitAttributes(node.id, patch);
				if (nodeNow.attributes.id) {
					applyLiveProperty(nodeNow.attributes.id, "frequency", state.freq);
					if (gainCapable) applyLiveProperty(nodeNow.attributes.id, "gain", state.gainDb);
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
				if (!BIQUAD_Q_TYPES.has(select.value)) return;
				e.preventDefault();
				state.Q = Math.max(0.1, Math.min(20, state.Q - e.deltaY * 0.01));
				this._redrawBiquadCanvas(canvas, state, select.value);
				updateInfoLabel(select.value);
				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (nodeNow) this._commitAttributes(node.id, { ...nodeNow.attributes, Q: String(Math.round(state.Q * 10) / 10) });
				if (nodeNow?.attributes.id) applyLiveProperty(nodeNow.attributes.id, "Q", state.Q);
			},
			{ passive: false }
		);

		return card;
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

		const gainCapable = BIQUAD_GAIN_TYPES.has(type);
		const hx = biquadFreqToXPixel(w, state.freq);
		const hy = gainCapable ? biquadDbToYPixel(h, state.gainDb) : zeroY;
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

		const state = {
			threshold: Math.max(COMP_DB_MIN, readNum(node, "threshold", -24)),
			ratio: readNum(node, "ratio", 4),
			knee: readNum(node, "knee", 6)
		};
		this._redrawCompressorCanvas(canvas, state);

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

				const nodeNow = findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				this._commitAttributes(node.id, {
					...nodeNow.attributes,
					threshold: String(Math.round(state.threshold * 10) / 10),
					ratio: String(Math.round(state.ratio * 10) / 10)
				});
				if (nodeNow.attributes.id) {
					applyLiveProperty(nodeNow.attributes.id, "threshold", state.threshold);
					applyLiveProperty(nodeNow.attributes.id, "ratio", state.ratio);
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

	_buildStereoPannerCard(node) {
		const card = document.createElement("div");
		card.className = "node-card panner-card";
		card.appendChild(this._buildCardHeader(node));
		card.appendChild(this._buildSimpleKnob(node, "pan", -1, 1, "pan", (v) => v.toFixed(2), 0));
		return card;
	}

	_buildDelayCard(node) {
		const card = document.createElement("div");
		card.className = "node-card delay-card";
		card.appendChild(this._buildCardHeader(node));
		card.appendChild(this._buildSimpleKnob(node, "delayTime", 0, 10, "time", (v) => `${Math.round(v * 1000)} ms`, 0.3));
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
