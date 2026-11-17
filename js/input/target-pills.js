import { xmlStore } from "../xml-editor/xml-store.js";
import { inputMapMode } from "../state/input-map-mode.js";

// What every INPUT row has in common once it measures something: a list of
// targets — one pill per parameter (or root <Var>) it drives, click a pill to
// point it somewhere else, × to remove it, and a "Map..." that adds another.
// Shared by the camera rows (wa-webcam-input.js) and the data rows
// (wa-data-input.js); the rows themselves differ, this part does not.
//
// A mapping is { varName, direct?, inputVar?, invert?, mode? }: `invert` turns the value it
// sends upside down (1 − value; on top of the row's own invert, so both together cancel) and
// `mode` says what it sends instead of the plain value: "d1" | "d2" | "d3" (the 1st–3rd
// derivative, 0.5 = not changing) or "gate" (0 | 1) — see mappingOutput. A target made straight onto a
// parameter (direct) is fed through the hidden variable `inputVar` its <Var>
// reads (see xml-editor/input-mapping.js); a root <Var> target is fed under a
// name the row makes up (its syntheticName) and gets "value=$thatName" written
// onto it.

export const TARGET_PILL_CSS = `
	.targets {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
	}
	.sv-map-btn {
		background: none;
		border: 1px dashed var(--waw-border, #2f2f2f);
		border-radius: 4px;
		color: var(--waw-muted, #8a8a8a);
		font-size: 0.65rem;
		font-family: inherit;
		padding: 0.1rem 0.35rem;
		cursor: pointer;
		white-space: nowrap;
	}
	.sv-map-btn:hover {
		border-color: var(--waw-accent, #4fa3ff);
		color: var(--waw-accent, #4fa3ff);
	}
	/* Whichever button/pill armed input-map-mode.js just now — the same yellow
	   ring every valid target uses (see wa-var-knobs.js's own comment on why the
	   @keyframes is declared again per shadow root). */
	@keyframes target-armed-blink {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(250, 204, 21, 0);
		}
		50% {
			box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.55);
		}
	}
	.sv-map-btn.armed,
	.sv-tool.armed,
	.sv-mapped.armed {
		border-style: solid;
		border-color: #facc15;
		color: #facc15;
		animation: target-armed-blink 0.9s ease-in-out infinite;
	}
	.sv-mapped {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: rgba(79, 163, 255, 0.15);
		border: 1px solid var(--waw-accent, #4fa3ff);
		border-radius: 4px;
		color: var(--waw-accent, #4fa3ff);
		font-size: 0.65rem;
		font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		padding: 0.1rem 0.3rem;
		cursor: pointer;
		white-space: nowrap;
	}
	.sv-unmap {
		background: none;
		border: none;
		color: inherit;
		cursor: pointer;
		padding: 0;
		font-size: 0.8rem;
		line-height: 1;
		opacity: 0.7;
	}
	.sv-unmap:hover {
		opacity: 1;
	}
	.sv-mapped.selected {
		background: rgba(79, 163, 255, 0.3);
		box-shadow: 0 0 0 2px var(--waw-accent, #4fa3ff);
	}
	.sv-tools {
		flex: 1 0 100%;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.25rem;
		padding: 0.15rem 0;
	}
	.sv-tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.7rem;
		height: 1.5rem;
		padding: 0 0.3rem;
		background: #1a1c1f;
		border: 1.5px solid var(--waw-border, #2f2f2f);
		border-radius: 5px;
		color: var(--waw-muted, #8a8a8a);
		cursor: pointer;
		font: italic 0.8rem/1 Georgia, "Times New Roman", serif;
	}
	.sv-tool:hover {
		border-color: var(--waw-accent, #4fa3ff);
	}
	.sv-tool.on {
		border-color: var(--waw-teal, #45b58c);
		color: var(--waw-teal, #45b58c);
		background: rgba(69, 181, 140, 0.14);
	}
	.sv-tool-sep {
		width: 1px;
		align-self: stretch;
		background: var(--waw-border, #2f2f2f);
		margin: 0 0.1rem;
	}
	.sv-flags {
		font: italic 0.7rem/1 Georgia, "Times New Roman", serif;
		opacity: 0.85;
	}
`;

export function mappingFromPick(detail) {
	return detail.direct ? { varName: detail.varName, direct: true, inputVar: detail.inputVar } : { varName: detail.varName };
}

