import { xmlStore } from "../xml-editor/xml-store.js";
import { stageStore } from "../project/stage-store.js";
import { assessmentStore } from "../project/assessment-store.js";
import { collectValues } from "../assessment/collect.js";
import { readKey } from "../assessment/evaluate.js";
import { buildAbGraph, buildStageItems, buildAssessment, selfTestAbMatching, SLOTS, editableKey, elementId, editableList, slotAttributes, attributeText, isAtStart } from "./ab-matching.js";

// Puts an A/B task (see ab-matching.js) into the open project and keeps it in
// step with the document afterwards. A project holds many tasks (one Stage
// view each, see stage-store.js), so everything a task adds is named after a
// prefix that is free in this document (ab1, ab2, ...). The recipe's own data —
// the source, the parts shown, which attributes the student may change, the
// ranges for random targets — is kept in the task's assessment (`task`),
// which is the author's and is not published.
//
// The author sets a task up by turning the controls of strip A in the
// document itself (an edit in the document is a normal, undoable edit): what
// is changed there is what the student has to find, so it is marked editable
// automatically (see markChanged). All of a task's changes are made in one
// burst, which edit-history coalesces into one undo step.

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

export const taskOfView = (viewId) => assessmentStore.get(viewId)?.task || null;

// The value of an attribute as the assessment reads it (a number or undefined).
export function readDocumentValue(ref, attr, as) {
	const read = { ref, attr, as: as === "db" ? "db" : "number" };
	return collectValues([read])[readKey(read)];
}

// Brings everything derived from a task in step with its data and the
// document: the criteria of the assessment, which attributes the student may
// change on the Stage. -> the self-test's report, { ok, facit, start, problems }.
export function syncAbTask(viewId) {
	const previous = assessmentStore.get(viewId);
	const meta = previous?.task;
	if (!meta) return null;
	const assessment = buildAssessment(meta, previous, readStrip(meta, "b"));
	assessmentStore.set(viewId, assessment);
	stageStore.setViewTargets(viewId, assessment.targets);
	const bySlot = new Map(meta.slots.map((slot) => [elementId(meta.prefix, "b", slot), slot]));
	stageStore.editViewItems(viewId, (items) =>
		items.map((item) => {
			if (item.type === "element" && bySlot.has(item.ref)) {
				const slot = bySlot.get(item.ref);
				const editable = slotAttributes(slot).filter((attr) => meta.editable.includes(editableKey(slot, attr)));
				// a part with nothing to adjust is not shown to the student
				const { hidden, ...rest } = item;
				return editable.length ? { ...rest, editable } : { ...rest, editable, hidden: true };
			}
			if (item.type === "strip" && item.ref === `${meta.prefix}-b`) return { ...item, editable: editableList(meta) };
			return item;
		})
	);
	return selfTestAbMatching(assessment, readDocumentValue);
}

// Writes a change of the recipe's data (`patch` replaces those keys) and syncs.
export function updateTaskMeta(viewId, patch) {
	const a = assessmentStore.get(viewId);
	if (!a?.task) return null;
	assessmentStore.set(viewId, { ...a, task: { ...a.task, ...patch } });
	return syncAbTask(viewId);
}

// An attribute the student may (not) change.
export function setEditable(viewId, slot, attr, on) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const key = editableKey(slot, attr);
	const has = meta.editable.includes(key);
	if (on === has) return syncAbTask(viewId);
	return updateTaskMeta(viewId, { editable: on ? [...meta.editable, key] : meta.editable.filter((k) => k !== key) });
}

// The values of strip A's parts as they are in the document: { "<slot>.<attr>": number }.
export function readStrip(meta, chain) {
	const values = {};
	meta.slots.forEach((slot) => {
		slotAttributes(slot).forEach((attr) => {
			values[editableKey(slot, attr)] = readDocumentValue(elementId(meta.prefix, chain, slot), attr, attr === "gain" ? "db" : "number");
		});
	});
	return values;
}

// What changed in strip A since `before` (a readStrip result) becomes editable —
// and what was changed but is back at its starting value (a double-click on a
// control resets it) stops being. Returns the new `before`.
export function markChanged(viewId, before) {
	const meta = taskOfView(viewId);
	if (!meta) return before;
	const now = readStrip(meta, "a");
	const added = [];
	const dropped = [];
	Object.keys(now).forEach((key) => {
		if (!Number.isFinite(now[key])) return;
		const [slot, attr] = key.split(".");
		const atStart = isAtStart(slot, attr, now[key]);
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
export function resetAttribute(viewId, slot, attr) {
	const meta = taskOfView(viewId);
	if (!meta) return null;
	const el = findElement(elementId(meta.prefix, "a", slot));
	if (el) xmlStore.updateAttributes(el.id, { ...el.attributes, [attr]: attributeText(slot, attr, SLOTS[slot].start[attr]) });
	const key = editableKey(slot, attr);
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
		const [slot, attr] = key.split(".");
		const start = SLOTS[slot].start[attr];
		const tolerance = attr === "frequency" ? SNAP_TOLERANCE.frequency * start : SNAP_TOLERANCE[attr];
		if (!Number.isFinite(now[key]) || Math.abs(now[key] - start) > tolerance) return;
		if (now[key] !== start || meta.editable.includes(key)) {
			resetAttribute(viewId, slot, attr);
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

// Takes the random range of a value away.
export function clearRange(viewId, key) {
	const meta = taskOfView(viewId);
	if (!meta?.ranges?.[key]) return null;
	const ranges = { ...meta.ranges };
	delete ranges[key];
	return updateTaskMeta(viewId, { ranges });
}

function findElement(id) {
	const walk = (n) => (n.attributes.id === id ? n : n.children.map(walk).find(Boolean));
	return xmlStore.root ? walk(xmlStore.root) : null;
}

// Removes a task altogether: its Stage view, its assessment and everything it
// put into the document.
export function deleteAbTask(viewId) {
	const meta = taskOfView(viewId);
	if (!meta) return false;
	const p = meta.prefix;
	const doomed = xmlStore.root.children.filter((c) => (c.attributes.id || "").startsWith(`${p}-`) || (c.tagName === "Var" && c.attributes.name === `gate${p}`));
	doomed.forEach((c) => xmlStore.removeNode(c.id));
	assessmentStore.remove(viewId);
	stageStore.removeView(viewId);
	return true;
}



export { SLOTS };
