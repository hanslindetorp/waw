// Faithful, numeric-only reimplementation of the relevant slice of waxml.js's
// own Mapper class (mapin/mapout/curve/pattern/offset/convert — see
// waxml.js's Mapper.mapValue and friends) — verified line-by-line against
// that source. NOTE (2026-09-24): waxml.js's own attribute is still named
// "steps" as of this writing — Hans is renaming it to "pattern" engine-side
// himself; this module (and the schema) already use the new name.
// Used by wa-var-view.js to draw its interactive mapin/mapout+curve+pattern
// graph and its convert graph (including the live dot), without touching
// waxml.js itself: this is purely this app's own mirror of the engine's math,
// so the editor always shows what the real engine will actually produce.
//
// Deliberately scoped to numeric mapin/mapout only (Mapper also supports a
// string-keyed lookup mode — mapping discrete string values instead of
// interpolating a range — which is out of scope for this graphical editor;
// see Mapper.getValue's "string" case in waxml.js for that other mode).
//
// A single global `curve`/`convert` value only (a plain string, not the
// per-segment array waxml.js's own comma/semicolon-split attribute parsing
// produces) — matches wa-var-view.js's simpler one-Var-one-curve UI. Since
// waxml.js indexes those arrays as `arr[i % arr.length]`, a length-1 array
// always resolves to that one value regardless of segment index `i`, so this
// is mathematically equivalent for everything the UI itself can produce.

const EaseIn = (power) => (t) => Math.pow(t, power);
const EaseOut = (power) => (t) => 1 - Math.abs(Math.pow(t - 1, power));
const EaseInOut = (power) => (t) => (t < 0.5 ? EaseIn(power)(t * 2) / 2 : EaseOut(power)(t * 2 - 1) / 2 + 0.5);
const EaseInSin = (t) => 1 + Math.sin((Math.PI / 2) * t - Math.PI / 2);
const EaseOutSin = (t) => Math.sin((Math.PI / 2) * t);
const EaseInOutSin = (t) => (1 + Math.sin(Math.PI * t - Math.PI / 2)) / 2;
const EaseInElastic = (t) => (0.04 - 0.04 / t) * Math.sin(25 * t) + 1;
const EaseOutElastic = (t) => ((0.04 * t) / (t - 1)) * Math.sin(25 * (t - 1));
const EaseInOutElastic = (t) => {
	const s = t - 0.5;
	return s < 0 ? (0.02 + 0.01 / s) * Math.sin(50 * s) : (0.02 - 0.01 / s) * Math.sin(50 * s) + 1;
};

function bellFn(x, stdD, mean) {
	return 1 / ((1 / (stdD * Math.sqrt(2 * Math.PI))) * Math.pow(Math.E, (-1 * Math.pow(x - mean, 2)) / (2 * Math.pow(stdD, 2))));
}
function mapToBell(x, stdD = 1 / 4, mean = 0.5) {
	const max = bellFn(0, stdD, mean);
	const min = bellFn(mean, stdD, mean);
	const bx = bellFn(x, stdD, mean);
	return (max - bx) / (max - min);
}

// Same switch as Mapper.applyCurve (waxml.js) — x here is the relative (0-1)
// position within the current mapout segment.
export function applyCurveFn(curveValue, x) {
	if (curveValue === undefined || curveValue === null || curveValue === "") return x;
	if (typeof curveValue === "string" && curveValue.trim() !== "" && !Number.isNaN(Number(curveValue))) {
		return Math.pow(x, Number(curveValue));
	}
	switch (curveValue) {
		case "step":
		case "steps":
			return 0;
		case "lin":
		case "linear":
			return x;
		case "easeInQuad":
		case "easeIn":
			return EaseIn(2)(x);
		case "easeOutQuad":
		case "easeOut":
			return EaseOut(2)(x);
		case "easeInOutQuad":
		case "easeInOut":
			return EaseInOut(2)(x);
		case "easeInCubic":
			return EaseIn(3)(x);
		case "easeOutCubic":
			return EaseOut(3)(x);
		case "easeInOutCubic":
			return EaseInOut(3)(x);
		case "easeInQuart":
			return EaseIn(4)(x);
		case "easeOutQuart":
			return EaseOut(4)(x);
		case "easeInOutQuart":
			return EaseInOut(4)(x);
		case "easeInQuint":
			return EaseIn(5)(x);
		case "easeOutQuint":
			return EaseOut(5)(x);
		case "easeInOutQuint":
			return EaseInOut(5)(x);
		case "easeInSin":
		case "easeInSine":
			return EaseInSin(x);
		case "easeOutSin":
		case "easeOutSine":
			return EaseOutSin(x);
		case "easeInOutSin":
		case "easeInOutSine":
			return EaseInOutSin(x);
		case "easeInElastic":
			return EaseInElastic(x);
		case "easeOutElastic":
			return EaseOutElastic(x);
		case "easeInOutElastic":
			return EaseInOutElastic(x);
		case "bell":
			return mapToBell(x);
		case "sine":
			return Math.sin(2 * x * Math.PI) / 2 + 0.5;
		case "half-sine":
			return Math.sin(x * Math.PI);
		default:
			return x;
	}
}

