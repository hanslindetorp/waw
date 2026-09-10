import { xmlStore } from "../xml-editor/xml-store.js";
import { findNodeById } from "../xml-editor/xml-tree-ops.js";
import { findSrcAttribute, resolvePlayableUrl } from "../xml-editor/src-attribute.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";
import { WaxmlBridge } from "../waxml-integration/waxml-bridge.js";
import { vfs } from "../vfs/VFS.js";
import { selection } from "../state/selection.js";
import "./wa-section-view.js";
import "./wa-mixer-view.js";
import "./wa-wam-view.js";
import "./wa-composition-view.js";
import { isPreviewableAudioFile } from "./wa-file-preview.js";

// Preview panel (panel 3): reflects whatever is selected in the XML editor
// (panel 2) / XML code (panel 4) — they all share xmlStore's selectedNodeId.
// <Section> gets a full DAW-style arrange view; <Mixer> gets a channel-strip
// mixer view; other audio-bearing elements get a waveform + WAXML play/stop.
// More element-specific views (WAM modules, ...) land in later steps per
// docs/WAXML-Workstation-spec.md avsnitt 5.4/9.

const bridge = new WaxmlBridge();

// Composition/section-context tags aren't valid as a standalone
// <audio><Tag .../></audio> wrapper (WAXML's Parser rejects them outside
// their <Composition>/<Section> parent) — selecting one still shows its
// waveform for reference, but without the (would-be-broken) WAXML play button.
const COMPOSITION_CONTEXT_TAGS = new Set(["Layer", "Segment", "Option", "Stinger", "Command"]);

// A Mixer's own descendants — selecting one of these while the mixer view
// is already showing shouldn't yank the panel away to a bare attribute
// list. Also covers xmlStore.insertNewChild's own side effect of moving
// the global selection to whatever it just created (e.g. clicking a
// channel strip's "+ add insert" button selects the new <Wam>), and
// xmlStore.removeNode's own "select the parent" behavior on delete —
// without this, every "+" click, or every Backspace on a channel-strip
// element, would otherwise hide the mixer view instantly. Walks the real
// tree (rather than an enumerated tag whitelist) so it stays correct for
// any element type nested under a Mixer, present or future, per Hans.
function isDescendantOfTag(node, tagName) {
	let cur = node;
	while (cur && cur.parent) {
		const parent = findNodeById(xmlStore.root, cur.parent);
		if (!parent) return false;
		if (parent.tagName === tagName) return true;
		cur = parent;
	}
	return false;
}

