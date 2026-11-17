import { parseNumber } from "./csv-parse.js";

// From a parsed CSV table to the series the INPUT panel plays: which way the
// series run in the file, where their names are, the time axis, and how a value
// at any point of the play-bar is read out (and normalized to 0–1). Pure, no
// DOM — see scripts/test-csv.mjs.
//
// A "layout" says how to read the table:
//   orientation  "rows"    — every line of the file is a series, running left to right
//                            (the name, if any, is the first cell of the line);
//                "columns" — every column is a series, running downwards
//                            (the name, if any, is the first line);
//   header       the first cell of every series is its name (the first column of a
//                "rows" file, the first line of a "columns" file);
//   timeColumn   the first series (the first column/line after the names) is the
//                time axis, not data — the values are placed by it, not evenly.
// Without a time axis the values are spread evenly over the whole play-bar.

const textual = (cell, decimal) => cell !== "" && Number.isNaN(parseNumber(cell, decimal));

function share(cells, test) {
	const filled = cells.filter((c) => c !== undefined && c !== "");
	return filled.length ? filled.filter(test).length / filled.length : 0;
}

export function transpose(table) {
	const width = table.reduce((m, r) => Math.max(m, r.length), 0);
	return Array.from({ length: width }, (_, c) => table.map((r) => r[c] ?? ""));
}

const TIME_NAME_RE = /^(time|tid|t|sec|secs|seconds|s|ms|millis|timestamp|x)$/i;

// The layout a table most likely has.
export function guessLayout(table, decimal = ".") {
	const R = table.length;
	const C = table.reduce((m, r) => Math.max(m, r.length), 0);
	const isText = (c) => textual(c, decimal);
	const isNum = (c) => !Number.isNaN(parseNumber(c, decimal));
	let layout;
	if (R === 0 || C === 0) {
		layout = { orientation: "columns", header: false, timeColumn: false };
	} else if (R === 1) {
		layout = { orientation: "rows", header: isText(table[0][0]) && C > 1, timeColumn: false };
	} else if (C === 1) {
		layout = { orientation: "columns", header: isText(table[0][0]) && R > 1, timeColumn: false };
	} else {
		const inner = table.slice(1).flatMap((r) => r.slice(1));
		const firstColumn = table.slice(1).map((r) => r[0]);
		const firstRow = table[0].slice(1);
		const innerNumeric = share(inner, isNum) >= 0.6;
		const labelsDown = share(firstColumn, isText) >= 0.6;
		const labelsAcross = share(firstRow, isText) >= 0.6;
		if (innerNumeric && labelsDown && !labelsAcross) layout = { orientation: "rows", header: true, timeColumn: false };
		else if (innerNumeric && labelsAcross) layout = { orientation: "columns", header: true, timeColumn: false };
		else if (share(table[0], isText) >= 0.6 && share(table[1], isNum) >= 0.6) layout = { orientation: "columns", header: true, timeColumn: false };
		else layout = { orientation: R <= C ? "rows" : "columns", header: false, timeColumn: false };
	}
	// A time axis: a first series named like one, counting upwards.
	const grid = layout.orientation === "rows" ? transpose(table) : table;
	const body = layout.header ? grid.slice(1) : grid;
	if (layout.header && grid[0]?.length > 1 && TIME_NAME_RE.test(grid[0][0] || "") && body.length > 1) {
		const xs = body.map((r) => parseNumber(r[0], decimal));
		if (xs.every(Number.isFinite) && xs.every((x, i) => i === 0 || x >= xs[i - 1]) && xs[xs.length - 1] > xs[0]) layout.timeColumn = true;
	}
	return layout;
}

// Fills the gaps (NaN) of a series: between two values linearly, before the first and
// after the last by holding the nearest. With `times` (seconds per value) and `maxGap`,
// a gap longer than that is not bridged by a line: the last value is held until the next
// one comes — a hand that left the picture does not slide to where it comes back.
export function fillGaps(values, { times = null, maxGap = Infinity } = {}) {
	const out = Float64Array.from(values);
	let first = -1;
	for (let i = 0; i < out.length; i++) {
		if (Number.isFinite(out[i])) {
			first = i;
			break;
		}
	}
	if (first < 0) return out;
	for (let i = 0; i < first; i++) out[i] = out[first];
	let prev = first;
	for (let i = first + 1; i < out.length; i++) {
		if (!Number.isFinite(out[i])) continue;
		const bridge = !times || times[i] - times[prev] <= maxGap;
		for (let k = prev + 1; k < i; k++) out[k] = bridge ? out[prev] + ((out[i] - out[prev]) * (k - prev)) / (i - prev) : out[prev];
		prev = i;
	}
	for (let i = prev + 1; i < out.length; i++) out[i] = out[prev];
	return out;
}

