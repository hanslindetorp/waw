// Assessment of a Stage view: how well did the user do the task? A pure,
// declarative function with no DOM and no app imports, so the same file runs
// in the browser (the viewer's Done button, the author's test run) and — when
// grades start to count — on a server, which must not take the browser's word
// for a score. Per Hans (2026-10-15): the model differs from task to task
// (match a filter, set a balance, a reverb amount, a delay time, a compressor
// ...), so an assessment is a list of weighted CRITERIA, each measuring
// something and saying how far off is how bad, combined into one score.
//
// An assessment (one per view, see project/assessment-store.js):
//   { max: 10,                    points the whole thing is worth (default 10)
//     pass: 0.6,                  share of max that counts as passed (optional; without it Done is enough)
//     reveal: "distance",         what the comments give away: "score" | "distance" | "direction"
//     criteria: [ criterion, ... ],
//     bands: [ { min: 0.9, text: "Excellent." }, ... ] }   overall comment by share of max
//
// A criterion: { id, label, weight (default 1), type, scale, full, zero, ... }
//   what it measures                       type
//   one value against a fixed target       "target"   a, target
//   one value against another value        "match"    a, b
//   one value inside a range               "range"    a, min, max
//   the difference of two values           "relation" a, b, target   (a − b, in `scale` units, vs target)
//   how far apart a group of values are    "spread"   of: [reads]
// A READ — { ref, attr, as } — names a value of the document: attribute
// `attr` of the element whose XML id is `ref`; `as: "db"` reads a gain in dB.
//
// How bad a miss is, in `scale` units (the values are converted first):
//   scale "linear" — as they are (dB, seconds, 0–1 amounts)
//   scale "log2"   — octaves: the right way to compare frequencies, times and
//                    ratios such as Q, where doubling matters, not adding
//   deviation <= `full`  → the criterion's score is 1
//   deviation >= `zero`  → 0, and linearly in between.
//
// The caller measures the values (see assessment/collect.js) and passes them as
// a plain object keyed by readKey(); evaluate() knows nothing else.

export const SCALES = ["linear", "log2"];
export const CRITERION_TYPES = ["match", "target", "range", "relation", "spread"];
export const REVEAL_MODES = ["score", "distance", "direction"];

export function readKey(read) {
	return `${read.ref}.${read.attr}.${read.as === "db" ? "db" : "number"}`;
}

function criterionReads(c) {
	switch (c.type) {
		case "target":
		case "range":
			return [c.a];
		case "match":
		case "relation":
			return [c.a, c.b];
		case "spread":
			return Array.isArray(c.of) ? c.of : [];
	}
	return [];
}

// Every distinct read the assessment needs, for the caller to measure.
export function requiredReads(assessment) {
	const seen = new Map();
	(assessment?.criteria || []).forEach((c) =>
		criterionReads(c).forEach((r) => {
			if (r && r.ref && r.attr) seen.set(readKey(r), { ref: r.ref, attr: r.attr, as: r.as === "db" ? "db" : "number" });
		})
	);
	return [...seen.values()];
}

function scaled(scale, x) {
	if (!Number.isFinite(x)) return NaN;
	if (scale === "log2") return x > 0 ? Math.log2(x) : NaN;
	return x;
}

function scoreFor(deviation, full, zero) {
	if (deviation <= full) return 1;
	if (zero <= full || deviation >= zero) return 0;
	return 1 - (deviation - full) / (zero - full);
}

// { deviation, signed } for one criterion, or null when a value is missing.
// `signed` is which way it missed (positive = too high / too far), where that
// means something.
function measure(c, values) {
	const get = (read) => (read && read.ref ? values[readKey(read)] : undefined);
	const s = (read) => scaled(c.scale, get(read));
	const num = (x) => (Number.isFinite(x) ? x : NaN);
	let signed = null;
	let deviation;
	switch (c.type) {
		case "target":
			signed = s(c.a) - scaled(c.scale, num(c.target));
			deviation = Math.abs(signed);
			break;
		case "match":
			signed = s(c.a) - s(c.b);
			deviation = Math.abs(signed);
			break;
		case "relation":
			signed = s(c.a) - s(c.b) - num(c.target);
			deviation = Math.abs(signed);
			break;
		case "range": {
			const v = s(c.a);
			const lo = scaled(c.scale, num(c.min));
			const hi = scaled(c.scale, num(c.max));
			signed = v < lo ? v - lo : v > hi ? v - hi : 0;
			deviation = Math.abs(signed);
			break;
		}
		case "spread": {
			const list = (c.of || []).map(s);
			if (list.length < 2) return null;
			deviation = Math.max(...list) - Math.min(...list);
			break;
		}
		default:
			return null;
	}
	return Number.isFinite(deviation) ? { deviation, signed: Number.isFinite(signed) ? signed : null } : null;
}

