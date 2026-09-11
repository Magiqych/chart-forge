/**
 * Drawing the chart's decorations.
 *
 * A Decoration is not a Note. Nothing here is hit, judged or scored, and a Player that
 * ignored this file entirely would play exactly the same chart - which is why every
 * failure in it is a shrug rather than an error. A kind this Player has never heard of
 * is skipped and counted; a style value out of range is replaced by its default at the
 * moment of drawing, and the document is left exactly as the author wrote it.
 *
 * The defaults below are the contract's own, quoted from `schemas/chart.schema.json`:
 * sans-serif, 0.06 of the playfield's height, weight 400, centred, no rotation, opaque,
 * white on a black outline of zero width. They are not written into anything.
 *
 * What is *not* implemented: `effects` - shimmer, sparkle and meteors. They are optional
 * and additive, and the contract says a reader that ignores them "draws a still caption,
 * which is a correct reading of the chart". Gameplay came first tonight; this is the
 * honest place to stop.
 */

const DEFAULTS = {
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

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_FAMILIES = ["sans-serif", "serif", "monospace"];
const ALIGNMENTS = ["left", "center", "right"];

/** How small a `scale` entrance starts at. The Editor uses the same figure. */
export const SCALE_ANIMATION_FROM = 0.6;

function number(value, low, high, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : fallback;
}

export function resolveStyle(style) {
  if (typeof style !== "object" || style === null) return { ...DEFAULTS, gradient: null, glow: null };
  return {
    fontFamily: FONT_FAMILIES.includes(style.fontFamily) ? style.fontFamily : DEFAULTS.fontFamily,
    fontSize: typeof style.fontSize === "number" && style.fontSize > 0 && style.fontSize <= 1 ? style.fontSize : DEFAULTS.fontSize,
    fontWeight: Math.round(number(style.fontWeight, 100, 900, DEFAULTS.fontWeight)),
    align: ALIGNMENTS.includes(style.align) ? style.align : DEFAULTS.align,
    rotationDeg: number(style.rotationDeg, -360, 360, DEFAULTS.rotationDeg),
    opacity: number(style.opacity, 0, 1, DEFAULTS.opacity),
    color: HEX.test(style.color ?? "") ? style.color : DEFAULTS.color,
    strokeColor: HEX.test(style.strokeColor ?? "") ? style.strokeColor : DEFAULTS.strokeColor,
    strokeWidth: number(style.strokeWidth, 0, 1, DEFAULTS.strokeWidth),
    gradient: resolveGradient(style.gradient),
    glow: resolveGlow(style.glow),
  };
}

function resolveGradient(gradient) {
  if (typeof gradient !== "object" || gradient === null) return null;
  const colors = Array.isArray(gradient.colors) ? gradient.colors.filter((c) => HEX.test(c ?? "")) : [];
  // "At least two stops are needed for a ramp; fewer is not a gradient."
  if (colors.length < 2) return null;
  return {
    colors,
    angleDeg: number(gradient.angleDeg, -360, 360, 0),
    cycleSec: number(gradient.cycleSec, 0, 600, 0),
  };
}

function resolveGlow(glow) {
  // Absent means none - never "none with defaults".
  if (typeof glow !== "object" || glow === null) return null;
  return {
    color: HEX.test(glow.color ?? "") ? glow.color : "#ffffff",
    radius: number(glow.radius, 0, 1, 0.02),
    intensity: number(glow.intensity, 0, 1, 0.5),
  };
}

/**
 * How present a decoration is at a moment: its opacity and its scale.
 *
 * Entrance and exit are clamped so they cannot overlap in a window too short for both,
 * and an effect this Player does not implement draws the decoration without it rather
 * than not drawing it at all.
 */
export function presenceAt(shown, chartTimeSec) {
  const { decoration, startSec, endSec } = shown;
  const style = resolveStyle(decoration.style);
  const window = Math.max(0, endSec - startSec);
  const animation = typeof decoration.animation === "object" && decoration.animation !== null ? decoration.animation : {};
  const enterSec = Math.min(Math.max(0, number(animation.enterDurationSec, 0, Infinity, 0)), window);
  const exitSec = Math.min(Math.max(0, number(animation.exitDurationSec, 0, Infinity, 0)), Math.max(0, window - enterSec));

  let progress = 1;
  let kind = "none";
  if (enterSec > 0 && chartTimeSec < startSec + enterSec) {
    progress = (chartTimeSec - startSec) / enterSec;
    kind = animation.enter === "fade" || animation.enter === "scale" ? animation.enter : "none";
  } else if (exitSec > 0 && chartTimeSec > endSec - exitSec) {
    progress = (endSec - chartTimeSec) / exitSec;
    kind = animation.exit === "fade" || animation.exit === "scale" ? animation.exit : "none";
  }
  progress = Math.min(1, Math.max(0, progress));

  return {
    style,
    opacity: style.opacity * (kind === "fade" ? progress : 1),
    scale: kind === "scale" ? SCALE_ANIMATION_FROM + (1 - SCALE_ANIMATION_FROM) * progress : 1,
  };
}

/**
 * The rectangle a decoration's coordinates are expressed in.
 *
 * "x runs 0 at the left edge to 1 at the right; y runs 0 at the far edge of the playfield
 * to 1 at the judgement line" - so it is the playfield itself, flat, not the perspective
 * the notes travel through. Drawing a caption in perspective would shrink it towards the
 * horizon, which is not what a caption over a playfield does.
 */
export function stageRectOf(geometry) {
  return {
    left: geometry.centreX - geometry.nearWidth / 2,
    top: geometry.topY,
    width: geometry.nearWidth,
    height: geometry.judgeY - geometry.topY,
  };
}

export function drawDecoration(ctx, geometry, shown, chartTimeSec) {
  const decoration = shown.decoration;
  if (decoration.type !== "text") return false;
  const text = typeof decoration.text === "string" ? decoration.text : "";
  if (text.length === 0) return false;

  const position = decoration.position;
  if (typeof position !== "object" || position === null) return false;
  const x = number(position.x, 0, 1, 0.5);
  const y = number(position.y, 0, 1, 0.5);

  const { style, opacity, scale } = presenceAt(shown, chartTimeSec);
  if (opacity <= 0) return false;

  const stage = stageRectOf(geometry);
  const fontPx = Math.max(1, style.fontSize * stage.height * scale);
  const centreX = stage.left + x * stage.width;
  const centreY = stage.top + y * stage.height;

  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
  ctx.translate(centreX, centreY);
  if (style.rotationDeg !== 0) ctx.rotate((style.rotationDeg * Math.PI) / 180);
  ctx.font = `${style.fontWeight} ${fontPx}px ${style.fontFamily}`;
  ctx.textAlign = style.align === "center" ? "center" : style.align;
  ctx.textBaseline = "middle";

  if (style.glow) {
    ctx.shadowColor = style.glow.color;
    ctx.shadowBlur = style.glow.radius * stage.height * (0.5 + style.glow.intensity);
  }

  if (style.strokeWidth > 0) {
    ctx.lineWidth = style.strokeWidth * stage.height;
    ctx.lineJoin = "round";
    ctx.strokeStyle = style.strokeColor;
    ctx.strokeText(text, 0, 0);
  }

  ctx.fillStyle = style.gradient ? gradientFor(ctx, style.gradient, text, fontPx, chartTimeSec) : style.color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return true;
}

/**
 * A colour ramp across the text.
 *
 * `cycleSec` is measured in chart time, as the contract says, so the ramp travels at the
 * same rate however fast the recording is being played. The stops are repeated once so
 * that a travelling ramp has somewhere to travel from.
 */
function gradientFor(ctx, gradient, text, fontPx, chartTimeSec) {
  const width = Math.max(ctx.measureText(text).width, fontPx);
  const angle = (gradient.angleDeg * Math.PI) / 180;
  const halfWidth = width / 2;
  const dx = Math.cos(angle) * halfWidth;
  const dy = Math.sin(angle) * halfWidth;
  const ramp = ctx.createLinearGradient(-dx, -dy, dx, dy);

  const phase = gradient.cycleSec > 0 ? (chartTimeSec / gradient.cycleSec) % 1 : 0;
  const colors = gradient.colors;
  const span = colors.length;
  for (let i = 0; i <= span * 2; i += 1) {
    const stop = i / (span * 2);
    const index = Math.floor(((i / 2) + phase * span) % span);
    ramp.addColorStop(Math.min(1, Math.max(0, stop)), colors[index]);
  }
  return ramp;
}
