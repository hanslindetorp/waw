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

	setSchema(schema, fileName) {
		this.schema = schema;
		this.schemaFileName = fileName || "";
		this._emit();
	}

	clearSchema() {
		this.schema = null;
		this.schemaFileName = "";
		this._emit();
	}

	// --- selection ---

	selectNode(id) {
		this.selectedNodeId = id;
		this._emit();
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
		if (attributes) child = { ...child, attributes };
		this.root = ops.insertChild(this.root, parentId, child, index);
		this.selectedNodeId = child.id;
		this._syncCode();
		return child;
	}

	removeNode(nodeId) {
		if (!this.root) return;
		if (this.selectedNodeId === nodeId) this.selectedNodeId = null;
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

	updateAttributes(nodeId, attributes) {
		if (!this.root) return;
		this.root = ops.updateNodeAttributes(this.root, nodeId, attributes);
		this._syncCode();
	}

	renameSrcReferences(oldPath, newPath) {
		if (!this.root) return;
		this.root = ops.renameSrcReferences(this.root, this.schema, oldPath, newPath);
		this._syncCode();
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

	_syncCode() {
		if (this.root) {
			this.root = ops.backfillElementIds(this.root, this._idCounters);
			const { xml, lineMap } = ops.generateFullXmlWithLineMap(this.root);
			this.codeValue = xml;
			this.lineMap = lineMap;
		} else {
			this.codeValue = EMPTY_XML;
			this.lineMap = new Map();
		}
		this._emit();
	}

	_emit() {
		this.dispatchEvent(new CustomEvent("change"));
	}
}

export const xmlStore = new XmlStore();
