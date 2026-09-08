import { describe, expect, it } from "vitest";

import {
  canCarryEnd, canCarryEndAction, connectSlide, connectSlides, deleteNote, deleteNotes,
  disconnectSlide, emptyChart, endFlickDirection, flickEndAction, isBoundedPlaceable,
  chainOf, connectRun, connectionsTouching, disconnectRun, isConnected,
  isSlideChain, isSlidePoint, isStandaloneFlick, moveNotes, noteAt, placeNote,
  projectChart, resizeNote, serializeChart, setEndAction, setFlickDirection, setNoteStart,
  slidePoints,
  travelsBetweenLanes, whyNotConnectable, whyNotConnectableRun, type ChartNote,
  ChartError, DEFAULT_LANE_COUNT, DIRECTIONS, FLICK_DIRECTIONS, MIN_HELD_DURATION_SEC,
  PLACEABLE_TYPES,
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

  it("rejects a kind this Editor does not offer", () => {
    // `type` is an open vocabulary in the Chart contract, so a chart may legitimately
    // arrive carrying kinds this Editor cannot author. Reading and drawing one is fine;
    // placing one it has no gesture for is not.
    expect(() =>
      // @ts-expect-error deliberately outside PlaceableType
      placeNote(blank(), { timeSec: 1, lane: 0, type: "damage" }),
    ).toThrow(/cannot place a damage/);
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

describe("purple, which the Editor no longer authors", () => {
  it("is not among the kinds that can be placed", () => {
    expect(PLACEABLE_TYPES).not.toContain("purple");
    expect([...PLACEABLE_TYPES]).toEqual(["tap", "hold", "slide", "flick"]);
  });

  it("refuses to place one", () => {
    expect(() =>
      // @ts-expect-error deliberately outside PlaceableType
      placeNote(blank(), { timeSec: 1, lane: 0, type: "purple" }),
    ).toThrow(/cannot place a purple/);
  });

  it("still loads a chart that has one, because the vocabulary is open", () => {
    // Nothing was removed from the contract, so an existing chart is still valid and
    // still readable. Retiring a kind from the toolbar must never make a document
    // unopenable.
    const loaded = projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "purple", timeSec: 1.5, lane: 2 }],
    });
    expect(loaded.notes[0]).toMatchObject({ type: "purple", timeSec: 1.5, lane: 2 });
  });

  it("writes it back untouched rather than rewriting it", () => {
    // Opening a chart is not permission to edit it. A kind the Editor does not author is
    // preserved exactly, like any other unfamiliar kind.
    const document = {
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "purple", timeSec: 1.5, lane: 2 }],
    };
    const round = serializeChart(projectChart(document)) as {
      notes: readonly Record<string, unknown>[];
    };
    expect(round.notes[0]).toEqual({ id: "n-0001", type: "purple", timeSec: 1.5, lane: 2 });
  });
});
describe("held notes", () => {
  it("is a bounded kind, stored as the contract's hold", () => {
    expect(PLACEABLE_TYPES).toContain("hold");
    expect(isBoundedPlaceable("hold")).toBe(true);
    const { note } = placeNote(blank(), {
      timeSec: 1, lane: 3, type: "hold", endTimeSec: 2.5,
    });
    expect(note.type).toBe("hold");
    expect(note.endTimeSec).toBe(2.5);
  });

  it("never sets an end lane", () => {
    // Moving between lanes is a slide, a different gesture the Editor does not author.
    const { note } = placeNote(blank(), {
      timeSec: 1, lane: 3, type: "hold", endTimeSec: 2.5,
    });
    expect(note.endLane).toBeUndefined();
    const notes = serializeChart(
      placeNote(blank(), { timeSec: 1, lane: 3, type: "hold", endTimeSec: 2.5 }).state,
    )["notes"] as Record<string, unknown>[];
    expect(notes[0]!["endLane"]).toBeUndefined();
  });

  it("refuses a zero-length hold", () => {
    // The ordinary way to reach this is snapping both ends of a drag onto one grid line.
    expect(() =>
      placeNote(blank(), { timeSec: 2, lane: 0, type: "hold", endTimeSec: 2 }),
    ).toThrow(/must end after it starts/);
  });

  it("refuses a hold that ends before it starts", () => {
    expect(() =>
      placeNote(blank(), { timeSec: 2, lane: 0, type: "hold", endTimeSec: 1.5 }),
    ).toThrow(/must end after it starts/);
  });

  it("refuses a hold with no end at all", () => {
    expect(() => placeNote(blank(), { timeSec: 1, lane: 0, type: "hold" }))
      .toThrow(/needs an end time/);
  });

  it("survives a save and a load, and still passes the contract's ordering", () => {
    const { state } = placeNote(blank(), {
      timeSec: 1, lane: 3, type: "hold", endTimeSec: 2.5,
    });
    const reloaded = projectChart(serializeChart(state));
    expect(reloaded.notes[0]).toEqual({
      id: "n-0001", type: "hold", timeSec: 1, lane: 3, endTimeSec: 2.5,
    });
  });
});

describe("the note taxonomy this Editor authors", () => {
  it("offers exactly the four gameplay kinds", () => {
    // Deresute's four: Tap, Long, Slide, Flick, stored as the Chart contract's own words.
    expect([...PLACEABLE_TYPES]).toEqual(["tap", "hold", "slide", "flick"]);
  });

  it("drags out only the one kind that has a length", () => {
    // A Slide used to be dragged out too. It is not any more: a slide is a chain of
    // judgement points, so the points are clicked down one at a time and joined
    // afterwards, which is also the shape a multi-point slide will need.
    expect(isBoundedPlaceable("hold")).toBe(true);
    expect(isBoundedPlaceable("slide")).toBe(false);
    expect(isBoundedPlaceable("tap")).toBe(false);
    expect(isBoundedPlaceable("flick")).toBe(false);
  });

  it("lets a Long and a Slide carry an end, and nothing else", () => {
    expect(canCarryEnd("hold")).toBe(true);
    expect(canCarryEnd("slide")).toBe(true);
    expect(canCarryEnd("tap")).toBe(false);
    expect(canCarryEnd("flick")).toBe(false);
  });

  it("knows which kinds travel between lanes", () => {
    // This is the whole difference between a Long and a Slide: both have a duration,
    // only one of them moves.
    expect(travelsBetweenLanes("slide")).toBe(true);
    expect(travelsBetweenLanes("hold")).toBe(false);
    expect(travelsBetweenLanes("tap")).toBe(false);
  });

  it("places a slide with the lane it travels to", () => {
    const { state } = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "slide", endTimeSec: 2, endLane: 3,
    });
    expect(state.notes[0]).toMatchObject({
      type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3,
    });
  });

  it("allows a slide that comes back to the lane it started in", () => {
    // Nothing about a slide requires it to end elsewhere; only a zero length is
    // rejected, and that is about the drag, not the lanes.
    const { state } = placeNote(blank(), {
      timeSec: 1, lane: 2, type: "slide", endTimeSec: 2, endLane: 2,
    });
    expect(state.notes[0]).toMatchObject({ lane: 2, endLane: 2 });
  });

  it("rejects an end lane on a kind that does not travel", () => {
    expect(() =>
      placeNote(blank(), { timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, endLane: 3 }),
    ).toThrow(/cannot travel between lanes/);
    expect(() =>
      placeNote(blank(), { timeSec: 1, lane: 0, type: "tap", endLane: 3 }),
    ).toThrow(/cannot travel between lanes/);
  });

  it("rejects an end lane outside the playfield", () => {
    expect(() =>
      placeNote(blank(), { timeSec: 1, lane: 0, type: "slide", endTimeSec: 2, endLane: 5 }),
    ).toThrow(/outside 0\.\.4/);
    expect(() =>
      placeNote(blank(), { timeSec: 1, lane: 0, type: "slide", endTimeSec: 2, endLane: -1 }),
    ).toThrow(ChartError);
  });

  it("rejects a slide with no length", () => {
    expect(() =>
      placeNote(blank(), { timeSec: 1, lane: 0, type: "slide", endTimeSec: 1, endLane: 3 }),
    ).toThrow(ChartError);
  });

  it("serialises a slide with the fields the contract already has", () => {
    const { state } = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "slide", endTimeSec: 2, endLane: 3,
    });
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0001", type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3,
    });
  });

  it("has no simultaneous kind", () => {
    // Two notes at the same time are two notes. Nothing in the model says otherwise, and
    // nothing should: it would be a fact about a pair, not a property of a note.
    expect(PLACEABLE_TYPES).not.toContain("simultaneous");
  });
});

