import { DELIMITERS, ENCODINGS, decodeBytes, parseCsv, sniffCsv } from "../input/csv-parse.js";
import { buildDataset, guessLayout } from "../input/data-series.js";

// The CSV import's preview: shows how a file is understood — the first lines as
// a table, with the names and the time axis marked, and how many series of how
// many values come out — and lets every guess be changed (encoding, the
// character between cells, quotes, the end of a line, the decimal character,
// which way the series run, where the names are, whether there is a time axis).
// A change is shown at once. Until the layout is touched by hand it is guessed
// anew whenever the format changes.
//
// Used imperatively: `const options = await openCsvImportDialog({ name, buffer, options });`
// — resolves with the chosen options (see below), or null when cancelled.
//
// options: { encoding, delimiter, quote, recordSeparator, decimal, orientation, header, timeColumn, interpolate }

const PREVIEW_ROWS = 12;
const PREVIEW_COLUMNS = 10;
const LARGE_VALUES = 500000;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.backdrop {
			position: absolute;
			inset: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(0, 0, 0, 0.6);
		}
		.dialog {
			width: min(46rem, 94vw);
			max-height: 92vh;
			overflow: auto;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
			padding: 1rem 1.1rem;
			color: var(--waw-fg, #e8e8e8);
		}
		h2 {
			margin: 0 0 0.15rem;
			font-size: 1rem;
		}
		.file {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.75rem;
			margin-bottom: 0.8rem;
			word-break: break-all;
		}
		.settings {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
			gap: 0.55rem 0.8rem;
			margin-bottom: 0.8rem;
		}
		label.field {
			display: flex;
			flex-direction: column;
			gap: 0.15rem;
			font-size: 0.7rem;
			color: var(--waw-muted, #8a8a8a);
		}
		label.check {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			font-size: 0.78rem;
			color: var(--waw-fg, #e8e8e8);
		}
		select {
			background: #111;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			color: var(--waw-fg, #e8e8e8);
			font: inherit;
			font-size: 0.78rem;
			padding: 0.28rem 0.35rem;
		}
		.layout {
			display: flex;
			flex-wrap: wrap;
			gap: 0.4rem 1.2rem;
			margin-bottom: 0.8rem;
			padding: 0.6rem 0.7rem;
			background: rgba(255, 255, 255, 0.04);
			border-radius: 6px;
		}
		.layout .field {
			min-width: 14rem;
		}
		.preview-wrap {
			overflow: auto;
			max-height: 15rem;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			margin-bottom: 0.5rem;
		}
		table {
			border-collapse: collapse;
			width: 100%;
			font: 0.72rem/1.3 var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		td {
			border: 1px solid #2a2a2a;
			padding: 0.18rem 0.45rem;
			white-space: nowrap;
			max-width: 9rem;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		td.names {
			background: rgba(79, 163, 255, 0.18);
			color: var(--waw-accent, #4fa3ff);
			font-weight: 600;
		}
		td.time {
			background: rgba(251, 146, 60, 0.16);
			color: #fb923c;
		}
		td.text {
			color: var(--waw-muted, #8a8a8a);
		}
		.summary {
			font-size: 0.78rem;
			min-height: 1.2em;
		}
		.summary.warn {
			color: #fb923c;
		}
		.summary.error {
			color: var(--waw-danger, #e5484d);
		}
		.names-list {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.72rem;
			margin-top: 0.15rem;
		}
		.actions {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			margin-top: 0.9rem;
		}
		.actions .spacer {
			flex: 1 1 auto;
		}
		button {
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.35rem 0.9rem;
			font-size: 0.8rem;
			cursor: pointer;
		}
		button:hover {
			background: #333;
		}
		button.primary {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #0c0c0c;
		}
		button.primary:hover {
			filter: brightness(1.08);
		}
		button:disabled {
			opacity: 0.45;
			cursor: default;
		}
	</style>
	<div class="backdrop">
		<div class="dialog" role="dialog" aria-label="Import CSV">
			<h2>Import CSV</h2>
			<div class="file"></div>
			<div class="settings">
				<label class="field">Encoding<select data-opt="encoding"></select></label>
				<label class="field">Between cells<select data-opt="delimiter"></select></label>
				<label class="field">Quotes<select data-opt="quote">
					<option value='"'>Double ( " )</option>
					<option value="'">Single ( ' )</option>
					<option value="">None</option>
				</select></label>
				<label class="field">End of a line<select data-opt="recordSeparator">
					<option value="auto">Line break</option>
					<option value=";">Semicolon ( ; )</option>
				</select></label>
				<label class="field" title="1.5 and 1,5 are both read as 1.5. This only settles a number like 1,234 — is it 1.234 or 1234?">Decimal sign (for 1,234)<select data-opt="decimal">
					<option value=".">Point — 1,234 is 1234</option>
					<option value=",">Comma — 1,234 is 1.234</option>
				</select></label>
				<label class="field">Between values<select data-opt="interpolate">
					<option value="linear">Glide (linear)</option>
					<option value="step">Hold (steps)</option>
				</select></label>
			</div>
			<div class="layout">
				<label class="field">Each …<select data-opt="orientation">
					<option value="rows">row is a series (time runs along the row)</option>
					<option value="columns">column is a series (time runs down)</option>
				</select></label>
				<label class="check"><input type="checkbox" data-opt="header" /> <span class="header-label"></span></label>
				<label class="check"><input type="checkbox" data-opt="timeColumn" /> <span class="time-label"></span></label>
			</div>
			<div class="preview-wrap"><table class="preview"></table></div>
			<div class="summary"></div>
			<div class="names-list"></div>
			<div class="actions">
				<button class="btn-reset" type="button" title="Detect the format again">Reset to detected</button>
				<span class="spacer"></span>
				<button class="btn-cancel" type="button">Cancel</button>
				<button class="btn-import primary" type="button">Import</button>
			</div>
		</div>
	</div>
`;

class WaCsvImportDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		this._file = $(".file");
		this._table = $(".preview");
		this._summary = $(".summary");
		this._names = $(".names-list");
		this._importBtn = $(".btn-import");
		this._headerLabel = $(".header-label");
		this._timeLabel = $(".time-label");
		this._opts = {};
		this._layoutTouched = false;
		this._buffer = null;
		this._table2d = [];
		this._resolve = null;
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._finish(null);
		};
	}

	setup({ name, buffer, options }) {
		this._buffer = buffer;
		this._file.textContent = `${name} · ${buffer.byteLength.toLocaleString("en-US")} bytes`;
		this._fill(this._$('[data-opt="encoding"]'), ENCODINGS);
		this._fill(this._$('[data-opt="delimiter"]'), DELIMITERS);
		this._savedOptions = options || null;
		this._detect();
		if (options) {
			this._opts = { ...this._opts, ...options };
			this._layoutTouched = true;
			this._reparse();
		}
		this._syncControls();
		this._render();
		return new Promise((resolve) => (this._resolve = resolve));
	}

	_$(sel) {
		return this.shadowRoot.querySelector(sel);
	}

	_fill(select, items) {
		select.innerHTML = "";
		items.forEach((i) => {
			const o = document.createElement("option");
			o.value = i.value;
			o.textContent = i.label;
			select.appendChild(o);
		});
	}

	// Everything guessed from the file anew.
	_detect() {
		const { text } = decodeBytes(this._buffer, "auto");
		const sniffed = sniffCsv(text);
		this._opts = { encoding: "auto", interpolate: "linear", ...sniffed };
		this._layoutTouched = false;
		this._reparse();
	}

	// Decodes and splits with the current format options; unless the layout was
	// touched by hand it is guessed anew too.
	_reparse() {
		const { text } = decodeBytes(this._buffer, this._opts.encoding);
		this._table2d = parseCsv(text, this._opts);
		if (!this._layoutTouched || this._opts.orientation === undefined) {
			const layout = guessLayout(this._table2d, this._opts.decimal);
			Object.assign(this._opts, layout);
		}
	}

	_syncControls() {
		this.shadowRoot.querySelectorAll("[data-opt]").forEach((el) => {
			const value = this._opts[el.dataset.opt];
			if (el.type === "checkbox") el.checked = !!value;
			else el.value = value ?? "";
		});
		const rows = this._opts.orientation === "rows";
		this._headerLabel.textContent = rows ? "The first column holds the names" : "The first line holds the names";
		this._timeLabel.textContent = rows ? "The first row is time (a time axis)" : "The first column is time (a time axis)";
	}

	_render() {
		const o = this._opts;
		const grid = this._table2d;
		const R = Math.min(grid.length, PREVIEW_ROWS);
		const C = Math.min(grid.reduce((m, r) => Math.max(m, r.length), 0), PREVIEW_COLUMNS);
		this._table.innerHTML = "";
		const rows = o.orientation === "rows";
		for (let r = 0; r < R; r++) {
			const tr = document.createElement("tr");
			for (let c = 0; c < C; c++) {
				const td = document.createElement("td");
				td.textContent = grid[r][c] ?? "";
				td.title = grid[r][c] ?? "";
				// In a "rows" file the names are the first column and the time is the first line;
				// in a "columns" file the names are the first line and the time is the first column.
				const isName = o.header && (rows ? c === 0 : r === 0);
				const isTime = o.timeColumn && (rows ? r === 0 : c === 0);
				if (isName) td.className = "names";
				else if (isTime) td.className = "time";
				tr.appendChild(td);
			}
			this._table.appendChild(tr);
		}
		const ds = buildDataset(grid, { orientation: o.orientation, header: !!o.header, timeColumn: !!o.timeColumn }, o.decimal);
		const count = ds.series.length;
		const values = count * ds.length;
		this._summary.className = "summary";
		if (!grid.length || !count) {
			this._summary.textContent = "No numbers found with these settings — try another delimiter, decimal or orientation.";
			this._summary.classList.add("error");
			this._names.textContent = "";
			this._importBtn.disabled = true;
			return;
		}
		this._importBtn.disabled = false;
		this._summary.textContent = `${count} series × ${ds.length.toLocaleString("en-US")} values` + (o.timeColumn && ds.xs ? " · placed by the time axis" : o.timeColumn ? " · the time axis is not usable (it must count upwards) — spread evenly" : " · spread evenly over the play-bar");
		if (values > LARGE_VALUES) {
			this._summary.textContent += ` — ${values.toLocaleString("en-US")} values is a lot; the panel may feel slow.`;
			this._summary.classList.add("warn");
		}
		this._names.textContent = ds.series.map((s) => s.name).slice(0, 12).join(" · ") + (count > 12 ? " · …" : "");
	}

	connectedCallback() {
		const root = this.shadowRoot;
		root.querySelectorAll("[data-opt]").forEach((el) => {
			el.addEventListener("change", () => {
				const key = el.dataset.opt;
				const value = el.type === "checkbox" ? el.checked : el.value;
				this._opts[key] = value;
				if (["orientation", "header", "timeColumn"].includes(key)) this._layoutTouched = true;
				if (["encoding", "delimiter", "quote", "recordSeparator", "decimal"].includes(key)) this._reparse();
				this._syncControls();
				this._render();
			});
		});
		root.querySelector(".btn-reset").addEventListener("click", () => {
			this._detect();
			this._syncControls();
			this._render();
		});
		root.querySelector(".btn-cancel").addEventListener("click", () => this._finish(null));
		this._importBtn.addEventListener("click", () => this._finish({ ...this._opts }));
		root.querySelector(".backdrop").addEventListener("click", (e) => {
			if (e.target === e.currentTarget) this._finish(null);
		});
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	_finish(result) {
		const resolve = this._resolve;
		this._resolve = null;
		this.remove();
		resolve?.(result);
	}
}

customElements.define("wa-csv-import-dialog", WaCsvImportDialog);

export function openCsvImportDialog({ name, buffer, options }) {
	const dialog = document.createElement("wa-csv-import-dialog");
	document.body.appendChild(dialog);
	return dialog.setup({ name, buffer, options });
}