// { length, xs (positions 0–1 of every value when there is a time axis, else null),
//   series: [{ name, sourceIndex, filled, min, max }] }. A series with no number
// in it at all is left out.
export function buildDataset(table, layout, decimal = ".") {
	const grid = layout.orientation === "rows" ? transpose(table) : table;
	const header = layout.header ? grid[0] || [] : null;
	const body = layout.header ? grid.slice(1) : grid;
	const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
	let xs = null;
	let first = 0;
	if (layout.timeColumn) {
		const times = body.map((r) => parseNumber(r[0], decimal));
		first = 1;
		if (times.length > 1 && times.every(Number.isFinite) && times.every((t, i) => i === 0 || t >= times[i - 1]) && times[times.length - 1] > times[0]) {
			const t0 = times[0];
			const span = times[times.length - 1] - t0;
			xs = Float64Array.from(times, (t) => (t - t0) / span);
		}
	}
	const series = [];
	for (let c = first; c < width; c++) {
		const raw = body.map((r) => parseNumber(r[c], decimal));
		const finite = raw.filter(Number.isFinite);
		if (!finite.length) continue;
		let min = Infinity;
		let max = -Infinity;
		for (const v of finite) {
			if (v < min) min = v;
			if (v > max) max = v;
		}
		const name = (header?.[c] || "").trim();
		series.push({ name: name || `Series ${series.length + 1}`, sourceIndex: c, filled: fillGaps(raw), min, max });
	}
	return { length: body.length, xs, series };
}

// The fractional index into a series at a point (0–1) of the play-bar.
function indexAt(dataset, pos) {
	const n = dataset.length;
	if (n <= 1) return 0;
	const p = Math.min(1, Math.max(0, pos));
	if (!dataset.xs) return p * (n - 1);
	const xs = dataset.xs;
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= p) lo = mid;
		else hi = mid;
	}
	const gap = xs[hi] - xs[lo];
	return lo + (gap > 0 ? (p - xs[lo]) / gap : 0);
}

// The (raw) value of a series at `pos` (0–1 of the play-bar); "linear" reads
// between the values, "step" holds each one until the next.
export function sampleSeries(dataset, series, pos, interpolate = "linear") {
	const n = dataset.length;
	if (!n) return NaN;
	if (n === 1) return series.filled[0];
	const f = indexAt(dataset, pos);
	const i = Math.min(n - 1, Math.floor(f));
	if (interpolate === "step") return series.filled[i];
	const j = Math.min(n - 1, i + 1);
	return series.filled[i] + (series.filled[j] - series.filled[i]) * (f - i);
}

// The q-quantile (0–1) of the finite numbers in `values`, read between neighbours; NaN if
// there are none.
export function quantile(values, q) {
	const a = Float64Array.from(Array.prototype.filter.call(values, Number.isFinite)).sort();
	if (!a.length) return NaN;
	const pos = (a.length - 1) * Math.min(1, Math.max(0, q));
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// The range a series is read over when its most extreme `percent` % at either end is
// ignored (2 gives the 2nd to the 98th percentile): one wild reading no longer decides
// what 0 and 1 are. { lo, hi }, or null when there is nothing to go by.
export function percentileRange(values, percent) {
	const lo = quantile(values, percent / 100);
	const hi = quantile(values, 1 - percent / 100);
	return Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null;
}

// 0–1 of `value` between lo and hi (clamped); `invert` runs it 1 to 0.
export function normalize(value, lo, hi, invert = false) {
	if (!Number.isFinite(value)) return undefined;
	const t = hi > lo ? Math.min(1, Math.max(0, (value - lo) / (hi - lo))) : 0;
	return invert ? 1 - t : t;
}

// What a waveform shows: for each of `columns` pixel columns across the visible
// stretch [start, start+span] of the play-bar, the lowest and highest
// normalized value there. `points` are the values themselves (position, 0–1)
// when so few are visible that a line through them is better. `norm(v)` maps a raw
// value to 0–1.
export function waveformColumns(dataset, series, view, columns, norm) {
	const n = dataset.length;
	const { start, span } = view;
	const visible = [];
	const posOf = (i) => (dataset.xs ? dataset.xs[i] : n > 1 ? i / (n - 1) : 0);
	// The indexes whose position lies in the visible stretch, plus one either side.
	let i0 = Math.max(0, Math.floor(indexAt(dataset, start)) - 1);
	let i1 = Math.min(n - 1, Math.ceil(indexAt(dataset, start + span)) + 1);
	if (i1 - i0 <= columns * 1.5) {
		for (let i = i0; i <= i1; i++) visible.push({ x: (posOf(i) - start) / span, y: norm(series.filled[i]) });
		return { points: visible };
	}
	const lo = new Float32Array(columns).fill(NaN);
	const hi = new Float32Array(columns).fill(NaN);
	for (let i = i0; i <= i1; i++) {
		const col = Math.floor(((posOf(i) - start) / span) * columns);
		if (col < 0 || col >= columns) continue;
		const y = norm(series.filled[i]);
		if (!(y >= lo[col])) lo[col] = y;
		if (!(y <= hi[col])) hi[col] = y;
	}
	return { lo, hi };
}
