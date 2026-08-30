import { xmlStore } from "../xml-editor/xml-store.js";
import { testPattern } from "../xml-editor/attribute-controls.js";
import { applyLiveProperty } from "../waxml-integration/live-property.js";
import { parseGainAttributeToDb, isDbNativeGain, dbToLinearRatio } from "../waxml-integration/gain-units.js";
import { getAttributeCurve } from "../xml-editor/attribute-curves.js";

// Nudges the live audio graph (if currently playing and this node survived
// into it) to match a value just edited here — same "also move the
// currently-sounding audio, xmlStore stays the source of truth" side
// channel wa-mixer-view's own knobs/faders already use for their own edits
// (see applyLiveProperty), so dragging *this* slider is just as live, per
// Hans. Most attributes share their unit with the live Web Audio param
// they drive, so the raw parsed number just passes straight through —
// `gain` is the one that needs converting first: the XML attribute is
// either a 0-1 linear ratio or a "-XdB"/bare-number-dB string depending on
// the node (see gain-units.js), but only some node types' *live* gain
// param is natively linear (GainNode/Send) — a BiquadFilterNode's is
// natively dB (see wa-mixer-view.js's own applyLiveGainDb, same rule).
// A union attribute's free-text edit mode (_renderStringControl, reached
// via _renderUnionControl's pencil cycle) used to validate a typed value
// against only the ONE member currently cycled to — so e.g. typing a bare
// number, or a "$var" math expression, into gain's "-XdB" string mode
// showed a false-positive red ✗, even though that value is perfectly valid
// for a *different* member of the same union (gain is a number OR a
// "-XdB" string OR a math expression — per Hans, all three should just
// work when typing, not only whichever one you happened to be cycled to).
// Builds one combined pattern covering every member's own shape instead,
// so "is this a legal value for this attribute at all" is what gets
// validated, not "does it match this specific representation of it".
// Returns null (skip validation entirely) if any member is a fully
// unconstrained string, since the union then accepts literally anything.
function combineUnionPattern(members) {
	const parts = [];
	for (const m of members) {
		if (m.type === "number") {
			parts.push("-?\\d+(\\.\\d+)?");
		} else if (m.type === "boolean") {
			parts.push("true|false");
		} else if (m.type === "enum" && m.enumValues?.length) {
			parts.push(m.enumValues.map(escapeRegExp).join("|"));
		} else if (m.type === "string") {
			if (!m.pattern) return null;
			parts.push(m.pattern);
		}
	}
	return parts.length ? parts.map((p) => `(?:${p})`).join("|") : null;
}

