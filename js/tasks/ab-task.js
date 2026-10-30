import { xmlStore } from "../xml-editor/xml-store.js";
import { stageStore } from "../project/stage-store.js";
import { assessmentStore } from "../project/assessment-store.js";
import { collectValues } from "../assessment/collect.js";
import { readKey } from "../assessment/evaluate.js";
import { buildAbGraph, buildStageItems, buildAssessment, selfTestAbMatching, sourceParts, SLOTS, editableKey, elementId, editableList, partAttributes, partOf, attributeText, isAtStart, startsOf } from "./ab-matching.js";

// Puts an A/B task (see ab-matching.js) into the open project and keeps it in
// step with the document afterwards. A project holds many tasks (one Stage
// view each, see stage-store.js), so everything a task adds is named after a
// prefix that is free in this document (ab1, ab2, ...). The recipe's own data —
// the source, the parts, which attributes the student may change, the ranges for
// random targets — is kept in the task's assessment (`task`), which is the
// author's and is not published.
//
// The document is the truth. The author sets a task up by turning the controls of
// strip A in the document itself (an edit in the document is a normal, undoable
// edit): what is changed there is what the student has to find, so it is marked
// editable automatically (see markChanged). The two strips are kept alike by
// reconcileStrips: a filter or an insert added to (or deleted from) one of them is
// added to (deleted from) the other, and what the Stage shows follows. A task is
// made of elements that must not be deleted from underneath it, which a removal
// guard (see below) sees to.
//
// A task is self-contained and its ids all start with its prefix, which is what
// lets a task be copied into another project later (a library of tasks): see
// taskSummary and the library notes in docs/architecture-overview.md.

// ── the data of a task ──

// Tasks made before parts were named by their element ids (version 2) have their
// values under the old slot names; they are read as if made today.
const OLD_SLOT_IDS = { highshelf: "hs", peaking: "pk", lowshelf: "ls", pan: "pan", volume: "vol" };

function normalizeMeta(meta) {
	if (!meta || meta.version >= 2) return meta;
	const key = (k) => {
		const [s, a] = k.split(".");
		return `${OLD_SLOT_IDS[s] || s}.${a}`;
	};
	const keyed = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [key(k), v]));
	const parts = Object.keys(SLOTS).map((id) => ({ id, tagName: SLOTS[id].tagName, label: SLOTS[id].label, start: { ...SLOTS[id].start } }));
	return {
		...meta,
		version: 2,
		parts,
		known: parts.map((p) => p.id),
		shown: (meta.slots || []).map((s) => OLD_SLOT_IDS[s] || s),
		editable: (meta.editable || []).map(key),
		fixed: (meta.fixed || []).map(key),
		ranges: keyed(meta.ranges),
		precision: keyed(meta.precision)
	};
}

export const taskOfView = (viewId) => normalizeMeta(assessmentStore.get(viewId)?.task) || null;

// Every view that is a task: [{ viewId, meta }].
export function allTasks() {
	return assessmentStore
		.viewIds()
		.map((viewId) => ({ viewId, meta: taskOfView(viewId) }))
		.filter((t) => t.meta);
}

// What a library of tasks would show and search: the title and the instruction as they
// are on the Stage now (the author edits them there), the sound and what is matched.
export function taskSummary(viewId) {
	const meta = taskOfView(viewId);
	const view = stageStore.getView(viewId);
	if (!meta || !view) return null;
	return {
		viewId,
		title: view.items.find((i) => i.type === "heading")?.text || view.name,
		name: view.name,
		instruction: view.items.find((i) => i.type === "text")?.text || "",
		recipe: meta.recipe,
		source: meta.source?.kind,
		matched: (meta.editable || []).length
	};
}

