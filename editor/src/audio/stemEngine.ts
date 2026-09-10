/**
 * Playing separated stems in step with the transport that already exists.
 *
 * The Editor's clock is, and stays, the `<audio>` element streaming the original
 * recording. Nothing here starts a second one. This engine is told where that element
 * has got to and simply keeps its own sources lined up with it, so every existing
 * feature - the playhead, Follow, the note clicks, seeking, the rate menu - goes on
 * reading exactly the same clock it always read.
 *
 * ## Why Web Audio rather than more media elements
 *
 * The obvious cheap version is an `<audio>` element per stem, each seeked to the
 * transport's position. It was rejected. Each element decodes and resamples on its own
 * timer, so several of them wander apart by tens of milliseconds - and these are not
 * independent tracks, they are one performance cut into parts. Two parts of one
 * performance a few tens of milliseconds apart is a flam on every drum hit and a smeared
 * attack on every bass note, which is precisely the thing an author is trying to read.
 *
 * Sources scheduled on one `AudioContext` share a single sample clock, so any number of
 * stems started together stay sample-locked to each other forever. The only drift left is
 * between that clock and the element's, and that is corrected here, once, in one place.
 *
 * ## What it costs, and what is done about it
 *
 * Web Audio needs whole decoded buffers, and `decodeAudioData` resamples to **the
 * context's** rate rather than the file's. That is the trap: measured on a machine whose
 * sound device runs at 192 kHz, one 201-second stereo stem decoded to 294 MB - four of
 * them would have been 1.2 GB, for audio whose source files are 44.1 kHz. So the context
 * is asked for `DECODE_RATE_HZ` instead of the device's rate, which brings the same stem
 * to 74 MB and its decode from 1.8 s to 0.6 s, and costs nothing anyone can hear.
 *
 * On top of that, a stem is fetched and decoded **only when it is first actually listened
 * to**, never on opening a project, so a project whose author never opens the mixer pays
 * nothing at all. Decoded buffers are then kept, because re-decoding on every Solo toggle
 * would stall for that long each time; they are all released when the project changes.
 *
 * ## The one thing it cannot do
 *
 * `AudioBufferSourceNode.playbackRate` resamples, so at 0.5x a stem plays an octave down,
 * where the `<audio>` element time-stretches and holds its pitch. Matching it would mean
 * writing a time-stretcher. It is left as varispeed and said out loud in the panel,
 * because the alternative - giving each stem its own media element to get `preservesPitch`
 * - is exactly the design rejected above, and losing stem alignment to gain pitch would be
 * a bad trade for a tool whose whole purpose is reading rhythm.
 */

import type { StemAvailability } from "../core/stemMixer";

/** Where the transport is. Read from the element; never written by anything here. */
export interface TransportSnapshot {
  readonly timeSec: number;
  readonly playing: boolean;
  /** The element's `playbackRate`. */
  readonly rate: number;
}

/** One stem the engine has been asked to play, and how loud. */
export interface StemPlanTrack {
  readonly id: string;
  /** 0 to 1, master already folded in. Zero is still *routed* - see the mixer. */
  readonly gain: number;
}

export type StemLoadStatus = "idle" | "loading" | "ready" | "failed" | "unavailable";

export interface StemEngine {
  /** Replace the set of stems this project offers. Everything else is released. */
  setAvailability(stems: readonly StemAvailability[]): void;
  /** What should be sounding, and how loudly. Absent from the list means silent. */
  setPlan(tracks: readonly StemPlanTrack[]): void;
  /** Line the sources up with the transport. Cheap, and called every frame. */
  sync(transport: TransportSnapshot): void;
  statuses(): Readonly<Record<string, StemLoadStatus>>;
  close(): void;
}

/**
 * A source's claim about where it is: at `contextTime` it was playing `mediaTime`.
 *
 * Kept as data rather than read back off the node, because a source will not tell you
 * where it has got to - and because the arithmetic that decides whether it has drifted is
 * then testable without an audio device.
 */
export interface Anchor {
  readonly contextTime: number;
  readonly mediaTime: number;
  readonly rate: number;
}

/** Where a source anchored like this should have reached by `contextTime`. */
export function expectedMediaTime(anchor: Anchor, contextTime: number): number {
  return anchor.mediaTime + (contextTime - anchor.contextTime) * anchor.rate;
}

/**
 * How far a source has slipped from the transport, in seconds of media time.
 *
 * Signed: positive means the stem is ahead of the element.
 */
export function driftSec(anchor: Anchor, contextTime: number, mediaTimeSec: number): number {
  return expectedMediaTime(anchor, contextTime) - mediaTimeSec;
}

/**
 * How far apart they may get before it is worth re-anchoring.
 *
 * Small enough that nothing rhythmic reads wrongly - a note is placed to a few
 * milliseconds, and 25 ms is inside a single frame at 30 fps - and large enough that
 * ordinary jitter in `currentTime` never triggers a restart. Every re-anchor is a short
 * fade, so a threshold that trips constantly would be audible as fluttering.
 */
