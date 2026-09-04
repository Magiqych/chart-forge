import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import {
  distanceToBox, eventBox, hitTestAnalysisEvent, pitchRangesFor,
  HIT_TOLERANCE_PX, SPAN_HEIGHT_PX, TICK_INSET_PX,
  type LaneHitTarget,
} from "./eventGeometry";
import type { Viewport } from "./viewport";

/** 100 px/s starting at 10 s, so time 10 s is x = 0 and every second is 100 px. */
const VIEW: Viewport = { startSec: 10, pixelsPerSecond: 100, widthPx: 800 };

const ROW = { topPx: 100, heightPx: 46 };
const PITCH_ROW = { topPx: 200, heightPx: 74 };
const RANGE = { minMidi: 40, maxMidi: 80 };

function tick(id: string, startSec: number, overrides: Partial<ProjectedEvent> = {}): ProjectedEvent {
  return {
    id, type: "onset", startSec, endKind: "instantaneous",
    detectorId: "librosa.onset", stemId: "stem-drums", lane: "drums", ...overrides,
  };
}

function span(
  id: string, startSec: number, endSec: number, midi: number,
  overrides: Partial<ProjectedEvent> = {},
): ProjectedEvent {
  return {
    id, type: "pitchRun", startSec, endSec, endKind: "bounded",
    detectorId: "torchcrepe", stemId: "stem-vocals", lane: "vocals",
    pitch: { hz: 440, midi, name: "A4" },
    ...overrides,
  };
}

const drumsTarget = (events: readonly ProjectedEvent[]): LaneHitTarget => ({
  lane: "drums", row: ROW, range: RANGE, events,
});

const vocalsTarget = (events: readonly ProjectedEvent[]): LaneHitTarget => ({
  lane: "vocals", row: PITCH_ROW, range: RANGE, events,
});

describe("eventBox", () => {
  it("gives an instantaneous event a zero-width box inset inside its row", () => {
    const box = eventBox(tick("ev-1", 11), ROW, VIEW, RANGE);
    expect(box.leftPx).toBe(100);
    expect(box.rightPx).toBe(100);
    expect(box.topPx).toBe(ROW.topPx + TICK_INSET_PX);
    expect(box.bottomPx).toBe(ROW.topPx + ROW.heightPx - TICK_INSET_PX);
  });

  it("gives a bounded event a box spanning its duration at its pitch", () => {
    const box = eventBox(span("ev-2", 11, 11.5, 60), PITCH_ROW, VIEW, RANGE);
    expect(box.leftPx).toBe(100);
    expect(box.rightPx).toBe(150);
    expect(box.bottomPx - box.topPx).toBeCloseTo(SPAN_HEIGHT_PX, 10);
  });

  it("keeps a very short bounded event wide enough to see and to click", () => {
    const box = eventBox(span("ev-3", 11, 11.001, 60), PITCH_ROW, VIEW, RANGE);
    expect(box.rightPx - box.leftPx).toBeGreaterThanOrEqual(2);
  });

  it("places a higher pitch higher on the screen", () => {
    const low = eventBox(span("ev-low", 11, 12, 45), PITCH_ROW, VIEW, RANGE);
    const high = eventBox(span("ev-high", 11, 12, 75), PITCH_ROW, VIEW, RANGE);
    expect(high.topPx).toBeLessThan(low.topPx);
  });

  it("treats an unknown end like a tick, because only the start was measured", () => {
    const box = eventBox(tick("ev-4", 11, { endKind: "unknown" }), ROW, VIEW, RANGE);
    expect(box.leftPx).toBe(box.rightPx);
  });
});

describe("distanceToBox", () => {
  it("is zero inside the box", () => {
    expect(distanceToBox(105, 110, { leftPx: 100, rightPx: 110, topPx: 100, bottomPx: 120 }))
      .toBe(0);
  });

  it("measures to the nearest edge outside it", () => {
    const box = { leftPx: 100, rightPx: 110, topPx: 100, bottomPx: 120 };
    expect(distanceToBox(94, 110, box)).toBe(6);
    expect(distanceToBox(105, 126, box)).toBe(6);
  });
});

describe("hitTestAnalysisEvent — instantaneous", () => {
  const events = [tick("ev-1", 11)];

  it("hits a tick clicked exactly on it", () => {
    const hit = hitTestAnalysisEvent(100, 120, VIEW, [drumsTarget(events)]);
    expect(hit?.event.id).toBe("ev-1");
    expect(hit?.lane).toBe("drums");
    expect(hit?.distancePx).toBe(0);
  });

  it("hits a tick clicked just beside it", () => {
    expect(hitTestAnalysisEvent(104, 120, VIEW, [drumsTarget(events)])?.event.id).toBe("ev-1");
  });

  it("misses a tick clicked well away horizontally", () => {
    expect(hitTestAnalysisEvent(140, 120, VIEW, [drumsTarget(events)])).toBeNull();
  });

  it("misses a tick clicked outside its row", () => {
    // Well above the lane: the tick is inset inside its row and does not extend here.
    expect(hitTestAnalysisEvent(100, 20, VIEW, [drumsTarget(events)])).toBeNull();
  });
});

