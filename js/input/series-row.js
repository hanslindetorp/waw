import { parseNumber } from "./csv-parse.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { inputTransport } from "./input-transport.js";
import { inputView } from "./input-view.js";
import { despike, indexesBetween, normalize, percentileRange, positionOf, quantile, sampleSeries, waveformColumns } from "./data-series.js";
import { TARGET_PILL_CSS, armMapping, mappingOutput, renderTargetPills } from "./target-pills.js";
import "../components/wa-color-picker.js";

// One row of a time-based input: a series of values along the play-bar, shown as a
// waveform (normalized 0–1 after the row's own range and invert, in the row's colour,
// with a vertical line at the playhead), with the controls every row has — colour,
// mute, invert, the values that become 0 and 1, remove — and the targets it drives
// (see target-pills.js). Shared by the CSV rows (wa-data-input.js) and the rows of an
// analysed video (wa-video-input.js): once the numbers exist, a row is a row.
//
// An entry is { id, key, name, detail?, color, invert, bypassed, min, max, mappings }
// (plus `percentile`: 0, or how many % at either end are ignored when finding the range;
// and `spikes`: 0, or the size (2 | 4 | 8) of the filter that levels out stray values)
// — the part that is saved. Where its values come from is `source()`, which returns
// { data, series, interpolate } (data: { length, xs }, series: { filled, min, max },
// see data-series.js), or null. `ctx` hands the row what only its section knows:
//   onChange()                       — something worth saving changed;
//   onRemove(entry)                  — its × was clicked;
//   syntheticName(entry, index)      — the name a root-<Var> target is fed under;
//   edit?                            — present when the values can be changed (they are, or can
//                                      become, a column of a CSV file):
//                                      { readCell(entry, i) → the text of value i's cell,
//                                        writeCells(entry, [[i, number | text]]) — puts them in
//                                        the file and reads the series anew,
//                                        begin?(entry) — called before the first change (a video row
//                                        lifts its track out into a CSV file then),
//                                        revert?(entry) — a row with that: its "Revert" button gives
//                                        up the changes }.
// Double-clicking the waveform enters the drawing mode (the pointer becomes a pen), OK or another
// double-click leaves it; "Remove spikes" fixes the stray values a tracker gives. See _wireWave. The zoom is the panel-wide inputView; the clock is inputTransport.

const SEND_EPSILON = 1e-4;
const WAVE_HEIGHT = 46;
const EDIT_HEIGHT = 120; // taller while drawing, for finer steps
const PEN_SVG =
	"<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M3 21l1.2-4.6L16.4 4.2a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L7.6 19.8z' fill='white' stroke='black' stroke-width='1.3' stroke-linejoin='round'/><path d='M3 21l1.2-4.6 3.4 3.4z' fill='black'/></svg>";
const PEN_CURSOR = `url("data:image/svg+xml,${PEN_SVG.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23")}") 3 21, crosshair`;
const DOUBLE_CLICK_MS = 600;

// Only one row is drawn on at a time.
let editingRow = null;

