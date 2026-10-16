import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { xmlStore } from "../xml-editor/xml-store.js";

// The Stage: flat, hierarchy-free pages ("views") of whatever the project's
// author wants a user to see and play with — headings, instructions and
// chosen objects from the audio graph (a <Command> button, a <Var> knob, a
// BiquadFilterNode card, ...) placed at x/y positions on a fixed-size scene.
// Per Hans (2026-10-15) a project holds any number of views (one per task,
// say), all of them sharing the project's one audio graph; each is reachable
// on its own URL (see the viewer) and — later — has its own assessment.
//
// Everything lives in one file, stage.json, at the project root: project
// content (it travels in the zip, counts towards "unsaved changes" and is
// part of undo), not editor layout like workstation-state.json. The file is
// only created once the author has actually changed the Stage: until then it
// is computed — one view with all root-level <Command>s and <Var>s in a row
// each, which is what the bottom bar shows too.
//
// Elements are referenced by their XML `id` attribute, the one durable
// reference (the tree's own ids change on every reparse). Nothing here
// touches the XML document.
//
//   { "version": 2,
//     "views": [
//       { "id": "vk3x9q2ab1", "name": "Match the filter",
//         "items": [
//           { "id": "i1", "type": "heading", "x": 24, "y": 20, "w": 600, "text": "..." },
//           { "id": "i2", "type": "text",    "x": 24, "y": 70, "w": 600, "text": "..." },
//           { "id": "i3", "type": "command", "x": 24, "y": 140, "w": 140, "ref": "<element id>" },
//           { "id": "i4", "type": "var",     "x": 200, "y": 140, "w": 90, "ref": "<element id>" },
//           { "id": "i5", "type": "element", "x": 24, "y": 220, "w": 260, "ref": "<element id>" },
//           { "id": "i6", "type": "input",   "x": 24, "y": 400, "w": 260, "source": "webcam", "ref": 3 } ] } ] }
//
// An "input" item stands for a row of a live input (the camera: `ref` is the
// row's id in inputs.json) together with the Start/Stop of that input.
//
// A view's `id` is random and never derived from its name: it is what ends
// up in the view's URL, so it must neither change when the view is renamed
// nor be guessable. An item's height is never stored: an item is as tall as
// its content.
//
// The data is treated as immutable (every edit builds new arrays/objects),
// which is what lets undo (project/edit-history.js) keep a snapshot as just a
// reference.
//
// Events: "change" — anything a Stage view has to redraw for (also the
// computed defaults following the document, a project being loaded); "edit" —
// the author changed something (what undo records).

export const STAGE_FILE_NAME = "stage.json";
// What an input row (see wa-webcam-input.js) carries when it is dragged onto
// the Stage: JSON { source, entryId }.
export const STAGE_INPUT_DRAG_TYPE = "application/x-waw-stage-input";
export const STAGE_WIDTH = 960;
export const STAGE_MIN_HEIGHT = 540;

const FORMAT_VERSION = 2;
const SAVE_DEBOUNCE_MS = 400;
const DEFAULT_WIDTHS = { heading: 600, text: 600, command: 150, var: 100, element: 260, input: 260 };
const ESTIMATED_HEIGHTS = { heading: 44, text: 90, command: 40, var: 110, element: 240, input: 90 };
const ITEM_GAP = 16;
const ELEMENT_COLUMN_STEP = 280;
const DEFAULT_VIEW_NAME = "Stage";

function newViewId() {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return "v" + [...bytes].map((b) => (b % 36).toString(36)).join("");
}

class StageStore extends EventTarget {
	constructor() {
		super();
		this._fileId = null;
		this._explicit = false; // true once a stage.json exists (or has been created by an edit)
		this._views = [];
		this._currentId = null;
		this._saveTimer = null;
		this._nextItemId = 1;
		this._defaultsCache = null;
		this._elementTags = new Set(); // tags that have a card to show (set by wa-chain-view.js)
		// The defaults follow the document (a new root Command shows up), so a
		// project without a stage.json keeps up with it.
		xmlStore.addEventListener("change", () => {
			if (!this._explicit) {
				this._defaultsCache = null;
				this.dispatchEvent(new CustomEvent("change"));
			}
		});
	}

	// The element tags the Stage can show as a card — registered by the view
	// that knows how to draw them, so this module needs no UI imports.
	setElementTags(tags) {
		this._elementTags = new Set(tags);
	}

	// Called once a project's files and document are in place (see
	// project-manager.js's initProjectState). Synchronous for a project
	// without a stage.json; await it before taking the undo baseline.
	init() {
		clearTimeout(this._saveTimer);
		this._saveTimer = null;
		this._fileId = null;
		this._explicit = false;
		this._views = [];
		this._currentId = null;
		this._nextItemId = 1;
		this._defaultsCache = null;
		const existing = vfs.listFolder(ROOT_ID).find((n) => n.type === "file" && n.name === STAGE_FILE_NAME);
		if (!existing) {
			this.dispatchEvent(new CustomEvent("change"));
			return Promise.resolve();
		}
		this._fileId = existing.id;
		return existing.file
			.text()
			.then((text) => {
				const views = parseStageFile(JSON.parse(text));
				if (views) {
					this._views = views;
					this._explicit = true;
					this._currentId = views[0].id;
					this._nextItemId = nextItemIdFor(views);
				}
			})
			.catch(() => {
				// A corrupt stage.json is never a reason to fail loading the
				// project — the Stage just falls back to its defaults.
			})
			.then(() => this.dispatchEvent(new CustomEvent("change")));
	}

