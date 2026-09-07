import * as ops from "./xml-tree-ops.js";
import { isVariableControlled } from "./variable-references.js";

const EMPTY_XML = '<?xml version="1.0" encoding="UTF-8"?>';

// Shared state for the graphical XML editor (panel 2) and the XML source
// view (panel 4) — same singleton-EventTarget pattern as vfs.js/selection.js,
// so any panel (including the future Preview views) can read/react to it.
//
// Ported from the XML-editor-DEMO Lovable prototype's Index.tsx, which held
// this as React state with tree<->code sync via two guard refs. Here the
// guard is a single synchronous flag, since dispatchEvent() runs listeners
// synchronously.
class XmlStore extends EventTarget {
	constructor() {
		super();
		this.root = null;
		this.schema = null;
		this.schemaFileName = "";
		this.selectedNodeId = null;
		this.selectedNodeIds = new Set(); // multi-select (Cmd/Ctrl-click, Shift-click — see wa-xml-tree.js); always contains selectedNodeId when it's non-null
		this._clipboard = null; // { mode: "copy", nodes: XmlNode[] } | { mode: "cut", nodes: id[] } — see copySelection/cutSelection/pasteIntoSelection
		this.codeValue = EMPTY_XML;
		this.lineMap = new Map();
		this._idCounters = new Map(); // tagName -> highest "TagName-N" used so far this project (see ops.backfillElementIds)
	}

	// Call when genuinely starting a different project (a new default
	// project, or opening a different file) — not on every edit to the one
	// already open, or auto-assigned ids would restart at 1 and could
	// collide with ones already used earlier in the same document/session.
	resetIdCounters() {
		this._idCounters = new Map();
	}

	// --- schema ---

	// structural=false on all three below: none of these ever change the
	// XML document's own shape (selection/schema aren't document content at
	// all) — without this, player-store.js would incorrectly treat every
	// tree/Inspector click as if it could invalidate the live audio graph
	// and stop playback just from browsing around.
	setSchema(schema, fileName) {
		this.schema = schema;
		this.schemaFileName = fileName || "";
		this._emit(false);
	}

	clearSchema() {
		this.schema = null;
		this.schemaFileName = "";
		this._emit(false);
	}

	// --- selection ---

	// open: true marks this selection as an explicit "open this element's
	// own dedicated view" request — double-clicking a Section inside
	// wa-composition-view.js (2026-09-05), and every plain click in
	// wa-xml-tree.js (2026-09-08, since a click in the tree is always an
	// explicit "take me to this element", unlike a plain click *inside* a
	// preview view itself, e.g. wa-composition-view.js's own single-click,
	// which omits this and defaults to false) — rather than a plain "just
	// select it" click. wa-preview.js reads this off the "change" event's
	// detail to decide whether to switch panels or stay put.
	//
	// reveal: true additionally asks wa-xml-tree.js to expand every
	// collapsed ancestor of `id` and scroll it into view — an explicit
	// "show me this in the XML tree" action, per Hans (2026-09-08):
	// double-clicking a <Layer>/<Segment> box in wa-section-view.js. Never
	// implied by a plain select (dropping a file, a single click on a box)
	// — those must NOT jump the tree's own scroll/collapse state out from
	// under the user, only this explicit gesture does.
	selectNode(id, { open = false, reveal = false } = {}) {
		this.selectedNodeId = id;
		this.selectedNodeIds = new Set(id ? [id] : []);
		this._emit(false, { open, reveal });
	}

	// Cmd/Ctrl-click: toggles one node in/out of the multi-selection.
	// Becomes the new primary (Inspector/Preview target) when added; when
	// removing the current primary, falls back to another still-selected
	// member (or null if the set is now empty). Per Hans (2026-09-06).
	toggleNodeSelection(id) {
		if (!id) return;
		const next = new Set(this.selectedNodeIds);
		if (next.has(id)) {
			next.delete(id);
			this.selectedNodeIds = next;
			if (this.selectedNodeId === id) {
				const remaining = [...next];
				this.selectedNodeId = remaining.length ? remaining[remaining.length - 1] : null;
			}
		} else {
			next.add(id);
			this.selectedNodeIds = next;
			this.selectedNodeId = id;
		}
		this._emit(false);
	}

