/**
 * Decorations and the magnet, and the geometry of the two surfaces they are edited on.
 *
 * The snapping half is the reason decorations went through `buildMagnetCandidates`
 * instead of getting a magnet of their own: one list, one threshold, one hysteresis, one
 * guide. So what is checked here is mostly that a decoration is *just another source* -
 * that it snaps to the same things a note does, that notes snap to it, and that the notes'
 * own behaviour did not change when it was added.
 */

import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import type { ChartNote } from "./chart";
import type { ChartDecoration } from "./decoration";
import { buildGuideAnchors } from "./guideAnchors";
import {
  buildMagnetCandidates, magnetSnapDelta, magnetSnapEdge, describeCandidate,
  type SnapCandidate,
} from "./magnetSnap";
import {
  DECORATION_HANDLE_PX, MIN_DECORATION_WIDTH_PX, MIN_GRIP_BAR_PX, MIN_STAGE_HIT_PX,
  decorationRowGeometry, decorationsInRect, estimateTextEms, fitStage, hitTestDecoration,
  hitTestStage, stagePoint, stagePosition, stageTextBox,
} from "./decorationGeometry";
import type { Viewport } from "./viewport";

const decoration = (
  id: string,
  startTimeSec: number,
  endTimeSec?: number,
  over: Partial<ChartDecoration> = {},
): ChartDecoration => ({
  id,
  type: "text",
  startTimeSec,
  ...(endTimeSec !== undefined ? { endTimeSec } : {}),
  position: { x: 0.5, y: 0.5 },
  text: "HI",
  ...over,
});

const note = (id: string, timeSec: number, endTimeSec?: number): ChartNote => ({
  id,
  type: endTimeSec === undefined ? "tap" : "hold",
  timeSec,
  lane: 0,
  ...(endTimeSec === undefined ? {} : { endTimeSec }),
});

const events = (
  specs: readonly { id: string; startSec: number; lane: LaneId }[],
): readonly ProjectedEvent[] =>
  specs.map((spec) => ({
    id: spec.id,
    type: "onset",
    startSec: spec.startSec,
    endKind: "instantaneous" as const,
    detectorId: "det",
    stemId: `stem-${spec.lane}`,
    lane: spec.lane,
  }));

const ALL_LANES: ReadonlySet<LaneId> = new Set<LaneId>(["drums", "other", "bass", "vocals"]);

/** A drag of one edge, stated the way the Timeline states it. */
const edgeTo = (
  candidates: readonly SnapCandidate[],
  at: number,
  bounds: { minTimeSec?: number; maxTimeSec?: number } = {},
) =>
  magnetSnapEdge({
    candidates,
    rawTimeSec: at,
    ...bounds,
    pixelsPerSecond: 100,
    enabled: true,
  });

describe("a decoration as a snap candidate", () => {
  it("offers both edges of its window", () => {
    const candidates = buildMagnetCandidates({
      decorations: [decoration("dec-0001", 5, 7)],
    });
    expect(candidates).toEqual([
      { timeSec: 5, kind: "decoration-start", decorationId: "dec-0001" },
      { timeSec: 7, kind: "decoration-end", decorationId: "dec-0001" },
    ]);
  });

  it("offers the default end for one that states none", () => {
    // The end an author can actually see on the timeline, so lining a caption up with
    // where the previous one visibly stops lands on something.
    const candidates = buildMagnetCandidates({
      decorations: [decoration("dec-0001", 5)],
    });
    expect(candidates.map((c) => c.timeSec)).toEqual([5, 6]);
  });

  it("is excluded while it is the thing being dragged", () => {
    const candidates = buildMagnetCandidates({
      decorations: [decoration("dec-0001", 5, 7), decoration("dec-0002", 9, 10)],
      excludeDecorationIds: new Set(["dec-0001"]),
    });
    expect(candidates.every((c) => c.decorationId !== "dec-0001")).toBe(true);
    expect(candidates).toHaveLength(2);
  });

  it("collapses onto a beat at the same instant, so one guide is drawn", () => {
    const candidates = buildMagnetCandidates({
      beatGrid: [5],
      decorations: [decoration("dec-0001", 5, 7)],
    });
    expect(candidates.filter((c) => c.timeSec === 5)).toHaveLength(1);
    // The beat wins the collapse: it is the more useful thing to say about where
    // something went.
    expect(candidates[0]?.kind).toBe("beat");
  });

  it("sits between the note edges and the events in the tie-break order", () => {
    const candidates = buildMagnetCandidates({
      beatGrid: [],
      notes: [note("n-0001", 5)],
      decorations: [decoration("dec-0001", 5.0001, 7)],
      eventAnchors: buildGuideAnchors(
        events([{ id: "ev-1", startSec: 5.0002, lane: "vocals" }]),
        ALL_LANES,
      ),
    });
    expect(candidates.map((c) => c.kind)).toEqual([
      "note-start", "decoration-start", "event", "decoration-end",
    ]);
  });

  it("names what a decoration edge was, for the status line", () => {
    expect(describeCandidate({
      timeSec: 2, kind: "decoration-start", decorationId: "dec-0001",
    })).toBe("dec-0001 start @ 2.000s");
    expect(describeCandidate({
      timeSec: 3, kind: "decoration-end", decorationId: "dec-0001",
    })).toBe("dec-0001 end @ 3.000s");
    // And the note wording is exactly what it was.
    expect(describeCandidate({ timeSec: 2, kind: "note-start", noteId: "n-1" }))
      .toBe("n-1 start @ 2.000s");
    expect(describeCandidate({ timeSec: 2, kind: "beat" })).toBe("beat @ 2.000s");
  });
});