function midiNoteToFrequency(note) {
	return 440 * Math.pow(2, (note - 69) / 12);
}
function dbToPower(value) {
	return Math.pow(2, parseFloat(value) / 3);
}

// Same JS-expression support as Mapper.convert's eval() fallback, but via
// `new Function` instead of raw `eval` — no access to the enclosing scope,
// same result for the simple arithmetic-on-`x` expressions this is for.
function evalConvertExpression(expr, x) {
	// eslint-disable-next-line no-new-func
	const fn = new Function("x", `"use strict"; return (${expr});`);
	return fn(x);
}

// Throws on an invalid expression — used by wa-var-view.js to validate a
// custom convert expression before writing it, rather than discovering the
// problem only once the curve tries to render.
export function validateConvertExpression(expr) {
	evalConvertExpression(expr, 0);
}

// Same three cases as Mapper.convert (waxml.js) — a built-in preset, a
// custom "x"-based JS expression, or (absent/invalid) passthrough.
export function applyConvertFn(convertValue, x) {
	if (!convertValue) return x;
	switch (convertValue) {
		case "MIDI->frequency":
			return midiNoteToFrequency(x);
		case "db->power":
		case "dB->power":
			return dbToPower(x);
		default:
			try {
				return evalConvertExpression(convertValue, x);
			} catch {
				return x;
			}
	}
}

function clampToRange(x, min, max) {
	return Math.max(min, Math.min(max, x));
}

// Same as Mapper.inToMapInIndex: the index of the last mapin entry <= x.
// Assumes mapin sorted ascending and x already clamped into its range.
function inToMapInIndex(x, mapin) {
	let idx = 0;
	for (let i = 0; i < mapin.length; i++) {
		if (mapin[i] <= x) idx = i;
	}
	return idx;
}

// Same as Mapper.in2Rel.
function in2Rel(x, i, mapin) {
	const in1 = mapin[i % mapin.length];
	const in2 = mapin[(i + 1) % mapin.length];
	if (in2 === in1) return 0;
	return (x - in1) / (in2 - in1);
}

// Same as Mapper.inToMapOutIndex — handles the "more mapout values than
// mapin values" distribution (only reachable by hand-editing the XML; see
// wa-var-view.js's Map node docs, Hans's point 1.10).
function inToMapOutIndex(x, i, mapin, mapout) {
	if (mapout.length > mapin.length && i + 2 === mapin.length) {
		const outValues = mapout.filter((_, index) => index >= i);
		const len = outValues.length;
		const x2 = x === 1 ? len - 1 : x * len;
		return { i: i + Math.floor(x2), x: x === 1 ? x : x2 % 1 };
	}
	if (mapout.length >= mapin.length && i + 1 === mapin.length) {
		return { i: mapout.length - 1, x: 0 };
	}
	return { i: i % mapout.length, x };
}

// Same as Mapper.applySteps' internal pattern-fill loop (its "steps" param,
// same concept Hans is renaming to "pattern" — see the top-of-file note). A
// safety valve (beyond what waxml.js itself has) guards against a
// pathological pattern (e.g. a zero patternWidth) spinning forever —
// reachable here via free-text input in a way it normally isn't in
// hand-authored XML.
function computePatternValues(pattern, out1, out2) {
	const range = Math.abs(out2 - out1);
	const patternCnt = pattern.length - 1;
	const patternWidth = Number(pattern[patternCnt]);
	if (patternCnt <= 0 || !Number.isFinite(patternWidth) || patternWidth <= 0) return [0];
	const values = [];
	let n = 0,
		v = 0;
	while (v < range && n <= 10000) {
		const c = Math.floor(n / patternCnt);
		v = c * patternWidth + Number(pattern[n % patternCnt]);
		values.push(v);
		n++;
	}
	return values.length ? values : [0];
}

// Same as Mapper.applySteps.
function applyPattern(x, i, pattern, mapout) {
	const out1 = mapout[i % mapout.length];
	const out2 = mapout[(i + 1) % mapout.length];
	const range = Math.abs(out2 - out1);
	const values = computePatternValues(pattern, out1, out2);
	const idx = Math.min(values.length - 1, Math.floor(x * values.length));
	if (out2 >= out1) return values[idx];
	return [...values].reverse()[idx] - range;
}

// Same as Mapper.rel2Out.
function rel2Out(x, i, mapout, pattern) {
	if (pattern && pattern.length) return applyPattern(x, i, pattern, mapout);
	const out1 = mapout[i % mapout.length];
	const out2 = mapout[(i + 1) % mapout.length];
	return x * (out2 - out1);
}