describe("deleteNotes", () => {
  const three = () => {
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 0, type: "tap" }).state;
    state = placeNote(state, { timeSec: 2, lane: 1, type: "tap" }).state;
    state = placeNote(state, { timeSec: 3, lane: 2, type: "tap" }).state;
    return state;
  };

  it("removes several notes in one change", () => {
    const state = deleteNotes(three(), ["n-0001", "n-0003"]);
    expect(state.notes.map((note) => note.id)).toEqual(["n-0002"]);
  });

  it("leaves the state it was given alone", () => {
    const before = three();
    deleteNotes(before, ["n-0001", "n-0002"]);
    expect(before.notes).toHaveLength(3);
  });

  it("is a no-op for an empty list", () => {
    const before = three();
    expect(deleteNotes(before, [])).toBe(before);
  });

  it("refuses the whole batch when one id is unknown", () => {
    // Deleting fewer notes than the author was looking at is worse than refusing: they
    // would not notice until much later.
    const before = three();
    expect(() => deleteNotes(before, ["n-0001", "n-9999"])).toThrow(/n-9999/);
    expect(before.notes).toHaveLength(3);
  });

  it("does not hand a deleted id out again", () => {
    const { state } = placeNote(deleteNotes(three(), ["n-0002"]), {
      timeSec: 4, lane: 3, type: "tap",
    });
    expect(state.notes.map((note) => note.id)).toEqual(["n-0001", "n-0003", "n-0004"]);
  });
});

describe("flick direction", () => {
  it("offers Left and Right for authoring", () => {
    // The contract enumerates all eight compass points and every one of them is read,
    // drawn and written back untouched. Offering all eight for authoring would offer
    // choices this Editor has no opinion about, so the toolbar stays with the two.
    expect([...FLICK_DIRECTIONS]).toEqual(["left", "right"]);
    for (const value of FLICK_DIRECTIONS) {
      expect(DIRECTIONS).toContain(value);
    }
  });

  it("places a flick in each authored direction", () => {
    for (const direction of FLICK_DIRECTIONS) {
      const { state } = placeNote(blank(), { timeSec: 1, lane: 0, type: "flick", direction });
      expect(state.notes[0]).toMatchObject({ type: "flick", direction });
    }
  });

  it("writes the direction to the contract's own field", () => {
    const { state } = placeNote(blank(), {
      timeSec: 1, lane: 2, type: "flick", direction: "left",
    });
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0001", type: "flick", timeSec: 1, lane: 2, direction: "left",
    });
  });

  it("survives a round trip through the document", () => {
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 0, type: "flick", direction: "left" }).state;
    state = placeNote(state, { timeSec: 2, lane: 1, type: "flick", direction: "right" }).state;
    const reloaded = projectChart(serializeChart(state));
    expect(reloaded.notes.map((note) => note.direction)).toEqual(["left", "right"]);
  });

  it("reads a direction the Editor does not author without changing it", () => {
    // A chart written elsewhere may use any of the eight. It must come back out exactly
    // as it went in, rather than being normalised to something this toolbar can offer.
    const loaded = projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "flick", timeSec: 1, lane: 0, direction: "upLeft" }],
    });
    expect(loaded.notes[0]?.direction).toBe("upLeft");
    const document = serializeChart(loaded) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]?.["direction"]).toBe("upLeft");
  });

  it("still refuses a flick with no direction at all", () => {
    expect(() => placeNote(blank(), { timeSec: 1, lane: 0, type: "flick" }))
      .toThrow(/needs a direction/);
  });
});

