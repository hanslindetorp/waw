// The stretch of the play-bar the INPUT panel's waveforms show: one `start` and
// `span` (both 0–1 of the whole length) shared by every row of every section, so
// zooming one zooms them all and the playheads stay on the same time. Emits
// "change" when it moves.

const MIN_SPAN = 0.002;

class InputView extends EventTarget {
	constructor() {
		super();
		this.start = 0;
		this.span = 1;
	}

	set(start, span) {
		const s = Math.min(1, Math.max(MIN_SPAN, span));
		const a = Math.min(1 - s, Math.max(0, start));
		if (a === this.start && s === this.span) return;
		this.start = a;
		this.span = s;
		this.dispatchEvent(new CustomEvent("change"));
	}

	// Zooms by `factor` around the point `anchor` (0–1 across the view).
	zoom(factor, anchor = 0.5) {
		const next = Math.min(1, Math.max(MIN_SPAN, this.span / factor));
		const at = this.start + anchor * this.span;
		this.set(at - anchor * next, next);
	}

	pan(delta) {
		this.set(this.start + delta, this.span);
	}

	fit() {
		this.set(0, 1);
	}

	// Keeps `fraction` (the playhead) inside the view while playing.
	follow(fraction) {
		if (this.span < 1 && (fraction < this.start || fraction > this.start + this.span)) this.set(fraction - 0.05 * this.span, this.span);
	}
}

export const inputView = new InputView();