export const SERIES_ROW_CSS = `
	.data-row {
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid var(--waw-border, #2f2f2f);
		border-radius: 7px;
		padding: 0.45rem 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.row-top {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem 0.5rem;
	}
	.row-name {
		flex: 1 1 6rem;
		min-width: 0;
		font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		font-size: 0.74rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--entry-color, #4fa3ff);
	}
	.row-name small {
		color: var(--waw-muted, #8a8a8a);
		font-size: 0.65rem;
		margin-left: 0.4rem;
	}
	.mute-btn,
	.icon-btn {
		border: 1.5px solid var(--waw-border, #2f2f2f);
		border-radius: 6px;
		background: #1a1c1f;
		color: var(--waw-muted, #8a8a8a);
		cursor: pointer;
		line-height: 1;
	}
	.mute-btn {
		padding: 0.15rem 0.45rem;
		font-size: 0.7rem;
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.2rem 0.3rem;
	}
	.mute-btn.active {
		border-color: #fb923c;
		color: #fb923c;
		background: rgba(251, 146, 60, 0.14);
	}
	.icon-btn.active {
		border-color: var(--waw-teal, #45b58c);
		color: var(--waw-teal, #45b58c);
		background: rgba(69, 181, 140, 0.12);
	}
	.row-del {
		background: none;
		border: none;
		color: var(--waw-muted, #8a8a8a);
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0 0.2rem;
	}
	.row-del:hover {
		color: var(--waw-danger, #e5484d);
	}
	.wave {
		position: relative;
		height: ${WAVE_HEIGHT}px;
		background: #0f1113;
		border-radius: 4px;
		overflow: hidden;
		cursor: ew-resize;
		touch-action: none;
	}
	.wave canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
	.wave .mid {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 1px;
		background: rgba(255, 255, 255, 0.06);
		pointer-events: none;
	}
	.wave.editing {
		height: ${EDIT_HEIGHT}px;
		cursor: ${PEN_CURSOR};
		outline: 1.5px solid var(--entry-color, #4fa3ff);
		outline-offset: -1.5px;
	}
	.edit-hint {
		position: absolute;
		left: 6px;
		top: 3px;
		font-size: 0.62rem;
		color: var(--waw-muted, #8a8a8a);
		pointer-events: none;
		display: none;
	}
	.wave.editing .edit-hint {
		display: block;
	}
	.ok-btn {
		border: 1.5px solid var(--waw-teal, #45b58c);
		border-radius: 6px;
		background: rgba(69, 181, 140, 0.18);
		color: var(--waw-teal, #45b58c);
		cursor: pointer;
		font-size: 0.7rem;
		padding: 0.15rem 0.6rem;
		line-height: 1;
	}
	.ok-btn[hidden],
	.revert-btn[hidden] {
		display: none;
	}
	.revert-btn {
		border: 1.5px solid var(--waw-border, #2f2f2f);
		border-radius: 6px;
		background: #1a1c1f;
		color: var(--waw-muted, #8a8a8a);
		cursor: pointer;
		font-size: 0.65rem;
		padding: 0.15rem 0.45rem;
		line-height: 1;
	}
	.revert-btn:hover {
		border-color: var(--waw-danger, #e5484d);
		color: var(--waw-danger, #e5484d);
	}
	.despike-msg {
		font-size: 0.65rem;
		color: var(--waw-muted, #8a8a8a);
	}
	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: #fff;
		box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.6);
		pointer-events: none;
		left: 0;
	}
	.row-controls {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.range {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.65rem;
		color: var(--waw-muted, #8a8a8a);
	}
	.pct {
		background: #111;
		border: 1px solid var(--waw-border, #2f2f2f);
		border-radius: 4px;
		color: var(--waw-fg, #e8e8e8);
		font-size: 0.68rem;
		padding: 0.1rem 0.2rem;
	}
	.range input {
		width: 3.3rem;
		background: #111;
		border: 1px solid var(--waw-border, #2f2f2f);
		border-radius: 4px;
		color: var(--waw-fg, #e8e8e8);
		font-size: 0.68rem;
		padding: 0.1rem 0.25rem;
	}
	.value-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1 1 8rem;
	}
	.value-bar {
		flex: 1 1 auto;
		height: 6px;
		background: #1a1c1f;
		border-radius: 3px;
		overflow: hidden;
	}
	.value-fill {
		height: 100%;
		width: 0;
		background: var(--entry-color, #4fa3ff);
	}
	.value-num {
		font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		font-size: 0.72rem;
		min-width: 2.6rem;
		text-align: right;
		color: var(--waw-fg, #e8e8e8);
	}
	${TARGET_PILL_CSS}
`;

export class SeriesRow {
	constructor(entry, source, ctx) {
		this.entry = entry;
		this.source = source;
		this.ctx = ctx;
		this.norm = undefined;
		this._sent = new WeakMap(); // what each target was last sent
		this.el = this._build();
	}

	// The values that become 0 and 1 when nothing is typed in: the data's lowest and highest,
	// or — with a percentile chosen — those left when that % at either end is ignored.
	// (Worked out once per series and percentile; a series that is replaced is worked out anew.)
	_autoRange() {
		const series = this._view()?.series;
		if (!series) return { lo: 0, hi: 1 };
		const p = this.entry.percentile || 0;
		if (!p) return { lo: series.min, hi: series.max };
		const cache = (series._percentiles ??= new Map());
		const hit = cache.get(p);
		if (hit && hit.filled === series.filled) return hit.range;
		const range = percentileRange(series.filled, p) ?? { lo: series.min, hi: series.max };
		cache.set(p, { filled: series.filled, range });
		return range;
	}

