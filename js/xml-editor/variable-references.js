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
