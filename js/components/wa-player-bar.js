import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { isEditableContext } from "../project/edit-history.js";
import "./wa-var-knobs.js";

// Global transport, in the app header (to the right of the File menu) — per
// Hans, playback is app-wide and independent of whichever Preview panel/view
// happens to be showing (Section, Mixer, ...), so it lives outside all of
// them. PLAY always trig()s whatever the selector field currently holds —
// wa-section-view.js/wa-composition-view.js auto-fill that field whenever a
// different <Section> becomes the one being viewed or gets explicitly
// trig()'d some other way (see playerStore.trigShortcut, 2026-09-09: every
// trig, however it happens, is reflected here), but it stays a plain
// editable text input so it can be pointed at anything else too. The
// trigger-shortcut buttons are root-level <Command type="trig"> elements —
// independent one-click presets (a Layer, a Stinger, an
// AudioBufferSourceNode, ...), grouped by a shared `class` attribute where
// one's set. The "+" button next to the selector field creates a new one of
// those from whatever the field currently holds.

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
		.tp-btn:disabled {
			opacity: 0.4;
			cursor: default;
		}
		/* A brief pulse ring on every actual trig — per Hans (2026-09-09): so
		   clicking PLAY (even while already .active, e.g. re-triggering the
		   same selector) visibly confirms a trig was really sent, distinct
		   from the .active background's own persistent "is playing" state.
		   Shared by PLAY and every shortcut-btn now (2026-09-10) — same
		   confirmation on any actual trig, wherever it's fired from. Layered
		   as a box-shadow (not a background swap) so it reads the same
		   regardless of .active/.selected/disabled. Retriggered in JS by
		   removing+reflowing+re-adding the class (see _blink), since
		   re-adding an already-present class alone wouldn't restart the
		   animation. */
		@keyframes tp-trig-blink {
			0% {
				box-shadow: 0 0 0 3px rgba(79, 163, 255, 0.9);
			}
			100% {
				box-shadow: 0 0 0 3px rgba(79, 163, 255, 0);
			}
		}
		.blink {
			animation: tp-trig-blink 0.35s ease-out;
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
		.bar-divider {
			flex: 0 0 auto;
			width: 1px;
			height: 1.3rem;
			background: var(--waw-border, #2f2f2f);
		}
		.bar-label {
			flex: 0 0 auto;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		.add-shortcut-btn,
		.add-var-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.25rem 0.5rem;
			font-size: 0.85rem;
			line-height: 1;
			cursor: pointer;
		}
		.add-shortcut-btn:hover,
		.add-var-btn:hover {
			background: #2f333a;
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
		.shortcut-btn.selected {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #06131f;
		}
	</style>
	<button class="tp-btn tp-play" data-action="play" title="Play">▶</button>
	<button class="tp-btn" data-action="stop" title="Stop">■</button>
	<input type="text" class="selector-input" placeholder="CSS selector to trig" title="What PLAY triggers — auto-fills whenever anything gets trig()'d, or type your own" />
	<div class="bar-divider"></div>
	<span class="bar-label">Triggers:</span>
	<button class="add-shortcut-btn" type="button" title="Save the current selector as a trigger-shortcut Command">+</button>
	<div class="shortcuts"></div>
	<div class="bar-divider"></div>
	<span class="bar-label">Variables:</span>
	<button class="add-var-btn" type="button" title="Add a new <Var>">+</button>
	<wa-var-knobs></wa-var-knobs>
`;

export class WaPlayerBar extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._playBtn = this.shadowRoot.querySelector('[data-action="play"]');
		this._stopBtn = this.shadowRoot.querySelector('[data-action="stop"]');
		this._selectorInput = this.shadowRoot.querySelector(".selector-input");
		this._addShortcutBtn = this.shadowRoot.querySelector(".add-shortcut-btn");
		this._addVarBtn = this.shadowRoot.querySelector(".add-var-btn");
		this._shortcuts = this.shadowRoot.querySelector(".shortcuts");
		this._onPlayerChange = this._onPlayerChange.bind(this);
		this._onXmlStoreChange = this._onXmlStoreChange.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
	}

	connectedCallback() {
		// A blink confirms an actual trig was sent, even when the selector
		// (or isPlaying/.active state) doesn't visibly change — e.g.
		// re-pressing PLAY on the same already-playing selector. Per Hans
		// (2026-09-09).
		this._playBtn.addEventListener("click", () => {
			this._blink(this._playBtn);
			playerStore.play();
		});
		this._stopBtn.addEventListener("click", () => playerStore.stop());
		this._selectorInput.addEventListener("change", () => {
			playerStore.setTriggerSelector(this._selectorInput.value, null);
		});
		this._addShortcutBtn.addEventListener("click", () => this._addShortcutCommand());
		this._addVarBtn.addEventListener("click", () => this._addVarElement());
		playerStore.addEventListener("change", this._onPlayerChange);
		xmlStore.addEventListener("change", this._onXmlStoreChange);
		document.addEventListener("keydown", this._onKeyDown);
		this._onPlayerChange();
		this._renderShortcuts();
	}

	disconnectedCallback() {
		playerStore.removeEventListener("change", this._onPlayerChange);
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
		document.removeEventListener("keydown", this._onKeyDown);
	}

	// Space toggles PLAY/STOP globally, per Hans — except while any text
	// field has focus (isEditableContext, same shadow-DOM-piercing check
	// edit-history.js uses for its own Cmd/Ctrl+Z guard), where Space must
	// still just type a space. Backspace/Delete removes the currently
	// selected root-level <Command> (a trigger-shortcut button) — same
	// selectable/deletable treatment as everywhere else in the XML editor,
	// per Hans (2026-09-09). Mirrors wa-mixer-view.js's own _onKeyDown: only
	// acts when the selection is genuinely one of *this* component's own
	// elements, never something selected in a completely different view.
	_onKeyDown(e) {
		if (e.key === " " || e.code === "Space") {
			if (isEditableContext()) return;
			e.preventDefault();
			if (playerStore.isPlaying) {
				playerStore.stop();
			} else {
				this._blink(this._playBtn);
				playerStore.play();
			}
			return;
		}
		if (e.key === "Backspace" || e.key === "Delete") {
			if (isEditableContext()) return;
			const selectedId = xmlStore.selectedNodeId;
			if (!selectedId || !xmlStore.root) return;
			const isOwnCommand = xmlStore.root.children.some((c) => c.tagName === "Command" && c.id === selectedId);
			if (!isOwnCommand) return;
			e.preventDefault();
			xmlStore.removeNode(selectedId);
		}
	}

	// Restarts the .blink CSS animation on every call — re-adding an
	// already-present class doesn't restart it, so this removes it, forces
	// a reflow (reading offsetWidth), then re-adds it. Shared by PLAY and
	// every shortcut-btn (2026-09-10) — any actual trig blinks whichever
	// button sent it. Per Hans (2026-09-09).
	_blink(el) {
		el.classList.remove("blink");
		void el.offsetWidth;
		el.classList.add("blink");
	}

	_onPlayerChange() {
		this._playBtn.classList.toggle("active", playerStore.isPlaying);
		this._playBtn.disabled = !playerStore.triggerSelector;
		if (this.shadowRoot.activeElement !== this._selectorInput) {
			this._selectorInput.value = playerStore.triggerSelector;
		}
	}

	_onXmlStoreChange() {
		this._renderShortcuts();
	}

	// The "+" button: saves the field's current selector as a new root-level
	// trigger-shortcut <Command>, inserted as root's first child if it has
	// no <Command> children yet, otherwise right after the last one. Per
	// Hans (2026-09-09).
	_addShortcutCommand() {
		const selector = playerStore.triggerSelector;
		if (!selector || !xmlStore.root) return;
		const rootChildren = xmlStore.root.children;
		const lastCommandIndex = rootChildren.reduce((last, c, i) => (c.tagName === "Command" ? i : last), -1);
		const index = lastCommandIndex + 1; // 0 (first child) if none found yet
		xmlStore.insertNewChild(xmlStore.root.id, "Command", { id: ops.generateCommandId(xmlStore.root), type: "trig", value: selector }, index);
	}

	// The "+" button next to the Var knobs: adds a new root-level <Var>,
	// right after the last existing one (keeping every <Var> grouped
	// together, ahead of anything that isn't a <Command>/<Var>) — or right
	// after the first <Command> if there's no <Var> yet, or as root's first
	// child if there's neither. Attributes (name/mapin/default) are left
	// for xmlStore.insertNewChild's own Var auto-fill. Per Hans (2026-09-10).
	_addVarElement() {
		if (!xmlStore.root) return;
		const rootChildren = xmlStore.root.children;
		const lastVarIndex = rootChildren.reduce((last, c, i) => (c.tagName === "Var" ? i : last), -1);
		let index;
		if (lastVarIndex >= 0) {
			index = lastVarIndex + 1;
		} else {
			const firstCommandIndex = rootChildren.findIndex((c) => c.tagName === "Command");
			index = firstCommandIndex >= 0 ? firstCommandIndex + 1 : 0;
		}
		xmlStore.insertNewChild(xmlStore.root.id, "Var", {}, index);
	}

	// Root-level <Command type="trig"> elements — grouped by a shared
	// `class` attribute (each distinct class value, in first-seen order,
	// becomes one visually separated cluster); commands without a class sit
	// together as their own leading group. The selector each one trig()s
	// lives in `value` (per Hans, 2026-09-09 — see _addShortcutCommand,
	// which writes exactly this shape).
	_renderShortcuts() {
		this._shortcuts.innerHTML = "";
		if (!xmlStore.root) return;

		const commands = xmlStore.root.children.filter((c) => c.tagName === "Command" && (c.attributes.type || "trig") === "trig" && c.attributes.value);
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
				btn.classList.toggle("selected", xmlStore.selectedNodeId === cmd.id);
				// label > id > class, per Hans (2026-09-09).
				btn.textContent = cmd.attributes.label || cmd.attributes.id || cmd.attributes.class || cmd.attributes.value;
				btn.title = `trig(${cmd.attributes.value})`;
				// Selects this <Command> (so the XML tree/Code panel highlight
				// it too — see xmlStore.selectNode's existing sync) *and*
				// fires it, per Hans (2026-09-09): selectable/deletable now,
				// same as everything else in the XML editor. Blinks the same
				// way PLAY does (2026-09-10) — see _blink.
				btn.addEventListener("click", () => {
					xmlStore.selectNode(cmd.id);
					this._blink(btn);
					playerStore.trigShortcut(cmd.attributes.value);
				});
				groupEl.appendChild(btn);
			});
			this._shortcuts.appendChild(groupEl);
		});
	}
}

customElements.define("wa-player-bar", WaPlayerBar);
