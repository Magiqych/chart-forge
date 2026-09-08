import { describe, expect, it } from "vitest";

import { emptyChart, projectChart, ChartError } from "./chart";
import { serializeChart } from "./chart";
import {
  addToSelection, canRedoSession, canUndoSession, changeEndAction, changeFlickDirection,
  chartOf, clearSelection, connect, connectableSelection, connectFlickRun, disconnect,
  disconnectableRun, disconnectFlickRun, isChartDirty,
  isDirty, isSelected, markChartSaved, markSaveFailed, markSaved, moveSelected,
  openSession, place, placeAtEvent, redo, remove, removeSelected, resize, resizeStart,
  select,
  selectAt, selectEvent, selectionCount, selectMany, setSnap, setSnapMode, soleSelectedId,
  toggleSelected, undo,
} from "./editorSession";
import {
  buildSnapGrid, snapTime, DEFAULT_SNAP, readSnapSettings, type SnapSettings,
} from "./snap";

const blank = () => emptyChart({ audioPath: "song.wav", audioDurationSec: 8 });
const tap = (timeSec: number, lane: number) => ({ timeSec, lane, type: "tap" as const });
const fresh = () => openSession(blank(), DEFAULT_SNAP);

describe("dirty state", () => {
  it("a freshly loaded chart is clean on both counts", () => {
    const loaded = projectChart({
      version: "0.1.0",
      audio: { path: "song.wav" },
      timing: { offsetSec: 0 },
      playfield: { laneCount: 5 },
      notes: [{ id: "n-0001", type: "tap", timeSec: 1, lane: 0 }],
    });
    const session = openSession(loaded, { enabled: false, division: 4 });
    expect(isChartDirty(session)).toBe(false);
    expect(session.projectDirty).toBe(false);
    expect(isDirty(session)).toBe(false);
    expect(session.selectedNoteIds).toEqual([]);
  });

  it("a chart created for a project that had none is also clean", () => {
    // Nothing has been authored yet, so there is nothing to lose and Save is not urged.
    expect(isDirty(fresh())).toBe(false);
  });

  it("placing a note dirties the chart and not the project", () => {
    const session = place(fresh(), tap(1, 0));
    expect(isChartDirty(session)).toBe(true);
    expect(session.projectDirty).toBe(false);
    expect(isDirty(session)).toBe(true);
  });

  it("deleting a note dirties the chart and not the project", () => {
    const saved = markSaved(place(fresh(), tap(1, 0)));
    expect(isDirty(saved)).toBe(false);

    const after = remove(saved, "n-0001");
    expect(isChartDirty(after)).toBe(true);
    expect(after.projectDirty).toBe(false);
  });

  it("turning snapping off dirties the project and not the chart", () => {
    // Snapping decides where a future note lands; it changes nothing already placed.
    const session = setSnap(fresh(), { enabled: false, division: 1 });
    expect(session.projectDirty).toBe(true);
    expect(isChartDirty(session)).toBe(false);
    expect(isDirty(session)).toBe(true);
  });

  it("changing the snap division dirties the project and not the chart", () => {
    const session = setSnap(fresh(), { enabled: true, division: 4 });
    expect(session.projectDirty).toBe(true);
    expect(isChartDirty(session)).toBe(false);
    expect(chartOf(session).notes).toHaveLength(0);
  });

  it("setting the same snap values again changes nothing", () => {
    const session = fresh();
    expect(setSnap(session, { ...DEFAULT_SNAP })).toBe(session);
    expect(isDirty(setSnap(session, { ...DEFAULT_SNAP }))).toBe(false);
  });

  it("editing both documents leaves the session dirty overall", () => {
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 8 });
    expect(isChartDirty(session)).toBe(true);
    expect(session.projectDirty).toBe(true);
    expect(isDirty(session)).toBe(true);
  });

  it("a successful save clears both", () => {
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 2 });

    const saved = markSaved(session);
    expect(isChartDirty(saved)).toBe(false);
    expect(saved.projectDirty).toBe(false);
    expect(isDirty(saved)).toBe(false);
    expect(chartOf(saved).notes).toHaveLength(1);
    expect(saved.snap).toEqual({ enabled: false, division: 2 });
  });

  it("a save that changed only the snap settings still ends clean", () => {
    const saved = markSaved(setSnap(fresh(), { enabled: false, division: 6 }));
    expect(isDirty(saved)).toBe(false);
  });

  it("a failed save leaves both dirty", () => {
    // The notes only exist in memory until the write succeeds, so the editor must keep
    // saying so rather than looking saved.
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 4 });

    const after = markSaveFailed(session);
    expect(isChartDirty(after)).toBe(true);
    expect(after.projectDirty).toBe(true);
    expect(chartOf(after).notes).toHaveLength(1);
  });

  it("a chart that saved before the project failed reports exactly that", () => {
    // The chart is written first, so this is the only partial outcome the save order
    // can produce: the notes are on disk, the project is not yet up to date.
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 4 });

    const after = markChartSaved(session);
    expect(isChartDirty(after)).toBe(false);
    expect(after.projectDirty).toBe(true);
    expect(isDirty(after)).toBe(true);
    expect(chartOf(after).notes).toHaveLength(1);
  });

  it("selecting and deselecting dirties nothing", () => {
    const session = markSaved(place(fresh(), tap(1, 0)));
    expect(isDirty(select(session, "n-0001"))).toBe(false);
    expect(isDirty(select(session, null))).toBe(false);
  });

  it("a rejected placement leaves the session untouched", () => {
    const session = fresh();
    expect(() => place(session, { timeSec: 1, lane: 99, type: "tap" })).toThrow(ChartError);
    expect(isDirty(session)).toBe(false);
    expect(chartOf(session).notes).toHaveLength(0);
  });
});

describe("snap settings round trip", () => {
  it("restores what a project recorded", () => {
    // What the Editor writes on save is what it reads back on load.
    const persisted: SnapSettings = { enabled: false, division: 8 };
    const session = openSession(blank(), readSnapSettings({ snap: persisted }));
    expect(session.snap).toEqual(persisted);
    expect(isDirty(session)).toBe(false);
  });

  it("survives a change, a save, and a reload of what was saved", () => {
    let session = setSnap(fresh(), { enabled: false, division: 3 });
    session = markSaved(session);

    // What the save path sends to Rust, and what a later load reads back out.
    const written = { snap: { enabled: session.snap.enabled, division: session.snap.division } };
    const reopened = openSession(blank(), readSnapSettings(written));

    expect(reopened.snap).toEqual({ enabled: false, division: 3 });
    expect(isDirty(reopened)).toBe(false);
  });

  it("falls back to the defaults for a project that never recorded any", () => {
    expect(openSession(blank(), readSnapSettings(undefined)).snap).toEqual(DEFAULT_SNAP);
  });
});

