/**
 * The judgement engine.
 *
 * Nothing here draws, listens to a key, or knows what an AudioContext is. It is fed a
 * clock and a stream of input events, and it answers with judgements - which is what
 * makes the same chart, the same inputs and the same times produce the same result every
 * run, and what lets autoplay be tested against exactly the same code the player's own
 * fingers go through.
 *
 *     chart points  ----+
 *     audio clock   ----+---->  judge  ---->  judgements  ---->  scoreboard / display
 *     input events  ----+
 *
 * The engine judges **points**, not notes: a slide is judged at each of its waypoints and
 * a held note at both of its ends, so a note may produce several judgements. See
 * `judgePointsOf` in chart.js for where the points come from.
 *
 * Two invariants are worth stating because the rest of the file exists to keep them:
 *
 *   - **One input consumes at most one point.** A press in a lane picks the single
 *     closest pending point it is allowed to satisfy. A chord is several presses.
 *   - **Every point ends up judged exactly once.** Points that were never hit are missed
 *     when their window closes, so `hits + misses === points.length` at the end of a
 *     song, and the result screen adds up.
 */

/**
 * Judgement windows, in seconds either side of the point's time.
 *
 * There is no window in the Chart contract - the schema says when a note is, not how
 * forgiving the game is about it - so these are the Player's own, stated here rather
 * than buried in the engine so they can be tuned in one place. They are in the region a
 * Deresute-like game uses, and are deliberately a little generous: this Player exists to
 * verify a chart, and a window so tight that a good chart feels broken would hide the
 * thing it is meant to reveal.
 */
export const DEFAULT_WINDOWS = Object.freeze({
  perfect: 0.06,
  great: 0.11,
  good: 0.16,
});

export const RESULTS = ["perfect", "great", "good", "miss"];

/** Order used when a result has to be capped: `cap('perfect', 'good') === 'good'`. */
const RESULT_RANK = { perfect: 0, great: 1, good: 2, miss: 3 };

export function capResult(result, limit) {
  return RESULT_RANK[result] >= RESULT_RANK[limit] ? result : limit;
}

/** Which result a timing error earns, or null when it is outside every window. */
export function resultFor(deltaSec, windows = DEFAULT_WINDOWS) {
  const error = Math.abs(deltaSec);
  if (error <= windows.perfect) return "perfect";
  if (error <= windows.great) return "great";
  if (error <= windows.good) return "good";
  return null;
}

/** Point kinds a plain press may satisfy. A release is not one of them. */
const PRESSABLE = new Set(["tap", "hold-start", "waypoint", "flick", "flick-end"]);
/** Point kinds a swipe may satisfy. */
const SWIPEABLE = new Set(["flick", "flick-end"]);

/**
 * Whether two directions count as the same swipe.
 *
 * A point with no direction accepts any swipe - the chart asked for a flick and did not
 * say which way. An event with no direction is a press that the input layer could not
 * give a direction to, which is the ordinary keyboard case, and is accepted for the same
 * reason: refusing it would make flicks unplayable on a keyboard, which is the one input
 * this Player is certain to have.
 */
export function directionsAgree(pointDirection, eventDirection) {
  if (!pointDirection || !eventDirection) return true;
  return pointDirection === eventDirection;
}

export const DEFAULT_CONFIG = Object.freeze({
  windows: DEFAULT_WINDOWS,
  /**
   * Whether a swipe the wrong way may satisfy a flick at all.
   *
   * Off by default: the wrong direction still hits, capped at Good, and is reported so
   * the author can see it. On, it does not hit and the flick is missed. Off is the right
   * default for a Player used to check a chart on a keyboard; on is the honest one for
   * checking that the flicks read correctly.
   */
  strictFlickDirection: false,
});

function emptyStats() {
  return { perfect: 0, great: 0, good: 0, miss: 0, judged: 0, combo: 0, maxCombo: 0 };
}

