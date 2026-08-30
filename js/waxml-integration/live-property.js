import { playerStore } from "./player-store.js";

// Applies a value directly to a node's *live* waxml object, if one exists
// right now (i.e. playback is running and this node survived into the
// currently-loaded engine graph) — no engine reload, an immediate,
// click-free change via waxml's own setTargetAtTime-backed property
// setters. A no-op whenever nothing's playing — xmlStore is always the
// source of truth; this is purely a "also nudge the currently-sounding
// audio to match" side channel. Shared by every component that edits a
// live-audio-relevant attribute (wa-mixer-view's own knobs/faders,
// wa-node-inspector's attribute sliders, ...), so any of them behaves the
// same way during playback.
export function applyLiveProperty(nodeId, propName, value) {
	if (!playerStore.isPlaying || !nodeId) return;
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
