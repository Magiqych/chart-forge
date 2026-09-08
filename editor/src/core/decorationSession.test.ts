/**
 * Decorations through the session: selection, undo, and the clipboard.
 *
 * The session is the Editor's command boundary, so this is where "one gesture is one step
 * of undo" is actually checked, and where a selection holding both kinds of object has to
 * behave. The notes' own behaviour is asserted alongside, because the point of a mixed
 * selection is that neither kind notices the other.
 */

import { describe, expect, it } from "vitest";

import { emptyChart, type ChartState } from "./chart";
import {
  addObjectsToSelection, canRedoSession, canUndoSession, chartOf, clearSelection,
  copyFromSession, editDecoration, isDecorationSelected, moveSelected,
  moveSelectedDecorations, openSession, pasteIntoSession, place,
  placeDecorationInSession, redo, removeSelected, resizeDecorationEnd,
  resizeDecorationStart, select, selectDecoration, selectMany, selectObjects,
  selectedDecorations, soleSelectedDecoration, toggleDecorationSelected,
  totalSelectionCount, undo, type EditorSession,
} from "./editorSession";
import { clipboardSize, isClipboardEmpty } from "./clipboard";

const blank = (): ChartState => emptyChart({ audioPath: "song.wav", audioDurationSec: 30 });
const fresh = () => openSession(blank());

const addText = (
  session: EditorSession,
  over: { startTimeSec?: number; endTimeSec?: number; text?: string } = {},
) => {
  const startTimeSec = over.startTimeSec ?? 10;
  return placeDecorationInSession(session, {
    startTimeSec,
    endTimeSec: over.endTimeSec ?? startTimeSec + 2,
    text: over.text ?? "HI",
    position: { x: 0.5, y: 0.5 },
  });
};

const decorationOf = (session: EditorSession, id: string) =>
  chartOf(session).decorations.find((d) => d.id === id);

describe("placing through the session", () => {
  it("adds it and selects it, so the next keystroke goes into it", () => {
    const session = addText(fresh());
    expect(chartOf(session).decorations).toHaveLength(1);
    expect(session.selectedDecorationIds).toEqual(["dec-0001"]);
    expect(session.selectedNoteIds).toEqual([]);
  });

  it("is one step of undo", () => {
    const session = addText(fresh());
    expect(canUndoSession(session)).toBe(true);
    const back = undo(session);
    expect(chartOf(back).decorations).toHaveLength(0);
    // A selection pointing at something that no longer exists would leave Delete armed
    // against nothing.
    expect(back.selectedDecorationIds).toEqual([]);
    expect(chartOf(redo(back)).decorations).toHaveLength(1);
  });

  it("never reuses an id after an undo and a fresh placement", () => {
    // The discarded redo branch had already handed dec-0001 out; a second one would make
    // the undone decoration and the new one share an identity.
    const first = addText(fresh());
    const second = addText(undo(first));
    expect(second.selectedDecorationIds).toEqual(["dec-0002"]);
  });
});

describe("selection", () => {
  const withBoth = () => {
    let session = place(fresh(), { timeSec: 1, lane: 0, type: "tap" });
    session = addText(session);
    return session;
  };

  it("selects one decoration and clears the notes", () => {
    const session = selectDecoration(withBoth(), "dec-0001");
    expect(session.selectedDecorationIds).toEqual(["dec-0001"]);
    expect(session.selectedNoteIds).toEqual([]);
    expect(isDecorationSelected(session, "dec-0001")).toBe(true);
  });

  it("selecting a note clears the decorations, and the other way round", () => {
    let session = selectDecoration(withBoth(), "dec-0001");
    session = select(session, "n-0001");
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(session.selectedDecorationIds).toEqual([]);

    session = selectDecoration(session, "dec-0001");
    expect(session.selectedNoteIds).toEqual([]);
  });

  it("holds both kinds at once when a rubber band caught both", () => {
    const session = selectObjects(withBoth(), ["n-0001"], ["dec-0001"]);
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(session.selectedDecorationIds).toEqual(["dec-0001"]);
    expect(totalSelectionCount(session)).toBe(2);
  });

  it("adds to a mixed selection without disturbing what is in it", () => {
    let session = addText(withBoth(), { startTimeSec: 20 });
    session = selectObjects(session, ["n-0001"], []);
    session = addObjectsToSelection(session, [], ["dec-0001", "dec-0002"]);
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(session.selectedDecorationIds).toEqual(["dec-0001", "dec-0002"]);
    // Adding what is already there changes nothing at all.
    expect(addObjectsToSelection(session, ["n-0001"], ["dec-0001"])).toBe(session);
  });

  it("toggles one in and out, as shift-click does", () => {
    // Placing selects what it made, so start from nothing selected.
    let session = clearSelection(withBoth());
    session = toggleDecorationSelected(session, "dec-0001");
    expect(session.selectedDecorationIds).toEqual(["dec-0001"]);
    session = toggleDecorationSelected(session, "dec-0001");
    expect(session.selectedDecorationIds).toEqual([]);
  });

  it("clears both lists at once", () => {
    const session = clearSelection(selectObjects(withBoth(), ["n-0001"], ["dec-0001"]));
    expect(totalSelectionCount(session)).toBe(0);
  });

  it("reports the selected decorations, skipping any that have gone", () => {
    const session = selectObjects(withBoth(), [], ["dec-0001", "dec-9999"]);
    expect(selectedDecorations(session).map((d) => d.id)).toEqual(["dec-0001"]);
  });

  it("names a sole selected decoration only when it is alone", () => {
    let session = selectDecoration(withBoth(), "dec-0001");
    expect(soleSelectedDecoration(session)?.id).toBe("dec-0001");
    session = addObjectsToSelection(session, ["n-0001"], []);
    expect(soleSelectedDecoration(session)).toBeNull();
  });

  it("leaves the note selection commands behaving as they always did", () => {
    const session = selectMany(withBoth(), ["n-0001"]);
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(selectMany(session, ["n-0001"])).toBe(session);
  });
});

