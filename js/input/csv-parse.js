// Reading a CSV file: decoding the bytes, splitting the text into cells and
// guessing the format. Pure functions, no DOM — so they run (and are tested,
// see scripts/test-csv.mjs) under Node as well as in the browser.
//
// A CSV file has no standard. What varies, and what the import dialog lets the
// user set (everything below is guessed first, see sniffCsv):
//   encoding         UTF-8 (with or without a BOM), UTF-16, or the Windows-1252 that
//                    Swedish Excel writes;
//   delimiter        comma, semicolon, tab, pipe or space between the cells;
//   quote            "…" or '…' around a cell (a doubled quote inside is one quote), or none;
//   record separator a line break (any of \r\n, \n, \r) — or, in some exports, a semicolon;
//   decimal          a point, or the comma that goes with a semicolon delimiter ("1,5"); both are
//                    read in any case (see parseNumber), the choice only settles "1,234".

export const DELIMITERS = [
	{ value: ",", label: "Comma" },
	{ value: ";", label: "Semicolon" },
	{ value: "\t", label: "Tab" },
	{ value: "|", label: "Pipe" },
	{ value: " ", label: "Space" }
];

export const ENCODINGS = [
	{ value: "auto", label: "Auto-detect" },
	{ value: "utf-8", label: "UTF-8" },
	{ value: "windows-1252", label: "Windows-1252 (Excel)" },
	{ value: "iso-8859-1", label: "ISO-8859-1" },
	{ value: "utf-16le", label: "UTF-16 LE" },
	{ value: "utf-16be", label: "UTF-16 BE" }
];

// The text of a file's bytes. "auto": a byte-order mark decides; else UTF-8 if
// the bytes are valid UTF-8, else Windows-1252 (what an Excel in Swedish
// saves as "CSV"). Returns the encoding actually used.
export function decodeBytes(buffer, encoding = "auto") {
	const bytes = new Uint8Array(buffer);
	let enc = encoding;
	if (enc === "auto") {
		if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = "utf-16le";
		else if (bytes[0] === 0xfe && bytes[1] === 0xff) enc = "utf-16be";
		else {
			try {
				return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
			} catch {
				enc = "windows-1252";
			}
		}
	}
	return { text: new TextDecoder(enc).decode(bytes), encoding: enc };
}

// Splits text into records of cells. A cell that was quoted keeps its text
// exactly, an unquoted one is trimmed; an empty line is not a record. With a
// custom recordSeparator (";") a line break is plain white space.
export function parseCsv(text, { delimiter = ",", quote = '"', recordSeparator = "auto" } = {}) {
	const rows = [];
	let row = [];
	let cell = "";
	let inQuotes = false;
	let wasQuoted = false;
	const custom = recordSeparator === "auto" ? null : recordSeparator;
	const endCell = () => {
		row.push(wasQuoted ? cell : cell.trim());
		cell = "";
		wasQuoted = false;
	};
	const endRow = () => {
		endCell();
		if (row.length > 1 || row[0] !== "") rows.push(row);
		row = [];
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === quote) {
				if (text[i + 1] === quote) {
					cell += quote;
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cell += ch;
			}
			continue;
		}
		if (quote && ch === quote && cell.trim() === "") {
			inQuotes = true;
			wasQuoted = true;
			cell = "";
			continue;
		}
		if (ch === delimiter) {
			endCell();
			continue;
		}
		if (custom !== null) {
			if (ch === custom) {
				endRow();
				continue;
			}
		} else if (ch === "\r") {
			if (text[i + 1] === "\n") i++;
			endRow();
			continue;
		} else if (ch === "\n") {
			endRow();
			continue;
		}
		cell += ch;
	}
	if (cell !== "" || row.length > 0 || wasQuoted) endRow();
	return rows;
}

// The reverse of parseCsv: records of cells as text, with the same delimiter, quote and
// record separator. A cell is quoted only when it has to be (it holds the delimiter, a quote,
// a line break, the record separator, or white space at either end that would be trimmed away).
export function stringifyCsv(table, { delimiter = ",", quote = '"', recordSeparator = "auto" } = {}) {
	const end = recordSeparator === "auto" ? "\n" : recordSeparator;
	const cellText = (cell) => {
		const text = cell === undefined || cell === null ? "" : String(cell);
		const needs = text !== text.trim() || text.includes(delimiter) || /[\r\n]/.test(text) || text.includes(end) || (quote && text.includes(quote));
		if (!needs || !quote) return text;
		return quote + text.split(quote).join(quote + quote) + quote;
	};
	return table.map((row) => row.map(cellText).join(delimiter)).join(end) + (recordSeparator === "auto" ? "\n" : "");
}

// A number as a cell: enough digits to read back what was drawn, with the file's decimal sign.
export function formatNumber(value, decimal = ".") {
	const text = String(Number(value.toPrecision(10)));
	return decimal === "," ? text.replace(".", ",") : text;
}

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

