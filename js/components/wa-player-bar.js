import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import "./wa-var-knobs.js";

// Global transport, in the app header (to the right of the File menu) — per
// Hans, playback is app-wide and independent of whichever Preview panel/view
// happens to be showing (Section, Mixer, ...), so it lives outside all of
// them. PLAY always trig()s whatever the selector field currently holds —
// wa-section-view.js auto-fills that field whenever a different <Section>
// becomes the one being viewed, but it stays a plain editable text input so
// it can be pointed at anything else too. The trigger-shortcut buttons are
// root-level <Command type="trig"> elements — independent one-click presets
// (a Layer, a Stinger, an AudioBufferSourceNode, ...), grouped by a shared
// `class` attribute where one's set.
//
// Note: <Command>'s schema type (commandContentType) doesn't currently
// declare a `class`/`id` attribute (it isn't built on commonNodeAttributes
// the way most waxml elements are) — grouping here just reads
// attributes.class as free-form data regardless, which works fine in
// practice (this app doesn't hard-reject undeclared attributes), but it's
// worth Hans adding `class`/`id` to commandContentType in the schema itself
// for correctness/Inspector support.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.tp-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.55rem;
			font-size: 0.85rem;
			line-height: 1;
			cursor: pointer;
			min-width: 2rem;
		}
		.tp-btn:hover {
			background: #2f333a;
		}
		.tp-btn.active {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #06131f;
		}
		.selector-input {
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.75rem;
			border-radius: 4px;
			padding: 0.25rem 0.45rem;
			width: 11rem;
		}
		.shortcuts {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			flex-wrap: wrap;
		}
		.shortcut-group {
			display: flex;
			align-items: center;
			gap: 0.2rem;
			padding: 0 0.35rem;
			border-left: 1px solid var(--waw-border, #2f2f2f);
		}
		.shortcut-group:first-child {
			border-left: none;
			padding-left: 0;
		}
		.shortcut-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.2rem 0.5rem;
			font-size: 0.75rem;
			cursor: pointer;
			white-space: nowrap;
		}
		.shortcut-btn:hover {
			background: rgba(79, 163, 255, 0.15);
			border-color: var(--waw-accent, #4fa3ff);
		}
	</style>
	<button class="tp-btn tp-play" data-action="play" title="Play">▶</button>
	<button class="tp-btn" data-action="stop" title="Stop">■</button>
	<input type="text" class="selector-input" placeholder="CSS selector to trig" title="What PLAY triggers — auto-fills when a Section is selected, or type your own" />
	<wa-var-knobs></wa-var-knobs>
	<div class="shortcuts"></div>
`;

export class WaPlayerBar extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._playBtn = this.shadowRoot.querySelector('[data-action="play"]');
		this._stopBtn = this.shadowRoot.querySelector('[data-action="stop"]');
		this._selectorInput = this.shadowRoot.querySelector(".selector-input");
		this._shortcuts = this.shadowRoot.querySelector(".shortcuts");
		this._onPlayerChange = this._onPlayerChange.bind(this);
		this._onXmlStoreChange = this._onXmlStoreChange.bind(this);
	}

	connectedCallback() {
		this._playBtn.addEventListener("click", () => playerStore.play());
		this._stopBtn.addEventListener("click", () => playerStore.stop());
		this._selectorInput.addEventListener("change", () => {
			playerStore.setTriggerSelector(this._selectorInput.value, null);
		});
		playerStore.addEventListener("change", this._onPlayerChange);
		xmlStore.addEventListener("change", this._onXmlStoreChange);
		this._onPlayerChange();
		this._renderShortcuts();
	}

	disconnectedCallback() {
		playerStore.removeEventListener("change", this._onPlayerChange);
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
	}

	_onPlayerChange() {
		this._playBtn.classList.toggle("active", playerStore.isPlaying);
		if (this.shadowRoot.activeElement !== this._selectorInput) {
			this._selectorInput.value = playerStore.triggerSelector;
		}
	}

	_onXmlStoreChange() {
		this._renderShortcuts();
	}

	// Root-level <Command type="trig"> elements — grouped by a shared
	// `class` attribute (each distinct class value, in first-seen order,
	// becomes one visually separated cluster); commands without a class sit
	// together as their own leading group.
	_renderShortcuts() {
		this._shortcuts.innerHTML = "";
		if (!xmlStore.root) return;

		const commands = xmlStore.root.children.filter((c) => c.tagName === "Command" && (c.attributes.type || "trig") === "trig" && c.attributes.selector);
		if (commands.length === 0) return;

		const groups = new Map(); // className ("" = ungrouped) -> [commands]
		commands.forEach((cmd) => {
			const key = cmd.attributes.class || "";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(cmd);
		});

		groups.forEach((groupCommands) => {
			const groupEl = document.createElement("div");
			groupEl.className = "shortcut-group";
			groupCommands.forEach((cmd) => {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "shortcut-btn";
				btn.textContent = cmd.attributes.label || cmd.attributes.selector;
				btn.title = `trig(${cmd.attributes.selector})`;
				btn.addEventListener("click", () => playerStore.trigShortcut(cmd.attributes.selector));
				groupEl.appendChild(btn);
			});
			this._shortcuts.appendChild(groupEl);
		});
	}
}

customElements.define("wa-player-bar", WaPlayerBar);
