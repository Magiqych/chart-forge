/**
 * The guitar guide layer, from the document to the magnet.
 *
 * The point of this suite is that **none of it is a second system**. A guitar onset is an
 * Analysis Event like any other, so it reaches the timeline through the lane it is drawn
 * in, reaches keyboard navigation through the same visible-lane filter, and reaches the
 * magnet through the same candidate list as a beat or a note edge. What is tested here is
 * that the existing path really does carry it, and that a document written before guitar
 * existed still behaves exactly as it did.
 */

import { describe, expect, it } from "vitest";

import {
  LANE_IDS, laneForStem, projectAnalysis,
  type AnalysisProjection, type LaneId, type ProjectedEvent,
} from "./analysis";
import { DEFAULT_ROWS } from "./lanes";
import { MIN_TICK_FRACTION, tickFraction } from "./eventGeometry";
import { buildGuideAnchors, guideRadiusSec, nearestGuideAnchor } from "./guideAnchors";
import { navigableEvents } from "./eventNavigation";
import { buildMagnetCandidates, magnetSnapDelta, type SnapCandidate } from "./magnetSnap";

/**
 * Drag a single note from `fromSec` to `toSec` and report where the magnet puts it.
 *
 * The real entry point, with the real arguments: one edge, an unsnapped delta, and a
 * zoom. Wrapped only so the cases below read as "drag this there", not as six fields.
 */
function dragTo(
  candidates: readonly SnapCandidate[],
  fromSec: number,
  toSec: number,
  pixelsPerSecond: number,
) {
  const outcome = magnetSnapDelta({
    candidates,
    baseEdgesSec: [fromSec],
    rawDeltaSec: toSec - fromSec,
    earliestMovingSec: fromSec,
    pixelsPerSecond,
    enabled: true,
  });
  return { ...outcome, landedSec: fromSec + outcome.deltaSec };
}

/** A guitar attack as the Analyzer writes one: an onset, with a confidence. */
function guitarEvent(index: number, startSec: number, confidence: number) {
  return {
    id: `ev-guitar-${String(index).padStart(6, "0")}`,
    type: "onset",
    detectorId: "det-pluck-onset",
    endKind: "instantaneous",
    startSec,
    confidence,
    source: { stemId: "stem-guitar", instrument: "guitar" },
    metadata: { rawScore: { kind: "pluck-onset-strength", value: 4.2 } },
  };
}

function document(events: readonly unknown[], stems: readonly string[]) {
  return {
    version: "0.2.0",
    audio: { path: "song.wav", durationSec: 60, sha256: "a".repeat(64) },
    tempo: { bpm: 120 },
    beats: [],
    detectors: [{ id: "det-pluck-onset", name: "chart-forge pluck onset" }],
    stems: stems.map((kind) => ({ id: `stem-${kind}`, kind, path: `stems/${kind}.wav` })),
    events,
  };
}

const SIX = ["vocals", "drums", "bass", "guitar", "piano", "other"];

describe("reading a six-stem document", () => {
  const projection: AnalysisProjection = projectAnalysis(
    document(
      [guitarEvent(1, 1.0, 0.9), guitarEvent(2, 1.5, 0.3), guitarEvent(3, 2.0, 0.6)],
      SIX,
    ),
  );

  it("puts guitar events in the guitar lane", () => {
    expect(projection.eventsByLane.guitar.map((e) => e.id)).toEqual([
      "ev-guitar-000001", "ev-guitar-000002", "ev-guitar-000003",
    ]);
    expect(projection.counts.byLane.guitar).toBe(3);
  });

  it("carries the confidence across, because the guide is drawn from it", () => {
    expect(projection.eventsByLane.guitar[0]?.confidence).toBeCloseTo(0.9);
    expect(projection.eventsByLane.guitar[1]?.confidence).toBeCloseTo(0.3);
  });

  it("carries the six stems the mixer needs", () => {
    expect(projection.stems.map((s) => s.kind)).toEqual(SIX);
    expect(projection.stems.find((s) => s.kind === "guitar")?.path).toBe("stems/guitar.wav");
  });

  it("keeps guitar as an instantaneous event, not a span", () => {
    // An attack is a moment. A `bounded` guitar event would draw as a filled block and
    // offer an end to snap to that the Analyzer never measured.
    for (const event of projection.eventsByLane.guitar) {
      expect(event.endKind).toBe("instantaneous");
      expect(event.endSec).toBeUndefined();
    }
  });

  it("gives the guitar its own timeline row and lane colour", () => {
    expect(DEFAULT_ROWS.map((r) => r.id)).toContain("guitar");
    expect(DEFAULT_ROWS.map((r) => r.id)).toContain("piano");
    expect(LANE_IDS).toContain("guitar");
    expect(laneForStem("stem-guitar")).toBe("guitar");
  });
});

