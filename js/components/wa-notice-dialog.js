// A minimal single-button "OK" popup for a one-off informational message —
// used by xml-store.js's own "notice" event (see its
// _applyActiveFadeTimeWorkaround, wired up once in app.js) so a workaround
// applied silently under the hood still gets explained to whoever triggered
// it. Same backdrop+dialog shape as wa-file-conflict-dialog.js, just one
// acknowledgement instead of a choice.
//
// Used imperatively: `showNotice("some message");` — fire and forget, no
// return value needed (nothing to choose between).

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
			margin-top: 1rem;
		}
		button {
			background: var(--waw-accent, #4fa3ff);
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: #0c0c0c;
			border-radius: 4px;
			padding: 0.35rem 0.9rem;
			font-size: 0.8rem;
			cursor: pointer;
		}
		button:hover {
			filter: brightness(1.08);
		}
	</style>
	<div class="backdrop">
		<div class="dialog">
			<p class="message"></p>
			<div class="actions">
				<button class="btn-ok" type="button">OK</button>
			</div>
		</div>
	</div>
`;

class WaNoticeDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._backdrop = this.shadowRoot.querySelector(".backdrop");
		this._message = this.shadowRoot.querySelector(".message");
		this._onKeyDown = (e) => {
			if (e.key === "Escape" || e.key === "Enter") this._close();
		};
	}

	setup(message) {
		this._message.textContent = message;
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".btn-ok").addEventListener("click", () => this._close());
		// currentTarget (the backdrop itself, where this listener lives) vs
		// target (whatever was actually clicked) — only a genuine backdrop
		// click (not one bubbling up from inside .dialog) dismisses it.
		this._backdrop.addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this._close();
		});
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	_close() {
		this.remove();
	}
}

customElements.define("wa-notice-dialog", WaNoticeDialog);

export function showNotice(message) {
	const dialog = document.createElement("wa-notice-dialog");
	document.body.appendChild(dialog);
	dialog.setup(message);
}
