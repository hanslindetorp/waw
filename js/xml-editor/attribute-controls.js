// Pure helpers for NodeInspector's schema-driven attribute controls.
// Ported from the XML-editor-DEMO Lovable prototype (src/components/NodeInspector.tsx).

export function testPattern(pattern, value) {
	if (!pattern) return null;
	try {
		return new RegExp(`^${pattern}$`).test(value);
	} catch {
		return null;
	}
}

// Smart range defaults for numeric attributes without schema-specified min/max,
// guessed from common audio/synth parameter naming.
export function getSmartRange(attrName, schemaMin, schemaMax) {
	const hasMin = schemaMin !== undefined && schemaMin !== null;
	const hasMax = schemaMax !== undefined && schemaMax !== null;

	if (hasMin && hasMax) {
		const range = schemaMax - schemaMin;
		const step = range > 100 ? 1 : range > 10 ? 0.1 : 0.01;
		return { min: schemaMin, max: schemaMax, step };
	}

	const name = attrName.toLowerCase();
	if (name.includes("frequency") || name === "freq") return { min: 0, max: 20000, step: 1 };
	if (name.includes("gain") || name === "volume" || name === "level" || name === "amp" || name === "amplitude") return { min: 0, max: 1, step: 0.01 };
	if (name === "pan" || name === "balance") return { min: -1, max: 1, step: 0.01 };
	if (name === "q" || name === "quality" || name.includes("resonance")) return { min: 0, max: 100, step: 0.1 };
	if (name.includes("delay") || name.includes("time") || name.includes("duration")) return { min: 0, max: 10, step: 0.01 };
	if (name.includes("rate") || name.includes("speed")) return { min: 0, max: 10, step: 0.1 };
	if (name.includes("detune")) return { min: -1200, max: 1200, step: 1 };
	if (name.includes("octave")) return { min: -4, max: 4, step: 1 };
	if (name.includes("semitone")) return { min: -12, max: 12, step: 1 };
	if (name.includes("cent")) return { min: -100, max: 100, step: 1 };
	if (name.includes("angle") || name.includes("phase")) return { min: 0, max: 360, step: 1 };
	if (name.includes("percent") || name.includes("mix") || name === "wet" || name === "dry" || name === "feedback") return { min: 0, max: 100, step: 1 };
	if (name.includes("pitch")) return { min: -24, max: 24, step: 1 };
	if (name.includes("bpm") || name.includes("tempo")) return { min: 20, max: 300, step: 1 };
	if (name.includes("channel")) return { min: 0, max: 16, step: 1 };
	if (name.includes("velocity")) return { min: 0, max: 127, step: 1 };
	if (name.includes("note")) return { min: 0, max: 127, step: 1 };

	const min = hasMin ? schemaMin : 0;
	const max = hasMax ? schemaMax : 100;
	const range = max - min;
	const step = range > 100 ? 1 : range > 10 ? 0.1 : 0.01;
	return { min, max, step };
}
