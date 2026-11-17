import { xmlStore } from "../xml-editor/xml-store.js";
import { inputMapMode } from "../state/input-map-mode.js";

// What every INPUT row has in common once it measures something: a list of
// targets — one pill per parameter (or root <Var>) it drives, click a pill to
// point it somewhere else, × to remove it, and a "Map..." that adds another.
// Shared by the camera rows (wa-webcam-input.js) and the data rows
// (wa-data-input.js); the rows themselves differ, this part does not.
//
// A mapping is { varName, direct?, inputVar? }: a target made straight onto a
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

// Fills `wrap` with the pills of `entry.mappings`. `syntheticName(index)` is the
// name a root-<Var> target of this row is fed under; `onChange()` is told after
// every change (add, remap, remove). `armFn` is the row owner's armMapping, so
// it can do its own clean-up when the mode ends.
export function renderTargetPills(wrap, entry, { syntheticName, onChange, armFn = armMapping }) {
	wrap.innerHTML = "";
	const afterAdded = (mapping, index) => {
		if (!mapping.direct) writeVarReference(mapping.varName, syntheticName(index));
	};
	entry.mappings.forEach((mapping, index) => {
		const pill = document.createElement("span");
		pill.className = "sv-mapped";
		pill.title = "Click to remap";
		const nameSpan = document.createElement("span");
		nameSpan.textContent = mapping.varName;
		nameSpan.addEventListener("click", (e) => {
			// Without this, the very click that arms input-map-mode.js keeps
			// bubbling to document, where its "unclaimed click disarms" listener
			// would immediately undo the arm.
			e.stopPropagation();
			armFn(pill, (detail) => {
				const next = mappingFromPick(detail);
				entry.mappings[index] = next;
				afterAdded(next, index);
				renderTargetPills(wrap, entry, { syntheticName, onChange, armFn });
				onChange();
			});
		});
		const xBtn = document.createElement("button");
		xBtn.type = "button";
		xBtn.className = "sv-unmap";
		xBtn.textContent = "×";
		xBtn.title = "Unmap";
		xBtn.addEventListener("click", () => {
			entry.mappings.splice(index, 1);
			renderTargetPills(wrap, entry, { syntheticName, onChange, armFn });
			onChange();
		});
		pill.append(nameSpan, xBtn);
		wrap.appendChild(pill);
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
			renderTargetPills(wrap, entry, { syntheticName, onChange, armFn });
			onChange();
		});
	});
	wrap.appendChild(btn);
}
