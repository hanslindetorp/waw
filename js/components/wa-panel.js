// Generic show/hide + resizable panel wrapper used by all four vertical
// panels from docs/WAXML-Workstation-spec.md avsnitt 5. Panel content is
// slotted in, e.g. <wa-panel panel-title="Preview"><wa-preview></wa-preview></wa-panel>.
//
// Collapsing a panel shrinks it to a minimal icon rail (icon-title-...icon="🎚️"
// + the collapse button, no body) rather than just hiding its content at
// full width.
//
// The row's layout rule (per Hans, 2026-10-28): the LAST OPEN panel (counted
// from the left) always stretches to fill all the space up to the collapsed
// rails after it, so there is never an empty area and the rails stay glued to
// the right edge; every other open panel has a fixed width. A panel's right
// edge (its resize handle) can only be dragged while some open panel lies to
// its right — that stretching panel is what takes up the change — so the last
// open panel has no handle. All of this is applied in WaPanel.layoutRow(),
// run whenever a panel opens/closes, on load and on a window resize.

const COLLAPSED_FLEX = "0 0 2.8rem";
// Every panel keeps flex-shrink:0 while expanded (see _applyFlex/_baseFlex)
// — letting the browser's own flex-shrink renegotiate *every* panel's width
// continuously (which an earlier version of this file did) made a manual
// resize-handle drag lag behind the pointer, per Hans (2026-09-02): the
// dragged panel's own width was itself subject to shrinking against its
// neighbors mid-drag instead of tracking the cursor 1:1. Space-stealing for
// an *opening* panel (Code needs room from the left, File Manager from the
// right) is instead a one-time, explicit reflow — see _reclaimSpaceIfNeeded.
const MIN_EXPANDED_WIDTH_PX = 160;
const MIN_EXPANDED_WIDTH = `${MIN_EXPANDED_WIDTH_PX}px`;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: relative;
			display: flex;
			flex-direction: column;
			min-width: ${MIN_EXPANDED_WIDTH};
			border-right: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
			color: var(--waw-fg, #e8e8e8);
			overflow: hidden;
		}
		:host(.collapsed) {
			min-width: 0;
		}
		:host([hidden]) {
			display: none;
		}
		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
			padding: 0.5rem 0.75rem;
			font: 600 0.75rem/1.2 system-ui, sans-serif;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
			white-space: nowrap;
		}
		:host(.collapsed) .panel-header {
			flex-direction: column;
			padding: 0.5rem 0.25rem;
			gap: 0.5rem;
		}
		.panel-title {
			overflow: hidden;
			text-overflow: ellipsis;
		}
		:host(.collapsed) .panel-title {
			display: none;
		}
		.panel-icon {
			display: none;
			font-size: 1.2em;
			line-height: 1;
		}
		:host(.collapsed) .panel-icon {
			display: block;
		}
		/* A slotted <svg> icon (see the "icon" slot above) draws in the
		   panel's own text color, flat/graphic rather than a pictorial
		   emoji — per Hans, white-on-black line icons, matching the
		   text fallback's visual size rather than whatever raw
		   width/height it was authored at. */
		.panel-icon ::slotted(svg) {
			display: block;
			width: 1.2em;
			height: 1.2em;
			color: inherit;
		}
		.panel-body {
			flex: 1 1 auto;
			overflow: auto;
			min-height: 0;
		}
		:host(.collapsed) .panel-body {
			display: none;
		}
		.collapse-btn {
			background: none;
			border: none;
			color: inherit;
			cursor: pointer;
			font-size: 0.85rem;
			line-height: 1;
			padding: 0.1rem 0.3rem;
		}
		.resize-handle {
			position: absolute;
			top: 0;
			right: -3px;
			width: 6px;
			height: 100%;
			cursor: col-resize;
			z-index: 1;
		}
		:host(.collapsed) .resize-handle {
			display: none;
		}
	</style>
	<div class="panel-header">
		<span class="panel-icon"><slot name="icon"><span class="panel-icon-text"></span></slot></span>
		<span class="panel-title"></span>
		<button class="collapse-btn" type="button" title="Show/hide panel">-</button>
	</div>
	<div class="panel-body"><slot></slot></div>
	<div class="resize-handle"></div>
