import { describe, expect, it } from "vitest";

import { DIRECTIONS } from "../core/chart";
import { DIRECTION_VECTORS, flickScreenDirection } from "./notesRenderer";

describe("the direction a flick indicator points", () => {
  it("points left for left and right for right", () => {
    expect(DIRECTION_VECTORS["left"]).toEqual({ x: -1, y: 0 });
    expect(DIRECTION_VECTORS["right"]).toEqual({ x: 1, y: 0 });
    expect(DIRECTION_VECTORS["left"]!.x).toBe(-DIRECTION_VECTORS["right"]!.x);
  });

  it("knows every direction the contract allows", () => {
    // The Editor authors two of them, but a chart from elsewhere may carry any of the
    // eight, and drawing what is there beats drawing nothing.
    for (const direction of DIRECTIONS) {
      expect(DIRECTION_VECTORS[direction]).toBeDefined();
    }
  });

  it("uses screen coordinates, where up is negative", () => {
    expect(DIRECTION_VECTORS["up"]!.y).toBeLessThan(0);
    expect(DIRECTION_VECTORS["down"]!.y).toBeGreaterThan(0);
  });

  it("gives every direction a unit vector", () => {
    for (const direction of DIRECTIONS) {
      const v = DIRECTION_VECTORS[direction]!;
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 3);
    }
  });

  it("makes the diagonals agree with their names", () => {
    expect(DIRECTION_VECTORS["upLeft"]!.x).toBeLessThan(0);
    expect(DIRECTION_VECTORS["upLeft"]!.y).toBeLessThan(0);
    expect(DIRECTION_VECTORS["downRight"]!.x).toBeGreaterThan(0);
    expect(DIRECTION_VECTORS["downRight"]!.y).toBeGreaterThan(0);
  });

  it("draws nothing for a direction nobody has heard of", () => {
    expect(DIRECTION_VECTORS["sideways"]).toBeUndefined();
  });
});

describe("how a flick is drawn on this timeline", () => {
  it("draws left as up and right as down", () => {
    // The horizontal axis here is time, so a left-pointing arrow beside a note reads as
    // "earlier", which is not what a flick direction means. Putting the pair on the axis
    // that is not time keeps the indicator from making a claim about timing.
    expect(flickScreenDirection("left")).toBe("up");
    expect(flickScreenDirection("right")).toBe("down");
  });

  it("gives the two opposite vertical directions, and no horizontal component", () => {
    const left = DIRECTION_VECTORS[flickScreenDirection("left")]!;
    const right = DIRECTION_VECTORS[flickScreenDirection("right")]!;
    expect(left.x).toBe(0);
    expect(right.x).toBe(0);
    expect(left.y).toBe(-right.y);
    expect(left.y).toBeLessThan(0);
    expect(right.y).toBeGreaterThan(0);
  });

  it("changes nothing about what is stored", () => {
    // The mapping is a drawing convention. `direction` on disk stays left and right, and
    // the round-trip test in the chart model is what holds that down.
    expect(flickScreenDirection("left")).not.toBe("left");
    expect(["up", "down"]).toContain(flickScreenDirection("left"));
  });

  it("leaves every other direction pointing where it says", () => {
    for (const direction of ["up", "down", "upLeft", "upRight", "downLeft", "downRight"]) {
      expect(flickScreenDirection(direction)).toBe(direction);
    }
  });
});
