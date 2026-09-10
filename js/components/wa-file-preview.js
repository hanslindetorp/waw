import { vfs } from "../vfs/VFS.js";
import { selection } from "../state/selection.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";
import { WaxmlBridge } from "../waxml-integration/waxml-bridge.js";

// A raw File Manager selection's own preview: waveform + a transport (play,
// stop, loop, return-to-start) and click-to-seek — independent of xmlStore
// entirely (a selected file need not even be referenced anywhere in the XML
// yet). Always mounted, listens to selection.js itself (see wa-preview.js,
// same "always mounted, drives its own visibility from its own state"
// pattern as wa-section-view.js/wa-mixer-view.js). Plays back via a plain
// <audio> element rather than the WAXML engine/bridge — this is a standalone
// asset preview, not part of the composition graph, so it doesn't need (or
// want) the engine's own gesture-gated AudioContext lifecycle. Only
// bridge.audioContext is reused, and only for decodeAudioBuffer's waveform
// peaks — matching wa-preview.js's own "audio" state, and avoiding a second
// concurrent AudioContext.

const bridge = new WaxmlBridge();

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a"]);

// Shared with wa-preview.js, which needs the same check to decide whether a
// File Manager selection should take over the panel at all (a selected
// .xml/.zip file has no waveform to show, so the panel should stay on
// whatever it was already showing instead of switching to an empty state).
export function isPreviewableAudioFile(node) {
	if (!node || node.type !== "file") return false;
	const ext = node.name.split(".").pop()?.toLowerCase();
	return AUDIO_EXTENSIONS.has(ext);
}

// Candidate tick spacings (seconds) for the time ruler — picks the smallest
// one that keeps the tick count reasonable for the waveform's own width,
// same "nice round numbers" idea as a DAW ruler, just seconds-only (no bars/
// beats here, per Hans — this is a raw file, it has no tempo).
const TICK_INTERVALS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const TARGET_TICK_COUNT = 8;

function pickTickInterval(durationSeconds) {
	for (const interval of TICK_INTERVALS) {
		if (durationSeconds / interval <= TARGET_TICK_COUNT) return interval;
	}
	return TICK_INTERVALS[TICK_INTERVALS.length - 1];
}

