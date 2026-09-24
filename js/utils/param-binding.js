import { varMapMode } from "../state/var-map-mode.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import { isVariableControlled, variableNameFromValue } from "../xml-editor/variable-references.js";
import { applyLiveProperty } from "../waxml-integration/live-property.js";
import { isNumericAttributeSchema } from "../xml-editor/schema-parser.js";

// A bare plain number (no "$name" reference, no unit suffix like "XdB", no
// math expression) — the shape where the committed string IS the node's own
// native unit value, safe to push straight through to the live graph as-is
// (see commitRaw's own comment).
const BARE_NUMBER_RE = /^-?\d+(\.\d+)?$/;

// Shared building blocks for how every specialized view (wa-chain-view.js,
// wa-mixer-view.js, ...) shows AND edits a single node attribute's raw
// value, so each one gets — for free, without reimplementing it —
// everything wa-node-inspector.js's own attribute rows already have:
//
//  - typing any raw string as the value (a plain number, a math
//    expression, or a "$name" <Var> reference) instead of being limited to
//    whatever the control's own drag/native-number-input normally accepts.
//    Per Hans (2026-09-29): "måste man kunna skriva ett variabelnamn som
//    värde på frequency precis som man kan i XML Editor."
//  - claiming a click while a <Var> knob's "Map..." is armed
//    (js/state/var-map-mode.js) to wire $varName into this attribute
//    directly — same one-to-many click-claiming pattern
//    wa-node-inspector.js's attribute rows and wa-var-knobs.js's own Map
//    button already use. Per Hans (2026-09-29): "Det ska också gå att
//    mappa direkt från INPUT till valfri parameter i en vy."
//
// getNode() is called fresh on every commit (never a captured `node`
// reference) since xmlStore.updateAttributes rebuilds the tree immutably.
//
// Also nudges the live audio graph directly (applyLiveProperty) for a bare
// numeric value — same "commit AND push live" pattern wa-mixer-view.js's
// own knobs already use for a drag. Bug found per Hans (2026-09-30): typing
// a value into one of these chips (as opposed to dragging a knob/canvas
// handle, which already called applyLiveProperty inline) only ever reached
// the XML attribute, never the live node — e.g. typing a new frequency on
// an OscillatorNode didn't change its pitch until the next full reload,
// which a plain numeric change on these node types never actually triggers
// (see xml-store.js's _attributeChangeNeedsRebuild — structural is only
// forced by a routing change, an OscillatorNode.type change, or a value
// newly becoming/stopping being a $var reference). A bare number (this
// regex) is always a node's native unit value already, never dB-suffixed
// or a math expression, so pushing it straight through is safe (see
// gain-units.js's own "a bare number means the node's own native unit"
// convention) — a $var reference or an expression is deliberately left
// alone here; the $var case already gets a full reload for free (same
// xml-store.js rule), and an expression has no single number to push.
function commitRaw(getNode, attrName, raw) {
	const nodeNow = getNode();
	if (!nodeNow) return;
	const next = { ...nodeNow.attributes };
	if (raw === "") delete next[attrName];
	else next[attrName] = raw;
	xmlStore.updateAttributes(nodeNow.id, next);
	if (nodeNow.attributes.id && BARE_NUMBER_RE.test(raw.trim())) {
		applyLiveProperty(nodeNow.attributes.id, attrName, parseFloat(raw));
	}
}

