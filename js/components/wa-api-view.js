import { xmlStore } from "../xml-editor/xml-store.js";

// How a published WAXML project (see wa-library-view.js's Library (DEMO)
// sketch) gets embedded into someone else's web app. Per Hans (2026-09-11):
// four parts — instructions, the <script> tag to paste into a host page,
// HTML attributes for a no-JS integration, and the JavaScript API — with the
// attribute/JS-call listings generated live from the *real* open project's
// root-level <Command type="trig"> and <Var> elements (same filtering
// wa-player-bar.js's own shortcuts/knobs use), so this page never drifts out
// of sync with what a host app could actually call. Originally its own
// top-level "API" view; now shown inside the File menu's "Share..." dialog
// instead (see wa-share-dialog.js), per Hans (2026-09-13) — this component
// itself is unchanged either way, just re-parented.

function rootTrigCommands(root) {
	if (!root) return [];
	return root.children.filter((c) => c.tagName === "Command" && (c.attributes.type || "trig") === "trig" && c.attributes.value);
}

function rootVars(root) {
	if (!root) return [];
	return root.children.filter((c) => c.tagName === "Var" && (c.attributes.name || c.attributes.id));
}

// A code line is an array of segments — {text} for plain text, or
// {text, placeholder: true} for a fill-in-yourself part (rendered in
// italics, e.g. the value half of a "set" call — per Hans, 2026-09-11: a
// <Var> only carries a *name*, never a fixed value to set it to, so that
// part can only ever be a placeholder for the host developer to supply).
// `plainLine` wraps an already-complete line (nothing to italicize) in the
// same shape so _buildCodeBlock only has to handle one format.
function plainLine(text) {
	return [{ text }];
}

