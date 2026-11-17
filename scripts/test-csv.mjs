// Tests of the CSV reading (js/input/csv-parse.js, data-series.js): the formats
// a CSV can come in, the guesses about them, and how a value is read out.
//   node scripts/test-csv.mjs
import assert from "node:assert/strict";
import { decodeBytes, parseCsv, parseNumber, sniffCsv } from "../js/input/csv-parse.js";
import { buildDataset, guessLayout, normalize, sampleSeries, transpose, waveformColumns } from "../js/input/data-series.js";

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
}

// Text → table with everything guessed, the way the import does it first.
function read(text) {
	const opts = sniffCsv(text);
	const table = parseCsv(text, opts);
	const layout = guessLayout(table, opts.decimal);
	return { opts, table, layout, dataset: buildDataset(table, layout, opts.decimal) };
}

test("comma, quotes, doubled quote, embedded delimiter and newline", () => {
	const t = parseCsv('a,"b,c","say ""hi""","line1\nline2"\n1,2,3,4');
	assert.deepEqual(t, [["a", "b,c", 'say "hi"', "line1\nline2"], ["1", "2", "3", "4"]]);
});

test("line endings \\r\\n, \\n, \\r and a missing last newline", () => {
	for (const nl of ["\r\n", "\n", "\r"]) assert.deepEqual(parseCsv(`1,2${nl}3,4${nl}`), [["1", "2"], ["3", "4"]]);
	assert.deepEqual(parseCsv("1,2\n3,4"), [["1", "2"], ["3", "4"]]);
});

test("empty lines are not records; cells are trimmed unless quoted", () => {
	assert.deepEqual(parseCsv('1, 2 ,"  3  "\n\n  \n4,5,6'), [["1", "2", "  3  "], ["4", "5", "6"]]);
});

test("single quotes and no quotes", () => {
	assert.deepEqual(parseCsv("'a,b',c", { delimiter: ",", quote: "'" }), [["a,b", "c"]]);
	assert.deepEqual(parseCsv('"a",b', { delimiter: ",", quote: "" }), [['"a"', "b"]]);
});

test("a semicolon as record separator", () => {
	assert.deepEqual(parseCsv("1,2,3;4,5,6;7,8,9;", { delimiter: ",", recordSeparator: ";" }), [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]);
});

test("numbers: point, decimal comma, thousands, percent, junk", () => {
	assert.equal(parseNumber("1.5"), 1.5);
	assert.equal(parseNumber("1,5", ","), 1.5);
	assert.equal(parseNumber("1 234,5", ","), 1234.5);
	assert.equal(parseNumber("1.234,5", ","), 1234.5);
	assert.equal(parseNumber("1,234.5"), 1234.5);
	assert.equal(parseNumber("-.5"), -0.5);
	assert.equal(parseNumber("2e3"), 2000);
	assert.equal(parseNumber("50 %"), 50);
	// Both signs work in the same file; only "1,234" depends on the setting.
	assert.equal(parseNumber("1,5"), 1.5);
	assert.equal(parseNumber("2.5", ","), 2.5);
	assert.equal(parseNumber("-0,25"), -0.25);
	assert.equal(parseNumber("1,234"), 1234);
	assert.equal(parseNumber("1,234", ","), 1.234);
	assert.equal(parseNumber("1.234"), 1.234);
	assert.equal(parseNumber("1.234", ","), 1234);
	assert.equal(parseNumber("1,234,567"), 1234567);
	assert.equal(parseNumber("1.234.567,5"), 1234567.5);
	assert.equal(parseNumber("1,234.56"), 1234.56);
	for (const junk of ["", "abc", "n/a", "NaN", "1.2.3", "1,2,3", "1.234,56,7", undefined, null]) assert.ok(Number.isNaN(parseNumber(junk)));
});

test("a file that mixes decimal points and commas", () => {
	const { dataset } = read("a;b\n1,5;2.5\n3.5;4,5\n");
	assert.deepEqual([...dataset.series[0].filled], [1.5, 3.5]);
	assert.deepEqual([...dataset.series[1].filled], [2.5, 4.5]);
});

test("a comma delimiter works with decimal commas when the cells are quoted", () => {
	const { opts, dataset } = read('a,b\n"1,5","2,5"\n"3,5","4,5"\n');
	assert.equal(opts.delimiter, ",");
	assert.deepEqual([...dataset.series[0].filled], [1.5, 3.5]);
});

test("encodings: UTF-8, BOM, Windows-1252 and UTF-16", () => {
	assert.equal(decodeBytes(new TextEncoder().encode("åäö;1")).text, "åäö;1");
	assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).text, "a");
	const w1252 = new Uint8Array([0xe5, 0xe4, 0xf6]); // åäö in Windows-1252, not valid UTF-8
	assert.deepEqual(decodeBytes(w1252.buffer), { text: "åäö", encoding: "windows-1252" });
	const utf16 = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3b, 0x00, 0x31, 0x00]);
	assert.equal(decodeBytes(utf16.buffer).text.replace("﻿", ""), "a;1");
});

test("sniff: comma, semicolon, tab, pipe", () => {
	assert.equal(sniffCsv("a,b,c\n1,2,3\n4,5,6").delimiter, ",");
	assert.equal(sniffCsv("a;b;c\n1;2;3\n4;5;6").delimiter, ";");
	assert.equal(sniffCsv("a\tb\tc\n1\t2\t3").delimiter, "\t");
	assert.equal(sniffCsv("a|b|c\n1|2|3").delimiter, "|");
});

