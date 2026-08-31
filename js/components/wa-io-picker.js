// Popup "pick a routing target" tree — opened by clicking an "output" or
// "input" attribute's value (see wa-node-inspector.js's
// _renderIoSelectorControl), per Hans (2026-08-31). Used imperatively:
// `const picked = await openIoPicker(tree, anchorRect);` resolves with the
// chosen "#id" string, or null if dismissed without picking anything.
//
// Anchored near the control that opened it (like a dropdown menu), not a
// centered modal — matches "popup menu" in Hans's own wording, and the
// expand/collapse rows deliberately mirror wa-xml-tree.js's own ▸/▾
// convention ("öppnar och stänger sina behållare som vanligt").

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
		}
		.popup {
			position: absolute;
			min-width: 14rem;
			max-width: 22rem;
			max-height: 60vh;
			overflow-y: auto;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
			padding: 0.3rem;
		}
		.empty-status {
			color: var(--waw-muted, #8a8a8a);
			padding: 0.4rem 0.6rem;
		}
		.io-node {
			display: flex;
			flex-direction: column;
		}
		.io-row {
			display: flex;
			align-items: center;
			gap: 0.2rem;
			border-radius: 4px;
			padding: 0.15rem 0.3rem;
		}
		.io-row.selectable {
			cursor: pointer;
		}
		.io-row.selectable:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.io-toggle {
			background: none;
			border: none;
			color: inherit;
			cursor: pointer;
			flex: 0 0 auto;
			width: 1.1rem;
			padding: 0;
			font-size: 0.75rem;
		}
		.io-toggle-spacer {
			display: inline-block;
			width: 1.1rem;
			flex: 0 0 auto;
		}
		.io-id {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.io-row:not(.selectable) .io-id {
			color: var(--waw-muted, #8a8a8a);
			font-style: italic;
		}
		.io-tag {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.72rem;
			flex: 0 0 auto;
		}
		.io-children {
			margin-left: 1.1rem;
		}
	</style>
	<div class="backdrop"></div>
	<div class="popup"><div class="tree-root"></div></div>
`;

class WaIoPicker extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._popup = this.shadowRoot.querySelector(".popup");
		this._treeRoot = this.shadowRoot.querySelector(".tree-root");
		this._resolve = null;
	}

	// tree: the buildRoutingTree() result (or null). anchorRect: a
	// getBoundingClientRect()-shaped object to position the popup near.
	setup(tree, anchorRect) {
		if (!tree) {
			const empty = document.createElement("p");
			empty.className = "empty-status";
			empty.textContent = "No available targets.";
			this._treeRoot.appendChild(empty);
		} else {
			// The root of the tree is almost always just the document root
			// itself (never selectable, id-less) — render its children
			// directly rather than one redundant always-open top-level row.
			tree.children.forEach((child) => this._treeRoot.appendChild(this._renderNode(child)));
			if (tree.children.length === 0) {
				const empty = document.createElement("p");
				empty.className = "empty-status";
				empty.textContent = "No available targets.";
				this._treeRoot.appendChild(empty);
			}
		}
		this._positionNear(anchorRect);
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".backdrop").addEventListener("click", () => this._finish(null));
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._finish(null);
		};
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

	_renderNode(node) {
		const wrapper = document.createElement("div");
		wrapper.className = "io-node";

		const row = document.createElement("div");
		row.className = "io-row" + (node.selectable ? " selectable" : "");

		const hasChildren = node.children.length > 0;
		const childrenEl = document.createElement("div");
		childrenEl.className = "io-children";
		node.children.forEach((child) => childrenEl.appendChild(this._renderNode(child)));

		if (hasChildren) {
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "io-toggle";
			toggle.textContent = "▾";
			toggle.title = "Expand/collapse";
			toggle.addEventListener("click", (e) => {
				e.stopPropagation();
				const collapsed = childrenEl.hidden;
				childrenEl.hidden = !collapsed;
				toggle.textContent = collapsed ? "▾" : "▸";
			});
			row.appendChild(toggle);
		} else {
			const spacer = document.createElement("span");
			spacer.className = "io-toggle-spacer";
			row.appendChild(spacer);
		}

		const idSpan = document.createElement("span");
		idSpan.className = "io-id";
		idSpan.textContent = node.id || node.tagName;
		row.appendChild(idSpan);

		if (node.id) {
			const tagSpan = document.createElement("span");
			tagSpan.className = "io-tag";
			tagSpan.textContent = node.tagName;
			row.appendChild(tagSpan);
		}

		if (node.selectable) {
			row.title = `Route to #${node.id}`;
			row.addEventListener("click", () => this._finish(`#${node.id}`));
		}

		wrapper.appendChild(row);
		wrapper.appendChild(childrenEl);
		return wrapper;
	}

	_positionNear(anchorRect) {
		// Measure after the popup has real content, then clamp inside the
		// viewport — a deep tree opened near the bottom/right edge shouldn't
		// render partly off-screen.
		requestAnimationFrame(() => {
			const rect = this._popup.getBoundingClientRect();
			let left = anchorRect?.left ?? 0;
			let top = anchorRect?.bottom ?? 0;
			left = Math.min(left, window.innerWidth - rect.width - 8);
			left = Math.max(8, left);
			top = Math.min(top, window.innerHeight - rect.height - 8);
			top = Math.max(8, top);
			this._popup.style.left = `${left}px`;
			this._popup.style.top = `${top}px`;
		});
	}

	_finish(value) {
		this._resolve?.(value);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-io-picker", WaIoPicker);

export function openIoPicker(tree, anchorRect) {
	const picker = document.createElement("wa-io-picker");
	document.body.appendChild(picker);
	picker.setup(tree, anchorRect);
	return picker.whenDone();
}
