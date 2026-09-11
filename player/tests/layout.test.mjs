/**
 * Where a note is, and which notes are worth drawing.
 *
 * The whole point of the layout module is that position is a function of time, so most
 * of this file is checking that: the same time gives the same place, twice as far away
 * in time is drawn further away, and nothing accumulates.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readChart } from "../web/chart.js";
import {
  BASE_TRAVEL_SEC, travelSecFor, progressOf, project, playfieldGeometry,
  laneCentreX, positionOf, upperBoundByTime, visibleNotes, visibleDecorations,
} from "../web/layout.js";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.chart.json", import.meta.url)), "utf8"),
);
const chart = readChart(structuredClone(FIXTURE));
const geometry = playfieldGeometry(1280, 720, 5);

describe("time to position", () => {
  it("is 0 when a note appears and 1 when it arrives", () => {
    assert.ok(Math.abs(progressOf(10, 10 - BASE_TRAVEL_SEC, BASE_TRAVEL_SEC)) < 1e-12);
    assert.equal(progressOf(10, 10, BASE_TRAVEL_SEC), 1);
  });

  it("passes 1 once the moment is behind the playhead", () => {
    assert.ok(progressOf(10, 10.1, BASE_TRAVEL_SEC) > 1);
  });

  it("depends on nothing but the two times and the travel", () => {
    const a = progressOf(12.345, 11.1, 1.6);
    const b = progressOf(12.345, 11.1, 1.6);
    assert.equal(a, b);
  });

  it("shortens the journey as the note speed goes up, and clamps at the ends", () => {
    assert.equal(travelSecFor(1), BASE_TRAVEL_SEC);
    assert.ok(travelSecFor(2) < travelSecFor(1));
    assert.equal(travelSecFor(99), travelSecFor(4));
    assert.equal(travelSecFor(0), travelSecFor(0.5));
  });

  it("lands exactly on the judgement line and exactly on the horizon", () => {
    const far = positionOf(geometry, 2, 0);
    const near = positionOf(geometry, 2, 1);
    assert.ok(Math.abs(near.y - geometry.judgeY) < 1e-9);
    assert.ok(Math.abs(far.y - geometry.topY) < 1e-9);
    assert.equal(near.scale, 1);
    assert.ok(far.scale < 1, "the far end is smaller");
  });

  it("moves monotonically down the screen as the note comes", () => {
    let previous = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const y = positionOf(geometry, 0, p).y;
      assert.ok(y > previous, `y must increase at progress ${p.toFixed(2)}`);
      previous = y;
    }
  });

  it("draws lanes converging on the centre as they go back", () => {
    const near = positionOf(geometry, 0, 1);
    const far = positionOf(geometry, 0, 0);
    assert.ok(Math.abs(far.x - geometry.centreX) < Math.abs(near.x - geometry.centreX));
    assert.equal(near.x, laneCentreX(geometry, 0));
  });

  it("keeps the projection finite a little past the line", () => {
    const overshoot = project(1.6);
    assert.ok(Number.isFinite(overshoot.scale) && overshoot.scale > 1);
  });
});

describe("which notes are on screen", () => {
  it("finds the note that is arriving", () => {
    const visible = visibleNotes(chart, 0.9, 1.1).map((note) => note.id);
    assert.deepEqual(visible, ["n-0001"]);
  });

  it("still finds a long note whose start has already gone past", () => {
    // n-0009 runs 6.75 to 7.75; at 7.5 its start is well behind the window's left edge.
    const visible = visibleNotes(chart, 7.4, 7.6).map((note) => note.id);
    assert.deepEqual(visible, ["n-0009"]);
  });

  it("returns them in time order", () => {
    const visible = visibleNotes(chart, 0, 10);
    assert.equal(visible.length, chart.notes.length);
    for (let i = 1; i < visible.length; i += 1) {
      assert.ok(visible[i - 1].timeSec <= visible[i].timeSec);
    }
  });

  it("returns nothing before the first note and nothing after the last", () => {
    assert.deepEqual(visibleNotes(chart, 0, 0.5), []);
    assert.deepEqual(visibleNotes(chart, 20, 21), []);
  });

  it("agrees with a full scan of the chart, at every moment of it", () => {
    // The windowing is an optimisation; this is the definition it has to match.
    for (let t = 0; t < 9; t += 0.1) {
      const from = t - 0.35;
      const to = t + 1.2;
      const naive = chart.notes
        .filter((note, index) => note.timeSec <= to && chart.endTimes[index] >= from)
        .map((note) => note.id);
      assert.deepEqual(visibleNotes(chart, from, to).map((note) => note.id), naive, `at ${t.toFixed(1)}s`);
    }
  });

  it("finds the boundary with a binary search", () => {
    assert.equal(upperBoundByTime(chart.notes, 0), 0);
    assert.equal(upperBoundByTime(chart.notes, 1.0), 1);
    assert.equal(upperBoundByTime(chart.notes, 100), chart.notes.length);
  });
});

describe("which decorations are showing", () => {
  it("shows one inside its window and not outside it", () => {
    assert.equal(visibleDecorations(chart.decorations, 1.5).length, 1);
    assert.equal(visibleDecorations(chart.decorations, 0.5).length, 0);
  });

  it("gives a decoration with no end the reader's default duration", () => {
    // dec-0002 starts at 3.0 and names no end.
    assert.equal(visibleDecorations(chart.decorations, 3.5).length, 1);
    assert.equal(visibleDecorations(chart.decorations, 4.5).length, 0);
  });

  it("sorts by zIndex so the painting order is the chart's, not the array's", () => {
    const shown = visibleDecorations(
      [
        { id: "b", type: "text", startTimeSec: 0, endTimeSec: 2, zIndex: 5, position: { x: 0, y: 0 } },
        { id: "a", type: "text", startTimeSec: 0, endTimeSec: 2, zIndex: 1, position: { x: 0, y: 0 } },
      ],
      1,
    );
    assert.deepEqual(shown.map((entry) => entry.decoration.id), ["a", "b"]);
  });
});
