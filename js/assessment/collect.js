import { xmlStore } from "../xml-editor/xml-store.js";
import { isVariableControlled } from "../xml-editor/variable-references.js";
import { getLiveProperty } from "../waxml-integration/live-property.js";
import { parseGainAttributeToDb, isDbNativeGain, linearRatioToDb } from "../waxml-integration/gain-units.js";
import { engineDefault } from "../xml-editor/default-attributes.js";
import { readKey } from "./evaluate.js";

// Measures what an assessment (see evaluate.js) asks about, in the running
// document: for every read — the attribute of the element with that XML id —
// a number, or undefined when there is none. An attribute written out in the
// document is read from there; one that is missing (the element is on its
// defaults) or driven by a $variable is read from the live audio graph, which
// is where the real value is.

function findByElementId(elementId) {
	const walk = (n) => {
		if (n.attributes.id === elementId) return n;
		for (const c of n.children) {
			const f = walk(c);
			if (f) return f;
		}
		return null;
	};
	return xmlStore.root ? walk(xmlStore.root) : null;
}

function readOne(read) {
	const node = findByElementId(read.ref);
	if (!node) return undefined;
	const asDb = read.as === "db";
	const raw = node.attributes[read.attr];
	if (raw !== undefined && raw !== "" && !isVariableControlled(raw)) {
		if (asDb && read.attr === "gain") return parseGainAttributeToDb(node.tagName, raw);
		const n = parseFloat(raw);
		if (Number.isFinite(n)) return n;
	}
	// Not written out: the engine's default (a $variable-driven one has no
	// written number either, so it is read live below).
	if (raw === undefined || raw === "") {
		const fallback = engineDefault(node.tagName, read.attr);
		if (fallback !== undefined) {
			if (asDb && read.attr === "gain" && !isDbNativeGain(node.tagName)) return linearRatioToDb(fallback);
			return fallback;
		}
	}
	const live = getLiveProperty(read.ref, read.attr);
	if (!Number.isFinite(live)) return undefined;
	if (asDb && read.attr === "gain" && !isDbNativeGain(node.tagName)) return linearRatioToDb(live);
	return live;
}

// -> { [readKey]: number | undefined }
export function collectValues(reads) {
	const values = {};
	reads.forEach((read) => {
		values[readKey(read)] = readOne(read);
	});
	return values;
}
