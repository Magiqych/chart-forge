/**
 * Keeping a stem lined up with the transport.
 *
 * The engine itself needs an audio device, but the decision it makes sixty times a second
 * - is this source still where the transport is, or must it be started again - is
 * arithmetic over two clocks, and that is what is tested here.
 *
 * The situations it has to cover look quite different to a user: an author seeks, an
 * author changes the playback rate, and the two clocks slowly slip apart on their own.
 * A fourth is not a situation at all but an artefact - a media element's `currentTime`
 * stands still for a tenth of a second at a time - and telling that apart from the third
 * is what most of this suite is about, because failing to cost a burst of restarts at the
 * start of every solo.
 */

import { describe, expect, it } from "vitest";

import {
  DRIFT_LIMIT_SEC, DRIFT_PATIENCE_SEC, JUMP_SEC, STEADY, assessAnchor, driftSec,
  expectedMediaTime, type Anchor, type DriftWatch, type TransportSnapshot,
} from "./stemEngine";

/** A source started at context time 100, playing from 5 s, at normal speed. */
const anchor: Anchor = { contextTime: 100, mediaTime: 5, rate: 1 };

const at = (timeSec: number, rate = 1): TransportSnapshot => ({
  timeSec,
  playing: true,
  rate,
});

/** Whether a single reading, with nothing noticed before it, calls for a restart. */
const once = (contextTime: number, transport: TransportSnapshot, source = anchor) =>
  assessAnchor(source, contextTime, transport).reanchor;

/**
 * Play the same reading over and over, as the sync loop would, and say when it gives in.
 *
 * Returns the context time at which it decided to re-anchor, or null if it never did.
 */
function persist(
  source: Anchor,
  transportAt: (contextTime: number) => TransportSnapshot,
  fromSec: number,
  toSec: number,
  stepSec = 1 / 60,
): number | null {
  let watch: DriftWatch = STEADY;
  for (let t = fromSec; t <= toSec; t += stepSec) {
    const verdict = assessAnchor(source, t, transportAt(t), watch);
    if (verdict.reanchor) return t;
    watch = verdict.watch;
  }
  return null;
}

describe("where a source has got to", () => {
  it("advances with the context clock", () => {
    expect(expectedMediaTime(anchor, 100)).toBe(5);
    expect(expectedMediaTime(anchor, 102.5)).toBeCloseTo(7.5);
  });

  it("advances more slowly when the transport is slowed down", () => {
    // The rate belongs to the anchor, not to the moment: a source started at 0.25x goes
    // on playing at 0.25x until it is replaced.
    const slow: Anchor = { ...anchor, rate: 0.25 };
    expect(expectedMediaTime(slow, 104)).toBeCloseTo(6);
  });

  it("is behind the transport when the drift is negative", () => {
    expect(driftSec(anchor, 101, 1.02)).toBeCloseTo(4.98);
    expect(driftSec(anchor, 101, 6.02)).toBeCloseTo(-0.02);
  });
});

