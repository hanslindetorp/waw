// Global "armed" state for mapping an INPUT (webcam) entry's metric onto a
// root-level <Var> — the mirror image of var-map-mode.js's own Var-to-
// attribute mapping, but the direction is reversed: wa-webcam-input.js arms
// this when one of its saved entries' "Map..." buttons is clicked, and
// wa-var-knobs.js's own ROOT-scoped knobs (never the local/scoped row — per
// Hans, 2026-10-03: "target kan bara vara ett <Var>-element / knob i
// rooten") are the only valid targets. Picking one resolves back to
// whichever entry/key/index started the mapping via the "pick" event's
// detail — this module itself never needs to know what's being mapped, only
// that something is.
class InputMapMode extends EventTarget {
	constructor() {
		super();
		this._armed = false;
	}

	get armed() {
		return this._armed;
	}

	arm() {
		if (this._armed) return;
		this._armed = true;
		// Same cursor hint var-map-mode.js's own arm() uses — see its
		// comment for why a global, inherited CSS property reaches every
		// component's markup for free.
		document.documentElement.style.cursor = "crosshair";
		this.dispatchEvent(new CustomEvent("change"));
	}

	disarm() {
		if (!this._armed) return;
		this._armed = false;
		document.documentElement.style.cursor = "";
		this.dispatchEvent(new CustomEvent("change"));
	}

	// Called by wa-var-knobs.js when a root <Var> knob is clicked while
	// armed. Disarms itself right after — same "one shot per arm" rule
	// var-map-mode.js's own consumers now follow (per Hans, 2026-10-01).
	pick(varName) {
		if (!this._armed || !varName) return;
		this.dispatchEvent(new CustomEvent("pick", { detail: { varName } }));
		this.disarm();
	}
}

export const inputMapMode = new InputMapMode();

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && inputMapMode.armed) inputMapMode.disarm();
});

// Bubble phase, attached last (module load order — app.js imports every
// component up front, so this runs before any user interaction is
// possible): any click that reaches all the way up to document without a
// root Var knob claiming it (see wa-var-knobs.js) means it landed somewhere
// with no "map this INPUT entry here" meaning, so the arming ends. Same
// pattern as var-map-mode.js's own identical listener.
document.addEventListener("click", () => {
	if (inputMapMode.armed) inputMapMode.disarm();
});
