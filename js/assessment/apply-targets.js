import { xmlStore } from "../xml-editor/xml-store.js";
import { drawTargets, targetText } from "./targets.js";

// Puts a student's random targets (see targets.js) into the open project: each
// drawn value is written to the attribute it stands for. On a page this runs
// before the student starts, with values the grading server drew (an LTI launch)
// or — for a page opened on its own — ones drawn here from the view's targets.

function findByElementId(elementId) {
	const walk = (n) => (n.attributes.id === elementId ? n : n.children.map(walk).find(Boolean));
	return xmlStore.root ? walk(xmlStore.root) : null;
}

// drawn: [{ ref, attr, write, value }].
export function applyTargets(drawn) {
	const byNode = new Map(); // node id -> its attributes with every drawn value of it written
	(drawn || []).forEach((t) => {
		const node = findByElementId(t.ref);
		if (!node || !Number.isFinite(t.value)) return;
		const attributes = byNode.get(node.id) || { ...node.attributes };
		attributes[t.attr] = targetText(t.write, t.value);
		byNode.set(node.id, attributes);
	});
	// One element at a time (not updateManyAttributes): each edit also reaches the
	// running graph, which a page that has already loaded it needs.
	byNode.forEach((attributes, nodeId) => xmlStore.updateAttributes(nodeId, attributes));
	return byNode.size;
}

// A seed that is the same every time this browser opens this view (a practice
// page has no student to know), kept in the browser.
export function practiceSeed(project, viewId) {
	const key = `waw-target-seed:${project}:${viewId}`;
	try {
		let seed = localStorage.getItem(key);
		if (!seed) {
			const bytes = new Uint8Array(12);
			crypto.getRandomValues(bytes);
			seed = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
			localStorage.setItem(key, seed);
		}
		return seed;
	} catch {
		return Math.random().toString(16).slice(2) + "0000";
	}
}

// Draws and applies the targets of a view (or of an assessment: anything with a
// `targets` list) locally. -> how many values were set.
export function drawAndApply(source, seed) {
	if (!source?.targets?.length) return 0;
	return applyTargets(drawTargets(source.targets, seed));
}
