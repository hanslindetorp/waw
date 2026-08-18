import { xmlStore } from "../xml-editor/xml-store.js";
import { parseXsdSchema } from "../xml-editor/schema-parser.js";

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.4rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			font: 0.78rem/1.3 system-ui, sans-serif;
			flex: 0 0 auto;
			flex-wrap: wrap;
		}
		.label {
			color: var(--waw-muted, #8a8a8a);
			flex: 0 0 auto;
		}
		button, input {
			font: inherit;
			color: inherit;
		}
		.btn-upload {
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.3rem 0.55rem;
			cursor: pointer;
		}
		.btn-upload:hover {
			background: #333;
		}
		.url-row {
			display: flex;
			align-items: center;
			gap: 0.3rem;
			flex: 1 1 160px;
			min-width: 120px;
		}
		.url-input {
			flex: 1 1 auto;
			min-width: 0;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.3rem 0.45rem;
		}
		.btn-load {
			background: var(--waw-accent, #4fa3ff);
			color: #06131f;
			font-weight: 600;
			border: none;
			border-radius: 4px;
			padding: 0.3rem 0.6rem;
			cursor: pointer;
			white-space: nowrap;
		}
		.btn-load:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.chip {
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
			background: rgba(79, 163, 255, 0.15);
			color: var(--waw-accent, #4fa3ff);
			border-radius: 4px;
			padding: 0.2rem 0.5rem;
			font-weight: 600;
		}
		.chip[hidden] {
			display: none;
		}
		.chip button {
			background: none;
			border: none;
			color: inherit;
			cursor: pointer;
			line-height: 1;
			padding: 0;
		}
		.error {
			color: var(--waw-danger, #e5484d);
		}
		.hint {
			margin-left: auto;
			color: var(--waw-muted, #8a8a8a);
			font-style: italic;
			white-space: nowrap;
		}
	</style>
	<span class="label">Schema:</span>
	<div class="no-schema-controls">
		<label class="btn-upload">
			Upload XSD
			<input class="file-input" type="file" accept=".xsd,.xml" hidden />
		</label>
		<span class="label">or</span>
		<div class="url-row">
			<input class="url-input" type="text" placeholder="Schema URL..." />
			<button class="btn-load" type="button">Load</button>
		</div>
	</div>
	<div class="chip" hidden>
		<span class="chip-name"></span>
		<button class="chip-clear" type="button" title="Clear schema">✕</button>
	</div>
	<span class="error" hidden></span>
	<span class="hint">No schema — manual mode</span>
`;

export class WaSchemaInput extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._controls = this.shadowRoot.querySelector(".no-schema-controls");
		this._fileInput = this.shadowRoot.querySelector(".file-input");
		this._urlInput = this.shadowRoot.querySelector(".url-input");
		this._loadBtn = this.shadowRoot.querySelector(".btn-load");
		this._chip = this.shadowRoot.querySelector(".chip");
		this._chipName = this.shadowRoot.querySelector(".chip-name");
		this._chipClear = this.shadowRoot.querySelector(".chip-clear");
		this._errorEl = this.shadowRoot.querySelector(".error");
		this._hint = this.shadowRoot.querySelector(".hint");
		this._loading = false;
	}

	connectedCallback() {
		this._fileInput.addEventListener("change", (e) => this._handleFileUpload(e.target.files[0]));
		this._loadBtn.addEventListener("click", () => this._handleUrlLoad());
		this._urlInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this._handleUrlLoad();
		});
		this._urlInput.addEventListener("input", () => {
			this._loadBtn.disabled = this._loading || !this._urlInput.value.trim();
		});
		this._chipClear.addEventListener("click", () => this._handleClear());

		xmlStore.addEventListener("change", () => this.render());
		this.render();
	}

	_handleFileUpload(file) {
		if (!file) return;
		this._setError("");
		const reader = new FileReader();
		reader.onload = (ev) => {
			const schema = parseXsdSchema(ev.target.result);
			if (schema) {
				xmlStore.setSchema(schema, file.name);
			} else {
				this._setError("Failed to parse schema file");
			}
		};
		reader.readAsText(file);
	}

	async _handleUrlLoad() {
		const url = this._urlInput.value.trim();
		if (!url) return;
		this._loading = true;
		this._setError("");
		this.render();
		try {
			const res = await fetch(url);
			const text = await res.text();
			const schema = parseXsdSchema(text);
			if (schema) {
				xmlStore.setSchema(schema, url.split("/").pop() || "schema.xsd");
			} else {
				this._setError("Failed to parse schema from URL");
			}
		} catch {
			this._setError("Failed to fetch schema from URL");
		}
		this._loading = false;
		this.render();
	}

	_handleClear() {
		this._urlInput.value = "";
		this._setError("");
		xmlStore.clearSchema();
	}

	_setError(message) {
		this._errorEl.hidden = !message;
		this._errorEl.textContent = message;
	}

	render() {
		const hasSchema = xmlStore.schema !== null;
		this._controls.hidden = hasSchema;
		this._chip.hidden = !hasSchema;
		this._hint.hidden = hasSchema;
		if (hasSchema) this._chipName.textContent = xmlStore.schemaFileName;
		this._loadBtn.disabled = this._loading || !this._urlInput.value.trim();
		this._loadBtn.textContent = this._loading ? "..." : "Load";
	}
}

customElements.define("wa-schema-input", WaSchemaInput);