	// Shift-click: replaces the multi-selection outright with this exact
	// ordered id list — the *visible tree row* range between the click
	// anchor and the just-clicked row (wa-xml-tree.js computes the actual
	// ordering, since that depends on which rows are currently expanded,
	// something this store has no notion of). The last id becomes the new
	// primary. Per Hans (2026-09-06).
	selectRange(ids) {
		if (!ids || !ids.length) return;
		this.selectedNodeIds = new Set(ids);
		this.selectedNodeId = ids[ids.length - 1];
		this._emit(false);
	}

	getSelectedNode() {
		if (!this.root || !this.selectedNodeId) return null;
		return ops.findNodeById(this.root, this.selectedNodeId);
	}

	// --- tree <-> code line mapping (see xml-tree-ops.generateFullXmlWithLineMap) ---

	getLineRange(nodeId) {
		if (!nodeId) return null;
		return this.lineMap.get(nodeId) || null;
	}

	// Deepest node whose line range contains `line` (ranges nest, so this picks
	// the tightest/most specific match rather than an outer ancestor).
	getNodeIdAtLine(line) {
		let bestId = null;
		let bestSpan = Infinity;
		for (const [id, range] of this.lineMap) {
			if (line < range.start || line > range.end) continue;
			const span = range.end - range.start;
			if (span < bestSpan) {
				bestSpan = span;
				bestId = id;
			}
		}
		return bestId;
	}

	// --- tree mutations (each re-serializes to codeValue and emits "change") ---

	setRoot(node) {
		this.root = node;
		this.selectedNodeId = node ? node.id : null;
		this._syncCode();
	}

	// Like setRoot, but for edit-history.js's undo/redo: restores a specific
	// past selection along with the tree (setRoot always resets selection to
	// the new root itself, which isn't what a mid-tree undo/redo should do).
	// `root` here is a whole past `this.root` reference reused as-is — safe
	// only because every xml-tree-ops.js mutator is non-mutating (each edit
	// produces a *new* tree rather than touching an old one in place), so an
	// old root snapshot can never have been corrupted by edits made since.
	restoreSnapshot(root, selectedNodeId) {
		this.root = root;
		this.selectedNodeId = root && selectedNodeId && ops.findNodeById(root, selectedNodeId) ? selectedNodeId : root?.id ?? null;
		this._syncCode(true);
	}

	createRoot(tagName) {
		const trimmed = (tagName || "").trim();
		if (!trimmed) return;
		this.setRoot(ops.createXmlNode(trimmed, null));
	}

	addChild(parentId, tagName) {
		return this.insertNewChild(parentId, tagName);
	}

	// Like addChild, but with control over the initial attributes and
	// insertion index (used for e.g. dropping a file between two elements).
	insertNewChild(parentId, tagName, attributes, index) {
		if (!this.root) return;
		let child = ops.createXmlNode(tagName, parentId);
		// Every new *regular* <Section> gets a unique `class` so it's usable
		// as a PLAY/STOP trigger selector right away — see
		// generateSectionClass. Not for a "transition" Section (has its own
		// from/to instead, see wa-composition-view.js) — per Hans
		// (2026-09-05), those should stay classless.
		const isTransitionSection = attributes?.from !== undefined || attributes?.to !== undefined;
		if (tagName === "Section" && !attributes?.class && !isTransitionSection) {
			attributes = { ...attributes, class: ops.generateSectionClass(this.root) };
		}
		// Every new <Var> gets a name (see generateVarName — required for
		// setVariable()/"$name" to reach it at all) plus a sensible starting
		// mapin/default, so a freshly-created one is immediately usable as a
		// wa-var-knobs.js knob rather than needing three attributes filled in
		// by hand first. Never overrides a caller-supplied value.
		if (tagName === "Var") {
			attributes = {
				name: ops.generateVarName(this.root),
				mapin: "0,1",
				default: "0",
				...attributes
			};
		}
		if (attributes) child = { ...child, attributes };
		this.root = ops.insertChild(this.root, parentId, child, index);
		this.selectedNodeId = child.id;
		this._syncCode();
		return child;
	}

	// Selecting the parent (rather than clearing to nothing) on delete is
	// deliberate: a view that only shows itself while something inside its
	// own subtree is selected (Section preview, Mixer preview) would
	// otherwise vanish out from under the user the moment they delete
	// whatever they were just looking at.
	removeNode(nodeId) {
		if (!this.root) return;
		if (this.selectedNodeId === nodeId) {
			const node = ops.findNodeById(this.root, nodeId);
			this.selectedNodeId = node?.parent ?? null;
		}
		this.root = ops.removeNode(this.root, nodeId);
		this._syncCode();
	}

