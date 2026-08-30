// Converts a linear amplitude ratio (the XML "gain" attribute's own 0-1
// form — see the `gain` simpleType in waxml.xsd) to dB. 1 is unity gain
// (0dB), 0 is silence (-Infinity dB), and everything between follows the
// standard 20*log10 AMPLITUDE-ratio conversion — not the 10*log10
// power-ratio one. Web Audio's GainNode.gain is a linear amplitude
// multiplier, so e.g. 0.5 is -6.02dB, not -3dB (which is instead the
// power-halving point, for a param whose native unit is power rather than
// amplitude).
export function linearRatioToDb(ratio) {
	return ratio <= 0 ? -Infinity : 20 * Math.log10(ratio);
}
