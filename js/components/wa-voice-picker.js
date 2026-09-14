// Popup "pick a voice" menu — opened by clicking the `voice` attribute's
// control (see wa-node-inspector.js's _renderVoiceControl), per Hans
// (2026-09-15): every `<Layer>`/`<Stinger>`/etc. sharing the same `voice`
// value get treated as one monophonic instrument (see the schema's own
// "voice" type doc), so picking from what's already used elsewhere in the
// document — rather than retyping it by hand each time and risking a typo
// that silently creates a second, unrelated voice group — is the point.
//
// Used imperatively, same shape as wa-io-picker.js:
// `const picked = await openVoicePicker(existingVoices, anchorRect);`
// resolves with the chosen (or newly typed) voice name, or null if dismissed
// without picking anything.

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
			min-width: 12rem;
			max-width: 20rem;
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
		.voice-row {
			display: flex;
			align-items: center;
			gap: 0.3rem;
			border-radius: 4px;
			padding: 0.3rem 0.5rem;
			cursor: pointer;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.voice-row:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.voice-row.new-voice {
			color: var(--waw-accent, #4fa3ff);
			font-family: inherit;
			font-style: italic;
		}
		.divider {
			height: 1px;
			background: var(--waw-border, #2f2f2f);
			margin: 0.25rem 0.1rem;
		}
		.new-voice-input {
			display: flex;
			gap: 0.3rem;
			padding: 0.2rem;
		}
		.new-voice-input input {
			flex: 1 1 auto;
			min-width: 0;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			background: #0c0c0c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			color: inherit;
			padding: 0.2rem 0.4rem;
		}
	</style>
	<div class="backdrop"></div>
	<div class="popup"><div class="menu-root"></div></div>
`;

class WaVoicePicker extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._popup = this.shadowRoot.querySelector(".popup");
		this._menuRoot = this.shadowRoot.querySelector(".menu-root");
		this._resolve = null;
	}

	// existingVoices: array of distinct voice names already used anywhere in
	// the document (any order — sorted here). anchorRect: a
	// getBoundingClientRect()-shaped object to position the popup near.
	setup(existingVoices, anchorRect) {
		this._anchorRect = anchorRect;
		this._renderMenu(existingVoices);
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

	_renderMenu(existingVoices) {
		this._menuRoot.innerHTML = "";

		const newVoiceRow = document.createElement("div");
		newVoiceRow.className = "voice-row new-voice";
		newVoiceRow.textContent = "New Voice...";
		newVoiceRow.addEventListener("click", () => this._showNewVoiceInput());
		this._menuRoot.appendChild(newVoiceRow);

		const sorted = [...new Set(existingVoices)].sort((a, b) => a.localeCompare(b));
		if (sorted.length === 0) {
			const empty = document.createElement("p");
			empty.className = "empty-status";
			empty.textContent = "No voices used yet.";
			this._menuRoot.appendChild(empty);
			return;
		}

		const divider = document.createElement("div");
		divider.className = "divider";
		this._menuRoot.appendChild(divider);

		sorted.forEach((name) => {
			const row = document.createElement("div");
			row.className = "voice-row";
			row.textContent = name;
			row.addEventListener("click", () => this._finish(name));
			this._menuRoot.appendChild(row);
		});
	}

	_showNewVoiceInput() {
		this._menuRoot.innerHTML = "";
		const wrap = document.createElement("div");
		wrap.className = "new-voice-input";
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Voice name...";
		wrap.appendChild(input);
		this._menuRoot.appendChild(wrap);
		input.focus();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				if (input.value.trim()) this._finish(input.value.trim());
			}
		});
		this._positionNear(this._anchorRect);
	}

	_positionNear(anchorRect) {
		// Measure after the popup has real content, then clamp inside the
		// viewport — same reasoning as wa-io-picker.js's own _positionNear.
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

customElements.define("wa-voice-picker", WaVoicePicker);

export function openVoicePicker(existingVoices, anchorRect) {
	const picker = document.createElement("wa-voice-picker");
	document.body.appendChild(picker);
	picker.setup(existingVoices, anchorRect);
	return picker.whenDone();
}
