/**
 * The space notes fly through.
 *
 * The geometry is the part of the Player that a screenshot cannot check and a player
 * cannot feel going wrong until it is badly wrong, so it is the part with the most tests.
 * Nearly all of them are one idea in different clothes: **a position is a function of
 * chart time and nothing else.** That single property is what makes the Player correct
 * under a dropped frame, a seek, a pause, a change of playback rate and a machine running
 * at a different refresh rate, and every one of those is checked here as its own case
 * rather than trusted to follow.
 *
 * The other half is that the flight has to end in exactly the right place: a note's centre
 * at its hit time must be the centre of the tap target it is asking the player to press.
 * Everything about the look of this Player can be argued over; that cannot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readChart, notePoints } from "../web/chart.js";
import {
  WORLD,
  flightPhase,
  clampPhase,
  depthAtPhase,
  heightAtPhase,
  projectionOf,
  playfieldGeometry,
  laneCentreX,
  positionOf,
  positionBetween,
  noteRadiusAt,
  ribbonHalfWidth,
  clipFlightSpan,
  sampleRibbon,
} from "../web/note-space.js";
import { BASE_TRAVEL_SEC, travelSecFor } from "../web/layout.js";

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"));

const MINI = fixture("./fixtures/mini.chart.json");
const EXAMPLE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../examples/chart.example.json", import.meta.url)), "utf8"),
);

const chart = readChart(structuredClone(MINI));
const geometry = playfieldGeometry(1920, 1080, 5);
const APPROACH = travelSecFor(1.4);

/** Where a note's centre is drawn at a given chart time. */
function noteAt(note, chartTimeSec, approachSec = APPROACH, geo = geometry) {
  return positionOf(geo, note.lane, flightPhase(note.timeSec, chartTimeSec, approachSec));
}

/** The centre of a lane's tap target: phase 1 is, by definition, the tap line. */
function tapCentre(lane, geo = geometry) {
  return positionOf(geo, lane, 1);
}

// ---------------------------------------------------------------------------

describe("the world model", () => {
  it("closes the depth at a constant rate and ends exactly at the tap line", () => {
    assert.equal(depthAtPhase(0), WORLD.spawnDepth);
    assert.equal(depthAtPhase(1), WORLD.tapDepth);
    // Constant velocity: equal phase steps are equal depth steps.
    const first = depthAtPhase(0.1) - depthAtPhase(0);
    const later = depthAtPhase(0.9) - depthAtPhase(0.8);
    assert.ok(Math.abs(first - later) < 1e-9, "the depth must close at a constant rate");
  });

  it("drops the height from a standstill, and lands it at the tap height", () => {
    assert.equal(heightAtPhase(0), WORLD.spawnHeight);
    assert.ok(Math.abs(heightAtPhase(1) - WORLD.tapHeight) < 1e-9);
    // Zero initial velocity: the first tenth of the flight loses far less height than the
    // last tenth. That asymmetry is what gives the flight its curve.
    const early = heightAtPhase(0) - heightAtPhase(0.1);
    const late = heightAtPhase(0.9) - heightAtPhase(1);
    assert.ok(early < late / 5, `the fall must start from rest (early ${early}, late ${late})`);
  });

  it("keeps the note on the floor once it has arrived", () => {
    // Past the tap line the note has landed; letting the quadratic carry on would fling it
    // off the bottom of the screen in a frame.
    assert.equal(heightAtPhase(1.2), WORLD.tapHeight);
  });

  it("never lets the depth reach the eye, however far past the line it is asked", () => {
    for (const phase of [1, 1.5, 4, 1e6, Infinity]) {
      assert.ok(depthAtPhase(phase) > 0, `depth must stay positive at phase ${phase}`);
      assert.ok(Number.isFinite(projectionOf(phase).scale));
    }
  });

  it("treats a phase that is not a number as the start rather than as a crash", () => {
    assert.equal(clampPhase(Number.NaN), 0);
    const projection = projectionOf(Number.NaN);
    assert.ok(Number.isFinite(projection.scale) && Number.isFinite(projection.yNorm));
  });
});