describe("selection", () => {
  it("placing a note selects it, so Delete acts on what was just placed", () => {
    expect(place(fresh(), tap(1, 0)).selectedNoteIds).toEqual(["n-0001"]);
  });

  it("deleting the selected note clears the selection", () => {
    const session = place(fresh(), tap(1, 0));
    expect(remove(session, "n-0001").selectedNoteIds).toEqual([]);
  });

  it("deleting a different note keeps the selection", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 0));
    expect(session.selectedNoteIds).toEqual(["n-0002"]);
    expect(remove(session, "n-0001").selectedNoteIds).toEqual(["n-0002"]);
  });

  it("selectAt picks the note under the pointer, or clears when there is none", () => {
    const session = place(fresh(), tap(1, 2));
    const hit = selectAt(session, 1.01, 2, 0.05);
    expect(hit.hit?.id).toBe("n-0001");
    expect(hit.session.selectedNoteIds).toEqual(["n-0001"]);

    const miss = selectAt(hit.session, 5, 2, 0.05);
    expect(miss.hit).toBeNull();
    expect(miss.session.selectedNoteIds).toEqual([]);
  });

  it("re-selecting the same note returns the identical session", () => {
    const session = place(fresh(), tap(1, 0));
    expect(select(session, "n-0001")).toBe(session);
  });
});

describe("commands are pure", () => {
  it("place, remove and setSnap return new sessions rather than mutating", () => {
    // This is what makes an undo stack a later addition rather than a rewrite: the
    // previous session object is still intact and could simply be pushed on a stack.
    const first = fresh();
    const second = place(first, tap(1, 0));
    const third = remove(second, "n-0001");
    const fourth = setSnap(third, { enabled: false, division: 4 });

    expect(chartOf(first).notes).toHaveLength(0);
    expect(chartOf(second).notes).toHaveLength(1);
    expect(chartOf(third).notes).toHaveLength(0);
    expect(first.snap).toEqual(DEFAULT_SNAP);
    expect(fourth.snap).toEqual({ enabled: false, division: 4 });
    expect(second).not.toBe(first);
  });
});

/** An Analysis Event, reduced to the two fields the placement command is allowed to see. */
const EVENT = { id: "ev-000123", startSec: 45.16432026996767 };

describe("place from an Analysis Event", () => {
  it("uses the event's measured start as the note time", () => {
    const session = placeAtEvent(fresh(), EVENT, 2, "tap");
    expect(chartOf(session).notes).toHaveLength(1);
    expect(chartOf(session).notes[0]!.timeSec).toBe(EVENT.startSec);
  });

  it("records the event as provenance", () => {
    const note = chartOf(placeAtEvent(fresh(), EVENT, 2, "tap")).notes[0]!;
    expect(note.sourceEventId).toBe("ev-000123");
  });

  it("uses the lane the author chose", () => {
    for (const lane of [0, 1, 2, 3, 4]) {
      expect(chartOf(placeAtEvent(fresh(), EVENT, lane, "tap")).notes[0]!.lane).toBe(lane);
    }
  });

  it("takes nothing from the event but its start and its id", () => {
    // The command's signature is the guarantee: an event's stem, pitch, type and
    // duration are not parameters, so none of them can decide a lane or a note type.
    // A vocals-derived event placed into lane 0 as a flick makes the point.
    const session = placeAtEvent(fresh(), EVENT, 0, "flick", "up");
    expect(chartOf(session).notes[0]).toMatchObject({
      lane: 0, type: "flick", direction: "up", sourceEventId: "ev-000123",
    });
  });

  it("is not affected by the beat snap setting", () => {
    // The author picked this event because they wanted where the sound actually is;
    // pulling the note back onto the grid would discard the reason for the gesture.
    const grid = buildSnapGrid([{ timeSec: 45 }, { timeSec: 45.5 }, { timeSec: 46 }], 1);
    expect(snapTime(EVENT.startSec, grid, DEFAULT_SNAP)).not.toBe(EVENT.startSec);

    let session = setSnapMode(fresh(), "beat");
    session = placeAtEvent(session, EVENT, 2, "tap");
    expect(chartOf(session).notes[0]!.timeSec).toBe(EVENT.startSec);
  });

  it("allows several notes from one event", () => {
    // A chord or a roll built from one observed onset is ordinary authoring, so the
    // relationship is not 1:1 and a repeated sourceEventId is not an error.
    let session = placeAtEvent(fresh(), EVENT, 0, "tap");
    session = placeAtEvent(session, EVENT, 2, "tap");
    session = placeAtEvent(session, EVENT, 4, "tap");

    expect(chartOf(session).notes).toHaveLength(3);
    expect(chartOf(session).notes.map((n) => n.sourceEventId))
      .toEqual(["ev-000123", "ev-000123", "ev-000123"]);
    expect(chartOf(session).notes.map((n) => n.lane)).toEqual([0, 2, 4]);
    expect(new Set(chartOf(session).notes.map((n) => n.id)).size).toBe(3);
  });

  it("keeps the event selected so another note can follow", () => {
    const session = placeAtEvent(selectEvent(fresh(), "ev-000123"), EVENT, 0, "tap");
    expect(session.selectedEventId).toBe("ev-000123");
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
  });

  it("survives serialisation, which is how it reaches disk and comes back", () => {
    const session = placeAtEvent(fresh(), EVENT, 2, "tap");
    const notes = serializeChart(chartOf(session))["notes"] as Record<string, unknown>[];
    expect(notes[0]!["sourceEventId"]).toBe("ev-000123");
    expect(notes[0]!["timeSec"]).toBe(EVENT.startSec);

    const reloaded = projectChart(serializeChart(chartOf(session)));
    expect(reloaded.notes[0]!.sourceEventId).toBe("ev-000123");
  });
});

describe("ordinary manual placement", () => {
  it("records no sourceEventId, because no event was consulted", () => {
    const note = chartOf(place(fresh(), tap(1, 0))).notes[0]!;
    expect(note.sourceEventId).toBeUndefined();
  });

  it("omits the field entirely from the written document", () => {
    const session = place(fresh(), tap(1, 0));
    const notes = serializeChart(chartOf(session))["notes"] as Record<string, unknown>[];
    expect(Object.keys(notes[0]!)).not.toContain("sourceEventId");
  });

  it("sits alongside event-placed notes in one chart", () => {
    let session = place(fresh(), tap(1, 0));
    session = placeAtEvent(session, EVENT, 1, "tap");
    const sources = chartOf(session).notes.map((n) => n.sourceEventId);
    expect(sources).toEqual([undefined, "ev-000123"]);
  });
});