describe("a document written before guitar existed", () => {
  const projection = projectAnalysis(
    document(
      [
        {
          id: "ev-drums-000001",
          type: "percussion",
          detectorId: "det-librosa-onset",
          endKind: "instantaneous",
          startSec: 1.0,
          source: { stemId: "stem-drums" },
        },
      ],
      ["drums", "bass", "other", "vocals"],
    ),
  );

  it("loads, rather than failing over stems it does not have", () => {
    expect(projection.counts.events).toBe(1);
    expect(projection.stems).toHaveLength(4);
  });

  it("reports no guitar events rather than undefined", () => {
    expect(projection.eventsByLane.guitar).toEqual([]);
    expect(projection.counts.byLane.guitar).toBe(0);
    expect(projection.counts.byLane.piano).toBe(0);
  });

  it("offers no guitar anchors, so nothing can snap to a guitar that is not there", () => {
    const anchors = buildGuideAnchors(projection.events, new Set(LANE_IDS));
    expect(anchors.every((a) => a.lane !== "guitar")).toBe(true);
  });

  it("leaves an event with no confidence drawn exactly as it always was", () => {
    // "Unknown" is not "weak". Shrinking these would be the renderer inventing a claim.
    const drums = projection.eventsByLane.drums[0] as ProjectedEvent;
    expect(drums.confidence).toBeUndefined();
    expect(tickFraction(drums.confidence)).toBe(1);
  });
});

describe("how sure the detector is decides how tall the mark is", () => {
  it("draws a confident attack taller than a marginal one", () => {
    expect(tickFraction(0.9)).toBeGreaterThan(tickFraction(0.3));
  });

  it("never draws one so short it cannot be seen or clicked", () => {
    for (const confidence of [0, 0.01, 0.2]) {
      expect(tickFraction(confidence)).toBeGreaterThanOrEqual(MIN_TICK_FRACTION);
    }
  });

  it("never draws one taller than its lane", () => {
    for (const confidence of [0, 0.5, 1, 1.5, -3]) {
      expect(tickFraction(confidence)).toBeLessThanOrEqual(1);
    }
  });

  it("treats nonsense as unknown rather than as zero", () => {
    expect(tickFraction(Number.NaN)).toBe(1);
    expect(tickFraction(undefined)).toBe(1);
  });
});

describe("showing and hiding the guitar guide", () => {
  const projection = projectAnalysis(
    document([guitarEvent(1, 1.0, 0.9), guitarEvent(2, 2.0, 0.8)], SIX),
  );
  const all = new Set<LaneId>(LANE_IDS);
  const withoutGuitar = new Set<LaneId>(LANE_IDS.filter((l) => l !== "guitar"));

  it("walks guitar events with the arrow keys when the layer is shown", () => {
    expect(navigableEvents(projection.events, all)).toHaveLength(2);
  });

  it("removes them from navigation and from snapping together when hidden", () => {
    // One filter, two features. Hiding a layer that still snapped would leave the author
    // catching on something they cannot see.
    expect(navigableEvents(projection.events, withoutGuitar)).toHaveLength(0);
    expect(buildGuideAnchors(projection.events, withoutGuitar)).toHaveLength(0);
  });
});

