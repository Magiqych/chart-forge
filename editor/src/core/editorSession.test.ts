import { describe, expect, it } from "vitest";

import { emptyChart, projectChart, ChartError } from "./chart";
import { serializeChart } from "./chart";
import {
  isDirty, markChartSaved, markSaveFailed, markSaved, openSession,
  place, placeAtEvent, remove, select, selectAt, selectEvent, setSnap, setSnapMode,
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
    expect(session.chartDirty).toBe(false);
    expect(session.projectDirty).toBe(false);
    expect(isDirty(session)).toBe(false);
    expect(session.selectedNoteId).toBeNull();
  });

  it("a chart created for a project that had none is also clean", () => {
    // Nothing has been authored yet, so there is nothing to lose and Save is not urged.
    expect(isDirty(fresh())).toBe(false);
  });

  it("placing a note dirties the chart and not the project", () => {
    const session = place(fresh(), tap(1, 0));
    expect(session.chartDirty).toBe(true);
    expect(session.projectDirty).toBe(false);
    expect(isDirty(session)).toBe(true);
  });

  it("deleting a note dirties the chart and not the project", () => {
    const saved = markSaved(place(fresh(), tap(1, 0)));
    expect(isDirty(saved)).toBe(false);

    const after = remove(saved, "n-0001");
    expect(after.chartDirty).toBe(true);
    expect(after.projectDirty).toBe(false);
  });

  it("turning snapping off dirties the project and not the chart", () => {
    // Snapping decides where a future note lands; it changes nothing already placed.
    const session = setSnap(fresh(), { enabled: false, division: 1 });
    expect(session.projectDirty).toBe(true);
    expect(session.chartDirty).toBe(false);
    expect(isDirty(session)).toBe(true);
  });

  it("changing the snap division dirties the project and not the chart", () => {
    const session = setSnap(fresh(), { enabled: true, division: 4 });
    expect(session.projectDirty).toBe(true);
    expect(session.chartDirty).toBe(false);
    expect(session.chart.notes).toHaveLength(0);
  });

  it("setting the same snap values again changes nothing", () => {
    const session = fresh();
    expect(setSnap(session, { ...DEFAULT_SNAP })).toBe(session);
    expect(isDirty(setSnap(session, { ...DEFAULT_SNAP }))).toBe(false);
  });

  it("editing both documents leaves the session dirty overall", () => {
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 8 });
    expect(session.chartDirty).toBe(true);
    expect(session.projectDirty).toBe(true);
    expect(isDirty(session)).toBe(true);
  });

  it("a successful save clears both", () => {
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 2 });

    const saved = markSaved(session);
    expect(saved.chartDirty).toBe(false);
    expect(saved.projectDirty).toBe(false);
    expect(isDirty(saved)).toBe(false);
    expect(saved.chart.notes).toHaveLength(1);
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
    expect(after.chartDirty).toBe(true);
    expect(after.projectDirty).toBe(true);
    expect(after.chart.notes).toHaveLength(1);
  });

  it("a chart that saved before the project failed reports exactly that", () => {
    // The chart is written first, so this is the only partial outcome the save order
    // can produce: the notes are on disk, the project is not yet up to date.
    let session = place(fresh(), tap(1, 0));
    session = setSnap(session, { enabled: false, division: 4 });

    const after = markChartSaved(session);
    expect(after.chartDirty).toBe(false);
    expect(after.projectDirty).toBe(true);
    expect(isDirty(after)).toBe(true);
    expect(after.chart.notes).toHaveLength(1);
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
    expect(session.chart.notes).toHaveLength(0);
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
    expect(place(fresh(), tap(1, 0)).selectedNoteId).toBe("n-0001");
  });

  it("deleting the selected note clears the selection", () => {
    const session = place(fresh(), tap(1, 0));
    expect(remove(session, "n-0001").selectedNoteId).toBeNull();
  });

  it("deleting a different note keeps the selection", () => {
    let session = place(fresh(), tap(1, 0));
    session = place(session, tap(2, 0));
    expect(session.selectedNoteId).toBe("n-0002");
    expect(remove(session, "n-0001").selectedNoteId).toBe("n-0002");
  });

  it("selectAt picks the note under the pointer, or clears when there is none", () => {
    const session = place(fresh(), tap(1, 2));
    const hit = selectAt(session, 1.01, 2, 0.05);
    expect(hit.hit?.id).toBe("n-0001");
    expect(hit.session.selectedNoteId).toBe("n-0001");

    const miss = selectAt(hit.session, 5, 2, 0.05);
    expect(miss.hit).toBeNull();
    expect(miss.session.selectedNoteId).toBeNull();
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

    expect(first.chart.notes).toHaveLength(0);
    expect(second.chart.notes).toHaveLength(1);
    expect(third.chart.notes).toHaveLength(0);
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
    expect(session.chart.notes).toHaveLength(1);
    expect(session.chart.notes[0]!.timeSec).toBe(EVENT.startSec);
  });

  it("records the event as provenance", () => {
    const note = placeAtEvent(fresh(), EVENT, 2, "tap").chart.notes[0]!;
    expect(note.sourceEventId).toBe("ev-000123");
  });

  it("uses the lane the author chose", () => {
    for (const lane of [0, 1, 2, 3, 4]) {
      expect(placeAtEvent(fresh(), EVENT, lane, "tap").chart.notes[0]!.lane).toBe(lane);
    }
  });

  it("takes nothing from the event but its start and its id", () => {
    // The command's signature is the guarantee: an event's stem, pitch, type and
    // duration are not parameters, so none of them can decide a lane or a note type.
    // A vocals-derived event placed into lane 0 as a flick makes the point.
    const session = placeAtEvent(fresh(), EVENT, 0, "flick", "up");
    expect(session.chart.notes[0]).toMatchObject({
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
    expect(session.chart.notes[0]!.timeSec).toBe(EVENT.startSec);
  });

  it("allows several notes from one event", () => {
    // A chord or a roll built from one observed onset is ordinary authoring, so the
    // relationship is not 1:1 and a repeated sourceEventId is not an error.
    let session = placeAtEvent(fresh(), EVENT, 0, "tap");
    session = placeAtEvent(session, EVENT, 2, "tap");
    session = placeAtEvent(session, EVENT, 4, "tap");

    expect(session.chart.notes).toHaveLength(3);
    expect(session.chart.notes.map((n) => n.sourceEventId))
      .toEqual(["ev-000123", "ev-000123", "ev-000123"]);
    expect(session.chart.notes.map((n) => n.lane)).toEqual([0, 2, 4]);
    expect(new Set(session.chart.notes.map((n) => n.id)).size).toBe(3);
  });

  it("keeps the event selected so another note can follow", () => {
    const session = placeAtEvent(selectEvent(fresh(), "ev-000123"), EVENT, 0, "tap");
    expect(session.selectedEventId).toBe("ev-000123");
    expect(session.selectedNoteId).toBe("n-0001");
  });

  it("survives serialisation, which is how it reaches disk and comes back", () => {
    const session = placeAtEvent(fresh(), EVENT, 2, "tap");
    const notes = serializeChart(session.chart)["notes"] as Record<string, unknown>[];
    expect(notes[0]!["sourceEventId"]).toBe("ev-000123");
    expect(notes[0]!["timeSec"]).toBe(EVENT.startSec);

    const reloaded = projectChart(serializeChart(session.chart));
    expect(reloaded.notes[0]!.sourceEventId).toBe("ev-000123");
  });
});

