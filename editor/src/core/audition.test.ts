import { describe, expect, it } from "vitest";

import {
  createAuditionController, planNavigationAudition,
  NAVIGATION_AUDITION_MS, type AuditionMedia, type AuditionTimers,
} from "./audition";

/** A timer queue that only advances when a test says so. */
function fakeTimers() {
  const queued = new Map<number, () => void>();
  let next = 1;
  const timers: AuditionTimers = {
    set(callback) {
      const handle = next;
      next += 1;
      queued.set(handle, callback);
      return handle;
    },
    clear(handle) {
      queued.delete(handle);
    },
  };
  return {
    timers,
    /** Fire everything still queued, oldest first. */
    flush() {
      for (const handle of [...queued.keys()].sort((a, b) => a - b)) {
        const callback = queued.get(handle);
        queued.delete(handle);
        callback?.();
      }
    },
    outstanding: () => queued.size,
  };
}

function fakeMedia(play: () => Promise<void> = () => Promise.resolve()) {
  const calls: string[] = [];
  const media: AuditionMedia = {
    play: () => {
      calls.push("play");
      return play();
    },
    pause: () => {
      calls.push("pause");
    },
    setCurrentTime: (timeSec) => {
      calls.push(`seek:${timeSec}`);
    },
  };
  return { media, calls };
}

describe("deciding whether to audition", () => {
  it("plays a moment and stops it again when the song was paused", () => {
    expect(planNavigationAudition({ targetSec: 12.5, wasPlaying: false, enabled: true }))
      .toEqual({
        play: true,
        stopAfterMs: NAVIGATION_AUDITION_MS,
        restoreTimeSec: 12.5,
      });
  });

  it("does nothing at all while the song is already playing", () => {
    // The author is listening already and the seek has taken them somewhere new. Pausing
    // a tenth of a second later would be this feature stopping playback it did not start.
    expect(planNavigationAudition({ targetSec: 12.5, wasPlaying: true, enabled: true }))
      .toEqual({ play: false, stopAfterMs: null, restoreTimeSec: null });
  });

  it("does nothing when the author has switched it off", () => {
    expect(planNavigationAudition({ targetSec: 1, wasPlaying: false, enabled: false }))
      .toEqual({ play: false, stopAfterMs: null, restoreTimeSec: null });
    expect(planNavigationAudition({ targetSec: 1, wasPlaying: true, enabled: false }))
      .toEqual({ play: false, stopAfterMs: null, restoreTimeSec: null });
  });

  it("restores the clock to where the navigation landed", () => {
    // Otherwise five presses would move five steps plus half a second of drift.
    for (const targetSec of [0, 0.25, 149.999]) {
      expect(planNavigationAudition({ targetSec, wasPlaying: false, enabled: true })
        .restoreTimeSec).toBe(targetSec);
    }
  });

  it("uses a duration that is short but audible", () => {
    expect(NAVIGATION_AUDITION_MS).toBeGreaterThanOrEqual(80);
    expect(NAVIGATION_AUDITION_MS).toBeLessThanOrEqual(150);
  });
});