describe("snapping a note to a guitar attack", () => {
  const projection = projectAnalysis(
    document(
      [guitarEvent(1, 10.0, 0.9), guitarEvent(2, 10.4, 0.8), guitarEvent(3, 12.0, 0.5)],
      SIX,
    ),
  );
  const anchors = buildGuideAnchors(projection.events, new Set(LANE_IDS));

  it("offers every attack as an anchor", () => {
    expect(anchors.map((a) => a.timeSec)).toEqual([10.0, 10.4, 12.0]);
    expect(anchors.every((a) => a.lane === "guitar")).toBe(true);
  });

  it("catches a click that lands near one", () => {
    const radius = guideRadiusSec(100);          // 12 px at 100 px/s = 0.12 s
    expect(nearestGuideAnchor(anchors, 10.05, radius)?.timeSec).toBe(10.0);
    expect(nearestGuideAnchor(anchors, 10.35, radius)?.timeSec).toBe(10.4);
  });

  it("leaves a click that is not near one alone", () => {
    expect(nearestGuideAnchor(anchors, 11.0, guideRadiusSec(100))).toBeNull();
  });

  it("reaches the magnet through the ordinary candidate list", () => {
    // Not a second snapping path: the same list a beat or a note edge goes into.
    const candidates = buildMagnetCandidates({ eventAnchors: anchors });
    expect(candidates.map((c) => c.timeSec)).toEqual([10.0, 10.4, 12.0]);
    expect(candidates.every((c) => c.kind === "event")).toBe(true);
    expect(candidates[0]?.eventId).toBe("ev-guitar-000001");
  });

  it("pulls a dragged note onto an attack", () => {
    const candidates = buildMagnetCandidates({ eventAnchors: anchors });
    const dropped = dragTo(candidates, 8.0, 10.03, 100);
    expect(dropped.candidate?.timeSec).toBe(10.0);
    // Exactly on it, to the last bit: the delta is candidate minus edge, never the
    // pointer's own position with its rounding carried in.
    expect(dropped.landedSec).toBe(10.0);
    expect(dropped.guideTimeSec).toBe(10.0);
  });

  it("lets go of a note dragged well away from every attack", () => {
    const candidates = buildMagnetCandidates({ eventAnchors: anchors });
    const dropped = dragTo(candidates, 8.0, 11.2, 100);
    expect(dropped.candidate).toBeNull();
    expect(dropped.landedSec).toBeCloseTo(11.2, 9);
  });

  it("snaps the end of a Long to an attack as readily as its start", () => {
    // Both edges are offered, so a hold can be finished where a sound was struck.
    const candidates = buildMagnetCandidates({ eventAnchors: anchors });
    const outcome = magnetSnapDelta({
      candidates,
      baseEdgesSec: [7.0, 9.97],
      rawDeltaSec: 0.02,
      earliestMovingSec: 7.0,
      pixelsPerSecond: 100,
      enabled: true,
    });
    expect(outcome.candidate?.timeSec).toBe(10.0);
    expect(9.97 + outcome.deltaSec).toBe(10.0);
  });
});

describe("the magnet feels the same at every zoom", () => {
  const projection = projectAnalysis(document([guitarEvent(1, 10.0, 0.9)], SIX));
  const anchors = buildGuideAnchors(projection.events, new Set(LANE_IDS));
  const candidates = buildMagnetCandidates({ eventAnchors: anchors });

  it("reaches the same number of pixels however far the view is zoomed in", () => {
    // A radius in seconds would do the opposite of what the eye expects: generous when
    // zoomed in, useless when zoomed out.
    for (const pixelsPerSecond of [25, 100, 400, 1600]) {
      const eightPixels = 8 / pixelsPerSecond;
      const fortyPixels = 40 / pixelsPerSecond;
      expect(
        dragTo(candidates, 5, 10 + eightPixels, pixelsPerSecond).candidate,
      ).not.toBeNull();
      expect(
        dragTo(candidates, 5, 10 + fortyPixels, pixelsPerSecond).candidate,
      ).toBeNull();
    }
  });

  it("narrows in seconds as the view zooms in, so close attacks stay separable", () => {
    // Two attacks 40 ms apart - the closest the detector will ever report - have to be
    // reachable independently once the author has zoomed far enough in to see them.
    const pair = buildMagnetCandidates({
      eventAnchors: buildGuideAnchors(
        projectAnalysis(
          document([guitarEvent(1, 10.0, 0.9), guitarEvent(2, 10.04, 0.9)], SIX),
        ).events,
        new Set(LANE_IDS),
      ),
    });
    expect(dragTo(pair, 5, 10.005, 2000).candidate?.timeSec).toBe(10.0);
    expect(dragTo(pair, 5, 10.035, 2000).candidate?.timeSec).toBeCloseTo(10.04);
  });
});

describe("guitar does not out-rank the rest of the guide", () => {
  it("is an ordinary event candidate, with no priority of its own", () => {
    // The brief asked for pixel distance and a deterministic tie-break, not for guitar to
    // win. A guitar attack and a drum hit are the same kind of claim.
    const anchors = buildGuideAnchors(
      projectAnalysis(
        document(
          [
            guitarEvent(1, 5.0, 0.9),
            {
              id: "ev-drums-000001",
              type: "percussion",
              detectorId: "det-librosa-onset",
              endKind: "instantaneous",
              startSec: 5.06,
              source: { stemId: "stem-drums" },
            },
          ],
          SIX,
        ),
      ).events,
      new Set(LANE_IDS),
    );
    const candidates = buildMagnetCandidates({ eventAnchors: anchors });
    // Nearest wins, whichever instrument it came from.
    expect(dragTo(candidates, 1, 5.01, 200).candidate?.eventId).toBe("ev-guitar-000001");
    expect(dragTo(candidates, 1, 5.05, 200).candidate?.eventId).toBe("ev-drums-000001");
  });
});
