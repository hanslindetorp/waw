import { vfs } from "../vfs/VFS.js";
import { showToast } from "../ui/toast.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { isPreviewableAudioFile } from "./wa-file-preview.js";
import "./wa-chain-view.js";
import "./wa-mixer-view.js";
import { SLOTS, ATTRIBUTES, OSCILLATOR_WAVES, DEFAULT_INSTRUCTION, slotAttributes, editableKey, elementId, chainId } from "../tasks/ab-matching.js";
import { createAbTask, taskOfView, syncAbTask, setEditable, updateTaskMeta, readStrip, markChanged, deleteAbTask, readDocumentValue, resetAttribute, clearRange } from "../tasks/ab-task.js";

// File > Create task...: sets up an "A/B matching" task (js/tasks/ab-matching.js)
// the way an author sets up anything in the workstation — by turning the real
// controls, not by filling in numbers. Steps: the sound; what the student sees
// (the full channel strip or separate objects); which objects; and then the
// set-up itself, with a tab for A and one for B: on A the author sets the
// reference — what is changed there is what the student has to find and is
// marked adjustable automatically, with a "rnd" button for a range the target
// may be drawn from — and on B the values it starts from and what the student
// may adjust. The task exists in the project from the end of the third step
// and every turn of a control is a normal, undoable edit of it. Per Hans
// (2026-10-30).

