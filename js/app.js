import "./components/wa-panel.js";
import "./components/wa-file-menu.js";
import "./components/wa-edit-menu.js";
import "./components/wa-player-bar.js";
import "./components/wa-file-manager.js";
import "./components/wa-preview.js";
import "./components/wa-xml-editor.js";
import "./components/wa-xml-code.js";

import { xmlStore } from "./xml-editor/xml-store.js";
import { parseXsdSchema } from "./xml-editor/schema-parser.js";
import { createDefaultProject } from "./project/project-manager.js";
import { registerPanels, registerLayoutExtras } from "./project/workstation-state.js";
import { initEditHistory } from "./project/edit-history.js";

const DEFAULT_SCHEMA_PATH = "schemas/waxml.xsd";
const DEFAULT_SCHEMA_NAME = "waxml.xsd";

registerPanels([...document.querySelectorAll("main.app-panels > wa-panel")]);
// wa-xml-tree and wa-section-view aren't reachable from the top-level
// document — they're built into wa-xml-editor's/wa-preview's own shadow
// roots (see those files' constructors) — one shadow-boundary hop each.
const xmlEditorEl = document.querySelector("wa-xml-editor");
const previewEl = document.querySelector("wa-preview");
registerLayoutExtras({
	xmlTree: xmlEditorEl?.shadowRoot.querySelector("wa-xml-tree"),
	xmlEditor: xmlEditorEl,
	sectionView: previewEl?.shadowRoot.querySelector("wa-section-view")
});
initEditHistory();
loadDefaultSchema().then(createDefaultProject);

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
