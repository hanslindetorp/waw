// Generic show/hide + resizable panel wrapper used by all four vertical
// panels from docs/WAXML-Workstation-spec.md avsnitt 5. Panel content is
// slotted in, e.g. <wa-panel panel-title="Preview"><wa-preview></wa-preview></wa-panel>.
//
// Collapsing a panel shrinks it to a minimal icon rail (icon-title-...icon="🎚️"
// + the collapse button, no body) rather than just hiding its content at
// full width, and hands the freed horizontal space to its nearest expanded
// *left* neighbor — not just to whichever panel happens to be marked "fill"
// — so collapsing e.g. Preview visibly widens XML Editor right next to it,
// not XML Code three panels away.

const COLLAPSED_FLEX = "0 0 2.8rem";
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: relative;
			display: flex;
			flex-direction: column;
			min-width: 0;
			border-right: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
			color: var(--waw-fg, #e8e8e8);
			overflow: hidden;
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
		/* Generic trackpad/Magic-pad pinch-to-zoom fallback for panel content
		   (see the wheel+ctrlKey handler below) — per Hans, "the same gesture
		   in other panels zooms that panel's own content". A panel whose own
		   content implements a more meaningful zoom (e.g. wa-section-view.js's
		   pxPerSecond/rowHeight zoom) stops the wheel event from ever
		   reaching here instead of using this. transform-origin 0 0 so
		   scaling grows toward the bottom-right, matching where scroll
		   position already is rather than jumping to re-center. */
		.panel-zoom-wrap {
			transform-origin: 0 0;
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
	<div class="panel-body"><div class="panel-zoom-wrap"><slot></slot></div></div>
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
		this._zoomWrap = this.shadowRoot.querySelector(".panel-zoom-wrap");
		this._zoomScale = 1;
		this._collapsed = false;
		this._absorbing = false;
		this._onResizeMove = this._onResizeMove.bind(this);
		this._onResizeEnd = this._onResizeEnd.bind(this);
	}

	connectedCallback() {
		this._titleEl.textContent = this.getAttribute("panel-title") || "";
		this._iconEl.textContent = this.getAttribute("icon") || "";
		// Every panel defaults to a fixed width (resizable via the handle
		// below), which on a wide window leaves empty space past the last one.
		// The one panel marked "fill" (normally the trailing one) grows to
		// soak up whatever's left instead of leaving a gap.
		this._baseFlex = this.hasAttribute("fill") ? "1 1 auto" : `0 0 ${this.getAttribute("width") || "300px"}`;
		this._applyFlex();
		this._collapseBtn.addEventListener("click", () => this.toggleCollapse());
		this._resizeHandle.addEventListener("pointerdown", (e) => this._onResizeStart(e));
		// Generic trackpad/Magic-pad pinch-zoom fallback (see the .panel-zoom-wrap
		// CSS comment) — per Hans (2026-09-02). A descendant that wants its own
		// zoom instead (wa-section-view.js's pxPerSecond/rowHeight zoom) calls
		// stopPropagation() on the same wheel+ctrlKey gesture before it bubbles
		// up here, so this never fires for it.
		this._panelBody.addEventListener("wheel", (e) => this._onWheelZoom(e), { passive: false });
		// A markup-level starting state (e.g. Code defaulting to closed in a
		// fresh project, per Hans) — workstation-state.js's own saved state
		// (if any) still wins once it applies, same as any other later
		// toggleCollapse() call.
		if (this.hasAttribute("collapsed")) this.toggleCollapse(true);
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
	}

	toggleCollapse(force) {
		const next = typeof force === "boolean" ? force : !this._collapsed;
		if (next === this._collapsed) return;
		this._collapsed = next;
		this.classList.toggle("collapsed", this._collapsed);
		this._collapseBtn.textContent = this._collapsed ? "+" : "-";
		this._header.title = this._collapsed ? this.getAttribute("panel-title") || "" : "";
		this._applyFlex();
		// Lets workstation-state.js (or anything else) persist panel layout
		// without polling every panel's own .collapsed getter.
		this.dispatchEvent(new CustomEvent("collapse-change", { bubbles: true, detail: { collapsed: this._collapsed } }));

		// Hand this panel's freed (or reclaimed) width to the nearest
		// expanded panel to its left, skipping past any that are themselves
		// collapsed — not the default "fill" panel, which might be several
		// panels further over.
		const neighbor = this._findAbsorbingNeighbor();
		if (neighbor) neighbor.setAbsorbing(this._collapsed);
	}

	// Called by a collapsing/expanding right neighbor (see toggleCollapse) —
	// not meant to be called directly for any other reason.
	setAbsorbing(active) {
		this._absorbing = active;
		this._applyFlex();
	}

	_findAbsorbingNeighbor() {
		let el = this.previousElementSibling;
		while (el instanceof WaPanel && el.classList.contains("collapsed")) {
			el = el.previousElementSibling;
		}
		return el instanceof WaPanel ? el : null;
	}

	_applyFlex() {
		if (this._collapsed) {
			this.style.flex = COLLAPSED_FLEX;
		} else if (this._absorbing) {
			this.style.flex = "1 1 auto";
		} else {
			this.style.flex = this._baseFlex;
		}
	}

	// Browsers synthesize a trackpad/Magic-pad pinch as wheel + ctrlKey (also
	// catches an actual Ctrl+scroll-wheel zoom attempt, a reasonable bonus) —
	// scales this panel's own content around wherever the gesture is
	// happening, clamped to [MIN_ZOOM, MAX_ZOOM]. Skipped for a collapsed
	// panel (nothing to zoom) and for any wheel event a descendant already
	// claimed via stopPropagation (see connectedCallback).
	_onWheelZoom(e) {
		if (!e.ctrlKey || this._collapsed) return;
		e.preventDefault();
		const factor = Math.exp(-e.deltaY * 0.01);
		this._zoomScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this._zoomScale * factor));
		this._zoomWrap.style.transform = `scale(${this._zoomScale})`;
	}

	_onResizeStart(e) {
		e.preventDefault();
		this._resizeStartX = e.clientX;
		this._resizeStartWidth = this.getBoundingClientRect().width;
		window.addEventListener("pointermove", this._onResizeMove);
		window.addEventListener("pointerup", this._onResizeEnd);
	}

	_onResizeMove(e) {
		const newWidth = Math.max(160, this._resizeStartWidth + (e.clientX - this._resizeStartX));
		this._baseFlex = `0 0 ${newWidth}px`;
		this._applyFlex();
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
