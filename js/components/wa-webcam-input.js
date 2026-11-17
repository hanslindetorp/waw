import { playerStore } from "../waxml-integration/player-store.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { inputMapMode } from "../state/input-map-mode.js";
import { inputSources } from "../state/input-sources.js";
import { stageStore, STAGE_INPUT_DRAG_TYPE } from "../project/stage-store.js";
import { setCardDragImage } from "../utils/drag-image.js";
import { VISION_BUNDLE_URL, WASM_PATH, MODEL_URLS } from "../input/mediapipe.js";
import { vfs } from "../vfs/VFS.js";
import { showNotice } from "./wa-notice-dialog.js";
import { confirmDialog } from "./wa-confirm-dialog.js";
import { startRecording } from "../input/video-recorder.js";
import { LARGE_VIDEO_BYTES, MAX_RECORDING_BYTES, formatSize, storeVideo } from "../input/video-files.js";
import { armMapping, mappingFromPick, writeVarReference, renderTargetPills } from "../input/target-pills.js";
import { angularOrder, area2d, axisMean, dist2d, emptyCalib, expandCalib, finalizeCalib, kindForCount, linePosition, normalizeSample, pushSample, sampleFor, widen } from "../input/measures.js";
import "./wa-color-picker.js";
import { COLOR_PALETTE } from "./wa-color-picker.js";

// The INPUT panel's "Web Camera" section — MediaPipe hand/body/face tracking
// that turns points on the live webcam picture into 0–1 values driving
// parameters in the document (see input-mapping.js).
//
// Adding a mapping (per Hans, 2026-10-12):
//   1. "+" in the top-left corner of the video, then one of hand | body | face
//      — only that tracker is switched on (nothing runs until it is needed);
//   2. click one or more points in the video; a single point sprays its color
//      along its path, two points are joined by a line and three or more by
//      a surface, all in real time;
//   3. as soon as a point is selected the range it moves through is
//      calibrated ("Move the body to auto-calibrate") until "map..." is
//      pressed; with one point a Horizontal | Vertical | Both choice sits
//      above the button;
//   4. "map..." works as before — then click the parameter (or a root <Var>
//      knob) to map to. The result is a row below the video.
//
// What a row measures, always calibrated to 0–1:
//   one point, Horizontal — x; Vertical — y (up is more); Both — the distance
//     from the lower-left corner of the range the point has covered, in
//     proportion to that range's diagonal;
//   two points — their 2D distance;
//   three or more — the area they enclose.
// (The old 3D measures and circumference are gone.)
//
// Every row sprays/draws in its own color — also when it is not selected —
// and picking a row shows its points in the video.
//
// Rows (with the points, color, mode, calibrated range and targets) are
// project content, saved in inputs.json (getEntries()/applyEntries() — see
// project/inputs-store.js); the camera choice and whether it was running are
// editor state (getState()/applyState() — see workstation-state.js's own
// registerLayoutExtras wiring). None of it is WAXML document content. Rows
// saved by earlier versions (in workstation-state.json) are converted when
// the project opens.
//
// Other parts of the app reach this element through input-sources.js: the
// Stage shows a row (and a Start button) as one of its items, and the viewer
// page keeps an instance out of sight as the engine behind them.
//
// Ported from Hans's own reference implementation (https://msw.waxml.org/,
// fetched 2026-09-22): the landmark rebuild and click-to-select hit-test.
// Camera/model loading stays gated behind an explicit Start button — this app
// never starts media without a real user gesture (see waxml-bridge.js).

const MODEL_CHOICES = { hands: "hand", pose: "body", face: "face" };
const SPRAY_MS = 200; // how long a sprayed dot takes to fade away — short, so a point moved back and forth drags a tail behind it