const SCALE_UNIT = { linear: "", log2: " octaves" };

function describe(c, m, score, reveal) {
	const name = c.label || c.id || c.type;
	if (reveal === "score") return null;
	const quality = score >= 0.9 ? "spot on" : score >= 0.5 ? "close" : "far off";
	let text = `${name}: ${quality}`;
	if (reveal === "direction" && m && m.signed !== null && m.signed !== 0 && score < 0.9) {
		text += c.type === "range" || c.type === "target" || c.type === "match" || c.type === "relation" ? (m.signed > 0 ? " — too high" : " — too low") : "";
	}
	return text + ".";
}

function bandText(bands, share) {
	const sorted = (Array.isArray(bands) ? bands : []).filter((b) => b && Number.isFinite(b.min) && b.text).sort((a, b) => b.min - a.min);
	const hit = sorted.find((b) => share >= b.min);
	return hit ? hit.text : "";
}

// -> { total (0..1), score, max, passed, comment, feedback, criteria: [{ id, label, weight, score, missing, text }] }
export function evaluate(assessment, values) {
	const a = assessment || {};
	const max = Number.isFinite(a.max) && a.max > 0 ? a.max : 10;
	const reveal = REVEAL_MODES.includes(a.reveal) ? a.reveal : "distance";
	const criteria = (a.criteria || []).map((c, i) => {
		const weight = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 1;
		const m = measure(c, values || {});
		const score = m ? scoreFor(m.deviation, Number.isFinite(c.full) ? c.full : 0, Number.isFinite(c.zero) ? c.zero : Infinity) : 0;
		return {
			id: c.id || `c${i + 1}`,
			label: c.label || c.id || `Criterion ${i + 1}`,
			weight,
			score,
			missing: !m,
			text: m ? describe(c, m, score, reveal) : `${c.label || c.id || "A value"} could not be measured.`
		};
	});
	const weightSum = criteria.reduce((n, c) => n + c.weight, 0);
	const total = criteria.length && weightSum > 0 ? criteria.reduce((n, c) => n + c.score * c.weight, 0) / weightSum : 1;
	const passed = Number.isFinite(a.pass) ? total >= a.pass : true;
	const comment = bandText(a.bands, total);
	return {
		total,
		score: Math.round(total * max * 10) / 10,
		max,
		passed,
		comment, // the overall one, by result
		feedback: [comment, ...criteria.map((c) => c.text)].filter(Boolean).join(" "), // everything in one text — what a gradebook comment gets
		criteria
	};
}

// What is wrong with an assessment as written — for the editor to point out.
export function problemsWith(assessment) {
	const problems = [];
	(assessment?.criteria || []).forEach((c, i) => {
		const name = c.label || c.id || `Criterion ${i + 1}`;
		if (!CRITERION_TYPES.includes(c.type)) problems.push(`${name}: unknown type`);
		criterionReads(c).forEach((r) => {
			if (!r || !r.ref || !r.attr) problems.push(`${name}: a value is not chosen`);
		});
		if (c.type === "target" && !Number.isFinite(c.target)) problems.push(`${name}: no target`);
		if (c.type === "range" && !(Number.isFinite(c.min) && Number.isFinite(c.max))) problems.push(`${name}: no range`);
		if (!(Number.isFinite(c.zero) && c.zero > (Number.isFinite(c.full) ? c.full : 0))) problems.push(`${name}: "zero" must be larger than "full"`);
	});
	return problems;
}