// Like isDescendantOfTag, but returns the actual ancestor (or `node` itself
// if it already has that tag) instead of a bare boolean — used to find
// "which <Section> does this belong to" for a Layer/Segment/Option/Stinger/
// Command selection, so opening the Section preview doesn't require the
// Section itself to be the literal selection (see the Section branch below).
function findAncestorOrSelf(node, tagName) {
	if (node.tagName === tagName) return node;
	let cur = node;
	while (cur && cur.parent) {
		const parent = findNodeById(xmlStore.root, cur.parent);
		if (!parent) return null;
		if (parent.tagName === tagName) return parent;
		cur = parent;
	}
	return null;
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			height: 100%;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.state {
			display: none;
			height: 100%;
		}
		.state.active {
			display: block;
		}
		.state.padded {
			padding: 0.75rem;
			overflow: auto;
		}
		.centered {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin-top: 2rem;
			padding: 0 0.5rem;
		}
		.node-label {
			margin: 0 0 0.6rem;
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			word-break: break-all;
		}
		.node-label .tag {
			color: var(--waw-accent, #4fa3ff);
		}
		canvas.waveform {
			width: 100%;
			height: 100px;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			display: block;
		}
		.waxml-controls {
			display: flex;
			gap: 0.5rem;
			margin-top: 0.75rem;
		}
		.waxml-controls button {
			background: #2a2a2a;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.35rem 0.7rem;
			cursor: pointer;
		}
		.waxml-controls button:hover {
			background: #333;
		}
		.hint {
			margin-top: 0.6rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
		.missing-value {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			color: var(--waw-danger, #e5484d);
		}
		.attr-list {
			margin-top: 0.6rem;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.78rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.attr-list div {
			padding: 0.1rem 0;
		}
	</style>

	<div class="state padded" data-state="empty">
		<p class="centered">Select an element in the XML editor to preview it.</p>
	</div>

	<div class="state" data-state="section">
		<wa-section-view></wa-section-view>
	</div>

	<div class="state" data-state="composition">
		<wa-composition-view></wa-composition-view>
	</div>

	<div class="state padded" data-state="file">
		<wa-file-preview></wa-file-preview>
	</div>

	<div class="state" data-state="mixer">
		<wa-mixer-view></wa-mixer-view>
	</div>

	<div class="state" data-state="wam">
		<wa-wam-view></wa-wam-view>
	</div>

	<div class="state padded" data-state="audio">
		<p class="node-label"><span class="tag"></span></p>
		<canvas class="waveform" width="600" height="100"></canvas>
		<div class="waxml-controls">
			<button class="btn-play" type="button">▶ Play via WAXML</button>
			<button class="btn-stop" type="button">■ Stop</button>
		</div>
		<p class="hint status"></p>
	</div>

	<div class="state padded" data-state="missing">
		<p class="node-label"><span class="tag"></span></p>
		<p class="centered">No file at <span class="missing-value"></span></p>
		<p class="hint">Drag a file from the file manager onto this element to set it.</p>
	</div>

	<div class="state padded" data-state="fallback">
		<p class="node-label"><span class="tag"></span></p>
		<p class="centered">No preview view yet for this element type.</p>
		<div class="attr-list"></div>
	</div>
`;

export class WaPreview extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._states = new Map(
			[...this.shadowRoot.querySelectorAll(".state")].map((el) => [el.dataset.state, el])
		);
		this._canvas = this.shadowRoot.querySelector("canvas.waveform");
		this._status = this.shadowRoot.querySelector(".status");
		this._playBtn = this.shadowRoot.querySelector(".btn-play");
		this._stopBtn = this.shadowRoot.querySelector(".btn-stop");
		this._requestToken = 0;
	}

	connectedCallback() {
		this._playBtn.addEventListener("click", () => bridge.play());
		this._stopBtn.addEventListener("click", () => bridge.stop());
		xmlStore.addEventListener("change", (e) => this._onStoreChange(e));
		selection.addEventListener("change", (e) => this._onFileSelectionChange(e.detail.id));
		this._onStoreChange();
	}

	// A File Manager selection (selection.js — completely independent of
	// xmlStore) takes over the panel, same as clicking a new node in the XML
	// tree would — per Hans (2026-09-10). Non-audio files (e.g. the project's
	// own .xml) have nothing to preview, so they're left alone rather than
	// switching to a blank "file" state.
	_onFileSelectionChange(id) {
		const node = id ? vfs.getNode(id) : null;
		if (!isPreviewableAudioFile(node)) return;
		this._showState("file");
		this._lastFileSelectionId = id;
	}

	_onStoreChange(e) {
		const node = xmlStore.getSelectedNode();

		// Ignore an xmlStore "change" event that isn't an actual new XML
		// selection (e.g. some unrelated live attribute edit elsewhere)
		// while the panel is showing a File Manager selection — otherwise
		// every incidental store change would silently yank the panel away
		// from the file preview. A genuine new XML-tree selection still
		// switches away from it, same as it would switch away from any
		// other state below.
		const xmlSelectionChanged = node?.id !== this._lastXmlNodeIdSeen;
		this._lastXmlNodeIdSeen = node?.id ?? null;
		if (this._activeState === "file" && !xmlSelectionChanged) return;

		if (!node) {
			this._showState("empty");
			this._lastNodeId = null;
			this._lastResolvedUrl = null;
			return;
		}

		if (node.tagName === "Composition") {
			// wa-composition-view listens to xmlStore itself and stays mounted
			// the whole time — we just need to make its state visible, same
			// shape as wa-section-view/wa-mixer-view below.
			this._showState("composition");
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		// A <Section>, or anything inside one (Layer/Segment/Option/Stinger/
		// Command), opens that Section's own arrange view — resolved via its
		// nearest Section ancestor (or itself) rather than requiring the
		// Section to be the literal selection, so e.g. selecting straight
		// into a <Layer> from the XML tree still shows something instead of
		// falling through to a bare waveform/fallback view. Per Hans
		// (2026-09-07). The one exception: a plain click on a Section (or
		// its descendant) that already belongs to the Composition currently
		// showing in the Composition preview only updates the tree/Code
		// panel selection and leaves the panel where it is — same "sticky
		// active view" reasoning as the Mixer carve-out below. Only an
		// explicit "open" (double-click; xmlStore.selectNode's own `open`
		// option) forces the switch away from Composition. Per Hans
		// (2026-09-05).
		const ancestorSection = findAncestorOrSelf(node, "Section");
		if (ancestorSection) {
			const forceOpen = e?.detail?.open === true;
			if (!forceOpen && this._activeState === "composition" && isDescendantOfTag(ancestorSection, "Composition")) {
				this._lastNodeId = node.id;
				this._lastResolvedUrl = null;
				return;
			}
			// wa-section-view listens to xmlStore itself and stays mounted
			// the whole time — we just need to make its state visible.
			this._showState("section");
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		if (node.tagName === "Mixer") {
			// Same "always mounted, listens to xmlStore itself" shape as
			// wa-section-view — see wa-mixer-view.js.
			this._showState("mixer");
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		if (node.tagName === "Wam") {
			// Takes priority over the Mixer-descendant carve-out just below —
			// per Hans, selecting a <Wam> shows its own interface even when
			// it's sitting inside a <Mixer> channel strip's insert chain.
			this._showState("wam");
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		// Same idea as the Section carve-out above, for a Mixer's own
		// descendants — see isDescendantOfTag.
		if (this._activeState === "mixer" && isDescendantOfTag(node, "Mixer")) {
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		const srcAttr = findSrcAttribute(xmlStore.schema, node);
		if (!srcAttr) {
			this._showFallback(node);
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		const resolvedUrl = resolvePlayableUrl(srcAttr.value);
		if (!resolvedUrl) {
			this._showState("missing");
			this._setTag(this._states.get("missing"), node.tagName);
			this._states.get("missing").querySelector(".missing-value").textContent = srcAttr.value || "(empty)";
			this._lastNodeId = node.id;
			this._lastResolvedUrl = null;
			return;
		}

		this._showState("audio");
		this._setTag(this._states.get("audio"), node.tagName);

		// The (expensive) bridge reload + waveform decode only needs to run
		// again when the node or its resolved audio source actually changed —
		// e.g. tweaking an unrelated attribute on this same node (gain, loop)
		// shouldn't restart playback or reflicker the waveform.
		const unchanged = node.id === this._lastNodeId && resolvedUrl === this._lastResolvedUrl;
		this._lastNodeId = node.id;
		this._lastResolvedUrl = resolvedUrl;
		if (unchanged) return;

		this._requestToken += 1;
		this._loadAudio(node, srcAttr, resolvedUrl, this._requestToken);
	}

	async _loadAudio(node, srcAttr, resolvedUrl, token) {
		const playableStandalone = !COMPOSITION_CONTEXT_TAGS.has(node.tagName);
		this._playBtn.hidden = !playableStandalone;
		this._stopBtn.hidden = !playableStandalone;

		this._status.textContent = playableStandalone
			? "Loading waveform…"
			: `Select the parent <Section> to hear this in context.`;

		if (playableStandalone) {
			await bridge.loadNode(node, srcAttr.attrName, resolvedUrl);
			if (token !== this._requestToken) return; // selection changed while awaiting
		}

		try {
			const audioBuffer = await decodeAudioBuffer(resolvedUrl, bridge.audioContext);
			if (token !== this._requestToken) return;
			drawWaveform(this._canvas, audioBuffer, "#4fa3ff");
			if (playableStandalone) this._status.textContent = "";
		} catch {
			if (token !== this._requestToken) return;
			this._status.textContent = "Could not decode audio for waveform (playback may still work).";
		}
	}

	_showFallback(node) {
		this._showState("fallback");
		const el = this._states.get("fallback");
		this._setTag(el, node.tagName);
		const list = el.querySelector(".attr-list");
		list.innerHTML = "";
		Object.entries(node.attributes).forEach(([k, v]) => {
			const row = document.createElement("div");
			row.textContent = `${k}="${v}"`;
			list.appendChild(row);
		});
	}

	_setTag(stateEl, tagName) {
		stateEl.querySelector(".tag").textContent = `<${tagName}>`;
	}

	_showState(name) {
		this._states.forEach((el, key) => el.classList.toggle("active", key === name));
		this._activeState = name;
	}
}

customElements.define("wa-preview", WaPreview);
