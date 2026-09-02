import { playerStore } from "./player-store.js";

// Applies a value directly to a node's *live* waxml object, if one exists
// right now (i.e. the graph is currently loaded — playerStore.isDocumentLoaded,
// which no longer requires Play to have ever been pressed, see
// player-store.js — and this node survived into it) — no engine reload, an
// immediate, click-free change via waxml's own setTargetAtTime-backed
// property setters. A no-op whenever no graph is loaded — xmlStore is
// always the source of truth; this is purely a "also nudge whatever's
// currently live to match" side channel. Shared by every component that
// edits a live-audio-relevant attribute (wa-mixer-view's own knobs/faders,
// wa-node-inspector's attribute sliders, ...), so any of them behaves the
// same way.
export function applyLiveProperty(nodeId, propName, value) {
	if (!playerStore.isDocumentLoaded || !nodeId) return;
	let liveObj;
	try {
		const matches = playerStore.getLiveObjects(`[id='${nodeId}']`);
		liveObj = matches && matches[0];
	} catch {
		liveObj = null;
	}
	if (!liveObj) return;
	try {
		liveObj[propName] = value;
	} catch {
		// A property this node type doesn't actually support (e.g. the node
		// wasn't the shape we expected) — not worth surfacing, the XML
		// attribute is still the source of truth and already updated.
	}
}

// Reads a value straight off a node's *live* waxml object — the read
// counterpart to applyLiveProperty above, used for attributes that are
// currently remote-controlled by a <Var> (a "$name"-style value — see
// variable-references.js): once waxml.js resolves that reference, the XML
// attribute itself stays the literal "$name" string forever, so the only
// place the actual current value ever shows up is the live object's own
// property. Returns undefined whenever nothing live can answer (no graph
// loaded, node not found, or the property genuinely isn't there) — callers
// should treat that as "nothing to show yet", not an error.
export function getLiveProperty(nodeId, propName) {
	if (!playerStore.isDocumentLoaded || !nodeId) return undefined;
	let liveObj;
	try {
		const matches = playerStore.getLiveObjects(`[id='${nodeId}']`);
		liveObj = matches && matches[0];
	} catch {
		return undefined;
	}
	if (!liveObj) return undefined;
	try {
		return liveObj[propName];
	} catch {
		return undefined;
	}
}

// Same idea as applyLiveProperty, but for nudging the live graph via a
// *method* rather than a property assignment (e.g. Mixer's own
// clearSolo()) — same lookup, same no-op-when-no-graph-loaded/not-found
// behavior, same "never worth surfacing a failure here" reasoning.
export function applyLiveMethodCall(nodeId, methodName, ...args) {
	if (!playerStore.isDocumentLoaded || !nodeId) return;
	let liveObj;
	try {
		const matches = playerStore.getLiveObjects(`[id='${nodeId}']`);
		liveObj = matches && matches[0];
	} catch {
		liveObj = null;
	}
	if (!liveObj || typeof liveObj[methodName] !== "function") return;
	try {
		liveObj[methodName](...args);
	} catch {
		// Same reasoning as applyLiveProperty's own catch above.
	}
}