// "ab1", "ab2", ... — the first not used by any id in the document.
export function nextTaskPrefix(root) {
	const used = new Set();
	const walk = (n) => {
		const m = /^ab(\d+)-/.exec(n.attributes.id || "");
		if (m) used.add(Number(m[1]));
		n.children.forEach(walk);
	};
	if (root) walk(root);
	let n = 1;
	while (used.has(n)) n++;
	return `ab${n}`;
}

function findElement(id) {
	const walk = (n) => (n.attributes.id === id ? n : n.children.map(walk).find(Boolean));
	return xmlStore.root ? walk(xmlStore.root) : null;
}

// What a task makes of a new Stage view: where its commands, source and mixer
// go in the document.
function insertGraph(graph) {
	let at = 0;
	xmlStore.root.children.forEach((c, i) => {
		if (c.tagName === "Command" || c.tagName === "Var") at = i + 1;
	});
	graph.commands.forEach((c, i) => xmlStore.insertNodeTree(xmlStore.root.id, c, at + i));
	graph.sourceNodes.forEach((n) => xmlStore.insertNodeTree(xmlStore.root.id, n, xmlStore.root.children.length));
	xmlStore.insertNodeTree(xmlStore.root.id, graph.mixer, xmlStore.root.children.length);
}

// -> { viewId, meta } or { error }
export function createAbTask(spec) {
	if (!xmlStore.root) return { error: "There is no project open." };
	const graph = buildAbGraph({ ...spec, prefix: nextTaskPrefix(xmlStore.root) });
	insertGraph(graph);
	const view = stageStore.addView(spec.title || "A/B task");
	buildStageItems(graph.meta, spec).forEach(({ type, ...fields }) => stageStore.addItem(type, fields));
	assessmentStore.set(view.id, buildAssessment(graph.meta));
	return { viewId: view.id, meta: graph.meta };
}

// The value of an attribute as the assessment reads it (a number or undefined).
export function readDocumentValue(ref, attr, as) {
	const read = { ref, attr, as: as === "db" ? "db" : "number" };
	return collectValues([read])[readKey(read)];
}

// ── keeping everything in step ──

// Brings everything derived from a task in step with its data and the
// document: the criteria of the assessment, which attributes the student may
// change on the Stage. -> the self-test's report, { ok, facit, start, problems }.
export function syncAbTask(viewId) {
	const previous = assessmentStore.get(viewId);
	let meta = normalizeMeta(previous?.task);
	if (!meta) return null;
	meta = refreshParts(meta);
	const assessment = buildAssessment(meta, previous, readStrip(meta, "b"));
	if (JSON.stringify(assessment) !== JSON.stringify(previous)) assessmentStore.set(viewId, assessment);
	stageStore.setViewTargets(viewId, assessment.targets);
	const shown = meta.display === "strip" ? [] : meta.shown.filter((id) => partOf(meta, id));
	const refs = new Map(shown.map((id) => [elementId(meta.prefix, "b", id), id]));
	stageStore.editViewItems(viewId, (items) => {
		const next = items
			.filter((item) => item.type !== "element" || !(item.ref || "").startsWith(`${meta.prefix}-b-`) || refs.has(item.ref)) // a part that is gone has no card
			.map((item) => {
				if (item.type === "element" && refs.has(item.ref)) {
					const id = refs.get(item.ref);
					const editable = partAttributes(partOf(meta, id)).filter((attr) => meta.editable.includes(editableKey(id, attr)));
					// a part with nothing to adjust is not shown to the student
					const { hidden, ...rest } = item;
					return editable.length ? { ...rest, editable } : { ...rest, editable, hidden: true };
				}
				if (item.type === "strip" && item.ref === `${meta.prefix}-b`) return { ...item, editable: editableList(meta) };
				return item;
			});
		return next;
	});
	return selfTestAbMatching(assessment, readDocumentValue);
}

// Writes a change of the recipe's data (`patch` replaces those keys) and syncs.
export function updateTaskMeta(viewId, patch) {
	const a = assessmentStore.get(viewId);
	if (!a?.task) return null;
	assessmentStore.set(viewId, { ...a, task: { ...normalizeMeta(a.task), ...patch } });
	return syncAbTask(viewId);
}