// Writes "$syntheticName" onto the root <Var> `targetVarName`'s own "value" —
// the explicit XML-visible counterpart to the variable a row pushes. wa-var-
// knobs.js's pushFromTarget keeps that Var's live value following along.
export function writeVarReference(targetVarName, syntheticName) {
	if (!xmlStore.root) return;
	const targetNode = xmlStore.root.children.find((c) => c.tagName === "Var" && (c.attributes.name || c.attributes.id) === targetVarName);
	if (!targetNode) return;
	xmlStore.updateAttributes(targetNode.id, { ...targetNode.attributes, value: `$${syntheticName}` });
}

// Arms input-map-mode.js (the "arm a mode, let some other element claim the
// next click" shape var-map-mode.js uses) and calls onPick(detail) when a
// parameter or a root <Var> knob is picked. `anchorEl` shows the armed ring
// meanwhile; onDisarm() runs when the mode ends, picked or not.
export function armMapping(anchorEl, onPick, onDisarm) {
	if (inputMapMode.armed) inputMapMode.disarm(); // re-arming for a different anchor — see the "change" cleanup below
	inputMapMode.arm();
	anchorEl.classList.add("armed");
	const pick = (e) => onPick(e.detail);
	const onChange = () => {
		if (inputMapMode.armed) return;
		inputMapMode.removeEventListener("pick", pick);
		inputMapMode.removeEventListener("change", onChange);
		anchorEl.classList.remove("armed");
		onDisarm?.();
	};
	inputMapMode.addEventListener("pick", pick);
	inputMapMode.addEventListener("change", onChange);
}

// What a mapping sends for a row's value `norm` (0–1, after the row's own invert): the value
// itself, or — with `mode` — its derivative (`derivative(mode)` hands the row's own, 0–1 with
// 0.5 as "not changing") or a gate (0 | 1: on above 0.55, off below 0.45, so a value hovering
// at the edge does not flutter); then turned upside down when the mapping is inverted.
// undefined when there is nothing to send.
const gates = new WeakMap();
export function mappingOutput(mapping, norm, derivative) {
	let v = norm;
	if (mapping.mode === "d1" || mapping.mode === "d2" || mapping.mode === "d3") {
		v = derivative?.(mapping.mode);
	} else if (mapping.mode === "gate") {
		const on = gates.get(mapping) ? norm > 0.45 : norm >= 0.55;
		gates.set(mapping, on);
		v = on ? 1 : 0;
	}
	if (v === undefined || !Number.isFinite(v)) return undefined;
	return mapping.invert ? 1 - v : v;
}

const svg = (inner) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TOOLS = {
	invert: {
		html: svg('<path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5"/>'),
		title: "Invert this target — it gets 1 − the value. Together with the row's own invert, the two cancel."
	},
	d1: { html: "f′", title: "Send the 1st derivative — how fast the value changes, 0.5 when it stands still, up when it rises, down when it falls (0–1)", mode: "d1" },
	d2: { html: "f″", title: "Send the 2nd derivative — how fast the change itself changes (0.5 = steady) (0–1)", mode: "d2" },
	d3: { html: "f‴", title: "Send the 3rd derivative (0.5 = steady) (0–1)", mode: "d3" },
	gate: {
		html: svg('<path d="M1.5 12h3V4h4v8h3V4h3" />'),
		title: "Send a gate instead of the value: 1 while the value is high (above about half), otherwise 0",
		mode: "gate"
	},
	remap: {
		html: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>'),
		title: "Point this target at another parameter — click it, then click the parameter"
	}
};
const FLAGS = { invert: "⇅", d1: "′", d2: "″", d3: "‴", gate: "⊓" };

