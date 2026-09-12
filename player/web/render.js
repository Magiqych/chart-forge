/**
 * The frame: what is painted, and in what order.
 *
 * Everything drawn here is a function of the chart and one number - the current chart
 * time. Nothing accumulates between frames, so the picture at a moment is the same whether
 * it was reached by playing, by seeking, or by a frame that took 200 ms. That is the rule
 * `note-space.js` states, and the renderer's whole job is not to break it.
 *
 * The one exception is the short-lived feedback - the ring at a tap target and the word
 * that floats off it. Those are given the chart time they happened at and fade over chart
 * time too, so they behave the same at half speed as at full.
 *
 * A canvas rather than DOM nodes on purpose: five hundred notes, a hundred connections and
 * a starfield are a few hundred fill calls per frame here, and would be a few hundred
 * elements to create, style and destroy in the other approach.
 *
 * ## The order
 *
 * Painted back to front, because that is what a picture with depth in it requires:
 *
 *   1. the sky and the lanes        the room the notes are in
 *   2. the connections              thin, under everything they join
 *   3. every ribbon, far to near    the bands of holds and slides
 *   4. the tap targets              where the notes are going
 *   5. every head, far to near      the notes themselves
 *   6. decorations                  the chart's own captions
 *   7. judgement feedback           what just happened
 *   8. the debug overlay            only when asked for
 *
 * Three of those are worth defending. **All ribbons before all heads**, rather than each
 * note drawn whole in turn, so that a four-second hold's band can never be painted over
 * the note that is about to be hit in front of it. **The tap targets over the ribbons**,
 * because a band arriving into a target should pass behind the ring rather than across it.
 * And **the tap targets under the heads**: the two coincide exactly at the moment of
 * judgement, and of the two it is the note that has to be readable at that instant.
 */

import { visibleNotes, visibleDecorations } from "./layout.js";
import { positionOf, laneCentreX, WORLD } from "./note-space.js";
import { drawDecoration } from "./decorations.js";
import { STAGE, FEEDBACK, DEBUG } from "./note-theme.js";
import {
  drawTapArea,
  drawNoteRibbon,
  drawNoteHeads,
  drawConnections,
} from "./note-renderer.js";

/** How long a judgement's word and its ring last, in chart seconds. */
const FEEDBACK_LIFE_SEC = 0.55;
const RING_LIFE_SEC = 0.4;

