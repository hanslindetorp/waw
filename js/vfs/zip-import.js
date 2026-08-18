// Unpacks a .zip client-side (JSZip, loaded via CDN in index.html) into the
// VFS, mirroring the archive's folder structure 1:1 (see docs/WAXML-Workstation-spec.md,
// avsnitt 10 — "spegla mappstruktur 1:1" chosen over flattening).

const SUPPORTED_EXTENSIONS = [".mp3", ".wav", ".ogg", ".m4a", ".xml", ".waxml"];

const MIME_BY_EXTENSION = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".xml": "text/xml",
	".waxml": "text/xml"
};

export async function importZip(vfs, parentId, zipFile) {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded (check the <script> tag in index.html).");
	}

	const zip = await JSZip.loadAsync(zipFile);
	const folderIdByPath = new Map([["", parentId]]);
	const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const relPath = entry.name.replace(/\/+$/, "");

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
