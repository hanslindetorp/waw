// Minimal dependency-free waveform rendering (min/max peaks per pixel column
// onto a canvas) — no WaveSurfer or other library, per "vanilla is beautiful".

export async function decodeAudioBuffer(url, audioContext) {
	const response = await fetch(url);
	const arrayBuffer = await response.arrayBuffer();
	return audioContext.decodeAudioData(arrayBuffer);
}

export function drawWaveform(canvas, audioBuffer, color) {
	const ctx = canvas.getContext("2d");
	const width = canvas.width;
	const height = canvas.height;
	ctx.clearRect(0, 0, width, height);

	const data = audioBuffer.getChannelData(0);
	const samplesPerPixel = Math.max(1, Math.floor(data.length / width));
	const mid = height / 2;

	ctx.fillStyle = color;
	for (let x = 0; x < width; x++) {
		const start = x * samplesPerPixel;
		let min = 0;
		let max = 0;
		for (let i = 0; i < samplesPerPixel; i++) {
			const sample = data[start + i];
			if (sample === undefined) break;
			if (sample < min) min = sample;
			if (sample > max) max = sample;
		}
		const y1 = mid + min * mid;
		const y2 = mid + max * mid;
		ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
	}
}
