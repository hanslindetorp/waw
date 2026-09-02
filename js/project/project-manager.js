import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { importZip } from "../vfs/zip-import.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { createXmlNode } from "../xml-editor/xml-tree-ops.js";
import { selection } from "../state/selection.js";
import { bindCurrentFile, getCurrentFileId } from "./document-sync.js";
import { initWorkstationState, flushWorkstationState } from "./workstation-state.js";
import { resetEditHistory } from "./edit-history.js";
import { listTemplates, importTemplateFiles } from "./template-loader.js";

// A "project" = the VFS's files/folders + the XML document currently open in
// xmlStore. The schema (waxml.xsd) is an app-level constant, not project
// data, so none of these touch xmlStore.schema.

const PROJECT_FILE_NAME = "wa.xml";

// The file "Save" (as opposed to "Save As...") writes back to, once one
// exists — either handed to us by Open (see openProjectFromFile) or set by
// a prior Save As (see saveProjectAs). null means there's nowhere to save
// back to yet, so Save falls back to Save As's own prompt. Deliberately
// module-level rather than something a UI component owns, same reasoning as
// document-sync.js's own currentFileId: "where the project last came from
// or went to" is project state, not view state.
let savedFileHandle = null;

export function createDefaultProject() {
	vfs.clear();
	xmlStore.resetIdCounters();
	xmlStore.setRoot(createDefaultAudioRoot());
	vfs.createFolder(ROOT_ID, "audio");
	const fileNode = vfs.uploadFile(ROOT_ID, new File([xmlStore.codeValue], PROJECT_FILE_NAME, { type: "application/xml" }));
	bindCurrentFile(fileNode.id, xmlStore.codeValue);
	selection.select(fileNode.id);
	initWorkstationState();
	resetEditHistory();
	savedFileHandle = null;
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
// entry point) or a single .xml/.waxml file. `handle`, when given (from the
// File System Access API's showOpenFilePicker — see wa-file-menu.js), is
// remembered so a later plain Save writes straight back to this same file
// instead of falling back to Save As's own prompt; a project opened via the
// classic <input type="file"> picker (no handle available) has to use Save
// As at least once before Save has anywhere to write to.
export async function openProjectFromFile(file, handle = null) {
	vfs.clear();
	xmlStore.resetIdCounters();
	savedFileHandle = handle ? { handle, kind: file.name.toLowerCase().endsWith(".zip") ? "zip" : "xml" } : null;
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
		// After the document (if any) is loaded, so a saved selectedElementId
		// can actually resolve against the real tree — looks for an imported
		// workstation-state.json and applies it, or creates a fresh default
		// one if this zip never had one (e.g. not authored by Workstation).
		initWorkstationState();
		resetEditHistory();
		return;
	}

	const fileNode = vfs.uploadFile(ROOT_ID, file);
	const text = await file.text();
	xmlStore.setCodeValue(text);
	bindCurrentFile(fileNode.id, text);
	selection.select(fileNode.id);
	initWorkstationState();
	resetEditHistory();
}

// Loads one of templates/manifest.json's projects by name (see
// template-loader.js) — same idea as opening a .zip, but fetched from a
// folder of loose files instead of unzipped from one, so Hans can author a
// template directly on disk rather than through a zip. Never remembers a
// save-back handle (loading a template must never let a plain Save
// overwrite the template's own source files under templates/).
export async function loadTemplate(name) {
	const manifest = await listTemplates();
	const relativePaths = manifest[name];
	if (!relativePaths) throw new Error(`Unknown template "${name}"`);

	vfs.clear();
	xmlStore.resetIdCounters();
	savedFileHandle = null;

	const nodesByPath = await importTemplateFiles(vfs, ROOT_ID, name, relativePaths);
	const entryPoint = nodesByPath.get(PROJECT_FILE_NAME) || findXmlEntryPoint();
	if (entryPoint) {
		const text = await entryPoint.file.text();
		xmlStore.setCodeValue(text);
		bindCurrentFile(entryPoint.id, text);
		selection.select(entryPoint.id);
	} else {
		xmlStore.setRoot(null);
	}
	initWorkstationState();
	resetEditHistory();
}

export { listTemplates };

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
// som ZIP"), in the same folder structure — shared by Export, Save, and
// Save As, which all differ only in *where* the resulting blob ends up.
async function buildProjectZipBlob() {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}

	// Guarantees the bundled workstation-state.json reflects the very latest
	// panel/selection state rather than whatever was true up to its own save
	// debounce ago (same reasoning as document-sync.js's flushPendingSync).
	flushWorkstationState();

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

	return zip.generateAsync({ type: "blob" });
}

// Always prompts for a location and never remembers it for later plain
// Saves — a deliberately separate action from Save As (below), which does
// remember it, per Hans (2026-09-03): Export is for handing someone a copy,
// Save/Save As are for your own working file.
export async function exportProjectAsZip() {
	const blob = await buildProjectZipBlob();
	await pickSaveLocation(blob, "waw-project.zip");
}

// The standard "Save": writes back to whatever file the project was last
// opened from or saved to (savedFileHandle), no prompt — falls back to Save
// As if there isn't one yet (a brand-new project, or one opened via the
// classic <input type="file"> picker, which never yields a writable
// handle). Per Hans (2026-09-03).
export async function saveProject() {
	if (!savedFileHandle) return saveProjectAs();
	const { handle, kind } = savedFileHandle;
	const writable = await handle.createWritable();
	if (kind === "zip") {
		await writable.write(await buildProjectZipBlob());
	} else {
		// Opened from a bare .xml/.waxml file (not a zip) — saved back the
		// same way. Writing the whole VFS out as a zip here instead would
		// silently replace what the user actually opened with something
		// they never asked for.
		await writable.write(xmlStore.codeValue);
	}
	await writable.close();
}

// Always prompts for a new location, and remembers it (when the picker
// actually returned a handle — see pickSaveLocation) so later plain Saves
// write straight back there.
export async function saveProjectAs() {
	const blob = await buildProjectZipBlob();
	const handle = await pickSaveLocation(blob, "waw-project.zip");
	if (handle) savedFileHandle = { handle, kind: "zip" };
}

// Chrome/Edge (not Safari/Firefox) can show a real native "Save As" dialog
// via the File System Access API — used when available, per Hans
// (2026-09-03). Returns the resulting handle (so saveProjectAs can remember
// it), or null if the picker isn't available, was cancelled (in which case
// nothing else happens either — cancelling shouldn't fall back to a silent
// download the user didn't ask for), or some other error left it unusable,
// in which case this instead falls back to the classic <a download> trick
// (always saves silently to the browser's own default download location —
// no handle to remember there).
async function pickSaveLocation(blob, filename) {
	if (typeof window.showSaveFilePicker === "function") {
		try {
			const handle = await window.showSaveFilePicker({
				suggestedName: filename,
				types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }]
			});
			const writable = await handle.createWritable();
			await writable.write(blob);
			await writable.close();
			return handle;
		} catch (err) {
			if (err.name === "AbortError") return null; // user cancelled the picker — not a failure
			// Anything else (e.g. a browser that lies about supporting the
			// API): fall through to the classic download below instead.
		}
	}

	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	return null;
}
