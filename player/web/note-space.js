/**
 * The space notes fly through, and the projection that puts it on a screen.
 *
 * A note does not slide down a flat screen from one pixel to another. It travels through
 * a small three-dimensional world - a lane position across, a depth into the picture, a
 * height above the playfield - and what is drawn is that world seen through a pinhole.
 * That is what makes a note grow as it comes, makes the five lanes fan out as they
 * approach, and gives the flight the gentle curve a flat interpolation cannot have.
 *
 * Two rules hold everything here together, and nothing in this file may break either:
 *
 * **Position is a function of time and nothing else.** There is no velocity carried
 * between frames, no `position += velocity * dt`, no state at all. Every coordinate is
 * evaluated from one number - the phase of the flight - which is itself computed from the
 * audio clock. A dropped frame, a seek, a pause, a change of playback rate and a machine
 * running at 30 Hz instead of 144 all land a note in exactly the same place, because the
 * same audio time always produces the same answer.
 *
 * **Nothing here decides when a note is hit.** The chart's `timeSec` is the truth about
 * that, and the judge reads it directly. This module only answers "where do I draw it",
 * so no amount of tuning the geometry can move a judgement window.
 *
 * Pure arithmetic, no canvas and no DOM: the renderer asks these functions where things
 * are, and the tests ask them the same questions without a browser.
 */

/**
 * The world the notes travel through.
 *
 * The model is the one the author's earlier proof of concept used, and the two equations
 * are the whole of the physics:
 *
 *     depth(p)  = spawnDepth  + (tapDepth  - spawnDepth)  * p        constant velocity
 *     height(p) = spawnHeight + (tapHeight - spawnHeight) * p²       from a standstill
 *
 * `p` is the phase of the flight, 0 as the note appears and 1 as it reaches the tap line.
 * The depth closes at a constant rate; the height falls from rest under a constant
 * acceleration, which is the `0.5 * a * t²` of the original written in terms of phase -
 * solving `height(1) = tapHeight` for the acceleration is what turns one into the other.
 *
 * The numbers are not pixels and are not tied to any screen size. Only their ratios
 * matter, because the projection is normalised onto whatever viewport it is given. They
 * were chosen by plotting the resulting curve rather than by taste:
 *
 *   - `tapDepth / spawnDepth` is the size a note is born at - here 0.45 of its final
 *     size, growing without a break to exactly 1 at the tap line.
 *   - `spawnHeight` above `cameraHeight` is what makes a note drift very slightly *up*
 *     for the first tenth of its flight before it starts to fall. It is a couple of
 *     pixels on a 1080p screen: felt rather than seen, which is what it is for. Raising
 *     `spawnHeight` deepens it, and the two are in direct tension - every pixel of lift
 *     is paid for by pulling more of the flight into the top of the screen, where notes
 *     a quarter of a second apart start to overlap. These values sit where a stream of
 *     sixteenths still reads as separate notes.
 *
 * A word about that trade, because it is the one real tension in this file. The flight is
 * deliberately back-loaded: a note covers about a tenth of its screen distance in the
 * first half of its time and rushes the rest. That is the look this is chasing. Pushed
 * further it becomes unreadable - notes pile up in a band a few pixels tall near the
 * horizon - and this Player exists to *read* charts, so the parameters sit at the gentler
 * end of the family rather than at the most dramatic one.
 */
export const WORLD = Object.freeze({
  /** Depth at which a note appears. Larger is further away, so smaller and higher up. */
  spawnDepth: 880,
  /** Depth of the tap line. Every note is exactly here at the moment it is judged. */
  tapDepth: 400,
  /** Height a note is born at, above the playfield floor. */
  spawnHeight: 360,
  /** Height at the tap line: the note has arrived, so it is on the floor. */
  tapHeight: 0,
  /** Eye height. Below `spawnHeight`, which is what gives the flight its initial lift. */
  cameraHeight: 260,
  /**
   * How far past the tap line a moment is still evaluated, in phase.
   *
   * A missed note keeps being drawn for a moment as it goes by. The clamp exists because
   * the depth closes linearly and would eventually reach the eye, where the projection
   * divides by zero; stopping short of that keeps every number finite.
   */
  maxOvershoot: 0.35,
});

/** Depth of the flight at a phase. Linear: the note closes at a constant rate. */
export function depthAtPhase(phase) {
  const p = clampPhase(phase);
  return WORLD.spawnDepth + (WORLD.tapDepth - WORLD.spawnDepth) * p;
}

/**
 * Height of the flight at a phase.
 *
 * Quadratic, from rest, and held flat outside the flight at both ends. Past the tap line
 * the note has landed, and letting the curve carry on downwards would fling it off the
 * bottom of the screen in a frame or two rather than letting it pass the line and fade.
 * Before the spawn line it has not set off yet - and because the curve is `p²` it is
 * symmetric about zero, so an unclamped negative phase would have a note *descending* as
 * it got further away, which is the opposite of what it should do.
 */
