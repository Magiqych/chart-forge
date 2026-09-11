/**
 * Drawing the playfield.
 *
 * Everything drawn here is a function of the chart and one number - the current chart
 * time. Nothing accumulates between frames, so the picture at a moment is the same
 * whether it was reached by playing, by seeking, or by a frame that took 200 ms. That is
 * the same rule the layout module states, and the renderer's whole job is not to break
 * it.
 *
 * The one exception is the short-lived feedback - the flash at the judgement line and
 * the text that floats off it. Those are given the chart time they happened at and fade
 * over chart time too, so they behave the same at half speed as at full.
 *
 * A canvas rather than DOM nodes on purpose: five hundred notes, a hundred connections
 * and a starfield are a few hundred fill calls per frame here, and would be a few hundred
 * elements to create, style and destroy in the other approach.
 */

import { notePoints, noteKind } from "./chart.js";
import { positionOf, progressOf, laneCentreX, visibleNotes, visibleDecorations } from "./layout.js";
import { drawDecoration } from "./decorations.js";

/**
 * The palette.
 *
 * The four gameplay kinds are told apart by hue first, because during play there is no
 * time to read a shape: blue taps, amber longs, mint slides, pink flicks. It is a night
 * sky, which suits this song, and it keeps the notes - which are all bright - clear of
 * the background, which is all dark.
 */
export const palette = {
  skyTop: "#070a16",
  skyBottom: "#141a33",
  star: "#cfe2ff",
  laneFill: "rgba(150, 180, 255, 0.045)",
  laneFillAlt: "rgba(150, 180, 255, 0.015)",
  laneEdge: "rgba(160, 190, 255, 0.22)",
  laneEdgeFar: "rgba(160, 190, 255, 0.05)",
  judgeLine: "#e8f2ff",
  judgeGlow: "rgba(140, 200, 255, 0.55)",
  lanePress: "rgba(140, 200, 255, 0.20)",
  note: {
    tap: { fill: "#4fb8ff", edge: "#eaf7ff" },
    hold: { fill: "#ffb444", edge: "#fff0d6" },
    slide: { fill: "#57e3b0", edge: "#e2fff4" },
    flick: { fill: "#ff79d0", edge: "#ffe6f7" },
    other: { fill: "#b9c4d8", edge: "#ffffff" },
  },
  holdBody: "rgba(255, 180, 68, 0.30)",
  holdBodyActive: "rgba(255, 214, 130, 0.55)",
  slideBody: "rgba(87, 227, 176, 0.26)",
  slideBodyActive: "rgba(170, 255, 220, 0.5)",
  connection: "rgba(255, 121, 208, 0.55)",
  result: {
    perfect: "#ffe98a",
    great: "#7fe7a6",
    good: "#7fc4ff",
    miss: "#ff7c7c",
  },
};

const FEEDBACK_LIFE_SEC = 0.55;
const RING_LIFE_SEC = 0.38;

/** A deterministic star field: same chart, same machine, same sky. */
function makeStars(count) {
  const stars = [];
  let seed = 20260912;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: random(),
      y: random() * 0.85,
      radius: 0.4 + random() * 1.5,
      phase: random() * Math.PI * 2,
      speed: 0.4 + random() * 1.6,
    });
  }
  return stars;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Where the visible part of a held note's body starts and ends, in chart time.
 *
 * The near end is the playhead itself, not a little before it: the part of a long note
 * that is already behind the judgement line has been played, and drawing it would leave
 * a ribbon hanging off the bottom of the screen for something the player has finished
 * doing. The far end reaches a little past the top so a body does not pop into being.
 */
