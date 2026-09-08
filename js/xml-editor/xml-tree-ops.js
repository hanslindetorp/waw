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

// A, B, ..., Z, A1, B1, ..., Z1, A2, ... — the first value in that sequence
// not already present in `used` (optionally prefixed, e.g. "Section-" — the
// membership check is against the *prefixed* candidate, so `used` must
// contain full, already-prefixed values too). Shared by generateSectionClass
// (bare letter, e.g. "B") and backfillElementIds' <Section> id scheme
// ("Section-B" — see there), per Hans (2026-09-08): the id scheme is
// deliberately "en numrering matchande de automatiskt tilldelade
// classNames" (a numbering matching the auto-assigned classNames).
function nextLetterSequenceValue(used, prefix = "") {
	for (let n = 0; ; n++) {
		const letter = String.fromCharCode(65 + (n % 26));
		const suffix = Math.floor(n / 26);
		const candidate = prefix + (suffix > 0 ? `${letter}${suffix}` : letter);
		if (!used.has(candidate)) return candidate;
	}
}

// Per Hans (2026-09-02), every new <Section> gets one of these as its
// `class` so it's addressable as a PLAY/STOP trigger selector (see
// player-store.js) without the user having to type one by hand. Picks the
// first value in the sequence above not already used as a `class` token
// anywhere in the document (space-separated, same as any HTML/XML class
// attribute), so it stays collision-free against both hand-set classes and
// previously auto-assigned ones, loaded document or not.
function usedClassTokens(node, set = new Set()) {
	(node.attributes.class || "").split(/\s+/).filter(Boolean).forEach((t) => set.add(t));
	node.children.forEach((c) => usedClassTokens(c, set));
	return set;
}

export function generateSectionClass(root) {
	return nextLetterSequenceValue(root ? usedClassTokens(root) : new Set());
}

// Every id currently in the tree, any element/tag — used by
// backfillElementIds' <Section>/transition id schemes so a freshly
// auto-assigned id never collides with *anything* already present (hand-set
// or previously auto-assigned, on any tag), guaranteeing real document-wide
// uniqueness rather than just uniqueness-within-its-own-scheme. Unlike
// backfillElementIds' other (per-tag numeric) counters — which track the
// highest number ever used *persistently* across the whole session, so a
// number is never reused even after its element is deleted — this only
// ever looks at what's *currently* in the tree: the same "first free value,
// reuse allowed after deletion" semantics as generateSectionClass itself,
// which the Section-id scheme below deliberately mirrors.
function usedIds(node, set = new Set()) {
	if (node.attributes.id) set.add(node.attributes.id);
	node.children.forEach((c) => usedIds(c, set));
	return set;
}

// A "transition" Section is marked purely by having a `from`/`to` attribute
// (mirrors section-model.js's own isTransitionSection — duplicated rather
// than imported, keeping this file dependency-free of any other app
// module, per its own header comment).
function isTransitionSectionNode(node) {
	return node.attributes.from !== undefined || node.attributes.to !== undefined;
}

// The short "target token" a transition's auto-id embeds — the part after
// "Section-" in whatever its `to` attribute's #id points at (or that bare
// id itself, if it doesn't happen to follow the "Section-<letter>" scheme)
// — e.g. to="#Section-B" -> "B", to="#MyCustomId" -> "MyCustomId". Falls
// back to "X" for a transition with no #id-shaped `to` at all (a class
// selector, or missing/malformed — only reachable via hand-edited XML,
// since the app's own "+" flow always writes a #id), so backfill can still
// produce *some* valid, readable id rather than failing. Purely
// string-based — deliberately doesn't need to resolve which actual Section
// `to` points at.
function transitionTargetToken(node) {
	const to = node.attributes.to;
	if (typeof to !== "string" || !to.startsWith("#")) return "X";
	const targetId = to.slice(1);
	return targetId.startsWith("Section-") ? targetId.slice("Section-".length) : targetId;
}

