/**
 * Where a decoration is drawn, on each of the two surfaces that show one.
 *
 * The Editor deliberately shows a decoration in two places, because a decoration has two
 * independent coordinates and the timeline can only express one of them. The timeline's
 * axes are time and lane; a decoration has time and a *position on the playfield*, which
 * is not a lane and cannot be drawn as one. Putting both on the timeline would mean
 * dragging a caption upwards to move it up the playfield, on an axis where upwards
 * already means a different lane - and an author who nudged a caption sideways would
 * change when it appears.
 *
 * So:
 *
 *   the timeline row  answers "when is this shown", and is dragged in time;
 *   the stage         answers "where on the playfield", and is dragged in space.
 *
 * Each surface edits exactly the coordinates it can show, and neither can change the
 * other's behind the author's back. Both live here, as pure geometry, so hit testing and
 * drawing cannot drift apart and both can be tested without a canvas.
 */

import { displayWindow, resolveTextStyle, type ChartDecoration } from "./decoration";
import type { LayoutRow } from "./lanes";
import { timeToX, type Viewport } from "./viewport";

/** A rectangle in canvas pixels. */
export interface Box {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
}

/**
 * How narrow a decoration's bar may get before it is widened for the hand.
 *
 * A decoration's bar is as wide as its window, and a short window at a wide zoom is a
 * bar a few pixels across - or none at all. Widening it keeps the thing selectable at
 * every zoom, which matters more here than for a note: a note is a marker of fixed width
 * by construction, and this is the only object in the Editor whose drawn size can go to
 * nothing.
 */
export const MIN_DECORATION_WIDTH_PX = 10;

/** Space kept above and below the bar inside its row. */
const ROW_PADDING_PX = 6;

/** The grip at each end of the bar, in pixels. Matches a held note's, so the hand learns one. */
export const DECORATION_HANDLE_PX = 9;

/**
 * How wide the bar has to be drawn before it offers grips.
 *
 * The same rule a held note follows: two grips on a bar with nothing between them leave
 * a decoration that can be stretched but never moved, and moving is the commoner thing
 * to want.
 */
export const MIN_GRIP_BAR_PX = DECORATION_HANDLE_PX * 3;

/** Which part of a decoration's bar a pointer is nearest. */
export type DecorationPart = "body" | "startHandle" | "endHandle";

export interface DecorationRowGeometry {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  /** Where the window actually starts, before any widening for the hand. */
  readonly startPx: number;
  readonly endPx: number;
  readonly startHandle: Box | null;
  readonly endHandle: Box | null;
}

/**
 * The bar for one decoration on the timeline.
 *
 * Drawn from `displayWindow`, so a decoration that leaves its end to the reader is drawn
 * with the length it will actually be shown for rather than as an instant. That is the
 * whole reason the default lives in one function: an author has to be able to see the
 * second they did not ask for.
 */
export function decorationRowGeometry(
  decoration: ChartDecoration,
  row: LayoutRow,
  view: Viewport,
): DecorationRowGeometry {
  const { startSec, endSec } = displayWindow(decoration);
  const startPx = timeToX(startSec, view);
  const endPx = timeToX(endSec, view);

  const width = Math.max(endPx - startPx, MIN_DECORATION_WIDTH_PX);
  const leftPx = startPx;
  const rightPx = startPx + width;
  const topPx = row.topPx + ROW_PADDING_PX;
  const bottomPx = row.bottomPx - ROW_PADDING_PX;

  const grip = (atPx: number): Box => ({
    leftPx: atPx - DECORATION_HANDLE_PX / 2,
    rightPx: atPx + DECORATION_HANDLE_PX / 2,
    topPx,
    bottomPx,
  });
  const roomy = rightPx - leftPx >= MIN_GRIP_BAR_PX;

  return {
    leftPx,
    rightPx,
    topPx,
    bottomPx,
    startPx,
    endPx,
    startHandle: roomy ? grip(leftPx) : null,
    endHandle: roomy ? grip(rightPx) : null,
  };
}

