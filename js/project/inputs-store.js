import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { inputSources } from "../state/input-sources.js";

// The rows of the live inputs (the camera's points and what they measure and
// drive) as project content: inputs.json at the project root, next to
// wa.xml and stage.json. They used to be saved in workstation-state.json,
// which is editor layout — but a viewer page needs them to run the project's
// inputs, and they are part of what a project is (and of "unsaved changes").
// The camera choice and whether it was running stay in workstation-state.json
// (they are about this machine, not the project).
//
//   { "version": 1, "webcam": { "entries": [ ...rows, see wa-webcam-input.js getEntries() ] } }
//
// The file only comes to exist once there is a row to save. A project whose
// rows are still in workstation-state.json (saved before this file existed)
// is read from there (see the webcam element's applyState) and gets its
// inputs.json the next time a row changes.

export const INPUTS_FILE_NAME = "inputs.json";

const SAVE_DEBOUNCE_MS = 400;

let fileId = null;
let saveTimer = null;
let lastJson = null; // what the file holds / would hold — only a real change is written
let wiredElement = null;

function currentJson() {
	const webcam = inputSources.get("webcam");
	return JSON.stringify({ version: 1, webcam: { entries: webcam ? webcam.getEntries() : [] } }, null, 2);
}

function hasRows() {
	return (inputSources.get("webcam")?.getEntries().length ?? 0) > 0;
}

function scheduleSave() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

function saveNow() {
	clearTimeout(saveTimer);
	saveTimer = null;
	const json = currentJson();
	if (json === lastJson) return;
	if (!fileId && !hasRows()) return;
	lastJson = json;
	if (fileId && vfs.getNode(fileId)) {
		vfs.updateFileContent(fileId, json, { silent: true });
	} else {
		fileId = vfs.uploadFile(ROOT_ID, new File([json], INPUTS_FILE_NAME, { type: "application/json" })).id;
	}
}

// Writes any pending change now (before a zip is exported).
export function flushInputs() {
	if (saveTimer) saveNow();
}

// Follows the camera element's changes. Called whenever an input source
// registers (it may come and go), and safe to call again.
function wire() {
	const webcam = inputSources.get("webcam");
	if (webcam === wiredElement) return;
	wiredElement?.removeEventListener("state-change", scheduleSave);
	wiredElement = webcam;
	wiredElement?.addEventListener("state-change", scheduleSave);
}
inputSources.addEventListener("change", wire);

// Once a project's files are in place: reads inputs.json (if any) into the
// inputs. Resolves when they are in, so what follows (the unsaved-changes
// baseline) sees them.
export async function initInputs() {
	clearTimeout(saveTimer);
	saveTimer = null;
	fileId = null;
	lastJson = null;
	wire();
	const webcam = inputSources.get("webcam");
	const existing = vfs.listFolder(ROOT_ID).find((n) => n.type === "file" && n.name === INPUTS_FILE_NAME);
	if (existing) {
		fileId = existing.id;
		try {
			const data = JSON.parse(await existing.file.text());
			webcam?.applyEntries(data?.webcam?.entries);
		} catch {
			// A corrupt inputs.json never stops a project from opening.
		}
	}
	if (!existing && hasRows()) {
		// A project saved before this file existed: its rows came in from
		// workstation-state.json (see wa-webcam-input.js applyState), which no
		// longer keeps them — so they are written here, now, or the next save
		// of that file would drop them. (The unsaved-changes baseline is taken
		// after this, so opening such a project doesn't count as a change.)
		fileId = vfs.uploadFile(ROOT_ID, new File([currentJson()], INPUTS_FILE_NAME, { type: "application/json" })).id;
	}
	// Measured after the rows are in, not taken from the file: the element
	// may normalise them, and merely opening a project must not rewrite it.
	lastJson = currentJson();
}
