// The Export dialog's "Public pages" tab: for every project zip in the
// public/ folder (listed in public/manifest.json — see
// scripts/build-template-manifest.js), the address of each of its Stage views
// in the viewer (viewer.html, which shows that one view and nothing else).
// Per Hans (2026-10-15). public/ is the temporary home of published projects
// until a server takes over; the LTI addresses will join these when that
// layer exists.
//
// The views of a zip are read from the zip's own stage.json, so this always
// shows what the file really holds. A zip without one has a single view, "default".

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
			overflow: auto;
			padding: 0.9rem 1.1rem;
			font: 0.85rem/1.5 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		h3 {
			margin: 0 0 0.3rem;
			font-size: 0.85rem;
		}
		p {
			margin: 0 0 0.8rem;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.78rem;
		}
		.project {
			margin-bottom: 1.1rem;
			padding-bottom: 0.9rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.project-name {
			font-weight: 600;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
		}
		.view {
			margin: 0.5rem 0 0 0.6rem;
		}
		.view-name {
			font-size: 0.78rem;
			color: #cdd3d8;
		}
		.url-row {
			display: flex;
			gap: 0.4rem;
			align-items: center;
			margin-top: 0.2rem;
		}
		.url {
			flex: 1 1 auto;
			min-width: 0;
			font: 0.72rem var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			background: #101010;
			color: #cdd3d8;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.25rem 0.4rem;
		}
		button {
			flex: 0 0 auto;
			font: inherit;
			font-size: 0.72rem;
			background: #2a2a2a;
			color: inherit;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 4px;
			padding: 0.2rem 0.5rem;
			cursor: pointer;
		}
		button:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.empty, .error {
			color: var(--waw-muted, #8a8a8a);
		}
		.error {
			color: var(--waw-danger, #e5484d);
		}
	</style>
	<h3>Public pages</h3>
	<p>One address per view of each project in the <code>public/</code> folder. The address opens just that view — no menus, no other views.</p>
	<div class="list"></div>
`;

export class WaPublicLinks extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._list = this.shadowRoot.querySelector(".list");
	}

	// Re-reads public/ — called each time the tab is shown, so a project added
	// meanwhile appears without a reload.
	async refresh() {
		this._list.textContent = "Loading…";
		let names;
		try {
			const res = await fetch("public/manifest.json", { cache: "no-store" });
			names = res.ok ? await res.json() : [];
		} catch {
			names = [];
		}
		if (!Array.isArray(names) || !names.length) {
			this._list.innerHTML = "";
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "No projects in the public/ folder yet. Save a project there as a .zip and run scripts/build-template-manifest.js.";
			this._list.appendChild(empty);
			return;
		}
		this._list.innerHTML = "";
		for (const name of names) this._list.appendChild(await this._buildProject(name));
	}

	async _buildProject(zipName) {
		const box = document.createElement("div");
		box.className = "project";
		const title = document.createElement("div");
		title.className = "project-name";
		title.textContent = zipName;
		box.appendChild(title);
		try {
			const views = await this._readViews(zipName);
			views.forEach((view) => box.appendChild(this._buildView(zipName, view)));
		} catch (err) {
			const e = document.createElement("div");
			e.className = "error";
			e.textContent = `Could not read this project: ${err.message}`;
			box.appendChild(e);
		}
		return box;
	}

	// [{ id, name }] from the zip's stage.json (current format, or the first
	// one's plain item list — which has no ids, so it counts as the default view).
	async _readViews(zipName) {
		if (typeof JSZip === "undefined") throw new Error("JSZip is not loaded");
		const res = await fetch(`public/${encodeURIComponent(zipName)}`, { cache: "no-store" });
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const zip = await JSZip.loadAsync(await res.blob());
		const entry = Object.values(zip.files).find((f) => !f.dir && /(^|\/)stage\.json$/.test(f.name));
		if (!entry) return [{ id: "default", name: "Stage" }];
		const data = JSON.parse(await entry.async("string"));
		const views = Array.isArray(data.views) ? data.views.filter((v) => v && typeof v.id === "string").map((v) => ({ id: v.id, name: v.name || v.id })) : [];
		return views.length ? views : [{ id: "default", name: "Stage" }];
	}

	_buildView(zipName, view) {
		const url = new URL(`viewer.html?project=${encodeURIComponent(`public/${zipName}`)}&view=${encodeURIComponent(view.id)}`, location.href).href;
		const box = document.createElement("div");
		box.className = "view";
		const name = document.createElement("div");
		name.className = "view-name";
		name.textContent = view.name;
		const row = document.createElement("div");
		row.className = "url-row";
		const input = document.createElement("input");
		input.className = "url";
		input.readOnly = true;
		input.value = url;
		input.addEventListener("focus", () => input.select());
		const copy = document.createElement("button");
		copy.type = "button";
		copy.textContent = "Copy";
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(url);
				copy.textContent = "Copied";
			} catch {
				input.select();
				copy.textContent = "Select + copy";
			}
			setTimeout(() => (copy.textContent = "Copy"), 1200);
		});
		const open = document.createElement("button");
		open.type = "button";
		open.textContent = "Open";
		open.addEventListener("click", () => window.open(url, "_blank", "noopener"));
		row.append(input, copy, open);
		box.append(name, row);
		return box;
	}
}

customElements.define("wa-public-links", WaPublicLinks);