describe("deciding to start again", () => {
  it("leaves a source alone while it is in step", () => {
    expect(once(101, at(6))).toBe(false);
    expect(once(130.5, at(35.5))).toBe(false);
  });

  it("tolerates the jitter a media element's currentTime always has", () => {
    // `currentTime` is sampled, not exact, so a few milliseconds of wobble arrives every
    // frame. Restarting on that would flutter continuously.
    for (const wobble of [0.001, -0.002, 0.004, -0.005, 0.011]) {
      expect(once(105, at(10 + wobble))).toBe(false);
    }
  });

  it("acts on a seek at once, because the author is waiting to hear it", () => {
    // The author clicked the timeline at 40 s while the source was playing 10 s. No
    // waiting and no confirmation: this is not drift, and they would hear the delay.
    expect(once(105, at(40))).toBe(true);
    expect(once(105, at(2))).toBe(true);
    // Even the smallest jump an author can make is acted on immediately.
    expect(once(105, at(10 + JUMP_SEC + 0.01))).toBe(true);
  });

  it("acts on a rate change at once, even when nothing has drifted yet", () => {
    // The instant after the rate menu changes, the positions still agree - but the
    // source is resampling at the old rate and will be wrong from here on.
    expect(once(105, at(10, 0.5))).toBe(true);
    expect(once(100, at(5, 0.25))).toBe(true);
  });

  it("waits before believing a small drift, then acts", () => {
    const off = (t: number) => at(t - 95 - DRIFT_LIMIT_SEC - 0.005);
    // Nothing happens on the first reading, however far through the song it is.
    expect(once(200, off(200))).toBe(false);
    // But a drift that is still there a third of a second later is real.
    const gaveIn = persist(anchor, off, 200, 201);
    expect(gaveIn).not.toBeNull();
    expect((gaveIn as number) - 200).toBeGreaterThanOrEqual(DRIFT_PATIENCE_SEC);
    expect((gaveIn as number) - 200).toBeLessThan(DRIFT_PATIENCE_SEC + 0.05);
  });

  it("never gives in while the drift keeps coming back inside the limit", () => {
    // The defect this exists for. A media element's currentTime stands still for a
    // tenth of a second at a time, so a source that is perfectly in step reads as
    // drifting, then not, then drifting again. Restarting on that produced six restarts
    // in the first fifth of a second of every solo.
    const stalling = (contextTime: number) => {
      // The element updates in 130 ms steps; the source is genuinely in step.
      const step = 0.13;
      return at(5 + Math.floor((contextTime - 100) / step) * step);
    };
    expect(persist(anchor, stalling, 100, 110)).toBeNull();
  });

  it("still catches real skew hiding behind a stalling clock", () => {
    // A clock that stalls *and* a source that is genuinely running away: the reading
    // never comes back inside the limit, so patience runs out and it is corrected.
    const stalling = (contextTime: number) => {
      const step = 0.13;
      return at(5 + Math.floor((contextTime - 100) / step) * step - 0.09);
    };
    const gaveIn = persist(anchor, stalling, 100, 102);
    expect(gaveIn).not.toBeNull();
    expect((gaveIn as number) - 100).toBeLessThan(DRIFT_PATIENCE_SEC + 0.2);
  });

  it("forgets what it noticed once the drift is gone", () => {
    const drifted = assessAnchor(anchor, 100, at(5 - DRIFT_LIMIT_SEC - 0.01));
    expect(drifted.watch.since).toBe(100);

    const recovered = assessAnchor(anchor, 100.1, at(5.1), drifted.watch);
    expect(recovered.reanchor).toBe(false);
    expect(recovered.watch).toEqual(STEADY);
  });

  it("leaves a source alone on either side of the threshold for one reading", () => {
    const justInside = DRIFT_LIMIT_SEC - 0.001;
    const justOutside = DRIFT_LIMIT_SEC + 0.001;
    expect(once(200, at(105 - justInside))).toBe(false);
    expect(once(200, at(105 - justOutside))).toBe(false);
    expect(once(200, at(105 + justOutside))).toBe(false);
  });

  it("keeps the threshold tight enough to be inaudible as a timing error", () => {
    // A stem more than about 25 ms out would read as a flam against the note clicks;
    // this is the number that guarantees it never gets that far.
    expect(DRIFT_LIMIT_SEC).toBeLessThanOrEqual(0.03);
  });

  it("measures drift in media time, so a slow rate is not mistaken for a seek", () => {
    // At 0.25x, eight seconds of context time is two seconds of music, so a transport
    // that has moved 5 -> 7 is exactly in step. Comparing context seconds against media
    // seconds here would read as a two-second error and restart the source constantly.
    const slow: Anchor = { ...anchor, rate: 0.25 };
    expect(once(108, at(7, 0.25), slow)).toBe(false);
    expect(once(108, at(13, 0.25), slow)).toBe(true);
  });

  it("waits a fixed time rather than a fixed number of frames", () => {
    // A dropped frame or a slow render must not change how long it waits: the patience
    // is measured on the audio clock, which nothing in the UI can stall.
    const off = (t: number) => at(t - 95 - DRIFT_LIMIT_SEC - 0.005);
    const everyFrame = persist(anchor, off, 200, 201, 1 / 60);
    const everyOtherFrame = persist(anchor, off, 200, 201, 1 / 6);
    expect(everyFrame).not.toBeNull();
    expect(everyOtherFrame).not.toBeNull();
    expect(Math.abs((everyOtherFrame as number) - (everyFrame as number))).toBeLessThan(0.2);
  });
});
