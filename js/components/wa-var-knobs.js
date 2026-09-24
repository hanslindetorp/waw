import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { isEditableContext } from "../project/edit-history.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { mapStage1, applyConvertFn } from "../xml-editor/var-mapper-math.js";
import { formatValue } from "../utils/number-format.js";
import { varMapMode } from "../state/var-map-mode.js";
import { inputMapMode } from "../state/input-map-mode.js";
import { wireKnobDrag } from "../utils/knob-drag.js";
import { variableNameFromValue, variablePropFromValue } from "../xml-editor/variable-references.js";
import { getLiveProperty } from "../waxml-integration/live-property.js";
import { pickVarSourceSuffix } from "./wa-var-source-popup.js";

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
		/* Faint yellow ring — the Map button's own armed state, and every
		   valid target (a root Var knob, for the other kind of Map mode —
		   see .var-knob-wrap.map-target-armed below) while either is armed.
		   Same "--waw-map-armed-anim"-driven keyframe param-binding.js's
		   own wireMapClaim (Chain view/Mixer knobs) and wa-node-inspector.js
		   (attribute rows) already use for their own targets — declared
		   again here since a keyframe name is resolved within whichever
		   shadow root's own stylesheet references it, never shared across
		   shadow boundaries. Per Hans (2026-10-03): "likadan gul ram" on the
		   button as on every target it can bind to, replacing the old plain
		   opacity blink (2026-09-27).
		   .map-btn.armed uses the same box-shadow ring, unconditionally
		   (not gated behind the custom property) — a plain infinite
		   animation is enough since this button only ever renders while
		   varMapMode is actually armed for this exact Var. */
		@keyframes target-armed-blink {
			0%,
			100% {
				box-shadow: 0 0 0 0 rgba(250, 204, 21, 0);
			}
			50% {
				box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.55);
			}
		}
		.map-btn.armed {
			border-style: solid;
			border-color: #facc15;
			color: #facc15;
			animation: target-armed-blink 0.9s ease-in-out infinite;
		}
		/* Every OTHER root Var knob is a valid target while either Map mode
		   is armed — mapping this Var to another Var's output (varMapMode,
		   see _buildKnob's own claim logic), or mapping an INPUT entry onto
		   a Var (inputMapMode, root-scope only — see wa-webcam-input.js).
		   Toggled directly in _buildKnob (this component already fully
		   re-renders on either mode's own "change" event), not via the
		   inherited-custom-property trick the cross-shadow-root targets
		   elsewhere need.
		   Its own dedicated keyframe (border-color, not just a box-shadow
		   ring) — per Hans (2026-10-05): "blinket ... ska inte vara på
		   deras map-knapp ... utan hela ramen kring <Var> button (den som
		   blir blå när man markerar)" — matching .var-knob-wrap.selected's
		   own border-color treatment below (blue there, yellow+blinking
		   here) makes it unambiguous this is the SAME box, not the little
		   "Map..." button inside it. */
		@keyframes target-armed-blink-wrap {
			0%,
			100% {
				border-color: var(--waw-border, #2f2f2f);
				box-shadow: 0 0 0 0 rgba(250, 204, 21, 0);
			}
			50% {
				border-color: #facc15;
				box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.55);
			}
		}
		.var-knob-wrap.map-target-armed {
			animation: target-armed-blink-wrap 0.9s ease-in-out infinite;
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
		/* This Var's own "value" is a "$otherVar" reference (see
		   _buildKnob) — same "don't fight the live value" blue ring every
		   other remote-controlled knob/fader in the app already uses
		   (wa-mixer-view.js's own .remote-controlled). Dragging is skipped
		   entirely for this knob; _pollRemoteControlled keeps its dial
		   honest instead. Per Hans (2026-10-03): "Det ska gå att mappa en
		   variabel till en annan... slava till sin target <Var>s
		   outputvärde." */
		.var-knob.remote-controlled {
			cursor: default;
			box-shadow: 0 0 0 2px rgba(120, 170, 255, 0.6), 0 1px 2px rgba(0, 0, 0, 0.6);
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
		// Same reasoning, for the OTHER mapping direction (an INPUT entry
		// onto a root Var — see wa-webcam-input.js/input-map-mode.js): every
		// root knob's own ".map-target-armed" highlight is recomputed fresh
		// in _buildKnob on every render, so a full re-render here is enough,
		// same as _onVarMapModeChange. Per Hans (2026-10-03).
		this._onInputMapModeChange = () => this._render();
		// Shared rAF loop for every currently-visible knob whose own "value"
		// slaves off another Var (see _buildKnob's own slavedToName) — same
		// "one shared timer, only runs while something actually needs it"
		// shape as wa-chain-view.js's own _ensureLiveLoop, just without that
		// file's AnalyserNode half (nothing here needs it). Each tick reads
		// the target Var's live "mappedValue" and pushes it through
		// playerStore.setVariable() — the existing _onVariableChange
		// listener below picks that up and updates the dial for free, same
		// as any other setVariable() caller.
		this._activeRemoteControlTicks = new Set();
		this._liveLoopId = null;
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
		inputMapMode.addEventListener("change", this._onInputMapModeChange);
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
		playerStore.removeEventListener("variable-change", this._onVariableChange);
		document.removeEventListener("keydown", this._onKeyDown);
		varMapMode.removeEventListener("change", this._onVarMapModeChange);
		inputMapMode.removeEventListener("change", this._onInputMapModeChange);
		this._stopLiveLoop();
	}

	// Shared rAF loop — see the constructor's own comment on
	// _activeRemoteControlTicks. Mirrors wa-chain-view.js's own
	// _ensureLiveLoop/_stopLiveLoop shape exactly.
	_ensureLiveLoop() {
		if (this._liveLoopId !== null) return;
		const loop = () => {
			this._liveLoopId = requestAnimationFrame(loop);
			if (this._activeRemoteControlTicks.size === 0) {
				this._stopLiveLoop();
				return;
			}
			this._activeRemoteControlTicks.forEach((tick) => tick());
		};
		this._liveLoopId = requestAnimationFrame(loop);
	}

	_stopLiveLoop() {
		if (this._liveLoopId !== null) {
			cancelAnimationFrame(this._liveLoopId);
			this._liveLoopId = null;
		}
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
		// Every knob gets rebuilt fresh below — drop the old tick callbacks
		// so the shared loop (see _ensureLiveLoop) never calls into a knob
		// that's no longer in the DOM. Re-populated by _buildKnob as it runs.
		this._activeRemoteControlTicks = new Set();
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

		// Every OTHER root Var is a valid target while varMapMode is armed
		// (map this Var to become a slave of the one you click — see the
		// wrap click listener below), and — root scope only, per Hans
		// (2026-10-03): "target kan bara vara ett <Var>-element / knob i
		// rooten" — every root Var is also a valid target while
		// inputMapMode is armed (an INPUT entry being mapped, see
		// wa-webcam-input.js). Recomputed fresh on every render, which both
		// modes already trigger via their own "change" listeners
		// (_onVarMapModeChange/_onInputMapModeChange).
		const isVarMapTarget = varMapMode.armed && varMapMode.varName !== varName;
		const isInputMapTarget = this._scopeNodeId === null && inputMapMode.armed;
		wrap.classList.toggle("map-target-armed", isVarMapTarget || isInputMapTarget);

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

		// This Var's own "value" is itself a "$otherVar.mappedValue"
		// reference — i.e. it was mapped to another Var via the wrap click
		// listener below (see _claimVarToVarMapping). waxml.js's own
		// generic per-attribute $-reference resolution (the mechanism every
		// *other* "$name"-controlled attribute in this app already relies
		// on) turns out not to actually reach a <Var>'s own "value" live —
		// verified live (2026-10-03): the generic Watcher it wraps `value`
		// in calls `xmlNode.obj.setTargetAtTime(...)`, which Variable
		// objects don't have, so the callback silently no-ops. Rather than
		// touch waxml.js (never edited from here), this drives the slaving
		// entirely from our own side instead: every tick, read the TARGET
		// Var's live "mappedValue" (its fully computed output, post
		// mapin/mapout/curve/pattern/convert) and push it through
		// playerStore.setVariable() — the exact same call a knob drag
		// already uses, so the existing _onVariableChange listener picks it
		// up and updates this dial for free, no separate apply-visual path
		// needed here. Dragging is skipped entirely while slaved, same
		// "don't fight the live value" lock every other $var-controlled
		// knob/fader in the app already uses.
		const slavedToName = variableNameFromValue(node.attributes.value)?.split(".")[0];
		if (slavedToName) {
			knob.classList.add("remote-controlled");
			// The referenced name is either a real root <Var> (claimed via
			// _claimVarToVarMapping — reads its live Variable property,
			// suffix included) or a synthetic, non-XML name with no matching
			// <Var> at all — e.g. "rightHand8x", written by
			// wa-webcam-input.js's own _writeVarReference. Per Hans
			// (2026-10-05): "webcam ska köra waxml.set('rightHand8x', value)
			// och var1 ska slava till webcam precis som tidigare" — that
			// raw value lives only in waxml.js's own InteractionManager
			// fallback store (see playerStore.getVariable), never a
			// Variable instance, so it has no speed/derivative properties —
			// only the plain value itself is ever meaningful there.
			const slavedToNode = this._findVarByName(slavedToName);
			const slavedProp = variablePropFromValue(node.attributes.value);
			const pushFromTarget = () => {
				const live = slavedToNode ? getLiveProperty(slavedToNode.attributes.id, slavedProp) : playerStore.getVariable(slavedToName);
				if (Number.isFinite(live)) playerStore.setVariable(varName, live);
			};
			this._activeRemoteControlTicks.add(pushFromTarget);
			this._ensureLiveLoop();
		} else {
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
		}

		// Click anywhere in the box either claims this Var as a mapping
		// target (while either Map mode is armed — see above for which
		// knobs qualify) or, the normal case, selects the node — except on
		// the knob itself (drag-only, see above) or on an element that
		// already handles its own click (the Map button stops propagation
		// itself). Per Hans (2026-09-30 / 2026-10-03).
		wrap.addEventListener("click", (e) => {
			if (isVarMapTarget) {
				e.stopPropagation();
				// Measure BEFORE disarming — disarm() dispatches varMapMode's own
				// "change" synchronously, which this component listens for and
				// re-renders on, tearing down and rebuilding `wrap`. Measuring
				// after that point read a detached element's rect (all zeros),
				// which is why the popup opened pinned to the viewport's own
				// top-left corner instead of near the click. Bug per Hans
				// (2026-10-05).
				const anchorRect = wrap.getBoundingClientRect();
				const armedVarName = varMapMode.varName;
				varMapMode.disarm();
				this._claimVarToVarMapping(armedVarName, node, anchorRect);
				return;
			}
			if (isInputMapTarget) {
				e.stopPropagation();
				inputMapMode.pick(varName);
				return;
			}
			xmlStore.selectNode(node.id);
		});

		return wrap;
	}

	// Makes `targetNode` (the Var just clicked while armed) slave to the
	// ARMED Var's own OUTPUT value — the SAME direction every other
	// varMapMode claim site (param-binding.js's wireMapClaim,
	// wa-node-inspector.js's attribute rows) already uses: the armed Var's
	// name gets written INTO whatever gets clicked. Per Hans (2026-10-05
	// correction — the original 2026-10-03 version had this backwards):
	// "1. klicka på var2 -> map. 2. klicka på var1. -> nu ska var1 ha
	// value=$var2." This string is only ever read back by _buildKnob's own
	// slavedToName/slavedProp — not by waxml.js itself (a <Var>'s own
	// "value" attribute doesn't reach a live Watcher, see _buildKnob's own
	// comment on that).
	//
	// The popup (wa-var-source-popup.js) offers a choice of which of the
	// ARMED Var's own live signals to reference — its plain value/speed/
	// derivative(s), same as every other claim site. "value" (bare "$name",
	// no suffix) resolves to mappedValue via Variable's own value getter.
	_claimVarToVarMapping(armedVarName, targetNode, anchorRect) {
		pickVarSourceSuffix(anchorRect, armedVarName).then((suffix) => {
			if (suffix === null) return;
			const patch = { ...targetNode.attributes, value: `$${armedVarName}${suffix}` };
			// speed/derivative(2/3) are waxml.js's own frame-to-frame delta of
			// mappedValue — naturally tiny numbers (found live, 2026-10-04:
			// ~0.03-0.06 for an ordinary continuous drag) that a plain 0-1
			// mapin would barely register. Per Hans: switch the TARGET
			// (slaved) Var's own mapin to "auto" whenever one of these is
			// picked, which turns on waxml.js's existing autoInputRange (see
			// Variable's own constructor: `params.mapin == "auto"`) — it
			// rescales whatever raw range it actually observes into mapout's
			// own range instead of a hand-picked one. Never touched for the
			// plain "value" pick (suffix === ""), which is already full-range.
			if (suffix !== "") patch.mapin = "auto";
			xmlStore.updateAttributes(targetNode.id, patch);
		});
	}

	// Same flat "search the whole document by name" the rest of the app
	// already assumes for $-references (varMapMode.arm() itself only ever
	// carries a bare name, not a node id — see its own comment) — the armed
	// Var could be from either this instance's row or the other one
	// (global/local), so scope isn't known here either way.
	_findVarByName(name) {
		if (!xmlStore.root || !name) return null;
		const walk = (node) => {
			if (node.tagName === "Var" && (node.attributes.name || node.attributes.id) === name) return node;
			for (const child of node.children) {
				const found = walk(child);
				if (found) return found;
			}
			return null;
		};
		return walk(xmlStore.root);
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
