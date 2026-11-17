import { formatNumber, stringifyCsv } from "./csv-parse.js";
import { cellAddress, refreshSeries } from "./data-series.js";
import { vfs } from "../vfs/VFS.js";

// Changing the values of a series that lives in a CSV file of the project — the part of
// drawing over a row (series-row.js) that is the same for a CSV row (wa-data-input.js) and
// for a video row whose track was lifted out into a CSV file (wa-video-input.js).
//
// `ds` is { file, table, layout, import }: the file's path in the project, its parsed table
// (lines of text cells), how the table is read (see data-series.js) and how the file is
// written (delimiter, quote, record separator, decimal sign).

// The text of the cell that holds value `i` of a series.
export function readCell(ds, series, i) {
	const [r, c] = cellAddress(ds.layout, series.sourceIndex, i);
	return ds.table[r]?.[c] ?? "";
}

// Puts values (numbers, or the text a cell had before) into the table, reads the series anew
// from it (`length` values) and writes the table back to the file the way it was read. Other
// cells and series of the table are untouched. The file is written as UTF-8, whatever it was
// before, so an import setting for another encoding is changed to say so.
export function writeCells(ds, series, cells, length) {
	const o = ds.import;
	cells.forEach(([i, value]) => {
		const [r, c] = cellAddress(ds.layout, series.sourceIndex, i);
		const line = (ds.table[r] ??= []);
		while (line.length <= c) line.push("");
		line[c] = typeof value === "number" ? formatNumber(value, o.decimal) : value;
	});
	refreshSeries(series, ds.table, ds.layout, length, o.decimal);
	const node = vfs.findByExportPath(ds.file);
	if (!node?.file) return;
	if (o.encoding && o.encoding !== "auto") o.encoding = "utf-8";
	vfs.updateFileContent(node.id, stringifyCsv(ds.table, o), { silent: true });
}
