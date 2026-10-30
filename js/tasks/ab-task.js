import { xmlStore } from "../xml-editor/xml-store.js";
import { stageStore } from "../project/stage-store.js";
import { assessmentStore } from "../project/assessment-store.js";
import { collectValues } from "../assessment/collect.js";
import { readKey } from "../assessment/evaluate.js";
import { buildAbGraph, buildStageItems, buildAssessment, selfTestAbMatching, SLOTS, editableKey, elementId, editableList, slotAttributes } from "./ab-matching.js";

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
	const assessment = buildAssessment(meta, previous);
	assessmentStore.set(viewId, assessment);
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

// What changed in strip A since `before` (a readStrip result) becomes editable.
// Returns the new `before`.
export function markChanged(viewId, before) {
	const meta = taskOfView(viewId);
	if (!meta) return before;
	const now = readStrip(meta, "a");
	const changed = Object.keys(now).filter((key) => Number.isFinite(now[key]) && before[key] !== now[key] && !meta.editable.includes(key));
	if (changed.length) updateTaskMeta(viewId, { editable: [...meta.editable, ...changed] });
	return now;
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