	// ── Reading ───────────────────────────────────────────────────────────
	// The views to show: the saved ones, or — before the author has changed
	// anything — one computed default view.
	get views() {
		if (this._explicit) return this._views;
		return [{ id: "default", name: DEFAULT_VIEW_NAME, items: this._defaultItems() }];
	}

	get isDefault() {
		return !this._explicit;
	}

	getView(id) {
		return this.views.find((v) => v.id === id) || null;
	}

	get currentViewId() {
		const views = this.views;
		return views.some((v) => v.id === this._currentId) ? this._currentId : views[0].id;
	}

	get currentView() {
		return this.getView(this.currentViewId);
	}

	// The current view's items.
	get items() {
		return this.currentView.items;
	}

	getItem(id) {
		return this.items.find((i) => i.id === id) || null;
	}

	setCurrentView(id) {
		if (!this.getView(id) || id === this._currentId) return;
		this._currentId = id;
		this.dispatchEvent(new CustomEvent("change"));
	}

	_defaultItems() {
		if (this._defaultsCache) return this._defaultsCache;
		const items = [];
		const root = xmlStore.root;
		if (root) {
			let x = 24;
			root.children
				.filter((c) => c.tagName === "Command" && c.attributes.id)
				.forEach((c, i) => {
					items.push({ id: `d-c${i}`, type: "command", x, y: 24, w: DEFAULT_WIDTHS.command, ref: c.attributes.id });
					x += DEFAULT_WIDTHS.command + 12;
				});
			x = 24;
			root.children
				.filter((c) => c.tagName === "Var" && c.attributes.id)
				.forEach((c, i) => {
					items.push({ id: `d-v${i}`, type: "var", x, y: 100, w: DEFAULT_WIDTHS.var, ref: c.attributes.id });
					x += DEFAULT_WIDTHS.var + 12;
				});
		}
		this._defaultsCache = items;
		return items;
	}

	// ── Writing ───────────────────────────────────────────────────────────
	// An edit turns the computed defaults into real, saved content first, so
	// the author edits what they were looking at.
	_materialize() {
		if (this._explicit) return;
		this._views = [{ id: newViewId(), name: DEFAULT_VIEW_NAME, items: this._defaultItems().map((i, n) => ({ ...i, id: `i${n + 1}` })) }];
		this._currentId = this._views[0].id;
		this._nextItemId = this._views[0].items.length + 1;
		this._explicit = true;
	}

	_commit(views) {
		this._views = views;
		if (!views.some((v) => v.id === this._currentId)) this._currentId = views[0]?.id ?? null;
		this.dispatchEvent(new CustomEvent("change"));
		this.dispatchEvent(new CustomEvent("edit"));
		clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
	}

	_editCurrentView(fn) {
		this._materialize();
		const id = this.currentViewId;
		this._commit(this._views.map((v) => (v.id === id ? { ...v, items: fn(v.items) } : v)));
	}

	// Writes the file now (also called before a project is exported/saved, so
	// the zip has the latest).
	flush() {
		clearTimeout(this._saveTimer);
		this._saveTimer = null;
		if (!this._explicit) return;
		const json = JSON.stringify({ version: FORMAT_VERSION, views: this._views }, null, 2);
		if (this._fileId && vfs.getNode(this._fileId)) {
			vfs.updateFileContent(this._fileId, json, { silent: true });
		} else {
			const node = vfs.uploadFile(ROOT_ID, new File([json], STAGE_FILE_NAME, { type: "application/json" }));
			this._fileId = node.id;
		}
	}

	addItem(type, fields = {}) {
		this._materialize(); // first: it fixes the numbering the new id comes from
		const item = { id: `i${this._nextItemId++}`, type, x: 24, y: 24, w: DEFAULT_WIDTHS[type] ?? 200, ...fields };
		this._editCurrentView((items) => [...items, item]);
		return item;
	}

	updateItem(id, fields) {
		this._editCurrentView((items) => items.map((i) => (i.id === id ? { ...i, ...fields } : i)));
	}

	removeItem(id) {
		this._editCurrentView((items) => items.filter((i) => i.id !== id));
	}

	// ── Views ─────────────────────────────────────────────────────────────
	addView(name = "New view") {
		this._materialize();
		const view = { id: newViewId(), name, items: [] };
		this._commit([...this._views, view]);
		this._currentId = view.id;
		this.dispatchEvent(new CustomEvent("change"));
		return view;
	}

	duplicateView(id) {
		this._materialize();
		const source = this._views.find((v) => v.id === id);
		if (!source) return null;
		const items = source.items.map((i) => ({ ...i, id: `i${this._nextItemId++}` }));
		const view = { id: newViewId(), name: `${source.name} copy`, items };
		this._commit([...this._views, view]);
		this._currentId = view.id;
		this.dispatchEvent(new CustomEvent("change"));
		return view;
	}

