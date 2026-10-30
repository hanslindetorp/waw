// Random targets: values of a task that are drawn per student instead of being
// the same for everyone (the frequency A is set to, say, between 300 and 3000
// Hz). A pure module with no DOM and no app imports — the same draw runs in the
// browser (practice pages, the author's try-out) and on the grading server
// (lti/lib/Targets.php is a port, kept in step with this file by
// lti/tests/target-vectors.json, made by scripts/make-target-vectors.mjs), which
// is the one that counts when grades do: the server draws a student's targets
// itself, so a page can't pick an easy one.
//
// A task's assessment lists its targets (see tasks/ab-task.js):
//   { key, ref, attr, write, min, max, scale, decimals }
//   key       the read the value stands for, as evaluate.js's readKey() names it
//   ref, attr the document value it is (the attribute of the element with that XML id)
//   write     how it is written: "number" (as it is) or "dB" (a "-6.5dB" string)
//   min, max  the range, in the attribute's own unit
//   scale     "linear", or "log2" (equal chances per octave: the right way to
//             draw a frequency or a Q)
//   decimals  how many decimals the value is rounded to
//   start, separation  (optional) where the student's own value starts and how far
//             from it a target has to be, in the units of `scale` (octaves for
//             "log2"): a target too close to the start is drawn again (up to
//             MAX_TRIES times, then the farthest one is used), so the task is never
//             solved by leaving things as they are
//
// The same seed (a string) always gives the same values: a student gets the same
// target every time they open the task. The seed has to be plain ASCII (the server
// builds it from a hash), so that both languages read the same characters.

// 32-bit string hash (xmur3) and PRNG (mulberry32): both are exact integer
// arithmetic, which is what makes a port to another language give the same numbers.
function hash(str) {
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	h = Math.imul(h ^ (h >>> 16), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed) {
	let a = seed | 0;
	return function () {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Rounds half up in both languages (Math.round and PHP's round() differ on negative halves).
function roundTo(value, decimals) {
	const f = Math.pow(10, decimals);
	return Math.floor(value * f + 0.5) / f;
}

const MAX_TRIES = 20;

// -> the targets, each with its drawn `value`, in the order given. Every target
// takes its draws in turn, so the values stay the same as long as the list does.
export function drawTargets(targets, seed) {
	const random = mulberry32(hash(String(seed)));
	return (targets || []).map((t) => {
		const lo = Math.min(t.min, t.max);
		const hi = Math.max(t.min, t.max);
		const log = t.scale === "log2" && lo > 0;
		const valueAt = (u) => (log ? lo * Math.pow(hi / lo, u) : lo + u * (hi - lo));
		const hasStart = Number.isFinite(t.start);
		const distance = (v) => (!hasStart ? Infinity : log && t.start > 0 ? Math.abs(Math.log(v / t.start) / Math.LN2) : Math.abs(v - t.start));
		const separation = Number.isFinite(t.separation) ? t.separation : 0;
		let best = 0;
		let bestDistance = -1;
		for (let i = 0; i < MAX_TRIES; i++) {
			const v = valueAt(random());
			const d = distance(v);
			if (d > bestDistance) {
				best = v;
				bestDistance = d;
			}
			if (d >= separation) break;
		}
		return { ...t, value: roundTo(best, Number.isInteger(t.decimals) ? t.decimals : 2) };
	});
}

// The attribute text a drawn value is written as.
export function targetText(write, value) {
	return write === "dB" ? `${value}dB` : String(value);
}
