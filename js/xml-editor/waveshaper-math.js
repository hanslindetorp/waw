// Pure math for the WaveShaperNode bezier curve editor (wa-chain-view.js):
// resamples a single cubic bezier segment (P0 -> C1 -> C2 -> P3, all in
// [-1,1] x/y space) into a uniformly-x-spaced sample array — the shape
// WaveShaperNode.curve itself needs (per the Web Audio spec, curve[i] is
// the output for input = -1 + 2*i/(curve.length-1)). Never touches
// waxml.js. Per Hans (2026-09-27).
//
// The bezier is a *parametric* curve (x(t), y(t)) so it isn't naturally a
// function of x — resampled here by densely sampling t, then for each
// target x picking the closest sampled point. Robust even when the curve
// isn't perfectly x-monotonic (dragged handles can briefly fold it), unlike
// a bisection search which requires strict monotonicity.

export const CURVE_SAMPLE_COUNT = 256;
const DENSE_T_SAMPLES = 1024;

function cubicBezierPoint(p0, c1, c2, p3, t) {
	const mt = 1 - t;
	const a = mt * mt * mt;
	const b = 3 * mt * mt * t;
	const c = 3 * mt * t * t;
	const d = t * t * t;
	return {
		x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
		y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
	};
}

// The default "straight line" bezier — control handles sit on the diagonal,
// so the curve is exactly y=x (no distortion) until a user drags a handle.
export function defaultBezierPoints() {
	return {
		p0: { x: -1, y: -1 },
		c1: { x: -1 / 3, y: -1 / 3 },
		c2: { x: 1 / 3, y: 1 / 3 },
		p3: { x: 1, y: 1 }
	};
}

// Returns a length-`sampleCount` array of y values for x uniformly spaced
// across [-1, 1] — ready to write straight into WaveShaperNode.curve.
export function sampleBezierToCurve({ p0, c1, c2, p3 }, sampleCount = CURVE_SAMPLE_COUNT) {
	const dense = [];
	for (let i = 0; i < DENSE_T_SAMPLES; i++) {
		dense.push(cubicBezierPoint(p0, c1, c2, p3, i / (DENSE_T_SAMPLES - 1)));
	}
	const out = new Array(sampleCount);
	for (let i = 0; i < sampleCount; i++) {
		const targetX = -1 + (2 * i) / (sampleCount - 1);
		let bestIdx = 0;
		let bestDist = Infinity;
		for (let j = 0; j < dense.length; j++) {
			const d = Math.abs(dense[j].x - targetX);
			if (d < bestDist) {
				bestDist = d;
				bestIdx = j;
			}
		}
		out[i] = dense[bestIdx].y;
	}
	return out;
}
