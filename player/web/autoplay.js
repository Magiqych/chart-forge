/**
 * Autoplay: a perfect player, made of ordinary input events.
 *
 * The point of autoplay here is not a demo. It is the way an author checks that a whole
 * chart is playable at all - that every slide connects, every flick points somewhere,
 * every long note ends where it should - without having to play it perfectly by hand
 * first. For that to prove anything, autoplay has to go through exactly the same
 * judgement path a person does, so this module produces nothing but the same
 * `{kind, lane, direction, timeSec}` events the keyboard produces. If autoplay does not
 * get a full combo, the chart, the judge or this schedule is wrong - and any of those is
 * worth knowing.
 *
 * Events are stamped with the moment they were *due*, not the frame they were dispatched
 * on, so autoplay is unaffected by frame rate and scores the same at any playback speed.
 */

import { judgePointsOf } from "./chart.js";

/**
 * Build the whole schedule of presses for a chart.
 *
 * Walking one note at a time is what makes the finger's path sensible: a slide presses
 * its next lane before letting go of the one behind it, so the note is never momentarily
 * unheld, and a held note's press stays down until its end.
 */
export function buildAutoplayEvents(chart) {
  const events = [];
  let sequence = 0;
  const push = (event) => events.push({ ...event, sequence: sequence++ });

  for (const note of chart.notes) {
    const points = judgePointsOf(note);
    if (points.length === 0) continue;
    let held = null;

    points.forEach((point) => {
      if (point.isFirst) {
        if (point.kind === "flick") {
          push({ kind: "flick", lane: point.lane, direction: point.direction, timeSec: point.timeSec });
          return;
        }
        push({ kind: "down", lane: point.lane, timeSec: point.timeSec });
        if (point.kind === "hold-start") held = point.lane;
        else push({ kind: "up", lane: point.lane, timeSec: point.timeSec });
        return;
      }

      if (point.kind === "waypoint") {
        // Only when the slide actually changes lane. A waypoint in the lane already
        // being held needs no press: holding through it is what the chart asked for, and
        // the judge resolves it as the clock passes.
        if (held !== null && point.lane !== held) {
          push({ kind: "down", lane: point.lane, timeSec: point.timeSec });
          push({ kind: "up", lane: held, timeSec: point.timeSec });
          held = point.lane;
        }
        return;
      }

      if (point.kind === "flick-end") {
        push({ kind: "flick", lane: point.lane, direction: point.direction, timeSec: point.timeSec });
        if (held !== null) push({ kind: "up", lane: held, timeSec: point.timeSec });
        held = null;
        return;
      }

      if (point.kind === "release") {
        if (held !== null) push({ kind: "up", lane: held, timeSec: point.timeSec });
        held = null;
      }
    });

    // A note whose points ran out while still held - a shape this Player has not met -
    // still has to let go, or the lane stays pressed for the rest of the song.
    if (held !== null) {
      const last = points[points.length - 1];
      push({ kind: "up", lane: held, timeSec: last.timeSec });
    }
  }

  events.sort((a, b) => (a.timeSec !== b.timeSec ? a.timeSec - b.timeSec : a.sequence - b.sequence));
  return events;
}

/**
 * A cursor over that schedule.
 *
 * `emitUntil` must be called before the judge's own `update` for the frame, so that a
 * press that was due inside the frame is judged before the point it belongs to is
 * considered late.
 */
export function createAutoplay(chart) {
  const events = buildAutoplayEvents(chart);
  let cursor = 0;

  return {
    events,
    reset(atSec = 0) {
      cursor = 0;
      while (cursor < events.length && events[cursor].timeSec < atSec) cursor += 1;
    },
    emitUntil(chartTimeSec, dispatch) {
      let fired = 0;
      while (cursor < events.length && events[cursor].timeSec <= chartTimeSec) {
        const event = events[cursor];
        cursor += 1;
        dispatch({
          kind: event.kind,
          lane: event.lane,
          ...(event.direction ? { direction: event.direction } : {}),
          timeSec: event.timeSec,
          source: "autoplay",
        });
        fired += 1;
      }
      return fired;
    },
    isDone: () => cursor >= events.length,
  };
}