describe("moving notes", () => {
  const three = () => {
    let state = blank();
    state = placeNote(state, { timeSec: 5, lane: 1, type: "tap" }).state;
    state = placeNote(state, { timeSec: 6, lane: 2, type: "hold", endTimeSec: 7 }).state;
    state = placeNote(state, { timeSec: 8, lane: 0, type: "slide" }).state;
    return state;
  };

  it("moves a note in time", () => {
    expect(moveNotes(three(), ["n-0001"], 2, 0).notes.find((n) => n.id === "n-0001")?.timeSec)
      .toBe(7);
  });

  it("moves a note across lanes", () => {
    expect(moveNotes(three(), ["n-0001"], 0, 2).notes.find((n) => n.id === "n-0001")?.lane)
      .toBe(3);
  });

  it("carries both ends of a held note, so a move is not a stretch", () => {
    const note = moveNotes(three(), ["n-0002"], 2, 0).notes.find((n) => n.id === "n-0002");
    expect(note?.timeSec).toBe(8);
    expect(note?.endTimeSec).toBe(9);
    expect((note?.endTimeSec as number) - (note?.timeSec as number)).toBe(1);
  });

  it("carries both lanes of a connected slide", () => {
    const withEnd = placeNote(three(), { timeSec: 9, lane: 3, type: "slide" }).state;
    const connected = connectSlide(withEnd, "n-0003", "n-0004");
    const note = moveNotes(connected, ["n-0003"], 0, 1).notes.find((n) => n.id === "n-0003");
    expect(note?.lane).toBe(1);
    expect(note?.endLane).toBe(4);
  });

  it("moves several notes together", () => {
    const state = moveNotes(three(), ["n-0001", "n-0003"], 1, 0);
    expect(state.notes.find((n) => n.id === "n-0001")?.timeSec).toBe(6);
    expect(state.notes.find((n) => n.id === "n-0003")?.timeSec).toBe(9);
  });

  it("clamps the whole group at the start of the recording, keeping its shape", () => {
    // Clamping each note on its own would pile them all onto zero and silently destroy
    // the rhythm the author had.
    const state = moveNotes(three(), ["n-0001", "n-0003"], -100, 0);
    expect(state.notes.find((n) => n.id === "n-0001")?.timeSec).toBe(0);
    expect(state.notes.find((n) => n.id === "n-0003")?.timeSec).toBe(3);
  });

  it("clamps the whole group at the edge of the playfield", () => {
    const state = moveNotes(three(), ["n-0001", "n-0002"], 0, 100);
    expect(state.notes.find((n) => n.id === "n-0001")?.lane).toBe(3);
    expect(state.notes.find((n) => n.id === "n-0002")?.lane).toBe(4);
  });

  it("never moves a note out of the playfield", () => {
    for (const delta of [-10, -1, 1, 10]) {
      const state = moveNotes(three(), ["n-0001", "n-0002", "n-0003"], 0, delta);
      for (const note of state.notes) {
        expect(note.lane).toBeGreaterThanOrEqual(0);
        expect(note.lane).toBeLessThan(state.laneCount);
      }
    }
  });

  it("keeps the notes sorted", () => {
    const times = moveNotes(three(), ["n-0001"], 10, 0).notes.map((n) => n.timeSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("does not modify the state it was given", () => {
    const before = three();
    moveNotes(before, ["n-0001"], 2, 1);
    expect(before.notes.find((n) => n.id === "n-0001"))
      .toMatchObject({ timeSec: 5, lane: 1 });
  });

  it("is a no-op that returns the same state when nothing would change", () => {
    const before = three();
    expect(moveNotes(before, ["n-0001"], 0, 0)).toBe(before);
    expect(moveNotes(before, [], 5, 1)).toBe(before);
  });

  it("refuses an unknown id", () => {
    expect(() => moveNotes(three(), ["n-9999"], 1, 0)).toThrow(/n-9999/);
  });
});

describe("resizing a held note", () => {
  const held = () =>
    placeNote(blank(), { timeSec: 5, lane: 1, type: "hold", endTimeSec: 6 }).state;

  it("makes it longer", () => {
    expect(resizeNote(held(), "n-0001", 9).notes[0]?.endTimeSec).toBe(9);
  });

  it("makes it shorter", () => {
    expect(resizeNote(held(), "n-0001", 5.5).notes[0]?.endTimeSec).toBe(5.5);
  });

  it("never moves where it starts", () => {
    for (const end of [5.5, 9, 100]) {
      expect(resizeNote(held(), "n-0001", end).notes[0]?.timeSec).toBe(5);
    }
  });

  it("stops at a minimum length rather than collapsing", () => {
    // Dragging the grip back past the start would make a zero-length hold, which is not
    // a hold. It stops instead of refusing, so the grip stays usable at the limit.
    const state = resizeNote(held(), "n-0001", 1);
    expect(state.notes[0]?.endTimeSec).toBe(5 + MIN_HELD_DURATION_SEC);
    expect(state.notes[0]?.endTimeSec).toBeGreaterThan(state.notes[0]?.timeSec as number);
  });

  it("does not modify the state it was given", () => {
    const before = held();
    resizeNote(before, "n-0001", 9);
    expect(before.notes[0]?.endTimeSec).toBe(6);
  });

  it("returns the same state when the end does not move", () => {
    const before = held();
    expect(resizeNote(before, "n-0001", 6)).toBe(before);
  });

  it("refuses a note with no end to move", () => {
    const tapOnly = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    expect(() => resizeNote(tapOnly, "n-0001", 3)).toThrow(/no end to move/);
  });

  it("refuses a slide, whose end is a place rather than a length", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    const connected = connectSlide(state, "n-0001", "n-0002");
    expect(() => resizeNote(connected, "n-0001", 5)).toThrow(/ends in a lane/);
  });

  it("refuses an unknown id", () => {
    expect(() => resizeNote(held(), "n-9999", 9)).toThrow(/n-9999/);
  });
});

describe("moving where a held note starts", () => {
  const held = () =>
    placeNote(blank(), { timeSec: 5, lane: 1, type: "hold", endTimeSec: 9 }).state;

  it("makes it start later", () => {
    expect(setNoteStart(held(), "n-0001", 6).notes[0]?.timeSec).toBe(6);
  });

  it("makes it start earlier", () => {
    expect(setNoteStart(held(), "n-0001", 2).notes[0]?.timeSec).toBe(2);
  });

  it("never moves where it ends", () => {
    for (const start of [2, 6, 8.9] as const) {
      expect(setNoteStart(held(), "n-0001", start).notes[0]?.endTimeSec).toBe(9);
    }
  });

  it("stops at a minimum length rather than collapsing or inverting", () => {
    for (const start of [9, 12, 1000] as const) {
      const state = setNoteStart(held(), "n-0001", start);
      expect(state.notes[0]?.timeSec).toBe(9 - MIN_HELD_DURATION_SEC);
      expect(state.notes[0]?.endTimeSec as number).toBeGreaterThan(
        state.notes[0]?.timeSec as number,
      );
    }
  });

  it("stops at the start of the recording", () => {
    expect(setNoteStart(held(), "n-0001", -4).notes[0]?.timeSec).toBe(0);
  });

  it("keeps the note's identity and everything else about it", () => {
    const before = held();
    const after = setNoteStart(before, "n-0001", 6);
    expect(after.notes[0]?.id).toBe(before.notes[0]?.id);
    expect(after.notes[0]?.lane).toBe(before.notes[0]?.lane);
    expect(after.notes[0]?.type).toBe(before.notes[0]?.type);
    expect(after.nextIdSeq).toBe(before.nextIdSeq);
  });

  it("re-sorts, because a chart is ordered by where its notes start", () => {
    let state = placeNote(blank(), { timeSec: 5, lane: 1, type: "hold", endTimeSec: 9 }).state;
    state = placeNote(state, { timeSec: 6, lane: 2, type: "tap" }).state;
    const after = setNoteStart(state, "n-0001", 7);
    expect(after.notes.map((note) => note.timeSec)).toEqual([6, 7]);
  });

  it("does not modify the state it was given", () => {
    const before = held();
    setNoteStart(before, "n-0001", 6);
    expect(before.notes[0]?.timeSec).toBe(5);
  });

  it("returns the same state when the start does not move", () => {
    const before = held();
    expect(setNoteStart(before, "n-0001", 5)).toBe(before);
  });

  it("refuses a note with no end, whose start is simply its time", () => {
    const tapOnly = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    expect(() => setNoteStart(tapOnly, "n-0001", 3)).toThrow(/no start to move/);
  });

  it("refuses a slide, whose end is a place rather than a length", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    const connected = connectSlide(state, "n-0001", "n-0002");
    expect(() => setNoteStart(connected, "n-0001", 0.5)).toThrow(/ends in a lane/);
  });

  it("refuses an unknown id", () => {
    expect(() => setNoteStart(held(), "n-9999", 6)).toThrow(/n-9999/);
  });

  it("refuses a time that is not a number", () => {
    expect(() => setNoteStart(held(), "n-0001", Number.NaN)).toThrow();
  });
});

describe("connecting slide points", () => {
  /** n-0001 at 2 s, n-0002 at 1 s: the later point was placed first, deliberately. */
  const twoPoints = () => {
    let state = placeNote(blank(), { timeSec: 2, lane: 3, type: "slide" }).state;
    state = placeNote(state, { timeSec: 1, lane: 0, type: "slide" }).state;
    return state;
  };

  it("places a slide point with no end, which the contract allows", () => {
    const state = twoPoints();
    expect(state.notes.every(isSlidePoint)).toBe(true);
    expect(isSlidePoint({ id: "x", type: "tap", timeSec: 1, lane: 0 })).toBe(false);
  });

  it("joins two points into one slide", () => {
    const state = connectSlide(twoPoints(), "n-0001", "n-0002");
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]).toMatchObject({
      type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3,
    });
  });

  it("keeps the earlier point, whichever order they were selected in", () => {
    const forwards = connectSlide(twoPoints(), "n-0001", "n-0002");
    const backwards = connectSlide(twoPoints(), "n-0002", "n-0001");
    expect(forwards.notes).toEqual(backwards.notes);
    expect(forwards.notes[0]?.id).toBe("n-0002");
  });

  it("keeps the surviving point id and its event reference", () => {
    let state = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "slide", sourceEventId: "ev-0007",
    }).state;
    state = placeNote(state, { timeSec: 2, lane: 4, type: "slide" }).state;
    const connected = connectSlide(state, "n-0001", "n-0002");
    expect(connected.notes[0]).toMatchObject({ id: "n-0001", sourceEventId: "ev-0007" });
  });

  it("refuses two points at the same instant", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 1, lane: 3, type: "slide" }).state;
    expect(() => connectSlide(state, "n-0001", "n-0002")).toThrow(/same time/);
  });

  it("refuses a note that is not a slide at all", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "tap" }).state;
    expect(() => connectSlide(state, "n-0001", "n-0002"))
      .toThrow(/must be slide points or slides/);
  });

  it("extends a slide that is already connected, rather than refusing", () => {
    // This is the whole point of the chain: Connect can be pressed again and again.
    let state = connectSlide(twoPoints(), "n-0001", "n-0002");
    state = placeNote(state, { timeSec: 5, lane: 1, type: "slide" }).state;
    const grown = connectSlide(state, "n-0002", "n-0003");
    expect(grown.notes).toHaveLength(1);
    expect(slidePoints(grown.notes[0] as ChartNote).map((p) => [p.timeSec, p.lane]))
      .toEqual([[1, 0], [2, 3], [5, 1]]);
  });

  it("refuses to connect a point to itself", () => {
    expect(() => connectSlide(twoPoints(), "n-0001", "n-0001")).toThrow(/two different/);
  });

  it("does not modify the state it was given", () => {
    const before = twoPoints();
    connectSlide(before, "n-0001", "n-0002");
    expect(before.notes).toHaveLength(2);
  });

  it("serialises as a plain single-segment slide, with no contract change", () => {
    const state = connectSlide(twoPoints(), "n-0001", "n-0002");
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0002", type: "slide", timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3,
    });
  });
});

