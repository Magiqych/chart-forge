/**
 * Drawing the notes, the bands between them, and the targets they land on.
 *
 * Everything in this file is drawn from three things: a geometry, a chart time, and the
 * theme. It holds no state between frames and asks the clock nothing - it is handed the
 * moment to draw and draws it - which is what lets a seek, a pause and a 200 ms frame all
 * produce a correct picture without any of them being a special case.
 *
 * The split from `render.js` is deliberate. That file owns the order things are painted in
 * and the background they are painted on; this one owns what a note *is*. Adding a fifth
 * kind of note should be a style in `note-theme.js` and a mark here, and nothing at all in
 * the frame loop.
 *
 * Every shape is built from arcs, gradients and strokes written out as numbers. No image
 * is loaded, and none of it is derived from any existing game's artwork.
 */

import { noteKind, notePoints } from "./chart.js";
import {
  positionOf,
  flightPhase,
  noteRadiusAt,
  ribbonHalfWidth,
  sampleRibbon,
} from "./note-space.js";
import { SIZES, TAP_AREA, NOTE_STYLES, FLICK_VARIANTS, RIBBONS, CONNECTION } from "./note-theme.js";

const TAU = Math.PI * 2;

/** How far past the tap line a note is still drawn, and how fast it fades out there. */
const FADE_OUT_PHASE = 1.25;
const FADE_RATE = 4;
/** A little before the spawn line, so nothing appears with a visible pop. */
const FADE_IN_PHASE = -0.04;

const ARROW_ANGLES = {
  left: Math.PI,
  right: 0,
  up: -Math.PI / 2,
  down: Math.PI / 2,
  upLeft: (-3 * Math.PI) / 4,
  upRight: -Math.PI / 4,
  downLeft: (3 * Math.PI) / 4,
  downRight: Math.PI / 4,
};

// ---------------------------------------------------------------------------
// The tap targets
// ---------------------------------------------------------------------------

/**
 * The five circles at the bottom of the screen, and the line that threads them.
 *
 * Their centres are `laneCentreX` at `judgeY` - the same two numbers a note is given at
 * phase 1 - so a note and its target coincide exactly at the instant the note is judged.
 * That is not a coincidence to be maintained by hand: both come from `positionOf`, and a
 * test checks that they still agree.
 *
 * `laneDepth[lane]` is how many presses the judge currently has in that lane, so a held
 * lane stays lit for as long as it is held.
 */
