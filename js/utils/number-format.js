// Shared "how many decimals to show" rule for any live/mapped numeric
// readout across WAW (Var knobs, the Var mapping editor's own live value
// fields, ...) — per Hans (2026-09-25): scaled to the value's own
// characteristic magnitude rather than a flat decimal count, so a 0-1
// range shows 2 decimals ("0.42"), a 0-10 range shows 1 ("4.2"), and a
// 0-100+ range shows 0 ("42"). `max` is that magnitude (typically the
// larger-absolute-value end of the value's own domain); digitsBeforeDecimal
// is how many integer digits it has (e.g. "10" -> 2); 3 minus that is
// exactly the three example cases above.
export function decimalsForMax(max) {
	const digitsBeforeDecimal = String(Math.floor(Math.abs(max))).length;
	return Math.max(0, 3 - digitsBeforeDecimal);
}

export function formatValue(v, max) {
	if (!Number.isFinite(v)) return "—";
	return v.toFixed(decimalsForMax(max));
}
