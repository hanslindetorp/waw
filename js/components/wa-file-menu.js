import { createDefaultProject, openProjectFromFile, exportProjectAsZip, saveProject, saveProjectAs, listTemplates, loadTemplate } from "../project/project-manager.js";

const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD_KEY_LABEL = IS_MAC ? "⌘" : "Ctrl+";

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
			min-width: 13rem;
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
		.menu-shortcut {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
		.menu-divider {
			height: 1px;
			margin: 0.3rem 0.2rem;
			background: var(--waw-border, #2f2f2f);
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
			<button class="menu-item" type="button" data-action="new">
				<span>New Project</span><span class="menu-shortcut">${MOD_KEY_LABEL}N</span>
			</button>
			<button class="menu-item" type="button" data-action="open">
				<span>Open Project...</span><span class="menu-shortcut">${MOD_KEY_LABEL}O</span>
			</button>
			<button class="menu-item" type="button" data-action="save">
				<span>Save</span><span class="menu-shortcut">${MOD_KEY_LABEL}S</span>
			</button>
			<button class="menu-item" type="button" data-action="save-as">
				<span>Save As...</span><span class="menu-shortcut">⇧${MOD_KEY_LABEL}S</span>
			</button>
			<button class="menu-item" type="button" data-action="export">Export Project...</button>
			<div class="templates-divider menu-divider" hidden></div>
			<div class="templates-list"></div>
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
		this._templatesDivider = this.shadowRoot.querySelector(".templates-divider");
		this._templatesList = this.shadowRoot.querySelector(".templates-list");
		this._onKeyDown = this._onKeyDown.bind(this);
	}

	connectedCallback() {
		this._trigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this._dropdown.hidden ? this._open() : this._close();
		});

		this._dropdown.querySelector('[data-action="new"]').addEventListener("click", (e) => {
			e.stopPropagation();
			this._startNew();
		});

		this._dropdown.querySelector('[data-action="open"]').addEventListener("click", (e) => {
			e.stopPropagation();
			this._startOpen();
		});

		this._dropdown.querySelector('[data-action="save"]').addEventListener("click", async (e) => {
			e.stopPropagation();
			this._close();
			try {
				await saveProject();
			} catch (err) {
				console.error("Save failed:", err);
			}
		});

		this._dropdown.querySelector('[data-action="save-as"]').addEventListener("click", async (e) => {
			e.stopPropagation();
			this._close();
			try {
				await saveProjectAs();
			} catch (err) {
				console.error("Save As failed:", err);
			}
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
		document.addEventListener("keydown", this._onKeyDown);

		this._loadTemplates();
	}

	disconnectedCallback() {
		document.removeEventListener("click", this._onDocumentClick);
		document.removeEventListener("keydown", this._onKeyDown);
	}

	async _loadTemplates() {
		const manifest = await listTemplates();
		const names = Object.keys(manifest).sort((a, b) => a.localeCompare(b));
		if (names.length === 0) return;

		this._templatesDivider.hidden = false;
		names.forEach((name) => {
			const btn = document.createElement("button");
			btn.className = "menu-item";
			btn.type = "button";
			btn.innerHTML = `<span>${name}</span>`;
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this._startLoadTemplate(name);
			});
			this._templatesList.appendChild(btn);
		});
	}

	// Cmd/Ctrl+N and +O mirror the browser's own reserved shortcuts (new
	// window, open file) in most browsers, so preventDefault() here often
	// can't actually stop the browser's own handling of them — wired anyway
	// since it does work in some browsers/platforms, and Save/Save As are
	// the ones that reliably matter. Skipped while a menu/dialog is
	// mid-interaction (this._dropdown open) so a shortcut typed while
	// choosing "Discard & continue" doesn't also fire.
	_onKeyDown(e) {
		if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
		const key = e.key.toLowerCase();
		if (key === "n") {
			e.preventDefault();
			this._startNew();
		} else if (key === "o") {
			e.preventDefault();
			this._startOpen();
		} else if (key === "s" && e.shiftKey) {
			e.preventDefault();
			saveProjectAs().catch((err) => console.error("Save As failed:", err));
		} else if (key === "s") {
			e.preventDefault();
			saveProject().catch((err) => console.error("Save failed:", err));
		}
	}

	_startNew() {
		this._open();
		this._confirmThen("Discard the current project and start a new default project?", () => {
			createDefaultProject();
			this._close();
		});
	}

	async _startOpen() {
		// Chrome/Edge (not Safari/Firefox) can show a real native "Open"
		// dialog via the File System Access API, whose handle we can later
		// write straight back to on a plain Save — see project-manager.js.
		// Everywhere else falls back to the classic <input type="file">
		// picker, which never yields a handle (so Save falls back to Save
		// As's own prompt until the project is saved at least once).
		if (typeof window.showOpenFilePicker === "function") {
			this._close();
			let picked;
			try {
				[picked] = await window.showOpenFilePicker({
					types: [
						{
							description: "WAW project",
							accept: { "application/zip": [".zip"], "text/xml": [".xml", ".waxml"] }
						}
					]
				});
			} catch (err) {
				if (err.name === "AbortError") return; // user cancelled the picker
				this._startOpenViaInput();
				return;
			}
			// _confirmThen shows its prompt *inside* the dropdown — closed
			// above (needed while the native picker itself was open, so it
			// wasn't left hanging behind that dialog) — so it has to be
			// reopened here, or the confirm prompt renders invisibly and the
			// whole flow appears to silently do nothing. Bug per Hans
			// (2026-09-04): "File Open... öppnar inte någonting".
			this._open();
			this._confirmThen("Discard the current project and open another one?", async () => {
				this._close();
				try {
					const file = await picked.getFile();
					await openProjectFromFile(file, picked);
				} catch (err) {
					console.error("Open Project failed:", err);
				}
			});
			return;
		}
		this._startOpenViaInput();
	}

	_startOpenViaInput() {
		this._open();
		this._confirmThen("Discard the current project and open another one?", () => {
			this._close();
			this._fileInput.click();
		});
	}

	_startLoadTemplate(name) {
		this._open();
		this._confirmThen(`Discard the current project and load the "${name}" template?`, async () => {
			this._close();
			try {
				await loadTemplate(name);
			} catch (err) {
				console.error("Load Template failed:", err);
			}
		});
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
