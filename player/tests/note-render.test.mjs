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

import { readChart, noteKind, notePoints, chartSummary, DIRECTIONS } from "../web/chart.js";
import { noteMarks, styleFor, ribbonFor, drawArrowhead } from "../web/note-renderer.js";
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

  it("gives every kind three gradient stops to be drawn from", () => {
    for (const [name, style] of Object.entries(NOTE_STYLES)) {
      assert.equal(style.interior.length, 3, `${name} needs a light, a body and a shaded stop`);
    }
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
    // appears. A green head and an arrow is how this Player says it.
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

  it("draws the contract's example entirely in the five appearances a player knows", () => {
    // The example chart is the one document in the repository written by the contract rather
    // than by this Player, and it uses a diagonal flick, so it is the honest test of whether
    // the five appearances really cover everything a chart can ask for.
    const read = readChart(structuredClone(EXAMPLE));
    const five = new Set([
      NOTE_STYLES.tap, NOTE_STYLES.hold, NOTE_STYLES.slide,
      NOTE_STYLES.flickLeft, NOTE_STYLES.flickRight,
    ]);
    const seen = new Set();
    for (const note of read.notes) {
      for (const mark of noteMarks(note)) {
        const style = styleFor(mark.style, mark.direction);
        assert.ok(five.has(style), `${note.id} needed an appearance outside the five`);
        seen.add(style);
      }
      if (notePoints(note).length > 1) {
        const band = ribbonFor(note);
        assert.ok(band === RIBBONS.hold || band === RIBBONS.slide || band.widthFactor > 0);
      }
    }
    assert.ok(seen.size >= 4, "and it exercises most of them");
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
 * as rules with numbers in them — the kinds sit at least 45 degrees of hue apart, a slide is
 * violet and a flick is not, none of them shares the pale blue the stage furniture is drawn
 * in, the two flick sides are a fixed lightness apart, each band carries its head's hue — and
 * a rule written down in two places and checked in none is a rule that quietly stops being
 * true. The alternative is a screenshot and an opinion, which is the thing this file avoids.
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

function luminanceOf(colour) {
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(colour);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** CIE L*: perceived lightness, which is what survives a greyscale photograph of the screen. */
function lightnessOf(colour) {
  const y = luminanceOf(colour);
  return y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
}

/** WCAG contrast ratio, used here against the sky rather than against paper. */
function contrastOf(a, b) {
  const x = luminanceOf(a);
  const y = luminanceOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The shorter way round the wheel between two hues. */
function hueGap(a, b) {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

/** The hue the stage is drawn in: lane edges, tap targets, the link between them, the stars. */
const STAGE_HUE = 214;
/** Halfway down the sky's own ramp, which is what a note in flight is seen against. */
const SKY = "#0b1024";
/** What counts as violet. The slide lives in here and nothing else may. */
const VIOLET = [260, 300];

/** The body colour of a style: the middle stop, which covers most of the disc. */
const bodyOf = (name) => NOTE_STYLES[name].interior[1];

describe("the palette", () => {
  it("draws a slide in violet", () => {
    // The one hue in the palette that is assigned rather than chosen: a slide is the violet
    // note, and the rest of the palette is placed around that.
    const hue = hueOf(bodyOf("slide"));
    assert.ok(hue >= VIOLET[0] && hue <= VIOLET[1], `the slide is at ${hue.toFixed(1)} degrees, not violet`);
  });

  it("keeps every flick out of the violet, and well away from the slide", () => {
    for (const name of ["flick", "flickLeft", "flickRight"]) {
      const hue = hueOf(bodyOf(name));
      assert.ok(
        hue < VIOLET[0] || hue > VIOLET[1],
        `${name} is at ${hue.toFixed(1)} degrees, inside the slide's violet`,
      );
      const gap = hueGap(hue, hueOf(bodyOf("slide")));
      assert.ok(gap >= 45, `${name} is only ${gap.toFixed(1)} degrees from the slide`);
    }
  });

  it("keeps the four kinds at least 45 degrees of hue apart", () => {
    const kinds = ["tap", "hold", "slide", "flick"];
    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        const gap = hueGap(hueOf(bodyOf(kinds[i])), hueOf(bodyOf(kinds[j])));
        assert.ok(gap >= 45, `${kinds[i]} and ${kinds[j]} are only ${gap.toFixed(1)} degrees apart`);
      }
    }
  });

  it("keeps every note out of the pale blue the stage is drawn in", () => {
    // A note the colour of the floor it lands on is a note competing with the floor.
    for (const name of Object.keys(NOTE_STYLES)) {
      const gap = hueGap(hueOf(bodyOf(name)), STAGE_HUE);
      assert.ok(gap >= 30, `${name} sits ${gap.toFixed(1)} degrees from the stage's own hue`);
    }
  });

  it("lifts every note clear of the night sky", () => {
    // Nothing may sink into the background it is read against, and the rim is what is left of
    // a note that is only a few pixels across, so it has to be the brightest part.
    for (const name of Object.keys(NOTE_STYLES)) {
      const style = NOTE_STYLES[name];
      assert.ok(
        contrastOf(style.interior[1], SKY) >= 4.5,
        `${name}'s body is only ${contrastOf(style.interior[1], SKY).toFixed(2)}:1 against the sky`,
      );
      assert.ok(
        contrastOf(style.ring, SKY) >= 10,
        `${name}'s rim is only ${contrastOf(style.ring, SKY).toFixed(2)}:1 against the sky`,
      );
    }
  });

  it("gives every mark enough contrast against the body it sits on", () => {
    // A centre mark is the second answer to "which kind is this", so it has to be readable on
    // its own note - which is why the flick arrowheads are not both white.
    for (const name of Object.keys(NOTE_STYLES)) {
      const style = NOTE_STYLES[name];
      if (style.mark === "none") continue;
      const ratio = contrastOf(style.markColour, style.interior[1]);
      assert.ok(ratio >= 1.6, `${name}'s mark is only ${ratio.toFixed(2)}:1 on its own body`);
    }
  });

  it("has every band carry the hue of the heads it joins", () => {
    // A band is legible from further away than a head is, so it is the playfield's earliest
    // warning about what is coming. One that said nothing about which kind would waste that.
    for (const [kind, ribbon] of [["hold", RIBBONS.hold], ["slide", RIBBONS.slide]]) {
      for (const [part, colour] of [["edge", ribbon.edge], ["near fill", ribbon.fill[1]]]) {
        const gap = hueGap(hueOf(colour), hueOf(bodyOf(kind)));
        assert.ok(gap <= 15, `the ${kind} ${part} is ${gap.toFixed(1)} degrees off its own head`);
      }
    }
  });

  it("keeps the two bands far enough apart to be told apart on their own", () => {
    const gap = hueGap(hueOf(RIBBONS.hold.edge), hueOf(RIBBONS.slide.edge));
    assert.ok(gap >= 45, `the two bands are only ${gap.toFixed(1)} degrees apart`);
  });

  it("has no style for a fifth kind of note", () => {
    // The note kinds are the contract's four. A grey `other` style used to sit here for a
    // `type` this Player had not met; it was unreachable, and a fifth identity on the
    // playfield was a kind of note that does not exist.
    assert.deepEqual(
      Object.keys(NOTE_STYLES).sort(),
      ["flick", "flickLeft", "flickRight", "hold", "slide", "tap"],
      "the only styles are the four kinds plus the two sides of a flick",
    );
    assert.equal(NOTE_STYLES.other, undefined);
  });
});

describe("the two sides of a flick", () => {
  it("draws a leftward swipe and a rightward one differently in every part", () => {
    const left = styleFor("flick", "left");
    const right = styleFor("flick", "right");
    assert.equal(left, NOTE_STYLES.flickLeft);
    assert.equal(right, NOTE_STYLES.flickRight);
    for (const part of ["interior", "ring", "outline", "glow", "markColour"]) {
      assert.notDeepEqual(left[part], right[part], `left and right share their ${part}`);
    }
  });

  it("separates them by hue", () => {
    const gap = hueGap(hueOf(bodyOf("flickLeft")), hueOf(bodyOf("flickRight")));
    assert.ok(gap >= 45, `only ${gap.toFixed(1)} degrees between the two sides`);
  });

  it("makes the left one the warmer green and the right one the cooler", () => {
    // Both in the green band, one leaning yellow and one leaning blue, with the kind's own
    // colour between them - so an unsided flick cannot be read as either side.
    const left = hueOf(bodyOf("flickLeft"));
    const right = hueOf(bodyOf("flickRight"));
    const own = hueOf(bodyOf("flick"));
    assert.ok(left < own, "the left side should be the yellower green");
    assert.ok(right > own, "and the right side the bluer one");
  });

  it("separates them by lightness as well, so the difference survives in greyscale", () => {
    // Hue is the first thing a colour vision difference flattens. Lightness does not depend
    // on telling two hues apart at all.
    const gap = lightnessOf(bodyOf("flickLeft")) - lightnessOf(bodyOf("flickRight"));
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
  });

  it("points a left flick left and a right flick right", () => {
    // The one mistake in this file that would be invisible in a still and wrong in play, so
    // it is asked of the drawing rather than of the table the drawing reads.
    const tipOf = (direction) => {
      const recorder = recordingContext();
      drawArrowhead(recorder.ctx, { x: 0, y: 0 }, direction, 10);
      return recorder.points[0];
    };
    const left = tipOf("left");
    const right = tipOf("right");
    assert.ok(right.x > 0.5, `a right flick's tip should be to the right, was x=${right.x.toFixed(2)}`);
    assert.ok(left.x < -0.5, `a left flick's tip should be to the left, was x=${left.x.toFixed(2)}`);
    assert.ok(Math.abs(left.x + right.x) < 1e-9, "and the two should be mirror images");
    assert.ok(Math.abs(left.y) < 1e-9 && Math.abs(right.y) < 1e-9, "both level with the centre");
  });

  it("draws an arrowhead for every direction the contract allows", () => {
    for (const direction of DIRECTIONS) {
      const recorder = recordingContext();
      drawArrowhead(recorder.ctx, { x: 0, y: 0 }, direction, 10);
      assert.ok(recorder.points.length >= 4, `nothing drawn for ${direction}`);
      assert.equal(styleFor("flick", direction).mark, "arrow", `${direction} lost its arrow`);
    }
  });
});

describe("flicks the Editor does not author", () => {
  it("sends each diagonal to the side it leans towards", () => {
    // The contract enumerates all eight compass points and its own example chart uses a
    // diagonal, so these are drawn rather than refused. A hand swiping upLeft is going left.
    assert.equal(styleFor("flick", "upLeft"), NOTE_STYLES.flickLeft);
    assert.equal(styleFor("flick", "downLeft"), NOTE_STYLES.flickLeft);
    assert.equal(styleFor("flick", "upRight"), NOTE_STYLES.flickRight);
    assert.equal(styleFor("flick", "downRight"), NOTE_STYLES.flickRight);
  });

  it("falls back to the kind's own colour when there is no side to take", () => {
    assert.equal(styleFor("flick", "up"), NOTE_STYLES.flick);
    assert.equal(styleFor("flick", "down"), NOTE_STYLES.flick);
    assert.equal(styleFor("flick", null), NOTE_STYLES.flick);
    assert.deepEqual(
      DIRECTIONS.filter((direction) => FLICK_VARIANTS[direction] === undefined).sort(),
      ["down", "up"],
      "only the two directions with no side should fall through",
    );
  });

  it("never invents a note kind for one of them", () => {
    // The point of the fallback. Whatever the chart asks for, the playfield has five
    // appearances and not six, and every unsided flick wears the plain flick.
    const allowed = new Set([NOTE_STYLES.flick, NOTE_STYLES.flickLeft, NOTE_STYLES.flickRight]);
    for (const direction of [...DIRECTIONS, null, "sideways", "widdershins"]) {
      assert.ok(allowed.has(styleFor("flick", direction)), `${direction} escaped the flick styles`);
    }
  });

  it("reads every direction the contract allows onto the note that asked for it", () => {
    for (const direction of DIRECTIONS) {
      const read = readChart({
        version: "0.1.0",
        audio: { path: "x.wav" },
        timing: { offsetSec: 0 },
        playfield: { laneCount: 5 },
        notes: [{ id: "f", type: "flick", timeSec: 1, lane: 2, direction }],
      });
      assert.equal(read.problems.length, 0);
      const [mark] = noteMarks(read.notes[0]);
      assert.equal(mark.direction, direction, "the chart's own word, unchanged");
      assert.equal(mark.style, "flick", "and still one kind of note");
    }
  });

  it("gives a long note that ends in a swipe the side its end action names", () => {
    const held = noteMarks(noteById("n-0006")); // hold, endAction flick left
    const slid = noteMarks(noteById("n-0008")); // slide, endAction flick right
    assert.equal(styleFor(held[1].style, held[1].direction), NOTE_STYLES.flickLeft);
    const last = slid[slid.length - 1];
    assert.equal(styleFor(last.style, last.direction), NOTE_STYLES.flickRight);
  });

  it("applies the same rule to an end action the Editor does not author", () => {
    const read = readChart({
      version: "0.1.0",
      audio: { path: "x.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [
        { id: "a", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2, endAction: { type: "flick", direction: "downRight" } },
        { id: "b", type: "hold", timeSec: 3, lane: 2, endTimeSec: 4, endAction: { type: "flick", direction: "up" } },
      ],
    });
    const [a, b] = read.notes.map((note) => noteMarks(note));
    assert.equal(styleFor(a[1].style, a[1].direction), NOTE_STYLES.flickRight, "a diagonal end takes its side");
    assert.equal(styleFor(b[1].style, b[1].direction), NOTE_STYLES.flick, "an upward end has no side to take");
  });
});

describe("a type this Player has never met", () => {
  const UNFAMILIAR = {
    version: "0.1.0",
    audio: { path: "x.wav" },
    timing: { offsetSec: 0 },
    playfield: { laneCount: 5 },
    notes: [
      { id: "u-1", type: "sparkle", timeSec: 1, lane: 0 },
      { id: "u-2", type: "ribbon", timeSec: 2, lane: 1, endTimeSec: 3 },
      { id: "u-3", type: "swipe", timeSec: 4, lane: 2, direction: "left" },
      { id: "u-4", type: "purple", timeSec: 5, lane: 3, endTimeSec: 6, endLane: 4 },
    ],
  };

  it("is never drawn as a grey note of its own", () => {
    // What this replaces: an unfamiliar type used to have a grey fifth style waiting for it.
    const read = readChart(structuredClone(UNFAMILIAR));
    const known = new Set(Object.values(NOTE_STYLES));
    for (const note of read.notes) {
      for (const mark of noteMarks(note)) {
        const style = styleFor(mark.style, mark.direction);
        assert.ok(known.has(style), `${note.id} got a style from outside the palette`);
        assert.ok(style.interior.some((stop) => hueOf(stop) !== null), `${note.id} was drawn without a hue`);
      }
    }
  });

  it("is read from its own fields into one of the four kinds", () => {
    // Not forced into one particular kind: `judgePointsOf` reads the same fields, so a note
    // with a length is judged as held however it is labelled. Drawing it as anything else
    // would have the playfield telling the player to do something the judge will not accept.
    const read = readChart(structuredClone(UNFAMILIAR));
    assert.deepEqual(read.notes.map((note) => noteKind(note)), ["tap", "hold", "flick", "slide"]);
    assert.deepEqual(read.unknownNoteTypes, ["sparkle", "ribbon", "swipe", "purple"], "and reported, not hidden");
  });

  it("falls back to a flick when even the kind cannot be placed", () => {
    // The last resort in `styleFor`. Nothing reaches it today, because `noteKind` always
    // answers with one of the four - but when something does, it is a flick and not a grey.
    assert.equal(styleFor("sparkle"), NOTE_STYLES.flick);
    assert.equal(styleFor("sparkle", "left"), NOTE_STYLES.flick, "a side belongs to a flick alone");
    assert.equal(styleFor(undefined), NOTE_STYLES.flick);
  });

  it("is not confused by a direction on something that is not a flick", () => {
    assert.equal(styleFor("slide", "left"), NOTE_STYLES.slide);
    assert.equal(styleFor("hold", "right"), NOTE_STYLES.hold);
  });

  it("is counted as the kind it turns out to be, with no bin of its own", () => {
    const read = readChart(structuredClone(UNFAMILIAR));
    const summary = chartSummary(read);
    assert.deepEqual(summary.counts, { tap: 1, hold: 1, slide: 1, flick: 1 });
    assert.equal(summary.counts.other, undefined, "no fifth number on the start screen");
    const total = Object.values(summary.counts).reduce((sum, n) => sum + n, 0);
    assert.equal(total, summary.noteCount, "every note is counted exactly once");
  });
});

describe("which band a note trails", () => {
  const read = (notes) =>
    readChart({
      version: "0.1.0",
      audio: { path: "x.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes,
    }).notes[0];

  const hueOfBand = (ribbon) => hueOf(ribbon.edge);

  it("gives a long note its own hue and a slide its own", () => {
    const long = read([{ id: "a", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2 }]);
    const slide = read([{ id: "b", type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3 }]);
    assert.equal(hueOfBand(ribbonFor(long)), hueOf(RIBBONS.hold.edge));
    assert.equal(hueOfBand(ribbonFor(slide)), hueOf(RIBBONS.slide.edge));
    assert.ok(hueGap(hueOfBand(ribbonFor(long)), hueOf(bodyOf("hold"))) <= 15, "the long band matches its head");
    assert.ok(hueGap(hueOfBand(ribbonFor(slide)), hueOf(bodyOf("slide"))) <= 15, "the slide band matches its nodes");
  });

  it("does not turn a long note's band violet because it crosses lanes", () => {
    // The bug this rule replaces: the band used to be chosen by whether the note travelled,
    // so a Long with an `endLane` grew an amber head on a violet band.
    for (const notes of [
      [{ id: "a", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3 }],
      [{ id: "b", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2, waypoints: [{ timeSec: 1.5, lane: 2 }] }],
    ]) {
      const note = read(notes);
      assert.equal(noteKind(note), "hold");
      assert.equal(
        hueOfBand(ribbonFor(note)),
        hueOf(RIBBONS.hold.edge),
        "a long note that travels is still a long note",
      );
    }
  });

  it("still narrows a band that travels, because that is about the geometry", () => {
    // Colour says which kind; width says whether the hand moves. Separating the two is the
    // whole point, so both halves are checked.
    const still = read([{ id: "a", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2 }]);
    const travelling = read([{ id: "b", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3 }]);
    assert.equal(ribbonFor(still).widthFactor, SIZES.holdRibbon);
    assert.equal(ribbonFor(travelling).widthFactor, SIZES.slideRibbon);
    assert.ok(SIZES.slideRibbon < SIZES.holdRibbon);
  });

  it("leaves a slide at the travelling width and the theme's own objects untouched", () => {
    const slide = read([{ id: "b", type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3 }]);
    assert.equal(ribbonFor(slide), RIBBONS.slide, "no copy needed when the width already agrees");
    const still = read([{ id: "a", type: "hold", timeSec: 1, lane: 2, endTimeSec: 2 }]);
    assert.equal(ribbonFor(still), RIBBONS.hold);
  });
});

/**
 * A canvas that remembers where it was asked to draw.
 *
 * Only as much of the 2D context as `drawArrowhead` touches, and it tracks `translate` and
 * `rotate` itself, because the question being asked - does a left flick point left - is a
 * question about the transform.
 */
function recordingContext() {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const points = [];
  const apply = (x, y) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  });
  const multiply = (m) => {
    const [a, b, c, d, e, f] = matrix;
    matrix = [
      a * m[0] + c * m[1],
      b * m[0] + d * m[1],
      a * m[2] + c * m[3],
      b * m[2] + d * m[3],
      a * m[4] + c * m[5] + e,
      b * m[4] + d * m[5] + f,
    ];
  };
  const ctx = {
    save() { stack.push([...matrix]); },
    restore() { matrix = stack.pop() ?? matrix; },
    translate(x, y) { multiply([1, 0, 0, 1, x, y]); },
    rotate(angle) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      multiply([cos, sin, -sin, cos, 0, 0]);
    },
    beginPath() { },
    closePath() { },
    fill() { },
    stroke() { },
    arc() { },
    moveTo(x, y) { points.push(apply(x, y)); },
    lineTo(x, y) { points.push(apply(x, y)); },
  };
  return { ctx, points };
}
