import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import { getSchemaSrcAttributeName } from "../xml-editor/src-attribute.js";
import { vfs } from "../vfs/VFS.js";
import { VFS_FILE_DRAG_TYPE } from "../vfs/drag-types.js";

const FILE_DROP_TAG = "AudioBufferSourceNode";
const INDENT_PX = 18;
const BASE_PADDING_PX = 8;
const DEFAULT_COLUMNS = ["id", "class"];

// Renders the tree as a flat, indented list of CSS Grid rows (Finder-style
// "list view") rather than nested DOM — every row shares the same column
// tracks as the header, and indentation is a single depth*INDENT_PX with no
// nesting to compound it.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.container {
			padding: 0.6rem;
		}
		.container.grid-mode {
			padding: 0;
			display: grid;
			align-content: start;
		}
		.create-root {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.75rem;
			padding: 2rem 1rem;
			text-align: center;
		}
		.create-root select,
		.create-root input {
			font: inherit;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.4rem 0.5rem;
		}
		.create-root .row-input {
			display: flex;
			gap: 0.4rem;
		}
		.create-root button {
			background: var(--waw-accent, #4fa3ff);
			color: #06131f;
			font-weight: 600;
			border: none;
			border-radius: 4px;
			padding: 0.4rem 0.7rem;
			cursor: pointer;
		}

		.cell {
			display: flex;
			align-items: center;
			min-width: 0;
			padding: 0.3rem 0.5rem;
			border-bottom: 1px solid var(--waw-tree-node-border, #333);
			background: var(--waw-tree-node-bg, #1f1f1f);
			overflow: hidden;
		}
		.cell.header-cell {
			position: sticky;
			top: 0;
			z-index: 3;
			background: var(--waw-panel-bg, #1a1a1a);
			color: var(--waw-muted, #8a8a8a);
			font-weight: 600;
			font-size: 0.66rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			cursor: default;
			user-select: none;
			white-space: nowrap;
		}
		.cell.name-cell {
			gap: 0.35rem;
			cursor: pointer;
		}
		.cell.attr-cell {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.75rem;
			color: var(--waw-muted, #8a8a8a);
			cursor: default;
		}
		.cell:hover {
			background: var(--waw-tree-node-hover, #232936);
		}
		.cell.selected {
			background: var(--waw-tree-node-selected, #234b73);
		}
		.cell.dragging {
			opacity: 0.4;
		}
		.cell.drop-inside {
			background: rgba(79, 163, 255, 0.18);
		}
		.cell.drop-before {
			box-shadow: inset 0 2px 0 0 var(--waw-accent, #4fa3ff);
		}
		.cell.drop-after {
			box-shadow: inset 0 -2px 0 0 var(--waw-accent, #4fa3ff);
		}
		.cell.file-drop-hover {
			background: rgba(69, 181, 140, 0.15);
		}

		.attr-value {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.attr-value.empty {
			color: var(--waw-tree-node-border, #333);
		}
		.attr-edit-input {
			width: 100%;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			background: #0c0c0c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			color: inherit;
			padding: 0.1rem 0.3rem;
		}

		.grip {
			color: var(--waw-muted, #8a8a8a);
			cursor: grab;
			flex: 0 0 auto;
			font-size: 0.75rem;
		}
		.toggle {
			background: none;
			border: none;
			color: inherit;
			cursor: pointer;
			flex: 0 0 auto;
			width: 1.1rem;
			padding: 0;
		}
		.toggle-spacer {
			display: inline-block;
			width: 1.1rem;
			flex: 0 0 auto;
		}

		.tag-btn {
			background: none;
			border: none;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-weight: 600;
			color: var(--waw-accent, #4fa3ff);
			cursor: pointer;
			padding: 0;
			white-space: nowrap;
		}
		.tag-btn:hover {
			text-decoration: underline;
		}
		.tag-label {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-weight: 600;
			color: var(--waw-accent, #4fa3ff);
			white-space: nowrap;
		}

		.text-preview {
			flex: 0 1 auto;
			max-width: 80px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.file-hint {
			flex: 0 0 auto;
			color: var(--waw-teal, #45b58c);
			font-size: 0.72rem;
			font-weight: 600;
		}

		.actions {
			margin-left: auto;
			display: flex;
			align-items: center;
			gap: 0.1rem;
			flex: 0 0 auto;
		}
		.actions button {
			background: none;
			border: none;
			cursor: pointer;
			color: var(--waw-muted, #8a8a8a);
			border-radius: 4px;
			padding: 0.2rem 0.3rem;
			font-size: 0.85rem;
			line-height: 1;
		}
		.actions button:hover {
			background: rgba(255, 255, 255, 0.08);
		}
		.actions .act-add,
		.actions .act-copy {
			font-size: 1.2rem;
		}
		.actions .act-add:hover { color: var(--waw-teal, #45b58c); }
		.actions .act-copy:hover { color: var(--waw-accent, #4fa3ff); }
		.actions .act-delete:hover { color: var(--waw-danger, #e5484d); }

		.add-element-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.75rem;
			padding: 0.1rem 0;
		}
		.add-element-btn:hover {
			color: var(--waw-teal, #45b58c);
		}

		.popover,
		.column-menu {
			/* fixed (not absolute): these are appended straight to the shadow
			   root, not nested inside a grid cell — grid items are promoted to
			   the same painting tier as positioned content (see CSS Grid z-axis
			   ordering), so an absolutely-positioned popover nested *inside* a
			   cell would paint under whichever row happens to come later in
			   DOM order. Positioning as siblings of the grid, anchored via
			   getBoundingClientRect()/clientX/clientY, sidesteps that entirely. */
			position: fixed;
			z-index: 20;
			background: #1c1c1c;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
			padding: 0.25rem;
			max-height: 260px;
			overflow: auto;
			min-width: 10rem;
		}
		.popover button {
			display: block;
			width: 100%;
			text-align: left;
			background: none;
			border: none;
			color: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.8rem;
			padding: 0.3rem 0.5rem;
			border-radius: 4px;
			cursor: pointer;
		}
		.popover button:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.popover button.current {
			color: var(--waw-accent, #4fa3ff);
			font-weight: 700;
		}
		.column-menu-item {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.25rem 0.4rem;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
			cursor: pointer;
			border-radius: 4px;
			white-space: nowrap;
		}
		.column-menu-item:hover {
			background: rgba(79, 163, 255, 0.15);
		}
	</style>
	<div class="container"></div>
`;

export class WaXmlTree extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._container = this.shadowRoot.querySelector(".container");
		this._collapsedIds = new Set();
		this._dragState = { draggedNodeId: null, dropTargetId: null, dropPosition: null };
		this._openPopoverEl = null;
		this._openColumnMenuEl = null;
		this._creatingCustomRoot = false;
		this._activeColumns = [...DEFAULT_COLUMNS];
	}

	connectedCallback() {
		this._onDocumentClick = (e) => {
			if (this._openPopoverEl && !e.composedPath().includes(this._openPopoverEl)) {
				this._closePopover();
			}
			if (this._openColumnMenuEl && !e.composedPath().includes(this._openColumnMenuEl)) {
				this._closeColumnMenu();
			}
		};
		document.addEventListener("click", this._onDocumentClick);
		xmlStore.addEventListener("change", () => this._onStoreChange());

		// Safety net: without this, a file dropped on any gap between/around
		// grid cells (not directly over a cell) falls through to the browser's
		// native "open this file" behaviour instead of being handled below.
		this.addEventListener("dragover", (e) => e.preventDefault());
		this.addEventListener("drop", (e) => e.preventDefault());

		this.render();
	}

	disconnectedCallback() {
		document.removeEventListener("click", this._onDocumentClick);
	}

	// xmlStore fires one generic "change" event for everything (edits, add/
	// remove, selection, schema, code edits...). A full render() destroys and
	// recreates every cell — which, for a plain selection change, breaks the
	// browser's double-click detection (it requires the *same* element to
	// receive both clicks to synthesize dblclick). Since only tree mutations
	// replace xmlStore.root (immutable-update pattern) and selectNode() never
	// touches it, comparing root/schema by reference tells us whether this
	// change is "just a selection" — if so, only toggle .selected in place.
	_onStoreChange() {
		if (xmlStore.root === this._lastRoot && xmlStore.schema === this._lastSchema) {
			this._updateSelectionHighlight();
		} else {
			this.render();
		}
	}

	_updateSelectionHighlight() {
		this._container.querySelectorAll(".cell[data-node-id]").forEach((cell) => {
			cell.classList.toggle("selected", cell.dataset.nodeId === xmlStore.selectedNodeId);
		});
	}

	render() {
		this._closePopover();
		this._container.innerHTML = "";
		const root = xmlStore.root;
		this._lastRoot = root;
		this._lastSchema = xmlStore.schema;

		if (!root) {
			this._container.classList.remove("grid-mode");
			this._container.appendChild(this._renderCreateRoot());
			return;
		}

		this._container.classList.add("grid-mode");
		this._container.style.gridTemplateColumns = this._gridTemplateColumns();

		this._container.appendChild(this._renderHeaderCell("Name"));
		this._activeColumns.forEach((col) => this._container.appendChild(this._renderHeaderCell(col)));

		this._flatten(root).forEach((entry) => {
			const cells = entry.kind === "node" ? this._renderNodeRow(entry) : this._renderAddElementRow(entry);
			cells.forEach((cell) => this._container.appendChild(cell));
		});

		if (this._pendingEditTarget) {
			const { nodeId, colName } = this._pendingEditTarget;
			this._pendingEditTarget = null;
			const cell = this._container.querySelector(`.attr-cell[data-node-id="${nodeId}"][data-col="${colName}"]`);
			const node = ops.findNodeById(root, nodeId);
			if (cell && node) this._editAttrCell(cell, node, colName, node.attributes[colName]);
		}
	}

	_gridTemplateColumns() {
		const attrCols = this._activeColumns.map(() => "minmax(70px, max-content)").join(" ");
		return attrCols ? `minmax(200px, 1fr) ${attrCols}` : "minmax(200px, 1fr)";
	}

	// Depth-first walk of the visible (non-collapsed) tree into a flat row
	// list, interleaving synthetic trailing "+" rows exactly where the old
	// nested renderer placed the trailing button (after a node's last child).
	_flatten(root) {
		const out = [];
		const walk = (node, depth, isRoot, parentAllowedChildren) => {
			const schema = xmlStore.schema;
			const schemaElement = schema?.elements[node.tagName];
			const allowedChildren = schemaElement?.allowedChildren || [];
			const canHaveChildren = !schema || allowedChildren.length > 0;
			const hasChildren = node.children.length > 0;

			out.push({ kind: "node", node, depth, isRoot, hasChildren, canHaveChildren, allowedChildren, parentAllowedChildren });

			if (hasChildren && !this._collapsedIds.has(node.id)) {
				node.children.forEach((child) => walk(child, depth + 1, false, allowedChildren));
				if (canHaveChildren) {
					out.push({ kind: "add-element", depth: depth + 1, parentNode: node, allowedChildren });
				}
			}
		};
		walk(root, 0, true, []);
		return out;
	}

	_renderCreateRoot() {
		const schema = xmlStore.schema;
		const wrap = document.createElement("div");
		wrap.className = "create-root";

		const label = document.createElement("div");
		label.textContent = "No XML document. Create a root element:";
		wrap.appendChild(label);

		if (!schema) {
			// Nothing to validate a name against — just create the conventional
			// <root> element directly, no name prompt or list.
			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = "Create root element";
			btn.addEventListener("click", () => xmlStore.createRoot("root"));
			wrap.appendChild(btn);
			return wrap;
		}

		const rootOptions = [...schema.rootElements].sort((a, b) => a.localeCompare(b));

		if (rootOptions.length > 0 && !this._creatingCustomRoot) {
			const select = document.createElement("select");
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.textContent = "Select root element...";
			placeholder.disabled = true;
			placeholder.selected = true;
			select.appendChild(placeholder);
			rootOptions.forEach((name) => {
				const opt = document.createElement("option");
				opt.value = name;
				opt.textContent = name;
				select.appendChild(opt);
			});
			const other = document.createElement("option");
			other.value = "__other__";
			other.textContent = "Other...";
			select.appendChild(other);

			select.addEventListener("change", () => {
				if (select.value === "__other__") {
					this._creatingCustomRoot = true;
					this.render();
					return;
				}
				xmlStore.createRoot(select.value);
			});
			wrap.appendChild(select);
		} else {
			const row = document.createElement("div");
			row.className = "row-input";

			const input = document.createElement("input");
			input.type = "text";
			input.placeholder = "Root element name...";
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") xmlStore.createRoot(input.value);
			});

			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = "Create";
			btn.addEventListener("click", () => xmlStore.createRoot(input.value));

			row.appendChild(input);
			row.appendChild(btn);
			wrap.appendChild(row);
		}

		return wrap;
	}

	_renderHeaderCell(label) {
		const cell = document.createElement("div");
		cell.className = "cell header-cell";
		cell.textContent = label;
		cell.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this._openColumnMenu(e.clientX, e.clientY);
		});
		return cell;
	}

	_openColumnMenu(x, y) {
		this._closeColumnMenu();
		const menu = document.createElement("div");
		menu.className = "column-menu";
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;

		this._getAvailableColumnNames().forEach((name) => {
			const item = document.createElement("label");
			item.className = "column-menu-item";

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.checked = this._activeColumns.includes(name);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					if (!this._activeColumns.includes(name)) this._activeColumns.push(name);
				} else {
					this._activeColumns = this._activeColumns.filter((c) => c !== name);
				}
				this.render();
			});

			const text = document.createElement("span");
			text.textContent = name;

			item.appendChild(checkbox);
			item.appendChild(text);
			menu.appendChild(item);
		});

		this.shadowRoot.appendChild(menu);
		this._openColumnMenuEl = menu;
	}

	_closeColumnMenu() {
		if (this._openColumnMenuEl) {
			this._openColumnMenuEl.remove();
			this._openColumnMenuEl = null;
		}
	}

	// Union of every attribute name the schema declares anywhere, plus every
	// attribute name actually used in the current document — works with or
	// without a loaded schema.
	_getAvailableColumnNames() {
		const names = new Set(DEFAULT_COLUMNS);
		const schema = xmlStore.schema;
		if (schema) {
			Object.values(schema.elements).forEach((el) => {
				el.allowedAttributes.forEach((a) => names.add(a.name));
			});
		}
		const walk = (node) => {
			Object.keys(node.attributes).forEach((k) => names.add(k));
			node.children.forEach(walk);
		};
		if (xmlStore.root) walk(xmlStore.root);
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	_renderAddElementRow({ depth, parentNode, allowedChildren }) {
		const nameCell = document.createElement("div");
		nameCell.className = "cell name-cell";
		nameCell.style.paddingLeft = `${BASE_PADDING_PX + depth * INDENT_PX}px`;

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "add-element-btn";
		btn.textContent = "+";
		btn.title = "Add element";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this._startAddChild(parentNode, allowedChildren, btn);
		});
		nameCell.appendChild(btn);

		const attrCells = this._activeColumns.map(() => {
			const cell = document.createElement("div");
			cell.className = "cell attr-cell";
			return cell;
		});

		return [nameCell, ...attrCells];
	}

	_renderNodeRow({ node, depth, isRoot, hasChildren, canHaveChildren, allowedChildren, parentAllowedChildren }) {
		const schema = xmlStore.schema;
		const isSelected = xmlStore.selectedNodeId === node.id;
		const srcAttrName = getSchemaSrcAttributeName(schema, node.tagName);
		// Manual (schemaless) mode always allows file-drop, defaulting to "src";
		// with a schema loaded, only elements that declare a src/source attribute do.
		const canAcceptFile = !schema || srcAttrName !== null;
		const effectiveSrcAttrName = srcAttrName || "src";
		// Where a file dropped *between* elements would land — root's own allowed
		// children when hovering the root row (matching the reorder convention
		// where before/after-root means first/last child of root), otherwise the
		// hovered node's parent's allowed children.
		const siblingInsertionAllowedChildren = isRoot ? allowedChildren : parentAllowedChildren || [];
		const canInsertFileNode = !schema || siblingInsertionAllowedChildren.includes(FILE_DROP_TAG);

		const nameCell = document.createElement("div");
		nameCell.className = "cell name-cell";
		nameCell.dataset.nodeId = node.id;
		nameCell.style.paddingLeft = `${BASE_PADDING_PX + depth * INDENT_PX}px`;

		if (!isRoot) {
			const grip = document.createElement("span");
			grip.className = "grip";
			grip.textContent = "⋮⋮";
			nameCell.appendChild(grip);
		}

		if (hasChildren) {
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "toggle";
			toggle.textContent = this._collapsedIds.has(node.id) ? "▸" : "▾";
			toggle.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this._collapsedIds.has(node.id)) this._collapsedIds.delete(node.id);
				else this._collapsedIds.add(node.id);
				this.render();
			});
			nameCell.appendChild(toggle);
		} else {
			const spacer = document.createElement("span");
			spacer.className = "toggle-spacer";
			nameCell.appendChild(spacer);
		}

		nameCell.appendChild(this._renderTagLabel(node, isRoot, parentAllowedChildren));

		if (node.textContent) {
			const textSpan = document.createElement("span");
			textSpan.className = "text-preview";
			textSpan.textContent = `"${node.textContent}"`;
			nameCell.appendChild(textSpan);
		}

		const fileHint = document.createElement("span");
		fileHint.className = "file-hint";
		fileHint.hidden = true;
		fileHint.textContent = `⬇ ${effectiveSrcAttrName}`;
		nameCell.appendChild(fileHint);

		nameCell.appendChild(this._renderActions(node, isRoot, canHaveChildren, allowedChildren));

		const attrCells = this._activeColumns.map((colName) => this._renderAttrCell(node, colName));
		const cells = [nameCell, ...attrCells];

		if (isSelected) cells.forEach((c) => c.classList.add("selected"));
		cells.forEach((c) => c.addEventListener("click", () => xmlStore.selectNode(node.id)));

		this._wireDragEvents(cells, node, { isRoot, canAcceptFile, effectiveSrcAttrName, canInsertFileNode, fileHint });

		return cells;
	}

	_renderAttrCell(node, colName) {
		const cell = document.createElement("div");
		cell.className = "cell attr-cell";
		cell.dataset.nodeId = node.id;
		cell.dataset.col = colName;
		const value = node.attributes[colName];

		const span = document.createElement("span");
		span.className = value === undefined ? "attr-value empty" : "attr-value";
		span.textContent = value === undefined ? "–" : value;
		cell.appendChild(span);

		cell.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			if (value === undefined) {
				// Double-clicking a cell for an attribute the element doesn't have
				// yet adds it (empty value) right away, then continues straight
				// into edit mode — xmlStore's change event re-renders the whole
				// tree synchronously, so we ask render() to resume editing on the
				// freshly-created cell once it exists (see _pendingEditTarget below).
				this._pendingEditTarget = { nodeId: node.id, colName };
				xmlStore.updateAttributes(node.id, { ...node.attributes, [colName]: "" });
			} else {
				this._editAttrCell(cell, node, colName, value);
			}
		});

		return cell;
	}

	_editAttrCell(cell, node, colName, currentValue) {
		cell.innerHTML = "";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "attr-edit-input";
		input.value = currentValue !== undefined ? currentValue : "";
		cell.appendChild(input);
		input.focus();
		input.select();

		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const newValue = input.value;
			if (newValue === currentValue) {
				this.render();
				return;
			}
			if (newValue === "" && currentValue !== undefined) {
				const next = { ...node.attributes };
				delete next[colName];
				xmlStore.updateAttributes(node.id, next);
			} else {
				xmlStore.updateAttributes(node.id, { ...node.attributes, [colName]: newValue });
			}
		};

		input.addEventListener("click", (e) => e.stopPropagation());
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				committed = true;
				this.render();
			}
		});
		input.addEventListener("blur", commit);
	}

	_renderTagLabel(node, isRoot, parentAllowedChildren) {
		const schema = xmlStore.schema;
		const options = !schema
			? []
			: isRoot
				? [...schema.rootElements].sort((a, b) => a.localeCompare(b))
				: [...(parentAllowedChildren || [])].sort((a, b) => a.localeCompare(b));

		if (options.length === 0) {
			const span = document.createElement("span");
			span.className = "tag-label";
			span.textContent = node.tagName;
			return span;
		}

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "tag-btn";
		btn.textContent = node.tagName;
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this._openPopoverEl && this._openPopoverAnchor === btn) {
				this._closePopover();
			} else {
				this._openNamePopover(btn, options, node.tagName, (name) => xmlStore.updateTagName(node.id, name));
			}
		});

		return btn;
	}

	// Decides how to create a new child of parentNode: with a schema loaded
	// and exactly one legal child name, there's nothing to ask — create it
	// directly. With more than one legal name, show the same popover used for
	// renaming a tag so the user picks a schema-valid name instead of getting
	// a placeholder <element> the schema would reject. Without a schema
	// there's nothing to validate against, so new elements are just named
	// "element" with no popover (matches the root-creation fallback name
	// "root" in _renderCreateRoot).
	_startAddChild(parentNode, allowedChildren, anchorEl) {
		const schema = xmlStore.schema;

		if (schema && allowedChildren.length > 1) {
			if (this._openPopoverEl && this._openPopoverAnchor === anchorEl) {
				this._closePopover();
				return;
			}
			const options = [...allowedChildren].sort((a, b) => a.localeCompare(b));
			this._openNamePopover(anchorEl, options, null, (name) => xmlStore.addChild(parentNode.id, name));
			return;
		}

		const tagName = schema && allowedChildren.length === 1 ? allowedChildren[0] : "element";
		xmlStore.addChild(parentNode.id, tagName);
	}

	// Shared popover for picking an element name from a list — used both to
	// rename an existing element's tag and to name a freshly created child.
	_openNamePopover(anchorEl, options, currentName, onSelect) {
		this._closePopover();

		const popover = document.createElement("div");
		popover.className = "popover";
		options.forEach((name) => {
			const optBtn = document.createElement("button");
			optBtn.type = "button";
			optBtn.textContent = name;
			if (name === currentName) optBtn.classList.add("current");
			optBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				onSelect(name);
				this._closePopover();
			});
			popover.appendChild(optBtn);
		});

		const rect = anchorEl.getBoundingClientRect();
		popover.style.left = `${rect.left}px`;
		popover.style.top = `${rect.bottom + 2}px`;

		this.shadowRoot.appendChild(popover);
		this._openPopoverEl = popover;
		this._openPopoverAnchor = anchorEl;
	}

	_closePopover() {
		if (this._openPopoverEl) {
			this._openPopoverEl.remove();
			this._openPopoverEl = null;
			this._openPopoverAnchor = null;
		}
	}

	_renderActions(node, isRoot, canHaveChildren, allowedChildren) {
		const actions = document.createElement("div");
		actions.className = "actions";

		if (canHaveChildren) {
			const addBtn = document.createElement("button");
			addBtn.type = "button";
			addBtn.className = "act-add";
			addBtn.title = "Add child element";
			addBtn.textContent = "+";
			addBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this._collapsedIds.delete(node.id);
				this._startAddChild(node, allowedChildren, addBtn);
			});
			actions.appendChild(addBtn);
		}

		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "act-copy";
		copyBtn.title = "Duplicate element";
		copyBtn.textContent = "⎘";
		copyBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			xmlStore.copyNode(node.id);
		});
		actions.appendChild(copyBtn);

		if (!isRoot) {
			const delBtn = document.createElement("button");
			delBtn.type = "button";
			delBtn.className = "act-delete";
			delBtn.title = "Delete element";
			delBtn.textContent = "✕";
			delBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				xmlStore.removeNode(node.id);
			});
			actions.appendChild(delBtn);
		}

		return actions;
	}

	// cells = every grid cell belonging to this row (name-cell + attr-cells).
	// Drag/drop/hover feedback applies to all of them so the whole row acts as
	// one drop target, even though they're separate grid items with no
	// wrapping element.
	_wireDragEvents(cells, node, { isRoot, canAcceptFile, effectiveSrcAttrName, canInsertFileNode, fileHint }) {
		const primaryCell = cells[0];
		primaryCell.draggable = !isRoot;

		primaryCell.addEventListener("dragstart", (e) => {
			if (isRoot) {
				e.preventDefault();
				return;
			}
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", node.id);
			this._dragState = { draggedNodeId: node.id, dropTargetId: null, dropPosition: null };
			cells.forEach((c) => c.classList.add("dragging"));
		});

		primaryCell.addEventListener("dragend", () => {
			cells.forEach((c) => c.classList.remove("dragging"));
			this._clearDropIndicators();
			this._dragState = { draggedNodeId: null, dropTargetId: null, dropPosition: null };
		});

		const onDragOver = (e) => {
			e.preventDefault();
			e.stopPropagation();

			const types = e.dataTransfer.types;
			const isOsFileDrag = types.includes("Files") && !types.includes("text/plain");
			const isVfsFileDrag = types.includes(VFS_FILE_DRAG_TYPE);

			if (isOsFileDrag) {
				// Legacy behaviour (spec avsnitt 6.2): OS files can only set src on
				// the hovered element, never insert a new node between elements.
				if (canAcceptFile) {
					e.dataTransfer.dropEffect = "copy";
					cells.forEach((c) => c.classList.add("file-drop-hover"));
					fileHint.hidden = false;
				} else {
					e.dataTransfer.dropEffect = "none";
					cells.forEach((c) => c.classList.remove("file-drop-hover"));
					fileHint.hidden = true;
				}
				return;
			}

			if (isVfsFileDrag) {
				// Root gets the same three zones as everywhere else: before/after
				// mean "first/last child of root" (matching the reorder convention
				// below), "inside" means "set root's own src attribute".
				const rect = primaryCell.getBoundingClientRect();
				const y = e.clientY - rect.top;
				const position = y < rect.height * 0.25 ? "before" : y > rect.height * 0.75 ? "after" : "inside";
				const allowed = position === "inside" ? canAcceptFile : canInsertFileNode;

				cells.forEach((c) => c.classList.toggle("file-drop-hover", position === "inside" && allowed));
				fileHint.hidden = !(position === "inside" && allowed);

				if (allowed) {
					e.dataTransfer.dropEffect = "copy";
					this._setDropIndicator(cells, node.id, position);
				} else {
					e.dataTransfer.dropEffect = "none";
					this._clearDropIndicators();
					this._dragState = { ...this._dragState, dropTargetId: null, dropPosition: null };
				}
				return;
			}

			// Internal node-reorder drag.
			if (this._dragState.draggedNodeId === node.id) return;
			const rect = primaryCell.getBoundingClientRect();
			const y = e.clientY - rect.top;
			const position = y < rect.height * 0.25 ? "before" : y > rect.height * 0.75 ? "after" : "inside";
			this._setDropIndicator(cells, node.id, position);
		};

		const onDragLeave = () => {
			cells.forEach((c) => c.classList.remove("file-drop-hover"));
			fileHint.hidden = true;
		};

		const onDrop = (e) => {
			e.preventDefault();
			e.stopPropagation();

			const types = e.dataTransfer.types;
			const isOsFileDrag = types.includes("Files") && !types.includes("text/plain");
			const isVfsFileDrag = types.includes(VFS_FILE_DRAG_TYPE);

			cells.forEach((c) => c.classList.remove("file-drop-hover"));
			fileHint.hidden = true;

			if (isOsFileDrag || (e.dataTransfer.files.length > 0 && !this._dragState.draggedNodeId && !isVfsFileDrag)) {
				if (canAcceptFile && e.dataTransfer.files.length > 0) {
					this._handleOsFileDrop(node, effectiveSrcAttrName, e.dataTransfer.files[0]);
				}
				this._clearDropIndicators();
				return;
			}

			if (isVfsFileDrag) {
				const fileNodeId = e.dataTransfer.getData(VFS_FILE_DRAG_TYPE);
				const position = this._dragState.dropPosition;
				if (position) {
					this._handleVfsFileDrop(node, fileNodeId, position, canAcceptFile, effectiveSrcAttrName, canInsertFileNode);
				}
				this._clearDropIndicators();
				this._dragState = { draggedNodeId: null, dropTargetId: null, dropPosition: null };
				return;
			}

			if (this._dragState.dropPosition) {
				this._performDrop(node.id, this._dragState.dropPosition);
			}
			this._clearDropIndicators();
			this._dragState = { draggedNodeId: null, dropTargetId: null, dropPosition: null };
		};

		cells.forEach((c) => {
			c.addEventListener("dragover", onDragOver);
			c.addEventListener("dragleave", onDragLeave);
			c.addEventListener("drop", onDrop);
		});
	}

	// A file dragged straight from the OS (not from wa-file-manager) is
	// uploaded into the VFS first, so it shows up in the file manager too and
	// gets a real, resolvable export path instead of just a bare filename.
	_handleOsFileDrop(node, effectiveSrcAttrName, file) {
		const fileNode = vfs.uploadFile(undefined, file);
		const exportPath = vfs.getExportPath(fileNode.id);
		xmlStore.updateAttributes(node.id, { ...node.attributes, [effectiveSrcAttrName]: exportPath });
	}

	// Handles a file dragged from wa-file-manager being dropped on the tree.
	// "inside" (on an element) sets its src/source attribute; "before"/"after"
	// (between elements) inserts a new AudioBufferSourceNode with src set —
	// both gated by canAcceptFile/canInsertFileNode, which already checked the
	// XSD (when a schema is loaded) during dragover.
	_handleVfsFileDrop(targetNode, fileNodeId, position, canAcceptFile, effectiveSrcAttrName, canInsertFileNode) {
		const fileNode = vfs.getNode(fileNodeId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);

		if (position === "inside") {
			if (!canAcceptFile) return;
			xmlStore.updateAttributes(targetNode.id, { ...targetNode.attributes, [effectiveSrcAttrName]: exportPath });
			return;
		}

		if (!canInsertFileNode) return;
		const root = xmlStore.root;
		const parentId = targetNode.parent;

		if (!parentId) {
			// Dropped before/after the root — same convention as node reordering:
			// insert as first (before) or last (after) child of root.
			xmlStore.insertNewChild(targetNode.id, FILE_DROP_TAG, { src: exportPath }, position === "before" ? 0 : undefined);
			return;
		}

		const parent = ops.findNodeById(root, parentId);
		if (!parent) return;
		const targetIdx = parent.children.findIndex((c) => c.id === targetNode.id);
		const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
		xmlStore.insertNewChild(parentId, FILE_DROP_TAG, { src: exportPath }, insertIdx);
	}

	_setDropIndicator(cells, nodeId, position) {
		this._clearDropIndicators();
		cells.forEach((c) => c.classList.add(`drop-${position}`));
		this._dragState = { ...this._dragState, dropTargetId: nodeId, dropPosition: position };
		this._lastDropCells = cells;
	}

	_clearDropIndicators() {
		if (this._lastDropCells) {
			this._lastDropCells.forEach((c) => c.classList.remove("drop-before", "drop-after", "drop-inside"));
			this._lastDropCells = null;
		}
	}

	_performDrop(targetNodeId, position) {
		const draggedNodeId = this._dragState.draggedNodeId;
		const root = xmlStore.root;
		if (!draggedNodeId || !root || draggedNodeId === targetNodeId) return;

		const targetNode = ops.findNodeById(root, targetNodeId);
		if (!targetNode) return;

		if (position === "inside") {
			xmlStore.reparentNode(draggedNodeId, targetNodeId);
			return;
		}

		const parentId = targetNode.parent;
		if (!parentId) {
			xmlStore.reparentNode(draggedNodeId, targetNodeId, position === "before" ? 0 : undefined);
			return;
		}

		const parent = ops.findNodeById(root, parentId);
		if (!parent) return;
		const targetIdx = parent.children.findIndex((c) => c.id === targetNodeId);
		const draggedIdx = parent.children.findIndex((c) => c.id === draggedNodeId);
		let insertIdx = position === "before" ? targetIdx : targetIdx + 1;
		if (draggedIdx !== -1 && draggedIdx < targetIdx) insertIdx -= 1;
		xmlStore.reparentNode(draggedNodeId, parentId, insertIdx);
	}
}

customElements.define("wa-xml-tree", WaXmlTree);