describe("ordinary manual placement", () => {
  it("records no sourceEventId, because no event was consulted", () => {
    const note = place(fresh(), tap(1, 0)).chart.notes[0]!;
    expect(note.sourceEventId).toBeUndefined();
  });

  it("omits the field entirely from the written document", () => {
    const session = place(fresh(), tap(1, 0));
    const notes = serializeChart(session.chart)["notes"] as Record<string, unknown>[];
    expect(Object.keys(notes[0]!)).not.toContain("sourceEventId");
  });

  it("sits alongside event-placed notes in one chart", () => {
    let session = place(fresh(), tap(1, 0));
    session = placeAtEvent(session, EVENT, 1, "tap");
    const sources = session.chart.notes.map((n) => n.sourceEventId);
    expect(sources).toEqual([undefined, "ev-000123"]);
  });
});

describe("Analysis event selection", () => {
  it("dirties neither document", () => {
    // Looking at read-only guidance is not editing.
    const session = selectEvent(fresh(), "ev-000123");
    expect(session.chartDirty).toBe(false);
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
    expect(session.selectedNoteId).toBe("n-0001");
    expect(session.selectedEventId).toBe("ev-000123");

    session = select(session, null);
    expect(session.selectedEventId).toBe("ev-000123");
    expect(session.selectedNoteId).toBeNull();
  });

  it("re-selecting the same event returns the identical session", () => {
    const session = selectEvent(fresh(), "ev-000123");
    expect(selectEvent(session, "ev-000123")).toBe(session);
  });

  it("placing from an event dirties the chart, not the project", () => {
    const session = placeAtEvent(selectEvent(fresh(), "ev-000123"), EVENT, 0, "tap");
    expect(session.chartDirty).toBe(true);
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

  it("switching between off and event changes nothing the project stores", () => {
    // Event snapping has nowhere to live in the contract's snap object, so it is not a
    // stored setting and choosing it does not ask for a save.
    const off = openSession(blank(), { enabled: false, division: 1 });
    const event = setSnapMode(off, "event");
    expect(event.snapMode).toBe("event");
    expect(event.snap.enabled).toBe(false);
    expect(event.projectDirty).toBe(false);
  });

  it("keeps the chosen division while snapping is off", () => {
    let session = setSnap(fresh(), { enabled: true, division: 4 });
    session = setSnapMode(session, "off");
    expect(session.snap.division).toBe(4);
    expect(setSnapMode(session, "beat").snap.division).toBe(4);
  });

  it("reloads event mode as off, because the contract cannot record it", () => {
    const session = setSnapMode(fresh(), "event");
    const written = { snap: { enabled: session.snap.enabled, division: session.snap.division } };
    expect(openSession(blank(), readSnapSettings(written)).snapMode).toBe("off");
  });

  it("setting the same mode again returns the identical session", () => {
    const session = fresh();
    expect(setSnapMode(session, session.snapMode)).toBe(session);
  });
});
