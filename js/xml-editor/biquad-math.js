// Pure math for rendering a BiquadFilterNode's frequency response curve —
// the exact per-type coefficient formulas from the Web Audio API spec's
// "Filters characteristics" section (itself the well-known RBJ Audio EQ
// Cookbook formulas). Used by wa-chain-view.js's BiquadFilterNode card to
// draw (and hit-test) the curve; never touches waxml.js — this is this
// app's own reimplementation for the editor UI, same relationship
// var-mapper-math.js has to the live Mapper class. Per Hans (2026-09-27),
// as part of the <Chain> node-preview work.

// Web Audio's own Q parameter has no effect on lowshelf/highshelf (per
// spec, shelving filters use a fixed slope instead) — S=1 here matches
// that fixed slope exactly, so callers never need to special-case Q away
// for those two types themselves; passing any Q still produces the same
// curve.
const SHELF_SLOPE = 1;

// Computes normalized {b0, b1, b2, a1, a2} (already divided by a0) for the
// given filter type/frequency/Q/gain at the given sample rate. gainDb is
// only meaningful for peaking/lowshelf/highshelf — ignored otherwise.
export function computeBiquadCoeffs(type, freq, Q, gainDb, sampleRate) {
	const f0 = Math.max(1, Math.min(sampleRate / 2 - 1, freq));
	const w0 = (2 * Math.PI * f0) / sampleRate;
	const cosw0 = Math.cos(w0);
	const sinw0 = Math.sin(w0);
	const A = Math.pow(10, (gainDb || 0) / 40);

	let alpha;
	if (type === "lowshelf" || type === "highshelf") {
		alpha = (sinw0 / 2) * Math.sqrt((A + 1 / A) * (1 / SHELF_SLOPE - 1) + 2);
	} else {
		const q = Math.max(0.0001, Q);
		alpha = sinw0 / (2 * q);
	}

	let b0, b1, b2, a0, a1, a2;
	switch (type) {
		case "highpass":
			b0 = (1 + cosw0) / 2;
			b1 = -(1 + cosw0);
			b2 = (1 + cosw0) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cosw0;
			a2 = 1 - alpha;
			break;
		case "bandpass":
			b0 = alpha;
			b1 = 0;
			b2 = -alpha;
			a0 = 1 + alpha;
			a1 = -2 * cosw0;
			a2 = 1 - alpha;
			break;
		case "notch":
			b0 = 1;
			b1 = -2 * cosw0;
			b2 = 1;
			a0 = 1 + alpha;
			a1 = -2 * cosw0;
			a2 = 1 - alpha;
			break;
		case "allpass":
			b0 = 1 - alpha;
			b1 = -2 * cosw0;
			b2 = 1 + alpha;
			a0 = 1 + alpha;
			a1 = -2 * cosw0;
			a2 = 1 - alpha;
			break;
		case "peaking":
			b0 = 1 + alpha * A;
			b1 = -2 * cosw0;
			b2 = 1 - alpha * A;
			a0 = 1 + alpha / A;
			a1 = -2 * cosw0;
			a2 = 1 - alpha / A;
			break;
		case "lowshelf": {
			const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
			b0 = A * (A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha);
			b1 = 2 * A * (A - 1 - (A + 1) * cosw0);
			b2 = A * (A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha);
			a0 = A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha;
			a1 = -2 * (A - 1 + (A + 1) * cosw0);
			a2 = A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha;
			break;
		}
		case "highshelf": {
			const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
			b0 = A * (A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha);
			b1 = -2 * A * (A - 1 + (A + 1) * cosw0);
			b2 = A * (A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha);
			a0 = A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha;
			a1 = 2 * (A - 1 - (A + 1) * cosw0);
			a2 = A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha;
			break;
		}
		case "lowpass":
		default:
			b0 = (1 - cosw0) / 2;
			b1 = 1 - cosw0;
			b2 = (1 - cosw0) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cosw0;
			a2 = 1 - alpha;
			break;
	}

	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Magnitude response in dB at a given frequency, for coefficients already
// computed by computeBiquadCoeffs (or fresh — computes them itself if
// `type`/`freq`/`Q`/`gainDb`/`sampleRate` are passed instead of `coeffs`).
export function biquadMagnitudeDb(coeffs, evalFreq, sampleRate) {
	const w = (2 * Math.PI * evalFreq) / sampleRate;
	const c1 = Math.cos(w),
		s1 = Math.sin(w);
	const c2 = Math.cos(2 * w),
		s2 = Math.sin(2 * w);

	const numRe = coeffs.b0 + coeffs.b1 * c1 + coeffs.b2 * c2;
	const numIm = -coeffs.b1 * s1 - coeffs.b2 * s2;
	const denRe = 1 + coeffs.a1 * c1 + coeffs.a2 * c2;
	const denIm = -coeffs.a1 * s1 - coeffs.a2 * s2;

	const magNum = Math.hypot(numRe, numIm);
	const magDen = Math.hypot(denRe, denIm) || 1e-9;
	const mag = magNum / magDen || 1e-9;
	return 20 * Math.log10(mag);
}

// Convenience: response in dB for a whole array of frequencies at once.
export function biquadResponseCurve(type, freq, Q, gainDb, sampleRate, evalFreqs) {
	const coeffs = computeBiquadCoeffs(type, freq, Q, gainDb, sampleRate);
	return evalFreqs.map((f) => biquadMagnitudeDb(coeffs, f, sampleRate));
}

// Log-frequency <-> normalized-x (0-1) helpers shared by the graph's
// drawing and hit-testing/drag code, so they can never drift apart.
export const GRAPH_FREQ_MIN = 20;
export const GRAPH_FREQ_MAX = 20000;
const FREQ_LOG_RANGE = Math.log2(GRAPH_FREQ_MAX / GRAPH_FREQ_MIN);

export function freqToX(freq) {
	const t = Math.log2(Math.max(GRAPH_FREQ_MIN, Math.min(GRAPH_FREQ_MAX, freq)) / GRAPH_FREQ_MIN) / FREQ_LOG_RANGE;
	return t;
}

export function xToFreq(t) {
	return GRAPH_FREQ_MIN * Math.pow(2, Math.max(0, Math.min(1, t)) * FREQ_LOG_RANGE);
}

// Types whose `gain` attribute actually affects the curve shape, per the
// Web Audio spec (everything else ignores gain entirely).
export const BIQUAD_GAIN_TYPES = new Set(["peaking", "lowshelf", "highshelf"]);
// Types whose Q affects the curve shape (shelving filters don't, per spec —
// see SHELF_SLOPE above).
export const BIQUAD_Q_TYPES = new Set(["lowpass", "highpass", "bandpass", "peaking", "notch", "allpass"]);
