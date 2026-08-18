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
		node.name = newName;
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

		if (oldParent) {
			oldParent.children = oldParent.children.filter((childId) => childId !== id);
		}
		newParent.children.push(id);
		node.parentId = newParentId;
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