describe("deleting", () => {
  const withBoth = () => {
    let session = place(fresh(), { timeSec: 1, lane: 0, type: "tap" });
    session = addText(session);
    return selectObjects(session, ["n-0001"], ["dec-0001"]);
  };

  it("removes a mixed selection in one step", () => {
    const after = removeSelected(withBoth());
    expect(chartOf(after).notes).toHaveLength(0);
    expect(chartOf(after).decorations).toHaveLength(0);
    expect(totalSelectionCount(after)).toBe(0);
  });

  it("one undo brings all of it back", () => {
    const back = undo(removeSelected(withBoth()));
    expect(chartOf(back).notes).toHaveLength(1);
    expect(chartOf(back).decorations).toHaveLength(1);
    expect(canRedoSession(back)).toBe(true);
  });

  it("records nothing when nothing is selected", () => {
    const session = clearSelection(withBoth());
    expect(removeSelected(session)).toBe(session);
  });
});

describe("moving through the session", () => {
  const withBoth = () => {
    let session = place(fresh(), { timeSec: 5, lane: 1, type: "tap" });
    session = addText(session, { startTimeSec: 6, endTimeSec: 8 });
    return selectObjects(session, ["n-0001"], ["dec-0001"]);
  };

  it("moves a mixed selection as one, in one step", () => {
    const after = moveSelected(withBoth(), 2, 0);
    expect(chartOf(after).notes[0]?.timeSec).toBe(7);
    expect(decorationOf(after, "dec-0001")?.startTimeSec).toBe(8);
    expect(decorationOf(after, "dec-0001")?.endTimeSec).toBe(10);

    const back = undo(after);
    expect(chartOf(back).notes[0]?.timeSec).toBe(5);
    expect(decorationOf(back, "dec-0001")?.startTimeSec).toBe(6);
  });

  it("moves a decoration on its own", () => {
    const session = selectDecoration(withBoth(), "dec-0001");
    const after = moveSelected(session, 1.5, 0);
    expect(decorationOf(after, "dec-0001")?.startTimeSec).toBe(7.5);
    expect(chartOf(after).notes[0]?.timeSec).toBe(5);
  });

  it("moves across the playfield without touching the time, and back on undo", () => {
    const session = selectDecoration(withBoth(), "dec-0001");
    const after = moveSelectedDecorations(session, 0.2, -0.3);
    expect(decorationOf(after, "dec-0001")?.position).toEqual({ x: 0.7, y: 0.2 });
    expect(decorationOf(after, "dec-0001")?.startTimeSec).toBe(6);
    expect(decorationOf(undo(after), "dec-0001")?.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it("leaves notes alone when the playfield drag runs", () => {
    const after = moveSelectedDecorations(withBoth(), 0.1, 0);
    expect(chartOf(after).notes[0]?.timeSec).toBe(5);
    expect(chartOf(after).notes[0]?.lane).toBe(1);
  });

  it("records nothing for a move that changed nothing", () => {
    const session = withBoth();
    expect(moveSelected(session, 0, 0)).toBe(session);
    const cleared = clearSelection(session);
    expect(moveSelectedDecorations(cleared, 0.1, 0.1)).toBe(cleared);
  });
});

describe("editing through the session", () => {
  const one = () => selectDecoration(addText(fresh()), "dec-0001");

  it("records one step per edit, and undo takes it back", () => {
    const typed = editDecoration(one(), "dec-0001", { text: "キラメキ☆" });
    expect(decorationOf(typed, "dec-0001")?.text).toBe("キラメキ☆");
    expect(decorationOf(undo(typed), "dec-0001")?.text).toBe("HI");
    expect(decorationOf(redo(undo(typed)), "dec-0001")?.text).toBe("キラメキ☆");
  });

  it("undoes a style edit and an animation edit apart", () => {
    let session = editDecoration(one(), "dec-0001", { style: { fontSize: 0.2 } });
    session = editDecoration(session, "dec-0001", { animation: { enter: "fade" } });
    const back = undo(session);
    expect(decorationOf(back, "dec-0001")?.animation).toBeUndefined();
    expect(decorationOf(back, "dec-0001")?.style?.fontSize).toBe(0.2);
  });

  it("records nothing for an edit that changed nothing", () => {
    const session = one();
    expect(editDecoration(session, "dec-0001", { text: "HI" })).toBe(session);
  });

  it("resizes each edge in one step apiece", () => {
    const started = resizeDecorationStart(one(), "dec-0001", 11);
    expect(decorationOf(started, "dec-0001")?.startTimeSec).toBe(11);
    expect(decorationOf(started, "dec-0001")?.endTimeSec).toBe(12);
    expect(decorationOf(undo(started), "dec-0001")?.startTimeSec).toBe(10);

    const ended = resizeDecorationEnd(one(), "dec-0001", 15);
    expect(decorationOf(ended, "dec-0001")?.endTimeSec).toBe(15);
    expect(decorationOf(ended, "dec-0001")?.startTimeSec).toBe(10);
    expect(decorationOf(undo(ended), "dec-0001")?.endTimeSec).toBe(12);
  });
});

describe("copy and paste", () => {
  const populated = () => {
    let session = place(fresh(), { timeSec: 5, lane: 1, type: "tap" });
    session = addText(session, { startTimeSec: 6, endTimeSec: 8, text: "キラメキ☆" });
    return selectObjects(session, ["n-0001"], ["dec-0001"]);
  };

  it("copies a mixed selection", () => {
    const clipboard = copyFromSession(populated());
    expect(clipboardSize(clipboard)).toBe(2);
    expect(isClipboardEmpty(clipboard)).toBe(false);
  });

  it("copies nothing when nothing is selected", () => {
    expect(isClipboardEmpty(copyFromSession(clearSelection(populated())))).toBe(true);
  });

  it("pastes at the time asked for, keeping the spacing inside the copy", () => {
    const session = populated();
    const clipboard = copyFromSession(session);
    const after = pasteIntoSession(session, clipboard, 20);

    // The earliest thing copied was the note at 5, so it lands exactly on 20 and the
    // decoration keeps its one second of separation.
    const pastedNote = chartOf(after).notes.find((n) => n.id !== "n-0001");
    const pastedText = chartOf(after).decorations.find((d) => d.id !== "dec-0001");
    expect(pastedNote?.timeSec).toBe(20);
    expect(pastedText?.startTimeSec).toBe(21);
    expect(pastedText?.endTimeSec).toBe(23);
  });

  it("mints fresh ids rather than duplicating one", () => {
    const session = populated();
    const clipboard = copyFromSession(session);
    const after = pasteIntoSession(session, clipboard, 20);
    const ids = chartOf(after).decorations.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("dec-0002");
  });

  it("pasting twice makes two independent copies", () => {
    const session = populated();
    const clipboard = copyFromSession(session);
    const after = pasteIntoSession(pasteIntoSession(session, clipboard, 20), clipboard, 25);
    expect(chartOf(after).decorations).toHaveLength(3);
    expect(new Set(chartOf(after).decorations.map((d) => d.id)).size).toBe(3);
  });

  it("carries the text, the style and the position across", () => {
    let session = editDecoration(populated(), "dec-0001", {
      style: { fontSize: 0.2, color: "#ff0000" },
      position: { x: 0.2, y: 0.8 },
    });
    session = selectObjects(session, [], ["dec-0001"]);
    const after = pasteIntoSession(session, copyFromSession(session), 30);
    const pasted = chartOf(after).decorations.find((d) => d.id !== "dec-0001");
    expect(pasted?.text).toBe("キラメキ☆");
    expect(pasted?.style).toEqual({ fontSize: 0.2, color: "#ff0000" });
    // A position is a place on the playfield, not an offset from anything, so it is
    // copied exactly rather than moved because the time changed.
    expect(pasted?.position).toEqual({ x: 0.2, y: 0.8 });
  });

  it("selects what was pasted", () => {
    const session = populated();
    const after = pasteIntoSession(session, copyFromSession(session), 20);
    expect(after.selectedDecorationIds).toEqual(["dec-0002"]);
    expect(after.selectedNoteIds).toHaveLength(1);
    expect(after.selectedNoteIds[0]).not.toBe("n-0001");
  });

  it("is one step of undo, however much was pasted", () => {
    const session = populated();
    const after = pasteIntoSession(session, copyFromSession(session), 20);
    const back = undo(after);
    expect(chartOf(back).notes).toHaveLength(1);
    expect(chartOf(back).decorations).toHaveLength(1);
    expect(chartOf(redo(back)).decorations).toHaveLength(2);
  });

  it("does nothing at all with an empty clipboard", () => {
    const session = populated();
    expect(pasteIntoSession(session, copyFromSession(clearSelection(session)), 5))
      .toBe(session);
  });
});
