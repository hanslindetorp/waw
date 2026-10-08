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
		// slice(0, -1): the edited node itself never counts as "its" Mixer —
		// a <Mixer>'s own output (the master strip's) routes outside it.
		const mixer = path && path.slice(0, -1).reverse().find((n) => n.tagName === "Mixer");
		if (mixer) return buildMixerChannelTree(mixer, new Set(path.map((n) => n.id)));
	}
	const ancestorIds = new Set((findPath(root, excludeInternalId) || []).slice(0, -1).map((n) => n.id));
	return buildNode(root, schema, wantAttr, excludeInternalId, ancestorIds);
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

// Anything that would route audio into a loop is left out entirely, not just
// greyed: the edited element itself and any container it sits in (e.g. its
// own parent <Chain>) — per Hans (2026-10-09).
function buildMixerChannelTree(mixer, excludedIds) {
	const channels = mixer.children
		.filter((c) => c.tagName === "Chain" && c.attributes.id && !excludedIds.has(c.id))
		.map((c) => ({ tagName: c.tagName, id: c.attributes.id, selectable: true, children: [] }));
	if (channels.length === 0) return null;
	return { tagName: mixer.tagName, id: mixer.attributes.id || null, selectable: false, children: channels };
}

// The edited element and everything inside it are dropped from the tree
// (routing into yourself, or a <Mixer>'s output into one of its own channels,
// would be a loop). Its ancestors are never selectable either, and only show
// up at all when they hold some other valid target (the usual pruning rule).
function buildNode(node, schema, wantAttr, excludeInternalId, ancestorIds) {
	if (node.id === excludeInternalId) return null;
	const schemaEl = schema.elements?.[node.tagName];
	const supportsAttr = !!schemaEl?.allowedAttributes?.some((a) => a.name === wantAttr);
	const id = node.attributes.id || null;
	const isQualifyingTarget = supportsAttr && !!id && !ancestorIds.has(node.id);

	// A <Chain> is offered as one target, never unfolded into the elements
	// inside it — they'd bury the picker in irrelevant choices (per Hans,
	// 2026-10-09). Only the chain the edited element itself sits in is
	// opened, so its neighbours stay reachable.
	const opensUp = node.tagName !== "Chain" || ancestorIds.has(node.id);
	const children = opensUp
		? node.children.map((child) => buildNode(child, schema, wantAttr, excludeInternalId, ancestorIds)).filter(Boolean)
		: [];

	if (!isQualifyingTarget && children.length === 0) return null;

	return {
		tagName: node.tagName,
		id,
		selectable: isQualifyingTarget,
		children
	};
}
