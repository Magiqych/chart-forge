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
import { noteMarks, styleFor } from "../web/note-renderer.js";
import { NOTE_STYLES, FLICK_VARIANTS, RIBBONS, SIZES } from "../web/note-theme.js";

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
    // appears. A violet head and an arrow is how this Player says it.
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

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

/**
 * Enough colour arithmetic to ask the questions below, and no more.
 *
 * These are not a taste test. `note-theme.js` and the Player's README both state the palette
 * as rules with numbers in them — the kinds sit at least 45 degrees of hue apart, none of
 * them shares the pale blue the stage furniture is drawn in, the two flick sides are a fixed
 * lightness apart, each band carries its head's hue — and a rule written down in two places
 * and checked in none is a rule that quietly stops being true. The alternative is a
 * screenshot and an opinion, which is the thing this file exists to avoid.
 */
function channels(colour) {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(colour);
  assert.ok(rgb, `not a colour this test can read: ${colour}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

/** Hue in degrees, or null for a grey, which has none. */
function hueOf(colour) {
  const [r, g, b] = channels(colour).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null;
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return (hue + 360) % 360;
}

/** CIE L*: perceived lightness, which is what survives a greyscale photograph of the screen. */
function lightnessOf(colour) {
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(colour);
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
}

/** The shorter way round the wheel between two hues. */
function hueGap(a, b) {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

/** The hue the stage is drawn in: lane edges, tap targets, the link between them, the stars. */
const STAGE_HUE = 214;

describe("the palette", () => {
  it("keeps the four kinds at least 45 degrees of hue apart", () => {
    const kinds = ["tap", "hold", "slide", "flick"];
    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        const gap = hueGap(
          hueOf(NOTE_STYLES[kinds[i]].interior[1]),
          hueOf(NOTE_STYLES[kinds[j]].interior[1]),
        );
        assert.ok(gap >= 45, `${kinds[i]} and ${kinds[j]} are only ${gap.toFixed(1)} degrees apart`);
      }
    }
  });

  it("keeps every note out of the pale blue the stage is drawn in", () => {
    // A note the colour of the floor it lands on is a note competing with the floor. The
    // grey fallback is exempt: it has a hue on paper and none to the eye.
    for (const name of ["tap", "hold", "slide", "flick", "flickLeft", "flickRight"]) {
      const gap = hueGap(hueOf(NOTE_STYLES[name].interior[1]), STAGE_HUE);
      assert.ok(gap >= 30, `${name} sits ${gap.toFixed(1)} degrees from the stage's own hue`);
    }
  });

  it("gives the grey fallback no hue worth reading", () => {
    const [r, g, b] = channels(NOTE_STYLES.other.interior[1]);
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    assert.ok(saturation < 0.12, `the unknown-type grey is ${(saturation * 100).toFixed(0)}% saturated`);
  });

  it("has every band carry the hue of the heads it joins", () => {
    // A band is legible from further away than a head is, so it is the playfield's earliest
    // warning about what is coming. One that said nothing about which kind would waste that.
    for (const [kind, ribbon] of [["hold", RIBBONS.hold], ["slide", RIBBONS.slide]]) {
      for (const [part, colour] of [["edge", ribbon.edge], ["near fill", ribbon.fill[1]]]) {
        const gap = hueGap(hueOf(colour), hueOf(NOTE_STYLES[kind].interior[1]));
        assert.ok(gap <= 15, `the ${kind} ${part} is ${gap.toFixed(1)} degrees off its own head`);
      }
    }
  });

  it("keeps the two bands far enough apart to be told apart on their own", () => {
    const gap = hueGap(hueOf(RIBBONS.hold.edge), hueOf(RIBBONS.slide.edge));
    assert.ok(gap >= 45, `the two bands are only ${gap.toFixed(1)} degrees apart`);
  });
});

