import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { importZip } from "../vfs/zip-import.js";
import { selection } from "../state/selection.js";
import { VFS_FILE_DRAG_TYPE, vfsDragState, getDraggedFileIds } from "../vfs/drag-types.js";
import { STATE_FILE_NAME } from "../project/workstation-state.js";

// Image extensions added (2026-09-10) so a project thumbnail — used by the
// Library (DEMO) view, see wa-library-view.js — can actually be uploaded via
// the Upload button, not just dragged in (drag-and-drop never enforced this
// list anyway).
const ACCEPTED = ".mp3,.wav,.ogg,.m4a,.xml,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg";

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.toolbar {
			display: flex;
			gap: 0.4rem;
			padding: 0.5rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
		}
		button {
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.55rem;
			font-size: 0.75rem;
			cursor: pointer;
		}
		button:hover {
			background: #333;
		}
		.toolbar button {
			width: 1.9rem;
			height: 1.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			font-size: 0.95rem;
			line-height: 1;
		}
		.dropzone {
			flex: 1 1 auto;
			overflow: auto;
			padding: 0.5rem;
		}
		:host(.drag-over) .dropzone {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -4px;
		}
		.empty-hint {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
			padding: 0.5rem 0.2rem;
		}
		ul.tree {
			list-style: none;
			margin: 0;
			padding-left: 0;
		}
		ul.tree ul.tree {
			padding-left: 1.1rem;
		}
		.node-row {
			display: flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.15rem 0.2rem;
			border-radius: 3px;
		}
		li.file > .node-row {
			cursor: pointer;
		}
		li.file > .node-row:hover {
			background: #262626;
		}
		li.file.selected > .node-row,
		li.folder.selected > .node-row {
			background: #234b73;
		}
		li.folder > .node-row {
			cursor: pointer;
		}
		li.folder > .node-row.drop-target {
			background: rgba(79, 163, 255, 0.18);
			outline: 1px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -1px;
		}
		.disclosure {
			flex: 0 0 auto;
			width: 1rem;
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			padding: 0;
			font-size: 0.65rem;
			text-align: center;
		}
		.disclosure-spacer {
			flex: 0 0 auto;
			display: inline-block;
			width: 1rem;
		}
		.name {
			flex: 1 1 auto;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.name-edit {
			flex: 1 1 auto;
			min-width: 0;
			font: inherit;
			background: #0c0c0c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			color: inherit;
			padding: 0.05rem 0.25rem;
		}
		.actions {
			display: none;
			gap: 0.15rem;
			flex: 0 0 auto;
			align-items: center;
		}
		.node-row:hover .actions,
		.node-row.confirming .actions {
			display: flex;
		}
		.actions button {
			padding: 0 0.3rem;
			font-size: 0.7rem;
		}
		.confirm-delete {
			display: none;
			align-items: center;
			gap: 0.3rem;
			flex: 0 0 auto;
			font-size: 0.72rem;
			white-space: nowrap;
		}
		.node-row.confirming .confirm-delete {
			display: flex;
		}
		.node-row.confirming .actions {
			display: none;
		}
		.confirm-delete button {
			padding: 0.05rem 0.35rem;
			font-size: 0.7rem;
		}
		.confirm-delete .confirm-yes {
			background: var(--waw-danger, #e5484d);
			border-color: var(--waw-danger, #e5484d);
			color: #fff;
		}
	</style>
	<div class="toolbar">
		<button class="btn-upload" type="button" title="Upload">⬆</button>
		<button class="btn-new-folder" type="button" title="New folder">📁</button>
		<input class="file-input" type="file" multiple hidden accept="${ACCEPTED}" />
	</div>
	<div class="dropzone">
		<p class="empty-hint">Drag &amp; drop audio files, WAXML files, or a .zip here.</p>
		<ul class="tree" role="tree"></ul>
	</div>
`;

export class WaFileManager extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._tree = this.shadowRoot.querySelector(".tree");
		this._emptyHint = this.shadowRoot.querySelector(".empty-hint");
		this._fileInput = this.shadowRoot.querySelector(".file-input");
		this._collapsedIds = new Set();
		// Multi-selection (Finder/Explorer-style Ctrl/Cmd/Shift-click) — kept
		// separate from `selection` (state/selection.js), which is the shared
		// single "currently active" file used cross-component (drives the
		// file preview panel etc.). `selection` still gets updated to whatever
		// was last clicked (see _setActiveSelection) so that behavior keeps
		// working unchanged; `_selectedIds` is this component's own richer
		// state, used for the multi-row highlight and for what a drag actually
		// carries. Per Hans (2026-09-15).
		this._selectedIds = new Set();
		this._selectionAnchorId = null; // last plain-clicked row — the fixed end for a subsequent Shift-click range
		this._isLocalSelectionUpdate = false; // guards against _onExternalSelectionChange undoing our own selection.select() call
		this._onDragOver = this._onDragOver.bind(this);
		this._onDragLeave = this._onDragLeave.bind(this);
		this._onDrop = this._onDrop.bind(this);
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".btn-upload").addEventListener("click", () => this._fileInput.click());
		this.shadowRoot.querySelector(".btn-new-folder").addEventListener("click", () => this._createFolder(ROOT_ID));
		this._fileInput.addEventListener("change", (e) => {
			this._handleFiles(e.target.files, ROOT_ID);
			this._fileInput.value = "";
		});

		this.addEventListener("dragover", this._onDragOver);
		this.addEventListener("dragleave", this._onDragLeave);
		this.addEventListener("drop", this._onDrop);

		// Clicking empty space in the dropzone (not any row) clears the
		// multi-selection, same as clicking blank space in a real file
		// picker — the row's own click handler (_handleRowClick) already
		// stops this from firing when the click actually lands on a row.
		this.shadowRoot.querySelector(".dropzone").addEventListener("click", (e) => {
			if (e.target.closest(".node-row")) return;
			this._clearFileSelection();
		});

		vfs.addEventListener("change", () => this.render());
		selection.addEventListener("change", (e) => this._onExternalSelectionChange(e.detail.id));

		this.render();
	}

	_onDragOver(e) {
		e.preventDefault();
		this.classList.add("drag-over");
	}

	_onDragLeave() {
		this.classList.remove("drag-over");
	}

	_onDrop(e) {
		e.preventDefault();
		this.classList.remove("drag-over");
		// A folder row's own drop handler (see _wireDropTarget) stops
		// propagation for an internal VFS-move drag, so only a drop that
		// missed every folder row (empty space, or onto a file) reaches here
		// — treat that as "move to the top level", same as dropping between
		// icons in Finder's list view.
		const draggedIds = getDraggedFileIds(e.dataTransfer);
		if (draggedIds.length > 0) {
			draggedIds.forEach((id) => this._moveNode(id, ROOT_ID));
			return;
		}
		this._handleFiles(e.dataTransfer.files, ROOT_ID);
	}

	async _handleFiles(fileList, parentId) {
		for (const file of Array.from(fileList)) {
			if (file.name.toLowerCase().endsWith(".zip")) {
				await importZip(vfs, parentId, file);
			} else {
				vfs.uploadFile(parentId, file);
			}
		}
	}

	_createFolder(parentId) {
		const siblingNames = new Set(vfs.listFolder(parentId).map((n) => n.name));
		let name = "New folder";
		let i = 2;
		while (siblingNames.has(name)) name = `New folder ${i++}`;
		// vfs.createFolder() synchronously triggers our own "change" listener,
		// so render() has already drawn this folder's row by the time it returns.
		const folder = vfs.createFolder(parentId, name);
		const li = this._tree.querySelector(`li[data-id="${folder.id}"]`);
		if (li) this._startRename(li.querySelector(".node-row"), folder);
	}

	render() {
		this._tree.innerHTML = "";
		this._tree.appendChild(this._renderChildren(ROOT_ID));
		this._emptyHint.style.display = this._visibleChildren(ROOT_ID).length === 0 ? "" : "none";
		// Prune any selected id that no longer exists (e.g. it was just
		// deleted, or moved away as part of the very change that triggered
		// this render) before re-painting the highlight.
		[...this._selectedIds].forEach((id) => {
			if (!vfs.getNode(id)) this._selectedIds.delete(id);
		});
		this._updateSelectionHighlight();
	}

	// workstation-state.json lives at the project root like any other VFS
	// file (so exportProjectAsZip's normal walk picks it up for free — see
	// workstation-state.js) but per Hans users shouldn't see or touch it
	// here: it's Workstation's own editor state, not project content.
	_visibleChildren(folderId) {
		return vfs.listFolder(folderId).filter((n) => !(folderId === ROOT_ID && n.name === STATE_FILE_NAME));
	}

	// Same ordering _renderChildren lays rows out in (folders first, then
	// alphabetical within each type) — shared so a Shift-click range
	// (_flattenVisibleIds) walks ids in exactly the order they're visually
	// stacked.
	_sortedChildren(folderId) {
		return [...this._visibleChildren(folderId)].sort((a, b) =>
			a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
		);
	}

	_renderChildren(folderId) {
		const fragment = document.createDocumentFragment();
		this._sortedChildren(folderId).forEach((node) => {
			fragment.appendChild(node.type === "folder" ? this._renderFolderNode(node) : this._renderFileNode(node));
		});
		return fragment;
	}

	// Depth-first, visibility-respecting (collapsed folders' children are
	// skipped) flat id order — the same order rows actually render in, used
	// by a Shift-click to select every row between the anchor and the
	// clicked one, same convention as wa-xml-tree.js's own _flatten.
	_flattenVisibleIds(folderId = ROOT_ID, out = []) {
		this._sortedChildren(folderId).forEach((node) => {
			out.push(node.id);
			if (node.type === "folder" && !this._collapsedIds.has(node.id)) this._flattenVisibleIds(node.id, out);
		});
		return out;
	}

	_renderFolderNode(node) {
		const li = document.createElement("li");
		li.className = "folder";
		li.dataset.id = node.id;

		const hasChildren = vfs.listFolder(node.id).length > 0;
		const isCollapsed = this._collapsedIds.has(node.id);

		const row = document.createElement("div");
		row.className = "node-row";
		row.innerHTML = `
			${hasChildren ? `<button class="disclosure" type="button" title="Expand/collapse">${isCollapsed ? "▸" : "▾"}</button>` : `<span class="disclosure-spacer"></span>`}
			<span class="icon">\u{1F4C1}</span>
			<span class="name"></span>
			<span class="actions">
				<button class="act-add" type="button" title="Add files here">+</button>
				<button class="act-rename" type="button" title="Rename">✎</button>
				<button class="act-delete" type="button" title="Delete">✕</button>
			</span>
			<span class="confirm-delete">
				Delete?
				<button class="confirm-yes" type="button">Yes</button>
				<button class="confirm-no" type="button">No</button>
			</span>
		`;
		row.querySelector(".name").textContent = node.name;

		if (hasChildren) {
			row.querySelector(".disclosure").addEventListener("click", (e) => {
				e.stopPropagation();
				if (isCollapsed) this._collapsedIds.delete(node.id);
				else this._collapsedIds.add(node.id);
				this.render();
			});
		}

		row.querySelector(".act-add").addEventListener("click", (e) => {
			e.stopPropagation();
			this._promptUploadInto(node.id);
		});
		row.addEventListener("click", (e) => this._handleRowClick(e, node));
		this._wireRename(row, node);
		this._wireDelete(row, node);
		this._wireDragSource(row, node);
		this._wireDropTarget(row, node);

		const childList = document.createElement("ul");
		childList.className = "tree";
		if (!isCollapsed) childList.appendChild(this._renderChildren(node.id));

		li.appendChild(row);
		li.appendChild(childList);
		return li;
	}

	_renderFileNode(node) {
		const li = document.createElement("li");
		li.className = "file";
		li.dataset.id = node.id;

		const row = document.createElement("div");
		row.className = "node-row";
		row.innerHTML = `
			<span class="disclosure-spacer"></span>
			<span class="icon">\u{1F3B5}</span>
			<span class="name"></span>
			<span class="actions">
				<button class="act-rename" type="button" title="Rename">✎</button>
				<button class="act-delete" type="button" title="Delete">✕</button>
			</span>
			<span class="confirm-delete">
				Delete?
				<button class="confirm-yes" type="button">Yes</button>
				<button class="confirm-no" type="button">No</button>
			</span>
		`;
		row.querySelector(".name").textContent = node.name;
		row.addEventListener("click", (e) => this._handleRowClick(e, node));

		this._wireDragSource(row, node);
		this._wireRename(row, node);
		this._wireDelete(row, node);

		li.appendChild(row);
		return li;
	}

	// Double-clicking the name, or clicking the pencil icon, swaps the name
	// span for an inline text input — no native prompt() dialog.
	_wireRename(row, node) {
		const nameEl = row.querySelector(".name");
		const start = (e) => {
			e.stopPropagation();
			this._startRename(row, node);
		};
		nameEl.addEventListener("dblclick", start);
		row.querySelector(".act-rename").addEventListener("click", start);
	}

	_startRename(row, node) {
		const nameEl = row.querySelector(".name");
		const input = document.createElement("input");
		input.type = "text";
		input.className = "name-edit";
		input.value = node.name;
		nameEl.replaceWith(input);
		input.focus();
		input.select();

		let done = false;
		const commit = () => {
			if (done) return;
			done = true;
			const newName = input.value.trim();
			if (newName && newName !== node.name) vfs.rename(node.id, newName);
			else this.render();
		};
		input.addEventListener("click", (e) => e.stopPropagation());
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				done = true;
				this.render();
			}
		});
		input.addEventListener("blur", commit);
	}

	// Clicking the ✕ swaps the row's action icons for an inline "Delete? Yes/No"
	// confirmation — no native confirm() dialog.
	_wireDelete(row, node) {
		row.querySelector(".act-delete").addEventListener("click", (e) => {
			e.stopPropagation();
			row.classList.add("confirming");
		});
		row.querySelector(".confirm-no").addEventListener("click", (e) => {
			e.stopPropagation();
			row.classList.remove("confirming");
		});
		row.querySelector(".confirm-yes").addEventListener("click", (e) => {
			e.stopPropagation();
			if (selection.id === node.id) selection.select(null);
			vfs.delete(node.id);
		});
	}

	// Both files and folders can be dragged to reorganize the tree (dropped
	// onto a folder row, or onto empty space / a file to land at the top
	// level — see _onDrop). The same custom type already used to drag a file
	// out onto the XML editor (wa-xml-tree.js) carries the id(s) here too —
	// that drop handler already ignores anything that isn't a `file` node,
	// so reusing it for folder drags is safe.
	//
	// Dragging a row that's part of the current multi-selection carries the
	// *whole* selection (per Hans, 2026-09-15: "Om man drar flera filer till
	// en mapp ska alla flyttas") — dragging a row that ISN'T selected first
	// collapses the selection down to just that row, same as a real file
	// picker (dragging an unselected item drags only it, not whatever else
	// happened to be selected before).
	_wireDragSource(row, node) {
		row.draggable = true;
		row.addEventListener("dragstart", (e) => {
			e.stopPropagation();
			if (!this._selectedIds.has(node.id)) {
				this._selectedIds = new Set([node.id]);
				this._selectionAnchorId = node.id;
				this._updateSelectionHighlight();
				this._setActiveSelection(node.id);
			}
			const draggedNodes = [...this._selectedIds].map((id) => vfs.getNode(id)).filter(Boolean);
			// Folders can only be moved within the file manager — unlike a
			// file, they can't be dropped onto the XML editor to set a src
			// attribute (wa-xml-tree.js's own drop handler already ignores
			// non-file nodes), so only offer "copy" when at least one actual
			// file is part of the drag. This makes the browser show an honest
			// "not allowed" cursor over the XML editor while dragging only
			// folders, instead of a misleading "allowed" one.
			e.dataTransfer.effectAllowed = draggedNodes.some((n) => n.type === "file") ? "copyMove" : "move";
			e.dataTransfer.setData(VFS_FILE_DRAG_TYPE, JSON.stringify(draggedNodes.map((n) => n.id)));
			const fileIds = draggedNodes.filter((n) => n.type === "file").map((n) => n.id);
			vfsDragState.fileIds = fileIds;
			vfsDragState.fileId = fileIds[0] || null;
		});
		row.addEventListener("dragend", () => {
			vfsDragState.fileId = null;
			vfsDragState.fileIds = [];
		});
	}

	// Only folder rows are drop targets (you can't drop something "into" a
	// file). stopPropagation on both dragover and drop keeps this from also
	// being treated as a "move to top level" drop by the host's own handler.
	_wireDropTarget(row, node) {
		row.addEventListener("dragover", (e) => {
			if (!e.dataTransfer.types.includes(VFS_FILE_DRAG_TYPE)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			row.classList.add("drop-target");
		});
		row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
		row.addEventListener("drop", (e) => {
			if (!e.dataTransfer.types.includes(VFS_FILE_DRAG_TYPE)) return;
			e.preventDefault();
			e.stopPropagation();
			row.classList.remove("drop-target");
			getDraggedFileIds(e.dataTransfer).forEach((id) => this._moveNode(id, node.id));
		});
	}

	_moveNode(draggedId, targetFolderId) {
		if (!draggedId || draggedId === targetFolderId) return;
		const draggedNode = vfs.getNode(draggedId);
		if (!draggedNode || draggedNode.parentId === targetFolderId) return;

		// A folder can't be dropped into itself or one of its own
		// descendants — getPath(targetFolderId) is the target's own ancestor
		// chain (itself included), so if the dragged node shows up in it,
		// the target is inside (or is) the thing being dragged.
		const targetPath = vfs.getPath(targetFolderId);
		if (targetPath.some((n) => n.id === draggedId)) return;

		vfs.moveFile(draggedId, targetFolderId);
	}

	_promptUploadInto(folderId) {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = ACCEPTED;
		input.addEventListener("change", (e) => this._handleFiles(e.target.files, folderId));
		input.click();
	}

	// Finder/Explorer-style click handling for both file and folder rows —
	// plain click selects just this row (and sets it as the anchor for a
	// later Shift-click); Cmd/Ctrl-click toggles it in/out of the selection;
	// Shift-click selects the *visible* range from the last plain-clicked
	// anchor to this row (_flattenVisibleIds already respects collapsed
	// folders, matching render order). Mirrors wa-xml-tree.js's own
	// _handleRowClick. Per Hans (2026-09-15): "Det ska gå att multi-markera
	// flera filer (som i en vanlig filväljare)."
	_handleRowClick(e, node) {
		if (e.shiftKey && this._selectionAnchorId) {
			const orderedIds = this._flattenVisibleIds();
			const anchorIndex = orderedIds.indexOf(this._selectionAnchorId);
			const clickedIndex = orderedIds.indexOf(node.id);
			if (anchorIndex !== -1 && clickedIndex !== -1) {
				const [from, to] = anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
				this._selectedIds = new Set(orderedIds.slice(from, to + 1));
				this._updateSelectionHighlight();
				this._setActiveSelection(node.id);
				return;
			}
		}
		if (e.metaKey || e.ctrlKey) {
			if (this._selectedIds.has(node.id)) this._selectedIds.delete(node.id);
			else this._selectedIds.add(node.id);
			this._selectionAnchorId = node.id;
			this._updateSelectionHighlight();
			this._setActiveSelection(node.id);
			return;
		}
		this._selectedIds = new Set([node.id]);
		this._selectionAnchorId = node.id;
		this._updateSelectionHighlight();
		this._setActiveSelection(node.id);
	}

	_clearFileSelection() {
		if (this._selectedIds.size === 0) return;
		this._selectedIds.clear();
		this._selectionAnchorId = null;
		this._updateSelectionHighlight();
		this._setActiveSelection(null);
	}

	// Keeps the shared cross-component `selection` (state/selection.js) in
	// sync with whatever was last clicked here — _isLocalSelectionUpdate
	// stops the resulting "change" event (_onExternalSelectionChange) from
	// immediately collapsing the multi-selection this same click just built.
	_setActiveSelection(id) {
		this._isLocalSelectionUpdate = true;
		selection.select(id);
		this._isLocalSelectionUpdate = false;
	}

	// Reacts to `selection` changing from *outside* this component (e.g.
	// another view driving what's "active") by collapsing to just that one
	// id — a multi-selection only ever exists as something this component
	// itself built via _handleRowClick.
	_onExternalSelectionChange(selectedId) {
		if (this._isLocalSelectionUpdate) return;
		this._selectedIds = selectedId ? new Set([selectedId]) : new Set();
		this._selectionAnchorId = selectedId || null;
		this._updateSelectionHighlight();
	}

	_updateSelectionHighlight() {
		this._tree.querySelectorAll("li.file, li.folder").forEach((li) => {
			li.classList.toggle("selected", this._selectedIds.has(li.dataset.id));
		});
	}
}

customElements.define("wa-file-manager", WaFileManager);
