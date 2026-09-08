/**
 * The stage: the playfield as the player will see it, at one instant.
 *
 * The Editor's timeline is a time reader - horizontal is time, vertical is which lane -
 * and a decoration's `position` is neither of those. It is a place on the playfield, and
 * there is nowhere on a timeline to draw one honestly. So decorations get a second, small
 * surface that *is* the playfield: normalized coordinates drawn as a rectangle, with the
 * playhead's moment showing.
 *
 * This is also the only place an author can see what they are actually making. Font size,
 * alignment, rotation, colour, outline, opacity and the enter and exit animations are all
 * properties of the drawn caption, and none of them means anything on a bar in a row.
 *
 * Painting order is `paintOrder` and nothing else: `zIndex` first, then document order.
 * It is a pure function in `decoration.ts` precisely so the order can be asserted in a
 * test rather than inferred from what a canvas happened to do.
 */

import {
  decorationAppearance, isTextDecoration, paintOrder, resolveTextStyle,
  type ChartDecoration,
} from "../core/decoration";
import {
  effectStateAt, resolveGlow, resolveGradient, NO_EFFECTS,
  type EffectState, type MeteorState, type ResolvedGradient,
} from "../core/decorationEffects";
import {
  fitStage, stagePoint, stageTextBox, type Box, type StageRect,
} from "../core/decorationGeometry";
import { theme } from "./theme";

/**
 * The playfield's shape.
 *
 * Taller than it is wide, like the lane fan of the games this Editor is written for. It
 * is a drawing convention of this panel and nothing else - the contract stores normalized
 * coordinates precisely so no aspect ratio is baked into a chart.
 */
export const STAGE_ASPECT = 3 / 4;

const STAGE_PADDING_PX = 10;

export interface StageScene {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly decorations: readonly ChartDecoration[];
  readonly selectedIds: readonly string[];
  readonly timeSec: number;
  /**
   * Whether decorations outside their window are shown faintly.
   *
   * On while editing, because a caption that vanishes the moment the playhead leaves it
   * cannot be selected, dragged or deleted - and an author spends far more time beside a
   * decoration than exactly on it. Playback is not a separate mode here; this simply
   * makes the Editor an editor.
   */
  readonly showOutOfWindow: boolean;
  /**
   * Hold every moving part still, for `prefers-reduced-motion`.
   *
   * A property of the machine doing the drawing, never of the document: the chart is not
   * touched, and turning it off again restores the full appearance.
   */
  readonly reducedMotion?: boolean;
}

/** A decoration's drawn box, kept from the last paint so hit testing can use it. */
export interface StageBox {
  readonly decoration: ChartDecoration;
  readonly box: Box;
}

export interface StageRenderResult {
  readonly stage: StageRect;
  /** Back to front, which is the order `hitTestStage` walks in reverse. */
  readonly boxes: readonly StageBox[];
}

/** How faint an out-of-window decoration is drawn. */
const GHOST_OPACITY = 0.22;

/** How finely a drifting gradient's phase is quantised for caching. */
const GRADIENT_PHASE_STEPS = 96;
const GRADIENT_CACHE_LIMIT = 64;

