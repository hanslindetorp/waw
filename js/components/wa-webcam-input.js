import { playerStore } from "../waxml-integration/player-store.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { inputMapMode } from "../state/input-map-mode.js";
import { showNotice } from "./wa-notice-dialog.js";

// The INPUT panel's "Web Camera" section — MediaPipe hand/pose/face tracking
// that lets Hans click a landmark (or several) on the live webcam feed and
// map its live metrics (x/y/z for one point; dist2d/dist3d for two;
// area/circumference for three or more) onto a root-level <Var>, driven live
// via playerStore.setVariable() — same call wa-var-knobs.js's own knobs use.
//
// Ported from Hans's own reference implementation (https://msw.waxml.org/,
// fetched 2026-09-22) — the landmark math (dist2d/dist3d/area2d/area3d/
// circum2d/circum3d), the click-to-select hit-test, and the per-frame
// landmark rebuild are all near-verbatim from there. What's new here,
// per Hans's own architecture call (2026-09-22):
//   - No video-file mode — webcam only, for this first pass.
//   - Camera/model loading is gated behind an explicit Start button (never
//     auto-starts just because this section is visible) — matches this
//     app's existing "never resume audio without a real user gesture" rule
//     (see waxml-bridge.js).
//   - The reference's own sendToWaxml() was stubbed out with commented
//     placeholder setVariable() calls and auto-derived variable names
//     (hand5x, hand5y, ...). Here, each metric is *explicitly* mapped to an
//     existing root <Var> — INPUT stays outside the WAXML spec itself (no
//     new schema elements), but what it writes into is a completely
//     ordinary root Var. Only mapped metrics are ever sent; everything else
//     is display-only.
//   - That mapping (plus which models are enabled and which camera is
//     selected) is persisted via getState()/applyState() — see
//     workstation-state.js's own registerLayoutExtras wiring — never as
//     WAXML document content.
//   - Mapping a metric onto a Var (per Hans, 2026-10-03) arms the shared
//     input-map-mode.js singleton, the same "arm a mode, let some other
//     element claim the next click" shape var-map-mode.js's own Var-to-
//     attribute mapping already uses, instead of a popup menu — see
//     _mapKey. Every root-level <Var> knob (wa-var-knobs.js's global row
//     only, never the local one) is the only valid target; there's no way
//     to create a new one from here anymore, so an empty root gets an
//     explanatory notice instead of arming with nothing to pick.

const MEDIAPIPE_VERSION = "0.10.35";
const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URLS = {
	hands: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
	pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
	face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
};

// ── Math helpers (per Hans's own reference, verbatim) ─────────────────────
const dist2d = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
const dist3d = (a, b) => Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);

function area2d(pts) {
	let s = 0;
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
	}
	return Math.abs(s) / 2;
}