test("sniff: a decimal comma goes with a semicolon, single line too", () => {
	const o = sniffCsv("a;b\n1,5;2,5\n3,5;4,5");
	assert.equal(o.delimiter, ";");
	assert.equal(o.decimal, ",");
	const one = sniffCsv("1,5;2,5;3,5");
	assert.equal(one.delimiter, ";");
	assert.equal(one.decimal, ",");
});

test("sniff: one line with semicolons between records", () => {
	const o = sniffCsv("1,2,3;4,5,6;7,8,9");
	assert.equal(o.recordSeparator, ";");
	assert.equal(o.delimiter, ",");
	assert.equal(o.decimal, ".");
});

test("sniff: a comma list on one line is a single record", () => {
	const o = sniffCsv("1,2,3,4,5");
	assert.equal(o.delimiter, ",");
	assert.equal(o.recordSeparator, "auto");
});

test("sniff: a quoted comma does not make a column", () => {
	assert.equal(sniffCsv('name;note\nx;"a,b"\ny;"c,d"').delimiter, ";");
});

test("layout: columns with a header row", () => {
	const { layout, dataset } = read("time,temp,hum\n0,20,50\n1,21,52\n2,22,54");
	assert.deepEqual(layout, { orientation: "columns", header: true, timeColumn: true });
	assert.deepEqual(dataset.series.map((s) => s.name), ["temp", "hum"]);
	assert.equal(dataset.length, 3);
});

test("layout: rows with a name in the first column", () => {
	const { layout, dataset } = read("temp;20;21;22;23\nhum;50;52;54;56\n");
	assert.deepEqual(layout, { orientation: "rows", header: true, timeColumn: false });
	assert.deepEqual(dataset.series.map((s) => s.name), ["temp", "hum"]);
	assert.equal(dataset.length, 4);
});

test("layout: numbers only — few rows are series, few columns are series", () => {
	assert.equal(read("1,2,3,4,5,6\n6,5,4,3,2,1").layout.orientation, "rows");
	const tall = read("1,6\n2,5\n3,4\n4,3\n5,2\n6,1");
	assert.equal(tall.layout.orientation, "columns");
	assert.equal(tall.dataset.series.length, 2);
	assert.equal(tall.layout.header, false);
});

test("layout: a single line or a single column", () => {
	const row = read("0.1,0.5,0.9");
	assert.equal(row.dataset.series.length, 1);
	assert.equal(row.dataset.length, 3);
	const col = read("level\n1\n2\n3");
	assert.equal(col.dataset.series[0].name, "level");
	assert.equal(col.dataset.length, 3);
});

test("a swedish Excel export: semicolon, decimal comma, header", () => {
	const { opts, dataset } = read("Tid;Nivå\n0;0,5\n1;0,75\n2;1\n");
	assert.equal(opts.decimal, ",");
	assert.equal(dataset.series[0].name, "Nivå");
	assert.deepEqual([...dataset.series[0].filled], [0.5, 0.75, 1]);
});

test("transpose pads short lines", () => {
	assert.deepEqual(transpose([["a", "b", "c"], ["d"]]), [["a", "d"], ["b", ""], ["c", ""]]);
});

test("gaps are filled: between linearly, edges hold", () => {
	const { dataset } = read("a,b\n,1\n10,2\n,3\n30,4\n,5");
	assert.deepEqual([...dataset.series[0].filled], [10, 10, 20, 30, 30]);
});

test("a series with no numbers is left out", () => {
	const { dataset } = read("a,b,c\n1,x,3\n2,y,4");
	assert.deepEqual(dataset.series.map((s) => s.name), ["a", "c"]);
});

test("sampling: even spread, linear and step", () => {
	const { dataset } = read("v\n0\n10\n20");
	const s = dataset.series[0];
	assert.equal(sampleSeries(dataset, s, 0), 0);
	assert.equal(sampleSeries(dataset, s, 0.25), 5);
	assert.equal(sampleSeries(dataset, s, 0.5), 10);
	assert.equal(sampleSeries(dataset, s, 1), 20);
	assert.equal(sampleSeries(dataset, s, 0.25, "step"), 0);
	assert.equal(sampleSeries(dataset, s, 0.75, "step"), 10);
	assert.equal(sampleSeries(dataset, s, 2), 20);
	assert.equal(sampleSeries(dataset, s, -1), 0);
});

test("sampling with a time axis places values by time", () => {
	const { dataset } = read("time,v\n0,0\n1,10\n4,40");
	const s = dataset.series[0];
	assert.deepEqual([...dataset.xs], [0, 0.25, 1]);
	assert.equal(sampleSeries(dataset, s, 0.25), 10);
	assert.equal(sampleSeries(dataset, s, 0.625), 25);
});

test("normalize: range, clamping, invert, missing", () => {
	assert.equal(normalize(5, 0, 10), 0.5);
	assert.equal(normalize(20, 0, 10), 1);
	assert.equal(normalize(-3, 0, 10), 0);
	assert.equal(normalize(2.5, 0, 10, true), 0.75);
	assert.equal(normalize(5, 5, 5), 0);
	assert.equal(normalize(NaN, 0, 1), undefined);
});

test("waveform: few points give a line, many give min/max columns", () => {
	const few = read("v\n0\n10\n20").dataset;
	const line = waveformColumns(few, few.series[0], { start: 0, span: 1 }, 100, (v) => v / 20);
	assert.ok(line.points && line.points.length === 3);
	const rows = ["v"];
	for (let i = 0; i < 1000; i++) rows.push(String(i % 10));
	const many = read(rows.join("\n")).dataset;
	const cols = waveformColumns(many, many.series[0], { start: 0, span: 1 }, 50, (v) => v / 9);
	assert.ok(cols.lo && cols.hi && cols.lo.length === 50);
	assert.equal(cols.lo[10], 0);
	assert.equal(cols.hi[10], 1);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