// Fills `wrap` with the pills of `entry.mappings`. `syntheticName(index)` is the
// name a root-<Var> target of this row is fed under; `onChange()` is told after
// every change (add, remap, remove, a setting of a target). `armFn` is the row owner's
// armMapping, so it can do its own clean-up when the mode ends.
//
// `features` are the settings a target can be given, among "invert", "d1", "d2", "d3" and "gate".
// With none, a click on a pill points it somewhere else (as before). With some, a click selects
// the pill (blue frame) and a row of buttons shows up for it — the features, and "remap" — and
// a click elsewhere puts it away again.
export function renderTargetPills(wrap, entry, { syntheticName, onChange, armFn = armMapping, features = [] }) {
	const opts = { syntheticName, onChange, armFn, features };
	const rerender = () => renderTargetPills(wrap, entry, opts);
	wrap.innerHTML = "";
	const afterAdded = (mapping, index) => {
		if (!mapping.direct) writeVarReference(mapping.varName, syntheticName(index));
	};
	const select = (mapping) => {
		wrap._selected = mapping;
		wrap._away?.();
		if (!mapping) return;
		// A press anywhere else (not while a target is being picked) puts the tools away.
		const away = (e) => {
			if (!wrap.isConnected || wrap._selected !== mapping) {
				document.removeEventListener("pointerdown", away, true);
				return;
			}
			if (inputMapMode.armed || e.composedPath().includes(wrap)) return;
			document.removeEventListener("pointerdown", away, true);
			wrap._selected = null;
			wrap._away = null;
			rerender();
		};
		document.addEventListener("pointerdown", away, true);
		wrap._away = () => document.removeEventListener("pointerdown", away, true);
	};
	let tools = null;
	entry.mappings.forEach((mapping, index) => {
		const selectable = features.length > 0;
		const pill = document.createElement("span");
		pill.className = "sv-mapped" + (selectable && wrap._selected === mapping ? " selected" : "");
		pill.title = selectable ? "Click to select — settings for this target show up" : "Click to remap";
		const nameSpan = document.createElement("span");
		nameSpan.textContent = mapping.varName;
		nameSpan.addEventListener("click", (e) => {
			// Without this, the very click that arms input-map-mode.js keeps
			// bubbling to document, where its "unclaimed click disarms" listener
			// would immediately undo the arm.
			e.stopPropagation();
			if (selectable) {
				select(wrap._selected === mapping ? null : mapping);
				rerender();
				return;
			}
			armFn(pill, (detail) => {
				const next = mappingFromPick(detail);
				entry.mappings[index] = next;
				afterAdded(next, index);
				rerender();
				onChange();
			});
		});
		pill.appendChild(nameSpan);
		if (selectable) {
			const flags = [mapping.invert && FLAGS.invert, mapping.mode && FLAGS[mapping.mode]].filter(Boolean).join("");
			if (flags) {
				const f = document.createElement("span");
				f.className = "sv-flags";
				f.textContent = flags;
				pill.appendChild(f);
			}
		}
		const xBtn = document.createElement("button");
		xBtn.type = "button";
		xBtn.className = "sv-unmap";
		xBtn.textContent = "×";
		xBtn.title = "Unmap";
		xBtn.addEventListener("click", () => {
			if (wrap._selected === mapping) select(null);
			entry.mappings.splice(index, 1);
			rerender();
			onChange();
		});
		pill.appendChild(xBtn);
		wrap.appendChild(pill);

		if (selectable && wrap._selected === mapping) {
			tools = document.createElement("div");
			tools.className = "sv-tools";
			const tool = (key, on, handler) => {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "sv-tool" + (on ? " on" : "");
				b.innerHTML = TOOLS[key].html;
				b.title = TOOLS[key].title;
				b.setAttribute("aria-label", TOOLS[key].title);
				b.addEventListener("click", (e) => {
					e.stopPropagation();
					handler(b);
				});
				tools.appendChild(b);
				return b;
			};
			features.forEach((key) => {
				if (key === "invert") {
					tool("invert", !!mapping.invert, () => {
						if (mapping.invert) delete mapping.invert;
						else mapping.invert = true;
						rerender();
						onChange();
					});
				} else {
					tool(key, mapping.mode === key, () => {
						if (mapping.mode === key) delete mapping.mode;
						else mapping.mode = key;
						rerender();
						onChange();
					});
				}
			});
			const sep = document.createElement("span");
			sep.className = "sv-tool-sep";
			tools.appendChild(sep);
			tool("remap", false, (b) =>
				armFn(b, (detail) => {
					const next = { ...mappingFromPick(detail) };
					if (mapping.invert) next.invert = true;
					if (mapping.mode) next.mode = mapping.mode;
					entry.mappings[index] = next;
					afterAdded(next, index);
					select(next);
					rerender();
					onChange();
				})
			);
		}
	});
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "sv-map-btn";
	btn.textContent = "Map...";
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		armFn(btn, (detail) => {
			const mapping = mappingFromPick(detail);
			entry.mappings.push(mapping);
			afterAdded(mapping, entry.mappings.length - 1);
			rerender();
			onChange();
		});
	});
	wrap.appendChild(btn);
	// The tools of the selected pill sit last, on a line of their own.
	if (tools) wrap.appendChild(tools);
}
