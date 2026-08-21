// Pure, read-only helpers for turning a <Section> XmlNode into what the
// section view needs. Attribute names match the real engine (waxml.js's
// Music.js/MusicParser.js + schemas/waxml.xsd) — notably `timeSign`, not the
// `timeSignature` used in docs/WAXML-Workstation-spec.md's older example XML.
//
// Element names match the current schema exactly, including case: Section
// (was "arrangement", then lowercase "section"), Layer (was "track", then
// "layer"), Segment (was "region", then "segment"). Option/Command are
// unchanged apart from the same lowercase->PascalCase schema-wide rename.
//
// IMPORTANT: pos/length/loopLength are NOT plain seconds, and — easy to miss
// — pos uses a DIFFERENT notation than length/loopLength do:
// - length/loopLength/upbeat/delay/changeOnNext/partLength/quantize go
//   through parseDivision() below, mirroring waxml.js's divisionToTime()/
//   getTimeSign(): a bare number is a bar COUNT (length="2" = 2 bars), "X/Y"
//   is a fraction of a whole note ("3/8" = three eighth notes), "bar"/"beat"
//   are literally one bar/beat, and an explicit real-time value can be given
//   as "Xs" or "Xms".
// - pos (on Segment/Option/Command) goes through parsePosition() below
//   instead, mirroring waxml.js's own separate musicalPositionToTime(): a
//   1-indexed "bar.beat.offbeat" notation (e.g. "4.4.75" = bar 4, beat 4,
//   75% through that beat), NOT a bar-count/fraction/unit value.

const DEFAULT_TEMPO = 120;
const DEFAULT_TIME_SIGN = "4/4";
const MIN_TOTAL_BARS = 16;

export function readSectionInfo(sectionNode) {
	const attrs = sectionNode.attributes;
	const tempo = parseFloat(attrs.tempo);
	const timeSign = parseTimeSign(attrs.timeSign);
	const beatDuration = 60 / (Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_TEMPO);
	const barDuration = beatDuration * timeSign.numerator;
	return {
		tempo: Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_TEMPO,
		timeSign,
		beatDuration,
		barDuration,
		id: attrs.id || "",
		className: attrs.class || ""
	};
}

function parseTimeSign(value) {
	const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value || "").trim());
	if (!match) return { numerator: 4, denominator: 4, label: DEFAULT_TIME_SIGN };
	return { numerator: parseInt(match[1], 10), denominator: parseInt(match[2], 10), label: `${match[1]}/${match[2]}` };
}

export function getLayers(sectionNode) {
	return sectionNode.children.filter((c) => c.tagName === "Layer");
}

export function getSegments(layerNode) {
	return layerNode.children.filter((c) => c.tagName === "Segment");
}

export function getOptions(parentNode) {
	return parentNode.children.filter((c) => c.tagName === "Option");
}

// Converts a pos/length/loopLength attribute value to seconds, mirroring
// waxml.js's divisionToTime()/getTimeSign() against this section's own
// tempo/timeSign. Returns 0 for missing/empty values (matching divisionToTime's
// own `if(!div) return 0`), Infinity for "off" (its "never" sentinel, used for
// e.g. loopLength="off" to mean "don't loop").
export function parseDivision(value, info) {
	if (value === undefined || value === null || value === "") return 0;
	if (typeof value === "number") return value;

	const str = String(value).trim();
	if (str === "off") return Infinity;

	if (/ms$/i.test(str)) {
		// Mirrors the engine's own "ms" branch, which multiplies by 1000
		// instead of dividing — almost certainly a bug in waxml.js (worth
		// confirming with Hans), but matched here so the graphics represent
		// what the engine will actually schedule rather than what "should"
		// happen.
		return parseFloat(str) * 1000;
	}
	if (/s$/i.test(str)) {
		return parseFloat(str);
	}

	const fraction = resolveDivisionFraction(str, info.timeSign);
	return (fraction.numerator * info.beatDuration) / (fraction.denominator / info.timeSign.denominator);
}

