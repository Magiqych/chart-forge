import { describe, expect, it } from "vitest";

import { pointerIntent, type PointerContext } from "./pointerIntent";

const at = (over: Partial<PointerContext> = {}): PointerContext => ({
  mode: "edit",
  noteType: "tap",
  hitNoteId: null,
  hitPart: null,
  hitSelected: false,
  shiftKey: false,
  ...over,
});

describe("Edit Mode makes notes", () => {
  it("places on empty lane space", () => {
    expect(pointerIntent(at())).toEqual({ kind: "place", type: "tap" });
    expect(pointerIntent(at({ noteType: "flick" })))
      .toEqual({ kind: "place", type: "flick" });
  });

  it("draws out the one kind that has a duration", () => {
    expect(pointerIntent(at({ noteType: "hold" })))
      .toEqual({ kind: "startDrag", type: "hold" });
  });

  it("places a slide point with a click, rather than dragging one out", () => {
    // A slide is a chain of judgement points, so the points go down one at a time and
    // are joined afterwards.
    expect(pointerIntent(at({ noteType: "slide" })))
      .toEqual({ kind: "place", type: "slide" });
  });

  it("never starts a rubber band, whatever the modifier", () => {
    // A drag in Edit Mode draws a note out or does nothing. It is not a selection, and
    // shift does not turn it into one - that is what Select Mode is for.
    for (const noteType of ["tap", "hold", "slide", "flick"] as const) {
      for (const shiftKey of [false, true]) {
        expect(pointerIntent(at({ noteType, shiftKey })).kind)
          .not.toBe("startMarquee");
      }
    }
  });

  it("does nothing on a note that is already there", () => {
    // Not a placement, because stacking a second note on the first is a mistake every
    // time; and not a selection either, because that would mix the modes back together.
    expect(pointerIntent(at({ hitNoteId: "n-0001" }))).toEqual({ kind: "ignore" });
    expect(pointerIntent(at({ hitNoteId: "n-0001", noteType: "hold" })))
      .toEqual({ kind: "ignore" });
    expect(pointerIntent(at({ hitNoteId: "n-0001", shiftKey: true })))
      .toEqual({ kind: "ignore" });
  });

  it("never selects anything", () => {
    for (const hitNoteId of [null, "n-0001"]) {
      for (const shiftKey of [false, true]) {
        const intent = pointerIntent(at({ hitNoteId, shiftKey }));
        expect(intent.kind).not.toBe("selectOne");
        expect(intent.kind).not.toBe("toggleSelected");
      }
    }
  });
});

describe("Select Mode chooses notes", () => {
  const sel = (over: Partial<PointerContext> = {}) =>
    pointerIntent(at({ mode: "select", ...over }));

  it("selects the note under the pointer", () => {
    expect(sel({ hitNoteId: "n-0002" }))
      .toEqual({ kind: "selectOne", noteId: "n-0002" });
  });

  it("toggles with shift", () => {
    expect(sel({ hitNoteId: "n-0002", shiftKey: true }))
      .toEqual({ kind: "toggleSelected", noteId: "n-0002" });
  });

  it("starts a rubber band on empty space", () => {
    expect(sel()).toEqual({ kind: "startMarquee", add: false });
  });

  it("adds to the selection when a rubber band starts with shift", () => {
    expect(sel({ shiftKey: true })).toEqual({ kind: "startMarquee", add: true });
  });

  it("never places a note, whatever the note type says", () => {
    // The note type is Edit Mode's business. Select Mode does not consult it, so a
    // leftover choice of Long cannot leak a note into the chart.
    for (const noteType of ["tap", "hold", "slide", "flick"] as const) {
      const intent = sel({ noteType });
      expect(intent.kind).not.toBe("place");
      expect(intent.kind).not.toBe("startDrag");
    }
  });

  it("gives the same answer whichever kind is left selected in the toolbar", () => {
    const first = sel({ noteType: "tap" });
    for (const noteType of ["hold", "slide", "flick"] as const) {
      expect(sel({ noteType })).toEqual(first);
    }
  });
});

