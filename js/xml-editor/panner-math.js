// Pure geometry/scale helpers for wa-chain-view.js's PannerNode preview card
// (the top-down X/Z "radar" circle + its zoom) — same "keep the math out of
// the DOM-building file" split biquad-math.js/compressor-math.js already use
// for their own canvases. Per Hans (2026-10-04).

// "Nice" round numbers for both the zoom radius itself (the circle's own
// center-to-edge distance, in whatever unit the document's positionX/Y/Z
// values are already in — unitless per Hans, "funkar ungefär som meter")
// and the grid's own unit-per-square size below. A 1-2-5-per-decade
// progression reads more naturally than pure powers of two, and happens to
// already include 10 — the spec'd starting radius.
const NICE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

export const DEFAULT_ZOOM_RADIUS = 5;

// Every square starts at 1 unit; per Hans (2026-10-04): "När rutorna blir
// för små för att se bra ut växlar systemet och visar en ruta för varannat
// värde" — once the *unhalved* grid would need more than this many squares
// across the full diameter, step up to the next NICE_STEPS unit size
// instead (2, then 5, then 10, ...) so the square count stays in a
// comfortable, legible range regardless of how far zoomed out. Matches his
// own worked example almost exactly (radius 30 -> unit 2 -> 30 squares
// across, not 60).
const MAX_SQUARES_ACROSS_DIAMETER = 40;

export function zoomIn(radius) {
	for (let i = NICE_STEPS.length - 1; i >= 0; i--) {
		if (NICE_STEPS[i] < radius) return NICE_STEPS[i];
	}
	return NICE_STEPS[0];
}

export function zoomOut(radius) {
	for (let i = 0; i < NICE_STEPS.length; i++) {
		if (NICE_STEPS[i] > radius) return NICE_STEPS[i];
	}
	return NICE_STEPS[NICE_STEPS.length - 1];
}

// The smallest NICE_STEPS value big enough to keep the full-diameter square
// count under the cap — see MAX_SQUARES_ACROSS_DIAMETER's own comment.
export function gridUnitForRadius(radius) {
	for (const step of NICE_STEPS) {
		if ((2 * radius) / step <= MAX_SQUARES_ACROSS_DIAMETER) return step;
	}
	return NICE_STEPS[NICE_STEPS.length - 1];
}

// The label shown just above the circle's own top edge — per Hans
// (2026-10-04): "siffran ovanför cirkeln ska visa antalet rutor mellan
// centrum och övre kanten", i.e. the square COUNT from center to edge, not
// the raw radius distance itself (the two only coincide while the grid unit
// is still 1). Kept as its own function since "round to the nearest whole
// square" is a real (if usually invisible) approximation once unit doesn't
// divide radius evenly right at a NICE_STEPS boundary.
export function squaresFromCenterToEdge(radius, unit) {
	return Math.round(radius / unit);
}

// Smallest zoom radius that keeps every one of `positions` (each {x, z}, in
// the same unitless document coordinates) within the visible circle, with a
// little headroom so a source doesn't sit exactly on the rim — per Hans
// (2026-10-04): "Inzoomningen på cirkeln sätts initialt till ett värde som
// gör att alla ljudkällor syns." Never goes tighter than DEFAULT_ZOOM_RADIUS
// even for sources near the origin (per Hans, 2026-10-04 follow-up:
// "Initvärdet på zoom ska vara så att positionX och Z går från -10 till
// 10") — only zooms OUT further than that floor when a source genuinely
// needs the room.
export function radiusToFitAll(positions) {
	let maxDist = 0;
	for (const p of positions) {
		const d = Math.hypot(p.x, p.z);
		if (d > maxDist) maxDist = d;
	}
	const withHeadroom = Math.max(maxDist * 1.15, DEFAULT_ZOOM_RADIUS);
	for (const step of NICE_STEPS) {
		if (step >= withHeadroom) return step;
	}
	return NICE_STEPS[NICE_STEPS.length - 1];
}

// World (document positionX/positionZ, "meter-like" units, Z growing away
// from the listener's default forward direction) <-> canvas-pixel
// conversions for a circle of `pxRadius` centered at (cx, cy), currently
// showing `zoomRadius` world-units from center to edge. Per Hans's own
// sketch: worldZ more negative = "up"/away on screen (the default listener
// faces -Z), worldX more positive = right.
export function worldToCanvas(x, z, zoomRadius, cx, cy, pxRadius) {
	const scale = pxRadius / zoomRadius;
	return { px: cx + x * scale, py: cy + z * scale };
}

export function canvasToWorld(px, py, zoomRadius, cx, cy, pxRadius) {
	const scale = pxRadius / zoomRadius;
	return { x: (px - cx) / scale, z: (py - cy) / scale };
}

// Clamps a world-space point to inside (or exactly on) the circle of
// `zoomRadius` — per Hans (2026-10-04): "Den ska gå att flytta runt inom
// cirkeln."
export function clampToRadius(x, z, zoomRadius) {
	const d = Math.hypot(x, z);
	if (d <= zoomRadius || d === 0) return { x, z };
	const t = zoomRadius / d;
	return { x: x * t, z: z * t };
}
