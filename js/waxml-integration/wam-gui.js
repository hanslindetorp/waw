import { playerStore } from "./player-store.js";
import { xmlStore } from "../xml-editor/xml-store.js";

// Mounts a live <Wam> node's own plugin interface into `container`, and
// writes the plugin's parameter changes back into the XML as
// <Parameter name="..." value="..."/> children — per
// wam-insert-effects-instructions.md points 6-7.
//
// Best-effort by design: waxml.js's own WAM support was still mid-flight
// when this was written (see the code comments below for the specifics) —
// a plugin that hasn't finished loading, doesn't implement a GUI, or fires
// automation events in an unexpected shape just shows a status message
// rather than throwing.
//
// Returns a dispose() function — call it when the view goes away (removes
// the mounted GUI and every listener this attached).
export function mountWamGui(nodeId, container) {
	let disposed = false;
	let automationTarget = null;
	let onAutomation = null;
	let mountedLiveObj = null; // the instance we've actually mounted a GUI for, so a later reload's "change" doesn't remount for no reason
	let pollTimer = null;

	container.textContent = "";
	const status = document.createElement("p");
	status.className = "wam-gui-status";
	status.textContent = "Loading plugin…";
	container.appendChild(status);

	const onPlayerStoreChange = () => tryMount();
	playerStore.addEventListener("change", onPlayerStoreChange);

	tryMount();

	// player-store.js's own "change" event fires as soon as updateFromString()
	// resolves — but waxml.js's WAM init (dynamic import, createInstance,
	// getParameterInfo) is a slower, *unawaited* tail that keeps running well
	// after that, per Hans's own initWAMsWhenAllAreLoaded() (fire-and-forget,
	// not part of the promise chain player-store.js awaits). Nothing
	// broadcasts a "the plugin instance just became ready" event, so a
	// gentle poll is the only reliable way to notice it — cheap (a property
	// check, no network), and cleared the moment we're actually mounted.
	function startPolling() {
		if (pollTimer || disposed) return;
		pollTimer = setInterval(tryMount, 400);
	}
	function stopPolling() {
		clearInterval(pollTimer);
		pollTimer = null;
	}

	function tryMount() {
		if (disposed) return;
		if (!playerStore.isDocumentLoaded) {
			status.textContent = "Waiting for the project to load…";
			return;
		}

		let liveObj;
		try {
			const matches = playerStore.getLiveObjects(`[id='${nodeId}']`);
			liveObj = matches && matches[0];
		} catch {
			liveObj = null;
		}

		// this.instance is the raw WAM SDK plugin instance (see waxml.js's WAM
		// class) — createGui() is the standard WAM v2 API for a fresh, synced
		// view of the plugin (safe to call more than once per instance; a
		// second Preview/stacked-inserts view calling this again just gets its
		// own independent GUI element, same live parameters underneath).
		if (!liveObj?.instance?.createGui) {
			status.textContent = "This plugin hasn't finished loading yet.";
			mountedLiveObj = null;
			startPolling();
			return;
		}

		if (liveObj === mountedLiveObj) return; // already mounted for this exact instance — nothing to do
		stopPolling();

		ensureParametersDeclared(nodeId, liveObj)
			.then(() => liveObj.instance.createGui())
			.then((guiEl) => {
				if (disposed) return;
				container.textContent = "";
				container.appendChild(guiEl);
				mountedLiveObj = liveObj;
				wireAutomation(liveObj);
			})
			.catch((err) => {
				if (disposed) return;
				console.error(`WAM "${nodeId}" createGui() failed:`, err);
				status.textContent = "This plugin doesn't provide a usable interface.";
			});
	}

	// The WAM extensions spec's standard automation event — dispatched on
	// audioNode whenever the plugin's own GUI (or host automation) changes a
	// parameter. waxml.js doesn't read <Parameter> children back into the
	// live graph yet (Hans is adding that support separately), but writing
	// them here keeps the XML an accurate record of the plugin's state
	// regardless — and picks it up "for free" once that support lands.
	function wireAutomation(liveObj) {
		const audioNode = liveObj?.instance?.audioNode;
		if (!audioNode || typeof audioNode.addEventListener !== "function") return;
		automationTarget = audioNode;
		onAutomation = (e) => {
			const data = e.detail?.data ?? e.detail ?? {};
			const paramId = data.id ?? data.paramId;
			const value = data.value ?? data.normalized;
			if (paramId === undefined || value === undefined) return;
			writeParameter(nodeId, paramId, value);
		};
		audioNode.addEventListener("wam-automation", onAutomation);
	}

	return function dispose() {
		disposed = true;
		stopPolling();
		playerStore.removeEventListener("change", onPlayerStoreChange);
		if (automationTarget && onAutomation) automationTarget.removeEventListener("wam-automation", onAutomation);
		container.textContent = "";
	};
}

