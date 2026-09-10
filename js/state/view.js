// Which top-level view the app is currently showing — the normal editor
// ("workstation"), the Spotify-style demo library ("library"), or a future
// API view ("api"). Independent of xmlStore/vfs/playerStore on purpose: the
// whole point of the library/API views (per Hans, 2026-09-10) is that the
// real project keeps running live in the background exactly as it does in
// Workstation — switching views must never tear down or reload anything,
// just change which part of the DOM is visible. See app.js for the actual
// show/hide wiring.

class ViewState extends EventTarget {
	constructor() {
		super();
		this._current = "workstation";
	}

	get current() {
		return this._current;
	}

	set(view) {
		if (view === this._current) return;
		this._current = view;
		this.dispatchEvent(new CustomEvent("change", { detail: { view } }));
	}
}

export const viewState = new ViewState();