export const DRIFT_LIMIT_SEC = 0.025;

/**
 * A drift this large is not drift; it is a seek, and is acted on at once.
 *
 * Well above anything a clock does on its own and well below the smallest jump an author
 * makes with a timeline click or an arrow key.
 */
export const JUMP_SEC = 0.25;

/**
 * How long a small drift has to persist before it is believed.
 *
 * A media element's `currentTime` is not a smooth clock: it is the official playback
 * position, updated in steps, and it was measured standing still for around 130 ms at a
 * time while the audio clock ran on. Read once per frame, that looks exactly like a stem
 * running away - and re-anchoring on it produced a burst of six restarts in the first
 * fifth of a second of every solo.
 *
 * So a small drift has to still be there a moment later. Long enough to outlast a stalled
 * reading, short enough that genuine skew is caught long before it could be heard.
 */
export const DRIFT_PATIENCE_SEC = 0.35;

/**
 * What has been noticed about a source's drift so far.
 *
 * Just the moment the drift first went out of range, or `null` while it is in range.
 * Threading it through rather than holding it inside keeps the whole decision a pure
 * function, which is what makes the awkward cases - a stalled clock, a seek during a
 * stall - testable at all.
 */
export interface DriftWatch {
  readonly since: number | null;
}

export const STEADY: DriftWatch = { since: null };

export interface AnchorAssessment {
  readonly reanchor: boolean;
  readonly watch: DriftWatch;
}

/**
 * Whether a running source should be thrown away and started again.
 *
 * Covers three quite different things, and deliberately treats two of them as urgent and
 * one as suspicious:
 *
 *   a rate change   the anchor's arithmetic is now wrong - act at once;
 *   a large jump    the author seeked - act at once, they are waiting to hear it;
 *   a small drift   either real skew or a stalled clock reading - wait and see.
 *
 * Waiting costs nothing audible: a stem a few milliseconds out for a third of a second is
 * inaudible, where a restart every frame is not.
 */
export function assessAnchor(
  anchor: Anchor,
  contextTime: number,
  transport: TransportSnapshot,
  watch: DriftWatch = STEADY,
  limitSec = DRIFT_LIMIT_SEC,
): AnchorAssessment {
  if (anchor.rate !== transport.rate) return { reanchor: true, watch: STEADY };

  const drift = Math.abs(driftSec(anchor, contextTime, transport.timeSec));
  if (drift > JUMP_SEC) return { reanchor: true, watch: STEADY };
  if (drift <= limitSec) return { reanchor: false, watch: STEADY };

  const since = watch.since ?? contextTime;
  if (contextTime - since >= DRIFT_PATIENCE_SEC) return { reanchor: true, watch: STEADY };
  return { reanchor: false, watch: { since } };
}

/**
 * The rate to decode and run the graph at.
 *
 * Not the device's rate, deliberately. `decodeAudioData` resamples to whatever rate its
 * context runs at, so a machine with a 192 kHz sound device quadruples the memory every
 * stem takes for no audible gain - 294 MB against 74 MB, per stem, measured. 48 kHz is at
 * or above the rate of any material the Analyzer produces, so nothing is lost going
 * through it, and the device resamples the output once on its way out.
 */
export const DECODE_RATE_HZ = 48000;

/** Scheduling headroom, so a source starts on time rather than late. */
const START_LEAD_SEC = 0.03;

/** Long enough to remove a click, short enough not to be heard as a swell. */
const FADE_SEC = 0.012;

interface Playing {
  readonly source: AudioBufferSourceNode;
  readonly fade: GainNode;
  readonly anchor: Anchor;
  /** How long this source has been out of range, if it is. */
  watch: DriftWatch;
}

interface Track {
  readonly id: string;
  readonly url: string | null;
  readonly gain: GainNode;
  buffer: AudioBuffer | null;
  status: StemLoadStatus;
  playing: Playing | null;
  /** What the plan last asked for. `null` means not routed. */
  wanted: number | null;
}

/**
 * Build an engine over a Web Audio context.
 *
 * The context is the Editor's one context - the same one the note clicks use - so the
 * clicks and the stems share a clock and a device, and nothing here has to worry about
 * starting one on a gesture.
 *
 * `onStatusChange` fires when a stem starts loading, becomes ready, or fails, so the panel
 * can say so. Nothing else about the engine is observable, on purpose.
 */
