import { describe, expect, it } from "vitest";

import type { ChartNote } from "./chart";
import {
  advanceScheduler, buildHitPoints, idleScheduler, resetSchedulerTo, voiceForNote,
  INITIAL_SCHEDULER, SEEK_THRESHOLD_SEC, type HitPoint,
} from "./hitScheduler";

const tap = (timeSec: number, lane = 0): ChartNote => ({
  id: `n-${timeSec}-${lane}`, type: "tap", timeSec, lane,
});

/** Ascending by time, as the chart model guarantees. */
const NOTES: readonly ChartNote[] = [
  tap(1.0), tap(1.5), tap(2.0, 0), tap(2.0, 2), tap(2.0, 4), tap(2.5), tap(3.0),
];

/**
 * The scheduler walks *moments*, not notes.
 *
 * For a chart of taps the two lists are the same thing, which is why every expectation
 * below is unchanged: one tap is one moment. What the flattening buys is the notes that
 * are not - a connected slide, or a note that finishes in a flick - and those have their
 * own suite in `slideAudition.test.ts`.
 */
const POINTS = buildHitPoints(NOTES);

const ids = (points: readonly HitPoint[]) => points.map((p) => p.note.id);
const noteIds = (notes: readonly ChartNote[]) => notes.map((n) => n.id);

describe("first step", () => {
  it("adopts the position without announcing anything", () => {
    // Starting playback in the middle of a song must not replay everything before it.
    const step = advanceScheduler(INITIAL_SCHEDULER, 2.4, POINTS);
    expect(step.fired).toEqual([]);
    expect(step.state.lastTimeSec).toBe(2.4);
  });
});

describe("crossing notes", () => {
  it("fires a note the playhead passed", () => {
    const step = advanceScheduler(resetSchedulerTo(0.9), 1.1, POINTS);
    expect(ids(step.fired)).toEqual(["n-1-0"]);
  });

  it("fires a note exactly on the new time, and only once", () => {
    // The interval is half-open: previous < timeSec <= current.
    const first = advanceScheduler(resetSchedulerTo(0.9), 1.0, POINTS);
    expect(ids(first.fired)).toEqual(["n-1-0"]);
    const second = advanceScheduler(first.state, 1.2, POINTS);
    expect(second.fired).toEqual([]);
  });

  it("does not fire a note the playhead has not reached", () => {
    expect(advanceScheduler(resetSchedulerTo(0.5), 0.99, POINTS).fired).toEqual([]);
  });

  it("fires nothing when the clock has not moved", () => {
    const state = resetSchedulerTo(1.2);
    const step = advanceScheduler(state, 1.2, POINTS);
    expect(step.fired).toEqual([]);
    expect(step.state).toBe(state);
  });

  it("catches every note in a dropped frame", () => {
    // A hitch advanced the clock by 700 ms. Nothing in that window may be swallowed.
    const step = advanceScheduler(resetSchedulerTo(0.9), 1.6, POINTS);
    expect(ids(step.fired)).toEqual(["n-1-0", "n-1.5-0"]);
  });

  it("fires an entire chord", () => {
    // Three lanes at one instant: hearing only one would misreport the chart.
    const step = advanceScheduler(resetSchedulerTo(1.9), 2.1, POINTS);
    expect(ids(step.fired)).toEqual(["n-2-0", "n-2-2", "n-2-4"]);
  });

  it("fires in the order the notes occur", () => {
    // Walked forward in steps under the seek threshold, as real playback does.
    let state = resetSchedulerTo(0.5);
    const times: number[] = [];
    for (const t of [1.2, 2.1, 3.0]) {
      const step = advanceScheduler(state, t, POINTS);
      state = step.state;
      times.push(...step.fired.map((n) => n.timeSec));
    }
    expect(times).toEqual([1.0, 1.5, 2.0, 2.0, 2.0, 2.5, 3.0]);
  });

  it("copes with a chart that has no notes", () => {
    expect(advanceScheduler(resetSchedulerTo(0), 5, []).fired).toEqual([]);
  });
});