// Claims a pointerdown on `el` while a Var's "Map..." is armed, wiring
// "$varName" into `attrName` instead of whatever `el`'s own interaction
// would otherwise start. Register this BEFORE any drag-start listener on
// the same element (wireKnobDrag, a canvas's own pointerdown, ...) —
// stopImmediatePropagation keeps that later listener from also firing for
// the same pointerdown, since registration order (not capture/bubble
// phase) decides listener order for listeners on the same element.
//
// Disarms Map mode itself right after a successful claim, rather than
// leaving it armed for a follow-up claim elsewhere — per Hans (2026-10-01):
// the "Map..." button's blink never stopped once you'd actually finished
// binding a parameter, which read as broken even though it was originally
// deliberate (2026-09-27: one Var wired to many attributes in a row without
// re-clicking Map each time). var-map-mode.js's own "any unclaimed click
// disarms" listener never got a chance to run here anyway, since
// stopPropagation (needed to stop wireKnobDrag's own pointerdown from also
// firing) keeps this pointerdown from ever reaching it.
//
// Per Hans (2026-10-04 correction): speed/derivative(s) are only ever
// meaningful when mapping a Var TO another Var (see wa-var-knobs.js's own
// _claimVarToVarMapping, which still offers that choice) — a claim landing
// on a regular attribute here always writes the bare "$name" directly, no
// popup, same as before that feature briefly existed on this path too.
export function wireMapClaim(el, { getNode, attrName }) {
	// Static — never toggled per instance/per arm-disarm cycle, so this
	// never needs its own varMapMode listener (which, called fresh on every
	// re-render the way this function is, would leak one new listener per
	// render). The actual on/off blink is driven purely by the inherited
	// "--waw-map-armed-anim" custom property var-map-mode.js's own arm()/
	// disarm() set on document.documentElement — see its comment. The host
	// component's own <style> still needs a matching ".map-target-armed"
	// rule + "target-armed-blink" @keyframes (e.g. wa-chain-view.js's own).
	//
	// Every chip built via buildParamChip is already, by construction, a
	// numeric parameter (frequency/gain/pan/...) — but resolved from the
	// schema here too, rather than just trusted by convention, so the ring
	// (and the claim itself) only ever lights up for a genuinely numeric
	// attribute. Per Hans (2026-10-04): "Den gula blinkande ramen kring
	// potentiella targets när man mappar ska bara vara kring [attribut med
	// numeriska värden / <Var>-element]." Resolved once, at wiring time — a
	// chip's own attrName/node tagName never change across its lifetime.
	const nodeForSchema = getNode();
	const attrSchema = nodeForSchema && xmlStore.schema?.elements[nodeForSchema.tagName]?.allowedAttributes.find((a) => a.name === attrName);
	const isNumericTarget = isNumericAttributeSchema(attrSchema);
	if (isNumericTarget) el.classList.add("map-target-armed");
	el.addEventListener("pointerdown", (e) => {
		if (!varMapMode.armed || !isNumericTarget) return;
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		commitRaw(getNode, attrName, `$${varMapMode.varName}`);
		varMapMode.disarm();
	});
}

// Double-click (or `eventName`) `el` to replace it in place with a text
// input pre-filled with the attribute's raw current value (which might
// already be a "$name" reference or a math expression) — Enter/blur
// commits, Escape cancels, then the input is swapped back for `el`. Used
// directly on compact controls (a Mixer knob) that have no room for a
// separate visible label; buildParamChip below wraps this around its own
// dedicated chip instead.
//
// eventName defaults to "dblclick", but a caller whose element *already*
// has its own dblclick behavior (wa-mixer-view.js's knobs double-click to
// reset to their default value — see wireKnobDrag) should pass
// "contextmenu" instead, so the two gestures don't collide.
export function wireInlineTextEdit(el, { getNode, attrName, inputClassName = "param-inline-input", eventName = "dblclick" }) {
	el.addEventListener(eventName, (e) => {
		e.preventDefault();
		e.stopPropagation();
		const nodeNow = getNode();
		if (!nodeNow) return;
		const input = document.createElement("input");
		input.type = "text";
		input.className = inputClassName;
		input.value = nodeNow.attributes[attrName] ?? "";
		el.replaceWith(input);
		input.focus();
		input.select();
		let finished = false;
		const finish = (commit) => {
			if (finished) return;
			finished = true;
			if (commit) commitRaw(getNode, attrName, input.value.trim());
			input.replaceWith(el);
		};
		input.addEventListener("keydown", (ke) => {
			if (ke.key === "Enter") finish(true);
			else if (ke.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
	});
}

// Builds a small standalone "chip" — a visible value label that is itself
// the editable/mappable surface (wireMapClaim + wireInlineTextEdit rolled
// into one element). Used by views with room for a dedicated value label
// (wa-chain-view.js's cards); pass a `getNode`/`attrName` pair and append
// the returned `.el`, then call `.render(text)` to set its displayed
// (formatted) text whenever the value changes.
export function buildParamChip({ getNode, attrName, className = "param-chip" }) {
	const chip = document.createElement("span");
	chip.className = className;
	chip.tabIndex = 0;
	wireMapClaim(chip, { getNode, attrName });
	wireInlineTextEdit(chip, { getNode, attrName, inputClassName: `${className}-input` });
	return {
		el: chip,
		// A no-op while mid-edit (chip is briefly detached from the DOM,
		// see wireInlineTextEdit) is harmless — it'll show whatever was
		// last rendered once editing finishes and the chip is reinserted.
		render(text) {
			chip.textContent = text;
		}
	};
}

// True when this node's attribute is currently a "$name" <Var> reference —
// dragging a knob/handle bound to it would just fight waxml.js's own
// Watcher (same reasoning as wa-mixer-view.js's _lockRemoteControlled).
// Callers should skip wiring their own drag/pointer interaction entirely
// when this is true (wireMapClaim/wireInlineTextEdit stay available
// regardless, so a locked control can still be retyped or remapped).
export function isParamVarControlled(node, attrName) {
	return isVariableControlled(node.attributes[attrName]);
}

export function varNameForParam(node, attrName) {
	return variableNameFromValue(node.attributes[attrName]);
}
