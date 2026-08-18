import "./components/wa-panel.js";
import "./components/wa-file-menu.js";
import "./components/wa-file-manager.js";
import "./components/wa-preview.js";
import "./components/wa-xml-editor.js";
import "./components/wa-xml-code.js";

import { xmlStore } from "./xml-editor/xml-store.js";
import { parseXsdSchema } from "./xml-editor/schema-parser.js";
import { createDefaultProject } from "./project/project-manager.js";

const DEFAULT_SCHEMA_PATH = "schemas/waxml.xsd";
const DEFAULT_SCHEMA_NAME = "waxml.xsd";

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