`;

export class WaPanel extends HTMLElement {
	static get observedAttributes() {
		return ["panel-title", "icon"];
	}

	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._titleEl = this.shadowRoot.querySelector(".panel-title");
		// A plain-text icon (currently just Code's "</>") still uses the
		// `icon` attribute, rendered into this fallback span — it only ever
		// shows up while nothing's assigned to the "icon" slot. Every other
		// panel gets a flat, monochrome `<svg slot="icon">...</svg>` light-DOM
		// child in index.html instead (per Hans: white-on-black line icons,
		// not pictorial emoji), which pre-empts this fallback entirely.
		this._iconEl = this.shadowRoot.querySelector(".panel-icon-text");
		this._header = this.shadowRoot.querySelector(".panel-header");
		this._collapseBtn = this.shadowRoot.querySelector(".collapse-btn");
		this._resizeHandle = this.shadowRoot.querySelector(".resize-handle");
		this._panelBody = this.shadowRoot.querySelector(".panel-body");
		this._collapsed = false;
		this._isStretch = false; // the last open panel of the row, see layoutRow
		this._onResizeMove = this._onResizeMove.bind(this);
		this._onResizeEnd = this._onResizeEnd.bind(this);
	}

	connectedCallback() {
		this._titleEl.textContent = this.getAttribute("panel-title") || "";
		this._iconEl.textContent = this.getAttribute("icon") || "";
		// Every panel has a width of its own (resizable via the handle below,
		// used while it isn't the last open one); the last open panel
		// stretches instead — see layoutRow.
		this._baseFlex = `0 0 ${this.getAttribute("width") || "300px"}`;
		this._applyFlex();
		this._collapseBtn.addEventListener("click", () => this.toggleCollapse());
		this._resizeHandle.addEventListener("pointerdown", (e) => this._onResizeStart(e));
		// A markup-level starting state (e.g. Code defaulting to closed in a
		// fresh project, per Hans) — workstation-state.js's own saved state
		// (if any) still wins once it applies, same as any other later
		// toggleCollapse() call.
		if (this.hasAttribute("collapsed")) this.toggleCollapse(true);
		WaPanel._scheduleLayout(this.parentElement);
	}

	attributeChangedCallback(name, oldVal, newVal) {
		if (name === "panel-title" && this._titleEl) {
			this._titleEl.textContent = newVal || "";
		}
		if (name === "icon" && this._iconEl) {
			this._iconEl.textContent = newVal || "";
		}
	}

	get collapsed() {
		return this._collapsed;
	}

	// The panel's current "restore-to" flex-basis (e.g. "0 0 35%" or
	// "0 0 412px") — what it's sized to when expanded and not absorbing a
	// collapsed neighbor's space. Read by workstation-state.js to persist a
	// user's manual resize; unaffected by collapse/absorb, which only ever
	// touch this.style.flex, never this._baseFlex itself.
	get widthBasis() {
		return this._baseFlex;
	}

	// Restores a previously-saved widthBasis (see above) — used only when
	// applying workstation-state.json on load, so it deliberately does NOT
	// dispatch "width-change" (that's reserved for an actual user drag, see
	// _onResizeEnd) to avoid an immediate redundant save right after load.
	setWidthBasis(basis) {
		this._baseFlex = basis;
		this._applyFlex();
		WaPanel._scheduleLayout(this.parentElement);
	}

	toggleCollapse(force) {
		const next = typeof force === "boolean" ? force : !this._collapsed;
		if (next === this._collapsed) return;
		// What the other open panels measure right now, before this one opens
		// and takes room (see _applyFairShareOnOpen).
		const widthsBefore = next ? null : this._openPanelWidths();
		this._collapsed = next;
		this.classList.toggle("collapsed", this._collapsed);
		this._collapseBtn.textContent = this._collapsed ? "+" : "-";
		this._header.title = this._collapsed ? this.getAttribute("panel-title") || "" : "";
		// A panel that just opened claims a fair share of the total width —
		// see _applyFairShareOnOpen. Closing needs nothing special: the last
		// open panel stretches over the freed space (layoutRow).
		if (!this._collapsed) this._applyFairShareOnOpen(widthsBefore);
		WaPanel.layoutRow(this.parentElement);
		// Lets workstation-state.js (or anything else) persist panel layout
		// without polling every panel's own .collapsed getter.
		this.dispatchEvent(new CustomEvent("collapse-change", { bubbles: true, detail: { collapsed: this._collapsed } }));
	}

	_openPanelWidths() {
		const container = this.parentElement;
		const widths = new Map();
		if (!container) return widths;
		[...container.children].forEach((el) => {
			if (el instanceof WaPanel && el !== this && !el.collapsed && !el.hidden) widths.set(el, el.getBoundingClientRect().width);
		});
		return widths;
	}

	// Gives every panel its flex: the last open one stretches (1 1 0), the
	// other open ones keep their width, a collapsed one is a rail. Shows a
	// panel's resize handle only when an open panel lies to its right. Then
	// makes sure the row isn't wider than its container (see fitRow).
	static layoutRow(container) {
		if (!container) return;
		const panels = [...container.children].filter((el) => el instanceof WaPanel && !el.hidden);
		const open = panels.filter((p) => !p.collapsed);
		const last = open[open.length - 1];
		panels.forEach((p) => {
			p._isStretch = p === last;
			p._applyFlex();
			p._resizeHandle.style.display = !p.collapsed && p !== last ? "" : "none";
		});
		WaPanel.fitRow(container);
	}

	// The fixed-width panels together with the stretching one at its minimum
	// width and the collapsed rails must fit the container: when they don't
	// (a smaller window, a wider panel) the fixed panels are narrowed in
	// proportion to their widths, none below the minimum.
	static fitRow(container) {
		const panels = [...container.children].filter((el) => el instanceof WaPanel && !el.hidden);
		const fixed = panels.filter((p) => !p.collapsed && !p._isStretch);
		const stretch = panels.find((p) => p._isStretch);
		if (!fixed.length) return;
		const railsWidth = panels.filter((p) => p.collapsed).reduce((sum, p) => sum + p.getBoundingClientRect().width, 0);
		const available = container.getBoundingClientRect().width - railsWidth - (stretch ? MIN_EXPANDED_WIDTH_PX : 0);
		const widths = fixed.map((p) => p.getBoundingClientRect().width);
		const total = widths.reduce((a, b) => a + b, 0);
		if (total <= available || total <= 0) return;
		fixed.forEach((p, i) => {
			const width = Math.max(MIN_EXPANDED_WIDTH_PX, widths[i] * (available / total));
			p._baseFlex = `0 0 ${width}px`;
			p._applyFlex();
		});
	}

	static _scheduleLayout(container) {
		if (!container || container._wawLayoutPending) return;
		container._wawLayoutPending = true;
		queueMicrotask(() => {
			container._wawLayoutPending = false;
			WaPanel.layoutRow(container);
		});
		if (!container._wawLayoutObserver) {
			container._wawLayoutObserver = new ResizeObserver(() => WaPanel.fitRow(container));
			container._wawLayoutObserver.observe(container);
		}
	}

	_applyFlex() {
		if (this._collapsed) {
			this.style.flex = COLLAPSED_FLEX;
		} else if (this._isStretch) {
			this.style.flex = "1 1 0";
		} else {
			this.style.flex = this._baseFlex;
		}
	}

	// Called right after this panel expands (see toggleCollapse): this panel
	// claims 1/n of the container's width (n = now-open panel count — 25% of
	// 4, 33% of 3, 50% of 2), and the rest of the width is redistributed across
	// the other open panels in proportion to the widths they had before
	// (`widthsBefore`). Per Hans (2026-09-10). Whichever panel ends up last
	// open stretches regardless (layoutRow), so these widths matter for the
	// others; this panel's own is what it keeps when it isn't the last one.
	_applyFairShareOnOpen(widthsBefore) {
		const container = this.parentElement;
		if (!container || !widthsBefore) return;
		const others = [...widthsBefore.keys()];
		const visibleCount = others.length + 1;
		if (visibleCount <= 1) return;

		const containerWidth = container.getBoundingClientRect().width;
		const targetWidth = containerWidth / visibleCount;
		const othersWidth = [...widthsBefore.values()].reduce((sum, w) => sum + w, 0);
		const remaining = Math.max(0, containerWidth - targetWidth);

		this._baseFlex = `0 0 ${targetWidth}px`;
		if (othersWidth <= 0) return;
		others.forEach((p) => {
			const width = Math.max(MIN_EXPANDED_WIDTH_PX, remaining * (widthsBefore.get(p) / othersWidth));
			p._baseFlex = `0 0 ${width}px`;
			p._applyFlex();
		});
	}

	_onResizeStart(e) {
		e.preventDefault();
		this._resizeStartX = e.clientX;
		this._resizeStartWidth = this.getBoundingClientRect().width;
		window.addEventListener("pointermove", this._onResizeMove);
		window.addEventListener("pointerup", this._onResizeEnd);
	}

	_onResizeMove(e) {
		const rawWidth = this._resizeStartWidth + (e.clientX - this._resizeStartX);
		// _shrinkOthersToFit below can only ever shrink *other* panels down
		// to their own minimum — it can't manufacture room that isn't there.
		// Without also capping this panel's own growth, dragging far enough
		// still overflows once every other panel already bottomed out. Per
		// Hans (2026-09-26).
		const newWidth = Math.max(MIN_EXPANDED_WIDTH_PX, Math.min(rawWidth, this._maxWidthForOthersToFit()));
		this._baseFlex = `0 0 ${newWidth}px`;
		this._applyFlex();
		this._shrinkOthersToFit();
	}

	// How wide this panel can get while every *other* visible panel still
	// fits at its own minimum (a collapsed one can't shrink further than its
	// fixed icon-rail width; an expanded one can always reach
	// MIN_EXPANDED_WIDTH_PX via _shrinkOthersToFit).
	_maxWidthForOthersToFit() {
		const container = this.parentElement;
		if (!container) return Infinity;
		const others = [...container.children].filter((el) => el instanceof WaPanel && !el.hidden && el !== this);
		const containerWidth = container.getBoundingClientRect().width;
		const othersMin = others.reduce((sum, p) => sum + (p.collapsed ? p.getBoundingClientRect().width : MIN_EXPANDED_WIDTH_PX), 0);
		return Math.max(MIN_EXPANDED_WIDTH_PX, containerWidth - othersMin);
	}

	// Growing this panel must never push a later one past the container's
	// own right edge — per Hans (2026-09-26): "det sista panelens högerkant
	// ska alltid ligga mot fönstrets högerkant." Every non-fill panel keeps
	// flex-shrink:0 (see the top-of-file comment on why), so the browser
	// never shrinks anything on its own; if growing this panel pushed the
	// row's total width past the container, this explicitly shrinks every
	// *other* expanded, non-fill panel (proportionally to its own current
	// width, never below MIN_EXPANDED_WIDTH_PX) to absorb the difference —
	// this panel's own width stays exactly what the drag says (unaffected,
	// same "always tracks the cursor 1:1" reasoning as flex-shrink:0 itself),
	// only its neighbors compress. The fill panel (Code) is left alone: it
	// already absorbs width on its own via flex:1 1 auto whenever it's
	// expanded, and forcing a fixed _baseFlex onto it here would detach it
	// from the container's trailing edge (the exact bug _applyFairShareOnOpen's
	// own comment already warns about) — so this only matters while Code is
	// collapsed, which is exactly when nothing else is absorbing the overflow.
	_shrinkOthersToFit() {
		const container = this.parentElement;
		if (!container) return;
		const panels = [...container.children].filter((el) => el instanceof WaPanel && !el.hidden);
		const containerWidth = container.getBoundingClientRect().width;
		const overflow = panels.reduce((sum, p) => sum + p.getBoundingClientRect().width, 0) - containerWidth;
		if (overflow <= 0) return;

		const shrinkable = panels.filter((p) => p !== this && !p.collapsed && !p._isStretch);
		if (!shrinkable.length) return;
		const widths = shrinkable.map((p) => p.getBoundingClientRect().width);
		const shrinkableTotal = widths.reduce((a, b) => a + b, 0);
		if (shrinkableTotal <= 0) return;

		shrinkable.forEach((p, i) => {
			const share = overflow * (widths[i] / shrinkableTotal);
			const newWidth = Math.max(MIN_EXPANDED_WIDTH_PX, widths[i] - share);
			p._baseFlex = `0 0 ${newWidth}px`;
			p._applyFlex();
		});
	}

	_onResizeEnd() {
		window.removeEventListener("pointermove", this._onResizeMove);
		window.removeEventListener("pointerup", this._onResizeEnd);
		// Fired once per drag (not per pointermove) so workstation-state.js's
		// own debounce isn't doing all the work of not saving mid-drag.
		this.dispatchEvent(new CustomEvent("width-change", { bubbles: true, detail: { width: this._baseFlex } }));
	}
}

customElements.define("wa-panel", WaPanel);
