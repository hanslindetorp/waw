// A small, general color picker: a swatch button that opens a palette of
// ready-made colors plus a "Custom…" entry (the browser's own color input).
// Made for the INPUT panel's mappings (see wa-webcam-input.js) but meant to
// be used anywhere the app lets the user pick a color.
//
//   <wa-color-picker value="#4fa3ff"></wa-color-picker>
//
// Fires a bubbling, composed "change" event ({ detail: { value } }) when the
// user picks a color; `value` (property or attribute) is the current color as
// "#rrggbb".

export const COLOR_PALETTE = [
	"#ff5d73",
	"#ff9f43",
	"#ffd166",
	"#7bd88f",
	"#2ec4b6",
	"#4fa3ff",
	"#9b7bff",
	"#e56bd8",
	"#c0e218",
	"#00d2d3",
	"#f368e0",
	"#ffffff"
];

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: inline-block;
			line-height: 0;
		}
		.swatch {
			width: 18px;
			height: 18px;
			padding: 0;
			border-radius: 50%;
			border: 2px solid rgba(255, 255, 255, 0.55);
			background: var(--color, #4fa3ff);
			cursor: pointer;
		}
		.swatch:hover {
			border-color: #fff;
		}
		.popover {
			position: fixed;
			z-index: 200;
			display: grid;
			grid-template-columns: repeat(6, 20px);
			gap: 6px;
			padding: 8px;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		}
		.popover[hidden] {
			display: none;
		}
		.choice {
			width: 20px;
			height: 20px;
			padding: 0;
			border-radius: 50%;
			border: 2px solid transparent;
			cursor: pointer;
		}
		.choice:hover,
		.choice.current {
			border-color: #fff;
		}
		.custom {
			grid-column: 1 / -1;
			display: flex;
			align-items: center;
			gap: 6px;
			color: var(--waw-muted, #8a8a8a);
			font: 0.7rem system-ui, sans-serif;
			line-height: 1.2;
		}
		.custom input {
			width: 28px;
			height: 22px;
			padding: 0;
			border: none;
			background: none;
			cursor: pointer;
		}
	</style>
	<button class="swatch" type="button" title="Color"></button>
	<div class="popover" hidden></div>
`;

class WaColorPicker extends HTMLElement {
	static get observedAttributes() {
		return ["value"];
	}

	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._swatch = this.shadowRoot.querySelector(".swatch");
		this._popover = this.shadowRoot.querySelector(".popover");
		this._value = "#4fa3ff";
		this._onDocumentPointerDown = (e) => {
			if (!e.composedPath().includes(this)) this._close();
		};
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._close();
		};
	}

	connectedCallback() {
		this._swatch.addEventListener("click", (e) => {
			e.stopPropagation();
			this._popover.hidden ? this._open() : this._close();
		});
		// A click on the swatch is the picker's own business — it must not also
		// select whatever row or card the picker sits in.
		this.addEventListener("click", (e) => e.stopPropagation());
		this._render();
	}

	disconnectedCallback() {
		this._close();
	}

	attributeChangedCallback(name, _old, value) {
		if (name === "value" && value) {
			this._value = value;
			this._render();
		}
	}

	get value() {
		return this._value;
	}

	set value(v) {
		if (!v) return;
		this._value = v;
		this._render();
	}

	_render() {
		this._swatch.style.setProperty("--color", this._value);
	}

	_open() {
		this._popover.innerHTML = "";
		COLOR_PALETTE.forEach((color) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "choice" + (color.toLowerCase() === this._value.toLowerCase() ? " current" : "");
			b.style.background = color;
			b.title = color;
			b.addEventListener("click", () => this._pick(color));
			this._popover.appendChild(b);
		});
		const custom = document.createElement("label");
		custom.className = "custom";
		custom.textContent = "Custom…";
		const input = document.createElement("input");
		input.type = "color";
		input.value = /^#[0-9a-f]{6}$/i.test(this._value) ? this._value : "#4fa3ff";
		input.addEventListener("input", () => this._pick(input.value, false));
		input.addEventListener("change", () => this._close());
		custom.appendChild(input);
		this._popover.appendChild(custom);

		const rect = this._swatch.getBoundingClientRect();
		this._popover.hidden = false;
		const width = this._popover.offsetWidth;
		const height = this._popover.offsetHeight;
		this._popover.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, rect.left))}px`;
		this._popover.style.top = `${rect.bottom + height + 8 > window.innerHeight ? Math.max(4, rect.top - height - 4) : rect.bottom + 4}px`;
		document.addEventListener("pointerdown", this._onDocumentPointerDown, true);
		document.addEventListener("keydown", this._onKeyDown, true);
	}

	_close() {
		this._popover.hidden = true;
		document.removeEventListener("pointerdown", this._onDocumentPointerDown, true);
		document.removeEventListener("keydown", this._onKeyDown, true);
	}

	_pick(color, close = true) {
		this._value = color;
		this._render();
		this.dispatchEvent(new CustomEvent("change", { detail: { value: color }, bubbles: true, composed: true }));
		if (close) this._close();
	}
}

customElements.define("wa-color-picker", WaColorPicker);
