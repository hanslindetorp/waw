import { createLandmarker } from "./mediapipe.js";
import { createTable, setFrame } from "./landmark-table.js";

// Runs one of MediaPipe's trackers (hand / body / face) over a whole video file and
// keeps every point of every picture in a landmark table (landmark-table.js).
//
// The cost of a pass is the tracker running on each picture, however many of its points
// are wanted later — so a pass is made per model and keeps ALL of that model's points;
// any row that needs some of them then reads them from the table at no cost.
//
// Pictures are taken by stepping the video to each time with a seek (frame-accurate,
// unlike playing it faster) and the tracker is given them in order (VIDEO mode follows the
// subject from picture to picture, which is steadier and quicker than finding it anew).
// Each seek hands control back to the browser, so the page stays usable meanwhile.

// The rates (pictures per second) a pass can be made at; a slower one is quicker, and
// the values between pictures are interpolated when a row reads them.
export const ANALYSIS_RATES = [
	{ value: 30, label: "30 per second" },
	{ value: 15, label: "15 per second (faster)" },
	{ value: 10, label: "10 per second (fastest)" }
];

function once(el, type) {
	return new Promise((resolve, reject) => {
		const ok = () => {
			el.removeEventListener("error", bad);
			resolve();
		};
		const bad = () => {
			el.removeEventListener(type, ok);
			reject(new Error("The video could not be read"));
		};
		el.addEventListener(type, ok, { once: true });
		el.addEventListener("error", bad, { once: true });
	});
}

// A video recorded in the browser (MediaRecorder's webm) has no length in its header and
// reports Infinity until it has been played to the end; seeking far past the end makes the
// browser find it. After this the video's duration is a number.
export async function ensureDuration(video) {
	if (video.readyState < 1) await once(video, "loadedmetadata");
	if (Number.isFinite(video.duration)) return;
	const done = once(video, "durationchange");
	video.currentTime = 1e101;
	await done;
	await seek(video, 0);
}

async function seek(video, t) {
	if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return;
	const done = once(video, "seeked");
	video.currentTime = t;
	await done;
}

// A tracker's result as { label: { x, y, z } } for the table. Hands are named by the
// person's own side: MediaPipe assumes a mirrored picture and the video is not, so its
// "Left" is the person's right hand — the same swap the live camera does.
function pointsOf(model, result) {
	const points = {};
	if (model === "hands") {
		const sides = result.handednesses || result.handedness || [];
		(result.landmarks || []).forEach((hand, h) => {
			const raw = sides[h]?.[0]?.categoryName;
			const side = raw === "Left" ? "rightHand" : raw === "Right" ? "leftHand" : null;
			if (!side) return;
			hand.forEach((lm, i) => (points[`${side}${i}`] = { x: lm.x, y: lm.y, z: lm.z ?? 0 }));
		});
	} else {
		const list = model === "pose" ? result.landmarks?.[0] : result.faceLandmarks?.[0];
		(list || []).forEach((lm, i) => (points[`${model}${i}`] = { x: lm.x, y: lm.y, z: lm.z ?? 0 }));
	}
	return points;
}

// analyzeVideo({ url, model, fps, onProgress, signal }) → { table, duration, width, height, fps }
//   url         a playable address of the video (a blob: URL of a project file)
//   model       "hands" | "pose" | "face"
//   fps         pictures per second to take (never more than there are)
//   onProgress  (0–1) after each picture
//   signal      an AbortSignal; aborting rejects with an AbortError
export async function analyzeVideo({ url, model, fps = 30, onProgress, signal }) {
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	video.src = url;
	let landmarker = null;
	try {
		await ensureDuration(video);
		const duration = video.duration;
		if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("The video has no length");
		if (video.readyState < 2) await once(video, "loadeddata");
		landmarker = await createLandmarker(model);
		const step = 1 / fps;
		const frames = Math.max(1, Math.floor(duration / step + 1e-6) + 1);
		const times = Float64Array.from({ length: frames }, (_, i) => Math.min(i * step, Math.max(0, duration - 0.001)));
		const table = createTable(model, times);
		let last = -1;
		for (let f = 0; f < frames; f++) {
			if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
			await seek(video, times[f]);
			let ts = Math.round(times[f] * 1000);
			if (ts <= last) ts = last + 1;
			last = ts;
			setFrame(table, f, pointsOf(model, landmarker.detectForVideo(video, ts)));
			onProgress?.((f + 1) / frames);
		}
		return { table, duration, width: video.videoWidth, height: video.videoHeight, fps };
	} finally {
		landmarker?.close?.();
		video.removeAttribute("src");
		video.load();
	}
}
