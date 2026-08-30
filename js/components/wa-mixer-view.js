import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { playerStore } from "../waxml-integration/player-store.js";

// Analog-mixer-style channel-strip view for a <Mixer> element (styled after
// an Allen & Heath-style hardware desk, per Hans). Every direct child of
// <Mixer> gets its own channel strip; the "+" strip at the end creates a
// fresh <Chain id="MixChan-N"> with the default shape a channel strip is
// built around: N BiquadFilterNodes (EQ, rendered top-down in XML order),
// inserts (<Wam>), sends (<Send>), a StereoPannerNode, and a GainNode.
// Everything reads/writes straight through xmlStore, same pattern as
// wa-section-view.js, so the XML tree/code panels stay in sync for free.
//
// <Mixer> only ever appears at the document root or nested inside another
// Mixer/Chain (schema doesn't allow it inside <Section>/<Composition>).

// A GainNode/BiquadFilterNode's `gain` attribute (schema type "gain") is
// either a 0-1 linear ratio or a "-XdB"/"XdB" string. We always *write* the
// dB form (unambiguous for either node type), but need to *read* either
// form back for knob/fader positioning.
function gainToDb(rawValue) {
	if (rawValue === undefined || rawValue === null || rawValue === "") return 0;
	const str = String(rawValue).trim();
	const dbMatch = /^(-?\d+(\.\d+)?)dB$/i.exec(str);
	if (dbMatch) return parseFloat(dbMatch[1]);
	const num = parseFloat(str);
	if (Number.isFinite(num)) return num <= 0 ? -Infinity : 20 * Math.log10(num);
	return 0; // a mathExpression or unparseable value — fall back to unity for display
}

function dbToGainAttr(db) {
	if (!(db > FADER_MIN_DB)) return "0";
	return `${Math.round(db * 10) / 10}dB`;
}

function dbToLinear(db) {
	if (!(db > FADER_MIN_DB)) return 0;
	return Math.pow(10, db / 20);
}

// Applies a value directly to a node's *live* waxml object, if one exists
// right now (i.e. playback is running and this node survived into the
// currently-loaded engine graph) — no engine reload, an immediate,
// click-free change via waxml's own setTargetAtTime-backed property
// setters (confirmed in waxml.js: `set gain(val){ this.setTargetAtTime(...) }`
// etc.), per the design discussed with Hans. A no-op whenever nothing's
// playing — xmlStore is always the source of truth; this is purely a
// "also nudge the currently-sounding audio to match" side channel.
function applyLiveProperty(nodeId, propName, value) {
	if (!playerStore.isPlaying || !nodeId) return;
	let liveObj;
	try {
		const matches = playerStore.getLiveObjects(`[id='${nodeId}']`);
		liveObj = matches && matches[0];
	} catch {
		liveObj = null;
	}
	if (!liveObj) return;
	try {
		liveObj[propName] = value;
	} catch {
		// A property this node type doesn't actually support (e.g. the node
		// wasn't the shape we expected) — not worth surfacing, the XML
		// attribute is still the source of truth and already updated.
	}
}

// gain is special-cased: GainNode.gain is a linear multiplier, but
// BiquadFilterNode.gain (and Send, which routes through its own bus) is
// native dB already in Web Audio — same nuance as dbToGainAttr's own XML
// string form, just resolved against the live AudioParam's own unit
// instead of the schema's flexible "0-1 or XdB" attribute grammar.
function applyLiveGainDb(nodeId, db, isLinearGainNode) {
	applyLiveProperty(nodeId, "gain", isLinearGainNode ? dbToLinear(db) : db);
}

function readPan(node) {
	const num = parseFloat(node.attributes.pan);
	return Number.isFinite(num) ? Math.max(-1, Math.min(1, num)) : 0;
}

function displayLabel(node) {
	if (node.attributes.label) return node.attributes.label;
	if (node.attributes.id) return node.attributes.id;
	return node.tagName;
}

// Fader taper: 0dB sits at FADER_ZERO_DB_POS up the track (a typical mixer
// convention — the top portion is a small +dB boost range, the much larger
// bottom portion tapers down to silence), not a plain linear dB scale.
const FADER_MAX_DB = 9;
const FADER_MIN_DB = -60; // practical floor before snapping to true silence (gain="0")
const FADER_ZERO_DB_POS = 0.75;
const FADER_TICKS_DB = [9, 0, -6, -12, -24, -48];

// VU meter: peak amplitude -> dB -> 0-1 fill, same "quick attack, slow
// release" idea as a real VU ballistics/waxml's own Meter class (see
// waxml.js's drawLoudness) — jumps up instantly on a transient, decays
// gradually so it's readable instead of flickering every frame.
const VU_MIN_DB = -48;
const VU_MAX_DB = 0;
const VU_RELEASE = 0.85;

function dbToFaderPosition(db) {
	if (!(db > FADER_MIN_DB)) return 0;
	if (db >= 0) return FADER_ZERO_DB_POS + (Math.min(db, FADER_MAX_DB) / FADER_MAX_DB) * (1 - FADER_ZERO_DB_POS);
	return (1 - db / FADER_MIN_DB) * FADER_ZERO_DB_POS;
}

function faderPositionToDb(t) {
	if (t <= 0) return -Infinity;
	if (t >= FADER_ZERO_DB_POS) return ((t - FADER_ZERO_DB_POS) / (1 - FADER_ZERO_DB_POS)) * FADER_MAX_DB;
	return FADER_MIN_DB * (1 - t / FADER_ZERO_DB_POS);
}

// Frequency knob: 40Hz-10kHz, logarithmic (equal knob rotation per octave).
// Knob drags happen in "t" space (0-1 = one full octave-log sweep) via the
// shared _wireVerticalDrag helper, converting to/from Hz only at the edges.
const FREQ_MIN = 40;
const FREQ_MAX = 10000;
const FREQ_OCTAVES = Math.log2(FREQ_MAX / FREQ_MIN);

function readFrequency(node) {
	const num = parseFloat(node.attributes.frequency);
	return Number.isFinite(num) ? Math.max(FREQ_MIN, Math.min(FREQ_MAX, num)) : 1000;
}

function freqToKnobT(freq) {
	return Math.log2(freq / FREQ_MIN) / FREQ_OCTAVES;
}

function knobTToFreq(t) {
	return FREQ_MIN * Math.pow(2, Math.max(0, Math.min(1, t)) * FREQ_OCTAVES);
}

// Q: same 0-100 range the XML editor's own Inspector uses (schema type "Q").
const Q_MIN = 0;
const Q_MAX = 100;

function readQ(node) {
	const num = parseFloat(node.attributes.Q);
	return Number.isFinite(num) ? Math.max(Q_MIN, Math.min(Q_MAX, num)) : 1;
}

const EQ_MIN_DB = -15;
const EQ_MAX_DB = 15;
const FADER_TRACK_HEIGHT = 150;
const KNOB_PX_PER_RANGE = 160; // dragging this many px sweeps a knob's full range
// Fixed, shared-across-all-channels section heights — the filter section's
// height is dynamic (tallest channel's filter count sets it for everyone),
// insert/send are simply fixed and scroll internally if content overflows.
// Filter rows got taller here specifically to fit the gain+freq+Q knob
// cluster plus the type dropdown below it without spilling into the row
// below (the "knobsen ligger på varandra" bug Hans reported) — 2 stacked
// 18px knobs with a gap alone need ~41px, plus the dropdown and row gap.
const FILTER_ROW_HEIGHT = 66;
const INSERT_SECTION_HEIGHT = 90; // more room for EQ/inserts
const SEND_SECTION_HEIGHT = 56; // less room for sends, per Hans
// Fixed heights for the bottom-group's own rows (pan/fader/solo) — every
// channel type (VU-only, Pan+Vol+VU, full) reserves the exact same space
// for each row via a spacer when it doesn't have a real control there, so
// the solo-button row (and everything below it) stays aligned across
// mixed channel types.
const PAN_ROW_HEIGHT = 40;
const FADER_ROW_HEIGHT = FADER_TRACK_HEIGHT + 20;
const SOLO_ROW_HEIGHT = 32;
const TRANSITION_TIME_MAX_MS = 1000; // the mini-slider's own range, per Hans (schema itself allows up to 2000)
const DEFAULT_TRANSITION_TIME_MS = 200; // fallback when no live Mixer object and no explicit attribute exist yet

const QUANTIZE_OPTIONS = [
	{ value: "", label: "Off" },
	{ value: "bar", label: "Bar" },
	{ value: "beat", label: "Beat" },
	{ value: "1/8", label: "1/8" },
	{ value: "1/16", label: "1/16" }
];

// Standard schema fallback for BiquadFilterNode's `type` enum (used only if
// the schema hasn't loaded for some reason) — the real list is always read
// live from xmlStore.schema, same source the XML editor's own Inspector
// uses, so the two never drift apart.
const BIQUAD_TYPE_FALLBACK = ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"];

