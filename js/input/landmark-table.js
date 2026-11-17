// The tracked points of a whole video, one value per point and axis for every
// picture — what the analysis of a video file (video-analysis.js) produces and
// what a row of the video input reads its numbers from. A table holds one model:
//   { model: "hands" | "pose" | "face", times: Float64Array (seconds, one per frame),
//     labels: ["pose0", …], axes: ["x","y","z"],
//     values: Float32Array (frame, label, axis — in that order; NaN where nothing was found) }
// Points are as MediaPipe reports them: x and y 0–1 across the picture (y downwards).
//
// The table is kept in the project as a CSV file (landmarksToCsv / parseLandmarkCsv)
// so it is a plain, universal file: the first column is `time` in seconds, then one
// column per point and axis (`pose0x`, `pose0y`, `pose0z`, …), an empty cell where a
// point was not found. Such a file reads in the CSV input too. Pure functions, no DOM.

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

export const MODEL_LABELS = {
	hands: [...range(21, (i) => `leftHand${i}`), ...range(21, (i) => `rightHand${i}`)],
	pose: range(33, (i) => `pose${i}`),
	face: range(478, (i) => `face${i}`)
};

// The axes a model's points are kept in: the face's depth is of little use and would
// add a third to the file.
export const MODEL_AXES = { hands: ["x", "y", "z"], pose: ["x", "y", "z"], face: ["x", "y"] };

// Decimals written per model (4 is a fifth of a pixel at 1920 wide; the face has so many
// points that 3 keeps its file in check).
export const MODEL_DECIMALS = { hands: 4, pose: 4, face: 3 };

export function modelOfLabel(label) {
	if (/^(leftHand|rightHand|hand)\d+$/.test(label)) return "hands";
	if (/^pose\d+$/.test(label)) return "pose";
	if (/^face\d+$/.test(label)) return "face";
	return "unknown";
}

export function createTable(model, times) {
	const labels = MODEL_LABELS[model];
	const axes = MODEL_AXES[model];
	return { model, times: Float64Array.from(times), labels: [...labels], axes: [...axes], values: new Float32Array(times.length * labels.length * axes.length).fill(NaN) };
}

// Writes one picture's points into the table. `points` maps a label to { x, y, z }.
export function setFrame(table, frame, points) {
	const { labels, axes } = table;
	const stride = labels.length * axes.length;
	for (let l = 0; l < labels.length; l++) {
		const p = points[labels[l]];
		if (!p) continue;
		for (let a = 0; a < axes.length; a++) table.values[frame * stride + l * axes.length + a] = p[axes[a]] ?? NaN;
	}
}

// { x, y, z? } of a point in a frame, or null when it was not found there.
export function pointAt(table, label, frame) {
	const l = table.labelIndex?.get(label) ?? table.labels.indexOf(label);
	if (l < 0 || frame < 0 || frame >= table.times.length) return null;
	const n = table.axes.length;
	const base = (frame * table.labels.length + l) * n;
	const x = table.values[base];
	const y = table.values[base + 1];
	if (Number.isNaN(x) || Number.isNaN(y)) return null;
	const p = { x, y };
	if (n > 2) p.z = table.values[base + 2];
	return p;
}

// The frame nearest to `t` seconds.
export function frameAt(table, t) {
	const times = table.times;
	const n = times.length;
	if (!n) return -1;
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= t) lo = mid;
		else hi = mid;
	}
	return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi;
}

// Whether any point was found in a frame.
export function frameHasData(table, frame) {
	const stride = table.labels.length * table.axes.length;
	for (let i = frame * stride; i < (frame + 1) * stride; i++) if (!Number.isNaN(table.values[i])) return true;
	return false;
}

export function landmarksToCsv(table, decimals = MODEL_DECIMALS[table.model] ?? 4) {
	const { labels, axes, times, values } = table;
	const header = ["time", ...labels.flatMap((l) => axes.map((a) => `${l}${a}`))];
	const lines = [header.join(",")];
	const stride = labels.length * axes.length;
	for (let f = 0; f < times.length; f++) {
		const cells = [times[f].toFixed(3)];
		for (let i = 0; i < stride; i++) {
			const v = values[f * stride + i];
			cells.push(Number.isNaN(v) ? "" : v.toFixed(decimals));
		}
		lines.push(cells.join(","));
	}
	return lines.join("\n") + "\n";
}

// Reads a file written by landmarksToCsv. Goes line by line, straight into the
// typed array: a face is well over a million cells.
export function parseLandmarkCsv(text) {
	const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
	if (lines.length < 2) throw new Error("The file has no frames");
	const header = lines[0].split(",").map((h) => h.trim());
	if (header[0] !== "time") throw new Error("The first column should be `time`");
	const labels = [];
	const axisSet = [];
	for (const h of header.slice(1)) {
		const axis = h.slice(-1);
		const label = h.slice(0, -1);
		if (!["x", "y", "z"].includes(axis) || !label) throw new Error(`Unexpected column "${h}"`);
		if (!labels.includes(label)) labels.push(label);
		if (!axisSet.includes(axis)) axisSet.push(axis);
	}
	const axes = ["x", "y", "z"].filter((a) => axisSet.includes(a));
	const model = modelOfLabel(labels[0]);
	if (model === "unknown") throw new Error("These do not look like tracked points");
	const frames = lines.length - 1;
	const stride = labels.length * axes.length;
	const times = new Float64Array(frames);
	const values = new Float32Array(frames * stride).fill(NaN);
	for (let f = 0; f < frames; f++) {
		const cells = lines[f + 1].split(",");
		times[f] = parseFloat(cells[0]);
		for (let i = 0; i < stride; i++) {
			const c = cells[i + 1];
			if (c !== undefined && c !== "") values[f * stride + i] = parseFloat(c);
		}
	}
	return { model, times, labels, axes, values };
}
