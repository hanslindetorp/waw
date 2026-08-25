// Pure, immutable operations on an XmlNode tree.
// Ported from the XML-editor-DEMO Lovable prototype (src/lib/xml-utils.ts) —
// same shape, no framework dependency.
//
// XmlNode = { id, tagName, attributes: {name: value}, children: XmlNode[], textContent, parent: id|null }

import { findSrcAttribute } from "./src-attribute.js";

let nodeIdCounter = 0;

export function generateNodeId() {
	return `node_${++nodeIdCounter}`;
}

export function resetNodeIdCounter() {
	nodeIdCounter = 0;
}

export function parseXmlString(xmlString) {
	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(xmlString, "application/xml");
		if (doc.querySelector("parsererror")) return null;
		if (!doc.documentElement) return null;
		resetNodeIdCounter();
		return domToXmlNode(doc.documentElement, null);
	} catch {
		return null;
	}
}

function domToXmlNode(element, parentId) {
	const id = generateNodeId();
	const attributes = {};
	for (const attr of Array.from(element.attributes)) {
		attributes[attr.name] = attr.value;
	}

	const children = [];
	let textContent = "";

	for (const child of Array.from(element.childNodes)) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			children.push(domToXmlNode(child, id));
		} else if (child.nodeType === Node.TEXT_NODE) {
			const text = (child.textContent || "").trim();
			if (text) textContent += text;
		}
	}

	return { id, tagName: element.tagName, attributes, children, textContent, parent: parentId };
}

export function serializeXmlNode(node, indent = 0) {
	const spaces = "  ".repeat(indent);
	const attrs = Object.entries(node.attributes)
		.map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
		.join("");

	if (node.children.length === 0 && !node.textContent) {
		return `${spaces}<${node.tagName}${attrs} />`;
	}

	let result = `${spaces}<${node.tagName}${attrs}>`;

	if (node.children.length > 0) {
		result += "\n";
		for (const child of node.children) {
			result += serializeXmlNode(child, indent + 1) + "\n";
		}
		if (node.textContent) {
			result += `${spaces}  ${escapeXml(node.textContent)}\n`;
		}
		result += `${spaces}</${node.tagName}>`;
	} else {
		result += escapeXml(node.textContent);
		result += `</${node.tagName}>`;
	}

	return result;
}