// The parts of the task as the document has them: what is in strip A (the mute
// aside), in order. A part keeps the start values it had; a new one starts at what
// it was created with.
function refreshParts(meta) {
	const chain = findElement(`${meta.prefix}-a`);
	if (!chain) return meta;
	const parts = chain.children
		.filter((c) => (c.attributes.id || "").startsWith(`${meta.prefix}-a-`) && c.attributes.id !== `${meta.prefix}-a-mute`)
		.map((c) => {
			const id = c.attributes.id.slice(`${meta.prefix}-a-`.length);
			const known = (meta.parts || []).find((p) => p.id === id);
			const twin = findElement(elementId(meta.prefix, "b", id));
			return { id, tagName: c.tagName, label: c.attributes.label || known?.label || c.tagName, start: known?.start || startsOf(c.tagName, (twin || c).attributes) };
		});
	if (JSON.stringify(parts) === JSON.stringify(meta.parts)) return meta;
	const ids = new Set(parts.map((p) => p.id));
	const gone = (key) => !ids.has(key.split(".")[0]);
	const keyed = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !gone(k)));
	const next = {
		...meta,
		parts,
		shown: (meta.shown || []).filter((id) => ids.has(id)),
		editable: (meta.editable || []).filter((k) => !gone(k)),
		fixed: (meta.fixed || []).filter((k) => !gone(k)),
		ranges: keyed(meta.ranges),
		precision: keyed(meta.precision)
	};
	const a = assessmentStore.get(findViewOfPrefix(meta.prefix));
	if (a) assessmentStore.set(findViewOfPrefix(meta.prefix), { ...a, task: next });
	return next;
}

function findViewOfPrefix(prefix) {
	return allTasks().find((t) => t.meta.prefix === prefix)?.viewId;
}

// ── what the student adjusts, and what is fixed ──

// An attribute the student may (not) change. Taking one out FIXES it: B is set to
// A's value and from then on follows A (see markChanged), so what the author sets on
// A for a value the student can't change is what B has too. Putting it back lets the
// student adjust it (and A is what it has to be found against) again.
export function setEditable(viewId, part, attr, on) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const key = editableKey(part, attr);
	const has = meta.editable.includes(key);
	const fixed = (meta.fixed || []).filter((k) => k !== key);
	if (on === has) return syncAbTask(viewId);
	if (!on) {
		fixed.push(key);
		followA(meta, part, attr);
	}
	return updateTaskMeta(viewId, { editable: on ? [...meta.editable, key] : meta.editable.filter((k) => k !== key), fixed });
}

// B gets the value A has — exactly as A has it written.
function followA(meta, part, attr) {
	const a = findElement(elementId(meta.prefix, "a", part));
	const b = findElement(elementId(meta.prefix, "b", part));
	const def = partOf(meta, part);
	if (!a || !b || !def) return;
	const text = a.attributes[attr] !== undefined ? a.attributes[attr] : attributeText(def.tagName, attr, def.start[attr]);
	if (b.attributes[attr] !== text) xmlStore.updateAttributes(b.id, { ...b.attributes, [attr]: text });
}

// The values of a strip's parts as they are in the document: { "<part>.<attr>": number }.
export function readStrip(meta, chain) {
	const values = {};
	(meta.parts || []).forEach((part) => {
		partAttributes(part).forEach((attr) => {
			values[editableKey(part.id, attr)] = readDocumentValue(elementId(meta.prefix, chain, part.id), attr, attr === "gain" ? "db" : "number");
		});
	});
	return values;
}

