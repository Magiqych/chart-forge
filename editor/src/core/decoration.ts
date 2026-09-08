/**
 * Decorations: what the author puts *over* the playfield, as opposed to what the player
 * hits.
 *
 * A Decoration is not a Note and must never become one. A Note is a gameplay object -
 * it has a lane, it is judged, it is scored, and removing one changes what the chart
 * asks of the player. A Decoration is presentation: nothing is judged, nothing is
 * scored, and a Player that skips this module entirely plays exactly the same chart.
 * That is why they live in their own array in the document, carry their own kind of id,
 * and are moved by their own commands. A `textNote` would have put a thing with no lane
 * and no judgement into the list of things that have both, and every function that reads
 * a note would have had to learn to ignore it.
 *
 * Version 0.1 defines one kind, `text`. `type` is an open vocabulary exactly as
 * `chartNote.type` is, so a document may carry a kind this Editor has never heard of;
 * those are read, listed and written back untouched rather than dropped. There are no
 * empty definitions here for the kinds that do not exist yet - an Image decoration will
 * arrive with its own fields when there is something real to draw.
 *
 * Everything in this module is pure and knows nothing about a canvas, a chart state or
 * React, so the display rules - which are the ones a player actually sees - can be tested
 * as arithmetic.
 */

/** Which part of a text `position.x` names. */
export const TEXT_ALIGNMENTS = ["left", "center", "right"] as const;
export type TextAlign = (typeof TEXT_ALIGNMENTS)[number];

/**
 * Font families a chart may ask for.
 *
 * Logical families only, and no font file is ever named or embedded. A chart is a
 * document that has to draw the same words on a machine that has never heard of the
 * author's fonts, and "Hiragino Kaku Gothic ProN" is a fact about one computer. All
 * three carry Japanese on every platform this Editor runs on.
 */
