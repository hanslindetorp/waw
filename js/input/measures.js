// What an INPUT row measures from the tracked points of one picture, and how a
// calibrated range turns that into 0–1. Pure functions, no DOM: the live camera
// (wa-webcam-input.js) and an analysed video (wa-video-input.js) read points the
// same way, so a row means the same thing in both.
//
// Points are { x, y } in 0–1 as MediaPipe reports them (y downwards). A point is
// read as the viewer sees it: with up as more, and — for the live camera, whose
// preview is mirrored — mirrored (`mirror`); a video file is shown as it is.

export const dist2d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export function area2d(pts) {
	let s = 0;
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
	}
	return Math.abs(s) / 2;
}

export function kindForCount(n) {
	return n === 1 ? "point" : n === 2 ? "dist" : "area";
}

// What a calibration holds. A point: the range it covered on each axis and —
// for "both axes" — the two ends (a and b) of the line it moved along (see
// finalizeCalib); the others: the smallest and largest value.
export function emptyCalib(kind) {
	return kind === "point"
		? { xMin: null, xMax: null, yMin: null, yMax: null, ax: null, ay: null, bx: null, by: null, n: 0, xSum: 0, ySum: 0 }
		: { min: null, max: null };
}

// Samples kept while calibrating a point on both axes (see finalizeCalib):
// near-repeats are skipped and the list is thinned if it grows long.
export function pushSample(samples, sample) {
	const last = samples[samples.length - 1];
	if (last && Math.hypot(sample.sx - last.sx, sample.sy - last.sy) < 0.002) return;
	samples.push(sample);
	if (samples.length > 3000) samples.splice(0, samples.length, ...samples.filter((_, i) => i % 2 === 0));
}

// "Both axes" follows a line. After a calibration the line goes between the
// two of its points that lay furthest apart (the longest of all the lines one
// can draw between them); the end that is nearer the bottom-left of the
// picture is 0, the other 1. Positions are those of the picture as shown —
// x to the right (mirrored, as the preview is), y upwards, the same way
// Horizontal and Vertical count — in the picture's shape on screen (x scaled
// by `aspect`).
export function finalizeCalib(calib, samples, aspect) {
	if (!("ax" in calib)) return;
	calib.ax = calib.ay = calib.bx = calib.by = null;
	const pts = samples.map((p) => ({ x: p.sx, y: p.sy }));
	let best = 0;
	let a = null;
	let b = null;
	for (let i = 0; i < pts.length; i++) {
		for (let j = i + 1; j < pts.length; j++) {
			const d = Math.hypot((pts[i].x - pts[j].x) * aspect, pts[i].y - pts[j].y);
			if (d > best) {
				best = d;
				a = pts[i];
				b = pts[j];
			}
		}
	}
	if (!a) return;
	const nearer = (p) => p.x * aspect + p.y;
	if (nearer(a) > nearer(b) || (nearer(a) === nearer(b) && a.x > b.x)) [a, b] = [b, a];
	[calib.ax, calib.ay, calib.bx, calib.by] = [a.x, a.y, b.x, b.y];
}

export const widen = (lo, hi, v) => [lo === null ? v : Math.min(lo, v), hi === null ? v : Math.max(hi, v)];

// The points of an area in the order they go round it, whatever order they
// were picked in — by angle around their centre, in the shape the picture
// has on screen (x scaled by `aspect`). Clicked as an X, four corners still
// make a square.
export function angularOrder(pts, aspect = 1) {
	const cx = pts.reduce((s, p) => s + p.x * aspect, 0) / pts.length;
	const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
	return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x * aspect - cx) - Math.atan2(b.y - cy, b.x * aspect - cx));
}

// What is measured from the points at this moment. A point is read as the
// viewer sees it: mirrored (the preview is), and with up as more. Distances
// are those of the picture on screen — x is scaled by `aspect` (width /
// height), so the same gap reads the same whichever way it points; an area is
// the same up to a constant that calibration removes.
export function sampleFor(kind, pts, aspect = 1, mirror = true) {
	if (kind === "point") return { sx: mirror ? 1 - pts[0].x : pts[0].x, sy: 1 - pts[0].y };
	if (kind === "dist") return Math.hypot((pts[1].x - pts[0].x) * aspect, pts[1].y - pts[0].y);
	return area2d(angularOrder(pts, aspect));
}

export function expandCalib(calib, kind, sample) {
	if (kind === "point") {
		[calib.xMin, calib.xMax] = widen(calib.xMin, calib.xMax, sample.sx);
		[calib.yMin, calib.yMax] = widen(calib.yMin, calib.yMax, sample.sy);
		calib.n = (calib.n || 0) + 1;
		calib.xSum = (calib.xSum || 0) + sample.sx;
		calib.ySum = (calib.ySum || 0) + sample.sy;
	} else {
		[calib.min, calib.max] = widen(calib.min, calib.max, sample);
	}
}

export const unit = (v, lo, hi) => (lo === null || hi === null || !(hi > lo) ? undefined : Math.max(0, Math.min(1, (v - lo) / (hi - lo))));

// 0–1, or undefined while the range hasn't been covered yet.
//
// One point on both axes is read along a line: its right-angled projection
// onto the line a (0) to b (1) — the near leg of the right triangle whose
// hypotenuse is a–P — so a point beside the line reads as the point of the
// line straight "beside" it. Beyond a or b it is 0 or 1. The line is the one
// finalizeCalib found; a row saved before that has the diagonal of its range
// instead, from its bottom-left to its top-right corner. The geometry is that
// of the picture on screen (x scaled by `aspect`, width / height), so the
// right angle is a right angle as seen.
export function normalizeSample(kind, mode, calib, sample, aspect = 1) {
	if (kind !== "point") return unit(sample, calib.min, calib.max);
	if (mode === "horizontal") return unit(sample.sx, calib.xMin, calib.xMax);
	if (mode === "vertical") return unit(sample.sy, calib.yMin, calib.yMax);
	return linePosition(calib, sample, aspect)?.t;
}

// Where a point falls on the line "both axes" follows: `t` is 0 at a and 1 at
// b (clamped beyond them), a and b the line's ends. null while there is no
// line yet.
export function linePosition(calib, sample, aspect = 1) {
	let { ax, ay, bx, by } = calib;
	if (ax === null || ax === undefined) {
		if (calib.xMin === null || calib.xMin === undefined) return null;
		[ax, ay, bx, by] = [calib.xMin, calib.yMin, calib.xMax, calib.yMax];
	}
	const abx = (bx - ax) * aspect;
	const aby = by - ay;
	const lengthSquared = abx * abx + aby * aby;
	if (!(lengthSquared > 0)) return null;
	const apx = (sample.sx - ax) * aspect;
	const apy = sample.sy - ay;
	return { t: Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSquared)), a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

// The mean of a calibrated axis (what the calibration saw on average), or the
// middle of its range for a row saved without one.
export function axisMean(calib, axis) {
	if (calib.n > 0) return (axis === "x" ? calib.xSum : calib.ySum) / calib.n;
	const lo = axis === "x" ? calib.xMin : calib.yMin;
	const hi = axis === "x" ? calib.xMax : calib.yMax;
	return lo === null || lo === undefined ? null : (lo + hi) / 2;
}