// What changed in strip A since `before` (a readStrip result) becomes editable —
// and what was changed but is back at its starting value (a double-click on a
// control resets it) stops being. A value the author fixed is not something the
// student finds: B just follows it. Returns the new `before`.
export function markChanged(viewId, before) {
	const meta = taskOfView(viewId);
	if (!meta) return before;
	const now = readStrip(meta, "a");
	const added = [];
	const dropped = [];
	Object.keys(now).forEach((key) => {
		if (!Number.isFinite(now[key])) return;
		const [id, attr] = key.split(".");
		if ((meta.fixed || []).includes(key)) {
			if (before[key] !== now[key]) followA(meta, id, attr);
			return;
		}
		const atStart = isAtStart(partOf(meta, id), attr, now[key]);
		if (before[key] !== now[key] && !atStart && !meta.editable.includes(key)) added.push(key);
		if (atStart && meta.editable.includes(key) && before[key] !== now[key]) dropped.push(key);
	});
	if (added.length || dropped.length) {
		const ranges = { ...(meta.ranges || {}) };
		dropped.forEach((key) => delete ranges[key]);
		updateTaskMeta(viewId, { editable: [...meta.editable.filter((k) => !dropped.includes(k)), ...added], ranges });
	}
	return now;
}

// Puts a value of strip A back to where it starts and takes it out of the task
// (the mark on A, and any random range).
export function resetAttribute(viewId, part, attr) {
	const meta = taskOfView(viewId);
	const def = meta && partOf(meta, part);
	if (!def) return null;
	const el = findElement(elementId(meta.prefix, "a", part));
	if (el) xmlStore.updateAttributes(el.id, { ...el.attributes, [attr]: attributeText(def.tagName, attr, def.start[attr]) });
	const key = editableKey(part, attr);
	const ranges = { ...(meta.ranges || {}) };
	delete ranges[key];
	return updateTaskMeta(viewId, { editable: meta.editable.filter((k) => k !== key), ranges });
}

// How near its start a value of strip A counts as "meant to be at the start" while a
// task is being set up (a drag that comes back close to where it started): the
// attribute is then put exactly at its start and taken out of the task, as a
// double-click would. Only the task creator does this; elsewhere the user has
// full control.
const SNAP_TOLERANCE = { frequency: 0.04, gain: 0.5, Q: 0.15, pan: 0.05 }; // frequency: relative

export function snapToStart(viewId) {
	const meta = taskOfView(viewId);
	if (!meta) return false;
	const now = readStrip(meta, "a");
	let snapped = false;
	Object.keys(now).forEach((key) => {
		const [id, attr] = key.split(".");
		const start = partOf(meta, id)?.start?.[attr];
		if (!Number.isFinite(start)) return;
		const tolerance = attr === "frequency" ? SNAP_TOLERANCE.frequency * start : SNAP_TOLERANCE[attr];
		if (!Number.isFinite(now[key]) || Math.abs(now[key] - start) > tolerance) return;
		if (now[key] !== start || meta.editable.includes(key)) {
			resetAttribute(viewId, id, attr);
			snapped = true;
		}
	});
	return snapped;
}

// How precisely a value has to be found (a level of STRICTNESS), or null for the task's own.
export function setPrecision(viewId, key, level) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const precision = { ...(meta.precision || {}) };
	if (level) precision[key] = level;
	else delete precision[key];
	return updateTaskMeta(viewId, { precision });
}

// The random range of a value: set it (min, max) or take it away (null).
export function setRange(viewId, key, range) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const ranges = { ...(meta.ranges || {}) };
	if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min) ranges[key] = { min: range.min, max: range.max };
	else delete ranges[key];
	return updateTaskMeta(viewId, { ranges });
}

export const clearRange = (viewId, key) => (taskOfView(viewId)?.ranges?.[key] ? setRange(viewId, key, null) : null);

// ── the strips follow each other ──

// A copy of an element (and what is inside it) as plain data, with a new id.
function cloneSpec(node, id) {
	return { tagName: node.tagName, attributes: { ...node.attributes, id }, children: node.children.map((c) => cloneSpec(c, c.attributes.id)) };
}