const WAVE_LABELS = { sine: "Sine", triangle: "Triangle", square: "Square", sawtooth: "Sawtooth" };
const RANGE_SLOT_HINT = "Click rnd, then turn the control: the values you sweep over become the range the target is drawn from.";

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host { display: block; }
		:host([hidden]) { display: none; }
		.backdrop {
			position: fixed;
			inset: 0;
			z-index: 100;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(0, 0, 0, 0.6);
		}
		.dialog {
			display: flex;
			flex-direction: column;
			width: min(62rem, 96vw);
			max-height: 94vh;
			background: var(--waw-panel-bg, #1a1a1a);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 10px;
			overflow: hidden;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
			color: var(--waw-fg, #e8e8e8);
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.dialog-header {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.6rem 0.9rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			font: 600 0.8rem/1.2 system-ui, sans-serif;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}
		.close-btn {
			background: none;
			border: none;
			color: inherit;
			font-size: 1rem;
			line-height: 1;
			cursor: pointer;
			padding: 0.2rem 0.4rem;
			border-radius: 4px;
		}
		.close-btn:hover { background: rgba(255, 255, 255, 0.08); }
		.steps { display: flex; gap: 1.2rem; padding: 0.5rem 1.1rem; border-bottom: 1px solid var(--waw-border, #2f2f2f); color: var(--waw-muted, #8a8a8a); font-size: 0.78rem; }
		.steps span.current { color: var(--waw-fg, #e8e8e8); font-weight: 600; }
		.body { flex: 1 1 auto; overflow: auto; padding: 0.9rem 1.1rem; min-height: 18rem; }
		h3 { margin: 0 0 0.35rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--waw-muted, #8a8a8a); }
		.hint { color: var(--waw-muted, #8a8a8a); font-size: 0.78rem; }
		section { margin-bottom: 1rem; }
		input[type="text"], input[type="number"], textarea, select {
			font: inherit;
			color: inherit;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.3rem 0.45rem;
			box-sizing: border-box;
		}
		input[type="text"], textarea { width: 100%; }
		textarea { min-height: 3.6rem; resize: vertical; }
		.choice { display: block; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 6px; padding: 0.55rem 0.7rem; margin-bottom: 0.45rem; cursor: pointer; }
		.choice.on { border-color: rgba(79, 163, 255, 0.6); background: rgba(79, 163, 255, 0.08); }
		.choice.disabled { opacity: 0.45; cursor: default; }
		.choice-head { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
		.choice-sub { margin: 0.4rem 0 0 1.6rem; }
		.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; }
		.cards .choice { margin: 0; padding: 0.9rem; }
		.cards .choice-head { font-size: 1rem; }
		.parts { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: 0.45rem; }
		/* the set-up */
		.setup-bar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.7rem; flex-wrap: wrap; }
		.tabs { display: flex; gap: 2px; }
		.tab { font: inherit; font-weight: 600; min-width: 3.4rem; color: var(--waw-muted, #8a8a8a); background: #232323; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 6px 6px 0 0; padding: 0.35rem 0.9rem; cursor: pointer; }
		.tab.active { color: #06131f; background: var(--waw-accent, #4fa3ff); border-color: var(--waw-accent, #4fa3ff); }
		.spacer { flex: 1 1 auto; }
		.listen button.on { background: var(--waw-accent, #4fa3ff); color: #06131f; border-color: var(--waw-accent, #4fa3ff); }
		.setup-main { display: flex; flex-wrap: wrap; gap: 0.9rem; align-items: flex-start; }
		.controls { flex: 1 1 16rem; display: flex; flex-wrap: wrap; gap: 0.7rem; align-items: flex-start; }
		.controls wa-chain-view { width: 250px; flex: 0 0 auto; }
		.attrs { flex: 0 0 19rem; max-width: 100%; box-sizing: border-box; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 6px; padding: 0.55rem 0.65rem; }
		.attr-group { margin-bottom: 0.6rem; }
		.attr-group-name { font-weight: 600; margin-bottom: 0.2rem; }
		.attr-row { display: grid; grid-template-columns: 1.1rem 1fr auto; gap: 0.1rem 0.45rem; align-items: center; padding: 0.15rem 0; }
		.attr-row .range { grid-column: 2 / 4; color: var(--waw-teal, #45b58c); font-size: 0.76rem; }
		.attr-value { color: var(--waw-muted, #8a8a8a); font-size: 0.78rem; margin-left: 0.4rem; }
		.rnd { font: inherit; font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 4px; border: 1px solid var(--waw-border, #2f2f2f); background: #232323; color: inherit; cursor: pointer; }
		.rnd.armed { border-color: #e0b040; color: #e0b040; animation: rnd-blink 0.7s ease-in-out infinite; }
		.rnd.has { color: var(--waw-teal, #45b58c); border-color: var(--waw-teal, #45b58c); }
		@keyframes rnd-blink { 50% { background: rgba(224, 176, 64, 0.35); } }
		.mark { color: var(--waw-teal, #45b58c); }
		.report { margin-top: 0.8rem; border-radius: 6px; padding: 0.55rem 0.7rem; background: #101010; border: 1px solid var(--waw-border, #2f2f2f); }
		.report .ok { color: var(--waw-teal, #45b58c); }
		.report .bad { color: var(--waw-danger, #e5484d); }
		.report div + div { margin-top: 0.2rem; }
		.footer { flex: 0 0 auto; display: flex; gap: 0.5rem; padding: 0.65rem 1.1rem; border-top: 1px solid var(--waw-border, #2f2f2f); }
		.footer .grow { flex: 1 1 auto; }
		button.action { font: inherit; color: inherit; background: #2a2a2a; border: 1px solid var(--waw-border, #2f2f2f); border-radius: 5px; padding: 0.35rem 0.9rem; cursor: pointer; }
		button.action.primary { background: var(--waw-accent, #4fa3ff); border-color: var(--waw-accent, #4fa3ff); color: #06131f; font-weight: 600; }
		button.action.danger:hover { border-color: var(--waw-danger, #e5484d); color: var(--waw-danger, #e5484d); }
		button.action:disabled { opacity: 0.4; cursor: default; }
		[hidden] { display: none !important; }
	</style>
	<div class="backdrop">
		<div class="dialog">
			<div class="dialog-header">
				<span>Create task — A/B matching</span>
				<button class="close-btn" type="button" title="Close">✕</button>
			</div>
			<div class="steps"></div>
			<div class="body">
				<div class="pane" data-pane="sound">
					<section>
						<h3>Title and instruction</h3>
						<input class="title" type="text" placeholder="Title" />
						<textarea class="instruction" placeholder="Instruction"></textarea>
					</section>
					<section>
						<h3>Sound</h3>
						<div class="sources"></div>
					</section>
				</div>
				<div class="pane" data-pane="display">
					<h3>What does the student see?</h3>
					<div class="cards">
						<label class="choice" data-display="strip">
							<div class="choice-head"><input type="radio" name="display" value="strip" />Full channel strip</div>
							<div class="hint" style="margin-top:0.4rem">The whole strip as in the Mixer — filters, pan, volume — of which the student may adjust what you decide.</div>
						</label>
						<label class="choice" data-display="objects">
							<div class="choice-head"><input type="radio" name="display" value="objects" />Separate objects</div>
							<div class="hint" style="margin-top:0.4rem">Just the parts you choose next, such as a peaking filter or the volume, each on its own.</div>
						</label>
					</div>
				</div>
				<div class="pane" data-pane="objects">
					<h3>Which objects?</h3>
					<div class="hint" style="margin-bottom:0.5rem">The student sees these, and you set them up in the next step.</div>
					<div class="parts"></div>
				</div>
				<div class="pane" data-pane="setup">
					<div class="setup-bar">
						<div class="tabs">
							<button class="tab" type="button" data-tab="a">A</button>
							<button class="tab" type="button" data-tab="b">B</button>
						</div>
						<span class="hint tab-hint"></span>
						<span class="spacer"></span>
						<span class="listen">
							<button class="action" type="button" data-listen="a">Listen A</button>
							<button class="action" type="button" data-listen="b">Listen B</button>
							<button class="action" type="button" data-listen="stop" title="Stop">■</button>
						</span>
					</div>
					<div class="setup-main">
						<div class="controls"></div>
						<div class="attrs"></div>
					</div>
					<div class="setup-bar" style="margin-top:0.8rem">
						<label>Marking <select class="strictness">
							<option value="strict">Strict</option>
							<option value="medium">Medium</option>
							<option value="forgiving">Forgiving</option>
						</select></label>
					</div>
					<div class="report"></div>
				</div>
			</div>
			<div class="footer">
				<button class="action danger delete" type="button" hidden>Delete task</button>
				<span class="grow"></span>
				<button class="action back" type="button">Back</button>
				<button class="action primary next" type="button">Next</button>
			</div>
		</div>
	</div>
`;

export class WaTaskDialog extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		this._steps = $(".steps");
		this._title = $(".title");
		this._instruction = $(".instruction");
		this._sources = $(".sources");
		this._partsBox = $(".parts");
		this._controls = $(".controls");
		this._attrs = $(".attrs");
		this._report = $(".report");
		this._strictness = $(".strictness");
		this._tabHint = $(".tab-hint");
		this._back = $(".back");
		this._next = $(".next");
		this._delete = $(".delete");
		this._spec = null;
		this._step = "sound";
		this._flow = [];
		this._viewId = null;
		this._tab = "a";
		this._armed = null; // the rnd button waiting for a control to be turned
		this._running = false; // the task's sound is on
		this._listening = null;
		this._before = {};
		this._scheduled = false;
		this._onXmlChange = () => this._onDocumentChange();
		this._onPointerUp = () => this._finishRandom();
		this._onKeyDown = (e) => {
			if (e.key === "Escape" && !this.hidden) this.close();
		};
	}

	connectedCallback() {
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		$(".close-btn").addEventListener("click", () => this.close());
		this._back.addEventListener("click", () => this._go(-1));
		this._next.addEventListener("click", () => this._go(1));
		this._delete.addEventListener("click", () => this._deleteTask());
		this._title.addEventListener("input", () => (this._spec.title = this._title.value));
		this._instruction.addEventListener("input", () => (this._spec.instruction = this._instruction.value));
		this.shadowRoot.querySelectorAll('input[name="display"]').forEach((r) =>
			r.addEventListener("change", () => {
				this._spec.display = r.value;
				this._renderChoices();
			})
		);
		this.shadowRoot.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => this._switchTab(t.dataset.tab)));
		this.shadowRoot.querySelectorAll("[data-listen]").forEach((b) => b.addEventListener("click", () => this._listen(b.dataset.listen)));
		this._strictness.addEventListener("change", () => {
			if (this._viewId) this._report_(updateTaskMeta(this._viewId, { strictness: this._strictness.value }));
		});
		document.addEventListener("keydown", this._onKeyDown);
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
		this._unwatch();
	}

	// ── opening ──
	open() {
		this._viewId = null;
		this._spec = { title: "Match the sound", instruction: DEFAULT_INSTRUCTION, source: { kind: "file", src: "", wave: "sine", frequency: 220 }, display: "objects", slots: new Set(["peaking"]) };
		this._title.value = this._spec.title;
		this._instruction.value = this._spec.instruction;
		this._goTo("sound");
		this.hidden = false;
	}

	// Edit the set-up of an existing task (its Stage view).
	openFor(viewId) {
		const meta = taskOfView(viewId);
		if (!meta) return;
		this._viewId = viewId;
		this._spec = null;
		this._tab = "a";
		this._goTo("setup");
		this.hidden = false;
	}

	close() {
		this._stopSound();
		this._unwatch();
		this.hidden = true;
	}

	// ── steps ──
	_flowFor() {
		if (this._viewId) return ["setup"];
		return this._spec.display === "objects" ? ["sound", "display", "objects", "setup"] : ["sound", "display", "setup"];
	}

	_goTo(step) {
		this._step = step;
		this._flow = this._flowFor();
		this.shadowRoot.querySelectorAll(".pane").forEach((p) => (p.hidden = p.dataset.pane !== step));
		const names = { sound: "Sound", display: "What is shown", objects: "Objects", setup: "Set up A and B" };
		this._steps.innerHTML = this._flow.map((s) => `<span class="${s === step ? "current" : ""}">${names[s]}</span>`).join("");
		if (step === "sound") this._renderSources();
		if (step === "display" || step === "objects") this._renderChoices();
		if (step === "setup") this._enterSetup();
		else this._unwatch();
		this._updateFooter();
	}

	_go(direction) {
		const i = this._flow.indexOf(this._step);
		if (direction > 0) {
			if (this._step === "sound" && this._spec.source.kind === "file" && !this._spec.source.src) {
				showToast("Choose a sound file first (add one in the File Manager if there is none).", { kind: "warning" });
				return;
			}
			if (this._step === "objects" && !this._spec.slots.size) {
				showToast("Choose at least one object.", { kind: "warning" });
				return;
			}
			if (this._flow[i + 1] === "setup" && !this._viewId) {
				if (!this._createTask()) return;
			}
			if (i + 1 < this._flow.length) this._goTo(this._flow[i + 1]);
			else this.close(); // Done
		} else if (i > 0 && !(this._flow[i] === "setup" && this._viewId && this._spec)) {
			this._goTo(this._flow[i - 1]);
		}
	}

	_updateFooter() {
		const i = this._flow.indexOf(this._step);
		const atSetup = this._step === "setup";
		this._back.hidden = atSetup || i === 0;
		this._next.textContent = atSetup ? "Done" : "Next";
		this._delete.hidden = !(atSetup && this._viewId);
	}

	// ── step: sound ──
	_renderSources() {
		const spec = this._spec;
		this._sources.innerHTML = "";
		const files = vfs.allFiles().filter(isPreviewableAudioFile);
		const make = (kind, label, sub) => {
			const box = document.createElement("label");
			box.className = `choice${spec.source.kind === kind ? " on" : ""}`;
			const head = document.createElement("div");
			head.className = "choice-head";
			const radio = document.createElement("input");
			radio.type = "radio";
			radio.name = "source";
			radio.checked = spec.source.kind === kind;
			radio.addEventListener("change", () => {
				spec.source.kind = kind;
				this._renderSources();
			});
			head.append(radio, document.createTextNode(label));
			box.appendChild(head);
			if (sub && spec.source.kind === kind) {
				const wrap = document.createElement("div");
				wrap.className = "choice-sub";
				wrap.appendChild(sub);
				box.appendChild(wrap);
			}
			return box;
		};
		const fileSelect = document.createElement("select");
		files.forEach((node) => {
			const opt = document.createElement("option");
			opt.value = vfs.getExportPath(node.id);
			opt.textContent = opt.value;
			fileSelect.appendChild(opt);
		});
		if (files.length) {
			if (!files.some((n) => vfs.getExportPath(n.id) === spec.source.src)) spec.source.src = vfs.getExportPath(files[0].id);
			fileSelect.value = spec.source.src;
		}
		fileSelect.disabled = !files.length;
		fileSelect.addEventListener("change", () => (spec.source.src = fileSelect.value));
		const fileSub = document.createElement("div");
		fileSub.appendChild(fileSelect);
		if (!files.length) {
			const hint = document.createElement("div");
			hint.className = "hint";
			hint.textContent = "There is no audio file in the project yet — add one in the File Manager first.";
			fileSub.appendChild(hint);
		}
		this._sources.appendChild(make("file", "A sound from the project", fileSub));
		this._sources.appendChild(make("noise", "Noise", null));
		const waveSelect = document.createElement("select");
		OSCILLATOR_WAVES.forEach((w) => {
			const opt = document.createElement("option");
			opt.value = w;
			opt.textContent = WAVE_LABELS[w];
			waveSelect.appendChild(opt);
		});
		waveSelect.value = spec.source.wave;
		waveSelect.addEventListener("change", () => (spec.source.wave = waveSelect.value));
		const freqInput = document.createElement("input");
		freqInput.type = "number";
		freqInput.min = "20";
		freqInput.max = "20000";
		freqInput.step = "any";
		freqInput.style.width = "6rem";
		freqInput.value = spec.source.frequency;
		freqInput.title = "Frequency in Hz";
		freqInput.addEventListener("input", () => {
			const f = Number(freqInput.value);
			if (Number.isFinite(f) && f > 0) spec.source.frequency = Math.min(20000, Math.max(20, f));
		});
		const oscSub = document.createElement("div");
		oscSub.style.cssText = "display:flex;align-items:center;gap:0.5rem";
		oscSub.append(waveSelect, freqInput, document.createTextNode("Hz"));
		this._sources.appendChild(make("oscillator", "A tone (oscillator)", oscSub));
		if (xmlStore.root?.children.some((c) => c.tagName === "Composition")) {
			const later = document.createElement("div");
			later.className = "choice disabled";
			later.innerHTML = `<div class="choice-head"><input type="radio" disabled />A Section of this project's Composition</div><div class="hint" style="margin:0.3rem 0 0 1.6rem">Coming later — for matching the balance between the tracks of a mix.</div>`;
			this._sources.appendChild(later);
		}
	}

	// ── steps: display and objects ──
	_renderChoices() {
		const spec = this._spec;
		this.shadowRoot.querySelectorAll("[data-display]").forEach((el) => {
			const on = el.dataset.display === spec.display;
			el.classList.toggle("on", on);
			el.querySelector("input").checked = on;
		});
		this._partsBox.innerHTML = "";
		Object.entries(SLOTS).forEach(([slot, def]) => {
			const label = document.createElement("label");
			label.className = `choice${spec.slots.has(slot) ? " on" : ""}`;
			label.style.margin = "0";
			const head = document.createElement("div");
			head.className = "choice-head";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = spec.slots.has(slot);
			cb.addEventListener("change", () => {
				if (cb.checked) spec.slots.add(slot);
				else spec.slots.delete(slot);
				this._renderChoices();
			});
			head.append(cb, document.createTextNode(def.label));
			label.appendChild(head);
			this._partsBox.appendChild(label);
		});
		this._flow = this._flowFor();
		this._goStepsOnly(); // the step list follows the choice
	}

	_goStepsOnly() {
		const names = { sound: "Sound", display: "What is shown", objects: "Objects", setup: "Set up A and B" };
		this._steps.innerHTML = this._flow.map((s) => `<span class="${s === this._step ? "current" : ""}">${names[s]}</span>`).join("");
	}

	// The task exists from here on.
	_createTask() {
		const spec = this._spec;
		const slots = spec.display === "strip" ? Object.keys(SLOTS) : [...spec.slots];
		const result = createAbTask({
			title: spec.title.trim() || "Match the sound",
			instruction: spec.instruction.trim() || DEFAULT_INSTRUCTION,
			source: { ...spec.source },
			display: spec.display,
			slots
		});
		if (result.error) {
			showToast(result.error, { kind: "warning" });
			return false;
		}
		this._viewId = result.viewId;
		this._tab = "a";
		document.getElementById("stagePanel")?.toggleCollapse(false);
		return true;
	}

	_deleteTask() {
		if (!this._viewId) return;
		this._stopSound();
		this._unwatch();
		deleteAbTask(this._viewId);
		this._viewId = null;
		this.hidden = true;
		showToast("The task was deleted.", { kind: "info" });
	}

	// ── step: set up A and B ──
	_enterSetup() {
		const meta = taskOfView(this._viewId);
		if (!meta) return;
		this._strictness.value = meta.strictness || "medium";
		this._before = readStrip(meta, "a");
		xmlStore.addEventListener("change", this._onXmlChange);
		window.addEventListener("pointerup", this._onPointerUp, true);
		this._switchTab(this._tab || "a");
	}

	_unwatch() {
		xmlStore.removeEventListener("change", this._onXmlChange);
		window.removeEventListener("pointerup", this._onPointerUp, true);
		this._armed = null;
	}

	_switchTab(tab) {
		this._tab = tab;
		this._armed = null;
		this.shadowRoot.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
		this._tabHint.textContent =
			tab === "a" ? "Set A the way it should sound. What you change here is what the student has to find." : "Set the values B starts from, and tick what the student may adjust.";
		this._renderControls();
		this._renderAttrs();
		this._runSelfTest();
		if (this._running) this._listen(tab);
	}

	// The real controls of A or B — cards bound to the document.
	_renderControls() {
		const meta = taskOfView(this._viewId);
		this._controls.innerHTML = "";
		if (!meta) return;
		if (meta.display === "strip") {
			// the whole strip, with every control live
			const strip = document.createElement("wa-mixer-view");
			strip.style.width = "220px";
			strip.style.flex = "0 0 auto";
			this._controls.appendChild(strip);
			const keys = meta.slots.flatMap((slot) => slotAttributes(slot).map((attr) => `${elementId(meta.prefix, this._tab, slot)}.${attr}`));
			strip.setEmbeddedStrip(chainId(meta.prefix, this._tab), keys);
			return;
		}
		meta.slots.forEach((slot) => {
			const card = document.createElement("wa-chain-view");
			this._controls.appendChild(card);
			card.setCardNode(elementId(meta.prefix, this._tab, slot), { editable: null, publicLabels: true });
		});
	}

	_valueText(attr, value) {
		if (!Number.isFinite(value)) return "–";
		if (attr === "frequency") return `${Math.round(value)} Hz`;
		if (attr === "gain") return `${value.toFixed(1)} dB`;
		return value.toFixed(2);
	}

	// The list at the side: for each object, its attributes with their values;
	// on A the mark for "the student finds this" and the rnd button with its range,
	// on B a box for "the student may adjust this".
	_renderAttrs() {
		const meta = taskOfView(this._viewId);
		this._attrs.innerHTML = "";
		if (!meta) return;
		const onA = this._tab === "a";
		meta.slots.forEach((slot) => {
			const group = document.createElement("div");
			group.className = "attr-group";
			const name = document.createElement("div");
			name.className = "attr-group-name";
			name.textContent = SLOTS[slot].label;
			group.appendChild(name);
			slotAttributes(slot).forEach((attr) => {
				const key = editableKey(slot, attr);
				const editable = meta.editable.includes(key);
				const row = document.createElement("div");
				row.className = "attr-row";
				const lead = document.createElement("span");
				if (onA) {
					lead.className = "mark";
					lead.textContent = editable ? "✓" : "";
					if (editable) {
						lead.title = "The student has to find this. Click to reset it and take it out of the task.";
						lead.style.cursor = "pointer";
						lead.addEventListener("click", () => {
							this._report_(resetAttribute(this._viewId, slot, attr), true);
							this._before = readStrip(taskOfView(this._viewId), "a");
						});
					}
				} else {
					const cb = document.createElement("input");
					cb.type = "checkbox";
					cb.checked = editable;
					cb.title = "The student may adjust this";
					cb.addEventListener("change", () => this._report_(setEditable(this._viewId, slot, attr, cb.checked), true));
					lead.appendChild(cb);
				}
				const label = document.createElement("span");
				const value = readDocumentValue(elementId(meta.prefix, this._tab, slot), attr, attr === "gain" ? "db" : "number");
				label.append(ATTRIBUTES[attr].label);
				const v = document.createElement("span");
				v.className = "attr-value";
				v.textContent = this._valueText(attr, value);
				label.appendChild(v);
				row.append(lead, label);
				if (onA) {
					const rnd = document.createElement("button");
					rnd.type = "button";
					rnd.className = "rnd";
					const range = meta.ranges?.[key];
					rnd.classList.toggle("armed", this._armed?.key === key);
					rnd.classList.toggle("has", !!range);
					rnd.textContent = "rnd";
					rnd.title = range ? "A random target is drawn from this range. Click to take it away." : this._armed?.key === key ? "Turn the control, or click to cancel." : RANGE_SLOT_HINT;
					rnd.addEventListener("click", () => {
						if (range && this._armed?.key !== key) {
							this._report_(clearRange(this._viewId, key), true);
							return;
						}
						this._arm(slot, attr, key);
					});
					row.appendChild(rnd);
					if (range) {
						const r = document.createElement("span");
						r.className = "range";
						r.textContent = `random ${this._valueText(attr, range.min)} … ${this._valueText(attr, range.max)}`;
						row.appendChild(r);
					}
				} else {
					row.appendChild(document.createElement("span"));
				}
				group.appendChild(row);
			});
			this._attrs.appendChild(group);
		});
	}

	// ── rnd: the range a target is drawn from ──
	_arm(slot, attr, key) {
		if (this._armed?.key === key) {
			this._armed = null;
		} else {
			const meta = taskOfView(this._viewId);
			const ref = elementId(meta.prefix, "a", slot);
			this._armed = { key, slot, attr, ref, started: false, min: 0, max: 0, last: readDocumentValue(ref, attr, attr === "gain" ? "db" : "number") };
		}
		this._renderAttrs();
	}

	// While armed, the values the control passes through are the range.
	_trackRandom() {
		const a = this._armed;
		if (!a) return;
		const value = readDocumentValue(a.ref, a.attr, a.attr === "gain" ? "db" : "number");
		if (!Number.isFinite(value) || value === a.last) return;
		if (!a.started) {
			a.started = true;
			a.min = Math.min(a.last, value);
			a.max = Math.max(a.last, value);
		} else {
			a.min = Math.min(a.min, value);
			a.max = Math.max(a.max, value);
		}
		a.last = value;
	}

	_finishRandom() {
		const a = this._armed;
		if (!a || !a.started) return;
		const meta = taskOfView(this._viewId);
		this._armed = null;
		if (!meta) return;
		this._report_(updateTaskMeta(this._viewId, { ranges: { ...(meta.ranges || {}), [a.key]: { min: a.min, max: a.max } } }));
		this._renderAttrs();
	}

	// ── following the document ──
	_onDocumentChange() {
		if (this._tab === "a") this._trackRandom();
		if (this._scheduled) return;
		this._scheduled = true;
		setTimeout(() => {
			this._scheduled = false;
			if (this.hidden || this._step !== "setup") return;
			if (this._tab === "a") this._before = markChanged(this._viewId, this._before);
			this._renderAttrs();
			this._runSelfTest();
		}, 30);
	}

	_runSelfTest() {
		this._report_(syncAbTask(this._viewId));
	}

	_report_(test, rerender = false) {
		if (!test) return;
		const lines = [];
		test.problems.forEach((p) => lines.push(`<div class="bad">✕ ${p}</div>`));
		if (test.ok) {
			lines.push(`<div class="ok">✓ B set exactly to A gives full marks (${test.facit.score} of ${test.facit.max}).</div>`);
			lines.push(`<div class="ok">✓ B as it starts does not pass (${test.start.score} of ${test.start.max}).</div>`);
		}
		this._report.innerHTML = lines.join("");
		if (rerender) this._renderAttrs();
	}

	// ── listening, to hear what is being set up ──
	_command(id) {
		const walk = (n) => {
			if (n.attributes.id === id) return n;
			for (const c of n.children) {
				const f = walk(c);
				if (f) return f;
			}
			return null;
		};
		return xmlStore.root ? walk(xmlStore.root) : null;
	}

	_listen(which) {
		const meta = taskOfView(this._viewId);
		if (!meta) return;
		if (which === "stop") {
			this._stopSound();
			return;
		}
		if (!this._running) {
			const start = this._command(`${meta.prefix}-start`);
			if (start) playerStore.runCommand(start);
			this._running = true;
		}
		const cmd = this._command(`${meta.prefix}-listen-${which}`);
		if (cmd) playerStore.runCommand(cmd);
		this._listening = which;
		this._markListen();
	}

	_stopSound() {
		const meta = this._viewId ? taskOfView(this._viewId) : null;
		if (meta && this._running) {
			const stop = this._command(`${meta.prefix}-stop`);
			if (stop) playerStore.runCommand(stop);
		}
		this._running = false;
		this._listening = null;
		this._markListen();
	}

	_markListen() {
		this.shadowRoot.querySelectorAll("[data-listen]").forEach((b) => b.classList.toggle("on", b.dataset.listen === this._listening));
	}
}

customElements.define("wa-task-dialog", WaTaskDialog);
