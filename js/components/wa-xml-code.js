import { xmlStore } from "../xml-editor/xml-store.js";
import { tokenizeXml } from "../xml-editor/xml-tokenizer.js";

// XML source panel (panel 4): line-numbered, syntax-highlighted, editable
// source view, two-way synced with xmlStore. Ported from the XML-editor-DEMO
// Lovable prototype (src/components/XmlCodeEditor.tsx) — same overlay trick
// (transparent textarea on top of a highlighted, non-interactive copy).

const LINE_HEIGHT = 24; // px, matches leading-6 in the original

const colorVarByType = {
	tag: "var(--waw-syntax-tag, #63b3ed)",
	"attr-name": "var(--waw-syntax-attr-name, #f0b25c)",
	"attr-value": "var(--waw-syntax-attr-value, #8fd67a)",
	bracket: "var(--waw-syntax-bracket, #8b93a1)",
	text: "var(--waw-syntax-text, #cfd3da)",
	comment: "var(--waw-syntax-comment, #6b6f78)"
};

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			background: var(--waw-editor-bg, #17191d);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.82rem;
		}
		.editor {
			position: relative;
			display: flex;
			height: 100%;
			overflow: hidden;
		}
		.gutter {
			flex: 0 0 auto;
			background: var(--waw-editor-gutter, #1f232b);
			color: var(--waw-editor-line-number, #6b7280);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			text-align: right;
			user-select: none;
			padding: 0.75rem 0;
			overflow: hidden;
			white-space: pre;
		}
		.gutter div {
			height: ${LINE_HEIGHT}px;
			line-height: ${LINE_HEIGHT}px;
			padding-right: 0.75rem;
		}
		/* .content holds the three perfectly-overlapping layers (line
		   background, syntax highlight, real textarea) so none of them need
		   per-render left-offset math beyond what flex already gives .content. */
		.content {
			position: relative;
			flex: 1 1 auto;
			min-width: 0;
			overflow: hidden;
		}
		.line-bg,
		.highlight {
			position: absolute;
			inset: 0;
			pointer-events: none;
			overflow: hidden;
			white-space: pre;
			line-height: ${LINE_HEIGHT}px;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.line-bg {
			padding: 0.75rem 0;
			z-index: 0;
		}
		.line-bg div {
			height: ${LINE_HEIGHT}px;
		}
		.line-bg div.selected {
			background: rgba(255, 255, 255, 0.08);
		}
		.highlight {
			padding: 0.75rem 0 0.75rem 0.75rem;
			z-index: 1;
		}
		.highlight div {
			height: ${LINE_HEIGHT}px;
		}
		textarea {
			position: relative;
			z-index: 2;
			display: block;
			width: 100%;
			height: 100%;
			background: transparent;
			color: transparent;
			caret-color: var(--waw-editor-cursor, #4fa3ff);
			border: none;
			outline: none;
			resize: none;
			margin: 0;
			padding: 0.75rem 0 0.75rem 0.75rem;
			line-height: ${LINE_HEIGHT}px;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: inherit;
			white-space: pre;
			overflow: auto;
		}
		textarea::selection {
			background: var(--waw-editor-selection, rgba(79, 163, 255, 0.35));
		}
	</style>
	<div class="editor">
		<div class="gutter"></div>
		<div class="content">
			<div class="line-bg"></div>
			<div class="highlight"></div>
			<textarea spellcheck="false"></textarea>
		</div>
	</div>
`;

export class WaXmlCode extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._gutter = this.shadowRoot.querySelector(".gutter");
		this._lineBg = this.shadowRoot.querySelector(".line-bg");
		this._highlight = this.shadowRoot.querySelector(".highlight");
		this._textarea = this.shadowRoot.querySelector("textarea");
		this._isLocalEdit = false;
	}

	connectedCallback() {
		this._textarea.value = xmlStore.codeValue;
		this._renderStaticLayers(xmlStore.codeValue);

		this._textarea.addEventListener("input", () => {
			this._isLocalEdit = true;
			xmlStore.setCodeValue(this._textarea.value);
			this._isLocalEdit = false;
			this._renderStaticLayers(this._textarea.value);
		});

		this._textarea.addEventListener("scroll", () => this._syncScroll());

		this._textarea.addEventListener("keydown", (e) => {
			if (e.key !== "Tab") return;
			e.preventDefault();
			const start = this._textarea.selectionStart;
			const end = this._textarea.selectionEnd;
			const value = this._textarea.value;
			this._textarea.value = `${value.slice(0, start)}  ${value.slice(end)}`;
			this._textarea.selectionStart = this._textarea.selectionEnd = start + 2;
			this._isLocalEdit = true;
			xmlStore.setCodeValue(this._textarea.value);
			this._isLocalEdit = false;
			this._renderStaticLayers(this._textarea.value);
		});

		// Clicking (or moving the caret with arrow keys) into a line selects
		// the XML node that line belongs to, mirroring tree -> code below.
		this._textarea.addEventListener("click", () => this._selectNodeAtCaret());
		this._textarea.addEventListener("keyup", (e) => {
			if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") this._selectNodeAtCaret();
		});

		xmlStore.addEventListener("change", () => {
			if (this._isLocalEdit) return;
			if (this._textarea.value !== xmlStore.codeValue) {
				this._textarea.value = xmlStore.codeValue;
			}
			this._renderStaticLayers(xmlStore.codeValue);
		});
	}

	_renderStaticLayers(value) {
		const lines = value.split("\n");
		const tokenizedLines = tokenizeXml(value);

		this._gutter.innerHTML = "";
		lines.forEach((_, i) => {
			const div = document.createElement("div");
			div.textContent = String(i + 1);
			this._gutter.appendChild(div);
		});
		const gutterWidth = Math.max(40, String(lines.length).length * 10 + 20);
		this._gutter.style.width = `${gutterWidth}px`;

		this._highlight.innerHTML = "";
		tokenizedLines.forEach((lineTokens) => {
			const div = document.createElement("div");
			if (lineTokens.length === 0) {
				div.textContent = " ";
			} else {
				lineTokens.forEach((token) => {
					const span = document.createElement("span");
					span.style.color = colorVarByType[token.type] || colorVarByType.text;
					span.textContent = token.text;
					div.appendChild(span);
				});
			}
			this._highlight.appendChild(div);
		});

		this._renderLineHighlight(lines.length);
		this._syncScroll();
	}

	_renderLineHighlight(lineCount) {
		const range = xmlStore.getLineRange(xmlStore.selectedNodeId);
		this._lineBg.innerHTML = "";
		for (let i = 1; i <= lineCount; i++) {
			const div = document.createElement("div");
			if (range && i >= range.start && i <= range.end) div.classList.add("selected");
			this._lineBg.appendChild(div);
		}
	}

	_selectNodeAtCaret() {
		const upToCaret = this._textarea.value.slice(0, this._textarea.selectionStart);
		const line = upToCaret.split("\n").length;
		const nodeId = xmlStore.getNodeIdAtLine(line);
		if (nodeId && nodeId !== xmlStore.selectedNodeId) xmlStore.selectNode(nodeId);
	}

	_syncScroll() {
		this._gutter.style.transform = `translateY(-${this._textarea.scrollTop}px)`;
		const shift = `translate(-${this._textarea.scrollLeft}px, -${this._textarea.scrollTop}px)`;
		this._highlight.style.transform = shift;
		this._lineBg.style.transform = shift;
	}
}

customElements.define("wa-xml-code", WaXmlCode);