// Makes strip B have the same elements as strip A and the other way round: what is
// added to one (a filter, an insert, from the Mixer's own "+") is added to the
// other, what is deleted from one (the removal guard has already refused what the
// task needs) is deleted from the other. Elements made by the Mixer have ids of its
// own; they are given the task's (x1, x2, ...). The values of a new part are
// copied once; after that each strip's own. -> whether anything was changed.
export function reconcileStrips(viewId) {
	const meta = taskOfView(viewId);
	if (!meta) return false;
	const p = meta.prefix;
	const chainOf = (which) => findElement(`${p}-${which}`);
	const parts = (chain, which) => (chain ? chain.children.filter((c) => (c.attributes.id || "") !== `${p}-${which}-mute`) : []);
	let changed = false;

	// 1. ids for what the Mixer's own controls added
	for (const which of ["a", "b"]) {
		for (;;) {
			const fresh = parts(chainOf(which), which).find((c) => !(c.attributes.id || "").startsWith(`${p}-${which}-`));
			if (!fresh) break;
			let n = 1;
			const taken = new Set([...parts(chainOf("a"), "a"), ...parts(chainOf("b"), "b")].map((c) => (c.attributes.id || "").replace(`${p}-a-`, "").replace(`${p}-b-`, "")));
			while (taken.has(`x${n}`)) n++;
			xmlStore.updateAttributes(fresh.id, { ...fresh.attributes, id: `${p}-${which}-x${n}` });
			changed = true;
		}
	}

	// 2. what one strip has and the other lacks
	const suffix = (c, which) => c.attributes.id.slice(`${p}-${which}-`.length);
	for (const [from, to] of [["a", "b"], ["b", "a"]]) {
		const src = parts(chainOf(from), from);
		const dstSuffixes = new Set(parts(chainOf(to), to).map((c) => suffix(c, to)));
		for (const el of src) {
			const id = suffix(el, from);
			if (dstSuffixes.has(id)) continue;
			if ((meta.known || []).includes(id)) {
				xmlStore.removeNode(el.id, { force: true }); // it was deleted from the other strip
			} else {
				const chain = chainOf(to);
				const index = Math.min(chain.children.length, chainOf(from).children.findIndex((c) => c.id === el.id));
				xmlStore.insertNodeTree(chain.id, cloneSpec(el, `${p}-${to}-${id}`), index);
			}
			changed = true;
		}
	}

	if (changed) {
		const ids = parts(chainOf("a"), "a").map((c) => suffix(c, "a"));
		const a = assessmentStore.get(viewIdOf(meta));
		if (a) assessmentStore.set(viewIdOf(meta), { ...a, task: { ...normalizeMeta(a.task), known: ids } });
	}
	return changed;
}

function viewIdOf(meta) {
	return findViewOfPrefix(meta.prefix);
}

// Runs reconcileStrips for every task whenever the structure of the document changes
// (an edit that is not just a value turned), once things have settled.
let reconciling = false;
let reconcileTimer = null;
function scheduleReconcile() {
	clearTimeout(reconcileTimer);
	reconcileTimer = setTimeout(() => {
		if (reconciling) return;
		reconciling = true;
		try {
			allTasks().forEach(({ viewId }) => {
				reconcileStrips(viewId);
				syncAbTask(viewId);
			});
		} finally {
			reconciling = false;
		}
	}, 0);
}
xmlStore.addEventListener("change", (e) => {
	if (!reconciling && (!e.detail || e.detail.structural !== false) && assessmentStore.viewIds().length) scheduleReconcile();
});

// ── what is used must not be deleted ──