	// --- copy / cut / paste (see wa-edit-menu.js, wa-xml-tree.js) ---

	// The current selection, with any node that's itself a descendant of
	// another *also-selected* node dropped — copying/cutting a parent
	// already brings its selected children along with it; including them a
	// second time as their own top-level entries would duplicate them under
	// the paste target. Falls back to the single primary selection when
	// nothing is multi-selected.
	_topLevelSelection() {
		if (!this.root) return [];
		const ids = this.selectedNodeIds.size ? this.selectedNodeIds : new Set(this.selectedNodeId ? [this.selectedNodeId] : []);
		const nodes = [...ids].map((id) => ops.findNodeById(this.root, id)).filter(Boolean);
		return nodes.filter((n) => !nodes.some((other) => other.id !== n.id && ops.isDescendantOf(other, n.id)));
	}

	// Snapshots the current selection by reference, ids intact — safe without
	// cloning because every xml-tree-ops.js mutator is non-mutating (an edit
	// elsewhere always produces fresh node objects rather than touching these
	// in place). Keeping the *original* ids here (rather than stripping them
	// now) is deliberate: pasteIntoSelection re-clones fresh per paste anyway
	// (so a copy can be pasted more than once, each with its own new ids),
	// and cloning from the original ids lets it build an old-id->new-id map
	// wa-xml-tree.js uses to carry over collapsed/expanded state.
	copySelection() {
		const nodes = this._topLevelSelection();
		if (!nodes.length) return false;
		this._clipboard = { mode: "copy", nodes };
		this._emit(false); // lets wa-edit-menu.js re-enable Paste
		return true;
	}

	// Deferred removal, per Hans (2026-09-06): cutting doesn't touch the
	// document at all yet — it only marks the selection as "pending move"
	// (stored as ids, re-resolved fresh from this.root at paste time, so
	// any edit made before the eventual paste is reflected). The actual
	// removal only happens as part of a *successful* paste (see
	// pasteIntoSelection) — a paste that fails schema validation leaves the
	// document completely untouched, and the cut content is still sitting
	// in the clipboard to retry pasting somewhere else.
	cutSelection() {
		const nodes = this._topLevelSelection();
		if (!nodes.length) return false;
		this._clipboard = { mode: "cut", nodes: nodes.map((n) => n.id) };
		this._emit(false); // lets wa-xml-tree.js show the "marked for cut" style
		return true;
	}

	hasClipboard() {
		return !!this._clipboard && this._clipboard.nodes.length > 0;
	}

	// Escape: "let go" of a pending cut — clears the clipboard (and the
	// "marked for cut" dashed row style in wa-xml-tree.js) without moving
	// anything, since a cut never touches the document until a paste actually
	// lands (see cutSelection above). A no-op for a copy clipboard — there's
	// nothing "cut" to release. Per Hans (2026-09-07).
	clearPendingCut() {
		if (this._clipboard?.mode !== "cut") return;
		this._clipboard = null;
		this._emit(false);
	}

	// Read by wa-xml-tree.js to dim/dash the rows currently marked for a
	// pending cut (see cutSelection's own comment on why nothing is
	// actually removed yet).
	get clipboardCutIds() {
		return this._clipboard?.mode === "cut" ? new Set(this._clipboard.nodes) : new Set();
	}

