import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { isEditableContext } from "../project/edit-history.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { mapStage1, applyConvertFn } from "../xml-editor/var-mapper-math.js";
import { formatValue } from "../utils/number-format.js";
import { varMapMode } from "../state/var-map-mode.js";
import { wireKnobDrag } from "../utils/knob-drag.js";

// One knob per <Var> child of a "scope" node — lets you nudge a variable
// live while playing, right from the player/bottom bar. Turning a knob never
// touches xmlStore — per Hans, it calls waxml.setVariable(name, value)
// directly, same as any other purely-live control (see live-property.js's
// own applyLiveProperty). This also means a knob's own current position is
// *not* the document's source of truth (a <Var>'s XML attributes never
// change) — it's tracked only in this component's own _values map, for as
// long as it stays alive.
//
// The scope defaults to the document root (matching how root-level
// <Command> trigger-shortcuts work in wa-player-bar.js) but can be pointed
// at any other node via setScopeNode() — per Hans (2026-09-20): wa-bottom-
// bar.js's own "local" row uses a second <wa-var-knobs> instance scoped to
// whatever element is currently selected, showing only *its* own <Var>
// children, side by side with the always-root-scoped "global" instance.

const KNOB_PX_PER_RANGE = 130; // dragging this many px sweeps a knob's full range — smaller than the shared default since this knob itself is smaller (see KNOB_SIZE)
const KNOB_SIZE = 24;

function parseNumberList(str) {
	if (typeof str !== "string" || str.trim() === "") return [];
	const separator = str.includes(";") ? ";" : str.includes(",") ? "," : str.includes("...") ? "..." : " ";
	return str
		.split(separator)
		.map((s) => parseFloat(s.trim()))
		.filter((n) => Number.isFinite(n));
}

// formatValue/decimalsForMax now live in js/utils/number-format.js — per
// Hans (2026-09-25), the same "scale decimals to the value's own
// magnitude" rule applies to every live/mapped numeric readout in WAW, not
// just knobs (see wa-var-view.js's own live input/output value fields).

// True when this Var actually transforms its value in some way (see
// wa-var-view.js's Mapping/Pattern/Curve/Convert nodes) — a knob for a
// plain, unmapped Var (mapin === mapout, nothing else set) only ever needs
// its one existing value display. Per Hans (2026-09-25). An absent mapout
// defaults to mapin (same as waxml.js's own Mapper), so that alone doesn't
// count as "mapped".
function hasMapping(node) {
	if (node.attributes.pattern !== undefined || node.attributes.curve !== undefined || node.attributes.convert !== undefined) return true;
	const mapinStr = node.attributes.mapin;
	const mapoutStr = node.attributes.mapout !== undefined ? node.attributes.mapout : mapinStr;
	if (mapinStr === undefined && mapoutStr === undefined) return false;
	const a = parseNumberList(mapinStr);
	const b = parseNumberList(mapoutStr);
	if (a.length !== b.length) return true;
	return a.some((v, i) => v !== b[i]);
}

