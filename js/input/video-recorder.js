import { MAX_RECORDING_BYTES } from "./video-files.js";

// Records a camera stream to a video file in the browser (MediaRecorder). The recording is the
// camera's own, unmirrored picture — the way a video file is read and analysed (see
// video-analysis.js) — and has sound when the stream given has an audio track (the camera
// itself is opened without; the recorder's caller adds the microphone when it is asked for).

const PICTURE_TYPES = [
	["video/mp4;codecs=avc1", ".mp4"],
	["video/mp4", ".mp4"],
	["video/webm;codecs=vp9", ".webm"],
	["video/webm;codecs=vp8", ".webm"],
	["video/webm", ".webm"]
];

const SOUND_TYPES = [
	["video/mp4;codecs=avc1,mp4a.40.2", ".mp4"],
	["video/mp4", ".mp4"],
	["video/webm;codecs=vp9,opus", ".webm"],
	["video/webm;codecs=vp8,opus", ".webm"],
	["video/webm", ".webm"]
];

// MP4 where the browser can (it plays everywhere and has a length in its header), else WebM.
export function pickFormat(withSound = false) {
	if (typeof MediaRecorder === "undefined") return null;
	const hit = (withSound ? SOUND_TYPES : PICTURE_TYPES).find(([type]) => MediaRecorder.isTypeSupported(type));
	return hit ? { mimeType: hit[0], extension: hit[1] } : null;
}

export function recordingName(date = new Date(), extension = ".webm") {
	const p = (n) => String(n).padStart(2, "0");
	return `recording-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${extension}`;
}

// startRecording(stream, { onProgress({ bytes, seconds }), onStop(result) }) → { stop() }
// `result`: { file: File, bytes, seconds, limited: true when it stopped at the size limit, sound }, or
// { error } when nothing could be recorded. A recording that is stopped by its stream ending
// (the camera is switched off) is saved as far as it got.
export function startRecording(stream, { onProgress, onStop } = {}) {
	const sound = stream.getAudioTracks().length > 0;
	const format = pickFormat(sound);
	if (!format) {
		onStop?.({ error: "This browser cannot record video." });
		return { stop() {} };
	}
	const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: 2_500_000, ...(sound ? { audioBitsPerSecond: 128_000 } : {}) });
	const chunks = [];
	let bytes = 0;
	let limited = false;
	const started = performance.now();
	recorder.ondataavailable = (e) => {
		if (!e.data?.size) return;
		chunks.push(e.data);
		bytes += e.data.size;
		onProgress?.({ bytes, seconds: (performance.now() - started) / 1000 });
		if (bytes >= MAX_RECORDING_BYTES && recorder.state === "recording") {
			limited = true;
			recorder.stop();
		}
	};
	recorder.onerror = (e) => onStop?.({ error: e.error?.message || "The recording failed." });
	recorder.onstop = () => {
		const seconds = (performance.now() - started) / 1000;
		if (!bytes) {
			onStop?.({ error: "Nothing was recorded." });
			return;
		}
		const type = format.mimeType.split(";")[0];
		onStop?.({ file: new File(chunks, recordingName(new Date(), format.extension), { type }), bytes, seconds, limited, sound });
	};
	recorder.start(1000);
	return {
		stop() {
			if (recorder.state === "recording") recorder.stop();
		}
	};
}
