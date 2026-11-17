import { xmlStore } from "../xml-editor/xml-store.js";
import { inputSources } from "../state/input-sources.js";
import { vfs, ROOT_ID, isHiddenName } from "../vfs/VFS.js";
import { inputTransport } from "../input/input-transport.js";
import { inputView } from "../input/input-view.js";
import { decodeBytes, parseCsv } from "../input/csv-parse.js";
import { readCell, writeCells } from "../input/csv-edit.js";
import { buildDataset } from "../input/data-series.js";
import { SERIES_ROW_CSS, SeriesRow } from "../input/series-row.js";
import { openCsvImportDialog } from "./wa-csv-import-dialog.js";
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
//   Play         the panel's own bar (wa-input-transport.js): PLAY / STOP, the length,
//                loop, scrub, zoom. The values of a file are spread evenly over that
//                length (or placed by the file's own time axis).
//   Rows         input/series-row.js — waveform, colour, mute, invert, range, targets.
//
// Rows (settings, colour, targets) and the import options are project content,
// saved in inputs.json under "data" (getProject()/applyProject() — see
// project/inputs-store.js); like the camera rows none of it is WAXML document
// content.

// A colour for the n-th row: the palette first, then hues spread by the golden angle.
export function colorForIndex(n) {
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

export function slug(name) {
	return (
		String(name)
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 24) || "series"
	);
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
		.empty[hidden],
		.project-files[hidden] {
			display: none;
		}
		:host(.drag-over) {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -4px;
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
		${SERIES_ROW_CSS}
	</style>
	<div class="import-bar">
		<button class="btn import-btn" type="button" title="Read a CSV file from your computer">Import CSV…</button>
		<select class="project-files" title="Use a CSV file that is already in the project" hidden></select>
		<input class="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden />
	</div>
	<p class="empty">Import a CSV file (or drop one here) to play its series as inputs.</p>
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
		this._datasetsEl = $(".datasets");

		this._datasets = []; // { id, file, import, data, interpolate, rows: [{ entry, row }], error, savedRows }
		this._datasetCounter = 0;
		this._rowCounter = 0;
		this._colorIndex = 0;
		this._resizeObserver = new ResizeObserver(() => this._drawAll());

		this._onTick = () => this._onTransportTick();
		this._onViewChange = () => {
			this._drawAll();
			this._updatePlayheads();
		};
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
		inputView.addEventListener("change", this._onViewChange);
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
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("project-reset", this._onProjectReset);
		xmlStore.removeEventListener("var-link-changed", this._onVarLink);
		vfs.removeEventListener("change", this._onVfsChange);
		vfs.removeEventListener("path-change", this._onPathChange);
		inputTransport.removeEventListener("tick", this._onTick);
		inputView.removeEventListener("change", this._onViewChange);
		inputSources.unregister("data", this);
		inputTransport.release("data");
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

	_allRows() {
		return this._datasets.flatMap((ds) => ds.rows.map((r) => ({ ds, ...r })));
	}

	getEntrySummaries() {
		return this._allRows().map(({ entry }) => ({ id: entry.id, color: entry.color, label: entry.name, measure: "data", bypassed: entry.bypassed }));
	}

	getEntryNorm(id) {
		const found = this._allRows().find(({ entry }) => entry.id === id);
		return found && !found.entry.bypassed ? found.row.norm : undefined;
	}

	// ── Persistence (inputs.json → "data") ───────────────────────────────
	// null when there is nothing to save.
	getProject() {
		if (!this._datasets.length) return null;
		const plain = (e) => ({
			id: e.id,
			key: e.key,
			sourceIndex: e.sourceIndex,
			name: e.name,
			color: e.color,
			invert: !!e.invert,
			bypassed: !!e.bypassed,
			percentile: e.percentile || 0,
			spikes: e.spikes || 0,
			min: e.min ?? null,
			max: e.max ?? null,
			mappings: e.mappings.map((m) => ({ ...m }))
		});
		return {
			version: 1,
			datasets: this._datasets.map((ds) => ({
				file: ds.file,
				import: { ...ds.import },
				rows: ds.error ? ds.savedRows : ds.rows.map((r) => plain(r.entry))
			}))
		};
	}

	// Reads the saved datasets back: every file is read from the project.
	async applyProject(project) {
		if (!project || !Array.isArray(project.datasets)) return;
		// The length and loop used to be saved here (now: "transport", see wa-input-transport.js).
		if (project.duration > 0) inputTransport.setDuration(project.duration);
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
		inputView.fit();
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
		const keep = ds.error ? ds.savedRows : ds.rows.map((r) => r.entry);
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
		ds.table = table;
		ds.layout = { orientation: o.orientation, header: !!o.header, timeColumn: !!o.timeColumn };
		ds.data = buildDataset(table, ds.layout, o.decimal);
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
				percentile: old?.percentile || 0,
				spikes: old?.spikes || 0,
				min: old?.min ?? null,
				max: old?.max ?? null,
				mappings: (old?.mappings || []).map((m) => ({ ...m }))
			};
			this._rowCounter = Math.max(this._rowCounter, entry.id);
			return { entry, series };
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
		if (this._datasets.length) inputTransport.use("data");
		else inputTransport.release("data");
		requestAnimationFrame(() => {
			this._drawAll();
			this._updatePlayheads();
			// Shown, not sent: opening a project must not move anything by itself.
			this._allRows().forEach(({ row }) => row.update({ quiet: true }));
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
		ds.rows.forEach((r) => {
			r.row = new SeriesRow(r.entry, () => ({ data: ds.data, series: r.series, interpolate: ds.interpolate }), {
				onChange: () => this._dispatchStateChange(),
				onRemove: (entry) => {
					ds.rows = ds.rows.filter((x) => x.entry !== entry);
					this._renderAll();
					this._dispatchStateChange();
				},
				syntheticName: (entry, index) => this._syntheticName(entry, index),
				edit: {
					readCell: (entry, i) => this._readCell(ds, r.series, i),
					writeCells: (entry, cells) => this._writeCells(ds, r.series, cells)
				}
			});
			this._resizeObserver.observe(r.row.waveEl);
			rows.appendChild(r.row.el);
		});
		wrap.appendChild(rows);
		return wrap;
	}

	// ── Drawing over the values (see series-row.js, input/csv-edit.js) ───
	_readCell(ds, series, i) {
		return readCell(ds, series, i);
	}

	_writeCells(ds, series, cells) {
		writeCells(ds, series, cells, ds.data.length);
		this._dispatchStateChange();
	}

	_syntheticName(entry, index) {
		const base = `data_${entry.key}`;
		return index > 0 ? `${base}_${index + 1}` : base;
	}

	_drawAll() {
		this._allRows().forEach(({ row }) => row.draw());
	}

	_updatePlayheads() {
		inputView.follow(inputTransport.fraction);
		this._allRows().forEach(({ row }) => row.updatePlayhead());
	}

	// Every frame (and after a seek): the playheads, and what every row tells its targets.
	_onTransportTick() {
		if (!this._datasets.length) return;
		this._updatePlayheads();
		this._allRows().forEach(({ row }) => row.update());
	}
}

customElements.define("wa-data-input", WaDataInput);
