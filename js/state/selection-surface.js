// Which surface the user last selected something on: the document ("document" —
// the XML tree, the Preview, the Inspector all show the same selected element)
// or the Stage ("stage" — an item there is a different instance of an object, not
// the element itself). Only one of them is "active" at a time: the Stage's item is
// highlighted — and Backspace/Delete removes it — only while it is active, and the
// Preview's highlight and Backspace stand back while the Stage is. Per Hans
// (2026-10-17).
class SelectionSurface extends EventTarget {
	constructor() {
		super();
		this._active = "document";
	}

	get active() {
		return this._active;
	}

	set(name) {
		if (this._active === name) return;
		this._active = name;
		this.dispatchEvent(new CustomEvent("change"));
	}
}

export const selectionSurface = new SelectionSurface();
