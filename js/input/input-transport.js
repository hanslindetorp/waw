// The one clock of the INPUT panel's time-based inputs (today the data rows,
// soon a video): play, stop, a position in seconds and a length in seconds,
// shared by everything that runs along a time line. Nothing here knows about
// the data — a source listens to "tick" and reads `position` (or `fraction`).
//
// A video is meant to take this over without anything else changing: while a
// timebase is set (setTimebase), the length and the position come from it and
// play / stop / seek are passed on to it, so the data and the picture can never
// drift apart. A timebase is any object with
//   duration, currentTime (settable), playing, play(), pause().
//
// The speed: `rate` (0.5–2, 1 is normal) makes the clock run faster or slower — a file takes
// duration / rate seconds to play, and a video's own playbackRate is set to match (so the
// picture, its sound and the data stay together). `position` and `duration` are in the
// file's own seconds; effectivePosition / effectiveDuration are what a listener experiences
// at the chosen speed.
//
// Events (CustomEvent on this object):
//   "tick"   — the position changed (while playing, and after every seek);
//   "state"  — playing, duration, loop or the timebase changed.

const DEFAULT_DURATION = 10; // seconds
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

class InputTransport extends EventTarget {
	constructor() {
		super();
		this._duration = DEFAULT_DURATION;
		this._position = 0;
		this._playing = false;
		this._loop = true;
		this._rate = 1;
		this._timebase = null;
		this._users = new Set(); // the sections that have something to play (see use())
		this._raf = null;
		this._last = 0;
		this._frame = this._frame.bind(this);
	}

	get duration() {
		return this._timebase ? this._timebase.duration || 0 : this._duration;
	}

	get position() {
		return this._timebase ? this._timebase.currentTime || 0 : this._position;
	}

	// 0–1 of the length.
	get fraction() {
		const d = this.duration;
		return d > 0 ? Math.min(1, Math.max(0, this.position / d)) : 0;
	}

	get playing() {
		return this._timebase ? !!this._timebase.playing : this._playing;
	}

	get loop() {
		return this._loop;
	}

	get rate() {
		return this._rate;
	}

	// How long the whole file takes to play at the chosen speed, and how far into that we are.
	get effectiveDuration() {
		return this.duration / this._rate;
	}

	get effectivePosition() {
		return this.position / this._rate;
	}

	get hasTimebase() {
		return !!this._timebase;
	}

	// Whether any section has something time-based to play; the transport bar is
	// shown while one does.
	get inUse() {
		return this._users.size > 0;
	}

	use(key) {
		if (this._users.has(key)) return;
		this._users.add(key);
		this._emit("state");
	}

	release(key) {
		if (this._users.delete(key)) {
			if (!this._users.size) this.stop();
			this._emit("state");
		}
	}

	setDuration(seconds) {
		const s = Number(seconds);
		if (!(s > 0) || this._timebase) return;
		this._duration = s;
		this._position = Math.min(this._position, s);
		this._emit("state");
		this._emit("tick");
	}

	setRate(rate) {
		const r = Math.min(MAX_RATE, Math.max(MIN_RATE, Number(rate) || 1));
		if (r === this._rate) return;
		this._rate = r;
		if (this._timebase) this._timebase.playbackRate = r;
		this._emit("state");
	}

	setLoop(on) {
		this._loop = !!on;
		this._emit("state");
	}

	play() {
		if (this.playing) return;
		if (this._timebase) {
			this._timebase.play();
		} else {
			if (this._position >= this._duration) this._position = 0;
			this._playing = true;
		}
		this._start();
		this._emit("state");
	}

	pause() {
		if (!this.playing) return;
		if (this._timebase) this._timebase.pause();
		else this._playing = false;
		this._emit("state");
	}

	toggle() {
		if (this.playing) this.pause();
		else this.play();
	}

	// Stops and goes back to the start.
	stop() {
		if (this._timebase) {
			this._timebase.pause();
			this._timebase.currentTime = 0;
		} else {
			this._playing = false;
			this._position = 0;
		}
		this._emit("state");
		this._emit("tick");
	}

	seek(seconds) {
		const t = Math.min(this.duration, Math.max(0, Number(seconds) || 0));
		if (this._timebase) this._timebase.currentTime = t;
		else this._position = t;
		this._emit("tick");
	}

	seekFraction(fraction) {
		this.seek(fraction * this.duration);
	}

	// A video (or anything with a time) takes over the clock; null gives it back.
	setTimebase(timebase) {
		this._timebase = timebase || null;
		if (this._timebase) {
			this._timebase.playbackRate = this._rate;
			this._playing = false;
			this._start();
		}
		this._emit("state");
		this._emit("tick");
	}

	_start() {
		if (this._raf !== null) return;
		this._last = performance.now();
		this._raf = requestAnimationFrame(this._frame);
	}

	_frame(now) {
		this._raf = null;
		if (!this.playing && !this._timebase) return;
		if (!this._timebase) {
			this._position += ((now - this._last) / 1000) * this._rate;
			if (this._position >= this._duration) {
				if (this._loop) {
					this._position %= this._duration;
				} else {
					this._position = this._duration;
					this._playing = false;
					this._emit("state");
				}
			}
		}
		this._last = now;
		this._emit("tick");
		// A timebase keeps the loop running so a scrub done in the video itself is seen.
		if (this.playing || this._timebase) this._raf = requestAnimationFrame(this._frame);
	}

	_emit(type) {
		this.dispatchEvent(new CustomEvent(type));
	}
}

export const inputTransport = new InputTransport();
