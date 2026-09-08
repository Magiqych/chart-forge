/**
 * Decorations in the Chart document: reading them, changing them, and writing them back.
 *
 * The compatibility claims are the point of most of this. Adding decorations was meant to
 * be an additive change - every chart written before them still loads, still saves, and
 * comes back byte-identical - and that is a claim about behaviour, so it is checked as
 * behaviour rather than asserted in a comment.
 */

import { describe, expect, it } from "vitest";

import {
  ChartError, deleteDecorations, decorationAt, emptyChart, formatDecorationId,
  moveChartObjects, moveNotes, placeDecoration, placeNote, projectChart, serializeChart,
  setDecorationEnd, setDecorationStart, moveDecorationsBy, updateDecoration,
  type ChartState,
} from "./chart";
import { DEFAULT_DISPLAY_DURATION_SEC, MIN_DECORATION_DURATION_SEC } from "./decoration";

const LEGACY = {
  version: "0.1.0",
  metadata: { title: "Example" },
  audio: { path: "song.wav", durationSec: 8 },
  timing: { offsetSec: 0 },
  playfield: { laneCount: 5, profile: "generic" },
  notes: [
    { id: "n-0001", type: "tap", timeSec: 1, lane: 0 },
    { id: "n-0002", type: "hold", timeSec: 2, lane: 1, endTimeSec: 3 },
  ],
  extensions: {},
} as const;

const blank = () => emptyChart({ audioPath: "song.wav", audioDurationSec: 30 });

const place = (state: ChartState, over: Record<string, unknown> = {}) =>
  placeDecoration(state, {
    startTimeSec: 1,
    position: { x: 0.5, y: 0.5 },
    text: "HI",
    ...over,
  });

describe("a chart written before decorations existed", () => {
  it("loads, with no decorations", () => {
    const state = projectChart(LEGACY);
    expect(state.decorations).toEqual([]);
    expect(state.nextDecorationIdSeq).toBe(1);
    expect(state.notes).toHaveLength(2);
  });

  it("is written back byte-for-byte what it was", () => {
    // The whole additive claim in one assertion: opening and saving an old chart must
    // not announce a feature in the author's document.
    const round = serializeChart(projectChart(LEGACY));
    expect(round).toEqual(LEGACY);
    expect(Object.keys(round)).not.toContain("decorations");
  });

  it("does not gain an empty decorations array from an edit elsewhere", () => {
    const state = placeNote(projectChart(LEGACY), { timeSec: 4, lane: 2, type: "tap" }).state;
    expect(Object.keys(serializeChart(state))).not.toContain("decorations");
  });

  it("keeps an unfamiliar note kind, as it always did", () => {
    const legacy = {
      ...LEGACY,
      notes: [{ id: "n-0001", type: "purple", timeSec: 1, lane: 0 }],
    };
    expect(serializeChart(projectChart(legacy))).toEqual(legacy);
  });
});

