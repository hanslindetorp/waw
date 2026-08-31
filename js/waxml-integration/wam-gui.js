import { playerStore } from "./player-store.js";
import { xmlStore } from "../xml-editor/xml-store.js";
import * as ops from "../xml-editor/xml-tree-ops.js";

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

	container.textContent = "";
	const status = document.createElement("p");
	status.className = "wam-gui-status";
	status.textContent = "Loading plugin…";
	container.appendChild(status);

	const onPlayerStoreChange = () => tryMount();
	playerStore.addEventListener("change", onPlayerStoreChange);

	tryMount();

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
			return;
		}

		liveObj.instance
			.createGui()
			.then((guiEl) => {
				if (disposed) return;
				container.textContent = "";
				container.appendChild(guiEl);
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
		playerStore.removeEventListener("change", onPlayerStoreChange);
		if (automationTarget && onAutomation) automationTarget.removeEventListener("wam-automation", onAutomation);
		container.textContent = "";
	};
}

function writeParameter(wamNodeId, paramId, value) {
	const wamNode = ops.findNodeById(xmlStore.root, wamNodeId);
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
