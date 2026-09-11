/**
 * The judgement engine.
 *
 * Every test here drives the engine the way the game loop does - events first, then the
 * clock - so that what is being tested is the thing that actually runs. The frame step is
 * a parameter on purpose: a judgement that depends on the frame rate is a bug, and the
 * coarse-step tests are there to catch it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readChart } from "../web/chart.js";
import { createJudge, resultFor, capResult, directionsAgree, DEFAULT_WINDOWS } from "../web/judge.js";
import { createAutoplay, buildAutoplayEvents } from "../web/autoplay.js";
import { createScoreboard } from "../web/score.js";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.chart.json", import.meta.url)), "utf8"),
);

const fixture = () => readChart(structuredClone(FIXTURE));

/** A chart built inline, so a test can say exactly what it means. */
function chartOf(notes, laneCount = 5) {
  return readChart({
    version: "0.1.0",
    audio: { path: "x.wav" },
    timing: { offsetSec: 0 },
    playfield: { laneCount },
    notes,
  });
}

/**
 * Run the game loop over a chart.
 *
 * `events` are delivered at the first frame at or after their own `timeSec`, but keep
 * that time as their stamp - which is what a real keypress does, since the key was
 * pressed between frames and the judge is told when, not when it heard about it.
 */
function simulate(chart, { events = [], untilSec, stepSec = 1 / 60, autoplay = false, config = {}, fromSec = 0 } = {}) {
  const judge = createJudge(chart, config);
  judge.reset(fromSec);
  const auto = autoplay ? createAutoplay(chart) : null;
  auto?.reset(fromSec);
  const scoreboard = createScoreboard(judge.totalJudgeable());
  const pending = [...events].sort((a, b) => a.timeSec - b.timeSec);
  const judgements = [];

  const take = (list) => {
    for (const judgement of list) {
      judgements.push(judgement);
      scoreboard.apply(judgement);
    }
  };

  const end = untilSec ?? chart.lastPointSec + 1;
  for (let t = fromSec; t <= end + stepSec; t += stepSec) {
    while (pending.length > 0 && pending[0].timeSec <= t) take(judge.input(pending.shift()));
    if (auto) auto.emitUntil(t, (event) => take(judge.input(event)));
    take(judge.update(t));
  }
  return { judge, judgements, snapshot: scoreboard.snapshot(), byPoint: new Map(judgements.map((j) => [j.pointId, j])) };
}

describe("judgement windows", () => {
  it("names each band, either side of the moment", () => {
    assert.equal(resultFor(0), "perfect");
    assert.equal(resultFor(-DEFAULT_WINDOWS.perfect), "perfect");
    assert.equal(resultFor(DEFAULT_WINDOWS.perfect + 0.001), "great");
    assert.equal(resultFor(-(DEFAULT_WINDOWS.great + 0.001)), "good");
    assert.equal(resultFor(DEFAULT_WINDOWS.good + 0.001), null);
  });

  it("caps a result without ever improving one", () => {
    assert.equal(capResult("perfect", "good"), "good");
    assert.equal(capResult("miss", "good"), "miss");
  });

  it("treats a missing direction on either side as agreement", () => {
    assert.ok(directionsAgree("left", null));
    assert.ok(directionsAgree(null, "left"));
    assert.ok(directionsAgree("left", "left"));
    assert.ok(!directionsAgree("left", "right"));
  });
});

describe("a single note", () => {
  const chart = chartOf([{ id: "n1", type: "tap", timeSec: 1.0, lane: 2 }]);

  it("is Perfect when pressed on the moment", () => {
    const run = simulate(chart, { events: [{ kind: "down", lane: 2, timeSec: 1.0 }] });
    assert.equal(run.judgements.length, 1);
    assert.equal(run.judgements[0].result, "perfect");
    assert.equal(run.judgements[0].deltaSec, 0);
  });

  it("grades a late press and reports how late", () => {
    const run = simulate(chart, { events: [{ kind: "down", lane: 2, timeSec: 1.08 }] });
    assert.equal(run.judgements[0].result, "great");
    assert.ok(Math.abs(run.judgements[0].deltaSec - 0.08) < 1e-9);
  });

  it("is missed when nobody presses anything", () => {
    const run = simulate(chart, {});
    assert.equal(run.judgements.length, 1);
    assert.equal(run.judgements[0].result, "miss");
    assert.equal(run.snapshot.combo, 0);
  });

  it("is not hit by a press far outside the window, and is missed afterwards", () => {
    const run = simulate(chart, { events: [{ kind: "down", lane: 2, timeSec: 0.5 }] });
    assert.equal(run.judgements.length, 1);
    assert.equal(run.judgements[0].result, "miss");
  });

  it("is not hit by a press in another lane", () => {
    const run = simulate(chart, { events: [{ kind: "down", lane: 0, timeSec: 1.0 }] });
    assert.equal(run.judgements[0].result, "miss");
  });
});

