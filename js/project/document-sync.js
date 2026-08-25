import { vfs } from "../vfs/VFS.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { selection } from "../state/selection.js";

// Keeps exactly one VFS file "checked out" as the document currently open in
// xmlStore (the XML editor / XML code panels): selecting a different
// .xml/.waxml file in the File Manager switches the editors to it, and every
// edit gets written straight back into that file's VFS content. This is what
// lets a WAXML document's <include>d files be opened and edited the same way
// as the main wa.xml — whichever one was most recently selected is "live".

const XML_EXTENSIONS = [".xml", ".waxml"];
const SYNC_DEBOUNCE_MS = 400;

let currentFileId = null;
let lastSyncedValue = null;
let syncTimer = null;

export function getCurrentFileId() {
	return currentFileId;
}

// Points live-sync at a VFS file whose content is already known to match
// xmlStore's current document (e.g. right after project-manager just wrote
// it) — no re-read/re-parse needed.
export function bindCurrentFile(fileId, value) {
	currentFileId = fileId;
	lastSyncedValue = value;
}

function isXmlFile(node) {
	const lower = node.name.toLowerCase();
	return XML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Writes any not-yet-synced edits for the currently linked file immediately
// (skipping the debounce) — called right before switching to a different
// file, so a fast file-switch mid-edit can't drop or misdirect the tail end
// of what was just typed.
function flushPendingSync() {
	if (!syncTimer) return;
	clearTimeout(syncTimer);
	syncTimer = null;
	if (!currentFileId || xmlStore.codeValue === lastSyncedValue) return;
	const node = vfs.getNode(currentFileId);
	if (!node || node.type !== "file") return;
	lastSyncedValue = xmlStore.codeValue;
	vfs.updateFileContent(currentFileId, lastSyncedValue);
}

async function openFileForEditing(fileNode) {
	flushPendingSync();
	const text = await fileNode.file.text();
	// The selection may have moved on again while we were awaiting the read.
	if (selection.id !== fileNode.id) return;
	currentFileId = fileNode.id;
	lastSyncedValue = text;
	xmlStore.setCodeValue(text);
}

selection.addEventListener("change", (e) => {
	const id = e.detail.id;
	if (!id || id === currentFileId) return;
	const node = vfs.getNode(id);
	if (!node || node.type !== "file" || !isXmlFile(node)) return;
	openFileForEditing(node);
});

xmlStore.addEventListener("change", () => {
	if (!currentFileId || xmlStore.codeValue === lastSyncedValue) return;
	clearTimeout(syncTimer);
	syncTimer = setTimeout(flushPendingSync, SYNC_DEBOUNCE_MS);
});

// Covers the linked file being deleted (directly, or via an ancestor folder
// delete) — nothing left to sync into, so drop the link.
vfs.addEventListener("change", () => {
	if (currentFileId && !vfs.getNode(currentFileId)) {
		currentFileId = null;
		lastSyncedValue = null;
	}
});

// A File Manager move or rename changes a file's export path (VFS.getExportPath
// is derived from its current name + folder ancestry) — keep every <Tag
// src="..."> (or source="...") in the open document pointing at the right
// file when that happens, rather than silently going stale.
vfs.addEventListener("path-change", (e) => {
	e.detail.changes.forEach(({ oldPath, newPath }) => {
		xmlStore.renameSrcReferences(oldPath, newPath);
	});
});
