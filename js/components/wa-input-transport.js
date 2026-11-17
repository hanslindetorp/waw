import { inputSources } from "../state/input-sources.js";
import { inputTransport } from "../input/input-transport.js";
import { inputView } from "../input/input-view.js";

// The INPUT panel's play bar, at the top above the sections: PLAY / pause, STOP,
// the time, the length in seconds, loop, a bar to scrub along the whole length and
// the zoom of the waveforms. One for everything time-based — the data rows and, in
// time, a video — so they always run together (see input/input-transport.js, with
// the zoom in input/input-view.js). It shows itself while a section has something to
// play (inputTransport.use()).
//
// Its settings (the length and loop) are project content, saved in inputs.json
// under "transport" (getProject()/applyProject() — see project/inputs-store.js).

function formatTime(seconds) {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.85rem/1.4 system-ui, sans-serif;
			padding: 0.6rem 0.75rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		:host([hidden]) {
			display: none;
		}
		.bar {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem 0.5rem;
		}
		button, input {
			font-family: inherit;
		}
		.btn {
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			background: #1a1c1f;
			color: var(--waw-fg, #e8e8e8);
			cursor: pointer;
			font-size: 0.75rem;
			padding: 0.28rem 0.6rem;
			line-height: 1.1;
		}
		.btn:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.btn.active {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.12);
		}
		.play-btn {
			min-width: 2.2rem;
			font-size: 0.9rem;
		}
		.time {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.74rem;
			min-width: 7.5rem;
		}
		.length {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.length input {
			width: 3.6rem;
			background: #111;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			color: var(--waw-fg, #e8e8e8);
			font-size: 0.74rem;
			padding: 0.2rem 0.3rem;
		}
		.length input:disabled {
			opacity: 0.5;
		}
		.zoom {
			margin-left: auto;
			display: inline-flex;
			align-items: center;
			gap: 0.2rem;
		}
		.scrub {
			width: 100%;
			margin: 0.5rem 0 0;
			accent-color: var(--waw-accent, #4fa3ff);
		}
	</style>
	<div class="bar">
		<button class="btn play-btn" type="button" title="Play / pause">▶</button>
		<button class="btn stop-btn" type="button" title="Stop and go to the start">■</button>
		<span class="time">0:00.0 / 0:10.0</span>
		<label class="length" title="How long a data file takes to play (a video sets this itself)">Length <input class="length-input" type="number" min="0.1" step="0.5" value="10" /> s</label>
		<button class="btn loop-btn active" type="button" title="Loop">Loop</button>
		<span class="zoom">
			<button class="btn zoom-out" type="button" title="Zoom out">−</button>
			<button class="btn zoom-in" type="button" title="Zoom in (Ctrl/⌘ + wheel in a waveform also zooms)">+</button>
			<button class="btn zoom-fit" type="button" title="Show everything">Fit</button>
		</span>
	</div>
	<input class="scrub" type="range" min="0" max="10000" value="0" title="Position" />
`;

export class WaInputTransport extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);
		this._playBtn = $(".play-btn");
		this._timeEl = $(".time");
		this._lengthInput = $(".length-input");
		this._loopBtn = $(".loop-btn");
		this._scrub = $(".scrub");
		this._onState = () => this._syncState();
		this._onTick = () => this._syncTime();
	}

	connectedCallback() {
		inputTransport.addEventListener("state", this._onState);
		inputTransport.addEventListener("tick", this._onTick);
		inputSources.register("transport", this);
		this._playBtn.addEventListener("click", () => inputTransport.toggle());
		this.shadowRoot.querySelector(".stop-btn").addEventListener("click", () => inputTransport.stop());
		this._loopBtn.addEventListener("click", () => {
			inputTransport.setLoop(!inputTransport.loop);
			this._dispatchStateChange();
		});
		this._lengthInput.addEventListener("change", () => {
			inputTransport.setDuration(this._lengthInput.value);
			this._syncState();
			this._dispatchStateChange();
		});
		this._scrub.addEventListener("input", () => inputTransport.seekFraction(this._scrub.value / 10000));
		this.shadowRoot.querySelector(".zoom-in").addEventListener("click", () => inputView.zoom(2));
		this.shadowRoot.querySelector(".zoom-out").addEventListener("click", () => inputView.zoom(0.5));
		this.shadowRoot.querySelector(".zoom-fit").addEventListener("click", () => inputView.fit());
		this._syncState();
	}

	disconnectedCallback() {
		inputTransport.removeEventListener("state", this._onState);
		inputTransport.removeEventListener("tick", this._onTick);
		inputSources.unregister("transport", this);
	}

	// ── Persistence (inputs.json → "transport") ──────────────────────────
	// null when no section uses the transport, so a project without time-based
	// inputs keeps no trace of it.
	getProject() {
		if (!inputTransport.inUse) return null;
		return { version: 1, duration: inputTransport.hasTimebase ? this._savedDuration || inputTransport.duration : inputTransport.duration, loop: inputTransport.loop };
	}

	applyProject(project) {
		if (!project || typeof project !== "object") return;
		if (project.duration > 0) {
			this._savedDuration = project.duration;
			inputTransport.setDuration(project.duration);
		}
		if (typeof project.loop === "boolean") inputTransport.setLoop(project.loop);
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	_syncState() {
		const t = inputTransport;
		this.hidden = !t.inUse;
		this._playBtn.textContent = t.playing ? "❚❚" : "▶";
		this._loopBtn.classList.toggle("active", t.loop);
		this._lengthInput.disabled = t.hasTimebase;
		if (this.shadowRoot.activeElement !== this._lengthInput) this._lengthInput.value = String(+t.duration.toFixed(3));
		this._syncTime();
	}

	_syncTime() {
		const t = inputTransport;
		this._timeEl.textContent = `${formatTime(t.position)} / ${formatTime(t.duration)}`;
		if (this.shadowRoot.activeElement !== this._scrub) this._scrub.value = String(Math.round(t.fraction * 10000));
	}
}

customElements.define("wa-input-transport", WaInputTransport);
