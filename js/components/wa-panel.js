// Generic show/hide + resizable panel wrapper used by all four vertical
// panels from docs/WAXML-Workstation-spec.md avsnitt 5. Panel content is
// slotted in, e.g. <wa-panel panel-title="Preview"><wa-preview></wa-preview></wa-panel>.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: relative;
			display: flex;
			flex-direction: column;
			min-width: 0;
			border-right: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
			color: var(--waw-fg, #e8e8e8);
			overflow: hidden;
		}
		:host([hidden]) {
			display: none;
		}
		:host(.collapsed) {
			flex-basis: auto !important;
			width: auto;
		}
		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
			padding: 0.5rem 0.75rem;
			font: 600 0.75rem/1.2 system-ui, sans-serif;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
			white-space: nowrap;
		}
		.panel-body {
			flex: 1 1 auto;
			overflow: auto;
			min-height: 0;
		}
		:host(.collapsed) .panel-body {
			display: none;
		}
		.collapse-btn {
			background: none;
			border: none;
			color: inherit;
			cursor: pointer;
			font-size: 0.85rem;
			line-height: 1;
			padding: 0.1rem 0.3rem;
		}
		.resize-handle {
			position: absolute;
			top: 0;
			right: -3px;
			width: 6px;
			height: 100%;
			cursor: col-resize;
			z-index: 1;
		}
		:host(.collapsed) .resize-handle {
			display: none;
		}
	</style>
	<div class="panel-header">
		<span class="panel-title"></span>
		<button class="collapse-btn" type="button" title="Show/hide panel">-</button>
	</div>
	<div class="panel-body"><slot></slot></div>
	<div class="resize-handle"></div>
`;

export class WaPanel extends HTMLElement {
	static get observedAttributes() {
		return ["panel-title"];
	}

	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._titleEl = this.shadowRoot.querySelector(".panel-title");
		this._collapseBtn = this.shadowRoot.querySelector(".collapse-btn");
		this._resizeHandle = this.shadowRoot.querySelector(".resize-handle");
		this._collapsed = false;
		this._onResizeMove = this._onResizeMove.bind(this);
		this._onResizeEnd = this._onResizeEnd.bind(this);
	}

	connectedCallback() {
		this._titleEl.textContent = this.getAttribute("panel-title") || "";
		// Every panel defaults to a fixed width (resizable via the handle
		// below), which on a wide window leaves empty space past the last one.
		// The one panel marked "fill" (normally the trailing one) grows to
		// soak up whatever's left instead of leaving a gap.
		this.style.flex = this.hasAttribute("fill") ? "1 1 auto" : `0 0 ${this.getAttribute("width") || "300px"}`;
		this._collapseBtn.addEventListener("click", () => this.toggleCollapse());
		this._resizeHandle.addEventListener("pointerdown", (e) => this._onResizeStart(e));
	}

	attributeChangedCallback(name, oldVal, newVal) {
		if (name === "panel-title" && this._titleEl) {
			this._titleEl.textContent = newVal || "";
		}
	}

	toggleCollapse(force) {
		this._collapsed = typeof force === "boolean" ? force : !this._collapsed;
		this.classList.toggle("collapsed", this._collapsed);
		this._collapseBtn.textContent = this._collapsed ? "+" : "-";
	}

	_onResizeStart(e) {
		e.preventDefault();
		this._resizeStartX = e.clientX;
		this._resizeStartWidth = this.getBoundingClientRect().width;
		window.addEventListener("pointermove", this._onResizeMove);
		window.addEventListener("pointerup", this._onResizeEnd);
	}

	_onResizeMove(e) {
		const newWidth = Math.max(160, this._resizeStartWidth + (e.clientX - this._resizeStartX));
		this.style.flex = `0 0 ${newWidth}px`;
	}

	_onResizeEnd() {
		window.removeEventListener("pointermove", this._onResizeMove);
		window.removeEventListener("pointerup", this._onResizeEnd);
	}
}

customElements.define("wa-panel", WaPanel);
