import { xmlStore } from "../xml-editor/xml-store.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { applyLiveProperty } from "../waxml-integration/live-property.js";
import { playerStore } from "../waxml-integration/player-store.js";
import { DEFAULT_ZOOM_RADIUS, zoomIn, zoomOut, gridUnitForRadius, squaresFromCenterToEdge, radiusToFitAll, worldToCanvas, canvasToWorld, clampToRadius } from "../xml-editor/panner-math.js";

// A top-down (X/Z plane) 3D-panning "radar" — one <PannerNode>'s position,
// PLUS every sibling <PannerNode> (direct or nested inside a sibling's own
// subtree) shown alongside it, dimmed, so the whole group of audio sources
// around one listener is visible at once. Per Hans (2026-10-04). Genuinely
// reusable (a real custom element, not just a wa-chain-view.js-internal
// helper) since it's embedded in two very different places:
//   - wa-chain-view.js's own PannerNode card (one instance per PannerNode —
//     "Om den ligger i en Chain ska den in som ett objekt i den vertikala
//     kedjan").
//   - wa-mixer-view.js's own popup, opened from a channel's "3D" toggle
//     thumbnail (one shared instance, re-pointed at whichever channel's
//     PannerNode was clicked).
// Call setPrimaryNode(nodeId) any time to point an existing instance at a
// (possibly different) PannerNode — mirrors wa-var-knobs.js's own
// setScopeNode() shape.
//
// positionY has no home on the X/Z circle at all — a separate vertical
// slider next to it controls/reflects it instead, same "keep the 3rd axis
// off the 2D map" idea real spatial-audio tools use. Every position write
// goes to XML only on release (drag itself only pushes the *live* audio
// property + local render state) — per Hans: "När man släpper högtalaren
// ska de nya positions-värdena sättas till aktuell position."
//
// The listener sits fixed at the circle's own center for now — Hans's own
// wording ("lyssnaren kommer kunna flyttas") flags that as a *future*
// capability, not this pass's.

// Zoom radius is genuinely per GROUP (every sibling PannerNode shares one
// circle), not per DOM instance, and needs to survive this component being
// torn down and rebuilt on every wa-chain-view.js re-render — a plain
// module-level Map, keyed the same way wa-chain-view.js's own
// _analyserModeKey keys its display-mode Map (the group's own shared parent
// node's real XML `id` when it has one, else its session-only internal tree
// id). RAM-only, same "remembered for this session, never written to the
// XML document" reasoning as e.g. wa-var-view.js's own toggle-off cache —
// per Hans (2026-10-04): "kommer ihåg sin zoominställning om man ställt in
// den explicit" only needs to survive re-renders, not a reload.
const explicitZoomByGroup = new Map();

