// Ordering rules for the elements inside a <Chain>. waxml.js connects a
// Chain's children one after another (the Chain's input into the first,
// each element's output into the next), so an element with no audio input
// (a generator: AudioBufferSourceNode, OscillatorNode, ...) only works as
// the very first one — anything placed before it is cut off from the rest
// of the chain, and a second generator can't be first as well. Per Hans
// (2026-10-09).
//
// "Has no audio input" is read from the schema (an element that declares an
// `output` attribute but no `input` — see commonNodeAttributesNoInput in
// waxml.xsd), so a new generator element joins the rule just by being
// declared that way. The few such elements that aren't audio at all are
// listed below, and Var/Envelope/Snapshot are skipped when working out what
// the chain's "first" element is, since waxml.js passes straight over them.

const NOT_AUDIO_SOURCES = new Set(["Var", "Envelope", "Snapshot", "Layer", "Stinger"]);
const SKIPPED_IN_CHAIN = new Set(["Var", "Envelope", "Snapshot", "Command", "Parameter"]);
// Used only when no schema is loaded.
const FALLBACK_SOURCES = new Set(["AudioBufferSourceNode", "MediaStreamAudioSourceNode", "OscillatorNode", "AmbientAudio"]);

export function lacksAudioInput(schema, tagName) {
	if (NOT_AUDIO_SOURCES.has(tagName)) return false;
	const element = schema?.elements?.[tagName];
	if (!element) return FALLBACK_SOURCES.has(tagName);
	const names = element.allowedAttributes.map((a) => a.name);
	return names.includes("output") && !names.includes("input");
}

// Every element sitting in the wrong place inside some <Chain>, as
// { key, tagName, id, chainId, message }. `key` is stable across edits that
// don't touch the problem (tag + XML id), so a caller can tell a newly
// introduced problem from one it has already reported.
export function findChainOrderProblems(schema, root) {
	const problems = [];
	const walk = (node) => {
		if (node.tagName === "Chain") collectChainProblems(schema, node, problems);
		node.children.forEach(walk);
	};
	if (root) walk(root);
	return problems;
}

function describe(node) {
	return node.attributes.id ? `<${node.tagName} id="${node.attributes.id}">` : `<${node.tagName}>`;
}

function collectChainProblems(schema, chain, problems) {
	const audio = chain.children.filter((c) => !SKIPPED_IN_CHAIN.has(c.tagName));
	const first = audio[0];
	audio.forEach((child, i) => {
		if (i === 0 || !lacksAudioInput(schema, child.tagName)) return;
		const chainName = chain.attributes.id ? `<Chain id="${chain.attributes.id}">` : "<Chain>";
		const message =
			first && lacksAudioInput(schema, first.tagName)
				? `${describe(child)} has no audio input, so it has to be the first element in its ${chainName} — but ${describe(first)} already is, and a Chain only has room for one.`
				: `${describe(child)} has no audio input, so it has to be the first element in its ${chainName}.`;
		problems.push({
			key: `${child.tagName}#${child.attributes.id ?? child.id}`,
			tagName: child.tagName,
			id: child.attributes.id ?? null,
			chainId: chain.attributes.id ?? null,
			message
		});
	});
}
