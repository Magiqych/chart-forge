/**
 * What a note is drawn as.
 *
 * Not the pixels - those need a canvas and an eye - but the decision in front of them:
 * which of the four identities a point of a note takes, which way an arrow points, and
 * which points get one at all. Those are contract readings rather than taste, and getting
 * one of them backwards is the kind of bug a screenshot does not catch and a player finds
 * out about a bar too late.
 *
 * `noteMarks` is pure, so all of it can be asked here without a browser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readChart, noteKind, DIRECTIONS } from "../web/chart.js";
import { noteMarks } from "../web/note-renderer.js";
import { NOTE_STYLES, SIZES } from "../web/note-theme.js";

const MINI = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.chart.json", import.meta.url)), "utf8"),
);
const EXAMPLE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../examples/chart.example.json", import.meta.url)), "utf8"),
);

const chart = readChart(structuredClone(MINI));
const noteById = (id) => chart.notes.find((note) => note.id === id);

describe("the four identities", () => {
  it("gives each kind a hue and a mark of its own", () => {
    // Colour alone is not enough: two notes overlapping near the horizon are a few pixels
    // of one hue on top of another. The mark in the middle is the second answer.
    const kinds = ["tap", "hold", "slide", "flick"];
    const marks = kinds.map((kind) => NOTE_STYLES[kind].mark);
    assert.equal(new Set(marks).size, kinds.length, "every kind needs a distinguishable mark");

    const interiors = kinds.map((kind) => NOTE_STYLES[kind].interior[2]);
    assert.equal(new Set(interiors).size, kinds.length, "and a hue of its own");
  });

  it("keeps a style for a type this Player has never seen", () => {
    // The contract calls `type` an open vocabulary. A word nobody here recognises is still
    // a note to draw, so the fallback has to stay - deleting it would hide a note rather
    // than report it.
    assert.ok(NOTE_STYLES.other);
    assert.ok(NOTE_STYLES.other.interior.length === 3);
  });

  it("draws an unknown type from its shape rather than refusing it", () => {
    const read = readChart({
      version: "0.1.0",
      audio: { path: "x.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [
        { id: "u-1", type: "sparkle", timeSec: 1, lane: 0 },
        { id: "u-2", type: "ribbon", timeSec: 2, lane: 1, endTimeSec: 3 },
        { id: "u-3", type: "swipe", timeSec: 4, lane: 2, direction: "left" },
      ],
    });
    assert.deepEqual(read.unknownNoteTypes, ["sparkle", "ribbon", "swipe"]);
    assert.equal(noteKind(read.notes[0]), "tap");
    assert.equal(noteKind(read.notes[1]), "hold");
    assert.equal(noteKind(read.notes[2]), "flick");
    for (const note of read.notes) {
      for (const mark of noteMarks(note)) {
        assert.ok(NOTE_STYLES[mark.style], `no style for ${mark.style}`);
      }
    }
  });
});

describe("flicks", () => {
  it("points a left flick left and a right flick right", () => {
    // The one mistake in this file that would be invisible in a still and wrong in play.
    const left = noteMarks(noteById("n-0005"));
    const right = noteMarks(noteById("n-0004"));
    assert.equal(left.length, 1);
    assert.equal(left[0].direction, "left");
    assert.equal(left[0].style, "flick");
    assert.equal(right[0].direction, "right");
    assert.equal(right[0].style, "flick");
    assert.notEqual(left[0].direction, right[0].direction);
  });

  it("understands all eight compass points the contract allows", () => {
    for (const direction of DIRECTIONS) {
      const read = readChart({
        version: "0.1.0",
        audio: { path: "x.wav" },
        timing: { offsetSec: 0 },
        playfield: { laneCount: 5 },
        notes: [{ id: "f", type: "flick", timeSec: 1, lane: 2, direction }],
      });
      assert.equal(read.problems.length, 0);
      assert.equal(noteMarks(read.notes[0])[0].direction, direction);
    }
  });

  it("keeps a note's own direction on its start and never lends it to its end", () => {
    // `direction` on a bounded note would be ambiguous about which end it described, which
    // is exactly why the contract has a separate `endAction`. So the start keeps it and the
    // end does not borrow it.
    const read = readChart({
      version: "0.1.0",
      audio: { path: "x.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "h", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2, direction: "right" }],
    });
    const marks = noteMarks(read.notes[0]);
    assert.equal(marks.length, 2);
    assert.equal(marks[0].direction, null, "a held note's start is not a flick");
    assert.equal(marks[1].direction, null, "and its end is a release, not a swipe");
  });

  it("keeps the chain the chart drew between two flicks", () => {
    assert.deepEqual(
      chart.connections,
      [{ type: "flick", fromNoteId: "n-0004", toNoteId: "n-0005" }],
      "a connection is part of the chart and the Player only draws it",
    );
  });
});

describe("ends that are not releases", () => {
  it("draws a flick at the end of a long note that finishes with one", () => {
    // A four-second hold that ends in a swipe looks exactly like one that ends in a release
    // until the last instant, so the end action has to be visible from the moment the note
    // appears. Blue and an arrow is how this Player says it.
    const marks = noteMarks(noteById("n-0006")); // hold, endAction flick left
    assert.equal(marks.length, 2);
    assert.equal(marks[0].style, "hold");
    assert.equal(marks[1].style, "flick");
    assert.equal(marks[1].direction, "left");
  });

  it("does the same at the end of a slide", () => {
    const marks = noteMarks(noteById("n-0008")); // slide, endAction flick right
    assert.equal(marks[0].style, "slide");
    assert.equal(marks[marks.length - 1].style, "flick");
    assert.equal(marks[marks.length - 1].direction, "right");
  });

  it("leaves an ordinary release as the note's own kind", () => {
    const marks = noteMarks(noteById("n-0003")); // plain hold
    assert.equal(marks.length, 2);
    assert.equal(marks[0].style, "hold");
    assert.equal(marks[1].style, "hold");
    assert.equal(marks[1].direction, null);
  });

  it("ignores an end action it has never heard of rather than dropping the note", () => {
    const read = readChart({
      version: "0.1.0",
      audio: { path: "x.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [
        { id: "h", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2, endAction: { type: "pinch" } },
      ],
    });
    const marks = noteMarks(read.notes[0]);
    assert.equal(marks.length, 2);
    assert.equal(marks[1].style, "hold", "an unknown end action still ends the note");
    assert.equal(read.notes[0].endAction.type, "pinch", "and the document is not edited");
  });
});

describe("slides", () => {
  it("draws every waypoint the chart placed, in its own lane and at its own time", () => {
    const marks = noteMarks(noteById("n-0007"));
    assert.deepEqual(
      marks.map((mark) => [mark.timeSec, mark.lane]),
      [[4.5, 0], [4.75, 1], [5.0, 2], [5.25, 3]],
    );
  });

  it("makes a waypoint smaller than a cap, because it is passed through, not struck", () => {
    const marks = noteMarks(noteById("n-0007"));
    assert.equal(marks[0].size, SIZES.note);
    assert.equal(marks[1].size, SIZES.waypoint);
    assert.equal(marks[2].size, SIZES.waypoint);
    assert.equal(marks[3].size, SIZES.note);
    assert.ok(SIZES.waypoint < SIZES.note);
  });

  it("indexes every mark so it can be matched to its judgement point", () => {
    // The renderer asks the judge whether `noteId#index` is still pending. If these fell
    // out of step with `judgePointsOf`, hit notes would stay on screen and missed ones
    // would vanish early.
    for (const note of chart.notes) {
      const marks = noteMarks(note);
      assert.deepEqual(marks.map((mark) => mark.index), marks.map((_, index) => index));
    }
  });
});

describe("the charts already written", () => {
  it("reads the contract's example and finds a style for every mark of it", () => {
    const read = readChart(structuredClone(EXAMPLE));
    assert.equal(read.problems.length, 0, read.problems.join("; "));
    for (const note of read.notes) {
      const marks = noteMarks(note);
      assert.ok(marks.length >= 1);
      for (const mark of marks) assert.ok(NOTE_STYLES[mark.style], `${note.id}: ${mark.style}`);
    }
  });

  it("carries a chart's decorations through untouched", () => {
    const read = readChart(structuredClone(EXAMPLE));
    assert.ok(read.decorations.length > 0);
    // The Player is a reader. A decoration comes back out exactly as it went in, including
    // a kind this Player does not draw.
    const original = [...EXAMPLE.decorations].sort((a, b) => a.startTimeSec - b.startTimeSec);
    assert.deepEqual(read.decorations, original);
  });

  it("still plays a chart with no decorations at all", () => {
    const bare = structuredClone(EXAMPLE);
    delete bare.decorations;
    const read = readChart(bare);
    assert.deepEqual(read.decorations, []);
    assert.ok(read.notes.length > 0);
  });
});