export const FONT_FAMILIES = ["sans-serif", "serif", "monospace"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/**
 * The effects 0.1 defines for arriving and leaving.
 *
 * Three, deliberately: `none` so an author can turn it off, `fade` because opacity is the
 * one effect every renderer can do identically, and `scale` because a caption that pops
 * reads as deliberate where one that simply appears reads as a glitch. The directional
 * slides are a natural fourth, fifth and sixth and are not here, because each needs a
 * decision about what it slides *relative to* - the playfield, the text's own size, or a
 * fixed distance - and that decision is worth making with real charts in hand.
 *
 * Closed rather than open, unlike `type`: a reader that meets an effect it does not know
 * draws the decoration without the effect, which `animationKindOf` below is what enforces.
 */
export const ANIMATION_KINDS = ["none", "fade", "scale"] as const;
export type AnimationKind = (typeof ANIMATION_KINDS)[number];

/**
 * Where a decoration sits, in the playfield's own coordinates rather than the screen's.
 *
 * `x` runs 0 at the left edge to 1 at the right, `y` runs 0 at the far edge to 1 at the
 * judgement line. Normalized because a chart is authored once and drawn at whatever size
 * the player's screen happens to be: a pixel would name a different place on every
 * device, and an author who lined a caption up with the centre lane would find it
 * somewhere else on a phone.
 */
export interface DecorationPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * How a text decoration is drawn. Every field optional, every field defaulted.
 *
 * `fontSize` and `strokeWidth` are fractions of the playfield's height for the same
 * reason `position` is normalized: a size in pixels would be a different size on every
 * screen, and text that fitted the playfield on one would overflow it on another.
 */
export interface TextDecorationStyle {
  readonly fontFamily?: FontFamily;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly align?: TextAlign;
  readonly rotationDeg?: number;
  readonly opacity?: number;
  readonly color?: string;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
}

/** How a decoration arrives and leaves. Every field optional, every field defaulted. */
export interface DecorationAnimation {
  readonly enter?: AnimationKind;
  readonly enterDurationSec?: number;
  readonly exit?: AnimationKind;
  readonly exitDurationSec?: number;
}

/**
 * One decoration, as the document holds it.
 *
 * The kind-specific fields - `text`, `style`, `animation` - are optional on the one
 * interface rather than split into a union, which is exactly how `ChartNote` carries
 * `endTimeSec`, `waypoints` and `direction`. It is the same trade for the same reason:
 * `type` is open, so a union would have to close it, and an unfamiliar kind has to
 * survive a load and a save unchanged.
 */
export interface ChartDecoration {
  readonly id: string;
  /** Open vocabulary. `text` is the only kind this Editor authors. */
  readonly type: string;
  readonly startTimeSec: number;
  /** Absent means "show it for the default duration", never "show it forever". */
  readonly endTimeSec?: number;
  readonly position: DecorationPosition;
  /** Present on a text decoration. An empty string is a caption not written yet. */
  readonly text?: string;
  readonly style?: TextDecorationStyle;
  readonly animation?: DecorationAnimation;
  readonly zIndex?: number;
  readonly metadata?: Record<string, unknown>;
}

/** Whether this Editor knows how to draw and edit this decoration. */
export function isTextDecoration(decoration: ChartDecoration): boolean {
  return decoration.type === "text";
}

/**
 * How long a decoration with no `endTimeSec` is shown.
 *
 * A second: long enough to read a short caption at a glance, short enough that an author
 * who wanted longer notices immediately and says so. It is a *reader's* assumption and
 * nothing else - the contract is explicit that it must never be written back into the
 * document, because a value the author did not choose would then be indistinguishable
 * from one they did, and this Editor's taste would be frozen into their file.
 */
export const DEFAULT_DISPLAY_DURATION_SEC = 1;

/**
 * The shortest a decoration may be shrunk to by dragging one of its edges.
 *
 * The same epsilon a held note uses, for the same reason: a window of no length shows
 * nothing, and stopping the drag reads better than refusing it.
 */
export const MIN_DECORATION_DURATION_SEC = 0.01;

/** How small `scale` starts from, and shrinks to. */
export const SCALE_ANIMATION_FROM = 0.6;

/** A fully decided style: what the renderer actually draws with. */
export interface ResolvedTextStyle {
  readonly fontFamily: FontFamily;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly align: TextAlign;
  readonly rotationDeg: number;
  readonly opacity: number;
  readonly color: string;
  readonly strokeColor: string;
  readonly strokeWidth: number;
}

/**
 * What a text decoration looks like when it says nothing about how it should look.
 *
 * White, because the playfield behind it is dark and a caption has to be readable before
 * it is anything else; centred, because `position` names a point and the middle of the
 * text is the least surprising thing for a point to name; and no outline, because an
 * outline is a decision an author makes about a specific background rather than a thing
 * they always want.
 */
export const DEFAULT_TEXT_STYLE: ResolvedTextStyle = {
  fontFamily: "sans-serif",
  fontSize: 0.06,
  fontWeight: 400,
  align: "center",
  rotationDeg: 0,
  opacity: 1,
  color: "#ffffff",
  strokeColor: "#000000",
  strokeWidth: 0,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function usableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Fill in whatever the author left unsaid.
 *
 * Defaults are applied here, at the moment of drawing, and never written back. A value
 * outside its documented range is replaced by the default rather than clamped: the
 * document has already been through the contract, so anything arriving here out of range
 * came from somewhere that does not answer to it, and guessing what an author meant by
 * an opacity of 5 is worse than drawing the caption they can see and fix.
 */
export function resolveTextStyle(style?: TextDecorationStyle): ResolvedTextStyle {
  if (!style) return DEFAULT_TEXT_STYLE;
  const d = DEFAULT_TEXT_STYLE;
  return {
    fontFamily: (FONT_FAMILIES as readonly string[]).includes(style.fontFamily ?? "")
      ? (style.fontFamily as FontFamily)
      : d.fontFamily,
    fontSize:
      usableNumber(style.fontSize) && style.fontSize > 0 && style.fontSize <= 1
        ? style.fontSize
        : d.fontSize,
    fontWeight:
      usableNumber(style.fontWeight) && style.fontWeight >= 100 && style.fontWeight <= 900
        ? Math.round(style.fontWeight)
        : d.fontWeight,
    align: (TEXT_ALIGNMENTS as readonly string[]).includes(style.align ?? "")
      ? (style.align as TextAlign)
      : d.align,
    rotationDeg: usableNumber(style.rotationDeg) ? style.rotationDeg : d.rotationDeg,
    opacity:
      usableNumber(style.opacity) && style.opacity >= 0 && style.opacity <= 1
        ? style.opacity
        : d.opacity,
    color: typeof style.color === "string" && HEX_COLOR.test(style.color) ? style.color : d.color,
    strokeColor:
      typeof style.strokeColor === "string" && HEX_COLOR.test(style.strokeColor)
        ? style.strokeColor
        : d.strokeColor,
    strokeWidth:
      usableNumber(style.strokeWidth) && style.strokeWidth >= 0 && style.strokeWidth <= 1
        ? style.strokeWidth
        : d.strokeWidth,
  };
}

/** An effect this version implements, or `none` for one it does not. */
export function animationKindOf(value: unknown): AnimationKind {
  return (ANIMATION_KINDS as readonly string[]).includes(value as string)
    ? (value as AnimationKind)
    : "none";
}

/** Hold a value inside 0..1. Used wherever a pointer can carry a position off the edge. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Hold a position inside the playfield.
 *
 * Clamped rather than refused, and clamped per axis rather than as a pair, so dragging a
 * caption off the right edge slides it along the edge instead of stopping the whole
 * gesture dead. Outside 0..1 is not a place the contract can express, so there is nothing
 * to preserve by letting it through.
 */
export function clampPosition(position: DecorationPosition): DecorationPosition {
  return { x: clampUnit(position.x), y: clampUnit(position.y) };
}

/**
 * When a decoration is on screen, start and end.
 *
 * The one place the missing-`endTimeSec` rule lives, so the renderer, the hit test, the
 * timeline row and the inspector all answer the question the same way. A stored end that
 * is not after the start is treated as no end at all rather than as a window of zero
 * length: the contract forbids it, so a document carrying one is already wrong, and
 * showing the caption for a second is a more useful reading than never showing it.
 */
export function displayWindow(
  decoration: ChartDecoration,
): { readonly startSec: number; readonly endSec: number } {
  const startSec = usableNumber(decoration.startTimeSec) ? decoration.startTimeSec : 0;
  const end = decoration.endTimeSec;
  if (usableNumber(end) && end > startSec) return { startSec, endSec: end };
  return { startSec, endSec: startSec + DEFAULT_DISPLAY_DURATION_SEC };
}

/** How long it is shown, whether or not it says so. */
export function displayDurationSec(decoration: ChartDecoration): number {
  const window = displayWindow(decoration);
  return window.endSec - window.startSec;
}

/**
 * The entrance and exit lengths a window can actually accommodate.
 *
 * An author can ask for a half-second entrance on a caption that lasts a fifth of a
 * second, and a Player has to do something sensible rather than run the entrance past the
 * exit and leave the opacity somewhere undefined. Both are scaled by the same factor so
 * their proportion survives, which keeps a long entrance and a short exit looking like a
 * long entrance and a short exit even when the whole thing is compressed.
 */
export function fittedAnimation(
  decoration: ChartDecoration,
): { readonly enterSec: number; readonly exitSec: number } {
  const animation = decoration.animation;
  const wanted = (value: unknown): number =>
    usableNumber(value) && value > 0 ? value : 0;
  let enterSec = wanted(animation?.enterDurationSec);
  let exitSec = wanted(animation?.exitDurationSec);
  if (animationKindOf(animation?.enter) === "none") enterSec = 0;
  if (animationKindOf(animation?.exit) === "none") exitSec = 0;

  const total = enterSec + exitSec;
  const window = displayDurationSec(decoration);
  if (total > window && total > 0) {
    const factor = window / total;
    enterSec *= factor;
    exitSec *= factor;
  }
  return { enterSec, exitSec };
}

/** What a decoration looks like at one instant. */
export interface DecorationAppearance {
  readonly visible: boolean;
  /** The style's own opacity with any animation applied. */
  readonly opacity: number;
  /** 1 unless an animation is shrinking or growing it. */
  readonly scale: number;
}

const HIDDEN: DecorationAppearance = { visible: false, opacity: 0, scale: 1 };

/**
 * Whether a decoration is on screen at `timeSec`, and how far through its arrival or
 * departure it is.
 *
 * The whole display rule in one pure function, because this is what a viewer actually
 * experiences and it is the part most easily got subtly wrong: an off-by-one at the
 * boundary, an entrance that never reaches full opacity, a zero-length animation that
 * divides by zero. Both ends of the window are inclusive, so a caption is on screen at
 * the instant it starts and at the instant it ends.
 */
export function decorationAppearance(
  decoration: ChartDecoration,
  timeSec: number,
): DecorationAppearance {
  if (!Number.isFinite(timeSec)) return HIDDEN;
  const { startSec, endSec } = displayWindow(decoration);
  if (timeSec < startSec || timeSec > endSec) return HIDDEN;

  const style = resolveTextStyle(decoration.style);
  const { enterSec, exitSec } = fittedAnimation(decoration);

  // How far through the phase we are, 0 at the outer edge and 1 at full presence. An
  // entrance runs forwards from the start, an exit backwards from the end, so the same
  // number means "fully arrived" in both and one curve serves for both.
  let progress = 1;
  let kind: AnimationKind = "none";
  if (enterSec > 0 && timeSec < startSec + enterSec) {
    progress = (timeSec - startSec) / enterSec;
    kind = animationKindOf(decoration.animation?.enter);
  } else if (exitSec > 0 && timeSec > endSec - exitSec) {
    progress = (endSec - timeSec) / exitSec;
    kind = animationKindOf(decoration.animation?.exit);
  }
  progress = progress < 0 ? 0 : progress > 1 ? 1 : progress;

  return {
    visible: true,
    opacity: style.opacity * (kind === "fade" ? progress : 1),
    scale: kind === "scale" ? SCALE_ANIMATION_FROM + (1 - SCALE_ANIMATION_FROM) * progress : 1,
  };
}

/** Whether it is on screen at all, without working out how it looks. */
export function isDisplayedAt(decoration: ChartDecoration, timeSec: number): boolean {
  return decorationAppearance(decoration, timeSec).visible;
}

/**
 * Document order: ascending start, then id.
 *
 * The contract requires the list to ascend by `startTimeSec` so a Player can stream it
 * beside the notes. Two decorations may legitimately start together - a caption and its
 * shadow - so the tie-break has to be total, or serialisation would not be stable.
 */
export function compareDecorations(a: ChartDecoration, b: ChartDecoration): number {
  if (a.startTimeSec !== b.startTimeSec) return a.startTimeSec - b.startTimeSec;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Painting order: back to front.
 *
 * `zIndex` first, then document order, so the answer never depends on the order the list
 * happened to be built in. Separate from `compareDecorations` on purpose - the document's
 * order is a streaming guarantee and this is a drawing decision, and a renderer that
 * sorted by `zIndex` on disk would keep rewriting the file every time an author changed
 * which caption was in front.
 */
export function paintOrder(
  decorations: readonly ChartDecoration[],
): readonly ChartDecoration[] {
  return [...decorations].sort((a, b) => {
    const az = a.zIndex ?? 0;
    const bz = b.zIndex ?? 0;
    if (az !== bz) return az - bz;
    return compareDecorations(a, b);
  });
}

/** Those on screen at an instant, back to front. */
export function decorationsAt(
  decorations: readonly ChartDecoration[],
  timeSec: number,
): readonly ChartDecoration[] {
  return paintOrder(decorations).filter((decoration) => isDisplayedAt(decoration, timeSec));
}