describe("the two sides of a flick", () => {
  it("draws a leftward swipe and a rightward one in different violets", () => {
    const left = styleFor("flick", "left");
    const right = styleFor("flick", "right");
    assert.equal(left, NOTE_STYLES.flickLeft);
    assert.equal(right, NOTE_STYLES.flickRight);
    for (const part of ["interior", "ring", "outline", "glow", "markColour"]) {
      assert.notDeepEqual(left[part], right[part], `left and right share their ${part}`);
    }
  });

  it("keeps both of them violet", () => {
    // The point of the pair is that a flick is still recognisably a flick before the player
    // has read which way it points.
    for (const name of ["flick", "flickLeft", "flickRight"]) {
      const hue = hueOf(NOTE_STYLES[name].interior[1]);
      assert.ok(hue >= 240 && hue <= 310, `${name} is at ${hue.toFixed(1)} degrees, outside the violets`);
    }
  });

  it("leans the left one warm and the right one cool", () => {
    const left = hueOf(NOTE_STYLES.flickLeft.interior[1]);
    const right = hueOf(NOTE_STYLES.flickRight.interior[1]);
    const neutral = hueOf(NOTE_STYLES.flick.interior[1]);
    assert.ok(left > neutral, "the left side should be the redder violet");
    assert.ok(right < neutral, "and the right side the bluer one");
    assert.ok(hueGap(left, right) >= 30, "with a gap worth having between them");
  });

  it("separates them by lightness as well, so the difference survives in greyscale", () => {
    // Forty degrees of violet is not much to judge at speed, and it is the difference a
    // red-green colour vision difference flattens. Lightness does not depend on telling two
    // hues apart at all.
    const gap =
      lightnessOf(NOTE_STYLES.flickLeft.interior[1]) - lightnessOf(NOTE_STYLES.flickRight.interior[1]);
    assert.ok(gap >= 12, `only ${gap.toFixed(1)} L* between the light side and the deep one`);
  });

  it("flips the arrowhead from dark-on-light to light-on-deep", () => {
    // The largest and fastest-read difference on the note, and it needs no colour at all.
    const left = NOTE_STYLES.flickLeft;
    const right = NOTE_STYLES.flickRight;
    assert.ok(
      lightnessOf(left.markColour) < lightnessOf(left.interior[1]) - 30,
      "a dark arrow on the light side",
    );
    assert.ok(
      lightnessOf(right.markColour) > lightnessOf(right.interior[1]) + 30,
      "a light arrow on the deep side",
    );
  });

  it("tints the rims apart too, which is what carries at a distance", () => {
    // The rim is the largest area left on a note small enough that its arrowhead is a few
    // pixels, so it is the last thing to stay readable as one shrinks.
    assert.ok(
      hueGap(hueOf(NOTE_STYLES.flickLeft.ring), hueOf(NOTE_STYLES.flickRight.ring)) >= 30,
      "the two rims should not be the same white",
    );
    assert.ok(lightnessOf(NOTE_STYLES.flickLeft.ring) > 85, "and both should still read as a rim");
    assert.ok(lightnessOf(NOTE_STYLES.flickRight.ring) > 85);
  });

  it("gives every one of the eight compass points a style with an arrow on it", () => {
    for (const direction of DIRECTIONS) {
      const style = styleFor("flick", direction);
      assert.ok(style, `no style for ${direction}`);
      assert.equal(style.mark, "arrow");
    }
  });

  it("sends each diagonal to the side it leans towards", () => {
    assert.equal(styleFor("flick", "upLeft"), NOTE_STYLES.flickLeft);
    assert.equal(styleFor("flick", "downLeft"), NOTE_STYLES.flickLeft);
    assert.equal(styleFor("flick", "upRight"), NOTE_STYLES.flickRight);
    assert.equal(styleFor("flick", "downRight"), NOTE_STYLES.flickRight);
    assert.deepEqual(
      DIRECTIONS.filter((direction) => FLICK_VARIANTS[direction] === undefined).sort(),
      ["down", "up"],
      "only the two directions with no side should fall through",
    );
  });

  it("leaves a flick with no side to take in the neutral violet", () => {
    // `up`, `down`, and a flick the chart gave no direction at all — which the judge accepts
    // from a swipe either way, so the playfield must not claim it wants one.
    assert.equal(styleFor("flick", "up"), NOTE_STYLES.flick);
    assert.equal(styleFor("flick", "down"), NOTE_STYLES.flick);
    assert.equal(styleFor("flick", null), NOTE_STYLES.flick);
  });

  it("is not confused by a direction on something that is not a flick", () => {
    // Nothing sets that today, but `styleFor` is handed whatever `noteMarks` produced, and a
    // side is a flick's business alone.
    assert.equal(styleFor("slide", "left"), NOTE_STYLES.slide);
    assert.equal(styleFor("hold", "right"), NOTE_STYLES.hold);
    assert.equal(styleFor("sparkle", "left"), NOTE_STYLES.other);
  });

  it("gives a long note that ends in a swipe the side its end action names", () => {
    const held = noteMarks(noteById("n-0006")); // hold, endAction flick left
    const slid = noteMarks(noteById("n-0008")); // slide, endAction flick right
    assert.equal(styleFor(held[1].style, held[1].direction), NOTE_STYLES.flickLeft);
    const last = slid[slid.length - 1];
    assert.equal(styleFor(last.style, last.direction), NOTE_STYLES.flickRight);
  });

  it("finds a style for every mark of every chart already written", () => {
    const read = readChart(structuredClone(EXAMPLE));
    for (const note of read.notes) {
      for (const mark of noteMarks(note)) {
        assert.ok(styleFor(mark.style, mark.direction), `${note.id}: ${mark.style}`);
      }
    }
  });
});