export function heightAtPhase(phase) {
  const p = Math.min(1, Math.max(0, clampPhase(phase)));
  return WORLD.spawnHeight + (WORLD.tapHeight - WORLD.spawnHeight) * p * p;
}

/** Keep a phase inside the range where the projection is defined. */
export function clampPhase(phase) {
  if (!Number.isFinite(phase)) return 0;
  return Math.min(1 + WORLD.maxOvershoot, phase);
}

/**
 * How far along its flight a moment is: 0 as it appears, 1 at the tap line.
 *
 * This is the only place time enters the geometry, and it is a subtraction on the audio
 * clock. Everything that makes the Player frame-rate independent, seek correctly, stop
 * when paused and stay in step at 0.25× speed follows from this one line being a function
 * of `chartTimeSec` rather than of anything that accumulates.
 *
 * Values above 1 are moments already past, which the renderer still draws briefly.
 */
export function flightPhase(timeSec, chartTimeSec, approachSec) {
  if (!(approachSec > 0)) return 1;
  return 1 - (timeSec - chartTimeSec) / approachSec;
}

// The projection is normalised so that the spawn depth lands on the top of the playfield
// and the tap depth exactly on the tap line, whatever the viewport is. These two are the
// ends of that normalisation and depend only on the constants above.
const RATIO_SPAWN = (WORLD.cameraHeight - WORLD.spawnHeight) / WORLD.spawnDepth;
const RATIO_TAP = (WORLD.cameraHeight - WORLD.tapHeight) / WORLD.tapDepth;
const RATIO_SPAN = RATIO_TAP - RATIO_SPAWN;

/**
 * The perspective projection, as a pure function of phase.
 *
 * A pinhole: everything is divided by the depth. `scale` is the size of a thing at this
 * depth relative to its size at the tap line, so it is exactly 1 at the moment of
 * judgement - which is what lets a note and its tap target be drawn at the same size and
 * the same place at the same instant. `yNorm` is the height of the eye ray, normalised to
 * 0 at the spawn line and 1 at the tap line.
 *
 * `yNorm` may go slightly below 0 early in the flight. That is the lift, and it is meant:
 * it is not an error to clamp away.
 *
 * The horizontal and vertical scales are normalised separately onto the viewport, so this
 * is not a single-focal-length camera - it is the same depth seen through two focal
 * lengths. Every rhythm game does this, because a strict pinhole would make the playfield's
 * shape a consequence of the window's aspect ratio rather than a thing that can be chosen.
 */
export function projectionOf(phase) {
  const depth = depthAtPhase(phase);
  const height = heightAtPhase(phase);
  const ratio = (WORLD.cameraHeight - height) / depth;
  return {
    scale: WORLD.tapDepth / depth,
    yNorm: (ratio - RATIO_SPAWN) / RATIO_SPAN,
  };
}

/**
 * The fixed geometry of the playfield for a given canvas size.
 *
 * Everything is a fraction of the canvas, so the same playfield appears on a phone and on
 * a 4K monitor with nothing hard-coded. `nearWidth` is also capped against the height, so
 * that a very wide window does not stretch the lanes into a letterbox.
 *
 * `tapRadius` is the radius of one of the five tap targets, and is the unit the notes are
 * sized in as well: a note at the tap line is drawn against a circle of exactly this size.
 */
export function playfieldGeometry(width, height, laneCount) {
  const lanes = Math.max(1, laneCount);
  const judgeY = height * 0.84;
  const topY = height * 0.13;
  const nearWidth = Math.min(width * 0.94, height * 1.75);
  const laneWidth = nearWidth / lanes;
  return {
    width,
    height,
    laneCount: lanes,
    centreX: width / 2,
    judgeY,
    topY,
    nearWidth,
    laneWidth,
    /**
     * Radius of a tap target, and the reference size for a note at the tap line.
     *
     * Two limits, whichever bites first: a share of the lane, so the five circles never
     * grow into each other however few lanes a chart has, and a share of the height, so a
     * very wide window does not end up with five dinner plates along the bottom of it.
     */
    tapRadius: Math.min(laneWidth * 0.3, height * 0.075),
  };
}

/** The x of a lane's centre at the tap line, where the perspective scale is 1. */
export function laneCentreX(geometry, lane) {
  const left = geometry.centreX - geometry.nearWidth / 2;
  return left + (lane + 0.5) * geometry.laneWidth;
}

/**
 * Where a moment in a lane is drawn.
 *
 * The world x of a lane is a fixed offset from the middle of the playfield, so dividing it
 * by the depth - which is what multiplying by `scale` does - is the same perspective the
 * size and the height go through. The lanes therefore converge towards the spawn line and
 * fan out towards the tap line, without that being drawn as a special case anywhere.
 *
 * `lane` may be fractional: a point between two lanes is a point between two world
 * positions, which is how a slide crossing the playfield is placed.
 *
 * The world spacing between two lanes is not a separate constant: it is `laneWidth`, the
 * distance between two lane centres at the tap line, which is where the scale is 1 and
 * world units and pixels therefore coincide. One number rather than two that have to be
 * kept agreeing with each other.
 */
