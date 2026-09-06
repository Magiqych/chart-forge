import { describe, expect, it } from "vitest";

import type { ChartNote } from "./chart";
import {
  advanceScheduler, idleScheduler, resetSchedulerTo, voiceForNote,
  INITIAL_SCHEDULER, SEEK_THRESHOLD_SEC,
} from "./hitScheduler";

const tap = (timeSec: number, lane = 0): ChartNote => ({
  id: `n-${timeSec}-${lane}`, type: "tap", timeSec, lane,
});

/** Ascending by time, as the chart model guarantees. */
const NOTES: readonly ChartNote[] = [
  tap(1.0), tap(1.5), tap(2.0, 0), tap(2.0, 2), tap(2.0, 4), tap(2.5), tap(3.0),
];

const ids = (notes: readonly ChartNote[]) => notes.map((n) => n.id);

describe("first step", () => {
  it("adopts the position without announcing anything", () => {
    // Starting playback in the middle of a song must not replay everything before it.
    const step = advanceScheduler(INITIAL_SCHEDULER, 2.4, NOTES);
    expect(step.fired).toEqual([]);
    expect(step.state.lastTimeSec).toBe(2.4);
  });
});

describe("crossing notes", () => {
  it("fires a note the playhead passed", () => {
    const step = advanceScheduler(resetSchedulerTo(0.9), 1.1, NOTES);
    expect(ids(step.fired)).toEqual(["n-1-0"]);
  });

  it("fires a note exactly on the new time, and only once", () => {
    // The interval is half-open: previous < timeSec <= current.
    const first = advanceScheduler(resetSchedulerTo(0.9), 1.0, NOTES);
    expect(ids(first.fired)).toEqual(["n-1-0"]);
    const second = advanceScheduler(first.state, 1.2, NOTES);
    expect(second.fired).toEqual([]);
  });

  it("does not fire a note the playhead has not reached", () => {
    expect(advanceScheduler(resetSchedulerTo(0.5), 0.99, NOTES).fired).toEqual([]);
  });

  it("fires nothing when the clock has not moved", () => {
    const state = resetSchedulerTo(1.2);
    const step = advanceScheduler(state, 1.2, NOTES);
    expect(step.fired).toEqual([]);
    expect(step.state).toBe(state);
  });

  it("catches every note in a dropped frame", () => {
    // A hitch advanced the clock by 700 ms. Nothing in that window may be swallowed.
    const step = advanceScheduler(resetSchedulerTo(0.9), 1.6, NOTES);
    expect(ids(step.fired)).toEqual(["n-1-0", "n-1.5-0"]);
  });

  it("fires an entire chord", () => {
    // Three lanes at one instant: hearing only one would misreport the chart.
    const step = advanceScheduler(resetSchedulerTo(1.9), 2.1, NOTES);
    expect(ids(step.fired)).toEqual(["n-2-0", "n-2-2", "n-2-4"]);
  });

  it("fires in the order the notes occur", () => {
    // Walked forward in steps under the seek threshold, as real playback does.
    let state = resetSchedulerTo(0.5);
    const times: number[] = [];
    for (const t of [1.2, 2.1, 3.0]) {
      const step = advanceScheduler(state, t, NOTES);
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
    const step = advanceScheduler(resetSchedulerTo(0.5), 0.5 + SEEK_THRESHOLD_SEC + 0.5, NOTES);
    expect(step.fired).toEqual([]);
    expect(step.seeked).toBe(true);
  });

  it("moves the cursor to where the seek landed", () => {
    const step = advanceScheduler(resetSchedulerTo(0.5), 40, NOTES);
    expect(step.state.lastTimeSec).toBe(40);
    // And carries on normally from there rather than catching up.
    expect(advanceScheduler(step.state, 40.1, NOTES).fired).toEqual([]);
  });

  it("announces nothing for a backward jump", () => {
    const step = advanceScheduler(resetSchedulerTo(3.0), 1.2, NOTES);
    expect(step.fired).toEqual([]);
    expect(step.seeked).toBe(true);
    expect(step.state.lastTimeSec).toBe(1.2);
  });

  it("plays normally again after a backward seek", () => {
    const seeked = advanceScheduler(resetSchedulerTo(3.0), 0.9, NOTES);
    expect(ids(advanceScheduler(seeked.state, 1.1, NOTES).fired)).toEqual(["n-1-0"]);
  });

  it("treats a big but plausible frame as playback, not a seek", () => {
    // 300 ms is a bad hitch, not a jump. Its notes must still sound.
    const step = advanceScheduler(resetSchedulerTo(1.4), 1.7, NOTES);
    expect(step.seeked).toBe(false);
    expect(ids(step.fired)).toEqual(["n-1.5-0"]);
  });
});

describe("pause and resume", () => {
  it("replays nothing from before the resume point", () => {
    // Paused at 2.2, resumed there: the notes at 1.0-2.0 have already been heard.
    const resumed = resetSchedulerTo(2.2);
    expect(advanceScheduler(resumed, 2.3, NOTES).fired).toEqual([]);
  });

  it("still fires the next note after a resume", () => {
    const resumed = resetSchedulerTo(2.2);
    expect(ids(advanceScheduler(resumed, 2.6, NOTES).fired)).toEqual(["n-2.5-0"]);
  });

  it("an idle scheduler adopts the next position it sees", () => {
    const step = advanceScheduler(idleScheduler(), 2.9, NOTES);
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
      const step = advanceScheduler(state, t, NOTES);
      state = step.state;
      slow.push(...ids(step.fired));
    }

    const fast = ids(advanceScheduler(resetSchedulerTo(0.9), 1.65, NOTES).fired);
    expect(slow).toEqual(fast);
    expect(slow).toEqual(["n-1-0", "n-1.5-0"]);
  });

  it("does not depend on how many steps the clock is sampled in", () => {
    // One frame covering 0.9 s, versus nine covering 0.1 s each: the same notes, once.
    const oneStep = ids(advanceScheduler(resetSchedulerTo(1.4), 2.3, NOTES).fired);

    let state = resetSchedulerTo(1.4);
    const many: string[] = [];
    for (let t = 1.5; t <= 2.3001; t += 0.1) {
      const step = advanceScheduler(state, Number(t.toFixed(4)), NOTES);
      state = step.state;
      many.push(...ids(step.fired));
    }
    expect(many).toEqual(oneStep);
    expect(oneStep).toEqual(["n-1.5-0", "n-2-0", "n-2-2", "n-2-4"]);
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
