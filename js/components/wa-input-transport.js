import { inputSources } from "../state/input-sources.js";
import { inputTransport, MAX_RATE, MIN_RATE } from "../input/input-transport.js";
import { inputView } from "../input/input-view.js";
import { wireKnobDrag } from "../utils/knob-drag.js";

// The INPUT panel's play bar, at the top above the sections: PLAY / pause, STOP, loop, the
// speed (a knob, ½× to 2×), the position, the length at that speed, a bar to scrub along
// the whole length and the zoom of the waveforms. One for everything time-based — the data
// rows and a video — so they always run together (see input/input-transport.js, with the
// zoom in input/input-view.js). It shows itself while a section has something to play
// (inputTransport.use()).
//
// Its settings (the length, loop and speed) are project content, saved in inputs.json under
// "transport" (getProject()/applyProject() — see project/inputs-store.js). The zoom is not:
// it is only how the waveforms are looked at.

function formatTime(seconds) {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

// The speed on a 0–1 knob: logarithmic, so that the middle is normal speed and ½× and 2× are
// the same distance from it.
const rateToKnob = (rate) => (Math.log2(rate) - Math.log2(MIN_RATE)) / (Math.log2(MAX_RATE) - Math.log2(MIN_RATE));
const knobToRate = (t) => 2 ** (Math.log2(MIN_RATE) + t * (Math.log2(MAX_RATE) - Math.log2(MIN_RATE)));
const SNAP = 0.03; // a speed this close to 1× is 1×

const svg = (inner) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
	loop: svg('<path d="M3 8a5 5 0 0 1 8.6-3.4L13 6M13 2.8V6h-3.2"/><path d="M13 8a5 5 0 0 1-8.6 3.4L3 10M3 13.2V10h3.2"/>'),
	zoomIn: svg('<circle cx="6.8" cy="6.8" r="4.6"/><path d="M10.2 10.2L14 14M4.8 6.8h4M6.8 4.8v4"/>'),
	zoomOut: svg('<circle cx="6.8" cy="6.8" r="3.2"/><path d="M9.3 9.3L14 14M5.4 6.8h2.8"/>'),
	fit: svg('<path d="M2 5h11M10 2.2L13 5l-3 2.8"/><path d="M14 11H3M6 8.2L3 11l3 2.8"/>')
};

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
		.bar + .bar {
			margin-top: 0.45rem;
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
		.btn.icon {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 2rem;
			height: 1.9rem;
			padding: 0;
		}
		.play-btn {
			font-size: 0.9rem;
		}
		.rate {
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
		}
		.rate-knob {
			position: relative;
			width: 26px;
			height: 26px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #52565c, #17191c 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
			cursor: ns-resize;
			touch-action: none;
		}
		.rate-knob:hover {
			filter: brightness(1.2);
		}
		.rate-knob:disabled {
			cursor: default;
			opacity: 0.4;
		}
		.rate-dial {
			position: absolute;
			left: 50%;
			top: 2px;
			width: 2px;
			height: 45%;
			margin-left: -1px;
			background: #f2f2f2;
			border-radius: 1px;
			transform-origin: center bottom;
			pointer-events: none;
		}
		.rate-value {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.68rem;
			color: var(--waw-muted, #8a8a8a);
			min-width: 2.4rem;
		}
		.time {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
			margin-left: 0.2rem;
		}
		.length {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.length input {
			width: 3.8rem;
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
		<button class="btn icon play-btn" type="button" title="Play / pause" aria-label="Play / pause">▶</button>
		<button class="btn icon stop-btn" type="button" title="Stop and go to the start" aria-label="Stop">■</button>
		<button class="btn icon loop-btn active" type="button" title="Loop" aria-label="Loop">${ICONS.loop}</button>
		<span class="rate">
			<span class="rate-knob" role="slider" aria-label="Speed" aria-valuemin="0.5" aria-valuemax="2" title="Speed, ½× to 2× (double-click for normal speed). It changes how long everything takes to play."><span class="rate-dial"></span></span>
			<span class="rate-value">1.00×</span>
		</span>
		<span class="time" title="Where we are">0:00.0</span>
	</div>
	<div class="bar">
		<label class="length" title="How long the whole thing takes to play at the chosen speed (a video sets this itself)">Length <input class="length-input" type="number" min="0.1" step="0.5" value="10" /> s</label>
		<span class="zoom">
			<button class="btn icon zoom-out" type="button" title="Zoom out" aria-label="Zoom out">${ICONS.zoomOut}</button>
			<button class="btn icon zoom-in" type="button" title="Zoom in (Ctrl/⌘ + wheel in a waveform also zooms)" aria-label="Zoom in">${ICONS.zoomIn}</button>
			<button class="btn icon zoom-fit" type="button" title="Show everything" aria-label="Fit — show everything">${ICONS.fit}</button>
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
		this._knob = $(".rate-knob");
		this._dial = $(".rate-dial");
		this._rateValue = $(".rate-value");
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
		// The length typed is how long it takes at the speed chosen; the file's own length is
		// what that comes to at normal speed.
		this._lengthInput.addEventListener("change", () => {
			inputTransport.setDuration(this._lengthInput.value * inputTransport.rate);
			this._syncState();
			this._dispatchStateChange();
		});
		wireKnobDrag(this._knob, {
			getStartValue: () => rateToKnob(inputTransport.rate),
			min: 0,
			max: 1,
			defaultValue: rateToKnob(1),
			pxPerRange: 130,
			onChange: (t) => {
				const rate = knobToRate(t);
				inputTransport.setRate(Math.abs(rate - 1) < SNAP ? 1 : rate);
			},
			onCommit: () => this._dispatchStateChange()
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
		return {
			version: 1,
			duration: inputTransport.hasTimebase ? this._savedDuration || inputTransport.duration : inputTransport.duration,
			loop: inputTransport.loop,
			rate: inputTransport.rate
		};
	}

	applyProject(project) {
		if (!project || typeof project !== "object") return;
		if (project.duration > 0) {
			this._savedDuration = project.duration;
			inputTransport.setDuration(project.duration);
		}
		if (typeof project.loop === "boolean") inputTransport.setLoop(project.loop);
		if (project.rate > 0) inputTransport.setRate(project.rate);
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
		if (this.shadowRoot.activeElement !== this._lengthInput) this._lengthInput.value = String(+t.effectiveDuration.toFixed(3));
		this._dial.style.transform = `rotate(${-135 + rateToKnob(t.rate) * 270}deg)`;
		this._knob.setAttribute("aria-valuenow", t.rate.toFixed(2));
		this._rateValue.textContent = `${t.rate.toFixed(2)}×`;
		this._syncTime();
	}

	_syncTime() {
		const t = inputTransport;
		this._timeEl.textContent = formatTime(t.effectivePosition);
		if (this.shadowRoot.activeElement !== this._scrub) this._scrub.value = String(Math.round(t.fraction * 10000));
	}
}

customElements.define("wa-input-transport", WaInputTransport);