function escapeRegExp(str) {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyLiveAttributeNudge(node, attrName, rawValue) {
	if (attrName === "gain") {
		const db = parseGainAttributeToDb(node.tagName, rawValue);
		applyLiveProperty(node.attributes.id, "gain", isDbNativeGain(node.tagName) ? db : dbToLinearRatio(db));
		return;
	}
	const num = parseFloat(rawValue);
	if (!Number.isFinite(num)) return; // a mathExpression form, or non-numeric — no live nudge, XML stays authoritative
	applyLiveProperty(node.attributes.id, attrName, num);
}

// When present, these always lead the attribute list, in this exact order,
// ahead of everything else (which stays alphabetical) — separated by a
// divider so the "usual suspects" are never buried in a long schema list.
const PRIORITY_ATTR_ORDER = ["label", "id", "class", "input", "output"];

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			background: #161616;
			font: 0.82rem/1.4 system-ui, sans-serif;
			overflow: auto;
		}
		.empty {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.header {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.4rem 0.75rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			font-weight: 600;
			font-size: 0.72rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--waw-muted, #8a8a8a);
		}
		.body {
			padding: 0.6rem 0.75rem;
			display: flex;
			flex-direction: column;
			gap: 0.6rem;
		}
		label.field-label {
			display: block;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			margin-bottom: 0.2rem;
		}
		input, select {
			font: inherit;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.45rem;
		}
		input:disabled, select:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.full-input {
			width: 100%;
		}
		.mono {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.attr-row {
			display: flex;
			align-items: center;
			gap: 0.4rem;
		}
		.attr-name {
			flex: 0 0 auto;
			min-width: 74px;
			font-weight: 600;
			color: var(--waw-syntax-attr-name, #f0b25c);
		}
		.attr-control {
			flex: 1 1 auto;
			display: flex;
			align-items: center;
			gap: 0.4rem;
			min-width: 0;
		}
		.attr-control input[type="text"],
		.attr-control input[type="number"],
		.attr-control select {
			flex: 1 1 auto;
			min-width: 0;
		}
		/* Custom track/thumb (was bare browser-default styling, "Safari
		   default" per Hans) — flat dark track, round accent-colored
		   thumb, no native padding eating into the ends of its own travel
		   so the thumb can actually reach both edges of the row. */
		.attr-control input[type="range"] {
			flex: 1 1 auto;
			min-width: 0;
			-webkit-appearance: none;
			appearance: none;
			width: 100%;
			height: 4px;
			margin: 0;
			padding: 0;
			background: transparent;
			cursor: pointer;
		}
		.attr-control input[type="range"]::-webkit-slider-runnable-track {
			height: 4px;
			border-radius: 2px;
			background: #2a2d31;
		}
		.attr-control input[type="range"]::-moz-range-track {
			height: 4px;
			border-radius: 2px;
			background: #2a2d31;
		}
		.attr-control input[type="range"]::-webkit-slider-thumb {
			-webkit-appearance: none;
			width: 13px;
			height: 13px;
			margin-top: -4.5px;
			border-radius: 50%;
			background: var(--waw-accent, #4fa3ff);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
		}
		.attr-control input[type="range"]::-moz-range-thumb {
			width: 13px;
			height: 13px;
			border-radius: 50%;
			background: var(--waw-accent, #4fa3ff);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
		}
		.attr-control input[type="range"]:hover::-webkit-slider-thumb {
			filter: brightness(1.15);
		}
		.attr-control input[type="range"]:focus-visible {
			outline: 2px solid var(--waw-accent, #4fa3ff);
			outline-offset: 2px;
		}
		.num-value {
			width: 4.5rem;
			flex: 0 0 auto;
			text-align: right;
		}
		.num-unit {
			flex: 0 0 auto;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.72rem;
			margin-left: -0.15rem;
		}
		.toggle-btn {
			flex: 0 0 auto;
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.15rem 0.4rem;
			font-size: 0.68rem;
			cursor: pointer;
		}
		.pencil-btn {
			font-size: 0.8rem;
			line-height: 1;
			padding: 0.2rem 0.4rem;
		}
		.pencil-btn.active {
			background: var(--waw-accent, #4fa3ff);
			color: #06131f;
			border-color: var(--waw-accent, #4fa3ff);
		}
		.attr-divider {
			border: none;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			margin: 0.4rem 0;
			width: 100%;
		}
		.remove-btn {
			flex: 0 0 auto;
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			padding: 0.1rem 0.25rem;
		}
		.remove-btn:hover {
			color: var(--waw-danger, #e5484d);
		}
		.remove-btn:disabled {
			opacity: 0.3;
			cursor: default;
		}
		.valid-ok { color: var(--waw-success, #4caf7d); flex: 0 0 auto; }
		.valid-bad { color: var(--waw-danger, #e5484d); flex: 0 0 auto; }
		.pattern-ok { border-color: var(--waw-success, #4caf7d) !important; }
		.pattern-bad { border-color: var(--waw-danger, #e5484d) !important; }

		.add-attr-row {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding-top: 0.5rem;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			flex-wrap: wrap;
		}
		.add-attr-row select,
		.add-attr-row input[name="attr-name"] {
			flex: 0 1 9rem;
			font-size: 0.75rem;
		}
		.add-attr-row input[name="attr-value"] {
			flex: 1 1 8rem;
			font-size: 0.75rem;
		}
		.add-btn {
			background: var(--waw-accent, #4fa3ff);
			color: #06131f;
			font-weight: 700;
			border: none;
			border-radius: 4px;
			padding: 0.3rem 0.5rem;
			cursor: pointer;
		}
		.add-btn:disabled {
			opacity: 0.5;
			cursor: default;
		}
		.cancel-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.75rem;
		}
	</style>
	<div class="content"></div>
`;

export class WaNodeInspector extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._content = this.shadowRoot.querySelector(".content");
	}

	connectedCallback() {
		xmlStore.addEventListener("change", () => {
			if (this._isLocalEdit) return;
			this.render();
		});
		this.render();
	}

	render() {
		this._content.innerHTML = "";
		const node = xmlStore.getSelectedNode();

		if (!node) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "Select a node to inspect";
			this._content.appendChild(empty);
			return;
		}

		const header = document.createElement("div");
		header.className = "header";
		header.textContent = "Inspector";
		this._content.appendChild(header);

		const body = document.createElement("div");
		body.className = "body";
		body.appendChild(this._renderTagNameField(node));
		const textField = this._renderTextContentField(node);
		if (textField) body.appendChild(textField);
		body.appendChild(this._renderAttributesSection(node));
		this._content.appendChild(body);
	}

	_renderTagNameField(node) {
		const wrap = document.createElement("div");
		const label = document.createElement("label");
		label.className = "field-label";
		label.textContent = "Element";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "full-input mono";
		input.value = node.tagName;

		// The root element's name isn't really a free choice when the schema
		// only declares one legal root type — renaming it would just produce
		// a document the schema itself rejects. Read-only in that case;
		// still editable without a schema (nothing to validate against) or
		// when the schema allows more than one root type.
		const isRoot = xmlStore.root && node.id === xmlStore.root.id;
		const rootOptions = xmlStore.schema?.rootElements;
		if (isRoot && rootOptions && rootOptions.length === 1) {
			input.disabled = true;
			input.title = "The schema only allows one root element type";
			wrap.appendChild(label);
			wrap.appendChild(input);
			return wrap;
		}

		// Unlike a plain attribute-value edit (deliberately kept from
		// re-rendering, see _renderAttributeRow), renaming the tag is a real
		// structural change — a different schema element means a different
		// attribute list, different allowsText, etc. — so it genuinely needs
		// a full re-render. Committing on every keystroke would tear this
		// very input down mid-typing and steal focus back to nothing, so
		// commit only on Enter/blur instead, same as the rename pattern used
		// elsewhere (wa-file-manager.js's rename, wa-xml-tree.js's
		// attribute-cell edit).
		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const newName = input.value.trim();
			if (newName && newName !== node.tagName) xmlStore.updateTagName(node.id, newName);
			else this.render();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				committed = true;
				this.render();
			}
		});
		input.addEventListener("blur", commit);

		wrap.appendChild(label);
		wrap.appendChild(input);
		return wrap;
	}

	_renderTextContentField(node) {
		const schema = xmlStore.schema;
		const schemaElement = schema?.elements[node.tagName];
		// No schema, or the element isn't in it (schemaless/manual mode for
		// that tag) -> stay permissive. Once the schema resolves the element,
		// follow it to the letter: hide the field entirely if it says no text.
		const allowsText = !schema || !schemaElement || schemaElement.allowsText;
		if (!allowsText) return null;

		const wrap = document.createElement("div");
		const label = document.createElement("label");
		label.className = "field-label";
		label.textContent = "Text Content";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "full-input";
		input.placeholder = "(empty)";
		input.value = node.textContent;
		input.addEventListener("input", () => {
			// Nothing else in the inspector's DOM depends on textContent's value
			// (only on tagName/schema), so it's safe to skip our own re-render —
			// which matters because rebuilding this input mid-keystroke would
			// otherwise steal focus back to nothing on every character typed.
			this._isLocalEdit = true;
			xmlStore.updateTextContent(node.id, input.value);
			this._isLocalEdit = false;
		});
		wrap.appendChild(label);
		wrap.appendChild(input);
		return wrap;
	}

	_renderAttributesSection(node) {
		const schema = xmlStore.schema;
		const schemaElement = schema?.elements[node.tagName];

		// With the element recognized by an active schema, the schema *is* the
		// full list of legal attributes — show every one of them (even unset),
		// so there's nothing left to pick from an "add attribute" list. Without
		// a schema (or for a tag the schema doesn't know), fall back to the
		// permissive present-attributes-only + free-form add row.
		return schema && schemaElement
			? this._renderSchemaAttributesSection(node, schemaElement)
			: this._renderFreeformAttributesSection(node);
	}

	_renderSchemaAttributesSection(node, schemaElement) {
		const wrap = document.createElement("div");
		const label = document.createElement("label");
		label.className = "field-label";
		label.textContent = "Attributes";
		wrap.appendChild(label);

		const allowedAttributes = schemaElement.allowedAttributes;
		const getAttrSchema = (name) => allowedAttributes.find((a) => a.name === name);

		const list = document.createElement("div");
		list.style.display = "flex";
		list.style.flexDirection = "column";
		list.style.gap = "0.4rem";

		const { priority, rest } = this._splitByPriority(allowedAttributes, (a) => a.name);
		priority.forEach((attrSchema) => {
			list.appendChild(this._renderAttributeRow(node, attrSchema.name, node.attributes[attrSchema.name], attrSchema));
		});
		if (priority.length > 0) list.appendChild(this._renderAttrDivider());
		rest.forEach((attrSchema) => {
			list.appendChild(this._renderAttributeRow(node, attrSchema.name, node.attributes[attrSchema.name], attrSchema));
		});

		// Defensive: surface any attribute already on the node that the schema
		// doesn't declare (e.g. hand-edited via the code panel) instead of
		// silently hiding real data.
		Object.keys(node.attributes)
			.filter((name) => !getAttrSchema(name))
			.sort((a, b) => a.localeCompare(b))
			.forEach((name) => list.appendChild(this._renderAttributeRow(node, name, node.attributes[name], undefined)));

		wrap.appendChild(list);

		// <xs:anyAttribute> alongside the fixed attribute list means the schema
		// itself declares the element open to arbitrary extra attributes — offer
		// the same free-form "add attribute" row a schemaless element would get.
		if (schemaElement.allowsAnyAttribute) {
			wrap.appendChild(this._renderAddAttributeRow(node, [], () => undefined));
		}

		return wrap;
	}

	_renderFreeformAttributesSection(node) {
		const wrap = document.createElement("div");
		const label = document.createElement("label");
		label.className = "field-label";
		label.textContent = "Attributes";
		wrap.appendChild(label);

		const list = document.createElement("div");
		list.style.display = "flex";
		list.style.flexDirection = "column";
		list.style.gap = "0.4rem";

		const { priority, rest } = this._splitByPriority(Object.entries(node.attributes), ([name]) => name);
		priority.forEach(([key, value]) => list.appendChild(this._renderAttributeRow(node, key, value, undefined)));
		if (priority.length > 0) list.appendChild(this._renderAttrDivider());
		rest.forEach(([key, value]) => list.appendChild(this._renderAttributeRow(node, key, value, undefined)));

		wrap.appendChild(list);

		wrap.appendChild(this._renderAddAttributeRow(node, [], () => undefined));
		return wrap;
	}

	// Splits `items` into [priority-ordered subset per PRIORITY_ATTR_ORDER,
	// everything else alphabetically] — shared by both the schema-driven and
	// freeform attribute lists so id/class/label/input/output (whichever of
	// them apply) always lead, in that order, ahead of the rest.
	_splitByPriority(items, getName) {
		const priority = PRIORITY_ATTR_ORDER.map((name) => items.find((item) => getName(item) === name)).filter(Boolean);
		const rest = items
			.filter((item) => !PRIORITY_ATTR_ORDER.includes(getName(item)))
			.sort((a, b) => getName(a).localeCompare(getName(b)));
		return { priority, rest };
	}

	_renderAttrDivider() {
		const hr = document.createElement("hr");
		hr.className = "attr-divider";
		return hr;
	}

	_renderAttributeRow(node, attrName, value, attrSchema) {
		const row = document.createElement("div");
		row.className = "attr-row";

		const nameSpan = document.createElement("span");
		nameSpan.className = "attr-name mono";
		nameSpan.textContent = attrName;
		row.appendChild(nameSpan);

		const control = document.createElement("div");
		control.className = "attr-control";

		const removeBtn = document.createElement("button");
		removeBtn.type = "button";
		removeBtn.className = "remove-btn";
		removeBtn.title = "Remove attribute";
		removeBtn.textContent = "✕";
		removeBtn.disabled = value === undefined;

		// Setting a value never adds/removes an attribute *row* (it's already
		// shown, per the schema-driven list above) — so there's nothing else in
		// the inspector that needs a full re-render here. Skipping it matters:
		// xmlStore's "change" event fires on every drag tick of a range slider,
		// and rebuilding that same slider mid-drag would kill the browser's
		// native drag tracking (a fresh element never receives the rest of the
		// gesture) — which is exactly the "can't drag, only click" bug. Update
		// the one bit of UI that *does* depend on the value (the remove button)
		// directly instead of relying on a re-render for it.
		const onChange = (v) => {
			this._isLocalEdit = true;
			xmlStore.updateAttributes(node.id, { ...node.attributes, [attrName]: v });
			this._isLocalEdit = false;
			removeBtn.disabled = false;
			applyLiveAttributeNudge(node, attrName, v);
		};

		if (attrSchema?.type === "boolean") {
			control.appendChild(this._renderBooleanControl(value, onChange));
		} else if (attrSchema?.type === "union") {
			control.appendChild(this._renderUnionControl(attrName, attrSchema, onChange));
		} else if (attrSchema?.enumValues && attrSchema.enumValues.length > 0) {
			control.appendChild(this._renderEnumControl(attrName, value, attrSchema, onChange));
		} else if (attrSchema?.type === "number") {
			control.appendChild(this._renderNumberWithTextToggle(attrName, attrSchema, onChange));
		} else {
			control.appendChild(this._renderStringControl(value, attrSchema, onChange));
		}

		row.appendChild(control);

		// Removal, unlike a value edit, genuinely needs the normal re-render:
		// the row itself must reset to its unset state (schema mode) or vanish
		// entirely (freeform mode).
		removeBtn.addEventListener("click", () => {
			const next = { ...node.attributes };
			delete next[attrName];
			xmlStore.updateAttributes(node.id, next);
		});
		row.appendChild(removeBtn);

		return row;
	}

	_renderBooleanControl(value, onChange) {
		const wrap = document.createElement("label");
		wrap.style.display = "flex";
		wrap.style.alignItems = "center";
		wrap.style.gap = "0.4rem";
		wrap.style.cursor = "pointer";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = value === "true";
		const text = document.createElement("span");
		text.style.color = "var(--waw-muted, #8a8a8a)";
		text.textContent = value === undefined ? "not set" : value === "true" ? "true" : "false";
		checkbox.addEventListener("change", () => {
			onChange(checkbox.checked ? "true" : "false");
			text.textContent = checkbox.checked ? "true" : "false";
		});
		wrap.appendChild(checkbox);
		wrap.appendChild(text);
		return wrap;
	}

	// A union attribute can take several otherwise-unrelated value shapes
	// (e.g. a number OR one of a fixed set of keywords OR a free-form
	// pattern-matched string) — render the current member's own normal
	// control (reusing the exact same renderers a plain, non-union attribute
	// of that type would get), with a single pencil button that cycles to the
	// next member type on click (rather than a row of mode buttons — the
	// schema decides how many modes exist and what they are, so one button
	// that steps through them scales to any number of members without adding
	// UI clutter for the common 2-member case).
	_renderUnionControl(attrName, attrSchema, onChange) {
		const members = attrSchema.unionMembers;

		const frag = document.createElement("div");
		frag.style.display = "flex";
		frag.style.alignItems = "center";
		frag.style.gap = "0.4rem";
		frag.style.flex = "1 1 auto";
		frag.style.minWidth = "0";

		const controlSlot = document.createElement("div");
		controlSlot.style.display = "flex";
		controlSlot.style.alignItems = "center";
		controlSlot.style.gap = "0.4rem";
		controlSlot.style.flex = "1 1 auto";
		controlSlot.style.minWidth = "0";

		// Re-read the live value from the store (rather than trusting a node
		// object captured at mount time) every time we pick/rebuild a member's
		// control. xmlStore.updateAttributes() rebuilds the tree immutably, so
		// a `node` reference from the last full render would keep pointing at
		// an ever-more-stale snapshot once edits stop triggering a re-render
		// (see _renderAttributeRow) — getSelectedNode() always resolves against
		// the current root.
		let activeIndex = this._detectUnionMemberIndex(members, xmlStore.getSelectedNode()?.attributes[attrName]);

		const renderActiveControl = () => {
			controlSlot.innerHTML = "";
			const currentValue = xmlStore.getSelectedNode()?.attributes[attrName];
			const detectedIndex = this._detectUnionMemberIndex(members, currentValue);
			const member = members[activeIndex];
			// Only hand the member the real current value if it's actually the
			// value's own detected type — otherwise this mode was picked by
			// cycling and should start empty rather than misrepresenting e.g. a
			// number as if it were a selected list option.
			const memberValue = detectedIndex === activeIndex ? currentValue : undefined;

			// The pencil marks itself only while showing a mode that *isn't*
			// what the stored value actually is — i.e. the user cycled away
			// from the real representation into an empty alternate one. Back
			// on the type the value naturally belongs to, it's just a normal
			// button again.
			cycleBtn.classList.toggle("active", activeIndex !== detectedIndex);

			if (member.type === "boolean") {
				controlSlot.appendChild(this._renderBooleanControl(memberValue, onChange));
			} else if (member.type === "enum") {
				controlSlot.appendChild(this._renderEnumControl(attrName, memberValue, member, onChange));
			} else if (member.type === "number") {
				controlSlot.appendChild(this._renderNumberControl(attrName, memberValue, member, onChange));
			} else {
				// Validate against the whole union's shape, not just this one
				// cycled-to member's own pattern — see combineUnionPattern.
				const combined = combineUnionPattern(members);
				const validationSchema = { ...member, pattern: combined || undefined };
				controlSlot.appendChild(this._renderStringControl(memberValue, validationSchema, onChange));
			}
		};

		const cycleBtn = this._renderPencilButton("Switch value type (schema: " + members.length + " types)", () => {
			activeIndex = (activeIndex + 1) % members.length;
			renderActiveControl();
		});

		renderActiveControl();

		frag.appendChild(controlSlot);
		frag.appendChild(cycleBtn);
		return frag;
	}

	_renderPencilButton(title, onClick) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "toggle-btn pencil-btn";
		btn.textContent = "✎";
		btn.title = title;
		btn.addEventListener("click", onClick);
		return btn;
	}

	// A plain number attribute isn't a real schema union, but still benefits
	// from the same idea: the slider is great within its min/max/step, and
	// the pencil button swaps it for a free-form text field for anything
	// outside that (no up/down arrows, no range/step clamping) — same
	// mechanism as _renderUnionControl, just with an implicit 2-member cycle
	// (number, string) instead of one declared by the schema.
	_renderNumberWithTextToggle(attrName, attrSchema, onChange) {
		const looksNumeric = (v) => v !== undefined && /^-?\d+(\.\d+)?$/.test(String(v).trim());

		const frag = document.createElement("div");
		frag.style.display = "flex";
		frag.style.alignItems = "center";
		frag.style.gap = "0.4rem";
		frag.style.flex = "1 1 auto";
		frag.style.minWidth = "0";

		const controlSlot = document.createElement("div");
		controlSlot.style.display = "flex";
		controlSlot.style.alignItems = "center";
		controlSlot.style.gap = "0.4rem";
		controlSlot.style.flex = "1 1 auto";
		controlSlot.style.minWidth = "0";

		const initialValue = xmlStore.getSelectedNode()?.attributes[attrName];
		let showText = !looksNumeric(initialValue) && initialValue !== undefined;

		const renderSlot = () => {
			controlSlot.innerHTML = "";
			const currentValue = xmlStore.getSelectedNode()?.attributes[attrName];
			// Slider is the natural mode for a numeric-looking (or unset) value;
			// text is natural for anything that doesn't parse as a number. The
			// pencil only marks itself when showing the *other* one — a
			// deliberate override — not while sitting on whichever mode the
			// value already belongs to.
			const textIsNatural = !looksNumeric(currentValue) && currentValue !== undefined;
			toggleBtn.classList.toggle("active", showText !== textIsNatural);
			controlSlot.appendChild(
				showText
					? this._renderStringControl(currentValue, attrSchema, onChange)
					: this._renderNumberControl(attrName, currentValue, attrSchema, onChange)
			);
		};

		const toggleBtn = this._renderPencilButton("Toggle slider / free text", () => {
			showText = !showText;
			renderSlot();
		});

		renderSlot();

		frag.appendChild(controlSlot);
		frag.appendChild(toggleBtn);
		return frag;
	}

	// Guesses which union member the current raw string value belongs to,
	// most-specific match first: an exact enum value, then a value that fully
	// parses as a number, then "true"/"false" for a boolean member, then a
	// string member whose pattern actually matches, then any unconstrained
	// string member — falling back to the first member for an unset value or
	// one that doesn't cleanly match anything.
	_detectUnionMemberIndex(members, value) {
		if (value === undefined) return 0;

		const enumIdx = members.findIndex((m) => m.type === "enum" && m.enumValues.includes(value));
		if (enumIdx !== -1) return enumIdx;

		const numberIdx = members.findIndex((m) => m.type === "number" && /^-?\d+(\.\d+)?$/.test(String(value).trim()));
		if (numberIdx !== -1) return numberIdx;

		const boolIdx = members.findIndex((m) => m.type === "boolean" && (value === "true" || value === "false"));
		if (boolIdx !== -1) return boolIdx;

		const patternIdx = members.findIndex((m) => m.type === "string" && m.pattern && testPattern(m.pattern, value) === true);
		if (patternIdx !== -1) return patternIdx;

		const plainStringIdx = members.findIndex((m) => m.type === "string" && !m.pattern);
		if (plainStringIdx !== -1) return plainStringIdx;

		return 0;
	}

	_renderEnumControl(attrName, value, attrSchema, onChange) {
		const hasValue = value !== undefined;
		const isNumeric = attrSchema.type === "number";
		const sorted = isNumeric
			? [...attrSchema.enumValues].sort((a, b) => parseFloat(a) - parseFloat(b))
			: [...attrSchema.enumValues].sort((a, b) => a.localeCompare(b));

		const frag = document.createElement("div");
		frag.style.display = "flex";
		frag.style.alignItems = "center";
		frag.style.gap = "0.4rem";
		frag.style.flex = "1 1 auto";
		frag.style.minWidth = "0";

		const select = document.createElement("select");
		let unsetOpt = null;
		if (!hasValue) {
			unsetOpt = document.createElement("option");
			unsetOpt.value = "__unset__";
			unsetOpt.textContent = "(not set)";
			unsetOpt.disabled = true;
			unsetOpt.selected = true;
			select.appendChild(unsetOpt);
		}
		sorted.forEach((v) => {
			const opt = document.createElement("option");
			opt.value = v;
			opt.textContent = v;
			select.appendChild(opt);
		});
		const otherOpt = document.createElement("option");
		otherOpt.value = "__other__";
		otherOpt.textContent = "Custom...";
		select.appendChild(otherOpt);

		const customInput = document.createElement("input");
		customInput.type = isNumeric ? "number" : "text";
		customInput.className = "mono";
		customInput.value = value ?? "";

		const validMark = document.createElement("span");

		// Now that a value edit no longer forces a full re-render (see
		// _renderAttributeRow), this control has to keep its own validity mark
		// current itself instead of relying on the next rebuild to recompute it.
		const updateValidity = (currentValue) => {
			const valid = currentValue === "" ? null : testPattern(attrSchema.pattern, currentValue);
			validMark.className = "";
			validMark.title = "";
			validMark.textContent = "";
			if (valid === true) {
				validMark.className = "valid-ok";
				validMark.textContent = "✓";
			} else if (valid === false) {
				validMark.className = "valid-bad";
				validMark.title = `Pattern: ${attrSchema.pattern}`;
				validMark.textContent = "✗";
			}
		};

		customInput.addEventListener("input", () => {
			onChange(customInput.value);
			updateValidity(customInput.value);
		});

		const isOther = hasValue && !sorted.includes(value);
		if (hasValue) select.value = isOther ? "__other__" : value;
		customInput.hidden = !isOther;

		select.addEventListener("change", () => {
			if (select.value === "__other__") {
				customInput.hidden = false;
				customInput.focus();
				return;
			}
			if (unsetOpt) {
				unsetOpt.remove();
				unsetOpt = null;
			}
			customInput.hidden = true;
			onChange(select.value);
			updateValidity(select.value);
		});

		updateValidity(value ?? "");

		frag.appendChild(select);
		frag.appendChild(customInput);
		frag.appendChild(validMark);
		return frag;
	}

	// The slider's own position and the attribute's real value aren't
	// necessarily the same number any more — see attribute-curves.js: gain
	// drags in dB and writes a tag-appropriate string, frequency/time-like
	// attributes drag logarithmically. curve.parse/format round-trip
	// through the XML attribute's own string form; the number input always
	// shows/edits the real value (Hz, dB, ms, ...), never the raw slider
	// position.
	_renderNumberControl(attrName, value, attrSchema, onChange) {
		const node = xmlStore.getSelectedNode();
		const curve = getAttributeCurve(attrName, node?.tagName, attrSchema.minValue, attrSchema.maxValue);
		const hasValue = value !== undefined;
		const parsed = hasValue ? curve.parse(value) : NaN;
		const isNumeric = Number.isFinite(parsed);
		const realValue = isNumeric ? parsed : curve.positionToValue(curve.sliderMin);

		const frag = document.createElement("div");
		frag.style.display = "flex";
		frag.style.alignItems = "center";
		frag.style.gap = "0.4rem";
		frag.style.flex = "1 1 auto";
		frag.style.minWidth = "0";

		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = curve.sliderMin;
		slider.max = curve.sliderMax;
		slider.step = curve.sliderStep;
		slider.value = curve.valueToPosition(realValue);

		const numberInput = document.createElement("input");
		numberInput.type = "number";
		numberInput.className = "num-value";
		numberInput.step = curve.numberStep;
		numberInput.value = isNumeric ? curve.displayRound(realValue) : "";

		// Commits on every "input" tick (not just "change" at release), per
		// Hans — safe here specifically because onChange sets _isLocalEdit
		// around its xmlStore.updateAttributes call (see below), which skips
		// this component's own re-render; other listeners (code view,
		// preview, ...) still see every intermediate value via xmlStore's
		// own "change" event, same as before.
		slider.addEventListener("input", () => {
			const v = curve.positionToValue(parseFloat(slider.value));
			numberInput.value = curve.displayRound(v);
			onChange(curve.format(v));
		});
		numberInput.addEventListener("input", () => {
			const v = parseFloat(numberInput.value);
			if (numberInput.value !== "" && Number.isFinite(v)) slider.value = curve.valueToPosition(v);
			onChange(numberInput.value === "" ? "" : curve.format(v));
		});

		frag.appendChild(slider);
		frag.appendChild(numberInput);
		// The number field only ever holds the plain real value (a native
		// <input type="number"> can't contain non-numeric text like "dB") —
		// the unit, when the curve has one, is shown as its own small label
		// right after it instead, per Hans.
		if (curve.unit) {
			const unitLabel = document.createElement("span");
			unitLabel.className = "num-unit";
			unitLabel.textContent = curve.unit;
			frag.appendChild(unitLabel);
		}
		return frag;
	}

	_renderStringControl(value, attrSchema, onChange) {
		const frag = document.createElement("div");
		frag.style.display = "flex";
		frag.style.alignItems = "center";
		frag.style.gap = "0.3rem";
		frag.style.flex = "1 1 auto";
		frag.style.minWidth = "0";

		const input = document.createElement("input");
		input.type = "text";
		input.className = "mono";
		input.style.flex = "1 1 auto";
		input.style.minWidth = "0";
		input.value = value ?? "";

		const updateValidity = () => {
			// An empty field means "not set yet" (or just cleared) rather than an
			// actual invalid value — skip pattern validation so it doesn't flash
			// a red ✗ on every still-unset schema attribute.
			const valid = input.value === "" ? null : testPattern(attrSchema?.pattern, input.value);
			input.classList.remove("pattern-ok", "pattern-bad");
			mark.className = "";
			mark.textContent = "";
			if (valid === true) {
				input.classList.add("pattern-ok");
				mark.className = "valid-ok";
				mark.textContent = "✓";
			} else if (valid === false) {
				input.classList.add("pattern-bad");
				mark.className = "valid-bad";
				mark.title = `Pattern: ${attrSchema.pattern}`;
				mark.textContent = "✗";
			}
		};

		const mark = document.createElement("span");
		input.addEventListener("input", () => {
			onChange(input.value);
			updateValidity();
		});
		updateValidity();

		frag.appendChild(input);
		frag.appendChild(mark);
		return frag;
	}

	_renderAddAttributeRow(node, unused, getAttrSchema) {
		const row = document.createElement("div");
		row.className = "add-attr-row";
		const hasChoices = unused.length > 0;
		let showCustomName = false;

		const select = document.createElement("select");
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = "Add attribute...";
		placeholder.disabled = true;
		placeholder.selected = true;
		select.appendChild(placeholder);
		unused.forEach((name) => {
			const opt = document.createElement("option");
			opt.value = name;
			opt.textContent = name;
			select.appendChild(opt);
		});
		const otherOpt = document.createElement("option");
		otherOpt.value = "__custom__";
		otherOpt.textContent = "Other...";
		select.appendChild(otherOpt);
		select.hidden = !hasChoices;

		const nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.className = "mono";
		nameInput.placeholder = "Attribute name";
		nameInput.hidden = hasChoices;

		const valueInput = document.createElement("input");
		valueInput.type = "text";
		valueInput.className = "mono";
		valueInput.placeholder = "Value";

		const addBtn = document.createElement("button");
		addBtn.type = "button";
		addBtn.className = "add-btn";
		addBtn.textContent = "+";
		addBtn.disabled = true;

		const cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className = "cancel-btn";
		cancelBtn.textContent = "Cancel";
		cancelBtn.hidden = true;

		const currentName = () => (showCustomName || !hasChoices ? nameInput.value : select.value);
		const refreshAddBtn = () => {
			addBtn.disabled = !currentName().trim();
		};

		select.addEventListener("change", () => {
			if (select.value === "__custom__") {
				showCustomName = true;
				select.hidden = true;
				nameInput.hidden = false;
				cancelBtn.hidden = false;
				nameInput.value = "";
				nameInput.focus();
				refreshAddBtn();
				return;
			}
			const attrSchema = getAttrSchema(select.value);
			if (attrSchema?.defaultValue) valueInput.value = attrSchema.defaultValue;
			else if (attrSchema?.type === "boolean") valueInput.value = "false";
			else if (attrSchema?.type === "number") valueInput.value = String(attrSchema.minValue ?? 0);
			else if (attrSchema?.enumValues?.[0]) valueInput.value = attrSchema.enumValues[0];
			refreshAddBtn();
		});
		nameInput.addEventListener("input", refreshAddBtn);

		const submit = () => {
			const name = currentName().trim();
			if (!name) return;
			xmlStore.updateAttributes(node.id, { ...node.attributes, [name]: valueInput.value });
		};
		addBtn.addEventListener("click", submit);
		valueInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		cancelBtn.addEventListener("click", () => {
			showCustomName = false;
			select.hidden = false;
			select.value = "";
			nameInput.hidden = true;
			nameInput.value = "";
			cancelBtn.hidden = true;
			refreshAddBtn();
		});

		row.appendChild(select);
		row.appendChild(nameInput);
		row.appendChild(valueInput);
		row.appendChild(addBtn);
		row.appendChild(cancelBtn);

		return row;
	}
}

customElements.define("wa-node-inspector", WaNodeInspector);