// A cell as a number, or NaN (empty, text, "NaN", "n/a"…). A point and a comma
// both work as the decimal sign, in the same file if need be: "1.5" and "1,5" are
// both 1.5. Where a number has both, the last one is the decimal sign and the other
// a thousands separator ("1.234,5", "1,234.5"); a separator repeated in groups of three
// is a thousands separator ("1,234,567"). Only one separator followed by exactly three
// digits ("1,234") is truly ambiguous — there `decimal` ("." or ",") decides. White
// space between digits is ignored, and a trailing % is dropped.
export function parseNumber(cell, decimal = ".") {
	if (cell === undefined || cell === null) return NaN;
	let s = String(cell).replace(/[\s\u00a0]/g, "").replace(/%$/, "");
	if (s === "") return NaN;
	const hasComma = s.includes(",");
	const hasPoint = s.includes(".");
	if (hasComma && hasPoint) {
		const decimalSign = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
		const thousands = decimalSign === "," ? "." : ",";
		const [whole, fraction, ...rest] = s.split(decimalSign);
		if (rest.length || !/^[-+]?\d{1,3}(\D\d{3})*$/.test(whole) || whole.replace(/\d/g, "").replace(/^[-+]/, "").split("").some((c) => c !== thousands)) return NaN;
		s = whole.split(thousands).join("") + "." + fraction;
	} else if (hasComma || hasPoint) {
		const sign = hasComma ? "," : ".";
		const count = s.split(sign).length - 1;
		if (count > 1) {
			if (!new RegExp(`^[-+]?\\d{1,3}(\\${sign}\\d{3})+$`).test(s)) return NaN;
			s = s.split(sign).join("");
		} else if (/^[-+]?\d{1,3}[.,]\d{3}$/.test(s) && sign !== decimal) {
			s = s.replace(sign, "");
		} else {
			s = s.replace(sign, ".");
		}
	}
	return NUMBER_RE.test(s) ? Number(s) : NaN;
}

// ── Guessing the format ──────────────────────────────────────────────────

function detectQuote(sample) {
	if (sample.includes('"')) return '"';
	// Single quotes only count when most cells start and end with one.
	const cells = sample.split(/[,;\t|\r\n]+/).map((c) => c.trim()).filter(Boolean);
	if (cells.length && cells.filter((c) => c.length > 1 && c.startsWith("'") && c.endsWith("'")).length / cells.length > 0.5) return "'";
	return '"';
}

// Whether the numbers use a decimal comma ("1,5;2,5"): there is a ";" or tab
// between the cells and the commas only ever sit inside single numbers.
function looksLikeDecimalComma(sample) {
	if (!/[;\t]/.test(sample) || !/\d,\d/.test(sample)) return false;
	const tokens = sample.split(/[;\t\r\n]+/).map((t) => t.replace(/^"|"$/g, "").trim()).filter(Boolean);
	if (tokens.some((t) => (t.match(/,/g) || []).length > 1 && /^[-+\d.,\s]+$/.test(t))) return false;
	return tokens.some((t) => /^[-+]?\d+,\d+$/.test(t));
}

function consistency(rows) {
	if (!rows.length) return { count: 0, share: 0 };
	const freq = new Map();
	rows.forEach((r) => freq.set(r.length, (freq.get(r.length) || 0) + 1));
	let count = 0;
	let best = 0;
	for (const [n, f] of freq) {
		if (f > best || (f === best && n > count)) {
			best = f;
			count = n;
		}
	}
	return { count, share: best / rows.length };
}

// The options a file most likely has: { delimiter, quote, recordSeparator, decimal }.
export function sniffCsv(text) {
	const sample = text.slice(0, 200000);
	const quote = detectQuote(sample);
	const decimalComma = looksLikeDecimalComma(sample);
	const body = sample.replace(/[\r\n]+$/, "");
	const singleLine = !/[\r\n]/.test(body);

	// One line only, with a semicolon between records: "1,2,3;4,5,6;7,8,9".
	if (singleLine && !decimalComma && body.includes(";")) {
		for (const delimiter of [",", "\t", " "]) {
			const rows = parseCsv(body, { delimiter, quote, recordSeparator: ";" });
			const { count, share } = consistency(rows);
			if (rows.length >= 2 && count > 1 && share === 1) {
				return { delimiter, quote, recordSeparator: ";", decimal: "." };
			}
		}
	}

	let delimiter = ",";
	if (decimalComma) {
		delimiter = /;/.test(sample) ? ";" : "\t";
	} else {
		const lines = sample.split(/\r\n|\n|\r/).slice(0, 100).join("\n");
		let bestScore = -1;
		for (const candidate of ["\t", ";", ",", "|", " "]) {
			const rows = parseCsv(lines, { delimiter: candidate, quote });
			const { count, share } = consistency(rows);
			if (count < 2) continue;
			const score = share * 100 + Math.min(count, 20) - (candidate === " " ? 60 : 0);
			if (share >= 0.7 && score > bestScore) {
				bestScore = score;
				delimiter = candidate;
			}
		}
	}
	return { delimiter, quote, recordSeparator: "auto", decimal: decimalComma ? "," : "." };
}