describe("dragging a decoration's edge onto something", () => {
  const sources = {
    beatGrid: [1, 2, 3, 4, 5],
    notes: [note("n-0001", 6.4), note("n-0002", 7, 7.8)],
    decorations: [decoration("dec-0001", 10, 11), decoration("dec-9999", 20, 21)],
    excludeDecorationIds: new Set(["dec-0001"]),
    eventAnchors: buildGuideAnchors(
      events([{ id: "ev-vox", startSec: 8.37, lane: "vocals" },
              { id: "ev-hit", startSec: 9.22, lane: "drums" }]),
      ALL_LANES,
    ),
  };
  const candidates = buildMagnetCandidates(sources);

  it("lands on a beat", () => {
    expect(edgeTo(candidates, 3.04).timeSec).toBe(3);
  });

  it("lands on a note's start and a note's end", () => {
    expect(edgeTo(candidates, 6.43).candidate?.kind).toBe("note-start");
    expect(edgeTo(candidates, 7.83).candidate?.kind).toBe("note-end");
  });

  it("lands on a vocal event and on a drum onset", () => {
    expect(edgeTo(candidates, 8.34).timeSec).toBe(8.37);
    expect(edgeTo(candidates, 9.25).timeSec).toBe(9.22);
  });

  it("lands on another decoration's edges", () => {
    expect(edgeTo(candidates, 20.03).candidate?.kind).toBe("decoration-start");
    expect(edgeTo(candidates, 20.97).candidate?.kind).toBe("decoration-end");
  });

  it("is never caught by its own two edges", () => {
    expect(candidates.every((c) => c.decorationId !== "dec-0001")).toBe(true);
    expect(edgeTo(candidates, 10.01).candidate).toBeNull();
  });

  it("stays where the hand put it outside the threshold", () => {
    expect(edgeTo(candidates, 3.4).candidate).toBeNull();
    expect(edgeTo(candidates, 3.4).timeSec).toBeCloseTo(3.4, 9);
  });

  it("prefers another decoration's edge to a beat that is nearer", () => {
    // Authored timings outrank the beat grid: at a fine division some grid line is
    // always within a few pixels, so nearest-wins alone would make lining one caption up
    // with another a thing the author could not reliably do.
    const close = buildMagnetCandidates({
      beatGrid: [4],
      decorations: [decoration("dec-0005", 4.03, 5)],
    });
    expect(edgeTo(close, 4.04).candidate?.kind).toBe("decoration-start");
    expect(edgeTo(close, 4.01).candidate?.kind).toBe("decoration-start");
  });

  it("takes the beat when no authored timing is in reach", () => {
    const far = buildMagnetCandidates({
      beatGrid: [4],
      decorations: [decoration("dec-0005", 4.5, 5)],
    });
    expect(edgeTo(far, 4.01).candidate?.kind).toBe("beat");
  });

  it("does not snap at all with the magnet suspended", () => {
    const free = magnetSnapEdge({
      candidates, rawTimeSec: 3.01, pixelsPerSecond: 100, enabled: false,
    });
    expect(free.candidate).toBeNull();
    expect(free.timeSec).toBeCloseTo(3.01, 9);
  });

  it("refuses a candidate that would invert the window, and keeps looking", () => {
    // Dragging the end back past the start: everything at or before the floor is not a
    // place this edge can go, however close it is.
    const bounded = edgeTo(candidates, 3.01, { minTimeSec: 3.5 });
    expect(bounded.candidate).toBeNull();
    expect(bounded.timeSec).toBe(3.5);
    expect(edgeTo(candidates, 4.02, { minTimeSec: 3.5 }).timeSec).toBe(4);
  });
});

