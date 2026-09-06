import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import {
  buildGuideAnchors, describeAnchor, guideRadiusSec, nearestGuideAnchor,
  GUIDE_SNAP_RADIUS_PX,
} from "./guideAnchors";
import { resolvePlacementTime, DEFAULT_SNAP } from "./snap";

const event = (
  id: string,
  startSec: number,
  lane: LaneId | null,
  endSec?: number,
): ProjectedEvent => ({
  id,
  type: "onset",
  startSec,
  ...(endSec === undefined ? {} : { endSec }),
  endKind: endSec === undefined ? "instantaneous" : "bounded",
  detectorId: "det",
  stemId: `stem-${lane ?? "none"}`,
  lane,
});

const ALL: ReadonlySet<LaneId> = new Set(["drums", "other", "bass", "vocals"]);

const events = [
  event("ev-1", 1.0, "drums"),
  event("ev-2", 2.0, "bass", 2.5),
  event("ev-3", 3.0, "vocals"),
];

describe("where a note can snap to", () => {
  it("offers every start in a visible lane", () => {
    expect(buildGuideAnchors(events, ALL).map((a) => [a.timeSec, a.edge]))
      .toEqual([[1.0, "start"], [2.0, "start"], [3.0, "start"]]);
  });

  it("leaves out a lane that is switched off", () => {
    // The same rule keyboard navigation obeys, from the same function - so what you can
    // walk to is what you can snap to.
    const withoutBass: ReadonlySet<LaneId> = new Set(["drums", "vocals"]);
    expect(buildGuideAnchors(events, withoutBass).map((a) => a.eventId))
      .toEqual(["ev-1", "ev-3"]);
  });

  it("offers nothing when every lane is off", () => {
    expect(buildGuideAnchors(events, new Set())).toEqual([]);
  });

  it("leaves out an event belonging to no lane", () => {
    const orphan = [...events, event("ev-x", 1.5, null)];
    expect(buildGuideAnchors(orphan, ALL).map((a) => a.eventId)).not.toContain("ev-x");
  });

  it("never offers a Chart Note", () => {
    // The function only ever sees Analysis Events - the types say so - and nothing is
    // invented beyond them.
    const ids = new Set(events.map((e) => e.id));
    for (const anchor of buildGuideAnchors(events, ALL)) {
      expect(ids.has(anchor.eventId)).toBe(true);
    }
  });

  it("offers an event's end only when asked", () => {
    // Placing a note asks when a sound *started*. Dragging the end of a Long asks when
    // one stopped, which is a different question and a different set of candidates.
    expect(buildGuideAnchors(events, ALL).some((a) => a.edge === "end")).toBe(false);
    const withEnds = buildGuideAnchors(events, ALL, { includeEnds: true });
    expect(withEnds.map((a) => [a.timeSec, a.edge]))
      .toEqual([[1.0, "start"], [2.0, "start"], [2.5, "end"], [3.0, "start"]]);
  });

  it("ignores a degenerate end", () => {
    const zero = [event("ev-z", 4.0, "drums", 4.0)];
    expect(buildGuideAnchors(zero, ALL, { includeEnds: true })).toHaveLength(1);
  });

  it("stays in ascending time order once ends are mixed in", () => {
    const anchors = buildGuideAnchors(events, ALL, { includeEnds: true });
    for (let i = 1; i < anchors.length; i += 1) {
      expect(anchors[i]!.timeSec).toBeGreaterThanOrEqual(anchors[i - 1]!.timeSec);
    }
  });
});

describe("the snap radius", () => {
  it("is a screen distance converted through the zoom", () => {
    expect(guideRadiusSec(100)).toBeCloseTo(GUIDE_SNAP_RADIUS_PX / 100, 9);
    expect(guideRadiusSec(400)).toBeCloseTo(GUIDE_SNAP_RADIUS_PX / 400, 9);
  });

  it("covers less time as the zoom goes up", () => {
    // So the feel in the hand is constant: zoomed in, the author can place a note
    // between two onsets a few milliseconds apart.
    expect(guideRadiusSec(400)).toBeLessThan(guideRadiusSec(100));
    expect(guideRadiusSec(100)).toBeLessThan(guideRadiusSec(25));
  });

  it("is nothing at a nonsense zoom", () => {
    expect(guideRadiusSec(0)).toBe(0);
    expect(guideRadiusSec(-5)).toBe(0);
    expect(guideRadiusSec(Number.NaN)).toBe(0);
  });
});

