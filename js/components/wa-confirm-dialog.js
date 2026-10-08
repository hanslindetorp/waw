// A minimal OK / Cancel popup, same backdrop+dialog shape as
// wa-notice-dialog.js (which only acknowledges) — for a one-off yes/no
// question. Used imperatively:
//
//   if (await confirmDialog("Delete all the things?")) { ... }
//
// Resolves true on OK / Enter, false on Cancel / Escape / a backdrop click.

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
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(0, 0, 0, 0.6);
		}
		.dialog {
			width: min(26rem, 90vw);
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
			padding: 1rem 1.1rem;
			color: var(--waw-fg, #e8e8e8);
		}
		.message {
			margin: 0;
		}
		.actions {
			display: flex;
			justify-content: flex-end;
			gap: 0.5rem;
			margin-top: 1rem;
		}
		button {
			border-radius: 4px;
			padding: 0.35rem 0.9rem;
			font-size: 0.8rem;
			cursor: pointer;
		}
		.btn-ok {
			background: var(--waw-accent, #4fa3ff);
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: #0c0c0c;
		}
		.btn-cancel {
			background: transparent;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
		}
		button:hover {
			filter: brightness(1.12);
		}
	</style>
	<div class="backdrop">
		<div class="dialog">
			<p class="message"></p>
			<div class="actions">
				<button class="btn-cancel" type="button">Cancel</button>
				<button class="btn-ok" type="button">OK</button>
			</div>
		</div>
	</div>
`;

class WaConfirmDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._backdrop = this.shadowRoot.querySelector(".backdrop");
		this._message = this.shadowRoot.querySelector(".message");
		this._resolve = null;
		this._onKeyDown = (e) => {
			if (e.key !== "Escape" && e.key !== "Enter") return;
			e.preventDefault();
			e.stopPropagation();
			this._finish(e.key === "Enter");
		};
	}

	setup(message) {
		this._message.textContent = message;
	}

	whenDone() {
		return new Promise((resolve) => {
			this._resolve = resolve;
		});
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".btn-ok").addEventListener("click", () => this._finish(true));
		this.shadowRoot.querySelector(".btn-cancel").addEventListener("click", () => this._finish(false));
		this._backdrop.addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this._finish(false);
		});
		document.addEventListener("keydown", this._onKeyDown, true);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown, true);
	}

	_finish(value) {
		this._resolve?.(value);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-confirm-dialog", WaConfirmDialog);

export function confirmDialog(message) {
	const dialog = document.createElement("wa-confirm-dialog");
	document.body.appendChild(dialog);
	dialog.setup(message);
	return dialog.whenDone();
}