export function createStemEngine(
  context: AudioContext,
  onStatusChange?: () => void,
): StemEngine {
  const master = context.createGain();
  master.gain.value = 1;
  master.connect(context.destination);

  let tracks = new Map<string, Track>();
  let closed = false;

  /**
   * Take a source out of the output.
   *
   * `end` is when it should be fully gone. Re-anchoring passes the moment its
   * replacement reaches full gain, which turns the swap into a crossfade rather than a
   * hole; stopping for real just uses the default short fade.
   */
  function stop(track: Track, now: number, end = now + FADE_SEC): void {
    const playing = track.playing;
    if (!playing) return;
    track.playing = null;

    // Fade rather than cut: an AudioBufferSourceNode stopped mid-waveform clicks, and a
    // click on every Solo toggle would be the most noticeable thing about the feature.
    playing.fade.gain.cancelScheduledValues(now);
    playing.fade.gain.setValueAtTime(playing.fade.gain.value, now);
    playing.fade.gain.linearRampToValueAtTime(0, end);
    try {
      playing.source.stop(end);
    } catch {
      // Already stopped, which is not a problem.
    }
    playing.source.onended = () => {
      playing.source.disconnect();
      playing.fade.disconnect();
    };
  }

  function start(track: Track, transport: TransportSnapshot, startAt: number): void {
    const buffer = track.buffer;
    if (!buffer) return;

    // Where the transport will have reached by the time this actually sounds. Getting
    // this wrong by the lead time is exactly the kind of small constant offset that would
    // make every stem feel slightly late.
    const offset =
      transport.timeSec + (startAt - context.currentTime) * transport.rate;
    if (offset < 0 || offset >= buffer.duration) return;

    const fade = context.createGain();
    fade.gain.setValueAtTime(0, startAt);
    fade.gain.linearRampToValueAtTime(1, startAt + FADE_SEC);
    fade.connect(track.gain);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = transport.rate;
    source.connect(fade);
    source.start(startAt, offset);

    const playing: Playing = {
      source,
      fade,
      anchor: { contextTime: startAt, mediaTime: offset, rate: transport.rate },
      watch: STEADY,
    };
    source.onended = () => {
      source.disconnect();
      fade.disconnect();
      // Reaching the end of the buffer is not a reason to keep a dead node around; the
      // next sync will start a new one if the transport is somehow still inside it.
      if (track.playing === playing) track.playing = null;
    };
    track.playing = playing;
  }

  function load(track: Track): void {
    if (track.status !== "idle" || !track.url) return;
    track.status = "loading";
    onStatusChange?.();

    void (async () => {
      try {
        const response = await fetch(track.url as string);
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        // The project may have changed while this was in flight; dropping the result is
        // the whole of the cleanup, because nothing else was touched.
        if (closed || tracks.get(track.id) !== track) return;
        track.buffer = buffer;
        track.status = "ready";
      } catch {
        if (closed || tracks.get(track.id) !== track) return;
        track.status = "failed";
      }
      onStatusChange?.();
    })();
  }

  function release(track: Track): void {
    stop(track, context.currentTime);
    track.buffer = null;
    track.gain.disconnect();
  }

  return {
    setAvailability(stems: readonly StemAvailability[]): void {
      for (const track of tracks.values()) release(track);
      const next = new Map<string, Track>();
      for (const stem of stems) {
        const gain = context.createGain();
        gain.gain.value = 0;
        gain.connect(master);
        next.set(stem.id, {
          id: stem.id,
          url: stem.url,
          gain,
          buffer: null,
          status: stem.url ? "idle" : "unavailable",
          playing: null,
          wanted: null,
        });
      }
      tracks = next;
      onStatusChange?.();
    },

    setPlan(plan: readonly StemPlanTrack[]): void {
      const now = context.currentTime;
      const wanted = new Map(plan.map((entry) => [entry.id, entry.gain]));
      for (const track of tracks.values()) {
        const gain = wanted.get(track.id);
        track.wanted = gain ?? null;
        // A short ramp, not a jump: setting a gain outright while audio is running is
        // the other reliable way to produce a click.
        const target = gain ?? 0;
        track.gain.gain.cancelScheduledValues(now);
        track.gain.gain.setValueAtTime(track.gain.gain.value, now);
        track.gain.gain.linearRampToValueAtTime(target, now + FADE_SEC);
        if (gain !== undefined) load(track);
      }
    },

    sync(transport: TransportSnapshot): void {
      if (closed) return;
      const now = context.currentTime;
      for (const track of tracks.values()) {
        const routed = track.wanted !== null;

        if (!routed || !transport.playing) {
          stop(track, now);
          continue;
        }
        const startAt = now + START_LEAD_SEC;
        if (track.status === "ready" && !track.playing) {
          start(track, transport, startAt);
          continue;
        }
        if (track.playing) {
          const verdict = assessAnchor(track.playing.anchor, now, transport, track.playing.watch);
          if (verdict.reanchor) {
            // Crossfade: the outgoing source holds until the incoming one is up, so a
            // correction is inaudible rather than a gap on every seek.
            stop(track, now, startAt + FADE_SEC);
            start(track, transport, startAt);
          } else {
            track.playing.watch = verdict.watch;
          }
        }
      }
    },

    statuses(): Readonly<Record<string, StemLoadStatus>> {
      const out: Record<string, StemLoadStatus> = {};
      for (const track of tracks.values()) out[track.id] = track.status;
      return out;
    },

    close(): void {
      closed = true;
      for (const track of tracks.values()) release(track);
      tracks = new Map();
      master.disconnect();
    },
  };
}
