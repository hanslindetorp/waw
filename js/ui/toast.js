// Minimal, dependency-free notice/warning toast — appended straight to
// document.body rather than any one component's shadow root, since this is
// an app-wide concern (e.g. a schema-invalid paste, see xml-store.js's
// pasteIntoSelection) that isn't scoped to a single panel. No existing
// toast/banner mechanism exists elsewhere in this app (console.warn is used
// for background-only issues; native alert()/confirm() are deliberately
// avoided everywhere, e.g. wa-file-menu.js's own inline confirm view).

let container = null;

function ensureContainer() {
	if (container && container.isConnected) return container;
	container = document.createElement("div");
	container.style.cssText = `
		position: fixed;
		top: 1rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 10000;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
		pointer-events: none;
	`;
	document.body.appendChild(container);
	return container;
}

export function showToast(message, { kind = "warning", durationMs = 4000 } = {}) {
	const el = document.createElement("div");
	el.textContent = message;
	const bg = kind === "warning" ? "#e5484d" : "#2a2a2a";
	el.style.cssText = `
		background: ${bg};
		color: #fff;
		font: 0.85rem/1.4 system-ui, sans-serif;
		padding: 0.5rem 0.9rem;
		border-radius: 6px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
		max-width: 28rem;
		text-align: center;
	`;
	ensureContainer().appendChild(el);
	setTimeout(() => el.remove(), durationMs);
}
