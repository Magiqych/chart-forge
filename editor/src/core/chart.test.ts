import { describe, expect, it } from "vitest";

import {
  deleteNote, emptyChart, noteAt, placeNote, projectChart, serializeChart,
  ChartError, DEFAULT_LANE_COUNT,
} from "./chart";

const CHART_DOCUMENT = {
  version: "0.1.0",
  metadata: { title: "Example Song", charter: "someone" },
  audio: { path: "song.wav", durationSec: 8 },
  timing: { offsetSec: 0, bpm: 120, beatsPerBar: 4 },
  playfield: { laneCount: 5, profile: "generic" },
  notes: [
    { id: "n-0001", type: "tap", timeSec: 0, lane: 2, sourceEventId: "ev-0001" },
    { id: "n-0003", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2.75 },
    { id: "n-0002", type: "flick", timeSec: 2, lane: 4, direction: "right" as const },
  ],
  extensions: {},
};

const blank = () => emptyChart({ audioPath: "song.wav", audioDurationSec: 8 });

describe("emptyChart", () => {
  it("produces a document a project with no chart can start from", () => {
    const state = blank();
    expect(state.notes).toEqual([]);
    expect(state.laneCount).toBe(DEFAULT_LANE_COUNT);

    const document = serializeChart(state);
    expect(document["version"]).toBe("0.1.0");
    expect(document["playfield"]).toEqual({ laneCount: 5, profile: "generic" });
    expect(document["notes"]).toEqual([]);
  });

  it("states only the timing it can honestly state", () => {
    // The Analyzer emits detected beats and no tempo map, so a bpm written here would
    // describe a uniform grid the recording does not have.
    expect(serializeChart(blank())["timing"]).toEqual({ offsetSec: 0 });
  });
});

describe("projectChart", () => {
  it("reads a chart and sorts its notes into contract order", () => {
    const state = projectChart(CHART_DOCUMENT);
    expect(state.notes.map((n) => n.id)).toEqual(["n-0001", "n-0003", "n-0002"]);
    expect(state.laneCount).toBe(5);
  });

  it("keeps note types it cannot author", () => {
    const state = projectChart(CHART_DOCUMENT);
    const hold = state.notes.find((n) => n.id === "n-0003");
    expect(hold?.type).toBe("hold");
    expect(hold?.endTimeSec).toBe(2.75);
  });

  it("continues numbering after the highest existing id", () => {
    expect(projectChart(CHART_DOCUMENT).nextIdSeq).toBe(4);
  });

  it("rejects a document it would otherwise mis-draw", () => {
    expect(() => projectChart({ ...CHART_DOCUMENT, version: "0.2.0" })).toThrow(ChartError);
    expect(() => projectChart({ ...CHART_DOCUMENT, playfield: {} })).toThrow(ChartError);
    expect(() =>
      projectChart({
        ...CHART_DOCUMENT,
        notes: [
          { id: "a", type: "tap", timeSec: 0, lane: 0 },
          { id: "a", type: "tap", timeSec: 1, lane: 0 },
        ],
      }),
    ).toThrow(/duplicate id/);
    expect(() =>
      projectChart({ ...CHART_DOCUMENT, notes: [{ id: "a", type: "tap", timeSec: 0, lane: 9 }] }),
    ).toThrow(/outside 0\.\.4/);
  });
});

