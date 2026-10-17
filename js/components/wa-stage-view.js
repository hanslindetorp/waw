import { xmlStore } from "../xml-editor/xml-store.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { stageStore, STAGE_WIDTH, STAGE_MIN_HEIGHT, STAGE_INPUT_DRAG_TYPE } from "../project/stage-store.js";
import { inputSources } from "../state/input-sources.js";
import { isEditableContext } from "../project/edit-history.js";
import { showNotice } from "./wa-notice-dialog.js";
import { confirmDialog } from "./wa-confirm-dialog.js";
import { assessmentStore } from "../project/assessment-store.js";
import { runAssessment } from "../assessment/run.js";
import { showAssessmentResult } from "./wa-assessment-result.js";
import "./wa-assessment-editor.js";
import "./wa-var-knobs.js";
import { CARD_ATTRIBUTES } from "./wa-chain-view.js";

// The Stage panel: a flat page (see project/stage-store.js) with headings,
// instructions and chosen objects from the audio graph at x/y positions on a
// fixed-size scene that scales to fit the panel. Built to be reused as-is by
// the stripped-down viewer page: `readonly` shows the same Stage without any
// of the editing aids.
//
// A project can have several views (tabs along the top); the editor shows
// whichever is open. `view-id` pins an instance to one view and turns the
// editing aids off — that is how the viewer page shows a single view.
//
// Editing: drag an element/Command/Var from the XML tree — or the "add to
// Stage" handle of a Preview card — onto the scene (a Chain adds its
// elements side by side), "+ Heading"/"+ Text" for the words,
// drag an item by its grip to move it, its right edge to widen it, double-click
// a heading/text to edit it, Backspace removes the selected item. The items'
// own controls stay live, so the author can try them out.

