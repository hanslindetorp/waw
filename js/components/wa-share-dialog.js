import "./wa-api-view.js";

// The "Share..." dialog (File menu) — a modal overlay on top of Workstation
// showing the same embed instructions/API reference as the old standalone
// API view (see wa-api-view.js, reused as-is here — the View menu's "API"
// entry is gone, this dialog is its only home now). Per Hans (2026-09-13).

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
		}
		:host([hidden]) {
			display: none;
		}
		.backdrop {
			position: fixed;
			inset: 0;
			z-index: 100;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(0, 0, 0, 0.6);
		}
		.dialog {
			display: flex;
			flex-direction: column;
			width: min(52rem, 92vw);
			height: min(42rem, 86vh);
			background: var(--waw-panel-bg, #1a1a1a);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 10px;
			overflow: hidden;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
		}
		.dialog-header {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.6rem 0.9rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			font: 600 0.8rem/1.2 system-ui, sans-serif;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--waw-fg, #e8e8e8);
		}
		.close-btn {
			background: none;
			border: none;
			color: inherit;
			font-size: 1rem;
			line-height: 1;
			cursor: pointer;
			padding: 0.2rem 0.4rem;
			border-radius: 4px;
		}
		.close-btn:hover {
			background: rgba(255, 255, 255, 0.08);
		}
		wa-api-view {
			flex: 1 1 auto;
			min-height: 0;
		}
	</style>
	<div class="backdrop">
		<div class="dialog">
			<div class="dialog-header">
				<span>Share</span>
				<button class="close-btn" type="button" title="Close">✕</button>
			</div>
			<wa-api-view></wa-api-view>
		</div>
	</div>
`;

export class WaShareDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._backdrop = this.shadowRoot.querySelector(".backdrop");
		this._onKeyDown = (e) => {
			if (e.key === "Escape" && !this.hidden) this.close();
		};
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".close-btn").addEventListener("click", () => this.close());
		// currentTarget (the backdrop itself, where this listener lives) vs
		// target (whatever was actually clicked) — only a genuine backdrop
		// click (not one bubbling up from inside .dialog) closes it.
		this._backdrop.addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this.close();
		});
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	open() {
		this.hidden = false;
	}

	close() {
		this.hidden = true;
	}
}

customElements.define("wa-share-dialog", WaShareDialog);