/**
 * Build an engine for one chart.
 *
 * The chart is read once; everything after that is state that `reset` puts back, so a
 * restart or a seek is not a rebuild.
 */
export function createJudge(chart, config = {}) {
  const settings = { ...DEFAULT_CONFIG, ...config, windows: { ...DEFAULT_WINDOWS, ...(config.windows ?? {}) } };
  const points = chart.points;

  /** Points of one note, in order, so a broken note can retire the rest of itself. */
  const pointsByNote = new Map();
  for (const point of points) {
    const list = pointsByNote.get(point.noteId);
    if (list) list.push(point);
    else pointsByNote.set(point.noteId, [point]);
  }

  const status = new Map();
  const noteState = new Map();
  /** How many presses are currently down in each lane. Two fingers in a lane is two. */
  const laneDepth = new Array(chart.laneCount).fill(0);
  let stats = emptyStats();
  let cursor = 0;
  let nowSec = 0;

  function reset(atSec = 0) {
    status.clear();
    for (const point of points) status.set(point.id, { state: "pending", result: null, deltaSec: 0 });
    noteState.clear();
    for (const note of chart.notes) {
      noteState.set(note.id, { holding: false, dead: false, currentLane: note.lane });
    }
    laneDepth.fill(0);
    stats = emptyStats();
    nowSec = atSec;
    cursor = 0;
    // Everything already behind the playhead is simply not part of this run. It is not
    // missed - nobody was asked to play it - so it is retired silently and left out of
    // the totals.
    //
    // The boundary is the playhead itself and not the playhead less a judgement window,
    // deliberately: a run from `atSec` contains exactly the points at or after `atSec`,
    // which is the same rule autoplay's cursor uses. When the two disagreed by a window's
    // width, seeking left a handful of notes that nothing would ever press and that were
    // then counted as missed.
    for (let i = 0; i < points.length; i += 1) {
      if (points[i].timeSec < atSec) {
        status.get(points[i].id).state = "skipped";
        cursor = i + 1;
      } else break;
    }

    // A note whose beginning is behind the playhead goes with it, all of it. Starting
    // halfway through a fourteen-second slide would otherwise leave fifty waypoints that
    // nobody can reach, because the press that would have been travelling between them
    // was never made - and they would all be counted as missed, which would blame the
    // chart for where the author chose to start listening.
    for (const list of pointsByNote.values()) {
      if (list.length === 0) continue;
      if (status.get(list[0].id).state !== "skipped") continue;
      for (const point of list) status.get(point.id).state = "skipped";
    }
  }

  function totalJudgeable() {
    let total = 0;
    for (const point of points) if (status.get(point.id).state !== "skipped") total += 1;
    return total;
  }

  function record(point, result, deltaSec, extra = {}) {
    const entry = status.get(point.id);
    entry.state = result === "miss" ? "missed" : "hit";
    entry.result = result;
    entry.deltaSec = deltaSec;

    stats[result] += 1;
    stats.judged += 1;
    if (result === "miss") {
      stats.combo = 0;
    } else {
      stats.combo += 1;
      if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;
    }

    return {
      pointId: point.id,
      noteId: point.noteId,
      kind: point.kind,
      lane: point.lane,
      isFirst: point.isFirst,
      isLast: point.isLast,
      result,
      deltaSec,
      timeSec: point.timeSec,
      combo: stats.combo,
      wrongDirection: extra.wrongDirection === true,
      auto: extra.auto === true,
    };
  }

  /**
   * Retire what is left of a note after it has gone wrong.
   *
   * A held note whose start was missed, or which was let go halfway, is over: its
   * remaining points are missed rather than left open for a stray press to pick up
   * later. They are counted, because a dropped four-point slide really did cost the
   * player four things, and a result screen that hid three of them would be lying about
   * how badly it went.
   */
  function killNote(noteId, out, fromIndex = -1) {
    const note = noteState.get(noteId);
    if (note) {
      note.dead = true;
      note.holding = false;
    }
    for (const point of pointsByNote.get(noteId) ?? []) {
      if (point.index <= fromIndex) continue;
      const entry = status.get(point.id);
      if (entry.state === "pending") out.push(record(point, "miss", 0, { auto: true }));
    }
  }

  /** The pending point an event in this lane is closest to, or null. */
  function bestCandidate(lane, timeSec, allowed) {
    const reach = settings.windows.good;
    let best = null;
    let bestError = Infinity;
    for (let i = cursor; i < points.length; i += 1) {
      const point = points[i];
      if (point.timeSec > timeSec + reach) break;
      if (point.lane !== lane) continue;
      if (!allowed.has(point.kind)) continue;
      if (status.get(point.id).state !== "pending") continue;
      if (noteState.get(point.noteId)?.dead) continue;
      // A point in the middle or at the end of a held note only becomes available once
      // the note is actually being held. Otherwise a press could pick up the far end of
      // a hold whose start is still coming.
      if (!point.isFirst && !noteState.get(point.noteId)?.holding) continue;
      const error = Math.abs(timeSec - point.timeSec);
      if (error > reach) continue;
      if (error < bestError - 1e-9) {
        best = point;
        bestError = error;
      }
    }
    return best;
  }

  function judgeHit(point, timeSec, eventDirection, out, extra = {}) {
    const deltaSec = timeSec - point.timeSec;
    let result = resultFor(deltaSec, settings.windows);
    if (result === null) return false;

    let wrongDirection = false;
    if (point.direction && eventDirection && point.direction !== eventDirection) {
      wrongDirection = true;
      result = capResult(result, "good");
    }

    const note = noteState.get(point.noteId);
    if (note) {
      note.currentLane = point.lane;
      if (point.kind === "hold-start") note.holding = true;
      if (point.isLast) note.holding = false;
    }
    out.push(record(point, result, deltaSec, { wrongDirection, ...extra }));
    return true;
  }

  /**
   * Settle everything the player has already held their way through, up to a moment.
   *
   * A slide's waypoint in the lane the finger is already in, and the end of a note held
   * to its finish, are not pressed - reaching them *is* playing them - so something has
   * to notice that they have come due. That used to happen only on the clock, which was
   * wrong in a way that took a real chart to show: a slide with two waypoints twenty
   * milliseconds apart in the same lane, followed by one in another lane four
   * milliseconds later, lost the middle ones whenever a frame happened to span all
   * three. By the time the clock next ran, the finger had already moved to the new lane,
   * and a waypoint in the old one no longer looked reached - although it had been.
   *
   * So this runs before an input is applied as well as on the clock, using the state as
   * it was at the moment being settled rather than the state after the next press. The
   * result no longer depends on where the frame boundaries happened to fall.
   */
  function resolveHeldThrough(uptoSec, out) {
    const late = settings.windows.good;
    for (let i = cursor; i < points.length; i += 1) {
      const point = points[i];
      if (point.timeSec > uptoSec) break;
      if (status.get(point.id).state !== "pending") continue;
      const note = noteState.get(point.noteId);
      if (!note || !note.holding || note.dead) continue;
      if (point.kind === "waypoint" && note.currentLane === point.lane) {
        judgeHit(point, Math.min(uptoSec, point.timeSec + late), null, out, { auto: true });
      } else if (point.kind === "release") {
        // Held all the way to the end. The chart asked for the note to last this long and
        // it did; the exact instant of letting go afterwards is not something a chart can
        // be verified against, so it is not judged on it.
        judgeHit(point, point.timeSec, null, out, { auto: true });
      }
    }
  }

  /**
   * An input event.
   *
   * `kind` is `down`, `up` or `flick`; `timeSec` is chart time, which the input layer
   * stamps rather than the engine reading a clock, so a keypress is judged against when
   * it happened and not against when the frame got round to it.
   */
  function input(event) {
    const out = [];
    const lane = event.lane;
    if (!Number.isInteger(lane) || lane < 0 || lane >= chart.laneCount) return out;
    const timeSec = Number.isFinite(event.timeSec) ? event.timeSec : nowSec;

    // Bring the held-through judgements up to the moment of this event first, so that a
    // press which moves the finger elsewhere cannot retroactively unreach a point the
    // finger had already reached.
    resolveHeldThrough(timeSec, out);

    if (event.kind === "down") {
      laneDepth[lane] += 1;
      const point = bestCandidate(lane, timeSec, PRESSABLE);
      if (point) {
        if (settings.strictFlickDirection && SWIPEABLE.has(point.kind) && !directionsAgree(point.direction, event.direction)) {
          // Strict mode: a press that is not the swipe the chart asked for does nothing,
          // and the flick will be missed when its window closes.
          return out;
        }
        judgeHit(point, timeSec, event.direction ?? null, out);
      }
      return out;
    }

    if (event.kind === "flick") {
      const point = bestCandidate(lane, timeSec, SWIPEABLE);
      if (point) {
        if (settings.strictFlickDirection && !directionsAgree(point.direction, event.direction)) return out;
        judgeHit(point, timeSec, event.direction ?? null, out);
      }
      return out;
    }

    if (event.kind === "up") {
      laneDepth[lane] = Math.max(0, laneDepth[lane] - 1);
      if (laneDepth[lane] > 0) return out;
      // With nothing left pressed in this lane, any note being held there has been let
      // go. Whether that was the release the chart asked for depends on where its next
      // point is.
      for (const [noteId, note] of noteState) {
        if (!note.holding || note.currentLane !== lane) continue;
        const pending = (pointsByNote.get(noteId) ?? []).find((p) => status.get(p.id).state === "pending");
        if (!pending) {
          note.holding = false;
          continue;
        }
        if (pending.kind === "release" && resultFor(timeSec - pending.timeSec, settings.windows) !== null) {
          judgeHit(pending, timeSec, null, out);
          continue;
        }
        // Let go too early, or let go where a swipe was asked for. Either way the rest
        // of the note is gone.
        killNote(noteId, out, pending.index - 1);
      }
      return out;
    }

    return out;
  }

  /**
   * Advance the clock.
   *
   * Two things happen here: what the player is holding through is settled up to now, and
   * anything whose window has closed without being played is missed. Both are driven by
   * chart time, so they behave identically at any playback speed and at any frame rate.
   */
  function update(chartTimeSec) {
    const out = [];
    if (!Number.isFinite(chartTimeSec)) return out;
    if (chartTimeSec < nowSec) {
      // Time never runs backwards during play; a seek calls reset() instead.
      nowSec = chartTimeSec;
      return out;
    }
    nowSec = chartTimeSec;
    resolveHeldThrough(chartTimeSec, out);

    const late = settings.windows.good;
    for (let i = cursor; i < points.length; i += 1) {
      const point = points[i];
      // Points are in time order, so the first one still inside its window ends the scan.
      if (point.timeSec + late >= chartTimeSec) break;
      if (status.get(point.id).state !== "pending") continue;

      out.push(record(point, "miss", 0, { auto: true }));
      const note = noteState.get(point.noteId);
      if (!point.isLast && (point.kind === "hold-start" || point.kind === "waypoint")) {
        killNote(point.noteId, out, point.index);
      }
      if (note) note.holding = false;
    }
    // Move the cursor past everything settled, so the next frame starts where this one
    // stopped rather than at the beginning of the song.
    while (cursor < points.length && status.get(points[cursor].id).state !== "pending") cursor += 1;
    return out;
  }

  reset(0);

  return {
    settings,
    input,
    update,
    reset,
    get stats() {
      return { ...stats };
    },
    get laneDepth() {
      return [...laneDepth];
    },
    statusOf: (pointId) => status.get(pointId),
    noteStateOf: (noteId) => noteState.get(noteId),
    totalJudgeable,
    /** True once every point has been settled: the song is over as far as play goes. */
    isComplete: () => cursor >= points.length,
  };
}
