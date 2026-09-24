// Global "armed" state for a <Var> knob's own "Map..." button (see
// wa-var-knobs.js) — lets wa-node-inspector.js's attribute rows know,
// without either file importing the other, that a click on them right now
// means "wire this attribute to the armed Var" rather than a normal edit.
// Per Hans (2026-09-27).
//
// The actual "click elsewhere disarms" behavior lives in the *consumers*,
// not here: each attribute row claims a click for itself (assigns, calls
// stopPropagation — see wa-node-inspector.js's own row listener) while
// armed; this module's own document-level click listener only ever sees a
// click that *wasn't* claimed by anything (nothing else stopped it) and
// disarms on it — so a single Var can be wired to many attributes in a row
// without re-clicking "Map..." each time, per Hans's own "one-to-many"
// point, and only a genuinely unrelated click (or Escape) ends the mode.
class VarMapMode extends EventTarget {
	constructor() {
		super();
		this._varName = null;
	}

	get armed() {
		return this._varName !== null;
	}

	get varName() {
		return this._varName;
	}

	// Arming for a Var that's already armed is treated as "toggle off" by
	// the caller (wa-var-knobs.js) — this module itself just does whatever
	// it's told.
	arm(varName) {
		if (!varName || this._varName === varName) return;
		this._varName = varName;
		// A global cursor hint while armed — per Hans (2026-09-30): "ska
		// markören visa något som passar mappning/länkning... tills man
		// fullbordat eller avbrutit mappningen." `cursor` inherits down
		// through shadow DOM boundaries (it's an inherited CSS property),
		// so this reaches every component's own markup too, though a
		// component with its own explicit `cursor` rule on a specific
		// element (e.g. a knob's ns-resize) still wins there — acceptable,
		// since that element still works correctly as a map target either
		// way, this is just the visual hint for everything else.
		document.documentElement.style.cursor = "crosshair";
		// Every valid target (see param-binding.js's wireMapClaim and
		// wa-node-inspector.js's own attribute row, both of which set a
		// permanent, static ".map-target-armed" class — never toggled per
		// instance, to avoid needing a listener per element that would leak
		// across every re-render) blinks a faint yellow ring while armed —
		// per Hans (2026-10-03): "samtliga tillgängliga target ska blinka
		// med motsvarande gul ram." A custom property is the only way to
		// reach *into* every shadow root those targets live in (Chain view,
		// Mixer, Inspector, ...) from here without each of them subscribing
		// to this module directly — custom properties inherit through
		// shadow boundaries even though selectors can't cross them; each of
		// those components' own stylesheets still needs its own identical
		// "target-armed-blink" @keyframes declaration (a keyframe name is
		// resolved within whichever stylesheet uses it, never shared), just
		// not a live subscription to this class.
		document.documentElement.style.setProperty("--waw-map-armed-anim", "target-armed-blink");
		this.dispatchEvent(new CustomEvent("change"));
	}

	disarm() {
		if (this._varName === null) return;
		this._varName = null;
		document.documentElement.style.cursor = "";
		document.documentElement.style.setProperty("--waw-map-armed-anim", "none");
		this.dispatchEvent(new CustomEvent("change"));
	}
}

export const varMapMode = new VarMapMode();

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && varMapMode.armed) varMapMode.disarm();
});

// Bubble phase, attached last (module load order — app.js imports every
// component up front, so this runs before any user interaction is
// possible): any click that reaches all the way up to document without an
// attribute row claiming it (see wa-node-inspector.js) means it landed
// somewhere with no "wire to this Var" meaning, so the arming ends.
document.addEventListener("click", () => {
	if (varMapMode.armed) varMapMode.disarm();
});