describe("choosing the anchor a click lands on", () => {
  const anchors = buildGuideAnchors(events, ALL, { includeEnds: true });

  it("takes the nearest one inside the radius", () => {
    expect(nearestGuideAnchor(anchors, 1.02, 0.12)?.timeSec).toBe(1.0);
    expect(nearestGuideAnchor(anchors, 2.44, 0.12)?.timeSec).toBe(2.5);
  });

  it("leaves the raw time alone when nothing is close enough", () => {
    // Nothing is ever dragged across the screen to an event the author was not aiming at.
    expect(nearestGuideAnchor(anchors, 1.6, 0.12)).toBeNull();
  });

  it("takes nothing at all when the radius is zero", () => {
    expect(nearestGuideAnchor(anchors, 1.0, 0)).toBeNull();
  });

  it("takes nothing from an empty set", () => {
    expect(nearestGuideAnchor([], 1.0, 1)).toBeNull();
  });

  it("prefers an end over a start at the same instant", () => {
    // Where one sound stops and the next begins, someone dragging the end of a hold was
    // looking for where to let go.
    const together = buildGuideAnchors(
      [event("ev-a", 1.0, "drums", 5.0), event("ev-b", 5.0, "bass")],
      ALL,
      { includeEnds: true },
    );
    const chosen = nearestGuideAnchor(together, 5.0, 0.2);
    expect(chosen?.edge).toBe("end");
    expect(chosen?.eventId).toBe("ev-a");
  });

  it("breaks a remaining tie the same way every time", () => {
    const together = [
      event("ev-c", 7.0, "vocals"),
      event("ev-a", 7.0, "drums"),
    ];
    const once = nearestGuideAnchor(buildGuideAnchors(together, ALL), 7.0, 0.2);
    const again = nearestGuideAnchor(
      buildGuideAnchors([...together].reverse(), ALL), 7.0, 0.2,
    );
    expect(once?.eventId).toBe(again?.eventId);
    expect(once?.eventId).toBe("ev-a");
  });

  it("names what it chose, for the status line", () => {
    const chosen = nearestGuideAnchor(anchors, 2.0, 0.2)!;
    expect(describeAnchor(chosen)).toBe("bass start @ 2.000s");
  });
});

describe("the one resolver every placement goes through", () => {
  const anchors = buildGuideAnchors(events, ALL);
  const base = {
    snap: DEFAULT_SNAP,
    grid: [0, 0.5, 1.5, 2.5],
    anchors,
    pixelsPerSecond: 100,
  };

  it("leaves the raw time alone when snapping is off", () => {
    expect(resolvePlacementTime({ ...base, rawTimeSec: 1.234, snapMode: "off" }))
      .toEqual({ timeSec: 1.234, anchor: null });
  });

  it("uses the beat grid in beat mode, and reports no anchor", () => {
    const result = resolvePlacementTime({ ...base, rawTimeSec: 1.4, snapMode: "beat" });
    expect(result.timeSec).toBe(1.5);
    expect(result.anchor).toBeNull();
  });

  it("uses a guide anchor in guide mode, and says which", () => {
    const result = resolvePlacementTime({ ...base, rawTimeSec: 1.05, snapMode: "guide" });
    expect(result.timeSec).toBe(1.0);
    expect(result.anchor?.eventId).toBe("ev-1");
  });

  it("keeps the raw time in guide mode when nothing is near", () => {
    const result = resolvePlacementTime({ ...base, rawTimeSec: 1.6, snapMode: "guide" });
    expect(result.timeSec).toBe(1.6);
    expect(result.anchor).toBeNull();
  });

  it("snaps over a wider slice of time when zoomed out", () => {
    // 1.6 is 0.6 s from the nearest anchor: out of reach at 100 px/s, within reach at 15.
    expect(resolvePlacementTime({
      ...base, rawTimeSec: 1.6, snapMode: "guide", pixelsPerSecond: 100,
    }).anchor).toBeNull();
    expect(resolvePlacementTime({
      ...base, rawTimeSec: 1.6, snapMode: "guide", pixelsPerSecond: 15,
    }).anchor?.timeSec).toBe(2.0);
  });

  it("never returns a negative time", () => {
    expect(resolvePlacementTime({ ...base, rawTimeSec: -5, snapMode: "off" }).timeSec)
      .toBe(0);
    expect(resolvePlacementTime({ ...base, rawTimeSec: -5, snapMode: "guide" }).timeSec)
      .toBe(0);
  });

  it("ignores the beat grid in guide mode and the anchors in beat mode", () => {
    // The modes are exclusive: a beat and an onset are different questions, and a note is
    // always aligned to one or the other.
    expect(resolvePlacementTime({ ...base, rawTimeSec: 1.05, snapMode: "guide" }).timeSec)
      .toBe(1.0);
    expect(resolvePlacementTime({ ...base, rawTimeSec: 1.05, snapMode: "beat" }).timeSec)
      .toBe(1.5);
  });

  it("gives every kind of placement the same answer for the same click", () => {
    // Single, Purple, Flick, a Slide point, a Long's start and end all call this with the
    // same arguments, so they cannot snap differently from one another.
    const once = resolvePlacementTime({ ...base, rawTimeSec: 2.03, snapMode: "guide" });
    for (let i = 0; i < 5; i += 1) {
      expect(resolvePlacementTime({ ...base, rawTimeSec: 2.03, snapMode: "guide" }))
        .toEqual(once);
    }
  });

  it("can reach an event end when given the end anchors", () => {
    const withEnds = buildGuideAnchors(events, ALL, { includeEnds: true });
    const result = resolvePlacementTime({
      ...base, anchors: withEnds, rawTimeSec: 2.47, snapMode: "guide",
    });
    expect(result.timeSec).toBe(2.5);
    expect(result.anchor?.edge).toBe("end");
  });

  it("cannot reach an event end when given only the start anchors", () => {
    const result = resolvePlacementTime({ ...base, rawTimeSec: 2.47, snapMode: "guide" });
    expect(result.anchor).toBeNull();
  });
});