function resolveDivisionFraction(str, timeSign) {
	if (str === "bar") return { numerator: timeSign.numerator, denominator: timeSign.denominator };
	if (str === "beat") return { numerator: 1, denominator: timeSign.denominator };

	const parts = str.split("/");
	if (parts.length >= 2) {
		return { numerator: parseFloat(parts[0]), denominator: parseFloat(parts[1]) };
	}
	// A bare number (no "/") is a count of whole bars.
	const bars = parseFloat(parts[0]) || 0;
	return { numerator: bars * timeSign.numerator, denominator: timeSign.denominator };
}

// `pos` on Segment/Option/Command is NOT a length/loopLength-style value —
// waxml.js parses it with its own separate musicalPositionToTime()/
// posStringToObject() (Music.js, confirmed via Part construction at
// `curPos = this.musicalPositionToTime(o.pos)`), a 1-indexed
// "bar.beat.offbeat" notation (e.g. "4.4.75" = bar 4, beat 4, 75% through
// that beat) — completely different from length's bar-count/fraction/
// explicit-unit grammar. A bare bar number defaults beat=1, offbeat=0, so
// "4" alone means "the very start of bar 4". Reimplemented here rather than
// calling into waxml.js's own posStringToObject() because that function
// uses eval() on each segment.
export function parsePosition(value, info) {
	if (value === undefined || value === null || value === "") return 0;
	if (typeof value === "number") return value;

	const str = String(value).trim();
	if (str === "off") return Infinity;

	const delimiter = str.includes(",") ? "," : ".";
	const parts = str.split(delimiter);
	const bar = parts[0] !== undefined && parts[0] !== "" ? parseFloat(parts[0]) : 1;
	const beat = parts[1] !== undefined && parts[1] !== "" ? parseFloat(parts[1]) : 1;
	const offBeat = parts[2] !== undefined && parts[2] !== "" ? parseFloat(`0.${parts[2]}`) : 0;
	if (!Number.isFinite(bar)) return 0;

	return info.barDuration * (bar - 1) + info.beatDuration * ((Number.isFinite(beat) ? beat : 1) - 1) + info.beatDuration * (Number.isFinite(offBeat) ? offBeat : 0);
}

export function readPos(node, info) {
	return parsePosition(node.attributes.pos, info);
}

// Inverse of parsePosition/readPos — used when a drag-and-drop interaction
// needs to write a *new* pos value from a pixel/time position. Quantizes to
// the nearest `gridBeats`-beat grid first (default 1 beat, i.e. a quarter
// note the way this engine defines a beat — see readSectionInfo/tempo:
// beatDuration is always 60/tempo regardless of the meter's denominator),
// then formats as the same 1-indexed "bar.beat.00" string musicalPositionToTime
// reads back correctly.
export function secondsToPosString(seconds, info, gridBeats = 1) {
	const beatIndex = Math.round(seconds / info.beatDuration / gridBeats) * gridBeats;
	const barIndex0 = Math.floor(beatIndex / info.timeSign.numerator);
	const beatInBar0 = beatIndex - barIndex0 * info.timeSign.numerator;
	return `${barIndex0 + 1}.${beatInBar0 + 1}.00`;
}

// null = no explicit length in the XML; caller falls back to decoded audio
// duration (for a bare layer src) or a placeholder width (for segment/option).
export function readLength(node, info) {
	if (node.attributes.length === undefined) return null;
	const seconds = parseDivision(node.attributes.length, info);
	return Number.isFinite(seconds) ? seconds : null;
}

// Layer looping (spec: <Layer loopLength="...">) — null means "doesn't loop"
// (attribute absent, "off", zero, or unparseable).
export function readLoopLength(layerNode, info) {
	const raw = layerNode.attributes.loopLength;
	if (raw === undefined) return null;
	const seconds = parseDivision(raw, info);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// A sensible minimum timeline width (in seconds) so an empty/sparse section
// still shows a usable ruler — MIN_TOTAL_BARS bars at this section's own
// tempo/timeSign.
export function minimumTotalDuration(info) {
	return info.barDuration * MIN_TOTAL_BARS;
}
