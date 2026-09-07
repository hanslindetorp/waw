import { undo, redo, canUndo, canRedo, addHistoryChangeListener, isEditableContext } from "../project/edit-history.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { showToast } from "../ui/toast.js";

// Mac gets the ⌘ glyph in the shortcut hint; everyone else gets "Ctrl" — a
// label-only distinction, edit-history.js's own keydown handler already
// accepts both metaKey and ctrlKey regardless of platform.
const IS_MAC = navigator.platform?.toUpperCase().includes("MAC") ?? false;
const UNDO_HINT = IS_MAC ? "⌘Z" : "Ctrl+Z";
const REDO_HINT = IS_MAC ? "⇧⌘Z" : "Ctrl+Y";
const COPY_HINT = IS_MAC ? "⌘C" : "Ctrl+C";
const CUT_HINT = IS_MAC ? "⌘X" : "Ctrl+X";
const PASTE_HINT = IS_MAC ? "⌘V" : "Ctrl+V";

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: inline-block;
			position: relative;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.menu-trigger {
			background: none;
			border: 1px solid transparent;
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.6rem;
			font: inherit;
			cursor: pointer;
		}
		.menu-trigger:hover,
		:host(.open) .menu-trigger {
			background: #2a2a2a;
			border-color: var(--waw-border, #2f2f2f);
		}
		.menu-dropdown {
			position: absolute;
			top: 100%;
			left: 0;
			margin-top: 0.25rem;
			z-index: 30;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
			min-width: 12rem;
			padding: 0.3rem;
		}
		.menu-divider {
			height: 1px;
			margin: 0.3rem 0.2rem;
			background: var(--waw-border, #2f2f2f);
		}
		.menu-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 1rem;
			width: 100%;
			text-align: left;
			background: none;
			border: none;
			color: inherit;
			font: inherit;
			padding: 0.4rem 0.6rem;
			border-radius: 4px;
			cursor: pointer;
		}
		.menu-item:hover:not(:disabled) {
			background: rgba(79, 163, 255, 0.15);
		}
		.menu-item:disabled {
			color: var(--waw-muted, #8a8a8a);
			cursor: default;
		}
		.menu-item .hint {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.75rem;
		}
	</style>
	<button class="menu-trigger" type="button">Edit</button>
	<div class="menu-dropdown" hidden>
		<button class="menu-item" type="button" data-action="undo">
			<span>Undo</span>
			<span class="hint">${UNDO_HINT}</span>
		</button>
		<button class="menu-item" type="button" data-action="redo">
			<span>Redo</span>
			<span class="hint">${REDO_HINT}</span>
		</button>
		<div class="menu-divider"></div>
		<button class="menu-item" type="button" data-action="copy">
			<span>Copy</span>
			<span class="hint">${COPY_HINT}</span>
		</button>
		<button class="menu-item" type="button" data-action="cut">
			<span>Cut</span>
			<span class="hint">${CUT_HINT}</span>
		</button>
		<button class="menu-item" type="button" data-action="paste">
			<span>Paste</span>
			<span class="hint">${PASTE_HINT}</span>
		</button>
	</div>
`;

export class WaEditMenu extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._trigger = this.shadowRoot.querySelector(".menu-trigger");
		this._dropdown = this.shadowRoot.querySelector(".menu-dropdown");
		this._undoBtn = this.shadowRoot.querySelector('[data-action="undo"]');
		this._redoBtn = this.shadowRoot.querySelector('[data-action="redo"]');
		this._copyBtn = this.shadowRoot.querySelector('[data-action="copy"]');
		this._cutBtn = this.shadowRoot.querySelector('[data-action="cut"]');
		this._pasteBtn = this.shadowRoot.querySelector('[data-action="paste"]');
		this._onHistoryChange = () => this._updateDisabledState();
		this._onXmlStoreChange = () => this._updateDisabledState();
		this._onKeyDown = this._onKeyDown.bind(this);
	}

	connectedCallback() {
		this._trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this._dropdown.hidden ? this._open() : this._close();
		});

		this._undoBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			undo();
			this._close();
		});

		this._redoBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			redo();
			this._close();
		});

		this._copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._copy();
			this._close();
		});

		this._cutBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._cut();
			this._close();
		});

		this._pasteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._paste();
			this._close();
		});

		this._onDocumentClick = () => this._close();
		document.addEventListener("click", this._onDocumentClick);
		document.addEventListener("keydown", this._onKeyDown);

		addHistoryChangeListener(this._onHistoryChange);
		xmlStore.addEventListener("change", this._onXmlStoreChange);
		this._updateDisabledState();
	}

	disconnectedCallback() {
		document.removeEventListener("click", this._onDocumentClick);
		document.removeEventListener("keydown", this._onKeyDown);
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
	}

	// Cmd/Ctrl+C/X/V — skipped whenever a text field has focus
	// (isEditableContext, same guard edit-history.js's own Undo/Redo uses)
	// so normal text copy/cut/paste in the Inspector, Code panel, rename
	// fields etc. is never hijacked into an XML-node operation. Per Hans
	// (2026-09-06).
	_onKeyDown(e) {
		if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
		if (isEditableContext()) return;
		const key = e.key.toLowerCase();
		if (key === "c") {
			e.preventDefault();
			this._copy();
		} else if (key === "x") {
			e.preventDefault();
			this._cut();
		} else if (key === "v") {
			e.preventDefault();
			this._paste();
		}
	}

	_copy() {
		xmlStore.copySelection();
	}

	_cut() {
		xmlStore.cutSelection();
	}

	_paste() {
		const result = xmlStore.pasteIntoSelection();
		if (!result.ok) showToast(result.reason, { kind: "warning" });
	}

	_open() {
		this._updateDisabledState();
		this._dropdown.hidden = false;
		this.classList.add("open");
	}

	_close() {
		this._dropdown.hidden = true;
		this.classList.remove("open");
	}

	_updateDisabledState() {
		this._undoBtn.disabled = !canUndo();
		this._redoBtn.disabled = !canRedo();
		const hasSelection = xmlStore.selectedNodeIds.size > 0 || !!xmlStore.selectedNodeId;
		this._copyBtn.disabled = !hasSelection;
		this._cutBtn.disabled = !hasSelection;
		this._pasteBtn.disabled = !xmlStore.hasClipboard() || !xmlStore.selectedNodeId;
	}
}

customElements.define("wa-edit-menu", WaEditMenu);
