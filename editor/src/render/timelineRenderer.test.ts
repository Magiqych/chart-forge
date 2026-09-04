/**
 * Tests for the ruler's pure helpers.
 *
 * The renderer itself needs a canvas, so it is verified by running the app. These two
 * functions decide what the ruler says, which is checkable without one.
 */

import { describe, expect, it } from "vitest";

import { chooseRulerStep, formatTime } from "./timelineRenderer";

describe("chooseRulerStep", () => {
  it("picks the smallest step that keeps labels at least 70 px apart", () => {
    expect(chooseRulerStep(1000)).toBe(0.1);
    expect(chooseRulerStep(300)).toBe(0.25);
    expect(chooseRulerStep(100)).toBe(1);
    expect(chooseRulerStep(20)).toBe(5);
    expect(chooseRulerStep(5)).toBe(15);
  });

  it("falls back to the coarsest step when even that is too dense", () => {
    expect(chooseRulerStep(0.01)).toBe(300);
  });
});

describe("formatTime", () => {
  it("uses the same precision and width for every value", () => {
    // The defect this guards against: neighbouring ruler labels disagreeing on
    // precision, so "2:09.00" sat next to "2:10.0" and the text shifted off its tick.
    const labels = [127, 128, 129, 130, 131].map(formatTime);
    expect(labels).toEqual(["2:07.00", "2:08.00", "2:09.00", "2:10.00", "2:11.00"]);
    expect(new Set(labels.map((l) => l.length)).size).toBe(1);
  });

  it("splits minutes and seconds", () => {
    expect(formatTime(0)).toBe("0:00.00");
    expect(formatTime(59.5)).toBe("0:59.50");
    expect(formatTime(60)).toBe("1:00.00");
    expect(formatTime(201)).toBe("3:21.00");
  });

  it("carries a rounded-up second into the next minute", () => {
    expect(formatTime(59.999)).toBe("1:00.00");
    expect(formatTime(119.997)).toBe("2:00.00");
  });

  it("clamps negative input to zero", () => {
    expect(formatTime(-1)).toBe("0:00.00");
  });
});