describe("disconnecting a slide", () => {
  const connected = () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    return connectSlide(state, "n-0001", "n-0002");
  };

  it("gives back two points", () => {
    const state = disconnectSlide(connected(), "n-0001");
    expect(state.notes).toHaveLength(2);
    expect(state.notes.every(isSlidePoint)).toBe(true);
    expect(state.notes.map((n) => [n.timeSec, n.lane])).toEqual([[1, 0], [2, 3]]);
  });

  it("keeps the start id and gives the end a fresh one", () => {
    // The id the end originally had was retired when it was folded in, and ids are never
    // reissued. Undo is what restores the original pair exactly.
    expect(disconnectSlide(connected(), "n-0001").notes.map((n) => n.id))
      .toEqual(["n-0001", "n-0003"]);
  });

  it("refuses a note that is not a connected slide", () => {
    const tapOnly = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    expect(() => disconnectSlide(tapOnly, "n-0001")).toThrow(/not a connected slide/);
  });

  it("does not modify the state it was given", () => {
    const before = connected();
    disconnectSlide(before, "n-0001");
    expect(before.notes).toHaveLength(1);
  });
});

describe("multi-point slides", () => {
  /** Four loose points, deliberately placed out of time order. */
  const fourPoints = () => {
    let state = blank();
    state = placeNote(state, { timeSec: 3, lane: 2, type: "slide" }).state;   // n-0001
    state = placeNote(state, { timeSec: 1, lane: 1, type: "slide" }).state;   // n-0002
    state = placeNote(state, { timeSec: 4, lane: 4, type: "slide" }).state;   // n-0003
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;   // n-0004
    return state;
  };
  const shape = (state: { notes: readonly ChartNote[] }) =>
    slidePoints(state.notes[0] as ChartNote).map((p) => [p.timeSec, p.lane]);

  it("makes a two-point slide from two points", () => {
    const state = connectSlide(fourPoints(), "n-0002", "n-0004");
    expect(state.notes).toHaveLength(3);
    const chain = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    expect(slidePoints(chain).map((p) => [p.timeSec, p.lane])).toEqual([[1, 1], [2, 3]]);
    expect(chain.waypoints).toBeUndefined();
  });

  it("grows a chain by adding a point after it", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0004");
    state = connectSlide(state, "n-0002", "n-0001");
    const chain = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    expect(slidePoints(chain).map((p) => [p.timeSec, p.lane]))
      .toEqual([[1, 1], [2, 3], [3, 2]]);
    expect(chain.waypoints).toEqual([{ timeSec: 2, lane: 3 }]);
  });

  it("grows a chain by adding a point before it", () => {
    // n-0001 at 3 s and n-0003 at 4 s make the chain; n-0004 at 2 s goes in front.
    let state = connectSlide(fourPoints(), "n-0001", "n-0003");
    state = connectSlide(state, "n-0004", "n-0001");
    const chain = state.notes.find((n) => n.id === "n-0004") as ChartNote;
    expect(slidePoints(chain).map((p) => [p.timeSec, p.lane]))
      .toEqual([[2, 3], [3, 2], [4, 4]]);
  });

  it("grows to four points, one Connect at a time", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0004");
    state = connectSlide(state, "n-0002", "n-0001");
    state = connectSlide(state, "n-0002", "n-0003");
    expect(state.notes).toHaveLength(1);
    expect(shape(state)).toEqual([[1, 1], [2, 3], [3, 2], [4, 4]]);
    expect((state.notes[0] as ChartNote).waypoints).toHaveLength(2);
  });

  it("gives the same chain whichever way round the pair was selected", () => {
    const forwards = connectSlide(fourPoints(), "n-0002", "n-0004");
    const backwards = connectSlide(fourPoints(), "n-0004", "n-0002");
    expect(forwards.notes).toEqual(backwards.notes);
  });

  it("keeps the earliest note as the survivor, however it was built", () => {
    let state = connectSlide(fourPoints(), "n-0001", "n-0003");
    state = connectSlide(state, "n-0001", "n-0002");
    expect(state.notes.find((n) => n.id === "n-0002")).toBeDefined();
    expect(state.notes.find((n) => n.id === "n-0001")).toBeUndefined();
  });

  it("orders the points by time, not by selection", () => {
    const state = connectSlides(fourPoints(), ["n-0003", "n-0001", "n-0004", "n-0002"]);
    expect(shape(state)).toEqual([[1, 1], [2, 3], [3, 2], [4, 4]]);
  });

  it("joins two chains that do not overlap", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0004");   // 1s, 2s
    state = connectSlide(state, "n-0001", "n-0003");              // 3s, 4s
    const merged = connectSlide(state, "n-0002", "n-0001");
    expect(merged.notes).toHaveLength(1);
    expect(shape(merged)).toEqual([[1, 1], [2, 3], [3, 2], [4, 4]]);
  });

  it("refuses two chains whose times interleave", () => {
    // 1s-3s and 2s-4s: joining them would need the points to cross, and a slide is one
    // path travelled forwards.
    let state = connectSlide(fourPoints(), "n-0002", "n-0001");   // 1s, 3s
    state = connectSlide(state, "n-0004", "n-0003");              // 2s, 4s
    expect(() => connectSlide(state, "n-0002", "n-0004")).toThrow(/overlap/);
  });

  it("refuses a point that falls inside a chain", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0003");   // 1s .. 4s
    expect(() => connectSlide(state, "n-0002", "n-0001")).toThrow(/overlap/);
  });

  it("refuses two points at the same instant", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 1, lane: 3, type: "slide" }).state;
    expect(() => connectSlide(state, "n-0001", "n-0002")).toThrow(/same time/);
  });

  it("tells a point from a chain", () => {
    const state = connectSlide(fourPoints(), "n-0002", "n-0004");
    const chain = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    const loose = state.notes.find((n) => n.id === "n-0001") as ChartNote;
    expect(isSlideChain(chain)).toBe(true);
    expect(isSlidePoint(chain)).toBe(false);
    expect(isSlideChain(loose)).toBe(false);
    expect(isSlidePoint(loose)).toBe(true);
  });

  it("explains a refusal without throwing", () => {
    const state = fourPoints();
    const point = state.notes.find((n) => n.id === "n-0002") as ChartNote;
    const tapNote: ChartNote = { id: "t", type: "tap", timeSec: 9, lane: 0 };
    expect(whyNotConnectable(point, tapNote)).toMatch(/slide points or slides/);
    expect(whyNotConnectable(point, point)).toMatch(/two different/);
    expect(whyNotConnectable(point, state.notes.find((n) => n.id === "n-0004") as ChartNote))
      .toBeNull();
  });

  it("moves every point of a chain together", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0004");
    state = connectSlide(state, "n-0002", "n-0001");
    const moved = moveNotes(state, ["n-0002"], 1, 0);
    expect(slidePoints(moved.notes.find((n) => n.id === "n-0002") as ChartNote)
      .map((p) => p.timeSec)).toEqual([2, 3, 4]);
  });

  it("clamps a chain at the edge of the playfield using every point", () => {
    // The chain visits lane 4, so it cannot move right at all in a five-lane playfield.
    let state = connectSlide(fourPoints(), "n-0002", "n-0003");
    const moved = moveNotes(state, ["n-0002"], 0, 3);
    const lanes = slidePoints(moved.notes.find((n) => n.id === "n-0002") as ChartNote)
      .map((p) => p.lane);
    expect(Math.max(...lanes)).toBeLessThan(5);
  });

  it("survives a round trip through the document", () => {
    let state = connectSlide(fourPoints(), "n-0002", "n-0004");
    state = connectSlide(state, "n-0002", "n-0001");
    state = connectSlide(state, "n-0002", "n-0003");

    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0002",
      type: "slide",
      timeSec: 1,
      lane: 1,
      endTimeSec: 4,
      endLane: 4,
      waypoints: [{ timeSec: 2, lane: 3 }, { timeSec: 3, lane: 2 }],
    });

    const reloaded = projectChart(serializeChart(state));
    expect(slidePoints(reloaded.notes[0] as ChartNote))
      .toEqual(slidePoints(state.notes[0] as ChartNote));
  });

  it("reads a chart that has no waypoints as a two-point slide", () => {
    // Backward compatibility: an existing single-segment slide is still exactly a slide.
    const loaded = projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{
        id: "n-0001", type: "slide", timeSec: 10, lane: 1, endTimeSec: 11, endLane: 4,
      }],
    });
    expect(loaded.notes[0]?.waypoints).toBeUndefined();
    expect(slidePoints(loaded.notes[0] as ChartNote).map((p) => [p.timeSec, p.lane]))
      .toEqual([[10, 1], [11, 4]]);
  });

  it("refuses a waypoint outside the playfield when reading", () => {
    expect(() => projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{
        id: "n-0001", type: "slide", timeSec: 10, lane: 1, endTimeSec: 11, endLane: 4,
        waypoints: [{ timeSec: 10.5, lane: 9 }],
      }],
    })).toThrow(/outside 0\.\.4/);
  });

  it("writes no waypoints field for a two-point slide", () => {
    const state = connectSlide(fourPoints(), "n-0002", "n-0004");
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).not.toHaveProperty("waypoints");
  });
});