	// The values that become 0 and 1: the row's own, else the automatic ones.
	_range() {
		const auto = this._autoRange();
		return { lo: this.entry.min ?? auto.lo, hi: this.entry.max ?? auto.hi };
	}

	_build() {
		const { entry, ctx } = this;
		const row = document.createElement("div");
		row.className = "data-row";
		row.style.setProperty("--entry-color", entry.color);

		const top = document.createElement("div");
		top.className = "row-top";
		const picker = document.createElement("wa-color-picker");
		picker.setAttribute("value", entry.color);
		picker.addEventListener("change", (e) => {
			entry.color = e.detail.value;
			row.style.setProperty("--entry-color", entry.color);
			this.draw();
			ctx.onChange();
		});
		const name = document.createElement("div");
		name.className = "row-name";
		name.textContent = entry.name;
		if (entry.detail) {
			const small = document.createElement("small");
			small.textContent = entry.detail;
			name.appendChild(small);
		}
		name.title = entry.detail ? `${entry.name} — ${entry.detail}` : entry.name;
		const mute = document.createElement("button");
		mute.type = "button";
		mute.className = "mute-btn" + (entry.bypassed ? " active" : "");
		mute.textContent = "mute";
		mute.title = "Mute — this row stops setting its targets, without losing anything";
		mute.addEventListener("click", () => {
			entry.bypassed = !entry.bypassed;
			mute.classList.toggle("active", entry.bypassed);
			this.draw();
			this.update({ force: !entry.bypassed });
			ctx.onChange();
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "row-del";
		del.textContent = "×";
		del.title = "Remove this row";
		del.addEventListener("click", () => ctx.onRemove(entry));
		this.okBtn = document.createElement("button");
		this.okBtn.type = "button";
		this.okBtn.className = "ok-btn";
		this.okBtn.textContent = "OK";
		this.okBtn.hidden = true;
		this.okBtn.title = "Finish drawing (the new values are kept in the CSV file)";
		this.okBtn.addEventListener("click", () => this.setEditing(false));
		this.revertBtn = document.createElement("button");
		this.revertBtn.type = "button";
		this.revertBtn.className = "revert-btn";
		this.revertBtn.textContent = "edited · Revert";
		this.revertBtn.hidden = true;
		this.revertBtn.title = "This row's values were changed by hand and now come from a CSV file. Revert gives the changes up and measures from the analysis again.";
		this.revertBtn.addEventListener("click", () => {
			if (window.confirm("Give up the changes made by hand to this row and measure it from the analysis again? The CSV file with the changes is deleted.")) {
				ctx.edit.revert(entry);
			}
		});
		top.append(picker, name, this.okBtn, this.revertBtn, mute, del);

		const wave = document.createElement("div");
		wave.className = "wave";
		this.canvas = document.createElement("canvas");
		const mid = document.createElement("div");
		mid.className = "mid";
		this.playheadEl = document.createElement("div");
		this.playheadEl.className = "playhead";
		this.hintEl = document.createElement("div");
		this.hintEl.className = "edit-hint";
		this.hintEl.textContent = "Drawing";
		this.hintEl.title = "Drag to draw. ⌘/Ctrl+Z undoes a stroke. OK, Esc or a double-click finishes.";
		wave.append(this.canvas, mid, this.hintEl, this.playheadEl);
		this.waveEl = wave;
		this._undo = [];
		this._wireWave(wave);

		const controls = document.createElement("div");
		controls.className = "row-controls";
		const invert = document.createElement("button");
		invert.type = "button";
		invert.className = "icon-btn" + (entry.invert ? " active" : "");
		invert.title = "Invert — the value runs 1 to 0 instead of 0 to 1";
		invert.setAttribute("aria-label", "Invert");
		invert.innerHTML =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5"/></svg>';
		invert.addEventListener("click", () => {
			entry.invert = !entry.invert;
			invert.classList.toggle("active", entry.invert);
			this.draw();
			this.update({ force: true });
			ctx.onChange();
		});
		const pct = document.createElement("select");
		pct.className = "pct";
		pct.title = "How the range of 0 and 1 is found: all of the values, or leaving out the most extreme ones at either end, so that one wild reading does not decide it";
		[
			[0, "Full range"],
			[1, "1–99 %"],
			[2, "2–98 %"],
			[5, "5–95 %"]
		].forEach(([value, label]) => {
			const o = document.createElement("option");
			o.value = value;
			o.textContent = label;
			pct.appendChild(o);
		});
		pct.value = String(entry.percentile || 0);
		const range = document.createElement("span");
		range.className = "range";
		range.title = "The values that become 0 and 1 (empty: the lowest and highest in the data)";
		const lo = document.createElement("input");
		lo.type = "number";
		lo.step = "any";
		lo.placeholder = this._placeholder("lo");
		lo.value = entry.min ?? "";
		const hi = document.createElement("input");
		this._loInput = lo;
		this._hiInput = hi;
		hi.type = "number";
		hi.step = "any";
		hi.placeholder = this._placeholder("hi");
		hi.value = entry.max ?? "";
		const setRange = () => {
			entry.min = lo.value === "" ? null : Number(lo.value);
			entry.max = hi.value === "" ? null : Number(hi.value);
			this.draw();
			this.update({ force: true });
			ctx.onChange();
		};
		lo.addEventListener("change", setRange);
		hi.addEventListener("change", setRange);
		pct.addEventListener("change", () => {
			entry.percentile = Number(pct.value);
			lo.placeholder = this._placeholder("lo");
			hi.placeholder = this._placeholder("hi");
			this.draw();
			this.update({ force: true });
			ctx.onChange();
		});
		range.append("0 =", lo, "1 =", hi);

		const valueRow = document.createElement("div");
		valueRow.className = "value-row";
		const bar = document.createElement("div");
		bar.className = "value-bar";
		this.fillEl = document.createElement("div");
		this.fillEl.className = "value-fill";
		bar.appendChild(this.fillEl);
		this.numEl = document.createElement("span");
		this.numEl.className = "value-num";
		this.numEl.textContent = "—";
		valueRow.append(bar, this.numEl);
		controls.append(invert, pct, range, valueRow);
		const spikes = document.createElement("select");
		spikes.className = "pct";
		spikes.title = "Spike filter — values that jump away for a moment (a tracker that lost a point) get the value of their neighbours. Light finds the shortest spikes, Strong longer ones. Off shows the values as they are. Drawing on the row takes the filtered values as they are.";
		[
			["0", "Spikes: off"],
			["2", "Spikes: light"],
			["4", "Spikes: medium"],
			["8", "Spikes: strong"]
		].forEach(([value, label]) => {
			const o = document.createElement("option");
			o.value = value;
			o.textContent = label;
			spikes.appendChild(o);
		});
		spikes.value = String(entry.spikes || 0);
		this.spikesSelect = spikes;
		this.despikeMsg = document.createElement("span");
		this.despikeMsg.className = "despike-msg";
		spikes.addEventListener("change", () => {
			entry.spikes = Number(spikes.value);
			this._afterWrite();
			ctx.onChange();
		});
		controls.append(spikes, this.despikeMsg);

		this.targetsEl = document.createElement("div");
		this.targetsEl.className = "targets";
		this.refreshTargets();

		row.append(top, wave, controls, this.targetsEl);
		return row;
	}

	_placeholder(which) {
		return this.source()?.series ? String(+this._autoRange()[which].toPrecision(4)) : "";
	}

	refreshTargets() {
		const { entry, ctx } = this;
		renderTargetPills(this.targetsEl, entry, {
			syntheticName: (index) => ctx.syntheticName(entry, index),
			onChange: () => {
				this.update({ force: true });
				ctx.onChange();
			},
			armFn: (anchorEl, onPick) => armMapping(anchorEl, onPick),
			features: ["invert", "d1", "d2", "d3", "gate"]
		});
	}

	// Dragging in the waveform moves the playhead; Ctrl/⌘ + wheel (also a pinch)
	// zooms, a sideways wheel moves along the zoomed stretch.
	_wireWave(wave) {
		const fractionAt = (e) => {
			const rect = wave.getBoundingClientRect();
			const a = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
			return inputView.start + a * inputView.span;
		};
		let dragging = false;
		wave.addEventListener("pointerdown", (e) => {
			dragging = true;
			wave.setPointerCapture(e.pointerId);
			if (this.editing) this._beginStroke(e);
			else inputTransport.seekFraction(fractionAt(e));
		});
		wave.addEventListener("pointermove", (e) => {
			if (!dragging) return;
			if (this.editing) this._moveStroke(e);
			else inputTransport.seekFraction(fractionAt(e));
		});
		const end = () => {
			if (dragging && this.editing) this._endStroke();
			dragging = false;
		};
		wave.addEventListener("pointerup", end);
		wave.addEventListener("pointercancel", end);
		wave.addEventListener("dblclick", () => {
			if (!this.ctx.edit) return;
			if (this.editing) this._dropDoubleClickDots();
			this.setEditing(!this.editing);
		});
		wave.addEventListener(
			"wheel",
			(e) => {
				const rect = wave.getBoundingClientRect();
				const a = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					inputView.zoom(Math.exp(-e.deltaY * 0.01), a);
				} else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && inputView.span < 1) {
					e.preventDefault();
					inputView.pan((e.deltaX / Math.max(1, rect.width)) * inputView.span);
				}
			},
			{ passive: false }
		);
	}

