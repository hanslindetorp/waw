import { stageStore } from "../project/stage-store.js";
import { showToast } from "../ui/toast.js";
import { isValidProjectName, testUrl, launchUrl } from "../project/share-urls.js";

// "Share this test": the address of the Stage view being shown, ready to copy. The address
// depends on the name the project is published under (the zip in the public folder of the
// server, made with File > Export > Export for publishing), which the app doesn't know, so
// it is asked for once and remembered. Opening the dialog also copies the test's own address.
// Per Hans (2026-11-02).

const NAME_KEY = "waw-share-project-name";

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host { display: block; }
		:host([hidden]) { display: none; }
		.backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); }
		.dialog { width: min(40rem, 94vw); background: var(--waw-panel-bg, #1a1a1a); border: 1px solid var(--waw-border, #2f2f2f); border-radius: 10px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); color: var(--waw-fg, #e8e8e8); font: 0.85rem/1.4 system-ui, sans-serif; }
		.head { display: flex; justify-content: space-between; padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--waw-border, #2f2f2f); font-weight: 600; text-transform: uppercase; font-size: 0.78rem; letter-spacing: 0.04em; }
		.close { background: none; border: none; color: inherit; cursor: pointer; font-size: 1rem; }
		.body { padding: 0.9rem 1.1rem; display: flex; flex-direction: column; gap: 0.8rem; }
		.hint { color: var(--waw-muted, #8a8a8a); font-size: 0.78rem; }
		label.field { display: flex; flex-direction: column; gap: 0.25rem; }
		input[type="text"] { font: inherit; color: inherit; background: #101010; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 4px; padding: 0.35rem 0.5rem; box-sizing: border-box; width: 100%; }
		.row { display: flex; gap: 0.4rem; }
		.row input { font: 0.75rem var(--waw-mono-font, Menlo, monospace); }
		button.action { font: inherit; color: inherit; background: #2a2a2a; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 5px; padding: 0.3rem 0.8rem; cursor: pointer; white-space: nowrap; }
		button.action:hover { border-color: var(--waw-accent, #4fa3ff); }
		.error { color: var(--waw-danger, #e5484d); min-height: 1.2em; }
	</style>
	<div class="backdrop">
		<div class="dialog">
			<div class="head"><span>Share this test</span><button class="close" type="button" title="Close">✕</button></div>
			<div class="body">
				<label class="field">The project's file name on the server
					<input class="name" type="text" placeholder="my-project" spellcheck="false" />
					<span class="hint">The project exported with File → Export → Export for publishing under this name, and uploaded to the server's public folder. Letters, digits, dots, dashes and underscores.</span>
				</label>
				<div class="error"></div>
				<div>
					<div>The test, to open on its own</div>
					<div class="row"><input class="url-test" type="text" readonly /><button class="action copy-test" type="button">Copy</button></div>
				</div>
				<div>
					<div>For the learning platform's assignment (Canvas, LTI)</div>
					<div class="row"><input class="url-launch" type="text" readonly /><button class="action copy-launch" type="button">Copy</button></div>
				</div>
			</div>
		</div>
	</div>
`;

export class WaTestShare extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._viewId = null;
		this._onKeyDown = (e) => {
			if (e.key === "Escape" && !this.hidden) this.close();
		};
	}

	connectedCallback() {
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		$(".close").addEventListener("click", () => this.close());
		$(".backdrop").addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this.close();
		});
		$(".name").addEventListener("input", () => this._update(false));
		$(".copy-test").addEventListener("click", () => this._copy($(".url-test").value));
		$(".copy-launch").addEventListener("click", () => this._copy($(".url-launch").value));
		[".url-test", ".url-launch"].forEach((sel) => $(sel).addEventListener("focus", (e) => e.target.select()));
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	open(viewId) {
		this._viewId = viewId;
		let name = "";
		try {
			name = localStorage.getItem(NAME_KEY) || "";
		} catch {
			// no storage: the name is asked for each time
		}
		this.shadowRoot.querySelector(".name").value = name;
		this.hidden = false;
		this._update(true);
	}

	close() {
		this.hidden = true;
	}

	// Writes the addresses for the name as it is, and — when the dialog has just opened — copies the test's own.
	_update(copyNow) {
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		const name = $(".name").value.trim();
		const view = stageStore.getView(this._viewId);
		if (!view) {
			$(".error").textContent = "This view does not exist.";
			return;
		}
		if (!name || !isValidProjectName(name)) {
			$(".error").textContent = name ? "The name may hold letters, digits, dots, dashes and underscores only." : "";
			$(".url-test").value = "";
			$(".url-launch").value = "";
			return;
		}
		$(".error").textContent = "";
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// not remembered
		}
		$(".url-test").value = testUrl(name, this._viewId);
		$(".url-launch").value = launchUrl(name, this._viewId);
		if (copyNow) this._copy($(".url-test").value);
	}

	async _copy(text) {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			showToast("Copied to the clipboard.", { kind: "info" });
		} catch {
			showToast("Could not copy: select the address and copy it.", { kind: "warning" });
		}
	}
}

customElements.define("wa-test-share", WaTestShare);
