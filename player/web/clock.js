/**
 * The clock. There is exactly one, and it is the audio.
 *
 * Everything the Player draws and everything it judges is a function of the position
 * returned here. Nothing counts frames, and nothing keeps its own idea of how far the
 * song has got: a `requestAnimationFrame` loop that advanced its own timer would agree
 * with the music for about a minute and then quietly stop being a rhythm game.
 *
 * The position is derived, not polled. An `AudioBufferSourceNode` is started at a known
 * point on the context's own clock, so
 *
 *     songTime = anchorSongTime + (ctx.currentTime - anchorCtxTime) * rate
 *
 * is exact between frames, survives a dropped frame, and stays right at any playback
 * rate. `HTMLAudioElement.currentTime` would have been simpler and is quantised to
 * something like a frame, which is a quarter of a Perfect window.
 *
 * The cost of this is that the whole file is decoded into memory before play starts. For
 * a three-minute song that is tens of megabytes and a few seconds of waiting, which is a
 * fair price for a clock that does not drift.
 */

const SCHEDULE_AHEAD_SEC = 0.06;

export function createAudioClock() {
  const context = new (window.AudioContext ?? window.webkitAudioContext)();
  const master = context.createGain();
  master.connect(context.destination);

  let buffer = null;
  let source = null;
  let anchorCtx = 0;
  let anchorSong = 0;
  let playing = false;
  let rate = 1;
  let pausedAt = 0;
  let onEnded = null;

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped: nothing to do.
    }
    source.disconnect();
    source = null;
  }

  function positionNow() {
    if (!playing) return pausedAt;
    const elapsed = context.currentTime - anchorCtx;
    if (elapsed <= 0) return anchorSong;
    return anchorSong + elapsed * rate;
  }

  function startAt(fromSec) {
    if (!buffer) return;
    stopSource();
    const clamped = Math.min(buffer.duration, Math.max(0, fromSec));
    source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(master);
    const when = context.currentTime + SCHEDULE_AHEAD_SEC;
    source.start(when, clamped);
    anchorCtx = when;
    anchorSong = clamped;
    playing = true;
    source.onended = () => {
      // Only a natural end reaches here; a stop for a seek clears the handler first.
      playing = false;
      pausedAt = buffer.duration;
      source = null;
      if (onEnded) onEnded();
    };
  }

  return {
    get context() {
      return context;
    },
    get duration() {
      return buffer ? buffer.duration : 0;
    },
    get isPlaying() {
      return playing;
    },
    get rate() {
      return rate;
    },

    /** Decode a whole file. `onStage` reports which slow part is happening. */
    async load(url, onStage = () => {}) {
      onStage("fetching");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`audio request failed: ${response.status} ${response.statusText}`);
      const bytes = await response.arrayBuffer();
      onStage("decoding");
      buffer = await context.decodeAudioData(bytes);
      pausedAt = 0;
      onStage("ready");
      return buffer.duration;
    },

    /** Seconds into the audio, right now. Between frames this keeps moving. */
    now: positionNow,

    async play(fromSec = null) {
      if (!buffer) return;
      // Browsers start a context suspended until a gesture; every caller here is one.
      if (context.state === "suspended") await context.resume();
      const from = fromSec === null ? pausedAt : fromSec;
      if (from >= buffer.duration) return;
      startAt(from);
    },

    pause() {
      if (!playing) return;
      pausedAt = Math.min(buffer ? buffer.duration : 0, Math.max(0, positionNow()));
      stopSource();
      playing = false;
    },

    /** Move the playhead, keeping whatever the transport was doing. */
    seek(toSec) {
      const clamped = Math.min(buffer ? buffer.duration : 0, Math.max(0, toSec));
      if (playing) startAt(clamped);
      else pausedAt = clamped;
      return clamped;
    },

    /**
     * Change speed.
     *
     * The position is re-anchored at the current instant first, so the seconds already
     * played keep the rate they were played at. Changing `playbackRate` without doing
     * that would retroactively rescale the whole song.
     */
    setRate(value) {
      const next = Math.min(4, Math.max(0.05, value));
      if (playing) {
        const at = positionNow();
        rate = next;
        startAt(at);
      } else {
        rate = next;
      }
    },

    setVolume(value) {
      master.gain.value = Math.min(1, Math.max(0, value));
    },

    onEnded(handler) {
      onEnded = handler;
    },

    close() {
      stopSource();
      void context.close();
    },
  };
}

/**
 * The click that marks a hit.
 *
 * Synthesised rather than shipped, for the same reason the Editor does it: a few
 * milliseconds of tone costs nothing to generate and keeps the repository free of binary
 * assets. Its gain is separate from the music's, because checking a chart is done with
 * the song turned down and the clicks left audible.
 */
export function createHitSound(context) {
  const master = context.createGain();
  master.gain.value = 0.35;
  master.connect(context.destination);

  const VOICES = {
    tap: { frequency: 1400, decaySec: 0.045, level: 1 },
    flick: { frequency: 1900, decaySec: 0.05, level: 0.95 },
    "flick-end": { frequency: 1900, decaySec: 0.05, level: 0.95 },
    "hold-start": { frequency: 1100, decaySec: 0.06, level: 1 },
    waypoint: { frequency: 1250, decaySec: 0.03, level: 0.6 },
    release: { frequency: 900, decaySec: 0.05, level: 0.8 },
  };

  return {
    play(kind) {
      const shape = VOICES[kind] ?? VOICES.tap;
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = shape.frequency;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(shape.level, now + 0.001);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + shape.decaySec);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(now);
      oscillator.stop(now + shape.decaySec + 0.01);
      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
      };
    },
    setGain(value) {
      master.gain.value = Math.min(1, Math.max(0, value));
    },
  };
}
