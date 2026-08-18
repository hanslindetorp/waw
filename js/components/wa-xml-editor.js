import "./wa-schema-input.js";
import "./wa-xml-tree.js";
import "./wa-node-inspector.js";

// Graphical XML editor (panel 2): schema bar on top, scrollable tree in the
// middle, inspector docked at the bottom (max 40% of the panel's height).
// Ported layout from the XML-editor-DEMO Lovable prototype's Index.tsx left
// column + top schema bar, combined into one panel per Hans's instruction.

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
			flex: 1 1 auto;
			min-height: 0;
			overflow: auto;
		}
		wa-node-inspector {
			flex: 0 0 auto;
			max-height: 40%;
			overflow: auto;
		}
	</style>
	<wa-schema-input></wa-schema-input>
	<div class="tree-scroll">
		<wa-xml-tree></wa-xml-tree>
	</div>
	<wa-node-inspector></wa-node-inspector>
`;

export class WaXmlEditor extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
	}
}

customElements.define("wa-xml-editor", WaXmlEditor);
