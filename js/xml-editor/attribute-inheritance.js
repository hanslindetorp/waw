import * as ops from "./xml-tree-ops.js";

// A handful of <Layer>/<Section> attributes inherit down the document —
// own value first, then the nearest ancestor of a specific tag with the
// same attribute set, then a hardcoded default — mirroring how waxml.js's
// iMus engine itself resolves them when actually playing (per Hans,
// 2026-09-02). Each entry lists the ancestor tags to check, nearest first.
const LAYER_INHERITANCE = {
	fadeTime: ["Section", "Composition"],
	loopEnd: ["Section", "Composition"],
	changeOnNext: ["Section", "Composition"]
};

const SECTION_INHERITANCE = {
	timeSign: ["Composition"],
	tempo: ["Composition"],
	changeOnNext: ["Composition"]
};

// waxml.js's own `defaultParams` (see the Music engine), converted into the
// XML attribute's own string format/unit — not the internal JS shape (e.g.
// timeSign's {nominator,denominator} becomes "4/4" per the schema's `meter`
// pattern; fadeTime's 0.01s becomes "10" since the schema's fadeTime is in
// ms). loopEnd (formerly loopLength — now a musical position, per Hans
// 2026-09-02, matching the schema's own musicalLoopEnd type) defaults to
// "off", matching waxml.js's own defaultParams.loopEnd.
const DEFAULTS = {
	fadeTime: "10",
	loopEnd: "off",
	tempo: "120",
	timeSign: "4/4",
	changeOnNext: "1/1"
};

function getChain(tagName) {
	if (tagName === "Layer") return LAYER_INHERITANCE;
	if (tagName === "Section") return SECTION_INHERITANCE;
	return null;
}

// True for any (tagName, attrName) this module has an inheritance rule for
// — lets callers decide whether it's even worth resolving before an
// attribute has been confirmed unset.
export function isInheritable(tagName, attrName) {
	return !!getChain(tagName)?.[attrName];
}

// Resolves attrName for `node` (assumed to already be unset on the node
// itself — callers check node.attributes[attrName] first) by walking up
// through the ancestor tags this attribute inherits from, then the
// built-in default. Returns { value, source } where source is the
// ancestor's tagName or "default" — or { value: null, source: null } if
// nothing was found anywhere in the chain.
export function resolveInheritedAttribute(root, node, attrName) {
	const chain = getChain(node.tagName)?.[attrName];
	if (chain) {
		let current = node;
		for (const ancestorTag of chain) {
			current = findAncestorByTag(root, current, ancestorTag);
			if (!current) break;
			const value = current.attributes[attrName];
			if (value !== undefined && value !== "") {
				return { value, source: current.tagName };
			}
		}
	}

	if (DEFAULTS[attrName] !== undefined) {
		return { value: DEFAULTS[attrName], source: "default" };
	}

	return { value: null, source: null };
}

// Nearest ancestor of `node` (exclusive) with the given tagName, walking up
// via the internal parent-id chain (same convention as every other tree
// walk in this app — not the XML `id` attribute).
function findAncestorByTag(root, node, tagName) {
	let current = node;
	while (current && current.parent) {
		current = ops.findNodeById(root, current.parent);
		if (!current) return null;
		if (current.tagName === tagName) return current;
	}
	return null;
}