describe("the projection", () => {
  it("is exactly 1 at the tap line and smaller everywhere before it", () => {
    assert.equal(projectionOf(1).scale, 1);
    assert.ok(projectionOf(0).scale < 1);
    assert.ok(projectionOf(0.5).scale < 1);
  });

  it("normalises the spawn line to 0 and the tap line to 1", () => {
    assert.ok(Math.abs(projectionOf(0).yNorm) < 1e-12);
    assert.ok(Math.abs(projectionOf(1).yNorm - 1) < 1e-12);
  });

  it("grows a note the whole way in, without a single step backwards", () => {
    let previous = -Infinity;
    for (let phase = 0; phase <= 1.0001; phase += 0.002) {
      const { scale } = projectionOf(phase);
      assert.ok(scale > previous, `scale must grow, broke at phase ${phase.toFixed(3)}`);
      previous = scale;
    }
  });

  it("makes a far note smaller than a near one - the readability the flight depends on", () => {
    const far = noteRadiusAt(geometry, projectionOf(0).scale);
    const middle = noteRadiusAt(geometry, projectionOf(0.5).scale);
    const near = noteRadiusAt(geometry, projectionOf(1).scale);
    assert.ok(far < middle && middle < near, `${far} < ${middle} < ${near}`);
    assert.ok(near / far > 2, "the growth should be worth seeing");
  });

  it("bunches the lanes towards the spawn line and fans them out at the tap line", () => {
    const spawnSpread = Math.abs(positionOf(geometry, 4, 0).x - positionOf(geometry, 0, 0).x);
    const tapSpread = Math.abs(positionOf(geometry, 4, 1).x - positionOf(geometry, 0, 1).x);
    assert.ok(spawnSpread < tapSpread * 0.6, `lanes must converge: ${spawnSpread} vs ${tapSpread}`);

    // And they must widen the whole way, not wander in and out.
    let previous = -Infinity;
    for (let phase = 0; phase <= 1.0001; phase += 0.01) {
      const spread = positionOf(geometry, 4, phase).x - positionOf(geometry, 0, phase).x;
      assert.ok(spread > previous, `the fan must open, broke at phase ${phase.toFixed(2)}`);
      previous = spread;
    }
  });

  it("draws a smooth path, with no kink anywhere along it", () => {
    // A polyline with a corner in it reads as a mistake even when the endpoints are right.
    // The test: the change in the step size between samples stays small and gradual.
    const step = (phase) => positionOf(geometry, 0, phase + 0.01).y - positionOf(geometry, 0, phase).y;
    let previous = step(0);
    for (let phase = 0.01; phase <= 0.98; phase += 0.01) {
      const current = step(phase);
      assert.ok(
        Math.abs(current - previous) < Math.abs(current) * 0.5 + 1,
        `the path kinks at phase ${phase.toFixed(2)}`,
      );
      previous = current;
    }
  });
});

describe("a note and the target it is aimed at", () => {
  it("puts a tap's centre exactly on its tap target at the moment it is hit", () => {
    for (const note of chart.notes) {
      const drawn = noteAt(note, note.timeSec);
      const target = tapCentre(note.lane);
      assert.ok(Math.abs(drawn.x - target.x) < 1e-9, `note ${note.id} x`);
      assert.ok(Math.abs(drawn.y - target.y) < 1e-9, `note ${note.id} y`);
      assert.equal(drawn.scale, 1);
    }
  });

  it("does the same in every one of the five lanes", () => {
    for (let lane = 0; lane < 5; lane += 1) {
      const drawn = positionOf(geometry, lane, 1);
      assert.ok(Math.abs(drawn.x - laneCentreX(geometry, lane)) < 1e-9, `lane ${lane}`);
      assert.ok(Math.abs(drawn.y - geometry.judgeY) < 1e-9, `lane ${lane}`);
    }
    // Lane 0 is the leftmost and lane 4 the rightmost, which is the contract's own
    // ordering - "0-based from the left" - and is not something to get backwards.
    const xs = [0, 1, 2, 3, 4].map((lane) => positionOf(geometry, lane, 1).x);
    for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] > xs[i - 1], "lanes run left to right");
  });

  it("is nowhere near its target at the moment it appears", () => {
    for (const note of chart.notes) {
      const spawnTime = note.timeSec - APPROACH;
      const drawn = noteAt(note, spawnTime);
      const target = tapCentre(note.lane);
      const band = geometry.judgeY - geometry.topY;
      assert.ok(target.y - drawn.y > band * 0.9, `note ${note.id} should still be at the back`);
      assert.ok(drawn.scale < 0.55, `note ${note.id} should still be small`);
    }
  });

  it("keeps the tap target comfortably inside its lane, so a finger cannot hit two", () => {
    // The visible circle is deliberately smaller than the band a press is read from, so a
    // thumb landing a little off still counts - without the lanes ever overlapping.
    for (const [width, height] of [[1920, 1080], [1280, 720], [390, 844], [3840, 2160]]) {
      const geo = playfieldGeometry(width, height, 5);
      assert.ok(geo.tapRadius * 2 < geo.laneWidth, `targets must not touch at ${width}x${height}`);
      assert.ok(geo.tapRadius > geo.laneWidth * 0.15, `but must stay a real target at ${width}x${height}`);
    }
  });
});

