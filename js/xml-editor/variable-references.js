// Detects whether an attribute's raw string value is a reference to a
// <Var> (e.g. "$intensity", "${intensity}", "var(intensity)") rather than a
// literal value — waxml.js resolves these itself via a Watcher that pushes
// live updates into the node's own property whenever the named Variable
// changes (see waxml.js's Parser.parseXML, WebAudioUtils.nrOfVariableNames).
//
// The regex mirrors waxml.js's own `rxp` (WebAudioUtils.nrOfVariableNames/
// getVariableNames) exactly — duplicated here rather than reached into
// waxml.js's internals, since waxml.js is only ever loaded as a plain
// <script> and doesn't expose WebAudioUtils on `window`.
const VAR_REF_SOURCE = "[$][{]([a-z0-9:_]+)[}]|[$]([a-z0-9:_.]*)|var[(]([a-z0-9:_]+)[)]";

export function isVariableControlled(value) {
	if (typeof value !== "string" || value === "") return false;
	return new RegExp(VAR_REF_SOURCE, "i").test(value);
}

// The variable name a value refers to (the part after "$"/"${...}"/"var(...)"),
// or null if the value isn't a variable reference at all.
export function variableNameFromValue(value) {
	if (typeof value !== "string") return null;
	const match = new RegExp(VAR_REF_SOURCE, "i").exec(value);
	if (!match) return null;
	return match[1] || match[2] || match[3] || null;
}

// The dot-suffix a value references on its target Var (e.g. "$name.speed"
// -> "speed"), or "value" when the reference is bare (e.g. "$name") — same
// default waxml.js's own WebAudioUtils.replaceVariableNames falls back to.
// Only the bare "$name[.prop]" form (group 2 above) actually allows a dot;
// "${name}"/"var(name)" never do, matching waxml.js's own rxp regex.
export function variablePropFromValue(value) {
	if (typeof value !== "string") return "value";
	const match = new RegExp(VAR_REF_SOURCE, "i").exec(value);
	if (!match) return "value";
	const full = match[1] || match[2] || match[3] || "";
	const dot = full.indexOf(".");
	return dot === -1 ? "value" : full.slice(dot + 1) || "value";
}

// Rewrites every reference to the <Var> `oldName` in one attribute value to
// `newName` — "$old", "${old}" and "var(old)", where a "$old" only counts when
// the name ends there (so "$old2" is another variable, while "$old.speed" is
// still this one's property). Returns the value untouched when nothing matches.
export function renameVariableInValue(value, oldName, newName) {
	if (typeof value !== "string" || !value.toLowerCase().includes(oldName.toLowerCase())) return value;
	const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return value
		.replace(new RegExp(`\\$\\{${esc}\\}`, "gi"), () => `\${${newName}}`)
		.replace(new RegExp(`var\\(${esc}\\)`, "gi"), () => `var(${newName})`)
		.replace(new RegExp(`\\$${esc}(?![a-z0-9:_])`, "gi"), () => `$${newName}`);
}
