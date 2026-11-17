// Tests of the tracked-point tables of a video (js/input/landmark-table.js, video-series.js,
// the gap filling in data-series.js).
//   node scripts/test-landmarks.mjs
import assert from "node:assert/strict";
import { createTable, frameAt, landmarksToCsv, parseLandmarkCsv, pointAt, setFrame } from "../js/input/landmark-table.js";
import { measureSeries } from "../js/input/video-series.js";
import { fillGaps } from "../js/input/data-series.js";
import { buildDataset, guessLayout } from "../js/input/data-series.js";
import { parseCsv, sniffCsv } from "../js/input/csv-parse.js";

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

// A pose that moves a hand-like point 0.2 → 0.8 across the picture, then vanishes for a while.
function sample() {
	const times = [0, 0.1, 0.2, 0.3, 0.4, 1.5, 1.6];
	const t = createTable("pose", times);
	const xs = [0.2, 0.35, 0.5, 0.65, 0.8, null, 0.8];
	xs.forEach((x, f) => {
		if (x === null) return;
		setFrame(t, f, { pose0: { x, y: 0.5, z: 0.1 }, pose1: { x: 0.5, y: 0.2 + f * 0.1, z: 0 } });
	});
	return t;
}

test("a table keeps points, NaN where nothing was found", () => {
	const t = sample();
	assert.deepEqual(pointAt(t, "pose0", 2), { x: 0.5, y: 0.5, z: t.values[(2 * 33 + 0) * 3 + 2] });
	assert.equal(pointAt(t, "pose0", 5), null);
	assert.equal(pointAt(t, "pose9", 2), null);
	assert.equal(pointAt(t, "nope", 2), null);
});

test("frameAt finds the nearest frame", () => {
	const t = sample();
	assert.equal(frameAt(t, 0), 0);
	assert.equal(frameAt(t, 0.26), 3);
	assert.equal(frameAt(t, 99), 6);
});

test("CSV round trip keeps the values to the decimals written", () => {
	const t = sample();
	const back = parseLandmarkCsv(landmarksToCsv(t));
	assert.equal(back.model, "pose");
	assert.deepEqual(back.axes, ["x", "y", "z"]);
	assert.equal(back.times.length, 7);
	assert.ok(Math.abs(pointAt(back, "pose0", 3).x - 0.65) < 1e-4);
	assert.equal(pointAt(back, "pose0", 5), null);
});

test("the face keeps x and y only", () => {
	const t = createTable("face", [0, 0.1]);
	setFrame(t, 0, { face5: { x: 0.123456, y: 0.5, z: 0.9 } });
	const csv = landmarksToCsv(t);
	assert.ok(csv.split("\n")[0].includes("face5x,face5y,face6x"));
	assert.ok(!csv.includes("face5z"));
	assert.ok(Math.abs(pointAt(parseLandmarkCsv(csv), "face5", 0).x - 0.123) < 1e-6);
});

test("the CSV of a table also reads in the CSV input, placed by its time axis", () => {
	const text = landmarksToCsv(sample());
	const opts = sniffCsv(text);
	const layout = guessLayout(parseCsv(text, opts), opts.decimal);
	assert.deepEqual(layout, { orientation: "columns", header: true, timeColumn: true });
	const ds = buildDataset(parseCsv(text, opts), layout, opts.decimal);
	assert.ok(ds.xs && ds.series.length >= 1);
});

test("a bad file is refused with a reason", () => {
	assert.throws(() => parseLandmarkCsv("a,b\n1,2"), /time/);
	assert.throws(() => parseLandmarkCsv("time,foo\n0,1"), /Unexpected column|tracked points/);
	assert.throws(() => parseLandmarkCsv("time"), /no frames/);
});

test("gaps: short ones are bridged, long ones hold the last value", () => {
	const v = [1, NaN, 3, NaN, NaN, NaN, 9];
	const times = [0, 0.1, 0.2, 0.3, 1.0, 1.9, 2.0];
	assert.deepEqual([...fillGaps(v)], [1, 2, 3, 4.5, 6, 7.5, 9]);
	const bridged = fillGaps(v, { times, maxGap: 0.5 });
	assert.equal(bridged[1], 2); // 0.2 s gap: a line
	assert.deepEqual([...bridged].slice(3, 6), [3, 3, 3]); // 1.8 s gap: held
	assert.equal(bridged[6], 9);
});

test("a point moving along a line reads 0 → 1 over the video, and the gap holds", () => {
	const t = sample();
	const { values, found } = measureSeries(t, ["pose0"], "horizontal", 16 / 9, 0.5);
	assert.equal(found, 6);
	assert.ok(Math.abs(values[0] - 0) < 1e-9 && Math.abs(values[4] - 1) < 1e-9);
	assert.ok(Math.abs(values[2] - 0.5) < 1e-6);
	assert.equal(values[5], 1); // inside the 1.1 s gap: held at the last value
});

test("a distance between two points is calibrated by the video itself", () => {
	const t = createTable("pose", [0, 1, 2]);
	[0.1, 0.3, 0.5].forEach((x, f) => setFrame(t, f, { pose0: { x: 0, y: 0, z: 0 }, pose1: { x, y: 0, z: 0 } }));
	const { values } = measureSeries(t, ["pose0", "pose1"], "both", 1);
	assert.ok(Math.abs(values[0]) < 1e-9 && Math.abs(values[1] - 0.5) < 1e-6 && Math.abs(values[2] - 1) < 1e-9);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