describe("Analysis event selection", () => {
  it("dirties neither document", () => {
    // Looking at read-only guidance is not editing.
    const session = selectEvent(fresh(), "ev-000123");
    expect(isChartDirty(session)).toBe(false);
    expect(session.projectDirty).toBe(false);
    expect(isDirty(session)).toBe(false);
  });

  it("changing which event is selected still dirties nothing", () => {
    let session = selectEvent(fresh(), "ev-000123");
    session = selectEvent(session, "ev-000456");
    session = selectEvent(session, null);
    expect(isDirty(session)).toBe(false);
  });

  it("is kept apart from the Chart note selection", () => {
    let session = place(fresh(), tap(1, 0));
    session = selectEvent(session, "ev-000123");
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(session.selectedEventId).toBe("ev-000123");

    session = select(session, null);
    expect(session.selectedEventId).toBe("ev-000123");
    expect(session.selectedNoteIds).toEqual([]);
  });

  it("re-selecting the same event returns the identical session", () => {
    const session = selectEvent(fresh(), "ev-000123");
    expect(selectEvent(session, "ev-000123")).toBe(session);
  });

  it("placing from an event dirties the chart, not the project", () => {
    const session = placeAtEvent(selectEvent(fresh(), "ev-000123"), EVENT, 0, "tap");
    expect(isChartDirty(session)).toBe(true);
    expect(session.projectDirty).toBe(false);
  });
});

describe("snap mode", () => {
  it("starts from what the project persisted", () => {
    expect(openSession(blank(), { enabled: true, division: 4 }).snapMode).toBe("beat");
    expect(openSession(blank(), { enabled: false, division: 4 }).snapMode).toBe("off");
  });

  it("turning beat snapping on is a project change", () => {
    const session = setSnapMode(openSession(blank(), { enabled: false, division: 1 }), "beat");
    expect(session.snap.enabled).toBe(true);
    expect(session.projectDirty).toBe(true);
  });

  it("switching between off and guide changes nothing the project stores", () => {
    // Guide snapping has nowhere to live in the contract's snap object, so it is not a
    // stored setting and choosing it does not ask for a save.
    const off = openSession(blank(), { enabled: false, division: 1 });
    const guide = setSnapMode(off, "guide");
    expect(guide.snapMode).toBe("guide");
    expect(guide.snap.enabled).toBe(false);
    expect(guide.projectDirty).toBe(false);
  });

  it("keeps the chosen division while snapping is off", () => {
    let session = setSnap(fresh(), { enabled: true, division: 4 });
    session = setSnapMode(session, "off");
    expect(session.snap.division).toBe(4);
    expect(setSnapMode(session, "beat").snap.division).toBe(4);
  });

  it("reloads guide mode as off, because the contract cannot record it", () => {
    const session = setSnapMode(fresh(), "guide");
    const written = { snap: { enabled: session.snap.enabled, division: session.snap.division } };
    expect(openSession(blank(), readSnapSettings(written)).snapMode).toBe("off");
  });

  it("setting the same mode again returns the identical session", () => {
    const session = fresh();
    expect(setSnapMode(session, session.snapMode)).toBe(session);
  });
});

describe("undo history", () => {
  it("has nothing to undo or redo when a chart is first opened", () => {
    const session = fresh();
    expect(canUndoSession(session)).toBe(false);
    expect(canRedoSession(session)).toBe(false);
    expect(undo(session)).toBe(session);
    expect(redo(session)).toBe(session);
  });

  it("takes back a placement", () => {
    const placed = place(fresh(), tap(1, 0));
    expect(chartOf(placed).notes).toHaveLength(1);

    const back = undo(placed);
    expect(chartOf(back).notes).toHaveLength(0);
    expect(canUndoSession(back)).toBe(false);
    expect(canRedoSession(back)).toBe(true);
  });

  it("puts a placement back", () => {
    const placed = place(fresh(), tap(1, 0));
    const again = redo(undo(placed));
    expect(chartOf(again).notes).toHaveLength(1);
    expect(chartOf(again).notes[0]).toEqual(chartOf(placed).notes[0]);
  });

  it("restores a deleted note exactly", () => {
    const placed = placeAtEvent(fresh(), EVENT, 3, "tap");
    const before = chartOf(placed).notes[0]!;
    const deleted = remove(placed, before.id);
    expect(chartOf(deleted).notes).toHaveLength(0);

    const restored = undo(deleted);
    expect(chartOf(restored).notes).toHaveLength(1);
    // Not an equivalent note - the same one, with everything it carried.
    expect(chartOf(restored).notes[0]).toEqual(before);
  });

  it("re-deletes on redo", () => {
    let session = place(fresh(), tap(1, 0));
    session = remove(session, "n-0001");
    expect(chartOf(redo(undo(session))).notes).toHaveLength(0);
  });

  it("undoes several edits in reverse order", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 1));
    session = place(session, tap(3, 2));
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001", "n-0002", "n-0003"]);

    session = undo(session);
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
    session = undo(session);
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001"]);
    session = undo(session);
    expect(chartOf(session).notes).toHaveLength(0);
    expect(canUndoSession(session)).toBe(false);
  });

  it("redoes several edits in the order they were made", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 1));
    session = place(session, tap(3, 2));
    session = undo(undo(undo(session)));

    session = redo(session);
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001"]);
    session = redo(session);
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
    session = redo(session);
    expect(chartOf(session).notes.map((n) => n.id)).toEqual(["n-0001", "n-0002", "n-0003"]);
    expect(canRedoSession(session)).toBe(false);
  });

  it("does not record a command that was rejected", () => {
    const session = place(fresh(), tap(1, 0));
    expect(() => place(session, { timeSec: 1, lane: 99, type: "tap" })).toThrow(ChartError);
    // The failed placement left no step to undo past.
    expect(chartOf(undo(session)).notes).toHaveLength(0);
    expect(canUndoSession(undo(session))).toBe(false);
  });

  it("does not record a selection or a snap change", () => {
    let session = place(fresh(), tap(1, 0));
    session = select(session, null);
    session = selectEvent(session, "ev-000123");
    session = setSnap(session, { enabled: false, division: 4 });
    session = setSnapMode(session, "off");

    // One undo still reaches the empty chart: none of the above was an authoring edit.
    expect(chartOf(undo(session)).notes).toHaveLength(0);
  });
});

describe("redo branching", () => {
  it("discards the redo branch once a new edit is made", () => {
    let session = place(fresh(), tap(1, 0));       // A
    session = place(session, tap(2, 1));           // B
    session = undo(session);                       // B is undoable again
    expect(canRedoSession(session)).toBe(true);

    session = place(session, tap(3, 2));           // C, from where A stood
    expect(canRedoSession(session)).toBe(false);
    expect(chartOf(session).notes.map((n) => n.timeSec)).toEqual([1, 3]);
  });

  it("cannot resurrect a discarded branch by undoing again", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 1));
    session = place(undo(session), tap(3, 2));

    session = undo(session);                       // back to just A
    expect(chartOf(session).notes.map((n) => n.timeSec)).toEqual([1]);
    // Redo offers C, the edit that replaced B - never B itself.
    expect(chartOf(redo(session)).notes.map((n) => n.timeSec)).toEqual([1, 3]);
  });
});

