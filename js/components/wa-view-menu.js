import { viewState } from "../state/view.js";

// Switches between the normal editor and the demo publishing/distribution
// views (per Hans, 2026-09-10) — same menu-trigger/dropdown shape as
// wa-edit-menu.js/wa-file-menu.js, copied rather than shared since there's
// no real logic in common beyond that shape.

const VIEWS = [
	{ id: "workstation", label: "Workstation" },
	{ id: "library", label: "Library (DEMO)" },
	{ id: "api", label: "API (DEMO)" }
];

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
		.menu-item:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.menu-item .check {
			color: var(--waw-accent, #4fa3ff);
			visibility: hidden;
		}
		.menu-item.current .check {
			visibility: visible;
		}
	</style>
	<button class="menu-trigger" type="button">View</button>
	<div class="menu-dropdown" hidden>
		${VIEWS.map((v) => `<button class="menu-item" type="button" data-view="${v.id}"><span>${v.label}</span><span class="check">✓</span></button>`).join("")}
	</div>
`;

export class WaViewMenu extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._trigger = this.shadowRoot.querySelector(".menu-trigger");
		this._dropdown = this.shadowRoot.querySelector(".menu-dropdown");
		this._items = [...this.shadowRoot.querySelectorAll(".menu-item")];
		this._onViewChange = () => this._updateCurrent();
	}

	connectedCallback() {
		this._trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this._dropdown.hidden ? this._open() : this._close();
		});
		this._items.forEach((item) => {
			item.addEventListener("click", (e) => {
				e.stopPropagation();
				viewState.set(item.dataset.view);
				this._close();
			});
		});
		this._onDocumentClick = () => this._close();
		document.addEventListener("click", this._onDocumentClick);
		viewState.addEventListener("change", this._onViewChange);
		this._updateCurrent();
	}

	disconnectedCallback() {
		document.removeEventListener("click", this._onDocumentClick);
		viewState.removeEventListener("change", this._onViewChange);
	}

	_open() {
		this._dropdown.hidden = false;
		this.classList.add("open");
	}

	_close() {
		this._dropdown.hidden = true;
		this.classList.remove("open");
	}

	_updateCurrent() {
		this._items.forEach((item) => item.classList.toggle("current", item.dataset.view === viewState.current));
	}
}

customElements.define("wa-view-menu", WaViewMenu);