// The ids of what a task needs: its source, commands, Mixer and strips, the parts the
// student is shown or adjusts. (A part that is only a preset in both strips is free to go.)
function usedIdsOf(meta) {
	const p = meta.prefix;
	const ids = new Set([`${p}-src`, `${p}-gate`, `${p}-mix`, `${p}-a`, `${p}-b`, `${p}-start`, `${p}-stop`, `${p}-listen-a`, `${p}-listen-b`, `${p}-a-mute`, `${p}-b-mute`]);
	const parts = new Set([...(meta.display === "strip" ? [] : meta.shown || []), ...(meta.editable || []).map((k) => k.split(".")[0])]);
	parts.forEach((id) => {
		ids.add(elementId(p, "a", id));
		ids.add(elementId(p, "b", id));
	});
	return ids;
}

xmlStore.addRemovalGuard((nodeId) => {
	if (!xmlStore.root || !assessmentStore.viewIds().length) return null;
	const doomed = [];
	const walk = (n, inside) => {
		const isTarget = n.id === nodeId;
		if (inside || isTarget) doomed.push(n);
		n.children.forEach((c) => walk(c, inside || isTarget));
	};
	walk(xmlStore.root, false);
	for (const { viewId, meta } of allTasks()) {
		const used = usedIdsOf(meta);
		const gateVar = `gate${meta.prefix}`;
		const hit = doomed.some((n) => used.has(n.attributes.id) || (n.tagName === "Var" && n.attributes.name === gateVar));
		if (hit) {
			const name = taskSummary(viewId)?.title || "a task";
			return `This is part of the task "${name}" (its sound, its A/B buttons or what the student sees and adjusts). Take it out of the task first, or delete the whole task.`;
		}
	}
	return null;
});

// ── the sound ──

// Changes the sound of a task: another file, another kind of source. The old file stays in
// the project (another task may use it). The task's buttons keep working: they trig the
// source of this task only (by its id), whatever it is.
export function changeSource(viewId, source) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const p = meta.prefix;
	const old = meta.source || {};
	const parts = sourceParts(p, source);
	const sameKind = old.kind === source.kind;
	const src = findElement(`${p}-src`);
	if (sameKind && src) {
		// the same kind of element: its own attributes
		if (source.kind === "file") xmlStore.updateAttributes(src.id, { ...src.attributes, src: source.src || "" });
		else if (source.kind === "oscillator") xmlStore.updateAttributes(src.id, { ...src.attributes, type: parts.nodes.find((n) => n.tagName === "OscillatorNode").attributes.type, frequency: parts.nodes.find((n) => n.tagName === "OscillatorNode").attributes.frequency });
	} else {
		// another kind of source: out with the old, in with the new
		const gateVar = `gate${p}`;
		xmlStore.root.children.filter((c) => [`${p}-src`, `${p}-gate`].includes(c.attributes.id) || (c.tagName === "Var" && c.attributes.name === gateVar)).forEach((c) => xmlStore.removeNode(c.id, { force: true }));
		let at = 0;
		xmlStore.root.children.forEach((c, i) => {
			if (c.tagName === "Command" || c.tagName === "Var") at = i + 1;
		});
		parts.nodes.forEach((n, i) => xmlStore.insertNodeTree(xmlStore.root.id, n, at + i));
		// and the buttons that start and stop it
		[["start", parts.start, "Start"], ["stop", parts.stop, "Stop"]].forEach(([name, attrs, label]) => {
			const cmd = findElement(`${p}-${name}`);
			if (cmd) xmlStore.updateAttributes(cmd.id, { id: `${p}-${name}`, label, ...attrs });
		});
	}
	return updateTaskMeta(viewId, { source: { ...source } });
}

// Removes a task altogether: its Stage view, its assessment and everything it
// put into the document.
export function deleteAbTask(viewId) {
	const meta = taskOfView(viewId);
	if (!meta) return false;
	const p = meta.prefix;
	const doomed = xmlStore.root.children.filter((c) => (c.attributes.id || "").startsWith(`${p}-`) || (c.tagName === "Var" && c.attributes.name === `gate${p}`));
	doomed.forEach((c) => xmlStore.removeNode(c.id, { force: true }));
	assessmentStore.remove(viewId);
	stageStore.removeView(viewId);
	return true;
}

export { SLOTS };
