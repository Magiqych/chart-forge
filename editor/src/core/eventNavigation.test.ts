import { describe, expect, it } from "vitest";

import type { LaneId, ProjectedEvent } from "./analysis";
import {
  eventStep, navigableEvents, navigationReferenceSec, EVENT_EPSILON_SEC,
} from "./eventNavigation";

const event = (
  id: string,
  startSec: number,
  lane: LaneId | null,
): ProjectedEvent => ({
  id,
  type: "onset",
  startSec,
  endKind: "instantaneous",
  detectorId: "det",
  stemId: `stem-${lane ?? "none"}`,
  lane,
});

const ALL: ReadonlySet<LaneId> = new Set(["drums", "other", "bass", "vocals"]);

const events = [
  event("ev-1", 1.0, "drums"),
  event("ev-2", 2.0, "bass"),
  event("ev-3", 3.0, "drums"),
  event("ev-4", 4.0, "vocals"),
];

describe("which events the keyboard can visit", () => {
  it("includes every event in a visible lane", () => {
    expect(navigableEvents(events, ALL).map((e) => e.id))
      .toEqual(["ev-1", "ev-2", "ev-3", "ev-4"]);
  });

  it("excludes events in a lane that is switched off", () => {
    // Turning Bass off turns the overlay into a filter for reading, which is the point.
    const withoutBass: ReadonlySet<LaneId> = new Set(["drums", "other", "vocals"]);
    expect(navigableEvents(events, withoutBass).map((e) => e.id))
      .toEqual(["ev-1", "ev-3", "ev-4"]);
  });

  it("excludes everything when every lane is off", () => {
    expect(navigableEvents(events, new Set())).toEqual([]);
  });

  it("excludes an event that belongs to no lane", () => {
    // Nothing draws it, so nothing should jump to it.
    const orphan = [...events, event("ev-x", 2.5, null)];
    expect(navigableEvents(orphan, ALL).map((e) => e.id)).not.toContain("ev-x");
  });

  it("never includes a Chart Note, because it only ever sees events", () => {
    // The types make this true rather than the code checking for it: an Analysis Event
    // and a Chart Note are different concepts, and this function is typed to the former.
    // What the test can hold down is that nothing is added beyond the events given.
    const ids = new Set(events.map((e) => e.id));
    for (const found of navigableEvents(events, ALL)) {
      expect(ids.has(found.id)).toBe(true);
    }
  });

  it("orders by time", () => {
    const jumbled = [events[3]!, events[1]!, events[0]!, events[2]!];
    expect(navigableEvents(jumbled, ALL).map((e) => e.startSec)).toEqual([1, 2, 3, 4]);
  });

  it("breaks a tie the same way every time", () => {
    // Several detectors can fire on one instant. Without the tie-break the order would
    // depend on how the projection happened to be built, and the same key press could do
    // different things on different runs.
    const together = [
      event("ev-c", 5, "vocals"),
      event("ev-a", 5, "drums"),
      event("ev-b", 5, "drums"),
    ];
    const once = navigableEvents(together, ALL).map((e) => e.id);
    const again = navigableEvents([...together].reverse(), ALL).map((e) => e.id);
    expect(once).toEqual(again);
    expect(once).toEqual(["ev-a", "ev-b", "ev-c"]);
  });
});

describe("stepping to the next or previous event", () => {
  const ordered = navigableEvents(events, ALL);

  it("goes to the next event after a time", () => {
    expect(eventStep(ordered, 0, 1)?.id).toBe("ev-1");
    expect(eventStep(ordered, 1.5, 1)?.id).toBe("ev-2");
    expect(eventStep(ordered, 3.9, 1)?.id).toBe("ev-4");
  });

  it("goes to the previous event before a time", () => {
    expect(eventStep(ordered, 5, -1)?.id).toBe("ev-4");
    expect(eventStep(ordered, 3.5, -1)?.id).toBe("ev-3");
    expect(eventStep(ordered, 1.5, -1)?.id).toBe("ev-1");
  });

  it("does not find the event it is standing on", () => {
    // Without the epsilon a press would keep finding the current event, and the keys
    // would appear to do nothing.
    expect(eventStep(ordered, 2.0, 1)?.id).toBe("ev-3");
    expect(eventStep(ordered, 2.0, -1)?.id).toBe("ev-1");
  });

  it("ignores a difference smaller than the epsilon", () => {
    expect(eventStep(ordered, 2.0 + EVENT_EPSILON_SEC / 2, 1)?.id).toBe("ev-3");
    expect(eventStep(ordered, 2.0 - EVENT_EPSILON_SEC / 2, -1)?.id).toBe("ev-1");
  });

  it("walks the whole list one press at a time", () => {
    let at = 0;
    const visited: string[] = [];
    for (;;) {
      const next = eventStep(ordered, at, 1);
      if (!next) break;
      visited.push(next.id);
      at = next.startSec;
    }
    expect(visited).toEqual(["ev-1", "ev-2", "ev-3", "ev-4"]);
  });

  it("walks back again", () => {
    let at = 5;
    const visited: string[] = [];
    for (;;) {
      const previous = eventStep(ordered, at, -1);
      if (!previous) break;
      visited.push(previous.id);
      at = previous.startSec;
    }
    expect(visited).toEqual(["ev-4", "ev-3", "ev-2", "ev-1"]);
  });

  it("stops at the last event", () => {
    expect(eventStep(ordered, 4.0, 1)).toBeNull();
    expect(eventStep(ordered, 100, 1)).toBeNull();
  });

  it("stops at the first event", () => {
    expect(eventStep(ordered, 1.0, -1)).toBeNull();
    expect(eventStep(ordered, -5, -1)).toBeNull();
  });

  it("does nothing at all when there are no events", () => {
    expect(eventStep([], 1, 1)).toBeNull();
    expect(eventStep([], 1, -1)).toBeNull();
  });

  it("skips a hidden lane rather than stopping on it", () => {
    const visible = navigableEvents(events, new Set(["drums"]));
    expect(eventStep(visible, 1.0, 1)?.id).toBe("ev-3");
  });
});

describe("what a step is measured from", () => {
  it("uses the selected event when there is one", () => {
    // So a run of presses walks the list rather than sticking wherever the playhead
    // happened to round to.
    expect(navigationReferenceSec(events[1]!, 99)).toBe(2.0);
  });

  it("uses the playhead when nothing is selected", () => {
    expect(navigationReferenceSec(null, 12.5)).toBe(12.5);
  });

  it("makes repeated presses advance, not oscillate", () => {
    const ordered = navigableEvents(events, ALL);
    let selected: ProjectedEvent | null = null;
    const visited: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = eventStep(ordered, navigationReferenceSec(selected, 0), 1);
      if (!next) break;
      selected = next;
      visited.push(next.id);
    }
    expect(visited).toEqual(["ev-1", "ev-2", "ev-3", "ev-4"]);
  });
});