describe("running an audition", () => {
  const plan = (targetSec: number) =>
    planNavigationAudition({ targetSec, wasPlaying: false, enabled: true });

  it("plays, then pauses and restores the clock", () => {
    const { timers, flush } = fakeTimers();
    const { media, calls } = fakeMedia();
    createAuditionController(timers).run(media, plan(5));
    expect(calls).toEqual(["play"]);
    flush();
    expect(calls).toEqual(["play", "pause", "seek:5"]);
  });

  it("does not touch the media when the plan is silent", () => {
    const { timers, outstanding } = fakeTimers();
    const { media, calls } = fakeMedia();
    createAuditionController(timers).run(
      media,
      planNavigationAudition({ targetSec: 5, wasPlaying: true, enabled: true }),
    );
    expect(calls).toEqual([]);
    expect(outstanding()).toBe(0);
  });

  it("lets only the newest navigation stop the sound", () => {
    // Holding an arrow key produces a stream of these. If the third press's stop arrived
    // during the fifth press's sound it would cut it off, and holding the key would give
    // silence with occasional blips - the opposite of the point.
    const { timers, flush } = fakeTimers();
    const { media, calls } = fakeMedia();
    const controller = createAuditionController(timers);

    controller.run(media, plan(1));
    controller.run(media, plan(2));
    controller.run(media, plan(3));
    expect(calls).toEqual(["play", "play", "play"]);

    flush();
    // One pause, and it restores the newest target rather than an older one.
    expect(calls).toEqual(["play", "play", "play", "pause", "seek:3"]);
  });

  it("keeps only one stop pending however many navigations arrive", () => {
    const { timers, outstanding } = fakeTimers();
    const { media } = fakeMedia();
    const controller = createAuditionController(timers);
    for (let i = 0; i < 10; i += 1) controller.run(media, plan(i));
    expect(outstanding()).toBe(1);
  });

  it("survives a stale callback that was already in flight", () => {
    // Belt and braces: clearing the timer handles the ordinary case, and the generation
    // check handles a callback that had already been taken off the queue.
    const queued: (() => void)[] = [];
    const timers: AuditionTimers = {
      set(callback) {
        queued.push(callback);
        return queued.length;
      },
      clear() {
        // Deliberately does nothing, to model a callback already in flight.
      },
    };
    const { media, calls } = fakeMedia();
    const controller = createAuditionController(timers);
    controller.run(media, plan(1));
    controller.run(media, plan(2));
    for (const callback of queued) callback();
    // Only the newest one acted.
    expect(calls.filter((c) => c === "pause")).toHaveLength(1);
    expect(calls).toContain("seek:2");
    expect(calls).not.toContain("seek:1");
  });

  it("can be cancelled outright, so transport always wins", () => {
    const { timers, flush } = fakeTimers();
    const { media, calls } = fakeMedia();
    const controller = createAuditionController(timers);
    controller.run(media, plan(5));
    controller.cancel();
    flush();
    // The author pressed play; nothing may pause it a moment later.
    expect(calls).toEqual(["play"]);
    expect(controller.pending()).toBe(false);
  });

  it("reports whether a stop is pending", () => {
    const { timers, flush } = fakeTimers();
    const { media } = fakeMedia();
    const controller = createAuditionController(timers);
    expect(controller.pending()).toBe(false);
    controller.run(media, plan(1));
    expect(controller.pending()).toBe(true);
    flush();
    expect(controller.pending()).toBe(false);
  });

  it("swallows a refusal to play rather than breaking the Editor", async () => {
    // A browser declining to start, or a seek interrupting the start, is a reason for one
    // audition to be silent - never an unhandled rejection and never a broken Editor.
    // The rejected promise is attached to below, which is what proves it was handled: an
    // unattached rejection would surface as an unhandled one.
    const rejected = Promise.reject(new Error("not allowed"));
    const settled = rejected.catch(() => "handled");

    const { timers } = fakeTimers();
    const { media, calls } = fakeMedia(() => rejected);
    const controller = createAuditionController(timers);
    expect(() => controller.run(media, plan(5))).not.toThrow();

    expect(await settled).toBe("handled");
    expect(calls).toEqual(["play"]);

    // And the controller still works for the next navigation.
    const { media: second, calls: secondCalls } = fakeMedia();
    controller.run(second, plan(9));
    expect(secondCalls).toEqual(["play"]);
  });

  it("plays from the start of the recording as readily as anywhere else", () => {
    const { timers, flush } = fakeTimers();
    const { media, calls } = fakeMedia();
    createAuditionController(timers).run(media, plan(0));
    flush();
    expect(calls).toEqual(["play", "pause", "seek:0"]);
  });
});