describe("seeking", () => {
  it("announces nothing for a long forward jump", () => {
    // 40 s to 90 s must not play the fifty seconds of notes in between.
    const step = advanceScheduler(resetSchedulerTo(0.5), 0.5 + SEEK_THRESHOLD_SEC + 0.5, POINTS);
    expect(step.fired).toEqual([]);
    expect(step.seeked).toBe(true);
  });

  it("moves the cursor to where the seek landed", () => {
    const step = advanceScheduler(resetSchedulerTo(0.5), 40, POINTS);
    expect(step.state.lastTimeSec).toBe(40);
    // And carries on normally from there rather than catching up.
    expect(advanceScheduler(step.state, 40.1, POINTS).fired).toEqual([]);
  });

  it("announces nothing for a backward jump", () => {
    const step = advanceScheduler(resetSchedulerTo(3.0), 1.2, POINTS);
    expect(step.fired).toEqual([]);
    expect(step.seeked).toBe(true);
    expect(step.state.lastTimeSec).toBe(1.2);
  });

  it("plays normally again after a backward seek", () => {
    const seeked = advanceScheduler(resetSchedulerTo(3.0), 0.9, POINTS);
    expect(ids(advanceScheduler(seeked.state, 1.1, POINTS).fired)).toEqual(["n-1-0"]);
  });

  it("treats a big but plausible frame as playback, not a seek", () => {
    // 300 ms is a bad hitch, not a jump. Its notes must still sound.
    const step = advanceScheduler(resetSchedulerTo(1.4), 1.7, POINTS);
    expect(step.seeked).toBe(false);
    expect(ids(step.fired)).toEqual(["n-1.5-0"]);
  });
});

describe("pause and resume", () => {
  it("replays nothing from before the resume point", () => {
    // Paused at 2.2, resumed there: the notes at 1.0-2.0 have already been heard.
    const resumed = resetSchedulerTo(2.2);
    expect(advanceScheduler(resumed, 2.3, POINTS).fired).toEqual([]);
  });

  it("still fires the next note after a resume", () => {
    const resumed = resetSchedulerTo(2.2);
    expect(ids(advanceScheduler(resumed, 2.6, POINTS).fired)).toEqual(["n-2.5-0"]);
  });

  it("an idle scheduler adopts the next position it sees", () => {
    const step = advanceScheduler(idleScheduler(), 2.9, POINTS);
    expect(step.fired).toEqual([]);
    expect(step.state.lastTimeSec).toBe(2.9);
  });
});

describe("playback rate", () => {
  it("schedules by chart time, so the rate changes nothing about which notes fire", () => {
    // The audio element's currentTime is already in chart seconds whatever the rate; a
    // slow pass simply reports smaller steps. The same notes fire, in the same order.
    const slowSteps = [1.05, 1.2, 1.35, 1.5, 1.65];
    let state = resetSchedulerTo(0.9);
    const slow: string[] = [];
    for (const t of slowSteps) {
      const step = advanceScheduler(state, t, POINTS);
      state = step.state;
      slow.push(...ids(step.fired));
    }

    const fast = ids(advanceScheduler(resetSchedulerTo(0.9), 1.65, POINTS).fired);
    expect(slow).toEqual(fast);
    expect(slow).toEqual(["n-1-0", "n-1.5-0"]);
  });

  it("does not depend on how many steps the clock is sampled in", () => {
    // One frame covering 0.9 s, versus nine covering 0.1 s each: the same notes, once.
    const oneStep = ids(advanceScheduler(resetSchedulerTo(1.4), 2.3, POINTS).fired);

    let state = resetSchedulerTo(1.4);
    const many: string[] = [];
    for (let t = 1.5; t <= 2.3001; t += 0.1) {
      const step = advanceScheduler(state, Number(t.toFixed(4)), POINTS);
      state = step.state;
      many.push(...ids(step.fired));
    }
    expect(many).toEqual(oneStep);
    expect(oneStep).toEqual(["n-1.5-0", "n-2-0", "n-2-2", "n-2-4"]);
  });
});

/**
 * Slow playback, where the note clicks are actually used.
 *
 * A tenth-speed pass advances the clock by about 1.7 ms per frame, which is small enough
 * that the two ways this could break both become likely at once: a frame that reports the
 * same `currentTime` as the last one, which must not announce a note twice, and notes
 * closer together than the sampling, which must not be stepped over. Both are checked
 * against a run of frames rather than a single call, because both are properties of a
 * sequence.
 */
