import "./components/wa-panel.js";
import "./components/wa-file-menu.js";
import "./components/wa-edit-menu.js";
import "./components/wa-view-menu.js";
import "./components/wa-bottom-bar.js";
import "./components/wa-input-panel.js";
import "./components/wa-file-manager.js";
import "./components/wa-preview.js";
import "./components/wa-xml-editor.js";
import "./components/wa-xml-code.js";
import "./components/wa-library-view.js";
import "./components/wa-share-dialog.js";
import { showNotice } from "./components/wa-notice-dialog.js";

import { xmlStore } from "./xml-editor/xml-store.js";
import { parseXsdSchema } from "./xml-editor/schema-parser.js";
import { createDefaultProject } from "./project/project-manager.js";
import { registerPanels, registerLayoutExtras } from "./project/workstation-state.js";
import { initEditHistory, isEditableContext } from "./project/edit-history.js";
import { viewState } from "./state/view.js";

const DEFAULT_SCHEMA_PATH = "schemas/waxml.xsd";
const DEFAULT_SCHEMA_NAME = "waxml.xsd";

registerPanels([...document.querySelectorAll("main.app-panels > wa-panel")]);
// wa-xml-tree, wa-section-view, wa-chain-view, wa-var-view, wa-mixer-view
// and wa-webcam-input aren't reachable from the top-level document — they're
// built into wa-xml-editor's/wa-preview's/wa-input-panel's own shadow roots
// (see those files' constructors) — one shadow-boundary hop each.
const xmlEditorEl = document.querySelector("wa-xml-editor");
const previewEl = document.querySelector("wa-preview");
const inputPanelEl = document.querySelector("wa-input-panel");
registerLayoutExtras({
	xmlTree: xmlEditorEl?.shadowRoot.querySelector("wa-xml-tree"),
	xmlEditor: xmlEditorEl,
	sectionView: previewEl?.shadowRoot.querySelector("wa-section-view"),
	webcamInput: inputPanelEl?.shadowRoot.querySelector("wa-webcam-input"),
	chainView: previewEl?.shadowRoot.querySelector("wa-chain-view"),
	varView: previewEl?.shadowRoot.querySelector("wa-var-view"),
	mixerView: previewEl?.shadowRoot.querySelector("wa-mixer-view")
});
initEditHistory();
loadDefaultSchema().then(createDefaultProject);

// Global fallback: Backspace/Delete removes whatever's currently selected in
// the XML document, for any selection none of the more specific per-view
// handlers already claimed — wa-bottom-bar.js's/wa-var-knobs.js's/
// wa-mixer-view.js's/wa-section-view.js's/wa-composition-view.js's/
// wa-player-bar.js's own Backspace handlers each only recognize their own
// narrow kind of selection (a root/local Command or Var, a Mixer channel, a
// Section's Option/Segment, the Composition itself, a trigger shortcut) and
// each checks e.defaultPrevented first, calling preventDefault() itself only
// once it actually acts — so this, registered last (every other listener
// above is wired from a component's own connectedCallback, which — for a
// custom element already sitting in the initial HTML — runs synchronously
// during that component's own `import` above, all of which finish before
// this line ever runs), only ever fires for a selection none of them
// recognized. That includes a plain node selected directly in the XML tree,
// and — per Hans (2026-10-01): "markera olika objekt i <Chain> - de gick
// inte heller att radera med BACKSPACE" — any node selected via a
// wa-chain-view.js card, which never had ANY keyboard-delete path before.
document.addEventListener("keydown", (e) => {
	if (e.defaultPrevented) return;
	if (e.key !== "Backspace" && e.key !== "Delete") return;
	if (isEditableContext()) return;
	const selectedId = xmlStore.selectedNodeId;
	if (!selectedId || !xmlStore.root || selectedId === xmlStore.root.id) return;
	e.preventDefault();
	xmlStore.removeNode(selectedId);
});

// xmlStore stays UI-agnostic (every other view just listens for its own
// "change") — a "notice" event is its one exception, for a message that
// needs to reach the user directly rather than just drive a re-render. Per
// Hans (2026-09-22): currently only the active/fadeTime workaround (see
// xml-store.js's own _applyActiveFadeTimeWorkaround) fires this.
xmlStore.addEventListener("notice", (e) => showNotice(e.detail.message));

// View menu wiring (per Hans, 2026-09-10): swaps which top-level view is
// visible without ever touching xmlStore/vfs/playerStore — the real project
// keeps running in the background exactly as-is under Workstation whichever
// view is showing. <wa-bottom-bar> (2026-09-20, replacing the header's own
// <wa-player-bar>) only makes sense in Workstation (the Library view has its
// own, reused <wa-player-bar> instance — see wa-library-view.js) so it hides
// along with <main> in the other views.
const VIEW_TITLES = {
	workstation: "WAXML Workstation — BETA",
	library: "WAXML Library (DEMO)"
};
const appTitleEl = document.getElementById("appTitle");
const bottomBarEl = document.getElementById("bottomBar");
const mainPanelsEl = document.querySelector("main.app-panels");
const libraryViewEl = document.querySelector("wa-library-view");

function applyView(view) {
	mainPanelsEl.hidden = view !== "workstation";
	bottomBarEl.hidden = view !== "workstation";
	libraryViewEl.hidden = view !== "library";
	appTitleEl.textContent = VIEW_TITLES[view] || VIEW_TITLES.workstation;
}
viewState.addEventListener("change", (e) => applyView(e.detail.view));
applyView(viewState.current);

async function loadDefaultSchema() {
	try {
		const res = await fetch(DEFAULT_SCHEMA_PATH);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const schema = parseXsdSchema(await res.text());
		if (schema) xmlStore.setSchema(schema, DEFAULT_SCHEMA_NAME);
		else console.warn(`Could not parse default schema at ${DEFAULT_SCHEMA_PATH}`);
	} catch (err) {
		console.warn(`Could not load default schema at ${DEFAULT_SCHEMA_PATH}:`, err);
	}
}

// Steg 0 kör helt i RAM — refresh/stängd flik tömmer sessionen (spec avsnitt 1.4).
window.addEventListener("beforeunload", (e) => {
	e.preventDefault();
	e.returnValue = "";
});
