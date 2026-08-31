// In-memory VFS for Steg 0. Same method signatures as the future PHP API
// (see docs/WAXML-Workstation-spec.md, avsnitt 1.3) so only the
// implementation needs to change in Steg 1, not the GUI calling it.

export const ROOT_ID = "root";

let idCounter = 1;
function nextId() {
	return `n${idCounter++}`;
}

export class VFS extends EventTarget {
	constructor() {
		super();
		this._nodes = new Map();
		this._nodes.set(ROOT_ID, {
			id: ROOT_ID,
			type: "folder",
			name: "",
			parentId: null,
			children: []
		});
	}

	listFolder(id = ROOT_ID) {
		const folder = this._requireType(id, "folder");
		return folder.children.map((childId) => this._nodes.get(childId));
	}

	createFolder(parentId = ROOT_ID, name) {
		const parent = this._requireType(parentId, "folder");
		const node = { id: nextId(), type: "folder", name, parentId, children: [] };
		this._nodes.set(node.id, node);
		parent.children.push(node.id);
		this._emitChange();
		return node;
	}

	uploadFile(parentId = ROOT_ID, file) {
		const parent = this._requireType(parentId, "folder");
		const node = {
			id: nextId(),
			type: "file",
			name: file.name,
			parentId,
			file,
			sessionUrl: URL.createObjectURL(file)
		};
		this._nodes.set(node.id, node);
		parent.children.push(node.id);
		this._emitChange();
		return node;
	}

	// Replaces a file's content in place (same id, same name) — used to keep a
	// VFS file live-synced with a document being edited elsewhere (xmlStore).
	updateFileContent(id, content) {
		const node = this._requireType(id, "file");
		if (node.sessionUrl) URL.revokeObjectURL(node.sessionUrl);
		node.file = new File([content], node.name, { type: node.file.type || "application/xml" });
		node.sessionUrl = URL.createObjectURL(node.file);
		this._emitChange();
		return node;
	}

	rename(id, newName) {
		const node = this._requireNode(id);
		const fileIds = this._collectFileIds(id);
		const oldPaths = new Map(fileIds.map((fid) => [fid, this.getExportPath(fid)]));
		node.name = newName;
		this._emitPathChanges(fileIds, oldPaths);
		this._emitChange();
		return node;
	}

	delete(id) {
		const node = this._requireNode(id);

		if (node.type === "folder") {
			[...node.children].forEach((childId) => this.delete(childId));
		} else if (node.sessionUrl) {
			URL.revokeObjectURL(node.sessionUrl);
		}

		const parent = this._nodes.get(node.parentId);
		if (parent) {
			parent.children = parent.children.filter((childId) => childId !== id);
		}
		this._nodes.delete(id);
		this._emitChange();
	}

	moveFile(id, newParentId) {
		const node = this._requireNode(id);
		const newParent = this._requireType(newParentId, "folder");
		const oldParent = this._nodes.get(node.parentId);
		const fileIds = this._collectFileIds(id);
		const oldPaths = new Map(fileIds.map((fid) => [fid, this.getExportPath(fid)]));

		if (oldParent) {
			oldParent.children = oldParent.children.filter((childId) => childId !== id);
		}
		newParent.children.push(id);
		node.parentId = newParentId;

		this._emitPathChanges(fileIds, oldPaths);
		this._emitChange();
		return node;
	}

	getNode(id) {
		return this._nodes.get(id) || null;
	}

	// Removes every file/folder (used when starting or opening a project).
	clear() {
		[...this.listFolder(ROOT_ID)].forEach((node) => this.delete(node.id));
	}

	// A deep-enough snapshot for edit-history.js's undo/redo: every mutator
	// above (rename, delete, moveFile, ...) edits node objects and their
	// `children` arrays in place, so simply keeping a reference to `_nodes`
	// would let *later* mutations silently corrupt an "old" snapshot. `file`
	// itself (a Blob) is immutable and fine to share by reference;
	// `sessionUrl` is deliberately dropped here — see restore().
	snapshot() {
		const nodes = new Map();
		for (const [id, node] of this._nodes) {
			nodes.set(
				id,
				node.type === "folder"
					? { id: node.id, type: "folder", name: node.name, parentId: node.parentId, children: [...node.children] }
					: { id: node.id, type: "file", name: node.name, parentId: node.parentId, file: node.file }
			);
		}
		return nodes;
	}