describe("undo and note ids", () => {
  it("restores the same note id on redo, rather than minting a new one", () => {
    const placed = place(fresh(), tap(1, 0));
    expect(chartOf(placed).notes[0]!.id).toBe("n-0001");
    expect(chartOf(redo(undo(placed))).notes[0]!.id).toBe("n-0001");
  });

  it("does not hand out an id again after it has been undone away", () => {
    // n-0001 exists only in a branch the author walked away from. Reusing the number
    // would make two different notes share an identity across the session.
    let session = place(fresh(), tap(1, 0));
    session = place(undo(session), tap(5, 2));
    expect(chartOf(session).notes[0]!.id).toBe("n-0002");
  });

  it("keeps allocating forwards through repeated undo and re-edit", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(undo(session), tap(2, 0));
    session = place(undo(session), tap(3, 0));
    expect(chartOf(session).notes[0]!.id).toBe("n-0003");
    expect(chartOf(session).notes).toHaveLength(1);
  });

  it("still never reissues the id of a note that was deleted outright", () => {
    let session = place(fresh(), tap(1, 0));
    session = remove(session, "n-0001");
    session = place(session, tap(2, 0));
    expect(chartOf(session).notes[0]!.id).toBe("n-0002");
  });

  it("allocates deterministically: the same sequence of commands gives the same ids", () => {
    const run = () => {
      let s = place(fresh(), tap(1, 0));
      s = place(s, tap(2, 1));
      s = undo(s);
      s = place(s, tap(3, 2));
      return chartOf(s).notes.map((n) => n.id);
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual(["n-0001", "n-0003"]);
  });
});

describe("undo and provenance", () => {
  it("restores an event-placed note whole", () => {
    const placed = placeAtEvent(fresh(), EVENT, 3, "flick", "up");
    const original = chartOf(placed).notes[0]!;
    const again = redo(undo(placed));

    expect(chartOf(again).notes[0]).toEqual(original);
    expect(chartOf(again).notes[0]).toMatchObject({
      id: "n-0001",
      type: "flick",
      direction: "up",
      lane: 3,
      timeSec: EVENT.startSec,
      sourceEventId: "ev-000123",
    });
  });

  it("survives serialisation after an undo and redo", () => {
    const session = redo(undo(placeAtEvent(fresh(), EVENT, 2, "tap")));
    const notes = serializeChart(chartOf(session))["notes"] as Record<string, unknown>[];
    expect(notes[0]!["sourceEventId"]).toBe("ev-000123");
    expect(notes[0]!["timeSec"]).toBe(EVENT.startSec);
  });
});

describe("undo and the dirty state", () => {
  it("reports clean again once undo reaches the loaded state", () => {
    const session = place(fresh(), tap(1, 0));
    expect(isChartDirty(session)).toBe(true);
    expect(isChartDirty(undo(session))).toBe(false);
    expect(isDirty(undo(session))).toBe(false);
  });

  it("reports dirty again on redo", () => {
    const session = place(fresh(), tap(1, 0));
    expect(isChartDirty(redo(undo(session)))).toBe(true);
  });

  it("makes the saved state the new clean baseline", () => {
    let session = markSaved(place(fresh(), tap(1, 0)));
    expect(isChartDirty(session)).toBe(false);

    session = place(session, tap(2, 1));
    expect(isChartDirty(session)).toBe(true);
    expect(isChartDirty(undo(session))).toBe(false);
  });

  it("goes dirty when undoing past a save", () => {
    // The file on disk still holds the note; memory no longer does, so there is
    // something to save.
    const saved = markSaved(place(fresh(), tap(1, 0)));
    const undone = undo(saved);
    expect(chartOf(undone).notes).toHaveLength(0);
    expect(isChartDirty(undone)).toBe(true);
  });

  it("goes clean again when redo returns to the saved state", () => {
    const saved = markSaved(place(fresh(), tap(1, 0)));
    expect(isChartDirty(redo(undo(saved)))).toBe(false);
  });

  it("keeps the history across a save", () => {
    // place A, place B, Save, place C, undo C, undo B - all still reachable.
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 1));
    session = markSaved(session);
    session = place(session, tap(3, 2));

    session = undo(session);
    expect(chartOf(session).notes.map((n) => n.timeSec)).toEqual([1, 2]);
    expect(isChartDirty(session)).toBe(false);

    session = undo(session);
    expect(chartOf(session).notes.map((n) => n.timeSec)).toEqual([1]);
    expect(isChartDirty(session)).toBe(true);
  });

  it("tracks the project separately from the chart", () => {
    let session = setSnap(fresh(), { enabled: false, division: 4 });
    session = place(session, tap(1, 0));
    expect(isDirty(session)).toBe(true);

    // Undo takes back the note but not the setting, so the session stays dirty.
    session = undo(session);
    expect(isChartDirty(session)).toBe(false);
    expect(session.projectDirty).toBe(true);
    expect(isDirty(session)).toBe(true);
  });

  it("keeps the chart baseline when the chart saved but the project did not", () => {
    let session = setSnap(fresh(), { enabled: false, division: 4 });
    session = place(session, tap(1, 0));

    const partial = markChartSaved(session);
    expect(isChartDirty(partial)).toBe(false);
    expect(partial.projectDirty).toBe(true);
    expect(isDirty(partial)).toBe(true);

    // The chart on disk holds the note, so undoing past it is a change again.
    expect(isChartDirty(undo(partial))).toBe(true);
  });
});

describe("undo and selection", () => {
  it("clears a selection whose note no longer exists", () => {
    const session = place(fresh(), tap(1, 0));
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
    expect(undo(session).selectedNoteIds).toEqual([]);
  });

  it("keeps a selection that survives the step", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 1));
    session = select(session, "n-0001");
    // Undoing the second placement leaves n-0001 in place, so it stays selected.
    expect(undo(session).selectedNoteIds).toEqual(["n-0001"]);
  });

  it("restores a selectable note on redo without re-selecting it", () => {
    const session = redo(undo(place(fresh(), tap(1, 0))));
    expect(chartOf(session).notes).toHaveLength(1);
    expect(session.selectedNoteIds).toEqual([]);
  });

  it("leaves the Analysis event selection alone", () => {
    let session = selectEvent(fresh(), "ev-000123");
    session = place(session, tap(1, 0));
    expect(undo(session).selectedEventId).toBe("ev-000123");
    expect(redo(undo(session)).selectedEventId).toBe("ev-000123");
  });

  it("does not leave Delete pointing at a note that was undone away", () => {
    const undone = undo(place(fresh(), tap(1, 0)));
    expect(undone.selectedNoteIds).toEqual([]);
    expect(chartOf(undone).notes).toHaveLength(0);
  });
});