describe("one input never judges two notes", () => {
  it("leaves the other lane of a chord alone", () => {
    const chart = chartOf([
      { id: "a", type: "tap", timeSec: 1.0, lane: 0 },
      { id: "b", type: "tap", timeSec: 1.0, lane: 3 },
    ]);
    const run = simulate(chart, { events: [{ kind: "down", lane: 0, timeSec: 1.0 }] });
    assert.equal(run.byPoint.get("a#0").result, "perfect");
    assert.equal(run.byPoint.get("b#0").result, "miss");
  });

  it("picks the nearer of two notes in one lane and leaves the other pending", () => {
    const chart = chartOf([
      { id: "a", type: "tap", timeSec: 1.0, lane: 1 },
      { id: "b", type: "tap", timeSec: 1.09, lane: 1 },
    ]);
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 1, timeSec: 1.08 },
        { kind: "up", lane: 1, timeSec: 1.085 },
        { kind: "down", lane: 1, timeSec: 1.12 },
      ],
    });
    assert.equal(run.byPoint.get("b#0").result, "perfect", "the closer note takes the first press");
    assert.equal(run.byPoint.get("a#0").result, "good", "the other is still there for the second");
  });
});

describe("a long note", () => {
  const chart = chartOf([{ id: "h", type: "hold", timeSec: 1.0, lane: 2, endTimeSec: 2.0 }]);

  it("is judged at its start and at its release", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 2, timeSec: 1.0 },
        { kind: "up", lane: 2, timeSec: 2.0 },
      ],
    });
    assert.equal(run.judgements.length, 2);
    assert.equal(run.byPoint.get("h#0").result, "perfect");
    assert.equal(run.byPoint.get("h#1").result, "perfect");
    assert.equal(run.byPoint.get("h#1").kind, "release");
  });

  it("completes when it is held past the end and let go late", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 2, timeSec: 1.0 },
        { kind: "up", lane: 2, timeSec: 2.6 },
      ],
    });
    assert.equal(run.byPoint.get("h#1").result, "perfect");
    assert.equal(run.snapshot.counts.miss, 0);
  });

  it("is broken by letting go in the middle", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 2, timeSec: 1.0 },
        { kind: "up", lane: 2, timeSec: 1.4 },
      ],
    });
    assert.equal(run.byPoint.get("h#0").result, "perfect");
    assert.equal(run.byPoint.get("h#1").result, "miss");
  });

  it("survives a second finger arriving and leaving in the same lane", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 2, timeSec: 1.0 },
        { kind: "down", lane: 2, timeSec: 1.4 },
        { kind: "up", lane: 2, timeSec: 1.45 },
        { kind: "up", lane: 2, timeSec: 2.0 },
      ],
    });
    assert.equal(run.byPoint.get("h#1").result, "perfect");
  });

  it("loses its end too when its start was missed", () => {
    const run = simulate(chart, {});
    assert.equal(run.judgements.length, 2);
    assert.ok(run.judgements.every((judgement) => judgement.result === "miss"));
  });
});

describe("a flick", () => {
  const chart = chartOf([{ id: "f", type: "flick", timeSec: 1.0, lane: 4, direction: "right" }]);

  it("is satisfied by a swipe the right way", () => {
    const run = simulate(chart, { events: [{ kind: "flick", lane: 4, direction: "right", timeSec: 1.0 }] });
    assert.equal(run.judgements[0].result, "perfect");
    assert.equal(run.judgements[0].wrongDirection, false);
  });

  it("is satisfied by a plain press, because a keyboard has no direction to give", () => {
    const run = simulate(chart, { events: [{ kind: "down", lane: 4, timeSec: 1.0 }] });
    assert.equal(run.judgements[0].result, "perfect");
  });

  it("is capped at Good, and reported, when swiped the wrong way", () => {
    const run = simulate(chart, { events: [{ kind: "flick", lane: 4, direction: "left", timeSec: 1.0 }] });
    assert.equal(run.judgements[0].result, "good");
    assert.equal(run.judgements[0].wrongDirection, true);
  });

  it("is missed when swiped the wrong way and the direction is being enforced", () => {
    const run = simulate(chart, {
      events: [{ kind: "flick", lane: 4, direction: "left", timeSec: 1.0 }],
      config: { strictFlickDirection: true },
    });
    assert.equal(run.judgements[0].result, "miss");
  });
});

