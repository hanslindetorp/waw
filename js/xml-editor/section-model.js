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

export function getStingers(sectionNode) {
	return sectionNode.children.filter((c) => c.tagName === "Stinger");
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

// A freshly-dropped audio file's new Segment gets a musically-rounded length
// rather than either a fixed 1 bar (too short/wrong for anything longer) or
// the file's raw decoded duration (essentially never bar-aligned):
// - A short "one-shot" sample (shorter than a full bar — a snare hit, a UI
//   blip) rounds to the nearest beat instead, with a one-beat minimum, so it
//   doesn't get force-stretched out to an almost-empty bar.
// - Anything a full bar or longer rounds DOWN to the bar at or before its
//   real end (never up) — the Segment's own `length` reflects only that
//   quantized amount, and audio past that point is left to render as a
//   visible tail past the Segment's own box (see wa-section-view.js) rather
//   than being folded into its length — with a one-bar minimum.
export function quantizeDroppedFileLength(durationSeconds, info) {
	if (durationSeconds < info.barDuration) {
		const beats = Math.max(1, Math.round(durationSeconds / info.beatDuration));
		return beats * info.beatDuration;
	}
	const bars = Math.max(1, Math.floor(durationSeconds / info.barDuration));
	return bars * info.barDuration;
}

// Inverse of parseDivision, for writing a computed duration (e.g. from
// quantizeDroppedFileLength) back into a `length` attribute — plain seconds
// is unambiguous and round-trips exactly via parseDivision's own "Xs" branch,
// without needing to reduce it to a bar-count/fraction.
export function secondsToLengthString(seconds) {
	return `${Math.round(seconds * 1000) / 1000}s`;
}

// null = no explicit length in the XML; caller falls back to decoded audio
// duration (for a bare layer src) or a placeholder width (for segment/option).
export function readLength(node, info) {
	if (node.attributes.length === undefined) return null;
	const seconds = parseDivision(node.attributes.length, info);
	return Number.isFinite(seconds) ? seconds : null;
}

// Layer looping (spec: <Layer loopLength="...">) — null means "doesn't loop"
// (attribute absent, "off", zero, or unparseable). This only reads the
// Layer's OWN attribute; see readEffectiveLoopLength below for the real,
// inheritance-aware value the schema actually intends.
export function readLoopLength(layerNode, info) {
	const raw = layerNode.attributes.loopLength;
	if (raw === undefined) return null;
	const seconds = parseDivision(raw, info);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// undefined = this element doesn't specify loopLength at all (keep looking
// up the chain); null = it specifies "off" (or something unparseable) —
// looping stops here, full stop, regardless of what any ancestor says.
function ownLoopLengthSeconds(node, info) {
	if (!node || node.attributes.loopLength === undefined) return undefined;
	const seconds = parseDivision(node.attributes.loopLength, info);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// loopLength inherits Composition -> Section -> Layer: "om t.ex.
// <Composition> har loopLength='4' får alla <Layer> utan eget
// loopLength-värde loopen inställd till fyra takter" — each level's own
// explicit value (including "off") wins outright over any ancestor's;
// only an actually-*missing* attribute falls through to the next one up.
// null = no loop is in effect anywhere in the chain.
export function readEffectiveLoopLength(layerNode, sectionNode, compositionNode, info) {
	const ownValue = ownLoopLengthSeconds(layerNode, info);
	if (ownValue !== undefined) return ownValue;
	const sectionValue = ownLoopLengthSeconds(sectionNode, info);
	if (sectionValue !== undefined) return sectionValue;
	const compositionValue = ownLoopLengthSeconds(compositionNode, info);
	if (compositionValue !== undefined) return compositionValue;
	return null;
}

// A sensible minimum timeline width (in seconds) so an empty/sparse section
// still shows a usable ruler — MIN_TOTAL_BARS bars at this section's own
// tempo/timeSign.
export function minimumTotalDuration(info) {
	return info.barDuration * MIN_TOTAL_BARS;
}

// A <Stinger> isn't placed on the Section's own timeline — it can trigger at
// any moment during live playback — but its `quantize` attribute (same
// grammar as length/loopLength: "bar", "beat", a bar count, or a fraction)
// says how far a trigger has to wait for the next musically-sound moment to
// actually start. For a static preview (per Hans), that's shown as "if
// triggered right at bar 1, where does it land": one quantize-unit's
// duration after bar 1 — quantize="bar" -> bar 2's start, quantize="beat" ->
// beat 2 of bar 1, quantize="1/8" -> the second eighth-note of bar 1, etc.
// Reusing parseDivision as-is already gives exactly that (one unit's own
// duration); an absent quantize is treated as "right at bar 1" (0), matching
// how every other missing division value in this app already defaults.
export function readStingerQuantizePosition(stingerNode, info) {
	return parseDivision(stingerNode.attributes.quantize, info);
}

// upbeat and pos both nudge a Stinger/Option away from its quantize point —
// upbeat always shifts earlier (negated, same convention waxml.js's own
// Part constructor uses: this.offset = delay || -upbeat || 0), pos shifts
// either way (parsePosition's own bar.beat.offbeat grammar, added as a
// delta here rather than used as an absolute position) — both apply
// together when both are set. Missing attributes contribute 0 from
// parseDivision/parsePosition's own existing defaults, so this needs no
// extra fallback handling of its own.
export function readStingerOffset(node, info) {
	return parsePosition(node.attributes.pos, info) - parseDivision(node.attributes.upbeat, info);
}