function getBiquadTypeOptions() {
	const attr = xmlStore.schema?.elements?.BiquadFilterNode?.allowedAttributes?.find((a) => a.name === "type");
	return attr?.enumValues?.length ? attr.enumValues : BIQUAD_TYPE_FALLBACK;
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			font: 0.75rem/1.3 system-ui, sans-serif;
			background: linear-gradient(180deg, #4b5560, #3c4650);
			color: #e8ecef;
			user-select: none;
		}
		.mixer {
			display: flex;
			flex-direction: column;
			height: 100%;
		}
		.mixer-body {
			flex: 1 1 auto;
			display: flex;
			align-items: stretch;
			min-height: 0;
			border-bottom: 1px solid #232830;
		}
		.row-labels {
			display: flex;
			flex-direction: column;
			align-items: center;
			flex: 0 0 auto;
			width: 28px;
			padding: 0.5rem 0 0.5rem 0.2rem;
			color: #aab2ba;
			font-size: 0.6rem;
			letter-spacing: 0.04em;
		}
		.row-label {
			display: flex;
			align-items: center;
			justify-content: center;
			flex: 0 0 auto;
			writing-mode: vertical-rl;
			text-orientation: mixed;
			transform: rotate(180deg); /* reads bottom-to-top, per Hans */
		}
		.row-label-bottom {
			margin-top: auto;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.4rem;
			padding-bottom: 0.6rem;
		}
		.row-label-bottom .row-label {
			writing-mode: horizontal-tb;
			transform: none;
		}
		.channels-scroll {
			flex: 1 1 auto;
			overflow-x: auto;
			overflow-y: hidden;
		}
		.channels {
			display: flex;
			align-items: stretch;
			height: 100%;
			width: max-content;
		}
		.channel-strip {
			display: flex;
			flex-direction: column;
			align-items: center;
			width: 96px;
			flex: 0 0 auto;
			height: 100%;
			padding: 0.5rem 0.3rem 0.6rem;
			border-right: 1px solid #2b313a;
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(0, 0, 0, 0.08));
			box-sizing: border-box;
		}
		.other-node {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.7rem;
			color: #aab2ba;
			padding: 0.5rem 0;
		}
		.filter-section {
			display: flex;
			flex-direction: column;
			width: 100%;
			flex: 0 0 auto;
		}
		.filter-row {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.15rem;
			width: 100%;
			box-sizing: border-box;
		}
		.filter-row-top {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 0.3rem;
		}
		.filter-small-knobs {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}
		.filter-type-select {
			width: 100%;
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			color: #cdd3d8;
			font-size: 0.5rem;
			border-radius: 2px;
			padding: 0.05rem 0.1rem;
		}
		.knob-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.1rem;
			position: relative;
		}
		.knob {
			width: 26px;
			height: 26px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #52565c, #17191c 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
			position: relative;
			cursor: ns-resize;
			touch-action: none;
			z-index: 1;
		}
		/* Color-coded per Hans, matching the reference photo: blue for gain,
		   gray for frequency, black for Q. */
		.knob-large.knob-gain {
			width: 32px;
			height: 32px;
			background: radial-gradient(circle at 35% 30%, #3f7fb5, #123049 72%);
			border-color: #0a1a26;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.2), 0 0 0 1px #2f6a94;
		}
		.knob-small.knob-freq {
			width: 18px;
			height: 18px;
			background: radial-gradient(circle at 35% 30%, #7c828a, #3a3d41 72%);
			border-color: #1c1e20;
		}
		.knob-small.knob-q {
			width: 18px;
			height: 18px;
			background: radial-gradient(circle at 35% 30%, #303234, #060707 72%);
			border-color: #000;
		}
		.knob.pan-knob {
			background: radial-gradient(circle at 35% 30%, #d15a5a, #4a0f0f 72%);
			border-color: #300a0a;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.2), 0 0 0 1px #9c2c2c;
		}
		.knob:hover {
			filter: brightness(1.2);
		}
		.knob-dial {
			position: absolute;
			left: 50%;
			top: 2px;
			width: 2px;
			height: 45%;
			margin-left: -1px;
			background: #f2f2f2;
			border-radius: 1px;
			transform-origin: center bottom;
			z-index: 1;
		}
		/* Small white tick marks printed around a knob's rotational range —
		   purely decorative, positioned by JS (see _buildKnobTicks) since a
		   pure-CSS radial arrangement of discrete ticks isn't practical. */
		.knob-ticks {
			position: absolute;
			pointer-events: none;
		}
		.knob-tick {
			position: absolute;
			width: 1px;
			height: 3px;
			background: #f5f5f5;
			opacity: 0.85;
		}
		.knob-label {
			font-size: 0.55rem;
			color: #aab2ba;
			letter-spacing: 0.03em;
		}
		.filter-type-label {
			font-size: 0.5rem;
			color: #aab2ba;
			width: 14px;
			text-align: center;
			line-height: 1.1;
		}
		.insert-section,
		.sends-section {
			display: flex;
			flex-direction: column;
			gap: 0.2rem;
			width: 100%;
			padding: 0.25rem 0;
			overflow-y: auto;
			flex: 0 0 auto;
			box-sizing: border-box;
		}
		.section-divider {
			width: 100%;
			height: 1px;
			background: #232830;
			flex: 0 0 auto;
		}
		.insert-slot {
			font-size: 0.65rem;
			text-align: center;
			padding: 0.2rem 0.1rem;
			border-radius: 3px;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;
			flex: 0 0 auto;
		}
		.insert-slot.filled {
			background: rgba(69, 181, 140, 0.14);
			border: 1px solid var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
			cursor: default;
		}
		.insert-slot.empty {
			border: 1px dashed #5a636d;
			color: #aab2ba;
		}
		.insert-slot.empty:hover {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.send-row {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.15rem;
			padding: 0.2rem 0;
			border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
			flex: 0 0 auto;
		}
		.send-row:last-child {
			border-bottom: none;
		}
		.send-row.add-send {
			cursor: pointer;
			color: #aab2ba;
			font-size: 0.85rem;
			border: 1px dashed #5a636d;
			border-radius: 3px;
		}
		.send-row.add-send:hover {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.send-bus-input {
			width: 100%;
			box-sizing: border-box;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			color: inherit;
			font-size: 0.6rem;
			border-radius: 3px;
			padding: 0.1rem 0.2rem;
			text-align: center;
		}
		.pre-post-btn {
			background: #24272c;
			border: 1px solid #0b0c0d;
			color: #aab2ba;
			font-size: 0.6rem;
			border-radius: 3px;
			padding: 0.05rem 0.3rem;
			cursor: pointer;
			letter-spacing: 0.03em;
		}
		.pre-post-btn:hover {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.bottom-group {
			margin-top: auto;
			display: flex;
			flex-direction: column;
			align-items: center;
			width: 100%;
			flex: 0 0 auto;
		}
		.fader-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			padding: 0.4rem 0;
		}
		.fader-wrap.disabled {
			opacity: 0.3;
		}
		.fader-row {
			display: flex;
			align-items: flex-end;
			gap: 0.4rem;
		}
		.fader-track {
			position: relative;
			width: 10px;
			background: #1c1f24;
			border: 1px solid #0b0c0d;
			border-radius: 3px;
			box-shadow: inset 0 0 3px rgba(0, 0, 0, 0.8);
			margin: 0 0.8rem;
		}
		.fader-tick {
			position: absolute;
			left: -3px;
			width: 16px;
			height: 1px;
			background: #5a636d;
		}
		.fader-tick.zero {
			background: #c9cfd4;
		}
		.fader-tick span {
			position: absolute;
			left: 18px;
			top: -5px;
			font-size: 0.55rem;
			color: #aab2ba;
			white-space: nowrap;
		}
		.fader-handle {
			position: absolute;
			left: 50%;
			bottom: 0;
			width: 32px;
			height: 16px;
			margin-left: -16px;
			margin-bottom: -8px;
			background: linear-gradient(180deg, #e3e7ea, #9aa2a9 45%, #6b7278 50%, #9aa2a9 55%, #e3e7ea);
			border: 1px solid #26292d;
			border-radius: 3px;
			box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
			cursor: ns-resize;
			touch-action: none;
		}
		.fader-handle::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			top: 50%;
			height: 2px;
			margin-top: -1px;
			background: #c0392b;
		}
		.vu-meter {
			position: relative;
			width: 6px;
			border-radius: 2px;
			background: #101214;
			border: 1px solid #0b0c0d;
			overflow: hidden;
		}
		.vu-fill {
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			background: linear-gradient(to top, #3ecf5e 0%, #3ecf5e 65%, #e8d34d 65%, #e8d34d 88%, #e5484d 88%, #e5484d 100%);
			background-repeat: no-repeat;
			background-position: bottom;
		}
		.channel-label {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.65rem;
			text-align: center;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			width: 100%;
			color: #e8ecef;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			border-radius: 3px;
			padding: 0.15rem 0.2rem;
			box-sizing: border-box;
			margin-top: 0.3rem;
		}
		.add-channel-strip {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			flex: 0 0 auto;
			font-size: 1.4rem;
			color: #aab2ba;
			cursor: pointer;
			border-right: 1px solid #2b313a;
		}
		.add-channel-strip:hover {
			color: var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.08);
		}
		.add-channel-wrap {
			position: relative;
			flex: 0 0 auto;
		}
		.channel-type-menu {
			position: absolute;
			left: 0;
			top: 0;
			z-index: 10;
			background: #24272c;
			border: 1px solid #0b0c0d;
			border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
			min-width: 10rem;
			padding: 0.25rem;
		}
		.channel-type-option {
			display: block;
			width: 100%;
			text-align: left;
			background: none;
			border: none;
			color: inherit;
			font: inherit;
			font-size: 0.7rem;
			padding: 0.35rem 0.5rem;
			border-radius: 3px;
			cursor: pointer;
			white-space: nowrap;
		}
		.channel-type-option:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.meta-column {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: flex-end;
			flex: 0 0 auto;
			width: 60px;
			height: 100%;
			padding: 0.5rem 0.3rem 0.6rem;
			box-sizing: border-box;
			border-left: 1px solid #2b313a;
		}
		.mini-sliders {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.3rem;
			height: ${SOLO_ROW_HEIGHT}px;
			width: 100%;
			box-sizing: border-box;
		}
		.mini-slider-row {
			display: flex;
			align-items: center;
			gap: 0.2rem;
			width: 100%;
		}
		.mini-slider-label {
			font-size: 0.5rem;
			color: #aab2ba;
			width: 14px;
			flex: 0 0 auto;
		}
		.mini-slider {
			flex: 1 1 auto;
			width: 100%;
			height: 4px;
			-webkit-appearance: none;
			appearance: none;
			background: #1c1f24;
			border: 1px solid #0b0c0d;
			border-radius: 2px;
		}
		.mini-slider::-webkit-slider-thumb {
			-webkit-appearance: none;
			appearance: none;
			width: 8px;
			height: 12px;
			background: linear-gradient(180deg, #e3e7ea, #9aa2a9);
			border: 1px solid #26292d;
			border-radius: 2px;
			cursor: pointer;
		}
		.pan-row,
		.fader-row-wrap,
		.solo-row {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 100%;
			flex: 0 0 auto;
			box-sizing: border-box;
		}
		.solo-btn {
			width: 20px;
			height: 20px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #3a1414, #1a0808 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
			cursor: pointer;
			padding: 0;
			transition: background 0.15s ease-out, box-shadow 0.15s ease-out;
		}
		.solo-btn:hover {
			border-color: #e5484d;
		}
		.bottom-row {
			flex: 0 0 auto;
			display: flex;
			align-items: stretch;
			border-bottom: 1px solid #232830;
		}
		.row-labels-spacer {
			flex: 0 0 auto;
			width: 28px;
		}
		.solo-slider-area {
			flex: 1 1 auto;
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.4rem 0.6rem;
			min-width: 0;
		}
		.solo-slider-minmax {
			font-size: 0.6rem;
			color: #aab2ba;
			flex: 0 0 auto;
		}
		.solo-slider-track {
			position: relative;
			flex: 1 1 auto;
			height: 10px;
			background: #1c1f24;
			border: 1px solid #0b0c0d;
			border-radius: 3px;
			box-shadow: inset 0 0 3px rgba(0, 0, 0, 0.8);
			min-width: 20px;
		}
		.solo-slider-handle {
			position: absolute;
			top: 50%;
			left: 0;
			width: 16px;
			height: 32px;
			margin-top: -16px;
			margin-left: -8px;
			background: linear-gradient(90deg, #e3e7ea, #9aa2a9 45%, #6b7278 50%, #9aa2a9 55%, #e3e7ea);
			border: 1px solid #26292d;
			border-radius: 3px;
			box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
			cursor: ew-resize;
			touch-action: none;
			opacity: 0.35;
			transition: opacity 0.15s ease-out, left 0.2s ease-out;
		}
		.solo-slider-handle.active {
			opacity: 1;
		}
		.solo-slider-handle::after {
			content: "";
			position: absolute;
			top: 0;
			bottom: 0;
			left: 50%;
			width: 2px;
			margin-left: -1px;
			background: #c0392b;
		}
		.solo-slider-handle.standby {
			animation: solo-standby-blink 0.6s ease-in-out infinite;
		}
		@keyframes solo-standby-blink {
			0%, 100% { box-shadow: 0 0 0 2px rgba(232, 211, 77, 0.9); }
			50% { box-shadow: 0 0 0 2px rgba(232, 211, 77, 0.15); }
		}
		.quantize-select {
			flex: 0 0 auto;
			align-self: center;
			margin-right: 0.6rem;
			background: #1a1c1f;
			border: 1px solid #0b0c0d;
			color: inherit;
			font-size: 0.7rem;
			border-radius: 4px;
			padding: 0.2rem 0.4rem;
		}
		.transport-hint {
			flex: 0 0 auto;
			padding: 0.35rem 0.6rem;
			border-bottom: 1px solid #232830;
			color: #aab2ba;
			font-size: 0.65rem;
		}
	</style>
	<div class="mixer">
		<div class="transport-hint">Use the global Play/Stop in the header — VU meters need it playing (and real audio routed into this Mixer) to show a live level</div>
		<div class="mixer-body">
			<div class="row-labels">
				<div class="row-label eq-label">EQ</div>
				<div class="row-label ins-label">Ins</div>
				<div class="row-label send-label">Send</div>
				<div class="row-label-bottom">
					<div class="row-label pan-label">Pan</div>
					<div class="row-label vol-label">Vol</div>
					<div class="row-label solo-label">Solo</div>
				</div>
			</div>
			<div class="channels-scroll">
				<div class="channels"></div>
			</div>
			<div class="meta-column">
				<div class="mini-sliders">
					<div class="mini-slider-row">
						<span class="mini-slider-label">Bl</span>
						<input type="range" class="mini-slider blend-slider" min="0" max="1" step="0.01" value="0.1" title="Blend" />
					</div>
					<div class="mini-slider-row">
						<span class="mini-slider-label">Tr</span>
						<input type="range" class="mini-slider transition-slider" min="0" max="1000" step="1" value="200" title="Transition time (ms)" />
					</div>
				</div>
			</div>
		</div>
		<div class="bottom-row">
			<div class="row-labels-spacer"></div>
			<div class="solo-slider-area">
				<span class="solo-slider-minmax">0%</span>
				<div class="solo-slider-track">
					<div class="solo-slider-handle"></div>
				</div>
				<span class="solo-slider-minmax">100%</span>
			</div>
			<select class="quantize-select"></select>
		</div>
	</div>
`;

export class WaMixerView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._channels = this.shadowRoot.querySelector(".channels");
		this._channelsScroll = this.shadowRoot.querySelector(".channels-scroll");
		this._eqLabel = this.shadowRoot.querySelector(".eq-label");
		this._insLabel = this.shadowRoot.querySelector(".ins-label");
		this._sendLabel = this.shadowRoot.querySelector(".send-label");
		this._soloSliderArea = this.shadowRoot.querySelector(".solo-slider-area");
		this._soloTrack = this.shadowRoot.querySelector(".solo-slider-track");
		this._soloHandle = this.shadowRoot.querySelector(".solo-slider-handle");
		this._quantizeSelect = this.shadowRoot.querySelector(".quantize-select");
		this._blendSlider = this.shadowRoot.querySelector(".blend-slider");
		this._transitionSlider = this.shadowRoot.querySelector(".transition-slider");
		this._activeMixerId = null;
		this._liveMixerObj = null; // the live waxml Mixer object currently wired for "update"-event standby-clearing, per Hans's addEventListener("update") proposal
		this._liveMixerUpdateHandler = null;
		this._meterState = new Map(); // chainId (internal tree id) -> {analyser, dataArray, vuFillEl, smoothedT}
		this._meterRafId = null;
		this._onStoreChange = this._onStoreChange.bind(this);
		this._onPlayerStoreChange = this._onPlayerStoreChange.bind(this);
		this._buildQuantizeOptions();
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		playerStore.addEventListener("change", this._onPlayerStoreChange);
		this._wireSoloSliderDrag();
		this._quantizeSelect.addEventListener("change", () => this._handleQuantizeChange());
		this._blendSlider.addEventListener("input", () => this._handleBlendInput());
		this._transitionSlider.addEventListener("input", () => this._handleTransitionInput());
		this._channelsScroll.addEventListener("scroll", () => this._updateSoloSliderGeometry());
		// A panel resize (splitter drag, window resize) changes which
		// channels are visible without firing a "scroll" event.
		this._resizeObserver = new ResizeObserver(() => this._updateSoloSliderGeometry());
		this._resizeObserver.observe(this._channelsScroll);
		this._onStoreChange();
		this._onPlayerStoreChange();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onStoreChange);
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
		this._stopMeterLoop();
		this._disconnectMeters();
		this._unwireMixerUpdateListener();
		this._resizeObserver?.disconnect();
	}

	// --- live metering, driven by the global player (see player-store.js) ---
	// A <Mixer> has no audio source of its own (it's a processing graph —
	// EQ/pan/gain — not something that "trigs") and no Play/Stop of its
	// own any more, per Hans — Play/Stop is global, in the app header. Once
	// *anything* is playing, this Mixer's own Chains exist in that same
	// loaded graph regardless of what triggered it, so meters connect
	// whenever playerStore.isPlaying goes true. Whether anything audible is
	// actually flowing through a given Chain depends on real content being
	// routed in elsewhere (via input=/output= selectors) — the meters will
	// correctly show silence otherwise, which is accurate, not broken.
	_onPlayerStoreChange() {
		if (playerStore.isPlaying) {
			const node = this._activeMixerId ? ops.findNodeById(xmlStore.root, this._activeMixerId) : null;
			if (node) {
				this._connectMeters(node);
				this._attachMeterElements();
				this._wireMixerUpdateListener(node);
			}
			this._startMeterLoop();
		} else {
			this._stopMeterLoop();
			this._disconnectMeters();
			this._unwireMixerUpdateListener();
			this.shadowRoot.querySelectorAll(".vu-fill").forEach((el) => {
				el.style.height = "0%";
			});
			this.shadowRoot.querySelectorAll(".solo-btn").forEach((btn) => {
				btn.style.filter = "";
				btn.style.boxShadow = "";
			});
		}
	}

	// Per Hans's proposal: listen for the "update" event on the live Mixer
	// object to know when a quantize-gated solo change has actually taken
	// effect, so the standby blink can clear. Idiomatic given AudioObject
	// extends EventTarget and already dispatches "change"/similar events
	// elsewhere in waxml.js (e.g. `set mix`) — same pattern, different event
	// name. Re-wires whenever the live object identity changes (e.g. after a
	// structural rebuild) and is a no-op if nothing's playing yet.
	_wireMixerUpdateListener(mixerNode) {
		if (!playerStore.isPlaying || !mixerNode?.attributes.id) return;
		let liveObj;
		try {
			const matches = playerStore.getLiveObjects(`[id='${mixerNode.attributes.id}']`);
			liveObj = matches && matches[0];
		} catch {
			liveObj = null;
		}
		if (!liveObj || typeof liveObj.addEventListener !== "function") return;
		if (this._liveMixerObj === liveObj) return;
		this._unwireMixerUpdateListener();
		this._liveMixerObj = liveObj;
		this._liveMixerUpdateHandler = () => this._soloHandle.classList.remove("standby");
		liveObj.addEventListener("update", this._liveMixerUpdateHandler);
	}

	_unwireMixerUpdateListener() {
		if (this._liveMixerObj && this._liveMixerUpdateHandler) {
			try {
				this._liveMixerObj.removeEventListener("update", this._liveMixerUpdateHandler);
			} catch {}
		}
		this._liveMixerObj = null;
		this._liveMixerUpdateHandler = null;
	}

	// Taps each <Chain>'s live output GainNode with our own AnalyserNode —
	// purely additive (doesn't touch the existing routing) — per the
	// confirmed waxml.js internals: <Chain>.obj.output (and <Mixer>.obj.
	// output) are real GainNodes carrying the chain's fully-processed
	// signal. Only Chains with an `id` can be found this way (matches by
	// the XML id attribute, via the same safe [id='...'] selector used
	// elsewhere). References here are only valid until the next structural
	// edit (which stops playback and invalidates the live graph — see
	// player-store.js), never assumed to persist beyond that.
	_connectMeters(mixerNode) {
		this._disconnectMeters();
		mixerNode.children
			.filter((c) => (c.tagName === "Chain" || c.tagName === "GainNode") && c.attributes.id)
			.forEach((chain) => {
				let liveObj;
				try {
					const matches = playerStore.getLiveObjects(`[id='${chain.attributes.id}']`);
					liveObj = matches && matches[0];
				} catch {
					liveObj = null;
				}
				if (!liveObj || !liveObj.output) return;
				const analyser = playerStore.audioContext.createAnalyser();
				analyser.fftSize = 1024;
				liveObj.output.connect(analyser);
				this._meterState.set(chain.id, {
					analyser,
					dataArray: new Uint8Array(analyser.fftSize),
					vuFillEl: null,
					smoothedT: 0
				});
			});
	}

	_disconnectMeters() {
		this._meterState.forEach((entry) => {
			try {
				entry.analyser.disconnect();
			} catch {}
		});
		this._meterState.clear();
	}

	// Re-links each meter's target DOM element by chain id — needed after
	// every render, since _render rebuilds the whole .channels subtree from
	// scratch on any xmlStore change (dragging a knob, editing an attribute
	// elsewhere, etc.), which would otherwise leave _meterState pointing at
	// detached elements.
	_attachMeterElements() {
		if (this._meterState.size === 0) return;
		this._meterState.forEach((entry, chainId) => {
			const vuMeter = this._channels.querySelector(`.vu-meter[data-chain-id="${CSS.escape(chainId)}"]`);
			entry.vuFillEl = vuMeter ? vuMeter.querySelector(".vu-fill") : null;
		});
	}

	_startMeterLoop() {
		this._stopMeterLoop();
		const step = () => {
			if (!playerStore.isPlaying) return;
			this._meterState.forEach((entry) => {
				if (!entry.vuFillEl) return;
				entry.analyser.getByteTimeDomainData(entry.dataArray);
				let peak = 0;
				for (let i = 0; i < entry.dataArray.length; i++) {
					const v = Math.abs(entry.dataArray[i] - 128) / 128;
					if (v > peak) peak = v;
				}
				const db = peak > 0 ? 20 * Math.log10(peak) : VU_MIN_DB;
				const targetT = Math.max(0, Math.min(1, (db - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)));
				// Quick attack, slow release — jumps up instantly, decays gradually.
				entry.smoothedT = targetT > entry.smoothedT ? targetT : entry.smoothedT * VU_RELEASE + targetT * (1 - VU_RELEASE);
				entry.vuFillEl.style.height = `${entry.smoothedT * 100}%`;
			});
			this._updateSoloButtonGains();
			this._meterRafId = requestAnimationFrame(step);
		};
		this._meterRafId = requestAnimationFrame(step);
	}

	// getChannelGain(index) is a live per-channel solo-crossfade readout Hans
	// is building in waxml.js in parallel with this UI — called defensively
	// (the function may not exist yet on any given live Mixer object).
	_updateSoloButtonGains() {
		if (!this._liveMixerObj || typeof this._liveMixerObj.getChannelGain !== "function") return;
		this.shadowRoot.querySelectorAll(".solo-btn").forEach((btn) => {
			const idx = parseInt(btn.dataset.channelIndex, 10);
			let gain = 0;
			try {
				gain = this._liveMixerObj.getChannelGain(idx);
			} catch {
				gain = 0;
			}
			const t = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0;
			btn.style.filter = t > 0.02 ? `brightness(${(1 + t * 1.8).toFixed(2)})` : "";
			btn.style.boxShadow = t > 0.02 ? `0 0 ${(4 + t * 8).toFixed(1)}px rgba(229, 72, 77, ${(0.3 + t * 0.7).toFixed(2)})` : "";
		});
	}

	_stopMeterLoop() {
		if (this._meterRafId) cancelAnimationFrame(this._meterRafId);
		this._meterRafId = null;
	}

	// "Sticky" active-Mixer tracking, same pattern (and same reason) as
	// wa-section-view's _lastSectionId: xmlStore.insertNewChild moves the
	// global selection to whatever it just created as a side effect, so
	// clicking any of this view's own "+" buttons (add channel/insert/send)
	// would otherwise immediately move selection off the Mixer and onto the
	// new Chain/Wam/Send — which, without this, would stop this view from
	// re-rendering (and would also hide it entirely, via wa-preview.js's own
	// matching MIXER_CONTEXT_TAGS carve-out).
	_onStoreChange() {
		const selected = xmlStore.getSelectedNode();
		if (selected && selected.tagName === "Mixer") {
			this._activeMixerId = selected.id;
		}
		if (!this._activeMixerId) return;
		const mixerNode = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!mixerNode) {
			this._activeMixerId = null;
			return;
		}
		this._render(mixerNode);
	}

	// --- solo slider (renamed from "mix", per Hans) ---

	_buildQuantizeOptions() {
		QUANTIZE_OPTIONS.forEach(({ value, label }) => {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = label;
			this._quantizeSelect.appendChild(opt);
		});
	}

	_applySoloSliderVisual(value, hasValue) {
		const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
		this._soloHandle.style.left = `${clamped * 100}%`;
		this._soloHandle.classList.toggle("active", !!hasValue);
	}

	// The slider's drawn width/position hugs only the currently *visible*
	// channels (scroll-reactive), per Hans — not the full channel range,
	// which may be scrolled out of view. The 0-100% value mapping itself
	// still always spans the *entire* channel set regardless of scroll.
	_updateSoloSliderGeometry() {
		const track = this._soloTrack;
		const area = this._soloSliderArea;
		if (!track || !area) return;
		const strips = Array.from(this._channels.querySelectorAll(".channel-strip"));
		if (!strips.length) {
			track.style.flex = "1 1 auto";
			track.style.marginLeft = "0px";
			track.style.width = "";
			return;
		}
		const scrollRect = this._channelsScroll.getBoundingClientRect();
		const visible = strips.filter((el) => {
			const r = el.getBoundingClientRect();
			return r.right > scrollRect.left + 1 && r.left < scrollRect.right - 1;
		});
		const refStrips = visible.length ? visible : strips;
		const firstRect = refStrips[0].getBoundingClientRect();
		const lastRect = refStrips[refStrips.length - 1].getBoundingClientRect();
		const areaRect = area.getBoundingClientRect();
		const left = Math.max(0, firstRect.left - areaRect.left);
		const right = Math.max(left + 20, lastRect.right - areaRect.left);
		track.style.flex = "0 0 auto";
		track.style.marginLeft = `${left}px`;
		track.style.width = `${right - left}px`;
	}

	_wireSoloSliderDrag() {
		const handle = this._soloHandle;
		const track = this._soloTrack;
		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !this._activeMixerId) return;
			e.preventDefault();
			e.stopPropagation();
			const trackRect = track.getBoundingClientRect();
			let dragging = false;
			let committed = 0.5;
			handle.style.transitionDuration = "0s";
			try {
				handle.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				dragging = true;
				const relX = moveEvt.clientX - trackRect.left;
				const t = Math.max(0, Math.min(1, trackRect.width ? relX / trackRect.width : 0));
				committed = t;
				this._applySoloSliderVisual(t, true);
				this._applyLiveSolo(t);
			};
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				handle.style.transitionDuration = "";
				if (dragging) this._commitSoloValue(committed);
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});
	}

	_applyLiveSolo(value) {
		if (!this._activeMixerId) return;
		const node = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!node) return;
		applyLiveProperty(node.attributes.id, "solo", value);
	}

	_commitSoloValue(value) {
		if (!this._activeMixerId) return;
		const node = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!node) return;
		xmlStore.updateAttributes(node.id, { ...node.attributes, solo: String(Math.round(value * 1000) / 1000) });
		// The engine (Hans is wiring this up) is what actually honors
		// `quantize` — this side only shows a "pending" state until the live
		// Mixer object's own "update" event tells us the change landed.
		if (node.attributes.quantize) this._soloHandle.classList.add("standby");
	}

	// Per-channel solo button: animates the big slider to
	// channelIndex/(totalCount-1) over the live (or fallback) transitionTime.
	_setSoloValue(mixerNode, value) {
		const ms = this._getTransitionTimeMs(mixerNode);
		this._soloHandle.style.transitionDuration = `${ms}ms`;
		this._applySoloSliderVisual(value, true);
		this._applyLiveSolo(value);
		this._commitSoloValue(value);
	}

	// Read the *live* transitionTime (it can be inherited, so the raw XML
	// attribute alone isn't reliable while playing), falling back to the XML
	// attribute, then a hardcoded default — per Hans's exact instruction.
	_getTransitionTimeMs(mixerNode) {
		if (this._liveMixerObj && typeof this._liveMixerObj.getParameter === "function") {
			try {
				const v = this._liveMixerObj.getParameter("transitionTime");
				if (Number.isFinite(v)) return v;
			} catch {}
		}
		const num = parseFloat(mixerNode.attributes.transitionTime);
		return Number.isFinite(num) ? num : DEFAULT_TRANSITION_TIME_MS;
	}

	_handleQuantizeChange() {
		if (!this._activeMixerId) return;
		const node = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!node) return;
		const attrs = { ...node.attributes };
		if (this._quantizeSelect.value) attrs.quantize = this._quantizeSelect.value;
		else delete attrs.quantize;
		xmlStore.updateAttributes(node.id, attrs);
	}

	_handleBlendInput() {
		if (!this._activeMixerId) return;
		const node = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!node) return;
		applyLiveProperty(node.attributes.id, "blend", parseFloat(this._blendSlider.value));
		xmlStore.updateAttributes(node.id, { ...node.attributes, blend: this._blendSlider.value });
	}

	_handleTransitionInput() {
		if (!this._activeMixerId) return;
		const node = ops.findNodeById(xmlStore.root, this._activeMixerId);
		if (!node) return;
		applyLiveProperty(node.attributes.id, "transitionTime", parseFloat(this._transitionSlider.value));
		xmlStore.updateAttributes(node.id, { ...node.attributes, transitionTime: this._transitionSlider.value });
	}

	_render(mixerNode) {
		// The filter section's height is shared across every channel — set
		// by whichever channel has the most BiquadFilterNodes — so all
		// channels' Ins/Send/Pan/Vol rows line up horizontally regardless of
		// how many EQ bands any one of them has, per Hans.
		const chainChildren = mixerNode.children.filter((c) => c.tagName === "Chain");
		const maxFilterCount = Math.max(1, ...chainChildren.map((c) => c.children.filter((cc) => cc.tagName === "BiquadFilterNode").length));
		const filterSectionHeight = maxFilterCount * FILTER_ROW_HEIGHT;

		this._eqLabel.style.height = `${filterSectionHeight}px`;
		this._insLabel.style.height = `${INSERT_SECTION_HEIGHT}px`;
		this._sendLabel.style.height = `${SEND_SECTION_HEIGHT}px`;

		this._channels.innerHTML = "";
		const totalCount = mixerNode.children.length;
		mixerNode.children.forEach((child, index) => {
			this._channels.appendChild(this._buildChannelStrip(child, index, totalCount, filterSectionHeight, mixerNode));
		});
		this._channels.appendChild(this._buildAddChannelStrip(mixerNode));

		const soloRaw = mixerNode.attributes.solo;
		const soloValue = soloRaw !== undefined ? parseFloat(soloRaw) : undefined;
		const hasSolo = soloRaw !== undefined && Number.isFinite(soloValue);
		this._applySoloSliderVisual(hasSolo ? soloValue : 0.5, hasSolo);

		this._quantizeSelect.value = mixerNode.attributes.quantize || "";

		const blendValue = mixerNode.attributes.blend !== undefined ? parseFloat(mixerNode.attributes.blend) : 0.1;
		this._blendSlider.value = String(Number.isFinite(blendValue) ? Math.max(0, Math.min(1, blendValue)) : 0.1);

		const transitionAttr = mixerNode.attributes.transitionTime !== undefined ? parseFloat(mixerNode.attributes.transitionTime) : DEFAULT_TRANSITION_TIME_MS;
		this._transitionSlider.value = String(Number.isFinite(transitionAttr) ? Math.max(0, Math.min(TRANSITION_TIME_MAX_MS, transitionAttr)) : DEFAULT_TRANSITION_TIME_MS);

		if (playerStore.isPlaying) this._wireMixerUpdateListener(mixerNode);
		this._attachMeterElements();
		this._updateSoloSliderGeometry();
	}

	// --- "+" channel-type picker ---

	_buildAddChannelStrip(mixerNode) {
		const wrap = document.createElement("div");
		wrap.className = "add-channel-wrap";
		const strip = document.createElement("div");
		strip.className = "add-channel-strip";
		strip.textContent = "+";
		strip.title = "Add channel strip";
		strip.addEventListener("click", (e) => {
			e.stopPropagation();
			this._toggleChannelTypeMenu(wrap, mixerNode);
		});
		wrap.appendChild(strip);
		return wrap;
	}

	_toggleChannelTypeMenu(wrap, mixerNode) {
		const existing = wrap.querySelector(".channel-type-menu");
		if (existing) {
			existing.remove();
			return;
		}
		const menu = document.createElement("div");
		menu.className = "channel-type-menu";
		const options = [
			{ label: "VU", handler: () => this._addChannelVU(mixerNode) },
			{ label: "Pan, Volume, VU", handler: () => this._addChannelPanVolVU(mixerNode) },
			{ label: "Full Channel Strip", handler: () => this._addChannelFull(mixerNode) }
		];
		options.forEach(({ label, handler }) => {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "channel-type-option";
			btn.textContent = label;
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				menu.remove();
				handler();
			});
			menu.appendChild(btn);
		});
		wrap.appendChild(menu);
		// composedPath (not e.target) — a pointerdown outside the shadow
		// root retargets e.target to the <wa-mixer-view> host itself, which
		// would make wrap.contains(e.target) always false.
		const closeOnOutside = (e) => {
			if (!e.composedPath().includes(wrap)) {
				menu.remove();
				document.removeEventListener("pointerdown", closeOnOutside, true);
			}
		};
		setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
	}

	// New channel strips get a "MixChan-N" id (never colliding with an
	// existing one, never reusing a number even after deletion, mirroring
	// the reasoning behind xmlStore's own TagName-N auto-id backfill) rather
	// than the generic "Chain-N"/"GainNode-N" auto-id, per Hans.
	_nextChannelId(mixerNow) {
		const existingNums = mixerNow.children
			.map((c) => /^MixChan-(\d+)$/.exec(c.attributes.id || ""))
			.filter(Boolean)
			.map((m) => parseInt(m[1], 10));
		return existingNums.length ? Math.max(...existingNums) + 1 : 1;
	}

	_addChannelFull(mixerNode) {
		const mixerNow = ops.findNodeById(xmlStore.root, mixerNode.id);
		if (!mixerNow) return;
		const nextNum = this._nextChannelId(mixerNow);
		const chain = xmlStore.insertNewChild(mixerNow.id, "Chain", { id: `MixChan-${nextNum}` });
		xmlStore.insertNewChild(chain.id, "BiquadFilterNode", { type: "highshelf" });
		xmlStore.insertNewChild(chain.id, "BiquadFilterNode", { type: "peaking" });
		xmlStore.insertNewChild(chain.id, "BiquadFilterNode", { type: "lowshelf" });
		xmlStore.insertNewChild(chain.id, "StereoPannerNode", {});
		xmlStore.insertNewChild(chain.id, "GainNode", {});
	}

	_addChannelPanVolVU(mixerNode) {
		const mixerNow = ops.findNodeById(xmlStore.root, mixerNode.id);
		if (!mixerNow) return;
		const nextNum = this._nextChannelId(mixerNow);
		const chain = xmlStore.insertNewChild(mixerNow.id, "Chain", { id: `MixChan-${nextNum}` });
		xmlStore.insertNewChild(chain.id, "StereoPannerNode", {});
		xmlStore.insertNewChild(chain.id, "GainNode", {});
	}

	_addChannelVU(mixerNode) {
		const mixerNow = ops.findNodeById(xmlStore.root, mixerNode.id);
		if (!mixerNow) return;
		const nextNum = this._nextChannelId(mixerNow);
		xmlStore.insertNewChild(mixerNow.id, "GainNode", { id: `MixChan-${nextNum}` });
	}

	// --- channel strips ---

	// Blank spacer rows matching the real EQ/Ins/Send section heights, so a
	// VU-only or "other" strip's Pan/Vol/Solo rows still line up with a full
	// channel strip's, per Hans's "alla channel-typer ska vara i linje".
	_buildSectionSpacers(filterSectionHeight) {
		const frag = document.createDocumentFragment();
		const filterSpacer = document.createElement("div");
		filterSpacer.className = "filter-section";
		filterSpacer.style.height = `${filterSectionHeight}px`;
		frag.appendChild(filterSpacer);
		const insertSpacer = document.createElement("div");
		insertSpacer.className = "insert-section";
		insertSpacer.style.height = `${INSERT_SECTION_HEIGHT}px`;
		frag.appendChild(insertSpacer);
		frag.appendChild(this._buildDivider());
		const sendSpacer = document.createElement("div");
		sendSpacer.className = "sends-section";
		sendSpacer.style.height = `${SEND_SECTION_HEIGHT}px`;
		frag.appendChild(sendSpacer);
		return frag;
	}

	_buildSoloRow(child, index, totalCount, mixerNode) {
		const row = document.createElement("div");
		row.className = "solo-row";
		row.style.height = `${SOLO_ROW_HEIGHT}px`;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "solo-btn";
		btn.title = `Solo: ${displayLabel(child)}`;
		btn.dataset.channelIndex = String(index);
		const targetValue = totalCount > 1 ? index / (totalCount - 1) : 0;
		btn.addEventListener("click", () => this._setSoloValue(mixerNode, targetValue));
		row.appendChild(btn);
		return row;
	}

	// Bare <GainNode> direct child of <Mixer> — the "VU" channel type: shows
	// only the VU meter, no fader handle, no pan, no EQ/insert/send.
	_buildVuOnlyStrip(child, index, totalCount, filterSectionHeight, mixerNode) {
		const strip = document.createElement("div");
		strip.className = "channel-strip";
		strip.appendChild(this._buildSectionSpacers(filterSectionHeight));

		const bottomGroup = document.createElement("div");
		bottomGroup.className = "bottom-group";

		const panRow = document.createElement("div");
		panRow.className = "pan-row";
		panRow.style.height = `${PAN_ROW_HEIGHT}px`;
		bottomGroup.appendChild(panRow);

		const faderRow = document.createElement("div");
		faderRow.className = "fader-row-wrap";
		faderRow.style.height = `${FADER_ROW_HEIGHT}px`;
		const vuMeter = document.createElement("div");
		vuMeter.className = "vu-meter";
		vuMeter.style.height = `${FADER_TRACK_HEIGHT}px`;
		vuMeter.dataset.chainId = child.id;
		vuMeter.title = "Level (live, while playing)";
		const vuFill = document.createElement("div");
		vuFill.className = "vu-fill";
		vuFill.style.backgroundSize = `6px ${FADER_TRACK_HEIGHT}px`;
		vuFill.style.height = "0%";
		vuMeter.appendChild(vuFill);
		faderRow.appendChild(vuMeter);
		bottomGroup.appendChild(faderRow);

		const label = document.createElement("div");
		label.className = "channel-label";
		label.textContent = displayLabel(child);
		label.title = child.attributes.id || "";
		bottomGroup.appendChild(label);

		bottomGroup.appendChild(this._buildSoloRow(child, index, totalCount, mixerNode));

		strip.appendChild(bottomGroup);
		return strip;
	}

	_buildChannelStrip(child, index, totalCount, filterSectionHeight, mixerNode) {
		if (child.tagName === "GainNode") {
			return this._buildVuOnlyStrip(child, index, totalCount, filterSectionHeight, mixerNode);
		}

		const strip = document.createElement("div");
		strip.className = "channel-strip";

		if (child.tagName !== "Chain") {
			// Any other element type directly under <Mixer> still gets its
			// own strip ("varje child-element ... representeras av en
			// channel-strip", per Hans) — just without the full EQ/insert/
			// send/pan/fader layout below, which is specifically a <Chain>'s
			// shape. Still reserves the same row heights so its Solo button
			// lines up with every other channel's.
			strip.appendChild(this._buildSectionSpacers(filterSectionHeight));

			const bottomGroup = document.createElement("div");
			bottomGroup.className = "bottom-group";

			const panRow = document.createElement("div");
			panRow.className = "pan-row";
			panRow.style.height = `${PAN_ROW_HEIGHT}px`;
			const other = document.createElement("div");
			other.className = "other-node";
			other.textContent = child.tagName;
			panRow.appendChild(other);
			bottomGroup.appendChild(panRow);

			const faderRow = document.createElement("div");
			faderRow.className = "fader-row-wrap";
			faderRow.style.height = `${FADER_ROW_HEIGHT}px`;
			bottomGroup.appendChild(faderRow);

			const label = document.createElement("div");
			label.className = "channel-label";
			label.textContent = displayLabel(child);
			bottomGroup.appendChild(label);

			bottomGroup.appendChild(this._buildSoloRow(child, index, totalCount, mixerNode));

			strip.appendChild(bottomGroup);
			return strip;
		}

		const roles = this._classifyChain(child);

		const filterSection = document.createElement("div");
		filterSection.className = "filter-section";
		filterSection.style.height = `${filterSectionHeight}px`;
		roles.filters.forEach((f) => filterSection.appendChild(this._buildFilterRow(f)));
		strip.appendChild(filterSection);

		strip.appendChild(this._buildInsertSection(child, roles));
		strip.appendChild(this._buildDivider());
		strip.appendChild(this._buildSendsSection(child, roles));

		const bottomGroup = document.createElement("div");
		bottomGroup.className = "bottom-group";

		const panRow = document.createElement("div");
		panRow.className = "pan-row";
		panRow.style.height = `${PAN_ROW_HEIGHT}px`;
		if (roles.stereoPanner) panRow.appendChild(this._buildPanKnob(roles.stereoPanner));
		bottomGroup.appendChild(panRow);

		const faderRow = document.createElement("div");
		faderRow.className = "fader-row-wrap";
		faderRow.style.height = `${FADER_ROW_HEIGHT}px`;
		faderRow.appendChild(this._buildFader(roles.gainNode, child.id));
		bottomGroup.appendChild(faderRow);

		const label = document.createElement("div");
		label.className = "channel-label";
		label.textContent = displayLabel(child);
		label.title = child.attributes.id || "";
		bottomGroup.appendChild(label);

		bottomGroup.appendChild(this._buildSoloRow(child, index, totalCount, mixerNode));

		strip.appendChild(bottomGroup);

		return strip;
	}

	_buildDivider() {
		const div = document.createElement("div");
		div.className = "section-divider";
		return div;
	}

	// Classifies a <Chain>'s children by channel-strip role. filters keeps
	// every BiquadFilterNode in XML order (any count, any type) — "Filter
	// ska alltid ligga överst i den ordningen de dyker upp i XML", per Hans.
	// preSends/postSends is determined by each Send's position relative to
	// the GainNode in the XML — "pre" (before it) is the default landing
	// spot for a new Send; toggling "post" moves it after the GainNode.
	_classifyChain(chainNode) {
		const children = chainNode.children;
		const gainIdx = children.findIndex((c) => c.tagName === "GainNode");
		const gainNode = gainIdx !== -1 ? children[gainIdx] : null;
		const sends = children.filter((c) => c.tagName === "Send");
		return {
			filters: children.filter((c) => c.tagName === "BiquadFilterNode"),
			stereoPanner: children.find((c) => c.tagName === "StereoPannerNode"),
			gainNode,
			wams: children.filter((c) => c.tagName === "Wam"),
			preSends: gainIdx === -1 ? sends : sends.filter((s) => children.indexOf(s) < gainIdx),
			postSends: gainIdx === -1 ? [] : sends.filter((s) => children.indexOf(s) > gainIdx)
		};
	}

	// --- filter row: one large gain knob + small freq/Q knobs ---

	_buildFilterRow(node) {
		const row = document.createElement("div");
		row.className = "filter-row";
		row.style.height = `${FILTER_ROW_HEIGHT}px`;

		const top = document.createElement("div");
		top.className = "filter-row-top";

		const typeLabel = document.createElement("div");
		typeLabel.className = "filter-type-label";
		typeLabel.textContent = this._filterTypeAbbrev(node.attributes.type);
		top.appendChild(typeLabel);

		top.appendChild(this._buildFilterGainKnob(node));

		const smallKnobs = document.createElement("div");
		smallKnobs.className = "filter-small-knobs";
		smallKnobs.appendChild(this._buildFreqKnob(node));
		smallKnobs.appendChild(this._buildQKnob(node));
		top.appendChild(smallKnobs);

		row.appendChild(top);
		row.appendChild(this._buildFilterTypeSelect(node));

		return row;
	}

	// Same option list the XML editor's own Inspector uses for this
	// attribute (read live from the schema), per Hans.
	_buildFilterTypeSelect(node) {
		const select = document.createElement("select");
		select.className = "filter-type-select";
		getBiquadTypeOptions().forEach((value) => {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = value;
			select.appendChild(opt);
		});
		select.value = node.attributes.type || "";
		select.title = "Filter type";
		select.addEventListener("change", () => {
			const nodeNow = ops.findNodeById(xmlStore.root, node.id);
			if (!nodeNow) return;
			xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, type: select.value });
		});
		select.addEventListener("pointerdown", (e) => e.stopPropagation());
		return select;
	}

	_filterTypeAbbrev(type) {
		switch (type) {
			case "highshelf":
				return "HI";
			case "lowshelf":
				return "LO";
			case "peaking":
				return "MID";
			case "notch":
				return "NCH";
			case "bandpass":
				return "BP";
			case "allpass":
				return "AP";
			case "lowpass":
				return "LP";
			case "highpass":
				return "HP";
			default:
				return (type || "EQ").slice(0, 3).toUpperCase();
		}
	}

	_buildFilterGainKnob(node) {
		const { wrap, knob, dial } = this._buildKnobSkeleton("", 32);
		knob.classList.add("knob-large", "knob-gain");
		const applyVisual = (db) => this._applyKnobRotation(dial, db, EQ_MIN_DB, EQ_MAX_DB);
		applyVisual(gainToDb(node.attributes.gain));
		knob.title = `${node.attributes.type || "filter"} gain`;

		this._wireVerticalDrag(
			knob,
			gainToDb(node.attributes.gain),
			EQ_MIN_DB,
			EQ_MAX_DB,
			(db) => {
				applyVisual(db);
				applyLiveGainDb(node.attributes.id, db, false); // BiquadFilterNode.gain is native dB
			},
			(db) => {
				const nodeNow = ops.findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, gain: dbToGainAttr(db) });
			}
		);

		return wrap;
	}

	// Logarithmic: the knob's own drag happens in "t" (0-1) space via
	// freqToKnobT/knobTToFreq, so an equal drag distance always covers an
	// equal number of octaves, regardless of where on the range you start.
	_buildFreqKnob(node) {
		const { wrap, knob, dial } = this._buildKnobSkeleton("", 18);
		knob.classList.add("knob-small", "knob-freq");
		const applyVisual = (t) => this._applyKnobRotation(dial, t, 0, 1);
		const startT = freqToKnobT(readFrequency(node));
		applyVisual(startT);
		knob.title = `Freq ${Math.round(readFrequency(node))} Hz`;

		this._wireVerticalDrag(
			knob,
			startT,
			0,
			1,
			(t) => {
				applyVisual(t);
				knob.title = `Freq ${Math.round(knobTToFreq(t))} Hz`;
				applyLiveProperty(node.attributes.id, "frequency", knobTToFreq(t));
			},
			(t) => {
				const nodeNow = ops.findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, frequency: String(Math.round(knobTToFreq(t))) });
			}
		);

		return wrap;
	}

	_buildQKnob(node) {
		const { wrap, knob, dial } = this._buildKnobSkeleton("", 18);
		knob.classList.add("knob-small", "knob-q");
		const applyVisual = (q) => this._applyKnobRotation(dial, q, Q_MIN, Q_MAX);
		applyVisual(readQ(node));
		knob.title = `Q ${readQ(node).toFixed(1)}`;

		this._wireVerticalDrag(
			knob,
			readQ(node),
			Q_MIN,
			Q_MAX,
			(q) => {
				applyVisual(q);
				knob.title = `Q ${q.toFixed(1)}`;
				applyLiveProperty(node.attributes.id, "Q", q);
			},
			(q) => {
				const nodeNow = ops.findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, Q: String(Math.round(q * 10) / 10) });
			}
		);

		return wrap;
	}

	// --- pan knob (-1 to 1) ---

	_buildPanKnob(node) {
		const { wrap, knob, dial } = this._buildKnobSkeleton("", 26);
		knob.classList.add("pan-knob");
		const applyVisual = (pan) => this._applyKnobRotation(dial, pan, -1, 1);
		applyVisual(readPan(node));
		knob.title = "Pan";

		this._wireVerticalDrag(
			knob,
			readPan(node),
			-1,
			1,
			(pan) => {
				applyVisual(pan);
				applyLiveProperty(node.attributes.id, "pan", pan);
			},
			(pan) => {
				const nodeNow = ops.findNodeById(xmlStore.root, node.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, pan: String(Math.round(pan * 100) / 100) });
			}
		);

		return wrap;
	}

	_buildKnobSkeleton(labelText, sizePx = 26) {
		const wrap = document.createElement("div");
		wrap.className = "knob-wrap";
		wrap.appendChild(this._buildKnobTicks(sizePx));
		const knob = document.createElement("div");
		knob.className = "knob";
		const dial = document.createElement("div");
		dial.className = "knob-dial";
		knob.appendChild(dial);
		wrap.appendChild(knob);
		if (labelText) {
			const labelEl = document.createElement("div");
			labelEl.className = "knob-label";
			labelEl.textContent = labelText;
			wrap.appendChild(labelEl);
		}
		return { wrap, knob, dial };
	}

	// Small white tick marks printed around a knob's rotational range (a
	// physical pot's scale markings, purely decorative) — computed in JS
	// since positioning discrete ticks on a circle isn't practical with a
	// fixed CSS rule shared across different knob sizes. Same -135°..+135°
	// sweep as the knob's own dial indicator.
	_buildKnobTicks(sizePx, count = 11) {
		const wrap = document.createElement("div");
		wrap.className = "knob-ticks";
		const outerSize = sizePx + 10;
		wrap.style.width = `${outerSize}px`;
		wrap.style.height = `${outerSize}px`;
		wrap.style.left = `${-5}px`;
		wrap.style.top = `${-5}px`;
		const radius = sizePx / 2 + 3;
		const center = outerSize / 2;
		for (let i = 0; i < count; i++) {
			const angleDeg = -135 + (i / (count - 1)) * 270;
			const angleRad = (angleDeg * Math.PI) / 180;
			const x = center + radius * Math.sin(angleRad);
			const y = center - radius * Math.cos(angleRad);
			const tick = document.createElement("div");
			tick.className = "knob-tick";
			tick.style.left = `${x}px`;
			tick.style.top = `${y}px`;
			tick.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
			wrap.appendChild(tick);
		}
		return wrap;
	}

	_applyKnobRotation(dial, value, min, max) {
		const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
		dial.style.transform = `rotate(${-135 + t * 270}deg)`;
	}

	// Shared vertical-drag-to-adjust-a-value interaction for knobs (rotary,
	// linear value<->angle mapping) — the fader has its own wiring instead,
	// since it's a linear track position the pointer follows directly
	// rather than a relative drag delta, and needs the nonlinear dB<->
	// position taper (see dbToFaderPosition/faderPositionToDb).
	_wireVerticalDrag(el, startValue, min, max, onLiveChange, onCommit) {
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const startY = e.clientY;
			let dragging = false;
			let committed = startValue;
			try {
				el.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				dragging = true;
				const deltaPx = startY - moveEvt.clientY; // up = increase
				const rawValue = startValue + (deltaPx / KNOB_PX_PER_RANGE) * (max - min);
				committed = Math.max(min, Math.min(max, rawValue));
				onLiveChange(committed);
			};
			const onUp = () => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
				if (dragging) onCommit(committed);
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onUp);
		});
	}

	// --- fader (gain, dB, nonlinear taper) + VU meter ---
	// The VU meter shows real signal level, tapped from the live <Chain>'s
	// own output GainNode via an AnalyserNode once Play is running — see
	// _connectMeters/_startMeterLoop. It's tagged with data-chain-id so
	// _attachMeterElements can find it fresh after every re-render (the
	// whole channel strip DOM gets rebuilt on any xmlStore change, same
	// reason wa-section-view's Stinger pointer re-attaches every render).

	_buildFader(gainNode, chainId) {
		const wrap = document.createElement("div");
		wrap.className = "fader-wrap";

		const row = document.createElement("div");
		row.className = "fader-row";

		const track = document.createElement("div");
		track.className = "fader-track";
		track.style.height = `${FADER_TRACK_HEIGHT}px`;

		FADER_TICKS_DB.forEach((db) => {
			const t = dbToFaderPosition(db);
			const tick = document.createElement("div");
			tick.className = db === 0 ? "fader-tick zero" : "fader-tick";
			tick.style.bottom = `${t * 100}%`;
			const tickLabel = document.createElement("span");
			tickLabel.textContent = db > 0 ? `+${db}` : String(db);
			tick.appendChild(tickLabel);
			track.appendChild(tick);
		});

		const handle = document.createElement("div");
		handle.className = "fader-handle";
		track.appendChild(handle);
		row.appendChild(track);

		const vuMeter = document.createElement("div");
		vuMeter.className = "vu-meter";
		vuMeter.style.height = `${FADER_TRACK_HEIGHT}px`;
		vuMeter.dataset.chainId = chainId || "";
		vuMeter.title = "Level (live, while playing)";
		const vuFill = document.createElement("div");
		vuFill.className = "vu-fill";
		vuFill.style.backgroundSize = `6px ${FADER_TRACK_HEIGHT}px`;
		vuFill.style.height = "0%";
		vuMeter.appendChild(vuFill);
		row.appendChild(vuMeter);

		wrap.appendChild(row);

		if (!gainNode) {
			wrap.classList.add("disabled");
			return wrap;
		}

		const applyVisual = (db) => {
			handle.style.bottom = `${dbToFaderPosition(db) * 100}%`;
		};
		let currentDb = gainToDb(gainNode.attributes.gain);
		applyVisual(currentDb);
		handle.title = Number.isFinite(currentDb) ? `${currentDb.toFixed(1)} dB` : "-∞ dB";

		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const trackRect = track.getBoundingClientRect();
			let dragging = false;
			let committedDb = currentDb;
			try {
				handle.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				dragging = true;
				const relY = moveEvt.clientY - trackRect.top;
				const t = Math.max(0, Math.min(1, 1 - relY / trackRect.height));
				committedDb = faderPositionToDb(t);
				applyVisual(committedDb);
				applyLiveGainDb(gainNode.attributes.id, committedDb, true); // GainNode.gain is linear
			};
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				if (!dragging) return;
				const nodeNow = ops.findNodeById(xmlStore.root, gainNode.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(gainNode.id, { ...nodeNow.attributes, gain: dbToGainAttr(committedDb) });
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});

		return wrap;
	}

	// --- insert (Wam) section — fixed height, scrolls if it overflows ---
	// A real "pick a WAM from a list + live GUI preview" flow is a later
	// step, per Hans — for now, an empty slot just adds a bare <Wam/>.

	_buildInsertSection(chainNode, roles) {
		const section = document.createElement("div");
		section.className = "insert-section";
		section.style.height = `${INSERT_SECTION_HEIGHT}px`;
		roles.wams.forEach((wam) => section.appendChild(this._buildInsertSlot(wam)));
		section.appendChild(this._buildAddInsertSlot(chainNode, roles));
		return section;
	}

	_buildInsertSlot(wam) {
		const slot = document.createElement("div");
		slot.className = "insert-slot filled";
		slot.textContent = wam.attributes.src ? wam.attributes.src.split("/").pop() : "WAM";
		slot.title = wam.attributes.src || "(no plugin selected yet)";
		return slot;
	}

	_buildAddInsertSlot(chainNode, roles) {
		const slot = document.createElement("div");
		slot.className = "insert-slot empty";
		slot.textContent = "+";
		slot.title = "Add insert effect";
		slot.addEventListener("click", () => {
			const chainNow = ops.findNodeById(xmlStore.root, chainNode.id);
			if (!chainNow) return;
			const rolesNow = this._classifyChain(chainNow);
			xmlStore.insertNewChild(chainNow.id, "Wam", {}, this._insertPositionAfterEq(chainNow, rolesNow));
		});
		return slot;
	}

	// Where a new insert/pre-send lands: right after the EQ filters and any
	// existing inserts, before StereoPannerNode/GainNode/pre-sends.
	_insertPositionAfterEq(chainNode, roles) {
		const lastEqOrInsert = [...roles.filters, ...roles.wams].filter(Boolean).pop();
		if (!lastEqOrInsert) return 0;
		return chainNode.children.findIndex((c) => c.id === lastEqOrInsert.id) + 1;
	}

	// --- sends section — fixed height, scrolls if it overflows ---

	_buildSendsSection(chainNode, roles) {
		const section = document.createElement("div");
		section.className = "sends-section";
		section.style.height = `${SEND_SECTION_HEIGHT}px`;
		roles.preSends.forEach((send) => section.appendChild(this._buildSendRow(send, false, chainNode)));
		roles.postSends.forEach((send) => section.appendChild(this._buildSendRow(send, true, chainNode)));
		section.appendChild(this._buildAddSendSlot(chainNode, roles));
		return section;
	}

	_buildSendRow(send, isPost, chainNode) {
		const row = document.createElement("div");
		row.className = "send-row";

		const { wrap: knobWrap, knob, dial } = this._buildKnobSkeleton("");
		const applyVisual = (db) => this._applyKnobRotation(dial, db, EQ_MIN_DB, EQ_MAX_DB);
		applyVisual(gainToDb(send.attributes.gain));
		knob.title = "Send level";
		this._wireVerticalDrag(
			knob,
			gainToDb(send.attributes.gain),
			EQ_MIN_DB,
			EQ_MAX_DB,
			(db) => {
				applyVisual(db);
				applyLiveGainDb(send.attributes.id, db, true); // Send routes through a GainNode-based bus, linear like GainNode
			},
			(db) => {
				const nodeNow = ops.findNodeById(xmlStore.root, send.id);
				if (!nodeNow) return;
				xmlStore.updateAttributes(send.id, { ...nodeNow.attributes, gain: dbToGainAttr(db) });
			}
		);
		row.appendChild(knobWrap);

		const busInput = document.createElement("input");
		busInput.className = "send-bus-input";
		busInput.type = "text";
		busInput.placeholder = "output";
		busInput.value = send.attributes.bus || "";
		busInput.title = "Send output (bus selector) — picker UI coming in a later step";
		busInput.addEventListener("change", () => {
			const nodeNow = ops.findNodeById(xmlStore.root, send.id);
			if (!nodeNow) return;
			xmlStore.updateAttributes(send.id, { ...nodeNow.attributes, bus: busInput.value });
		});
		row.appendChild(busInput);

		const prePostBtn = document.createElement("button");
		prePostBtn.type = "button";
		prePostBtn.className = "pre-post-btn";
		prePostBtn.textContent = isPost ? "POST" : "PRE";
		prePostBtn.title = "Toggle pre/post-fader";
		prePostBtn.addEventListener("click", () => this._toggleSendPrePost(send, isPost, chainNode));
		row.appendChild(prePostBtn);

		return row;
	}

	// "post" moves the <Send> to right after the channel's <GainNode> (taps
	// the signal after the fader); toggling back to "pre" moves it back to
	// the usual insert/pre-send spot (after EQ, before pan/gain) — per
	// Hans's exact wording.
	_toggleSendPrePost(send, isCurrentlyPost, chainNode) {
		const chainNow = ops.findNodeById(xmlStore.root, chainNode.id);
		if (!chainNow) return;
		if (isCurrentlyPost) {
			const rolesNow = this._classifyChain(chainNow);
			xmlStore.reparentNode(send.id, chainNow.id, this._insertPositionAfterEq(chainNow, rolesNow));
		} else {
			const gainNodeNow = chainNow.children.find((c) => c.tagName === "GainNode");
			const targetIndex = gainNodeNow ? chainNow.children.findIndex((c) => c.id === gainNodeNow.id) + 1 : chainNow.children.length;
			xmlStore.reparentNode(send.id, chainNow.id, targetIndex);
		}
	}

	_buildAddSendSlot(chainNode, roles) {
		const slot = document.createElement("div");
		slot.className = "send-row add-send";
		slot.textContent = "+";
		slot.title = "Add send";
		slot.addEventListener("click", () => {
			const chainNow = ops.findNodeById(xmlStore.root, chainNode.id);
			if (!chainNow) return;
			const rolesNow = this._classifyChain(chainNow);
			xmlStore.insertNewChild(chainNow.id, "Send", {}, this._insertPositionAfterEq(chainNow, rolesNow));
		});
		return slot;
	}
}

customElements.define("wa-mixer-view", WaMixerView);