describe("the session holds no audio or viewport state", () => {
  // Volume, mute, the note click, the playback rate, the scroll position and Follow are
  // all session UI concerns. None of them belongs to a document, so none may reach the
  // undo history or either dirty flag - and the way to guarantee that is for the session
  // not to carry them at all.
  const AUDIO_AND_VIEW_KEYS = [
    "volume", "muted", "hitSoundOn", "playbackRate",
    "startSec", "pixelsPerSecond", "scrollLeft", "followPlayhead", "playheadSec",
  ];

  it("has no field for any of them", () => {
    const session = place(fresh(), tap(1, 0));
    for (const key of AUDIO_AND_VIEW_KEYS) {
      expect(Object.keys(session)).not.toContain(key);
    }
  });

  it("carries only the chart, its history, the snap settings and the selections", () => {
    expect(Object.keys(fresh()).sort()).toEqual(
      [
        "history", "projectDirty", "selectedDecorationIds", "selectedEventId",
        "selectedNoteIds", "snap", "snapMode",
      ],
    );
  });

  it("keeps its history entries free of them too", () => {
    const session = place(place(fresh(), tap(1, 0)), tap(2, 1));
    for (const state of [...session.history.past, session.history.present]) {
      for (const key of AUDIO_AND_VIEW_KEYS) {
        expect(Object.keys(state)).not.toContain(key);
      }
    }
  });
});

describe("placement audition", () => {
  // The Editor plays a click when a note is created. The rule that keeps it honest is
  // that the sound follows a successful command: a rejected placement throws before
  // anything is created, so there is nothing to audition.
  it("has nothing to announce when a placement is rejected", () => {
    const session = fresh();
    expect(() => place(session, { timeSec: 1, lane: 99, type: "tap" })).toThrow(ChartError);
    expect(chartOf(session).notes).toHaveLength(0);
    expect(isChartDirty(session)).toBe(false);
  });

  it("creates exactly one note to announce for a placement that succeeded", () => {
    const before = chartOf(fresh()).notes.length;
    const after = chartOf(place(fresh(), tap(1, 0))).notes.length;
    expect(after - before).toBe(1);
  });

  it("creates one for a placement from an event too", () => {
    expect(chartOf(placeAtEvent(fresh(), EVENT, 2, "tap")).notes).toHaveLength(1);
  });

  it("creates nothing for selecting, undoing or redoing", () => {
    // None of these is an authoring command, so none of them has a note to announce.
    const placed = place(fresh(), tap(1, 0));
    expect(chartOf(select(placed, null)).notes).toHaveLength(1);
    expect(chartOf(selectEvent(placed, "ev-1")).notes).toHaveLength(1);
    expect(chartOf(undo(placed)).notes).toHaveLength(0);
    expect(chartOf(redo(undo(placed))).notes).toHaveLength(1);
  });
});

describe("authoring the new kinds", () => {
  const long = (timeSec: number, endTimeSec: number, lane = 0) =>
    ({ timeSec, lane, type: "hold" as const, endTimeSec });

  it("places a flick through the ordinary command", () => {
    const session = place(fresh(), {
      timeSec: 1, lane: 2, type: "flick", direction: "left",
    });
    expect(chartOf(session).notes[0]).toMatchObject({ type: "flick", lane: 2 });
    expect(isChartDirty(session)).toBe(true);
  });

  it("places a held note through the ordinary command", () => {
    const session = place(fresh(), long(1, 2.5, 3));
    expect(chartOf(session).notes[0]).toMatchObject({
      type: "hold", lane: 3, timeSec: 1, endTimeSec: 2.5,
    });
  });

  it("undoes and redoes a flick like any other edit", () => {
    const placed = place(fresh(), {
      timeSec: 1, lane: 2, type: "flick", direction: "left",
    });
    expect(chartOf(undo(placed)).notes).toHaveLength(0);
    // Redo restores the note that existed, not a fresh one with a new id.
    expect(chartOf(redo(undo(placed))).notes[0]).toEqual(chartOf(placed).notes[0]);
  });

  it("undoes and redoes a held note whole, end time included", () => {
    const placed = place(fresh(), long(1, 2.5, 3));
    const original = chartOf(placed).notes[0]!;
    expect(chartOf(undo(placed)).notes).toHaveLength(0);
    expect(chartOf(redo(undo(placed))).notes[0]).toEqual(original);
    expect(chartOf(redo(undo(placed))).notes[0]!.endTimeSec).toBe(2.5);
  });

  it("keeps a rejected zero-length hold out of the history", () => {
    const session = place(fresh(), tap(1, 0));
    expect(() => place(session, long(2, 2, 0))).toThrow(ChartError);
    // One undo still reaches the empty chart: the refusal recorded no step.
    expect(chartOf(undo(session)).notes).toHaveLength(0);
    expect(canUndoSession(undo(session))).toBe(false);
  });
});

describe("deleting the selected note", () => {
  it("removes it and clears the selection", () => {
    const placed = place(fresh(), tap(1, 0));
    expect(placed.selectedNoteIds).toEqual(["n-0001"]);

    const after = remove(placed, "n-0001");
    expect(chartOf(after).notes).toHaveLength(0);
    expect(after.selectedNoteIds).toEqual([]);
  });

  it("is undone by restoring the note exactly", () => {
    const placed = place(fresh(), {
      timeSec: 1, lane: 2, type: "flick", direction: "left",
    });
    const original = chartOf(placed).notes[0]!;
    const deleted = remove(placed, original.id);

    const restored = undo(deleted);
    expect(chartOf(restored).notes).toHaveLength(1);
    expect(chartOf(restored).notes[0]).toEqual(original);
  });

  it("is redone by deleting it again", () => {
    const placed = place(fresh(), tap(1, 0));
    const deleted = remove(placed, "n-0001");
    expect(chartOf(redo(undo(deleted))).notes).toHaveLength(0);
  });

  it("restores a held note whole when the deletion is undone", () => {
    const placed = place(fresh(), { timeSec: 1, lane: 3, type: "hold", endTimeSec: 2.5 });
    const original = chartOf(placed).notes[0]!;
    expect(chartOf(undo(remove(placed, original.id))).notes[0]).toEqual(original);
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(place(fresh(), tap(1, 0)));
    const deleted = remove(saved, "n-0001");
    expect(isChartDirty(deleted)).toBe(true);
    expect(deleted.projectDirty).toBe(false);
  });

  it("goes clean again when the deletion is undone back to what was saved", () => {
    const saved = markSaved(place(fresh(), tap(1, 0)));
    expect(isChartDirty(undo(remove(saved, "n-0001")))).toBe(false);
  });

  it("refuses an id that is not there rather than silently doing nothing", () => {
    expect(() => remove(place(fresh(), tap(1, 0)), "n-9999")).toThrow(/no note with id/);
  });

  it("leaves no stale selection for the inspector to read", () => {
    // Whatever deleted it - the key, the toolbar or the inspector button - they all run
    // this one command, so there is one answer to what happens to the selection.
    const deleted = remove(place(fresh(), tap(1, 0)), "n-0001");
    expect(deleted.selectedNoteIds).toEqual([]);
    expect(chartOf(deleted).notes.find((n) => n.id === "n-0001")).toBeUndefined();
  });
});

