// Loads a starter project from templates/ — a folder of loose files (not a
// zip, so Hans can author/edit a template directly on disk) — per Hans
// (2026-09-03). templates/manifest.json (see scripts/build-template-manifest.js)
// is what actually lists them: a browser can't list a plain static server's
// directory contents on its own, so that manifest stands in for it. Each
// key is a template's own folder name, which is also what shows up in the
// File menu.

const MANIFEST_URL = "templates/manifest.json";

const MIME_BY_EXTENSION = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".xml": "text/xml",
	".waxml": "text/xml",
	".json": "application/json"
};

function getExtension(name) {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index).toLowerCase();
}

// { templateName: ["wa.xml", "audio/foo.mp3", ...] } — or {} if the
// manifest is missing/unreachable (e.g. no templates/ folder at all yet),
// so an empty Templates section is the worst case rather than a hard error.
export async function listTemplates() {
	try {
		const res = await fetch(MANIFEST_URL, { cache: "no-store" });
		if (!res.ok) return {};
		return await res.json();
	} catch {
		return {};
	}
}

// Same folder-path-splitting idea as vfs/zip-import.js's ensureFolderPath,
// duplicated in miniature rather than shared — this walks a flat list of
// already-known relative paths fetched over the network, not a JSZip
// archive's own entries, so the two didn't share enough real logic to be
// worth threading a common abstraction through.
function ensureFolderPath(vfs, folderIdByPath, dirPath, rootParentId) {
	if (folderIdByPath.has(dirPath)) return folderIdByPath.get(dirPath);
	const parts = dirPath.split("/");
	let currentPath = "";
	let currentParentId = rootParentId;
	for (const part of parts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		if (folderIdByPath.has(currentPath)) {
			currentParentId = folderIdByPath.get(currentPath);
			continue;
		}
		const folder = vfs.createFolder(currentParentId, part);
		folderIdByPath.set(currentPath, folder.id);
		currentParentId = folder.id;
	}
	return currentParentId;
}

// Fetches every file listed for `templateName` and populates them into the
// VFS under `parentId`, mirroring the template's own folder structure.
// Returns the map of relative path -> uploaded VFS file node, so the caller
// can find its entry-point document (wa.xml) without a second lookup.
export async function importTemplateFiles(vfs, parentId, templateName, relativePaths) {
	const folderIdByPath = new Map([["", parentId]]);
	const nodesByPath = new Map();

	for (const relPath of relativePaths) {
		const res = await fetch(`templates/${templateName}/${relPath}`, { cache: "no-store" });
		if (!res.ok) continue;
		const blob = await res.blob();
		const dirPath = relPath.includes("/") ? relPath.split("/").slice(0, -1).join("/") : "";
		const fileName = relPath.split("/").pop();
		const targetFolderId = ensureFolderPath(vfs, folderIdByPath, dirPath, parentId);
		const file = new File([blob], fileName, { type: MIME_BY_EXTENSION[getExtension(fileName)] || blob.type });
		nodesByPath.set(relPath, vfs.uploadFile(targetFolderId, file));
	}

	return nodesByPath;
}
