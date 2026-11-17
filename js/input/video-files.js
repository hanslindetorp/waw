import { vfs, ROOT_ID } from "../vfs/VFS.js";

// Where a video goes in the project, shared by the Video section (a file loaded from the
// computer) and the camera's recorder. A video lives in a folder named "video" (found
// whatever its capitals, made when it is missing); the project's files are kept in memory,
// so a big one is warned about.

export const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;

// From here a video is called large: it is kept in memory, in the project's zip, and every
// copy made of it. A recording stops by itself at the second limit.
export const LARGE_VIDEO_BYTES = 100 * 1048576;
export const MAX_RECORDING_BYTES = 500 * 1048576;

export function formatSize(bytes) {
	return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

// The id of the video folder; made when it is missing.
export function videoFolderId() {
	const found = vfs.listFolder(ROOT_ID).find((n) => n.type === "folder" && n.name.toLowerCase() === "video");
	return found ? found.id : vfs.createFolder(ROOT_ID, "video").id;
}

// A name free in the folder: "name.ext", else "name-2.ext", "name-3.ext", …
function freeName(folderId, name) {
	const taken = new Set(vfs.listFolder(folderId).map((n) => n.name));
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let candidate = name;
	for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}${ext}`;
	return candidate;
}

// Puts a video file in the video folder and returns its node. With `reuse`, a file there
// with the same name and size is taken to be the same one and is returned instead.
export function storeVideo(file, { reuse = false } = {}) {
	const folderId = vfs.listFolder(ROOT_ID).some((n) => n.type === "folder" && n.name.toLowerCase() === "video") ? videoFolderId() : null;
	if (reuse) {
		// Videos loaded before the folder rule (at the top) count too.
		const places = [ROOT_ID, ...(folderId ? [folderId] : [])];
		for (const place of places) {
			const same = vfs.listFolder(place).find((n) => n.type === "file" && n.name === file.name && n.file?.size === file.size);
			if (same) return same;
		}
	}
	const target = folderId ?? videoFolderId();
	return vfs.uploadFile(target, new File([file], freeName(target, file.name), { type: file.type || "video/mp4" }));
}