function distanceToBox(x: number, y: number, box: Box): number {
  const dx = x < box.leftPx ? box.leftPx - x : x > box.rightPx ? x - box.rightPx : 0;
  const dy = y < box.topPx ? box.topPx - y : y > box.bottomPx ? y - box.bottomPx : 0;
  return Math.hypot(dx, dy);
}

/** How close a press has to be to a decoration's bar to land on it. */
export const DECORATION_HIT_TOLERANCE_PX = 4;

export interface DecorationHit {
  readonly decoration: ChartDecoration;
  readonly distancePx: number;
  readonly part: DecorationPart;
}

/**
 * The decoration under a pointer on the timeline, or null.
 *
 * The grips keep ties against the body, exactly as a held note's do: the point of a grip
 * is that pressing it grips rather than doing whatever is underneath.
 *
 * Later decorations win a tie rather than earlier ones, because a decoration drawn later
 * is drawn on top, and clicking has to select what the author can see.
 */
export function hitTestDecoration(
  x: number,
  y: number,
  decorations: readonly ChartDecoration[],
  row: LayoutRow,
  view: Viewport,
  tolerancePx: number = DECORATION_HIT_TOLERANCE_PX,
): DecorationHit | null {
  let best: DecorationHit | null = null;
  for (const decoration of decorations) {
    const geometry = decorationRowGeometry(decoration, row, view);
    if (geometry.rightPx < 0 || geometry.leftPx > view.widthPx) continue;

    let part: DecorationPart = "body";
    let distance = distanceToBox(x, y, geometry);
    // Both grips take ties from the body they sit on: pressing a grip has to grip, and at
    // either edge of the bar the distance to the body is zero as well. They cannot tie
    // with each other - a bar narrower than `MIN_GRIP_BAR_PX` has no grips at all, so
    // when they exist they are always further apart than the tolerance.
    if (geometry.startHandle) {
      const toStart = distanceToBox(x, y, geometry.startHandle);
      if (toStart <= distance) {
        part = "startHandle";
        distance = toStart;
      }
    }
    if (geometry.endHandle) {
      const toEnd = distanceToBox(x, y, geometry.endHandle);
      if (toEnd <= distance) {
        part = "endHandle";
        distance = toEnd;
      }
    }
    if (distance > tolerancePx) continue;
    if (best === null || distance <= best.distancePx) {
      best = { decoration, distancePx: distance, part };
    }
  }
  return best;
}

/** Every decoration whose bar meets a rubber band. */
export function decorationsInRect(
  rect: Box,
  decorations: readonly ChartDecoration[],
  row: LayoutRow,
  view: Viewport,
): readonly ChartDecoration[] {
  return decorations.filter((decoration) => {
    const geometry = decorationRowGeometry(decoration, row, view);
    return (
      geometry.rightPx >= rect.leftPx &&
      geometry.leftPx <= rect.rightPx &&
      geometry.bottomPx >= rect.topPx &&
      geometry.topPx <= rect.bottomPx
    );
  });
}

// --------------------------------------------------------------------------------
// The stage: the playfield, drawn in its own normalized coordinates
// --------------------------------------------------------------------------------

/**
 * Where the playfield is drawn, in canvas pixels.
 *
 * A rectangle rather than the whole canvas, so the stage can keep the playfield's aspect
 * ratio inside whatever space the window gives it. Everything below converts through
 * this and nothing assumes the canvas itself is the playfield.
 */
