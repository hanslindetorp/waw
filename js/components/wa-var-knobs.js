import { xmlStore } from "../xml-editor/xml-store.js";
import { playerStore } from "../waxml-integration/player-store.js";

// One knob per root-level <Var> — lets you nudge a global variable live
// while playing, right from the player bar (per Hans, top-right, next to
// the PLAY trigger-selector field). Turning a knob never touches xmlStore —
// per Hans, it calls waxml.setVariable(name, value) directly, same as any
// other purely-live control (see live-property.js's own applyLiveProperty).
// This also means a knob's own current position is *not* the document's
// source of truth (a <Var>'s XML attributes never change) — it's tracked
// only in this component's own _values map, for as long as it stays alive.
//
// Only direct children of the document root are shown — matches how
// root-level <Command> trigger-shortcuts work in this same bar.

const KNOB_PX_PER_RANGE = 130; // dragging this many px sweeps a knob's full range
const KNOB_SIZE = 24;

function parseNumberList(str) {
	if (typeof str !== "string" || str.trim() === "") return [];
	const separator = str.includes(";") ? ";" : str.includes(",") ? "," : str.includes("...") ? "..." : " ";
	return str
		.split(separator)
		.map((s) => parseFloat(s.trim()))
		.filter((n) => Number.isFinite(n));
}

