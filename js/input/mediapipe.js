// MediaPipe's hand / body / face trackers, loaded from a CDN the first time one is
// needed (no backend, nothing bundled). Shared by the live camera
// (wa-webcam-input.js) and the analysis of a video file (video-analysis.js), so they
// always run the same version and the same models.

export const MEDIAPIPE_VERSION = "0.10.35";
export const VISION_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
export const WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const MODEL_URLS = {
	hands: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
	pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
	face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"
};

// The models by the name a user sees (see wa-webcam-input.js's MODEL_CHOICES).
export const MODEL_LABELS = { hands: "hand", pose: "body", face: "face" };

let visionPromise = null;

// { module, vision } — the module's classes and the resolved wasm fileset.
export function loadVision() {
	if (!visionPromise) {
		visionPromise = (async () => {
			const module = await import(/* webpackIgnore: true */ VISION_BUNDLE_URL);
			const vision = await module.FilesetResolver.forVisionTasks(WASM_PATH);
			return { module, vision };
		})().catch((err) => {
			visionPromise = null;
			throw err;
		});
	}
	return visionPromise;
}

// A tracker for `name` ("hands" | "pose" | "face") in VIDEO mode (it follows a
// subject from picture to picture, which is steadier and quicker than detecting
// anew). The GPU is tried first, the CPU if that fails.
export async function createLandmarker(name, { delegate = "GPU" } = {}) {
	const { module, vision } = await loadVision();
	const { HandLandmarker, PoseLandmarker, FaceLandmarker } = module;
	const make = (delegateName) => {
		const options = (extra) => ({ baseOptions: { modelAssetPath: MODEL_URLS[name], delegate: delegateName }, runningMode: "VIDEO", ...extra });
		return name === "hands"
			? HandLandmarker.createFromOptions(vision, options({ numHands: 2 }))
			: name === "pose"
				? PoseLandmarker.createFromOptions(vision, options({ numPoses: 1 }))
				: FaceLandmarker.createFromOptions(vision, options({ numFaces: 1 }));
	};
	try {
		return await make(delegate);
	} catch (err) {
		if (delegate === "CPU") throw err;
		return make("CPU");
	}
}