// The value this Var's own mapping pipeline would produce for a given raw
// input — same math wa-var-view.js's live dots use, so the knob's own
// output readout always matches what that editor shows. Per Hans
// (2026-09-25).
function computeMappedValue(node, rawValue) {
	const mapin = parseNumberList(node.attributes.mapin);
	const mapoutStr = node.attributes.mapout !== undefined ? node.attributes.mapout : node.attributes.mapin;
	const mapout = parseNumberList(mapoutStr);
	const pattern = node.attributes.pattern !== undefined ? parseNumberList(node.attributes.pattern) : null;
	const stage1 = mapin.length >= 2 && mapout.length >= 2 ? mapStage1(rawValue, { mapin, mapout, curve: node.attributes.curve, pattern }) : rawValue;
	return applyConvertFn(node.attributes.convert, stage1);
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			gap: 0.6rem;
		}
		:host([hidden]) {
			display: none;
		}
		/* :host's own flex only arranges its one shadow-DOM child (this
		   div) — without this, .var-knob-wrap (a plain block-level div per
		   knob) stacked vertically instead of sitting side by side. Per
		   Hans (2026-09-10). */
		.var-knobs {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-start;
			gap: 1rem;
		}
		.var-knob-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.15rem;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			padding: 0.4rem 0.55rem;
			cursor: pointer;
		}
		.var-name-row {
			display: flex;
			align-items: center;
			gap: 0.3rem;
		}
		.map-btn {
			flex: 0 0 auto;
			background: none;
			border: 1px dashed var(--waw-border, #2f2f2f);
			border-radius: 4px;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.6rem;
			font-family: inherit;
			padding: 0.05rem 0.3rem;
			cursor: pointer;
			white-space: nowrap;
		}
		.map-btn:hover {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		@keyframes var-map-armed-blink {
			0%,
			100% {
				opacity: 1;
			}
			50% {
				opacity: 0.35;
			}
		}
		.map-btn.armed {
			border-style: solid;
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
			animation: var-map-armed-blink 0.9s ease-in-out infinite;
		}
		/* Knob + its value sit in a row now (value used to be stacked below
		   the knob along with the name) — per Hans (2026-09-10). Gap widened
		   the same day — the knob and value almost touched at 0.35rem. */
		.var-knob-row {
			display: flex;
			align-items: center;
			gap: 0.65rem;
		}
		/* The ticks' own -5px/-5px offsets (see _buildTicks) are relative to
		   this anchor specifically (a plain KNOB_SIZE box), not the whole
		   row — so they stay centered on just the knob once the value label
		   sits beside it instead of stretching the row wider. */
		.var-knob-anchor {
			position: relative;
			width: ${KNOB_SIZE}px;
			height: ${KNOB_SIZE}px;
		}
		.var-knob {
			width: ${KNOB_SIZE}px;
			height: ${KNOB_SIZE}px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #52565c, #17191c 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
			position: relative;
			cursor: ns-resize;
			touch-action: none;
			z-index: 1;
		}
		.var-knob:hover {
			filter: brightness(1.2);
		}
		.var-knob.disabled {
			cursor: default;
			opacity: 0.4;
		}
		/* Selection highlight moved to the whole box (per Hans, 2026-09-30) —
		   not just the knob, which is drag-only territory (see the wrap-level
		   click-to-select listener in _buildKnob). */
		.var-knob-wrap.selected {
			border-color: var(--waw-accent, #4fa3ff);
			box-shadow: 0 0 0 1px var(--waw-accent, #4fa3ff);
		}
		.var-knob-dial {
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
		.var-knob-ticks {
			position: absolute;
			pointer-events: none;
		}
		.var-knob-tick {
			position: absolute;
			width: 1px;
			height: 3px;
			background: #f5f5f5;
			opacity: 0.85;
		}
		.var-name {
			font-size: 0.55rem;
			color: #aab2ba;
			letter-spacing: 0.03em;
			max-width: 4.5rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		/* Bigger than the name label — per Hans (2026-09-10), for
		   readability now that it sits beside the knob instead of stacked
		   underneath it. A fixed min-width + right-align (also per Hans,
		   2026-09-10) so the digits land on a consistent right edge instead
		   of each width jittering the row as the value changes. */
		.var-values {
			display: flex;
			flex-direction: column;
			align-items: flex-end;
			gap: 0.1rem;
		}
		.var-value {
			font-size: 0.8rem;
			color: var(--waw-accent, #4fa3ff);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			min-width: 2.6rem;
			text-align: right;
		}
		/* A Var with an actual mapping pipeline (see wa-var-view.js) shows
		   both values — the knob's own raw input (white, unmapped) and the
		   value after mapin/mapout/curve/pattern/convert (blue) — so it's
		   clear the knob itself never moved into the mapped range. A Var
		   with no mapping keeps the single accent-colored value exactly as
		   before. Per Hans (2026-09-25). */
		.var-value-input.mapped {
			color: var(--waw-fg, #e8e8e8);
		}
		.var-value-output {
			font-size: 0.68rem;
		}
		.var-value-output[hidden] {
			display: none;
		}
	</style>
	<div class="var-knobs"></div>
`;

export class WaVarKnobs extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._container = this.shadowRoot.querySelector(".var-knobs");
		this._values = new Map(); // node id -> current live value, this component's own state (see class comment)
		this._knobRuntime = new Map(); // node id -> { applyVisual, min, max } — see _onVariableChange
		this._wasDocumentLoaded = false;
		this._scopeNodeId = null; // null = document root (the default/global instance)
		this._onXmlStoreChange = () => this._render();
		this._onPlayerStoreChange = () => this._onPlayerChange();
		this._onVariableChange = this._onVariableChange.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
		// Re-render on every arm/disarm so each knob's own Map button picks up
		// (or drops) its blinking ".armed" state — see _buildKnob. A full
		// _render() is already how this component reacts to any other change
		// (_onXmlStoreChange), so this stays consistent rather than trying to
		// patch just the one button in place. Per Hans (2026-09-27).
		this._onVarMapModeChange = () => this._render();
	}

	// Points this instance at a specific node's own <Var> children instead of
	// the document root — pass null to go back to root. Per Hans (2026-09-20).
	setScopeNode(nodeId) {
		this._scopeNodeId = nodeId;
		this._render();
	}

	_getScopeNode() {
		if (!xmlStore.root) return null;
		if (!this._scopeNodeId) return xmlStore.root;
		return findNodeById(xmlStore.root, this._scopeNodeId);
	}

	// Reads this instance's own unwrapped content width (every knob on one
	// line) regardless of how much room the host currently has — used by
	// wa-bottom-bar.js to balance how much of the bar's width triggers vs.
	// variables get (see its own _recalcLayout). Toggles flex-wrap off just
	// long enough to measure, then restores it — .var-knobs already wraps
	// for actual display (see its own CSS); this only defeats that briefly
	// to read the *unwrapped* intrinsic width. Per Hans (2026-09-20).
	getNaturalWidth() {
		this._container.style.flexWrap = "nowrap";
		const width = this._container.scrollWidth;
		this._container.style.flexWrap = "";
		return width;
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onXmlStoreChange);
		playerStore.addEventListener("change", this._onPlayerStoreChange);
		playerStore.addEventListener("variable-change", this._onVariableChange);
		document.addEventListener("keydown", this._onKeyDown);
		varMapMode.addEventListener("change", this._onVarMapModeChange);
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
		playerStore.removeEventListener("variable-change", this._onVariableChange);
		document.removeEventListener("keydown", this._onKeyDown);
		varMapMode.removeEventListener("change", this._onVarMapModeChange);
	}

	// Follows a variable set by *anything* (a Command type="set" shortcut,
	// wa-webcam-input.js's own mapped metrics, ...) — never just the knob's
	// own drag, which already updates itself directly. Per Hans (2026-09-23).
	// Never touches xmlStore — same "display only" rule as everything else
	// in this component (see the class comment).
	_onVariableChange({ detail: { name, value } }) {
		const scopeNode = this._getScopeNode();
		if (!scopeNode) return;
		const node = scopeNode.children.find((c) => c.tagName === "Var" && (c.attributes.name || c.attributes.id) === name);
		if (!node) return;
		const runtime = this._knobRuntime.get(node.id);
		if (!runtime) return;
		const clamped = Math.max(runtime.min, Math.min(runtime.max, value));
		this._values.set(node.id, clamped);
		runtime.applyVisual(clamped);
	}

	// Backspace/Delete removes the currently selected root-level <Var> —
	// same selectable/deletable treatment as everywhere else in the XML
	// editor, per Hans (2026-09-09). Only acts when the selection is
	// genuinely one of *this* component's own knobs, same guard
	// wa-player-bar.js's own Command deletion uses. defaultPrevented guard:
	// same reasoning as wa-player-bar.js's own (2026-09-10) — more than one
	// <wa-var-knobs> can be mounted at once now (Library (DEMO) view).
	_onKeyDown(e) {
		if (e.defaultPrevented) return;
		if (e.key !== "Backspace" && e.key !== "Delete") return;
		if (isEditableContext()) return;
		const selectedId = xmlStore.selectedNodeId;
		const scopeNode = this._getScopeNode();
		if (!selectedId || !scopeNode) return;
		const isOwnVar = scopeNode.children.some((c) => c.tagName === "Var" && c.id === selectedId);
		if (!isOwnVar) return;
		e.preventDefault();
		xmlStore.removeNode(selectedId);
	}

	// Re-pushes every knob's own current value the moment the graph
	// (re)loads — a <Var>'s Variable object always starts back at its XML
	// `default` on a fresh load (see waxml.js's Variable constructor), which
	// would otherwise silently discard whatever a user had already dialed in
	// here across a reload triggered by an unrelated structural edit.
	_onPlayerChange() {
		const isLoaded = playerStore.isDocumentLoaded;
		if (isLoaded && !this._wasDocumentLoaded) {
			const scopeNode = this._getScopeNode();
			this._values.forEach((value, nodeId) => {
				const node = scopeNode && findChild(scopeNode, nodeId);
				const varName = node && (node.attributes.name || node.attributes.id);
				if (varName) playerStore.setVariable(varName, value);
			});
		}
		this._wasDocumentLoaded = isLoaded;
	}

	_render() {
		this._container.innerHTML = "";
		this._knobRuntime.clear();
		const scopeNode = this._getScopeNode();
		const varNodes = scopeNode ? scopeNode.children.filter((c) => c.tagName === "Var") : [];
		this.hidden = varNodes.length === 0;

		const liveIds = new Set(varNodes.map((n) => n.id));
		[...this._values.keys()].forEach((id) => {
			if (!liveIds.has(id)) this._values.delete(id);
		});

		varNodes.forEach((node) => this._container.appendChild(this._buildKnob(node)));
	}

	_buildKnob(node) {
		const varName = node.attributes.name || node.attributes.id;

		const wrap = document.createElement("div");
		wrap.className = "var-knob-wrap";

		// The knob (with its ticks) and its value sit side by side now — the
		// name label is the only thing still below. Per Hans (2026-09-10).
		const row = document.createElement("div");
		row.className = "var-knob-row";
		wrap.appendChild(row);

		const knobAnchor = document.createElement("div");
		knobAnchor.className = "var-knob-anchor";
		knobAnchor.appendChild(this._buildTicks());
		row.appendChild(knobAnchor);

		const knob = document.createElement("div");
		knob.className = "var-knob";
		wrap.classList.toggle("selected", xmlStore.selectedNodeId === node.id);
		// Selecting this <Var> (so the XML tree/Code panel highlight it too —
		// see xmlStore.selectNode's existing sync) happens via a click
		// anywhere else in .var-knob-wrap (see the wrap-level listener at the
		// end of this method) — never on the knob itself, which is drag-only
		// territory. Per Hans (2026-09-30): selecting used to also fire on a
		// plain click-without-drag on the knob (2026-09-09/13 history), but
		// that made the knob's own click behavior ambiguous with its drag
		// gesture; stopping propagation here keeps the two fully separate.
		knob.addEventListener("click", (e) => e.stopPropagation());
		const dial = document.createElement("div");
		dial.className = "var-knob-dial";
		knob.appendChild(dial);
		knobAnchor.appendChild(knob);

		const valuesWrap = document.createElement("div");
		valuesWrap.className = "var-values";
		row.appendChild(valuesWrap);

		const valueLabel = document.createElement("div");
		valueLabel.className = "var-value var-value-input";
		valuesWrap.appendChild(valueLabel);

		const outputLabel = document.createElement("div");
		outputLabel.className = "var-value var-value-output";
		outputLabel.hidden = true;
		valuesWrap.appendChild(outputLabel);

		const nameRow = document.createElement("div");
		nameRow.className = "var-name-row";
		wrap.appendChild(nameRow);

		const nameLabel = document.createElement("div");
		nameLabel.className = "var-name";
		nameLabel.textContent = varName || "(no name)";
		nameRow.appendChild(nameLabel);

		// Arms/disarms the shared var-map-mode singleton (see
		// js/state/var-map-mode.js) so wa-node-inspector.js's attribute rows
		// know a click on them right now means "wire to $varName". Clicking
		// Map again while already armed for *this* var disarms it — the
		// module itself treats re-arming the same var as a no-op, so the
		// toggle direction has to be decided here. Per Hans (2026-09-27).
		const mapBtn = document.createElement("button");
		mapBtn.type = "button";
		mapBtn.className = "map-btn";
		mapBtn.textContent = "Map...";
		mapBtn.hidden = !varName;
		mapBtn.classList.toggle("armed", varMapMode.armed && varMapMode.varName === varName);
		mapBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (varMapMode.armed && varMapMode.varName === varName) {
				varMapMode.disarm();
			} else {
				varMapMode.arm(varName);
			}
		});
		nameRow.appendChild(mapBtn);

		if (!varName) {
			// No "name" (nor a fallback "id") to call setVariable() with —
			// nothing this knob could meaningfully control.
			knob.classList.add("disabled");
			valueLabel.textContent = "—";
			knob.title = "This <Var> has no name/id attribute";
			return wrap;
		}

		const mapin = parseNumberList(node.attributes.mapin);
		const min = mapin.length ? Math.min(...mapin) : 0;
		const max = mapin.length ? Math.max(...mapin) : 1;
		const parsedDefault = parseFloat(node.attributes.default);
		const defaultValue = Number.isFinite(parsedDefault) ? Math.max(min, Math.min(max, parsedDefault)) : (min + max) / 2;

		if (!this._values.has(node.id)) this._values.set(node.id, defaultValue);
		const current = Math.max(min, Math.min(max, this._values.get(node.id)));
		this._values.set(node.id, current);

		const mapped = hasMapping(node);
		valueLabel.classList.toggle("mapped", mapped);
		outputLabel.hidden = !mapped;

		const applyVisual = (v) => {
			const t = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
			dial.style.transform = `rotate(${-135 + t * 270}deg)`;
			valueLabel.textContent = formatValue(v, max);
			let title = `${varName}: ${formatValue(v, max)}`;
			if (mapped) {
				const outValue = computeMappedValue(node, v);
				outputLabel.textContent = formatValue(outValue, Math.abs(outValue) || 1);
				title += ` -> ${formatValue(outValue, Math.abs(outValue) || 1)}`;
			}
			knob.title = title;
		};
		applyVisual(current);
		this._knobRuntime.set(node.id, { applyVisual, min, max });

		const commit = (v) => {
			this._values.set(node.id, v);
			applyVisual(v);
			playerStore.setVariable(varName, v);
		};

		wireKnobDrag(knob, {
			getStartValue: () => this._values.get(node.id),
			min,
			max,
			onChange: commit,
			defaultValue,
			pxPerRange: KNOB_PX_PER_RANGE
		});

		// Click anywhere in the box selects the node — except on the knob
		// itself (drag-only, see above) or on an element that already
		// handles its own click (the Map button stops propagation itself).
		// Per Hans (2026-09-30).
		wrap.addEventListener("click", () => xmlStore.selectNode(node.id));

		return wrap;
	}

	_buildTicks(count = 11) {
		const wrap = document.createElement("div");
		wrap.className = "var-knob-ticks";
		const outerSize = KNOB_SIZE + 10;
		wrap.style.width = `${outerSize}px`;
		wrap.style.height = `${outerSize}px`;
		wrap.style.left = `-5px`;
		wrap.style.top = `-5px`;
		const radius = KNOB_SIZE / 2 + 3;
		const center = outerSize / 2;
		for (let i = 0; i < count; i++) {
			const angleDeg = -135 + (i / (count - 1)) * 270;
			const angleRad = (angleDeg * Math.PI) / 180;
			const x = center + radius * Math.sin(angleRad);
			const y = center - radius * Math.cos(angleRad);
			const tick = document.createElement("div");
			tick.className = "var-knob-tick";
			tick.style.left = `${x}px`;
			tick.style.top = `${y}px`;
			tick.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
			wrap.appendChild(tick);
		}
		return wrap;
	}

}

function findChild(scopeNode, id) {
	return scopeNode.children.find((c) => c.id === id);
}

customElements.define("wa-var-knobs", WaVarKnobs);
