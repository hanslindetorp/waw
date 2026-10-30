import { formatGainAttribute } from "../waxml-integration/gain-units.js";
import { evaluate, requiredReads, readKey } from "../assessment/evaluate.js";
import { drawTargets } from "../assessment/targets.js";

// Recipe: "A/B matching". The student hears a reference (A) and their own
// version (B) of the same sound and adjusts B until it matches A. A balance
// task is the same thing (the volume of one source matched to a reference
// mix), so this one recipe covers the first family of tasks. Per Hans
// (2026-10-17): recipes first — deterministic generators of the graph, the
// Stage view and the assessment — and an AI assistant later, on top, only
// filling in this recipe's form.
//
// This file is pure: it describes what a task consists of as plain data and
// touches no store (ab-task.js puts it into the open project). The graph is
// what the Mixer builds as a "Full Channel Strip" — twice — fed by ONE source:
//
//   <AudioBufferSourceNode id="<p>-src" src=… loop="true" output="#<p>-a, #<p>-b"/>     a sound file
//   <OscillatorNode/Noise id="<p>-src" output="#<p>-gate"/> + <GainNode id="<p>-gate"   a continuous source,
//        gain="$gate<p>" output="#<p>-a, #<p>-b"/> + <Var name="gate<p>" default="0"/>   switched on and off by the Var
//   <Mixer solo="$solo<p>" blend="0" transitionTime="50">
//     <Chain id="<p>-a"> mute, high shelf, peaking, low shelf, pan, volume </Chain>     the reference
//     <Chain id="<p>-b"> … </Chain>                                                      the student's
//   </Mixer>
//   <Command> start, stop (the source) and listen-a / listen-b (set $solo<p> to 0 / 1)
//
// The same source feeds both strips, so A and B are the same sound at the same
// moment, and the Mixer's solo (blend 0: a hard switch, so no value in between
// lets both strips through; 50 ms transition time to keep the switch from clicking)
// is the A/B switch. A sound
// file has start and stop of its own (trig/stop); an oscillator or noise runs
// from the moment it is created and has none, hence the gate.
//
// The source is described by { kind, ... } so that more can follow — kind
// "section" (a <Section> of an existing <Composition>, for matching the balance
// between tracks of a mix) needs a source per strip and is left for later; the
// rest of the recipe does not depend on how the sound is made.

const MUTE_SUFFIX = "-mute";
const GATE_LEVEL = 0.25; // an oscillator or noise is much louder than a recorded sound: -12 dB
export const OSCILLATOR_WAVES = ["sine", "triangle", "square", "sawtooth"];
export const SOURCE_KINDS = ["file", "noise", "oscillator"];

// The parts of the strip a task can be about, in signal order (as the Mixer
// builds them). `start` is what a newly created element is set to — the same
// values as the Mixer's, so B starts where a fresh strip starts.
export const SLOTS = {
	highshelf: { suffix: "hs", tagName: "BiquadFilterNode", label: "High shelf", start: { frequency: 4000, gain: 0, Q: 1 } },
	peaking: { suffix: "pk", tagName: "BiquadFilterNode", label: "Peaking", start: { frequency: 400, gain: 0, Q: 1 } },
	lowshelf: { suffix: "ls", tagName: "BiquadFilterNode", label: "Low shelf", start: { frequency: 150, gain: 0, Q: 1 } },
	pan: { suffix: "pan", tagName: "StereoPannerNode", label: "Pan", start: { pan: 0 } },
	volume: { suffix: "vol", tagName: "GainNode", label: "Volume", start: { gain: 0 } }
};

// How an attribute is compared: octaves for frequency and Q (doubling is what
// matters), dB or plain units for the rest.
export const ATTRIBUTES = {
	frequency: { label: "Frequency", scale: "log2", unit: "Hz" },
	Q: { label: "Q", scale: "log2", unit: "" },
	gain: { label: "Gain", scale: "linear", unit: "dB" },
	pan: { label: "Pan", scale: "linear", unit: "" }
};

// Where a miss starts to cost points (`full`: still full marks) and where it
// gives none (`zero`), per attribute, in the units of its scale.
// "precise" is for a value the student can hear to a few cents — two oscillators
// tuned against each other, say, where 1 Hz around 400 Hz (4 cents) is audible —
// while "forgiving" suits a filter cutoff that is judged by ear to a fifth of an octave.
export const STRICTNESS = {
	forgiving: { frequency: [0.2, 1.5], Q: [0.4, 2], gain: [2, 9], pan: [0.2, 1] },
	medium: { frequency: [0.1, 1], Q: [0.2, 1.5], gain: [1, 6], pan: [0.1, 0.6] },
	strict: { frequency: [0.05, 0.5], Q: [0.1, 1], gain: [0.5, 3], pan: [0.05, 0.4] },
	precise: { frequency: [0.005, 0.05], Q: [0.03, 0.3], gain: [0.1, 1], pan: [0.01, 0.1] }
};
export const PRECISION_LEVELS = Object.keys(STRICTNESS);
export const PRECISION_LABELS = { forgiving: "Forgiving", medium: "Medium", strict: "Strict", precise: "Precise" };

