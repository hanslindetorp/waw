import { formatGainAttribute } from "../waxml-integration/gain-units.js";

// The one place that says what an element's parameters are when nothing has
// been set. Per Hans (2026-10-16): attributes that were never written used to
// be invisible — Snapshots missed them, cards showed one value while the
// engine played another (a filter card said 1000 Hz, the engine's resting
// frequency is 350) — so two things are separated here:
//
//   ENGINE_DEFAULTS    what an ABSENT attribute means: what the audio engine
//                      does with it. Native units (a GainNode's gain is the
//                      linear ratio, a BiquadFilterNode's is dB). Checked
//                      against the live engine on 2026-10-16 where it exposes
//                      the property (oscillator, filter, gain, panner, delay);
//                      Web Audio's own defaults otherwise (the compressor).
//   CREATION_VALUES    what is WRITTEN, as attributes, when the user creates
//                      the element — the values its card has always started
//                      at — so the parameters you turn are in the document
//                      from the start, where Snapshots, the Stage and the
//                      assessment can see them. Only the parameters with a
//                      control on the element's card: not types, routing,
//                      detune or the analyser's display settings.
//
// Reading code asks engineDefault()/withEngineDefaults() for an attribute that
// is missing; nothing rewrites existing documents.

export const ENGINE_DEFAULTS = {
	OscillatorNode: { frequency: 440 },
	BiquadFilterNode: { frequency: 350, Q: 1, gain: 0 },
	GainNode: { gain: 1 },
	DynamicsCompressorNode: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
	StereoPannerNode: { pan: 0 },
	DelayNode: { delayTime: 0 },
	PannerNode: { positionX: 0, positionY: 0, positionZ: 0 }
};

const CREATION_VALUES = {
	OscillatorNode: () => ({ frequency: "440" }),
	BiquadFilterNode: () => ({ frequency: "1000", Q: "1", gain: "0" }),
	GainNode: () => ({ gain: formatGainAttribute("GainNode", 0) }),
	DynamicsCompressorNode: () => ({ threshold: "-24", knee: "6", ratio: "4", attack: "0.003", release: "0.25" }),
	StereoPannerNode: () => ({ pan: "0" }),
	DelayNode: () => ({ delayTime: "0.3" }),
	PannerNode: () => ({ positionX: "0", positionY: "0", positionZ: "-1" })
};

// What a missing attribute is, as a number in the attribute's native unit —
// undefined when the engine's default isn't tracked here.
export function engineDefault(tagName, attrName) {
	return ENGINE_DEFAULTS[tagName]?.[attrName];
}

// The attributes a newly created element gets (a fresh object each time).
export function creationAttributes(tagName) {
	return CREATION_VALUES[tagName]?.() ?? {};
}

// A node's attributes with the tracked parameters it doesn't have written out
// filled in with what the engine would use, as attribute strings — the
// effective state of the element, for whatever must capture all of it.
export function withEngineDefaults(node) {
	const out = { ...node.attributes };
	const defaults = ENGINE_DEFAULTS[node.tagName];
	if (!defaults) return out;
	for (const [name, value] of Object.entries(defaults)) {
		if (out[name] !== undefined) continue;
		out[name] = node.tagName === "GainNode" && name === "gain" ? formatGainAttribute("GainNode", value === 0 ? -Infinity : 20 * Math.log10(value)) : String(value);
	}
	return out;
}