// Sized to actually fit wa-chain-view.js's own card (.chain-stack's
// max-width: 260px, minus the card's own padding/border — roughly 235px of
// real content width) with the Y-slider column alongside it — per Hans
// (2026-10-04): "positionY-slidern behöver ligga inuti boxen." The circle
// itself (CANVAS_W wide, CANVAS_H - LABEL_H tall) stays square the same way
// it always has (see CIRCLE_CX/CIRCLE_PX_RADIUS below).
const CANVAS_W = 180;
const CANVAS_H = 200;
const LABEL_H = 20; // room for the "N squares to edge" readout above the circle
const CIRCLE_CX = CANVAS_W / 2;
const CIRCLE_CY = LABEL_H + (CANVAS_H - LABEL_H) / 2;
const CIRCLE_PX_RADIUS = (CANVAS_H - LABEL_H) / 2 - 6;
const SIDE_W = 36; // the Y-slider's own column — wide enough for "pos Y" and a 3-digit max-value label without overflowing
const SPEAKER_HIT_RADIUS = 14;
const LISTENER_PX_MIN = 9;
const LISTENER_PX_MAX = 16;
const SPEAKER_BADGE_PX = 9; // the speaker icon's own circular badge radius

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			font: 0.8rem/1.4 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		.row {
			display: flex;
			align-items: flex-start;
			gap: 0.4rem;
		}
		.stage {
			position: relative;
		}
		canvas {
			display: block;
			touch-action: none;
			cursor: default;
		}
		.side {
			display: flex;
			flex-direction: column;
			align-items: center;
			width: ${SIDE_W}px;
		}
		.slider-max-label {
			height: ${LABEL_H}px;
			display: flex;
			align-items: flex-end;
			padding-bottom: 8px;
			font: 10px monospace;
			color: #8a8a8a;
		}
		.slider {
			position: relative;
			width: 14px;
			height: ${CANVAS_H - LABEL_H}px;
			background: #16181a;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 7px;
			touch-action: none;
			cursor: ns-resize;
		}
		.slider-fill {
			position: absolute;
			left: 1px;
			right: 1px;
			top: 50%;
			height: 0;
			background: rgba(79, 163, 255, 0.35);
			border-radius: 6px;
		}
		.slider-thumb {
			position: absolute;
			left: -3px;
			right: -3px;
			height: 6px;
			background: var(--waw-accent, #4fa3ff);
			border-radius: 3px;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
			transform: translateY(-50%);
		}
		.slider-label {
			text-align: center;
			font-size: 0.62rem;
			color: var(--waw-muted, #8a8a8a);
			margin-top: 0.2rem;
		}
		.zoom-row {
			display: flex;
			justify-content: flex-end;
			gap: 0.3rem;
			margin-top: 0.3rem;
		}
		.zoom-btn {
			width: 22px;
			height: 22px;
			border-radius: 5px;
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			font-size: 0.95rem;
			line-height: 1;
			cursor: pointer;
			padding: 0;
		}
		.zoom-btn:hover {
			background: #2f333a;
		}
	</style>
	<div class="row">
		<div class="stage">
			<canvas width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
		</div>
		<div class="side">
			<div class="slider-max-label"></div>
			<div class="slider">
				<div class="slider-fill"></div>
				<div class="slider-thumb"></div>
			</div>
			<div class="slider-label">pos Y</div>
		</div>
	</div>
	<div class="zoom-row">
		<button class="zoom-btn zoom-out" type="button" title="Zoom out">−</button>
		<button class="zoom-btn zoom-in" type="button" title="Zoom in">+</button>
	</div>
`;

export class WaPannerView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._canvas = this.shadowRoot.querySelector("canvas");
		this._ctx = this._canvas.getContext("2d");
		this._slider = this.shadowRoot.querySelector(".slider");
		this._sliderThumb = this.shadowRoot.querySelector(".slider-thumb");
		this._sliderFill = this.shadowRoot.querySelector(".slider-fill");
		this._sliderMaxLabel = this.shadowRoot.querySelector(".slider-max-label");

		this._primaryNodeId = null;
		this._panners = []; // [{ node, x, y, z }] — local render/drag state, refreshed every render
		this._dragState = null; // { kind: "speaker"|"listenerY", panner? }

		this._onStoreChange = () => this._render();
		this._onCanvasPointerDown = this._onCanvasPointerDown.bind(this);
		this._onPointerMove = this._onPointerMove.bind(this);
		this._onPointerUp = this._onPointerUp.bind(this);
		this._onSliderPointerDown = this._onSliderPointerDown.bind(this);
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		this._canvas.addEventListener("pointerdown", this._onCanvasPointerDown);
		this._slider.addEventListener("pointerdown", this._onSliderPointerDown);
		window.addEventListener("pointermove", this._onPointerMove);
		window.addEventListener("pointerup", this._onPointerUp);
		this.shadowRoot.querySelector(".zoom-in").addEventListener("click", (e) => {
			e.stopPropagation();
			this._setZoom(zoomIn(this._currentZoom()));
		});
		this.shadowRoot.querySelector(".zoom-out").addEventListener("click", (e) => {
			e.stopPropagation();
			this._setZoom(zoomOut(this._currentZoom()));
		});
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onStoreChange);
		window.removeEventListener("pointermove", this._onPointerMove);
		window.removeEventListener("pointerup", this._onPointerUp);
	}

	setPrimaryNode(nodeId) {
		this._primaryNodeId = nodeId;
		this._render();
	}

	// Every sibling <PannerNode> — direct siblings that are themselves one,
	// or a sibling with one nested anywhere inside its own subtree — per
	// Hans (2026-10-04): "Om den har XML-siblings som också är PannerNodes,
	// eller siblings som innehåller PannerNodes, ska alla dessa PannerNodes
	// representeras i grafen." Falls back to just the node itself when it
	// has no parent (or is the only one), so this always returns >= 1 entry.
	//
	// The search root is normally just the PannerNode's own direct parent
	// (its real siblings) — EXCEPT when that parent is itself one <Mixer>
	// channel's own <Chain>, where the group widens to the whole <Mixer>
	// instead, so every channel's own PannerNode shows up together. Per
	// Hans (2026-10-04): "Om flera kanaler i <Mixer> har en <PannerNode>...
	// ska de... dyka upp som omarkerade objekt i grafen" — without this,
	// two channels' own PannerNodes would never see each other, since each
	// one's real parent is only ITS OWN Chain, not the other channel's.
	_groupRoot(node) {
		const parent = node.parent ? findNodeById(xmlStore.root, node.parent) : null;
		if (!parent) return null;
		const grandparent = parent.parent ? findNodeById(xmlStore.root, parent.parent) : null;
		return grandparent && grandparent.tagName === "Mixer" ? grandparent : parent;
	}

	_findGroupPanners(node) {
		const root = this._groupRoot(node);
		if (!root) return [node];
		const found = [];
		const walk = (n) => {
			if (n.tagName === "PannerNode") found.push(n);
			n.children.forEach(walk);
		};
		root.children.forEach(walk);
		return found.length ? found : [node];
	}

	_groupKey(node) {
		const root = this._groupRoot(node);
		return root ? root.attributes.id || root.id : `solo-${node.id}`;
	}

	_currentZoom() {
		return this._zoomRadius ?? DEFAULT_ZOOM_RADIUS;
	}

	_setZoom(radius) {
		this._zoomRadius = radius;
		if (this._groupKeyCache) explicitZoomByGroup.set(this._groupKeyCache, radius);
		this._drawScene();
		this._updateSlider();
	}

	_render() {
		const primary = this._primaryNodeId ? findNodeById(xmlStore.root, this._primaryNodeId) : null;
		if (!primary) {
			this._panners = [];
			return;
		}
		// Materializes the panningModel default straight into the XML the
		// first time this card sees it absent — per Hans (2026-10-04): "Om
		// attributet panningModel inte är angivet ska du sätta det till
		// 'HRTF'" (a real write, not just a live-only default the way e.g.
		// AnalyserNode's own smoothingTimeConstant default works — read as
		// "make it be HRTF", not "act as if it were"). Guarded so this only
		// ever fires once per node (the attribute is present from then on).
		if (primary.attributes.panningModel === undefined) {
			this._commitAttrs(primary, { panningModel: "HRTF" });
			return; // the resulting xmlStore "change" re-enters _render() with it set
		}

		const group = this._findGroupPanners(primary);
		this._panners = group.map((node) => ({
			node,
			x: parseFloat(node.attributes.positionX) || 0,
			y: parseFloat(node.attributes.positionY) || 0,
			z: parseFloat(node.attributes.positionZ) || -1
		}));

		this._groupKeyCache = this._groupKey(primary);
		if (this._zoomRadius === undefined) {
			this._zoomRadius = explicitZoomByGroup.get(this._groupKeyCache) ?? radiusToFitAll(this._panners);
		}

		this._drawScene();
		this._updateSlider();
	}

	_commitAttrs(node, patch) {
		xmlStore.updateAttributes(node.id, { ...node.attributes, ...patch });
	}

	_selectedNodeId() {
		return xmlStore.selectedNodeId;
	}

	// ── Canvas ───────────────────────────────────────────────────────────
	_drawScene() {
		const ctx = this._ctx;
		const w = CANVAS_W,
			h = CANVAS_H;
		ctx.clearRect(0, 0, w, h);
		const zoom = this._currentZoom();
		const unit = gridUnitForRadius(zoom);

		// Label — square count from center to the circle's own top edge.
		// Drawn straight on the canvas, never a DOM chip: per Hans
		// (2026-09-30 correction on the Var Convert graph), a readout here
		// must never look editable, and this one genuinely isn't.
		ctx.fillStyle = "#8a8a8a";
		ctx.font = "10px monospace";
		ctx.textAlign = "center";
		ctx.fillText(String(squaresFromCenterToEdge(zoom, unit)), CIRCLE_CX, LABEL_H - 8);

		// Clip to the circle so the grid's own corners are cut off by its
		// edge — per Hans: "hörnen av denna kvadrat klipps av av cirkelns
		// kant."
		ctx.save();
		ctx.beginPath();
		ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS, 0, Math.PI * 2);
		ctx.clip();

		ctx.fillStyle = "#111315";
		ctx.fillRect(CIRCLE_CX - CIRCLE_PX_RADIUS, CIRCLE_CY - CIRCLE_PX_RADIUS, CIRCLE_PX_RADIUS * 2, CIRCLE_PX_RADIUS * 2);

		ctx.strokeStyle = "#2a2d31";
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let g = -zoom; g <= zoom + 1e-6; g += unit) {
			const a = worldToCanvas(g, -zoom, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			const b = worldToCanvas(g, zoom, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			ctx.moveTo(a.px, a.py);
			ctx.lineTo(b.px, b.py);
			const c = worldToCanvas(-zoom, g, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			const d = worldToCanvas(zoom, g, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			ctx.moveTo(c.px, c.py);
			ctx.lineTo(d.px, d.py);
		}
		ctx.stroke();

		// Center cross-hairs, a touch brighter than the rest of the grid.
		ctx.strokeStyle = "#3a3e43";
		ctx.beginPath();
		ctx.moveTo(CIRCLE_CX - CIRCLE_PX_RADIUS, CIRCLE_CY);
		ctx.lineTo(CIRCLE_CX + CIRCLE_PX_RADIUS, CIRCLE_CY);
		ctx.moveTo(CIRCLE_CX, CIRCLE_CY - CIRCLE_PX_RADIUS);
		ctx.lineTo(CIRCLE_CX, CIRCLE_CY + CIRCLE_PX_RADIUS);
		ctx.stroke();

		ctx.restore();
		ctx.strokeStyle = "#3a3e43";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.arc(CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS, 0, Math.PI * 2);
		ctx.stroke();

		// Listener — fixed at center for now (see the class comment). Shrinks
		// as the zoom radius grows, floored so it never gets too small to
		// register as a click/drag target once that lands — per Hans:
		// "inte nödvändigtvis helt skalenligt... annars blir det ett
		// praktiskt problem." Drawn as a cute round face (per Hans's own
		// reference image, 2026-10-04, replacing the earlier "head from
		// above" attempt entirely): a circular head with two ears poking out
		// the sides, a little tuft on top, two dot eyes and a small
		// double-arc smile underneath them.
		const r = Math.max(LISTENER_PX_MIN, Math.min(LISTENER_PX_MAX, CIRCLE_PX_RADIUS / zoom));
		ctx.fillStyle = "#ffffff";
		ctx.strokeStyle = "#0c0c0c";
		ctx.lineWidth = Math.max(1, r * 0.12);

		// Ears — drawn BEFORE the head so only their outer curve pokes out
		// past its edge, same "avoid a same-color blob" reasoning the
		// earlier design used.
		const earR = r * 0.32;
		const earCx = r * 0.92;
		const earCy = CIRCLE_CY + r * 0.05;
		ctx.beginPath();
		ctx.ellipse(CIRCLE_CX - earCx, earCy, earR, earR * 1.3, 0, 0, Math.PI * 2);
		ctx.ellipse(CIRCLE_CX + earCx, earCy, earR, earR * 1.3, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();

		// Head + a small wavy tuft on top center.
		ctx.beginPath();
		ctx.arc(CIRCLE_CX, CIRCLE_CY, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(CIRCLE_CX - r * 0.14, CIRCLE_CY - r * 0.94);
		ctx.quadraticCurveTo(CIRCLE_CX, CIRCLE_CY - r * 1.35, CIRCLE_CX + r * 0.14, CIRCLE_CY - r * 0.94);
		ctx.fill();
		ctx.stroke();

		// Face — two dot eyes, and a small smile-arc under each (matching
		// the reference icon's own two separate curved marks).
		const eyeY = CIRCLE_CY - r * 0.05;
		const eyeDx = r * 0.32;
		ctx.fillStyle = "#0c0c0c";
		ctx.beginPath();
		ctx.ellipse(CIRCLE_CX - eyeDx, eyeY, r * 0.1, r * 0.13, 0, 0, Math.PI * 2);
		ctx.ellipse(CIRCLE_CX + eyeDx, eyeY, r * 0.1, r * 0.13, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.lineWidth = Math.max(1, r * 0.1);
		ctx.beginPath();
		ctx.arc(CIRCLE_CX - eyeDx, eyeY + r * 0.35, r * 0.18, Math.PI * 0.15, Math.PI * 0.85);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(CIRCLE_CX + eyeDx, eyeY + r * 0.35, r * 0.18, Math.PI * 0.15, Math.PI * 0.85);
		ctx.stroke();

		// Speakers — every sibling PannerNode, the "owning" one (this card's
		// own primary, or whichever is currently selected within the group)
		// full-strength, every other dimmed. Per Hans: "De 'andra'
		// PannerNode'sen ska vara lite transparenta för att visa att de
		// inte är markerade." A speaker zoomed outside the currently visible
		// radius is skipped entirely (not drawn at all, not even clipped at
		// the rim) — per Hans (2026-10-04): "Om man zoomar in så att ett
		// ljudobjekt hamnar utanför kanten ska den inte synas."
		const selectedId = this._selectedNodeId();
		const soloSource = this._panners.length === 1;
		this._panners.forEach((p) => {
			if (Math.hypot(p.x, p.z) > zoom) return;
			const isSelected = p.node.id === selectedId || (soloSource && p.node.id === this._primaryNodeId);
			const { px, py } = worldToCanvas(p.x, p.z, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			drawSpeakerBadge(ctx, px, py, isSelected);

			// Per Hans (2026-10-04): "Om det bara finns en ljudkälla ska
			// högtalaren inte ha någon label" — no fallback-to-"Panner" text
			// at all in that case, not even a dimmed one.
			if (!soloSource) {
				const label = p.node.attributes.label || p.node.attributes.id || p.node.attributes.class || "Panner";
				ctx.font = "9px monospace";
				ctx.textAlign = "center";
				ctx.fillStyle = isSelected ? "#cdd3d8" : "rgba(138,138,138,0.7)";
				ctx.fillText(label, px, py + SPEAKER_BADGE_PX + 10);
			}
		});
	}

	_updateSlider() {
		const zoom = this._currentZoom();
		// The slider's own range tracks the circle's zoom — per Hans
		// (2026-10-04): "posY-slidern ska påverkas av zoomknapparna och ha en
		// label ovanför som indikerar mx-värdet." (a plain unitless number,
		// same as positionY itself, not a grid-square count — Y isn't
		// gridded, so the raw zoom radius IS its reachable max.)
		this._sliderMaxLabel.textContent = String(zoom);
		const primaryY = this._panners.find((p) => p.node.id === this._primaryNodeId)?.y ?? 0;
		// 0 = track bottom (Y = -zoom), 1 = track top (Y = +zoom) — screen-up
		// is positive Y, matching how a real fader/slider reads.
		const t = Math.max(0, Math.min(1, (primaryY + zoom) / (2 * zoom)));
		const thumbTopPct = (1 - t) * 100;
		this._sliderThumb.style.top = `${thumbTopPct}%`;
		// The fill bar always grows from the track's own center (Y=0) out
		// toward the thumb, in whichever direction Y currently is.
		if (t >= 0.5) {
			this._sliderFill.style.top = `${thumbTopPct}%`;
			this._sliderFill.style.height = `${(t - 0.5) * 100}%`;
		} else {
			this._sliderFill.style.top = "50%";
			this._sliderFill.style.height = `${(0.5 - t) * 100}%`;
		}
	}

	// ── Speaker drag (positionX/positionZ) ──────────────────────────────
	_onCanvasPointerDown(e) {
		const rect = this._canvas.getBoundingClientRect();
		const sx = this._canvas.width / rect.width;
		const sy = this._canvas.height / rect.height;
		const px = (e.clientX - rect.left) * sx;
		const py = (e.clientY - rect.top) * sy;
		const zoom = this._currentZoom();
		let hit = null;
		for (const p of this._panners) {
			const c = worldToCanvas(p.x, p.z, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
			if (Math.hypot(c.px - px, c.py - py) <= SPEAKER_HIT_RADIUS) {
				hit = p;
				break;
			}
		}
		if (!hit) return;
		e.preventDefault();
		// Per Hans: "Om man klickar på en PannerNode som inte är markerad,
		// så markeras den" — clicking (even just to start a drag) any
		// sibling speaker selects it first, so the drag (and every XML
		// write below) always targets the one actually being touched.
		if (hit.node.id !== this._selectedNodeId()) xmlStore.selectNode(hit.node.id);
		try {
			this._canvas.setPointerCapture(e.pointerId);
		} catch {}
		this._dragState = { kind: "speaker", panner: hit };
	}

	_onSliderPointerDown(e) {
		const primary = this._panners.find((p) => p.node.id === this._primaryNodeId);
		if (!primary) return;
		e.preventDefault();
		try {
			this._slider.setPointerCapture(e.pointerId);
		} catch {}
		this._dragState = { kind: "listenerY", panner: primary };
		this._dragSliderMove(e);
	}

	_dragSliderMove(e) {
		const rect = this._slider.getBoundingClientRect();
		const t = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
		const zoom = this._currentZoom();
		const y = (1 - t) * 2 * zoom - zoom; // screen-up = +Y
		const panner = this._dragState.panner;
		panner.y = y;
		this._updateSlider();
		if (panner.node.attributes.id) applyLiveProperty(panner.node.attributes.id, "positionY", y);
	}

	_onPointerMove(e) {
		if (!this._dragState) return;
		if (this._dragState.kind === "listenerY") {
			this._dragSliderMove(e);
			return;
		}
		const rect = this._canvas.getBoundingClientRect();
		const sx = this._canvas.width / rect.width;
		const sy = this._canvas.height / rect.height;
		const px = (e.clientX - rect.left) * sx;
		const py = (e.clientY - rect.top) * sy;
		const zoom = this._currentZoom();
		const world = canvasToWorld(px, py, zoom, CIRCLE_CX, CIRCLE_CY, CIRCLE_PX_RADIUS);
		const clamped = clampToRadius(world.x, world.z, zoom);
		const panner = this._dragState.panner;
		panner.x = clamped.x;
		panner.z = clamped.z;
		this._drawScene();
		if (panner.node.attributes.id) {
			applyLiveProperty(panner.node.attributes.id, "positionX", clamped.x);
			applyLiveProperty(panner.node.attributes.id, "positionZ", clamped.z);
		}
	}

	_onPointerUp() {
		if (!this._dragState) return;
		const panner = this._dragState.panner;
		const kind = this._dragState.kind;
		this._dragState = null;
		// Per Hans (2026-10-04): "När man släpper högtalaren ska de nya
		// positions-värdena sättas till aktuell position" — the XML commit
		// happens only now, on release; every tick during the drag above
		// only pushed the live audio property + local render state.
		if (kind === "speaker") {
			this._commitAttrs(panner.node, { positionX: String(round3(panner.x)), positionZ: String(round3(panner.z)) });
		} else {
			this._commitAttrs(panner.node, { positionY: String(round3(panner.y)) });
		}
	}
}

function round3(n) {
	return Math.round(n * 1000) / 1000;
}

// Speaker badge — a filled circle (blue for selected, white for
// unselected — same blue the rest of the app already uses for a selected
// object, see --waw-accent) with a speaker glyph inside (white on the blue
// badge, dark on the white one), dimmed via globalAlpha when unselected —
// per Hans (2026-10-04): "Högtalarikonen ska se ut ungefär som bilden jag
// bifogar - i en cirkel. Gärna samma blå som du använder i programmet för
// markerade objekt och vit med svart högtalarikon för omarkerad (och då
// även nedtonad)."
function drawSpeakerBadge(ctx, cx, cy, isSelected) {
	ctx.save();
	ctx.globalAlpha = isSelected ? 1 : 0.4;
	ctx.beginPath();
	ctx.arc(cx, cy, SPEAKER_BADGE_PX, 0, Math.PI * 2);
	ctx.fillStyle = isSelected ? "#4fa3ff" : "#ffffff";
	ctx.fill();

	const glyphColor = isSelected ? "#ffffff" : "#1a1a1a";
	ctx.fillStyle = glyphColor;
	ctx.strokeStyle = glyphColor;
	const s = SPEAKER_BADGE_PX * 0.62;
	ctx.beginPath();
	ctx.moveTo(cx - s * 0.95, cy - s * 0.4);
	ctx.lineTo(cx - s * 0.3, cy - s * 0.4);
	ctx.lineTo(cx + s * 0.35, cy - s * 0.85);
	ctx.lineTo(cx + s * 0.35, cy + s * 0.85);
	ctx.lineTo(cx - s * 0.3, cy + s * 0.4);
	ctx.lineTo(cx - s * 0.95, cy + s * 0.4);
	ctx.closePath();
	ctx.fill();

	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.arc(cx + s * 0.35, cy, s * 0.65, -0.6, 0.6);
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(cx + s * 0.35, cy, s * 1.05, -0.5, 0.5);
	ctx.stroke();
	ctx.restore();
}

customElements.define("wa-panner-view", WaPannerView);