// The precision of one value: its own if the author set one, else the task's.
export const precisionOf = (meta, key) => (STRICTNESS[meta.precision?.[key]] ? meta.precision[key] : STRICTNESS[meta.strictness] ? meta.strictness : "medium");

// What a precision level means for an attribute, in units a teacher knows:
// { full, zero, unit } — full marks within ±full, no points beyond ±zero. A
// frequency is in cents (1/100 of a semitone), a Q in per cent.
export function toleranceText(attr, level) {
	const [full, zero] = (STRICTNESS[level] || STRICTNESS.medium)[attr];
	const convert = { frequency: (x) => Math.round(x * 1200), Q: (x) => Math.round((Math.pow(2, x) - 1) * 100) }[attr] || ((x) => Math.round(x * 1000) / 1000);
	const unit = { frequency: "cents", Q: "%", gain: "dB", pan: "" }[attr] || "";
	return { full: convert(full), zero: convert(zero), unit };
}

export const DEFAULT_INSTRUCTION = "Listen to A, then to B. Adjust B until it sounds like A. Press Done when you think they match.";

export const slotAttributes = (slot) => Object.keys(SLOTS[slot]?.start || {});
export const editableKey = (slot, attr) => `${slot}.${attr}`;
export const elementId = (prefix, chain, slot) => `${prefix}-${chain}-${SLOTS[slot].suffix}`;
export const chainId = (prefix, chain) => `${prefix}-${chain}`;

// A value is "back at its start" when it is this close to it (a knob rounds
// what it writes): frequency within 1 %, gain 0.05 dB, Q 0.02, pan 0.01.
export function isAtStart(slot, attr, value) {
	const start = SLOTS[slot]?.start[attr];
	if (!Number.isFinite(value) || !Number.isFinite(start)) return false;
	const tolerance = { frequency: 0.01 * Math.abs(start), gain: 0.05, Q: 0.02, pan: 0.01 }[attr] ?? 1e-6;
	return Math.abs(value - start) <= tolerance;
}

// The element attribute for a value of a slot, as written in the document.
export function attributeText(slot, attr, value) {
	if (slot === "volume" && attr === "gain") return formatGainAttribute("GainNode", value);
	return String(Math.round(value * 1000) / 1000);
}

function slotElement(prefix, chain, slot) {
	const def = SLOTS[slot];
	const attributes = { id: elementId(prefix, chain, slot), label: def.label };
	if (def.tagName === "BiquadFilterNode") attributes.type = slot;
	Object.keys(def.start).forEach((attr) => {
		attributes[attr] = attributeText(slot, attr, def.start[attr]);
	});
	return { tagName: def.tagName, attributes, children: [] };
}

function node(tagName, attributes, children = []) {
	return { tagName, attributes, children };
}

// The source, with what starts and stops it. -> { nodes: [root elements], start: Command attributes, stop: Command attributes }
function sourceParts(prefix, source) {
	const id = `${prefix}-src`;
	const both = `#${chainId(prefix, "a")}, #${chainId(prefix, "b")}`;
	if (source?.kind === "file") {
		return {
			nodes: [node("AudioBufferSourceNode", { id, src: source.src || "", loop: "true", output: both })],
			start: { type: "trig", value: `#${id}` },
			stop: { type: "stop", value: `#${id}` }
		};
	}
	const gate = `${prefix}-gate`;
	const gateVar = `gate${prefix}`;
	const generator =
		source?.kind === "noise"
			? node("Noise", { id, output: `#${gate}` })
			: node("OscillatorNode", { id, type: OSCILLATOR_WAVES.includes(source?.wave) ? source.wave : "sine", frequency: String(source?.frequency || 220), output: `#${gate}` });
	return {
		nodes: [node("Var", { name: gateVar, default: "0", mapin: "0,1", mapout: `0,${GATE_LEVEL}` }), generator, node("GainNode", { id: gate, gain: `$${gateVar}`, output: both })],
		start: { type: "set", variable: `$${gateVar}`, value: "1" },
		stop: { type: "set", variable: `$${gateVar}`, value: "0" }
	};
}

