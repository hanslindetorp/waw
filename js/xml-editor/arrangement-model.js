// Pure, read-only helpers for turning an <arrangement> XmlNode into what the
// arrangement view needs. Attribute names match the real engine (waxml.js's
// Music.js/MusicParser.js + schemas/waxml.xsd) — notably `timeSign`, not the
// `timeSignature` used in docs/WAXML-Workstation-spec.md's older example XML.
//
// IMPORTANT: pos/length/loopLength are NOT plain seconds. waxml.js's own
// divisionToTime()/getTimeSign() (Music.js) parse them as musical notation:
// a bare number is a bar COUNT (e.g. length="2" = 2 bars), "X/Y" is a
// fraction of a whole note (e.g. "3/8" = three eighth notes), "bar"/"beat"
// are literally one bar/beat, and an explicit real-time value can be given
// as "Xs" or "Xms". parseDivision() below mirrors that conversion so the
// graphics line up with what the engine will actually schedule.

const DEFAULT_TEMPO = 120;
const DEFAULT_TIME_SIGN = "4/4";
const MIN_TOTAL_BARS = 16;

export function readArrangementInfo(arrangementNode) {
	const attrs = arrangementNode.attributes;
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

export function getTracks(arrangementNode) {
	return arrangementNode.children.filter((c) => c.tagName === "track");
}

export function getRegions(trackNode) {
	return trackNode.children.filter((c) => c.tagName === "region");
}

export function getOptions(parentNode) {
	return parentNode.children.filter((c) => c.tagName === "option");
}

// Converts a pos/length/loopLength attribute value to seconds, mirroring
// waxml.js's divisionToTime()/getTimeSign() against this arrangement's own
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

export function readPos(node, info) {
	return parseDivision(node.attributes.pos, info);
}

// null = no explicit length in the XML; caller falls back to decoded audio
// duration (for a bare track src) or a placeholder width (for region/option).
export function readLength(node, info) {
	if (node.attributes.length === undefined) return null;
	const seconds = parseDivision(node.attributes.length, info);
	return Number.isFinite(seconds) ? seconds : null;
}

// Track looping (spec: <track loopLength="...">) — null means "doesn't loop"
// (attribute absent, "off", zero, or unparseable).
export function readLoopLength(trackNode, info) {
	const raw = trackNode.attributes.loopLength;
	if (raw === undefined) return null;
	const seconds = parseDivision(raw, info);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// A sensible minimum timeline width (in seconds) so an empty/sparse
// arrangement still shows a usable ruler — MIN_TOTAL_BARS bars at this
// arrangement's own tempo/timeSign.
export function minimumTotalDuration(info) {
	return info.barDuration * MIN_TOTAL_BARS;
}
