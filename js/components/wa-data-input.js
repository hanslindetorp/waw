import { playerStore } from "../waxml-integration/player-store.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { inputSources } from "../state/input-sources.js";
import { vfs, ROOT_ID, isHiddenName } from "../vfs/VFS.js";
import { inputTransport } from "../input/input-transport.js";
import { decodeBytes, parseCsv } from "../input/csv-parse.js";
import { buildDataset, normalize, sampleSeries, waveformColumns } from "../input/data-series.js";
import { TARGET_PILL_CSS, armMapping, renderTargetPills } from "../input/target-pills.js";
import { openCsvImportDialog } from "./wa-csv-import-dialog.js";
import "./wa-color-picker.js";
import { COLOR_PALETTE } from "./wa-color-picker.js";

// The INPUT panel's "Data (CSV)" section: a CSV file whose series are played
// along a time line and drive parameters, the way a camera row does — each
// series is a row that can be mapped to any parameter (or root <Var>) and always
// sends 0–1.
//
//   Import       a CSV from the computer or from the project's files; the import
//                dialog (wa-csv-import-dialog.js) shows how it is understood and
//                lets every guess be changed. The file is kept in the project (a
//                normal file in the File Manager), the way it was read in inputs.json.
//   Play         one transport for all rows (input/input-transport.js): PLAY / STOP,
//                a length in seconds, loop, scrub by dragging in a waveform or the bar.
//                The values of a file are spread evenly over that length (or placed by
//                its own time axis). A video will take the clock over later, so
//                picture and data stay together.
//   Waveform     per row, normalized 0–1 (after the row's own range and invert), in the
//                row's colour, with a vertical line at the playhead; the zoom (Ctrl/⌘ +
//                wheel, pinch, or the buttons) and the stretch shown are common to all rows.
//
// Rows (settings, colour, targets) and the import options are project content,
// saved in inputs.json (getProject()/applyProject() — see project/inputs-store.js);
// like the camera rows none of it is WAXML document content.

const WAVE_HEIGHT = 46;
const MIN_SPAN = 0.002;
const SEND_EPSILON = 1e-4;

// A colour for the n-th row: the palette first, then hues spread by the golden angle.
function colorForIndex(n) {
	if (n < COLOR_PALETTE.length - 1) return COLOR_PALETTE[n];
	const h = ((n * 137.508) % 360) / 360;
	const s = 0.7;
	const l = 0.62;
	const f = (k) => {
		const a = s * Math.min(l, 1 - l);
		const t = (k + h * 12) % 12;
		return l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1));
	};
	const hex = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
	return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

function slug(name) {
	return (
		String(name)
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 24) || "series"
	);
}

