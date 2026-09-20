import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { isEditableContext } from "../project/edit-history.js";
import "./wa-var-knobs.js";

// A persistent, always-visible bottom bar for the whole trigger/variable
// surface — moved here from the app header's own <wa-player-bar> (which
// still exists, unchanged, for the Library (DEMO) view's own separate
// bottom bar — see wa-library-view.js). Per Hans (2026-09-20).
//
// Two stacked rows, each split left/right into a Triggers column and a
// Variables column by one shared vertical divider whose x-position is
// balanced by content (see _recalcLayout):
//   - The GLOBAL row is always visible: PLAY/STOP/the CSS trigger-selector
//     field and every root-level <Command> (type="trig" *or* "set" — the
//     "+" button still only ever creates a "trig" one) on the left, every
//     root-level <Var> knob on the right.
//   - The LOCAL row only appears while the current XML selection has its
//     own <Command>/<Var> children — same two columns, scoped to that
//     element instead of the document root, with no "+" buttons (nothing
//     here creates new elements, only shows/fires what's already there).
//     Its leftmost column has no "Triggers" label — a "Locale:" label sits
//     in that same slot instead, so the first actual button/knob in both
//     rows shares the exact same x-position (see the CSS custom properties
//     --trig-lead-w/--vars-lead-w, applied to both rows' lead slots).
//
// Both rows' own button/knob lists wrap onto more lines under their own
// column instead of ever needing the bar itself to scroll (see
// _recalcLayout's own comment) — per Hans: "man ska inte kunna och aldrig
// behöva scrolla bottom-bar i någon riktning."

