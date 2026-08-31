import { xmlStore } from "../xml-editor/xml-store.js";
import { mountWamGui } from "../waxml-integration/wam-gui.js";

// Preview-panel state (see wa-preview.js) for a selected <Wam> node — shows
// the plugin's own interface, per wam-insert-effects-instructions.md point
// 6. Stays mounted the whole time (same "always mounted, listens to
// xmlStore itself" shape as wa-section-view.js/wa-mixer-view.js) so
// wa-preview.js only needs to show/hide it.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.header {
			padding: 0.6rem 0.75rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.node-label {
			margin: 0;
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.node-label .tag {
			color: var(--waw-accent, #4fa3ff);
		}
		.src {
			margin: 0.2rem 0 0;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.gui-container {
			height: calc(100% - 3.6rem);
			overflow: auto;
			display: flex;
			align-items: flex-start;
			justify-content: center;
			padding: 0.75rem;
			box-sizing: border-box;
		}
		.wam-gui-status {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin-top: 2rem;
		}
	</style>
	<div class="header">
		<p class="node-label"><span class="tag"></span></p>
		<p class="src"></p>
	</div>
	<div class="gui-container"></div>
`;

export class WaWamView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._tagEl = this.shadowRoot.querySelector(".tag");
		this._srcEl = this.shadowRoot.querySelector(".src");
		this._container = this.shadowRoot.querySelector(".gui-container");
		this._disposeGui = null;
		this._activeNodeId = null;
	}

	connectedCallback() {
		xmlStore.addEventListener("change", () => this._onStoreChange());
		this._onStoreChange();
	}

	disconnectedCallback() {
		this._disposeGui?.();
		this._disposeGui = null;
	}

	_onStoreChange() {
		const node = xmlStore.getSelectedNode();
		if (!node || node.tagName !== "Wam") return; // wa-preview.js only shows us for a <Wam> selection

		this._tagEl.textContent = `<${node.tagName}>`;
		this._srcEl.textContent = node.attributes.src || "(no plugin selected)";

		if (node.id === this._activeNodeId) return; // same plugin instance still selected — don't remount
		this._activeNodeId = node.id;
		this._disposeGui?.();
		// getLiveObjects matches the real XML `id` *attribute* (a CSS-attribute
		// selector against waxml.js's live tree) — node.id is this app's own
		// internal session-local tree id, a different thing entirely (see
		// xml-store.js's own comment on the distinction).
		this._disposeGui = mountWamGui(node.attributes.id, this._container);
	}
}

customElements.define("wa-wam-view", WaWamView);
