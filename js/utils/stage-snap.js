// Snapping for the Stage, after Apple Pages' alignment guides (per Hans,
// 2026-10-17): while an item is moved or widened it is pulled into line with the
// edges and the centres of the other items and of the page — a thin guide line
// shows what it lines up with — and into the same spacing as the gaps between
// other items (the guide then marks the equal gaps). Nothing here knows about the
// DOM: a rectangle is { x, y, w, h } in the Stage's own units, and the result says
// how far to move and which guides to draw.
//
//   computeSnap({ moving, others, stage: { w, h }, threshold, axes, anchors })
//     -> { dx, dy, guides }
//
// A guide is either
//   { kind: "line", axis: "x"|"y", pos, from, to }     a line at x (or y) = pos from `from` to `to` on the other axis
//   { kind: "gap", axis: "x"|"y", cross, from, to }    a spacing marker between `from` and `to` along the axis, at `cross` on the other
//
// `axes` limits what may snap (a widened item only snaps in x); `anchors` which of
// the moving item's lines count: "start", "center", "end".

export const SNAP_MARGIN = 24; // the page also has guides this far in from each edge

const AXES = {
	x: { pos: "x", size: "w", cross: "y", crossSize: "h" },
	y: { pos: "y", size: "h", cross: "x", crossSize: "w" }
};

const overlap = (aStart, aLen, bStart, bLen) => aStart < bStart + bLen && bStart < aStart + aLen;

function snapAxis(axis, moving, others, stage, threshold, anchorNames) {
	const A = AXES[axis];
	const m = { start: moving[A.pos], center: moving[A.pos] + moving[A.size] / 2, end: moving[A.pos] + moving[A.size] };

	// ── Alignment: an anchor of the moving item meets a line of something else ──
	const targets = [];
	others.forEach((o) => {
		[o[A.pos], o[A.pos] + o[A.size] / 2, o[A.pos] + o[A.size]].forEach((v) => targets.push({ v, owner: o }));
	});
	const pageSize = axis === "x" ? stage.w : stage.h;
	[0, pageSize / 2, pageSize, SNAP_MARGIN, pageSize - SNAP_MARGIN].forEach((v) => targets.push({ v, owner: null }));

	let best = null; // { d, kind, ... }
	for (const name of anchorNames) {
		for (const t of targets) {
			const d = t.v - m[name];
			if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d) - 1e-9)) best = { d, kind: "align" };
		}
	}

	// ── Spacing: the gap to a neighbour equals a gap that already exists ──
	const gaps = [];
	for (const a of others) {
		for (const b of others) {
			if (a === b || a[A.pos] + a[A.size] > b[A.pos]) continue;
			if (!overlap(a[A.cross], a[A.crossSize], b[A.cross], b[A.crossSize])) continue;
			const g = b[A.pos] - (a[A.pos] + a[A.size]);
			if (g > 1 && g < 600) gaps.push({ g, a, b });
		}
	}
	const wantsStart = anchorNames.includes("start");
	const wantsEnd = anchorNames.includes("end");
	const neighbours = others.filter((k) => overlap(moving[A.cross], moving[A.crossSize], k[A.cross], k[A.crossSize]));
	const spacing = []; // candidates: { d, gap segments }
	for (const k of neighbours) {
		for (const ref of gaps) {
			if (wantsStart) spacing.push({ d: k[A.pos] + k[A.size] + ref.g - m.start, ref, side: "after", k });
			if (wantsEnd) spacing.push({ d: k[A.pos] - ref.g - m.end, ref, side: "before", k });
		}
	}
	// between two items, with equal gaps on both sides (the moving item moves as a whole)
	if (wantsStart && wantsEnd) {
		for (const a of neighbours) {
			for (const b of neighbours) {
				if (a === b || a[A.pos] + a[A.size] > b[A.pos]) continue;
				const room = b[A.pos] - (a[A.pos] + a[A.size]) - moving[A.size];
				if (room < 2) continue;
				spacing.push({ d: a[A.pos] + a[A.size] + room / 2 - m.start, between: [a, b] });
			}
		}
	}
	let bestSpacing = null;
	for (const c of spacing) {
		if (Math.abs(c.d) <= threshold && (!bestSpacing || Math.abs(c.d) < Math.abs(bestSpacing.d) - 1e-9)) bestSpacing = c;
	}

	// Alignment wins a tie; otherwise the closer one does.
	let delta = 0;
	let useSpacing = null;
	if (best && (!bestSpacing || Math.abs(best.d) <= Math.abs(bestSpacing.d) + 1e-9)) delta = best.d;
	else if (bestSpacing) {
		delta = bestSpacing.d;
		useSpacing = bestSpacing;
	}
	return { delta, useSpacing, targets };
}

export function computeSnap({ moving, others, stage, threshold, axes = ["x", "y"], anchors = ["start", "center", "end"] }) {
	const result = { dx: 0, dy: 0, guides: [] };
	const solved = {};
	for (const axis of axes) {
		solved[axis] = snapAxis(axis, moving, others, stage, threshold, anchors);
		if (axis === "x") result.dx = solved[axis].delta;
		else result.dy = solved[axis].delta;
	}
	const snapped = { x: moving.x + result.dx, y: moving.y + result.dy, w: moving.w, h: moving.h };

	for (const axis of axes) {
		const A = AXES[axis];
		const s = solved[axis];
		const lo = (r) => r[A.cross];
		const hi = (r) => r[A.cross] + r[A.crossSize];
		if (s.useSpacing) {
			const c = s.useSpacing;
			const mid = snapped[A.cross] + snapped[A.crossSize] / 2;
			const seg = (from, to, owner) => ({ kind: "gap", axis, cross: owner ? (Math.max(lo(snapped), lo(owner)) + Math.min(hi(snapped), hi(owner))) / 2 : mid, from, to });
			if (c.between) {
				const [a, b] = c.between;
				result.guides.push(seg(a[A.pos] + a[A.size], snapped[A.pos], a), seg(snapped[A.pos] + snapped[A.size], b[A.pos], b));
			} else {
				const { ref, side, k } = c;
				if (side === "after") result.guides.push(seg(k[A.pos] + k[A.size], snapped[A.pos], k));
				else result.guides.push(seg(snapped[A.pos] + snapped[A.size], k[A.pos], k));
				result.guides.push({
					kind: "gap",
					axis,
					cross: (Math.max(lo(ref.a), lo(ref.b)) + Math.min(hi(ref.a), hi(ref.b))) / 2,
					from: ref.a[A.pos] + ref.a[A.size],
					to: ref.b[A.pos]
				});
			}
			continue;
		}
		// Every line the snapped item now shares with something: drawn from item to item.
		const m = { start: snapped[A.pos], center: snapped[A.pos] + snapped[A.size] / 2, end: snapped[A.pos] + snapped[A.size] };
		const seen = new Set();
		for (const name of anchors) {
			for (const t of s.targets) {
				if (Math.abs(t.v - m[name]) > 0.51) continue;
				const key = `${t.v}|${t.owner ? "o" : "p"}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const pageSpan = axis === "x" ? stage.h : stage.w;
				result.guides.push({
					kind: "line",
					axis,
					pos: t.v,
					from: t.owner ? Math.min(lo(snapped), lo(t.owner)) : 0,
					to: t.owner ? Math.max(hi(snapped), hi(t.owner)) : pageSpan
				});
			}
		}
	}
	return result;
}
