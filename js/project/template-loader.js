// Starter projects live in templates/ as .zip files — each one a project
// like any other zip WAW opens (see project-manager.js) — per Hans
// (2026-10-12). templates/manifest.json (see scripts/build-template-manifest.js)
// lists their file names: a browser can't list a plain static server's
// directory on its own, so that manifest stands in for it. The name shown in
// the File menu is the zip's file name without ".zip".

const TEMPLATES_URL = "templates/";
const MANIFEST_URL = `${TEMPLATES_URL}manifest.json`;

// [{ name: "waw-project", fileName: "waw-project.zip" }, ...] — or [] if the
// manifest is missing/unreachable (e.g. no templates/ folder at all), so an
// empty Templates section is the worst case rather than a hard error.
export async function listTemplates() {
	try {
		const res = await fetch(MANIFEST_URL, { cache: "no-store" });
		if (!res.ok) return [];
		const fileNames = await res.json();
		if (!Array.isArray(fileNames)) return [];
		return fileNames
			.filter((f) => typeof f === "string" && f.toLowerCase().endsWith(".zip"))
			.map((fileName) => ({ name: fileName.replace(/\.zip$/i, ""), fileName }));
	} catch {
		return [];
	}
}

export async function fetchTemplateZip(fileName) {
	const res = await fetch(`${TEMPLATES_URL}${encodeURIComponent(fileName)}`, { cache: "no-store" });
	if (!res.ok) throw new Error(`Could not load template "${fileName}" (${res.status})`);
	return new File([await res.blob()], fileName, { type: "application/zip" });
}
