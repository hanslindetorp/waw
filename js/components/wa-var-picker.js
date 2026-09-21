import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";

// Popup "pick a root Var, or create a new one" menu — opened from
// wa-webcam-input.js's own per-key mapping controls (2026-09-22): each
// tracked metric (a point's x/y/z, a distance's dist2d/dist3d, ...) maps to
// a root-level <Var> it drives live via playerStore.setVariable(). Per Hans:
// the INPUT panel stays outside the WAXML spec itself, but the <Var> it
// writes into is a completely ordinary one — same root Vars wa-bottom-bar.js's
// own knobs list and wa-api-view.js's own JS-API examples already show.
//
// Used imperatively, same shape as wa-voice-picker.js's openVoicePicker:
// `const name = await openVarPicker(anchorRect);`
// resolves with the picked (or newly created) Var's name, or null if
// dismissed without picking anything. Picking "New Variable..." actually
// creates the <Var> right away (via xmlStore.addRootVar) — unlike a voice,
// which is just a string attribute value with nothing to create.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.backdrop {
			position: absolute;
			inset: 0;
		}
		.popup {
			position: absolute;
			min-width: 12rem;
			max-width: 20rem;
			max-height: 60vh;
			overflow-y: auto;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
			padding: 0.3rem;
		}
		.empty-status {
			color: var(--waw-muted, #8a8a8a);
			padding: 0.4rem 0.6rem;
		}
		.var-row {
			display: flex;
			align-items: center;
			gap: 0.3rem;
			border-radius: 4px;
			padding: 0.3rem 0.5rem;
			cursor: pointer;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.var-row:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.var-row.new-var {
			color: var(--waw-accent, #4fa3ff);
			font-family: inherit;
			font-style: italic;
		}
		.divider {
			height: 1px;
			background: var(--waw-border, #2f2f2f);
			margin: 0.25rem 0.1rem;
		}
		.new-var-input {
			display: flex;
			gap: 0.3rem;
			padding: 0.2rem;
		}
		.new-var-input input {
			flex: 1 1 auto;
			min-width: 0;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			background: #0c0c0c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			color: inherit;
			padding: 0.2rem 0.4rem;
		}
	</style>
	<div class="backdrop"></div>
	<div class="popup"><div class="menu-root"></div></div>
`;

class WaVarPicker extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._popup = this.shadowRoot.querySelector(".popup");
		this._menuRoot = this.shadowRoot.querySelector(".menu-root");
		this._resolve = null;
	}

	// anchorRect: a getBoundingClientRect()-shaped object to position the
	// popup near.
	setup(anchorRect) {
		this._anchorRect = anchorRect;
		this._renderMenu();
		this._positionNear(anchorRect);
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".backdrop").addEventListener("click", () => this._finish(null));
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._finish(null);
		};
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	whenDone() {
		return new Promise((resolve) => {
			this._resolve = resolve;
		});
	}

	// Every root-level <Var> that has a usable name/id — same filter
	// wa-api-view.js's own private rootVars() uses.
	_existingVars() {
		if (!xmlStore.root) return [];
		return xmlStore.root.children.filter((c) => c.tagName === "Var" && (c.attributes.name || c.attributes.id));
	}

	_renderMenu() {
		this._menuRoot.innerHTML = "";

		const newVarRow = document.createElement("div");
		newVarRow.className = "var-row new-var";
		newVarRow.textContent = "New Variable...";
		newVarRow.addEventListener("click", () => this._showNewVarInput());
		this._menuRoot.appendChild(newVarRow);

		const names = [...new Set(this._existingVars().map((v) => v.attributes.name || v.attributes.id))].sort((a, b) => a.localeCompare(b));
		if (names.length === 0) {
			const empty = document.createElement("p");
			empty.className = "empty-status";
			empty.textContent = "No root Vars yet.";
			this._menuRoot.appendChild(empty);
			return;
		}

		const divider = document.createElement("div");
		divider.className = "divider";
		this._menuRoot.appendChild(divider);

		names.forEach((name) => {
			const row = document.createElement("div");
			row.className = "var-row";
			row.textContent = name;
			row.addEventListener("click", () => this._finish(name));
			this._menuRoot.appendChild(row);
		});
	}

	_showNewVarInput() {
		this._menuRoot.innerHTML = "";
		const wrap = document.createElement("div");
		wrap.className = "new-var-input";
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Variable name...";
		// A suggested, ready-to-go name — same auto-naming a "+" button
		// elsewhere in the app would generate, fully editable before commit.
		input.value = xmlStore.root ? ops.generateVarName(xmlStore.root) : "";
		wrap.appendChild(input);
		this._menuRoot.appendChild(wrap);
		input.focus();
		input.select();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this._commitNewVar(input.value.trim());
			}
		});
		this._positionNear(this._anchorRect);
	}

	_commitNewVar(name) {
		if (!name) return;
		const node = xmlStore.addRootVar(name);
		this._finish(node ? node.attributes.name : null);
	}

	_positionNear(anchorRect) {
		// Measure after the popup has real content, then clamp inside the
		// viewport — same reasoning as wa-voice-picker.js's own _positionNear.
		requestAnimationFrame(() => {
			const rect = this._popup.getBoundingClientRect();
			let left = anchorRect?.left ?? 0;
			let top = anchorRect?.bottom ?? 0;
			left = Math.min(left, window.innerWidth - rect.width - 8);
			left = Math.max(8, left);
			top = Math.min(top, window.innerHeight - rect.height - 8);
			top = Math.max(8, top);
			this._popup.style.left = `${left}px`;
			this._popup.style.top = `${top}px`;
		});
	}

	_finish(value) {
		this._resolve?.(value);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-var-picker", WaVarPicker);

export function openVarPicker(anchorRect) {
	const picker = document.createElement("wa-var-picker");
	document.body.appendChild(picker);
	picker.setup(anchorRect);
	return picker.whenDone();
}