	// Pastes the clipboard as new children of the current primary selection.
	// Validates every clipboard node's tag against the target's own
	// schema.allowedChildren *before* touching the document at all — same
	// validation depth this app's drag-and-drop reorder already uses
	// (wa-xml-tree.js's _isSchemaValidReparent: "is this tag permitted as an
	// immediate child here", not full XSD conformance — maxOccurs/ordering
	// aren't checked anywhere else in this app either) — and never partially
	// applies: either every clipboard node lands, or none of them do.
	// Returns { ok: true } or { ok: false, reason }.
	pasteIntoSelection() {
		if (!this.root) return { ok: false, reason: "No document open" };
		if (!this._clipboard || !this._clipboard.nodes.length) return { ok: false, reason: "Nothing to paste" };
		const target = this.selectedNodeId ? ops.findNodeById(this.root, this.selectedNodeId) : null;
		if (!target) return { ok: false, reason: "Select an element to paste into first" };

		const { mode, nodes } = this._clipboard;
		const sourceNodes = mode === "cut" ? nodes.map((id) => ops.findNodeById(this.root, id)).filter(Boolean) : nodes;
		if (!sourceNodes.length) return { ok: false, reason: "Nothing to paste" };

		if (this.schema) {
			const allowedChildren = this.schema.elements[target.tagName]?.allowedChildren || [];
			const invalid = sourceNodes.find((n) => !allowedChildren.includes(n.tagName));
			if (invalid) return { ok: false, reason: `<${invalid.tagName}> isn't allowed inside <${target.tagName}>` };
		}

		if (mode === "cut") {
			const selfOrDescendant = sourceNodes.find((n) => n.id === target.id || ops.isDescendantOf(n, target.id));
			if (selfOrDescendant) return { ok: false, reason: "Can't paste an element into itself or its own descendant" };
			// reparentNode preserves the node's own id/structure exactly — a
			// cut+paste never collides, so ids are never regenerated here,
			// per Hans.
			sourceNodes.forEach((n) => {
				this.root = ops.reparentNode(this.root, n.id, target.id);
			});
			this._clipboard = null; // a move is consumed after one paste
			this._syncCode();
		} else {
			// cloneNode strips ids (see its own comment) — _syncCode's
			// backfill below assigns each one a fresh, unique id, so pasting
			// the same copy repeatedly never collides either. idMap collects
			// every original->new internal id pair across the whole pasted
			// subtree(s), so wa-xml-tree.js can carry over each node's own
			// collapsed/expanded state to its fresh clone.
			const idMap = new Map();
			sourceNodes.forEach((n) => {
				const clone = ops.cloneNode(n, target.id, idMap);
				this.root = ops.insertChild(this.root, target.id, clone);
			});
			this._syncCode(true, { idMap });
		}

		return { ok: true };
	}

// idMap (see cloneNode) lets wa-xml-tree.js carry the duplicated node's own
	// collapsed/expanded state over to its fresh clone.
	copyNode(nodeId) {
		if (!this.root) return;
		const node = ops.findNodeById(this.root, nodeId);
		if (!node || !node.parent) return; // can't copy root in place
		const idMap = new Map();
		const copy = ops.cloneNode(node, node.parent, idMap);
		const parent = ops.findNodeById(this.root, node.parent);
		if (!parent) return;
		const idx = parent.children.findIndex((c) => c.id === nodeId);
		this.root = ops.insertChild(this.root, node.parent, copy, idx + 1);
		this.selectedNodeId = copy.id;
		this._syncCode(true, { idMap });
	}

	reparentNode(nodeId, newParentId, index) {
		if (!this.root) return;
		this.root = ops.reparentNode(this.root, nodeId, newParentId, index);
		this._syncCode();
	}

	// Most attribute changes are structural=false (see below) — but per Hans,
	// a few specific ones don't have a working *live* equivalent at all:
	// output/input/bus only take effect when waxml.js actually re-wires
	// .connect() calls while building the graph, and an OscillatorNode's
	// "type" governs which construction path it takes, not a property that
	// can just be nudged after the fact. Changing any of these needs the
	// whole graph rebuilt (player-store.js's normal structural-edit reload),
	// same as adding/removing a node — a plain live-property nudge would
	// silently do nothing.
	static ROUTING_REBUILD_ATTRS = new Set(["output", "input", "bus"]);

	// structural=false (the common case): an attribute value changing never
	// adds/removes/reorders a node, so it can't change what a live waxml
	// audio graph needs to look like — only *what value* a node's live
	// setter should be given (see player-store.js, which listens for exactly
	// this flag to decide whether a live edit can be applied via a direct
	// setter, or needs the whole engine graph stopped and rebuilt). The
	// routing/oscillator-type exception above is structural=true instead,
	// for the same reason a tree-shape edit is.
	updateAttributes(nodeId, attributes) {
		if (!this.root) return;
		const node = ops.findNodeById(this.root, nodeId);
		const structural = this._attributeChangeNeedsRebuild(node, attributes);
		this.root = ops.updateNodeAttributes(this.root, nodeId, attributes);
		this._syncCode(structural);
	}