function withPlaceholder(before, placeholderText, after = "") {
	const parts = [{ text: before }, { text: placeholderText, placeholder: true }];
	if (after) parts.push({ text: after });
	return parts;
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			flex: 1 1 auto;
			min-height: 0;
			overflow: auto;
			background: var(--waw-bg, #121212);
		}
		:host([hidden]) {
			display: none;
		}
		.api-content {
			max-width: 46rem;
			margin: 0 auto;
			padding: 2.5rem 2rem 4rem;
			font: 0.9rem/1.6 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		.api-content h2 {
			margin: 0 0 1rem;
			font-size: 1.4rem;
		}
		.api-content h3 {
			margin: 0 0 0.6rem;
			font-size: 1.05rem;
		}
		.api-content p {
			margin: 0 0 1rem;
		}
		.api-content ol {
			margin: 0 0 1rem;
			padding-left: 1.4rem;
		}
		.api-content li {
			margin: 0.3rem 0;
		}
		.api-content code {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.85em;
			background: rgba(255, 255, 255, 0.08);
			padding: 0.05rem 0.3rem;
			border-radius: 3px;
		}
		.api-divider {
			margin: 2rem 0;
			border: none;
			border-top: 1px solid var(--waw-border, #2f2f2f);
		}
		.api-section {
			margin-bottom: 2rem;
		}
		.api-code-block {
			position: relative;
			margin: 0 0 0.9rem;
		}
		.api-code {
			margin: 0;
			background: var(--waw-editor-bg, #17191d);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			padding: 0.75rem 1rem;
			padding-right: 4rem;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.82rem;
			line-height: 1.6;
			overflow-x: auto;
			white-space: pre;
			color: var(--waw-syntax-text, #cfd3da);
		}
		.api-code .empty {
			color: var(--waw-muted, #8a8a8a);
			font-style: italic;
		}
		/* Marks a fill-in-yourself part of a line (e.g. "value" in a set
		   call) — per Hans (2026-09-11): italic, not a different color,
		   since it's still real syntax, just a placeholder for whatever the
		   host developer's own value expression is. */
		.api-code .placeholder {
			font-style: italic;
			color: var(--waw-syntax-attr-value, #8fd67a);
		}
		.copy-btn {
			position: absolute;
			top: 0.5rem;
			right: 0.5rem;
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.2rem 0.5rem;
			font-size: 0.7rem;
			cursor: pointer;
		}
		.copy-btn:hover {
			background: #2f333a;
		}
		.copy-btn.copied {
			border-color: var(--waw-success, #4caf7d);
			color: var(--waw-success, #4caf7d);
		}
	</style>
	<div class="api-content">
		<h2>API</h2>
		<p>To implement a WAXML project into a web based application, you need to:</p>
		<ol>
			<li>Save your project and place it in the root of your web project.</li>
			<li>Copy the HTML code below at the bottom of the <code>&lt;body&gt;</code> element in the HTML document.</li>
			<li>Use the Javascript API to trigger different objects in WAXML and to set variables.</li>
			<li>You can also use the HTML attributes below for triggers and variables without having to touch javascript at all.</li>
		</ol>
		<hr class="api-divider" />
		<div class="api-examples">
			<section class="api-section">
				<h3>HTML code</h3>
				<p>Paste this at the bottom of the <code>&lt;body&gt;</code> element in your HTML document:</p>
				<div class="html-code-slot"></div>
			</section>
			<section class="api-section">
				<h3>HTML attributes</h3>
				<p>You can add attributes to HTML elements that pick up events and trigger WAXML objects or set Variable values, in the following way:</p>
				<div class="trig-attrs-slot"></div>
				<div class="set-attrs-slot"></div>
			</section>
			<section class="api-section">
				<h3>JavaScript API</h3>
				<div class="trig-js-slot"></div>
				<div class="set-js-slot"></div>
			</section>
		</div>
	</div>
`;

export class WaApiView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._htmlCodeSlot = this.shadowRoot.querySelector(".html-code-slot");
		this._trigAttrsSlot = this.shadowRoot.querySelector(".trig-attrs-slot");
		this._setAttrsSlot = this.shadowRoot.querySelector(".set-attrs-slot");
		this._trigJsSlot = this.shadowRoot.querySelector(".trig-js-slot");
		this._setJsSlot = this.shadowRoot.querySelector(".set-js-slot");
		this._onStoreChange = () => this._render();
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onStoreChange);
	}

	_render() {
		this._htmlCodeSlot.replaceChildren(
			this._buildCodeBlock([plainLine(`<script src="waxml.js" data-source="[path to the main wa.xml document in the project]" />`)])
		);

		const commands = rootTrigCommands(xmlStore.root);
		const vars = rootVars(xmlStore.root);
		const varName = (v) => v.attributes.name || v.attributes.id;

		this._trigAttrsSlot.replaceChildren(
			this._buildCodeBlock(
				commands.length ? commands.map((c) => plainLine(`<a data-waxml-click-trig="${c.attributes.value}" />`)) : null,
				"No <Command type=\"trig\"> elements at the document root yet."
			)
		);
		this._setAttrsSlot.replaceChildren(
			this._buildCodeBlock(
				// A <Var> only carries a name — the value half is always a
				// placeholder for the host developer to fill in themselves.
				vars.length ? vars.map((v) => withPlaceholder(`<a data-waxml-click-set="${varName(v)}=`, "value", `" />`)) : null,
				"No <Var> elements at the document root yet."
			)
		);
		this._trigJsSlot.replaceChildren(
			this._buildCodeBlock(
				commands.length ? commands.map((c) => plainLine(`waxml.trig("${c.attributes.value}")`)) : null,
				"No <Command type=\"trig\"> elements at the document root yet."
			)
		);
		this._setJsSlot.replaceChildren(
			this._buildCodeBlock(
				vars.length ? vars.map((v) => withPlaceholder(`waxml.set("${varName(v)}", `, "value", `)`)) : null,
				"No <Var> elements at the document root yet."
			)
		);
	}

	// `lines` is an array of segment-arrays (see plainLine/withPlaceholder
	// above), or null/empty to show `emptyMessage` instead (no copy button —
	// nothing useful to copy). Built as real DOM text/elements (never
	// innerHTML) so a Command's own `value`/Var's `name` — user-authored XML
	// attribute text — can never be interpreted as markup, however it's
	// spelled.
	_buildCodeBlock(lines, emptyMessage) {
		const wrap = document.createElement("div");
		wrap.className = "api-code-block";
		const pre = document.createElement("pre");
		pre.className = "api-code";

		if (!lines || lines.length === 0) {
			const span = document.createElement("span");
			span.className = "empty";
			span.textContent = emptyMessage || "Nothing to show yet.";
			pre.appendChild(span);
			wrap.appendChild(pre);
			return wrap;
		}

		lines.forEach((parts, i) => {
			parts.forEach((part) => {
				if (part.placeholder) {
					const em = document.createElement("em");
					em.className = "placeholder";
					em.textContent = part.text;
					pre.appendChild(em);
				} else {
					pre.appendChild(document.createTextNode(part.text));
				}
			});
			if (i < lines.length - 1) pre.appendChild(document.createTextNode("\n"));
		});

		// The copy button copies plain text (placeholder segments included
		// verbatim, no italics) — the host developer still needs to replace
		// it with a real value either way.
		const plainText = lines.map((parts) => parts.map((p) => p.text).join("")).join("\n");
		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "copy-btn";
		copyBtn.textContent = "Copy";
		copyBtn.addEventListener("click", () => this._copy(plainText, copyBtn));
		wrap.appendChild(copyBtn);
		wrap.appendChild(pre);
		return wrap;
	}

	async _copy(text, btn) {
		try {
			await navigator.clipboard.writeText(text);
			btn.textContent = "Copied!";
			btn.classList.add("copied");
			setTimeout(() => {
				btn.textContent = "Copy";
				btn.classList.remove("copied");
			}, 1200);
		} catch {
			// Clipboard access can be denied/unavailable (e.g. no secure
			// context) — the code is still right there to select by hand, so
			// this is never worth surfacing as an error.
		}
	}
}

customElements.define("wa-api-view", WaApiView);