const SHORTCUT_EDGE_PX = 5; // see wa-player-bar.js's own identical constant
const MIN_VARS_CONTENT_PX = 90; // roughly one knob-wrap's own width — never squeeze the vars column narrower than fitting a single knob

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			flex: 0 0 auto;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
			font: 0.85rem/1.4 system-ui, sans-serif;
			padding: 0.5rem 1rem;
		}
		:host([hidden]) {
			display: none;
		}
		.bar-row {
			display: grid;
			grid-template-columns: var(--trig-col-w, 50%) 1px 1fr;
			column-gap: 0.75rem;
			align-items: start;
			padding: 0.35rem 0;
		}
		.h-divider,
		.local-row {
			display: none;
		}
		:host(.has-local) .h-divider {
			display: block;
		}
		:host(.has-local) .local-row {
			display: grid;
		}
		.h-divider {
			height: 1px;
			background: var(--waw-border, #2f2f2f);
		}
		.v-divider {
			align-self: stretch;
			width: 1px;
			background: var(--waw-border, #2f2f2f);
		}
		.col {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem;
			min-width: 0;
		}
		/* Fixed-width slot (via the JS-measured --trig-lead-w/--vars-lead-w
		   custom properties, set once from the *global* row's own natural
		   content) shared verbatim by both rows — this alone is what makes
		   the local row's first button/knob line up with the global row's,
		   regardless of how different "Locale:" and "Triggers"/the add-btn
		   actually measure. Per Hans (2026-09-20). */
		.lead {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
		.trig-lead {
			min-width: var(--trig-lead-w, auto);
		}
		.vars-lead {
			min-width: var(--vars-lead-w, auto);
		}
		.content {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.35rem;
			flex: 1 1 auto;
			min-width: 0;
		}
		.col-label,
		.locale-label {
			flex: 0 0 auto;
			font-size: 0.65rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
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
		@keyframes bb-trig-blink {
			0% {
				box-shadow: inset 0 0 0 30px rgba(79, 163, 255, 0.85);
			}
			100% {
				box-shadow: inset 0 0 0 30px rgba(79, 163, 255, 0);
			}
		}
		.blink {
			animation: bb-trig-blink 0.35s ease-out;
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
			flex: 0 0 auto;
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
		.shortcut-group {
			display: flex;
			flex-wrap: wrap;
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
		.shortcut-play-icon {
			flex: 0 0 auto;
			width: 9px;
			height: 9px;
			opacity: 0.7;
		}
		.shortcut-set-icon {
			flex: 0 0 auto;
			width: 9px;
			height: 9px;
			opacity: 0.7;
			color: var(--waw-teal, #45b58c);
		}
		.shortcut-btn::before {
			content: "";
			position: absolute;
			inset: -${SHORTCUT_EDGE_PX}px;
		}
		.shortcut-btn:hover {
			background: linear-gradient(180deg, #40454c, #24272c 80%);
			border-color: var(--waw-accent, #4fa3ff);
		}
		.shortcut-btn.selected {
			border-color: var(--waw-accent, #4fa3ff);
		}
		wa-var-knobs {
			flex: 1 1 auto;
			min-width: 0;
		}
	</style>
	<div class="bar-row global-row">
		<div class="col triggers-col">
			<div class="lead trig-lead">
				<span class="col-label">Triggers</span>
				<button class="tp-btn tp-play" data-action="play" title="Play">▶</button>
				<button class="tp-btn" data-action="stop" title="Stop">■</button>
				<input type="text" class="selector-input" placeholder="CSS selector to trig" title="What PLAY triggers — auto-fills whenever anything gets trig()'d, or type your own" />
				<button class="add-shortcut-btn" type="button" title="Save the current selector as a trigger-shortcut Command">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
						<rect x="3" y="6" width="18" height="12" rx="3" />
						<path d="M12 9v6M9 12h6" />
					</svg>
				</button>
			</div>
			<div class="content shortcuts-list global-shortcuts"></div>
		</div>
		<div class="v-divider"></div>
		<div class="col vars-col">
			<div class="lead vars-lead">
				<span class="col-label">Variables</span>
				<button class="add-var-btn" type="button" title="Add a new Var knob">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
						<circle cx="12" cy="12" r="9" />
						<path d="M12 8v8M8 12h8" />
					</svg>
				</button>
			</div>
			<wa-var-knobs class="content global-knobs"></wa-var-knobs>
		</div>
	</div>
	<div class="h-divider"></div>
	<div class="bar-row local-row">
		<div class="col triggers-col">
			<div class="lead trig-lead">
				<span class="locale-label">Locale:</span>
			</div>
			<div class="content shortcuts-list local-shortcuts"></div>
		</div>
		<div class="v-divider"></div>
		<div class="col vars-col">
			<div class="lead vars-lead"></div>
			<wa-var-knobs class="content local-knobs"></wa-var-knobs>
		</div>
	</div>
`;

export class WaBottomBar extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._playBtn = this.shadowRoot.querySelector('[data-action="play"]');
		this._stopBtn = this.shadowRoot.querySelector('[data-action="stop"]');
		this._selectorInput = this.shadowRoot.querySelector(".selector-input");
		this._addShortcutBtn = this.shadowRoot.querySelector(".add-shortcut-btn");
		this._addVarBtn = this.shadowRoot.querySelector(".add-var-btn");
		this._globalShortcuts = this.shadowRoot.querySelector(".global-shortcuts");
		this._localShortcuts = this.shadowRoot.querySelector(".local-shortcuts");
		this._globalKnobs = this.shadowRoot.querySelector(".global-knobs");
		this._localKnobs = this.shadowRoot.querySelector(".local-knobs");
		this._globalTrigLead = this.shadowRoot.querySelector(".global-row .trig-lead");
		this._globalVarsLead = this.shadowRoot.querySelector(".global-row .vars-lead");
		this._hasLocal = false;
		this._onPlayerChange = this._onPlayerChange.bind(this);
		this._onXmlStoreChange = this._onXmlStoreChange.bind(this);
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onResize = this._onResize.bind(this);
	}

	connectedCallback() {
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
		window.addEventListener("resize", this._onResize);
		this._onPlayerChange();
		this._render();
	}

	disconnectedCallback() {
		playerStore.removeEventListener("change", this._onPlayerChange);
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
		document.removeEventListener("keydown", this._onKeyDown);
		window.removeEventListener("resize", this._onResize);
	}

	// Same shape as wa-player-bar.js's own _onKeyDown (Space toggles PLAY/
	// STOP unless a text field has focus; Backspace/Delete removes the
	// selected Command) — including its defaultPrevented guard, since the
	// Library (DEMO) view's own <wa-player-bar minimal> instance stays
	// mounted (just hidden) while this bar is showing, and vice versa; both
	// listen on `document`, so whichever runs first must stop the other.
	// Generalized here to also delete a selected *local* Command (a child of
	// whatever's currently selected, not just a root-level one).
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
			const scopes = [xmlStore.root, this._localScopeNode()].filter(Boolean);
			const isOwnCommand = scopes.some((scope) => scope.children.some((c) => c.tagName === "Command" && c.id === selectedId));
			if (!isOwnCommand) return;
			e.preventDefault();
			xmlStore.removeNode(selectedId);
		}
	}

	_blink(el) {
		el.classList.remove("blink");
		void el.offsetWidth;
		el.classList.add("blink");
	}

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

	// A small "=" glyph — per Hans's request to show type="set" Commands
	// alongside type="trig" ones (2026-09-20), *some* icon needs to tell
	// them apart at a glance; a play triangle would misleadingly suggest a
	// "set" button plays something. Same construction reasoning as
	// _buildPlayIcon (real SVG DOM nodes, never innerHTML, since a
	// Command's own `variable`/`value` text sits right next to this on the
	// same button and must never be interpretable as markup).
	_buildSetIcon() {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("class", "shortcut-set-icon");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2.5");
		svg.setAttribute("stroke-linecap", "round");
		const top = document.createElementNS("http://www.w3.org/2000/svg", "path");
		top.setAttribute("d", "M4 9h16");
		const bottom = document.createElementNS("http://www.w3.org/2000/svg", "path");
		bottom.setAttribute("d", "M4 15h16");
		svg.appendChild(top);
		svg.appendChild(bottom);
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
		this._render();
	}

	// Mirrors wa-player-bar.js's own _addShortcutCommand exactly — the "+"
	// button always creates a root-level type="trig" Command, regardless of
	// whether a local row happens to be showing right now.
	_addShortcutCommand() {
		const selector = playerStore.triggerSelector;
		if (!selector || !xmlStore.root) return;
		const rootChildren = xmlStore.root.children;
		const lastCommandIndex = rootChildren.reduce((last, c, i) => (c.tagName === "Command" ? i : last), -1);
		const index = lastCommandIndex + 1;
		xmlStore.insertNewChild(xmlStore.root.id, "Command", { id: ops.generateCommandId(xmlStore.root), type: "trig", value: selector }, index, { select: false });
	}

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
		xmlStore.insertNewChild(xmlStore.root.id, "Var", {}, index, { select: false });
	}

	// A Command qualifies as a shortcut button if it's a usable "trig" (has
	// a selector in `value`, matching wa-player-bar.js's own established
	// convention) or a usable "set" (has a `variable` to set — `value` can
	// be empty/0, both truthy *strings*, so this only excludes a Command
	// missing the attribute entirely). Per Hans (2026-09-20): "inte bara
	// type='trig' utan även type='set'".
	_qualifyingCommands(scopeNode) {
		if (!scopeNode) return [];
		return scopeNode.children.filter((c) => {
			if (c.tagName !== "Command") return false;
			const type = c.attributes.type || "trig";
			if (type === "trig") return !!c.attributes.value;
			if (type === "set") return !!c.attributes.variable;
			return false;
		});
	}

	// The root node's own <Command>/<Var> children are already exactly what
	// the global row shows — per Hans (2026-09-21), selecting the root
	// itself must never surface a redundant "local" row duplicating it.
	_localScopeNode() {
		const node = xmlStore.getSelectedNode();
		return node && node !== xmlStore.root ? node : null;
	}

	_render() {
		if (!xmlStore.root) return;
		this._globalKnobs.setScopeNode(null);
		this._renderShortcutsInto(this._globalShortcuts, xmlStore.root);

		const localScope = this._localScopeNode();
		const localCommands = this._qualifyingCommands(localScope);
		const localVarCount = localScope ? localScope.children.filter((c) => c.tagName === "Var").length : 0;
		this._hasLocal = !!localScope && (localCommands.length > 0 || localVarCount > 0);
		this.classList.toggle("has-local", this._hasLocal);

		if (this._hasLocal) {
			this._localKnobs.setScopeNode(localScope.id);
			this._renderShortcutsInto(this._localShortcuts, localScope);
		} else {
			this._localShortcuts.innerHTML = "";
		}

		requestAnimationFrame(() => this._recalcLayout());
	}

	// Builds one grouped row of shortcut buttons (trig + set) for
	// `scopeNode`'s own direct <Command> children into `container` — shared
	// by the global (root-scoped) and local (selected-element-scoped) rows,
	// since a Command's own trig/set behavior never depends on *where* in
	// the tree it lives, only on its own attributes. Per Hans (2026-09-20).
	_renderShortcutsInto(container, scopeNode) {
		container.innerHTML = "";
		const commands = this._qualifyingCommands(scopeNode);
		if (commands.length === 0) return;

		const groups = new Map();
		commands.forEach((cmd) => {
			const key = cmd.attributes.class || "";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(cmd);
		});

		groups.forEach((groupCommands) => {
			const groupEl = document.createElement("div");
			groupEl.className = "shortcut-group";
			groupCommands.forEach((cmd) => groupEl.appendChild(this._buildShortcutButton(cmd)));
			container.appendChild(groupEl);
		});
	}

	_buildShortcutButton(cmd) {
		const isSet = (cmd.attributes.type || "trig") === "set";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "shortcut-btn";
		btn.classList.toggle("selected", xmlStore.selectedNodeId === cmd.id);

		const label = document.createElement("span");
		label.className = "shortcut-label";
		if (isSet) {
			// variable=value, unless an explicit label overrides it — mirrors
			// the trig button's own "just show what it does" convention.
			label.textContent = cmd.attributes.label || `${cmd.attributes.variable}=${cmd.attributes.value ?? ""}`;
			btn.title = `set(${cmd.attributes.variable} = ${cmd.attributes.value ?? ""})`;
		} else {
			label.textContent = (cmd.attributes.value || "").replace(/^[.#]/, "");
			btn.title = `trig(${cmd.attributes.value})`;
		}
		btn.appendChild(label);
		btn.appendChild(isSet ? this._buildSetIcon() : this._buildPlayIcon());

		btn.addEventListener("click", (e) => {
			const rect = btn.getBoundingClientRect();
			const inCenter =
				e.clientX >= rect.left + SHORTCUT_EDGE_PX &&
				e.clientX <= rect.right - SHORTCUT_EDGE_PX &&
				e.clientY >= rect.top + SHORTCUT_EDGE_PX &&
				e.clientY <= rect.bottom - SHORTCUT_EDGE_PX;
			if (inCenter) {
				this._blink(btn);
				if (isSet) {
					const parsed = parseFloat(cmd.attributes.value);
					playerStore.setVariable(cmd.attributes.variable, Number.isFinite(parsed) ? parsed : cmd.attributes.value);
				} else {
					playerStore.trigShortcut(cmd.attributes.value);
				}
			} else {
				xmlStore.selectNode(cmd.id);
			}
		});
		return btn;
	}

	_onResize() {
		this._recalcLayout();
	}

	// Balances how much of the bar's own width the Triggers column vs. the
	// Variables column gets, based on how much content each actually has —
	// per Hans (2026-09-20): "om det är många buttons men få knobs eller
	// tvärtom, behöver delaren mellan fälten anpassas så att alla får
	// plats." Measures each side's *unwrapped* natural width (every button/
	// knob on one line) across BOTH rows (whichever of global/local needs
	// more room for a side wins, since both rows share the same column
	// split), then:
	//   - If both sides' natural widths already fit side by side, the
	//     Triggers column gets exactly its own natural width and the
	//     Variables column (grid-template-columns' trailing `1fr`) absorbs
	//     whatever's left over — no artificial stretching.
	//   - Otherwise, the available width is split proportionally to each
	//     side's own demand, clamped so neither column ever gets crushed
	//     below fitting its own fixed "lead" controls (Play/Stop/input, or
	//     the add-var button) — every button/knob that doesn't fit next to
	//     that just wraps onto another line within its own column instead
	//     (see .content's own flex-wrap), so the bar only ever grows
	//     *taller*, never needs to scroll.
	_recalcLayout() {
		if (!this.isConnected) return;
		const style = getComputedStyle(this);
		const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
		const availableWidth = this.clientWidth - paddingX;
		if (availableWidth <= 0) return;

		const trigLeadWidth = this._globalTrigLead.getBoundingClientRect().width;
		const varsLeadWidth = this._globalVarsLead.getBoundingClientRect().width;
		this.style.setProperty("--trig-lead-w", `${trigLeadWidth}px`);
		this.style.setProperty("--vars-lead-w", `${varsLeadWidth}px`);

		// Un-wraps the container *and* every .shortcut-group inside it (each
		// one is its own flex-wrap context — see its own CSS — so forcing
		// nowrap on just the outer container wouldn't straighten out a
		// group's own internally-wrapped buttons) before reading scrollWidth,
		// then restores both.
		const naturalWrapWidth = (el) => {
			const groups = el.querySelectorAll(".shortcut-group");
			const prev = el.style.flexWrap;
			const prevGroups = [...groups].map((g) => g.style.flexWrap);
			el.style.flexWrap = "nowrap";
			groups.forEach((g) => (g.style.flexWrap = "nowrap"));
			const width = el.scrollWidth;
			el.style.flexWrap = prev;
			groups.forEach((g, i) => (g.style.flexWrap = prevGroups[i]));
			return width;
		};
		const trigContentNatural = Math.max(naturalWrapWidth(this._globalShortcuts), this._hasLocal ? naturalWrapWidth(this._localShortcuts) : 0);
		const varsContentNatural = Math.max(this._globalKnobs.getNaturalWidth(), this._hasLocal ? this._localKnobs.getNaturalWidth() : 0);

		const trigNatural = trigLeadWidth + trigContentNatural;
		const varsNatural = varsLeadWidth + varsContentNatural;
		const total = trigNatural + varsNatural;

		const DIVIDER_AND_GAP = 1 + 0.75 * 16; // 1px divider + the row's own column-gap (0.75rem, assumed 16px root)
		const usable = Math.max(0, availableWidth - DIVIDER_AND_GAP);

		let trigColWidth = total > 0 ? (total <= usable ? trigNatural : usable * (trigNatural / total)) : usable / 2;

		const minTrig = trigLeadWidth;
		const minVars = varsLeadWidth + MIN_VARS_CONTENT_PX;
		trigColWidth = Math.max(minTrig, Math.min(trigColWidth, usable - minVars));

		this.style.setProperty("--trig-col-w", `${trigColWidth}px`);
	}
}

customElements.define("wa-bottom-bar", WaBottomBar);
