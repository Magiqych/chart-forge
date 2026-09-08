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

export class StageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

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

    for (const decoration of paintOrder(scene.decorations)) {
      const appearance = decorationAppearance(decoration, scene.timeSec);
      if (!appearance.visible && !scene.showOutOfWindow) continue;
      // Out of its window it is drawn at a fixed ghost opacity rather than at whatever
      // its animation would have given it, so "faint" always means "not on screen yet"
      // and never "mid-fade".
      const opacity = appearance.visible ? appearance.opacity : GHOST_OPACITY;
      const scale = appearance.visible ? appearance.scale : 1;
      const box = this.drawDecoration(decoration, stage, opacity, scale);
      boxes.push({ decoration, box });
      if (selected.has(decoration.id)) this.drawSelection(box);
    }

    return { stage, boxes };
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
      if (style.strokeWidth > 0) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeStyle = style.strokeColor;
        // Doubled because a canvas stroke straddles the glyph edge, so half of it is
        // painted over by the fill that follows.
        ctx.lineWidth = style.strokeWidth * stage.heightPx * 2;
        ctx.strokeText(label, 0, 0);
      }
      ctx.fillStyle = style.color;
      ctx.fillText(label, 0, 0);
    }
    ctx.restore();

    // Measured at scale 1: the box is what the author aims at, and a target that shrank
    // and grew through an animation would be a target they could not hit.
    return stageTextBox(decoration, stage, widthPx);
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