	renameView(id, name) {
		this._materialize();
		this._commit(this._views.map((v) => (v.id === id ? { ...v, name: name || v.name } : v)));
	}

	// The last view can't be removed — a project always has at least one.
	removeView(id) {
		this._materialize();
		if (this._views.length <= 1) return false;
		this._commit(this._views.filter((v) => v.id !== id));
		return true;
	}

	// Adds an input row (see "input" in the header comment) to the current
	// view; at = { x, y } or below what is there.
	addInput(source, entryId, at = null) {
		return this.addItem("input", {
			x: at ? Math.max(0, Math.round(at.x)) : 24,
			y: at ? Math.max(0, Math.round(at.y)) : this.nextFreeY(),
			source,
			ref: entryId
		});
	}

	// ── Adding a document element ─────────────────────────────────────────
	// Adds `node` (a node of the XML document) to the current view: a <Command>
	// or <Var> as its own button/knob, an element with a card as a card, a
	// <Chain> as its elements side by side. Without `at` the items go below
	// what is already there. Returns { items } or { error }.
	addNode(node, at = null) {
		const refOf = (n) => n.attributes.id;
		const x0 = at ? Math.max(0, Math.round(at.x)) : 24;
		const y0 = at ? Math.max(0, Math.round(at.y)) : this.nextFreeY();
		if (node.tagName === "Command" || node.tagName === "Var") {
			if (!refOf(node)) return { error: `This <${node.tagName}> has no id, so the Stage can't refer to it.` };
			return { items: [this.addItem(node.tagName === "Command" ? "command" : "var", { x: x0, y: y0, ref: refOf(node) })] };
		}
		const nodes = node.tagName === "Chain" ? node.children : [node];
		const usable = nodes.filter((n) => this._elementTags.has(n.tagName) && refOf(n));
		if (!usable.length) {
			return { error: `The Stage can't show <${node.tagName}> yet. Drag an element such as a BiquadFilterNode, a <Command> or a <Var>.` };
		}
		let x = x0;
		const items = usable.map((n) => {
			const item = this.addItem("element", { x, y: y0, ref: refOf(n) });
			x += ELEMENT_COLUMN_STEP;
			return item;
		});
		return { items };
	}

	// Where something new can go without landing on what is there: below the
	// lowest item (heights are estimated — the view knows the real ones, but
	// this must work with the Stage panel closed).
	nextFreeY() {
		const items = this.items;
		if (!items.length) return 24;
		let bottom = 0;
		items.forEach((i) => {
			let h = ESTIMATED_HEIGHTS[i.type] ?? 60;
			if (i.type === "text" || i.type === "heading") {
				const lines = String(i.text || "").split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(10, i.w / 9))), 0);
				h = Math.max(h, lines * (i.type === "heading" ? 36 : 24) + 8);
			}
			bottom = Math.max(bottom, i.y + h);
		});
		return bottom + ITEM_GAP;
	}

	// ── Undo ──────────────────────────────────────────────────────────────
	// What undo keeps of the Stage: a reference — the data is never mutated.
	snapshot() {
		return { explicit: this._explicit, views: this._views, currentId: this._currentId, nextItemId: this._nextItemId };
	}

	restore(snap) {
		if (!snap) return;
		this._explicit = snap.explicit;
		this._views = snap.views;
		this._currentId = snap.currentId;
		this._nextItemId = snap.nextItemId;
		this._defaultsCache = null;
		this.dispatchEvent(new CustomEvent("change"));
		if (this._explicit) {
			clearTimeout(this._saveTimer);
			this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
		}
	}
}

// A stage.json — the current format, or the first one (one view, a plain
// `items` list) — as a list of views; null if it is neither.
function parseStageFile(data) {
	if (!data || typeof data !== "object") return null;
	if (Array.isArray(data.views)) {
		const views = data.views
			.filter((v) => v && typeof v.id === "string" && Array.isArray(v.items))
			.map((v) => ({ id: v.id, name: typeof v.name === "string" && v.name ? v.name : DEFAULT_VIEW_NAME, items: v.items.filter(isValidItem).map((i) => ({ ...i })) }));
		return views.length ? views : null;
	}
	if (Array.isArray(data.items)) {
		return [{ id: newViewId(), name: DEFAULT_VIEW_NAME, items: data.items.filter(isValidItem).map((i) => ({ ...i })) }];
	}
	return null;
}

function nextItemIdFor(views) {
	let max = 0;
	views.forEach((v) => v.items.forEach((i) => (max = Math.max(max, parseInt(String(i.id).replace(/\D/g, ""), 10) || 0))));
	return max + 1;
}

function isValidItem(i) {
	return (
		i &&
		typeof i === "object" &&
		typeof i.id === "string" &&
		["heading", "text", "command", "var", "element", "input"].includes(i.type) &&
		Number.isFinite(i.x) &&
		Number.isFinite(i.y)
	);
}

export const stageStore = new StageStore();