// What goes into the document for a new task, all at their starting values (A is
// set up afterwards, by turning the controls). -> { commands, sourceNodes, mixer, meta }
export function buildAbGraph(spec) {
	const prefix = spec.prefix || "ab1";
	const soloVar = `solo${prefix}`;
	const slots = (spec.slots || []).filter((s) => SLOTS[s]);
	const source = sourceParts(prefix, spec.source);
	const strip = (chain) =>
		node("Chain", { id: chainId(prefix, chain), label: chain === "a" ? "A (reference)" : "B (yours)" }, [
			node("GainNode", { id: `${chainId(prefix, chain)}${MUTE_SUFFIX}`, label: "Mute", gain: "1" }),
			...Object.keys(SLOTS).map((slot) => slotElement(prefix, chain, slot))
		]);
	const mixer = node("Mixer", { id: `${prefix}-mix`, label: spec.title || "A/B task", blend: "0", transitionTime: "50", solo: `$${soloVar}` }, [strip("a"), strip("b")]);
	const commands = [
		node("Command", { id: `${prefix}-start`, label: "Start", ...source.start }),
		node("Command", { id: `${prefix}-stop`, label: "Stop", ...source.stop }),
		node("Command", { id: `${prefix}-listen-a`, type: "set", variable: `$${soloVar}`, value: "0", label: "A" }),
		node("Command", { id: `${prefix}-listen-b`, type: "set", variable: `$${soloVar}`, value: "1", label: "B" })
	];
	const meta = {
		recipe: "ab",
		prefix,
		source: { ...spec.source },
		display: spec.display === "strip" ? "strip" : "objects",
		slots,
		editable: [],
		fixed: [], // values the author took out of what the student adjusts: B follows A's
		ranges: {},
		precision: {},
		strictness: STRICTNESS[spec.strictness] ? spec.strictness : "medium"
	};
	return { commands, sourceNodes: source.nodes, mixer, meta };
}

// The Stage view's items for a task: heading, instruction, A / B / Stop, and what
// B is made of — a card for each chosen part, or the whole strip. Only the
// attributes in meta.editable can be changed by the student, and everything of
// B is dimmed while A is what is heard.
export function buildStageItems(meta, { title, instruction } = {}) {
	const p = meta.prefix;
	const group = p;
	const items = [
		{ type: "heading", x: 24, y: 20, w: 800, text: title || "Match the sound" },
		{ type: "text", x: 24, y: 76, w: 800, text: instruction || DEFAULT_INSTRUCTION },
		{ type: "command", x: 24, y: 150, w: 70, ref: `${p}-listen-a`, toggleGroup: group, starts: `${p}-start` },
		{ type: "command", x: 106, y: 150, w: 70, ref: `${p}-listen-b`, toggleGroup: group, starts: `${p}-start` },
		{ type: "command", x: 188, y: 150, w: 70, ref: `${p}-stop`, clears: group }
	];
	const inactiveWhen = { group, ref: `${p}-listen-a` };
	if (meta.display === "strip") {
		items.push({ type: "strip", x: 24, y: 240, w: 360, ref: chainId(p, "b"), editable: editableList(meta), inactiveWhen });
	} else {
		meta.slots.forEach((slot, i) => {
			items.push({
				type: "element",
				x: 24 + (i % 3) * 296,
				y: 240 + Math.floor(i / 3) * 270,
				w: 280,
				ref: elementId(p, "b", slot),
				editable: slotAttributes(slot).filter((attr) => meta.editable.includes(editableKey(slot, attr))),
				inactiveWhen
			});
		});
	}
	return items;
}

// For a strip: what is editable, as "<element id>.<attribute>".
export function editableList(meta) {
	return meta.editable.map((key) => {
		const [slot, attr] = key.split(".");
		return `${elementId(meta.prefix, "b", slot)}.${attr}`;
	});
}

// One criterion per attribute the student may change: B's value against A's.
export function criteriaFor(meta) {
	const criteria = [];
	meta.editable.forEach((key) => {
		const [slot, attr] = key.split(".");
		const kind = ATTRIBUTES[attr];
		if (!SLOTS[slot] || !kind || !(attr in SLOTS[slot].start)) return;
		const [full, zero] = STRICTNESS[precisionOf(meta, key)][attr];
		const asDb = attr === "gain";
		criteria.push({
			id: `${slot}-${attr}`,
			label: `${SLOTS[slot].label} ${kind.label.toLowerCase()}`,
			weight: 1,
			type: "match",
			a: { ref: elementId(meta.prefix, "b", slot), attr, ...(asDb ? { as: "db" } : {}) },
			b: { ref: elementId(meta.prefix, "a", slot), attr, ...(asDb ? { as: "db" } : {}) },
			scale: kind.scale,
			full,
			zero
		});
	});
	return criteria;
}

