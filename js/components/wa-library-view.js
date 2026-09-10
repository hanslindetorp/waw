import { xmlStore } from "../xml-editor/xml-store.js";
import { vfs, ROOT_ID } from "../vfs/VFS.js";
import "./wa-player-bar.js";

// DEMO: a Spotify-style "library of productions" view (per Hans, 2026-09-10)
// — a sketch of a future publishing/distribution feature where a published
// project shows up in a shared library, the way Spotify is a library of
// songs. Everything except the one real, currently-open project is invented:
// fake productions with fake names/thumbnails just to make the list look
// populated. The real project's own name comes from the root <WAXML>'s
// `label` attribute; its thumbnail is the first image file found anywhere in
// the File Manager (vfs), or a generated placeholder if there isn't one yet.
//
// The bottom bar reuses <wa-player-bar> directly rather than rebuilding
// trigger/variable controls from scratch — it's already a self-contained
// element driven entirely by the shared xmlStore/playerStore singletons, so
// a second instance here automatically sends the exact same trig()/
// setVariable() calls as the one in the app header, no new plumbing needed.
// The real project keeps running live in the background the whole time this
// view is showing — nothing here ever reloads or tears down the engine.

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

// Ten invented productions purely for set dressing — per Hans: "fejkade
// thumbnails... ge dem lite olika fantasifulla namn". Thumbnails are plain
// CSS gradients (hue below), not real images, so this needs no asset files.
const FAKE_PRODUCTIONS = [
	{ name: "Neon Driftscape", creator: "Mira Voss", tag: "Ambient · Adaptive", hue: 210, blurb: "A slow-drifting synth bed that reshapes itself around however long the listener lingers — no two playthroughs land the same." },
	{ name: "Quantum Lullaby", creator: "Echo Parallax", tag: "Generative · Sleep", hue: 260, blurb: "Generative sleep music that reacts to time of day, gently detuning itself deeper into the night." },
	{ name: "Crimson Vortex Suite", creator: "Hollow Static", tag: "Cinematic · Battle", hue: 350, blurb: "A combat score built entirely from interlocking stingers — every hit, dodge, and victory gets its own musical answer." },
	{ name: "Glacial Bloom", creator: "Aki Nordvik", tag: "Ambient · Nature", hue: 190, blurb: "Field-recorded ice and glass, layered into slowly thawing drones that never quite loop the same way twice." },
	{ name: "Static Bloom Protocol", creator: "Rendered Ghosts", tag: "IDM · Interactive", hue: 40, blurb: "Glitch-driven IDM where the listener's own input reshuffles the percussion grid in real time." },
	{ name: "Nightfall Recursion", creator: "8-Bit Séance", tag: "Chiptune · Loopable", hue: 280, blurb: "A haunted-arcade chiptune loop with a dozen quiet variations hidden under the obvious one." },
	{ name: "Wandering Signal", creator: "Faye Calloway", tag: "Folktronica", hue: 90, blurb: "Acoustic guitar sketches stitched together by an adaptive transition engine that always finds the next chord." },
	{ name: "Paper Moons", creator: "Small Hours", tag: "Lo-fi · Adaptive", hue: 320, blurb: "Lo-fi tape warmth that swaps its own vinyl crackle layer depending on how long you've been listening." },
	{ name: "Hollow Frequency", creator: "Vantablack Audio", tag: "Dark Ambient", hue: 0, blurb: "Sub-bass drones with sparse, randomized metallic stingers — built to unsettle without ever repeating exactly." },
	{ name: "Driftwood Ensemble", creator: "The Loop Collective", tag: "Downtempo · Variation-heavy", hue: 30, blurb: "A downtempo suite authored with an unusual amount of section-to-section variation for its genre." }
];

function findFirstImage(folderId = ROOT_ID) {
	const queue = [folderId];
	while (queue.length > 0) {
		const id = queue.shift();
		for (const node of vfs.listFolder(id)) {
			if (node.type === "folder") {
				queue.push(node.id);
				continue;
			}
			const ext = node.name.split(".").pop()?.toLowerCase();
			if (IMAGE_EXTENSIONS.has(ext)) return node;
		}
	}
	return null;
}

function findFirstByTag(node, tagName) {
	if (!node) return null;
	if (node.tagName === tagName) return node;
	for (const child of node.children) {
		const found = findFirstByTag(child, tagName);
		if (found) return found;
	}
	return null;
}

