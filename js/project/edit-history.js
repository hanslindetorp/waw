import { xmlStore } from "../xml-editor/xml-store.js";
import { vfs } from "../vfs/VFS.js";

// App-wide undo/redo, per Hans: one combined in-memory history across the
// XML document *and* the file manager (VFS), spanning every "change" event
// from either store — not a per-panel undo, so e.g. undoing after deleting a
// file also undoes an XML edit made just before it, same as most apps' one
// global Edit > Undo. workstation-state.json (panel layout/collapse/width)
// deliberately does NOT ride along here — only xmlStore.selectedNodeId does
// (bundled into every snapshot below), since restoring *what's selected*
// alongside a document edit is expected, but undo silently resizing/opening
// panels would not be.
//
// Coalescing: xmlStore fires one "change" event per keystroke/drag-tick (see
// wa-xml-code.js's textarea "input" handler and the Mixer/Inspector sliders'
// continuous-commit behavior) — recording every single one as its own undo
// step would make Undo nearly useless (one keystroke or one drag-tick at a
// time). Instead, a burst of changes closer together than COALESCE_MS
// collapses into a single undo step, boundary-tested against the *first*
// change of the burst — so pressing Undo right after releasing a slider (or
// pausing while typing) reverts the whole gesture, not its last tick.

const HISTORY_LIMIT = 100;
const COALESCE_MS = 500;

let undoStack = [];
let redoStack = [];
let current = null; // last known live snapshot; not yet "committed" onto undoStack
let burstBefore = null; // snapshot from just before the in-flight burst started
let coalesceTimer = null;
let applyingHistory = false; // guards against recording our own undo()/redo() restores
let wired = false;

const events = new EventTarget();

// Fires on every push/pop/reset — lets wa-edit-menu.js keep its Undo/Redo
// items' disabled state in sync without polling.
export function addHistoryChangeListener(fn) {
	events.addEventListener("change", fn);
}

export function canUndo() {
	return undoStack.length > 0 || burstBefore !== null;
}

export function canRedo() {
	return redoStack.length > 0;
}

export function undo() {
	commitBurst();
	if (undoStack.length === 0) return;
	const target = undoStack.pop();
	redoStack.push(current);
	applyRestore(target);
}

export function redo() {
	commitBurst();
	if (redoStack.length === 0) return;
	const target = redoStack.pop();
	undoStack.push(current);
	applyRestore(target);
}

// Call once, after a project has actually finished loading (see
// project-manager.js) — establishes the fresh project as the undo baseline
// and throws away any history from the project that was just replaced.
export function resetEditHistory() {
	undoStack = [];
	redoStack = [];
	burstBefore = null;
	clearTimeout(coalesceTimer);
	coalesceTimer = null;
	current = captureSnapshot();
	notify();
}

// Call once at startup (see app.js) — wires the store listeners and the
// global keyboard shortcuts. Safe to call before a project exists: onChange
// no-ops until resetEditHistory() has established a baseline `current`.
export function initEditHistory() {
	if (wired) return;
	wired = true;
	xmlStore.addEventListener("change", onChange);
	vfs.addEventListener("change", onChange);
	document.addEventListener("keydown", onKeyDown);
}

function captureSnapshot() {
	return {
		xmlRoot: xmlStore.root,
		selectedNodeId: xmlStore.selectedNodeId,
		vfsNodes: vfs.snapshot()
	};
}

function applyRestore(snapshot) {
	applyingHistory = true;
	try {
		xmlStore.restoreSnapshot(snapshot.xmlRoot, snapshot.selectedNodeId);
		vfs.restore(snapshot.vfsNodes);
	} finally {
		applyingHistory = false;
	}
	current = snapshot;
	notify();
}

function onChange() {
	if (applyingHistory || !current) return;
	if (burstBefore === null) {
		burstBefore = current;
		redoStack = []; // a genuinely new edit always invalidates redo, even mid-burst
	}
	current = captureSnapshot();
	clearTimeout(coalesceTimer);
	coalesceTimer = setTimeout(commitBurst, COALESCE_MS);
	notify();
}

// Finalizes the in-flight burst (if any) onto undoStack — called both by the
// idle-timeout above and defensively by undo()/redo() themselves, so e.g.
// pressing Cmd+Z immediately after a click (well within COALESCE_MS) still
// undoes that click rather than whatever the stack's stale top was.
function commitBurst() {
	clearTimeout(coalesceTimer);
	coalesceTimer = null;
	if (burstBefore === null) return;
	undoStack.push(burstBefore);
	if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
	burstBefore = null;
}

function notify() {
	events.dispatchEvent(new Event("change"));
}

function onKeyDown(e) {
	if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
	const key = e.key.toLowerCase();
	const isUndo = key === "z" && !e.shiftKey;
	const isRedo = (key === "z" && e.shiftKey) || key === "y";
	if (!isUndo && !isRedo) return;
	if (isEditableContext()) return; // let native input/textarea undo run instead
	e.preventDefault();
	isRedo ? redo() : undo();
}

// True while focus is inside a text-editing control (an <input>, <textarea>,
// or contenteditable — including one buried inside another component's
// shadow DOM, e.g. the Code panel's textarea or a file-rename field) — used
// to let a global single-key shortcut (Cmd/Ctrl+Z here, Space for PLAY/STOP
// in wa-player-bar.js) fall through to normal typing instead of firing.
export function isEditableContext() {
	let el = document.activeElement;
	while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
	if (!el) return false;
	return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}
