import "./components/wa-stage-view.js";
import "./components/wa-webcam-input.js";
import { xmlStore } from "./xml-editor/xml-store.js";
import { parseXsdSchema } from "./xml-editor/schema-parser.js";
import { openProjectFromFile } from "./project/project-manager.js";
import { assessmentStore } from "./project/assessment-store.js";
import { runAssessment } from "./assessment/run.js";
import { collectValues } from "./assessment/collect.js";
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

// When the page is opened by a learning platform (LTI), Done does not judge
// anything itself: it asks the tool's server what to measure, measures it, and
// sends the values back — the server works out the score and passes it on to
// the gradebook. The server's address comes in the page's own address, so only
// these servers are accepted (a made-up address must not be able to collect
// what the page sends).
const LTI_API_PREFIXES = ["https://waxml.org/waw/lti/"];

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
	if (!res.ok) throw new Error(`the schema file (${DEFAULT_SCHEMA_PATH}) answered ${res.status}`);
	const schema = parseXsdSchema(await res.text());
	if (schema) xmlStore.setSchema(schema, "waxml.xsd");
}

// A view that is assessed has a Done button: it measures the page as it is,
// evaluates it and shows the outcome. The outcome is also announced on the
// document ("waw:done") for whatever hosts the page (the LTI layer, later) —
// the page itself sends nothing anywhere.
function setUpDone(viewId, lti) {
	if (lti) {
		doneBar.hidden = false;
		const button = doneBar.querySelector(".done-btn");
		button.addEventListener("click", async () => {
			button.disabled = true;
			try {
				const reads = (await postToTool(lti, { token: lti.token, action: "reads" })).reads;
				const outcome = await postToTool(lti, { token: lti.token, values: collectValues(reads) });
				showAssessmentResult(outcome.result, { pass: outcome.result.hasPass ? 0 : undefined });
				if (outcome.ags && !outcome.ags.sent) showToolNote(`Your result was not sent to the gradebook (${outcome.ags.status}).`);
				document.dispatchEvent(new CustomEvent("waw:done", { detail: { viewId, result: outcome.result } }));
			} catch (err) {
				console.error("Viewer: Done failed:", err);
				showToolNote(err.message || "The result could not be sent. Try again.");
			} finally {
				button.disabled = false;
			}
		});
		return;
	}
	if (!assessmentStore.has(viewId)) return;
	doneBar.hidden = false;
	doneBar.querySelector(".done-btn").addEventListener("click", () => {
		const run = runAssessment(viewId);
		if (!run) return;
		showAssessmentResult(run.result, run.assessment);
		document.dispatchEvent(new CustomEvent("waw:done", { detail: run }));
	});
}

async function postToTool(lti, body) {
	const res = await fetch(lti.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
	return data;
}

function showToolNote(text) {
	let note = document.querySelector(".tool-note");
	if (!note) {
		note = document.createElement("div");
		note.className = "tool-note";
		doneBar.prepend(note);
	}
	note.textContent = text;
}

// The launch the learning platform handed over, if any: { token, api }.
function ltiLaunch(params) {
	const token = params.get("lti");
	const api = params.get("api");
	if (!token || !api) return null;
	// (A viewer opened from localhost, while developing, may also use a tool server on localhost.)
	const local = location.hostname === "localhost" && api.startsWith("http://localhost");
	if (!local && !LTI_API_PREFIXES.some((prefix) => api.startsWith(prefix))) return null;
	return { token, api };
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
		if (!res.ok) throw new Error(`the project file (${project}) was not found or could not be read: the server answered ${res.status}`);
		const file = new File([await res.blob()], project.split("/").pop(), { type: "application/zip" });
		await openProjectFromFile(file);
		stageEl.style.display = "";
		setUpDone(view, ltiLaunch(params));
	} catch (err) {
		console.error("Viewer: could not open the project:", err);
		// The reason is shown (it holds no secrets: a file name and a status) so a
		// person setting this up can tell a missing file from a broken one.
		showMessage(`The project could not be loaded: ${err.message || err}`);
	}
}

main();