describe("disconnecting a multi-point slide", () => {
  const chain = () => {
    let state = blank();
    state = placeNote(state, { timeSec: 1, lane: 1, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    state = placeNote(state, { timeSec: 3, lane: 2, type: "slide" }).state;
    state = connectSlide(state, "n-0001", "n-0002");
    return connectSlide(state, "n-0001", "n-0003");
  };

  it("gives back one standalone point per judgement point", () => {
    const state = disconnectSlide(chain(), "n-0001");
    expect(state.notes).toHaveLength(3);
    expect(state.notes.every(isSlidePoint)).toBe(true);
    expect(state.notes.map((n) => [n.timeSec, n.lane])).toEqual([[1, 1], [2, 3], [3, 2]]);
  });

  it("keeps the first id and gives the rest fresh ones", () => {
    expect(disconnectSlide(chain(), "n-0001").notes.map((n) => n.id))
      .toEqual(["n-0001", "n-0004", "n-0005"]);
  });

  it("leaves nothing carrying waypoints", () => {
    const state = disconnectSlide(chain(), "n-0001");
    expect(state.notes.every((n) => n.waypoints === undefined)).toBe(true);
  });
});

describe("a note that ends in a flick", () => {
  const held = (over: Partial<Record<string, unknown>> = {}) =>
    placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, ...over,
    } as never).state;

  it("has no end action by default", () => {
    const note = held().notes[0] as ChartNote;
    expect(note.endAction).toBeUndefined();
    expect(endFlickDirection(note)).toBeNull();
  });

  it("places a Long that ends in a left flick", () => {
    const note = held({ endAction: flickEndAction("left") }).notes[0] as ChartNote;
    expect(note.endAction).toEqual({ type: "flick", direction: "left" });
    expect(endFlickDirection(note)).toBe("left");
  });

  it("places a Long that ends in a right flick", () => {
    const note = held({ endAction: flickEndAction("right") }).notes[0] as ChartNote;
    expect(endFlickDirection(note)).toBe("right");
  });

  it("places a Slide that ends in a flick", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    const connected = connectSlide(state, "n-0001", "n-0002");
    const flicked = setEndAction(connected, "n-0001", flickEndAction("left"));
    expect(endFlickDirection(flicked.notes[0] as ChartNote)).toBe("left");
  });

  it("puts the flick on a multi-point slide's last point only", () => {
    // The middle points keep their bars: only the end is flicked.
    let state = blank();
    for (const [timeSec, lane] of [[1, 0], [2, 3], [3, 1], [4, 4]] as const) {
      state = placeNote(state, { timeSec, lane, type: "slide" }).state;
    }
    state = connectSlides(state, ["n-0001", "n-0002", "n-0003", "n-0004"]);
    state = setEndAction(state, "n-0001", flickEndAction("right"));
    const note = state.notes[0] as ChartNote;
    expect(slidePoints(note)).toHaveLength(4);
    expect(note.waypoints).toHaveLength(2);
    expect(endFlickDirection(note)).toBe("right");
    // Nothing about the middle changed.
    expect(note.waypoints).toEqual([{ timeSec: 2, lane: 3 }, { timeSec: 3, lane: 1 }]);
  });

  it("knows which kinds can carry one", () => {
    expect(canCarryEndAction("hold")).toBe(true);
    expect(canCarryEndAction("slide")).toBe(true);
    expect(canCarryEndAction("tap")).toBe(false);
    expect(canCarryEndAction("flick")).toBe(false);
  });

  it("refuses an end action on a kind that has no end", () => {
    for (const type of ["tap", "flick"] as const) {
      expect(() => placeNote(blank(), {
        timeSec: 1, lane: 0, type,
        ...(type === "flick" ? { direction: "left" as const } : {}),
        endAction: flickEndAction("left"),
      } as never)).toThrow(/cannot have an end action/);
    }
  });

  it("refuses an end action on a slide point with no end", () => {
    expect(() => placeNote(blank(), {
      timeSec: 1, lane: 0, type: "slide", endAction: flickEndAction("left"),
    } as never)).toThrow(/needs an end time/);
  });

  it("refuses an end flick with no direction", () => {
    expect(() => placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, endAction: { type: "flick" },
    } as never)).toThrow(/needs a direction/);
  });

  it("does not reuse the note's own direction for the end", () => {
    // A plain flick's `direction` is its own; a held note's end is a separate statement.
    const note = held({ endAction: flickEndAction("left") }).notes[0] as ChartNote;
    expect(note.direction).toBeUndefined();
    expect(note.endAction?.direction).toBe("left");
  });

  it("changes the end action on a note that already exists", () => {
    let state = held();
    state = setEndAction(state, "n-0001", flickEndAction("right"));
    expect(endFlickDirection(state.notes[0] as ChartNote)).toBe("right");
    state = setEndAction(state, "n-0001", flickEndAction("left"));
    expect(endFlickDirection(state.notes[0] as ChartNote)).toBe("left");
    state = setEndAction(state, "n-0001", null);
    expect((state.notes[0] as ChartNote).endAction).toBeUndefined();
  });

  it("returns the same state when the end action does not change", () => {
    const before = setEndAction(held(), "n-0001", flickEndAction("left"));
    expect(setEndAction(before, "n-0001", flickEndAction("left"))).toBe(before);
    const plain = held();
    expect(setEndAction(plain, "n-0001", null)).toBe(plain);
  });

  it("refuses to set one on a note with no end", () => {
    const tapOnly = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    expect(() => setEndAction(tapOnly, "n-0001", flickEndAction("left")))
      .toThrow(/no end for an action/);
  });

  it("survives a round trip through the document", () => {
    const state = held({ endAction: flickEndAction("right") });
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0001", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2,
      endAction: { type: "flick", direction: "right" },
    });
    const reloaded = projectChart(serializeChart(state));
    expect(endFlickDirection(reloaded.notes[0] as ChartNote)).toBe("right");
  });

  it("writes nothing when there is no end action", () => {
    const document = serializeChart(held()) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).not.toHaveProperty("endAction");
  });

  it("refuses to read a flick end action with no direction", () => {
    expect(() => projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{
        id: "n-0001", type: "hold", timeSec: 1, lane: 0, endTimeSec: 2,
        endAction: { type: "flick" },
      }],
    })).toThrow(/ends in a flick with no direction/);
  });

  it("carries the end action through a move", () => {
    const moved = moveNotes(held({ endAction: flickEndAction("left") }), ["n-0001"], 1, 1);
    expect(endFlickDirection(moved.notes[0] as ChartNote)).toBe("left");
  });

  it("carries the end action through a resize", () => {
    const resized = resizeNote(held({ endAction: flickEndAction("left") }), "n-0001", 5);
    expect(endFlickDirection(resized.notes[0] as ChartNote)).toBe("left");
    expect(resized.notes[0]?.endTimeSec).toBe(5);
  });

  it("drops it when a slide is disconnected, because points have no end", () => {
    // Keeping it would make a document the contract rejects, and moving it onto the last
    // point would silently change what the player is asked to do. Undo is the way back.
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "slide" }).state;
    state = placeNote(state, { timeSec: 2, lane: 3, type: "slide" }).state;
    state = connectSlide(state, "n-0001", "n-0002");
    state = setEndAction(state, "n-0001", flickEndAction("right"));
    const split = disconnectSlide(state, "n-0001");
    expect(split.notes.every((note) => note.endAction === undefined)).toBe(true);
    expect(split.notes.every((note) => note.type === "slide")).toBe(true);
  });
});

