// A small copy of what is being dragged, to follow the pointer — instead of the
// browser's default (a faint snapshot of the little handle that was grabbed).
// Per Hans (2026-10-17): dragging a card from the Preview to the Stage should
// carry a small copy of the card.
//
// The copy is a deep clone of `source`, placed (off screen) in the same root as
// the source — a shadow root keeps its styles that way — scaled down with CSS
// `zoom`, handed to setDragImage(), and removed again once the browser has
// taken its snapshot. A canvas is not copied by cloning, so its pixels are drawn
// over to the clone's canvas.
export function setCardDragImage(dataTransfer, source, scale = 0.6) {
	if (!dataTransfer?.setDragImage || !source) return;
	const root = source.getRootNode();
	const host = root instanceof ShadowRoot || root instanceof Document ? root : document;
	const holder = document.createElement("div");
	holder.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none;opacity:0.92;";
	const width = source.getBoundingClientRect().width;
	const copy = source.cloneNode(true);
	copy.style.width = `${width}px`;
	copy.style.zoom = String(scale);
	copy.classList.remove("selected", "dragging");
	const from = source.querySelectorAll("canvas");
	copy.querySelectorAll("canvas").forEach((canvas, i) => {
		try {
			canvas.getContext("2d").drawImage(from[i], 0, 0);
		} catch {
			// a canvas that can't be read just stays empty in the picture
		}
	});
	holder.appendChild(copy);
	(host.body || host).appendChild(holder);
	try {
		dataTransfer.setDragImage(holder, 12, 12);
	} finally {
		setTimeout(() => holder.remove(), 0);
	}
}
