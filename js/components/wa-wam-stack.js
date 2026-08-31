import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { mountWamGui } from "../waxml-integration/wam-gui.js";

// "All this channel's insert effects, stacked in order" window — opened by
// double-clicking a filled insert slot in the Mixer, per
// wam-insert-effects-instructions.md point 5. Used imperatively:
// `openWamStack(chainNodeId)`. Tracks the chain live (re-renders if inserts
// are added/removed/reordered while open) rather than freezing the list at
// open time.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
			display: flex;
			align-items: center;
			justify-content: center;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.55);
		}
		.panel {
			position: relative;
			width: min(40rem, 92vw);
			height: min(40rem, 86vh);
			background: var(--waw-panel-bg, #1a1a1a);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			padding: 0.7rem 1rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.panel-header h2 {
			margin: 0;
			font-size: 0.95rem;
			font-weight: 600;
		}
		.close-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			font-size: 1.1rem;
			line-height: 1;
			cursor: pointer;
			padding: 0.2rem 0.4rem;
		}
		.close-btn:hover {
			color: var(--waw-fg, #e8e8e8);
		}
		.body {
			flex: 1 1 auto;
			overflow-y: auto;
			padding: 0.6rem;
		}
		.empty-status {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin-top: 2rem;
		}
		.wam-block {
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			margin-bottom: 0.6rem;
			overflow: hidden;
		}
		.wam-block-header {
			padding: 0.4rem 0.6rem;
			background: #202020;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			font-weight: 600;
			font-size: 0.8rem;
			cursor: pointer;
		}
		.wam-block-gui {
			padding: 0.6rem;
			display: flex;
			justify-content: center;
		}
		.wam-gui-status {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin: 1rem 0;
		}
	</style>
	<div class="backdrop"></div>
	<div class="panel" role="dialog" aria-label="Insert effects">
		<div class="panel-header">
			<h2>Insert effects</h2>
			<button class="close-btn" type="button" title="Close">✕</button>
		</div>
		<div class="body"></div>
	</div>
`;

class WaWamStack extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._body = this.shadowRoot.querySelector(".body");
		this._chainNodeId = null;
		this._disposers = [];
	}

	// Call right after appending to the DOM — split from connectedCallback so
	// the caller can set the target chain before the first render.
	open(chainNodeId) {
		this._chainNodeId = chainNodeId;
		this._render();
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".backdrop").addEventListener("click", () => this._close());
		this.shadowRoot.querySelector(".close-btn").addEventListener("click", () => this._close());
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._close();
		};
		document.addEventListener("keydown", this._onKeyDown);
		this._onStoreChange = () => this._render();
		xmlStore.addEventListener("change", this._onStoreChange);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
		xmlStore.removeEventListener("change", this._onStoreChange);
		this._disposers.forEach((dispose) => dispose());
		this._disposers = [];
	}

	_close() {
		this.remove();
	}

	_render() {
		const chainNode = ops.findNodeById(xmlStore.root, this._chainNodeId);
		const wams = chainNode ? chainNode.children.filter((c) => c.tagName === "Wam") : [];

		this._disposers.forEach((dispose) => dispose());
		this._disposers = [];
		this._body.textContent = "";

		if (wams.length === 0) {
			const empty = document.createElement("p");
			empty.className = "empty-status";
			empty.textContent = "No insert effects on this channel.";
			this._body.appendChild(empty);
			this._close(); // the last insert was just removed while this was open
			return;
		}

		wams.forEach((wam) => {
			const block = document.createElement("div");
			block.className = "wam-block";

			const header = document.createElement("div");
			header.className = "wam-block-header";
			header.textContent = wam.attributes.label || (wam.attributes.src ? wam.attributes.src.split("/").pop() : "WAM");
			header.title = "Select in the XML editor";
			header.addEventListener("click", () => xmlStore.selectNode(wam.id));
			block.appendChild(header);

			const guiContainer = document.createElement("div");
			guiContainer.className = "wam-block-gui";
			block.appendChild(guiContainer);

			// getLiveObjects matches the real XML `id` attribute, not this
			// app's internal tree id — see wa-wam-view.js's own note on this.
			this._disposers.push(mountWamGui(wam.attributes.id, guiContainer));
			this._body.appendChild(block);
		});
	}
}

customElements.define("wa-wam-stack", WaWamStack);

export function openWamStack(chainNodeId) {
	const stack = document.createElement("wa-wam-stack");
	document.body.appendChild(stack);
	stack.open(chainNodeId);
}
