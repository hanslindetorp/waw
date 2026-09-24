// Popup "which signal of this Var?" menu — opened only from
// wa-var-knobs.js's own _claimVarToVarMapping, the ONE Map-mode claim site
// where a dot-suffixed reference ($name.speed etc.) is ever meaningful.
// Per Hans (2026-10-04 correction): "jag inser att speed/derivative bara är
// vettiga alternativ när man mappar en <Var> till en <Var>... När man
// droppar på en vanlig parameter ska ingen popup visas... Det är
// variabelns namn (med $) som ska skrivas in. Inget annat." — every OTHER
// claim site (param-binding.js's wireMapClaim, wa-node-inspector.js's own
// attr-row claim listener) went back to committing the bare "$varName"
// directly, no popup, after this was tried there too (2026-10-04, reverted
// same day). Offers a choice between the source Var's plain value and its
// speed/derivative(s), written with dot syntax ("$name.speed" etc.) except
// plain "value", which stays bare ("$name") — matching waxml.js's own
// WebAudioUtils.replaceVariableNames, which already defaults an absent
// dot-suffix to "value".
//
// Used imperatively, same shape as the deleted wa-var-picker.js's own
// openVarPicker: `const suffix = await pickVarSourceSuffix(anchorRect, name);`
// resolves with the dot-suffix to append ("" for plain value, ".speed",
// ".derivative", ".derivative2", ".derivative3"), or null if dismissed
// without picking anything.
//
// The option list intentionally says "derivative" (not "derivative1") for
// the first order, matching waxml.js's own Variable class exactly — it has
// no "derivative1" getter, only "derivative"/"derivative2"/"derivative3"
// (see Variable.speed/.derivative/.derivative2/.derivative3, waxml.js).

const SOURCE_OPTIONS = [
	{ label: "value", suffix: "" },
	{ label: "speed", suffix: ".speed" },
	{ label: "derivative", suffix: ".derivative" },
	{ label: "derivative2", suffix: ".derivative2" },
	{ label: "derivative3", suffix: ".derivative3" }
];

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
			min-width: 11rem;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
			padding: 0.3rem;
		}
		.source-row {
			border-radius: 4px;
			padding: 0.3rem 0.5rem;
			cursor: pointer;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			color: var(--waw-accent, #4fa3ff);
		}
		.source-row:hover {
			background: rgba(79, 163, 255, 0.15);
		}
	</style>
	<div class="backdrop"></div>
	<div class="popup"><div class="menu-root"></div></div>
`;

class WaVarSourcePopup extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._popup = this.shadowRoot.querySelector(".popup");
		this._menuRoot = this.shadowRoot.querySelector(".menu-root");
		this._resolve = null;
		// Guards against the exact gesture that opened this popup also
		// "clicking through" onto it — param-binding.js's wireMapClaim opens
		// this on POINTERDOWN (has to, to beat wireKnobDrag's own pointerdown
		// listener on the same chip — see its own comment), so the matching
		// mouseup/click for that same physical click lands wherever the
		// cursor now is, which is right on top of this popup's own first row
		// (positioned at the target's own anchorRect.bottom). Without this
		// guard, that leftover click silently auto-picks "value" every time,
		// before the user ever sees the menu — bug per Hans (2026-10-04):
		// "det är bara [var-name] som funkar. Speed och derivative 'biter'
		// inte alls." Armed one frame after creation (same rAF _positionNear
		// already schedules) — by then the browser has dispatched the
		// initiating gesture's own click/mouseup, so only a genuinely new
		// click gets through.
		this._ready = false;
	}

	// anchorRect: a getBoundingClientRect()-shaped object to position the
	// popup near. varName: the source Var's name, shown in each option as
	// "$varName[.suffix]".
	setup(anchorRect, varName) {
		this._anchorRect = anchorRect;
		this._renderMenu(varName);
		this._positionNear(anchorRect);
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".backdrop").addEventListener("click", () => {
			if (this._ready) this._finish(null);
		});
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

	_renderMenu(varName) {
		this._menuRoot.innerHTML = "";
		SOURCE_OPTIONS.forEach(({ suffix }) => {
			const row = document.createElement("div");
			row.className = "source-row";
			row.textContent = `$${varName}${suffix}`;
			row.addEventListener("click", () => {
				if (this._ready) this._finish(suffix);
			});
			this._menuRoot.appendChild(row);
		});
	}

	_positionNear(anchorRect) {
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
			// See the constructor's own comment on _ready.
			this._ready = true;
		});
	}

	_finish(value) {
		this._resolve?.(value);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-var-source-popup", WaVarSourcePopup);

export function pickVarSourceSuffix(anchorRect, varName) {
	const popup = document.createElement("wa-var-source-popup");
	document.body.appendChild(popup);
	popup.setup(anchorRect, varName);
	return popup.whenDone();
}
