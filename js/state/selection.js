// Shared selection state so wa-file-manager and wa-preview (siblings, each
// their own custom element) can talk without knowing about each other.

class Selection extends EventTarget {
	constructor() {
		super();
		this._id = null;
	}

	select(id) {
		this._id = id;
		this.dispatchEvent(new CustomEvent("change", { detail: { id } }));
	}

	get id() {
		return this._id;
	}
}

export const selection = new Selection();
