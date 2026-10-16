import "./components/wa-stage-view.js";
import "./components/wa-webcam-input.js";
import { xmlStore } from "./xml-editor/xml-store.js";
import { parseXsdSchema } from "./xml-editor/schema-parser.js";
import { openProjectFromFile } from "./project/project-manager.js";
import { assessmentStore } from "./project/assessment-store.js";
import { runAssessment } from "./assessment/run.js";
import { showAssessmentResult } from "./components/wa-assessment-result.js";

// The viewer page (viewer.html): opens one published project (a zip) and
// shows ONE of its Stage views, full page. Nothing of the editor is here —
// no menus, no panels — and no way to move to another view: which view it is
// comes from the URL (?project=...&view=<view id>), and a URL without a view
// shows nothing rather than a default one.
//
// Note: the whole project is loaded in the browser, other views included, so
// "can't reach another view" is about the page, not a security guarantee —
// that takes a server that only sends the requested view (see the LTI plan).

const DEFAULT_SCHEMA_PATH = "schemas/waxml.xsd";

const stageEl = document.querySelector("wa-stage-view");
const doneBar = document.querySelector(".done-bar");

function showMessage(text) {
	stageEl.style.display = "none";
	const p = document.createElement("p");
	p.className = "viewer-message";
	p.textContent = text;
	document.body.appendChild(p);
}

async function loadSchema() {
	const res = await fetch(DEFAULT_SCHEMA_PATH);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	const schema = parseXsdSchema(await res.text());
	if (schema) xmlStore.setSchema(schema, "waxml.xsd");
}

// A view that is assessed has a Done button: it measures the page as it is,
// evaluates it and shows the outcome. The outcome is also announced on the
// document ("waw:done") for whatever hosts the page (the LTI layer, later) —
// the page itself sends nothing anywhere.
function setUpDone(viewId) {
	if (!assessmentStore.has(viewId)) return;
	doneBar.hidden = false;
	doneBar.querySelector(".done-btn").addEventListener("click", () => {
		const run = runAssessment(viewId);
		if (!run) return;
		showAssessmentResult(run.result, run.assessment);
		document.dispatchEvent(new CustomEvent("waw:done", { detail: run }));
	});
}

async function main() {
	const params = new URLSearchParams(location.search);
	const project = params.get("project");
	const view = params.get("view");
	if (!project || !view) {
		showMessage("This page needs a project and a view in its address.");
		return;
	}
	// Only a zip next to this page — never an address on another site.
	if (!/\.zip$/i.test(project) || /^[a-z][a-z0-9+.-]*:|^\/\/|\.\./i.test(project)) {
		showMessage("This project can't be opened.");
		return;
	}
	// Pinned to the view from the start, so the editor's tabs never show.
	stageEl.setAttribute("view-id", view);
	stageEl.style.display = "none";
	try {
		await loadSchema();
		const res = await fetch(project, { cache: "no-store" });
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const file = new File([await res.blob()], project.split("/").pop(), { type: "application/zip" });
		await openProjectFromFile(file);
		stageEl.style.display = "";
		setUpDone(view);
	} catch (err) {
		console.error("Viewer: could not open the project:", err);
		showMessage("The project could not be loaded.");
	}
}

main();
