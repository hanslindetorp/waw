// Converts a linear amplitude ratio (the XML "gain" attribute's own 0-1
// form — see the `gain` simpleType in waxml.xsd) to dB. 1 is unity gain
// (0dB), 0 is silence (-Infinity dB), and everything between follows the
// standard 20*log10 AMPLITUDE-ratio conversion — not the 10*log10
// power-ratio one. Web Audio's GainNode.gain is a linear amplitude
// multiplier, so e.g. 0.5 is -6.02dB, not -3dB (which is instead the
// power-halving point, for a param whose native unit is power rather than
// amplitude).
export function linearRatioToDb(ratio) {
	return ratio <= 0 ? -Infinity : 20 * Math.log10(ratio);
}

// Inverse of linearRatioToDb. Naturally -> 0 as db -> -Infinity
// (Math.pow(10, -Infinity) === 0 in JS), no special floor-casing needed.
export function dbToLinearRatio(db) {
	return Math.pow(10, db / 20);
}

// Which node types have a NATIVE-dB gain param in Web Audio
// (BiquadFilterNode) vs. a native-LINEAR one (GainNode, Send's underlying
// bus, ...) — same distinction wa-mixer-view.js's own knobs already draw
// (there: isLinearGainNode).
export function isDbNativeGain(tagName) {
	return tagName === "BiquadFilterNode";
}

// Parses a `gain` attribute's raw XML value — a 0-1 linear ratio, a
// "-XdB"/"XdB" string, or (only meaningful for a dB-native node) a bare
// numeric dB value — into a plain dB float, given the owning node's tag.
export function parseGainAttributeToDb(tagName, rawValue) {
	if (rawValue === undefined || rawValue === null || rawValue === "") return 0;
	const str = String(rawValue).trim();
	const dbMatch = /^(-?\d+(\.\d+)?)dB$/i.exec(str);
	if (dbMatch) return parseFloat(dbMatch[1]);
	const num = parseFloat(str);
	if (!Number.isFinite(num)) return 0; // a mathExpression or unparseable value — fall back to unity for display
	return isDbNativeGain(tagName) ? num : linearRatioToDb(num);
}

// Formats a dB float back into the `gain` attribute's own writing
// convention for the owning node's tag — per Hans: a BiquadFilterNode's
// gain is native dB in Web Audio already, so it gets a bare number (the
// unit's implied, "even i fortsättningen"); anything else (GainNode,
// Send, ...) is native LINEAR, so it gets an explicit "XdB" string — a
// bare number there would mean the *linear* 0-1 ratio instead, per the
// schema's own "gain" union type.
export function formatGainAttribute(tagName, db) {
	const rounded = Math.round(db * 10) / 10;
	if (isDbNativeGain(tagName)) return String(rounded);
	return db === -Infinity ? "0" : `${rounded}dB`;
}

// Shared dB ranges for a gain-drag control — a BiquadFilterNode's EQ band
// realistically only needs ±15dB; anything else (a fader-like GainNode)
// needs to reach down toward silence. Centralized here (rather than
// duplicated per UI) so wa-mixer-view.js's own knobs/fader and
// wa-node-inspector.js's gain slider can never drift apart on the actual
// numbers.
export const EQ_GAIN_MIN_DB = -15;
export const EQ_GAIN_MAX_DB = 15;
export const FADER_GAIN_MIN_DB = -60;
export const FADER_GAIN_MAX_DB = 9;

export function gainDbRangeForTag(tagName) {
	return isDbNativeGain(tagName) ? { min: EQ_GAIN_MIN_DB, max: EQ_GAIN_MAX_DB } : { min: FADER_GAIN_MIN_DB, max: FADER_GAIN_MAX_DB };
}
