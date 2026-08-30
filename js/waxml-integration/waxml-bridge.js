// Thin wrapper around the global `window.waxml` instance, following the
// integration rules from docs/WAXML-Workstation-spec.md avsnitt 2:
// - content updates go through updateFromString(), never script-tag swapping
// - audio only starts from waxml.init() inside a real click handler

import * as ops from "../xml-editor/xml-tree-ops.js";
import { resolvePlayableUrl } from "../xml-editor/src-attribute.js";

const PREVIEW_CLASS = "waw-preview-target";

export class WaxmlBridge {
	constructor() {
		this.lastXmlString = "";
	}

	get waxml() {
		const instance = window.waxml;
		if (!instance) {
			throw new Error("waxml.js has not finished loading yet.");
		}
		return instance;
	}

	get audioContext() {
		return this.waxml._ctx;
	}

	// Loads a single XML-tree node (as currently edited — tagName + attributes,
	// with `resolvedSrc` swapped in for its src/source attribute so playback
	// uses the real session blob: URL rather than the visible export path).
	async loadNode(node, srcAttrName, resolvedSrc) {
		this.lastXmlString = buildNodePreviewXml(node, srcAttrName, resolvedSrc);
		await this.waxml.updateFromString(this.lastXmlString);
	}

	// Loads the WHOLE current document (so Composition-level defaults like a
	// shared tempo still apply) and tags one specific node (e.g. an
	// <arrangement>) with the preview marker class for trig()/stop(). Every
	// src/source attribute anywhere in the (cloned) tree is resolved from its
	// visible VFS export path to a real playable session URL first — a plain
	// document walk, not just the target node, since an arrangement pulls in
	// its whole track/region/option subtree.
	async loadDocumentTargeting(root, targetNodeId) {
		const clone = structuredClone(root);
		resolveSrcAttributesInPlace(clone);

		const target = ops.findNodeById(clone, targetNodeId);
		if (target) {
			target.attributes = { ...target.attributes, class: [target.attributes.class, PREVIEW_CLASS].filter(Boolean).join(" ") };
		}

		this.lastXmlString = ops.generateFullXml(clone);
		await this.waxml.updateFromString(this.lastXmlString);
	}

	// Loads the WHOLE current document exactly as-is — every real id intact,
	// nothing tagged with the preview-only class — for the global player
	// (see player-store.js): once loaded, any element can be trig()'d by its
	// own real selector directly, no per-node "targeting" load needed. Every
	// src/source attribute is still resolved from its visible VFS export
	// path to a real playable session URL first, same as
	// loadDocumentTargeting.
	async loadFullDocument(root) {
		const clone = structuredClone(root);
		resolveSrcAttributesInPlace(clone);
		this.lastXmlString = ops.generateFullXml(clone);
		await this.waxml.updateFromString(this.lastXmlString);
	}

	// Must be called from inside a user gesture (click handler) the first time,
	// so the browser lets the AudioContext resume.
	play() {
		this.waxml.init();
		this.waxml.trig(`.${PREVIEW_CLASS}`);
	}

	stop() {
		this.waxml.stop(`.${PREVIEW_CLASS}`);
	}

	// Global player (see player-store.js): trig/stop against the whole
	// engine directly, by whatever selector the caller supplies — not
	// scoped to a single "preview target", since the global player can
	// address any element in the (fully, plainly loaded — see
	// loadFullDocument) document, plus any number of independent trigger-
	// shortcut buttons at once.
	trig(selector) {
		this.waxml.init();
		this.waxml.trig(selector);
	}

	stopAll() {
		this.waxml.stop("all");
	}

	// Triggers one specific node (by its auto-assigned `id` attribute)
	// within the document already loaded for preview — used to trigger an
	// individual <Stinger> live during Section Preview playback, distinct
	// from play()'s whole-preview-target trig(). An explicit [id='...']
	// attribute selector is used rather than "#id" shorthand: a plain XML
	// document has no DTD, so the browser doesn't know which attribute is of
	// type ID for "#" to match against, but a plain attribute selector works
	// regardless.
	trigNode(nodeId) {
		this.waxml.trig(`[id='${nodeId}']`);
	}

	// Resolves a selector to the live runtime object(s) (not XML DOM nodes —
	// waxml's own querySelectorAll on the engine itself already returns the
	// attached .obj/.audioObject wrapper directly) for whatever's currently
	// loaded — e.g. a <Chain>'s or <Mixer>'s own object, whose `.output` is a
	// real (tappable, non-destructively connectable) Web Audio GainNode. Only
	// meaningful once a document has actually been loaded via
	// loadDocumentTargeting/loadNode; each call to those tears down and
	// rebuilds every object, so any reference obtained here goes stale the
	// next time the document reloads.
	getLiveObjects(selector) {
		return this.waxml.querySelectorAll(selector);
	}
}

function resolveSrcAttributesInPlace(node) {
	for (const key of Object.keys(node.attributes)) {
		const lower = key.toLowerCase();
		if (lower !== "src" && lower !== "source") continue;
		const resolved = resolvePlayableUrl(node.attributes[key]);
		if (resolved) node.attributes[key] = resolved;
	}
	node.children.forEach(resolveSrcAttributesInPlace);
}

function buildNodePreviewXml(node, srcAttrName, resolvedSrc) {
	const attrs = { ...node.attributes };
	if (srcAttrName) attrs[srcAttrName] = resolvedSrc;
	attrs.class = [attrs.class, PREVIEW_CLASS].filter(Boolean).join(" ");

	const attrString = Object.entries(attrs)
		.map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
		.join("");

	return `<WAXML version="1.0">\n\t<${node.tagName}${attrString} />\n</WAXML>`;
}

function escapeXmlAttr(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
