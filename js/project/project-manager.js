import { vfs, ROOT_ID, isHiddenName } from "../vfs/VFS.js";
import { importZip, findProjectFolder } from "../vfs/zip-import.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { createXmlNode } from "../xml-editor/xml-tree-ops.js";
import { selection } from "../state/selection.js";
import { bindCurrentFile, getCurrentFileId } from "./document-sync.js";
import { STATE_FILE_NAME, initWorkstationState, flushWorkstationState } from "./workstation-state.js";
import { stageStore } from "./stage-store.js";
import { assessmentStore } from "./assessment-store.js";
import { initInputs, flushInputs } from "./inputs-store.js";
import { resetEditHistory } from "./edit-history.js";
import { listTemplates, fetchTemplateZip } from "./template-loader.js";

// A "project" = the VFS's files/folders + the XML document currently open in
// xmlStore. The schema (waxml.xsd) is an app-level constant, not project
// data, so none of these touch xmlStore.schema.

export const PROJECT_FILE_NAME = "wa.xml";

// The file "Save" (as opposed to "Save As...") writes back to, once one
// exists — either handed to us by Open (see openProjectFromFile) or set by
// a prior Save As (see saveProjectAs). null means there's nowhere to save
// back to yet, so Save falls back to Save As's own prompt. Deliberately
// module-level rather than something a UI component owns, same reasoning as
// document-sync.js's own currentFileId: "where the project last came from
// or went to" is project state, not view state.
let savedFileHandle = null;

// "Is the latest version saved?" — the project as it is now (the files and
// folders with their sizes, and the open document) against how it was when
// it was last opened, created or saved. Only a real difference counts, so
// undoing back to what was saved is clean again, and the editor's own
// layout (workstation-state.json) never makes a project "changed". Used to
// decide whether opening another project has to warn first.
let savedSignature = null;

function projectSignature() {
	const parts = [];
	const walk = (folderId, path) => {
		vfs.listFolder(folderId).forEach((node) => {
			const full = path + node.name;
			if (node.type === "folder") {
				parts.push(`d:${full}`);
				walk(node.id, `${full}/`);
			} else if (!(path === "" && node.name === STATE_FILE_NAME)) {
				parts.push(`f:${full}:${node.file?.size}`);
			}
		});
	};
	walk(ROOT_ID, "");
	return `${parts.sort().join("|")}\n${xmlStore.root ? xmlStore.codeValue : ""}`;
}

// What every way of getting a project in place ends with: the editor layout
// saved with it and the Stage (stage.json) are read from the VFS.
async function initProjectState() {
	await Promise.all([initWorkstationState(), stageStore.init(), assessmentStore.init()]);
	await initInputs();
}

export function markProjectSaved() {
	savedSignature = projectSignature();
}

// A project that has never been saved (a template just opened): changed by
// definition, until the first save.
export function markProjectUnsaved() {
	savedSignature = "";
}

export function isProjectDirty() {
	return savedSignature !== null && projectSignature() !== savedSignature;
}

export function createDefaultProject() {
	vfs.clear();
	xmlStore.resetIdCounters();
	xmlStore.setRoot(createDefaultAudioRoot());
	vfs.createFolder(ROOT_ID, "audio");
	const fileNode = vfs.uploadFile(ROOT_ID, new File([xmlStore.codeValue], PROJECT_FILE_NAME, { type: "application/xml" }));
	bindCurrentFile(fileNode.id, xmlStore.codeValue);
	selection.select(fileNode.id);
	initProjectState();
	resetEditHistory();
	savedFileHandle = null;
	markProjectSaved();
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
		await importProjectZip(file);
		await finishProjectLoad();
		return;
	}

	const fileNode = vfs.uploadFile(ROOT_ID, file);
	const text = await file.text();
	xmlStore.setCodeValue(text);
	bindCurrentFile(fileNode.id, text);
	selection.select(fileNode.id);
	await initProjectState(); // the Stage is read before the undo baseline is taken
	resetEditHistory();
	markProjectSaved();
}

// A .zip that has a WAW json file (workstation-state.json) in it, anywhere,
// is a project: its folder is the top level (so a zip made by compressing a
// project's folder opens the same as one made from inside it). Otherwise the
// archive's structure is mirrored as it is.
async function importProjectZip(file) {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}
	const zip = await JSZip.loadAsync(file);
	const folder = findProjectFolder(Object.keys(zip.files), STATE_FILE_NAME);
	await importZip(vfs, ROOT_ID, file, { zip, stripPrefix: folder || "" });
}

// After the files of a project are in the VFS: opens its main document and
// the editor layout saved with it, or creates a default layout for a project
// that never had one (not authored by Workstation).
async function finishProjectLoad() {
	const entryPoint = findXmlEntryPoint();
	if (entryPoint) {
		const text = await entryPoint.file.text();
		xmlStore.setCodeValue(text);
		bindCurrentFile(entryPoint.id, text);
		selection.select(entryPoint.id);
	} else {
		xmlStore.setRoot(null);
	}
	// After the document (if any) is loaded, so a saved selectedElementId can
	// actually resolve against the real tree.
	await initProjectState(); // the Stage is read before the undo baseline is taken
	resetEditHistory();
	markProjectSaved();
}

// Whether an archive holds a project (see importProjectZip) — what a .zip
// dropped in the File Manager is checked with.
export async function zipHoldsProject(file) {
	if (typeof JSZip === "undefined") return false;
	try {
		const zip = await JSZip.loadAsync(file);
		return findProjectFolder(Object.keys(zip.files), STATE_FILE_NAME) !== null;
	} catch {
		return false;
	}
}