describe("multiple selection", () => {
  /** Four taps, ids n-0001 .. n-0004. */
  const four = () => {
    let session = fresh();
    for (let i = 0; i < 4; i += 1) session = place(session, tap(i + 1, i % 5));
    return session;
  };

  it("starts with nothing selected", () => {
    expect(fresh().selectedNoteIds).toEqual([]);
    expect(selectionCount(fresh())).toBe(0);
    expect(soleSelectedId(fresh())).toBeNull();
  });

  it("selects one note, replacing whatever was selected", () => {
    const session = select(select(four(), "n-0001"), "n-0003");
    expect(session.selectedNoteIds).toEqual(["n-0003"]);
    expect(soleSelectedId(session)).toBe("n-0003");
  });

  it("clears the selection with a null id", () => {
    expect(select(select(four(), "n-0001"), null).selectedNoteIds).toEqual([]);
    expect(clearSelection(selectMany(four(), ["n-0001", "n-0002"])).selectedNoteIds).toEqual([]);
  });

  it("replaces the selection outright, as a rubber band does", () => {
    const session = selectMany(select(four(), "n-0004"), ["n-0001", "n-0002"]);
    expect(session.selectedNoteIds).toEqual(["n-0001", "n-0002"]);
    expect(selectionCount(session)).toBe(2);
  });

  it("adds to the selection without losing what was there", () => {
    const session = addToSelection(select(four(), "n-0001"), ["n-0002", "n-0003"]);
    expect(session.selectedNoteIds).toEqual(["n-0001", "n-0002", "n-0003"]);
  });

  it("does not select the same note twice when adding", () => {
    const session = addToSelection(selectMany(four(), ["n-0001", "n-0002"]), ["n-0002", "n-0003"]);
    expect(session.selectedNoteIds).toEqual(["n-0001", "n-0002", "n-0003"]);
  });

  it("toggles one note in and out", () => {
    const one = toggleSelected(clearSelection(four()), "n-0002");
    expect(one.selectedNoteIds).toEqual(["n-0002"]);
    const two = toggleSelected(one, "n-0004");
    expect(two.selectedNoteIds).toEqual(["n-0002", "n-0004"]);
    expect(toggleSelected(two, "n-0002").selectedNoteIds).toEqual(["n-0004"]);
  });

  it("answers whether a given note is selected", () => {
    const session = selectMany(four(), ["n-0001", "n-0003"]);
    expect(isSelected(session, "n-0001")).toBe(true);
    expect(isSelected(session, "n-0002")).toBe(false);
  });

  it("has no single selected note when several are selected", () => {
    expect(soleSelectedId(selectMany(four(), ["n-0001", "n-0002"]))).toBeNull();
  });

  it("returns the same session when the selection does not change", () => {
    // Identity matters: the render path compares it, and a new array every pointer move
    // would redraw the notes canvas for nothing.
    const session = selectMany(four(), ["n-0001", "n-0002"]);
    expect(selectMany(session, ["n-0001", "n-0002"])).toBe(session);
    expect(addToSelection(session, ["n-0001"])).toBe(session);
    expect(addToSelection(session, [])).toBe(session);
    const cleared = clearSelection(session);
    expect(clearSelection(cleared)).toBe(cleared);
  });

  it("never writes the selection into either document", () => {
    const session = selectMany(four(), ["n-0001", "n-0002", "n-0003"]);
    const document = serializeChart(chartOf(session)) as Record<string, unknown>;
    expect(JSON.stringify(document)).not.toContain("selected");
    expect(isChartDirty(session)).toBe(isChartDirty(four()));
  });

  it("selecting dirties nothing", () => {
    const saved = markSaved(four());
    expect(isDirty(selectMany(saved, ["n-0001", "n-0002"]))).toBe(false);
  });
});

describe("deleting a selection", () => {
  const four = () => {
    let session = fresh();
    for (let i = 0; i < 4; i += 1) session = place(session, tap(i + 1, i % 5));
    return session;
  };

  it("deletes every selected note", () => {
    const session = removeSelected(selectMany(four(), ["n-0001", "n-0003"]));
    expect(chartOf(session).notes.map((note) => note.id)).toEqual(["n-0002", "n-0004"]);
  });

  it("clears the selection afterwards", () => {
    // Nothing is left to act on, and a selection naming deleted notes would be a lie the
    // next command would trip over.
    expect(removeSelected(selectMany(four(), ["n-0001", "n-0003"])).selectedNoteIds).toEqual([]);
  });

  it("is one step in the history however many notes it deleted", () => {
    const before = four();
    const after = removeSelected(selectMany(before, ["n-0001", "n-0002", "n-0003", "n-0004"]));
    expect(chartOf(after).notes).toEqual([]);

    const undone = undo(after);
    expect(chartOf(undone).notes.map((note) => note.id))
      .toEqual(["n-0001", "n-0002", "n-0003", "n-0004"]);
    // One press, everything back: the author made one decision, so undo reverses one.
    expect(chartOf(undone)).toEqual(chartOf(before));
  });

  it("restores the notes exactly, ids and all", () => {
    const before = chartOf(four()).notes;
    const restored = chartOf(undo(removeSelected(selectMany(four(), ["n-0002", "n-0004"]))));
    expect(restored.notes).toEqual(before);
  });

  it("redoes the whole batch in one step too", () => {
    const deleted = removeSelected(selectMany(four(), ["n-0001", "n-0002"]));
    expect(chartOf(redo(undo(deleted))).notes.map((note) => note.id))
      .toEqual(["n-0003", "n-0004"]);
  });

  it("does nothing at all when nothing is selected", () => {
    const session = clearSelection(four());
    expect(removeSelected(session)).toBe(session);
    expect(canUndoSession(removeSelected(fresh()))).toBe(false);
  });

  it("deletes a single selected note through the same command", () => {
    // The keyboard, the toolbar button and the inspector button all end up here; there
    // is no second delete anywhere with its own rules.
    const session = removeSelected(select(four(), "n-0002"));
    expect(chartOf(session).notes.map((note) => note.id)).toEqual(["n-0001", "n-0003", "n-0004"]);
  });

  it("drops undone notes from the selection", () => {
    const placed = place(selectMany(four(), ["n-0001"]), tap(9, 0));
    expect(placed.selectedNoteIds).toEqual(["n-0005"]);
    expect(undo(placed).selectedNoteIds).toEqual([]);
  });

  it("keeps the notes that survive an undo", () => {
    const session = undo(place(selectMany(four(), ["n-0001", "n-0002"]), tap(9, 0)));
    // The placement replaced the selection with the new note, which the undo removed.
    expect(session.selectedNoteIds).toEqual([]);
  });
});

const slidePoint = (timeSec: number, lane: number) =>
  ({ timeSec, lane, type: "slide" as const });

