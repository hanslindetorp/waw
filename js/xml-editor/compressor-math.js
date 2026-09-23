// Pure math for rendering a DynamicsCompressorNode's classic input/output
// transfer curve — a standard soft-knee compressor transfer function (the
// same shape used by most compressor UIs: a straight 1:1 line below the
// knee, a straight 1/ratio-slope line above it, and a smooth quadratic
// blend across the knee width in between). Used by wa-chain-view.js's
// DynamicsCompressorNode card. Never touches waxml.js — this app's own
// reimplementation for the editor UI, same relationship var-mapper-math.js
// has to the live Mapper class. Per Hans (2026-09-27).

// inputDb/thresholdDb: dBFS. ratio: e.g. 4 means 4:1. kneeDb: knee width in
// dB, centered on thresholdDb (kneeDb=0 is a hard knee).
export function compressorOutputDb(inputDb, thresholdDb, ratio, kneeDb) {
	const halfKnee = Math.max(0, kneeDb) / 2;
	if (inputDb < thresholdDb - halfKnee) return inputDb;
	if (inputDb > thresholdDb + halfKnee) return thresholdDb + (inputDb - thresholdDb) / ratio;
	// Soft-knee quadratic blend (Reiss & McPherson's "Audio Effects" formula).
	const x = inputDb - thresholdDb + halfKnee;
	return inputDb + (1 / ratio - 1) * (x * x) / (2 * Math.max(1e-6, kneeDb));
}

export function compressorResponseCurve(thresholdDb, ratio, kneeDb, inputDbs) {
	return inputDbs.map((x) => compressorOutputDb(x, thresholdDb, ratio, kneeDb));
}