describe("a long note that ends in a flick", () => {
  const chart = chartOf([
    { id: "e", type: "hold", timeSec: 1.0, lane: 1, endTimeSec: 2.0, endAction: { type: "flick", direction: "left" } },
  ]);

  it("wants the swipe, and takes it", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 1, timeSec: 1.0 },
        { kind: "flick", lane: 1, direction: "left", timeSec: 2.0 },
        { kind: "up", lane: 1, timeSec: 2.02 },
      ],
    });
    assert.equal(run.byPoint.get("e#1").kind, "flick-end");
    assert.equal(run.byPoint.get("e#1").result, "perfect");
    assert.equal(run.snapshot.counts.miss, 0);
  });

  it("is not satisfied by simply letting go, unlike an ordinary release", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 1, timeSec: 1.0 },
        { kind: "up", lane: 1, timeSec: 2.0 },
      ],
    });
    assert.equal(run.byPoint.get("e#1").result, "miss");
  });
});

describe("a slide", () => {
  const chart = chartOf([
    {
      id: "s",
      type: "slide",
      timeSec: 1.0,
      lane: 0,
      waypoints: [{ timeSec: 1.25, lane: 1 }, { timeSec: 1.5, lane: 2 }],
      endTimeSec: 1.75,
      endLane: 3,
    },
  ]);

  it("is played by moving the press from lane to lane", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 0, timeSec: 1.0 },
        { kind: "down", lane: 1, timeSec: 1.25 },
        { kind: "up", lane: 0, timeSec: 1.26 },
        { kind: "down", lane: 2, timeSec: 1.5 },
        { kind: "up", lane: 1, timeSec: 1.51 },
        { kind: "down", lane: 3, timeSec: 1.75 },
        { kind: "up", lane: 2, timeSec: 1.76 },
        { kind: "up", lane: 3, timeSec: 1.9 },
      ],
    });
    assert.equal(run.judgements.length, 4);
    assert.equal(run.snapshot.counts.miss, 0);
    assert.equal(run.snapshot.maxCombo, 4);
  });

  it("loses the rest of itself when a waypoint is not reached", () => {
    const run = simulate(chart, {
      events: [
        { kind: "down", lane: 0, timeSec: 1.0 },
        { kind: "up", lane: 0, timeSec: 1.05 },
      ],
    });
    assert.equal(run.byPoint.get("s#0").result, "perfect");
    assert.equal(run.snapshot.counts.miss, 3);
  });

  it("does not offer its far end to a press before its start has been taken", () => {
    // A press in lane 3 at the slide's end time, with the slide never started, must not
    // pick up the end point: the note is not in play.
    const run = simulate(chart, { events: [{ kind: "down", lane: 3, timeSec: 1.75 }] });
    assert.equal(run.snapshot.counts.miss, 4);
    assert.equal(run.snapshot.counts.perfect, 0);
  });
});

describe("starting somewhere other than the beginning", () => {
  it("leaves everything before the playhead out of the run entirely", () => {
    const chart = fixture();
    const run = simulate(chart, { fromSec: 4.0 });
    assert.ok(run.snapshot.total < chart.points.length, "fewer points are judgeable");
    // Nothing before 4 s is judged at all - not hit, not missed.
    assert.ok(run.judgements.every((judgement) => judgement.timeSec > 3.8));
  });

  it("leaves out the whole of a long note whose beginning is behind the playhead", () => {
    // Starting halfway through a slide means the press that should have been travelling
    // along it was never made, so none of it can be played. Counting the rest as missed
    // would blame the chart for where the listening started.
    const chart = chartOf([
      {
        id: "s",
        type: "slide",
        timeSec: 1,
        lane: 0,
        waypoints: [{ timeSec: 2, lane: 1 }, { timeSec: 3, lane: 2 }, { timeSec: 4, lane: 3 }],
        endTimeSec: 5,
        endLane: 4,
      },
      { id: "t", type: "tap", timeSec: 6, lane: 2 },
    ]);
    const run = simulate(chart, { fromSec: 2.5, autoplay: true });
    assert.equal(run.snapshot.total, 1, "only the tap after the playhead is in play");
    assert.equal(run.snapshot.counts.miss, 0);
    assert.ok(run.judgements.every((judgement) => judgement.noteId === "t"));
  });

  it("plays a long note in full when the playhead is before its start", () => {
    const chart = chartOf([{ id: "h", type: "hold", timeSec: 3, lane: 1, endTimeSec: 5 }]);
    const run = simulate(chart, { fromSec: 2.5, autoplay: true });
    assert.equal(run.snapshot.total, 2);
    assert.equal(run.snapshot.counts.miss, 0);
  });

  it("puts the totals back when the run is reset to the top", () => {
    const chart = fixture();
    const judge = createJudge(chart);
    judge.reset(4.0);
    const partial = judge.totalJudgeable();
    judge.reset(0);
    assert.equal(judge.totalJudgeable(), chart.points.length);
    assert.ok(partial < chart.points.length);
  });
});

