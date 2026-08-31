import { xmlStore } from "../xml-editor/xml-store.js";
import { WaxmlBridge } from "./waxml-bridge.js";

const bridge = new WaxmlBridge();

// A structural edit stops playback, then reloads the graph shortly after —
// debounced so a burst of structural edits (e.g. _addChannelFull's six
// separate inserts, or a fast drag-drop sequence) coalesces into one reload
// instead of many.
const RELOAD_DEBOUNCE_MS = 400;

// Safety net for a load that never settles (confirmed possible: even
// window.waxml.updateFromString() on the plain default document — no
// content beyond the root element — can hang indefinitely; a real waxml.js
// issue, not something this side can fix). Without this, one hung load
// would permanently wedge _reloadInFlight and silently stop every future
// reload for the rest of the session, since nothing would ever clear it.
const RELOAD_TIMEOUT_MS = 8000;

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
// live waxml audio graph needs, so only those force a reload.
//
// The graph is kept loaded proactively (see _scheduleReload/_reloadDocument
// below) rather than lazily on first Play — per Hans: a document doesn't
// need a <Composition>/<Section> to "start" for its graph to be meaningful
// (a Mixer's own routing, live knob/fader nudges, VU meters, solo lamps are
// all just as real without one), so gating the graph's very existence
// behind an explicit trigger was the wrong coupling. `isPlaying` now means
// only "is the transport actively triggering something" — `isDocumentLoaded`
// is the separate, more permissive "is there a live graph to read/write at
// all" signal every live-audio integration point should actually gate on
// (see live-property.js, wa-mixer-view.js).
class PlayerStore extends EventTarget {
	constructor() {
		super();
		this.isPlaying = false;
		this.triggerSelector = ""; // what the main PLAY button will waxml.trig()
		this.activeSectionId = null; // which <Section> (if any) triggerSelector currently targets — lets wa-section-view know whether *it* is the thing playing
		this._documentLoaded = false; // whether the full document is currently loaded into the live engine
		this._reloadTimer = null;
		this._reloadInFlight = false;
		this._reloadPending = false;
		xmlStore.addEventListener("change", (e) => this._onXmlStoreChange(e));
	}

	_onXmlStoreChange(e) {
		this._maybeUpdateTriggerSelectorFromSelection();

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
		}
		this._emit();
		this._scheduleReload();
	}

	_scheduleReload() {
		clearTimeout(this._reloadTimer);
		this._reloadTimer = setTimeout(() => this._reloadDocument(), RELOAD_DEBOUNCE_MS);
	}

	// Rebuilds the live graph from the current document — does NOT call
	// waxml.init() (that only resumes/starts the AudioContext, and stays
	// gated behind a real click per waxml-bridge.js's own rule), so this is
	// safe to run proactively, well outside any user gesture. Guarded
	// against overlapping itself: if a new structural edit arrives while a
	// reload is already in flight, it's remembered and re-run once the
	// in-flight one finishes, rather than starting a second
	// updateFromString() concurrently against the same waxml instance.
	async _reloadDocument() {
		if (!xmlStore.root) return;
		if (this._reloadInFlight) {
			this._reloadPending = true;
			return;
		}
		this._reloadInFlight = true;
		try {
			await raceWithTimeout(bridge.loadFullDocument(xmlStore.root), RELOAD_TIMEOUT_MS);
			this._documentLoaded = true;
			this._emit();
		} catch (err) {
			// waxml.js hasn't finished loading yet, a transient parse issue,
			// or the RELOAD_TIMEOUT_MS safety net above firing — worth a
			// console warning (unlike the individual live-nudge failures
			// elsewhere in this integration, a graph that won't load at all
			// is a real operational problem, not routine no-op territory).
			// The next structural change (or the retry below) will try again.
			console.warn("player-store: failed to load the live waxml graph", err);
		} finally {
			this._reloadInFlight = false;
			if (this._reloadPending) {
				this._reloadPending = false;
				this._scheduleReload();
			}
		}
	}

	// Per Hans (2026-09-01): waxml.js's sectionStart only ends up set
	// correctly when trig() is called with a *class* selector, not an
	// [id='...'] one — so the PLAY/STOP field now auto-follows "the first
	// class of the most recently selected element that actually had one",
	// instead of the id of whatever <Section> was last viewed. An element
	// with no class leaves the field exactly as it was (not cleared) —
	// runs on every xmlStore change, not just a fresh selection, so editing
	// the currently-armed element's own class attribute updates it too.
	_maybeUpdateTriggerSelectorFromSelection() {
		const node = xmlStore.getSelectedNode();
		if (!node) return;
		const firstClass = (node.attributes.class || "").trim().split(/\s+/)[0];
		if (!firstClass) return;
		const selector = `.${firstClass}`;
		if (selector === this.triggerSelector) return;
		this.setTriggerSelector(selector, node.tagName === "Section" ? node.id : null);
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
		// Normally already true by now (the graph loads proactively — see
		// _scheduleReload) — this is just the fallback for the narrow race
		// where Play is clicked before that debounce has had a chance to fire.
		if (!this._documentLoaded) await this._reloadDocument();
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
		if (!this._documentLoaded) await this._reloadDocument();
		bridge.trig(selector);
		this.isPlaying = true;
		this._emit();
	}

	get audioContext() {
		return bridge.audioContext;
	}

	// Live objects (see waxml-bridge.js's getLiveObjects) — meaningful once
	// isDocumentLoaded is true, which no longer requires Play/a trigger to
	// have ever run (see the class comment above).
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

// Doesn't cancel `promise` itself (can't — nothing here can abort a hung
// waxml.js call) — just stops *waiting* on it after `ms`, so a load that
// never settles doesn't wedge the caller forever. If the original promise
// does eventually settle after the timeout won the race, its result is
// simply discarded.
function raceWithTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

export const playerStore = new PlayerStore();
