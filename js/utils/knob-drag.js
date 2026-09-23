// Shared two-directional drag-to-adjust interaction for every rotary knob
// in WAW (wa-var-knobs.js, wa-mixer-view.js, wa-chain-view.js, ...) — moving
// the pointer UP or RIGHT increases the value, DOWN or LEFT decreases it,
// both axes contributing to the same delta. First built for wa-var-knobs.js
// (2026-09) so a drag that runs out of vertical screen room can just
// continue diagonally/horizontally instead of getting stuck; per Hans
// (2026-09-28) every other knob in the app should behave identically, and
// any future knob should get this for free rather than re-implementing its
// own vertical-only drag — hence pulling it out to one shared place instead
// of copy-pasting it per component.

export const DEFAULT_KNOB_PX_PER_RANGE = 150; // dragging this many px sweeps a knob's full range
const DRAG_THRESHOLD_PX = 2; // below this, pointerup is treated as a plain click (see onClick)

// options:
//   getStartValue() - returns the value to start dragging from (called once, on pointerdown)
//   min, max        - the value's range
//   onChange(value) - called on every drag tick (and on a defaultValue double-click) with the live value
//   onCommit(value) - optional, called once when a drag ends (not on every tick, not on a plain click)
//   onClick()       - optional, called on pointerup when the pointer never moved past the drag threshold
//   defaultValue    - optional; when finite, double-click resets straight to it (calls onChange then onCommit)
//   pxPerRange      - optional, defaults to DEFAULT_KNOB_PX_PER_RANGE; smaller knobs may want a shorter throw
export function wireKnobDrag(el, { getStartValue, min, max, onChange, onCommit, onClick, defaultValue, pxPerRange = DEFAULT_KNOB_PX_PER_RANGE }) {
	el.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startY = e.clientY;
		const startValue = getStartValue();
		let dragging = false;
		let committed = startValue;
		try {
			el.setPointerCapture(e.pointerId);
		} catch {}

		const onMove = (moveEvt) => {
			const deltaPx = startY - moveEvt.clientY + (moveEvt.clientX - startX);
			if (!dragging && Math.abs(deltaPx) < DRAG_THRESHOLD_PX) return;
			dragging = true;
			const raw = startValue + (deltaPx / pxPerRange) * (max - min);
			committed = Math.max(min, Math.min(max, raw));
			onChange(committed);
		};
		const onUp = () => {
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			if (dragging) {
				if (onCommit) onCommit(committed);
			} else if (onClick) {
				onClick();
			}
		};
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
	});

	if (defaultValue !== undefined && Number.isFinite(defaultValue)) {
		el.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			const clamped = Math.max(min, Math.min(max, defaultValue));
			onChange(clamped);
			if (onCommit) onCommit(clamped);
		});
	}
}
