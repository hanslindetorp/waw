// How a random range (see tasks/ab-task.js) is shown on a control while a task is
// being set up: the part of the control that the value may be drawn from is coloured
// — an arc around a knob, a band along a fader's track, a field in a filter's graph.
// t0 and t1 are positions along the control, 0..1.

export const RANGE_COLOR = "rgba(69, 181, 140, 0.9)";
export const RANGE_FILL = "rgba(69, 181, 140, 0.2)";
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// An arc outside a knob of `sizePx`, between two positions of its -135°..+135° sweep;
// sized and placed like the knob's tick ring (which it is added to).
export function rangeArcSvg(sizePx, t0, t1) {
	const NS = "http://www.w3.org/2000/svg";
	const outer = sizePx + 10;
	const c = outer / 2;
	const r = sizePx / 2 + 1;
	const a0 = -135 + clamp01(t0) * 270;
	const a1 = -135 + clamp01(t1) * 270;
	const point = (deg) => [c + r * Math.sin((deg * Math.PI) / 180), c - r * Math.cos((deg * Math.PI) / 180)];
	const [x0, y0] = point(a0);
	const [x1, y1] = point(a1);
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("width", outer);
	svg.setAttribute("height", outer);
	svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible";
	const path = document.createElementNS(NS, "path");
	path.setAttribute("d", `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`);
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", RANGE_COLOR);
	path.setAttribute("stroke-width", "3");
	path.setAttribute("stroke-linecap", "round");
	svg.appendChild(path);
	return svg;
}

// A band along a fader's track (a position 0 at the bottom, 1 at the top).
export function rangeBand(t0, t1) {
	const band = document.createElement("div");
	band.className = "range-band";
	const lo = clamp01(Math.min(t0, t1));
	const hi = clamp01(Math.max(t0, t1));
	band.style.cssText = `position:absolute;left:-2px;right:-2px;bottom:${lo * 100}%;height:${(hi - lo) * 100}%;background:${RANGE_FILL};border:1px solid ${RANGE_COLOR};border-radius:3px;pointer-events:none`;
	return band;
}