describe("serializeChart", () => {
  it("round-trips a document that was not edited", () => {
    const document = serializeChart(projectChart(CHART_DOCUMENT));
    expect(document).toEqual({
      ...CHART_DOCUMENT,
      // Only the note order changes, and only into the ascending order the contract
      // requires; the fixture is deliberately out of order.
      notes: [CHART_DOCUMENT.notes[0], CHART_DOCUMENT.notes[1], CHART_DOCUMENT.notes[2]],
    });
  });

  it("preserves top-level fields this Editor does not model", () => {
    const withExtras = {
      ...CHART_DOCUMENT,
      extensions: { deresute: { unitCount: 5 } },
      somethingFuture: { kept: true },
    };
    const document = serializeChart(projectChart(withExtras));
    expect(document["extensions"]).toEqual({ deresute: { unitCount: 5 } });
    expect(document["somethingFuture"]).toEqual({ kept: true });
  });

  it("writes notes in ascending time order after an edit", () => {
    let state = projectChart(CHART_DOCUMENT);
    state = placeNote(state, { timeSec: 0.5, lane: 1, type: "tap" }).state;
    const notes = serializeChart(state)["notes"] as { timeSec: number }[];
    const times = notes.map((n) => n.timeSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("omits optional fields that were never set", () => {
    const { state } = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" });
    const notes = serializeChart(state)["notes"] as Record<string, unknown>[];
    expect(Object.keys(notes[0]!)).toEqual(["id", "type", "timeSec", "lane"]);
  });
});

describe("placeNote", () => {
  it("adds a note the author fully described", () => {
    const { state, note } = placeNote(blank(), { timeSec: 1.25, lane: 3, type: "tap" });
    expect(note).toEqual({ id: "n-0001", type: "tap", timeSec: 1.25, lane: 3 });
    expect(state.notes).toHaveLength(1);
  });

  it("does not carry any analysis provenance", () => {
    // sourceEventId is optional and hand-authored. Nothing in the placement path can
    // set it, which is what keeps an Analysis Event from becoming a Chart Note.
    const { note } = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" });
    expect(note.sourceEventId).toBeUndefined();
  });

  it("gives every note a fresh id", () => {
    let state = blank();
    for (let i = 0; i < 3; i += 1) {
      state = placeNote(state, { timeSec: i, lane: 0, type: "tap" }).state;
    }
    expect(state.notes.map((n) => n.id)).toEqual(["n-0001", "n-0002", "n-0003"]);
  });

  it("orders notes deterministically regardless of the order they were placed in", () => {
    let a = blank();
    a = placeNote(a, { timeSec: 2, lane: 0, type: "tap" }).state;
    a = placeNote(a, { timeSec: 1, lane: 0, type: "tap" }).state;

    let b = blank();
    b = placeNote(b, { timeSec: 1, lane: 0, type: "tap" }).state;
    b = placeNote(b, { timeSec: 2, lane: 0, type: "tap" }).state;

    expect(a.notes.map((n) => n.timeSec)).toEqual([1, 2]);
    expect(b.notes.map((n) => n.timeSec)).toEqual([1, 2]);
  });

  it("allows two notes at the same time in different lanes", () => {
    // A chord is normal, and the Chart contract does not forbid a shared timestamp.
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 0, type: "tap" }).state;
    state = placeNote(state, { timeSec: 1, lane: 4, type: "tap" }).state;
    expect(state.notes).toHaveLength(2);
    expect(state.notes.map((n) => n.lane)).toEqual([0, 4]);
  });

  it("allows two notes at the same time in the same lane, and keeps their order stable", () => {
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 2, type: "tap" }).state;
    state = placeNote(state, { timeSec: 1, lane: 2, type: "tap" }).state;
    expect(state.notes.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
    const again = serializeChart(state)["notes"] as { id: string }[];
    expect(again.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
  });

  it("records a flick's direction", () => {
    const { note } = placeNote(blank(), {
      timeSec: 1, lane: 2, type: "flick", direction: "up",
    });
    expect(note).toMatchObject({ type: "flick", direction: "up" });
  });

  it("rejects a lane outside the playfield", () => {
    expect(() => placeNote(blank(), { timeSec: 1, lane: 5, type: "tap" })).toThrow(/outside 0\.\.4/);
    expect(() => placeNote(blank(), { timeSec: 1, lane: -1, type: "tap" })).toThrow(ChartError);
    expect(() => placeNote(blank(), { timeSec: 1, lane: 1.5, type: "tap" })).toThrow(ChartError);
  });

  it("rejects a type a single click cannot fully describe", () => {
    expect(() =>
      // @ts-expect-error deliberately outside PlaceableType
      placeNote(blank(), { timeSec: 1, lane: 0, type: "hold" }),
    ).toThrow(/cannot place a hold/);
  });

  it("rejects a flick with no direction", () => {
    expect(() => placeNote(blank(), { timeSec: 1, lane: 0, type: "flick" })).toThrow(/needs a direction/);
  });

  it("rejects an impossible time", () => {
    expect(() => placeNote(blank(), { timeSec: -1, lane: 0, type: "tap" })).toThrow(ChartError);
    expect(() => placeNote(blank(), { timeSec: Number.NaN, lane: 0, type: "tap" })).toThrow(ChartError);
  });

  it("does not modify the state it was given", () => {
    const before = blank();
    placeNote(before, { timeSec: 1, lane: 0, type: "tap" });
    expect(before.notes).toHaveLength(0);
  });
});

describe("deleteNote", () => {
  it("removes the named note and leaves the rest alone", () => {
    const state = projectChart(CHART_DOCUMENT);
    const after = deleteNote(state, "n-0003");
    expect(after.notes.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
  });

  it("refuses an id that is not there rather than silently doing nothing", () => {
    expect(() => deleteNote(projectChart(CHART_DOCUMENT), "n-9999")).toThrow(/no note with id/);
  });

  it("never reissues the id of a deleted note", () => {
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 0, type: "tap" }).state;
    state = deleteNote(state, "n-0001");
    const { note } = placeNote(state, { timeSec: 2, lane: 0, type: "tap" });
    expect(note.id).toBe("n-0002");
  });

  it("does not modify the state it was given", () => {
    const before = projectChart(CHART_DOCUMENT);
    deleteNote(before, "n-0001");
    expect(before.notes).toHaveLength(3);
  });
});

describe("noteAt", () => {
  const state = projectChart(CHART_DOCUMENT);

  it("finds a note within the tolerance in the same lane", () => {
    expect(noteAt(state, 0.02, 2, 0.05)?.id).toBe("n-0001");
  });

  it("ignores a note in another lane", () => {
    expect(noteAt(state, 0.0, 3, 0.05)).toBeNull();
  });

  it("returns nothing when the click is too far away", () => {
    expect(noteAt(state, 0.5, 2, 0.05)).toBeNull();
  });

  it("returns the closest note when two are in range", () => {
    let crowded = blank();
    crowded = placeNote(crowded, { timeSec: 1.0, lane: 0, type: "tap" }).state;
    crowded = placeNote(crowded, { timeSec: 1.1, lane: 0, type: "tap" }).state;
    expect(noteAt(crowded, 1.09, 0, 0.2)?.id).toBe("n-0002");
  });
});
