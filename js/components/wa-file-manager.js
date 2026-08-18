import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { importZip } from "../vfs/zip-import.js";
import { selection } from "../state/selection.js";
import { VFS_FILE_DRAG_TYPE } from "../vfs/drag-types.js";

const ACCEPTED = ".mp3,.wav,.ogg,.m4a,.xml,.zip";

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
		li.file.selected > .node-row {
			background: #234b73;
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
		<button class="btn-upload" type="button">Upload</button>
		<button class="btn-new-folder" type="button">New folder</button>
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

		vfs.addEventListener("change", () => this.render());
		selection.addEventListener("change", (e) => this._highlightSelection(e.detail.id));

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
		this._emptyHint.style.display = vfs.listFolder(ROOT_ID).length === 0 ? "" : "none";
		this._highlightSelection(selection.id);
	}

	_renderChildren(folderId) {
		const fragment = document.createDocumentFragment();
		const children = [...vfs.listFolder(folderId)].sort((a, b) =>
			a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
		);

		children.forEach((node) => {
			fragment.appendChild(node.type === "folder" ? this._renderFolderNode(node) : this._renderFileNode(node));
		});

		return fragment;
	}

	_renderFolderNode(node) {
		const li = document.createElement("li");
		li.className = "folder";
		li.dataset.id = node.id;

		const row = document.createElement("div");
		row.className = "node-row";
		row.innerHTML = `
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

		row.querySelector(".act-add").addEventListener("click", (e) => {
			e.stopPropagation();
			this._promptUploadInto(node.id);
		});
		this._wireRename(row, node);
		this._wireDelete(row, node);

		const childList = document.createElement("ul");
		childList.className = "tree";
		childList.appendChild(this._renderChildren(node.id));

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
		row.addEventListener("click", () => selection.select(node.id));

		row.draggable = true;
		row.addEventListener("dragstart", (e) => {
			e.dataTransfer.effectAllowed = "copy";
			// Only the custom type — no "text/plain" — so wa-xml-tree can tell this
			// apart from its own internal node-reorder drag (which uses text/plain).
			e.dataTransfer.setData(VFS_FILE_DRAG_TYPE, node.id);
		});

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

	_promptUploadInto(folderId) {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = ACCEPTED;
		input.addEventListener("change", (e) => this._handleFiles(e.target.files, folderId));
		input.click();
	}

	_highlightSelection(selectedId) {
		this._tree.querySelectorAll("li.file").forEach((li) => {
			li.classList.toggle("selected", li.dataset.id === selectedId);
		});
	}
}

customElements.define("wa-file-manager", WaFileManager);
