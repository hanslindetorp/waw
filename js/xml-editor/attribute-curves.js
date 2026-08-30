import { getSmartRange } from "./attribute-controls.js";
import { parseGainAttributeToDb, formatGainAttribute, gainDbRangeForTag } from "../waxml-integration/gain-units.js";

// How a number-attribute's <input type="range"> maps its own 0-1-or-native
// position to the attribute's real value, and back to the string actually
// written to XML — per Hans: most attributes are a plain linear mapping
// (unchanged from before), but a few need something else:
//   - "gain": drags in dB, writes the node-appropriate string form (see
//     gain-units.js — a bare number for a dB-native node like
//     BiquadFilterNode, an explicit "XdB" string otherwise).
//   - "frequency": logarithmic, so equal slider distance covers equal
//     *ratio* (octave), not equal Hz — matches wa-mixer-view.js's own
//     frequency knob. `detune` is explicitly NOT logarithmic (linear cents).
//   - time-like attributes (transitionTime, fadeTime, any *Time/*Delay/
//     *Duration attribute): also logarithmic, for the same reason — fine
//     control over the small values, which matter most, rather than most
//     of the slider's travel being wasted on values nobody uses.
//
// A curve is { sliderMin, sliderMax, sliderStep, numberStep,
//   positionToValue(pos), valueToPosition(value), parse(rawAttrString),
//   format(value), displayRound(value), unit? }. `parse`/`format` round-trip
// through the XML attribute's own string form; `positionToValue`/
// `valueToPosition` only concern the <input type="range">'s own position.
// `unit`, when present, is shown next to the number field (e.g. "dB") —
// the number field itself always shows/edits the plain real value (the
// unit is never part of what you type), since native <input type="number">
// can't hold non-numeric text.
export function getAttributeCurve(attrName, tagName, schemaMin, schemaMax) {
	if (attrName === "gain") return gainCurve(tagName);
	if (attrName === "frequency") return logCurve(schemaMin, schemaMax, 20000, (v) => String(Math.round(v)), 1);
	if (attrName !== "detune" && /time|delay|duration/i.test(attrName)) {
		return logCurve(schemaMin, schemaMax, 10000, (v) => String(Math.round(v * 10) / 10), 0.1);
	}
	return linearCurve(attrName, schemaMin, schemaMax);
}

function linearCurve(attrName, schemaMin, schemaMax) {
	const range = getSmartRange(attrName, schemaMin, schemaMax);
	return {
		sliderMin: range.min,
		sliderMax: range.max,
		sliderStep: range.step,
		numberStep: range.step,
		positionToValue: (pos) => pos,
		valueToPosition: (value) => value,
		parse: (raw) => parseFloat(raw),
		format: (value) => String(value),
		displayRound: (value) => value
	};
}

// Web Audio's GainNode.gain is linear, but the *slider* always drags in dB
// (matching the Mixer's own gain knobs) — 0-1 linear ratio is a poor UI
// scale (way too much travel spent above 0.1, almost none below it), while
// dB reads evenly by ear at any level. floor/ceil come from gainDbRangeForTag
// (narrow ±dB for a BiquadFilterNode's EQ-band-like gain, wider fader-like
// range for anything else — same numbers wa-mixer-view.js's own knobs use).
function gainCurve(tagName) {
	const { min, max } = gainDbRangeForTag(tagName);
	return {
		sliderMin: min,
		sliderMax: max,
		sliderStep: 0.1,
		numberStep: 0.1,
		positionToValue: (pos) => pos,
		valueToPosition: (value) => value,
		parse: (raw) => parseGainAttributeToDb(tagName, raw),
		format: (db) => formatGainAttribute(tagName, db),
		displayRound: (db) => Math.round(db * 10) / 10,
		unit: "dB"
	};
}

// A log curve can't include 0 (log(0) is undefined) — floor to a small,
// still-practically-silent/instant value when the schema's own min is 0,
// same idea as wa-mixer-view.js's FREQ_MIN=40Hz floor on its own knob.
function logCurve(schemaMin, schemaMax, fallbackMax, format, numberStep) {
	const floor = Number.isFinite(schemaMin) && schemaMin > 0 ? schemaMin : 1;
	const ceil = Number.isFinite(schemaMax) && schemaMax > floor ? schemaMax : fallbackMax;
	const logRange = Math.log(ceil / floor);
	return {
		sliderMin: 0,
		sliderMax: 1,
		sliderStep: 0.001,
		numberStep,
		positionToValue: (pos) => floor * Math.exp(Math.max(0, Math.min(1, pos)) * logRange),
		valueToPosition: (value) => Math.log(Math.max(floor, Math.min(ceil, value)) / floor) / logRange,
		parse: (raw) => parseFloat(raw),
		format,
		displayRound: (value) => Math.round(value * 10) / 10
	};
}
