/**
 * Reading a Chart document.
 *
 * The fixture beside this file is a small chart written for these tests. The real chart
 * this Player was built against is not in the repository and is never loaded here: it is
 * the author's work, it is read-only, and a test that depended on it would break the
 * moment they edited a note.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readChart, judgePointsOf, notePoints, noteKind, chartSummary, buildJudgePoints } from "../web/chart.js";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.chart.json", import.meta.url)), "utf8"),
);

export function loadFixture() {
  return readChart(structuredClone(FIXTURE));
}

describe("readChart", () => {
  it("reads the playfield, the notes and the links between them", () => {
    const chart = loadFixture();
    assert.equal(chart.laneCount, 5);
    assert.equal(chart.notes.length, 9);
    assert.equal(chart.connections.length, 1);
    assert.deepEqual(chart.problems, []);
    assert.equal(chart.title, "Player test fixture");
  });

  it("keeps notes in ascending time whatever order the document used", () => {
    const shuffled = structuredClone(FIXTURE);
    shuffled.notes.reverse();
    const chart = readChart(shuffled);
    for (let i = 1; i < chart.notes.length; i += 1) {
      assert.ok(chart.notes[i - 1].timeSec <= chart.notes[i].timeSec);
    }
  });

  it("does not apply timing.offsetSec to note times", () => {
    // The schema calls offsetSec the moment musical time zero happens, not a playback
    // correction, and note times are already seconds from the start of the audio.
    const shifted = structuredClone(FIXTURE);
    shifted.timing.offsetSec = 12.5;
    const chart = readChart(shifted);
    assert.equal(chart.notes[0].timeSec, 1.0);
    assert.equal(chart.gridOffsetSec, 12.5);
  });

  it("drops a note in a lane the playfield does not have, and says so", () => {
    const broken = structuredClone(FIXTURE);
    broken.notes.push({ id: "n-bad", type: "tap", timeSec: 7.9, lane: 9 });
    const chart = readChart(broken);
    assert.equal(chart.notes.find((note) => note.id === "n-bad"), undefined);
    assert.match(chart.problems.join(" "), /outside 0\.\.4/);
  });

  it("plays a note type it has never seen, from that note's own fields", () => {
    const strange = structuredClone(FIXTURE);
    strange.notes.push({ id: "n-purple", type: "purple", timeSec: 7.8, lane: 2 });
    const chart = readChart(strange);
    const note = chart.notes.find((entry) => entry.id === "n-purple");
    assert.ok(note, "the note survives");
    assert.deepEqual(chart.unknownNoteTypes, ["purple"]);
    // No end and no direction: it is judged as a single press, which is what its fields say.
    assert.deepEqual(judgePointsOf(note).map((point) => point.kind), ["tap"]);
  });

  it("ignores a connection that names a note which is not there", () => {
    const dangling = structuredClone(FIXTURE);
    dangling.connections.push({ type: "flick", fromNoteId: "n-0004", toNoteId: "n-nowhere" });
    const chart = readChart(dangling);
    assert.equal(chart.connections.length, 1);
    assert.match(chart.problems.join(" "), /not in the chart/);
  });

  it("refuses a document that is not a chart at all", () => {
    assert.throws(() => readChart({ version: "0.1.0" }), /playfield/);
    assert.throws(() => readChart({ version: "0.1.0", playfield: { laneCount: 5 } }), /notes/);
  });
});

describe("judgement points", () => {
  const chart = loadFixture();
  const byId = new Map(chart.notes.map((note) => [note.id, note]));

  it("gives a tap one moment", () => {
    assert.deepEqual(judgePointsOf(byId.get("n-0001")).map((p) => p.kind), ["tap"]);
  });

  it("gives a flick one moment, carrying its direction", () => {
    const [point] = judgePointsOf(byId.get("n-0004"));
    assert.equal(point.kind, "flick");
    assert.equal(point.direction, "right");
  });

  it("gives a long note a press and a release", () => {
    const points = judgePointsOf(byId.get("n-0003"));
    assert.deepEqual(points.map((p) => p.kind), ["hold-start", "release"]);
    assert.equal(points[1].timeSec, 3.0);
    assert.equal(points[1].lane, 1, "a long note ends in the lane it started in");
  });

  it("makes a long note's end a flick when the chart says so", () => {
    const points = judgePointsOf(byId.get("n-0006"));
    assert.deepEqual(points.map((p) => p.kind), ["hold-start", "flick-end"]);
    assert.equal(points[1].direction, "left");
  });

  it("walks a slide through every waypoint, in order, and ends where it ends", () => {
    const points = judgePointsOf(byId.get("n-0007"));
    assert.deepEqual(points.map((p) => p.kind), ["hold-start", "waypoint", "waypoint", "release"]);
    assert.deepEqual(points.map((p) => p.lane), [0, 1, 2, 3]);
    assert.deepEqual(points.map((p) => p.timeSec), [4.5, 4.75, 5.0, 5.25]);
  });

  it("ends a slide with a flick when it has an end action", () => {
    const points = judgePointsOf(byId.get("n-0008"));
    assert.deepEqual(points.map((p) => p.kind), ["hold-start", "flick-end"]);
    assert.equal(points[1].lane, 2);
    assert.equal(points[1].direction, "right");
  });

  it("puts every point of the chart in time order, including a slide's middle", () => {
    const points = buildJudgePoints(chart.notes);
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i - 1].timeSec <= points[i].timeSec, `${points[i - 1].id} before ${points[i].id}`);
    }
    assert.equal(points.length, chart.points.length);
  });

  it("reads waypoints in the order they are reached even if the file listed them out of order", () => {
    const scrambled = structuredClone(FIXTURE);
    const slide = scrambled.notes.find((note) => note.id === "n-0007");
    slide.waypoints.reverse();
    const note = readChart(scrambled).notes.find((entry) => entry.id === "n-0007");
    assert.deepEqual(notePoints(note).map((p) => p.timeSec), [4.5, 4.75, 5.0, 5.25]);
  });
});

describe("noteKind", () => {
  it("uses the declared type when it is one this Player draws", () => {
    const chart = loadFixture();
    const byId = new Map(chart.notes.map((note) => [note.id, note]));
    assert.equal(noteKind(byId.get("n-0001")), "tap");
    assert.equal(noteKind(byId.get("n-0003")), "hold");
    assert.equal(noteKind(byId.get("n-0007")), "slide");
    assert.equal(noteKind(byId.get("n-0004")), "flick");
  });

  it("falls back to the note's shape for a type it does not know", () => {
    const shape = (fields) => noteKind({ type: "mystery", waypoints: [], endTimeSec: null, endLane: null, direction: null, ...fields });
    assert.equal(shape({ timeSec: 0 }), "tap");
    assert.equal(shape({ timeSec: 0, direction: "left" }), "flick");
    assert.equal(shape({ timeSec: 0, endTimeSec: 1 }), "hold");
    assert.equal(shape({ timeSec: 0, endTimeSec: 1, endLane: 3 }), "slide");
  });
});

describe("chartSummary", () => {
  it("counts what the start screen shows", () => {
    const summary = chartSummary(loadFixture());
    assert.equal(summary.noteCount, 9);
    assert.equal(summary.counts.tap, 2);
    assert.equal(summary.counts.hold, 3);
    assert.equal(summary.counts.slide, 2);
    assert.equal(summary.counts.flick, 2);
    assert.equal(summary.connectionCount, 1);
    assert.equal(summary.decorationCount, 2);
  });
});
