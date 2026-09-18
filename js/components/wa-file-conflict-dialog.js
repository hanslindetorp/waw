// Modal asking how to resolve a name collision when uploading or moving one
// or more files into a folder that already has a file with the same name —
// per Hans (2026-09-18): dropping a file from Finder/Explorer, or dragging
// one to a different folder within File Manager, onto a target that already
// contains a same-named file must ask before silently doing either thing.
//
// Used imperatively, same shape as wa-voice-picker.js's openVoicePicker:
// `const action = await openFileConflictDialog(conflictingNames);`
// resolves to "replace" | "keep-both" | "cancel" (also "cancel" if dismissed
// via Escape or a backdrop click without picking a button).

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
		.names {
			margin: 0.5rem 0 0;
			padding-left: 1.1rem;
			max-height: 8rem;
			overflow-y: auto;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
		}
		.actions {
			display: flex;
			justify-content: flex-end;
			gap: 0.5rem;
			margin-top: 1rem;
		}
		button {
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.35rem 0.75rem;
			font-size: 0.8rem;
			cursor: pointer;
		}
		button:hover {
			background: #333;
		}
		button.primary {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #0c0c0c;
		}
		button.primary:hover {
			filter: brightness(1.08);
		}
	</style>
	<div class="backdrop">
		<div class="dialog">
			<p class="message"></p>
			<ul class="names"></ul>
			<div class="actions">
				<button class="btn-cancel" type="button">Cancel</button>
				<button class="btn-keep-both" type="button">Keep both</button>
				<button class="btn-replace primary" type="button">Replace</button>
			</div>
		</div>
	</div>
`;

class WaFileConflictDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._backdrop = this.shadowRoot.querySelector(".backdrop");
		this._message = this.shadowRoot.querySelector(".message");
		this._namesEl = this.shadowRoot.querySelector(".names");
		this._resolve = null;
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._finish("cancel");
		};
	}

	setup(names) {
		const n = names.length;
		this._message.textContent = n === 1 ? `"${names[0]}" already exists in this folder.` : `${n} files already exist in this folder:`;
		this._namesEl.innerHTML = "";
		this._namesEl.style.display = n > 1 ? "" : "none";
		if (n > 1) {
			names.forEach((name) => {
				const li = document.createElement("li");
				li.textContent = name;
				this._namesEl.appendChild(li);
			});
		}
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".btn-cancel").addEventListener("click", () => this._finish("cancel"));
		this.shadowRoot.querySelector(".btn-keep-both").addEventListener("click", () => this._finish("keep-both"));
		this.shadowRoot.querySelector(".btn-replace").addEventListener("click", () => this._finish("replace"));
		// currentTarget (the backdrop itself, where this listener lives) vs
		// target (whatever was actually clicked) — only a genuine backdrop
		// click (not one bubbling up from inside .dialog) dismisses it.
		this._backdrop.addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this._finish("cancel");
		});
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

	_finish(action) {
		this._resolve?.(action);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-file-conflict-dialog", WaFileConflictDialog);

export function openFileConflictDialog(names) {
	const dialog = document.createElement("wa-file-conflict-dialog");
	document.body.appendChild(dialog);
	dialog.setup(names);
	return dialog.whenDone();
}