describe("the phase, which is where the audio clock enters the geometry", () => {
  it("runs 0 at the spawn and 1 at the hit, and past 1 afterwards", () => {
    assert.ok(Math.abs(flightPhase(10, 10 - BASE_TRAVEL_SEC, BASE_TRAVEL_SEC)) < 1e-12);
    assert.equal(flightPhase(10, 10, BASE_TRAVEL_SEC), 1);
    assert.ok(flightPhase(10, 10.2, BASE_TRAVEL_SEC) > 1);
  });

  it("advances monotonically as the song does", () => {
    let previous = -Infinity;
    for (let now = 8; now <= 10.001; now += 0.01) {
      const phase = flightPhase(10, now, APPROACH);
      assert.ok(phase > previous, `phase must advance at ${now.toFixed(2)}s`);
      previous = phase;
    }
  });

  it("gives the same answer at the same audio time, whatever route was taken to it", () => {
    // This is frame-rate independence stated as a property. A machine at 30 Hz reaches
    // 9.5 s in a handful of steps and one at 240 Hz in dozens; both must draw the same
    // picture, which they do because neither of them accumulates anything.
    const note = chart.notes.find((entry) => entry.type === "tap");
    const target = noteAt(note, 9.5);

    for (const frameSec of [1 / 240, 1 / 144, 1 / 60, 1 / 30, 1 / 7]) {
      let clock = 0;
      while (clock + frameSec < 9.5) clock += frameSec;
      // Whatever the frame rate, the clock it *reads* is the audio's, not its own sum.
      const drawn = noteAt(note, 9.5);
      assert.deepEqual(drawn, target, `frame ${frameSec}`);
    }
  });

  it("lands in the right place after a seek, with nothing to unwind", () => {
    // A seek is not a special case here: the position at 40 s is computed from 40 s. There
    // is no simulation that has to be fast-forwarded or rewound, which is the whole reason
    // the model is analytic rather than integrated.
    const note = { lane: 2, timeSec: 41 };
    const beforeSeek = positionOf(geometry, note.lane, flightPhase(note.timeSec, 40.4, APPROACH));
    const afterSeek = positionOf(geometry, note.lane, flightPhase(note.timeSec, 40.4, APPROACH));
    assert.deepEqual(afterSeek, beforeSeek);

    // And a jump backwards puts the note back where it was, not somewhere new.
    const early = positionOf(geometry, note.lane, flightPhase(note.timeSec, 40.0, APPROACH));
    assert.ok(early.y < beforeSeek.y, "seeking back must put the note further away");
  });

  it("does not move while the clock is stopped", () => {
    // Pause stops the audio clock; `requestAnimationFrame` carries on. Because the only
    // input to a position is the clock, sixty frames at a standstill draw the same frame
    // sixty times - there is no per-frame term that could creep.
    const note = { lane: 1, timeSec: 12 };
    const paused = 11.4;
    const first = positionOf(geometry, note.lane, flightPhase(note.timeSec, paused, APPROACH));
    for (let frame = 0; frame < 60; frame += 1) {
      assert.deepEqual(
        positionOf(geometry, note.lane, flightPhase(note.timeSec, paused, APPROACH)),
        first,
        `frame ${frame} moved while paused`,
      );
    }
  });

  it("stays in step with the music at every practice speed", () => {
    // The Player slows the song by slowing the audio clock, so a note's phase is driven by
    // how far the *music* has got and not by how much wall-clock time has passed. At a
    // quarter speed the same musical moment therefore still draws the same picture.
    const note = { lane: 3, timeSec: 20 };
    const musicalMoment = 19.6;
    const reference = positionOf(geometry, note.lane, flightPhase(note.timeSec, musicalMoment, APPROACH));
    for (const rate of [1, 0.75, 0.5, 0.25, 0.1]) {
      const wallClockSeconds = (musicalMoment - 19) / rate; // longer at slower rates
      assert.ok(wallClockSeconds > 0);
      const drawn = positionOf(geometry, note.lane, flightPhase(note.timeSec, musicalMoment, APPROACH));
      assert.deepEqual(drawn, reference, `rate ${rate}`);
    }
  });

  it("gives every kind of note the same time in the air", () => {
    // The chart says when a note is hit; the Player decides only when to start drawing it.
    // A kind that arrived sooner than another would be the renderer quietly editing the
    // chart, so there is exactly one approach duration and it is not per-kind.
    const at = 5;
    for (const note of chart.notes) {
      const spawn = note.timeSec - APPROACH;
      assert.ok(Math.abs(flightPhase(note.timeSec, spawn, APPROACH)) < 1e-12, `note ${note.id}`);
    }
    assert.ok(at > 0);
  });
});

