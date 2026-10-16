#!/usr/bin/env node
// Regenerates templates/manifest.json AND public/manifest.json from the .zip
// files that are actually in those two folders — run this
// (node scripts/build-template-manifest.js) any time you add, remove or
// rename a zip in either. The app itself never lists a directory at runtime
// (a browser can't do that against a plain static file server), so these
// manifests are what it reads instead.
//   templates/  starter projects, listed in the File menu (see
//               js/project/template-loader.js); the menu name is the file name
//               without ".zip".
//   public/     projects published for the viewer (viewer.html) — the Export
//               dialog's "Public pages" tab lists their views and addresses
//               (see js/components/wa-public-links.js).

const fs = require("fs");
const path = require("path");

for (const folder of ["templates", "public"]) {
	const dir = path.join(__dirname, "..", folder);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir);
	const manifestPath = path.join(dir, "manifest.json");
	const zips = fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.toLowerCase().endsWith(".zip"))
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b));
	fs.writeFileSync(manifestPath, JSON.stringify(zips, null, "\t") + "\n");
	console.log(`Wrote ${manifestPath} with ${zips.length} zip(s): ${zips.join(", ")}`);
}
