import { playerStore } from "../waxml-integration/player-store.js";
import { inputTransport } from "./input-transport.js";
import { inputView } from "./input-view.js";
import { normalize, sampleSeries, waveformColumns } from "./data-series.js";
import { TARGET_PILL_CSS, armMapping, renderTargetPills } from "./target-pills.js";
import "../components/wa-color-picker.js";

// One row of a time-based input: a series of values along the play-bar, shown as a
// waveform (normalized 0–1 after the row's own range and invert, in the row's colour,
// with a vertical line at the playhead), with the controls every row has — colour,
// mute, invert, the values that become 0 and 1, remove — and the targets it drives
// (see target-pills.js). Shared by the CSV rows (wa-data-input.js) and the rows of an
// analysed video (wa-video-input.js): once the numbers exist, a row is a row.
//
// An entry is { id, key, name, detail?, color, invert, bypassed, min, max, mappings }
// — the part that is saved. Where its values come from is `source()`, which returns
// { data, series, interpolate } (data: { length, xs }, series: { filled, min, max },
// see data-series.js), or null. `ctx` hands the row what only its section knows:
//   onChange()                       — something worth saving changed;
//   onRemove(entry)                  — its × was clicked;
//   syntheticName(entry, index)      — the name a root-<Var> target is fed under.
// The zoom is the panel-wide inputView; the clock is inputTransport.

const SEND_EPSILON = 1e-4;
const WAVE_HEIGHT = 46;

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
		this.el = this._build();
	}

	// The values that become 0 and 1: the row's own, else the data's lowest and highest.
	_range() {
		const src = this.source();
		return { lo: this.entry.min ?? src?.series.min ?? 0, hi: this.entry.max ?? src?.series.max ?? 1 };
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
		top.append(picker, name, mute, del);

		const wave = document.createElement("div");
		wave.className = "wave";
		this.canvas = document.createElement("canvas");
		const mid = document.createElement("div");
		mid.className = "mid";
		this.playheadEl = document.createElement("div");
		this.playheadEl.className = "playhead";
		wave.append(this.canvas, mid, this.playheadEl);
		this.waveEl = wave;
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
		const range = document.createElement("span");
		range.className = "range";
		range.title = "The values that become 0 and 1 (empty: the lowest and highest in the data)";
		const lo = document.createElement("input");
		lo.type = "number";
		lo.step = "any";
		lo.placeholder = this._placeholder("min");
		lo.value = entry.min ?? "";
		const hi = document.createElement("input");
		hi.type = "number";
		hi.step = "any";
		hi.placeholder = this._placeholder("max");
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
		controls.append(invert, range, valueRow);

		this.targetsEl = document.createElement("div");
		this.targetsEl.className = "targets";
		this.refreshTargets();

		row.append(top, wave, controls, this.targetsEl);
		return row;
	}

	_placeholder(which) {
		const s = this.source()?.series;
		return s ? String(+s[which].toPrecision(4)) : "";
	}

	refreshTargets() {
		const { entry, ctx } = this;
		renderTargetPills(this.targetsEl, entry, {
			syntheticName: (index) => ctx.syntheticName(entry, index),
			onChange: () => {
				this.update({ force: true });
				ctx.onChange();
			},
			armFn: (anchorEl, onPick) => armMapping(anchorEl, onPick)
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
			inputTransport.seekFraction(fractionAt(e));
		});
		wave.addEventListener("pointermove", (e) => {
			if (dragging) inputTransport.seekFraction(fractionAt(e));
		});
		const end = () => (dragging = false);
		wave.addEventListener("pointerup", end);
		wave.addEventListener("pointercancel", end);
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

	// The waveform, for the stretch the panel shows.
	draw() {
		const canvas = this.canvas;
		const src = this.source();
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
		const src = this.source();
		if (!src) return;
		const { entry } = this;
		const { lo, hi } = this._range();
		const raw = sampleSeries(src.data, src.series, inputTransport.fraction, src.interpolate);
		const norm = normalize(raw, lo, hi, entry.invert);
		const changed = norm === undefined || this.norm === undefined ? norm !== this.norm : Math.abs(norm - this.norm) >= SEND_EPSILON;
		this.norm = norm;
		const shown = norm !== undefined && !entry.bypassed;
		this.numEl.textContent = shown ? norm.toFixed(2) : "—";
		this.fillEl.style.width = shown ? `${norm * 100}%` : "0%";
		if (quiet || !shown || !(changed || force)) return;
		entry.mappings.forEach((mapping, index) => {
			if (!mapping?.varName) return;
			playerStore.setVariable(mapping.direct ? mapping.inputVar : this.ctx.syntheticName(entry, index), norm);
		});
	}
}