	_attributeChangeNeedsRebuild(node, nextAttributes) {
		if (!node) return false;
		for (const name of XmlStore.ROUTING_REBUILD_ATTRS) {
			if (nextAttributes[name] !== node.attributes[name]) return true;
		}
		if (node.tagName === "OscillatorNode" && nextAttributes.type !== node.attributes.type) return true;
		// Temporary, per Hans (2026-09-01): the <Composition>/iMus side of
		// waxml.js doesn't have the Web Audio side's live-property-nudge
		// wiring yet (e.g. changing loopEnd live currently does nothing
		// audible) — so ANY attribute change on a <Composition> itself, or on
		// anything inside one, needs the whole graph rebuilt rather than a
		// live nudge that would silently no-op. Remove this blanket rule once
		// that live coupling exists on the iMus side.
		if (this._isInsideComposition(node)) return true;
		// An attribute whose value newly becomes (or stops being) a "$name"
		// <Var> reference needs a full reload too, for the same "live nudge
		// silently no-ops" reason as the Composition rule above: waxml.js
		// only wires up that reference's live Watcher while walking the
		// whole document afresh (Parser.parseXML, via updateFromString) — a
		// plain live-property nudge just hands the literal "$name" string to
		// the node's own setter, which quietly rejects it (e.g. Mixer's own
		// `set solo()` bails out on isNaN). Bug per Hans (2026-09-05):
		// turning a <Var> knob did nothing for a Mixer's solo, because the
		// edit that first set solo="$var1" never actually reached waxml.js's
		// Watcher machinery in the first place.
		for (const name of new Set([...Object.keys(node.attributes), ...Object.keys(nextAttributes)])) {
			const was = node.attributes[name];
			const now = nextAttributes[name];
			if (was === now) continue;
			if (isVariableControlled(was) || isVariableControlled(now)) return true;
		}
		return false;
	}

	// Walks up from `node` (inclusive) looking for a <Composition> ancestor —
	// internal parent chain, same convention as every other tree walk here
	// (node.parent is the internal tree id, not the XML id attribute).
	_isInsideComposition(node) {
		let current = node;
		while (current) {
			if (current.tagName === "Composition") return true;
			current = current.parent ? ops.findNodeById(this.root, current.parent) : null;
		}
		return false;
	}

	renameSrcReferences(oldPath, newPath) {
		if (!this.root) return;
		this.root = ops.renameSrcReferences(this.root, this.schema, oldPath, newPath);
		this._syncCode(false);
	}

	updateTagName(nodeId, tagName) {
		if (!this.root) return;
		this.root = ops.updateNodeTagName(this.root, nodeId, tagName);
		this._syncCode();
	}

	updateTextContent(nodeId, text) {
		if (!this.root) return;
		this.root = ops.updateNodeTextContent(this.root, nodeId, text);
		this._syncCode();
	}

	// --- code -> tree sync (called by wa-xml-code on every edit) ---

	setCodeValue(code) {
		this.codeValue = code;
		const parsed = ops.parseXmlString(code);
		if (parsed) {
			// Backfilled into the tree only — codeValue stays exactly as typed
			// (below) so a freshly-typed <Stinger/> with no id yet doesn't get
			// its formatting/cursor position fought on every keystroke; the id
			// becomes visible in the text on the next tree-driven edit
			// (_syncCode), same as canonical formatting already does.
			this.root = ops.backfillElementIds(parsed, this._idCounters);
			if (this.selectedNodeId && !ops.findNodeById(this.root, this.selectedNodeId)) {
				this.selectedNodeId = null;
			}
			// Best-effort: line numbers here come from re-serializing the parsed
			// tree in our own canonical layout, so they only match the literal
			// text 1:1 while the user's formatting happens to agree with it.
			// They re-sync exactly on the next tree-driven edit (_syncCode).
			this.lineMap = ops.generateFullXmlWithLineMap(this.root).lineMap;
		}
		// Invalid XML is left as-is in codeValue so the user can keep typing,
		// but root/selection don't change — matches the DEMO's behaviour.
		this._emit();
	}

	// structural (default true — the safe default, since under-flagging a
	// real structural change is a worse bug than an occasional unnecessary
	// engine stop): whether this edit could have changed the *shape* the
	// live waxml audio graph needs (nodes added/removed/reordered/retyped),
	// as opposed to just a value on an already-existing node.
	_syncCode(structural = true, extra = {}) {
		if (this.root) {
			this.root = ops.backfillElementIds(this.root, this._idCounters);
			const { xml, lineMap } = ops.generateFullXmlWithLineMap(this.root);
			this.codeValue = xml;
			this.lineMap = lineMap;
		} else {
			this.codeValue = EMPTY_XML;
			this.lineMap = new Map();
		}
		this._emit(structural, extra);
	}

	_emit(structural = true, extra = {}) {
		this.dispatchEvent(new CustomEvent("change", { detail: { structural, ...extra } }));
	}
}

export const xmlStore = new XmlStore();