describe("dragging a note onto a decoration", () => {
  it("snaps a note's start to a decoration's edge", () => {
    const candidates = buildMagnetCandidates({
      decorations: [decoration("dec-0001", 5, 7)],
      notes: [note("n-0001", 1)],
      excludeNoteIds: new Set(["n-0001"]),
    });
    const out = magnetSnapDelta({
      candidates,
      baseEdgesSec: [1],
      rawDeltaSec: 4.03,
      earliestMovingSec: 1,
      pixelsPerSecond: 100,
      enabled: true,
    });
    expect(out.candidate?.kind).toBe("decoration-start");
    expect(1 + out.deltaSec).toBeCloseTo(5, 9);
  });

  it("leaves the note magnet alone when there are no decorations", () => {
    // The regression that matters most: adding a source must not change what the notes
    // already did.
    const before = buildMagnetCandidates({ beatGrid: [1, 2], notes: [note("n-0001", 3)] });
    const after = buildMagnetCandidates({
      beatGrid: [1, 2], notes: [note("n-0001", 3)], decorations: [],
    });
    expect(after).toEqual(before);
  });

  it("still snaps a held note's two edges as it did", () => {
    const candidates = buildMagnetCandidates({
      beatGrid: [10, 11, 12, 13],
      decorations: [decoration("dec-0001", 40, 41)],
    });
    const out = magnetSnapDelta({
      candidates,
      baseEdgesSec: [10, 12],
      rawDeltaSec: 0.98,
      earliestMovingSec: 10,
      pixelsPerSecond: 100,
      enabled: true,
    });
    expect(out.deltaSec).toBeCloseTo(1, 9);
    expect(out.candidate?.kind).toBe("beat");
  });
});

describe("the timeline bar", () => {
  const row = { id: "decorations" as const, label: "Text", heightPx: 34, topPx: 100, bottomPx: 134 };
  const view = (pixelsPerSecond = 100, startSec = 0): Viewport => ({
    startSec, pixelsPerSecond, widthPx: 1000,
  });

  it("spans the window it will actually be shown for", () => {
    const geometry = decorationRowGeometry(decoration("dec-0001", 2, 4), row, view());
    expect(geometry.startPx).toBe(200);
    expect(geometry.endPx).toBe(400);
  });

  it("uses the default window for one with no stated end", () => {
    // So an author can see the second they did not ask for.
    const geometry = decorationRowGeometry(decoration("dec-0001", 2), row, view());
    expect(geometry.endPx - geometry.startPx).toBeCloseTo(100, 9);
  });

  it("never draws narrower than the hand can hit", () => {
    const geometry = decorationRowGeometry(decoration("dec-0001", 2, 2.01), row, view());
    expect(geometry.rightPx - geometry.leftPx).toBe(MIN_DECORATION_WIDTH_PX);
  });

  it("withholds the grips on a bar too narrow to leave a body", () => {
    const narrow = decorationRowGeometry(
      decoration("dec-0001", 2, 2 + (MIN_GRIP_BAR_PX - 1) / 100), row, view(),
    );
    expect(narrow.startHandle).toBeNull();
    expect(narrow.endHandle).toBeNull();

    // Zooming in gives them back.
    const wide = decorationRowGeometry(
      decoration("dec-0001", 2, 2 + (MIN_GRIP_BAR_PX - 1) / 100), row, view(400),
    );
    expect(wide.startHandle).not.toBeNull();
    expect(wide.endHandle).not.toBeNull();
    expect((wide.endHandle?.rightPx ?? 0) - (wide.endHandle?.leftPx ?? 0))
      .toBe(DECORATION_HANDLE_PX);
  });

  it("is hit at its body and at each grip", () => {
    const decorations = [decoration("dec-0001", 2, 4)];
    const middleY = 117;
    expect(hitTestDecoration(300, middleY, decorations, row, view())?.part).toBe("body");
    expect(hitTestDecoration(200, middleY, decorations, row, view())?.part).toBe("startHandle");
    expect(hitTestDecoration(400, middleY, decorations, row, view())?.part).toBe("endHandle");
    expect(hitTestDecoration(700, middleY, decorations, row, view())).toBeNull();
  });

  it("is still hit when it says nothing at all", () => {
    // The bar comes from the window, not from the text, so an empty caption is exactly
    // as clickable as a full one - which is what stops one becoming undeletable.
    const empty = [decoration("dec-0001", 2, 4, { text: "" })];
    expect(hitTestDecoration(300, 117, empty, row, view())?.decoration.id).toBe("dec-0001");
  });

  it("picks the one drawn on top when two overlap", () => {
    const overlapping = [decoration("dec-0001", 2, 4), decoration("dec-0002", 2, 4)];
    expect(hitTestDecoration(300, 117, overlapping, row, view())?.decoration.id)
      .toBe("dec-0002");
  });

  it("is caught by a rubber band that crosses it", () => {
    const decorations = [decoration("dec-0001", 2, 4), decoration("dec-0002", 8, 9)];
    const caught = decorationsInRect(
      { leftPx: 150, rightPx: 450, topPx: 90, bottomPx: 140 }, decorations, row, view(),
    );
    expect(caught.map((d) => d.id)).toEqual(["dec-0001"]);
  });

  it("is not caught by a band that misses its row", () => {
    const caught = decorationsInRect(
      { leftPx: 150, rightPx: 450, topPx: 0, bottomPx: 50 },
      [decoration("dec-0001", 2, 4)], row, view(),
    );
    expect(caught).toEqual([]);
  });
});

