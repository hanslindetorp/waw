// Builds the tree wa-io-picker.js shows when the user clicks an "output",
// "input", or <Send>'s "bus" attribute value, per Hans (2026-08-31): picking
// a value *for* "output" means routing into something with an available
// "input" (and vice versa) — so the picker always shows the *complementary*
// attribute's candidates, not the one being edited. "bus" is <Send>'s own
// routing target (schema: "Bus output for Send elements... matches the ID
// or ClassName of target element") — the exact same shape and direction as
// "output", so it shares the same complement.
const COMPLEMENT_ATTR = { output: "input", input: "output", bus: "input" };

// Mirrors the actual document tree (not just what the schema allows), so it
// only ever offers targets that really exist right now. A node is kept if
// it's itself a valid target (supports the complementary attribute AND has
// an id — only the document root can lack one, see xml-tree-ops.js's
// backfillElementIds) OR any of its descendants are — a container with
// nothing useful anywhere inside it is pruned rather than shown as dead
// weight. A kept container that ISN'T itself a valid target still renders
// (as an unselectable row) purely to reach its qualifying descendants.
// "inputs"/"outputs" — for a picker-trigger button's title/tooltip, so
// callers (wa-node-inspector.js, wa-mixer-view.js) don't each hardcode their
// own copy of the output/input/bus -> complement direction mapping.
export function complementNoun(forAttrName) {
	const want = COMPLEMENT_ATTR[forAttrName];
	return want === "input" ? "inputs" : want === "output" ? "outputs" : null;
}

export function buildRoutingTree(schema, root, forAttrName, excludeInternalId) {
	const wantAttr = COMPLEMENT_ATTR[forAttrName];
	if (!root || !wantAttr || !schema) return null;
	// An element living inside a <Mixer> can only route to that Mixer's own
	// channels — its direct <Chain> children, not anything inside them, and
	// not the rest of the document — per Hans (2026-10-08).
	if (forAttrName === "output" || forAttrName === "bus") {
		const path = findPath(root, excludeInternalId);
		const mixer = path && [...path].reverse().find((n) => n.tagName === "Mixer");
		if (mixer) return buildMixerChannelTree(mixer, new Set(path.map((n) => n.id)));
	}
	return buildNode(root, schema, wantAttr, excludeInternalId);
}

// Ancestor chain root -> node (inclusive), or null if not found.
function findPath(root, id) {
	if (!id) return null;
	if (root.id === id) return [root];
	for (const child of root.children) {
		const sub = findPath(child, id);
		if (sub) return [root, ...sub];
	}
	return null;
}

// Never offers the edited element itself or any container it sits in
// (e.g. its own parent <Chain>) — routing into yourself is a loop.
function buildMixerChannelTree(mixer, excludedIds) {
	const channels = mixer.children
		.filter((c) => c.tagName === "Chain" && c.attributes.id)
		.map((c) => ({ tagName: c.tagName, id: c.attributes.id, selectable: !excludedIds.has(c.id), children: [] }));
	if (channels.length === 0) return null;
	return { tagName: mixer.tagName, id: mixer.attributes.id || null, selectable: false, children: channels };
}

function buildNode(node, schema, wantAttr, excludeInternalId) {
	const schemaEl = schema.elements?.[node.tagName];
	const supportsAttr = !!schemaEl?.allowedAttributes?.some((a) => a.name === wantAttr);
	const id = node.attributes.id || null;
	const isQualifyingTarget = supportsAttr && !!id;

	const children = node.children.map((child) => buildNode(child, schema, wantAttr, excludeInternalId)).filter(Boolean);

	if (!isQualifyingTarget && children.length === 0) return null;

	return {
		tagName: node.tagName,
		id,
		// Never offer an element as a target for its own attribute — routing
		// something to itself is never meaningful.
		selectable: isQualifyingTarget && node.id !== excludeInternalId,
		children
	};
}