// "Transition-<targetToken><N>" — e.g. "Transition-B1" for the first
// backfilled transition targeting "#Section-B", "Transition-B2" for the
// next one targeting that same Section, per Hans (2026-09-08): "Den
// avslutande siffran är en autoincrement för transitions kopplade till
// efterföljande <Section>." N starts at 1 and is the first value not
// already in `used` (same reuse-after-delete semantics as the rest of this
// scheme) — checked against the *whole document's* ids (see usedIds), so
// "id ska vara unikt" holds even against something on a completely
// unrelated tag.
function nextTransitionId(used, targetToken) {
	for (let n = 1; ; n++) {
		const candidate = `Transition-${targetToken}${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

// A nameless <Var> can't be turned into a live knob (wa-var-knobs.js) or
// referenced as "$name" anywhere else — every new one gets a "varN" name
// (never colliding with an existing <Var name="...">, never reusing a
// number even after deletion, same reasoning as backfillElementIds' own
// TagName-N scheme), per Hans (2026-09-05).
function usedVarNames(node, set = new Set()) {
	if (node.tagName === "Var" && node.attributes.name) set.add(node.attributes.name);
	node.children.forEach((c) => usedVarNames(c, set));
	return set;
}

export function generateVarName(root) {
	const used = root ? usedVarNames(root) : new Set();
	for (let n = 1; ; n++) {
		const candidate = `var${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

// Root-level trigger-shortcut <Command>s created via the player bar's own
// "+" button (see wa-player-bar.js) get a "Cmd-N" id — same reuse-after-
// delete / whole-document-uniqueness semantics as generateVarName/
// nextTransitionId above.
export function generateCommandId(root) {
	const used = root ? usedIds(root) : new Set();
	for (let n = 1; ; n++) {
		const candidate = `Cmd-${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

// A Section's (or any element's) class can hold more than one
// space-separated token — every caller here only ever wants the first.
export function firstClassToken(node) {
	return (node.attributes.class || "").trim().split(/\s+/)[0];
}

// The selector to trig() a given element by — per Hans (2026-09-09): its
// own first class token (prefixed "."), or its id (prefixed "#") if it has
// no class at all. Used everywhere something needs to tell waxml.js "play
// this element" (the player bar's PLAY field, a trigger-shortcut Command,
// a Section's or Stinger's own play button, ...) so every one of those
// paths derives the same selector for the same element.
export function firstSelector(node) {
	const firstClass = firstClassToken(node);
	if (firstClass) return `.${firstClass}`;
	return `#${node.attributes.id}`;
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
//
// idMap (optional): when passed, every original->new *internal* tree id pair
// in the cloned subtree (this node and all descendants) is recorded into it —
// used by xmlStore.copyNode/pasteIntoSelection so wa-xml-tree.js can carry a
// collapsed node's expand/collapse state over to its fresh clone, which
// otherwise has no id in common with the original.
export function cloneNode(node, newParentId, idMap) {
	const newId = generateNodeId();
	if (idMap) idMap.set(node.id, newId);
	const attributes = { ...node.attributes };
	delete attributes.id;
	return {
		...node,
		id: newId,
		attributes,
		parent: newParentId,
		children: node.children.map((c) => cloneNode(c, newId, idMap))
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

// Auto-assigns an id to any element missing one (undefined or empty) — so
// every element ends up addressable as a trig()/selector target (e.g.
// "Stinger-1") without the user having to name it by hand, per Hans; still
// freely editable afterward like any other attribute. The document's own
// root element is exempt (per Hans) — it never gets an auto id, though one
// it already has (hand-set, or from before this exemption existed) isn't
// stripped.
//
// A regular <Section> is special-cased to "Section-<letter>" (A, B, ..., Z,
// A1, B1, ...) instead of the generic "TagName-N" scheme every other tag
// gets — deliberately matching generateSectionClass's own sequence/
// semantics (first free value *currently* in the tree, reuse allowed after
// deletion — unlike every other tag's counters below), per Hans
// (2026-09-08, changing from the previous "Section-1"-style numbering).
// A transition Section (see isTransitionSectionNode) gets
// "Transition-<targetToken><N>" instead — see nextTransitionId — so it's
// visibly distinct from a regular Section's own id at a glance.
//
// counters (Map<tagName, highestUsedN>) is deliberately mutable/shared
// across calls, unlike the rest of this file's pure tree functions — "never
// reuse a number even after that element is deleted" needs history beyond
// what the current tree alone can tell you, the same reason generateNodeId
// above keeps its own persistent counter rather than deriving one fresh
// from the tree each time. (A legacy hand-typed or previously-generated
// "Section-<N>" id still ratchets counters.get("Section") up here, same as
// any other tag — that's simply dead/unused going forward, since Section no
// longer draws from it.)
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

	const usedIdsSet = usedIds(root);

	const assign = (node, isRoot) => {
		const hasId = node.attributes.id !== undefined && node.attributes.id !== "";
		let attributes = node.attributes;
		if (!hasId && !isRoot) {
			if (node.tagName === "Section" && isTransitionSectionNode(node)) {
				const newId = nextTransitionId(usedIdsSet, transitionTargetToken(node));
				usedIdsSet.add(newId);
				attributes = { ...node.attributes, id: newId };
			} else if (node.tagName === "Section") {
				const newId = nextLetterSequenceValue(usedIdsSet, "Section-");
				usedIdsSet.add(newId);
				attributes = { ...node.attributes, id: newId };
			} else {
				const n = (counters.get(node.tagName) || 0) + 1;
				counters.set(node.tagName, n);
				attributes = { ...node.attributes, id: `${node.tagName}-${n}` };
			}
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

// Exported (also used by xml-store.js's paste — see pasteIntoSelection)
// for the same "can't move/paste something into itself or its own
// descendant" guard reparentNode already needs internally.
export function isDescendantOf(node, targetId) {
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
