import { xmlStore } from "../xml-editor/xml-store.js";
import { inputSources } from "../state/input-sources.js";
import { inputMapMode } from "../state/input-map-mode.js";
import { vfs, ROOT_ID, isHiddenName } from "../vfs/VFS.js";
import { inputTransport } from "../input/input-transport.js";
import { inputView } from "../input/input-view.js";
import { armMapping, mappingFromPick } from "../input/target-pills.js";
import { SERIES_ROW_CSS, SeriesRow } from "../input/series-row.js";
import { MODEL_LABELS as MODEL_NAMES } from "../input/mediapipe.js";
import { ANALYSIS_RATES, analyzeVideo, ensureDuration } from "../input/video-analysis.js";
import { frameAt, landmarksToCsv, parseLandmarkCsv, pointAt } from "../input/landmark-table.js";
import { measureSeries } from "../input/video-series.js";
import { angularOrder } from "../input/measures.js";
import { colorForIndex, slug } from "./wa-data-input.js";

// The INPUT panel's "Video" section: a video file as an input source next to the live
// camera. The same trackers (hand / body / face) are run over the whole file once, the
// points of every picture are kept as a CSV file in the project's Data folder, and a row
// — made like a camera row: "+", hand | body | face, click one or more points — reads
// its values from that table, a number for every picture, so it works like a row of CSV
// data: waveform, mute, invert, range, targets.
//
//   Analysis   per model, over the whole video, at the first use (input/video-analysis.js).
//              All of a model's points are kept, so every later row is free and instant.
//   Storage    Data/<video>.<model>.csv — `time`, then x/y(/z) per point (landmark-table.js).
//   Clock      the video is the play bar's clock (inputTransport.setTimebase): the length is
//              the video's, and play / stop / scrub / zoom move the picture and the data
//              together. The video's own sound plays (the speaker button mutes it).
//   Gaps       a point missing in some pictures is bridged by a line when it is gone for at
//              most half a second, else the last value is held (video-series.js).
//
// What is saved is project content, in inputs.json under "video" (getProject()/applyProject()
// — see project/inputs-store.js).

const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;
const DATA_FOLDER = "Data";
const NEAREST_PX = 24;
const LARGE_VIDEO_BYTES = 100 * 1048576;
const MODELS = ["hands", "pose", "face"];