// The folder (among a dropped folder's files, as { path, ... }, paths
// relative to it) a project lives in, or null — see findProjectFolder.
export function findProjectFolderAmong(paths) {
	return findProjectFolder(paths, STATE_FILE_NAME);
}

// Opens a project from loose files (a dropped folder): `files` is
// [{ path, file }] with `path` relative to the project's top folder, so what
// lies outside it has already been left out. Hidden files are skipped.
export async function openProjectFromFiles(files) {
	vfs.clear();
	xmlStore.resetIdCounters();
	savedFileHandle = null;
	const folderIds = new Map([["", ROOT_ID]]);
	const folderFor = (dirPath) => {
		if (folderIds.has(dirPath)) return folderIds.get(dirPath);
		const parts = dirPath.split("/");
		let current = "";
		let parentId = ROOT_ID;
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!folderIds.has(current)) folderIds.set(current, vfs.createFolder(parentId, part).id);
			parentId = folderIds.get(current);
		}
		return parentId;
	};
	for (const { path, file } of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
		const parts = path.split("/");
		if (parts.some(isHiddenName)) continue;
		const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
		if (![".mp3", ".wav", ".ogg", ".m4a", ".xml", ".waxml", ".json"].includes(ext)) continue;
		vfs.uploadFile(folderFor(parts.slice(0, -1).join("/")), file);
	}
	await finishProjectLoad();
}

// Opens one of the zips in templates/ (see template-loader.js) as a new,
// unsaved project: it is not tied to any file (a plain Save asks where to
// save, so the template's own zip can never be overwritten) and counts as
// having unsaved changes, so leaving it warns until it has been saved.
// Per Hans (2026-10-12).
export async function loadTemplate(fileName) {
	const file = await fetchTemplateZip(fileName);
	vfs.clear();
	xmlStore.resetIdCounters();
	savedFileHandle = null;
	await importProjectZip(file);
	await finishProjectLoad();
	markProjectUnsaved();
}

export { listTemplates };

// Breadth-first search for a file literally named wa.xml (case-insensitive),
// falling back to the first .xml/.waxml file found anywhere in the project.
// Exported for wa-api-view.js's own use — the Share dialog's HTML code
// example shows this file's *name* (see getMainDocumentName below), live so
// it stays right after a rename or after a differently-named XML file is
// imported as the project's entry point.
export function findXmlEntryPoint() {
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

// The name to show in the Share dialog's <script data-source="..."> example
// (see wa-api-view.js) — just findXmlEntryPoint()'s own name, or the default
// PROJECT_FILE_NAME before any document exists yet (a doc-less blank state,
// e.g. right after vfs.clear() and before createDefaultProject finishes).
export function getMainDocumentName() {
	return findXmlEntryPoint()?.name || PROJECT_FILE_NAME;
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
	stageStore.flush();
	assessmentStore.flush();
	flushInputs();

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

// Bundles the project for handing to a web developer to embed (the "Share..."
// dialog's "Export..." button — see wa-api-view.js) — every real file in the
// VFS *except* workstation-state.json (Workstation's own editor state, never
// meant to end up on a live site — see workstation-state.js's own
// top-of-file comment) plus the actual waxml.js this session is running,
// fetched fresh so the exported copy always matches whatever version is
// currently deployed. Deliberately separate from buildProjectZipBlob (Save/
// Save As use that one) — those need workstation-state.json for a later
// reopen in Workstation itself, and never need waxml.js alongside it. Per
// Hans (2026-09-18).
async function buildWebExportZipBlob() {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}

	const zip = new JSZip();
	const addFolder = (folderId, zipFolder) => {
		vfs.listFolder(folderId).forEach((node) => {
			if (node.type === "folder") {
				addFolder(node.id, zipFolder.folder(node.name));
			} else if (node.name !== STATE_FILE_NAME) {
				zipFolder.file(node.name, node.file);
			}
		});
	};
	addFolder(ROOT_ID, zip);

	if (xmlStore.root && !getCurrentFileId()) {
		zip.file(PROJECT_FILE_NAME, xmlStore.codeValue);
	}

	const waxmlSource = await fetch("waxml.js").then((res) => res.text());
	zip.file("waxml.js", waxmlSource);

	return zip.generateAsync({ type: "blob" });
}

// Always prompts for a location and never remembers it for later plain
// Saves — a deliberately separate action from Save As (below), which does
// remember it, per Hans (2026-09-03): Export is for handing someone a copy,
// Save/Save As are for your own working file.
export async function exportProjectAsZip() {
	const blob = await buildWebExportZipBlob();
	await pickSaveLocation(blob, "waw-export.zip");
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
	markProjectSaved();
}

// Always prompts for a new location, and remembers it (when the picker
// actually returned a handle — see pickSaveLocation) so later plain Saves
// write straight back there.
export async function saveProjectAs() {
	const blob = await buildProjectZipBlob();
	const handle = await pickSaveLocation(blob, "waw-project.zip");
	if (handle === false) return; // cancelled — nothing was saved
	if (handle) savedFileHandle = { handle, kind: "zip" };
	// A download (no handle) counts as saved too — the file has been written
	// out; "Export" never does, since that one is for handing a copy away.
	markProjectSaved();
}

// Chrome/Edge (not Safari/Firefox) can show a real native "Save As" dialog
// via the File System Access API — used when available, per Hans
// (2026-09-03). Returns the resulting handle (so saveProjectAs can remember
// it); false if the picker was cancelled (nothing else happens either —
// cancelling shouldn't fall back to a silent download the user didn't ask
// for); or null if the picker isn't available or some other error left it unusable,
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
			if (err.name === "AbortError") return false; // user cancelled the picker — not a failure, and nothing was saved
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
