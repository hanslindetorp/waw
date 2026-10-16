import { vfs, ROOT_ID } from "../vfs/VFS.js";

// How each Stage view is assessed (see assessment/evaluate.js for the model),
// in its own file, assessment.json, at the project root — apart from
// stage.json on purpose: what is shown and how it is judged are different
// things, and when grading counts the judging has to leave the browser (a
// server keeps this file and strips it from what it serves).
//
//   { "version": 1, "assessments": { "<view id>": { max, pass, reveal, criteria, bands } } }
//
// A view with no entry is not assessed (no Done button). The file only exists
// once some view has an assessment. Like stage-store.js, the data is never
// mutated, so undo keeps a snapshot as a reference ("edit" is what it records;
// "change" is for whatever has to redraw).

export const ASSESSMENT_FILE_NAME = "assessment.json";

const SAVE_DEBOUNCE_MS = 400;

class AssessmentStore extends EventTarget {
	constructor() {
		super();
		this._fileId = null;
		this._assessments = {};
		this._saveTimer = null;
	}

	init() {
		clearTimeout(this._saveTimer);
		this._saveTimer = null;
		this._fileId = null;
		this._assessments = {};
		const existing = vfs.listFolder(ROOT_ID).find((n) => n.type === "file" && n.name === ASSESSMENT_FILE_NAME);
		if (!existing) {
			this.dispatchEvent(new CustomEvent("change"));
			return Promise.resolve();
		}
		this._fileId = existing.id;
		return existing.file
			.text()
			.then((text) => {
				const data = JSON.parse(text);
				if (data && typeof data.assessments === "object" && data.assessments) {
					const clean = {};
					Object.entries(data.assessments).forEach(([id, a]) => {
						if (a && typeof a === "object") clean[id] = a;
					});
					this._assessments = clean;
				}
			})
			.catch(() => {})
			.then(() => this.dispatchEvent(new CustomEvent("change")));
	}

	has(viewId) {
		return !!this._assessments[viewId];
	}

	get(viewId) {
		return this._assessments[viewId] || null;
	}

	set(viewId, assessment) {
		this._commit({ ...this._assessments, [viewId]: assessment });
	}

	remove(viewId) {
		if (!this._assessments[viewId]) return;
		const next = { ...this._assessments };
		delete next[viewId];
		this._commit(next);
	}

	// A duplicated view is assessed the same way.
	copy(fromId, toId) {
		const a = this._assessments[fromId];
		if (a) this.set(toId, JSON.parse(JSON.stringify(a)));
	}

	_commit(assessments) {
		this._assessments = assessments;
		this.dispatchEvent(new CustomEvent("change"));
		this.dispatchEvent(new CustomEvent("edit"));
		this._scheduleSave();
	}

	_scheduleSave() {
		clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
	}

	flush() {
		clearTimeout(this._saveTimer);
		this._saveTimer = null;
		const empty = Object.keys(this._assessments).length === 0;
		if (empty && !this._fileId) return;
		const json = JSON.stringify({ version: 1, assessments: this._assessments }, null, 2);
		if (this._fileId && vfs.getNode(this._fileId)) {
			vfs.updateFileContent(this._fileId, json, { silent: true });
		} else {
			this._fileId = vfs.uploadFile(ROOT_ID, new File([json], ASSESSMENT_FILE_NAME, { type: "application/json" })).id;
		}
	}

	snapshot() {
		return { assessments: this._assessments };
	}

	restore(snap) {
		if (!snap) return;
		this._assessments = snap.assessments;
		this.dispatchEvent(new CustomEvent("change"));
		this._scheduleSave();
	}
}

export const assessmentStore = new AssessmentStore();