describe("moving the selection", () => {
  const placed = () => {
    let session = fresh();
    session = place(session, tap(1, 0));
    session = place(session, tap(2, 1));
    return selectMany(session, ["n-0001", "n-0002"]);
  };

  it("moves every selected note", () => {
    const session = moveSelected(placed(), 1, 1);
    expect(chartOf(session).notes.map((n) => [n.timeSec, n.lane]))
      .toEqual([[2, 1], [3, 2]]);
  });

  it("is one history step for the whole drag", () => {
    // The timeline previews a move without touching the chart, so this is the first and
    // only thing the history sees, however many pointer events the drag was made of.
    const before = placed();
    const after = moveSelected(before, 1, 1);
    expect(chartOf(undo(after))).toEqual(chartOf(before));
    expect(chartOf(redo(undo(after)))).toEqual(chartOf(after));
  });

  it("leaves the selection alone, so the notes stay grabbed", () => {
    expect(moveSelected(placed(), 1, 0).selectedNoteIds).toEqual(["n-0001", "n-0002"]);
  });

  it("does nothing when nothing is selected", () => {
    const session = clearSelection(placed());
    expect(moveSelected(session, 1, 1)).toBe(session);
  });

  it("records nothing when the move would change nothing", () => {
    const session = placed();
    expect(moveSelected(session, 0, 0)).toBe(session);
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(placed());
    const moved = moveSelected(saved, 1, 0);
    expect(isChartDirty(moved)).toBe(true);
    expect(moved.projectDirty).toBe(false);
  });
});

describe("resizing through the session", () => {
  const held = () => {
    const session = place(fresh(), { timeSec: 1, lane: 0, type: "hold", endTimeSec: 2 });
    return session;
  };

  it("changes only the end", () => {
    const note = chartOf(resize(held(), "n-0001", 4)).notes[0];
    expect(note?.timeSec).toBe(1);
    expect(note?.endTimeSec).toBe(4);
  });

  it("is one history step, so one undo restores the original length", () => {
    const before = held();
    const after = resize(before, "n-0001", 4);
    expect(chartOf(undo(after)).notes[0]?.endTimeSec).toBe(2);
    expect(chartOf(redo(undo(after))).notes[0]?.endTimeSec).toBe(4);
  });

  it("records nothing when the end does not move", () => {
    const session = held();
    expect(resize(session, "n-0001", 2)).toBe(session);
  });
});

describe("moving a held note's start through the session", () => {
  const held = () => place(fresh(), { timeSec: 1, lane: 0, type: "hold", endTimeSec: 4 });

  it("changes only the start", () => {
    const note = chartOf(resizeStart(held(), "n-0001", 2)).notes[0];
    expect(note?.timeSec).toBe(2);
    expect(note?.endTimeSec).toBe(4);
  });

  it("is one history step, so one undo restores both times", () => {
    const after = resizeStart(held(), "n-0001", 2);
    expect(chartOf(undo(after)).notes[0]?.timeSec).toBe(1);
    expect(chartOf(undo(after)).notes[0]?.endTimeSec).toBe(4);
    expect(chartOf(redo(undo(after))).notes[0]?.timeSec).toBe(2);
  });

  it("records nothing when the start does not move", () => {
    const session = held();
    expect(resizeStart(session, "n-0001", 1)).toBe(session);
  });

  it("is a separate step from a drag of the other grip", () => {
    // Two grips, two edits: undoing the second must leave the first standing.
    let session = resizeStart(held(), "n-0001", 2);
    session = resize(session, "n-0001", 5);
    const back = undo(session);
    expect(chartOf(back).notes[0]?.timeSec).toBe(2);
    expect(chartOf(back).notes[0]?.endTimeSec).toBe(4);
  });
});

describe("connecting slide points through the session", () => {
  const twoPoints = () => {
    let session = fresh();
    session = place(session, slidePoint(1, 0));
    session = place(session, slidePoint(2, 3));
    return selectMany(session, ["n-0001", "n-0002"]);
  };

  it("says when the selection can be connected", () => {
    expect(connectableSelection(twoPoints()).ok).toBe(true);
  });

  it("explains why it cannot, rather than just refusing", () => {
    expect(connectableSelection(fresh()).why).toMatch(/exactly two/);
    expect(connectableSelection(selectMany(twoPoints(), ["n-0001"])).why)
      .toMatch(/exactly two/);

    let mixed = place(fresh(), slidePoint(1, 0));
    mixed = place(mixed, tap(2, 1));
    // A slide point and a tap are not two of anything, so neither command applies.
    expect(connectableSelection(selectMany(mixed, ["n-0001", "n-0002"])).why)
      .toMatch(/not one of each/);

    let sameTime = place(fresh(), slidePoint(1, 0));
    sameTime = place(sameTime, slidePoint(1, 3));
    expect(connectableSelection(selectMany(sameTime, ["n-0001", "n-0002"])).why)
      .toMatch(/same time/);
  });

  it("joins them into one slide", () => {
    const session = connect(twoPoints());
    expect(chartOf(session).notes).toHaveLength(1);
    expect(chartOf(session).notes[0]).toMatchObject({
      timeSec: 1, lane: 0, endTimeSec: 2, endLane: 3,
    });
  });

  it("leaves the resulting slide selected, and nothing that has gone", () => {
    // A selection naming a note that no longer exists would arm Delete against nothing.
    const session = connect(twoPoints());
    expect(session.selectedNoteIds).toEqual(["n-0001"]);
  });

  it("is one history step, and undo gives back both points", () => {
    const before = twoPoints();
    const after = connect(before);
    const undone = undo(after);
    expect(chartOf(undone).notes).toHaveLength(2);
    expect(chartOf(undone)).toEqual(chartOf(before));
  });

  it("redoes the connection in one step", () => {
    const after = connect(twoPoints());
    expect(chartOf(redo(undo(after)))).toEqual(chartOf(after));
  });

  it("does nothing unless exactly two notes are selected", () => {
    const one = selectMany(twoPoints(), ["n-0001"]);
    expect(connect(one)).toBe(one);
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(twoPoints());
    const connected = connect(saved);
    expect(isChartDirty(connected)).toBe(true);
    expect(connected.projectDirty).toBe(false);
  });
});

describe("disconnecting through the session", () => {
  const connected = () => {
    let session = fresh();
    session = place(session, slidePoint(1, 0));
    session = place(session, slidePoint(2, 3));
    return connect(selectMany(session, ["n-0001", "n-0002"]));
  };

  it("gives back two points and selects both", () => {
    const session = disconnect(connected(), "n-0001");
    expect(chartOf(session).notes).toHaveLength(2);
    expect(session.selectedNoteIds).toHaveLength(2);
  });

  it("is one history step", () => {
    const before = connected();
    const after = disconnect(before, "n-0001");
    expect(chartOf(undo(after))).toEqual(chartOf(before));
  });

  it("takes two undos back to the two original points, connection and all", () => {
    const after = disconnect(connected(), "n-0001");
    const twiceUndone = undo(undo(after));
    expect(chartOf(twiceUndone).notes.map((n) => n.id)).toEqual(["n-0001", "n-0002"]);
    expect(chartOf(twiceUndone).notes.every((n) => n.endTimeSec === undefined)).toBe(true);
  });
});