describe("a viewport that changes", () => {
  it("keeps every number finite at any size, including silly ones", () => {
    for (const [width, height] of [[1920, 1080], [1280, 720], [390, 844], [3840, 2160], [320, 200], [1, 1]]) {
      const geo = playfieldGeometry(width, height, 5);
      for (let lane = 0; lane < 5; lane += 1) {
        for (let phase = -0.2; phase <= 1.4; phase += 0.05) {
          const point = positionOf(geo, lane, phase);
          assert.ok(Number.isFinite(point.x), `x at ${width}x${height} lane ${lane} phase ${phase}`);
          assert.ok(Number.isFinite(point.y), `y at ${width}x${height}`);
          assert.ok(Number.isFinite(point.scale) && point.scale > 0, `scale at ${width}x${height}`);
          assert.ok(Number.isFinite(noteRadiusAt(geo, point.scale)), `radius at ${width}x${height}`);
        }
      }
    }
  });

  it("puts the playfield in the same relative place whatever the window is", () => {
    const a = playfieldGeometry(1920, 1080, 5);
    const b = playfieldGeometry(960, 540, 5);
    assert.ok(Math.abs(a.judgeY / a.height - b.judgeY / b.height) < 1e-12);
    assert.ok(Math.abs(a.topY / a.height - b.topY / b.height) < 1e-12);
    assert.ok(Math.abs(a.tapRadius / a.height - b.tapRadius / b.height) < 1e-12);
  });

  it("still lands a note on its target after a resize", () => {
    for (const [width, height] of [[1920, 1080], [1024, 768], [412, 915]]) {
      const geo = playfieldGeometry(width, height, 5);
      for (let lane = 0; lane < 5; lane += 1) {
        const drawn = positionOf(geo, lane, 1);
        assert.ok(Math.abs(drawn.x - laneCentreX(geo, lane)) < 1e-9);
        assert.ok(Math.abs(drawn.y - geo.judgeY) < 1e-9);
      }
    }
  });

  it("survives a lane count that is not five", () => {
    for (const lanes of [1, 3, 4, 7, 9]) {
      const geo = playfieldGeometry(1280, 720, lanes);
      assert.equal(geo.laneCount, lanes);
      for (let lane = 0; lane < lanes; lane += 1) {
        assert.ok(Number.isFinite(positionOf(geo, lane, 0.5).x));
      }
    }
  });
});

