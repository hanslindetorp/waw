import "./wa-schema-input.js";
import "./wa-xml-tree.js";
import "./wa-node-inspector.js";

// Graphical XML editor (panel 2): schema bar on top, scrollable tree and the
// attribute inspector splitting the rest of the panel's height 70/30, with a
// draggable divider between them (per Hans, 2026-09-02 — every panel with two
// stacked areas gets one, see also wa-section-view.js's Layer/Stinger split).
// Ported layout from the XML-editor-DEMO Lovable prototype's Index.tsx left
// column + top schema bar, combined into one panel per Hans's instruction.

const MIN_AREA_HEIGHT = 60;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 0;
		}
		.tree-scroll {
			/* flex-grow ratio 7:3 (see wa-node-inspector below) — not a
			   percentage flex-basis, which would be relative to the whole
			   host including wa-schema-input's own height above, not just
			   the space actually left over for these two. Replaced with a
			   fixed pixel basis once the user drags .xml-divider (see
			   _onDividerMove) so a manual split survives future re-renders. */
			flex: 7 1 0%;
			min-height: 0;
			overflow: auto;
		}
		.xml-divider {
			flex: 0 0 6px;
			cursor: row-resize;
		}
		wa-node-inspector {
			flex: 3 1 0%;
			min-height: 0;
			overflow: auto;
		}
	</style>
	<wa-schema-input></wa-schema-input>
	<div class="tree-scroll">
		<wa-xml-tree></wa-xml-tree>
	</div>
	<div class="xml-divider"></div>
	<wa-node-inspector></wa-node-inspector>
`;

export class WaXmlEditor extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._treeScroll = this.shadowRoot.querySelector(".tree-scroll");
		this._inspector = this.shadowRoot.querySelector("wa-node-inspector");
		this._divider = this.shadowRoot.querySelector(".xml-divider");
		this._onDividerMove = this._onDividerMove.bind(this);
		this._onDividerEnd = this._onDividerEnd.bind(this);
	}

	connectedCallback() {
		this._divider.addEventListener("pointerdown", (e) => this._onDividerStart(e));
	}

	_onDividerStart(e) {
		e.preventDefault();
		this._dragStartY = e.clientY;
		this._dragStartTreeHeight = this._treeScroll.getBoundingClientRect().height;
		this._dragStartInspectorHeight = this._inspector.getBoundingClientRect().height;
		window.addEventListener("pointermove", this._onDividerMove);
		window.addEventListener("pointerup", this._onDividerEnd);
	}

	_onDividerMove(e) {
		const delta = e.clientY - this._dragStartY;
		const treeHeight = Math.max(MIN_AREA_HEIGHT, this._dragStartTreeHeight + delta);
		const inspectorHeight = Math.max(MIN_AREA_HEIGHT, this._dragStartInspectorHeight - delta);
		this._treeScroll.style.flex = `0 0 ${treeHeight}px`;
		this._inspector.style.flex = `0 0 ${inspectorHeight}px`;
	}

	_onDividerEnd() {
		window.removeEventListener("pointermove", this._onDividerMove);
		window.removeEventListener("pointerup", this._onDividerEnd);
	}
}

customElements.define("wa-xml-editor", WaXmlEditor);
