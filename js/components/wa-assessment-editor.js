import { xmlStore } from "../xml-editor/xml-store.js";
import { isNumericAttributeSchema } from "../xml-editor/schema-parser.js";
import { assessmentStore } from "../project/assessment-store.js";
import { CRITERION_TYPES, SCALES, REVEAL_MODES, problemsWith } from "../assessment/evaluate.js";

// The author's editor for how one Stage view is assessed (see
// assessment/evaluate.js for the model): whether the view is assessed at all
// (then the viewer shows a Done button), how many points it is worth, what
// counts as passed, how much the comments give away, and the weighted
// criteria — each measuring values of the document (an element's attribute)
// and saying how far off is how bad. Opened from the Stage panel's toolbar;
// edits go straight into project/assessment-store.js.

const DEFAULT_BANDS = [
	{ min: 0.9, text: "Excellent." },
	{ min: 0.6, text: "Getting there." },
	{ min: 0, text: "Not yet — try again." }
];

const TYPE_LABELS = {
	match: "One value matches another",
	target: "A value is at a target",
	range: "A value is within a range",
	relation: "Two values differ by",
	spread: "A group of values are alike"
};
const SCALE_LABELS = { linear: "Linear (dB, seconds, amounts)", log2: "Octaves (frequency, time, Q — ratios)" };
const REVEAL_LABELS = { score: "Score only", distance: "How close each criterion is", direction: "How close, and too high / too low" };

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.78rem/1.4 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		.wrap {
			padding: 0.6rem 0.8rem 0.9rem;
		}
		label.check {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			font-weight: 600;
		}
		.row {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5rem 0.9rem;
			margin: 0.5rem 0;
		}
		.field {
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
			color: var(--waw-muted, #8a8a8a);
		}
		input, select {
			font: inherit;
			font-size: 0.74rem;
			background: #101010;
			color: var(--waw-fg, #e8e8e8);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.15rem 0.3rem;
		}
		input[type="number"] {
			width: 4.5rem;
		}
		input[type="text"] {
			min-width: 6rem;
		}
		h4 {
			margin: 0.9rem 0 0.3rem;
			font-size: 0.72rem;
			text-transform: uppercase;
			letter-spacing: 0.04em;
			color: var(--waw-muted, #8a8a8a);
		}
		.criterion {
			margin: 0.4rem 0;
			padding: 0.5rem 0.6rem;
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
		}
		.criterion-head {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.4rem 0.6rem;
		}
		.criterion-head .spacer {
			flex: 1 1 auto;
		}
		.read {
			display: inline-flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.25rem;
			margin: 0.25rem 0;
		}
		.read .read-label {
			min-width: 6.5rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.hint {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.68rem;
		}
		button {
			font: inherit;
			font-size: 0.72rem;
			background: #2a2a2a;
			color: inherit;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.15rem 0.5rem;
			cursor: pointer;
		}
		button:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		button.icon {
			padding: 0.1rem 0.4rem;
		}
		.problems {
			margin-top: 0.6rem;
			color: var(--waw-danger, #e5484d);
			font-size: 0.7rem;
		}
		.off {
			color: var(--waw-muted, #8a8a8a);
			margin-top: 0.4rem;
		}
	</style>
	<div class="wrap"></div>
`;

export class WaAssessmentEditor extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._wrap = this.shadowRoot.querySelector(".wrap");
		this._viewId = null;
		this._onChange = () => this._render();
		this._elementSignature = null;
		this._onXmlChange = () => {
			// Only when the list of elements changes (the pickers are built from it).
			const sig = this._elements().map((e) => `${e.id}:${e.tag}`).join("|");
			if (sig !== this._elementSignature) this._render();
		};
	}

	connectedCallback() {
		assessmentStore.addEventListener("change", this._onChange);
		xmlStore.addEventListener("change", this._onXmlChange);
		this._render();
	}

	disconnectedCallback() {
		assessmentStore.removeEventListener("change", this._onChange);
		xmlStore.removeEventListener("change", this._onXmlChange);
	}

	setViewId(id) {
		if (this._viewId === id) return;
		this._viewId = id;
		this._render();
	}

	// ── Helpers ───────────────────────────────────────────────────────────
	_elements() {
		const out = [];
		const walk = (n) => {
			if (n.attributes.id) out.push({ id: n.attributes.id, tag: n.tagName });
			n.children.forEach(walk);
		};
		if (xmlStore.root) walk(xmlStore.root);
		return out;
	}

	_attributesOf(tag, elementId) {
		const names = new Set();
		const schemaAttrs = xmlStore.schema?.elements[tag]?.allowedAttributes || [];
		schemaAttrs.filter((a) => isNumericAttributeSchema(a)).forEach((a) => names.add(a.name));
		const node = this._findNode(elementId);
		if (node) Object.keys(node.attributes).forEach((k) => k !== "id" && names.add(k));
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	_findNode(elementId) {
		const walk = (n) => {
			if (n.attributes.id === elementId) return n;
			for (const c of n.children) {
				const f = walk(c);
				if (f) return f;
			}
			return null;
		};
		return xmlStore.root ? walk(xmlStore.root) : null;
	}

	_update(fn) {
		const current = assessmentStore.get(this._viewId);
		if (!current) return;
		assessmentStore.set(this._viewId, fn(JSON.parse(JSON.stringify(current))));
	}

	_el(tag, props = {}, ...children) {
		const el = document.createElement(tag);
		Object.entries(props).forEach(([k, v]) => {
			if (k === "text") el.textContent = v;
			else if (k === "class") el.className = v;
			else if (k in el) el[k] = v;
			else el.setAttribute(k, v);
		});
		children.forEach((c) => c && el.appendChild(c));
		return el;
	}

	_number(value, onCommit, { step = "any", min } = {}) {
		const input = this._el("input", { type: "number", step });
		if (min !== undefined) input.min = String(min);
		input.value = Number.isFinite(value) ? String(value) : "";
		input.addEventListener("change", () => {
			const n = parseFloat(input.value);
			onCommit(Number.isFinite(n) ? n : undefined);
		});
		return input;
	}

	_select(options, value, onCommit, labels = {}) {
		const select = this._el("select");
		options.forEach((o) => select.appendChild(this._el("option", { value: o, text: labels[o] ?? o })));
		select.value = value;
		select.addEventListener("change", () => onCommit(select.value));
		return select;
	}

	// ── Rendering ─────────────────────────────────────────────────────────
	_render() {
		this._elementSignature = this._elements().map((e) => `${e.id}:${e.tag}`).join("|");
		this._wrap.innerHTML = "";
		if (!this._viewId) return;
		const a = assessmentStore.get(this._viewId);

		const check = this._el("label", { class: "check" });
		const box = this._el("input", { type: "checkbox", checked: !!a });
		box.addEventListener("change", () => {
			if (box.checked) assessmentStore.set(this._viewId, { max: 10, pass: 0.6, reveal: "distance", criteria: [], bands: DEFAULT_BANDS.map((b) => ({ ...b })) });
			else assessmentStore.remove(this._viewId);
		});
		check.append(box, this._el("span", { text: "Assess this view — the viewer shows a Done button" }));
		this._wrap.appendChild(check);

		if (!a) {
			this._wrap.appendChild(this._el("div", { class: "off", text: "Not assessed: the page is just something to play with." }));
			return;
		}

		const general = this._el("div", { class: "row" });
		general.append(
			this._field("Points", this._number(a.max, (v) => this._update((x) => ({ ...x, max: v ?? 10 })), { min: 0 })),
			this._field(
				"Pass at (%)",
				this._number(Number.isFinite(a.pass) ? Math.round(a.pass * 100) : undefined, (v) => this._update((x) => {
					if (v === undefined) delete x.pass;
					else x.pass = Math.max(0, Math.min(1, v / 100));
					return x;
				}))
			),
			this._field("Comments give", this._select(REVEAL_MODES, a.reveal || "distance", (v) => this._update((x) => ({ ...x, reveal: v })), REVEAL_LABELS))
		);
		this._wrap.appendChild(general);
		this._wrap.appendChild(this._el("div", { class: "hint", text: "No pass level: pressing Done is enough to count as done. The points follow the score either way." }));

		this._wrap.appendChild(this._el("h4", { text: "Criteria" }));
		(a.criteria || []).forEach((c, i) => this._wrap.appendChild(this._buildCriterion(c, i)));
		const add = this._el("button", { type: "button", text: "+ Add criterion" });
		add.addEventListener("click", () =>
			this._update((x) => {
				x.criteria = [...(x.criteria || []), { id: `c${(x.criteria || []).length + 1}`, label: "", weight: 1, type: "match", a: {}, b: {}, scale: "linear", full: 0, zero: 1 }];
				return x;
			})
		);
		this._wrap.appendChild(add);

		this._wrap.appendChild(this._el("h4", { text: "Overall comment, by result" }));
		(a.bands || []).forEach((b, i) => this._wrap.appendChild(this._buildBand(b, i)));
		const addBand = this._el("button", { type: "button", text: "+ Add" });
		addBand.addEventListener("click", () => this._update((x) => ({ ...x, bands: [...(x.bands || []), { min: 0, text: "" }] })));
		this._wrap.appendChild(addBand);

		const problems = problemsWith(a);
		if (problems.length) this._wrap.appendChild(this._el("div", { class: "problems", text: problems.join(" · ") }));
	}

	_field(label, control) {
		return this._el("label", { class: "field" }, this._el("span", { text: label }), control);
	}

	_buildBand(band, index) {
		const row = this._el("div", { class: "row" });
		row.append(
			this._field("From (%)", this._number(Math.round((band.min ?? 0) * 100), (v) => this._update((x) => {
				x.bands[index].min = Math.max(0, Math.min(1, (v ?? 0) / 100));
				return x;
			}))),
			(() => {
				const t = this._el("input", { type: "text", value: band.text || "", placeholder: "Comment" });
				t.style.flex = "1 1 14rem";
				t.addEventListener("change", () => this._update((x) => {
					x.bands[index].text = t.value;
					return x;
				}));
				return t;
			})()
		);
		const del = this._el("button", { class: "icon", type: "button", text: "×", title: "Remove" });
		del.addEventListener("click", () => this._update((x) => {
			x.bands.splice(index, 1);
			return x;
		}));
		row.appendChild(del);
		return row;
	}

	_buildCriterion(c, index) {
		const box = this._el("div", { class: "criterion" });
		const head = this._el("div", { class: "criterion-head" });
		const label = this._el("input", { type: "text", value: c.label || "", placeholder: "Name (shown in the comments)" });
		label.addEventListener("change", () => this._update((x) => {
			x.criteria[index].label = label.value;
			return x;
		}));
		const type = this._select(CRITERION_TYPES, c.type, (v) => this._update((x) => {
			x.criteria[index] = this._retype(x.criteria[index], v);
			return x;
		}), TYPE_LABELS);
		const del = this._el("button", { class: "icon", type: "button", text: "×", title: "Remove this criterion" });
		del.addEventListener("click", () => this._update((x) => {
			x.criteria.splice(index, 1);
			return x;
		}));
		head.append(label, type, this._field("Weight", this._number(c.weight ?? 1, (v) => this._update((x) => {
			x.criteria[index].weight = v ?? 1;
			return x;
		}), { min: 0 })), this._el("span", { class: "spacer" }), del);
		box.appendChild(head);

		const setRead = (key) => (read) => this._update((x) => {
			x.criteria[index][key] = read;
			return x;
		});
		switch (c.type) {
			case "match":
				box.append(this._readPicker("Value", c.a, setRead("a")), this._readPicker("should match", c.b, setRead("b")));
				break;
			case "target":
				box.append(
					this._readPicker("Value", c.a, setRead("a")),
					this._el("div", { class: "read" }, this._el("span", { class: "read-label", text: "target" }), this._number(c.target, (v) => this._update((x) => {
						x.criteria[index].target = v;
						return x;
					})))
				);
				break;
			case "range":
				box.append(
					this._readPicker("Value", c.a, setRead("a")),
					this._el("div", { class: "read" },
						this._el("span", { class: "read-label", text: "within" }),
						this._number(c.min, (v) => this._update((x) => { x.criteria[index].min = v; return x; })),
						this._el("span", { text: "to" }),
						this._number(c.max, (v) => this._update((x) => { x.criteria[index].max = v; return x; })))
				);
				break;
			case "relation":
				box.append(
					this._readPicker("Value", c.a, setRead("a")),
					this._readPicker("minus", c.b, setRead("b")),
					this._el("div", { class: "read" }, this._el("span", { class: "read-label", text: "should be" }), this._number(c.target ?? 0, (v) => this._update((x) => {
						x.criteria[index].target = v ?? 0;
						return x;
					})))
				);
				break;
			case "spread":
				(c.of || []).forEach((read, i) => {
					const picker = this._readPicker(i === 0 ? "Values" : "", read, (r) => this._update((x) => {
						x.criteria[index].of[i] = r;
						return x;
					}));
					const rm = this._el("button", { class: "icon", type: "button", text: "×", title: "Remove" });
					rm.addEventListener("click", () => this._update((x) => {
						x.criteria[index].of.splice(i, 1);
						return x;
					}));
					picker.appendChild(rm);
					box.appendChild(picker);
				});
				const addRead = this._el("button", { type: "button", text: "+ value" });
				addRead.addEventListener("click", () => this._update((x) => {
					x.criteria[index].of = [...(x.criteria[index].of || []), {}];
					return x;
				}));
				box.appendChild(addRead);
				break;
		}

		const tol = this._el("div", { class: "row" });
		const unit = c.scale === "log2" ? " octaves" : "";
		tol.append(
			this._field("Compare as", this._select(SCALES, c.scale || "linear", (v) => this._update((x) => {
				x.criteria[index].scale = v;
				return x;
			}), SCALE_LABELS)),
			this._field(`Full score within${unit}`, this._number(c.full ?? 0, (v) => this._update((x) => {
				x.criteria[index].full = v ?? 0;
				return x;
			}), { min: 0 })),
			this._field(`No score from${unit}`, this._number(c.zero, (v) => this._update((x) => {
				x.criteria[index].zero = v;
				return x;
			}), { min: 0 }))
		);
		box.appendChild(tol);
		if (c.scale === "log2") box.appendChild(this._el("div", { class: "hint", text: "1 octave = a doubling. 0.1 octave is about 7 % in frequency, a little more than a semitone." }));
		return box;
	}

	// Changing a criterion's type keeps what still fits.
	_retype(c, type) {
		const next = { ...c, type };
		if (type === "spread") next.of = c.of || [c.a || {}, c.b || {}];
		if (type === "match" || type === "relation") {
			next.a = c.a || (c.of && c.of[0]) || {};
			next.b = c.b || (c.of && c.of[1]) || {};
		}
		if (type === "target" || type === "range") next.a = c.a || (c.of && c.of[0]) || {};
		return next;
	}

	// Element + attribute (+ unit) of one value of the document.
	_readPicker(label, read, onCommit) {
		const r = read || {};
		const row = this._el("div", { class: "read" });
		row.appendChild(this._el("span", { class: "read-label", text: label }));
		const elements = this._elements();
		const elSelect = this._el("select");
		elSelect.appendChild(this._el("option", { value: "", text: "— element —" }));
		elements.forEach((e) => elSelect.appendChild(this._el("option", { value: e.id, text: `${e.tag} #${e.id}` })));
		if (r.ref && !elements.some((e) => e.id === r.ref)) elSelect.appendChild(this._el("option", { value: r.ref, text: `#${r.ref} (missing)` }));
		elSelect.value = r.ref || "";
		const node = r.ref ? this._findNode(r.ref) : null;
		const attrSelect = this._el("select");
		attrSelect.appendChild(this._el("option", { value: "", text: "— attribute —" }));
		const attrs = node ? this._attributesOf(node.tagName, r.ref) : [];
		attrs.forEach((a) => attrSelect.appendChild(this._el("option", { value: a, text: a })));
		if (r.attr && !attrs.includes(r.attr)) attrSelect.appendChild(this._el("option", { value: r.attr, text: r.attr }));
		attrSelect.value = r.attr || "";
		const asSelect = this._select(["number", "db"], r.as === "db" ? "db" : "number", (v) => onCommit({ ...r, as: v === "db" ? "db" : undefined }), { number: "as is", db: "in dB" });
		elSelect.addEventListener("change", () => onCommit({ ref: elSelect.value || undefined, attr: undefined, as: r.as }));
		attrSelect.addEventListener("change", () => onCommit({ ...r, attr: attrSelect.value || undefined }));
		row.append(elSelect, attrSelect, asSelect);
		return row;
	}
}

customElements.define("wa-assessment-editor", WaAssessmentEditor);