	// Wholesale-replaces _nodes with a clone of a snapshot from snapshot()
	// above. Every currently-live file's blob: URL is revoked first (an old
	// snapshot's file might currently be deleted, meaning nothing else still
	// holds a reference to revoke it later) and every file node in the
	// restored snapshot gets a *freshly minted* sessionUrl — never trust a
	// blob: URL string carried inside a snapshot itself, since the same file
	// id's URL may have already been revoked and re-minted any number of
	// times since that snapshot was taken.
	restore(snapshotNodes) {
		for (const node of this._nodes.values()) {
			if (node.type === "file" && node.sessionUrl) URL.revokeObjectURL(node.sessionUrl);
		}
		const nodes = new Map();
		for (const [id, node] of snapshotNodes) {
			nodes.set(
				id,
				node.type === "folder"
					? { id: node.id, type: "folder", name: node.name, parentId: node.parentId, children: [...node.children] }
					: { id: node.id, type: "file", name: node.name, parentId: node.parentId, file: node.file, sessionUrl: URL.createObjectURL(node.file) }
			);
		}
		this._nodes = nodes;
		this._emitChange();
	}

	// Ordered list of ancestor nodes from (excluding) root down to id.
	getPath(id) {
		const parts = [];
		let node = this._requireNode(id);
		while (node && node.id !== ROOT_ID) {
			parts.unshift(node);
			node = this._nodes.get(node.parentId);
		}
		return parts;
	}

	// Relative path matching how WAXML resolves paths from wa.xml's location
	// (spec avsnitt 1.5), e.g. "drums/kick.wav".
	getExportPath(id) {
		return this.getPath(id).map((node) => node.name).join("/");
	}

	// Reverse of getExportPath(): given the string that ends up in an XML
	// src/source attribute, find the matching file node so its sessionUrl
	// (blob:) can be used for live playback. Returns null if nothing matches
	// (e.g. the path was hand-typed and doesn't correspond to an uploaded file).
	findByExportPath(exportPath) {
		if (!exportPath) return null;
		for (const node of this._nodes.values()) {
			if (node.type === "file" && this.getExportPath(node.id) === exportPath) {
				return node;
			}
		}
		return null;
	}

	// Every file under `id` (id itself, if it's already a file) — a move or
	// rename on a folder shifts the export path of every file inside it too,
	// not just the folder's own name/position.
	_collectFileIds(id, out = []) {
		const node = this._nodes.get(id);
		if (!node) return out;
		if (node.type === "file") {
			out.push(id);
		} else {
			node.children.forEach((childId) => this._collectFileIds(childId, out));
		}
		return out;
	}

	// Fires once, after a move/rename, with every file whose export path
	// actually changed as a result — a rename/move of a folder can affect
	// many files at once, and some might coincidentally keep the same path
	// (e.g. renaming a folder to its own current name).
	_emitPathChanges(fileIds, oldPaths) {
		const changes = fileIds
			.map((fid) => ({ oldPath: oldPaths.get(fid), newPath: this.getExportPath(fid) }))
			.filter((c) => c.oldPath !== c.newPath);
		if (changes.length > 0) {
			this.dispatchEvent(new CustomEvent("path-change", { detail: { changes } }));
		}
	}

	_requireType(id, type) {
		const node = this._requireNode(id);
		if (node.type !== type) {
			throw new Error(`VFS: node "${id}" is not a ${type}`);
		}
		return node;
	}

	_requireNode(id) {
		const node = this._nodes.get(id);
		if (!node) {
			throw new Error(`VFS: no node with id "${id}"`);
		}
		return node;
	}

	_emitChange() {
		this.dispatchEvent(new CustomEvent("change"));
	}
}

// Single shared instance for the Steg 0 demo session (no multi-project support yet).
export const vfs = new VFS();
