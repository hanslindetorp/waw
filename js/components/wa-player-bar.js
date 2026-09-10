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

// Half-width of the "edge" band a shortcut-btn click is tested against (see
// _renderShortcuts) — the button's own visual box, inset by this on every
// side, is the "center = trig only" zone; .shortcut-btn::before (below)
// expands the button's actual clickable area by the same amount outward, so
// the "edge = select only" zone genuinely straddles the visible border, a
// few px in and a few px out, per Hans (2026-09-10).
const SHORTCUT_EDGE_PX = 5;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		/* Needed since this element is now hidden from outside (the app
		   header's own instance, while a non-Workstation view is showing —
		   see app.js) rather than only ever unmounted. Per Hans (2026-09-10). */
		:host([hidden]) {
			display: none;
			/* Reserves a Var knob's own height (~54px measured) up front, so
			   the bar doesn't visibly grow the moment the *first* one is
			   created — wa-var-knobs.js hides itself entirely (display:none)
			   while empty, so it can't reserve this space on its own. Per
			   Hans (2026-09-10). */
			min-height: 56px;
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
		/* A brief blue background flash on every actual trig — per Hans
		   (2026-09-09, restyled 2026-09-10): so clicking PLAY (even while
		   already .active, e.g. re-triggering the same selector) visibly
		   confirms a trig was really sent, distinct from .selected's own
		   persistent border-based indicator (see .shortcut-btn.selected) —
		   the two used to both be blue and were easy to confuse; now the
		   *border* means "selected" and the *background* flash means "just
		   fired". A large inset spread reads as a full-button flash without
		   literally animating the background gradient property (which
		   doesn't interpolate cleanly). Shared by PLAY and every
		   shortcut-btn. Retriggered in JS by removing+reflowing+re-adding
		   the class (see _blink), since re-adding an already-present class
		   alone wouldn't restart the animation. */
		@keyframes tp-trig-blink {
			0% {
				box-shadow: inset 0 0 0 30px rgba(79, 163, 255, 0.85);
			}
			100% {
				box-shadow: inset 0 0 0 30px rgba(79, 163, 255, 0);
			}
		}
		.blink {
			animation: tp-trig-blink 0.35s ease-out;
		}
		/* Library (DEMO)'s bottom bar (see wa-library-view.js) reuses this
		   whole component but wants a stripped-down transport — no PLAY (its
		   own row already has a big STOP-only control elsewhere) and no
		   selector field, no "add a new Command/Var" buttons — while keeping
		   STOP, the existing shortcuts, and the Var knobs exactly as-is. Per
		   Hans (2026-09-10). Pure CSS on the host attribute so the markup
		   itself doesn't need two different template variants. */
		:host([minimal]) .tp-play,
		:host([minimal]) .selector-input,
		:host([minimal]) .add-shortcut-btn,
		:host([minimal]) .add-var-btn {
			display: none;
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
			/* Stretches to :host's own full row height (its cross-axis size,
			   since :host is display:flex) rather than a fixed rem value that
			   could drift out of sync with the bar's real height — e.g. once
			   it grows to fit a Var knob. Per Hans (2026-09-10). */
			align-self: stretch;
			background: var(--waw-border, #2f2f2f);
		}
		/* Wraps the whole Commands+Variables area in one subtly-shaded,
		   rounded group — per Hans (2026-09-10): with the "Triggers:"/
		   "Variables:" text labels gone, this pill is what actually marks
		   the area off from the rest of the bar (PLAY/STOP/selector field)
		   now, instead of a plain 1px line matching every other divider. */
		.cmd-var-group {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			/* More top padding than bottom — a Var knob's own value label
			   (see wa-var-knobs.js) sits close to the top otherwise. Per
			   Hans (2026-09-10). */
			padding: 0.6rem 0.6rem 0.3rem;
			border-radius: 10px;
			background: rgba(255, 255, 255, 0.04);
			border: 1px solid var(--waw-border, #2f2f2f);
		}
		.add-shortcut-btn,
		.add-var-btn {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 22px;
			height: 22px;
			padding: 0;
			background: linear-gradient(180deg, #383c42, #1d1f22 80%);
			border: 1px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);
			color: #cfd3da;
			cursor: pointer;
		}
		.add-shortcut-btn svg,
		.add-var-btn svg {
			width: 15px;
			height: 15px;
		}
		/* A rounded-rect "keycap" for "add a trigger button", a circle
		   (echoing wa-var-knobs.js's own round knobs) for "add a knob" — per
		   Hans (2026-09-10): the two icons should read as what they each add.
		   The circular shape alone already carries a lot of that meaning; the
		   icons inside (see the template markup) carry the rest. */
		.add-shortcut-btn {
			border-radius: 5px;
		}
		.add-var-btn {
			border-radius: 50%;
		}
		.add-shortcut-btn:hover,
		.add-var-btn:hover {
			background: linear-gradient(180deg, #40454c, #24272c 80%);
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.shortcuts {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			flex-wrap: wrap;
			/* Roughly two short shortcut-btns' worth of width (measured:
			   ~26px each, + the row's own gap) — per Hans (2026-09-10): a
			   plain margin-right alone barely showed at all once .shortcuts
			   itself had zero width (no Commands yet), collapsing the gap
			   before the divider/add-var-btn down to almost nothing. This
			   reserves that space unconditionally, not just when there
			   happen to be Commands to show. */
			min-width: 3.6rem;
			margin-right: 0.4rem;
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
		/* A bit of the same glossy, top-lit 3D feel as wa-var-knobs.js's own
		   knobs (dark radial gradient + inset highlight) — per Hans
		   (2026-09-10), a plain gradient here (a knob's radial one doesn't
		   read right on a rectangular button) plus an inset top highlight
		   and a real drop shadow for some actual depth. */
		/* Same height as a Var knob (KNOB_SIZE in wa-var-knobs.js) — per Hans
		   (2026-09-10), so the two rows of controls line up. Vertical padding
		   dropped in favor of a fixed height + flex centering; horizontal
		   padding unchanged. */
		.shortcut-btn {
			position: relative;
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
			height: 24px;
			background: linear-gradient(180deg, #383c42, #1d1f22 80%);
			border: 1px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);
			color: inherit;
			border-radius: 5px;
			padding: 0 0.5rem;
			font-size: 0.75rem;
			cursor: pointer;
			white-space: nowrap;
		}
		/* A small play triangle to the right of the label — per Hans
		   (2026-09-10), purely a visual "this is playable" cue; clicking
		   still goes through the button's own center/edge hit-test below,
		   not this icon specifically. */
		.shortcut-play-icon {
			flex: 0 0 auto;
			width: 9px;
			height: 9px;
			opacity: 0.7;
		}
		/* Expands the button's own clickable area by SHORTCUT_EDGE_PX on every
		   side (a pseudo-element still hit-tests as a click on its host
		   element) — clicking here lands outside the button's own
		   getBoundingClientRect(), which _renderShortcuts' click handler
		   reads as "edge" (select-only). Per Hans (2026-09-10). */
		.shortcut-btn::before {
			content: "";
			position: absolute;
			inset: -${SHORTCUT_EDGE_PX}px;
		}
		.shortcut-btn:hover {
			background: linear-gradient(180deg, #40454c, #24272c 80%);
			border-color: var(--waw-accent, #4fa3ff);
		}
		/* Border only (not the background, which .blink now owns — see its
		   own comment) — a same-width color swap, so a selected button
		   doesn't shift size, and its box-shadow property stays free for
		   .blink's animation to use without the two conflicting when a
		   selected button also gets triggered (a click on its own center).
		   Per Hans (2026-09-10). */
		.shortcut-btn.selected {
			border-color: var(--waw-accent, #4fa3ff);
		}
	</style>
	<button class="tp-btn tp-play" data-action="play" title="Play">▶</button>
	<button class="tp-btn" data-action="stop" title="Stop">■</button>
	<input type="text" class="selector-input" placeholder="CSS selector to trig" title="What PLAY triggers — auto-fills whenever anything gets trig()'d, or type your own" />
	<div class="cmd-var-group">
		<button class="add-shortcut-btn" type="button" title="Save the current selector as a trigger-shortcut Command">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
				<rect x="3" y="6" width="18" height="12" rx="3" />
				<path d="M12 9v6M9 12h6" />
			</svg>
		</button>
		<div class="shortcuts"></div>
		<div class="bar-divider"></div>
		<button class="add-var-btn" type="button" title="Add a new Var knob">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
				<circle cx="12" cy="12" r="9" />
				<path d="M12 8v8M8 12h8" />
			</svg>
		</button>
		<wa-var-knobs></wa-var-knobs>
	</div>
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
	//
	// defaultPrevented guard: the Library (DEMO) view (2026-09-10) reuses
	// this whole component for its own bottom bar, so more than one instance
	// can be mounted (and listening on document) at once — without this, the
	// same keydown would toggle PLAY/STOP twice (once per instance), which
	// cancels itself out. Whichever instance's handler runs first calls
	// preventDefault() below, so every instance after it just no-ops.
	_onKeyDown(e) {
		if (e.defaultPrevented) return;
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

	// The small play triangle inside every shortcut-btn (see _renderShortcuts)
	// — built as real SVG DOM nodes (createElementNS, not innerHTML) so a
	// Command's own `value` text elsewhere on the button can never end up
	// interpreted as markup. Per Hans (2026-09-10).
	_buildPlayIcon() {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "shortcut-play-icon");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "currentColor");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", "M8 5v14l11-7z");
		svg.appendChild(path);
		return svg;
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
				// The selector itself (what `value` actually trig()s), minus
				// its leading "."/"#" — per Hans (2026-09-10), replacing the
				// earlier label>id>class priority.
				const label = document.createElement("span");
				label.className = "shortcut-label";
				label.textContent = (cmd.attributes.value || "").replace(/^[.#]/, "");
				btn.appendChild(label);
				btn.appendChild(this._buildPlayIcon());
				btn.title = `trig(${cmd.attributes.value})`;
				// Clicking dead center *only* trigs (no select) — clicking the
				// edge (a band straddling the button's own visual border, a few
				// px in and a few px out via the ::before hit-area expansion in
				// CSS) *only* selects (so the XML tree/Code panel highlight it
				// — see xmlStore.selectNode's existing sync — without also
				// firing it). Per Hans (2026-09-10): trigging a Command button
				// used to always select it too, which made a second "+" click
				// build a Command that triggered the *previous* one instead of
				// whatever selector was actually wanted.
				btn.addEventListener("click", (e) => {
					const rect = btn.getBoundingClientRect();
					const inCenter =
						e.clientX >= rect.left + SHORTCUT_EDGE_PX &&
						e.clientX <= rect.right - SHORTCUT_EDGE_PX &&
						e.clientY >= rect.top + SHORTCUT_EDGE_PX &&
						e.clientY <= rect.bottom - SHORTCUT_EDGE_PX;
					if (inCenter) {
						this._blink(btn);
						playerStore.trigShortcut(cmd.attributes.value);
					} else {
						xmlStore.selectNode(cmd.id);
					}
				});
				groupEl.appendChild(btn);
			});
			this._shortcuts.appendChild(groupEl);
		});
	}
}

customElements.define("wa-player-bar", WaPlayerBar);
