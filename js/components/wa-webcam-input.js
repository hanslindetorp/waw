import { playerStore } from "../waxml-integration/player-store.js";
import { openVarPicker } from "./wa-var-picker.js";

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
//     (hand5x, hand5y, ...). Here, each metric is *explicitly* mapped (via
//     wa-var-picker.js) to an existing-or-new root <Var> — INPUT stays
//     outside the WAXML spec itself (no new schema elements), but what it
//     writes into is a completely ordinary root Var. Only mapped metrics are
//     ever sent; everything else is display-only.
//   - That mapping (plus which models are enabled and which camera is
//     selected) is persisted via getState()/applyState() — see
//     workstation-state.js's own registerLayoutExtras wiring — never as
//     WAXML document content.

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
		.info-header {
			flex: 0 0 auto;
			font-size: 0.65rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--waw-muted, #8a8a8a);
			padding-top: 0.2rem;
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
			font-size: 0.78rem;
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
			<div class="info-header">Selection</div>
			<div class="chip-container"><span class="hint-text">Click a point on the video to select</span></div>
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
			entries: this._savedEntries.map((e) => ({
				id: e.id,
				labels: e.labelMetas.map((m) => m.label),
				type: e.type,
				mappings: { ...e.mappings }
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
	}

	_dispatchStateChange() {
		this.dispatchEvent(new CustomEvent("state-change", { bubbles: true, composed: true }));
	}

	// ── Start / Stop ─────────────────────────────────────────────────────
	async _start() {
		this._startBtn.disabled = true;
		this._setStatus("Loading MediaPipe…", false);
		try {
			await this._ensureModelsLoaded();
			this._setStatus("Requesting camera…", false);
			const activeId = await this._startCamera(this._cameraDeviceId);
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
			let idx = 0;
			for (const hand of this._modelState.hands.results.landmarks) {
				for (const lm of hand) {
					push({
						label: `hand${idx++}`,
						model: "hands",
						x: parseFloat(lm.x.toFixed(3)),
						y: parseFloat(lm.y.toFixed(3)),
						z: parseFloat((lm.z ?? 0).toFixed(3)),
						cx: lm.x * this._canvas.width,
						cy: lm.y * this._canvas.height
					});
				}
			}
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
			this._chipContainer.innerHTML = '<span class="hint-text">Click a point on the video to select</span>';
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
		const entry = { id, type, labelMetas, lastValues: {}, mappings: {}, valueEls: {}, mapEls: {} };
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
			mappings: { ...(saved.mappings || {}) },
			valueEls: {},
			mapEls: {}
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
		rowTop.append(lbl, del);

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

		row.append(rowTop, vals);
		entry.row = row;
		return row;
	}

	_buildMapControl(entry, key) {
		const wrap = document.createElement("span");
		this._refreshMapControl(wrap, entry, key);
		entry.mapEls[key] = wrap;
		return wrap;
	}

	_refreshMapControl(wrap, entry, key) {
		wrap.innerHTML = "";
		const varName = entry.mappings[key];
		if (varName) {
			const pill = document.createElement("span");
			pill.className = "sv-mapped";
			pill.title = "Click to remap";
			const nameSpan = document.createElement("span");
			nameSpan.textContent = varName;
			nameSpan.style.cursor = "pointer";
			nameSpan.addEventListener("click", (e) => this._mapKey(entry, key, e.currentTarget));
			const xBtn = document.createElement("button");
			xBtn.type = "button";
			xBtn.className = "sv-unmap";
			xBtn.textContent = "×";
			xBtn.title = "Unmap";
			xBtn.addEventListener("click", () => {
				delete entry.mappings[key];
				this._refreshMapControl(wrap, entry, key);
				this._dispatchStateChange();
			});
			pill.append(nameSpan, xBtn);
			wrap.appendChild(pill);
		} else {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "sv-map-btn";
			btn.textContent = "Map...";
			btn.addEventListener("click", (e) => this._mapKey(entry, key, e.currentTarget));
			wrap.appendChild(btn);
		}
	}

	async _mapKey(entry, key, anchorEl) {
		const name = await openVarPicker(anchorEl.getBoundingClientRect());
		if (!name) return;
		entry.mappings[key] = name;
		this._refreshMapControl(entry.mapEls[key], entry, key);
		this._dispatchStateChange();
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
	// display-only. Per Hans (2026-09-22).
	_sendMappedValues(entry) {
		const v = entry.lastValues;
		if (!v) return;
		for (const [key, varName] of Object.entries(entry.mappings)) {
			if (!varName || v[key] === undefined) continue;
			playerStore.setVariable(varName, v[key]);
		}
	}
}

customElements.define("wa-webcam-input", WaWebcamInput);