describe("turning a standalone flick round", () => {
  const flick = (direction: "left" | "right") =>
    placeNote(blank(), { timeSec: 2, lane: 3, type: "flick", direction }).state;

  it("tells a standalone flick from a note that ends in one", () => {
    // Two different statements stored in two different fields. Nothing should read one
    // and mean the other.
    expect(isStandaloneFlick(flick("left").notes[0] as ChartNote)).toBe(true);

    const endsInOne = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, endAction: flickEndAction("left"),
    } as never).state.notes[0] as ChartNote;
    expect(isStandaloneFlick(endsInOne)).toBe(false);
    expect(endFlickDirection(endsInOne)).toBe("left");
    expect(endsInOne.direction).toBeUndefined();
  });

  it("changes left to right", () => {
    expect(setFlickDirection(flick("left"), "n-0001", "right").notes[0]?.direction)
      .toBe("right");
  });

  it("changes right to left", () => {
    expect(setFlickDirection(flick("right"), "n-0001", "left").notes[0]?.direction)
      .toBe("left");
  });

  it("changes nothing else about the note", () => {
    let state = placeNote(blank(), {
      timeSec: 2, lane: 3, type: "flick", direction: "left", sourceEventId: "ev-0009",
    }).state;
    const before = state.notes[0] as ChartNote;
    state = setFlickDirection(state, "n-0001", "right");
    const after = state.notes[0] as ChartNote;
    expect(after).toEqual({ ...before, direction: "right" });
    expect(after.id).toBe(before.id);
    expect(after.timeSec).toBe(before.timeSec);
    expect(after.lane).toBe(before.lane);
    expect(after.sourceEventId).toBe("ev-0009");
  });

  it("returns the identical state when the direction is unchanged", () => {
    // Checking which way a flick points must not fill the undo stack.
    const state = flick("left");
    expect(setFlickDirection(state, "n-0001", "left")).toBe(state);
  });

  it("leaves the state it was given alone", () => {
    const before = flick("left");
    setFlickDirection(before, "n-0001", "right");
    expect(before.notes[0]?.direction).toBe("left");
  });

  it("refuses a note that is not a standalone flick", () => {
    const tapOnly = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    expect(() => setFlickDirection(tapOnly, "n-0001", "left")).toThrow(/is not a flick/);

    const held = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, endAction: flickEndAction("left"),
    } as never).state;
    // A note that *ends* in a flick is changed with setEndAction, not this.
    expect(() => setFlickDirection(held, "n-0001", "right")).toThrow(/is not a flick/);
  });

  it("refuses a direction nobody has heard of", () => {
    expect(() => setFlickDirection(flick("left"), "n-0001", "sideways" as never))
      .toThrow(/unknown direction/);
  });

  it("refuses an unknown id", () => {
    expect(() => setFlickDirection(flick("left"), "n-9999", "right")).toThrow(/n-9999/);
  });

  it("survives a round trip through the document", () => {
    const state = setFlickDirection(flick("left"), "n-0001", "right");
    const document = serializeChart(state) as { notes: readonly Record<string, unknown>[] };
    expect(document.notes[0]).toEqual({
      id: "n-0001", type: "flick", timeSec: 2, lane: 3, direction: "right",
    });
    expect(projectChart(document).notes[0]?.direction).toBe("right");
  });

  it("does not disturb a note that ends in a flick", () => {
    // The two live side by side and are edited by different commands.
    let state = placeNote(blank(), {
      timeSec: 1, lane: 0, type: "hold", endTimeSec: 2, endAction: flickEndAction("left"),
    } as never).state;
    state = placeNote(state, {
      timeSec: 3, lane: 1, type: "flick", direction: "left",
    }).state;
    state = setFlickDirection(state, "n-0002", "right");
    expect(endFlickDirection(state.notes[0] as ChartNote)).toBe("left");
    expect(state.notes[1]?.direction).toBe("right");
  });
});