describe("hitTestAnalysisEvent — bounded", () => {
  const events = [span("ev-2", 11, 11.5, 60)];
  const box = eventBox(events[0]!, PITCH_ROW, VIEW, RANGE);
  const midY = (box.topPx + box.bottomPx) / 2;

  it("hits anywhere inside the span", () => {
    expect(hitTestAnalysisEvent(125, midY, VIEW, [vocalsTarget(events)])?.event.id).toBe("ev-2");
    expect(hitTestAnalysisEvent(100, midY, VIEW, [vocalsTarget(events)])?.event.id).toBe("ev-2");
    expect(hitTestAnalysisEvent(150, midY, VIEW, [vocalsTarget(events)])?.event.id).toBe("ev-2");
  });

  it("misses a click past the end of the span", () => {
    expect(hitTestAnalysisEvent(200, midY, VIEW, [vocalsTarget(events)])).toBeNull();
  });

  it("misses a click at the right time but the wrong pitch", () => {
    // Vertical position carries the pitch, so a span is not a full-height column: two
    // runs an octave apart at the same instant must be separately clickable.
    expect(hitTestAnalysisEvent(125, midY + 30, VIEW, [vocalsTarget(events)])).toBeNull();
  });

  it("picks the run whose pitch is under the pointer when two overlap in time", () => {
    const low = span("ev-low", 11, 12, 45);
    const high = span("ev-high", 11, 12, 75);
    const lowBox = eventBox(low, PITCH_ROW, VIEW, RANGE);
    const highBox = eventBox(high, PITCH_ROW, VIEW, RANGE);
    const target = vocalsTarget([low, high]);

    expect(hitTestAnalysisEvent(150, (lowBox.topPx + lowBox.bottomPx) / 2, VIEW, [target])
      ?.event.id).toBe("ev-low");
    expect(hitTestAnalysisEvent(150, (highBox.topPx + highBox.bottomPx) / 2, VIEW, [target])
      ?.event.id).toBe("ev-high");
  });
});

describe("hitTestAnalysisEvent — overlap resolution", () => {
  it("prefers the nearer event", () => {
    const target = drumsTarget([tick("ev-far", 11), tick("ev-near", 11.03)]);
    // x = 100 and x = 103; a click at 103 is on the second.
    expect(hitTestAnalysisEvent(103, 120, VIEW, [target])?.event.id).toBe("ev-near");
  });

  it("prefers the lane drawn on top when two are equally near", () => {
    // drums is drawn first and vocals last, so vocals is what the author can see.
    const drums = tick("ev-drums", 11);
    const vocals = span("ev-vocals", 11, 11.2, 60, { lane: "vocals" });
    const vocalsBox = eventBox(vocals, ROW, VIEW, RANGE);
    const y = (vocalsBox.topPx + vocalsBox.bottomPx) / 2;

    // Both lanes share a row here purely so the two boxes can overlap exactly.
    const hit = hitTestAnalysisEvent(100, y, VIEW, [
      { lane: "drums", row: ROW, range: RANGE, events: [drums] },
      { lane: "vocals", row: ROW, range: RANGE, events: [vocals] },
    ]);
    expect(hit?.event.id).toBe("ev-vocals");
  });

  it("falls back to startSec and then to id, never to scan order", () => {
    // Same lane, same distance, same start: only the id can decide, and it decides the
    // same way whichever order the events arrive in.
    const a = tick("ev-aaa", 11);
    const b = tick("ev-bbb", 11);
    expect(hitTestAnalysisEvent(100, 120, VIEW, [drumsTarget([a, b])])?.event.id).toBe("ev-aaa");
    expect(hitTestAnalysisEvent(100, 120, VIEW, [drumsTarget([b, a])])?.event.id).toBe("ev-aaa");
  });

  it("is stable across repeated calls with the same input", () => {
    const target = drumsTarget([tick("ev-1", 11), tick("ev-2", 11), tick("ev-3", 11)]);
    const ids = new Set(
      Array.from({ length: 20 }, () => hitTestAnalysisEvent(100, 120, VIEW, [target])?.event.id),
    );
    expect(ids.size).toBe(1);
  });
});

describe("hitTestAnalysisEvent — what is not selectable", () => {
  it("cannot select an event whose layer is hidden", () => {
    // A hidden lane is simply not among the targets, which is what the caller does when
    // its layer is switched off.
    expect(hitTestAnalysisEvent(100, 120, VIEW, [])).toBeNull();
  });

  it("cannot select an event outside the viewport", () => {
    // 60 s is far past the right edge at this zoom, so its box is nowhere near a click.
    const target = drumsTarget([tick("ev-offscreen", 60)]);
    expect(hitTestAnalysisEvent(100, 120, VIEW, [target])).toBeNull();
    expect(hitTestAnalysisEvent(799, 120, VIEW, [target])).toBeNull();
  });

  it("respects a caller-supplied tolerance", () => {
    const target = drumsTarget([tick("ev-1", 11)]);
    expect(hitTestAnalysisEvent(110, 120, VIEW, [target], HIT_TOLERANCE_PX)).toBeNull();
    expect(hitTestAnalysisEvent(110, 120, VIEW, [target], 20)?.event.id).toBe("ev-1");
  });

  it("returns null when there is nothing to hit", () => {
    expect(hitTestAnalysisEvent(100, 120, VIEW, [drumsTarget([])])).toBeNull();
  });
});

describe("pitchRangesFor", () => {
  it("gives each lane its own scale", () => {
    const byLane: Record<LaneId, ProjectedEvent[]> = {
      drums: [],
      other: [],
      bass: [span("b1", 0, 1, 36, { lane: "bass" }), span("b2", 1, 2, 48, { lane: "bass" })],
      vocals: [span("v1", 0, 1, 60), span("v2", 1, 2, 72)],
    };
    const ranges = pitchRangesFor({ eventsByLane: byLane });
    // Bass sits far below vocals; a shared scale would flatten both.
    expect(ranges.bass.maxMidi).toBeLessThan(ranges.vocals.maxMidi);
    expect(ranges.bass.minMidi).toBeLessThan(ranges.vocals.minMidi);
  });
});
