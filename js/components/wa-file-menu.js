import { createDefaultProject, openProjectFromFile, exportProjectAsZip } from "../project/project-manager.js";

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
			display: block;
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
		.confirm-view {
			padding: 0.5rem;
			max-width: 15rem;
		}
		.confirm-message {
			margin: 0 0 0.6rem;
			color: var(--waw-fg, #e8e8e8);
		}
		.confirm-actions {
			display: flex;
			gap: 0.4rem;
			justify-content: flex-end;
		}
		.confirm-actions button {
			font: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.6rem;
			cursor: pointer;
			border: 1px solid var(--waw-border, #2f2f2f);
			background: #2a2a2a;
			color: inherit;
		}
		.confirm-yes {
			background: var(--waw-danger, #e5484d) !important;
			border-color: var(--waw-danger, #e5484d) !important;
			color: #fff !important;
		}
	</style>
	<button class="menu-trigger" type="button">File</button>
	<div class="menu-dropdown" hidden>
		<div class="menu-items">
			<button class="menu-item" type="button" data-action="new">New Project</button>
			<button class="menu-item" type="button" data-action="open">Open Project</button>
			<button class="menu-item" type="button" data-action="export">Export Project...</button>
		</div>
		<div class="confirm-view" hidden>
			<p class="confirm-message"></p>
			<div class="confirm-actions">
				<button class="confirm-cancel" type="button">Cancel</button>
				<button class="confirm-yes" type="button">Discard &amp; continue</button>
			</div>
		</div>
	</div>
	<input class="file-input" type="file" accept=".zip,.xml,.waxml" hidden />
`;

export class WaFileMenu extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._trigger = this.shadowRoot.querySelector(".menu-trigger");
		this._dropdown = this.shadowRoot.querySelector(".menu-dropdown");
		this._menuItems = this.shadowRoot.querySelector(".menu-items");
		this._confirmView = this.shadowRoot.querySelector(".confirm-view");
		this._fileInput = this.shadowRoot.querySelector(".file-input");
	}

	connectedCallback() {
		this._trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this._dropdown.hidden ? this._open() : this._close();
		});

		this._dropdown.querySelector('[data-action="new"]').addEventListener("click", (e) => {
			e.stopPropagation();
			this._confirmThen("Discard the current project and start a new default project?", () => {
				createDefaultProject();
				this._close();
			});
		});

		this._dropdown.querySelector('[data-action="open"]').addEventListener("click", (e) => {
			e.stopPropagation();
			this._confirmThen("Discard the current project and open another one?", () => {
				this._close();
				this._fileInput.click();
			});
		});

		this._dropdown.querySelector('[data-action="export"]').addEventListener("click", async (e) => {
			e.stopPropagation();
			this._close();
			try {
				await exportProjectAsZip();
			} catch (err) {
				console.error("Export Project failed:", err);
			}
		});

		this._fileInput.addEventListener("click", (e) => e.stopPropagation());
		this._fileInput.addEventListener("change", async (e) => {
			const file = e.target.files[0];
			e.target.value = "";
			if (file) {
				try {
					await openProjectFromFile(file);
				} catch (err) {
					console.error("Open Project failed:", err);
				}
			}
		});

		this._onDocumentClick = () => this._close();
		document.addEventListener("click", this._onDocumentClick);
	}

	disconnectedCallback() {
		document.removeEventListener("click", this._onDocumentClick);
	}

	_open() {
		this._dropdown.hidden = false;
		this.classList.add("open");
		this._resetToMenuItems();
	}

	_close() {
		this._dropdown.hidden = true;
		this.classList.remove("open");
		this._resetToMenuItems();
	}

	_resetToMenuItems() {
		this._menuItems.hidden = false;
		this._confirmView.hidden = true;
	}

	// Swaps the dropdown to an inline "are you sure" view instead of a native
	// confirm() dialog — consistent with the rest of the app (file manager
	// rename/delete). Buttons are cloned fresh each call so listeners never
	// pile up across repeated open/cancel cycles.
	_confirmThen(message, onConfirm) {
		this._menuItems.hidden = true;
		this._confirmView.hidden = false;
		this._confirmView.querySelector(".confirm-message").textContent = message;

		const oldYes = this._confirmView.querySelector(".confirm-yes");
		const yesBtn = oldYes.cloneNode(true);
		oldYes.replaceWith(yesBtn);

		const oldCancel = this._confirmView.querySelector(".confirm-cancel");
		const cancelBtn = oldCancel.cloneNode(true);
		oldCancel.replaceWith(cancelBtn);

		yesBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			onConfirm();
		});
		cancelBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._close();
		});
	}
}

customElements.define("wa-file-menu", WaFileMenu);
