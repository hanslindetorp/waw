import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { importZip } from "../vfs/zip-import.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { createXmlNode } from "../xml-editor/xml-tree-ops.js";
import { selection } from "../state/selection.js";
import { bindCurrentFile, getCurrentFileId } from "./document-sync.js";

// A "project" = the VFS's files/folders + the XML document currently open in
// xmlStore. The schema (waxml.xsd) is an app-level constant, not project
// data, so none of these touch xmlStore.schema.

const PROJECT_FILE_NAME = "wa.xml";

export function createDefaultProject() {
	vfs.clear();
	xmlStore.resetIdCounters();
	xmlStore.setRoot(createDefaultAudioRoot());
	vfs.createFolder(ROOT_ID, "audio");
	const fileNode = vfs.uploadFile(ROOT_ID, new File([xmlStore.codeValue], PROJECT_FILE_NAME, { type: "application/xml" }));
	bindCurrentFile(fileNode.id, xmlStore.codeValue);
	selection.select(fileNode.id);
}

// The root tag name comes from the active schema (its own root element
// declaration), not a hardcoded string — so renaming the schema's root
// element (Audio -> waxml -> WAXML, so far) doesn't leave the default
// project generating a document the schema itself would reject. "WAXML"
// only survives as a last-resort fallback for the (should-never-happen)
// case where the default schema failed to load.
function createDefaultAudioRoot() {
	const rootTagName = xmlStore.schema?.rootElements?.[0] || "WAXML";
	const node = createXmlNode(rootTagName, null);
	node.attributes = {
		version: "1.0",
		timeUnit: "ms",
		gain: "-3dB",
		controls: "false"
	};
	return node;
}

// Replaces the current project with one loaded from a .zip (files + a wa.xml
// entry point) or a single .xml/.waxml file.
export async function openProjectFromFile(file) {
	vfs.clear();
	xmlStore.resetIdCounters();
	const lower = file.name.toLowerCase();

	if (lower.endsWith(".zip")) {
		await importZip(vfs, ROOT_ID, file);
		const entryPoint = findXmlEntryPoint();
		if (entryPoint) {
			const text = await entryPoint.file.text();
			xmlStore.setCodeValue(text);
			bindCurrentFile(entryPoint.id, text);
			selection.select(entryPoint.id);
		} else {
			xmlStore.setRoot(null);
		}
		return;
	}

	const fileNode = vfs.uploadFile(ROOT_ID, file);
	const text = await file.text();
	xmlStore.setCodeValue(text);
	bindCurrentFile(fileNode.id, text);
	selection.select(fileNode.id);
}

// Breadth-first search for a file literally named wa.xml (case-insensitive),
// falling back to the first .xml/.waxml file found anywhere in the project.
function findXmlEntryPoint() {
	let fallback = null;
	const queue = [ROOT_ID];

	while (queue.length > 0) {
		const folderId = queue.shift();
		for (const node of vfs.listFolder(folderId)) {
			if (node.type === "folder") {
				queue.push(node.id);
				continue;
			}
			const lower = node.name.toLowerCase();
			if (!lower.endsWith(".xml") && !lower.endsWith(".waxml")) continue;
			if (lower === PROJECT_FILE_NAME) return node;
			if (!fallback) fallback = node;
		}
	}

	return fallback;
}

// Bundles every real file in the VFS (spec avsnitt 1.5's "Exportera projekt
// som ZIP"), in the same folder structure, and triggers a browser download.
export async function exportProjectAsZip() {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}

	const zip = new JSZip();
	const addFolder = (folderId, zipFolder) => {
		vfs.listFolder(folderId).forEach((node) => {
			if (node.type === "folder") {
				addFolder(node.id, zipFolder.folder(node.name));
			} else {
				zipFolder.file(node.name, node.file);
			}
		});
	};
	addFolder(ROOT_ID, zip);

	// Every open .xml/.waxml file is already live-synced into the VFS (see
	// document-sync.js) and gets included above via addFolder — writing
	// codeValue again here would be redundant at best, and actively wrong if
	// the currently open document is some other (e.g. <include>d) file, which
	// would overwrite the real wa.xml with the wrong content. Only needed as
	// a fallback when the current document isn't linked to any VFS file at all.
	if (xmlStore.root && !getCurrentFileId()) {
		zip.file(PROJECT_FILE_NAME, xmlStore.codeValue);
	}

	const blob = await zip.generateAsync({ type: "blob" });
	downloadBlob(blob, "waw-project.zip");
}

function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
