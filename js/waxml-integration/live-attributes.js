// Which attribute changes the running audio graph can take without being
// rebuilt (xmlStore's non-structural edits), and which need a full reload
// (updateFromString). Per Hans (2026-10-28): "students wait minutes before a
// change is heard" came from attribute edits that were written to the XML but
// never reached the engine (a renamed id/class, a new src, an enum, a removed
// attribute...) — the live graph only changed on the next unrelated reload. So
// the rule is now an allowlist: only the continuous parameters below, with a
// plain numeric value, skip the reload; everything else gets one.
//
// Imported by xml-store.js (the decision) and player-store.js (pushing the
// change into the live objects, so every editor — Inspector, XML tree, cards —
// is heard, not just the ones that push by themselves).

// Continuous parameters (AudioParams and plain numeric properties) the live
// objects accept as a number — or, for gain, a raw "XdB" string, which
// waxml.js converts itself.
const LIVE_NUMERIC_ATTRS = new Set([
	"gain", "frequency", "detune", "Q", "pan", "delayTime", "threshold", "knee", "ratio", "attack", "release",
	"positionX", "positionY", "positionZ", "orientationX", "orientationY", "orientationZ",
	"refDistance", "rolloffFactor", "coneInnerAngle", "coneOuterAngle", "coneOuterGain",
	"fftSize", "minDecibels", "maxDecibels", "smoothingTimeConstant",
	"transitionTime", "blend", "solo"
]);

// Text values with a working live setter (tag.attribute).
const LIVE_TEXT_ATTRS = new Set(["BiquadFilterNode.type", "WaveShaperNode.oversample"]);

// Removals the UI has already applied to the live object itself.
const LIVE_REMOVABLE_ATTRS = new Set(["Mixer.solo"]);

// Never reach the engine, so changing them never needs a reload.
const APP_ONLY_ATTRS = new Set(["label"]);

// Pushed live by the Mixer view itself in a way a second push would repeat
// (a quantized solo schedules its own change).
const NOT_PUSHED_BY_STORE = new Set(["solo"]);

const NUMERIC_VALUE_RE = /^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*(dB)?\s*$/i;

// Whether changing `name` from `was` to `now` on a `tagName` element can be
// left to the live graph (true) or needs the document reloaded (false).
// undefined means absent.
export function isLiveAttributeChange(tagName, name, was, now) {
	if (APP_ONLY_ATTRS.has(name)) return true;
	// A WAM plugin's parameters are pushed into the plugin by wam-gui.js.
	if (tagName === "Parameter" && name === "value") return true;
	if (now === undefined) return LIVE_REMOVABLE_ATTRS.has(`${tagName}.${name}`);
	if (LIVE_TEXT_ATTRS.has(`${tagName}.${name}`)) return true;
	if (!LIVE_NUMERIC_ATTRS.has(name)) return false;
	return NUMERIC_VALUE_RE.test(now) && (was === undefined || NUMERIC_VALUE_RE.test(was));
}

// The changed attributes (name -> value as the live setter wants it) that the
// store should push into the running graph, from an edit's old and new
// attributes. Empty when the edit isn't one of the live kinds.
export function liveAttributePushes(tagName, previous, next) {
	const pushes = {};
	for (const [name, value] of Object.entries(next)) {
		if (value === previous[name] || NOT_PUSHED_BY_STORE.has(name)) continue;
		if (LIVE_TEXT_ATTRS.has(`${tagName}.${name}`)) pushes[name] = value;
		else if (LIVE_NUMERIC_ATTRS.has(name) && NUMERIC_VALUE_RE.test(value)) pushes[name] = name === "gain" ? String(value).trim() : parseFloat(value);
	}
	return pushes;
}