// A short, real, English description of the currently-open project, built by
// actually walking the document (Sections/Layers/Stingers/audio files/Mixer/
// other Web Audio nodes) rather than an AI call — per Hans (2026-09-10): "om
// det krävs [en extra tjänst] struntar vi i det" — this needs no extra
// service and, since it reads the real tree, is more accurate than a purely
// random blurb would be anyway.
function describeRealProject(root) {
	if (!root) return "No project is currently open.";

	const composition = root.children.find((c) => c.tagName === "Composition");
	if (!composition) {
		return "This WAXML document doesn't have a <Composition> yet — just some top-level nodes and settings so far.";
	}

	const sections = composition.children.filter((c) => c.tagName === "Section");
	const transitionSections = sections.filter((s) => s.attributes.from !== undefined || s.attributes.to !== undefined);
	const regularSections = sections.length - transitionSections.length;

	let totalLayers = 0;
	let totalStingers = 0;
	const srcSet = new Set();
	const collectSrc = (node) => {
		if (node.attributes.src) srcSet.add(node.attributes.src);
		node.children.forEach(collectSrc);
	};
	sections.forEach((sec) => {
		totalLayers += sec.children.filter((c) => c.tagName === "Layer").length;
		totalStingers += sec.children.filter((c) => c.tagName === "Stinger").length;
		collectSrc(sec);
	});

	const formats = new Set([...srcSet].map((s) => s.split(".").pop()?.toLowerCase()).filter(Boolean));
	const mixer = findFirstByTag(root, "Mixer");
	const otherNodes = root.children.filter((c) => !["Composition", "Command", "Var", "Mixer"].includes(c.tagName));

	const sentences = [];

	sentences.push(
		regularSections > 0
			? `Built from ${regularSections} section${regularSections === 1 ? "" : "s"} of adaptive music.`
			: `The composition is still empty — no sections have been authored yet.`
	);

	if (transitionSections.length > 0) {
		sentences.push(
			transitionSections.length === 1
				? `1 dedicated transition smooths the handoff between sections, so it never just cuts.`
				: `${transitionSections.length} dedicated transitions smooth the handoff between sections, so it never just cuts.`
		);
	} else if (regularSections > 1) {
		sentences.push(`Sections change directly into one another, without dedicated transition material between them yet.`);
	}

	if (totalLayers > 0) {
		const avg = regularSections ? (totalLayers / regularSections).toFixed(1).replace(/\.0$/, "") : totalLayers;
		sentences.push(`${totalLayers} layer${totalLayers === 1 ? "" : "s"} of audio in total — about ${avg} per section.`);
	}

	if (srcSet.size > 0) {
		const formatList = [...formats].join("/") || "audio";
		sentences.push(`${srcSet.size} distinct ${formatList} file${srcSet.size === 1 ? "" : "s"} ${srcSet.size === 1 ? "is" : "are"} referenced.`);
	}

	sentences.push(
		totalStingers === 1
			? `1 stinger adds a one-shot musical accent on top of the looping layers.`
			: totalStingers > 1
				? `${totalStingers} stingers add one-shot musical accents on top of the looping layers.`
				: `No stingers are used — every sound comes from the looping layers themselves.`
	);

	if (mixer) {
		sentences.push(`Routed through a ${mixer.children.length}-channel Mixer for live level and pan control.`);
	}

	if (otherNodes.length > 0) {
		sentences.push(`The document also wires up ${otherNodes.length} additional Web Audio node${otherNodes.length === 1 ? "" : "s"} (${otherNodes.map((n) => n.tagName).join(", ")}) alongside the composition.`);
	}

	return sentences.join(" ");
}

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-height: 0;
			background: var(--waw-bg, #121212);
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		:host([hidden]) {
			display: none;
		}
		.lib-topbar {
			flex: 0 0 auto;
			padding: 0.75rem 1.25rem;
			font-size: 1.05rem;
			font-weight: 700;
			letter-spacing: 0.01em;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.lib-body {
			flex: 1 1 auto;
			display: flex;
			min-height: 0;
			overflow: hidden;
		}
		.lib-rail {
			flex: 0 0 190px;
			overflow: auto;
			padding: 1rem 0.75rem;
			border-right: 1px solid var(--waw-border, #2f2f2f);
		}
		.lib-rail-title {
			margin: 0 0.25rem 0.6rem;
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--waw-muted, #8a8a8a);
		}
		.lib-rail-item {
			display: flex;
			align-items: center;
			gap: 0.55rem;
			padding: 0.35rem 0.25rem;
			border-radius: 6px;
		}
		.lib-rail-item:hover {
			background: rgba(255, 255, 255, 0.05);
		}
		.lib-rail-thumb {
			flex: 0 0 auto;
			width: 32px;
			height: 32px;
			border-radius: 4px;
		}
		.lib-rail-label {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
		.lib-list {
			flex: 1 1 auto;
			overflow: auto;
			padding: 1.25rem 1.5rem;
		}
		.lib-list h2 {
			margin: 0 0 1rem;
			font-size: 1.4rem;
		}
		.lib-row {
			display: flex;
			align-items: center;
			gap: 0.9rem;
			padding: 0.45rem 0.6rem;
			border-radius: 6px;
			cursor: pointer;
		}
		.lib-row:hover {
			background: rgba(255, 255, 255, 0.06);
		}
		.lib-row.previewing {
			background: rgba(79, 163, 255, 0.12);
		}
		.lib-row-index {
			flex: 0 0 1.4rem;
			color: var(--waw-muted, #8a8a8a);
			text-align: right;
			font-variant-numeric: tabular-nums;
		}
		.lib-row-thumb {
			flex: 0 0 auto;
			width: 44px;
			height: 44px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			font-weight: 700;
			color: rgba(255, 255, 255, 0.85);
		}
		.lib-row-thumb img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
		.lib-row-meta {
			flex: 1 1 auto;
			min-width: 0;
		}
		.lib-row-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.lib-row.active .lib-row-name {
			color: var(--waw-success, #4caf7d);
			display: flex;
			align-items: center;
			gap: 0.4rem;
		}
		.lib-row-creator {
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.lib-row-tag {
			flex: 0 0 auto;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
		.live-dot {
			flex: 0 0 auto;
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: var(--waw-success, #4caf7d);
			box-shadow: 0 0 0 3px rgba(76, 175, 125, 0.25);
		}
		.lib-detail {
			flex: 0 0 300px;
			overflow: auto;
			padding: 1.25rem;
			border-left: 1px solid var(--waw-border, #2f2f2f);
		}
		.lib-detail-thumb {
			width: 100%;
			aspect-ratio: 1;
			border-radius: 8px;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			font-size: 3rem;
			font-weight: 700;
			color: rgba(255, 255, 255, 0.85);
			box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		}
		.lib-detail-thumb img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
		.lib-detail-name {
			margin: 0.9rem 0 0.15rem;
			font-size: 1.15rem;
			font-weight: 700;
		}
		.lib-detail-creator {
			margin: 0 0 0.9rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.8rem;
		}
		.lib-detail-desc {
			color: var(--waw-fg, #e8e8e8);
			font-size: 0.82rem;
			line-height: 1.55;
		}
		.lib-bottombar {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			gap: 0.75rem;
			padding: 0.5rem 1rem;
			border-top: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
		}
		.lib-bottombar-thumb {
			flex: 0 0 auto;
			width: 46px;
			height: 46px;
			border-radius: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			font-weight: 700;
			color: rgba(255, 255, 255, 0.85);
		}
		.lib-bottombar-thumb img {
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
		.lib-bottombar-name {
			flex: 0 0 auto;
			max-width: 12rem;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 600;
			font-size: 0.82rem;
		}
	</style>
	<div class="lib-topbar">WAXML Library <span style="opacity:.6">(DEMO)</span></div>
	<div class="lib-body">
		<div class="lib-rail">
			<div class="lib-rail-title">Playlists</div>
			<div class="lib-rail-list"></div>
		</div>
		<div class="lib-list">
			<h2>Productions</h2>
			<div class="lib-rows"></div>
		</div>
		<div class="lib-detail">
			<div class="lib-detail-thumb"></div>
			<div class="lib-detail-name"></div>
			<div class="lib-detail-creator"></div>
			<div class="lib-detail-desc"></div>
		</div>
	</div>
	<div class="lib-bottombar">
		<div class="lib-bottombar-thumb"></div>
		<div class="lib-bottombar-name"></div>
		<wa-player-bar minimal></wa-player-bar>
	</div>
`;

const FAKE_PLAYLISTS = ["Focus Flow", "Night Drive", "Deep Space", "Retro Wave", "Slow Burn", "Foley Vault", "Live Sessions", "Community Picks"];

export class WaLibraryView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._railList = this.shadowRoot.querySelector(".lib-rail-list");
		this._rows = this.shadowRoot.querySelector(".lib-rows");
		this._detailThumb = this.shadowRoot.querySelector(".lib-detail-thumb");
		this._detailName = this.shadowRoot.querySelector(".lib-detail-name");
		this._detailCreator = this.shadowRoot.querySelector(".lib-detail-creator");
		this._detailDesc = this.shadowRoot.querySelector(".lib-detail-desc");
		this._bottomThumb = this.shadowRoot.querySelector(".lib-bottombar-thumb");
		this._bottomName = this.shadowRoot.querySelector(".lib-bottombar-name");
		this._previewIndex = null; // which row's info is showing in the right-hand detail panel
		this._onStoreChange = () => this._render();
		this._onVfsChange = () => this._render();
	}

	connectedCallback() {
		xmlStore.addEventListener("change", this._onStoreChange);
		vfs.addEventListener("change", this._onVfsChange);
		this._renderRail();
		this._render();
	}

	disconnectedCallback() {
		xmlStore.removeEventListener("change", this._onStoreChange);
		vfs.removeEventListener("change", this._onVfsChange);
	}

	_renderRail() {
		this._railList.innerHTML = "";
		FAKE_PLAYLISTS.forEach((name, i) => {
			const item = document.createElement("div");
			item.className = "lib-rail-item";
			const thumb = document.createElement("div");
			thumb.className = "lib-rail-thumb";
			thumb.style.background = this._gradient((i * 47) % 360);
			const label = document.createElement("div");
			label.className = "lib-rail-label";
			label.textContent = name;
			item.appendChild(thumb);
			item.appendChild(label);
			this._railList.appendChild(item);
		});
	}

	_gradient(hue) {
		return `linear-gradient(135deg, hsl(${hue}, 60%, 38%), hsl(${(hue + 40) % 360}, 55%, 18%))`;
	}

	_realThumbnailUrl() {
		return findFirstImage()?.sessionUrl || null;
	}

	// Mutates an existing thumbnail container in place (used for the two
	// single, always-present thumbs — detail panel and bottom bar); either a
	// real <img> (a file was found in the File Manager) or a generated
	// gradient + initial letter otherwise.
	_fillThumb(el, { url, hue, initial }) {
		el.innerHTML = "";
		if (url) {
			const img = document.createElement("img");
			img.src = url;
			img.alt = "";
			el.appendChild(img);
			el.style.background = "";
		} else {
			el.style.background = this._gradient(hue);
			el.textContent = initial;
		}
	}

	// Same as _fillThumb, but for a freshly-created row thumbnail (the
	// production list is rebuilt from scratch on every render).
	_buildThumbEl(className, opts) {
		const el = document.createElement("div");
		el.className = className;
		this._fillThumb(el, opts);
		return el;
	}

	_render() {
		const root = xmlStore.root;
		const realName = root?.attributes.label || "Untitled Project";
		const realThumbUrl = this._realThumbnailUrl();
		const realHue = this._hashHue(realName);
		const realDesc = describeRealProject(root);

		// The real project always sits in the middle of the fake list and is
		// always the one marked "active" — per Hans (2026-09-10), that mark
		// never moves, even though clicking any row changes what the detail
		// panel on the right is *previewing*.
		const list = [...FAKE_PRODUCTIONS];
		const realIndex = Math.floor(list.length / 2);
		list.splice(realIndex, 0, {
			name: realName,
			creator: "You",
			tag: "Your project",
			hue: realHue,
			blurb: realDesc,
			real: true
		});
		if (this._previewIndex === null) this._previewIndex = realIndex;

		this._rows.innerHTML = "";
		list.forEach((item, i) => {
			const row = document.createElement("div");
			row.className = "lib-row";
			row.classList.toggle("active", !!item.real);
			row.classList.toggle("previewing", i === this._previewIndex);

			const index = document.createElement("div");
			index.className = "lib-row-index";
			index.textContent = String(i + 1);

			const thumb = this._buildThumbEl("lib-row-thumb", {
				url: item.real ? realThumbUrl : null,
				hue: item.hue,
				initial: item.name.charAt(0).toUpperCase()
			});

			const meta = document.createElement("div");
			meta.className = "lib-row-meta";
			const nameEl = document.createElement("div");
			nameEl.className = "lib-row-name";
			if (item.real) {
				const dot = document.createElement("span");
				dot.className = "live-dot";
				dot.title = "Currently active in Workstation";
				nameEl.appendChild(dot);
				nameEl.appendChild(document.createTextNode(item.name));
			} else {
				nameEl.textContent = item.name;
			}
			const creatorEl = document.createElement("div");
			creatorEl.className = "lib-row-creator";
			creatorEl.textContent = item.creator;
			meta.appendChild(nameEl);
			meta.appendChild(creatorEl);

			const tag = document.createElement("div");
			tag.className = "lib-row-tag";
			tag.textContent = item.tag;

			row.appendChild(index);
			row.appendChild(thumb);
			row.appendChild(meta);
			row.appendChild(tag);
			row.addEventListener("click", () => {
				this._previewIndex = i;
				this._render();
			});
			this._rows.appendChild(row);
		});

		const previewed = list[this._previewIndex] ?? list[realIndex];
		this._fillThumb(this._detailThumb, {
			url: previewed.real ? realThumbUrl : null,
			hue: previewed.hue,
			initial: previewed.name.charAt(0).toUpperCase()
		});
		this._detailName.textContent = previewed.name;
		this._detailCreator.textContent = previewed.creator;
		this._detailDesc.textContent = previewed.blurb;

		this._fillThumb(this._bottomThumb, { url: realThumbUrl, hue: realHue, initial: realName.charAt(0).toUpperCase() });
		this._bottomName.textContent = realName;
	}

	_hashHue(str) {
		let h = 0;
		for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
		return h;
	}
}

customElements.define("wa-library-view", WaLibraryView);
