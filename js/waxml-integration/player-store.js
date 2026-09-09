import { xmlStore } from "../xml-editor/xml-store.js";
import { firstClassToken } from "../xml-editor/xml-tree-ops.js";
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
		this._reloadPromise = null; // shared by every caller currently waiting on _reloadDocument() — see there
		xmlStore.addEventListener("change", (e) => this._onXmlStoreChange(e));
	}

	_onXmlStoreChange(e) {
		this._maybeUpdateTriggerSelectorFromSelection();

		const structural = !e.detail || e.detail.structural !== false;
		if (!structural) {
			// xmlStore's own liveNudge detail (see xml-store.js's updateAttributes/
			// _buildLiveNudge) — a Section/Layer/Stinger attribute change that
			// stayed non-structural because that tag's live object now exposes a
			// generic waxml.js .set(param, value), per Hans (2026-09-08).
			if (e.detail?.liveNudge) this._applyLiveNudge(e.detail.liveNudge);
			return; // an attribute-only edit never invalidates the live graph's shape
		}
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

	// Nudges a Section/Track/Motif's own generic .set(param, value) directly
	// (no engine reload) — same "no graph loaded / object not found / setter
	// doesn't exist -> silently no-op" contract as live-property.js's
	// applyLiveMethodCall, reimplemented here rather than imported to avoid
	// a circular import (live-property.js already imports this module).
	_applyLiveNudge({ elementId, changed }) {
		if (!this._documentLoaded || !elementId) return;
		let liveObj;
		try {
			const matches = bridge.getLiveObjects(`[id='${elementId}']`);
			liveObj = matches && matches[0];
		} catch {
			liveObj = null;
		}
		if (!liveObj || typeof liveObj.set !== "function") return;
		for (const [param, value] of Object.entries(changed)) {
			try {
				liveObj.set(param, value);
			} catch {
				// Same reasoning as live-property.js's own catch: not worth
				// surfacing, the XML attribute is already the source of truth.
			}
		}
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
	//
	// Every caller shares the same _reloadPromise while one is running —
	// play()'s own `await this._reloadDocument()` needs the graph to
	// actually be loaded (or have genuinely failed) by the time it resumes,
	// not just "a reload was requested at some point". The old version
	// returned immediately from the "already in flight" branch instead of
	// waiting for it, so play() could resume — and trig — before the graph
	// it just asked for was actually ready. Bug per Hans (2026-09-04).
	_reloadDocument() {
		if (!xmlStore.root) return Promise.resolve();
		if (this._reloadInFlight) {
			this._reloadPending = true;
			return this._reloadPromise;
		}
		this._reloadInFlight = true;
		this._reloadPromise = this._runReloadLoop();
		return this._reloadPromise;
	}

	// One loadFullDocument() attempt, repeated in place (not via a fresh
	// _reloadDocument() call/promise) for as long as another structural edit
	// keeps arriving while the previous attempt was in flight — so the
	// single shared _reloadPromise every caller is awaiting only resolves
	// once things have genuinely settled.
	async _runReloadLoop() {
		do {
			this._reloadPending = false;
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
				// The next structural change (or the loop continuing below)
				// will try again.
				console.warn("player-store: failed to load the live waxml graph", err);
			}
		} while (this._reloadPending);
		this._reloadInFlight = false;
	}

	// Per Hans (2026-09-01, refined 2026-09-10): waxml.js's sectionStart only
	// ends up set correctly when trig() is called with a *class* selector,
	// not an [id='...'] one — so the PLAY/STOP field auto-follows the most
	// recently selected element's own class ("." prefixed). No longer falls
	// back to "#id" when there's no class (2026-09-10): a freshly created
	// <Command> auto-selects itself and has no class of its own, so that
	// fallback used to populate the field with "#Cmd-N" — meaning a second
	// "+" click created a Command that triggered the *first* Command instead
	// of whatever was actually meant. Selecting a <Command type="trig">
	// itself is special-cased to show *its own* `value` instead (what it
	// actually trig()s) — informative, and never that self-referencing
	// "#Cmd-N" shape. Runs on every xmlStore change, not just a fresh
	// selection, so editing the currently-armed element's own class/value
	// updates it too.
	_maybeUpdateTriggerSelectorFromSelection() {
		const node = xmlStore.getSelectedNode();
		if (!node) return;
		let selector;
		if (node.tagName === "Command" && (node.attributes.type || "trig") === "trig" && node.attributes.value) {
			selector = node.attributes.value;
		} else {
			const firstClass = firstClassToken(node);
			if (!firstClass) return;
			selector = `.${firstClass}`;
		}
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

	// Fires a one-off trig for an arbitrary selector (a trigger-shortcut
	// Command button, a Section's/Stinger's own round play button, a ruler
	// click, ...). Per Hans (2026-09-09): whatever selector actually gets
	// sent to waxml.js is always reflected in the PLAY field too — no matter
	// which of those triggered it — so the field is always an honest record
	// of "what was last told to play", not just "what the main PLAY button
	// itself targets". `sectionId`, when the caller knows the selector
	// resolves to an actual <Section> (e.g. wa-composition-view.js's own
	// _triggerSection), keeps activeSectionId in sync the same way
	// setTriggerSelector's own selection-driven path does; omit it (null)
	// for anything else. Loads the document first if it isn't already, so a
	// shortcut works even before the main PLAY button has ever been pressed.
	async trigShortcut(selector, sectionId = null) {
		if (!selector || !xmlStore.root) return;
		if (!this._documentLoaded) await this._reloadDocument();
		this.triggerSelector = selector;
		this.activeSectionId = sectionId;
		bridge.trig(selector);
		this.isPlaying = true;
		this._emit();
	}

	// Pushes a live value into a <Var> by name (see wa-var-knobs.js) —
	// independent of isPlaying/triggerSelector, same as trigShortcut, but
	// doesn't reload the document first: a <Var>'s own Variable object exists
	// as soon as the graph is loaded at all, and turning a Var knob before
	// the graph has ever loaded wouldn't mean anything yet anyway (nothing
	// would be listening).
	setVariable(name, value) {
		if (!this._documentLoaded || !name) return;
		try {
			bridge.setVariable(name, value);
		} catch {
			// waxml not loaded — nothing we can do until it is.
		}
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