describe("the bands of holds and slides", () => {
  const hold = chart.notes.find((note) => note.id === "n-0009"); // 6.75 -> 7.75, lane 1
  const slide = chart.notes.find((note) => note.id === "n-0007"); // 4.5 -> 5.25, lanes 0..3

  it("ends where the note's end time says, not where its head happens to be", () => {
    // The bug this exists to catch: a ribbon whose far end is pinned to the head and whose
    // near end is stretched to fill, so the tail stops moving while the head does not.
    const now = 7.0;
    const segments = sampleRibbon(geometry, notePoints(hold), now, APPROACH);
    assert.ok(segments.length > 0);
    const last = segments[segments.length - 1];
    const tip = last.samples[last.samples.length - 1];

    const expected = positionOf(geometry, hold.endLane ?? hold.lane, flightPhase(hold.endTimeSec, now, APPROACH));
    assert.ok(Math.abs(tip.timeSec - hold.endTimeSec) < 1e-9, "the far end must be the end time");
    assert.ok(Math.abs(tip.x - expected.x) < 1e-9);
    assert.ok(Math.abs(tip.y - expected.y) < 1e-9);
  });

  it("keeps the near end at the playhead, so nothing hangs below the targets", () => {
    const now = 7.2; // halfway through the hold
    const segments = sampleRibbon(geometry, notePoints(hold), now, APPROACH);
    const first = segments[0].samples[0];
    assert.ok(Math.abs(first.timeSec - now) < 1e-9, "the played part of a hold is not drawn");
    assert.ok(Math.abs(first.y - geometry.judgeY) < 1e-9, "and its near end sits on the tap line");
  });

  it("draws nothing at all once the whole note is behind the playhead", () => {
    assert.deepEqual(sampleRibbon(geometry, notePoints(hold), 8.5, APPROACH), []);
  });

  it("draws nothing yet for a note that has not appeared", () => {
    assert.deepEqual(sampleRibbon(geometry, notePoints(hold), 2.0, APPROACH), []);
  });

  it("clips the far end to the part that is on screen", () => {
    const span = clipFlightSpan(10, 30, 10, 1.2);
    assert.ok(span !== null);
    assert.ok(span.endSec < 30, "a twenty-second hold is not drawn all at once");
    assert.equal(clipFlightSpan(0, 5, 6, 1.2), null);
  });

  it("carries a slide through every lane its waypoints name, at the times they name", () => {
    const now = 4.4;
    const points = notePoints(slide);
    assert.deepEqual(
      points.map((point) => [point.timeSec, point.lane]),
      [[4.5, 0], [4.75, 1], [5.0, 2], [5.25, 3]],
      "the waypoints are the path; dropping them would flatten the slide into a line",
    );

    const segments = sampleRibbon(geometry, points, now, APPROACH);
    assert.equal(segments.length, points.length - 1, "one band per leg of the slide");
    segments.forEach((segment, index) => {
      const tip = segment.samples[segment.samples.length - 1];
      const expected = positionOf(
        geometry,
        points[index + 1].lane,
        flightPhase(points[index + 1].timeSec, now, APPROACH),
      );
      assert.ok(Math.abs(tip.x - expected.x) < 1e-9, `leg ${index} x`);
      assert.ok(Math.abs(tip.y - expected.y) < 1e-9, `leg ${index} y`);
    });
  });

  it("bends a leg that crosses lanes instead of cutting the corner", () => {
    // Straight in the world is curved on the screen, because the projection is not linear
    // in time. A quadrilateral drawn between two waypoints would leave the lanes.
    const now = 4.4;
    const segments = sampleRibbon(geometry, notePoints(slide), now, APPROACH);
    const samples = segments[0].samples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    let worst = 0;
    for (const sample of samples) {
      const mix = (sample.y - first.y) / (last.y - first.y || 1);
      worst = Math.max(worst, Math.abs(sample.x - (first.x + (last.x - first.x) * mix)));
    }
    assert.ok(worst > 0.5, "the sampled path must actually differ from a straight line");
  });

  it("narrows a band with distance the same way a note narrows", () => {
    const far = ribbonHalfWidth(geometry, projectionOf(0.1).scale, 0.46);
    const near = ribbonHalfWidth(geometry, projectionOf(1).scale, 0.46);
    assert.ok(far < near, `${far} < ${near}`);
  });

  it("places a point between two lanes between their two positions", () => {
    const left = positionOf(geometry, 1, 0.6);
    const right = positionOf(geometry, 3, 0.6);
    const middle = positionBetween(geometry, 1, 3, 0.5, 0.6);
    assert.ok(Math.abs(middle.x - (left.x + right.x) / 2) < 1e-9);
    assert.equal(middle.y, left.y);
  });

  it("samples a band identically at the same chart time, however it was reached", () => {
    const a = sampleRibbon(geometry, notePoints(slide), 4.4, APPROACH);
    const b = sampleRibbon(geometry, notePoints(slide), 4.4, APPROACH);
    assert.deepEqual(a, b);
  });
});

describe("the charts this has to keep playing", () => {
  it("reads the Player's own fixture and places every point of it", () => {
    const read = readChart(structuredClone(MINI));
    assert.equal(read.problems.length, 0);
    for (const note of read.notes) {
      for (const point of notePoints(note)) {
        const drawn = positionOf(geometry, point.lane, flightPhase(point.timeSec, point.timeSec, APPROACH));
        assert.ok(Math.abs(drawn.y - geometry.judgeY) < 1e-9, `note ${note.id}`);
      }
    }
  });

  it("reads the contract's own example chart, decorations and all", () => {
    const read = readChart(structuredClone(EXAMPLE));
    assert.equal(read.problems.length, 0, read.problems.join("; "));
    assert.ok(read.notes.length > 0);
    assert.ok(read.decorations.length > 0, "the example carries decorations");
    assert.ok(read.connections.length > 0, "and a flick chain");
    for (const note of read.notes) {
      const drawn = positionOf(geometry, note.lane, flightPhase(note.timeSec, note.timeSec - 0.4, APPROACH));
      assert.ok(Number.isFinite(drawn.x) && Number.isFinite(drawn.y));
    }
  });
});