describe("runs of flicks", () => {
  /** Four flicks a quarter of a second apart, each with its own direction. */
  const four = () => {
    let state = blank();
    const spec = [
      [10.0, 0, "right"], [10.25, 1, "right"], [10.5, 3, "left"], [10.75, 4, "right"],
    ] as const;
    for (const [timeSec, lane, direction] of spec) {
      state = placeNote(state, { timeSec, lane, type: "flick", direction }).state;
    }
    return state;
  };
  const ids = (state: { notes: readonly ChartNote[] }) => state.notes.map((n) => n.id);

  it("starts with no connections at all", () => {
    expect(four().connections).toEqual([]);
    expect(isConnected(four(), "n-0001")).toBe(false);
  });

  it("joins two flicks without merging them", () => {
    // The whole reason a run is stored beside the notes: both flicks are still notes.
    const state = connectRun(four(), ["n-0001", "n-0002"]);
    expect(state.notes).toHaveLength(4);
    expect(state.connections).toEqual([
      { type: "flick", fromNoteId: "n-0001", toNoteId: "n-0002" },
    ]);
    expect(state.notes[0]).toMatchObject({ id: "n-0001", direction: "right", lane: 0 });
    expect(state.notes[1]).toMatchObject({ id: "n-0002", direction: "right", lane: 1 });
  });

  it("grows a run by adding a flick after it", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0001", "n-0003"]);
    expect(chainOf(state, "n-0001").map((n) => n.id))
      .toEqual(["n-0001", "n-0002", "n-0003"]);
    expect(state.connections).toHaveLength(2);
  });

  it("grows a run by adding a flick in front of it", () => {
    let state = connectRun(four(), ["n-0002", "n-0003"]);
    state = connectRun(state, ["n-0001", "n-0002"]);
    expect(chainOf(state, "n-0003").map((n) => n.id))
      .toEqual(["n-0001", "n-0002", "n-0003"]);
  });

  it("grows to four, one Connect at a time", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    expect(chainOf(state, "n-0002").map((n) => n.id)).toEqual(ids(state));
    expect(state.connections).toHaveLength(3);
    expect(state.notes).toHaveLength(4);
  });

  it("joins two runs that do not overlap", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    const merged = connectRun(state, ["n-0001", "n-0003"]);
    expect(chainOf(merged, "n-0004").map((n) => n.id)).toEqual(ids(merged));
    expect(merged.connections).toHaveLength(3);
  });

  it("gives the same run whichever way round the pair was selected", () => {
    expect(connectRun(four(), ["n-0002", "n-0001"]).connections)
      .toEqual(connectRun(four(), ["n-0001", "n-0002"]).connections);
  });

  it("refuses runs whose times interleave", () => {
    let state = connectRun(four(), ["n-0001", "n-0003"]);
    state = connectRun(state, ["n-0002", "n-0004"]);
    expect(() => connectRun(state, ["n-0001", "n-0002"])).toThrow(/overlap/);
  });

  it("refuses a note that is not a flick", () => {
    let state = four();
    state = placeNote(state, { timeSec: 11, lane: 0, type: "tap" }).state;
    expect(() => connectRun(state, ["n-0001", "n-0005"])).toThrow(/Both must be flicks/);
  });

  it("refuses a note joined to itself", () => {
    expect(() => connectRun(four(), ["n-0001", "n-0001"])).toThrow(/two different notes/);
  });

  it("refuses two notes already in the same run", () => {
    const state = connectRun(four(), ["n-0001", "n-0002"]);
    expect(() => connectRun(state, ["n-0001", "n-0002"])).toThrow(/already in the same/);
  });

  it("refuses an id that is not in the chart", () => {
    expect(() => connectRun(four(), ["n-0001", "n-9999"]))
      .toThrow(/notes that are in the chart/);
  });

  it("explains a refusal without throwing", () => {
    expect(whyNotConnectableRun(four(), ["n-0001", "n-0002"])).toBeNull();
    expect(whyNotConnectableRun(four(), ["n-0001", "n-0001"])).toMatch(/two different/);
  });

  it("never writes a link that runs backwards", () => {
    const state = connectRun(four(), ["n-0004", "n-0001"]);
    const byId = new Map(state.notes.map((n) => [n.id, n]));
    for (const connection of state.connections) {
      expect((byId.get(connection.fromNoteId) as ChartNote).timeSec)
        .toBeLessThan((byId.get(connection.toNoteId) as ChartNote).timeSec);
    }
  });

  it("cannot describe a loop, because every link runs forwards", () => {
    // The forward rule is what makes a cycle unrepresentable rather than merely
    // forbidden - there is no sequence of forward steps that returns to its start.
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    expect(() => connectRun(state, ["n-0003", "n-0001"])).toThrow();
  });

  it("keeps every direction its own inside a run", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    expect(state.notes.map((n) => n.direction))
      .toEqual(["right", "right", "left", "right"]);
  });

  it("lets one flick in the middle be turned round, run intact", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    const before = state.connections;
    const turned = setFlickDirection(state, "n-0003", "right");
    expect(turned.notes.map((n) => n.direction))
      .toEqual(["right", "right", "right", "right"]);
    expect(turned.connections).toEqual(before);
    expect(turned.notes[2]).toMatchObject({ id: "n-0003", timeSec: 10.5, lane: 3 });
  });

  it("finds the whole run from any of its notes", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    for (const id of ["n-0001", "n-0002", "n-0003"]) {
      expect(chainOf(state, id).map((n) => n.id))
        .toEqual(["n-0001", "n-0002", "n-0003"]);
    }
    // A note in no run is a run of one.
    expect(chainOf(state, "n-0004").map((n) => n.id)).toEqual(["n-0004"]);
  });

  it("takes a run apart without losing anything", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    const before = state.notes;
    const split = disconnectRun(state, "n-0002");
    expect(split.connections).toEqual([]);
    // Nothing was ever merged, so there is nothing to rebuild.
    expect(split.notes).toEqual(before);
  });

  it("refuses to take apart a flick that is in no run", () => {
    expect(() => disconnectRun(four(), "n-0001")).toThrow(/not in a run/);
  });

  it("drops the links of a note that is deleted, without healing the gap", () => {
    // Deleting the middle of A - B - C leaves A and C unconnected rather than silently
    // joining them: a chart that quietly rewires itself is one nobody can predict.
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    const after = deleteNotes(state, ["n-0002"]);
    expect(after.connections).toEqual([]);
    expect(connectionsTouching(after, "n-0001")).toEqual([]);
    expect(chainOf(after, "n-0001").map((n) => n.id)).toEqual(["n-0001"]);
    expect(chainOf(after, "n-0003").map((n) => n.id)).toEqual(["n-0003"]);
  });

  it("drops only the links that touch the deleted note", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0003", "n-0004"]);
    const after = deleteNotes(state, ["n-0001"]);
    expect(after.connections).toEqual([
      { type: "flick", fromNoteId: "n-0003", toNoteId: "n-0004" },
    ]);
  });

  it("carries a run through a move of the whole thing", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);
    const moved = moveNotes(state, ["n-0001", "n-0002", "n-0003"], 1, 1);
    expect(moved.connections).toEqual(state.connections);
    expect(chainOf(moved, "n-0001").map((n) => n.timeSec)).toEqual([11, 11.25, 11.5]);
  });

  it("survives a round trip through the document", () => {
    let state = connectRun(four(), ["n-0001", "n-0002"]);
    state = connectRun(state, ["n-0002", "n-0003"]);

    const document = serializeChart(state) as {
      notes: readonly Record<string, unknown>[];
      connections?: readonly Record<string, unknown>[];
    };
    expect(document.connections).toEqual([
      { type: "flick", fromNoteId: "n-0001", toNoteId: "n-0002" },
      { type: "flick", fromNoteId: "n-0002", toNoteId: "n-0003" },
    ]);
    // Each flick is still a flick with its own direction.
    expect(document.notes).toHaveLength(4);

    const reloaded = projectChart(document);
    expect(reloaded.connections).toEqual(state.connections);
    expect(chainOf(reloaded, "n-0003").map((n) => n.id))
      .toEqual(["n-0001", "n-0002", "n-0003"]);
  });

  it("writes nothing when there is nothing to say", () => {
    // A chart of independent notes is byte-for-byte what it was before runs existed.
    const document = serializeChart(four()) as Record<string, unknown>;
    expect(document).not.toHaveProperty("connections");
  });

  it("reads a chart that has no connections as one of independent flicks", () => {
    const loaded = projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "flick", timeSec: 1, lane: 0, direction: "left" }],
    });
    expect(loaded.connections).toEqual([]);
    expect(isConnected(loaded, "n-0001")).toBe(false);
  });

  it("refuses to read a link that names a note which is not there", () => {
    expect(() => projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "flick", timeSec: 1, lane: 0, direction: "left" }],
      connections: [{ type: "flick", fromNoteId: "n-0001", toNoteId: "nowhere" }],
    })).toThrow(/not here/);
  });

  it("refuses to read a link that runs backwards", () => {
    expect(() => projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [
        { id: "n-0001", type: "flick", timeSec: 1, lane: 0, direction: "left" },
        { id: "n-0002", type: "flick", timeSec: 2, lane: 1, direction: "left" },
      ],
      connections: [{ type: "flick", fromNoteId: "n-0002", toNoteId: "n-0001" }],
    })).toThrow(/forwards/);
  });

  it("refuses to read a link joining a note to itself", () => {
    expect(() => projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "flick", timeSec: 1, lane: 0, direction: "left" }],
      connections: [{ type: "flick", fromNoteId: "n-0001", toNoteId: "n-0001" }],
    })).toThrow(/to itself/);
  });

  it("leaves the state it was given alone", () => {
    const before = four();
    connectRun(before, ["n-0001", "n-0002"]);
    expect(before.connections).toEqual([]);
  });
});
