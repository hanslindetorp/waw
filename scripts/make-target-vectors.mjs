// Writes lti/tests/target-vectors.json: seeds and targets with the values the
// JavaScript draw (js/assessment/targets.js) gives, for the PHP port
// (lti/lib/Targets.php) to reproduce exactly. Run after any change to that file:
//   node scripts/make-target-vectors.mjs
import { writeFileSync } from "node:fs";
import { drawTargets } from "../js/assessment/targets.js";

const targets = [
	{ key: "ab1-a-pk.frequency.number", ref: "ab1-a-pk", attr: "frequency", write: "number", min: 200, max: 4000, scale: "log2", decimals: 0 },
	{ key: "ab1-a-pk.gain.number", ref: "ab1-a-pk", attr: "gain", write: "number", min: -12, max: 12, scale: "linear", decimals: 1 },
	{ key: "ab1-a-pk.Q.number", ref: "ab1-a-pk", attr: "Q", write: "number", min: 0.5, max: 8, scale: "log2", decimals: 1 },
	{ key: "ab1-a-pan.pan.number", ref: "ab1-a-pan", attr: "pan", write: "number", min: -1, max: 1, scale: "linear", decimals: 2 },
	{ key: "ab1-a-vol.gain.db", ref: "ab1-a-vol", attr: "gain", write: "dB", min: -40, max: -3, scale: "linear", decimals: 1 },
	// kept away from where the student's own value starts
	{ key: "ab2-a-pk.frequency.number", ref: "ab2-a-pk", attr: "frequency", write: "number", min: 300, max: 900, scale: "log2", decimals: 0, start: 400, separation: 0.5 },
	{ key: "ab2-a-pk.gain.number", ref: "ab2-a-pk", attr: "gain", write: "number", min: -3, max: 3, scale: "linear", decimals: 1, start: 0, separation: 2 },
	// a range the separation can't be met in: the farthest of the tries is used
	{ key: "ab3-a-pan.pan.number", ref: "ab3-a-pan", attr: "pan", write: "number", min: -0.2, max: 0.2, scale: "linear", decimals: 1, start: 0, separation: 0.9 }
];
const seeds = ["a", "student-1", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "ab1|x|y", "kmh.instructure.com|user-42|rl-7|project|vfilter0001", "zzzz", "7", "A long seed with spaces, digits 12345 and punctuation!?"];
const vectors = seeds.map((seed) => ({ seed, targets, expected: drawTargets(targets, seed).map((t) => ({ key: t.key, value: t.value })) }));
writeFileSync(new URL("../lti/tests/target-vectors.json", import.meta.url), JSON.stringify({ vectors }, null, 2));
console.log(`Wrote ${vectors.length} vectors`);