function clampSegment(fromSec, toSec, chartTimeSec, travelSec) {
  const earliest = chartTimeSec;
  const latest = chartTimeSec + 1.35 * travelSec;
  const start = Math.max(fromSec, earliest);
  const end = Math.min(toSec, latest);
  return end <= start ? null : { start, end };
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const stars = makeStars(180);

  function drawSky(geometry, chartTimeSec) {
    const sky = ctx.createLinearGradient(0, 0, 0, geometry.height);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(1, palette.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    ctx.fillStyle = palette.star;
    for (const star of stars) {
      // A slow twinkle in chart time, so it slows down with the music rather than
      // carrying on at wall-clock speed while everything else is at quarter pace.
      const twinkle = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(star.phase + chartTimeSec * star.speed));
      ctx.globalAlpha = twinkle;
      ctx.beginPath();
      ctx.arc(star.x * geometry.width, star.y * geometry.height, star.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayfield(geometry, laneDepth) {
    const far = positionOf(geometry, 0, 0);
    const near = positionOf(geometry, 0, 1);

    for (let lane = 0; lane < geometry.laneCount; lane += 1) {
      const leftFar = geometry.centreX + (laneCentreX(geometry, lane) - geometry.laneWidth / 2 - geometry.centreX) * far.scale;
      const rightFar = geometry.centreX + (laneCentreX(geometry, lane) + geometry.laneWidth / 2 - geometry.centreX) * far.scale;
      const leftNear = laneCentreX(geometry, lane) - geometry.laneWidth / 2;
      const rightNear = laneCentreX(geometry, lane) + geometry.laneWidth / 2;

      ctx.beginPath();
      ctx.moveTo(leftFar, far.y);
      ctx.lineTo(rightFar, far.y);
      ctx.lineTo(rightNear, near.y);
      ctx.lineTo(leftNear, near.y);
      ctx.closePath();
      ctx.fillStyle = lane % 2 === 0 ? palette.laneFill : palette.laneFillAlt;
      ctx.fill();

      if (laneDepth && laneDepth[lane] > 0) {
        const glow = ctx.createLinearGradient(0, far.y, 0, near.y);
        glow.addColorStop(0, "rgba(140, 200, 255, 0)");
        glow.addColorStop(1, palette.lanePress);
        ctx.fillStyle = glow;
        ctx.fill();
      }
    }

    for (let edge = 0; edge <= geometry.laneCount; edge += 1) {
      const nearX = geometry.centreX - geometry.nearWidth / 2 + edge * geometry.laneWidth;
      const farX = geometry.centreX + (nearX - geometry.centreX) * far.scale;
      const stroke = ctx.createLinearGradient(0, far.y, 0, near.y);
      stroke.addColorStop(0, palette.laneEdgeFar);
      stroke.addColorStop(1, palette.laneEdge);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(farX, far.y);
      ctx.lineTo(nearX, near.y);
      ctx.stroke();
    }

    ctx.save();
    ctx.shadowColor = palette.judgeGlow;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = palette.judgeLine;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(geometry.centreX - geometry.nearWidth / 2, geometry.judgeY);
    ctx.lineTo(geometry.centreX + geometry.nearWidth / 2, geometry.judgeY);
    ctx.stroke();
    ctx.restore();
  }

  /** The band a held or travelling note occupies, drawn in perspective. */
  function drawBody(geometry, points, chartTimeSec, travelSec, colour, widthFactor) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (!(b.timeSec > a.timeSec)) continue;
      const span = clampSegment(a.timeSec, b.timeSec, chartTimeSec, travelSec);
      if (!span) continue;

      // The projection is not linear in time, so a straight quad between two waypoints
      // would leave the lane. Sampling keeps the band on the lanes it actually crosses.
      const steps = Math.min(24, Math.max(2, Math.ceil((span.end - span.start) / 0.06)));
      const left = [];
      const right = [];
      for (let step = 0; step <= steps; step += 1) {
        const t = span.start + ((span.end - span.start) * step) / steps;
        const mix = (t - a.timeSec) / (b.timeSec - a.timeSec);
        const lane = a.lane + (b.lane - a.lane) * mix;
        const progress = progressOf(t, chartTimeSec, travelSec);
        const position = positionOf(geometry, lane, progress);
        const halfWidth = (geometry.laneWidth * widthFactor * position.scale) / 2;
        left.push([position.x - halfWidth, position.y]);
        right.push([position.x + halfWidth, position.y]);
      }

      ctx.beginPath();
      ctx.moveTo(left[0][0], left[0][1]);
      for (let k = 1; k < left.length; k += 1) ctx.lineTo(left[k][0], left[k][1]);
      for (let k = right.length - 1; k >= 0; k -= 1) ctx.lineTo(right[k][0], right[k][1]);
      ctx.closePath();
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }

  function drawArrow(position, direction, size, colour) {
    const angles = {
      left: Math.PI, right: 0, up: -Math.PI / 2, down: Math.PI / 2,
      upLeft: (-3 * Math.PI) / 4, upRight: -Math.PI / 4,
      downLeft: (3 * Math.PI) / 4, downRight: Math.PI / 4,
    };
    const angle = angles[direction] ?? 0;
    ctx.save();
    ctx.translate(position.x, position.y);
    ctx.rotate(angle);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.55, -size * 0.8);
    ctx.lineTo(-size * 0.15, 0);
    ctx.lineTo(-size * 0.55, size * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawHead(geometry, position, kind, colours, options = {}) {
    if (position.scale <= 0) return;
    const width = geometry.laneWidth * (options.narrow ? 0.5 : 0.84) * position.scale;
    const height = Math.max(4, 16 * position.scale);
    ctx.save();
    ctx.globalAlpha = options.alpha ?? 1;
    ctx.shadowColor = colours.fill;
    ctx.shadowBlur = 12 * position.scale;
    roundedRect(ctx, position.x - width / 2, position.y - height / 2, width, height, height / 2);
    ctx.fillStyle = colours.fill;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1, 1.6 * position.scale);
    ctx.strokeStyle = colours.edge;
    ctx.stroke();
    if (options.direction) {
      drawArrow(position, options.direction, Math.max(3, 7 * position.scale), "#1a0d18");
    }
    if (kind === "waypoint") {
      ctx.fillStyle = colours.edge;
      ctx.beginPath();
      ctx.arc(position.x, position.y, Math.max(1.5, 2.6 * position.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawNote(geometry, note, chartTimeSec, travelSec, judge) {
    const points = notePoints(note);
    const kind = noteKind(note);
    const colours = palette.note[kind] ?? palette.note.other;
    const noteState = judge?.noteStateOf(note.id);
    const holding = noteState?.holding === true;

    if (points.length > 1) {
      const isSlide = kind === "slide" || note.endLane !== null || note.waypoints.length > 0;
      const body = isSlide
        ? holding ? palette.slideBodyActive : palette.slideBody
        : holding ? palette.holdBodyActive : palette.holdBody;
      drawBody(geometry, points, chartTimeSec, travelSec, body, isSlide ? 0.34 : 0.6);
    }

    points.forEach((point, index) => {
      const progress = progressOf(point.timeSec, chartTimeSec, travelSec);
      if (progress < -0.05 || progress > 1.25) return;
      const status = judge?.statusOf(`${note.id}#${index}`);
      if (status && status.state !== "pending") return;
      const position = positionOf(geometry, point.lane, progress);
      const isEnd = index === points.length - 1 && points.length > 1;
      const direction =
        index === 0 && points.length === 1
          ? note.direction
          : isEnd && note.endAction?.type === "flick"
            ? note.endAction.direction
            : null;
      drawHead(geometry, position, index === 0 || isEnd ? "cap" : "waypoint", colours, {
        ...(direction ? { direction } : {}),
        narrow: index > 0 && !isEnd,
        alpha: progress > 1 ? Math.max(0, 1 - (progress - 1) * 4) : 1,
      });
    });
  }

  /**
   * The links between notes swiped through in one motion.
   *
   * A thin line, drawn under the notes: the chart says these are one run, and a player
   * needs to see that the next flick is coming before it arrives.
   */
  function drawConnections(geometry, chart, chartTimeSec, travelSec, byId) {
    ctx.save();
    ctx.strokeStyle = palette.connection;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (const connection of chart.connections) {
      const from = byId.get(connection.fromNoteId);
      const to = byId.get(connection.toNoteId);
      if (!from || !to) continue;
      const fromProgress = progressOf(from.timeSec, chartTimeSec, travelSec);
      const toProgress = progressOf(to.timeSec, chartTimeSec, travelSec);
      if (toProgress < -0.05 || fromProgress > 1.2) continue;
      const a = positionOf(geometry, from.lane, fromProgress);
      const b = positionOf(geometry, to.lane, toProgress);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFeedback(geometry, feedback, chartTimeSec) {
    ctx.save();
    ctx.textAlign = "center";
    for (const item of feedback) {
      const age = chartTimeSec - item.timeSec;
      if (age < 0) continue;

      if (age < RING_LIFE_SEC && item.result !== "miss") {
        const t = age / RING_LIFE_SEC;
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.strokeStyle = palette.result[item.result] ?? "#ffffff";
        ctx.lineWidth = 3 * (1 - t) + 1;
        ctx.beginPath();
        ctx.ellipse(
          laneCentreX(geometry, item.lane),
          geometry.judgeY,
          geometry.laneWidth * (0.25 + t * 0.4),
          geometry.laneWidth * (0.07 + t * 0.14),
          0, 0, Math.PI * 2,
        );
        ctx.stroke();
      }

      if (age < FEEDBACK_LIFE_SEC && item.text) {
        const t = age / FEEDBACK_LIFE_SEC;
        ctx.globalAlpha = 1 - t * t;
        ctx.fillStyle = palette.result[item.result] ?? "#ffffff";
        ctx.font = `600 ${Math.round(geometry.height * 0.028)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(
          item.text,
          laneCentreX(geometry, item.lane),
          geometry.judgeY - geometry.height * 0.06 - t * geometry.height * 0.04,
        );
      }
    }
    ctx.restore();
  }

  return {
    /** Size the backing store to the device's pixels; CSS handles the layout size. */
    resize(width, height, devicePixelRatio) {
      const ratio = Math.min(2, Math.max(1, devicePixelRatio || 1));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    },

    draw(frame) {
      const { geometry, chart, chartTimeSec, travelSec, judge, feedback, laneDepth, showDecorations } = frame;
      ctx.clearRect(0, 0, geometry.width, geometry.height);
      drawSky(geometry, chartTimeSec);
      drawPlayfield(geometry, laneDepth);

      const notes = visibleNotes(chart, chartTimeSec - 0.35, chartTimeSec + travelSec);
      const byId = new Map(notes.map((note) => [note.id, note]));
      drawConnections(geometry, chart, chartTimeSec, travelSec, byId);

      // Far notes first, so nearer ones - the ones about to be hit - are on top.
      const ordered = notes.slice().sort((a, b) => b.timeSec - a.timeSec);
      for (const note of ordered) drawNote(geometry, note, chartTimeSec, travelSec, judge);

      if (showDecorations) {
        for (const shown of visibleDecorations(chart.decorations, chartTimeSec)) {
          drawDecoration(ctx, geometry, shown, chartTimeSec);
        }
      }

      drawFeedback(geometry, feedback, chartTimeSec);
      return notes.length;
    },
  };
}