function formatTime(seconds) {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

const CSV_NAME_RE = /\.(csv|tsv|txt)$/i;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.85rem/1.4 system-ui, sans-serif;
			padding: 0.75rem;
		}
		button, select, input {
			font-family: inherit;
		}
		.btn {
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			background: #1a1c1f;
			color: var(--waw-fg, #e8e8e8);
			cursor: pointer;
			font-size: 0.75rem;
			padding: 0.28rem 0.6rem;
			line-height: 1.1;
		}
		.btn:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.btn.active {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.12);
		}
		.btn:disabled {
			opacity: 0.45;
			cursor: default;
		}
		.import-bar {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem;
		}
		.import-bar select {
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			color: inherit;
			font-size: 0.72rem;
			padding: 0.27rem 0.3rem;
			max-width: 10rem;
		}
		.empty {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.75rem;
			margin: 0.5rem 0 0;
		}
		:host(.drag-over) {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -4px;
		}
		.transport {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem 0.5rem;
			margin-top: 0.7rem;
		}
		.transport[hidden],
		.scrub[hidden],
		.import-bar[hidden],
		.empty[hidden] {
			display: none;
		}
		.play-btn {
			min-width: 2.2rem;
			font-size: 0.9rem;
		}
		.time {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.74rem;
			min-width: 7.5rem;
		}
		.length {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.length input {
			width: 3.6rem;
			background: #111;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			color: var(--waw-fg, #e8e8e8);
			font-size: 0.74rem;
			padding: 0.2rem 0.3rem;
		}
		.zoom {
			margin-left: auto;
			display: inline-flex;
			align-items: center;
			gap: 0.2rem;
		}
		.scrub {
			width: 100%;
			margin: 0.5rem 0 0;
			accent-color: var(--waw-accent, #4fa3ff);
		}
		.datasets {
			display: flex;
			flex-direction: column;
			gap: 0.7rem;
			margin-top: 0.7rem;
		}
		.ds-head {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			margin-bottom: 0.3rem;
		}
		.ds-name {
			color: var(--waw-fg, #e8e8e8);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.ds-info {
			flex: 1 1 auto;
		}
		.ds-error {
			color: var(--waw-danger, #e5484d);
			font-size: 0.72rem;
		}
		.ds-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.9rem;
			line-height: 1;
			padding: 0 0.2rem;
		}
		.ds-btn:hover {
			color: var(--waw-accent, #4fa3ff);
		}
		.ds-btn.remove:hover {
			color: var(--waw-danger, #e5484d);
		}
		.rows {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}
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
			background: linear-gradient(#0f1113, #0f1113);
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
	</style>
	<div class="import-bar">
		<button class="btn import-btn" type="button" title="Read a CSV file from your computer">Import CSV…</button>
		<select class="project-files" title="Use a CSV file that is already in the project" hidden></select>
		<input class="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden />
	</div>
	<p class="empty">Import a CSV file (or drop one here) to play its series as inputs.</p>
	<div class="transport" hidden>
		<button class="btn play-btn" type="button" title="Play / pause">▶</button>
		<button class="btn stop-btn" type="button" title="Stop and go to the start">■</button>
		<span class="time">0:00.0 / 0:10.0</span>
		<label class="length" title="How long the whole file takes to play">Length <input class="length-input" type="number" min="0.1" step="0.5" value="10" /> s</label>
		<button class="btn loop-btn active" type="button" title="Loop">Loop</button>
		<span class="zoom">
			<button class="btn zoom-out" type="button" title="Zoom out">−</button>
			<button class="btn zoom-in" type="button" title="Zoom in (Ctrl/⌘ + wheel in a waveform also zooms)">+</button>
			<button class="btn zoom-fit" type="button" title="Show everything">Fit</button>
		</span>
	</div>
	<input class="scrub" type="range" min="0" max="10000" value="0" hidden title="Position" />
	<div class="datasets"></div>
`;

export class WaDataInput extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		this._importBtn = $(".import-btn");
		this._fileInput = $(".file-input");
		this._projectSelect = $(".project-files");
		this._emptyEl = $(".empty");
		this._transportEl = $(".transport");
		this._playBtn = $(".play-btn");
		this._stopBtn = $(".stop-btn");
		this._timeEl = $(".time");
		this._lengthInput = $(".length-input");
		this._loopBtn = $(".loop-btn");
		this._scrub = $(".scrub");
		this._datasetsEl = $(".datasets");

		this._datasets = []; // { id, file, import, data, rows, error, savedRows, el }
		this._datasetCounter = 0;
		this._rowCounter = 0;
		this._colorIndex = 0;
		this._view = { start: 0, span: 1 };
		this._resizeObserver = new ResizeObserver(() => this._drawAll());

		this._onTick = () => this._onTransportTick();
		this._onTransportState = () => this._syncTransport();
		this._onProjectReset = () => this._clear();
		this._onVarLink = (e) => this._followVarLink(e.detail);
		this._onVfsChange = () => this._refreshProjectFiles();
		this._onPathChange = (e) => this._followPaths(e.detail.changes);
	}

	connectedCallback() {
		xmlStore.addEventListener("project-reset", this._onProjectReset);
		xmlStore.addEventListener("var-link-changed", this._onVarLink);
		vfs.addEventListener("change", this._onVfsChange);
		vfs.addEventListener("path-change", this._onPathChange);
		inputTransport.addEventListener("tick", this._onTick);
		inputTransport.addEventListener("state", this._onTransportState);
		inputSources.register("data", this);

		this._importBtn.addEventListener("click", () => this._fileInput.click());
		this._fileInput.addEventListener("change", async () => {
			const file = this._fileInput.files?.[0];
			this._fileInput.value = "";
			if (file) await this._importBuffer(file.name, await file.arrayBuffer(), null);
		});
		this._projectSelect.addEventListener("change", async () => {
			const id = this._projectSelect.value;
			this._projectSelect.value = "";
			const node = id && vfs.getNode(id);
			if (node?.file) await this._importBuffer(node.name, await node.file.arrayBuffer(), node);
		});
		this._playBtn.addEventListener("click", () => inputTransport.toggle());
		this._stopBtn.addEventListener("click", () => inputTransport.stop());
		this._loopBtn.addEventListener("click", () => {
			inputTransport.setLoop(!inputTransport.loop);
			this._dispatchStateChange();
		});
		this._lengthInput.addEventListener("change", () => {
			inputTransport.setDuration(this._lengthInput.value);
			this._syncTransport();
			this._dispatchStateChange();
		});
		this._scrub.addEventListener("input", () => inputTransport.seekFraction(this._scrub.value / 10000));
		this.shadowRoot.querySelector(".zoom-in").addEventListener("click", () => this._zoom(2));
		this.shadowRoot.querySelector(".zoom-out").addEventListener("click", () => this._zoom(0.5));
		this.shadowRoot.querySelector(".zoom-fit").addEventListener("click", () => {
			this._view = { start: 0, span: 1 };
			this._drawAll();
		});

		// Drop a CSV file anywhere in the section.
		this.addEventListener("dragover", (e) => {
			if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
			e.preventDefault();
			this.classList.add("drag-over");
		});
		this.addEventListener("dragleave", () => this.classList.remove("drag-over"));
		this.addEventListener("drop", async (e) => {
			this.classList.remove("drag-over");
			const file = [...(e.dataTransfer?.files || [])].find((f) => CSV_NAME_RE.test(f.name));
			if (!file) return;
			e.preventDefault();
			await this._importBuffer(file.name, await file.arrayBuffer(), null);
		});

		this._resizeObserver.observe(this._datasetsEl);
		this._refreshProjectFiles();
		this._syncTransport();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("project-reset", this._onProjectReset);
		xmlStore.removeEventListener("var-link-changed", this._onVarLink);
		vfs.removeEventListener("change", this._onVfsChange);
		vfs.removeEventListener("path-change", this._onPathChange);
		inputTransport.removeEventListener("tick", this._onTick);
		inputTransport.removeEventListener("state", this._onTransportState);
		inputSources.unregister("data", this);
		this._resizeObserver.disconnect();
	}

	// ── For the Stage and the viewer later (see input-sources.js) ────────
	get running() {
		return inputTransport.playing;
	}

	get statusText() {
		return this._datasets.find((d) => d.error)?.error || "";
	}

	start() {
		inputTransport.play();
		return Promise.resolve();
	}

	stop() {
		inputTransport.stop();
	}

	getEntrySummaries() {
		return this._allRows().map(({ entry }) => ({ id: entry.id, color: entry.color, label: entry.name, measure: "data", bypassed: entry.bypassed }));
	}

	getEntryNorm(id) {
		const found = this._allRows().find(({ entry }) => entry.id === id);
		return found && !found.entry.bypassed ? found.entry.norm : undefined;
	}

	// ── Persistence (inputs.json → "data") ───────────────────────────────
	// null when there is nothing to save.
	getProject() {
		if (!this._datasets.length) return null;
		return {
			version: 1,
			duration: inputTransport.hasTimebase ? this._savedDuration : inputTransport.duration,
			loop: inputTransport.loop,
			datasets: this._datasets.map((ds) => ({
				file: ds.file,
				import: { ...ds.import },
				rows: (ds.error ? ds.savedRows : ds.rows).map((e) => ({
					id: e.id,
					key: e.key,
					sourceIndex: e.sourceIndex,
					name: e.name,
					color: e.color,
					invert: !!e.invert,
					bypassed: !!e.bypassed,
					min: e.min ?? null,
					max: e.max ?? null,
					mappings: e.mappings.map((m) => ({ ...m }))
				}))
			}))
		};
	}

	// Reads the saved datasets back: every file is read from the project.
	async applyProject(project) {
		if (!project || !Array.isArray(project.datasets)) return;
		if (project.duration > 0) {
			this._savedDuration = project.duration;
			inputTransport.setDuration(project.duration);
		}
		if (typeof project.loop === "boolean") inputTransport.setLoop(project.loop);
		for (const saved of project.datasets) {
			const node = vfs.findByExportPath(saved.file);
			const ds = { id: ++this._datasetCounter, file: saved.file, import: { ...saved.import }, data: null, rows: [], error: "", savedRows: saved.rows || [] };
			this._datasets.push(ds);
			if (!node?.file) {
				ds.error = `File not found: ${saved.file}`;
			} else {
				try {
					this._buildData(ds, await node.file.arrayBuffer());
					this._makeRows(ds, saved.rows);
				} catch (err) {
					ds.error = `Could not read ${saved.file}: ${err.message}`;
				}
			}
		}
		this._renderAll();
	}

	_clear() {
		inputTransport.stop();
		this._datasets = [];
		this._rowCounter = 0;
		this._colorIndex = 0;
		this._view = { start: 0, span: 1 };
		this._renderAll();
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	// A <Var>'s name changed (see xml-store.js's _varLinkChange): every target
	// that pointed at it follows.
	_followVarLink({ oldName, newName }) {
		if (oldName === newName) return;
		let changed = false;
		this._allRows().forEach(({ entry }) => {
			entry.mappings.forEach((mapping) => {
				if (mapping.varName === oldName) {
					mapping.varName = newName;
					changed = true;
				}
			});
		});
		if (changed) {
			this._renderAll();
			this._dispatchStateChange();
		}
	}

	// ── Import ───────────────────────────────────────────────────────────
	_allRows() {
		return this._datasets.flatMap((ds) => ds.rows.map((entry) => ({ ds, entry })));
	}

	_refreshProjectFiles() {
		const files = vfs.allFiles().filter((n) => !isHiddenName(n.name) && CSV_NAME_RE.test(n.name));
		this._projectSelect.hidden = files.length === 0;
		this._projectSelect.innerHTML = "";
		const first = document.createElement("option");
		first.value = "";
		first.textContent = "From the project…";
		this._projectSelect.appendChild(first);
		files.forEach((n) => {
			const o = document.createElement("option");
			o.value = n.id;
			o.textContent = vfs.getExportPath(n.id);
			this._projectSelect.appendChild(o);
		});
	}

	// Reads a file's bytes through the import dialog and adds the result as a
	// dataset. `projectNode` is the file when it already is in the project.
	async _importBuffer(name, buffer, projectNode) {
		const options = await openCsvImportDialog({ name, buffer });
		if (!options) return;
		const node = projectNode || (await this._storeInProject(name, buffer));
		const ds = { id: ++this._datasetCounter, file: vfs.getExportPath(node.id), import: options, data: null, rows: [], error: "", savedRows: [] };
		try {
			this._buildData(ds, buffer);
			this._makeRows(ds, null);
		} catch (err) {
			ds.error = err.message;
		}
		this._datasets.push(ds);
		this._renderAll();
		this._dispatchStateChange();
	}

	// "Import settings…" of a dataset: the same dialog, with what it was read with.
	async _reimport(ds) {
		const node = vfs.findByExportPath(ds.file);
		if (!node?.file) return;
		const buffer = await node.file.arrayBuffer();
		const options = await openCsvImportDialog({ name: ds.file, buffer, options: ds.import });
		if (!options) return;
		const keep = ds.error ? ds.savedRows : ds.rows;
		ds.import = options;
		ds.error = "";
		try {
			this._buildData(ds, buffer);
			this._makeRows(ds, keep);
		} catch (err) {
			ds.error = err.message;
		}
		this._renderAll();
		this._dispatchStateChange();
	}

	// A file that is not in the project yet goes in (the same bytes under the
	// same name are reused; another file with that name gets a number).
	async _storeInProject(name, buffer) {
		const existing = vfs.listFolder(ROOT_ID).filter((n) => n.type === "file");
		const same = async (node) => {
			const other = new Uint8Array(await node.file.arrayBuffer());
			const mine = new Uint8Array(buffer);
			return other.length === mine.length && other.every((b, i) => b === mine[i]);
		};
		for (const node of existing.filter((n) => n.name === name)) if (await same(node)) return node;
		let finalName = name;
		const dot = name.lastIndexOf(".");
		const base = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		for (let n = 2; existing.some((x) => x.name === finalName); n++) finalName = `${base}-${n}${ext}`;
		return vfs.uploadFile(ROOT_ID, new File([buffer], finalName, { type: "text/csv" }));
	}

	_buildData(ds, buffer) {
		const o = ds.import;
		const { text } = decodeBytes(buffer, o.encoding);
		const table = parseCsv(text, o);
		ds.data = buildDataset(table, { orientation: o.orientation, header: !!o.header, timeColumn: !!o.timeColumn }, o.decimal);
		if (!ds.data.series.length) throw new Error("No numbers found in the file with these settings");
		ds.interpolate = o.interpolate === "step" ? "step" : "linear";
	}

	// A row per series. `saved` (rows of an earlier reading) hands its settings to the
	// series with the same source index, so changing the import settings keeps the targets.
	_makeRows(ds, saved) {
		const usedKeys = new Set(this._allRows().filter((r) => r.ds !== ds).map((r) => r.entry.key));
		ds.rows = ds.data.series.map((series) => {
			const old = saved?.find((r) => r.sourceIndex === series.sourceIndex);
			let key = old?.key || slug(series.name);
			if (!old?.key) for (let n = 2; usedKeys.has(key); n++) key = `${slug(series.name)}_${n}`;
			usedKeys.add(key);
			const entry = {
				id: old?.id || ++this._rowCounter,
				key,
				sourceIndex: series.sourceIndex,
				name: old?.name || series.name,
				color: old?.color || colorForIndex(this._colorIndex++),
				invert: !!old?.invert,
				bypassed: !!old?.bypassed,
				min: old?.min ?? null,
				max: old?.max ?? null,
				mappings: (old?.mappings || []).map((m) => ({ ...m })),
				series,
				norm: undefined
			};
			this._rowCounter = Math.max(this._rowCounter, entry.id);
			return entry;
		});
		ds.savedRows = [];
	}

	_followPaths(changes) {
		let changed = false;
		this._datasets.forEach((ds) => {
			const hit = changes.find((c) => c.oldPath === ds.file);
			if (hit) {
				ds.file = hit.newPath;
				changed = true;
			}
		});
		if (changed) {
			this._renderAll();
			this._dispatchStateChange();
		}
	}

	// ── Rendering ────────────────────────────────────────────────────────
	_renderAll() {
		this._resizeObserver.disconnect();
		this._resizeObserver.observe(this._datasetsEl);
		this._datasetsEl.innerHTML = "";
		this._datasets.forEach((ds) => this._datasetsEl.appendChild(this._buildDataset(ds)));
		this._emptyEl.hidden = this._datasets.length > 0;
		this._transportEl.hidden = this._datasets.length === 0;
		this._scrub.hidden = this._datasets.length === 0;
		this._syncTransport();
		requestAnimationFrame(() => {
			this._drawAll();
			this._updatePlayheads();
			// Shown, not sent: opening a project must not move anything by itself.
			this._allRows().forEach(({ entry }) => this._sendEntry(entry, false, true));
		});
	}

	_buildDataset(ds) {
		const wrap = document.createElement("div");
		wrap.className = "dataset";
		const head = document.createElement("div");
		head.className = "ds-head";
		const name = document.createElement("span");
		name.className = "ds-name";
		name.textContent = ds.file;
		const info = document.createElement("span");
		info.className = "ds-info";
		info.textContent = ds.data ? `${ds.rows.length} of ${ds.data.series.length} series · ${ds.data.length.toLocaleString("en-US")} values` : "";
		const gear = document.createElement("button");
		gear.type = "button";
		gear.className = "ds-btn";
		gear.textContent = "⚙";
		gear.title = "Import settings…";
		gear.addEventListener("click", () => this._reimport(ds));
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "ds-btn remove";
		remove.textContent = "×";
		remove.title = "Remove this file's rows (the file stays in the project)";
		remove.addEventListener("click", () => {
			this._datasets = this._datasets.filter((d) => d !== ds);
			this._renderAll();
			this._dispatchStateChange();
		});
		head.append(name, info, gear, remove);
		wrap.appendChild(head);
		if (ds.error) {
			const err = document.createElement("div");
			err.className = "ds-error";
			err.textContent = ds.error;
			wrap.appendChild(err);
		}
		const rows = document.createElement("div");
		rows.className = "rows";
		ds.rows.forEach((entry) => rows.appendChild(this._buildRow(ds, entry)));
		wrap.appendChild(rows);
		return wrap;
	}

	_syntheticName(entry, index) {
		const base = `data_${entry.key}`;
		return index > 0 ? `${base}_${index + 1}` : base;
	}

	_buildRow(ds, entry) {
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
			this._drawRow(ds, entry);
			this._dispatchStateChange();
		});
		const name = document.createElement("div");
		name.className = "row-name";
		name.textContent = entry.name;
		name.title = entry.name;
		const mute = document.createElement("button");
		mute.type = "button";
		mute.className = "mute-btn" + (entry.bypassed ? " active" : "");
		mute.textContent = "mute";
		mute.title = "Mute — this row stops setting its targets, without losing anything";
		mute.addEventListener("click", () => {
			entry.bypassed = !entry.bypassed;
			mute.classList.toggle("active", entry.bypassed);
			this._drawRow(ds, entry);
			if (!entry.bypassed) this._sendEntry(entry, true);
			this._dispatchStateChange();
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "row-del";
		del.textContent = "×";
		del.title = "Remove this row";
		del.addEventListener("click", () => {
			ds.rows = ds.rows.filter((r) => r !== entry);
			this._renderAll();
			this._dispatchStateChange();
		});
		top.append(picker, name, mute, del);

		const wave = document.createElement("div");
		wave.className = "wave";
		const canvas = document.createElement("canvas");
		const mid = document.createElement("div");
		mid.className = "mid";
		const playhead = document.createElement("div");
		playhead.className = "playhead";
		wave.append(canvas, mid, playhead);
		this._wireWave(wave);
		entry.canvas = canvas;
		entry.playheadEl = playhead;
		entry.waveEl = wave;

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
			this._drawRow(ds, entry);
			this._sendEntry(entry, true);
			this._dispatchStateChange();
		});
		const range = document.createElement("span");
		range.className = "range";
		range.title = "The values that become 0 and 1 (empty: the lowest and highest in the data)";
		const lo = document.createElement("input");
		lo.type = "number";
		lo.step = "any";
		lo.placeholder = String(+entry.series.min.toPrecision(4));
		lo.value = entry.min ?? "";
		const hi = document.createElement("input");
		hi.type = "number";
		hi.step = "any";
		hi.placeholder = String(+entry.series.max.toPrecision(4));
		hi.value = entry.max ?? "";
		const setRange = () => {
			entry.min = lo.value === "" ? null : Number(lo.value);
			entry.max = hi.value === "" ? null : Number(hi.value);
			this._drawRow(ds, entry);
			this._sendEntry(entry, true);
			this._dispatchStateChange();
		};
		lo.addEventListener("change", setRange);
		hi.addEventListener("change", setRange);
		range.append("0 =", lo, "1 =", hi);

		const valueRow = document.createElement("div");
		valueRow.className = "value-row";
		const bar = document.createElement("div");
		bar.className = "value-bar";
		const fill = document.createElement("div");
		fill.className = "value-fill";
		bar.appendChild(fill);
		const num = document.createElement("span");
		num.className = "value-num";
		num.textContent = "—";
		valueRow.append(bar, num);
		entry.fillEl = fill;
		entry.numEl = num;
		controls.append(invert, range, valueRow);

		const targets = document.createElement("div");
		targets.className = "targets";
		entry.targetsEl = targets;
		this._refreshTargets(entry);

		row.append(top, wave, controls, targets);
		entry.row = row;
		this._resizeObserver.observe(wave);
		return row;
	}

	_refreshTargets(entry) {
		renderTargetPills(entry.targetsEl, entry, {
			syntheticName: (index) => this._syntheticName(entry, index),
			onChange: () => {
				this._sendEntry(entry, true);
				this._dispatchStateChange();
			},
			armFn: (anchorEl, onPick) => armMapping(anchorEl, onPick)
		});
	}

	// ── Waveforms ────────────────────────────────────────────────────────
	_rangeOf(entry) {
		return { lo: entry.min ?? entry.series.min, hi: entry.max ?? entry.series.max };
	}

	_drawAll() {
		this._datasets.forEach((ds) => ds.rows.forEach((entry) => this._drawRow(ds, entry)));
	}

	_drawRow(ds, entry) {
		const canvas = entry.canvas;
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
		if (!ds.data) return;
		const { lo, hi } = this._rangeOf(entry);
		const norm = (v) => normalize(v, lo, hi, entry.invert) ?? 0;
		const yOf = (v) => 2 + (1 - v) * (h - 4);
		const wf = waveformColumns(ds.data, entry.series, this._view, w, norm);
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

	// Dragging in a waveform moves the playhead; Ctrl/⌘ + wheel (also a pinch) zooms,
	// a sideways wheel moves along the zoomed stretch.
	_wireWave(wave) {
		const fractionAt = (e) => {
			const rect = wave.getBoundingClientRect();
			const a = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
			return this._view.start + a * this._view.span;
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
					this._zoom(Math.exp(-e.deltaY * 0.01), a);
				} else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && this._view.span < 1) {
					e.preventDefault();
					this._panBy((e.deltaX / Math.max(1, rect.width)) * this._view.span);
				}
			},
			{ passive: false }
		);
	}

	// Zooms by `factor` around the point `anchor` (0–1 across the view).
	_zoom(factor, anchor = 0.5) {
		const { start, span } = this._view;
		const next = Math.min(1, Math.max(MIN_SPAN, span / factor));
		const at = start + anchor * span;
		this._view = { start: Math.min(1 - next, Math.max(0, at - anchor * next)), span: next };
		this._drawAll();
		this._updatePlayheads();
	}

	_panBy(delta) {
		const { start, span } = this._view;
		this._view = { start: Math.min(1 - span, Math.max(0, start + delta)), span };
		this._drawAll();
		this._updatePlayheads();
	}

	// ── Transport ────────────────────────────────────────────────────────
	_syncTransport() {
		const t = inputTransport;
		this._playBtn.textContent = t.playing ? "❚❚" : "▶";
		this._loopBtn.classList.toggle("active", t.loop);
		this._lengthInput.disabled = t.hasTimebase;
		if (this.shadowRoot.activeElement !== this._lengthInput) this._lengthInput.value = String(+t.duration.toFixed(3));
		this._updateTime();
	}

	_updateTime() {
		const t = inputTransport;
		this._timeEl.textContent = `${formatTime(t.position)} / ${formatTime(t.duration)}`;
		if (this.shadowRoot.activeElement !== this._scrub) this._scrub.value = String(Math.round(t.fraction * 10000));
	}

	// Every frame (and after a seek): the playheads, and what every row tells its targets.
	_onTransportTick() {
		if (!this._datasets.length) return;
		this._updatePlayheads();
		this._allRows().forEach(({ entry }) => this._sendEntry(entry, false));
	}

	// The playhead of every waveform (and the time). While playing in a zoomed
	// view, the view follows the playhead.
	_updatePlayheads() {
		const frac = inputTransport.fraction;
		const v = this._view;
		if (v.span < 1 && inputTransport.playing && (frac < v.start || frac > v.start + v.span)) {
			this._view = { start: Math.min(1 - v.span, Math.max(0, frac - 0.05 * v.span)), span: v.span };
			this._drawAll();
		}
		this._updateTime();
		const left = ((frac - this._view.start) / this._view.span) * 100;
		this._allRows().forEach(({ entry }) => {
			if (!entry.playheadEl) return;
			entry.playheadEl.style.display = left >= 0 && left <= 100 ? "block" : "none";
			entry.playheadEl.style.left = `${left}%`;
		});
	}

	// The value of a row at the playhead: shown, and (unless `quiet`) sent to every
	// target when it changed (or `force`).
	_sendEntry(entry, force = false, quiet = false) {
		const ds = this._datasets.find((d) => d.rows.includes(entry));
		if (!ds?.data) return;
		const { lo, hi } = this._rangeOf(entry);
		const raw = sampleSeries(ds.data, entry.series, inputTransport.fraction, ds.interpolate);
		const norm = normalize(raw, lo, hi, entry.invert);
		const changed = norm === undefined || entry.norm === undefined ? norm !== entry.norm : Math.abs(norm - entry.norm) >= SEND_EPSILON;
		entry.norm = norm;
		if (entry.numEl) {
			entry.numEl.textContent = norm === undefined || entry.bypassed ? "—" : norm.toFixed(2);
			entry.fillEl.style.width = norm === undefined || entry.bypassed ? "0%" : `${norm * 100}%`;
		}
		if (quiet || norm === undefined || entry.bypassed || !(changed || force)) return;
		entry.mappings.forEach((mapping, index) => {
			if (!mapping?.varName) return;
			playerStore.setVariable(mapping.direct ? mapping.inputVar : this._syntheticName(entry, index), norm);
		});
	}
}

customElements.define("wa-data-input", WaDataInput);