const MAX_SCALE = 1.5;
const STAGE_BOTTOM_MARGIN = 40;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		.toolbar {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.4rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex-wrap: wrap;
		}
		:host([readonly]) .toolbar {
			display: none;
		}
		.toolbar button {
			font: inherit;
			font-size: 0.72rem;
			background: #2a2a2a;
			color: inherit;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.2rem 0.5rem;
			cursor: pointer;
		}
		.toolbar button:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.toolbar .spacer {
			flex: 1 1 auto;
		}
		.toolbar button.active {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.drawer {
			flex: 0 0 auto;
			max-height: 55%;
			overflow: auto;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
		}
		.drawer[hidden],
		:host([readonly]) .drawer {
			display: none;
		}
		.toolbar .hint {
			font-size: 0.66rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.tabs {
			flex: 0 0 auto;
			display: flex;
			align-items: flex-end;
			gap: 2px;
			padding: 0.3rem 0.6rem 0;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			overflow-x: auto;
		}
		:host([readonly]) .tabs {
			display: none;
		}
		.tab {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			max-width: 14rem;
			font: inherit;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			background: transparent;
			border: 1px solid transparent;
			border-bottom: none;
			border-radius: 5px 5px 0 0;
			padding: 0.25rem 0.55rem;
			cursor: pointer;
			white-space: nowrap;
		}
		.tab:hover {
			color: var(--waw-fg, #e8e8e8);
		}
		.tab.active {
			color: var(--waw-fg, #e8e8e8);
			background: #202327;
			border-color: var(--waw-border, #2f2f2f);
			margin-bottom: -1px;
		}
		.tab .tab-name {
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tab .tab-action {
			opacity: 0.6;
			padding: 0 0.15rem;
		}
		.tab .tab-action:hover {
			opacity: 1;
		}
		.tab-rename {
			font: inherit;
			font-size: 0.72rem;
			width: 9rem;
			background: #101010;
			color: inherit;
			border: 1px solid var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			padding: 0 0.2rem;
		}
		.tab-add {
			font: inherit;
			color: var(--waw-muted, #8a8a8a);
			background: none;
			border: none;
			padding: 0.25rem 0.5rem;
			cursor: pointer;
		}
		.tab-add:hover {
			color: var(--waw-accent, #4fa3ff);
		}
		/* What the viewer of the selected element may change (see item.editable). */
		.item-settings {
			flex: 0 0 auto;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.3rem 0.9rem;
			padding: 0.35rem 0.6rem;
			font-size: 0.72rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			background: rgba(79, 163, 255, 0.06);
		}
		.item-settings[hidden],
		:host([readonly]) .item-settings {
			display: none;
		}
		.item-settings label {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			cursor: pointer;
		}
		.item-settings .settings-hint {
			color: var(--waw-muted, #8a8a8a);
		}
		.viewport {
			flex: 1 1 auto;
			min-height: 0;
			overflow: auto;
		}
		.scaler {
			position: relative;
			margin: 0 auto;
		}
		.stage {
			position: absolute;
			left: 0;
			top: 0;
			width: ${STAGE_WIDTH}px;
			transform-origin: 0 0;
			background: #202327;
			outline: 1px solid var(--waw-border, #2f2f2f);
		}
		:host([readonly]) .stage {
			background: transparent;
			outline: none;
		}
		.stage.drop-active {
			outline: 2px solid var(--waw-accent, #4fa3ff);
		}
		.item {
			position: absolute;
			box-sizing: border-box;
		}
		:host(:not([readonly])) .item:hover,
		.item.selected {
			outline: 1px dashed rgba(79, 163, 255, 0.6);
			outline-offset: 3px;
		}
		.item.selected {
			outline-style: solid;
			outline-color: var(--waw-accent, #4fa3ff);
		}
		.grip {
			position: absolute;
			left: 0;
			right: 0;
			top: -17px;
			height: 14px;
			display: none;
			align-items: center;
			justify-content: space-between;
			padding: 0 3px;
			background: rgba(79, 163, 255, 0.85);
			border-radius: 3px 3px 0 0;
			color: #fff;
			font-size: 0.6rem;
			cursor: move;
			touch-action: none;
			user-select: none;
			z-index: 2;
		}
		:host(:not([readonly])) .item:hover > .grip,
		:host(:not([readonly])) .item.selected > .grip {
			display: flex;
		}
		.grip .remove {
			cursor: pointer;
			padding: 0 0.2rem;
		}
		.resize {
			position: absolute;
			right: -6px;
			top: 0;
			bottom: 0;
			width: 8px;
			display: none;
			cursor: ew-resize;
			touch-action: none;
			z-index: 2;
		}
		:host(:not([readonly])) .item:hover > .resize,
		:host(:not([readonly])) .item.selected > .resize {
			display: block;
		}
		.resize::after {
			content: "";
			position: absolute;
			left: 3px;
			top: 25%;
			bottom: 25%;
			width: 2px;
			border-radius: 1px;
			background: var(--waw-accent, #4fa3ff);
		}
		.heading {
			margin: 0;
			font-size: 1.5rem;
			font-weight: 600;
			line-height: 1.25;
			white-space: pre-wrap;
		}
		.text {
			margin: 0;
			font-size: 1rem;
			line-height: 1.5;
			color: #cdd3d8;
			white-space: pre-wrap;
		}
		.heading.empty,
		.text.empty {
			color: var(--waw-muted, #8a8a8a);
			font-style: italic;
		}
		[contenteditable] {
			outline: 1px solid var(--waw-accent, #4fa3ff);
			outline-offset: 2px;
		}
		.command-btn {
			display: inline-flex;
			align-items: center;
			gap: 0.4rem;
			height: 32px;
			max-width: 100%;
			background: linear-gradient(180deg, #383c42, #1d1f22 80%);
			border: 1px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);
			color: inherit;
			border-radius: 6px;
			padding: 0 0.8rem;
			font: inherit;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.command-btn:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.command-btn.blink {
			animation: blink 0.25s ease-out;
		}
		@keyframes blink {
			0% { background: var(--waw-accent, #4fa3ff); }
			100% { background: linear-gradient(180deg, #383c42, #1d1f22 80%); }
		}
		.command-btn .glyph {
			font-size: 0.7rem;
			opacity: 0.75;
		}
		.command-btn .glyph.set { color: var(--waw-teal, #45b58c); }
		.command-btn .glyph.stop { color: var(--waw-danger, #e5484d); }
		.input-card {
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-left: 4px solid var(--entry-color, #4fa3ff);
			border-radius: 6px;
			padding: 0.5rem 0.65rem;
		}
		.input-head {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 0.5rem;
			font-size: 0.75rem;
		}
		.input-head .input-title {
			font-weight: 600;
			color: #cdd3d8;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.input-head .input-tag {
			flex: 0 0 auto;
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.input-bar {
			height: 8px;
			margin: 0.45rem 0;
			background: #101010;
			border-radius: 4px;
			overflow: hidden;
		}
		.input-bar .input-fill {
			height: 100%;
			width: 0%;
			background: var(--entry-color, #4fa3ff);
		}
		.input-start {
			font: inherit;
			font-size: 0.75rem;
			background: linear-gradient(180deg, #383c42, #1d1f22 80%);
			color: inherit;
			border: 1px solid #0b0c0d;
			border-radius: 5px;
			padding: 0.25rem 0.7rem;
			cursor: pointer;
		}
		.input-start:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.input-start.running {
			border-color: var(--waw-teal, #45b58c);
		}
		.input-status {
			margin-top: 0.3rem;
			font-size: 0.66rem;
			color: var(--waw-danger, #e5484d);
		}
		.missing {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.7rem;
			font-style: italic;
		}
		.empty-hint {
			position: absolute;
			left: 0;
			right: 0;
			top: 40%;
			text-align: center;
			color: var(--waw-muted, #8a8a8a);
			pointer-events: none;
			padding: 0 2rem;
		}
	</style>
	<div class="toolbar">
		<button type="button" data-add="heading">+ Heading</button>
		<button type="button" data-add="text">+ Instruction</button>
		<span class="hint">Drag elements, Commands and Vars here from the XML tree.</span>
		<span class="spacer"></span>
		<button type="button" data-assess="toggle" title="How this view is assessed">Assessment</button>
		<button type="button" data-assess="test" title="Try the assessment on the page as it is now">Test run</button>
	</div>
	<div class="tabs"></div>
	<div class="item-settings" hidden></div>
	<div class="viewport">
		<div class="scaler"><div class="stage"></div></div>
	</div>
	<div class="drawer" hidden><wa-assessment-editor></wa-assessment-editor></div>
`;

export class WaStageView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._tabs = this.shadowRoot.querySelector(".tabs");
		this._itemSettings = this.shadowRoot.querySelector(".item-settings");
		this._drawer = this.shadowRoot.querySelector(".drawer");
		this._assessmentEditor = this.shadowRoot.querySelector("wa-assessment-editor");
		this._viewport = this.shadowRoot.querySelector(".viewport");
		this._scaler = this.shadowRoot.querySelector(".scaler");
		this._stage = this.shadowRoot.querySelector(".stage");
		this._scale = 1;
		this._selectedId = null;
		this._editingId = null;
		this._onChange = () => this._render();
		// Embedded cards and knobs follow the document themselves; the Stage
		// only has to be rebuilt when what its items refer to appears,
		// disappears or (for a Command's button) changes — never on every
		// value dragged in a card, which would tear that card down mid-drag.
		this._lastRefSignature = null;
		this._onXmlChange = () => {
			const signature = this._refSignature();
			if (signature === this._lastRefSignature) return;
			this._render();
		};
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onDocPointerDown = (e) => {
			if (!e.composedPath().includes(this)) this._select(null);
		};
		this._inputTickId = null;
		this._wiredSource = null;
		this._onSourceEvent = () => this._render();
		this._onSourcesChange = () => {
			this._wireSource();
			this._render();
		};
		this._resizeObserver = new ResizeObserver(() => this._fit());
		this._itemObserver = new ResizeObserver(() => this._fitHeight());
	}

	// Pinned to one view (the viewer page): that view only, nothing editable.
	static get observedAttributes() {
		return ["view-id"];
	}

	attributeChangedCallback() {
		// A view-pinned instance is read-only: the `readonly` attribute is what
		// the styles key on.
		if (this.viewId) this.setAttribute("readonly", "");
		if (this.isConnected) this._render();
	}

	get viewId() {
		return this.getAttribute("view-id") || null;
	}

	get readonly() {
		return this.hasAttribute("readonly") || !!this.viewId;
	}

	// The view being shown: the pinned one, or the editor's current one.
	_shownView() {
		return this.viewId ? stageStore.getView(this.viewId) : stageStore.currentView;
	}

	connectedCallback() {
		stageStore.addEventListener("change", this._onChange);
		xmlStore.addEventListener("change", this._onXmlChange);
		document.addEventListener("keydown", this._onKeyDown);
		document.addEventListener("pointerdown", this._onDocPointerDown, true);
		inputSources.addEventListener("change", this._onSourcesChange);
		this._wireSource();
		this._resizeObserver.observe(this._viewport);

		const toggle = this.shadowRoot.querySelector('[data-assess="toggle"]');
		toggle.addEventListener("click", () => {
			this._drawer.hidden = !this._drawer.hidden;
			toggle.classList.toggle("active", !this._drawer.hidden);
			this._fit();
		});
		this.shadowRoot.querySelector('[data-assess="test"]').addEventListener("click", () => {
			const run = runAssessment(stageStore.currentViewId);
			if (!run) {
				showNotice("This view is not assessed. Open Assessment and tick the box first.");
				return;
			}
			showAssessmentResult(run.result, run.assessment);
		});

		this.shadowRoot.querySelectorAll("[data-add]").forEach((btn) =>
			btn.addEventListener("click", () => {
				const type = btn.dataset.add;
				const item = stageStore.addItem(type, { y: stageStore.nextFreeY(), text: type === "heading" ? "Heading" : "Write the instruction here." });
				this._select(item.id);
			})
		);

		// Drop target for elements dragged from the XML tree (see wa-xml-tree.js:
		// the dragged node's tree id travels as text/plain).
		this._stage.addEventListener("dragover", (e) => {
			if (this.readonly || !(this._draggedInput(e) || this._draggedNodeId(e))) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move"; // the tree starts its drags as "move"
			this._stage.classList.add("drop-active");
		});
		this._stage.addEventListener("dragleave", (e) => {
			if (!this._stage.contains(e.relatedTarget)) this._stage.classList.remove("drop-active");
		});
		this._stage.addEventListener("drop", (e) => {
			this._stage.classList.remove("drop-active");
			const input = this._draggedInput(e);
			if (input && !this.readonly) {
				e.preventDefault();
				const rect = this._stage.getBoundingClientRect();
				const item = stageStore.addInput(input.source, input.entryId, { x: (e.clientX - rect.left) / this._scale, y: (e.clientY - rect.top) / this._scale });
				this._select(item.id);
				return;
			}
			const nodeId = this._draggedNodeId(e);
			if (this.readonly || !nodeId) return;
			e.preventDefault();
			const rect = this._stage.getBoundingClientRect();
			this._dropNode(nodeId, (e.clientX - rect.left) / this._scale, (e.clientY - rect.top) / this._scale);
		});

		this._render();
	}

	disconnectedCallback() {
		stageStore.removeEventListener("change", this._onChange);
		xmlStore.removeEventListener("change", this._onXmlChange);
		document.removeEventListener("keydown", this._onKeyDown);
		document.removeEventListener("pointerdown", this._onDocPointerDown, true);
		inputSources.removeEventListener("change", this._onSourcesChange);
		this._unwireSource();
		this._stopInputTick();
		this._resizeObserver.disconnect();
		this._itemObserver.disconnect();
	}

	// An input row dragged from the INPUT panel (during dragover the payload
	// can't be read, only its type seen).
	_draggedInput(e) {
		const types = [...(e.dataTransfer?.types || [])];
		if (!types.includes(STAGE_INPUT_DRAG_TYPE)) return null;
		if (e.type === "dragover") return { source: "?", entryId: null };
		try {
			const data = JSON.parse(e.dataTransfer.getData(STAGE_INPUT_DRAG_TYPE));
			return data && typeof data.source === "string" ? data : null;
		} catch {
			return null;
		}
	}

	// ── Input sources (the camera) ────────────────────────────────────────
	_wireSource() {
		const webcam = inputSources.get("webcam");
		if (webcam === this._wiredSource) return;
		this._unwireSource();
		this._wiredSource = webcam;
		webcam?.addEventListener("state-change", this._onSourceEvent);
		webcam?.addEventListener("run-change", this._onSourceEvent);
	}

	_unwireSource() {
		this._wiredSource?.removeEventListener("state-change", this._onSourceEvent);
		this._wiredSource?.removeEventListener("run-change", this._onSourceEvent);
		this._wiredSource = null;
	}

	_ensureInputTick() {
		if (this._inputTickId !== null) return;
		const tick = () => {
			this._inputTickId = requestAnimationFrame(tick);
			const source = inputSources.get("webcam");
			this._stage.querySelectorAll(".input-card[data-entry]").forEach((card) => {
				const norm = source?.getEntryNorm(Number(card.dataset.entry));
				card.querySelector(".input-fill").style.width = norm === undefined ? "0%" : `${Math.round(norm * 100)}%`;
			});
		};
		this._inputTickId = requestAnimationFrame(tick);
	}

	_stopInputTick() {
		if (this._inputTickId !== null) cancelAnimationFrame(this._inputTickId);
		this._inputTickId = null;
	}

	// ── Dropping from the tree ────────────────────────────────────────────
	_draggedNodeId(e) {
		const types = [...(e.dataTransfer?.types || [])];
		if (!types.includes("text/plain") || types.includes("Files")) return null;
		const id = e.dataTransfer.getData("text/plain");
		// getData is empty during dragover in most browsers: accept any plain
		// text drag then, and verify on drop.
		if (!id) return e.type === "dragover" ? "?" : null;
		return xmlStore.root && findNodeById(xmlStore.root, id) ? id : null;
	}

	_dropNode(nodeId, x, y) {
		const node = findNodeById(xmlStore.root, nodeId);
		if (!node) return;
		const result = stageStore.addNode(node, { x, y });
		if (result.error) {
			showNotice(result.error);
			return;
		}
		const last = result.items[result.items.length - 1];
		if (last) this._select(last.id);
	}

	// ── Selection / keyboard ──────────────────────────────────────────────
	_select(id) {
		if (this._selectedId === id) return;
		this._selectedId = id;
		this._stage.querySelectorAll(".item").forEach((el) => el.classList.toggle("selected", el.dataset.item === id));
		this._renderItemSettings();
	}

	// For a selected element: a tick box for each attribute it has a control for — the ones
	// ticked are what a viewer of the page may change; the rest is locked and not shown. An item
	// without a list at all (made before this existed) lets the viewer change everything.
	_renderItemSettings() {
		const bar = this._itemSettings;
		bar.innerHTML = "";
		const item = this._selectedId ? (this._shownView()?.items || []).find((i) => i.id === this._selectedId) : null;
		const node = item && item.type === "element" ? this._findByAttributeId(item.ref) : null;
		const attrs = node ? CARD_ATTRIBUTES[node.tagName] : null;
		if (this.readonly || !attrs) {
			bar.hidden = true;
			return;
		}
		bar.hidden = false;
		const title = document.createElement("span");
		title.textContent = "A viewer may change:";
		bar.appendChild(title);
		attrs.forEach((attr) => {
			const label = document.createElement("label");
			const box = document.createElement("input");
			box.type = "checkbox";
			box.checked = !Array.isArray(item.editable) || item.editable.includes(attr);
			box.addEventListener("change", () => {
				const current = Array.isArray(item.editable) ? item.editable : attrs;
				const next = box.checked ? [...new Set([...current, attr])] : current.filter((a) => a !== attr);
				stageStore.updateItem(item.id, { editable: attrs.filter((a) => next.includes(a)) });
			});
			label.append(box, document.createTextNode(attr));
			bar.appendChild(label);
		});
		const hint = document.createElement("span");
		hint.className = "settings-hint";
		hint.textContent = "Unticked = locked and hidden.";
		bar.appendChild(hint);
	}

	_onKeyDown(e) {
		if (this.readonly || e.defaultPrevented) return;
		if (e.key !== "Backspace" && e.key !== "Delete") return;
		if (!this._selectedId || this._editingId || isEditableContext()) return;
		if (!this.getClientRects().length) return;
		e.preventDefault();
		const id = this._selectedId;
		this._selectedId = null;
		stageStore.removeItem(id);
	}

	// ── Layout ────────────────────────────────────────────────────────────
	_fit() {
		const available = this._viewport.clientWidth;
		if (!available) return;
		this._scale = Math.min(MAX_SCALE, available / STAGE_WIDTH);
		this._stage.style.transform = `scale(${this._scale})`;
		this._scaler.style.width = `${STAGE_WIDTH * this._scale}px`;
		this._fitHeight();
	}

	_fitHeight() {
		let bottom = STAGE_MIN_HEIGHT;
		this._stage.querySelectorAll(".item").forEach((el) => {
			bottom = Math.max(bottom, el.offsetTop + el.offsetHeight + STAGE_BOTTOM_MARGIN);
		});
		this._stage.style.height = `${bottom}px`;
		this._scaler.style.height = `${bottom * this._scale}px`;
	}

	// ── Rendering ─────────────────────────────────────────────────────────
	_refSignature() {
		return (this._shownView()?.items || [])
			.map((item) => {
				if (item.type === "command") {
					const c = this._findByAttributeId(item.ref, "Command");
					return c ? JSON.stringify([c.attributes.type, c.attributes.label, c.attributes.value, c.attributes.variable]) : "-";
				}
				if (item.type === "input") {
					const source = inputSources.get(item.source);
					const row = source?.getEntrySummaries().find((r) => r.id === item.ref);
					return JSON.stringify([!!source, row ?? null, source?.running]);
				}
				if (item.type === "var" || item.type === "element") {
					const n = this._findByAttributeId(item.ref);
					return n ? n.tagName : "-";
				}
				return "";
			})
			.join("|");
	}

	_render() {
		if (this._editingId) return; // never tear down a text being typed
		this._lastRefSignature = this._refSignature();
		this._itemObserver.disconnect();
		this._renderTabs();
		this._renderItemSettings();
		if (!this.readonly) this._assessmentEditor.setViewId(stageStore.currentViewId);
		this._stage.innerHTML = "";
		const view = this._shownView();
		if (!view) {
			const msg = document.createElement("div");
			msg.className = "empty-hint";
			msg.textContent = "This view does not exist.";
			this._stage.appendChild(msg);
			this._fit();
			return;
		}
		const items = view.items;
		items.forEach((item) => this._stage.appendChild(this._buildItem(item)));
		if (!items.length) {
			const hint = document.createElement("div");
			hint.className = "empty-hint";
			hint.textContent = this.readonly ? "" : "The Stage is empty. Drag elements here from the XML tree, or add a heading and an instruction.";
			this._stage.appendChild(hint);
		}
		this._stage.querySelectorAll(".item").forEach((el) => this._itemObserver.observe(el));
		if (items.some((i) => i.type === "input")) this._ensureInputTick();
		else this._stopInputTick();
		this._fit();
	}

	_renderTabs() {
		this._tabs.innerHTML = "";
		if (this.readonly) return;
		const views = stageStore.views;
		const currentId = stageStore.currentViewId;
		views.forEach((view) => {
			const tab = document.createElement("div");
			tab.className = "tab" + (view.id === currentId ? " active" : "");
			tab.title = "Double-click to rename";
			const name = document.createElement("span");
			name.className = "tab-name";
			name.textContent = view.name;
			tab.appendChild(name);
			tab.addEventListener("click", () => {
				this._select(null);
				stageStore.setCurrentView(view.id);
			});
			tab.addEventListener("dblclick", () => this._renameTab(name, view));
			if (view.id === currentId) {
				const dup = document.createElement("span");
				dup.className = "tab-action";
				dup.textContent = "⧉";
				dup.title = "Duplicate this view";
				dup.addEventListener("click", (e) => {
					e.stopPropagation();
					const copy = stageStore.duplicateView(view.id);
					if (copy) assessmentStore.copy(view.id, copy.id);
				});
				tab.appendChild(dup);
				if (views.length > 1) {
					const del = document.createElement("span");
					del.className = "tab-action";
					del.textContent = "×";
					del.title = "Delete this view";
					del.addEventListener("click", async (e) => {
						e.stopPropagation();
						if (await confirmDialog(`Delete the view "${view.name}", with everything placed on it and how it is assessed?`)) {
							if (stageStore.removeView(view.id)) assessmentStore.remove(view.id);
						}
					});
					tab.appendChild(del);
				}
			}
			this._tabs.appendChild(tab);
		});
		const add = document.createElement("button");
		add.type = "button";
		add.className = "tab-add";
		add.textContent = "+";
		add.title = "New view";
		add.addEventListener("click", () => {
			this._select(null);
			stageStore.addView(`View ${stageStore.views.length + 1}`);
		});
		this._tabs.appendChild(add);
	}

	_renameTab(nameEl, view) {
		const input = document.createElement("input");
		input.className = "tab-rename";
		input.value = view.name;
		nameEl.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		const finish = (commit) => {
			if (done) return;
			done = true;
			const value = input.value.trim();
			if (commit && value && value !== view.name) stageStore.renameView(view.id, value);
			else this._renderTabs();
		};
		input.addEventListener("blur", () => finish(true));
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") finish(true);
			else if (e.key === "Escape") finish(false);
		});
		input.addEventListener("click", (e) => e.stopPropagation());
	}

	_buildItem(item) {
		const el = document.createElement("div");
		el.className = "item";
		el.dataset.item = item.id;
		el.style.left = `${item.x}px`;
		el.style.top = `${item.y}px`;
		el.style.width = `${item.w}px`;
		if (item.id === this._selectedId) el.classList.add("selected");

		el.appendChild(this._buildContent(item));

		if (!this.readonly) {
			const grip = document.createElement("div");
			grip.className = "grip";
			const label = document.createElement("span");
			label.textContent = "⋮⋮ " + item.type;
			const remove = document.createElement("span");
			remove.className = "remove";
			remove.textContent = "×";
			remove.title = "Remove from the Stage";
			remove.addEventListener("pointerdown", (e) => e.stopPropagation());
			remove.addEventListener("click", () => {
				this._selectedId = null;
				stageStore.removeItem(item.id);
			});
			grip.append(label, remove);
			this._wireMove(grip, el, item);
			el.appendChild(grip);

			const resize = document.createElement("div");
			resize.className = "resize";
			this._wireResize(resize, el, item);
			el.appendChild(resize);

			el.addEventListener("pointerdown", () => this._select(item.id));
		}
		return el;
	}

	_buildContent(item) {
		switch (item.type) {
			case "heading":
			case "text":
				return this._buildText(item);
			case "command":
				return this._buildCommand(item);
			case "var": {
				const knobs = document.createElement("wa-var-knobs");
				knobs.toggleAttribute("hide-map", this.readonly);
				knobs.setAttribute("public-labels", "");
				knobs.setOnlyElementId(item.ref);
				return knobs;
			}
			case "input":
				return this._buildInput(item);
			case "element": {
				const card = document.createElement("wa-chain-view");
				card.setCardNode(item.ref, { editable: Array.isArray(item.editable) ? item.editable : null, publicLabels: true });
				return card;
			}
		}
		return document.createElement("div");
	}

	_buildText(item) {
		const p = document.createElement(item.type === "heading" ? "h2" : "p");
		p.className = item.type;
		const text = item.text || "";
		p.textContent = text || (item.type === "heading" ? "Heading" : "Instruction");
		p.classList.toggle("empty", !text);
		if (!this.readonly) {
			p.title = "Double-click to edit";
			p.addEventListener("dblclick", () => this._editText(p, item));
		}
		return p;
	}

	_editText(p, item) {
		this._editingId = item.id;
		p.classList.remove("empty");
		p.textContent = item.text || "";
		p.contentEditable = "plaintext-only";
		p.focus();
		const range = document.createRange();
		range.selectNodeContents(p);
		const sel = this.shadowRoot.getSelection?.() || window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
		const finish = (commit) => {
			p.removeEventListener("blur", onBlur);
			p.removeEventListener("keydown", onKey);
			p.contentEditable = "false";
			const value = p.textContent;
			this._editingId = null;
			if (commit && value !== (item.text || "")) stageStore.updateItem(item.id, { text: value });
			else this._render();
		};
		const onBlur = () => finish(true);
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				finish(false);
			} else if (e.key === "Enter" && (item.type === "heading" || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				finish(true);
			}
		};
		p.addEventListener("blur", onBlur);
		p.addEventListener("keydown", onKey);
	}

	// A row of a live input and the Start/Stop of that input: what the viewer
	// needs for the camera to be usable (a browser only starts it on a click).
	_buildInput(item) {
		const source = inputSources.get(item.source);
		const row = source?.getEntrySummaries().find((r) => r.id === item.ref);
		if (!source || !row) {
			const m = document.createElement("div");
			m.className = "missing";
			m.textContent = source ? "Missing input row" : "This input is not available here";
			return m;
		}
		const card = document.createElement("div");
		card.className = "input-card";
		card.dataset.entry = String(row.id);
		card.style.setProperty("--entry-color", row.color);
		const head = document.createElement("div");
		head.className = "input-head";
		const title = document.createElement("span");
		title.className = "input-title";
		title.textContent = `Camera · ${row.label}`;
		title.title = title.textContent;
		const tag = document.createElement("span");
		tag.className = "input-tag";
		tag.textContent = row.measure;
		head.append(title, tag);
		const bar = document.createElement("div");
		bar.className = "input-bar";
		const fill = document.createElement("div");
		fill.className = "input-fill";
		bar.appendChild(fill);
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "input-start" + (source.running ? " running" : "");
		btn.textContent = source.running ? "Stop camera" : "Start camera";
		btn.addEventListener("click", () => (source.running ? source.stop() : source.start()));
		card.append(head, bar, btn);
		if (source.statusText) {
			const status = document.createElement("div");
			status.className = "input-status";
			status.textContent = source.statusText;
			card.appendChild(status);
		}
		return card;
	}

	_buildCommand(item) {
		const cmd = this._findByAttributeId(item.ref, "Command");
		if (!cmd) {
			const m = document.createElement("div");
			m.className = "missing";
			m.textContent = `Missing Command "${item.ref}"`;
			return m;
		}
		const type = cmd.attributes.type || "trig";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "command-btn";
		const glyph = document.createElement("span");
		glyph.className = `glyph ${type}`;
		glyph.textContent = type === "set" ? "=" : type === "stop" ? "■" : "▶";
		const label = document.createElement("span");
		const value = cmd.attributes.value ?? "";
		// The button says what its `label` says; without one it is just its icon — the
		// technical selector ("chA") is nothing for a viewer to read. (The author can still
		// see what it does: the tooltip.)
		label.textContent = cmd.attributes.label || "";
		btn.title = !this.readonly && !cmd.attributes.label ? (type === "set" ? `${cmd.attributes.variable}=${value}` : `${type}(${value})`) : cmd.attributes.label || "";
		if (!label.textContent) label.hidden = true;
		btn.append(label, glyph);
		btn.addEventListener("click", () => {
			btn.classList.remove("blink");
			void btn.offsetWidth;
			btn.classList.add("blink");
			if (type === "set") {
				const parsed = parseFloat(value);
				playerStore.setVariable(cmd.attributes.variable, Number.isFinite(parsed) ? parsed : value);
			} else if (type === "stop") {
				playerStore.stopShortcut(value);
			} else {
				playerStore.trigShortcut(value);
			}
		});
		return btn;
	}

	_findByAttributeId(elementId, tagName) {
		const walk = (n) => {
			if (n.attributes.id === elementId && (!tagName || n.tagName === tagName)) return n;
			for (const c of n.children) {
				const f = walk(c);
				if (f) return f;
			}
			return null;
		};
		return xmlStore.root ? walk(xmlStore.root) : null;
	}

	// ── Moving / resizing ─────────────────────────────────────────────────
	_wireMove(grip, el, item) {
		grip.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			grip.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startY = e.clientY;
			const origX = item.x;
			const origY = item.y;
			let moved = false;
			const move = (ev) => {
				moved = true;
				const nx = Math.max(0, Math.round(origX + (ev.clientX - startX) / this._scale));
				const ny = Math.max(0, Math.round(origY + (ev.clientY - startY) / this._scale));
				el.style.left = `${nx}px`;
				el.style.top = `${ny}px`;
				el._pos = { x: nx, y: ny };
			};
			const up = () => {
				grip.removeEventListener("pointermove", move);
				grip.removeEventListener("pointerup", up);
				grip.removeEventListener("pointercancel", up);
				if (moved && el._pos) stageStore.updateItem(item.id, el._pos);
			};
			grip.addEventListener("pointermove", move);
			grip.addEventListener("pointerup", up);
			grip.addEventListener("pointercancel", up);
		});
	}

	_wireResize(handle, el, item) {
		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const origW = item.w;
			let width = origW;
			const move = (ev) => {
				width = Math.max(60, Math.min(STAGE_WIDTH - item.x, Math.round(origW + (ev.clientX - startX) / this._scale)));
				el.style.width = `${width}px`;
			};
			const up = () => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
				handle.removeEventListener("pointercancel", up);
				if (width !== origW) stageStore.updateItem(item.id, { w: width });
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
			handle.addEventListener("pointercancel", up);
		});
	}
}

customElements.define("wa-stage-view", WaStageView);