describe("slow playback", () => {
  /**
   * A pass over `notes` at `rate`, sampled every frame at 60 Hz.
   *
   * `stallEvery` makes one frame in N report the previous time again, which is what a
   * media clock that updates less often than the display does looks like from here.
   */
  const playThrough = (
    fromSec: number,
    toSec: number,
    rate: number,
    notes: readonly ChartNote[],
    stallEvery = 0,
  ): string[] => {
    const perFrame = rate / 60;
    let state = resetSchedulerTo(fromSec);
    let clock = fromSec;
    const heard: string[] = [];
    for (let frame = 0; clock < toSec; frame += 1) {
      if (stallEvery === 0 || frame % stallEvery !== 0) clock += perFrame;
      const step = advanceScheduler(state, clock, buildHitPoints(notes));
      state = step.state;
      heard.push(...ids(step.fired));
      if (frame > 200000) throw new Error("clock is not advancing");
    }
    return heard;
  };

  it("announces every note exactly once at 0.10x", () => {
    const heard = playThrough(0.9, 3.1, 0.1, NOTES);
    expect(heard).toEqual(noteIds(NOTES));
  });

  it("announces every note exactly once at 0.25x", () => {
    expect(playThrough(0.9, 3.1, 0.25, NOTES)).toEqual(noteIds(NOTES));
  });

  it("announces nothing twice when the clock repeats a frame at 0.10x", () => {
    // Every third frame reports the same time again. A "the playhead is near a note"
    // test would fire the same note on each of them.
    expect(playThrough(0.9, 3.1, 0.1, NOTES, 3)).toEqual(noteIds(NOTES));
  });

  it("misses nothing when notes are closer together than one frame at 0.10x", () => {
    // A tenth-speed frame is about 1.7 ms of chart time; these notes are 1 ms apart, so
    // several fall inside a single step and all of them have to come out of it.
    const dense = [tap(1.0), tap(1.001), tap(1.002), tap(1.003), tap(1.004)];
    expect(playThrough(0.995, 1.01, 0.1, dense)).toEqual(noteIds(dense));
  });

  it("gives the same notes at 0.10x as at full speed", () => {
    expect(playThrough(0.9, 3.1, 0.1, NOTES)).toEqual(playThrough(0.9, 3.1, 1, NOTES));
  });

  it("resumes at 0.10x without replaying what was already heard", () => {
    const before = playThrough(0.9, 2.05, 0.1, NOTES);
    expect(before).toEqual(["n-1-0", "n-1.5-0", "n-2-0", "n-2-2", "n-2-4"]);
    // Pause writes nothing; resume puts the cursor back at the position it stopped at.
    const after = playThrough(2.05, 3.1, 0.1, NOTES);
    expect(after).toEqual(["n-2.5-0", "n-3-0"]);
  });

  it("stays silent over a seek at 0.10x and plays normally on the far side", () => {
    // At a tenth speed a frame is 1.7 ms, so a jump of a second is unmistakably a seek
    // however slowly the song is playing - the threshold is in chart time, not frames.
    let state = resetSchedulerTo(1.2);
    const jumped = advanceScheduler(state, 2.6, POINTS);
    state = jumped.state;
    expect(jumped.seeked).toBe(true);
    expect(jumped.fired).toEqual([]);

    const next = advanceScheduler(state, 2.6 + 0.1 / 60, POINTS);
    expect(next.seeked).toBe(false);
    // Nothing yet - but the cursor is live again, and the 3.0 note arrives on time.
    expect(next.fired).toEqual([]);
    expect(playThrough(2.6, 3.1, 0.1, NOTES)).toEqual(["n-3-0"]);
  });

  it("does not care how the rate changed on the way through", () => {
    // 1.00x to 0.10x and back: the clock is chart time either way, so switching speed
    // mid-pass is not an event the scheduler has to know about.
    let state = resetSchedulerTo(0.9);
    const heard: string[] = [];
    for (const rate of [1, 0.1, 1, 0.1]) {
      const perFrame = rate / 60;
      const until = state.lastTimeSec === null ? 0 : state.lastTimeSec + 0.55;
      let clock = state.lastTimeSec ?? 0;
      while (clock < until) {
        clock += perFrame;
        const step = advanceScheduler(state, clock, POINTS);
        state = step.state;
        heard.push(...ids(step.fired));
      }
    }
    expect(heard).toEqual(noteIds(NOTES));
  });
});

describe("voiceForNote", () => {
  it("distinguishes the kinds by shape, not by type name", () => {
    expect(voiceForNote(tap(1))).toBe("tap");
    expect(voiceForNote({ ...tap(1), direction: "up" })).toBe("flick");
    expect(voiceForNote({ ...tap(1), endTimeSec: 2 })).toBe("holdStart");
    // An unknown type with an end is still a hold start.
    expect(voiceForNote({ ...tap(1), type: "somethingElse", endTimeSec: 2 }))
      .toBe("holdStart");
  });

  it("treats a degenerate end as an instantaneous note", () => {
    expect(voiceForNote({ ...tap(1), endTimeSec: 1 })).toBe("tap");
  });
});