function modelOfLabel(label) {
	if (/^(leftHand|rightHand|hand)\d+$/.test(label)) return "hands";
	if (/^pose\d+$/.test(label)) return "pose";
	if (/^face\d+$/.test(label)) return "face";
	return "unknown";
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.85rem/1.4 system-ui, sans-serif;
			padding: 0.75rem;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex-wrap: wrap;
			margin-bottom: 0.6rem;
		}
		.camera-select {
			margin-left: auto;
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			color: inherit;
			font-size: 0.78rem;
			padding: 0.3rem 0.4rem;
			max-width: 9rem;
		}
		.start-btn {
			padding: 0.32rem 0.9rem;
			border: none;
			border-radius: 6px;
			background: var(--waw-accent, #4fa3ff);
			color: #06131f;
			font-weight: 600;
			cursor: pointer;
			font-size: 0.8rem;
			font-family: inherit;
		}
		.start-btn.running {
			background: var(--waw-danger, #e5484d);
			color: #fff;
		}
		.rec-btn {
			padding: 0.32rem 0.7rem;
			border: 1.5px solid var(--waw-danger, #e5484d);
			border-radius: 6px;
			background: transparent;
			color: var(--waw-danger, #e5484d);
			cursor: pointer;
			font-size: 0.8rem;
			font-family: inherit;
			font-weight: 600;
		}
		.rec-btn:disabled {
			opacity: 0.4;
			cursor: default;
		}
		.rec-btn.recording {
			background: var(--waw-danger, #e5484d);
			color: #fff;
		}
		.rec-sound {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
		}
		.rec-info {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.74rem;
			color: var(--waw-danger, #e5484d);
		}
		.rec-info.large {
			color: #fb923c;
		}
		.rec-saved {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem;
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			margin-bottom: 0.6rem;
		}
		.rec-saved .name {
			color: var(--waw-teal, #45b58c);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.rec-saved .error {
			color: var(--waw-danger, #e5484d);
		}
		.rec-saved button {
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			background: #1a1c1f;
			color: var(--waw-fg, #e8e8e8);
			cursor: pointer;
			font-size: 0.72rem;
			padding: 0.2rem 0.5rem;
		}
		.rec-saved button:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.rec-saved[hidden] {
			display: none;
		}
		.video-wrapper {
			position: relative;
			background: #000;
			border-radius: 8px;
			overflow: hidden;
			line-height: 0;
			margin-bottom: 0.6rem;
		}
		video {
			width: 100%;
			display: block;
		}
		video.mirror,
		canvas.mirror {
			transform: scaleX(-1);
		}
		canvas {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		canvas.picking {
			cursor: crosshair;
		}
		.status-overlay {
			position: absolute;
			inset: 0;
			z-index: 3;
			background: rgba(0, 0, 0, 0.82);
			display: flex;
			align-items: center;
			justify-content: center;
			text-align: center;
			padding: 1rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.8rem;
			line-height: 1.4;
		}
		.status-overlay.error {
			color: var(--waw-danger, #e5484d);
		}
		.status-overlay[hidden] {
			display: none;
		}
		/* The controls drawn over the video; only the controls themselves take
		   the pointer, the rest lets clicks through to the canvas. */
		.vid-ui {
			position: absolute;
			inset: 0;
			z-index: 2;
			pointer-events: none;
			line-height: 1.2;
		}
		.vid-ui > * {
			pointer-events: auto;
		}
		/* The instruction text is a row of its own across the top, with the
		   add controls beneath it, so nothing it says ever lies under a button. */
		.top-ui {
			position: absolute;
			top: 0.4rem;
			left: 0.4rem;
			right: 0.4rem;
			display: flex;
			flex-direction: column;
			align-items: stretch;
			gap: 0.35rem;
			pointer-events: none;
		}
		.top-ui > * {
			pointer-events: auto;
		}
		.add-wrap {
			display: flex;
			align-items: center;
			gap: 0.35rem;
		}
		.add-wrap[hidden],
		.model-choices[hidden],
		.map-wrap[hidden],
		.subtitle[hidden],
		.axis-select[hidden] {
			display: none;
		}
		.model-choices {
			display: flex;
			gap: 0.3rem;
		}
		/* A half-transparent dark ground (also when hovered, where a light one
		   made white text vanish on a light picture) and a light outline, so
		   the controls read on anything the camera shows. */
		.add-btn,
		.model-choices button,
		.map-btn,
		.axis-select {
			background: rgba(0, 0, 0, 0.72);
			border: 1.5px solid rgba(255, 255, 255, 0.9);
			border-radius: 6px;
			color: #fff;
			font: 600 0.8rem system-ui, sans-serif;
			text-shadow: 0 0 3px #000;
			box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
			cursor: pointer;
		}
		.add-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			border-radius: 50%;
			font-size: 1.1rem;
		}
		.model-choices button,
		.map-btn,
		.axis-select {
			padding: 0.25rem 0.6rem;
		}
		.add-btn:hover,
		.model-choices button:hover,
		.map-btn:hover {
			background: rgba(0, 0, 0, 0.9);
			border-color: #fff;
		}
		.map-btn.armed {
			border-color: #facc15;
			color: #facc15;
		}
		.subtitle {
			align-self: center;
			max-width: 100%;
			padding: 0.2rem 0.6rem;
			background: rgba(0, 0, 0, 0.78);
			color: #fff;
			font: 0.82rem/1.3 system-ui, sans-serif;
			text-align: center;
			border-radius: 3px;
			pointer-events: none;
		}
		.map-wrap {
			position: absolute;
			right: 0.5rem;
			bottom: 0.5rem;
			display: flex;
			flex-direction: column;
			align-items: flex-end;
			gap: 0.3rem;
		}
		.axis-select {
			font-weight: 400;
		}
		.axis-select option {
			color: #000;
		}

		.saved-list {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}
		.saved-row {
			background: rgba(255, 255, 255, 0.04);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 7px;
			padding: 0.45rem 0.6rem;
			display: flex;
			flex-direction: column;
			gap: 0.4rem;
			cursor: pointer;
		}
		.saved-row.selected {
			border-color: #fff;
			background: rgba(255, 255, 255, 0.09);
		}
		.saved-row-top {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem 0.5rem;
		}
		.saved-label {
			flex: 1 1 6rem;
			min-width: 0;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.74rem;
			display: flex;
			flex-wrap: wrap;
			gap: 0.1rem;
		}
		.slm-hands {
			color: var(--waw-teal, #45b58c);
		}
		.slm-pose {
			color: #fb923c;
		}
		.slm-face {
			color: var(--waw-accent, #4fa3ff);
		}
		.slm-sep {
			color: var(--waw-muted, #8a8a8a);
		}
		.measure-tag {
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			white-space: nowrap;
		}
		.saved-controls {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 0.4rem;
		}
		.row-axis {
			background: #1a1c1f;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			color: inherit;
			font-size: 0.68rem;
			padding: 0.1rem 0.2rem;
		}
		.mute-btn,
		.icon-btn {
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			background: #1a1c1f;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-family: inherit;
			line-height: 1;
		}
		.mute-btn {
			padding: 0.15rem 0.45rem;
			font-size: 0.7rem;
		}
		/* "Add to Stage": click puts the row on the current Stage view, dragging
		   it carries it onto the Stage panel (see wa-stage-view.js). */
		.stage-pin {
			flex: 0 0 auto;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 18px;
			height: 18px;
			border-radius: 3px;
			color: var(--waw-muted, #8a8a8a);
			cursor: grab;
			opacity: 0.6;
		}
		.stage-pin:hover {
			opacity: 1;
			color: var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.15);
		}
		.stage-pin svg {
			width: 12px;
			height: 12px;
			pointer-events: none;
		}
		.stage-pin.added {
			color: var(--waw-teal, #45b58c);
			opacity: 1;
		}
		.icon-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0.2rem 0.3rem;
		}
		.mute-btn.active {
			border-color: #fb923c;
			color: #fb923c;
			background: rgba(251, 146, 60, 0.14);
		}
		.icon-btn.active {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.12);
		}
		.saved-del {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 1rem;
			line-height: 1;
			padding: 0 0.2rem;
		}
		.saved-del:hover {
			color: var(--waw-danger, #e5484d);
		}
		.calibrate-btn {
			padding: 0.15rem 0.5rem;
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 6px;
			background: #1a1c1f;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.7rem;
			font-family: inherit;
			white-space: nowrap;
		}
		.calibrate-btn.active {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.12);
		}
		.calibrate-hint {
			font-size: 0.68rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.calibrate-hint[hidden] {
			display: none;
		}
		.value-row {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
		.value-bar {
			flex: 1 1 auto;
			height: 6px;
			background: #1a1c1f;
			border-radius: 3px;
			overflow: hidden;
		}
		.value-fill {
			height: 100%;
			width: 0;
			background: var(--entry-color, #4fa3ff);
		}
		.value-num {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.72rem;
			min-width: 2.6rem;
			text-align: right;
			color: var(--waw-fg, #e8e8e8);
		}
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
		/* Whichever button/pill armed input-map-mode.js just now — the same
		   yellow ring every valid target uses (see wa-var-knobs.js's own
		   comment on why the @keyframes is declared again per shadow root). */
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
		.sv-mapped.armed,
		.map-btn.armed {
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
	</style>
	<div class="row">
		<button class="start-btn" type="button">Start</button>
		<button class="rec-btn" type="button" disabled title="Record the camera picture to a video file in the project (start the camera first)">● Rec</button>
		<label class="rec-sound" title="Record sound from the microphone too (the browser asks for permission the first time)"><input type="checkbox" /> sound</label>
		<span class="rec-info" hidden></span>
		<select class="camera-select" title="Camera"></select>
	</div>
	<div class="rec-saved" hidden></div>
	<div class="video-wrapper">
		<video autoplay playsinline muted></video>
		<canvas></canvas>
		<div class="vid-ui" hidden>
			<div class="top-ui">
				<div class="subtitle" hidden></div>
				<div class="add-wrap">
					<button class="add-btn" type="button" title="Add a mapping">+</button>
					<span class="model-choices" hidden>
						<button type="button" data-model="hands">hand</button>
						<button type="button" data-model="pose">body</button>
						<button type="button" data-model="face">face</button>
					</span>
				</div>
			</div>
			<div class="map-wrap" hidden>
				<select class="axis-select" title="Which movement to follow" hidden>
					<option value="horizontal">Horizontal</option>
					<option value="vertical">Vertical</option>
					<option value="both" selected>Both</option>
				</select>
				<button class="map-btn" type="button">Calibrate...</button>
			</div>
		</div>
		<div class="status-overlay">Camera is off. Click Start to begin tracking.</div>
	</div>
	<div class="saved-list"></div>
`;

export class WaWebcamInput extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		const $ = (sel) => this.shadowRoot.querySelector(sel);

		this._videoEl = $("video");
		this._canvas = $("canvas");
		this._ctx = this._canvas.getContext("2d");
		this._statusOverlay = $(".status-overlay");
		this._cameraSelect = $(".camera-select");
		this._startBtn = $(".start-btn");
		this._recBtn = $(".rec-btn");
		this._recInfo = $(".rec-info");
		this._recSound = $(".rec-sound input");
		this._recSaved = $(".rec-saved");
		this._recording = null; // { stop() } while the camera picture is being recorded
		this._vidUi = $(".vid-ui");
		this._addWrap = $(".add-wrap");
		this._addBtn = $(".add-btn");
		this._modelChoices = $(".model-choices");
		this._subtitle = $(".subtitle");
		this._mapWrap = $(".map-wrap");
		this._axisSelect = $(".axis-select");
		this._mapBtn = $(".map-btn");
		this._savedListEl = $(".saved-list");

		// Per model: the tracker instance (once loaded) and the latest result.
		this._modelState = {
			hands: { instance: null, results: null, loading: null },
			pose: { instance: null, results: null, loading: null },
			face: { instance: null, results: null, loading: null }
		};
		this._drawUtils = null;
		this._visionModule = null;
		this._visionPromise = null;
		this._currentStream = null;
		this._cameraDeviceId = null;
		this._running = false;
		this._rafId = null;
		this._lastVideoTime = -1;

		this._choosing = false; // the hand | body | face buttons are showing
		this._adding = null; // { model } while picking points for a new mapping
		this._activeSelection = []; // labels of the points picked so far, in order
		this._activeCalib = null;
		this._activeSamples = [];
		this._calibPhase = "idle"; // of the selection: "idle" -> "calibrating" (Calibrate... pressed) -> "done" (Done pressed; the button is map...)
		this._calibNote = ""; // a short message under way, e.g. when nothing moved
		this._activeParticles = [];
		this._pendingMap = null; // the snapshot "map..." took, while a target is being picked
		this._nextColorIndex = 0;
		this._selectionColor = COLOR_PALETTE[0];

		this._allLandmarks = [];
		this._landmarkMap = new Map();
		this._savedEntries = []; // { id, model, labels, labelMetas, color, mode, calib, mappings, bypassed, ... }
		this._savedEntryCounter = 0;
		this._selectedEntryId = null;

		this._onVarLinkChanged = (e) => this._followVarLink(e.detail);
		this._onProjectReset = () => this._clearEntries();
		this._tick = this._tick.bind(this);
		this._onCanvasClick = this._onCanvasClick.bind(this);
		this._onKeyDown = (e) => {
			// Capture phase, so that an armed mapping's own Escape (input-map-mode.js)
			// is left to disarm it first.
			if (e.key !== "Escape" || inputMapMode.armed) return;
			if (this._adding || this._choosing) this._cancelAdding();
		};
	}

	connectedCallback() {
		xmlStore.addEventListener("var-link-changed", this._onVarLinkChanged);
		xmlStore.addEventListener("project-reset", this._onProjectReset);
		document.addEventListener("keydown", this._onKeyDown, true);
		inputSources.register("webcam", this);
		this._startBtn.addEventListener("click", () => (this._running ? this._stop() : this._start()));
		this._recBtn.addEventListener("click", () => this._toggleRecording());
		// Whether to record sound is remembered on this machine (not part of the project).
		try {
			this._recSound.checked = localStorage.getItem("waw.recordSound") === "1";
		} catch {
			// Storage can be blocked; the box then starts unticked each time.
		}
		this._recSound.addEventListener("change", () => {
			try {
				localStorage.setItem("waw.recordSound", this._recSound.checked ? "1" : "0");
			} catch {
				// Not worth a message.
			}
		});
		this._cameraSelect.addEventListener("change", () => {
			this._cameraDeviceId = this._cameraSelect.value || null;
			if (this._running) this._startCamera(this._cameraDeviceId);
			this._dispatchStateChange();
		});
		this._canvas.addEventListener("click", this._onCanvasClick);
		this._addBtn.addEventListener("click", () => this._onAddButton());
		this._modelChoices.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => this._beginAdding(btn.dataset.model)));
		this._mapBtn.addEventListener("click", (e) => {
			e.stopPropagation(); // the click that arms must not also be the "unclaimed click" that disarms
			this._onMapButton();
		});
		this._updateOverlay();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("var-link-changed", this._onVarLinkChanged);
		xmlStore.removeEventListener("project-reset", this._onProjectReset);
		document.removeEventListener("keydown", this._onKeyDown, true);
		inputSources.unregister("webcam", this);
		this._stop();
	}

	// A <Var>'s `name` and/or `value` changed (see xml-store.js's
	// _varLinkChange): every target that pointed at it follows, so the link
	// keeps working. A target made straight onto a parameter also keeps
	// feeding the variable the Var now reads from (its `value`).
	_followVarLink({ oldName, newName, oldValue, newValue }) {
		// A Var's `value` refers to the hidden variable as "$input_var1"; the
		// mapping stores the bare name the entry actually sets.
		const bare = (v) => (typeof v === "string" ? v.trim().replace(/^\$/, "") : "");
		const oldInput = bare(oldValue);
		const newInput = bare(newValue);
		const validInput = /^[A-Za-z0-9_]+$/.test(newInput);
		let changed = false;
		this._savedEntries.forEach((entry) => {
			let hit = false;
			entry.mappings.forEach((mapping) => {
				if (mapping.varName !== oldName) return;
				if (newName !== oldName) {
					mapping.varName = newName;
					hit = true;
				}
				if (mapping.direct && oldInput !== newInput && mapping.inputVar === oldInput && validInput) {
					mapping.inputVar = newInput;
					hit = true;
				}
			});
			if (hit) {
				changed = true;
				this._refreshTargets(entry);
			}
		});
		if (changed) this._dispatchStateChange();
	}

	// A different project is being opened or started: the rows of the last one
	// go (the new project's own come in with its saved state).
	_clearEntries() {
		this._cancelAdding();
		this._savedEntries.forEach((e) => e.row.remove());
		this._savedEntries = [];
		this._selectedEntryId = null;
		this._nextColorIndex = 0;
	}

	// Public wrapper so outside code (workstation-state.js's
	// resetWebcamInputForNewProject, called from "File > New...") can stop
	// tracking without reaching into the underscore-prefixed internals.
	stop() {
		this._stop();
	}

	// ── Persistence ──────────────────────────────────────────────────────
	// Editor state (workstation-state.json): which camera, and whether it was
	// running when the project was saved.
	getState() {
		return { version: 2, cameraDeviceId: this._cameraDeviceId, running: this._running };
	}

	applyState(state) {
		if (!state || typeof state !== "object") return;
		if (typeof state.cameraDeviceId === "string") this._cameraDeviceId = state.cameraDeviceId;
		// Rows saved by versions that kept them here (see applyEntries).
		if (Array.isArray(state.entries)) this.applyEntries(state.entries);
		// Per Hans (2026-09-26): a project saved with the camera running
		// should have it running again as soon as the project opens, rather
		// than making the user click Start every time. Not a "resume audio
		// without a gesture" violation the way autoplaying sound would be —
		// opening a project (via a real file-picker interaction) is itself
		// the user gesture, same as it already is for saved panel layout.
		if (state.running) this._start();
	}

	// Project content (inputs.json): the rows.
	getEntries() {
		return this._savedEntries.map((e) => ({
			id: e.id,
			model: e.model,
			labels: [...e.labels],
			color: e.color,
			mode: e.mode,
			invert: e.invert,
			calib: { ...e.calib },
			mappings: e.mappings.map((m) => ({ ...m })),
			bypassed: e.bypassed
		}));
	}

	applyEntries(entries) {
		if (!Array.isArray(entries)) return;
		this._migrateEntries(entries)
			.filter((e) => !e.id || !this._savedEntries.some((x) => x.id === e.id))
			.forEach((e) => this._createEntry(e));
		this._syncModels();
	}

	// ── For the Stage and the viewer (see input-sources.js) ──────────────
	get running() {
		return this._running;
	}

	get statusText() {
		return this._statusError || "";
	}

	start() {
		return this._running ? Promise.resolve() : this._start();
	}

	getEntrySummaries() {
		return this._savedEntries.map((e) => ({
			id: e.id,
			color: e.color,
			label: e.labels.join(" + "),
			measure: this._measureTag(e),
			bypassed: e.bypassed
		}));
	}

	getEntryNorm(id) {
		const e = this._savedEntries.find((x) => x.id === id);
		return e && !e.bypassed ? e.norm : undefined;
	}

	// Rows saved before the 2026-10-12 redesign had a metric per key (x, y, z,
	// dist2d, dist3d, area2d, ...), each with its own targets and range. Each
	// key that still exists becomes a row of its own — x → Horizontal, y →
	// Vertical, dist2d, area2d — keeping its targets, its range (in today's
	// mirrored, up-is-more terms) and the name it was sent under, so a root
	// <Var> that refers to that name keeps working. The 3D measures and
	// circumference are dropped.
	_migrateEntries(entries) {
		const out = [];
		for (const e of entries) {
			if (!Array.isArray(e.labels) || e.labels.length === 0) continue;
			if (e.version === 2 || e.model) {
				out.push(e);
				continue;
			}
			const model = modelOfLabel(e.labels[0]);
			const oldMappings = e.mappings && typeof e.mappings === "object" ? e.mappings : {};
			const n = e.labels.length;
			const keys = n === 1 ? ["x", "y"] : n === 2 ? ["dist2d"] : ["area2d"];
			for (const key of keys) {
				const list = oldMappings[key];
				if (!list) continue;
				const mappings = (Array.isArray(list) ? list : [list]).map((one) =>
					typeof one === "string" ? { varName: one, min: 0, max: 1 } : one
				);
				if (!mappings.length) continue;
				const first = mappings[0];
				const lo = first.min ?? null;
				const hi = first.max ?? null;
				let calib;
				if (key === "x") calib = { ...emptyCalib("point"), xMin: hi === null ? null : 1 - hi, xMax: lo === null ? null : 1 - lo };
				else if (key === "y") calib = { ...emptyCalib("point"), yMin: hi === null ? null : 1 - hi, yMax: lo === null ? null : 1 - lo };
				else calib = { min: lo, max: hi };
				out.push({
					model,
					labels: e.labels,
					mode: key === "x" ? "horizontal" : key === "y" ? "vertical" : "both",
					calib,
					mappings: mappings.map((m) => ({
						varName: m.varName,
						...(m.direct ? { direct: true, inputVar: m.inputVar ?? `input_${m.varName}` } : {})
					})),
					bypassed: !!e.bypassed
				});
			}
		}
		return out;
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	// ── Start / Stop ─────────────────────────────────────────────────────
	// getUserMedia() is called as the very first async step so it stays as
	// close as possible to the triggering user gesture (some browsers stop
	// treating it as driven by the gesture after a few seconds — the old
	// "models first, then camera" order silently broke the project-open
	// autostart; per Hans's bug report 2026-09-29). The trackers are loaded
	// afterwards, one by one and only when a row or a new mapping needs them.
	async _start() {
		this._startBtn.disabled = true;
		this._setStatus("Requesting camera…", false);
		try {
			const activeId = await this._startCamera(this._cameraDeviceId);
			await this._enumerateCameras(activeId);
			this._running = true;
			this._recBtn.disabled = false;
			this._startBtn.textContent = "Stop";
			this._startBtn.classList.add("running");
			this._statusOverlay.hidden = true;
			this._syncModels();
			this._updateOverlay();
			this._rafId = requestAnimationFrame(this._tick);
			this._statusError = "";
		} catch (err) {
			this._setStatus(`Error: ${err.message}\nCheck camera access and network connection.`, true);
			this._statusError = `Camera: ${err.message}`;
		} finally {
			this._startBtn.disabled = false;
			this.dispatchEvent(new CustomEvent("run-change"));
		}
	}

	_stop() {
		// The recording is closed first (and saved as far as it got), then the camera goes.
		this._recording?.stop();
		this._recBtn.disabled = true;
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
		if (this._currentStream) {
			this._currentStream.getTracks().forEach((t) => t.stop());
			this._currentStream = null;
		}
		this._running = false;
		this._choosing = false;
		this._adding = null;
		this._activeSelection = [];
		this._startBtn.textContent = "Start";
		this._startBtn.classList.remove("running");
		this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		Object.values(this._modelState).forEach((s) => (s.results = null));
		this._setStatus("Camera is off. Click Start to begin tracking.", false);
		this._updateOverlay();
		this.dispatchEvent(new CustomEvent("run-change"));
	}

	// ── Recording the camera picture to a video file ─────────────────────
	// Record starts a MediaRecorder on the camera's stream; stopping saves the file in the
	// project's video folder (made when missing), warns when it is large, and offers to use it
	// as the Video section's video — the same trackers and rows then work on it (see
	// wa-video-input.js). Only the picture is recorded (see input/video-recorder.js).
	_toggleRecording() {
		if (this._recording) {
			this._recording.stop();
			return Promise.resolve();
		}
		if (!this._currentStream || this._recStarting) return Promise.resolve();
		return this._beginRecording();
	}

	async _beginRecording() {
		this._recStarting = true;
		this._recSaved.hidden = true;
		let stream = this._currentStream;
		let mic = null;
		let note = "";
		// The microphone is asked for only when "sound" is ticked; if it is refused the picture
		// is still recorded, and the saved note says so.
		if (this._recSound.checked) {
			try {
				mic = await navigator.mediaDevices.getUserMedia({ audio: true });
				stream = new MediaStream([...this._currentStream.getVideoTracks(), ...mic.getAudioTracks()]);
			} catch (err) {
				note = `No sound: the microphone could not be used (${err.message || err.name})`;
			}
		}
		this._recStarting = false;
		if (!this._currentStream) {
			mic?.getTracks().forEach((t) => t.stop());
			return; // the camera was switched off meanwhile
		}
		const mark = mic ? " 🎤" : "";
		this._recBtn.classList.add("recording");
		this._recBtn.textContent = "■ Stop";
		this._recInfo.hidden = false;
		this._recInfo.classList.remove("large");
		this._recInfo.textContent = `● 0:00 · 0 kB${mark}`;
		this._recording = startRecording(stream, {
			onProgress: ({ bytes, seconds }) => {
				const m = Math.floor(seconds / 60);
				this._recInfo.textContent = `● ${m}:${String(Math.floor(seconds % 60)).padStart(2, "0")} · ${formatSize(bytes)}${mark}`;
				if (bytes >= LARGE_VIDEO_BYTES) {
					this._recInfo.classList.add("large");
					this._recInfo.title = `A large recording (the limit is ${formatSize(MAX_RECORDING_BYTES)}) — consider stopping`;
				}
			},
			onStop: (result) => {
				mic?.getTracks().forEach((t) => t.stop());
				this._onRecordingStopped(result, note);
			}
		});
	}

	_onRecordingStopped(result, note = "") {
		this._recording = null;
		this._recBtn.classList.remove("recording");
		this._recBtn.textContent = "● Rec";
		this._recInfo.hidden = true;
		this._recInfo.title = "";
		const box = this._recSaved;
		box.hidden = false;
		box.innerHTML = "";
		const add = (el) => box.appendChild(el);
		const span = (text, cls) => {
			const e = document.createElement("span");
			e.textContent = text;
			if (cls) e.className = cls;
			return e;
		};
		if (result.error) {
			add(span(result.error, "error"));
			return;
		}
		const node = storeVideo(result.file);
		const path = vfs.getExportPath(node.id);
		add(span("Saved"));
		add(span(`${path} (${formatSize(result.bytes)}${result.sound ? ", with sound" : ""})`, "name"));
		if (note) add(span(note, "error"));
		const use = document.createElement("button");
		use.type = "button";
		use.textContent = "Use as video input";
		use.title = "Open it in the Video section, where hand / body / face points can be mapped";
		use.addEventListener("click", () => this._useRecording(node));
		add(use);
		if (result.limited) {
			showNotice(`The recording stopped by itself at the size limit (${formatSize(MAX_RECORDING_BYTES)}). It has been saved.`);
		} else if (result.bytes >= LARGE_VIDEO_BYTES) {
			showNotice(
				`The recording is ${formatSize(result.bytes)}. A large video is kept in memory, goes into the project's zip and takes long to analyse. It has been saved — shorter clips are easier to work with.`
			);
		}
	}

	// Hands a recording to the Video section and opens that section.
	async _useRecording(node) {
		const video = inputSources.get("video");
		if (!video) return;
		if (!(await video.open(node, confirmDialog))) return;
		this.getRootNode().querySelector?.('[data-section="video"]')?.classList.remove("collapsed");
	}

	_setStatus(text, isError) {
		this._statusOverlay.hidden = false;
		this._vidUi.hidden = true;
		this._statusOverlay.classList.toggle("error", !!isError);
		this._statusOverlay.textContent = text;
	}

	// ── Trackers ─────────────────────────────────────────────────────────
	// Which trackers have to run right now: the ones the rows use, plus the
	// one a new mapping is being picked in.
	_neededModels() {
		const needed = new Set(this._savedEntries.map((e) => e.model));
		if (this._adding) needed.add(this._adding.model);
		needed.delete("unknown");
		return needed;
	}

	// Loads (once) every tracker that is needed and not loaded yet — the WASM
	// runtime is shared, each model is its own download. They stay loaded
	// across Stop/Start (re-downloading would be wasteful), but only the
	// needed ones run (see _tick).
	_syncModels() {
		if (!this._running) return;
		this._neededModels().forEach((name) => {
			const state = this._modelState[name];
			if (state.instance || state.loading) return;
			state.loading = this._loadModel(name)
				.catch((err) => this._showError(`Could not load ${MODEL_CHOICES[name]} tracking: ${err.message}`))
				.finally(() => {
					state.loading = null;
					this._updateOverlay();
				});
			this._updateOverlay();
		});
	}

	_showError(text) {
		this._subtitle.hidden = false;
		this._subtitle.textContent = text;
	}

	_ensureVision() {
		if (this._visionPromise) return this._visionPromise;
		this._visionPromise = (async () => {
			const mod = await import(/* webpackIgnore: true */ VISION_BUNDLE_URL);
			this._visionModule = mod;
			this._vision = await mod.FilesetResolver.forVisionTasks(WASM_PATH);
			this._drawUtils = new mod.DrawingUtils(this._ctx);
		})();
		return this._visionPromise;
	}

	async _loadModel(name) {
		await this._ensureVision();
		const { HandLandmarker, PoseLandmarker, FaceLandmarker } = this._visionModule;
		const options = (path, extra) => ({ baseOptions: { modelAssetPath: path, delegate: "GPU" }, runningMode: "VIDEO", ...extra });
		this._modelState[name].instance =
			name === "hands"
				? await HandLandmarker.createFromOptions(this._vision, options(MODEL_URLS.hands, { numHands: 2 }))
				: name === "pose"
					? await PoseLandmarker.createFromOptions(this._vision, options(MODEL_URLS.pose, { numPoses: 1 }))
					: await FaceLandmarker.createFromOptions(this._vision, options(MODEL_URLS.face, { numFaces: 1 }));
	}

	async _enumerateCameras(activeId) {
		const devs = await navigator.mediaDevices.enumerateDevices();
		this._cameraSelect.innerHTML = "";
		devs
			.filter((d) => d.kind === "videoinput")
			.forEach((cam, i) => {
				const o = document.createElement("option");
				o.value = cam.deviceId;
				o.textContent = cam.label || `Camera ${i + 1}`;
				if (cam.deviceId === activeId) o.selected = true;
				this._cameraSelect.appendChild(o);
			});
	}

	// Falls back to the default camera once if a *persisted* deviceId is no
	// longer available (e.g. a different camera got unplugged since last
	// session) — a plain "exact" constraint failure would otherwise leave
	// Start permanently broken until the user clears it by hand.
	async _startCamera(deviceId) {
		if (this._currentStream) this._currentStream.getTracks().forEach((t) => t.stop());
		try {
			this._currentStream = await navigator.mediaDevices.getUserMedia({
				video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" },
				audio: false
			});
		} catch (err) {
			if (!deviceId) throw err;
			this._currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
		}
		this._videoEl.srcObject = this._currentStream;
		await new Promise((resolve) => (this._videoEl.onloadedmetadata = resolve));
		this._videoEl.play();
		this._videoEl.classList.add("mirror");
		this._canvas.classList.add("mirror");
		const activeId = this._currentStream.getVideoTracks()[0]?.getSettings()?.deviceId ?? null;
		this._cameraDeviceId = activeId;
		return activeId;
	}

	// ── Main loop ────────────────────────────────────────────────────────
	_syncCanvasSize() {
		if (this._videoEl.videoWidth && (this._canvas.width !== this._videoEl.videoWidth || this._canvas.height !== this._videoEl.videoHeight)) {
			this._canvas.width = this._videoEl.videoWidth;
			this._canvas.height = this._videoEl.videoHeight;
		}
	}

	_tick() {
		this._syncCanvasSize();
		if (this._running && this._videoEl.readyState >= 2) {
			// The trackers run once per picture the camera delivers; the drawing
			// (the fading sprays) runs on every screen refresh in between.
			if (this._videoEl.currentTime !== this._lastVideoTime) {
				this._lastVideoTime = this._videoEl.currentTime;
				const ts = performance.now();
				const needed = this._neededModels();
				for (const [name, state] of Object.entries(this._modelState)) {
					state.results = needed.has(name) && state.instance ? state.instance.detectForVideo(this._videoEl, ts) : null;
				}
				this._onMediaPipeUpdate();
			} else {
				this._renderCanvas(performance.now(), false);
			}
		}
		if (this._running) this._rafId = requestAnimationFrame(this._tick);
	}

	// Rebuilds the point lookup from this frame's results. Labels stay
	// leftHand0..20 / rightHand0..20, pose0..32 and face0..477.
	_onMediaPipeUpdate() {
		this._allLandmarks = [];
		this._landmarkMap.clear();
		const push = (e) => {
			this._allLandmarks.push(e);
			this._landmarkMap.set(e.label, e);
		};
		const make = (model, lm) => ({
			model,
			x: parseFloat(lm.x.toFixed(3)),
			y: parseFloat(lm.y.toFixed(3)),
			z: parseFloat((lm.z ?? 0).toFixed(3)),
			cx: lm.x * this._canvas.width,
			cy: lm.y * this._canvas.height
		});

		const handResults = this._modelState.hands.results;
		if (handResults?.landmarks) {
			const { landmarks, handedness, handednesses } = handResults;
			// The field was renamed "handedness" -> "handednesses" at some
			// point in @mediapipe/tasks-vision's own history — checking both
			// costs nothing and keeps this working across versions.
			const handsList = handednesses || handedness || [];
			let idx = 0;
			landmarks.forEach((hand, handIdx) => {
				const rawSide = handsList[handIdx]?.[0]?.categoryName; // "Left" | "Right", per MediaPipe's own (unmirrored) frame
				// The preview is shown mirrored, so MediaPipe's own Left/Right
				// reads backwards from what the user sees on screen; swap to
				// match the display. Per Hans (2026-10-03).
				const side = rawSide === "Left" ? "rightHand" : rawSide === "Right" ? "leftHand" : null;
				hand.forEach((lm, i) => {
					const point = make("hands", lm);
					// The old combined "hand0".."hand41" labels (no left/right
					// distinction) are kept ONLY in _landmarkMap — never
					// _allLandmarks, so a click can never select one — purely so
					// a row saved with one still resolves. Per Hans (2026-10-03).
					this._landmarkMap.set(`hand${idx}`, { label: `hand${idx}`, ...point });
					idx++;
					if (side) push({ label: `${side}${i}`, ...point });
				});
			});
		}
		const poseResults = this._modelState.pose.results;
		if (poseResults?.landmarks) {
			for (const pose of poseResults.landmarks) pose.forEach((lm, i) => push({ label: `pose${i}`, ...make("pose", lm) }));
		}
		const faceResults = this._modelState.face.results;
		if (faceResults?.faceLandmarks) {
			for (const face of faceResults.faceLandmarks) face.forEach((lm, i) => push({ label: `face${i}`, ...make("face", lm) }));
		}

		this._updateActiveSelection();
		this._savedEntries.forEach((entry) => this._updateEntryValue(entry));
		this._renderCanvas(performance.now());
	}

	// ── Adding a mapping ─────────────────────────────────────────────────
	_onAddButton() {
		if (this._adding || this._choosing) {
			this._cancelAdding();
			return;
		}
		this._choosing = true;
		this._updateOverlay();
	}

	_beginAdding(model) {
		this._choosing = false;
		this._adding = { model };
		this._activeSelection = [];
		this._activeCalib = null;
		this._calibPhase = "idle";
		this._calibNote = "";
		this._activeParticles = [];
		this._selectionColor = COLOR_PALETTE[this._nextColorIndex % COLOR_PALETTE.length];
		this._axisSelect.value = "both";
		this._syncModels();
		this._updateOverlay();
	}

	_cancelAdding() {
		this._choosing = false;
		this._adding = null;
		this._activeSelection = [];
		this._activeCalib = null;
		this._calibPhase = "idle";
		this._pendingMap = null;
		this._updateOverlay();
	}

	_onCanvasClick(e) {
		if (!this._adding) return;
		const lm = this._nearestLandmark(e);
		if (!lm) return;
		const i = this._activeSelection.indexOf(lm.label);
		if (i >= 0) this._activeSelection.splice(i, 1);
		else this._activeSelection.push(lm.label);
		// A changed selection measures something else: its range starts over.
		this._activeCalib = null;
		this._calibPhase = "idle";
		this._calibNote = "";
		this._activeParticles = [];
		this._updateOverlay();
	}

	_nearestLandmark(e) {
		const rect = this._canvas.getBoundingClientRect();
		const sx = this._canvas.width / rect.width;
		const sy = this._canvas.height / rect.height;
		const rawX = (e.clientX - rect.left) * sx;
		const clickX = this._canvas.classList.contains("mirror") ? this._canvas.width - rawX : rawX;
		const clickY = (e.clientY - rect.top) * sy;
		let minDist = Infinity;
		let nearest = null;
		for (const lm of this._allLandmarks) {
			if (lm.model !== this._adding.model) continue;
			const d = Math.hypot(lm.cx - clickX, lm.cy - clickY);
			if (d < minDist) {
				minDist = d;
				nearest = lm;
			}
		}
		return minDist < 40 ? nearest : null;
	}

	// Between "Calibrate..." and "Done" the range the picked points cover is
	// measured.
	_updateActiveSelection() {
		if (!this._adding || !this._activeSelection.length || this._calibPhase !== "calibrating") return;
		const pts = this._activeSelection.map((l) => this._landmarkMap.get(l));
		if (!pts.every(Boolean)) return;
		const kind = kindForCount(pts.length);
		this._activeCalib ??= emptyCalib(kind);
		const sample = sampleFor(kind, pts, this._aspect());
		expandCalib(this._activeCalib, kind, sample);
		if (kind === "point") pushSample(this._activeSamples, sample);
	}

	// Width over height of the picture — what makes a distance on screen the
	// same whichever way it points (see sampleFor).
	_aspect() {
		return this._canvas.width / (this._canvas.height || 1);
	}

	// The texts and controls laid over the video.
	_updateOverlay() {
		const live = this._running;
		this._vidUi.hidden = !live;
		this._canvas.classList.toggle("picking", !!this._adding);
		this._addBtn.textContent = this._adding || this._choosing ? "×" : "+";
		this._addBtn.title = this._adding || this._choosing ? "Cancel" : "Add a mapping";
		this._modelChoices.hidden = !this._choosing;
		const n = this._activeSelection.length;
		const mapping = this._adding && this._pendingMap;
		this._mapWrap.hidden = !(this._adding && n > 0);
		this._axisSelect.hidden = n !== 1 || !!mapping;
		// One button, three steps: Calibrate... -> Done -> map...
		this._mapBtn.textContent = this._calibPhase === "calibrating" ? "Done" : this._calibPhase === "done" ? "map..." : "Calibrate...";
		this._mapBtn.classList.toggle("armed", !!mapping);

		let text = "";
		const loading = this._adding && this._modelState[this._adding.model].loading;
		if (this._adding) {
			text = loading
				? `Loading ${MODEL_CHOICES[this._adding.model]} tracking…`
				: mapping
					? "Click the parameter to map to"
					: this._calibNote
						? this._calibNote
						: n === 0
							? "Select one or more points in the video"
							: this._calibPhase === "idle"
								? "Click Calibrate..., then move"
								: this._calibPhase === "calibrating"
									? "Move the body to calibrate, then click Done"
									: "Click map..., then the parameter";
		}
		this._subtitle.hidden = !text;
		this._subtitle.textContent = text;
	}

	// The button over the video, in its three steps: Calibrate... starts
	// measuring the range the picked points move through, Done stops it, and
	// then it is map... (see _beginMap).
	_onMapButton() {
		if (!this._adding || !this._activeSelection.length) return;
		if (this._calibPhase === "idle") {
			const kind = kindForCount(this._activeSelection.length);
			this._activeCalib = emptyCalib(kind);
			this._activeSamples = [];
			this._calibNote = "";
			this._calibPhase = "calibrating";
			this._updateOverlay();
		} else if (this._calibPhase === "calibrating") {
			const c = this._activeCalib;
			const moved = c && ("min" in c ? c.min !== null && c.max > c.min : c.xMin !== null && (c.xMax > c.xMin || c.yMax > c.yMin));
			if (moved) {
				finalizeCalib(c, this._activeSamples, this._aspect());
				this._calibPhase = "done";
			} else {
				this._calibPhase = "idle";
				this._activeCalib = null;
				this._calibNote = "Nothing moved — try again";
			}
			this._updateOverlay();
		} else {
			this._beginMap();
		}
	}

	// "map..." — freezes the measured range and arms the shared mapping mode;
	// the row is made when a target is picked. Cancelling leaves the
	// selection as it was.
	_beginMap() {
		if (!this._adding || !this._activeSelection.length || this._calibPhase !== "done") return;
		const n = this._activeSelection.length;
		const kind = kindForCount(n);
		this._pendingMap = {
			model: this._adding.model,
			labels: [...this._activeSelection],
			mode: n === 1 ? this._axisSelect.value : "both",
			calib: { ...(this._activeCalib ?? emptyCalib(kind)) },
			color: this._selectionColor
		};
		this._armMapping(this._mapBtn, (detail) => {
			const spec = this._pendingMap;
			if (!spec) return;
			const mapping = this._mappingFromPick(detail);
			const entry = this._createEntry({ ...spec, mappings: [mapping] });
			this._nextColorIndex++;
			this._afterMappingAdded(entry, mapping, 0);
			this._adding = null;
			this._activeSelection = [];
			this._activeCalib = null;
			this._calibPhase = "idle";
			this._pendingMap = null;
			this._selectEntry(entry.id);
			this._syncModels();
			this._updateOverlay();
		});
		this._updateOverlay();
	}

	// Arms input-map-mode.js and calls onPick(detail) when a parameter or a root
	// <Var> knob is picked (see input/target-pills.js). Used by the video's
	// "map..." button and by each row's own. A numeric parameter anywhere gets a
	// new <Var> made for it (see input-mapping.js); a root <Var> knob maps onto that
	// existing Var.
	_armMapping(anchorEl, onPick) {
		armMapping(anchorEl, onPick, () => {
			if (this._pendingMap) {
				this._pendingMap = null;
				this._updateOverlay();
			}
		});
	}

	_mappingFromPick(detail) {
		return mappingFromPick(detail);
	}

	// A root <Var> target gets "value=$syntheticName" written onto it — the
	// explicit XML-visible counterpart to the synthetic variable this row
	// pushes (see _sendValue). A target made straight onto a parameter reads
	// its own hidden "input_<name>" variable instead and needs nothing here.
	_afterMappingAdded(entry, mapping, index) {
		if (mapping.direct) return;
		this._writeVarReference(mapping.varName, this._syntheticVarName(entry, index));
	}

	// ── Rows ─────────────────────────────────────────────────────────────
	// spec: { model, labels, mode, calib, color?, mappings, bypassed?, id? }
	_createEntry(spec) {
		const n = spec.labels.length;
		const kind = kindForCount(n);
		this._savedEntryCounter = Math.max(this._savedEntryCounter, spec.id || 0);
		const entry = {
			id: spec.id || ++this._savedEntryCounter,
			model: spec.model && spec.model !== "unknown" ? spec.model : modelOfLabel(spec.labels[0]),
			labels: [...spec.labels],
			labelMetas: spec.labels.map((label) => ({ label, model: modelOfLabel(label) })),
			color: spec.color || COLOR_PALETTE[this._nextColorIndex++ % COLOR_PALETTE.length],
			mode: kind === "point" ? spec.mode || "both" : "both",
			calib: { ...emptyCalib(kind), ...(spec.calib || {}) },
			mappings: (spec.mappings || []).map((m) => ({ ...m })),
			bypassed: !!spec.bypassed,
			invert: !!spec.invert,
			calibrating: false,
			particles: [],
			norm: undefined
		};
		this._buildEntryRow(entry);
		this._savedEntries.push(entry);
		this._savedListEl.appendChild(entry.row);
		this._dispatchStateChange();
		return entry;
	}

	_removeEntry(id) {
		const idx = this._savedEntries.findIndex((e) => e.id === id);
		if (idx === -1) return;
		this._savedEntries[idx].row.remove();
		this._savedEntries.splice(idx, 1);
		if (this._selectedEntryId === id) this._selectedEntryId = null;
		this._updateOverlay();
		this._dispatchStateChange();
	}

	_selectEntry(id) {
		this._selectedEntryId = this._selectedEntryId === id ? null : id;
		this._savedEntries.forEach((e) => e.row.classList.toggle("selected", e.id === this._selectedEntryId));
		this._updateOverlay();
	}

	// The menu over the video, while a one-point row is selected: which of its
	// movements the row follows. Its range already covers both axes, so
	// nothing needs measuring again. The name a root-<Var> target is fed under
	// depends on this (x / y / xy), so such targets are pointed at the new one.
	// Sets which movement a one-point row follows (the menu is in its row).
	_setEntryMode(entry, mode) {
		if (entry.labels.length !== 1 || entry.mode === mode) return;
		entry.mode = mode;
		entry.mappings.forEach((mapping, index) => this._afterMappingAdded(entry, mapping, index));
		if (entry.axisEl) entry.axisEl.value = mode;
		this._dispatchStateChange();
	}

	_measureTag(entry) {
		const n = entry.labels.length;
		if (n === 1) return entry.mode === "horizontal" ? "horizontal" : entry.mode === "vertical" ? "vertical" : "both axes";
		return n === 2 ? "distance" : "area";
	}

	_buildEntryRow(entry) {
		const row = document.createElement("div");
		row.className = "saved-row";
		row.addEventListener("click", () => this._selectEntry(entry.id));

		const top = document.createElement("div");
		top.className = "saved-row-top";

		const picker = document.createElement("wa-color-picker");
		picker.setAttribute("value", entry.color);
		picker.addEventListener("change", (e) => {
			entry.color = e.detail.value;
			entry.row.style.setProperty("--entry-color", entry.color);
			this._dispatchStateChange();
		});

		const lbl = document.createElement("div");
		lbl.className = "saved-label";
		entry.labelMetas.forEach((m, i) => {
			const sp = document.createElement("span");
			sp.className = `slm-${m.model}`;
			sp.textContent = m.label;
			lbl.appendChild(sp);
			if (i < entry.labelMetas.length - 1) {
				const sep = document.createElement("span");
				sep.className = "slm-sep";
				sep.textContent = " + ";
				lbl.appendChild(sep);
			}
		});

		// Every control is on the row whether it is selected or not: mute and
		// the × at the top right; below the points, the menu for which movement
		// a one-point row follows (the others say what they measure),
		// Calibrate, and invert.
		const muteBtn = document.createElement("button");
		muteBtn.type = "button";
		muteBtn.className = "mute-btn" + (entry.bypassed ? " active" : "");
		muteBtn.textContent = "mute";
		muteBtn.title = "Mute — this row stops setting its targets and disappears from the video, without losing anything";
		muteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			entry.bypassed = !entry.bypassed;
			muteBtn.classList.toggle("active", entry.bypassed);
			if (entry.bypassed) {
				entry.particles.length = 0;
				entry.numEl.textContent = "—";
				entry.fillEl.style.width = "0%";
			}
			this._dispatchStateChange();
		});

		const del = document.createElement("button");
		del.type = "button";
		del.className = "saved-del";
		del.textContent = "×";
		del.title = "Remove";
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			this._removeEntry(entry.id);
		});

		const pin = document.createElement("span");
		pin.className = "stage-pin";
		pin.draggable = true;
		pin.title = "Add to the Stage (click, or drag it there)";
		pin.innerHTML =
			'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>';
		pin.addEventListener("click", (e) => {
			e.stopPropagation();
			stageStore.addInput("webcam", entry.id);
			pin.classList.add("added");
			setTimeout(() => pin.classList.remove("added"), 900);
		});
		pin.addEventListener("dragstart", (e) => {
			e.stopPropagation();
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData(STAGE_INPUT_DRAG_TYPE, JSON.stringify({ source: "webcam", entryId: entry.id }));
			setCardDragImage(e.dataTransfer, row);
		});

		top.append(picker, lbl, muteBtn, pin, del);

		const controls = document.createElement("div");
		controls.className = "saved-controls";
		controls.addEventListener("click", (e) => e.stopPropagation());

		if (entry.labels.length === 1) {
			const axis = document.createElement("select");
			axis.className = "row-axis";
			axis.title = "Which movement to follow";
			[
				["horizontal", "Horizontal"],
				["vertical", "Vertical"],
				["both", "Both"]
			].forEach(([value, text]) => {
				const o = document.createElement("option");
				o.value = value;
				o.textContent = text;
				axis.appendChild(o);
			});
			axis.value = entry.mode;
			axis.addEventListener("change", () => this._setEntryMode(entry, axis.value));
			entry.axisEl = axis;
			controls.appendChild(axis);
		} else {
			const tag = document.createElement("span");
			tag.className = "measure-tag";
			tag.textContent = this._measureTag(entry);
			controls.appendChild(tag);
		}

		const calibrateBtn = document.createElement("button");
		calibrateBtn.type = "button";
		calibrateBtn.className = "calibrate-btn";
		calibrateBtn.textContent = "Calibrate";
		calibrateBtn.title = "While active, the range expands to fit whatever this row measures";
		calibrateBtn.addEventListener("click", () => this._toggleCalibrate(entry));
		entry.calibrateBtn = calibrateBtn;
		controls.appendChild(calibrateBtn);

		// Invert: 0–1 becomes 1–0.
		const invertBtn = document.createElement("button");
		invertBtn.type = "button";
		invertBtn.className = "icon-btn" + (entry.invert ? " active" : "");
		invertBtn.title = "Invert — the value runs 1 to 0 instead of 0 to 1";
		invertBtn.setAttribute("aria-label", "Invert");
		invertBtn.innerHTML =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5"/></svg>';
		invertBtn.addEventListener("click", () => {
			entry.invert = !entry.invert;
			invertBtn.classList.toggle("active", entry.invert);
			this._dispatchStateChange();
		});
		controls.appendChild(invertBtn);

		const hint = document.createElement("div");
		hint.className = "calibrate-hint";
		hint.hidden = true;
		hint.textContent = "Move to cover the full range you want, then click Calibrate again to lock it in.";
		entry.calibrateHint = hint;

		const valueRow = document.createElement("div");
		valueRow.className = "value-row";
		const bar = document.createElement("div");
		bar.className = "value-bar";
		const fill = document.createElement("div");
		fill.className = "value-fill";
		bar.appendChild(fill);
		const num = document.createElement("span");
		num.className = "value-num";
		num.textContent = "—";
		valueRow.append(bar, num);
		entry.fillEl = fill;
		entry.numEl = num;

		const targets = document.createElement("div");
		targets.className = "targets";
		targets.addEventListener("click", (e) => e.stopPropagation());
		entry.targetsEl = targets;

		row.style.setProperty("--entry-color", entry.color);
		row.append(top, controls, hint, valueRow, targets);
		entry.row = row;
		this._refreshTargets(entry);
		return row;
	}

	// One pill per target (click to point it somewhere else, × to remove it) and a
	// "Map..." that adds another — see input/target-pills.js.
	_refreshTargets(entry) {
		renderTargetPills(entry.targetsEl, entry, {
			syntheticName: (index) => this._syntheticVarName(entry, index),
			onChange: () => this._dispatchStateChange(),
			armFn: (anchorEl, onPick) => this._armMapping(anchorEl, onPick)
		});
	}

	// A stable name for what a root-<Var> target of this row is fed under —
	// e.g. a single point tracking "rightHand8" in Horizontal mode becomes
	// "rightHand8x" (the names of the earlier version are kept, so a root
	// <Var> referring to one keeps working); a second target gets "_2", ...
	_syntheticVarName(entry, mappingIndex) {
		const n = entry.labels.length;
		const key = n === 1 ? (entry.mode === "horizontal" ? "x" : entry.mode === "vertical" ? "y" : "xy") : n === 2 ? "dist2d" : "area2d";
		const base = entry.labels.join("") + key;
		return mappingIndex > 0 ? `${base}_${mappingIndex + 1}` : base;
	}

	// Writes "$syntheticName" onto `targetVarName`'s own "value" attribute (see
	// input/target-pills.js) — the explicit XML-visible counterpart to _sendValue's own
	// playerStore.setVariable(syntheticName, ...) push.
	_writeVarReference(targetVarName, syntheticName) {
		writeVarReference(targetVarName, syntheticName);
	}

	// Calibration of a row: while on, its range is measured anew (starting
	// empty) and widens to everything the row sees; turning it off keeps it.
	_toggleCalibrate(entry) {
		entry.calibrating = !entry.calibrating;
		if (entry.calibrating) {
			entry.calib = emptyCalib(kindForCount(entry.labels.length));
			entry.samples = [];
		} else {
			finalizeCalib(entry.calib, entry.samples || [], this._aspect());
		}
		entry.calibrateBtn.classList.toggle("active", entry.calibrating);
		entry.calibrateBtn.textContent = entry.calibrating ? "Done" : "Calibrate";
		entry.calibrateHint.hidden = !entry.calibrating;
		if (!entry.calibrating) this._dispatchStateChange();
	}

	// One frame of one row: measure, (while calibrating) widen the range,
	// normalize to 0–1 and send it to every target. Only a calibrated row
	// sends, and only when not bypassed. Values outside the range are clamped.
	_updateEntryValue(entry) {
		const pts = entry.labels.map((l) => this._landmarkMap.get(l));
		if (!pts.every(Boolean)) {
			entry.norm = undefined;
			entry.numEl.textContent = "—";
			entry.fillEl.style.width = "0%";
			return;
		}
		const kind = kindForCount(entry.labels.length);
		const aspect = this._aspect();
		const sample = sampleFor(kind, pts, aspect);
		if (entry.calibrating) {
			expandCalib(entry.calib, kind, sample);
			if (kind === "point") pushSample((entry.samples ??= []), sample);
		}
		const measured = normalizeSample(kind, entry.mode, entry.calib, sample, aspect);
		// Inverted: 0–1 becomes 1–0.
		const norm = measured === undefined ? undefined : entry.invert ? 1 - measured : measured;
		entry.norm = norm;
		// A muted row shows nothing: its value and bar are blank (and its
		// effect is not drawn, see _renderCanvas).
		const shown = norm !== undefined && !entry.bypassed;
		entry.numEl.textContent = shown ? norm.toFixed(2) : "—";
		entry.fillEl.style.width = shown ? `${norm * 100}%` : "0%";
		if (!shown) return;
		entry.mappings.forEach((mapping, index) => {
			if (!mapping?.varName) return;
			// A target made straight onto a parameter (see input-mapping.js) is
			// fed through the hidden "input_<name>" variable its <Var> reads.
			playerStore.setVariable(mapping.direct ? mapping.inputVar : this._syntheticVarName(entry, index), norm);
		});
	}

	// ── Drawing ──────────────────────────────────────────────────────────
	_renderCanvas(now, spawn = true) {
		const ctx = this._ctx;
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		if (this._adding) this._drawSkeleton(this._adding.model);

		for (const entry of this._savedEntries) {
			// A muted row is not drawn at all. While a row is being calibrated
			// its spray is free, so every line the point moves along shows;
			// it is held to the row's axis or line only once Done is clicked.
			if (entry.bypassed) continue;
			this._drawEffect(ctx, entry.labels, entry.color, entry.particles, now, entry.calibrating ? null : { mode: entry.mode, calib: entry.calib }, spawn);
		}

		if (this._adding && this._activeSelection.length) {
			// Free until Done: the spray is held to the chosen axis or line only
			// once the calibration is finished, so that it is open to every line
			// the point is moved along while measuring.
			const view = this._activeSelection.length === 1 && this._calibPhase === "done" ? { mode: this._axisSelect.value, calib: this._activeCalib } : null;
			this._drawEffect(ctx, this._activeSelection, this._selectionColor, this._activeParticles, now, view, spawn);
			ctx.lineWidth = 2.5;
			for (const label of this._activeSelection) {
				const lm = this._landmarkMap.get(label);
				if (!lm) continue;
				ctx.beginPath();
				ctx.arc(lm.cx, lm.cy, 9, 0, Math.PI * 2);
				ctx.fillStyle = this._selectionColor;
				ctx.fill();
				ctx.strokeStyle = "#fff";
				ctx.stroke();
			}
		}

		// A selected row's points are ringed.
		const selected = this._savedEntries.find((e) => e.id === this._selectedEntryId);
		if (selected) {
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 3;
			for (const label of selected.labels) {
				const lm = this._landmarkMap.get(label);
				if (!lm) continue;
				ctx.beginPath();
				ctx.arc(lm.cx, lm.cy, 13, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
	}

	// The tracker's own skeleton, drawn only while points are being picked in
	// it — the rows' effects are what shows otherwise.
	_drawSkeleton(model) {
		const mod = this._visionModule;
		if (!mod || !this._drawUtils) return;
		const results = this._modelState[model].results;
		if (model === "hands" && results?.landmarks) {
			for (const lms of results.landmarks) {
				this._drawUtils.drawConnectors(lms, mod.HandLandmarker.HAND_CONNECTIONS, { color: "#45b58c", lineWidth: 3 });
				this._drawUtils.drawLandmarks(lms, { color: "#2f8f6e", fillColor: "#12362a", lineWidth: 1, radius: 4 });
			}
		} else if (model === "pose" && results?.landmarks) {
			for (const lms of results.landmarks) {
				this._drawUtils.drawConnectors(lms, mod.PoseLandmarker.POSE_CONNECTIONS, { color: "#fb923c", lineWidth: 3 });
				this._drawUtils.drawLandmarks(lms, { color: "#c2660f", fillColor: "#3a2007", lineWidth: 1, radius: 4 });
			}
		} else if (model === "face" && results?.faceLandmarks) {
			for (const lms of results.faceLandmarks) {
				this._drawUtils.drawConnectors(lms, mod.FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "rgba(79,163,255,0.12)", lineWidth: 1 });
				this._drawUtils.drawConnectors(lms, mod.FaceLandmarker.FACE_LANDMARKS_CONTOURS, { color: "#4fa3ff", lineWidth: 2 });
				// The contours leave out most of the 478 points, so the ones the
				// click can land on are dotted in to be findable.
				ctx_dots(this._ctx, lms, this._canvas);
			}
		}
	}

	// One point sprays its color along its path (dots that follow it and fade
	// in 200 ms, like a tail), two points are joined by a line and three or more
	// enclose a surface — all in the given color, in real time.
	//
	// `view` ({ mode, calib }, one point only): the spray is held to what the
	// row follows, so the limitation shows in the picture. With Horizontal it
	// runs along a horizontal line at the average height the calibration saw,
	// from the calibrated minimum to the maximum x and no further (Vertical:
	// a vertical line at the average x, between the calibrated y); with both
	// axes it runs
	// along the line the value follows, from end to end, at the point's place
	// on it. The line is drawn faintly. Until there is a calibration the
	// spray runs along where the point first was.
	_drawEffect(ctx, labels, color, particles, now, view = null, spawn = true) {
		const pts = labels.map((l) => this._landmarkMap.get(l));
		const all = pts.length > 0 && pts.every(Boolean);
		if (labels.length === 1) {
			let at = all ? { x: pts[0].cx, y: pts[0].cy } : null;
			if (at && view && (view.mode === "horizontal" || view.mode === "vertical" || view.mode === "both")) {
				const W = this._canvas.width;
				const H = this._canvas.height;
				const c = view.calib;
				particles.anchor ??= { x: at.x, y: at.y };
				// Canvas x is the unmirrored picture and y runs downwards; a
				// calibration's x is as shown (mirrored) and its y runs upwards.
				const toX = (sx) => (1 - sx) * W;
				const toY = (sy) => (1 - sy) * H;
				const guide = (x1, y1, x2, y2) => {
					ctx.save();
					ctx.strokeStyle = color;
					ctx.globalAlpha = 0.35;
					ctx.lineWidth = 2;
					ctx.setLineDash([6, 5]);
					ctx.beginPath();
					ctx.moveTo(x1, y1);
					ctx.lineTo(x2, y2);
					ctx.stroke();
					ctx.restore();
				};
				if (view.mode === "horizontal") {
					const mean = c ? axisMean(c, "y") : null;
					const y = mean !== null ? toY(mean) : particles.anchor.y;
					if (c && c.xMin !== null) guide(toX(c.xMax), y, toX(c.xMin), y);
					// The spray stops at the ends of the calibrated range.
					const sx = c && c.xMin !== null ? Math.max(c.xMin, Math.min(c.xMax, 1 - pts[0].x)) : 1 - pts[0].x;
					at = { x: toX(sx), y };
				} else if (view.mode === "vertical") {
					const mean = c ? axisMean(c, "x") : null;
					const x = mean !== null ? toX(mean) : particles.anchor.x;
					if (c && c.yMin !== null) guide(x, toY(c.yMax), x, toY(c.yMin));
					const sy = c && c.yMin !== null ? Math.max(c.yMin, Math.min(c.yMax, 1 - pts[0].y)) : 1 - pts[0].y;
					at = { x, y: toY(sy) };
				} else {
					const line = c ? linePosition(c, { sx: 1 - pts[0].x, sy: 1 - pts[0].y }, this._aspect()) : null;
					if (line) {
						guide(toX(line.a.x), toY(line.a.y), toX(line.b.x), toY(line.b.y));
						at = { x: toX(line.a.x + line.t * (line.b.x - line.a.x)), y: toY(line.a.y + line.t * (line.b.y - line.a.y)) };
					}
				}
			}
			// A steady trail: the position is smoothed a little, and the gap from
			// where the point was last time is filled in with dots along the way
			// — so the trail is continuous however fast the point moves and at
			// whatever rate the camera delivers pictures. The dots are small and
			// hardly scatter; the axis a locked spray is limited to is not
			// scattered across at all.
			if (spawn) {
				if (!at) {
					particles.last = null;
				} else {
					const prev = particles.last;
					const now2 = prev ? { x: prev.x + (at.x - prev.x) * 0.6, y: prev.y + (at.y - prev.y) * 0.6 } : at;
					const gap = prev ? Math.hypot(now2.x - prev.x, now2.y - prev.y) : 0;
					const steps = Math.max(1, Math.min(30, Math.round(gap / 3)));
					const lockedY = view?.mode === "horizontal";
					const lockedX = view?.mode === "vertical";
					for (let k = 1; k <= steps; k++) {
						const t = k / steps;
						const x = prev ? prev.x + (now2.x - prev.x) * t : now2.x;
						const y = prev ? prev.y + (now2.y - prev.y) * t : now2.y;
						particles.push({
							x: x + (lockedX ? 0 : (Math.random() - 0.5) * 3),
							y: y + (lockedY ? 0 : (Math.random() - 0.5) * 3),
							r: 2.5 + Math.random() * 2,
							born: now
						});
					}
					particles.last = now2;
				}
			}
			for (let i = particles.length - 1; i >= 0; i--) {
				const p = particles[i];
				const age = now - p.born;
				if (age >= SPRAY_MS) {
					particles.splice(i, 1);
					continue;
				}
				const life = 1 - age / SPRAY_MS;
				ctx.globalAlpha = life * 0.9;
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.arc(p.x, p.y, p.r * (0.5 + life * 0.5), 0, Math.PI * 2);
				ctx.fill();
			}
			ctx.globalAlpha = 1;
			return;
		}
		if (!all) return;
		// An area goes round its points in order, whatever order they were picked.
		const ring = pts.length >= 3 ? angularOrder(pts, this._aspect()) : pts;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 5;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		ctx.beginPath();
		ring.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
		if (pts.length >= 3) {
			ctx.closePath();
			ctx.globalAlpha = 0.35;
			ctx.fillStyle = color;
			ctx.fill();
			ctx.globalAlpha = 1;
		}
		ctx.stroke();
		ctx.restore();
	}
}

// The landmarks of a face as small dots (a face has hundreds, so most are
// only visible as tracked points when picking).
function ctx_dots(ctx, lms, canvas) {
	ctx.fillStyle = "rgba(255,255,255,0.35)";
	for (let i = 0; i < lms.length; i += 1) {
		ctx.fillRect(lms[i].x * canvas.width - 1, lms[i].y * canvas.height - 1, 2, 2);
	}
}

customElements.define("wa-webcam-input", WaWebcamInput);
