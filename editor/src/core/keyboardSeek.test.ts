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
    // At 2000 px/s the raw step would be 8 ms: finer than anything audible and too slow
    // to get anywhere with.
    expect(keyboardSeekStepSec(2000)).toBe(MIN_STEP_SEC);
    expect(keyboardSeekStepSec(100000)).toBe(MIN_STEP_SEC);
  });

  it("clamps to something readable when zoomed right out", () => {
    // At 5 px/s the raw step would be 3.2 s, which skips whole phrases.
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