/**
 * A `#rrggbb` colour at an opacity.
 *
 * Kept here rather than in the contract because it is a drawing detail: the document
 * stores an opaque colour and an intensity separately, precisely so that one can be
 * animated without rewriting the other.
 */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export class StageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Built gradients, keyed by colours, width and quantised phase. */
  private readonly gradients = new Map<string, CanvasGradient>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    this.ctx = ctx;
  }

  resize(widthCss: number, heightCss: number, devicePixelRatio: number): void {
    this.dpr = devicePixelRatio;
    this.canvas.width = Math.max(1, Math.floor(widthCss * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.floor(heightCss * devicePixelRatio));
    this.canvas.style.width = `${widthCss}px`;
    this.canvas.style.height = `${heightCss}px`;
  }

  render(scene: StageScene): StageRenderResult {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, scene.widthPx, scene.heightPx);

    const stage = fitStage(scene.widthPx, scene.heightPx, STAGE_ASPECT, STAGE_PADDING_PX);
    this.drawPlayfield(stage);

    const selected = new Set(scene.selectedIds);
    const boxes: StageBox[] = [];
    const order = paintOrder(scene.decorations);

    // The effect state of every decoration, worked out once. It is a pure function of
    // the time, so nothing here accumulates between frames and a seek to this moment
    // produces this frame again exactly.
    const states = new Map<string, EffectState>();
    for (const decoration of order) {
      states.set(
        decoration.id,
        decorationAppearance(decoration, scene.timeSec).visible
          ? effectStateAt(decoration, scene.timeSec, {
              ...(scene.reducedMotion === true ? { reducedMotion: true } : {}),
            })
          : NO_EFFECTS,
      );
    }

    // Meteors first, and all of them, because they belong to the sky rather than to any
    // one caption: drawing them per decoration would put one in front of the text above
    // it and behind the text below it.
    this.drawMeteors(stage, order, states);

    for (const decoration of order) {
      const appearance = decorationAppearance(decoration, scene.timeSec);
      if (!appearance.visible && !scene.showOutOfWindow) continue;
      // Out of its window it is drawn at a fixed ghost opacity rather than at whatever
      // its animation would have given it, so "faint" always means "not on screen yet"
      // and never "mid-fade".
      const opacity = appearance.visible ? appearance.opacity : GHOST_OPACITY;
      const scale = appearance.visible ? appearance.scale : 1;
      const state = states.get(decoration.id) ?? NO_EFFECTS;
      const box = this.drawDecoration(decoration, stage, opacity, scale, state);
      boxes.push({ decoration, box });
      if (appearance.visible) this.drawSparkles(box, state, opacity);
      if (selected.has(decoration.id)) this.drawSelection(box);
    }

    return { stage, boxes };
  }

  /**
   * The streaks crossing the sky, behind everything.
   *
   * Clipped to the playfield, so a meteor can travel in from off the edge without
   * painting over the timeline. Drawn as a tapering line rather than a particle system:
   * a meteor is one stroke, and one stroke is what a canvas is fastest at.
   */
  private drawMeteors(
    stage: StageRect,
    order: readonly ChartDecoration[],
    states: ReadonlyMap<string, EffectState>,
  ): void {
    const all: MeteorState[] = [];
    for (const decoration of order) {
      const state = states.get(decoration.id);
      if (state && state.meteors.length > 0) all.push(...state.meteors);
    }
    if (all.length === 0) return;

    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(stage.leftPx, stage.topPx, stage.widthPx, stage.heightPx);
    ctx.clip();
    ctx.lineCap = "round";
    const diagonal = Math.hypot(stage.widthPx, stage.heightPx);

    for (const meteor of all) {
      const headX = stage.leftPx + meteor.x * stage.widthPx;
      const headY = stage.topPx + meteor.y * stage.heightPx;
      const tail = meteor.length * diagonal;
      const tailX = headX - Math.cos(meteor.angleRad) * tail;
      const tailY = headY - Math.sin(meteor.angleRad) * tail;

      // A gradient along the streak, so it fades out behind the head instead of ending.
      const ramp = ctx.createLinearGradient(tailX, tailY, headX, headY);
      ramp.addColorStop(0, withAlpha(meteor.color, 0));
      ramp.addColorStop(1, withAlpha(meteor.color, Math.max(0, Math.min(1, meteor.alpha))));
      ctx.strokeStyle = ramp;
      ctx.lineWidth = Math.max(1, diagonal * 0.0035);
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(headX, headY);
      ctx.stroke();

      // A small head, so the eye reads a direction rather than a scratch.
      ctx.fillStyle = withAlpha(meteor.color, Math.max(0, Math.min(1, meteor.alpha)) * 0.9);
      ctx.beginPath();
      ctx.arc(headX, headY, Math.max(1, diagonal * 0.0045), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The small lights around a caption.
   *
   * Four-pointed stars rather than dots: a dot beside text reads as a speck of dust, and
   * the shape is what makes it a twinkle. Drawn after the text and at the text's own
   * opacity, so they arrive and leave with it.
   */
  private drawSparkles(box: Box, state: EffectState, opacity: number): void {
    if (state.sparkles.length === 0) return;
    const { ctx } = this;
    const width = box.rightPx - box.leftPx;
    const height = box.bottomPx - box.topPx;
    const unit = Math.max(2, height * 0.22);

    ctx.save();
    for (const sparkle of state.sparkles) {
      const alpha = sparkle.alpha * opacity;
      if (alpha <= 0.01) continue;
      const x = box.leftPx + sparkle.x * width;
      const y = box.topPx + sparkle.y * height;
      // Grows as it appears and shrinks as it goes, which is what makes it twinkle
      // rather than blink.
      const size = unit * sparkle.size * (0.55 + 0.45 * Math.sin(sparkle.progress * Math.PI));

      ctx.fillStyle = withAlpha(sparkle.color, Math.min(1, alpha));
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.quadraticCurveTo(x, y, x + size, y);
      ctx.quadraticCurveTo(x, y, x, y + size);
      ctx.quadraticCurveTo(x, y, x - size, y);
      ctx.quadraticCurveTo(x, y, x, y - size);
      ctx.fill();
    }
    ctx.restore();
  }

  /** The playfield, its centre line and the judgement line, so a position means something. */
  private drawPlayfield(stage: StageRect): void {
    const { ctx } = this;
    ctx.fillStyle = theme.decoration.stageBackground;
    ctx.fillRect(stage.leftPx, stage.topPx, stage.widthPx, stage.heightPx);

    ctx.strokeStyle = theme.decoration.stageGuide;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    const midX = Math.round(stage.leftPx + stage.widthPx / 2) + 0.5;
    ctx.moveTo(midX, stage.topPx);
    ctx.lineTo(midX, stage.topPx + stage.heightPx);
    const midY = Math.round(stage.topPx + stage.heightPx / 2) + 0.5;
    ctx.moveTo(stage.leftPx, midY);
    ctx.lineTo(stage.leftPx + stage.widthPx, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // y = 1 is the judgement line: the one edge of the playfield with a name.
    ctx.strokeStyle = theme.decoration.stageJudgement;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const judgement = Math.round(stage.topPx + stage.heightPx) - 1;
    ctx.moveTo(stage.leftPx, judgement);
    ctx.lineTo(stage.leftPx + stage.widthPx, judgement);
    ctx.stroke();

    ctx.strokeStyle = theme.decoration.stageBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(stage.leftPx) + 0.5,
      Math.round(stage.topPx) + 0.5,
      Math.round(stage.widthPx) - 1,
      Math.round(stage.heightPx) - 1,
    );
  }

  /**
   * One decoration, and the box it turned out to occupy.
   *
   * The box is measured from what was actually drawn - the canvas's own text metrics -
   * rather than estimated, so what an author clicks is exactly what they can see. It is
   * handed back rather than stored, so the hit test uses the boxes from the frame the
   * author is looking at.
   */
  private drawDecoration(
    decoration: ChartDecoration,
    stage: StageRect,
    opacity: number,
    scale: number,
    state: EffectState,
  ): Box {
    const { ctx } = this;
    const style = resolveTextStyle(decoration.style);
    const { xPx, yPx } = stagePoint(decoration.position, stage);
    const fontPx = style.fontSize * stage.heightPx;
    const label = isTextDecoration(decoration)
      ? (decoration.text ?? "")
      : `<${decoration.type}>`;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.translate(xPx, yPx);
    if (style.rotationDeg !== 0) ctx.rotate((style.rotationDeg * Math.PI) / 180);
    if (scale !== 1) ctx.scale(scale, scale);

    ctx.font = `${style.fontWeight} ${fontPx}px ${style.fontFamily}`;
    ctx.textAlign = style.align;
    ctx.textBaseline = "middle";

    const widthPx = label === "" ? 0 : ctx.measureText(label).width;
    if (label !== "") {
      // The left edge of the text in this local space, which the gradient and the
      // shimmer both need and which `textAlign` alone does not give.
      const leftPx =
        style.align === "left" ? 0 : style.align === "right" ? -widthPx : -widthPx / 2;

      const glow = resolveGlow(decoration.style?.glow);
      if (glow) {
        // A shadow with no offset is a glow, and it is the one blur a canvas does
        // cheaply. Drawn as its own pass so the blur never lands on the fill that
        // follows - the letters stay as crisp as they were before the glow existed.
        ctx.save();
        ctx.shadowColor = withAlpha(glow.color, glow.intensity);
        ctx.shadowBlur = glow.radius * stage.heightPx;
        ctx.fillStyle = withAlpha(glow.color, Math.min(1, glow.intensity * 0.85));
        // Twice, because one pass of a canvas shadow is fainter than the eye expects.
        ctx.fillText(label, 0, 0);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }

      if (style.strokeWidth > 0) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeStyle = style.strokeColor;
        // Doubled because a canvas stroke straddles the glyph edge, so half of it is
        // painted over by the fill that follows.
        ctx.lineWidth = style.strokeWidth * stage.heightPx * 2;
        ctx.strokeText(label, 0, 0);
      }

      const gradient = resolveGradient(decoration.style?.gradient);
      ctx.fillStyle = gradient
        ? this.gradientFor(gradient, leftPx, widthPx, state.gradientPhase)
        : style.color;
      ctx.fillText(label, 0, 0);

      // The shimmer rides on top of the fill, clipped to the letters themselves, so it
      // travels across the word rather than across the box the word sits in.
      if (state.shimmer !== null && state.shimmerAlpha > 0.01 && widthPx > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(leftPx, -fontPx, widthPx, fontPx * 2);
        ctx.clip();
        const centre = leftPx + state.shimmer * widthPx;
        const half = Math.max(4, widthPx * 0.16);
        const sweep = ctx.createLinearGradient(centre - half, 0, centre + half, 0);
        const peak = Math.min(1, state.shimmerAlpha);
        sweep.addColorStop(0, "rgba(255,255,255,0)");
        sweep.addColorStop(0.5, `rgba(255,255,255,${peak.toFixed(3)})`);
        sweep.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sweep;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();

    // Measured at scale 1: the box is what the author aims at, and a target that shrank
    // and grew through an animation would be a target they could not hit.
    return stageTextBox(decoration, stage, widthPx);
  }

  /**
   * The colour ramp for one caption, reused between frames where it can be.
   *
   * A `CanvasGradient` cannot be moved once built, so a drifting ramp needs a new one
   * whenever the phase changes. Quantising the phase into a fixed number of steps means
   * one object per step instead of one per frame - about six times fewer at sixty frames
   * a second over an eight-second cycle - and the step is far finer than the eye can
   * follow on a slow drift.
   *
   * The ramp is laid out over twice the text's width and offset by the phase, with the
   * colours repeated, so the ends meet and the drift has no seam.
   */
  private gradientFor(
    gradient: ResolvedGradient,
    leftPx: number,
    widthPx: number,
    phase: number,
  ): CanvasGradient | string {
    if (widthPx <= 0) return gradient.colors[0] as string;
    const step = Math.round(phase * GRADIENT_PHASE_STEPS) % GRADIENT_PHASE_STEPS;
    const key = `${gradient.colors.join()}|${gradient.angleDeg}|${Math.round(widthPx)}|${step}`;
    const cached = this.gradients.get(key);
    if (cached) return cached;

    const radians = (gradient.angleDeg * Math.PI) / 180;
    const spanX = Math.cos(radians) * widthPx;
    const spanY = Math.sin(radians) * widthPx;
    const offset = (step / GRADIENT_PHASE_STEPS) * widthPx;
    const startX = leftPx - offset;
    const ramp = this.ctx.createLinearGradient(
      startX, -spanY / 2, startX + spanX * 2, spanY / 2 + spanY,
    );
    // Twice round the colours, so the ramp is continuous as it slides.
    const stops = [...gradient.colors, ...gradient.colors, gradient.colors[0] as string];
    stops.forEach((color, index) => {
      ramp.addColorStop(index / (stops.length - 1), color);
    });

    // A small bound: the cache exists to stop per-frame allocation, not to remember
    // every caption a session ever drew.
    if (this.gradients.size > GRADIENT_CACHE_LIMIT) this.gradients.clear();
    this.gradients.set(key, ramp);
    return ramp;
  }

  /** A dashed box around a selected decoration, so an empty caption is still visible. */
  private drawSelection(box: Box): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = theme.decoration.stageSelection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      Math.round(box.leftPx) - 2.5,
      Math.round(box.topPx) - 2.5,
      Math.round(box.rightPx - box.leftPx) + 5,
      Math.round(box.bottomPx - box.topPx) + 5,
    );
    ctx.restore();
  }
}