// How many decimals a drawn value of an attribute has (what the controls write).
const DRAW_DECIMALS = { frequency: 0, gain: 1, Q: 1, pan: 1 };

// The targets that are drawn per student (see assessment/targets.js): strip A's
// values that have a random range. Only values the student has to find count.
// `startValues` ({ "<slot>.<attr>": number }, what B starts at) lets a target be
// kept so far from B's start that B scores nothing on it: at least the distance
// where the marking gives no points.
export function targetsFor(meta, startValues = {}) {
	const targets = [];
	meta.editable.forEach((key) => {
		const range = meta.ranges?.[key];
		const [slot, attr] = key.split(".");
		if (!range || !SLOTS[slot] || !(attr in SLOTS[slot].start) || !(range.max > range.min)) return;
		const ref = elementId(meta.prefix, "a", slot);
		const asDb = attr === "gain";
		const scale = ATTRIBUTES[attr].scale === "log2" && range.min > 0 ? "log2" : "linear";
		targets.push({
			key: readKey({ ref, attr, as: asDb ? "db" : "number" }),
			ref,
			attr,
			write: slot === "volume" && attr === "gain" ? "dB" : "number",
			min: range.min,
			max: range.max,
			scale,
			decimals: DRAW_DECIMALS[attr] ?? 2,
			...(Number.isFinite(startValues[key]) ? { start: startValues[key], separation: STRICTNESS[precisionOf(meta, key)][attr][1] } : {})
		});
	});
	return targets;
}

export const DEFAULT_BANDS = [
	{ min: 0.9, text: "Excellent - B matches A." },
	{ min: 0.6, text: "Getting there." },
	{ min: 0, text: "Not yet - try again." }
];

// The assessment of a task, with the recipe's own data (`task`) kept in it: it is
// the author's, so it stays out of what is published (assessments are kept apart
// from the project, see project-manager.js's exportForPublishing).
export function buildAssessment(meta, previous = null, startValues = {}) {
	return {
		max: previous?.max ?? 10,
		pass: previous?.pass ?? 0.6,
		reveal: previous?.reveal ?? "direction",
		bands: previous?.bands ?? DEFAULT_BANDS.map((b) => ({ ...b })),
		criteria: criteriaFor(meta),
		targets: targetsFor(meta, startValues),
		task: meta
	};
}

// The self-test: does the task do what a task must? B set exactly to A has to give
// full marks and B as it starts has to fail — otherwise the task is impossible or
// already solved. `read(ref, attr, as)` gives an element's value (a number).
// -> { ok, facit, start, problems: [text] }
export function selfTestAbMatching(assessment, read) {
	const problems = [];
	const wanted = requiredReads(assessment);
	if (!wanted.length) {
		problems.push("Nothing is being matched yet: change something in A — what you change there is what the student has to find.");
		return { ok: false, facit: null, start: null, problems };
	}
	const start = {};
	const facit = {};
	wanted.forEach((r) => {
		start[readKey(r)] = read(r.ref, r.attr, r.as);
	});
	// the student's B set exactly to A: B's reads give A's values (a is B's element, b is A's)
	assessment.criteria.forEach((c) => {
		const aValue = read(c.b.ref, c.b.attr, c.b.as);
		facit[readKey(c.a)] = aValue;
		facit[readKey(c.b)] = aValue;
	});
	const facitResult = evaluate(assessment, facit);
	const startResult = evaluate(assessment, start);
	if (wanted.some((r) => !Number.isFinite(start[readKey(r)]))) problems.push("A value could not be read from the document.");
	if (facitResult.score < facitResult.max - 1e-9) problems.push("B set exactly to A does not give full marks.");
	if (startResult.passed) problems.push("B as it starts already passes — A is too close to B's starting values.");
	// With random targets: how often would B as it starts already pass?
	let passRate = null;
	if (assessment.targets?.length) {
		let passed = 0;
		const draws = 100;
		for (let i = 0; i < draws; i++) {
			const values = { ...start };
			drawTargets(assessment.targets, `check${i}`).forEach((t) => (values[t.key] = t.value));
			if (evaluate(assessment, values).passed) passed++;
		}
		passRate = passed / draws;
		if (passRate > 0.05) problems.push(`${Math.round(passRate * 100)} % of the possible random targets are so close to B's starting values that B passes without being touched.`);
	}
	return { ok: !problems.length, facit: facitResult, start: startResult, passRate, problems };
}