// nodeId here is the XML `id` *attribute* (mountWamGui's own param — see its
// note above), not this app's internal tree id, so the lookup has to walk
// the tree matching attributes.id rather than using ops.findNodeById (which
// expects the internal id and would silently find nothing).
function findNodeByAttributeId(node, targetId) {
	if (!node) return null;
	if (node.attributes.id === targetId) return node;
	for (const child of node.children) {
		const found = findNodeByAttributeId(child, targetId);
		if (found) return found;
	}
	return null;
}

// Writing a brand-new <Parameter> child is a *structural* xmlStore edit —
// per Hans, that's exactly the moment player-store.js tears down and rebuilds
// the whole live audio graph (see its proactive-reload architecture), which
// would otherwise happen on literally the first touch of every single knob,
// killing the very plugin instance/GUI the user is mid-drag on. Instead,
// every parameter this plugin declares gets its <Parameter> child written
// once, up front, with the plugin's own default value, right as its instance
// becomes ready — before the user could possibly have touched anything yet.
// That's still one structural rebuild, but it happens automatically at
// load time rather than disruptively mid-interaction, and it means every
// *real* writeParameter() call from here on only ever hits the
// updateAttributes branch below (non-structural, no rebuild, immediate).
async function ensureParametersDeclared(nodeId, liveObj) {
	const wamNode = findNodeByAttributeId(xmlStore.root, nodeId);
	if (!wamNode || wamNode.children.some((c) => c.tagName === "Parameter")) return;

	let info;
	try {
		info = await liveObj.instance.audioNode.getParameterInfo();
	} catch {
		return; // a plugin without getParameterInfo() just skips pre-declaration — writeParameter's own insertNewChild fallback still covers it
	}
	const params = Object.values(info || {});
	if (params.length === 0) return;

	// Re-check after the await — the node could have been deleted, or (in a
	// race with another view mounting the same Wam) already declared, while
	// getParameterInfo() was pending.
	const wamNodeNow = findNodeByAttributeId(xmlStore.root, nodeId);
	if (!wamNodeNow || wamNodeNow.children.some((c) => c.tagName === "Parameter")) return;

	// insertNewChild moves selection to whatever it just created — harmless
	// for a single user-driven "+", but looping it here would leave selection
	// on the *last* declared parameter instead of wherever it actually was
	// (e.g. the <Wam> node this view is mounting for). Restore once at the end
	// rather than after each insert.
	const preservedSelection = xmlStore.selectedNodeId;
	params.forEach((param) => {
		xmlStore.insertNewChild(wamNodeNow.id, "Parameter", { name: param.id, value: String(param.defaultValue ?? 0) });
	});
	xmlStore.selectNode(preservedSelection);
}

function writeParameter(wamNodeId, paramId, value) {
	const wamNode = findNodeByAttributeId(xmlStore.root, wamNodeId);
	if (!wamNode) return;
	const valueStr = String(value);
	const existing = wamNode.children.find((c) => c.tagName === "Parameter" && c.attributes.name === paramId);
	if (existing) {
		if (existing.attributes.value !== valueStr) xmlStore.updateAttributes(existing.id, { ...existing.attributes, value: valueStr });
		return;
	}
	// insertNewChild always moves selection to the node it just created —
	// fine for a user clicking "+", but this fires from a background
	// automation event, so silently yanking the user's current XML-editor/
	// Preview selection over to the new <Parameter> the moment they touch a
	// knob would be a surprising side effect. Restore it right after.
	const preservedSelection = xmlStore.selectedNodeId;
	xmlStore.insertNewChild(wamNode.id, "Parameter", { name: paramId, value: valueStr });
	xmlStore.selectNode(preservedSelection);
}
