#!/usr/bin/env node
// Regenerates templates/manifest.json from whatever's actually on disk in
// templates/ — run this (node scripts/build-template-manifest.js) any time
// you add, remove, or edit a template's files. The app itself never lists
// the templates/ directory at runtime (a browser can't do that against a
// plain static file server without one), so this manifest is what it reads
// instead, per Hans (2026-09-03) — no other build step involved.

const fs = require("fs");
const path = require("path");

const templatesDir = path.join(__dirname, "..", "templates");
const manifestPath = path.join(templatesDir, "manifest.json");

function walk(dir, base) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".DS_Store") continue;
		const full = path.join(dir, entry.name);
		const rel = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...walk(full, rel));
		else files.push(rel);
	}
	return files;
}

const manifest = {};
for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	manifest[entry.name] = walk(path.join(templatesDir, entry.name), "").sort();
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`Wrote ${manifestPath} with ${Object.keys(manifest).length} template(s): ${Object.keys(manifest).join(", ")}`);
