#!/usr/bin/env node
// Writes lti/tests/assessment-vectors.json: a set of assessments and measured
// values together with what js/assessment/evaluate.js makes of them. The PHP
// copy of the evaluator (lti/lib/Evaluate.php) is tested against this file
// (php lti/tests/run.php), so the two can't drift apart unnoticed. Run it again
// whenever evaluate.js changes (node scripts/make-assessment-vectors.mjs).

import { evaluate, readKey } from "../js/assessment/evaluate.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const A = (attr, as) => ({ ref: "A", attr, ...(as ? { as } : {}) });
const B = (attr, as) => ({ ref: "B", attr, ...(as ? { as } : {}) });
const k = (read) => readKey(read);

const filterTask = (reveal) => ({
	max: 10,
	pass: 0.6,
	reveal,
	bands: [
		{ min: 0.9, text: "Excellent." },
		{ min: 0.6, text: "Getting there." },
		{ min: 0, text: "Not yet — try again." }
	],
	criteria: [
		{ id: "freq", label: "Frequency", weight: 1, type: "match", a: B("frequency"), b: A("frequency"), scale: "log2", full: 0.1, zero: 1 },
		{ id: "gain", label: "Gain", weight: 1, type: "match", a: B("gain", "db"), b: A("gain", "db"), scale: "linear", full: 1, zero: 6 },
		{ id: "q", label: "Q", weight: 2, type: "match", a: B("Q"), b: A("Q"), scale: "log2", full: 0.2, zero: 1.5 }
	]
});
const filterValues = (bf, bg, bq) => ({ [k(A("frequency"))]: 400, [k(A("gain", "db"))]: -9, [k(A("Q"))]: 5, [k(B("frequency"))]: bf, [k(B("gain", "db"))]: bg, [k(B("Q"))]: bq });

const cases = [];
const add = (name, assessment, values) => cases.push({ name, assessment, values, expected: evaluate(assessment, values) });

for (const reveal of ["score", "distance", "direction", undefined]) {
	add(`filter exact, reveal ${reveal}`, filterTask(reveal), filterValues(400, -9, 5));
	add(`filter untouched, reveal ${reveal}`, filterTask(reveal), filterValues(350, 0, 1));
	add(`filter near, reveal ${reveal}`, filterTask(reveal), filterValues(430, -8, 4.5));
	add(`filter too high, reveal ${reveal}`, filterTask(reveal), filterValues(900, 4, 12));
}
add("filter with a missing value", filterTask("direction"), { ...filterValues(400, -9, 5), [k(B("Q"))]: null });
add("filter with a non-positive log value", filterTask("distance"), filterValues(0, -9, 5));
add("no criteria", { max: 5 }, {});
add("no criteria with pass level", { max: 5, pass: 0.5, criteria: [] }, {});
add("target", { max: 20, criteria: [{ type: "target", a: A("frequency"), target: 1000, scale: "log2", full: 0, zero: 2 }] }, { [k(A("frequency"))]: 1500 });
add("target linear low", { criteria: [{ id: "t", type: "target", a: A("gain", "db"), target: -6, scale: "linear", full: 1, zero: 4, label: "Level" }], reveal: "direction" }, { [k(A("gain", "db"))]: -12 });
add("range inside", { criteria: [{ type: "range", a: A("delayTime"), min: 0.2, max: 0.4, scale: "linear", full: 0, zero: 0.2 }] }, { [k(A("delayTime"))]: 0.3 });
add("range above", { reveal: "direction", criteria: [{ type: "range", a: A("delayTime"), min: 0.2, max: 0.4, scale: "linear", full: 0, zero: 0.2, label: "Delay" }] }, { [k(A("delayTime"))]: 0.5 });
add("range below log", { reveal: "direction", criteria: [{ type: "range", a: A("delayTime"), min: 0.2, max: 0.4, scale: "log2", full: 0, zero: 2 }] }, { [k(A("delayTime"))]: 0.1 });
add("relation (bass vs kick)", { max: 10, pass: 0.5, criteria: [{ id: "bal", label: "Balance", type: "relation", a: A("gain", "db"), b: B("gain", "db"), scale: "linear", target: 3, full: 0.5, zero: 4 }] }, { [k(A("gain", "db"))]: -3, [k(B("gain", "db"))]: -9 });
add("spread (strings)", { max: 8, reveal: "distance", criteria: [{ id: "bal", label: "Strings", type: "spread", of: [A("gain", "db"), B("gain", "db"), { ref: "C", attr: "gain", as: "db" }, { ref: "D", attr: "gain", as: "db" }], scale: "linear", full: 1, zero: 7 }] }, { [k(A("gain", "db"))]: -6, [k(B("gain", "db"))]: -8, "C.gain.db": -5, "D.gain.db": -12 });
add("spread with one value", { criteria: [{ type: "spread", of: [A("gain", "db")], scale: "linear", full: 0, zero: 1 }] }, { [k(A("gain", "db"))]: 0 });
add("zero not above full", { criteria: [{ type: "target", a: A("frequency"), target: 400, scale: "linear", full: 10, zero: 10 }] }, { [k(A("frequency"))]: 405 });
add("zero not above full, off", { criteria: [{ type: "target", a: A("frequency"), target: 400, scale: "linear", full: 10, zero: 10 }] }, { [k(A("frequency"))]: 450 });
add("unknown type", { criteria: [{ id: "x", type: "nonsense", a: A("frequency") }] }, { [k(A("frequency"))]: 1 });
add("weights and bands only", { max: 3, bands: [{ min: 0.5, text: "Half way." }, { min: 0, text: "Start." }, { min: "x", text: "ignored" }], criteria: [{ type: "target", a: A("pan"), target: 0, scale: "linear", full: 0.1, zero: 1, weight: 3 }, { type: "target", a: B("pan"), target: 0, scale: "linear", full: 0.1, zero: 1, weight: 1 }] }, { "A.pan.number": 0, "B.pan.number": 1 });
add("invalid max falls back to 10", { max: -3, criteria: [] }, {});

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "lti", "tests", "assessment-vectors.json");
writeFileSync(out, JSON.stringify(cases, null, "\t") + "\n");
console.log(`Wrote ${cases.length} cases to ${out}`);
