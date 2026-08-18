// Pure, immutable operations on an XmlNode tree.
// Ported from the XML-editor-DEMO Lovable prototype (src/lib/xml-utils.ts) —
// same shape, no framework dependency.
//
// XmlNode = { id, tagName, attributes: {name: value}, children: XmlNode[], textContent, parent: id|null }

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

export function cloneNode(node, newParentId) {
	const newId = generateNodeId();
	return {
		...node,
		id: newId,
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