/** How far behind the playhead a note is still looked for. */
const LOOK_BEHIND_SEC = 0.35;

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

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const stars = makeStars(180);

  function drawSky(geometry, chartTimeSec) {
    const sky = ctx.createLinearGradient(0, 0, 0, geometry.height);
    sky.addColorStop(0, STAGE.skyTop);
    sky.addColorStop(1, STAGE.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, geometry.width, geometry.height);

    ctx.fillStyle = STAGE.star;
    for (const star of stars) {
      // A slow twinkle in chart time, so it slows down with the music rather than carrying
      // on at wall-clock speed while everything else is at quarter pace.
      const twinkle = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(star.phase + chartTimeSec * star.speed));
      ctx.globalAlpha = twinkle;
      ctx.beginPath();
      ctx.arc(star.x * geometry.width, star.y * geometry.height, star.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The lanes, as the trapezoid the perspective makes of them.
   *
   * Faint on purpose. They are there so the five columns can be found at a glance and so
   * the playfield has a floor; anything stronger competes with the notes, which are the
   * only thing on this screen that has to be read in a tenth of a second.
   */
  function drawLanes(geometry, laneDepth) {
    const far = positionOf(geometry, 0, 0);
    const near = positionOf(geometry, 0, 1);
    const halfLane = geometry.laneWidth / 2;

    for (let lane = 0; lane < geometry.laneCount; lane += 1) {
      const centre = laneCentreX(geometry, lane);
      const leftFar = geometry.centreX + (centre - halfLane - geometry.centreX) * far.scale;
      const rightFar = geometry.centreX + (centre + halfLane - geometry.centreX) * far.scale;

      ctx.beginPath();
      ctx.moveTo(leftFar, far.y);
      ctx.lineTo(rightFar, far.y);
      ctx.lineTo(centre + halfLane, near.y);
      ctx.lineTo(centre - halfLane, near.y);
      ctx.closePath();
      ctx.fillStyle = lane % 2 === 0 ? STAGE.laneFill : STAGE.laneFillAlt;
      ctx.fill();

      if (laneDepth && laneDepth[lane] > 0) {
        const glow = ctx.createLinearGradient(0, far.y, 0, near.y);
        glow.addColorStop(0, "rgba(150, 205, 255, 0)");
        glow.addColorStop(1, STAGE.lanePress);
        ctx.fillStyle = glow;
        ctx.fill();
      }
    }

    for (let edge = 0; edge <= geometry.laneCount; edge += 1) {
      const nearX = geometry.centreX - geometry.nearWidth / 2 + edge * geometry.laneWidth;
      const farX = geometry.centreX + (nearX - geometry.centreX) * far.scale;
      const stroke = ctx.createLinearGradient(0, far.y, 0, near.y);
      stroke.addColorStop(0, STAGE.laneEdgeFar);
      stroke.addColorStop(1, STAGE.laneEdge);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(farX, far.y);
      ctx.lineTo(nearX, near.y);
      ctx.stroke();
    }
  }

  /**
   * What just happened, at the target it happened on.
   *
   * The ring opens from the tap target's own radius outward, so it reads as that circle
   * answering rather than as a separate thing that appeared nearby.
   */
  function drawFeedback(geometry, feedback, chartTimeSec) {
    ctx.save();
    ctx.textAlign = "center";
    for (const item of feedback) {
      const age = chartTimeSec - item.timeSec;
      if (age < 0) continue;
      const centreX = laneCentreX(geometry, item.lane);

      if (age < RING_LIFE_SEC && item.result !== "miss") {
        const t = age / RING_LIFE_SEC;
        const colour = FEEDBACK[item.result] ?? "#ffffff";

        ctx.globalAlpha = (1 - t) * 0.22;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(centreX, geometry.judgeY, geometry.tapRadius * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.strokeStyle = colour;
        ctx.lineWidth = geometry.tapRadius * 0.16 * (1 - t) + 1;
        ctx.beginPath();
        ctx.arc(centreX, geometry.judgeY, geometry.tapRadius * (1 + t * 1.1), 0, Math.PI * 2);
        ctx.stroke();
      }

      if (age < FEEDBACK_LIFE_SEC && item.text) {
        const t = age / FEEDBACK_LIFE_SEC;
        ctx.globalAlpha = 1 - t * t;
        ctx.fillStyle = FEEDBACK[item.result] ?? "#ffffff";
        ctx.font = `600 ${Math.round(geometry.height * 0.028)}px ui-sans-serif, system-ui, sans-serif`;
        // Clear of the target rather than a fixed distance up the screen: the circles grow
        // with the playfield, and a judgement written across the one it belongs to is a
        // judgement nobody can read.
        ctx.fillText(
          item.text,
          centreX,
          geometry.judgeY - geometry.tapRadius - geometry.height * 0.05 - t * geometry.height * 0.04,
        );
      }
    }
    ctx.restore();
  }

  /**
   * The overlay for tuning the flight, off unless the page was opened with `?debug=1`.
   *
   * It draws the thing that is otherwise invisible: the path a note in each lane takes,
   * sampled at every tenth of its phase. Five curves that converge towards the spawn line,
   * fan out to the five targets and space out as they come are what the geometry is
   * supposed to produce, and this is how that was checked rather than guessed at.
   */
  function drawDebug(geometry, chartTimeSec, approachSec, noteCount) {
    ctx.save();

    const spawn = positionOf(geometry, 0, 0);
    for (const [y, colour, label] of [
      [spawn.y, DEBUG.spawnLine, "spawn"],
      [geometry.judgeY, DEBUG.tapLine, "tap"],
    ]) {
      ctx.strokeStyle = colour;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(geometry.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, 6, y - 4);
    }

    for (let lane = 0; lane < geometry.laneCount; lane += 1) {
      ctx.strokeStyle = DEBUG.trajectory;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let step = 0; step <= 40; step += 1) {
        const point = positionOf(geometry, lane, step / 40);
        if (step === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();

      ctx.fillStyle = DEBUG.laneCentre;
      for (let step = 0; step <= 10; step += 1) {
        const point = positionOf(geometry, lane, step / 10);
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const lines = [
      `chart time   ${chartTimeSec.toFixed(3)} s`,
      `approach     ${approachSec.toFixed(3)} s`,
      `drawn notes  ${noteCount}`,
      `spawn depth  ${WORLD.spawnDepth}  height ${WORLD.spawnHeight}`,
      `tap depth    ${WORLD.tapDepth}  height ${WORLD.tapHeight}`,
      `camera       ${WORLD.cameraHeight}`,
      `tap radius   ${geometry.tapRadius.toFixed(1)} px`,
      `viewport     ${Math.round(geometry.width)}×${Math.round(geometry.height)}`,
    ];
    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(4, 8, 20, 0.7)";
    ctx.fillRect(8, geometry.height - 18 * lines.length - 16, 260, 18 * lines.length + 10);
    ctx.fillStyle = DEBUG.text;
    lines.forEach((line, index) => {
      ctx.fillText(line, 16, geometry.height - 18 * (lines.length - index) - 2);
    });

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
      const {
        geometry, chart, chartTimeSec, travelSec, judge, feedback, laneDepth,
        showDecorations, debug,
      } = frame;

      ctx.clearRect(0, 0, geometry.width, geometry.height);
      drawSky(geometry, chartTimeSec);
      drawLanes(geometry, laneDepth);

      const notes = visibleNotes(chart, chartTimeSec - LOOK_BEHIND_SEC, chartTimeSec + travelSec);
      const byId = new Map(notes.map((note) => [note.id, note]));
      drawConnections(ctx, geometry, chart.connections, byId, chartTimeSec, travelSec);

      // Far first, so a nearer note - the one about to be hit - is always on top of an
      // older one, and so no band is ever drawn over a head.
      const ordered = notes.slice().sort((a, b) => b.timeSec - a.timeSec);
      for (const note of ordered) drawNoteRibbon(ctx, geometry, note, chartTimeSec, travelSec, judge);

      drawTapArea(ctx, geometry, laneDepth);

      for (const note of ordered) drawNoteHeads(ctx, geometry, note, chartTimeSec, travelSec, judge);

      if (showDecorations) {
        for (const shown of visibleDecorations(chart.decorations, chartTimeSec)) {
          drawDecoration(ctx, geometry, shown, chartTimeSec);
        }
      }

      drawFeedback(geometry, feedback, chartTimeSec);
      if (debug) drawDebug(geometry, chartTimeSec, travelSec, notes.length);
      return notes.length;
    },
  };
}