describe("the stage", () => {
  it("keeps the playfield's proportions inside whatever space it is given", () => {
    const stage = fitStage(400, 200, 3 / 4);
    expect(stage.heightPx).toBe(200);
    expect(stage.widthPx).toBeCloseTo(150, 9);
    expect(stage.leftPx).toBeCloseTo(125, 9);

    const tall = fitStage(120, 400, 3 / 4);
    expect(tall.widthPx).toBeCloseTo(120, 9);
    expect(tall.heightPx).toBeCloseTo(160, 9);
  });

  it("converts a normalized position to pixels and back", () => {
    const stage = fitStage(300, 400, 3 / 4);
    const point = stagePoint({ x: 0.25, y: 0.75 }, stage);
    const back = stagePosition(point.xPx, point.yPx, stage);
    expect(back.x).toBeCloseTo(0.25, 9);
    expect(back.y).toBeCloseTo(0.75, 9);
  });

  it("puts the corners where the coordinates say", () => {
    const stage = fitStage(300, 400, 3 / 4);
    expect(stagePoint({ x: 0, y: 0 }, stage)).toEqual({
      xPx: stage.leftPx, yPx: stage.topPx,
    });
    expect(stagePoint({ x: 1, y: 1 }, stage)).toEqual({
      xPx: stage.leftPx + stage.widthPx, yPx: stage.topPx + stage.heightPx,
    });
  });

  it("boxes a caption around the point its alignment names", () => {
    const stage = fitStage(300, 400, 3 / 4);
    const centre = stagePoint({ x: 0.5, y: 0.5 }, stage);
    const centred = stageTextBox(decoration("dec-0001", 1), stage, 80);
    expect((centred.leftPx + centred.rightPx) / 2).toBeCloseTo(centre.xPx, 9);

    const left = stageTextBox(
      decoration("dec-0001", 1, undefined, { style: { align: "left" } }), stage, 80,
    );
    expect(left.leftPx).toBeCloseTo(centre.xPx, 9);

    const right = stageTextBox(
      decoration("dec-0001", 1, undefined, { style: { align: "right" } }), stage, 80,
    );
    expect(right.rightPx).toBeCloseTo(centre.xPx, 9);
  });

  it("keeps an empty caption big enough to click", () => {
    const stage = fitStage(300, 400, 3 / 4);
    const box = stageTextBox(decoration("dec-0001", 1, undefined, { text: "" }), stage, 0);
    expect(box.rightPx - box.leftPx).toBe(MIN_STAGE_HIT_PX);
    expect(box.bottomPx - box.topPx).toBeGreaterThanOrEqual(MIN_STAGE_HIT_PX);
  });

  it("keeps a tiny font big enough to click", () => {
    const stage = fitStage(300, 400, 3 / 4);
    const tiny = decoration("dec-0001", 1, undefined, { style: { fontSize: 0.001 } });
    const box = stageTextBox(tiny, stage, 2);
    expect(box.bottomPx - box.topPx).toBe(MIN_STAGE_HIT_PX);
  });

  it("selects the one in front when boxes overlap", () => {
    const stage = fitStage(300, 400, 3 / 4);
    const back = decoration("dec-0001", 1);
    const front = decoration("dec-0002", 1);
    const boxes = [
      { decoration: back, box: stageTextBox(back, stage, 100) },
      { decoration: front, box: stageTextBox(front, stage, 100) },
    ];
    const centre = stagePoint({ x: 0.5, y: 0.5 }, stage);
    expect(hitTestStage(centre.xPx, centre.yPx, boxes)?.id).toBe("dec-0002");
    expect(hitTestStage(0, 0, boxes)).toBeNull();
  });

  it("gives a Japanese caption roughly twice the width per character", () => {
    // The fallback estimate only, for the hit test before anything is measured. What
    // matters is that a Japanese caption's box is not sized as if it were Latin.
    expect(estimateTextEms("HELLO")).toBeCloseTo(3, 9);
    expect(estimateTextEms("キラメキ")).toBeCloseTo(4, 9);
    expect(estimateTextEms("")).toBe(0);
  });
});