export interface StageRect {
  readonly leftPx: number;
  readonly topPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * Fit a playfield of a given aspect ratio inside a canvas, centred.
 *
 * Letterboxed rather than stretched: the whole point of normalized coordinates is that
 * the author sees the proportions a player will, and a stage that stretched with the
 * window would move every caption every time the window was resized.
 */
export function fitStage(
  widthPx: number,
  heightPx: number,
  aspect: number,
  paddingPx = 0,
): StageRect {
  const availableWidth = Math.max(0, widthPx - paddingPx * 2);
  const availableHeight = Math.max(0, heightPx - paddingPx * 2);
  const byWidth = availableWidth / aspect;
  const stageHeight = Math.min(availableHeight, byWidth);
  const stageWidth = stageHeight * aspect;
  return {
    leftPx: paddingPx + (availableWidth - stageWidth) / 2,
    topPx: paddingPx + (availableHeight - stageHeight) / 2,
    widthPx: stageWidth,
    heightPx: stageHeight,
  };
}

/** A normalized position, in canvas pixels. */
export function stagePoint(
  position: { readonly x: number; readonly y: number },
  stage: StageRect,
): { readonly xPx: number; readonly yPx: number } {
  return {
    xPx: stage.leftPx + position.x * stage.widthPx,
    yPx: stage.topPx + position.y * stage.heightPx,
  };
}

/** A point in canvas pixels, back in normalized coordinates. Not clamped. */
export function stagePosition(
  xPx: number,
  yPx: number,
  stage: StageRect,
): { readonly x: number; readonly y: number } {
  return {
    x: stage.widthPx === 0 ? 0 : (xPx - stage.leftPx) / stage.widthPx,
    y: stage.heightPx === 0 ? 0 : (yPx - stage.topPx) / stage.heightPx,
  };
}

/**
 * Roughly how wide a string is, in ems.
 *
 * A fallback for the hit test before anything has been measured, and only that: the
 * renderer measures for real and hands the answer back. Full-width characters count as a
 * whole em and everything else as roughly six tenths, which is close enough to keep a
 * Japanese caption's box around its Japanese caption.
 */
export function estimateTextEms(text: string): number {
  let ems = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // The CJK, kana and full-width ranges, which is what "wide" means in practice here.
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    ems += wide ? 1 : 0.6;
  }
  return ems;
}

/**
 * The box a decoration occupies on the stage.
 *
 * `widthPx` is passed in rather than worked out, so the renderer can hand over what the
 * canvas actually measured and the hit test can be checked with a number in a test. The
 * box is grown to a minimum in both directions: an empty caption, or one holding a single
 * thin character, would otherwise be a target too small to click, and a decoration an
 * author cannot select is a decoration they cannot delete.
 *
 * Rotation is deliberately not applied. The box is the axis-aligned area the author
 * clicks, and a rotated caption that stayed selectable by its upright box is far less
 * surprising than one whose target moved out from under the pointer.
 */
export const MIN_STAGE_HIT_PX = 16;

export function stageTextBox(
  decoration: ChartDecoration,
  stage: StageRect,
  widthPx: number,
): Box {
  const style = resolveTextStyle(decoration.style);
  const { xPx, yPx } = stagePoint(decoration.position, stage);
  const heightPx = Math.max(style.fontSize * stage.heightPx, MIN_STAGE_HIT_PX);
  const width = Math.max(widthPx, MIN_STAGE_HIT_PX);

  const leftPx =
    style.align === "left" ? xPx : style.align === "right" ? xPx - width : xPx - width / 2;
  return {
    leftPx,
    rightPx: leftPx + width,
    topPx: yPx - heightPx / 2,
    bottomPx: yPx + heightPx / 2,
  };
}

/**
 * The decoration under a pointer on the stage, or null.
 *
 * Front to back, so the one drawn on top is the one selected - the opposite order to the
 * painting, and the reason `paintOrder` is a separate function from this.
 */
export function hitTestStage(
  xPx: number,
  yPx: number,
  boxes: readonly { readonly decoration: ChartDecoration; readonly box: Box }[],
): ChartDecoration | null {
  for (let index = boxes.length - 1; index >= 0; index -= 1) {
    const entry = boxes[index] as { decoration: ChartDecoration; box: Box };
    if (distanceToBox(xPx, yPx, entry.box) === 0) return entry.decoration;
  }
  return null;
}
