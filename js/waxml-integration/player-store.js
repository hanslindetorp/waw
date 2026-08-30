import { xmlStore } from "../xml-editor/xml-store.js";
import { WaxmlBridge } from "./waxml-bridge.js";

const bridge = new WaxmlBridge();

// Global playback state, independent of whichever Preview panel/view
// happens to be showing — per Hans: switching from viewing a <Section> to
// viewing a <Mixer> (or anything else) must never interrupt playback. The
// player bar (wa-player-bar.js, in the app header) owns the Play/Stop
// controls and the trigger-selector field; wa-section-view.js's own
// playhead animation, and wa-mixer-view.js's live parameter updates, just
// *read* this shared state rather than owning any transport of their own.
//
// Structural vs. attribute-only edits (see xmlStore's own `structural` flag
// on its "change" event): only a structural edit can change what shape the
// live waxml audio graph needs, so only those force a stop+reload-on-next-
// play — per Hans's own proposal, we don't attempt to rebuild live, we just
// waxml.stop("all") and leave it stopped; the user restarts explicitly.
class PlayerStore extends EventTarget {
	constructor() {
		super();
		this.isPlaying = false;
		this.triggerSelector = ""; // what the main PLAY button will waxml.trig()
		this.activeSectionId = null; // which <Section> (if any) triggerSelector currently targets — lets wa-section-view know whether *it* is the thing playing
		this._documentLoaded = false; // whether the full document is currently loaded into the live engine
		xmlStore.addEventListener("change", (e) => this._onXmlStoreChange(e));
	}

	_onXmlStoreChange(e) {
		const structural = !e.detail || e.detail.structural !== false;
		if (!structural) return; // an attribute-only edit never invalidates the live graph's shape
		this._documentLoaded = false;
		if (this.isPlaying) {
			try {
				bridge.stopAll();
			} catch {
				// waxml not loaded / nothing playing — fine.
			}
			this.isPlaying = false;
			this._emit();
		}
	}

	// Sets what the main PLAY button targets — called both when the user
	// types directly into the selector field, and automatically whenever a
	// different <Section> becomes the active one being viewed. If we're
	// already playing and this represents switching to a genuinely
	// different Section, per Hans a *new* trig event goes out immediately
	// (browsing to a different Section mid-playback previews it live,
	// without stopping whatever else is already sounding) — but merely
	// selecting a Section while stopped just arms the field for the next
	// manual Play.
	setTriggerSelector(selector, sectionId = null) {
		const sectionChanged = sectionId !== null && sectionId !== this.activeSectionId;
		this.triggerSelector = selector;
		this.activeSectionId = sectionId;
		if (this.isPlaying && sectionChanged) {
			try {
				bridge.trig(selector);
			} catch {
				// waxml not loaded — nothing we can do until it is.
			}
		}
		this._emit();
	}

	async play() {
		if (!this.triggerSelector || !xmlStore.root) return;
		if (!this._documentLoaded) {
			await bridge.loadFullDocument(xmlStore.root);
			this._documentLoaded = true;
		}
		bridge.trig(this.triggerSelector);
		this.isPlaying = true;
		this._emit();
	}

	stop() {
		try {
			bridge.stopAll();
		} catch {
			// waxml not loaded / nothing playing — fine, we're stopping anyway.
		}
		this.isPlaying = false;
		this._emit();
	}

	// Fires a one-off trig for an arbitrary selector (the trigger-shortcut
	// buttons, i.e. root-level <Command type="trig">) without touching
	// isPlaying/triggerSelector — these are independent quick-triggers, not
	// "what PLAY targets". Loads the document first if it isn't already, so
	// a shortcut works even before the main PLAY button has ever been
	// pressed.
	async trigShortcut(selector) {
		if (!selector || !xmlStore.root) return;
		if (!this._documentLoaded) {
			await bridge.loadFullDocument(xmlStore.root);
			this._documentLoaded = true;
		}
		bridge.trig(selector);
		this.isPlaying = true;
		this._emit();
	}

	get audioContext() {
		return bridge.audioContext;
	}

	// Live objects (see waxml-bridge.js's getLiveObjects) — only meaningful
	// once the document has actually been loaded (play()/trigShortcut()
	// having run at least once since the last structural invalidation).
	getLiveObjects(selector) {
		return bridge.getLiveObjects(selector);
	}

	get isDocumentLoaded() {
		return this._documentLoaded;
	}

	_emit() {
		this.dispatchEvent(new CustomEvent("change"));
	}
}

export const playerStore = new PlayerStore();
