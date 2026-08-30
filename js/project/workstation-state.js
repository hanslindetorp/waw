import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { xmlStore } from "../xml-editor/xml-store.js";

// Persists Workstation's own editor state (open panels, selected element) —
// separate from wa.xml, which stays pure "delivery" content: embeddable/
// shareable without workstation UI leftovers riding along. Per
// workstation-state-instructions.md (2026-08 conversation with Hans):
// this lives as its own file next to wa.xml in the project's zip, kept live-
// synced into the VFS the same way document-sync.js keeps wa.xml synced, so
// exportProjectAsZip picks it up "for free" via its normal VFS walk.
//
// Deliberately NOT implemented: the optional `<?workstation-state src="..."?>`
// processing-instruction link — plain filename convention (this file, at the
// project root) is enough for now per the instructions doc; add that only if
// multiple wa.xml-like files in one project ever need distinguishing.
export const STATE_FILE_NAME = "workstation-state.json";

const SAVE_DEBOUNCE_MS = 400;

let stateFileId = null;
let saveTimer = null;
let panels = [];

// Called once at startup with every top-level <wa-panel> whose open/closed
// state should be persisted (each needs a stable `id` attribute — see
// index.html's fileManager/xmlEditor/preview/xmlCode).
export function registerPanels(panelEls) {
	panels = panelEls;
	panels.forEach((panel) => panel.addEventListener("collapse-change", scheduleSave));
}

function captureState() {
	const state = { openPanels: panels.filter((p) => !p.collapsed).map((p) => p.id) };
	// The internal tree id (xmlStore.selectedNodeId) is a session-local
	// counter that resets on every reparse — never stable across a save/load
	// round-trip. Only the XML `id` *attribute* is a meaningful, durable
	// reference (per the instructions doc); a selected node without one
	// (only the document root can lack one — see backfillElementIds) just
	// means nothing gets persisted here.
	const selectedNode = xmlStore.getSelectedNode();
	if (selectedNode?.attributes.id) state.selectedElementId = selectedNode.attributes.id;
	return state;
}

// Best-effort by design (per the instructions doc): a missing/unparsable
// file, an unknown panel id, or a selectedElementId that no longer exists in
// the document are all silently ignored rather than failing project load.
function applyState(state) {
	if (!state || typeof state !== "object") return;
	if (Array.isArray(state.openPanels)) {
		panels.forEach((panel) => panel.toggleCollapse(!state.openPanels.includes(panel.id)));
	}
	if (state.selectedElementId && xmlStore.root) {
		const node = findNodeByAttributeId(xmlStore.root, state.selectedElementId);
		if (node) xmlStore.selectNode(node.id);
	}
}

function findNodeByAttributeId(node, targetId) {
	if (node.attributes.id === targetId) return node;
	for (const child of node.children) {
		const found = findNodeByAttributeId(child, targetId);
		if (found) return found;
	}
	return null;
}

function scheduleSave() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

function saveNow() {
	clearTimeout(saveTimer);
	saveTimer = null;
	if (!stateFileId) return;
	if (!vfs.getNode(stateFileId)) {
		stateFileId = null; // the file was deleted (e.g. a fresh project's vfs.clear()) — nothing to write into
		return;
	}
	vfs.updateFileContent(stateFileId, JSON.stringify(captureState(), null, 2));
}

// Flushes any pending debounced save immediately — call right before
// exporting a zip, so the bundled file reflects the latest state rather than
// whatever was true up to SAVE_DEBOUNCE_MS ago (same reasoning as document-
// sync.js's flushPendingSync before a file switch).
export function flushWorkstationState() {
	if (saveTimer) saveNow();
}

// Call once project-manager.js has finished setting up the VFS + xmlStore
// document (createDefaultProject / openProjectFromFile, both branches) —
// looks for an existing workstation-state.json at the project root and
// applies it if found; otherwise creates a fresh default one from whatever
// the panels/selection currently look like, exactly like wa.xml itself gets
// created for a brand new project.
export function initWorkstationState() {
	clearTimeout(saveTimer);
	saveTimer = null;
	stateFileId = null;

	const existing = vfs.listFolder(ROOT_ID).find((n) => n.type === "file" && n.name === STATE_FILE_NAME);
	if (existing) {
		stateFileId = existing.id;
		existing.file
			.text()
			.then((text) => applyState(JSON.parse(text)))
			.catch(() => {
				// Malformed/corrupt state file — never a reason to fail loading
				// the project itself (per the instructions doc), just keep
				// Workstation's current default state.
			});
		return;
	}

	const fileNode = vfs.uploadFile(ROOT_ID, new File([JSON.stringify(captureState(), null, 2)], STATE_FILE_NAME, { type: "application/json" }));
	stateFileId = fileNode.id;
}

xmlStore.addEventListener("change", scheduleSave);
