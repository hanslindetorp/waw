import { isHiddenName } from "./VFS.js";

// Unpacks a .zip client-side (JSZip, loaded via CDN in index.html) into the
// VFS, mirroring the archive's folder structure 1:1 (see docs/WAXML-Workstation-spec.md,
// avsnitt 10 — "spegla mappstruktur 1:1" chosen over flattening).

// .json is here for workstation-state.json (see workstation-state.js) —
// Workstation's own editor-state companion file, not a WAXML content type.
const SUPPORTED_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a", ".xml", ".waxml", ".json"];

const MIME_BY_EXTENSION = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".xml": "text/xml",
	".waxml": "text/xml",
	".json": "application/json"
};

// The folder (a path inside the archive, "" for its top) a project lives in,
// found by where its `markerName` file (workstation-state.json) is — the
// shallowest one — or null when the archive holds no such file. A hidden file
// or folder never counts. Per Hans (2026-10-12): an archive or folder with a
// WAW json inside is a project, to be opened as one.
export function findProjectFolder(names, markerName) {
	let best = null;
	for (const raw of names) {
		const path = raw.replace(/\/+$/, "");
		const parts = path.split("/");
		if (parts[parts.length - 1] !== markerName || parts.some(isHiddenName)) continue;
		const dir = parts.slice(0, -1).join("/");
		if (best === null || dir.split("/").filter(Boolean).length < best.split("/").filter(Boolean).length) best = dir;
	}
	return best;
}

// `options.stripPrefix`: the archive's folder to treat as the top level (see
// findProjectFolder) — whatever lies outside it is left out. `options.zip`: an
// archive already loaded by JSZip.loadAsync.
export async function importZip(vfs, parentId, zipFile, options = {}) {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}

	const zip = options.zip || (await JSZip.loadAsync(zipFile));
	const prefix = options.stripPrefix ? options.stripPrefix.replace(/\/+$/, "") + "/" : "";
	const folderIdByPath = new Map([["", parentId]]);
	const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if (prefix && !entry.name.startsWith(prefix)) continue;
		const relPath = entry.name.slice(prefix.length).replace(/\/+$/, "");
		if (!relPath || relPath.split("/").some(isHiddenName)) continue;

		if (entry.dir) {
			ensureFolderPath(vfs, folderIdByPath, relPath, parentId);
			continue;
		}

		const extension = getExtension(relPath);
		if (!SUPPORTED_EXTENSIONS.includes(extension)) continue;

		const dirPath = relPath.split("/").slice(0, -1).join("/");
		const targetFolderId = ensureFolderPath(vfs, folderIdByPath, dirPath, parentId);
		const fileName = relPath.split("/").pop();
		const blob = await entry.async("blob");
		const file = new File([blob], fileName, { type: MIME_BY_EXTENSION[extension] });
		vfs.uploadFile(targetFolderId, file);
	}
}

function ensureFolderPath(vfs, folderIdByPath, path, rootParentId) {
	if (folderIdByPath.has(path)) return folderIdByPath.get(path);

	const parts = path.split("/");
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

function getExtension(name) {
	const index = name.lastIndexOf(".");
	return index === -1 ? "" : name.slice(index).toLowerCase();
}
