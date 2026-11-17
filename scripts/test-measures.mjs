// Tests of the measures an INPUT row takes from tracked points (js/input/measures.js).
//   node scripts/test-measures.mjs
import assert from "node:assert/strict";
import { area2d, emptyCalib, expandCalib, finalizeCalib, kindForCount, normalizeSample, sampleFor } from "../js/input/measures.js";

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}

test("kinds by number of points", () => {
	assert.equal(kindForCount(1), "point");
	assert.equal(kindForCount(2), "dist");
	assert.equal(kindForCount(5), "area");
});

test("a point is read mirrored for the camera, as it is for a video", () => {
	assert.deepEqual(sampleFor("point", [{ x: 0.25, y: 0.25 }]), { sx: 0.75, sy: 0.75 });
	assert.deepEqual(sampleFor("point", [{ x: 0.25, y: 0.25 }], 1, false), { sx: 0.25, sy: 0.75 });
});

test("distance and area", () => {
	assert.equal(sampleFor("dist", [{ x: 0, y: 0 }, { x: 0.3, y: 0.4 }]), 0.5);
	assert.ok(Math.abs(area2d([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) - 1) < 1e-9);
});

test("a calibrated horizontal range gives 0–1 and clamps", () => {
	const calib = emptyCalib("point");
	[0.2, 0.6, 1].forEach((x) => expandCalib(calib, "point", { sx: x, sy: 0.5 }));
	assert.ok(Math.abs(normalizeSample("point", "horizontal", calib, { sx: 0.6, sy: 0.5 }) - 0.5) < 1e-9);
	assert.equal(normalizeSample("point", "horizontal", calib, { sx: 2, sy: 0.5 }), 1);
	assert.equal(normalizeSample("point", "horizontal", emptyCalib("point"), { sx: 0.5, sy: 0.5 }), undefined);
});

test("both axes follow the longest line between the samples", () => {
	const calib = emptyCalib("point");
	const samples = [
		{ sx: 0, sy: 0 },
		{ sx: 1, sy: 1 },
		{ sx: 0.5, sy: 0.5 }
	];
	samples.forEach((p) => expandCalib(calib, "point", p));
	finalizeCalib(calib, samples, 1);
	assert.equal(normalizeSample("point", "both", calib, { sx: 0.5, sy: 0.5 }, 1), 0.5);
	assert.equal(normalizeSample("point", "both", calib, { sx: 0, sy: 0 }, 1), 0);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