export function positionOf(geometry, lane, phase) {
  const { scale, yNorm } = projectionOf(phase);
  const nearX = laneCentreX(geometry, lane);
  return {
    x: geometry.centreX + (nearX - geometry.centreX) * scale,
    y: geometry.topY + yNorm * (geometry.judgeY - geometry.topY),
    scale,
  };
}

/** Where a point *between* two lanes is drawn - the body of a slide between waypoints. */
export function positionBetween(geometry, laneA, laneB, mix, phase) {
  return positionOf(geometry, laneA + (laneB - laneA) * mix, phase);
}

/**
 * The radius of a note at a depth.
 *
 * One multiplication, but it is the thing that makes the flight read: a note has to be
 * visibly smaller when it is far away and exactly the size of its tap target when it
 * arrives, and both of those fall out of `scale` being 1 at the tap line.
 */
export function noteRadiusAt(geometry, scale, sizeFactor = 1) {
  return geometry.tapRadius * sizeFactor * Math.max(0, scale);
}

/** Half the width of a hold or slide ribbon at a depth, in pixels. */
export function ribbonHalfWidth(geometry, scale, widthFactor) {
  return (geometry.laneWidth * widthFactor * Math.max(0, scale)) / 2;
}

/**
 * How much of a stretch of chart time is on screen right now.
 *
 * Both ends are cut, and each for its own reason.
 *
 * The **near** end is the playhead itself, not a little before it: the part of a long note
 * that is already behind the tap line has been played, and drawing it would leave a ribbon
 * hanging below the tap targets for something the player has finished doing.
 *
 * The **far** end is the spawn line exactly - the same moment the note's own head would
 * appear. A hold whose end is eight seconds away has not arrived yet in any sense that the
 * playfield should be showing, and drawing it further back than the geometry is defined for
 * puts it behind the vanishing point, where a greater depth reads as *lower* on the screen
 * and the band hooks back on itself. So the visible ribbon grows out of the spawn line and
 * the renderer fades that edge out.
 *
 * Returns null when none of the stretch is visible, which is the common case for all but a
 * handful of notes in any given frame.
 */
export function clipFlightSpan(fromSec, toSec, chartTimeSec, approachSec) {
  const start = Math.max(fromSec, chartTimeSec);
  const end = Math.min(toSec, chartTimeSec + approachSec);
  return end <= start ? null : { startSec: start, endSec: end };
}

/** The longest a single sampled ribbon step may span, in chart seconds. */
const RIBBON_STEP_SEC = 0.05;
const RIBBON_MAX_STEPS = 28;

/**
 * A hold or slide body, sampled along its flight and projected.
 *
 * The projection is not linear in time, so a straight quadrilateral drawn between two
 * waypoints would leave the lanes it is supposed to travel along - it would cut the corner
 * of its own curve. Sampling the path at several points and projecting each one puts the
 * ribbon where the notes themselves will be, which is the only way the two can agree.
 *
 * `points` are the note's own judgement points, `{timeSec, lane}`, in order. The result is
 * one entry per consecutive pair that is visible, each carrying the projected centre line;
 * the renderer turns those into a filled band, and the tests check them as numbers.
 *
 * Every sample carries the chart time it was taken at, so a test can assert that the end
 * of a ribbon really is the note's end time projected - not the head's position stretched
 * to reach.
 */
export function sampleRibbon(geometry, points, chartTimeSec, approachSec) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (!(to.timeSec > from.timeSec)) continue;
    const span = clipFlightSpan(from.timeSec, to.timeSec, chartTimeSec, approachSec);
    if (!span) continue;

    const steps = Math.min(
      RIBBON_MAX_STEPS,
      Math.max(2, Math.ceil((span.endSec - span.startSec) / RIBBON_STEP_SEC)),
    );
    const samples = [];
    for (let step = 0; step <= steps; step += 1) {
      const timeSec = span.startSec + ((span.endSec - span.startSec) * step) / steps;
      const mix = (timeSec - from.timeSec) / (to.timeSec - from.timeSec);
      const lane = from.lane + (to.lane - from.lane) * mix;
      const position = positionOf(geometry, lane, flightPhase(timeSec, chartTimeSec, approachSec));
      samples.push({ timeSec, lane, ...position });
    }
    segments.push({
      fromIndex: i,
      startSec: span.startSec,
      endSec: span.endSec,
      /** True when this leg runs on past the spawn line and its far edge is a cut. */
      clippedFar: span.endSec < to.timeSec - 1e-9,
      samples,
    });
  }
  return segments;
}
