// A sensible output range for a <Var> driving one attribute — what a new
// mapping's `mapout` starts as when an INPUT entry is mapped straight onto a
// parameter (see input-mapping.js). Per Hans (2026-10-09): "frequency -
// 20,10000, gain - 0,1, gain på filter - -40, +40, etc".
//
// "Tag.attr" entries win over a plain "attr" one; anything not listed falls
// back on the min/max the schema gives the attribute (when both exist and
// are finite), and finally on 0,1.

const BY_TAG_AND_ATTRIBUTE = {
	"BiquadFilterNode.gain": [-40, 40],
	"BiquadFilterNode.Q": [0.1, 20],
	"BiquadFilterNode.frequency": [20, 10000],
	"OscillatorNode.frequency": [20, 10000]
};

const BY_ATTRIBUTE = {
	frequency: [20, 10000],
	detune: [-1200, 1200],
	gain: [0, 1],
	pan: [-1, 1],
	Q: [0.1, 20],
	delayTime: [0, 2],
	threshold: [-100, 0],
	knee: [0, 40],
	ratio: [1, 20],
	attack: [0, 1],
	release: [0, 1],
	playbackRate: [0.25, 4],
	positionX: [-10, 10],
	positionY: [-10, 10],
	positionZ: [-10, 10],
	orientationX: [-1, 1],
	orientationY: [-1, 1],
	orientationZ: [-1, 1],
	refDistance: [1, 10],
	maxDistance: [1, 100],
	rolloffFactor: [0, 10],
	coneInnerAngle: [0, 360],
	coneOuterAngle: [0, 360],
	coneOuterGain: [0, 1],
	tempo: [60, 200],
	transitionTime: [0, 1000],
	fadeTime: [0, 5000],
	blend: [0, 1],
	solo: [0, 1],
	fftSize: [32, 32768],
	smoothingTimeConstant: [0, 1]
};

export function mapoutRangeFor(tagName, attrName, attrSchema) {
	const exact = BY_TAG_AND_ATTRIBUTE[`${tagName}.${attrName}`] ?? BY_ATTRIBUTE[attrName];
	if (exact) return exact;
	const members = attrSchema?.type === "union" ? attrSchema.unionMembers || [] : [attrSchema];
	for (const m of members) {
		if (m && Number.isFinite(m.minValue) && Number.isFinite(m.maxValue) && m.maxValue > m.minValue) return [m.minValue, m.maxValue];
	}
	return [0, 1];
}