function formatValue(v) {
	if (!Number.isFinite(v)) return "—";
	const rounded = Math.round(v * 100) / 100;
	return String(rounded);
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			gap: 0.6rem;
		}
		:host([hidden]) {
			display: none;
		}
		.var-knob-wrap {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 0.05rem;
			position: relative;
		}
		.var-knob {
			width: ${KNOB_SIZE}px;
			height: ${KNOB_SIZE}px;
			border-radius: 50%;
			background: radial-gradient(circle at 35% 30%, #52565c, #17191c 72%);
			border: 2px solid #0b0c0d;
			box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), inset 0 0 2px rgba(255, 255, 255, 0.15);
			position: relative;
			cursor: ns-resize;
			touch-action: none;
			z-index: 1;
		}
		.var-knob:hover {
			filter: brightness(1.2);
		}
		.var-knob.disabled {
			cursor: default;
			opacity: 0.4;
		}
		.var-knob-dial {
			position: absolute;
			left: 50%;
			top: 2px;
			width: 2px;
			height: 45%;
			margin-left: -1px;
			background: #f2f2f2;
			border-radius: 1px;
			transform-origin: center bottom;
			z-index: 1;
		}
		.var-knob-ticks {
			position: absolute;
			pointer-events: none;
		}
		.var-knob-tick {
			position: absolute;
			width: 1px;
			height: 3px;
			background: #f5f5f5;
			opacity: 0.85;
		}
		.var-name {
			font-size: 0.55rem;
			color: #aab2ba;
			letter-spacing: 0.03em;
			max-width: 4.5rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.var-value {
			font-size: 0.55rem;
			color: var(--waw-accent, #4fa3ff);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
	</style>
	<div class="var-knobs"></div>
`;

export class WaVarKnobs extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._container = this.shadowRoot.querySelector(".var-knobs");
		this._values = new Map(); // node id -> current live value, this component's own state (see class comment)
		this._wasDocumentLoaded = false;
		this._onXmlStoreChange = () => this._render();
		this._onPlayerStoreChange = () => this._onPlayerChange();
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onXmlStoreChange);
		playerStore.addEventListener("change", this._onPlayerStoreChange);
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onXmlStoreChange);
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
	}

	// Re-pushes every knob's own current value the moment the graph
	// (re)loads — a <Var>'s Variable object always starts back at its XML
	// `default` on a fresh load (see waxml.js's Variable constructor), which
	// would otherwise silently discard whatever a user had already dialed in
	// here across a reload triggered by an unrelated structural edit.
	_onPlayerChange() {
		const isLoaded = playerStore.isDocumentLoaded;
		if (isLoaded && !this._wasDocumentLoaded) {
			this._values.forEach((value, nodeId) => {
				const node = xmlStore.root && findChild(xmlStore.root, nodeId);
				const varName = node && (node.attributes.name || node.attributes.id);
				if (varName) playerStore.setVariable(varName, value);
			});
		}
		this._wasDocumentLoaded = isLoaded;
	}

	_render() {
		this._container.innerHTML = "";
		const varNodes = xmlStore.root ? xmlStore.root.children.filter((c) => c.tagName === "Var") : [];
		this.hidden = varNodes.length === 0;

		const liveIds = new Set(varNodes.map((n) => n.id));
		[...this._values.keys()].forEach((id) => {
			if (!liveIds.has(id)) this._values.delete(id);
		});

		varNodes.forEach((node) => this._container.appendChild(this._buildKnob(node)));
	}

	_buildKnob(node) {
		const varName = node.attributes.name || node.attributes.id;

		const wrap = document.createElement("div");
		wrap.className = "var-knob-wrap";
		wrap.appendChild(this._buildTicks());

		const knob = document.createElement("div");
		knob.className = "var-knob";
		const dial = document.createElement("div");
		dial.className = "var-knob-dial";
		knob.appendChild(dial);
		wrap.appendChild(knob);

		const nameLabel = document.createElement("div");
		nameLabel.className = "var-name";
		nameLabel.textContent = varName || "(no name)";
		wrap.appendChild(nameLabel);

		const valueLabel = document.createElement("div");
		valueLabel.className = "var-value";
		wrap.appendChild(valueLabel);

		if (!varName) {
			// No "name" (nor a fallback "id") to call setVariable() with —
			// nothing this knob could meaningfully control.
			knob.classList.add("disabled");
			valueLabel.textContent = "—";
			knob.title = "This <Var> has no name/id attribute";
			return wrap;
		}

		const mapin = parseNumberList(node.attributes.mapin);
		const min = mapin.length ? Math.min(...mapin) : 0;
		const max = mapin.length ? Math.max(...mapin) : 1;
		const parsedDefault = parseFloat(node.attributes.default);
		const defaultValue = Number.isFinite(parsedDefault) ? Math.max(min, Math.min(max, parsedDefault)) : (min + max) / 2;

		if (!this._values.has(node.id)) this._values.set(node.id, defaultValue);
		const current = Math.max(min, Math.min(max, this._values.get(node.id)));
		this._values.set(node.id, current);

		const applyVisual = (v) => {
			const t = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
			dial.style.transform = `rotate(${-135 + t * 270}deg)`;
			valueLabel.textContent = formatValue(v);
			knob.title = `${varName}: ${formatValue(v)}`;
		};
		applyVisual(current);

		const commit = (v) => {
			this._values.set(node.id, v);
			applyVisual(v);
			playerStore.setVariable(varName, v);
		};

		this._wireDrag(
			knob,
			() => this._values.get(node.id),
			min,
			max,
			commit,
			defaultValue
		);

		return wrap;
	}

	_buildTicks(count = 11) {
		const wrap = document.createElement("div");
		wrap.className = "var-knob-ticks";
		const outerSize = KNOB_SIZE + 10;
		wrap.style.width = `${outerSize}px`;
		wrap.style.height = `${outerSize}px`;
		wrap.style.left = `-5px`;
		wrap.style.top = `-5px`;
		const radius = KNOB_SIZE / 2 + 3;
		const center = outerSize / 2;
		for (let i = 0; i < count; i++) {
			const angleDeg = -135 + (i / (count - 1)) * 270;
			const angleRad = (angleDeg * Math.PI) / 180;
			const x = center + radius * Math.sin(angleRad);
			const y = center - radius * Math.cos(angleRad);
			const tick = document.createElement("div");
			tick.className = "var-knob-tick";
			tick.style.left = `${x}px`;
			tick.style.top = `${y}px`;
			tick.style.transform = `translate(-50%, -50%) rotate(${angleDeg}deg)`;
			wrap.appendChild(tick);
		}
		return wrap;
	}

	// getValue() is read fresh at the start of every drag gesture (rather
	// than a value baked in at build time) — this component's DOM never
	// rebuilds mid-gesture (no xmlStore write happens at all, see the class
	// comment), but it also never rebuilds *between* separate gestures
	// either, so a stale snapshot would make the second drag on the same
	// knob jump from wherever the first one actually ended.
	_wireDrag(el, getValue, min, max, onChange, defaultValue) {
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const startY = e.clientY;
			const startValue = getValue();
			try {
				el.setPointerCapture(e.pointerId);
			} catch {}

			const onMove = (moveEvt) => {
				const deltaPx = startY - moveEvt.clientY; // up = increase
				const raw = startValue + (deltaPx / KNOB_PX_PER_RANGE) * (max - min);
				onChange(Math.max(min, Math.min(max, raw)));
			};
			const onUp = () => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onUp);
		});

		if (Number.isFinite(defaultValue)) {
			el.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				onChange(Math.max(min, Math.min(max, defaultValue)));
			});
		}
	}
}

function findChild(root, id) {
	return root.children.find((c) => c.id === id);
}

customElements.define("wa-var-knobs", WaVarKnobs);
