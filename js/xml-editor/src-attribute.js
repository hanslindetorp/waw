// Shared logic for finding/resolving the "which file does this node point at"
// attribute (src/source) — used by the tree's file-drop handling and by
// Preview to know what to play. Works with or without a loaded XSD schema.

import { vfs } from "../vfs/VFS.js";

// The schema-declared src/source attribute name for a tag, e.g. "src" for
// <AudioBufferSourceNode>. Returns null if the schema doesn't know the tag or
// it has no such attribute.
export function getSchemaSrcAttributeName(schema, tagName) {
	if (!schema) return null;
	const el = schema.elements[tagName];
	if (!el) return null;
	for (const attr of el.allowedAttributes) {
		const lower = attr.name.toLowerCase();
		if (lower === "src" || lower === "source") return attr.name;
	}
	return null;
}

// Finds the src/source attribute actually present on a node: prefers the
// schema's declared name, falls back to any literally-named src/source
// attribute so this still works in manual (schemaless) mode.
export function findSrcAttribute(schema, node) {
	const schemaAttrName = getSchemaSrcAttributeName(schema, node.tagName);
	if (schemaAttrName && node.attributes[schemaAttrName] !== undefined) {
		return { attrName: schemaAttrName, value: node.attributes[schemaAttrName] };
	}
	for (const [key, value] of Object.entries(node.attributes)) {
		if (key.toLowerCase() === "src" || key.toLowerCase() === "source") {
			return { attrName: key, value };
		}
	}
	return null;
}

// Resolves a src attribute's value to something actually fetchable in this
// session: real URLs pass through, VFS export paths ("drums/kick.wav") are
// resolved to their blob: sessionUrl (spec avsnitt 1.5's "dual URL layers").
export function resolvePlayableUrl(value) {
	if (!value) return null;
	if (/^(https?:|blob:|data:)/i.test(value)) return value;
	const vfsNode = vfs.findByExportPath(value);
	return vfsNode ? vfsNode.sessionUrl : null;
}
