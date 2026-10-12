import { xmlStore } from "./xml-store.js";
import { findNodeById, generateVarName } from "./xml-tree-ops.js";
import { mapoutRangeFor } from "./parameter-ranges.js";
import { isNumericAttributeSchema } from "./schema-parser.js";

const BARE_NUMBER_RE = /^-?\d+(\.\d+)?$/;

// TEMPORARY (Hans, 2026-10-12): nothing in a <Composition> — the element
// itself and everything inside it (Section, Layer, Segment, Option, Stinger,
// ...) — can be mapped for now. waxml.js's music engine does not drive those
// attributes from a <Var> yet (see the musicGain note in schemas/waxml.xsd),
// so offering them as mapping targets would promise something that doesn't
// work. Remove the Composition check below once waxml.js is updated.
function isInsideComposition(node) {
	const root = xmlStore.root;
	for (let n = node; n; n = n.parent ? findNodeById(root, n.parent) : null) {
		if (n.tagName === "Composition") return true;
	}
	return false;
}

// Whether `attrName` of `node` can be the target of a mapping (a <Var> or an
// INPUT entry): a numeric attribute (per the schema) outside <Composition>.
// The one gate every mapping site — the Inspector's attribute rows, the
// parameter chips, createVarForAttribute — goes through.
export function isMappableTarget(node, attrSchema) {
	return !!node && isNumericAttributeSchema(attrSchema) && !isInsideComposition(node);
}

// Maps an INPUT entry straight onto one attribute (per Hans, 2026-10-09)
// instead of requiring a root-level <Var> first: creates a new <Var> with a
// unique name, mapin "0,1" and a mapout suited to the parameter, places it
// first among its target element's siblings (after any <Var>s already there)
// and points the attribute at it ("$name"). The Var reads its input from a
// hidden root-level variable named "input_<name>" (its `value` refers to it:
// <Var name="var1" value="$input_var1" .../>) which the INPUT entry sets with
// waxml.set() — so it works wherever in the document the Var sits, without a
// visible root <Var>. Returns { varName, inputVar }, `inputVar` being the bare
// variable name ("input_var1") the entry sets.
//
// The <Var> is inserted in the parent of the target element — in the target
// itself when that is the document root. The graph frame of a new Var comes
// from its own mapin/mapout (see wa-var-view.js).
//
// When the attribute currently holds a plain number, the Var's `default` is
// where on 0..1 that number falls inside mapout, so mapping doesn't make the
// parameter jump to the bottom of its range before anything moves.
export function createVarForAttribute(nodeId, attrName) {
	const root = xmlStore.root;
	const node = root && findNodeById(root, nodeId);
	if (!node) return null;
	const parent = node.parent ? findNodeById(root, node.parent) : node;
	if (!parent) return null;

	const attrSchema = xmlStore.schema?.elements[node.tagName]?.allowedAttributes.find((a) => a.name === attrName);
	if (!isMappableTarget(node, attrSchema)) return null;
	const [outMin, outMax] = mapoutRangeFor(node.tagName, attrName, attrSchema);
	const lastVarIndex = parent.children.reduce((last, c, i) => (c.tagName === "Var" ? i : last), -1);

	const varName = generateVarName(root);
	const inputVar = `input_${varName}`;
	const attributes = { name: varName, value: `$${inputVar}`, mapin: "0,1", mapout: `${outMin},${outMax}` };
	const current = node.attributes[attrName];
	if (typeof current === "string" && BARE_NUMBER_RE.test(current.trim())) {
		const t = (parseFloat(current) - outMin) / (outMax - outMin);
		if (Number.isFinite(t)) attributes.default = String(Math.round(Math.max(0, Math.min(1, t)) * 1000) / 1000);
	}

	xmlStore.insertNewChild(parent.id, "Var", attributes, lastVarIndex + 1, { select: false });
	const nodeNow = findNodeById(xmlStore.root, nodeId);
	if (nodeNow) xmlStore.updateAttributes(nodeId, { ...nodeNow.attributes, [attrName]: `$${varName}` });
	return { varName, inputVar };
}
