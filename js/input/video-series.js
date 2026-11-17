import { emptyCalib, expandCalib, finalizeCalib, kindForCount, normalizeSample, pushSample, sampleFor } from "./measures.js";
import { pointAt } from "./landmark-table.js";
import { fillGaps } from "./data-series.js";

// A row of the video input: what is measured from some of a video's tracked points
// (see measures.js — one point on an axis or both, the distance between two, the area
// of three or more) as a 0–1 value for every frame, from a landmark table. The range of
// the measure is the one the whole video covers, found here — so there is nothing to
// calibrate by moving. A video file is shown as it is, so a point is not mirrored.

// The longest stretch a missing point is bridged by a line between the values on either
// side; a longer absence keeps the last value until the point is back.
export const MAX_GAP_SECONDS = 0.5;

// { values: Float64Array (0–1 per frame, gaps filled), found: how many frames had every
//   point, calib }. `aspect` is the picture's width / height.
export function measureSeries(table, labels, mode, aspect, maxGap = MAX_GAP_SECONDS) {
	const kind = kindForCount(labels.length);
	const frames = table.times.length;
	const samples = [];
	const calib = emptyCalib(kind);
	const raw = new Array(frames);
	const kept = [];
	for (let f = 0; f < frames; f++) {
		const pts = labels.map((l) => pointAt(table, l, f));
		if (pts.some((p) => !p)) {
			raw[f] = null;
			continue;
		}
		const sample = sampleFor(kind, pts, aspect, false);
		raw[f] = sample;
		expandCalib(calib, kind, sample);
		if (kind === "point") pushSample(kept, sample);
	}
	if (kind === "point") finalizeCalib(calib, kept, aspect);
	const values = new Float64Array(frames);
	let found = 0;
	for (let f = 0; f < frames; f++) {
		const n = raw[f] === null ? undefined : normalizeSample(kind, mode, calib, raw[f], aspect);
		if (n === undefined) values[f] = NaN;
		else {
			values[f] = n;
			found++;
		}
	}
	return { values: fillGaps(values, { times: table.times, maxGap }), found, calib };
}