describe("reading decorations", () => {
  it("reads every field the contract defines", () => {
    const document = {
      ...LEGACY,
      decorations: [
        {
          id: "dec-0001",
          type: "text",
          startTimeSec: 1,
          endTimeSec: 2.5,
          position: { x: 0.25, y: 0.75 },
          text: "キラメキ☆",
          style: { fontSize: 0.12, color: "#ffcc00" },
          animation: { enter: "scale", enterDurationSec: 0.12 },
          zIndex: 20,
          metadata: { note: "by hand" },
        },
      ],
    };
    const [decoration] = projectChart(document).decorations;
    expect(decoration?.text).toBe("キラメキ☆");
    expect(decoration?.position).toEqual({ x: 0.25, y: 0.75 });
    expect(decoration?.style?.fontSize).toBe(0.12);
    expect(decoration?.animation?.enter).toBe("scale");
    expect(decoration?.zIndex).toBe(20);
    expect(decoration?.metadata).toEqual({ note: "by hand" });
  });

  it("reads one that says only what it must", () => {
    const document = {
      ...LEGACY,
      decorations: [
        { id: "dec-0001", type: "text", startTimeSec: 3, position: { x: 0.5, y: 0.4 }, text: "READY" },
      ],
    };
    const [decoration] = projectChart(document).decorations;
    expect(decoration?.endTimeSec).toBeUndefined();
    expect(decoration?.style).toBeUndefined();
    expect(decoration?.animation).toBeUndefined();
  });

  it("keeps a kind this Editor has never heard of, with everything it came with", () => {
    const future = {
      id: "dec-0001",
      type: "image",
      startTimeSec: 1,
      position: { x: 0.2, y: 0.3 },
      zIndex: 5,
    };
    const document = { ...LEGACY, decorations: [future] };
    expect(projectChart(document).decorations[0]?.type).toBe("image");
    expect(serializeChart(projectChart(document))).toEqual(document);
  });

  it("sorts them into document order on the way in", () => {
    const document = {
      ...LEGACY,
      decorations: [
        { id: "dec-0002", type: "text", startTimeSec: 5, position: { x: 0.5, y: 0.5 }, text: "b" },
        { id: "dec-0001", type: "text", startTimeSec: 1, position: { x: 0.5, y: 0.5 }, text: "a" },
      ],
    };
    expect(projectChart(document).decorations.map((d) => d.id))
      .toEqual(["dec-0001", "dec-0002"]);
  });

  it("continues the id sequence past what the document already used", () => {
    const document = {
      ...LEGACY,
      decorations: [
        { id: "dec-0007", type: "text", startTimeSec: 1, position: { x: 0.5, y: 0.5 }, text: "a" },
      ],
    };
    const state = projectChart(document);
    expect(state.nextDecorationIdSeq).toBe(8);
    expect(place(state).decoration.id).toBe("dec-0008");
  });

  it("refuses a decoration it could not draw or write back", () => {
    const bad = (decoration: unknown) =>
      () => projectChart({ ...LEGACY, decorations: [decoration] });
    expect(bad({ type: "text", startTimeSec: 1, position: { x: 0, y: 0 } })).toThrow(ChartError);
    expect(bad({ id: "dec-0001", startTimeSec: 1, position: { x: 0, y: 0 } })).toThrow(ChartError);
    expect(bad({ id: "dec-0001", type: "text", position: { x: 0, y: 0 } })).toThrow(ChartError);
    expect(bad({ id: "dec-0001", type: "text", startTimeSec: 1 })).toThrow(ChartError);
    expect(bad({ id: "dec-0001", type: "text", startTimeSec: 1, position: { x: "a", y: 0 } }))
      .toThrow(ChartError);
    expect(() => projectChart({ ...LEGACY, decorations: "no" })).toThrow(ChartError);
  });

  it("refuses two decorations with one id", () => {
    const same = { type: "text", startTimeSec: 1, position: { x: 0.5, y: 0.5 }, text: "a" };
    expect(() =>
      projectChart({
        ...LEGACY,
        decorations: [{ id: "dec-0001", ...same }, { id: "dec-0001", ...same }],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("writing decorations", () => {
  it("writes only what the author said", () => {
    const { state } = place(blank());
    const written = serializeChart(state)["decorations"] as Record<string, unknown>[];
    expect(Object.keys(written[0] ?? {})).toEqual(["id", "type", "startTimeSec", "position", "text"]);
  });

  it("does not materialise a default the author never chose", () => {
    const { state } = place(blank());
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0];
    for (const key of ["style", "animation", "zIndex", "endTimeSec"]) {
      expect(written).not.toHaveProperty(key);
    }
  });

  it("does not write an assumed end for one that never stated one", () => {
    // The reader shows it for a default second. Writing that second back would make an
    // assumption indistinguishable from the author's own decision.
    const { state } = place(blank());
    const round = projectChart({ ...LEGACY, ...serializeChart(state), notes: [] });
    expect(round.decorations[0]?.endTimeSec).toBeUndefined();
  });

  it("survives a full round trip unchanged", () => {
    const document = {
      ...LEGACY,
      decorations: [
        {
          id: "dec-0001", type: "text", startTimeSec: 1, endTimeSec: 2.5,
          position: { x: 0.25, y: 0.75 }, text: "キラメキ☆",
          style: { fontFamily: "serif", fontSize: 0.12, align: "left", color: "#ffcc00" },
          animation: { enter: "scale", enterDurationSec: 0.12, exit: "fade", exitDurationSec: 0.2 },
          zIndex: 20,
        },
      ],
    };
    expect(serializeChart(projectChart(document))).toEqual(document);
    // And again, so a second save cannot drift from the first.
    expect(serializeChart(projectChart(serializeChart(projectChart(document)))))
      .toEqual(document);
  });

  it("writes them in ascending start order, as the contract requires", () => {
    let state = blank();
    state = place(state, { startTimeSec: 9 }).state;
    state = place(state, { startTimeSec: 2 }).state;
    const written = serializeChart(state)["decorations"] as { startTimeSec: number }[];
    expect(written.map((d) => d.startTimeSec)).toEqual([2, 9]);
  });
});

describe("placing a decoration", () => {
  it("mints ids in sequence with their own prefix", () => {
    let state = blank();
    const first = place(state);
    state = first.state;
    const second = place(state);
    expect(first.decoration.id).toBe("dec-0001");
    expect(second.decoration.id).toBe("dec-0002");
    expect(formatDecorationId(12)).toBe("dec-0012");
  });

  it("never shares an id with a note", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    state = place(state).state;
    expect(state.notes[0]?.id).toBe("n-0001");
    expect(state.decorations[0]?.id).toBe("dec-0001");
    // And the two counters advance independently.
    expect(state.nextIdSeq).toBe(2);
    expect(state.nextDecorationIdSeq).toBe(2);
  });

  it("clamps a position outside the playfield", () => {
    const { decoration } = place(blank(), { position: { x: 3, y: -1 } });
    expect(decoration.position).toEqual({ x: 1, y: 0 });
  });

  it("refuses a window that does not run forwards", () => {
    expect(() => place(blank(), { startTimeSec: 5, endTimeSec: 5 })).toThrow(ChartError);
    expect(() => place(blank(), { startTimeSec: 5, endTimeSec: 4 })).toThrow(ChartError);
    expect(() => place(blank(), { startTimeSec: Number.NaN })).toThrow(ChartError);
  });

  it("never starts before the recording", () => {
    expect(place(blank(), { startTimeSec: -3 }).decoration.startTimeSec).toBe(0);
  });
});

describe("editing a decoration", () => {
  const one = () => place(blank(), { startTimeSec: 10, endTimeSec: 12 }).state;

  it("changes the text and nothing else", () => {
    const after = updateDecoration(one(), "dec-0001", { text: "キラメキ☆" });
    expect(after.decorations[0]?.text).toBe("キラメキ☆");
    expect(after.decorations[0]?.startTimeSec).toBe(10);
    expect(after.decorations[0]?.id).toBe("dec-0001");
  });

  it("accepts an empty string, which is a caption not written yet", () => {
    expect(updateDecoration(one(), "dec-0001", { text: "" }).decorations[0]?.text).toBe("");
  });

  it("merges a style patch over what is already there", () => {
    let state = updateDecoration(one(), "dec-0001", { style: { fontSize: 0.2 } });
    state = updateDecoration(state, "dec-0001", { style: { color: "#ff0000" } });
    expect(state.decorations[0]?.style).toEqual({ fontSize: 0.2, color: "#ff0000" });
  });

  it("removes a style field set back to nothing, rather than storing a default", () => {
    let state = updateDecoration(one(), "dec-0001", { style: { fontSize: 0.2, color: "#ff0000" } });
    state = updateDecoration(state, "dec-0001", { style: { color: undefined } });
    expect(state.decorations[0]?.style).toEqual({ fontSize: 0.2 });

    // Emptying it entirely drops the object, so the chart is back to saying nothing.
    state = updateDecoration(state, "dec-0001", { style: { fontSize: undefined } });
    expect(state.decorations[0]?.style).toBeUndefined();
    const written = serializeChart(state)["decorations"] as Record<string, unknown>[];
    expect(written[0]).not.toHaveProperty("style");
  });

  it("merges and clears an animation the same way", () => {
    let state = updateDecoration(one(), "dec-0001", {
      animation: { enter: "fade", enterDurationSec: 0.3 },
    });
    expect(state.decorations[0]?.animation).toEqual({ enter: "fade", enterDurationSec: 0.3 });
    state = updateDecoration(state, "dec-0001", {
      animation: { enter: undefined, enterDurationSec: undefined },
    });
    expect(state.decorations[0]?.animation).toBeUndefined();
  });

  it("changes the layer, and removes it when set back to nothing", () => {
    let state = updateDecoration(one(), "dec-0001", { zIndex: 20 });
    expect(state.decorations[0]?.zIndex).toBe(20);
    state = updateDecoration(state, "dec-0001", { zIndex: undefined });
    expect(state.decorations[0]?.zIndex).toBeUndefined();
  });

  it("clamps a position edited from the inspector", () => {
    const after = updateDecoration(one(), "dec-0001", { position: { x: 9, y: 0.5 } });
    expect(after.decorations[0]?.position).toEqual({ x: 1, y: 0.5 });
  });

  it("returns the same state when nothing actually differs", () => {
    const state = one();
    expect(updateDecoration(state, "dec-0001", { text: "HI" })).toBe(state);
    expect(updateDecoration(state, "dec-0001", {})).toBe(state);
  });

  it("refuses an id that is not there", () => {
    expect(() => updateDecoration(one(), "dec-9999", { text: "x" })).toThrow(/dec-9999/);
  });

  it("finds one by id", () => {
    expect(decorationAt(one(), "dec-0001")?.text).toBe("HI");
    expect(decorationAt(one(), "dec-9999")).toBeNull();
  });
});

describe("the window edges", () => {
  const one = () => place(blank(), { startTimeSec: 10, endTimeSec: 14 }).state;

  it("moves the start and leaves the end", () => {
    const after = setDecorationStart(one(), "dec-0001", 11);
    expect(after.decorations[0]?.startTimeSec).toBe(11);
    expect(after.decorations[0]?.endTimeSec).toBe(14);
  });

  it("moves the end and leaves the start", () => {
    const after = setDecorationEnd(one(), "dec-0001", 15);
    expect(after.decorations[0]?.startTimeSec).toBe(10);
    expect(after.decorations[0]?.endTimeSec).toBe(15);
  });

  it("keeps the window open however far an edge is dragged past the other", () => {
    for (const at of [14, 20, 100]) {
      const after = setDecorationStart(one(), "dec-0001", at);
      const decoration = after.decorations[0];
      expect(decoration?.startTimeSec as number).toBeLessThan(decoration?.endTimeSec as number);
      expect((decoration?.endTimeSec as number) - (decoration?.startTimeSec as number))
        .toBeCloseTo(MIN_DECORATION_DURATION_SEC, 12);
    }
    for (const at of [10, 5, -4]) {
      const after = setDecorationEnd(one(), "dec-0001", at);
      const decoration = after.decorations[0];
      expect(decoration?.endTimeSec as number).toBeGreaterThan(decoration?.startTimeSec as number);
    }
  });

  it("never starts before the recording", () => {
    expect(setDecorationStart(one(), "dec-0001", -5).decorations[0]?.startTimeSec).toBe(0);
  });

  it("gives a stated end to one that had none, because the author dragged for it", () => {
    const open = place(blank(), { startTimeSec: 10 }).state;
    expect(open.decorations[0]?.endTimeSec).toBeUndefined();
    const after = setDecorationEnd(open, "dec-0001", 13);
    expect(after.decorations[0]?.endTimeSec).toBe(13);
  });

  it("lets the start of an open-ended decoration travel freely", () => {
    const open = place(blank(), { startTimeSec: 10 }).state;
    expect(setDecorationStart(open, "dec-0001", 40).decorations[0]?.startTimeSec).toBe(40);
  });

  it("re-sorts when a start crosses a neighbour", () => {
    let state = place(blank(), { startTimeSec: 1 }).state;
    state = place(state, { startTimeSec: 5 }).state;
    const after = setDecorationStart(state, "dec-0001", 9);
    expect(after.decorations.map((d) => d.id)).toEqual(["dec-0002", "dec-0001"]);
  });

  it("records nothing when an edge does not move", () => {
    const state = one();
    expect(setDecorationStart(state, "dec-0001", 10)).toBe(state);
    expect(setDecorationEnd(state, "dec-0001", 14)).toBe(state);
  });
});

describe("moving in time", () => {
  const both = () => {
    let state = placeNote(blank(), { timeSec: 5, lane: 1, type: "tap" }).state;
    state = place(state, { startTimeSec: 6, endTimeSec: 8 }).state;
    return state;
  };

  it("carries both edges, so a window keeps its length", () => {
    const after = moveChartObjects(both(), [], ["dec-0001"], 3, 0);
    expect(after.decorations[0]?.startTimeSec).toBe(9);
    expect(after.decorations[0]?.endTimeSec).toBe(11);
  });

  it("moves notes and decorations together by the same amount", () => {
    const after = moveChartObjects(both(), ["n-0001"], ["dec-0001"], 2, 0);
    expect(after.notes[0]?.timeSec).toBe(7);
    expect(after.decorations[0]?.startTimeSec).toBe(8);
  });

  it("clamps once for the whole set, so a mixed selection keeps its shape", () => {
    // The note is the earliest thing, so it decides where the set stops.
    const after = moveChartObjects(both(), ["n-0001"], ["dec-0001"], -100, 0);
    expect(after.notes[0]?.timeSec).toBe(0);
    expect(after.decorations[0]?.startTimeSec).toBe(1);
    expect(after.decorations[0]?.endTimeSec).toBe(3);
  });

  it("clamps against a decoration when that is the earliest thing", () => {
    let state = placeNote(blank(), { timeSec: 9, lane: 1, type: "tap" }).state;
    state = place(state, { startTimeSec: 2, endTimeSec: 3 }).state;
    const after = moveChartObjects(state, ["n-0001"], ["dec-0001"], -100, 0);
    expect(after.decorations[0]?.startTimeSec).toBe(0);
    expect(after.notes[0]?.timeSec).toBe(7);
  });

  it("does not give a decoration a lane, however the notes move across them", () => {
    const after = moveChartObjects(both(), ["n-0001"], ["dec-0001"], 0, 2);
    expect(after.notes[0]?.lane).toBe(3);
    expect(after.decorations[0]).not.toHaveProperty("lane");
    expect(after.decorations[0]?.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it("ignores the lane delta entirely when only decorations are moving", () => {
    const after = moveChartObjects(both(), [], ["dec-0001"], 1, 3);
    expect(after.notes[0]?.lane).toBe(1);
    expect(after.decorations[0]?.startTimeSec).toBe(7);
  });

  it("leaves moveNotes behaving exactly as it did", () => {
    const state = both();
    expect(moveNotes(state, ["n-0001"], 2, 1)).toEqual(
      moveChartObjects(state, ["n-0001"], [], 2, 1),
    );
    expect(moveNotes(state, ["n-0001"], 2, 1).decorations).toBe(state.decorations);
  });

  it("refuses an id that is not there", () => {
    expect(() => moveChartObjects(both(), [], ["dec-9999"], 1, 0)).toThrow(/dec-9999/);
  });

  it("returns the same state for a move of nothing", () => {
    const state = both();
    expect(moveChartObjects(state, [], [], 5, 0)).toBe(state);
    expect(moveChartObjects(state, [], ["dec-0001"], 0, 0)).toBe(state);
  });
});

describe("moving across the playfield", () => {
  const one = () => place(blank(), { position: { x: 0.5, y: 0.5 } }).state;

  it("adds the delta and leaves the time alone", () => {
    const after = moveDecorationsBy(one(), ["dec-0001"], 0.2, -0.1);
    expect(after.decorations[0]?.position).toEqual({ x: 0.7, y: 0.4 });
    expect(after.decorations[0]?.startTimeSec).toBe(1);
  });

  it("stops at the edge of the playfield, per axis", () => {
    const after = moveDecorationsBy(one(), ["dec-0001"], 5, 0.1);
    expect(after.decorations[0]?.position).toEqual({ x: 1, y: 0.6 });
  });

  it("lets two decorations both settle on the edge", () => {
    // A wall rather than a boundary the group keeps its shape against: what the author
    // sees is both captions arriving at the edge, so both should be there.
    let state = place(blank(), { position: { x: 0.9, y: 0.5 } }).state;
    state = place(state, { position: { x: 0.5, y: 0.5 } }).state;
    const after = moveDecorationsBy(state, ["dec-0001", "dec-0002"], 5, 0);
    expect(after.decorations.map((d) => d.position.x)).toEqual([1, 1]);
  });

  it("returns the same state when nothing can move", () => {
    const state = moveDecorationsBy(one(), ["dec-0001"], 5, 5);
    expect(moveDecorationsBy(state, ["dec-0001"], 5, 5)).toBe(state);
    expect(moveDecorationsBy(state, [], 0.1, 0)).toBe(state);
    expect(moveDecorationsBy(state, ["dec-0001"], 0, 0)).toBe(state);
  });
});

describe("deleting", () => {
  it("removes what was named and nothing else", () => {
    let state = place(blank(), { startTimeSec: 1 }).state;
    state = place(state, { startTimeSec: 2 }).state;
    const after = deleteDecorations(state, ["dec-0001"]);
    expect(after.decorations.map((d) => d.id)).toEqual(["dec-0002"]);
  });

  it("touches no note, because no note refers to a decoration", () => {
    let state = placeNote(blank(), { timeSec: 1, lane: 0, type: "tap" }).state;
    state = place(state).state;
    const after = deleteDecorations(state, ["dec-0001"]);
    expect(after.notes).toBe(state.notes);
    expect(after.connections).toBe(state.connections);
  });

  it("returns the same state when there is nothing to remove", () => {
    const state = place(blank()).state;
    expect(deleteDecorations(state, [])).toBe(state);
    expect(deleteDecorations(state, ["dec-9999"])).toBe(state);
  });
});

describe("a chart the Editor created", () => {
  it("starts with an empty decoration list and a counter at one", () => {
    expect(blank().decorations).toEqual([]);
    expect(blank().nextDecorationIdSeq).toBe(1);
  });

  it("writes no decorations key until there is one to write", () => {
    expect(Object.keys(serializeChart(blank()))).not.toContain("decorations");
    const { state } = place(blank());
    expect(Object.keys(serializeChart(state))).toContain("decorations");
  });

  it("shows a decoration with no end for the default duration", () => {
    // The one number a reader is allowed to assume, stated once and used everywhere.
    const { decoration } = place(blank(), { startTimeSec: 4 });
    expect(decoration.endTimeSec).toBeUndefined();
    expect(DEFAULT_DISPLAY_DURATION_SEC).toBeGreaterThan(0);
  });
});