export function drawTapArea(ctx, geometry, laneDepth) {
  const radius = geometry.tapRadius;
  const first = positionOf(geometry, 0, 1);
  const last = positionOf(geometry, geometry.laneCount - 1, 1);

  ctx.save();

  // The line joining the centres. Drawn first and passed over by every circle, so it
  // reads as a rail the targets sit on rather than as a rule drawn across them.
  ctx.strokeStyle = TAP_AREA.link;
  ctx.lineWidth = Math.max(1, radius * TAP_AREA.linkWidthFactor);
  ctx.lineCap = "round";
  ctx.shadowColor = TAP_AREA.linkGlow;
  ctx.shadowBlur = radius * 0.5;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.shadowBlur = 0;

  for (let lane = 0; lane < geometry.laneCount; lane += 1) {
    const { x, y } = positionOf(geometry, lane, 1);
    const pressed = Array.isArray(laneDepth) && laneDepth[lane] > 0;

    // A soft pool of light under the target, so it holds its own over a bright decoration.
    const halo = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius * (1 + TAP_AREA.glowFactor));
    halo.addColorStop(0, TAP_AREA.glow);
    halo.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalAlpha = pressed ? 0.9 : 0.45;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, radius * (1 + TAP_AREA.glowFactor), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    // The dark middle: something for a note to be seen against as it lands.
    ctx.fillStyle = pressed ? TAP_AREA.pressFill : TAP_AREA.centre;
    ctx.beginPath();
    ctx.arc(x, y, radius * TAP_AREA.innerRingFactor, 0, TAU);
    ctx.fill();

    const sheen = ctx.createLinearGradient(x, y - radius, x, y + radius);
    sheen.addColorStop(0, TAP_AREA.centreHighlight);
    sheen.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = sheen;
    ctx.fill();

    ctx.strokeStyle = TAP_AREA.innerRing;
    ctx.lineWidth = Math.max(1, radius * TAP_AREA.innerRingWidthFactor);
    ctx.beginPath();
    ctx.arc(x, y, radius * TAP_AREA.innerRingFactor, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = pressed ? TAP_AREA.pressRing : TAP_AREA.outerRing;
    ctx.lineWidth = Math.max(1, radius * TAP_AREA.outerRingWidthFactor);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// One note head
// ---------------------------------------------------------------------------

/**
 * A round note: a coloured disc, a pale rim, a dark edge, a mark in the middle.
 *
 * The rim and the dark edge are both fractions of the radius, so a note two hundred pixels
 * away and a note at the tap line are the same drawing at two sizes rather than two
 * drawings - which is what stops a distant note from turning into a smudge with a
 * disproportionate outline.
 */
export function drawNoteHead(ctx, position, style, options = {}) {
  const radius = options.radius;
  if (!(radius > 0.4) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;

  const alpha = options.alpha ?? 1;
  if (alpha <= 0) return;

  const ringWidth = radius * SIZES.ringWidth;
  const innerRadius = Math.max(radius * 0.2, radius - ringWidth);

  ctx.save();
  ctx.globalAlpha = alpha;

  // The rim, with the note's own colour thrown onto the sky behind it. White on most kinds
  // and tinted on the two flick sides, which is one of the things that tells them apart.
  ctx.shadowColor = style.glow;
  ctx.shadowBlur = radius * SIZES.glow;
  ctx.fillStyle = style.ring;
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;

  const interior = ctx.createRadialGradient(
    position.x - innerRadius * 0.35,
    position.y - innerRadius * 0.4,
    innerRadius * 0.08,
    position.x,
    position.y,
    innerRadius,
  );
  interior.addColorStop(0, style.interior[0]);
  interior.addColorStop(0.52, style.interior[1]);
  interior.addColorStop(1, style.interior[2]);
  ctx.fillStyle = interior;
  ctx.beginPath();
  ctx.arc(position.x, position.y, innerRadius, 0, TAU);
  ctx.fill();

  // A thin dark edge around the rim. Without it the rim disappears the moment a decoration
  // puts something pale behind the playfield.
  const outline = Math.max(0.6, radius * SIZES.outlineWidth);
  ctx.strokeStyle = style.outline;
  ctx.lineWidth = outline;
  ctx.beginPath();
  ctx.arc(position.x, position.y, Math.max(0.2, radius - outline / 2), 0, TAU);
  ctx.stroke();

  if (innerRadius > 2.5) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = innerRadius * 0.16;
    ctx.beginPath();
    ctx.arc(position.x, position.y, innerRadius * 0.68, Math.PI * 1.12, Math.PI * 1.78);
    ctx.stroke();
  }

  drawMark(ctx, position, style, innerRadius, options.direction ?? null);

  ctx.restore();
}

/**
 * The thing in the middle of a note that says which of the four it is.
 *
 * The hue already says it; this says it a second time, for the moment when three notes are
 * overlapping near the horizon and hue alone is not enough. On the two flick sides it says a
 * third thing as well, because `markColour` is dark on the left and white on the right: the
 * arrowhead flips from a hole in a bright disc to a bright shape on a deep one, which is a
 * difference that survives both distance and a colour vision difference.
 */
function drawMark(ctx, position, style, innerRadius, direction) {
  if (innerRadius < 2) return;
  ctx.fillStyle = style.markColour;

  if (style.mark === "disc") {
    ctx.beginPath();
    ctx.arc(position.x, position.y, innerRadius * 0.36, 0, TAU);
    ctx.fill();
    return;
  }

  if (style.mark === "bar") {
    const halfWidth = innerRadius * 0.62;
    const halfHeight = Math.max(0.6, innerRadius * 0.17);
    ctx.beginPath();
    ctx.moveTo(position.x - halfWidth + halfHeight, position.y - halfHeight);
    ctx.lineTo(position.x + halfWidth - halfHeight, position.y - halfHeight);
    ctx.arc(position.x + halfWidth - halfHeight, position.y, halfHeight, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(position.x - halfWidth + halfHeight, position.y + halfHeight);
    ctx.arc(position.x - halfWidth + halfHeight, position.y, halfHeight, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fill();
    return;
  }

  if (style.mark === "arrow" && direction !== null) {
    // Short of the rim rather than against it: an arrowhead that touches the white ring
    // merges with it and the note stops reading as a circle with a mark inside.
    drawArrowhead(ctx, position, direction, innerRadius * 0.76);
  }
}

/**
 * A thick wedge pointing the way the chart says to swipe.
 *
 * Solid and blunt rather than a drawn "<": at the size a note is halfway down the screen a
 * thin chevron is two pixels of nothing, and a flick whose direction cannot be read is a
 * flick the chart failed to communicate. The eight compass points of the contract are all
 * here, so a chart that one day asks for `upRight` already draws correctly.
 */
export function drawArrowhead(ctx, position, direction, size) {
  const angle = ARROW_ANGLES[direction];
  if (angle === undefined || !(size > 0)) return;
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(angle);
  // Shifted back a little: the wedge has more of itself in front of the origin than
  // behind, so drawing it about the note's centre leaves it visibly off to one side of
  // the disc.
  ctx.translate(-size * 0.16, 0);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.45, -size * 0.88);
  ctx.lineTo(-size * 0.12, 0);
  ctx.lineTo(-size * 0.45, size * 0.88);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ribbons
// ---------------------------------------------------------------------------

/**
 * The band joining the points of a held or travelling note.
 *
 * It is not a rectangle stretched on the screen. `sampleRibbon` walks the visible part of
 * the note's own flight, projects each sample through the same perspective the heads go
 * through, and this fills the strip between the resulting left and right edges. So the band
 * is narrow and pale where the note is far away, widens as it comes, and follows the curve
 * of the flight instead of cutting across it - and a slide that crosses three lanes bends
 * the way its notes will actually travel.
 *
 * Three passes: a wide soft body, a brighter core, and a lit edge down each side. That is
 * the cheapest way to get a soft-edged band out of a canvas fill.
 */
export function drawRibbon(ctx, geometry, points, chartTimeSec, approachSec, style, active) {
  const segments = sampleRibbon(geometry, points, chartTimeSec, approachSec);
  if (segments.length === 0) return;

  const fill = active ? style.fillActive : style.fill;
  const core = active ? style.coreActive : style.core;
  const edge = active ? style.edgeActive : style.edge;

  // One ramp for the whole band rather than one per leg. A gradient per leg would restart
  // at every waypoint, and a four-point slide would come out as four bands of visibly
  // different shades stacked end to end.
  const nearest = segments[0].samples[0];
  const farthestSegment = segments[segments.length - 1];
  const farthest = farthestSegment.samples[farthestSegment.samples.length - 1];
  const ramp = (from, to, fadeFar) => {
    const gradient = ctx.createLinearGradient(farthest.x, farthest.y, nearest.x, nearest.y);
    if (fadeFar) {
      gradient.addColorStop(0, style.fade);
      gradient.addColorStop(FADE_SPAN, from);
    } else {
      gradient.addColorStop(0, from);
    }
    gradient.addColorStop(1, to);
    return gradient;
  };

  // The far edge is a cut, not an end, whenever the note runs on past the spawn line. It is
  // faded out so the band grows out of the distance instead of starting at a hard line.
  const fadeFar = farthestSegment.clippedFar;

  ctx.save();
  ctx.fillStyle = ramp(fill[0], fill[1], fadeFar);
  for (const segment of segments) {
    if (segment.samples.length < 2) continue;
    traceBand(ctx, geometry, segment.samples, style.widthFactor);
    ctx.fill();
  }

  ctx.fillStyle = ramp(fadeFar ? style.fade : core, core, fadeFar);
  for (const segment of segments) {
    if (segment.samples.length < 2) continue;
    traceBand(ctx, geometry, segment.samples, style.widthFactor * 0.55);
    ctx.fill();
  }

  ctx.strokeStyle = ramp(fadeFar ? style.fade : edge, edge, fadeFar);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.8, geometry.tapRadius * 0.05 * (nearest.scale + farthest.scale));
  for (const segment of segments) {
    if (segment.samples.length < 2) continue;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      segment.samples.forEach((sample, index) => {
        const x = sample.x + side * ribbonHalfWidth(geometry, sample.scale, style.widthFactor);
        if (index === 0) ctx.moveTo(x, sample.y);
        else ctx.lineTo(x, sample.y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** How much of the band's length the fade at a cut far edge occupies. */
const FADE_SPAN = 0.22;

/** Trace the outline of a sampled band: down one edge and back up the other. */
function traceBand(ctx, geometry, samples, widthFactor) {
  ctx.beginPath();
  for (let i = 0; i < samples.length; i += 1) {
    const half = ribbonHalfWidth(geometry, samples[i].scale, widthFactor);
    const x = samples[i].x - half;
    if (i === 0) ctx.moveTo(x, samples[i].y);
    else ctx.lineTo(x, samples[i].y);
  }
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const half = ribbonHalfWidth(geometry, samples[i].scale, widthFactor);
    ctx.lineTo(samples[i].x + half, samples[i].y);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// A whole note
// ---------------------------------------------------------------------------

/**
 * Which style each judgement point of a note is drawn in.
 *
 * Pure, and separated out because it is the part with the rules in it rather than the part
 * with the canvas in it - and because two of those rules are contract decisions worth
 * being able to test directly:
 *
 *   - A note whose `endAction` is a flick has a **flick** at its end: violet, in the side
 *     the end action names, with its arrow. Nothing else on the playfield would tell a
 *     player that the last thing they have to do with a four-second hold is swipe it, and
 *     the contract is explicit that the end action is about the end rather than the note.
 *   - A `direction` on the note itself belongs to its *start*, so it is drawn on the first
 *     point and never borrowed by the last one.
 */
export function noteMarks(note) {
  const points = notePoints(note);
  const kind = noteKind(note);
  const last = points.length - 1;
  const bounded = points.length > 1;

  return points.map((point, index) => {
    const isEnd = bounded && index === last;
    const isWaypoint = index > 0 && !isEnd;

    if (isEnd && note.endAction !== null && note.endAction.type === "flick") {
      return { ...point, index, style: "flick", direction: note.endAction.direction, size: SIZES.note };
    }
    if (isWaypoint) {
      return { ...point, index, style: kind, direction: null, size: SIZES.waypoint };
    }
    return {
      ...point,
      index,
      style: kind,
      direction: index === 0 && !bounded ? note.direction : null,
      size: SIZES.note,
    };
  });
}

/**
 * The style a mark is drawn in.
 *
 * A flick with a sideways component is drawn in that side's violet - `flickLeft` or
 * `flickRight` - and everything else in the style named after its kind. The side is resolved
 * here rather than in `noteMarks` on purpose: which of the two violets a swipe wears is a
 * matter of how the note looks, while `noteMarks` answers what the note *is*, and the judge
 * and the autoplay both read a flick as one thing however it points.
 *
 * Exported so the mapping can be asked without a canvas.
 */
export function styleFor(name, direction = null) {
  if (name === "flick" && direction !== null) {
    const variant = NOTE_STYLES[FLICK_VARIANTS[direction]];
    if (variant) return variant;
  }
  return NOTE_STYLES[name] ?? NOTE_STYLES.other;
}

/**
 * The ribbon of one note, if it has one. Drawn before every head, never over one.
 *
 * A note with nothing left to play has no band either. That matters after a seek: the judge
 * retires a note whose beginning is behind the new playhead - nobody was asked to play it,
 * so it is not missed and not counted - and a band on the screen for a note that is not in
 * the run would be the playfield disagreeing with the scoreboard.
 */
export function drawNoteRibbon(ctx, geometry, note, chartTimeSec, approachSec, judge) {
  const points = notePoints(note);
  if (points.length < 2) return;
  if (judge && !points.some((_, index) => judge.statusOf(`${note.id}#${index}`)?.state === "pending")) return;

  const kind = noteKind(note);
  const travels = kind === "slide" || note.endLane !== null || note.waypoints.length > 0;
  const style = travels ? RIBBONS.slide : RIBBONS.hold;
  const active = judge?.noteStateOf(note.id)?.holding === true;
  drawRibbon(ctx, geometry, points, chartTimeSec, approachSec, style, active);
}

/** The heads of one note: its start, its waypoints and its end. */
export function drawNoteHeads(ctx, geometry, note, chartTimeSec, approachSec, judge) {
  for (const mark of noteMarks(note)) {
    const phase = flightPhase(mark.timeSec, chartTimeSec, approachSec);
    if (phase < FADE_IN_PHASE || phase > FADE_OUT_PHASE) continue;
    // A point the judge has finished with is gone: it was hit, or it was missed and its
    // window has closed. Leaving it on the playfield would be the Player disagreeing with
    // its own scoreboard.
    const status = judge?.statusOf(`${note.id}#${mark.index}`);
    if (status && status.state !== "pending") continue;

    const position = positionOf(geometry, mark.lane, phase);
    drawNoteHead(ctx, position, styleFor(mark.style, mark.direction), {
      radius: noteRadiusAt(geometry, position.scale, mark.size),
      direction: mark.direction,
      alpha: phase > 1 ? Math.max(0, 1 - (phase - 1) * FADE_RATE) : 1,
    });
  }
}

/**
 * The links between notes swiped through in one motion.
 *
 * A thin line under the notes: the chart says these are one run, and a player needs to see
 * the next flick coming before it arrives. Both ends are projected through the same
 * perspective as the notes they join, so the link lies along the path the hand will take
 * rather than cutting a straight line across the screen.
 */
export function drawConnections(ctx, geometry, connections, byId, chartTimeSec, approachSec) {
  ctx.save();
  ctx.strokeStyle = CONNECTION.stroke;
  ctx.lineCap = "round";
  for (const connection of connections) {
    const from = byId.get(connection.fromNoteId);
    const to = byId.get(connection.toNoteId);
    if (!from || !to) continue;
    const fromPhase = flightPhase(from.timeSec, chartTimeSec, approachSec);
    const toPhase = flightPhase(to.timeSec, chartTimeSec, approachSec);
    if (toPhase < FADE_IN_PHASE || fromPhase > 1.2) continue;
    const a = positionOf(geometry, from.lane, fromPhase);
    const b = positionOf(geometry, to.lane, toPhase);
    ctx.lineWidth = Math.max(1, geometry.tapRadius * CONNECTION.widthFactor * ((a.scale + b.scale) / 2));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}