export function generateFullXml(root) {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXmlNode(root, 0)}`;
}

// Same output as generateFullXml, plus a Map(nodeId -> {start, end}) of the
// 1-indexed line range each node occupies — used to cross-highlight the tree
// and the code view. Mirrors serializeXmlNode's line-breaking exactly, so it
// only stays accurate for text produced by that function (hand-edited code
// with different formatting won't line up until it's next round-tripped
// through the tree, e.g. by any attribute/tree edit).
export function generateFullXmlWithLineMap(root) {
	const lineMap = new Map();
	const state = { line: 2 }; // line 1 is the <?xml ... ?> declaration
	const body = serializeWithLineMap(root, 0, state, lineMap);
	return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, lineMap };
}

function serializeWithLineMap(node, indent, state, lineMap) {
	const spaces = "  ".repeat(indent);
	const attrs = Object.entries(node.attributes)
		.map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
		.join("");
	const startLine = state.line;

	if (node.children.length === 0 && !node.textContent) {
		lineMap.set(node.id, { start: startLine, end: startLine });
		state.line += 1;
		return `${spaces}<${node.tagName}${attrs} />`;
	}

	let result = `${spaces}<${node.tagName}${attrs}>`;

	if (node.children.length > 0) {
		state.line += 1;
		result += "\n";
		for (const child of node.children) {
			result += serializeWithLineMap(child, indent + 1, state, lineMap) + "\n";
		}
		if (node.textContent) {
			result += `${spaces}  ${escapeXml(node.textContent)}\n`;
			state.line += 1;
		}
		result += `${spaces}</${node.tagName}>`;
		lineMap.set(node.id, { start: startLine, end: state.line });
		state.line += 1;
	} else {
		result += escapeXml(node.textContent);
		result += `</${node.tagName}>`;
		lineMap.set(node.id, { start: startLine, end: startLine });
		state.line += 1;
	}

	return result;
}

function escapeXml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function createXmlNode(tagName, parentId) {
	return {
		id: generateNodeId(),
		tagName,
		attributes: {},
		children: [],
		textContent: "",
		parent: parentId
	};
}

export function findNodeById(root, id) {
	if (root.id === id) return root;
	for (const child of root.children) {
		const found = findNodeById(child, id);
		if (found) return found;
	}
	return null;
}

// The XML `id` *attribute* (not to be confused with the internal tree id
// above) is stripped from the clone and every descendant, rather than
// copied verbatim — otherwise a duplicated node would carry the same id as
// its original, breaking the uniqueness backfillElementIds (xmlStore's
// _syncCode) otherwise guarantees. Stripping it here just leaves it
// missing, which that same backfill pass picks up on the very next sync and
// assigns a fresh one to, same as any other id-less element.
export function cloneNode(node, newParentId) {
	const newId = generateNodeId();
	const attributes = { ...node.attributes };
	delete attributes.id;
	return {
		...node,
		id: newId,
		attributes,
		parent: newParentId,
		children: node.children.map((c) => cloneNode(c, newId))
	};
}

export function removeNode(root, nodeId) {
	if (root.id === nodeId) return null;
	return {
		...root,
		children: root.children
			.filter((c) => c.id !== nodeId)
			.map((c) => removeNode(c, nodeId))
			.filter(Boolean)
	};
}

export function insertChild(root, parentId, child, index) {
	if (root.id === parentId) {
		const newChildren = [...root.children];
		const insertIndex = index !== undefined ? index : newChildren.length;
		newChildren.splice(insertIndex, 0, { ...child, parent: parentId });
		return { ...root, children: newChildren };
	}
	return {
		...root,
		children: root.children.map((c) => insertChild(c, parentId, child, index))
	};
}

export function updateNodeAttributes(root, nodeId, attributes) {
	if (root.id === nodeId) return { ...root, attributes };
	return { ...root, children: root.children.map((c) => updateNodeAttributes(c, nodeId, attributes)) };
}

// Rewrites every node's src/source attribute (schema-aware, via the same
// findSrcAttribute used everywhere else this matters) whose value exactly
// equals oldPath to newPath instead — used to keep XML src references
// pointing at the right file after a File Manager move/rename changes that
// file's export path (see VFS's "path-change" event, wired up in
// document-sync.js).
export function renameSrcReferences(root, schema, oldPath, newPath) {
	const match = findSrcAttribute(schema, root);
	const attributes = match && match.value === oldPath ? { ...root.attributes, [match.attrName]: newPath } : root.attributes;
	return {
		...root,
		attributes,
		children: root.children.map((c) => renameSrcReferences(c, schema, oldPath, newPath))
	};
}

// Auto-assigns "<TagName>-<N>" to any element missing an id (undefined or
// empty) — so every element ends up addressable as a trig()/selector target
// (e.g. "Stinger-1") without the user having to name it by hand, per Hans;
// still freely editable afterward like any other attribute. The document's
// own root element is exempt (per Hans) — it never gets an auto id, though
// one it already has (hand-set, or from before this exemption existed)
// isn't stripped.
//
// counters (Map<tagName, highestUsedN>) is deliberately mutable/shared
// across calls, unlike the rest of this file's pure tree functions — "never
// reuse a number even after that element is deleted" needs history beyond
// what the current tree alone can tell you, the same reason generateNodeId
// above keeps its own persistent counter rather than deriving one fresh
// from the tree each time.
//
// Two passes: first ratchet counters up from any ids *already* in the tree
// that happen to match the "TagName-N" pattern for their own tag (hand-set
// or pasted from elsewhere) so a freshly-assigned id can't collide with one
// of those; then assign fresh ids to whatever's still missing one.
export function backfillElementIds(root, counters) {
	const ratchet = (node) => {
		const match = /^(.+)-(\d+)$/.exec(node.attributes.id || "");
		if (match && match[1] === node.tagName) {
			const n = parseInt(match[2], 10);
			if (Number.isFinite(n) && n > (counters.get(node.tagName) || 0)) counters.set(node.tagName, n);
		}
		node.children.forEach(ratchet);
	};
	ratchet(root);

	const assign = (node, isRoot) => {
		const hasId = node.attributes.id !== undefined && node.attributes.id !== "";
		let attributes = node.attributes;
		if (!hasId && !isRoot) {
			const n = (counters.get(node.tagName) || 0) + 1;
			counters.set(node.tagName, n);
			attributes = { ...node.attributes, id: `${node.tagName}-${n}` };
		}
		return { ...node, attributes, children: node.children.map((c) => assign(c, false)) };
	};
	return assign(root, true);
}

export function updateNodeTagName(root, nodeId, tagName) {
	if (root.id === nodeId) return { ...root, tagName };
	return { ...root, children: root.children.map((c) => updateNodeTagName(c, nodeId, tagName)) };
}

export function updateNodeTextContent(root, nodeId, textContent) {
	if (root.id === nodeId) return { ...root, textContent };
	return { ...root, children: root.children.map((c) => updateNodeTextContent(c, nodeId, textContent)) };
}

function isDescendantOf(node, targetId) {
	if (node.id === targetId) return true;
	return node.children.some((c) => isDescendantOf(c, targetId));
}

export function reparentNode(root, nodeId, newParentId, index) {
	const node = findNodeById(root, nodeId);
	if (!node) return root;
	if (isDescendantOf(node, newParentId)) return root;
	if (root.id === nodeId) return root;

	const newRoot = removeNode(root, nodeId);
	if (!newRoot) return root;
	const reparented = { ...node, parent: newParentId };
	return insertChild(newRoot, newParentId, reparented, index);
}
