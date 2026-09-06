import { describe, expect, it } from "vitest";

import { emptyChart, placeNote, type ChartState } from "./chart";
import {
  baseForCommand, canRedo, canUndo, isChartDirty, markSaved, openHistory,
  record, redo, undo, MAX_HISTORY,
} from "./chartHistory";

const blank = (): ChartState => emptyChart({ audioPath: "song.wav" });
const withNote = (state: ChartState, timeSec: number): ChartState =>
  placeNote(state, { timeSec, lane: 0, type: "tap" }).state;

describe("openHistory", () => {
  it("starts at the given state, with nothing either side and nothing to save", () => {
    const chart = blank();
    const history = openHistory(chart);
    expect(history.present).toBe(chart);
    expect(history.past).toEqual([]);
    expect(history.future).toEqual([]);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(isChartDirty(history)).toBe(false);
  });
});

describe("record", () => {
  it("moves the present into the past", () => {
    const first = blank();
    const second = withNote(first, 1);
    const history = record(openHistory(first), second);

    expect(history.present).toBe(second);
    expect(history.past).toEqual([first]);
    expect(canUndo(history)).toBe(true);
  });

  it("ignores a command that produced the same state", () => {
    // A rejected or no-op command should not put a step between the author and their
    // last real edit.
    const history = openHistory(blank());
    expect(record(history, history.present)).toBe(history);
  });

  it("discards the redo branch", () => {
    const first = blank();
    let history = record(openHistory(first), withNote(first, 1));
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = record(history, withNote(history.present, 5));
    expect(canRedo(history)).toBe(false);
    expect(history.future).toEqual([]);
  });

  it("raises the id high-water mark and never lowers it", () => {
    const first = blank();
    const second = withNote(first, 1);
    let history = record(openHistory(first), second);
    expect(history.issuedIdSeq).toBe(second.nextIdSeq);

    history = undo(history);
    expect(history.present.nextIdSeq).toBe(first.nextIdSeq);
    expect(history.issuedIdSeq).toBe(second.nextIdSeq);
  });

  it("keeps the past bounded", () => {
    let history = openHistory(blank());
    for (let i = 0; i < MAX_HISTORY + 25; i += 1) {
      history = record(history, withNote(history.present, i + 1));
    }
    expect(history.past).toHaveLength(MAX_HISTORY);
    // The oldest states fall off the front; the newest are what an author needs.
    expect(history.present.notes).toHaveLength(MAX_HISTORY + 25);
  });
});

describe("baseForCommand", () => {
  it("is the present state when nothing has been undone", () => {
    const history = openHistory(blank());
    expect(baseForCommand(history)).toBe(history.present);
  });

  it("carries the id counter forward past an undone allocation", () => {
    const first = blank();
    const history = undo(record(openHistory(first), withNote(first, 1)));
    // The present has rewound to nextIdSeq 1, but 1 was already handed out.
    expect(history.present.nextIdSeq).toBe(1);
    expect(baseForCommand(history).nextIdSeq).toBe(2);
    // Everything else about the state is untouched.
    expect(baseForCommand(history).notes).toBe(history.present.notes);
  });
});

describe("undo and redo", () => {
  it("do nothing at the ends", () => {
    const history = openHistory(blank());
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it("move the same state objects back and forth", () => {
    const first = blank();
    const second = withNote(first, 1);
    const history = record(openHistory(first), second);

    const back = undo(history);
    expect(back.present).toBe(first);
    expect(redo(back).present).toBe(second);
  });
});

describe("saved baseline", () => {
  it("is an identity comparison, so undoing to the saved state reports clean", () => {
    const first = blank();
    let history = record(openHistory(first), withNote(first, 1));
    history = markSaved(history);
    expect(isChartDirty(history)).toBe(false);

    history = record(history, withNote(history.present, 2));
    expect(isChartDirty(history)).toBe(true);
    expect(isChartDirty(undo(history))).toBe(false);
  });

  it("leaves the history alone, so a save is not a barrier", () => {
    const first = blank();
    const history = markSaved(record(openHistory(first), withNote(first, 1)));
    expect(canUndo(history)).toBe(true);
    expect(undo(history).present).toBe(first);
    expect(isChartDirty(undo(history))).toBe(true);
  });

  it("returns the same history when the present is already the saved state", () => {
    const history = openHistory(blank());
    expect(markSaved(history)).toBe(history);
  });
});