describe("changing how a note ends, through the session", () => {
  const held = () =>
    place(fresh(), { timeSec: 1, lane: 0, type: "hold", endTimeSec: 3 });

  it("sets an end flick", () => {
    const session = changeEndAction(held(), "n-0001", { type: "flick", direction: "left" });
    expect(chartOf(session).notes[0]?.endAction)
      .toEqual({ type: "flick", direction: "left" });
  });

  it("is one history step, undoable and redoable", () => {
    const before = held();
    const after = changeEndAction(before, "n-0001", { type: "flick", direction: "right" });
    expect(chartOf(undo(after))).toEqual(chartOf(before));
    expect(chartOf(redo(undo(after)))).toEqual(chartOf(after));
  });

  it("walks Normal -> flick -> Normal in single steps", () => {
    let session = held();
    session = changeEndAction(session, "n-0001", { type: "flick", direction: "right" });
    session = changeEndAction(session, "n-0001", null);
    expect(chartOf(session).notes[0]?.endAction).toBeUndefined();
    expect(chartOf(undo(session)).notes[0]?.endAction)
      .toEqual({ type: "flick", direction: "right" });
  });

  it("records nothing when the end action does not change", () => {
    const session = changeEndAction(held(), "n-0001", { type: "flick", direction: "left" });
    expect(changeEndAction(session, "n-0001", { type: "flick", direction: "left" }))
      .toBe(session);
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(held());
    const changed = changeEndAction(saved, "n-0001", { type: "flick", direction: "left" });
    expect(isChartDirty(changed)).toBe(true);
    expect(changed.projectDirty).toBe(false);
  });

  it("leaves the selection alone", () => {
    const session = select(held(), "n-0001");
    expect(changeEndAction(session, "n-0001", { type: "flick", direction: "left" })
      .selectedNoteIds).toEqual(["n-0001"]);
  });
});

describe("turning a flick round, through the session", () => {
  const flick = () =>
    place(fresh(), { timeSec: 2, lane: 3, type: "flick", direction: "left" });

  it("changes the direction", () => {
    expect(chartOf(changeFlickDirection(flick(), "n-0001", "right")).notes[0]?.direction)
      .toBe("right");
  });

  it("is one history step, undoable and redoable", () => {
    const before = flick();
    const after = changeFlickDirection(before, "n-0001", "right");
    expect(chartOf(undo(after)).notes[0]?.direction).toBe("left");
    expect(chartOf(redo(undo(after))).notes[0]?.direction).toBe("right");
  });

  it("records nothing when the direction does not change", () => {
    const session = flick();
    expect(changeFlickDirection(session, "n-0001", "left")).toBe(session);
    expect(canUndoSession(changeFlickDirection(session, "n-0001", "left")))
      .toBe(canUndoSession(session));
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(flick());
    const turned = changeFlickDirection(saved, "n-0001", "right");
    expect(isChartDirty(turned)).toBe(true);
    expect(turned.projectDirty).toBe(false);
  });

  it("leaves the selection alone", () => {
    const session = select(flick(), "n-0001");
    expect(changeFlickDirection(session, "n-0001", "right").selectedNoteIds)
      .toEqual(["n-0001"]);
  });
});

describe("runs of flicks, through the session", () => {
  const flicks = () => {
    let session = fresh();
    const spec = [
      [10.0, 0, "right"], [10.25, 1, "right"], [10.5, 3, "left"],
    ] as const;
    for (const [timeSec, lane, direction] of spec) {
      session = place(session, { timeSec, lane, type: "flick", direction });
    }
    return session;
  };

  it("says two flicks can be joined into a run", () => {
    const session = selectMany(flicks(), ["n-0001", "n-0002"]);
    expect(connectableSelection(session)).toMatchObject({ ok: true, kind: "run" });
  });

  it("refuses to join a flick to a slide point", () => {
    let session = flicks();
    session = place(session, { timeSec: 12, lane: 0, type: "slide" });
    expect(connectableSelection(selectMany(session, ["n-0001", "n-0004"])))
      .toMatchObject({ ok: false, kind: null });
  });

  it("joins them with the one Connect command", () => {
    const session = connect(selectMany(flicks(), ["n-0001", "n-0002"]));
    expect(chartOf(session).connections).toHaveLength(1);
    expect(chartOf(session).notes).toHaveLength(3);
  });

  it("selects the whole run afterwards", () => {
    const session = connectFlickRun(selectMany(flicks(), ["n-0001", "n-0002"]));
    expect(session.selectedNoteIds).toEqual(["n-0001", "n-0002"]);
  });

  it("is one history step however many links it added", () => {
    const before = selectMany(flicks(), ["n-0001", "n-0002"]);
    const two = connectFlickRun(before);
    const three = connectFlickRun(selectMany(two, ["n-0001", "n-0003"]));
    expect(chartOf(three).connections).toHaveLength(2);
    // One undo per Connect, not one per link.
    expect(chartOf(undo(three)).connections).toHaveLength(1);
    expect(chartOf(undo(undo(three))).connections).toHaveLength(0);
    expect(chartOf(redo(undo(three))).connections).toHaveLength(2);
  });

  it("takes a run apart in one step", () => {
    let session = connectFlickRun(selectMany(flicks(), ["n-0001", "n-0002"]));
    session = connectFlickRun(selectMany(session, ["n-0001", "n-0003"]));
    const split = disconnectFlickRun(session, "n-0002");
    expect(chartOf(split).connections).toEqual([]);
    expect(chartOf(undo(split)).connections).toHaveLength(2);
  });

  it("knows when the selection is a run that could be taken apart", () => {
    const session = connectFlickRun(selectMany(flicks(), ["n-0001", "n-0002"]));
    expect(disconnectableRun(session)).toBe("n-0001");
    expect(disconnectableRun(selectMany(session, ["n-0003"]))).toBeNull();
    expect(disconnectableRun(clearSelection(session))).toBeNull();
  });

  it("turns one flick of a run round without disturbing the run", () => {
    let session = connectFlickRun(selectMany(flicks(), ["n-0001", "n-0002"]));
    session = connectFlickRun(selectMany(session, ["n-0001", "n-0003"]));
    const before = chartOf(session).connections;
    const turned = changeFlickDirection(session, "n-0002", "left");
    expect(chartOf(turned).notes.map((n) => n.direction))
      .toEqual(["right", "left", "left"]);
    expect(chartOf(turned).connections).toEqual(before);
    expect(chartOf(undo(turned)).notes[1]?.direction).toBe("right");
  });

  it("dirties the chart and not the project", () => {
    const saved = markSaved(selectMany(flicks(), ["n-0001", "n-0002"]));
    const joined = connectFlickRun(saved);
    expect(isChartDirty(joined)).toBe(true);
    expect(joined.projectDirty).toBe(false);
  });

  it("drops the links of notes deleted from a run", () => {
    let session = connectFlickRun(selectMany(flicks(), ["n-0001", "n-0002"]));
    session = connectFlickRun(selectMany(session, ["n-0001", "n-0003"]));
    const after = removeSelected(selectMany(session, ["n-0002"]));
    expect(chartOf(after).connections).toEqual([]);
    expect(chartOf(after).notes).toHaveLength(2);
  });
});
