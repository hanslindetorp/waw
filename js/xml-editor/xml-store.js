import * as ops from "./xml-tree-ops.js";

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

	selectNode(id) {
		this.selectedNodeId = id;
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
		// Every new <Section> gets a unique `class` so it's usable as a
		// PLAY/STOP trigger selector right away — see generateSectionClass.
		if (tagName === "Section" && !attributes?.class) {
			attributes = { ...attributes, class: ops.generateSectionClass(this.root) };
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

copyNode(nodeId) {
		if (!this.root) return;
		const node = ops.findNodeById(this.root, nodeId);
		if (!node || !node.parent) return; // can't copy root in place
		const copy = ops.cloneNode(node, node.parent);
		const parent = ops.findNodeById(this.root, node.parent);
		if (!parent) return;
		const idx = parent.children.findIndex((c) => c.id === nodeId);
		this.root = ops.insertChild(this.root, node.parent, copy, idx + 1);
		this.selectedNodeId = copy.id;
		this._syncCode();
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
		return this._isInsideComposition(node);
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
	_syncCode(structural = true) {
		if (this.root) {
			this.root = ops.backfillElementIds(this.root, this._idCounters);
			const { xml, lineMap } = ops.generateFullXmlWithLineMap(this.root);
			this.codeValue = xml;
			this.lineMap = lineMap;
		} else {
			this.codeValue = EMPTY_XML;
			this.lineMap = new Map();
		}
		this._emit(structural);
	}

	_emit(structural = true) {
		this.dispatchEvent(new CustomEvent("change", { detail: { structural } }));
	}
}

export const xmlStore = new XmlStore();