describe("the modes never overlap", () => {
  it("assigns every press exactly one meaning", () => {
    const kinds = new Set<string>();
    for (const mode of ["edit", "select"] as const) {
      for (const noteType of ["tap", "hold", "slide", "flick"] as const) {
        for (const hitNoteId of [null, "n-0001"]) {
          for (const hitPart of [null, "marker", "body", "resizeHandle", "startHandle"] as const) {
            for (const hitSelected of [false, true]) {
              for (const shiftKey of [false, true]) {
                kinds.add(pointerIntent({
                  mode, noteType, hitNoteId, hitPart, hitSelected, shiftKey,
                }).kind);
              }
            }
          }
        }
      }
    }
    // Every branch is reachable, and nothing else is.
    expect([...kinds].sort()).toEqual([
      "ignore", "place", "selectOne", "startDrag", "startMarquee", "startResize",
      "toggleSelected",
    ]);
  });

  it("creates in Edit and only in Edit", () => {
    const creates = (mode: "edit" | "select") => {
      for (const noteType of ["tap", "hold", "slide", "flick"] as const) {
        for (const hitNoteId of [null, "n-0001"]) {
          const kind = pointerIntent({
            mode, noteType, hitNoteId, hitPart: null, hitSelected: false, shiftKey: false,
          }).kind;
          if (kind === "place" || kind === "startDrag") return true;
        }
      }
      return false;
    };
    expect(creates("edit")).toBe(true);
    expect(creates("select")).toBe(false);
  });

  it("selects in Select and only in Select", () => {
    const selects = (mode: "edit" | "select") => {
      for (const hitNoteId of [null, "n-0001"]) {
        for (const shiftKey of [false, true]) {
          const kind = pointerIntent({
            mode, noteType: "tap", hitNoteId, hitPart: null, hitSelected: false, shiftKey,
          }).kind;
          if (kind === "selectOne" || kind === "toggleSelected" || kind === "startMarquee") {
            return true;
          }
        }
      }
      return false;
    };
    expect(selects("select")).toBe(true);
    expect(selects("edit")).toBe(false);
  });
});

describe("the resize grips", () => {
  const sel = (over: Partial<PointerContext> = {}) =>
    pointerIntent(at({ mode: "select", ...over }));

  it("is taken when a selected note's end grip is pressed", () => {
    expect(sel({ hitNoteId: "n-1", hitPart: "resizeHandle", hitSelected: true }))
      .toEqual({ kind: "startResize", noteId: "n-1", edge: "end" });
  });

  it("says which end was taken, so the two grips cannot be confused", () => {
    expect(sel({ hitNoteId: "n-1", hitPart: "startHandle", hitSelected: true }))
      .toEqual({ kind: "startResize", noteId: "n-1", edge: "start" });
  });

  it("is not grippable on a note that is not selected", () => {
    // The grips are only drawn on a selected note, so they must only be grabbable on one.
    for (const hitPart of ["resizeHandle", "startHandle"] as const) {
      expect(sel({ hitNoteId: "n-1", hitPart, hitSelected: false }))
        .toEqual({ kind: "selectOne", noteId: "n-1" });
    }
  });

  it("gives way to shift, which is still a toggle", () => {
    for (const hitPart of ["resizeHandle", "startHandle"] as const) {
      expect(sel({ hitNoteId: "n-1", hitPart, hitSelected: true, shiftKey: true }))
        .toEqual({ kind: "toggleSelected", noteId: "n-1" });
    }
  });

  it("is never taken in Edit Mode", () => {
    for (const hitPart of ["resizeHandle", "startHandle"] as const) {
      expect(pointerIntent(at({ hitNoteId: "n-1", hitPart, hitSelected: true })))
        .toEqual({ kind: "ignore" });
    }
  });

  it("leaves every other part of a selected note selecting it", () => {
    for (const hitPart of ["marker", "endMarker", "body", "connector", "arrow"] as const) {
      expect(sel({ hitNoteId: "n-1", hitPart, hitSelected: true }))
        .toEqual({ kind: "selectOne", noteId: "n-1" });
    }
  });
});
