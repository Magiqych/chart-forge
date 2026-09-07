import { describe, expect, it } from "vitest";

import {
  keyboardSeekStepSec, keyboardSeekTarget,
  COARSE_STEP_MULTIPLIER, KEYBOARD_STEP_PX, MAX_STEP_SEC, MIN_STEP_SEC,
} from "./keyboardSeek";
import type { Viewport } from "./viewport";

const view = (pixelsPerSecond: number): Viewport => ({
  startSec: 0,
  pixelsPerSecond,
  widthPx: 1000,
});

describe("the arrow-key step follows the zoom", () => {
  it("is a fixed distance on screen, converted through the zoom", () => {
    // This is the whole idea: the author gets the same visible nudge at any zoom, so the
    // key is a frame-advance rather than a fixed jump that is tiny at one zoom and wild
    // at another.
    for (const zoom of [40, 100, 200, 400]) {
      expect(keyboardSeekStepSec(zoom)).toBeCloseTo(KEYBOARD_STEP_PX / zoom, 9);
    }
  });

  it("gives a bigger step at a lower zoom", () => {
    expect(keyboardSeekStepSec(50)).toBeGreaterThan(keyboardSeekStepSec(100));
    expect(keyboardSeekStepSec(100)).toBeGreaterThan(keyboardSeekStepSec(400));
  });

  it("gives a smaller step at a higher zoom", () => {
    expect(keyboardSeekStepSec(800)).toBeLessThan(keyboardSeekStepSec(200));
  });

  it("halves when the zoom doubles", () => {
    expect(keyboardSeekStepSec(200)).toBeCloseTo(keyboardSeekStepSec(100) / 2, 9);
  });

  it("clamps to something useful when zoomed right in", () => {
    // At 2000 px/s the raw step would be 4 ms: finer than anything audible and too slow
    // to get anywhere with.
    expect(keyboardSeekStepSec(2000)).toBe(MIN_STEP_SEC);
    expect(keyboardSeekStepSec(100000)).toBe(MIN_STEP_SEC);
  });

  it("clamps to something readable when zoomed right out", () => {
    // At 5 px/s the raw step would be 1.6 s, which skips whole phrases.
    expect(keyboardSeekStepSec(5)).toBe(MAX_STEP_SEC);
    expect(keyboardSeekStepSec(0.01)).toBe(MAX_STEP_SEC);
  });

  it("survives a nonsense zoom", () => {
    expect(keyboardSeekStepSec(0)).toBe(MIN_STEP_SEC);
    expect(keyboardSeekStepSec(-100)).toBe(MIN_STEP_SEC);
    expect(keyboardSeekStepSec(Number.NaN)).toBe(MIN_STEP_SEC);
  });

  it("scales the coarse step by a multiplier rather than a second rule", () => {
    // Shift is "the same idea, bigger", so it stays zoom-relative too - which a fixed
    // five seconds would not.
    for (const zoom of [50, 100, 400]) {
      expect(keyboardSeekStepSec(zoom, true))
        .toBeCloseTo(keyboardSeekStepSec(zoom) * COARSE_STEP_MULTIPLIER, 9);
    }
  });

  it("keeps the coarse step bigger than the fine one at every zoom", () => {
    for (const zoom of [5, 50, 100, 500, 2000]) {
      expect(keyboardSeekStepSec(zoom, true)).toBeGreaterThan(keyboardSeekStepSec(zoom));
    }
  });
});