// Same as Mapper.offset.
function offset(x, i, mapout) {
	return x + mapout[i % mapout.length];
}

// Same pipeline as Mapper.mapValue, minus the final convert() step (kept
// separate — see applyConvertFn — so the Convert node's own graph can apply
// it to a value already in the mapout domain, per Hans's point 4).
export function mapStage1(x, { mapin, mapout, curve, pattern }) {
	if (!mapin || mapin.length < 2 || !mapout || mapout.length < 2) return x;
	const clamped = clampToRange(x, mapin[0], mapin[mapin.length - 1]);
	const i1 = inToMapInIndex(clamped, mapin);
	const rel = in2Rel(clamped, i1, mapin);
	const { i, x: relOut } = inToMapOutIndex(rel, i1, mapin, mapout);
	// `curve` may be a single value or a comma-separated one-per-segment
	// list (wa-var-view.js's "Per point" mode) — same `arr[i % arr.length]`
	// indexing waxml.js's own Mapper uses, so a plain single value (no
	// comma) still always resolves to itself regardless of segment `i`.
	const curveArr = typeof curve === "string" ? curve.split(",").map((s) => s.trim()).filter(Boolean) : null;
	const curveForSegment = curveArr && curveArr.length ? curveArr[i % curveArr.length] : curve;
	const curved = applyCurveFn(curveForSegment, relOut);
	const out = rel2Out(curved, i, mapout, pattern);
	return offset(out, i, mapout);
}

// Dense sample of the Map node's curve for drawing — mapin domain, `curve`-
// interpolated, and `pattern`-quantized if present (rel2Out's own pattern
// branch, via mapStage1 — the same pipeline order waxml.js's Mapper.mapValue
// uses: curve first, then pattern). Per Hans (2026-09-24, correcting his
// own earlier point 2.4): Pattern does NOT force curve="step" — that curve
// value is a *different*, unrelated technique (hand-typing many discrete
// mapout values with curve="step" so each holds flat) that happens to also
// produce a staircase, which is what caused the original confusion. With
// Pattern active, the Map node still renders through this same function —
// a single connected line (verified: with the default curve left
// unset/linear, sampling this densely across mapin=[0,1] mapout=[60,84]
// pattern=[0,2,4,5,7,9,11,12] reproduces Hans's own worked example
// 60,62,64,...,84 as a proper staircase, since rel2Out's own
// Math.floor(x*values.length) quantization already produces discrete jumps
// on its own, with no help from curve="step") — Hans's own instruction:
// while Pattern is active this graph becomes read-only (see wa-var-view.js)
// except for its axis min/max, but it's still drawn as one continuous line,
// not separate dots.
export function computeMapPoints({ mapin, mapout, curve, pattern }, sampleCount = 200) {
	if (!mapin || mapin.length < 2 || !mapout || mapout.length < 2) return [];
	const minIn = mapin[0];
	const maxIn = mapin[mapin.length - 1];
	const points = [];
	for (let i = 0; i <= sampleCount; i++) {
		const x = minIn + (i / sampleCount) * (maxIn - minIn);
		points.push({ x, y: mapStage1(x, { mapin, mapout, curve, pattern }) });
	}
	return points;
}

// x-position for each mapout[k] value, for drawing a dot at the right place
// on the Map node's graph — 1:1 against mapin for a normal (mapout.length
// <= mapin.length) mapping, or distributed across the LAST mapin segment
// per inToMapOutIndex's own rule when there are more mapout values than
// mapin values (Hans's point 1.10 — only reachable by hand-editing the XML
// this way, since neither this UI nor Pattern produce that shape). Used by
// wa-var-view.js for the Map node's normal draggable points.
export function mapoutPointPositions(mapin, mapout) {
	if (!mapin || mapin.length < 2 || !mapout || !mapout.length) return [];
	if (mapout.length <= mapin.length) {
		return mapout.map((y, k) => ({ x: mapin[Math.min(k, mapin.length - 1)], y }));
	}
	const segStart = mapin[mapin.length - 2];
	const segEnd = mapin[mapin.length - 1];
	return mapout.map((y, k) => ({ x: segStart + (k / mapout.length) * (segEnd - segStart), y }));
}

// Samples the Convert node's own curve — X is mapout's own domain (the
// value entering convert), Y = applyConvertFn(x), per Hans's point 4.2/4.3.
export function computeConvertPoints(convertValue, minX, maxX, sampleCount = 200) {
	const points = [];
	for (let i = 0; i <= sampleCount; i++) {
		const x = minX + (i / sampleCount) * (maxX - minX);
		points.push({ x, y: applyConvertFn(convertValue, x) });
	}
	return points;
}
