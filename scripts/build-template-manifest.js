#!/usr/bin/env node
// Regenerates templates/manifest.json from the .zip files that are actually
// in templates/ — run this (node scripts/build-template-manifest.js) any time
// you add, remove or rename a template. The app itself never lists the
// templates/ directory at runtime (a browser can't do that against a plain
// static file server), so this manifest is what it reads instead. Each
// template is a normal WAW project zip; its File menu name is the file name
// without ".zip".

const fs = require("fs");
const path = require("path");

const templatesDir = path.join(__dirname, "..", "templates");
const manifestPath = path.join(templatesDir, "manifest.json");

const zips = fs
	.readdirSync(templatesDir, { withFileTypes: true })
	.filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.toLowerCase().endsWith(".zip"))
	.map((e) => e.name)
	.sort((a, b) => a.localeCompare(b));

fs.writeFileSync(manifestPath, JSON.stringify(zips, null, "\t") + "\n");
console.log(`Wrote ${manifestPath} with ${zips.length} template(s): ${zips.join(", ")}`);