describe("where an arrow key lands", () => {
  it("moves left for -1 and right for +1", () => {
    expect(keyboardSeekTarget(view(100), 10, -1, 300)).toBeLessThan(10);
    expect(keyboardSeekTarget(view(100), 10, 1, 300)).toBeGreaterThan(10);
  });

  it("moves by exactly one step", () => {
    const step = keyboardSeekStepSec(100);
    expect(keyboardSeekTarget(view(100), 10, 1, 300)).toBeCloseTo(10 + step, 9);
    expect(keyboardSeekTarget(view(100), 10, -1, 300)).toBeCloseTo(10 - step, 9);
  });

  it("stops at the start of the recording", () => {
    expect(keyboardSeekTarget(view(100), 0, -1, 300)).toBe(0);
    expect(keyboardSeekTarget(view(5), 0.5, -1, 300)).toBe(0);
  });

  it("stops at the end of the recording", () => {
    expect(keyboardSeekTarget(view(100), 300, 1, 300)).toBe(300);
    expect(keyboardSeekTarget(view(5), 299.5, 1, 300)).toBe(300);
  });

  it("never leaves the recording, from anywhere, at any zoom", () => {
    for (const zoom of [5, 100, 2000]) {
      for (const at of [0, 0.001, 150, 299.999, 300]) {
        for (const direction of [-1, 1] as const) {
          for (const coarse of [false, true]) {
            const target = keyboardSeekTarget(view(zoom), at, direction, 300, coarse);
            expect(target).toBeGreaterThanOrEqual(0);
            expect(target).toBeLessThanOrEqual(300);
          }
        }
      }
    }
  });

  it("copes with a recording of no length", () => {
    expect(keyboardSeekTarget(view(100), 0, 1, 0)).toBe(0);
  });
});

/**
 * The size of the step, in seconds, rather than in terms of the constants.
 *
 * The tests above would all still pass if every constant were doubled, because they are
 * written against the constants themselves. These state the actual distances, so a change
 * to how far an arrow key goes has to be a deliberate change to a number here as well.
 * The step was halved from what it was: 16 px, 0.01 s and 2 s became 8 px, 0.005 s and
 * 1 s, which halves every press at every zoom rather than only in the middle of the range.
 */
describe("the size of one arrow press", () => {
  it("is eight pixels of travel", () => {
    expect(KEYBOARD_STEP_PX).toBe(8);
  });

  it("is half of what it used to be, at every zoom, fine and coarse alike", () => {
    const before = (pixelsPerSecond: number, coarse: boolean): number => {
      const scale = coarse ? COARSE_STEP_MULTIPLIER : 1;
      return Math.min(2, Math.max(0.01, 16 / pixelsPerSecond)) * scale;
    };
    // Right across the zoom range, including outside both clamps, where a step that had
    // kept the old limits would have stayed exactly where it was.
    for (const zoom of [5, 8, 16, 30, 100, 400, 800, 1600, 2000]) {
      for (const coarse of [false, true]) {
        expect(keyboardSeekStepSec(zoom, coarse)).toBeCloseTo(before(zoom, coarse) / 2, 12);
      }
    }
  });

  it("moves 80 ms at the zoom an author works at", () => {
    expect(keyboardSeekStepSec(100)).toBeCloseTo(0.08, 12);
    expect(keyboardSeekStepSec(100, true)).toBeCloseTo(0.4, 12);
  });

  it("goes exactly as far left as it does right", () => {
    for (const zoom of [5, 100, 2000]) {
      for (const coarse of [false, true]) {
        const at = 30;
        const right = keyboardSeekTarget(view(zoom), at, 1, 300, coarse) - at;
        const left = at - keyboardSeekTarget(view(zoom), at, -1, 300, coarse);
        expect(right).toBeCloseTo(left, 12);
      }
    }
  });

  it("lands wherever the step lands, with no grid pulling it anywhere", () => {
    // The arrow keys are the fine adjustment, so they are deliberately not magnetised:
    // an author using them is looking for a time *between* the things a drag snaps to.
    // A press from a round number therefore lands on an unround one and stays there.
    const step = keyboardSeekStepSec(137);
    expect(keyboardSeekTarget(view(137), 2, 1, 300)).toBeCloseTo(2 + step, 12);
    expect(keyboardSeekTarget(view(137), 2, 1, 300)).not.toBe(2.1);
  });
});
