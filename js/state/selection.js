// Shared selection state so wa-file-manager and wa-preview (siblings, each
// their own custom element) can talk without knowing about each other.

class Selection extends EventTarget {
	constructor() {
		super();
		this._id = null;
	}

	// autoplay is only ever true from wa-file-manager.js's own audio-file
	// double-click (see _handleFileDoubleClick) — every other caller (a
	// plain single click, opening a project file, ...) omits it. Carried
	// through the same "change" event rather than a separate signal so
	// wa-file-preview.js doesn't need to know *how* it got selected, just
	// whether this particular selection should start playing itself.
	select(id, { autoplay = false } = {}) {
		this._id = id;
		this.dispatchEvent(new CustomEvent("change", { detail: { id, autoplay } }));
	}

	get id() {
		return this._id;
	}
}

export const selection = new Selection();
