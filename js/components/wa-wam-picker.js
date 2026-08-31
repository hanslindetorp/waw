import { getInsertEffects, groupByCategory } from "../wam/wam-catalog.js";

// Modal "pick an insert effect" browser — per wam-insert-effects-instructions.md.
// Used imperatively: `const effect = await openWamPicker(); if (effect) { ... }`
// resolves with the chosen catalog entry (pluginSrc/thumbnailUrl already
// resolved, see wam-catalog.js), or null if the user closed it without
// picking anything. Self-contained custom element, created/destroyed per use
// rather than living in index.html, same reasoning a native <dialog> would be
// used one-off — nothing else on the page needs to reference it.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
			display: flex;
			align-items: center;
			justify-content: center;
			font: 0.85rem/1.4 system-ui, sans-serif;
		}
		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.55);
		}
		.panel {
			position: relative;
			width: min(46rem, 92vw);
			height: min(34rem, 82vh);
			background: var(--waw-panel-bg, #1a1a1a);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 8px;
			box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			padding: 0.7rem 1rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.panel-header h2 {
			margin: 0;
			font-size: 0.95rem;
			font-weight: 600;
		}
		.close-btn {
			background: none;
			border: none;
			color: var(--waw-muted, #8a8a8a);
			font-size: 1.1rem;
			line-height: 1;
			cursor: pointer;
			padding: 0.2rem 0.4rem;
		}
		.close-btn:hover {
			color: var(--waw-fg, #e8e8e8);
		}
		.search-row {
			padding: 0.6rem 1rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.search-row input {
			width: 100%;
			background: #111;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			color: inherit;
			font: inherit;
			padding: 0.4rem 0.6rem;
			box-sizing: border-box;
		}
		.body {
			flex: 1 1 auto;
			overflow-y: auto;
			padding: 0.4rem 0.6rem 1rem;
		}
		.status {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			margin-top: 2rem;
		}
		.group-heading {
			margin: 0.9rem 0.4rem 0.3rem;
			font-size: 0.72rem;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--waw-muted, #8a8a8a);
		}
		.group-heading:first-child {
			margin-top: 0.4rem;
		}
		.effect-list {
			display: flex;
			flex-direction: column;
		}
		.effect-item {
			display: flex;
			align-items: center;
			gap: 0.6rem;
			width: 100%;
			text-align: left;
			background: none;
			border: none;
			color: inherit;
			font: inherit;
			padding: 0.4rem;
			border-radius: 6px;
			cursor: pointer;
		}
		.effect-item:hover {
			background: rgba(79, 163, 255, 0.15);
		}
		.effect-thumb {
			width: 2.4rem;
			height: 2.4rem;
			border-radius: 4px;
			object-fit: cover;
			background: #101010;
			border: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
		}
		.effect-thumb.placeholder {
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 0.7rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.effect-text {
			min-width: 0;
		}
		.effect-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.effect-vendor {
			font-size: 0.72rem;
			color: var(--waw-muted, #8a8a8a);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	</style>
	<div class="backdrop"></div>
	<div class="panel" role="dialog" aria-label="Add insert effect">
		<div class="panel-header">
			<h2>Add insert effect</h2>
			<button class="close-btn" type="button" title="Close">✕</button>
		</div>
		<div class="search-row">
			<input type="text" placeholder="Search effects or vendors…" />
		</div>
		<div class="body">
			<p class="status">Loading WAM catalog…</p>
		</div>
	</div>
`;

class WaWamPicker extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._body = this.shadowRoot.querySelector(".body");
		this._search = this.shadowRoot.querySelector(".search-row input");
		this._resolve = null;
		this._allEffects = [];
	}

	connectedCallback() {
		this.shadowRoot.querySelector(".backdrop").addEventListener("click", () => this._finish(null));
		this.shadowRoot.querySelector(".close-btn").addEventListener("click", () => this._finish(null));
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this._finish(null);
		};
		document.addEventListener("keydown", this._onKeyDown);
		this._search.addEventListener("input", () => this._render());
		this._search.focus();

		getInsertEffects()
			.then((effects) => {
				this._allEffects = effects;
				this._render();
			})
			.catch((err) => {
				console.error("Could not load WAM catalog:", err);
				this._body.innerHTML = `<p class="status">Could not load the WAM catalog. Check your connection and try again.</p>`;
			});
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	// Returns a Promise<effect|null> — resolved once, when the user either
	// picks an effect or dismisses the picker.
	whenDone() {
		return new Promise((resolve) => {
			this._resolve = resolve;
		});
	}

	_render() {
		const query = this._search.value.trim().toLowerCase();
		const filtered = query ? this._allEffects.filter((e) => e.name.toLowerCase().includes(query) || (e.vendor || "").toLowerCase().includes(query)) : this._allEffects;

		if (filtered.length === 0) {
			this._body.innerHTML = `<p class="status">No effects found.</p>`;
			return;
		}

		this._body.innerHTML = "";
		for (const [groupName, effects] of groupByCategory(filtered)) {
			const heading = document.createElement("h3");
			heading.className = "group-heading";
			heading.textContent = groupName;
			this._body.appendChild(heading);

			const list = document.createElement("div");
			list.className = "effect-list";
			effects.forEach((effect) => list.appendChild(this._buildEffectItem(effect)));
			this._body.appendChild(list);
		}
	}

	_buildEffectItem(effect) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "effect-item";

		if (effect.thumbnailUrl) {
			const img = document.createElement("img");
			img.className = "effect-thumb";
			img.src = effect.thumbnailUrl;
			img.alt = "";
			img.loading = "lazy";
			img.onerror = () => img.remove();
			item.appendChild(img);
		} else {
			const placeholder = document.createElement("div");
			placeholder.className = "effect-thumb placeholder";
			placeholder.textContent = "WAM";
			item.appendChild(placeholder);
		}

		const text = document.createElement("div");
		text.className = "effect-text";
		text.innerHTML = `<div class="effect-name"></div><div class="effect-vendor"></div>`;
		text.querySelector(".effect-name").textContent = effect.name;
		text.querySelector(".effect-vendor").textContent = effect.vendor || "";
		item.appendChild(text);

		item.addEventListener("click", () => this._finish(effect));
		return item;
	}

	_finish(effect) {
		this._resolve?.(effect);
		this._resolve = null;
		this.remove();
	}
}

customElements.define("wa-wam-picker", WaWamPicker);

export function openWamPicker() {
	const picker = document.createElement("wa-wam-picker");
	document.body.appendChild(picker);
	return picker.whenDone();
}