function baseName(name) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

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
		.import-bar select,
		.rate-select {
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			color: inherit;
			font-size: 0.72rem;
			padding: 0.27rem 0.3rem;
			max-width: 11rem;
		}
		.empty {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.75rem;
			margin: 0.5rem 0 0;
		}
		[hidden] {
			display: none !important;
		}
		:host(.drag-over) {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -4px;
		}
		.head {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			margin: 0.7rem 0 0.4rem;
		}
		.head .name {
			color: var(--waw-fg, #e8e8e8);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.head .info {
			flex: 1 1 auto;
		}
		.head-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.95rem;
			line-height: 1;
			padding: 0 0.2rem;
		}
		.head-btn:hover {
			color: var(--waw-accent, #4fa3ff);
		}
		.head-btn.active {
			color: #fb923c;
		}
		.head-btn.remove:hover {
			color: var(--waw-danger, #e5484d);
		}
		.video-wrapper {
			position: relative;
			background: #000;
			border-radius: 8px;
			overflow: hidden;
			line-height: 0;
			margin-bottom: 0.6rem;
		}
		video {
			width: 100%;
			display: block;
		}
		canvas.overlay {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		canvas.overlay.picking {
			cursor: crosshair;
		}
		.vid-ui {
			position: absolute;
			inset: 0;
			pointer-events: none;
			line-height: 1.2;
		}
		.vid-ui > * {
			pointer-events: auto;
		}
		.top-ui {
			position: absolute;
			top: 0.4rem;
			left: 0.4rem;
			right: 0.4rem;
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			gap: 0.35rem;
			pointer-events: none;
		}
		.top-ui > * {
			pointer-events: auto;
		}
		.add-wrap {
			display: flex;
			align-items: center;
			gap: 0.35rem;
		}
		.add-btn,
		.model-choices button,
		.map-btn,
		.axis-select {
			background: rgba(0, 0, 0, 0.72);
			border: 1.5px solid rgba(255, 255, 255, 0.9);
			border-radius: 6px;
			color: #fff;
			font: 600 0.8rem system-ui, sans-serif;
			text-shadow: 0 0 3px #000;
			box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
			cursor: pointer;
		}
		.add-btn {
			width: 28px;
		}
		.model-choices {
			display: flex;
			gap: 0.3rem;
		}
		.subtitle {
			background: rgba(0, 0, 0, 0.7);
			color: #fff;
			font-size: 0.75rem;
			padding: 0.2rem 0.45rem;
			border-radius: 5px;
		}
		.map-wrap {
			position: absolute;
			left: 0.4rem;
			bottom: 0.4rem;
			display: flex;
			gap: 0.35rem;
			align-items: center;
		}
		.map-btn.armed {
			border-style: solid;
			border-color: #facc15;
			color: #facc15;
		}
		.analysis {
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
			margin-bottom: 0.6rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.analysis .line {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem;
		}
		.analysis .done {
			color: var(--waw-teal, #45b58c);
		}
		.analysis .error {
			color: var(--waw-danger, #e5484d);
		}
		.progress {
			flex: 1 1 6rem;
			height: 6px;
			border-radius: 3px;
			background: #1a1c1f;
			overflow: hidden;
		}
		.progress > div {
			height: 100%;
			width: 0;
			background: var(--waw-accent, #4fa3ff);
		}
		.rows {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}
		${SERIES_ROW_CSS}
	</style>
	<div class="import-bar">
		<button class="btn load-btn" type="button" title="Load a video file from your computer">Load video…</button>
		<select class="project-files" title="Use a video that is already in the project" hidden></select>
		<input class="file-input" type="file" accept="video/*,.mp4,.m4v,.mov,.webm" hidden />
	</div>
	<p class="empty">Load a video (or drop one here) to read values from the movement in it.</p>
	<div class="item" hidden>
		<div class="head">
			<span class="name"></span>
			<span class="info"></span>
			<button class="head-btn sound" type="button" title="Sound on / off">🔊</button>
			<button class="head-btn remove" type="button" title="Remove the video from this input (the file stays in the project)">×</button>
		</div>
		<div class="video-wrapper">
			<video playsinline preload="auto"></video>
			<canvas class="overlay"></canvas>
			<div class="vid-ui">
				<div class="top-ui">
					<div class="add-wrap">
						<button class="add-btn" type="button" title="Add a variable">+</button>
						<span class="model-choices" hidden>
							<button type="button" data-model="hands">hand</button>
							<button type="button" data-model="pose">body</button>
							<button type="button" data-model="face">face</button>
						</span>
					</div>
					<div class="subtitle" hidden></div>
				</div>
				<div class="map-wrap" hidden>
					<select class="axis-select" title="Which movement to follow" hidden>
						<option value="horizontal">Horizontal</option>
						<option value="vertical">Vertical</option>
						<option value="both" selected>Both</option>
					</select>
					<button class="map-btn" type="button">map...</button>
				</div>
			</div>
		</div>
		<div class="analysis"></div>
		<div class="rows"></div>
	</div>
`;

export class WaVideoInput extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		this._loadBtn = $(".load-btn");
		this._fileInput = $(".file-input");
		this._projectSelect = $(".project-files");
		this._emptyEl = $(".empty");
		this._itemEl = $(".item");
		this._nameEl = $(".name");
		this._infoEl = $(".info");
		this._soundBtn = $(".sound");
		this._videoEl = $("video");
		this._canvas = $("canvas.overlay");
		this._ctx = this._canvas.getContext("2d");
		this._addBtn = $(".add-btn");
		this._modelChoices = $(".model-choices");
		this._subtitle = $(".subtitle");
		this._mapWrap = $(".map-wrap");
		this._axisSelect = $(".axis-select");
		this._mapBtn = $(".map-btn");
		this._analysisEl = $(".analysis");
		this._rowsEl = $(".rows");

		this._item = null; // { file, node, muted, tables: { model: { table, file, fps } }, rows: [{ entry, row, series }] }
		this._rowCounter = 0;
		this._colorIndex = 0;
		this._adding = null; // { model } while picking points for a new row
		this._selection = []; // labels picked so far, in order
		this._choosing = false;
		this._running = null; // { model, abort: AbortController, progress } while a pass runs
		this._rate = 30;
		this._notes = {}; // model -> a message under the analysis line (an error)
		this._resizeObserver = new ResizeObserver(() => this._drawRows());

		this._onTick = () => this._onTransportTick();
		this._onState = () => this._syncLoop();
		this._onViewChange = () => {
			this._drawRows();
			this._updatePlayheads();
		};
		this._onProjectReset = () => this._clear();
		this._onVarLink = (e) => this._followVarLink(e.detail);
		this._onVfsChange = () => this._refreshProjectFiles();
		this._onKeyDown = (e) => {
			if (e.key !== "Escape" || inputMapMode.armed) return;
			if (this._adding || this._choosing) this._cancelAdding();
		};
		this._timebase = {
			get duration() {
				return this._v.duration || 0;
			},
			get currentTime() {
				return this._v.currentTime;
			},
			set currentTime(t) {
				this._v.currentTime = t;
			},
			get playing() {
				return !this._v.paused && !this._v.ended;
			},
			play: () => this._videoEl.play(),
			pause: () => this._videoEl.pause(),
			_v: this._videoEl
		};
	}

	connectedCallback() {
		xmlStore.addEventListener("project-reset", this._onProjectReset);
		xmlStore.addEventListener("var-link-changed", this._onVarLink);
		vfs.addEventListener("change", this._onVfsChange);
		inputTransport.addEventListener("tick", this._onTick);
		inputTransport.addEventListener("state", this._onState);
		inputView.addEventListener("change", this._onViewChange);
		document.addEventListener("keydown", this._onKeyDown, true);
		inputSources.register("video", this);

		this._loadBtn.addEventListener("click", () => this._fileInput.click());
		this._fileInput.addEventListener("change", async () => {
			const file = this._fileInput.files?.[0];
			this._fileInput.value = "";
			if (file) await this._loadFile(file);
		});
		this._projectSelect.addEventListener("change", async () => {
			const id = this._projectSelect.value;
			this._projectSelect.value = "";
			const node = id && vfs.getNode(id);
			if (node?.file) await this._openNode(node);
		});
		this.addEventListener("dragover", (e) => {
			if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
			e.preventDefault();
			this.classList.add("drag-over");
		});
		this.addEventListener("dragleave", () => this.classList.remove("drag-over"));
		this.addEventListener("drop", async (e) => {
			this.classList.remove("drag-over");
			const file = [...(e.dataTransfer?.files || [])].find((f) => VIDEO_NAME_RE.test(f.name) || f.type.startsWith("video/"));
			if (!file) return;
			e.preventDefault();
			await this._loadFile(file);
		});
		this.shadowRoot.querySelector(".remove").addEventListener("click", () => this._removeItem(true));
		this._soundBtn.addEventListener("click", () => {
			if (!this._item) return;
			this._item.muted = !this._item.muted;
			this._applySound();
			this._dispatchStateChange();
		});
		this._addBtn.addEventListener("click", () => this._onAddButton());
		this._modelChoices.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this._beginAdding(b.dataset.model)));
		this._canvas.addEventListener("click", (e) => this._onCanvasClick(e));
		this._mapBtn.addEventListener("click", (e) => {
			e.stopPropagation(); // the click that arms must not also be the "unclaimed click" that disarms
			this._beginMap();
		});
		this._videoEl.addEventListener("loadedmetadata", () => this._onVideoReady());
		this._videoEl.addEventListener("seeked", () => this._drawOverlay());
		this._refreshProjectFiles();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("project-reset", this._onProjectReset);
		xmlStore.removeEventListener("var-link-changed", this._onVarLink);
		vfs.removeEventListener("change", this._onVfsChange);
		inputTransport.removeEventListener("tick", this._onTick);
		inputTransport.removeEventListener("state", this._onState);
		inputView.removeEventListener("change", this._onViewChange);
		document.removeEventListener("keydown", this._onKeyDown, true);
		inputSources.unregister("video", this);
		this._resizeObserver.disconnect();
		this._releaseClock();
	}

	// ── For the Stage and the viewer later (see input-sources.js) ────────
	get running() {
		return !!this._item && inputTransport.playing;
	}

	get statusText() {
		return this._running ? `Analysing ${MODEL_NAMES[this._running.model]}…` : "";
	}

	start() {
		inputTransport.play();
		return Promise.resolve();
	}

	stop() {
		inputTransport.stop();
	}

	getEntrySummaries() {
		return (this._item?.rows || []).map(({ entry }) => ({ id: entry.id, color: entry.color, label: entry.name, measure: entry.detail, bypassed: entry.bypassed }));
	}

	getEntryNorm(id) {
		const r = this._item?.rows.find(({ entry }) => entry.id === id);
		return r && !r.entry.bypassed ? r.row.norm : undefined;
	}

	// ── Persistence (inputs.json → "video") ──────────────────────────────
	// null when no video is loaded.
	getProject() {
		const item = this._item;
		if (!item) return null;
		return {
			version: 1,
			videos: [
				{
					file: item.file,
					muted: !!item.muted,
					analyses: Object.fromEntries(Object.entries(item.tables).map(([model, t]) => [model, { file: t.file, fps: t.fps }])),
					rows: item.rows.map(({ entry }) => ({
						id: entry.id,
						key: entry.key,
						name: entry.name,
						detail: entry.detail,
						model: entry.model,
						labels: [...entry.labels],
						mode: entry.mode,
						color: entry.color,
						invert: !!entry.invert,
						bypassed: !!entry.bypassed,
						min: entry.min ?? null,
						max: entry.max ?? null,
						mappings: entry.mappings.map((m) => ({ ...m }))
					}))
				}
			]
		};
	}

	async applyProject(project) {
		const saved = project?.videos?.[0];
		if (!saved) return;
		const node = vfs.findByExportPath(saved.file);
		if (!node?.file) {
			this._showMissing(saved.file);
			return;
		}
		await this._openNode(node, saved);
	}

	_clear() {
		this._cancelAdding();
		this._running?.abort.abort();
		this._removeItem(false);
		this._rowCounter = 0;
		this._colorIndex = 0;
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	_showMissing(file) {
		this._emptyEl.textContent = `The video ${file} is not in the project.`;
	}

	// A <Var>'s name changed: every target that pointed at it follows.
	_followVarLink({ oldName, newName }) {
		if (oldName === newName || !this._item) return;
		let changed = false;
		this._item.rows.forEach(({ entry }) =>
			entry.mappings.forEach((m) => {
				if (m.varName === oldName) {
					m.varName = newName;
					changed = true;
				}
			})
		);
		if (changed) {
			this._item.rows.forEach(({ row }) => row.refreshTargets());
			this._dispatchStateChange();
		}
	}

	// ── Loading a video ──────────────────────────────────────────────────
	_refreshProjectFiles() {
		const files = vfs.allFiles().filter((n) => !isHiddenName(n.name) && VIDEO_NAME_RE.test(n.name));
		this._projectSelect.hidden = files.length === 0 || !!this._item;
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

	// A video from the computer goes into the project (in a folder named video, if there
	// is one, else at the top; the same name and size is the same file).
	async _loadFile(file) {
		const folder = vfs.listFolder(ROOT_ID).find((n) => n.type === "folder" && n.name.toLowerCase() === "video");
		const parentId = folder?.id ?? ROOT_ID;
		const existing = vfs.listFolder(parentId).filter((n) => n.type === "file");
		let node = existing.find((n) => n.name === file.name && n.file?.size === file.size);
		if (!node) {
			let name = file.name;
			const base = baseName(name);
			const ext = name.slice(base.length);
			for (let n = 2; existing.some((x) => x.name === name); n++) name = `${base}-${n}${ext}`;
			node = vfs.uploadFile(parentId, new File([file], name, { type: file.type || "video/mp4" }));
		}
		await this._openNode(node);
	}

	// Makes `node` the input's video. `saved` is what inputs.json held for it.
	async _openNode(node, saved = null) {
		this._removeItem(false);
		this._emptyEl.textContent = "Load a video (or drop one here) to read values from the movement in it.";
		// The video's own address (the project file's session address is replaced when the
		// file is read into memory, which would cut a video that is playing).
		this._item = { file: vfs.getExportPath(node.id), node, url: URL.createObjectURL(node.file), muted: !!saved?.muted, tables: {}, rows: [] };
		this._nameEl.textContent = this._item.file;
		this._itemEl.hidden = false;
		this._emptyEl.hidden = true;
		this._loadBtn.hidden = true;
		this._projectSelect.hidden = true;
		this._videoEl.src = this._item.url;
		this._videoEl.loop = inputTransport.loop;
		this._applySound();
		inputTransport.use("video");
		inputTransport.setTimebase(this._timebase);
		this._renderAnalysis();
		await ensureDuration(this._videoEl);
		this._onVideoReady();
		inputTransport.setTimebase(this._timebase); // its length is known now
		if (saved) await this._restore(saved);
		this._dispatchStateChange();
	}

	// The tables and rows a saved project had: the tables are read from their CSV files.
	async _restore(saved) {
		const item = this._item;
		for (const [model, a] of Object.entries(saved.analyses || {})) {
			const node = vfs.findByExportPath(a.file);
			if (!node?.file) {
				this._notes[model] = `${a.file} is missing — analyse again`;
				continue;
			}
			try {
				item.tables[model] = { table: parseLandmarkCsv(await node.file.text()), file: a.file, fps: a.fps };
			} catch (err) {
				this._notes[model] = `${a.file}: ${err.message}`;
			}
		}
		(saved.rows || []).forEach((entry) => {
			const t = item.tables[entry.model];
			if (!t) return;
			this._rowCounter = Math.max(this._rowCounter, entry.id || 0);
			this._addRow({ ...entry, mappings: (entry.mappings || []).map((m) => ({ ...m })) }, t.table);
		});
		this._renderAnalysis();
		this._renderRows();
	}

	_removeItem(save) {
		if (!this._item) return;
		this._cancelAdding();
		this._running?.abort.abort();
		this._releaseClock();
		this._videoEl.pause();
		this._videoEl.removeAttribute("src");
		this._videoEl.load();
		URL.revokeObjectURL(this._item.url);
		this._item = null;
		this._itemEl.hidden = true;
		this._emptyEl.hidden = false;
		this._loadBtn.hidden = false;
		this._rowsEl.innerHTML = "";
		this._notes = {};
		this._refreshProjectFiles();
		if (save) this._dispatchStateChange();
	}

	_releaseClock() {
		inputTransport.setTimebase(null);
		inputTransport.release("video");
	}

	_applySound() {
		const muted = !!this._item?.muted;
		this._videoEl.muted = muted;
		this._soundBtn.textContent = muted ? "🔇" : "🔊";
		this._soundBtn.classList.toggle("active", muted);
	}

	_syncLoop() {
		this._videoEl.loop = inputTransport.loop;
	}

	_onVideoReady() {
		const v = this._videoEl;
		this._canvas.width = v.videoWidth;
		this._canvas.height = v.videoHeight;
		const mb = this._item?.node.file?.size ? ` · ${(this._item.node.file.size / 1048576).toFixed(1)} MB` : "";
		const large = this._item?.node.file?.size > LARGE_VIDEO_BYTES ? " — a large file: it is kept in memory and in the project's zip" : "";
		this._infoEl.textContent = `${v.videoWidth}×${v.videoHeight} · ${v.duration.toFixed(1)} s${mb}${large}`;
		this._drawOverlay();
	}

	// ── Analysis ─────────────────────────────────────────────────────────
	_dataFolderId() {
		const found = vfs.listFolder(ROOT_ID).find((n) => n.type === "folder" && n.name === DATA_FOLDER);
		return found ? found.id : vfs.createFolder(ROOT_ID, DATA_FOLDER).id;
	}

	// The file of a model's table in the project (written over if it is there already).
	_writeTable(model, table) {
		const folderId = this._dataFolderId();
		const name = `${baseName(this._item.file.split("/").pop())}.${model}.csv`;
		const csv = landmarksToCsv(table);
		const existing = vfs.listFolder(folderId).find((n) => n.type === "file" && n.name === name);
		const node = existing ? vfs.updateFileContent(existing.id, csv) : vfs.uploadFile(folderId, new File([csv], name, { type: "text/csv" }));
		return vfs.getExportPath(node.id);
	}

	// Resolves with the model's table: the one already made, or one made now (a pass over
	// the whole video, with a progress bar and a cancel). null when cancelled or failed.
	async _ensureTable(model, { force = false } = {}) {
		const item = this._item;
		if (item.tables[model] && !force) return item.tables[model].table;
		if (this._running) {
			this._notes[model] = "Another analysis is running — try again when it is done";
			this._renderAnalysis();
			return null;
		}
		const abort = new AbortController();
		this._running = { model, abort, progress: 0 };
		delete this._notes[model];
		this._renderAnalysis();
		try {
			const result = await analyzeVideo({
				url: item.url,
				model,
				fps: this._rate,
				signal: abort.signal,
				onProgress: (p) => {
					this._running.progress = p;
					this._updateProgress();
				}
			});
			if (this._item !== item) return null; // the video was taken away meanwhile
			item.tables[model] = { table: result.table, file: this._writeTable(model, result.table), fps: this._rate };
			// Rows that read from an earlier pass of this model now read from the new one.
			item.rows.filter((r) => r.entry.model === model).forEach((r) => this._remeasure(r, result.table));
			this._dispatchStateChange();
			return result.table;
		} catch (err) {
			if (err.name !== "AbortError") this._notes[model] = `The analysis failed: ${err.message}`;
			return null;
		} finally {
			this._running = null;
			this._renderAnalysis();
		}
	}

	_renderAnalysis() {
		const el = this._analysisEl;
		el.innerHTML = "";
		const item = this._item;
		if (!item) return;
		const line = (...nodes) => {
			const d = document.createElement("div");
			d.className = "line";
			d.append(...nodes);
			el.appendChild(d);
			return d;
		};
		const text = (s, cls) => {
			const sp = document.createElement("span");
			sp.textContent = s;
			if (cls) sp.className = cls;
			return sp;
		};
		for (const model of MODELS) {
			const t = item.tables[model];
			if (t) {
				const again = document.createElement("button");
				again.type = "button";
				again.className = "btn";
				again.textContent = "Analyse again";
				again.title = "Run the analysis anew at the speed chosen below (the rows keep their targets)";
				again.disabled = !!this._running;
				again.addEventListener("click", () => this._ensureTable(model, { force: true }));
				line(text(`✓ ${MODEL_NAMES[model]}: ${t.table.times.length.toLocaleString("en-US")} pictures, all points`, "done"), text(`· ${t.file}`), again);
			}
			if (this._notes[model]) line(text(this._notes[model], "error"));
		}
		if (this._running) {
			const bar = document.createElement("div");
			bar.className = "progress";
			bar.appendChild(document.createElement("div"));
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "btn";
			cancel.textContent = "Cancel";
			cancel.addEventListener("click", () => this._running?.abort.abort());
			this._progressEl = bar.firstChild;
			this._progressText = text("");
			line(text(`Analysing ${MODEL_NAMES[this._running.model]} over the whole video…`), bar, this._progressText, cancel);
			this._updateProgress();
		}
		const rate = document.createElement("select");
		rate.className = "rate-select";
		rate.title = "How many pictures per second to analyse (fewer is quicker; the values between are interpolated)";
		ANALYSIS_RATES.forEach((r) => {
			const o = document.createElement("option");
			o.value = r.value;
			o.textContent = r.label;
			rate.appendChild(o);
		});
		rate.value = String(this._rate);
		rate.disabled = !!this._running;
		rate.addEventListener("change", () => (this._rate = Number(rate.value)));
		line(text("Analysis speed"), rate);
	}

	_updateProgress() {
		if (!this._running || !this._progressEl) return;
		const pct = Math.round(this._running.progress * 100);
		this._progressEl.style.width = `${pct}%`;
		this._progressText.textContent = `${pct}%`;
	}

	// ── Adding a row ─────────────────────────────────────────────────────
	_onAddButton() {
		if (!this._item) return;
		if (this._adding || this._choosing) {
			this._cancelAdding();
			return;
		}
		this._choosing = true;
		this._updateOverlayUi();
	}

	async _beginAdding(model) {
		this._choosing = false;
		this._adding = { model, ready: false };
		this._selection = [];
		this._updateOverlayUi();
		const table = await this._ensureTable(model);
		if (!this._adding || this._adding.model !== model) return;
		if (!table) {
			this._cancelAdding();
			return;
		}
		this._adding.ready = true;
		this._updateOverlayUi();
		this._drawOverlay();
	}

	_cancelAdding() {
		this._choosing = false;
		this._adding = null;
		this._selection = [];
		if (inputMapMode.armed) inputMapMode.disarm();
		this._updateOverlayUi();
		this._drawOverlay();
	}

	_updateOverlayUi() {
		const adding = this._adding;
		this._modelChoices.hidden = !this._choosing;
		this._addBtn.textContent = this._choosing || adding ? "×" : "+";
		const sub = this._subtitle;
		if (this._choosing) {
			sub.hidden = false;
			sub.textContent = "What should it follow?";
		} else if (adding) {
			sub.hidden = false;
			sub.textContent = !adding.ready
				? `Analysing ${MODEL_NAMES[adding.model]}…`
				: this._selection.length
					? `${this._selection.length} point${this._selection.length > 1 ? "s" : ""} — click more, or map…`
					: "Click one or more points in the picture";
		} else {
			sub.hidden = true;
		}
		const ready = !!adding?.ready && this._selection.length > 0;
		this._mapWrap.hidden = !ready;
		this._axisSelect.hidden = this._selection.length !== 1;
		this._canvas.classList.toggle("picking", !!adding?.ready);
	}

	_onCanvasClick(e) {
		if (!this._adding?.ready) return;
		const label = this._nearestLabel(e);
		if (!label) return;
		const i = this._selection.indexOf(label);
		if (i >= 0) this._selection.splice(i, 1);
		else this._selection.push(label);
		this._updateOverlayUi();
		this._drawOverlay();
	}

	_frameNow(table) {
		return frameAt(table, this._videoEl.currentTime);
	}

	_nearestLabel(e) {
		const table = this._item?.tables[this._adding.model]?.table;
		if (!table) return null;
		const frame = this._frameNow(table);
		const rect = this._canvas.getBoundingClientRect();
		let best = null;
		let bestDist = NEAREST_PX;
		for (const label of table.labels) {
			const p = pointAt(table, label, frame);
			if (!p) continue;
			const d = Math.hypot(rect.left + p.x * rect.width - e.clientX, rect.top + p.y * rect.height - e.clientY);
			if (d < bestDist) {
				bestDist = d;
				best = label;
			}
		}
		return best;
	}

	// "map..." — arms the shared mapping mode; the row is made when a target is picked.
	_beginMap() {
		const adding = this._adding;
		if (!adding?.ready || !this._selection.length) return;
		const spec = { model: adding.model, labels: [...this._selection], mode: this._selection.length === 1 ? this._axisSelect.value : "both" };
		armMapping(
			this._mapBtn,
			(detail) => {
				const table = this._item.tables[spec.model].table;
				const entry = this._addRow(
					{
						id: ++this._rowCounter,
						model: spec.model,
						labels: spec.labels,
						mode: spec.mode,
						color: colorForIndex(this._colorIndex++),
						invert: false,
						bypassed: false,
						min: null,
						max: null,
						mappings: [mappingFromPick(detail)]
					},
					table
				);
				this._cancelAdding();
				this._renderRows();
				this._item.rows.find((r) => r.entry === entry)?.row.refreshTargets();
				this._dispatchStateChange();
			},
			() => {}
		);
	}

	// A row from its saved form: its values are measured from the table at once.
	_addRow(raw, table) {
		const item = this._item;
		const entry = {
			id: raw.id,
			key: raw.key || this._uniqueKey(slug(`${raw.labels.join("_")}_${raw.mode}`)),
			name: raw.name || raw.labels.join(" + "),
			detail: raw.detail || this._detailOf(raw),
			model: raw.model,
			labels: [...raw.labels],
			mode: raw.mode,
			color: raw.color,
			invert: !!raw.invert,
			bypassed: !!raw.bypassed,
			min: raw.min ?? null,
			max: raw.max ?? null,
			mappings: raw.mappings
		};
		const data = { length: 0, xs: null };
		const series = { name: entry.name, sourceIndex: 0, filled: new Float64Array(0), min: 0, max: 1 };
		const r = { entry, series, data };
		this._remeasure(r, table);
		r.row = new SeriesRow(entry, () => ({ data, series, interpolate: "linear" }), {
			onChange: () => this._dispatchStateChange(),
			onRemove: (e) => {
				item.rows = item.rows.filter((x) => x.entry !== e);
				this._renderRows();
				this._dispatchStateChange();
			},
			syntheticName: (e, index) => (index > 0 ? `video_${e.key}_${index + 1}` : `video_${e.key}`)
		});
		item.rows.push(r);
		return entry;
	}

	// (Re)reads a row's values from a table: a 0–1 value for every picture, over the range the
	// whole video covers, and where in the play-bar each picture lies.
	_remeasure(r, table) {
		const aspect = this._videoEl.videoWidth / Math.max(1, this._videoEl.videoHeight) || 1;
		const duration = this._videoEl.duration || table.times[table.times.length - 1] || 1;
		r.series.filled = measureSeries(table, r.entry.labels, r.entry.mode, aspect).values;
		r.data.length = table.times.length;
		r.data.xs = Float64Array.from(table.times, (t) => t / duration);
		r.row?.draw();
		r.row?.update({ quiet: true });
	}

	_uniqueKey(base) {
		const used = new Set((this._item?.rows || []).map((r) => r.entry.key));
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
		return key;
	}

	_detailOf(raw) {
		const n = raw.labels.length;
		return n === 1 ? (raw.mode === "horizontal" ? "horizontal" : raw.mode === "vertical" ? "vertical" : "both axes") : n === 2 ? "distance" : "area";
	}

	_renderRows() {
		this._resizeObserver.disconnect();
		this._resizeObserver.observe(this._rowsEl);
		this._rowsEl.innerHTML = "";
		(this._item?.rows || []).forEach(({ row }) => {
			this._rowsEl.appendChild(row.el);
			this._resizeObserver.observe(row.waveEl);
		});
		requestAnimationFrame(() => {
			this._drawRows();
			this._updatePlayheads();
			// Shown, not sent: opening a project must not move anything by itself.
			(this._item?.rows || []).forEach(({ row }) => row.update({ quiet: true }));
		});
	}

	_drawRows() {
		(this._item?.rows || []).forEach(({ row }) => row.draw());
	}

	_updatePlayheads() {
		inputView.follow(inputTransport.fraction);
		(this._item?.rows || []).forEach(({ row }) => row.updatePlayhead());
	}

	_onTransportTick() {
		if (!this._item) return;
		this._updatePlayheads();
		this._item.rows.forEach(({ row }) => row.update());
		this._drawOverlay();
	}

	// ── The points over the picture ──────────────────────────────────────
	// Every row's points in its colour (a dot, a line between two, a surface for more),
	// and, while adding, all of the model's points with the picked ones marked.
	_drawOverlay() {
		const item = this._item;
		const ctx = this._ctx;
		const w = this._canvas.width;
		const h = this._canvas.height;
		ctx.clearRect(0, 0, w, h);
		if (!item) return;
		const scale = Math.max(1, w / 400);
		const at = (table, label) => {
			const p = pointAt(table, label, this._frameNow(table));
			return p ? { x: p.x * w, y: p.y * h } : null;
		};
		if (this._adding?.ready) {
			const table = item.tables[this._adding.model].table;
			ctx.fillStyle = "rgba(255,255,255,0.55)";
			const dot = this._adding.model === "face" ? 0.9 : 2;
			for (const label of table.labels) {
				const p = at(table, label);
				if (p) ctx.fillRect(p.x - dot * scale, p.y - dot * scale, dot * 2 * scale, dot * 2 * scale);
			}
			this._drawGroup(ctx, this._selection.map((l) => at(table, l)).filter(Boolean), "#ffffff", scale, 1);
		}
		for (const { entry } of item.rows) {
			if (entry.bypassed) continue;
			const table = item.tables[entry.model]?.table;
			if (!table) continue;
			this._drawGroup(ctx, entry.labels.map((l) => at(table, l)).filter(Boolean), entry.color, scale, 0.9);
		}
	}

	_drawGroup(ctx, pts, color, scale, alpha) {
		if (!pts.length) return;
		ctx.globalAlpha = alpha;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = 2 * scale;
		if (pts.length > 1) {
			const ordered = pts.length > 2 ? angularOrder(pts, 1) : pts;
			ctx.beginPath();
			ordered.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
			if (pts.length > 2) {
				ctx.closePath();
				ctx.globalAlpha = alpha * 0.25;
				ctx.fill();
				ctx.globalAlpha = alpha;
			}
			ctx.stroke();
		}
		for (const p of pts) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, 4 * scale, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}
}

customElements.define("wa-video-input", WaVideoInput);