	// ── Drawing over the values ──────────────────────────────────────────
	// In the drawing mode a drag sets the values under the pointer to where it is (a quick
	// stroke is filled in between), live in the row's series; when the stroke ends the new
	// values go into the CSV file (ctx.edit.writeCells). Undo takes back one stroke at a time.
	setEditing(on) {
		if (on === !!this.editing) return;
		if (on && !this.ctx.edit) return;
		if (on && editingRow && editingRow !== this) editingRow.setEditing(false);
		this.editing = on;
		this.waveEl.classList.toggle("editing", on);
		this.okBtn.hidden = !on;
		if (on) {
			editingRow = this;
			this._onKey = (e) => this._keydown(e);
			document.addEventListener("keydown", this._onKey, true);
		} else {
			if (editingRow === this) editingRow = null;
			document.removeEventListener("keydown", this._onKey, true);
			this._stroke = null;
		}
		this.draw();
	}

	_keydown(e) {
		if (e.key === "Escape") {
			e.preventDefault();
			this.setEditing(false);
		} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "") && this._undo.length) {
			e.preventDefault();
			e.stopPropagation();
			this._undoStroke();
		}
	}

	// Where a pointer event falls: its position along the play-bar, and the raw value that
	// height stands for (0 at the bottom of the wave and 1 at the top, after invert).
	_pointAt(e) {
		const rect = this.waveEl.getBoundingClientRect();
		const a = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
		const h = Math.max(1, rect.height);
		const n = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top - 2) / Math.max(1, h - 4)));
		const { lo, hi } = this._range();
		const t = this.entry.invert ? 1 - n : n;
		return { pos: inputView.start + a * inputView.span, value: lo + t * (hi - lo), x: e.clientX, y: e.clientY };
	}

	_beginStroke(e) {
		const src = this.source();
		const { lo, hi } = this._range();
		if (!src || !(hi > lo)) return;
		this._bakeSpikes();
		this.ctx.edit.begin?.(this.entry);
		const p = this._pointAt(e);
		this._stroke = { cells: new Map(), last: p, start: p, moved: false, time: performance.now() };
		this._paint(p, p);
	}

	_moveStroke(e) {
		if (!this._stroke) return;
		const p = this._pointAt(e);
		if (Math.abs(p.x - this._stroke.start.x) + Math.abs(p.y - this._stroke.start.y) > 3) this._stroke.moved = true;
		this._paint(this._stroke.last, p);
		this._stroke.last = p;
	}

	_paint(a, b) {
		const src = this.source();
		const stroke = this._stroke;
		if (!src || !stroke) return;
		const half = (inputView.span / Math.max(1, this.waveEl.clientWidth)) * 0.5; // half a pixel
		const lo = Math.min(a.pos, b.pos) - half;
		const hi = Math.max(a.pos, b.pos) + half;
		const width = b.pos - a.pos;
		for (const i of indexesBetween(src.data, lo, hi)) {
			const t = width ? Math.min(1, Math.max(0, (positionOf(src.data, i) - a.pos) / width)) : 1;
			if (!stroke.cells.has(i)) stroke.cells.set(i, this.ctx.edit.readCell(this.entry, i));
			src.series.filled[i] = a.value + (b.value - a.value) * t;
		}
		this.draw();
		this.update();
	}

	_endStroke() {
		const stroke = this._stroke;
		this._stroke = null;
		const src = this.source();
		if (!stroke || !src || !stroke.cells.size) return;
		const cells = [...stroke.cells.keys()].map((i) => [i, src.series.filled[i]]);
		this._undo.push({ before: [...stroke.cells], click: !stroke.moved, time: stroke.time });
		this.ctx.edit.writeCells(this.entry, cells);
		this._afterWrite();
	}

	_undoStroke() {
		const last = this._undo.pop();
		if (!last) return;
		this.ctx.edit.writeCells(this.entry, last.before);
		this._afterWrite();
	}

	// Shown on a row whose values were changed by hand and so come from a CSV file of their own.
	setEdited(on) {
		this.revertBtn.hidden = !on;
	}

	// The changes are given up (the row measures from the analysis again): nothing to undo.
	resetEdits() {
		this._undo = [];
		this.setEditing(false);
		this.setEdited(false);
		this._afterWrite();
	}

	// What the row reads its values from: the source, with the spike filter on (see despike)
	// when it is. Worked out once per series and filter.
	_view() {
		const src = this.source();
		const radius = this.entry.spikes || 0;
		if (!src) return src;
		if (!radius) {
			if (this.despikeMsg) this.despikeMsg.textContent = "";
			return src;
		}
		const raw = src.series;
		let hit = this._filtered;
		if (!hit || hit.raw !== raw.filled || hit.radius !== radius) {
			const filled = Float64Array.from(raw.filled);
			const found = despike(filled, { radius, floor: 0.01 * (raw.max - raw.min) });
			found.forEach(([i, value]) => (filled[i] = value));
			let min = Infinity;
			let max = -Infinity;
			for (const v of filled) {
				if (v < min) min = v;
				if (v > max) max = v;
			}
			hit = this._filtered = { raw: raw.filled, radius, series: { ...raw, filled, min, max }, found };
		}
		if (this.despikeMsg) this.despikeMsg.textContent = hit.found.length ? `${hit.found.length} flattened` : "none found";
		return { ...src, series: hit.series };
	}

	// Drawing starts from what is shown: with the filter on, its result is written to the file
	// first (one change, undone like a stroke) and the filter goes off.
	_bakeSpikes() {
		const radius = this.entry.spikes;
		if (!radius) return;
		const edit = this.ctx.edit;
		this._view(); // (works the filter out, if not yet)
		const src = this.source();
		const changes = this._filtered.found.filter(([i]) => Number.isFinite(parseNumber(edit.readCell(this.entry, i))));
		this.entry.spikes = 0;
		this.spikesSelect.value = "0";
		if (changes.length) {
			edit.begin?.(this.entry);
			const before = changes.map(([i]) => [i, edit.readCell(this.entry, i)]);
			changes.forEach(([i, value]) => (src.series.filled[i] = value));
			this._undo.push({ before, click: false, time: 0 });
			edit.writeCells(this.entry, changes);
		}
		this.ctx.onChange();
		this._afterWrite();
	}

	// The derivatives of the row's values (0–1 as sent: 0.5 where nothing changes), worked out
	// once per series, range, invert and filter. Each is the change per step along the play-bar
	// (by central differences), scaled so the steepest 1 % are at the ends.
	_derivatives(view) {
		const key = `${view.series.filled.length}|${this._range().lo}|${this._range().hi}|${this.entry.invert}|${this.entry.spikes || 0}`;
		if (this._deriv && this._deriv.raw === view.series.filled && this._deriv.key === key) return this._deriv.set;
		const { data, series } = view;
		const n = data.length;
		const { lo, hi } = this._range();
		let level = Float64Array.from({ length: n }, (_, i) => normalize(series.filled[i], lo, hi, this.entry.invert) ?? 0);
		const pos = Float64Array.from({ length: n }, (_, i) => positionOf(data, i));
		const set = {};
		for (const mode of ["d1", "d2", "d3"]) {
			const next = new Float64Array(n);
			for (let i = 0; i < n; i++) {
				const a = Math.max(0, i - 1);
				const b = Math.min(n - 1, i + 1);
				const dp = pos[b] - pos[a];
				next[i] = dp > 0 ? (level[b] - level[a]) / dp : 0;
			}
			level = next;
			const m = quantile(next.map(Math.abs), 0.99);
			set[mode] = { filled: next.map((d) => (m > 0 ? 0.5 + 0.5 * Math.max(-1, Math.min(1, d / m)) : 0.5)) };
		}
		this._deriv = { raw: view.series.filled, key, set };
		return set;
	}

	// Double-clicking to finish is two clicks of the pen: take back the dots they made.
	_dropDoubleClickDots() {
		const now = performance.now();
		for (let k = 0; k < 2; k++) {
			const last = this._undo[this._undo.length - 1];
			if (last?.click && now - last.time < DOUBLE_CLICK_MS) this._undoStroke();
		}
	}

	_afterWrite() {
		this._loInput.placeholder = this._placeholder("lo");
		this._hiInput.placeholder = this._placeholder("hi");
		this.draw();
		this.update({ force: true });
	}

	// The waveform, for the stretch the panel shows.
	draw() {
		const canvas = this.canvas;
		const src = this._view();
		if (!canvas || !canvas.isConnected) return;
		const w = Math.max(1, Math.floor(canvas.clientWidth));
		const h = Math.max(1, Math.floor(canvas.clientHeight));
		const dpr = window.devicePixelRatio || 1;
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
		}
		const ctx = canvas.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		if (!src) return;
		const { entry } = this;
		const { lo, hi } = this._range();
		const norm = (v) => normalize(v, lo, hi, entry.invert) ?? 0;
		const yOf = (v) => 2 + (1 - v) * (h - 4);
		const wf = waveformColumns(src.data, src.series, { start: inputView.start, span: inputView.span }, w, norm);
		ctx.globalAlpha = entry.bypassed ? 0.3 : 1;
		ctx.strokeStyle = entry.color;
		ctx.fillStyle = entry.color;
		if (wf.points) {
			if (!wf.points.length) return;
			ctx.lineWidth = 1.5;
			ctx.lineJoin = "round";
			ctx.beginPath();
			wf.points.forEach((p, i) => {
				const x = p.x * w;
				if (i === 0) ctx.moveTo(x, yOf(p.y));
				else ctx.lineTo(x, yOf(p.y));
			});
			ctx.stroke();
			if (wf.points.length * 8 < w) wf.points.forEach((p) => ctx.fillRect(p.x * w - 2, yOf(p.y) - 2, 4, 4));
		} else {
			for (let x = 0; x < w; x++) {
				const a = wf.lo[x];
				const b = wf.hi[x];
				if (Number.isNaN(a) || Number.isNaN(b)) continue;
				const top = yOf(b);
				ctx.fillRect(x, top, 1, Math.max(1.5, yOf(a) - top));
			}
		}
		ctx.globalAlpha = 1;
	}

	// The playhead line (the panel's view decides where it falls).
	updatePlayhead() {
		const left = ((inputTransport.fraction - inputView.start) / inputView.span) * 100;
		this.playheadEl.style.display = left >= 0 && left <= 100 ? "block" : "none";
		this.playheadEl.style.left = `${left}%`;
	}

	// The value at the playhead: shown, and (unless `quiet`) sent to every target when it
	// changed (or `force`).
	update({ force = false, quiet = false } = {}) {
		const src = this._view();
		if (!src) return;
		const { entry } = this;
		const { lo, hi } = this._range();
		const raw = sampleSeries(src.data, src.series, inputTransport.fraction, src.interpolate);
		const norm = normalize(raw, lo, hi, entry.invert);
		this.norm = norm;
		const shown = norm !== undefined && !entry.bypassed;
		this.numEl.textContent = shown ? norm.toFixed(2) : "—";
		this.fillEl.style.width = shown ? `${norm * 100}%` : "0%";
		if (quiet || !shown) return;
		// Each target gets what its own settings make of the value; only what changed is sent.
		let derivatives = null;
		const derivative = (mode) => {
			derivatives ??= this._derivatives(src);
			return sampleSeries(src.data, derivatives[mode], inputTransport.fraction, src.interpolate);
		};
		entry.mappings.forEach((mapping, index) => {
			if (!mapping?.varName) return;
			const out = mappingOutput(mapping, norm, derivative);
			if (out === undefined) return;
			const last = this._sent.get(mapping);
			if (!force && last !== undefined && Math.abs(out - last) < SEND_EPSILON) return;
			this._sent.set(mapping, out);
			playerStore.setVariable(mapping.direct ? mapping.inputVar : this.ctx.syntheticName(entry, index), out);
		});
	}
}