function formatSeconds(s) {
	return Number.isInteger(s) ? `${s}s` : `${s.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.file-name {
			margin: 0 0 0.6rem;
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.waveform-wrap {
			position: relative;
			height: 140px;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			overflow: hidden;
			cursor: pointer;
		}
		canvas.waveform {
			display: block;
			width: 100%;
			height: 100%;
		}
		.tick {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 0;
			border-left: 1px solid rgba(255, 255, 255, 0.12);
			pointer-events: none;
		}
		.tick .label {
			position: absolute;
			bottom: 2px;
			left: 3px;
			font-size: 0.68rem;
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		.playhead {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 0;
			border-left: 2px solid var(--waw-accent, #4fa3ff);
			pointer-events: none;
			display: none;
		}
		.transport {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			margin-top: 0.75rem;
		}
		/* Icon-only now (no text label) — per Hans (2026-09-10) — so this is a
		   fixed-size square button instead of text-driven padding. */
		.transport button {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 2rem;
			height: 2rem;
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0;
			cursor: pointer;
			font: inherit;
		}
		.transport button:hover {
			background: #333;
		}
		.transport button.active {
			background: rgba(79, 163, 255, 0.22);
			border-color: var(--waw-accent, #4fa3ff);
		}
		.time-readout {
			margin-left: auto;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.hint {
			margin-top: 0.6rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
	</style>
	<p class="file-name"></p>
	<div class="waveform-wrap">
		<canvas class="waveform" width="600" height="140"></canvas>
		<div class="ticks"></div>
		<div class="playhead"></div>
	</div>
	<div class="transport">
		<button class="btn-play" type="button" title="Play">▶</button>
		<button class="btn-stop" type="button" title="Stop">■</button>
		<button class="btn-loop" type="button" title="Loop">⟲</button>
		<button class="btn-start" type="button" title="Go to start">⏮</button>
		<span class="time-readout"></span>
	</div>
	<p class="hint status"></p>
`;

export class WaFilePreview extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._nameEl = this.shadowRoot.querySelector(".file-name");
		this._wrap = this.shadowRoot.querySelector(".waveform-wrap");
		this._canvas = this.shadowRoot.querySelector("canvas.waveform");
		this._ticksEl = this.shadowRoot.querySelector(".ticks");
		this._playheadEl = this.shadowRoot.querySelector(".playhead");
		this._statusEl = this.shadowRoot.querySelector(".status");
		this._timeEl = this.shadowRoot.querySelector(".time-readout");
		this._playBtn = this.shadowRoot.querySelector(".btn-play");
		this._stopBtn = this.shadowRoot.querySelector(".btn-stop");
		this._loopBtn = this.shadowRoot.querySelector(".btn-loop");
		this._startBtn = this.shadowRoot.querySelector(".btn-start");

		this._audio = new Audio();
		this._audio.preload = "auto";
		this._rafId = null;
		this._requestToken = 0;
		this._duration = 0;
	}

	connectedCallback() {
		selection.addEventListener("change", (e) => this._onSelectionChange(e.detail.id));

		this._playBtn.addEventListener("click", () => this._audio.play());
		this._stopBtn.addEventListener("click", () => {
			this._audio.pause();
			this._audio.currentTime = 0;
		});
		this._startBtn.addEventListener("click", () => {
			this._audio.currentTime = 0;
		});
		this._loopBtn.addEventListener("click", () => {
			this._audio.loop = !this._audio.loop;
			this._loopBtn.classList.toggle("active", this._audio.loop);
		});
		this._wrap.addEventListener("click", (e) => this._onSeekClick(e));

		this._audio.addEventListener("play", () => this._startAnimating());
		this._audio.addEventListener("pause", () => this._stopAnimating());
		this._audio.addEventListener("ended", () => this._stopAnimating());
		this._audio.addEventListener("timeupdate", () => this._updateTimeReadout());

		this._onSelectionChange(selection.id);
	}

	async _onSelectionChange(id) {
		const node = id ? vfs.getNode(id) : null;
		if (!isPreviewableAudioFile(node)) return; // not a file, or e.g. a .xml/.zip — leave whatever's showing alone

		this._nameEl.textContent = node.name;
		this._statusEl.textContent = "Loading waveform…";
		this._resetPlayback();
		this._audio.src = node.sessionUrl;

		this._requestToken += 1;
		const token = this._requestToken;
		try {
			const audioBuffer = await decodeAudioBuffer(node.sessionUrl, bridge.audioContext);
			if (token !== this._requestToken) return; // selection changed while awaiting
			this._duration = audioBuffer.duration;
			drawWaveform(this._canvas, audioBuffer, "#4fa3ff");
			this._renderTicks();
			this._statusEl.textContent = "";
			this._updateTimeReadout();
		} catch {
			if (token !== this._requestToken) return;
			this._duration = 0;
			this._ticksEl.innerHTML = "";
			this._statusEl.textContent = "Could not decode audio for waveform.";
		}
	}

	_resetPlayback() {
		this._audio.pause();
		this._audio.currentTime = 0;
		this._audio.loop = false;
		this._loopBtn.classList.remove("active");
		this._stopAnimating();
		this._playheadEl.style.display = "none";
	}

	_renderTicks() {
		this._ticksEl.innerHTML = "";
		if (!this._duration) return;
		const interval = pickTickInterval(this._duration);
		for (let t = 0; t <= this._duration; t += interval) {
			const tick = document.createElement("div");
			tick.className = "tick";
			tick.style.left = `${(t / this._duration) * 100}%`;
			const label = document.createElement("span");
			label.className = "label";
			label.textContent = formatSeconds(Math.round(t * 100) / 100);
			tick.appendChild(label);
			this._ticksEl.appendChild(tick);
		}
	}

	_onSeekClick(e) {
		if (!this._duration) return;
		const rect = this._wrap.getBoundingClientRect();
		const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		this._audio.currentTime = fraction * this._duration;
		this._updateTimeReadout();
		this._updatePlayheadPosition();
	}

	_startAnimating() {
		this._playheadEl.style.display = "block";
		const step = () => {
			this._updatePlayheadPosition();
			this._rafId = requestAnimationFrame(step);
		};
		this._stopAnimating();
		this._rafId = requestAnimationFrame(step);
	}

	_stopAnimating() {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
	}

	_updatePlayheadPosition() {
		if (!this._duration) return;
		this._playheadEl.style.display = "block";
		this._playheadEl.style.left = `${(this._audio.currentTime / this._duration) * 100}%`;
	}

	_updateTimeReadout() {
		this._updatePlayheadPosition();
		const cur = this._audio.currentTime || 0;
		this._timeEl.textContent = `${cur.toFixed(2)}s / ${this._duration.toFixed(2)}s`;
	}
}

customElements.define("wa-file-preview", WaFilePreview);