function area3d(pts) {
	const [a, b, c] = pts;
	const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
	const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
	const cx = ab.y * ac.z - ab.z * ac.y;
	const cy = ab.z * ac.x - ab.x * ac.z;
	const cz = ab.x * ac.y - ab.y * ac.x;
	return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

function circum2d(pts) {
	let p = 0;
	const n = pts.length;
	for (let i = 0; i < n; i++) p += dist2d(pts[i], pts[(i + 1) % n]);
	return p;
}

function circum3d(pts) {
	return dist3d(pts[0], pts[1]) + dist3d(pts[1], pts[2]) + dist3d(pts[2], pts[0]);
}

function calcValues(pts, type) {
	switch (type) {
		case "point":
			return { x: pts[0].x, y: pts[0].y, z: pts[0].z };
		case "dist":
			return { dist2d: dist2d(pts[0], pts[1]), dist3d: dist3d(pts[0], pts[1]) };
		case "triangle":
			return { area2d: area2d(pts), area3d: area3d(pts), circum2d: circum2d(pts), circum3d: circum3d(pts) };
		case "polygon":
			return { area2d: area2d(pts), circum2d: circum2d(pts) };
		default:
			return {};
	}
}

const TYPE_KEYS = {
	point: ["x", "y", "z"],
	dist: ["dist2d", "dist3d"],
	triangle: ["area2d", "area3d", "circum2d", "circum3d"],
	polygon: ["area2d", "circum2d"]
};

function typeForCount(n) {
	return n === 1 ? "point" : n === 2 ? "dist" : n === 3 ? "triangle" : "polygon";
}

function fmt(v) {
	return Number.isFinite(v) ? parseFloat(v.toFixed(3)) : "—";
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
		.model-btn {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.3rem 0.6rem 0.3rem 0.5rem;
			border: 1.5px solid var(--waw-border, #2f2f2f);
			border-radius: 7px;
			background: #1a1c1f;
			color: var(--waw-muted, #8a8a8a);
			cursor: pointer;
			font-size: 0.78rem;
			font-family: inherit;
		}
		.model-btn .dot {
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--waw-border, #2f2f2f);
			flex-shrink: 0;
		}
		.model-btn.active[data-model="hands"] {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
		}
		.model-btn.active[data-model="hands"] .dot {
			background: var(--waw-teal, #45b58c);
		}
		.model-btn.active[data-model="pose"] {
			border-color: #fb923c;
			color: #fb923c;
		}
		.model-btn.active[data-model="pose"] .dot {
			background: #fb923c;
		}
		.model-btn.active[data-model="face"] {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.model-btn.active[data-model="face"] .dot {
			background: var(--waw-accent, #4fa3ff);
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
		/* Per-entry mute — per Hans (2026-09-27): a manual knob drag should
		   always be possible even while INPUT drives it, but if the webcam
		   keeps sending values every frame that fights any manual attempt,
		   so this lets one entry stop feeding its mapped Var(s) without
		   losing its mappings (unlike deleting it outright). */
		.bypass-toggle {
			position: relative;
			display: inline-block;
			width: 26px;
			height: 15px;
			flex-shrink: 0;
		}
		.bypass-toggle input {
			opacity: 0;
			width: 0;
			height: 0;
		}
		.bypass-toggle .toggle-track {
			position: absolute;
			inset: 0;
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 15px;
			cursor: pointer;
			transition: background 0.12s ease;
		}
		.bypass-toggle .toggle-track::before {
			content: "";
			position: absolute;
			width: 9px;
			height: 9px;
			left: 2px;
			top: 2px;
			background: var(--waw-muted, #8a8a8a);
			border-radius: 50%;
			transition: transform 0.12s ease, background 0.12s ease;
		}
		.bypass-toggle input:checked + .toggle-track {
			background: rgba(69, 181, 140, 0.18);
			border-color: var(--waw-teal, #45b58c);
		}
		.bypass-toggle input:checked + .toggle-track::before {
			transform: translateX(11px);
			background: var(--waw-teal, #45b58c);
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
			cursor: crosshair;
		}
		.status-overlay {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.82);
			display: flex;
			align-items: center;
			justify-content: center;
			text-align: center;
			padding: 1rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.8rem;
		}
		.status-overlay.error {
			color: var(--waw-danger, #e5484d);
		}
		.status-overlay[hidden] {
			display: none;
		}
		.sel-panel {
			background: rgba(255, 255, 255, 0.04);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			padding: 0.6rem 0.7rem;
			margin-bottom: 0.6rem;
		}
		.sel-top {
			display: flex;
			align-items: flex-start;
			gap: 0.5rem;
		}
		.chip-container {
			flex: 1 1 auto;
			display: flex;
			flex-wrap: wrap;
			gap: 0.3rem;
			align-items: center;
			min-height: 1.5rem;
		}
		.hint-text {
			font-size: 0.68rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.sel-chip {
			display: inline-flex;
			align-items: center;
			gap: 0.3rem;
			padding: 0.15rem 0.3rem 0.15rem 0.5rem;
			border-radius: 20px;
			font-size: 0.75rem;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			border: 1px solid;
		}
		.sel-chip.model-hands {
			border-color: var(--waw-teal, #45b58c);
			color: var(--waw-teal, #45b58c);
		}
		.sel-chip.model-pose {
			border-color: #fb923c;
			color: #fb923c;
		}
		.sel-chip.model-face {
			border-color: var(--waw-accent, #4fa3ff);
			color: var(--waw-accent, #4fa3ff);
		}
		.sel-chip button {
			background: none;
			border: none;
			color: currentColor;
			cursor: pointer;
			font-size: 0.85rem;
			padding: 0;
			opacity: 0.6;
			line-height: 1;
		}
		.sel-chip button:hover {
			opacity: 1;
		}
		.sel-actions {
			flex: 0 0 auto;
			display: flex;
			gap: 0.3rem;
		}
		.clear-btn,
		.add-btn {
			padding: 0.2rem 0.5rem;
			border-radius: 5px;
			font-size: 0.75rem;
			font-family: inherit;
			cursor: pointer;
			white-space: nowrap;
		}
		.clear-btn {
			background: none;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: var(--waw-muted, #8a8a8a);
		}
		.add-btn {
			background: var(--waw-accent, #4fa3ff);
			border: none;
			color: #06131f;
			font-weight: 600;
		}
		.live-values {
			display: flex;
			gap: 0.9rem;
			flex-wrap: wrap;
			margin-top: 0.5rem;
		}
		.coord-block {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.15rem;
		}
		.coord-key {
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.coord-val {
			font-size: 0.85rem;
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			color: var(--waw-fg, #e8e8e8);
			min-width: 3.2rem;
			text-align: center;
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
		}
		.saved-row-top {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
		}
		.saved-label {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
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
		.saved-vals {
			display: flex;
			flex-wrap: wrap;
			gap: 0.6rem 0.9rem;
		}
		.sv-block {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.2rem;
		}
		.sv-key {
			font-size: 0.6rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.sv-val {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.82rem;
			font-weight: 600;
			color: var(--waw-fg, #e8e8e8);
			min-width: 3rem;
			text-align: center;
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
		/* Whichever button/pill armed input-map-mode.js just now — same
		   yellow ring wa-var-knobs.js's own Map button and every valid
		   target use (see that file's own comment on why the @keyframes is
		   declared again per shadow root). Per Hans (2026-10-03). */
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
		/* Stacked, not inline — an entry can map the same metric to several
		   <Var>s now (per Hans, 2026-09-30), so this needs room for more than
		   one pill plus the trailing "Map..." button. */
		.sv-map-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.2rem;
		}
	</style>
	<div class="row">
		<button class="model-btn active" type="button" data-model="hands"><span class="dot"></span>Hands</button>
		<button class="model-btn active" type="button" data-model="pose"><span class="dot"></span>Body</button>
		<button class="model-btn active" type="button" data-model="face"><span class="dot"></span>Face</button>
		<select class="camera-select" title="Camera"></select>
	</div>
	<div class="row">
		<button class="start-btn" type="button">Start</button>
	</div>
	<div class="video-wrapper">
		<video autoplay playsinline muted></video>
		<canvas></canvas>
		<div class="status-overlay">Camera is off. Click Start to begin tracking.</div>
	</div>
	<div class="sel-panel">
		<div class="sel-top">
			<div class="chip-container"><span class="hint-text">Select one or more points in the video</span></div>
			<div class="sel-actions">
				<button class="clear-btn hidden" type="button">Clear</button>
				<button class="add-btn hidden" type="button">+ Add</button>
			</div>
		</div>
		<div class="live-values"></div>
	</div>
	<div class="saved-list"></div>
`;

export class WaWebcamInput extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._videoEl = this.shadowRoot.querySelector("video");
		this._canvas = this.shadowRoot.querySelector("canvas");
		this._ctx = this._canvas.getContext("2d");
		this._statusOverlay = this.shadowRoot.querySelector(".status-overlay");
		this._cameraSelect = this.shadowRoot.querySelector(".camera-select");
		this._startBtn = this.shadowRoot.querySelector(".start-btn");
		this._chipContainer = this.shadowRoot.querySelector(".chip-container");
		this._liveValuesDiv = this.shadowRoot.querySelector(".live-values");
		this._clearBtn = this.shadowRoot.querySelector(".clear-btn");
		this._addBtn = this.shadowRoot.querySelector(".add-btn");
		this._savedListEl = this.shadowRoot.querySelector(".saved-list");

		this._modelState = {
			hands: { enabled: true, instance: null, results: null },
			pose: { enabled: true, instance: null, results: null },
			face: { enabled: true, instance: null, results: null }
		};
		this._drawUtils = null;
		this._visionModule = null; // the dynamically-imported MediaPipe module, cached across Start/Stop
		this._modelsLoadPromise = null;
		this._currentStream = null;
		this._cameraDeviceId = null;
		this._running = false;
		this._rafId = null;

		this._activeSelection = new Set(); // clicked-but-not-yet-saved labels
		this._allLandmarks = [];
		this._landmarkMap = new Map();
		this._savedEntries = []; // { id, type, labelMetas, lastValues, mappings, row, valueEls, mapEls }
		this._savedEntryCounter = 0;
		this._liveDisplayType = null;
		this._liveSpans = {};

		this._tick = this._tick.bind(this);
		this._onCanvasClick = this._onCanvasClick.bind(this);
	}

	connectedCallback() {
		this.shadowRoot.querySelectorAll(".model-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const model = btn.dataset.model;
				const state = this._modelState[model];
				state.enabled = !state.enabled;
				btn.classList.toggle("active", state.enabled);
				if (!state.enabled) state.results = null;
				this._dispatchStateChange();
			});
		});
		this._startBtn.addEventListener("click", () => (this._running ? this._stop() : this._start()));
		this._cameraSelect.addEventListener("change", () => {
			this._cameraDeviceId = this._cameraSelect.value || null;
			if (this._running) this._startCamera(this._cameraDeviceId);
			this._dispatchStateChange();
		});
		this._canvas.addEventListener("click", this._onCanvasClick);
		this._clearBtn.addEventListener("click", () => {
			this._activeSelection.clear();
			this._updateSelectionUI();
		});
		this._addBtn.addEventListener("click", () => {
			this._addToSaved();
			this._activeSelection.clear();
			this._updateSelectionUI();
		});
	}

	disconnectedCallback() {
		this._stop();
	}

	// Public wrapper so outside code (workstation-state.js's
	// resetWebcamInputForNewProject, called from "File > New...") can stop
	// tracking without reaching into the underscore-prefixed internals.
	stop() {
		this._stop();
	}

	// ── Persistence (workstation-state.json, via workstation-state.js's own
	// registerLayoutExtras — see that file's "webcamInput" wiring) ──────────
	getState() {
		return {
			modelToggles: {
				hands: this._modelState.hands.enabled,
				pose: this._modelState.pose.enabled,
				face: this._modelState.face.enabled
			},
			cameraDeviceId: this._cameraDeviceId,
			running: this._running,
			entries: this._savedEntries.map((e) => ({
				id: e.id,
				labels: e.labelMetas.map((m) => m.label),
				type: e.type,
				mappings: Object.fromEntries(Object.entries(e.mappings).map(([key, list]) => [key, list.map((m) => ({ ...m }))])),
				bypassed: e.bypassed
			}))
		};
	}

	applyState(state) {
		if (!state || typeof state !== "object") return;
		if (state.modelToggles && typeof state.modelToggles === "object") {
			["hands", "pose", "face"].forEach((model) => {
				if (typeof state.modelToggles[model] !== "boolean") return;
				this._modelState[model].enabled = state.modelToggles[model];
				this.shadowRoot.querySelector(`.model-btn[data-model="${model}"]`)?.classList.toggle("active", state.modelToggles[model]);
			});
		}
		if (typeof state.cameraDeviceId === "string") this._cameraDeviceId = state.cameraDeviceId;
		if (Array.isArray(state.entries)) {
			state.entries.forEach((e) => {
				if (!Array.isArray(e.labels) || e.labels.length === 0) return;
				this._restoreSavedEntry(e);
			});
		}
		// Per Hans (2026-09-26): a project saved with the camera running
		// should have it running again as soon as the project opens, rather
		// than making the user click Start every time. Not a "resume audio
		// without a gesture" violation the way autoplaying sound would be —
		// opening a project (via a real file-picker interaction) is itself
		// the user gesture, same as it already is for saved panel layout.
		if (state.running) this._start();
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	// ── Start / Stop ─────────────────────────────────────────────────────
	// getUserMedia() is called as the very first async step, in parallel
	// with (not after) loading MediaPipe's model files — those are fetched
	// over the network and can easily take several seconds, and some
	// browsers stop treating a getUserMedia call as driven by the
	// triggering user gesture once that much time has passed since it. The
	// old serial order (models, then camera) was silently breaking the
	// project-open autostart (applyState's own _start() call, itself
	// already downstream of the file-open gesture by the time the project
	// file and workstation-state.json have been read/parsed): by the time
	// it reached getUserMedia, the gesture had already gone stale, so it
	// silently sat there needing an actual click. Per Hans's bug report
	// (2026-09-29). Requesting the camera first (alongside, not blocked by,
	// the model load) keeps it as close to the gesture as possible — and is
	// strictly faster besides, since the two loads now run concurrently.
	async _start() {
		this._startBtn.disabled = true;
		this._setStatus("Requesting camera…", false);
		try {
			const modelsPromise = this._ensureModelsLoaded();
			const activeId = await this._startCamera(this._cameraDeviceId);
			this._setStatus("Loading MediaPipe…", false);
			await modelsPromise;
			await this._enumerateCameras(activeId);
			this._running = true;
			this._startBtn.textContent = "Stop";
			this._startBtn.classList.add("running");
			this._statusOverlay.hidden = true;
			this._rafId = requestAnimationFrame(this._tick);
		} catch (err) {
			this._setStatus(`Error: ${err.message}\nCheck camera access and network connection.`, true);
		} finally {
			this._startBtn.disabled = false;
		}
	}

	_stop() {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
		if (this._currentStream) {
			this._currentStream.getTracks().forEach((t) => t.stop());
			this._currentStream = null;
		}
		this._running = false;
		this._startBtn.textContent = "Start";
		this._startBtn.classList.remove("running");
		this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		this._setStatus("Camera is off. Click Start to begin tracking.", false);
	}

	_setStatus(text, isError) {
		this._statusOverlay.hidden = false;
		this._statusOverlay.classList.toggle("error", !!isError);
		this._statusOverlay.textContent = text;
	}

	// Loads the WASM runtime + all three models once, then keeps them warm
	// across later Stop/Start toggles — per Hans (2026-09-22): re-downloading
	// ~3 model files every time the user toggles Start would be wasteful.
	_ensureModelsLoaded() {
		if (this._modelsLoadPromise) return this._modelsLoadPromise;
		this._modelsLoadPromise = (async () => {
			const mod = await import(/* webpackIgnore: true */ VISION_BUNDLE_URL);
			this._visionModule = mod;
			const { HandLandmarker, PoseLandmarker, FaceLandmarker, FilesetResolver, DrawingUtils } = mod;
			const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
			await Promise.all([
				HandLandmarker.createFromOptions(vision, {
					baseOptions: { modelAssetPath: MODEL_URLS.hands, delegate: "GPU" },
					runningMode: "VIDEO",
					numHands: 2
				}).then((lm) => (this._modelState.hands.instance = lm)),
				PoseLandmarker.createFromOptions(vision, {
					baseOptions: { modelAssetPath: MODEL_URLS.pose, delegate: "GPU" },
					runningMode: "VIDEO",
					numPoses: 1
				}).then((lm) => (this._modelState.pose.instance = lm)),
				FaceLandmarker.createFromOptions(vision, {
					baseOptions: { modelAssetPath: MODEL_URLS.face, delegate: "GPU" },
					runningMode: "VIDEO",
					numFaces: 1
				}).then((lm) => (this._modelState.face.instance = lm))
			]);
			this._drawUtils = new DrawingUtils(this._ctx);
		})();
		return this._modelsLoadPromise;
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
			const ts = performance.now();
			const ms = this._modelState;
			ms.hands.results = ms.hands.enabled ? ms.hands.instance.detectForVideo(this._videoEl, ts) : null;
			ms.pose.results = ms.pose.enabled ? ms.pose.instance.detectForVideo(this._videoEl, ts) : null;
			ms.face.results = ms.face.enabled ? ms.face.instance.detectForVideo(this._videoEl, ts) : null;
			this._onMediaPipeUpdate();
		}
		if (this._running) this._rafId = requestAnimationFrame(this._tick);
	}

	// Variable-name-free version of the reference's own onMediaPipeUpdate —
	// labels stay hand0..41 / pose0..32 / face0..477 (used only to identify
	// which landmark a saved entry/active selection points at); the actual
	// WAXML variable it feeds comes from that entry's own per-key mapping
	// (see _sendMappedValues), not the label itself.
	_onMediaPipeUpdate() {
		this._allLandmarks = [];
		this._landmarkMap.clear();
		const push = (e) => {
			this._allLandmarks.push(e);
			this._landmarkMap.set(e.label, e);
		};

		if (this._modelState.hands.results?.landmarks) {
			const { landmarks, handedness, handednesses } = this._modelState.hands.results;
			// The field was renamed "handedness" -> "handednesses" at some
			// point in @mediapipe/tasks-vision's own history — checking both
			// costs nothing and keeps this working across versions.
			const handsList = handednesses || handedness || [];
			let idx = 0;
			landmarks.forEach((hand, handIdx) => {
				const rawSide = handsList[handIdx]?.[0]?.categoryName; // "Left" | "Right", per MediaPipe's own (unmirrored) frame
				// The preview is always shown mirrored (see _startCamera's own
				// ".mirror" class), so MediaPipe's own Left/Right — classified
				// from the raw, unmirrored camera frame — reads backwards from
				// what the user visually sees as *their* left/right hand on
				// screen; swap to match the display. Per Hans (2026-10-03):
				// "Det ska gå att mappa händerna separat. Visst finns det
				// leftHand och rightHand?"
				const side = rawSide === "Left" ? "rightHand" : rawSide === "Right" ? "leftHand" : null;
				hand.forEach((lm, i) => {
					const point = {
						model: "hands",
						x: parseFloat(lm.x.toFixed(3)),
						y: parseFloat(lm.y.toFixed(3)),
						z: parseFloat((lm.z ?? 0).toFixed(3)),
						cx: lm.x * this._canvas.width,
						cy: lm.y * this._canvas.height
					};
					// The old combined "hand0".."hand41" labels (first-detected
					// hand 0-20, second 21-41, no left/right distinction) are
					// kept ONLY in _landmarkMap — never _allLandmarks, so a new
					// click in the canvas can never select one — purely so an
					// already-saved entry that still references one keeps
					// resolving exactly as it always did. Per Hans (2026-10-03):
					// "Om man öppnar ett projekt som är gjort med bara 'hand'
					// ska den mappas från båda händerna som tidigare."
					this._landmarkMap.set(`hand${idx}`, { label: `hand${idx}`, ...point });
					idx++;
					if (side) push({ label: `${side}${i}`, ...point });
				});
			});
		}
		if (this._modelState.pose.results?.landmarks) {
			for (const pose of this._modelState.pose.results.landmarks) {
				for (let i = 0; i < pose.length; i++) {
					const lm = pose[i];
					push({
						label: `pose${i}`,
						model: "pose",
						x: parseFloat(lm.x.toFixed(3)),
						y: parseFloat(lm.y.toFixed(3)),
						z: parseFloat((lm.z ?? 0).toFixed(3)),
						cx: lm.x * this._canvas.width,
						cy: lm.y * this._canvas.height
					});
				}
			}
		}
		if (this._modelState.face.results?.faceLandmarks) {
			for (const face of this._modelState.face.results.faceLandmarks) {
				for (let i = 0; i < face.length; i++) {
					const lm = face[i];
					push({
						label: `face${i}`,
						model: "face",
						x: parseFloat(lm.x.toFixed(3)),
						y: parseFloat(lm.y.toFixed(3)),
						z: parseFloat((lm.z ?? 0).toFixed(3)),
						cx: lm.x * this._canvas.width,
						cy: lm.y * this._canvas.height
					});
				}
			}
		}

		this._updateActiveLiveValues();
		this._updateSavedEntryValues();
		this._renderCanvas();
	}

	// ── Canvas rendering ─────────────────────────────────────────────────
	_renderCanvas() {
		const ctx = this._ctx;
		ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
		const mod = this._visionModule;
		if (!mod || !this._drawUtils) return;

		if (this._modelState.hands.results?.landmarks) {
			for (const lms of this._modelState.hands.results.landmarks) {
				this._drawUtils.drawConnectors(lms, mod.HandLandmarker.HAND_CONNECTIONS, { color: "#45b58c", lineWidth: 3 });
				this._drawUtils.drawLandmarks(lms, { color: "#2f8f6e", fillColor: "#12362a", lineWidth: 1, radius: 4 });
			}
		}
		if (this._modelState.pose.results?.landmarks) {
			for (const lms of this._modelState.pose.results.landmarks) {
				this._drawUtils.drawConnectors(lms, mod.PoseLandmarker.POSE_CONNECTIONS, { color: "#fb923c", lineWidth: 3 });
				this._drawUtils.drawLandmarks(lms, { color: "#c2660f", fillColor: "#3a2007", lineWidth: 1, radius: 4 });
			}
		}
		if (this._modelState.face.results?.faceLandmarks) {
			for (const lms of this._modelState.face.results.faceLandmarks) {
				this._drawUtils.drawConnectors(lms, mod.FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "rgba(79,163,255,0.12)", lineWidth: 1 });
				this._drawUtils.drawConnectors(lms, mod.FaceLandmarker.FACE_LANDMARKS_CONTOURS, { color: "#4fa3ff", lineWidth: 2 });
			}
		}

		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 2.5;
		for (const entry of this._savedEntries) {
			for (const m of entry.labelMetas) {
				const lm = this._landmarkMap.get(m.label);
				if (!lm) continue;
				ctx.beginPath();
				ctx.arc(lm.cx, lm.cy, 12, 0, Math.PI * 2);
				ctx.stroke();
			}
		}

		for (const label of this._activeSelection) {
			const lm = this._landmarkMap.get(label);
			if (!lm) continue;
			ctx.beginPath();
			ctx.arc(lm.cx, lm.cy, 9, 0, Math.PI * 2);
			ctx.fillStyle = "#facc15";
			ctx.fill();
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 2;
			ctx.stroke();
		}
	}

	// ── Landmark picking ─────────────────────────────────────────────────
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
			const d = Math.hypot(lm.cx - clickX, lm.cy - clickY);
			if (d < minDist) {
				minDist = d;
				nearest = lm;
			}
		}
		return minDist < 40 ? nearest : null;
	}

	_onCanvasClick(e) {
		const lm = this._nearestLandmark(e);
		if (!lm) return;
		if (this._activeSelection.has(lm.label)) this._activeSelection.delete(lm.label);
		else this._activeSelection.add(lm.label);
		this._updateSelectionUI();
	}

	// ── Selection UI ─────────────────────────────────────────────────────
	_updateSelectionUI() {
		const labels = [...this._activeSelection];
		const n = labels.length;
		this._chipContainer.innerHTML = "";
		if (n === 0) {
			this._chipContainer.innerHTML = '<span class="hint-text">Select one or more points in the video</span>';
			this._clearBtn.classList.add("hidden");
			this._addBtn.classList.add("hidden");
			this._liveValuesDiv.innerHTML = "";
			this._liveDisplayType = null;
			return;
		}
		labels.forEach((label) => {
			const meta = { label, model: this._landmarkMap.get(label)?.model ?? "unknown" };
			const chip = document.createElement("span");
			chip.className = `sel-chip model-${meta.model}`;
			const nameSpan = document.createElement("span");
			nameSpan.textContent = label;
			const xBtn = document.createElement("button");
			xBtn.type = "button";
			xBtn.textContent = "×";
			xBtn.addEventListener("click", () => {
				this._activeSelection.delete(label);
				this._updateSelectionUI();
			});
			chip.append(nameSpan, xBtn);
			this._chipContainer.appendChild(chip);
		});
		this._clearBtn.classList.remove("hidden");
		this._addBtn.classList.remove("hidden");
		const newType = typeForCount(n);
		if (newType !== this._liveDisplayType) {
			this._liveDisplayType = null;
			this._liveValuesDiv.innerHTML = "";
		}
	}

	_updateActiveLiveValues() {
		const labels = [...this._activeSelection];
		const pts = labels.map((l) => this._landmarkMap.get(l)).filter(Boolean);
		const n = labels.length;
		if (n === 0) return;
		const type = typeForCount(n);

		if (type !== this._liveDisplayType) {
			this._liveDisplayType = type;
			this._liveSpans = {};
			this._liveValuesDiv.innerHTML = "";
			TYPE_KEYS[type].forEach((key) => {
				const blk = document.createElement("div");
				blk.className = "coord-block";
				const lbl = document.createElement("span");
				lbl.className = "coord-key";
				lbl.textContent = key;
				const val = document.createElement("span");
				val.className = "coord-val";
				val.textContent = "—";
				this._liveSpans[key] = val;
				blk.append(lbl, val);
				this._liveValuesDiv.appendChild(blk);
			});
		}

		if (pts.length === n) {
			const vals = calcValues(pts, type);
			for (const [k, span] of Object.entries(this._liveSpans)) span.textContent = fmt(vals[k]);
		}
	}

	// ── Saved entries ────────────────────────────────────────────────────
	_addToSaved() {
		const labels = [...this._activeSelection];
		if (labels.length === 0) return;
		const labelMetas = labels.map((l) => ({ label: l, model: this._landmarkMap.get(l)?.model ?? "unknown" }));
		const type = typeForCount(labels.length);
		const id = ++this._savedEntryCounter;
		const entry = { id, type, labelMetas, lastValues: {}, mappings: {}, valueEls: {}, mapEls: {}, calibrating: false, bypassed: false };
		this._buildSavedRow(entry);
		this._savedEntries.push(entry);
		this._savedListEl.appendChild(entry.row);
		this._dispatchStateChange();
	}

	// Rebuilds a saved entry (and its row) from persisted state — labelMetas'
	// own `model` is re-derived once real detection starts (landmarkMap isn't
	// populated yet at load time); until then it falls back to "unknown"
	// (same as a metric that currently isn't in frame).
	_restoreSavedEntry(saved) {
		const labelMetas = saved.labels.map((label) => ({ label, model: this._landmarkMap.get(label)?.model ?? "unknown" }));
		const id = Math.max(this._savedEntryCounter, saved.id || 0);
		this._savedEntryCounter = id;
		const entry = {
			id: saved.id || ++this._savedEntryCounter,
			type: saved.type,
			labelMetas,
			lastValues: {},
			// Normalizes every older mapping shape down to today's list-of-
			// {varName, min, max} per key: a plain string (before the range
			// feature), {varName, auto, min, max} (before Hans removed the
			// manual/auto choice — 2026-09-26), or a single {varName, min,
			// max} object (before multiple mappings per key — 2026-09-30) —
			// so an already-saved project never breaks.
			mappings: Object.fromEntries(
				Object.entries(saved.mappings || {}).map(([key, m]) => {
					const list = Array.isArray(m) ? m : [m];
					return [
						key,
						list.map((one) =>
							typeof one === "string" ? { varName: one, min: 0, max: 1 } : { varName: one.varName, min: one.min ?? 0, max: one.max ?? 1 }
						)
					];
				})
			),
			valueEls: {},
			mapEls: {},
			calibrating: false,
			bypassed: !!saved.bypassed
		};
		this._buildSavedRow(entry);
		this._savedEntries.push(entry);
		this._savedListEl.appendChild(entry.row);
	}

	_removeSavedEntry(id) {
		const idx = this._savedEntries.findIndex((e) => e.id === id);
		if (idx === -1) return;
		this._savedEntries[idx].row.remove();
		this._savedEntries.splice(idx, 1);
		this._dispatchStateChange();
	}

	_buildSavedRow(entry) {
		const row = document.createElement("div");
		row.className = "saved-row";

		const rowTop = document.createElement("div");
		rowTop.className = "saved-row-top";
		const lbl = document.createElement("div");
		lbl.className = "saved-label";
		entry.labelMetas.forEach((m, i) => {
			const sp = document.createElement("span");
			sp.className = `slm slm-${m.model}`;
			sp.textContent = m.label;
			lbl.appendChild(sp);
			if (i < entry.labelMetas.length - 1) {
				const sep = document.createElement("span");
				sep.className = "slm-sep";
				sep.textContent = " + ";
				lbl.appendChild(sep);
			}
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "saved-del";
		del.textContent = "×";
		del.title = "Remove";
		del.addEventListener("click", () => this._removeSavedEntry(entry.id));
		const calibrateBtn = document.createElement("button");
		calibrateBtn.type = "button";
		calibrateBtn.className = "calibrate-btn";
		calibrateBtn.textContent = "Calibrate";
		calibrateBtn.title = "While active, every 'auto' range below expands to fit whatever raw values this entry sees";
		calibrateBtn.addEventListener("click", () => this._toggleEntryCalibrate(entry));
		entry.calibrateBtn = calibrateBtn;

		const bypassLabel = document.createElement("label");
		bypassLabel.className = "bypass-toggle";
		bypassLabel.title = "Bypass — stop this entry from setting its mapped Var(s), without losing its mappings";
		const bypassInput = document.createElement("input");
		bypassInput.type = "checkbox";
		bypassInput.checked = !entry.bypassed;
		const bypassTrack = document.createElement("span");
		bypassTrack.className = "toggle-track";
		bypassLabel.append(bypassInput, bypassTrack);
		bypassInput.addEventListener("change", () => {
			entry.bypassed = !bypassInput.checked;
			this._dispatchStateChange();
		});
		entry.bypassInput = bypassInput;

		rowTop.append(lbl, calibrateBtn, bypassLabel, del);

		const calibrateHint = document.createElement("div");
		calibrateHint.className = "calibrate-hint";
		calibrateHint.hidden = true;
		calibrateHint.textContent = "Move to cover the full range you want, then click Calibrate again to lock it in.";
		entry.calibrateHint = calibrateHint;

		const vals = document.createElement("div");
		vals.className = "saved-vals";
		TYPE_KEYS[entry.type].forEach((key) => {
			const blk = document.createElement("div");
			blk.className = "sv-block";
			const k = document.createElement("span");
			k.className = "sv-key";
			k.textContent = key;
			const v = document.createElement("span");
			v.className = "sv-val";
			v.textContent = "—";
			entry.valueEls[key] = v;
			blk.append(k, v);
			blk.appendChild(this._buildMapControl(entry, key));
			vals.appendChild(blk);
		});

		row.append(rowTop, calibrateHint, vals);
		entry.row = row;
		return row;
	}

	_buildMapControl(entry, key) {
		const wrap = document.createElement("span");
		wrap.className = "sv-map-wrap";
		this._refreshMapControl(wrap, entry, key);
		entry.mapEls[key] = wrap;
		return wrap;
	}

	// entry.mappings[key] is a list now, not a single mapping (per Hans,
	// 2026-09-30: one metric can drive several <Var>s at once) — one pill
	// per mapping, plus a trailing "Map..." button that always adds another
	// rather than replacing anything.
	_refreshMapControl(wrap, entry, key) {
		wrap.innerHTML = "";
		const mappings = entry.mappings[key] || [];
		mappings.forEach((mapping, index) => {
			const pill = document.createElement("span");
			pill.className = "sv-mapped";
			pill.title = "Click to remap";
			const nameSpan = document.createElement("span");
			nameSpan.textContent = mapping.varName;
			nameSpan.style.cursor = "pointer";
			nameSpan.addEventListener("click", (e) => {
				// Without this, the very click that arms input-map-mode.js
				// keeps bubbling to document afterward, where its own
				// "unclaimed click disarms" listener immediately undoes the
				// arm() this line just did. Same reasoning as var-map-mode.js's
				// own Map button (wa-var-knobs.js).
				e.stopPropagation();
				this._mapKey(entry, key, e.currentTarget, index);
			});
			const xBtn = document.createElement("button");
			xBtn.type = "button";
			xBtn.className = "sv-unmap";
			xBtn.textContent = "×";
			xBtn.title = "Unmap";
			xBtn.addEventListener("click", () => {
				mappings.splice(index, 1);
				if (mappings.length === 0) delete entry.mappings[key];
				this._refreshMapControl(wrap, entry, key);
				this._dispatchStateChange();
			});
			pill.append(nameSpan, xBtn);
			wrap.appendChild(pill);
		});
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sv-map-btn";
		btn.textContent = "Map...";
		btn.addEventListener("click", (e) => {
			e.stopPropagation(); // see the nameSpan click listener's own comment above
			this._mapKey(entry, key, e.currentTarget, null);
		});
		wrap.appendChild(btn);
	}

	// index === null adds a new mapping; a number remaps the pill already at
	// that index (keeping its existing calibrated range) — same "remapping
	// keeps the range, a fresh mapping starts at 0-1" reasoning as before,
	// just per-pill instead of per-key now.
	//
	// Arms input-map-mode.js instead of opening wa-var-picker.js's old popup
	// menu — per Hans (2026-10-03): "när man ska mappa ett entry dyker det
	// nu upp en popup-meny. Ändra det så att det fungerar som när man
	// mappar en <Var>knob." wa-var-knobs.js's own ROOT-scoped knobs are the
	// only valid targets (that component enforces the root-only rule
	// itself — see its own isInputMapTarget); clicking one resolves via
	// input-map-mode's "pick" event. A root with no <Var> at all has
	// nothing to arm toward, so this shows an explanatory notice instead
	// (per Hans: "Om det inte finns någon <Var> i rooten ska det komma upp
	// en instruktion om att man behöver skapa en").
	_mapKey(entry, key, anchorEl, index) {
		const hasRootVar = xmlStore.root?.children.some((c) => c.tagName === "Var" && (c.attributes.name || c.attributes.id));
		if (!hasRootVar) {
			showNotice("Map... needs at least one root-level <Var> to target. Add one first — click the + next to Variables in the bottom bar.");
			return;
		}
		if (inputMapMode.armed) inputMapMode.disarm(); // re-arming for a different anchor — see the "change" cleanup below
		inputMapMode.arm();
		const visualEl = anchorEl.closest(".sv-mapped") || anchorEl;
		visualEl.classList.add("armed");
		const onPick = (e) => {
			if (!entry.mappings[key]) entry.mappings[key] = [];
			const list = entry.mappings[key];
			if (index === null || index === undefined) {
				list.push({ varName: e.detail.varName, min: 0, max: 1 });
			} else {
				list[index] = { ...list[index], varName: e.detail.varName };
			}
			this._refreshMapControl(entry.mapEls[key], entry, key);
			this._dispatchStateChange();
		};
		const onChange = () => {
			if (inputMapMode.armed) return;
			inputMapMode.removeEventListener("pick", onPick);
			inputMapMode.removeEventListener("change", onChange);
			visualEl.classList.remove("armed");
		};
		inputMapMode.addEventListener("pick", onPick);
		inputMapMode.addEventListener("change", onChange);
	}

	// Toggles a calibration pass for one saved entry (per Hans, 2026-09-23:
	// calibration happens entry by entry, not globally) — while active,
	// every mapped key *within this entry* expands its own min/max to fit
	// whatever raw values it sees (see expandRange, called from
	// _sendMappedValues); turning it off just freezes wherever it ended up.
	// Starting a *new* pass resets each mapping's range first —
	// recalibrating should never just widen an old, possibly stale range
	// further. Another entry's mappings are never touched. Per Hans
	// (2026-09-26): calibration is now the only way a mapping's input range
	// is ever set — there's no manual min/max entry to leave alone instead.
	_toggleEntryCalibrate(entry) {
		entry.calibrating = !entry.calibrating;
		entry.calibrateBtn.classList.toggle("active", entry.calibrating);
		entry.calibrateBtn.textContent = entry.calibrating ? "Calibrating…" : "Calibrate";
		entry.calibrateHint.hidden = !entry.calibrating;
		if (entry.calibrating) {
			Object.values(entry.mappings)
				.flat()
				.forEach((mapping) => {
					mapping.min = undefined;
					mapping.max = undefined;
				});
		} else {
			this._dispatchStateChange(); // persist the just-finished calibration
		}
	}

	_updateSavedEntryValues() {
		for (const entry of this._savedEntries) {
			const pts = entry.labelMetas.map((m) => this._landmarkMap.get(m.label));
			if (pts.every(Boolean)) entry.lastValues = calcValues(pts, entry.type);
			const v = entry.lastValues;
			for (const [key, el] of Object.entries(entry.valueEls)) el.textContent = fmt(v[key]);
			this._sendMappedValues(entry);
		}
	}

	// Only a mapped key is ever actually sent — an unmapped one is
	// display-only (per Hans, 2026-09-22). The raw metric is normalized to
	// 0-1 via its own mapping's calibrated input range before being sent —
	// never the raw value itself, and never scaled into the target <Var>'s
	// own musical range, which is WAXML's own job (per Hans, 2026-09-23).
	// Values outside the calibrated range are clamped (truncated) to 0-1,
	// never sent unclamped — per Hans (2026-09-26), confirming
	// normalizeToUnit's own existing Math.max(0, Math.min(1, ...)).
	_sendMappedValues(entry) {
		const v = entry.lastValues;
		if (!v) return;
		for (const [key, mappings] of Object.entries(entry.mappings)) {
			if (v[key] === undefined) continue;
			const raw = v[key];
			// Each mapping keeps its own independently calibrated range (per
			// Hans, 2026-09-30: several <Var>s can share one metric now) —
			// they usually converge to the same range when calibrated
			// together, but nothing forces that if one was added later.
			for (const mapping of mappings) {
				if (!mapping?.varName) continue;
				if (entry.calibrating) expandRange(mapping, raw);
				// Bypass stops this entry from driving its mapped Var(s) — e.g.
				// so a manual knob drag isn't immediately fought by the next
				// incoming frame — but keeps calibrating/tracking (and the
				// mapping itself) intact for whenever it's switched back on.
				// Per Hans (2026-09-27).
				if (entry.bypassed) continue;
				const normalized = normalizeToUnit(raw, mapping.min, mapping.max);
				if (normalized === undefined) continue; // never calibrated yet — nothing usable to send
				playerStore.setVariable(mapping.varName, normalized);
			}
		}
	}
}

// Widens `mapping`'s own min/max to include `raw` — the first value seen
// (min/max both still undefined) becomes both bounds, same "single point ->
// zero-width range" starting condition waxml.js's own native mapin="auto"
// calibration (Variable.autoAdjustInputRange) uses.
function expandRange(mapping, raw) {
	mapping.min = mapping.min === undefined ? raw : Math.min(mapping.min, raw);
	mapping.max = mapping.max === undefined ? raw : Math.max(mapping.max, raw);
}

function normalizeToUnit(raw, min, max) {
	if (!Number.isFinite(raw) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return undefined;
	return Math.max(0, Math.min(1, (raw - min) / (max - min)));
}

customElements.define("wa-webcam-input", WaWebcamInput);