describe("autoplay", () => {
  it("gets a full combo on the fixture, through the same judge a player uses", () => {
    const chart = fixture();
    const run = simulate(chart, { autoplay: true });
    assert.equal(run.snapshot.judged, chart.points.length);
    assert.equal(run.snapshot.counts.miss, 0, "autoplay must never miss");
    assert.equal(run.snapshot.counts.perfect, chart.points.length);
    assert.ok(run.snapshot.fullCombo);
    assert.equal(run.snapshot.score, 1_000_000);
  });

  it("gets the same result at a frame rate five times worse", () => {
    const chart = fixture();
    const fast = simulate(chart, { autoplay: true, stepSec: 1 / 120 });
    const slow = simulate(chart, { autoplay: true, stepSec: 1 / 24 });
    assert.deepEqual(slow.snapshot.counts, fast.snapshot.counts);
    assert.equal(slow.snapshot.score, fast.snapshot.score);
  });

  it("is deterministic: the same run twice is the same judgements", () => {
    const first = simulate(fixture(), { autoplay: true });
    const second = simulate(fixture(), { autoplay: true });
    assert.deepEqual(
      first.judgements.map((j) => [j.pointId, j.result, j.deltaSec]),
      second.judgements.map((j) => [j.pointId, j.result, j.deltaSec]),
    );
  });

  it("presses the next lane of a slide before letting go of the last", () => {
    const chart = chartOf([
      { id: "s", type: "slide", timeSec: 1, lane: 0, waypoints: [{ timeSec: 1.5, lane: 2 }], endTimeSec: 2, endLane: 4 },
    ]);
    const events = buildAutoplayEvents(chart);
    const atWaypoint = events.filter((event) => event.timeSec === 1.5);
    assert.deepEqual(atWaypoint.map((event) => [event.kind, event.lane]), [["down", 2], ["up", 0]]);
  });

  it("keeps a slide's same-lane waypoints when the finger moves on inside the same frame", () => {
    // The shape that broke this in a real chart: two waypoints in the lane already being
    // held, twenty milliseconds apart, and a third in another lane four milliseconds
    // after them. A frame spanning all three used to lose the first two - the press had
    // moved to the new lane before anything noticed the old ones had been reached.
    const chart = chartOf([
      {
        id: "s",
        type: "slide",
        timeSec: 1.0,
        lane: 4,
        waypoints: [
          { timeSec: 1.3124, lane: 4 },
          { timeSec: 1.3331, lane: 4 },
          { timeSec: 1.3371, lane: 0 },
        ],
        endTimeSec: 2.0,
        endLane: 0,
      },
    ]);
    // A frame step that guarantees one frame covers all three waypoints.
    const run = simulate(chart, { autoplay: true, stepSec: 0.1 });
    assert.equal(run.snapshot.counts.miss, 0);
    assert.equal(run.snapshot.judged, 5);
  });

  it("never misses at any frame rate, steady or lurching", () => {
    const chart = fixture();
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const jitter of [() => 1 / 60, () => 1 / 30, (r) => 0.014 + r() * 0.011, (r) => (r() < 0.05 ? 0.3 : 0.016)]) {
      const judge = createJudge(chart);
      judge.reset(0);
      const auto = createAutoplay(chart);
      auto.reset(0);
      const board = createScoreboard(judge.totalJudgeable());
      for (let t = 0; t <= chart.lastPointSec + 1; t += jitter(random)) {
        auto.emitUntil(t, (event) => {
          for (const judgement of judge.input(event)) board.apply(judgement);
        });
        for (const judgement of judge.update(t)) board.apply(judgement);
      }
      const snapshot = board.snapshot();
      assert.equal(snapshot.counts.miss, 0, "autoplay misses nothing");
      assert.equal(snapshot.judged, chart.points.length);
    }
  });

  it("leaves no lane pressed when the chart is over", () => {
    const chart = fixture();
    const depth = new Array(chart.laneCount).fill(0);
    for (const event of buildAutoplayEvents(chart)) {
      if (event.kind === "down") depth[event.lane] += 1;
      if (event.kind === "up") depth[event.lane] -= 1;
    }
    assert.deepEqual(depth, new Array(chart.laneCount).fill(0));
  });
});

describe("playing the fixture by hand", () => {
  it("counts every point exactly once when nothing is pressed at all", () => {
    const chart = fixture();
    const run = simulate(chart, {});
    assert.equal(run.snapshot.judged, chart.points.length);
    assert.equal(run.snapshot.counts.miss, chart.points.length);
    assert.equal(run.snapshot.score, 0);
    assert.ok(run.judge.isComplete());
  });
});
