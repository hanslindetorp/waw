// A small registry of the live input sources (today only the camera,
// "webcam"; MIDI/OSC later) so that parts of the app that are not the INPUT
// panel — the Stage, the viewer — can find a source, start it and read what
// its rows measure, without knowing where in the DOM it lives. A source
// element registers itself when it is connected (see wa-webcam-input.js) and
// is expected to offer:
//   running, statusText, start(), stop()          — the device
//   getEntrySummaries()                           — [{ id, color, label, measure, bypassed }]
//   getEntryNorm(id)                              — latest 0–1 value of a row, or undefined
//   events: "state-change" (rows changed), "run-change" (started/stopped/failed)
class InputSources extends EventTarget {
	constructor() {
		super();
		this._sources = new Map();
	}

	register(name, element) {
		this._sources.set(name, element);
		this.dispatchEvent(new CustomEvent("change"));
	}

	unregister(name, element) {
		if (this._sources.get(name) === element) {
			this._sources.delete(name);
			this.dispatchEvent(new CustomEvent("change"));
		}
	}

	get(name) {
		return this._sources.get(name) || null;
	}
}

export const inputSources = new InputSources();
