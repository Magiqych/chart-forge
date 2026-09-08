/**
 * What a decoration *does* while it is on screen, as opposed to what it looks like at
 * rest or how it arrives.
 *
 * A decoration already had two vocabularies and they were both full. `style` says what
 * the text looks like standing still - its colour, its outline, its size. `animation`
 * says how it arrives and how it leaves, and its two halves are bounded by the entrance
 * and the exit. Neither has room for a highlight that sweeps across the text every few
 * seconds, or a meteor crossing the background, because those are neither a resting
 * appearance nor a transition: they run for the whole display window and belong to it.
 *
 * So there are three scopes now, and they do not overlap:
 *
 *   style      what it looks like at rest        colour, gradient, stroke, glow
 *   animation  how it arrives and leaves         enter, exit
 *   effects    what happens while it is shown    shimmer, sparkle, meteor
 *
 * The gradient and the glow went into `style` rather than here for exactly that reason:
 * a gradient is what colour the text *is*, and a glow is a property of its edge, in the
 * same way `strokeColor` is. That they can also drift over time is a rendering detail of
 * a resting appearance, not a separate event.
 *
 * ## Everything here is a pure function of time
 *
 * `effectStateAt` reconstructs the whole visual state from the decoration and a chart
 * time, with no accumulation between frames and no `Math.random` anywhere. That is not
 * tidiness for its own sake:
 *
 *   - seeking to a moment shows what that moment looks like, every time;
 *   - a screenshot of a paused editor is reproducible;
 *   - pausing and resuming cannot make particles jump or pile up;
 *   - playing at a tenth speed shows the same effect a tenth as fast, rather than a
 *     different one;
 *   - a Player written later can draw the same frame from the same document without
 *     having replayed everything before it.
 *
 * Nothing about an individual particle is ever written to the chart. What a document
 * stores is a handful of numbers describing the *effect*; the particles are recomputed
 * from the decoration's own id, so two captions never share a pattern and the same
 * caption always has the one it had.
 */

import { displayWindow, type ChartDecoration } from "./decoration";

/** Which way a meteor travels. Two, because a meteor is a diagonal streak, not a compass. */
export const METEOR_DIRECTIONS = ["downRight", "downLeft"] as const;
export type MeteorDirection = (typeof METEOR_DIRECTIONS)[number];

/**
 * A colour ramp across the text, and how fast it drifts.
 *
 * Generic on purpose: "rainbow" is not a mode here, it is a list of colours an author
 * chose. That keeps the contract free of any one song's taste - a two-stop fade and a
 * seven-stop rainbow are the same field with different contents - and it is what lets a
 * preset be a UI convenience rather than a value the document has to understand.
 */
export interface TextGradient {
  /** Two or more stops, spread evenly across the text. */
  readonly colors: readonly string[];
  /** Direction of the ramp across the text. 0 is left to right. */
  readonly angleDeg?: number;
  /** Seconds for the ramp to travel one full cycle. 0, the default, is a still gradient. */
  readonly cycleSec?: number;
}

/** A soft light around the outside of the text. */
export interface TextGlow {
  readonly color?: string;
  /** Blur radius as a fraction of the playfield's height, like `fontSize`. */
  readonly radius?: number;
  readonly intensity?: number;
}

/** A highlight that travels across the text now and then. */
export interface ShimmerEffect {
  /** Seconds between one sweep starting and the next. */
  readonly periodSec?: number;
  /** How long one sweep takes. */
  readonly durationSec?: number;
  readonly color?: string;
  readonly intensity?: number;
}

/** Small lights that appear briefly around the text. */
export interface SparkleEffect {
  /** How many appear per second, on average. */
  readonly ratePerSec?: number;
  readonly colors?: readonly string[];
  /** Size relative to the default, which is a fraction of the text's height. */
  readonly scale?: number;
  readonly intensity?: number;
}

/** A thin streak crossing the playfield behind the text. */
export interface MeteorEffect {
  readonly ratePerSec?: number;
  readonly direction?: MeteorDirection;
  readonly color?: string;
  /** Tail length as a fraction of the playfield's diagonal. */
  readonly lengthScale?: number;
  readonly intensity?: number;
}

/**
 * The ambient effects that run for a decoration's display window.
 *
 * Every member is optional and an absent member means "not doing that", never "doing it
 * with defaults" - so a decoration with no `effects` object behaves exactly as it did
 * before this existed, which is the whole compatibility claim in one sentence.
 */
export interface DecorationEffects {
  readonly shimmer?: ShimmerEffect;
  readonly sparkle?: SparkleEffect;
  readonly meteor?: MeteorEffect;
}

// --------------------------------------------------------------------------------
// Defaults
// --------------------------------------------------------------------------------

export const DEFAULT_GRADIENT_ANGLE_DEG = 0;
export const DEFAULT_GRADIENT_CYCLE_SEC = 0;

export const DEFAULT_GLOW_COLOR = "#ffffff";
export const DEFAULT_GLOW_RADIUS = 0.02;
export const DEFAULT_GLOW_INTENSITY = 0.5;

export const DEFAULT_SHIMMER_PERIOD_SEC = 3;
export const DEFAULT_SHIMMER_DURATION_SEC = 0.45;
export const DEFAULT_SHIMMER_COLOR = "#ffffff";
export const DEFAULT_SHIMMER_INTENSITY = 0.5;

export const DEFAULT_SPARKLE_RATE = 3;
export const DEFAULT_SPARKLE_COLORS: readonly string[] = ["#ffffff", "#d8f6ff", "#ffe3f2"];
export const DEFAULT_SPARKLE_SCALE = 1;
export const DEFAULT_SPARKLE_INTENSITY = 0.6;
/** How long one sparkle lives. Short: a twinkle is an instant, not a fade. */
export const SPARKLE_LIFE_SEC = 0.55;

export const DEFAULT_METEOR_RATE = 0.5;
export const DEFAULT_METEOR_COLOR = "#dff4ff";
export const DEFAULT_METEOR_LENGTH = 0.18;
export const DEFAULT_METEOR_INTENSITY = 0.5;
/** How long a meteor takes to cross. Brief, so it reads as a flash rather than a move. */
export const METEOR_LIFE_SEC = 0.85;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value: unknown, low: number, high: number, fallback: number): number {
  return usable(value) && value >= low && value <= high ? value : fallback;
}

function colorOr(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

// --------------------------------------------------------------------------------
// Determinism
// --------------------------------------------------------------------------------

/**
 * A stable 32-bit hash of a string. FNV-1a.
 *
 * The seed for every particle a decoration ever shows comes from its **id**, so nothing
 * has to be stored to make the pattern reproducible and two decorations never sparkle
 * alike. A copy gets a new id and therefore its own pattern, which is the right answer:
 * it is a different object.
 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A number in [0, 1) from a seed and an index. No state, so no drift. */
export function noise(seed: number, index: number, salt = 0): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0x297a2d39) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

/**
 * The events of a Poisson-ish stream that are alive at `atSec`.
 *
 * Event *n* happens at `(n + jitter) / rate`, so the nth event's time depends on nothing
 * but the seed and n - which is what makes the whole system reconstructible from a
 * timestamp. Only the indices that could still be alive are examined, so the cost is the
 * number of things actually on screen and not the length of the song.
 *
 * `lifeSec` is how long one event lasts; an event is alive when the moment is inside
 * `[t_n, t_n + lifeSec)`.
 */
export function aliveEvents(
  seed: number,
  ratePerSec: number,
  lifeSec: number,
  atSec: number,
): readonly { readonly index: number; readonly progress: number }[] {
  if (!usable(ratePerSec) || ratePerSec <= 0 || !usable(lifeSec) || lifeSec <= 0) return [];
  if (!usable(atSec) || atSec < 0) return [];

  const spacing = 1 / ratePerSec;
  const first = Math.floor((atSec - lifeSec) / spacing) - 1;
  const last = Math.floor(atSec / spacing) + 1;

  const alive: { index: number; progress: number }[] = [];
  for (let index = first; index <= last; index += 1) {
    if (index < 0) continue;
    // The jitter keeps the stream from looking metronomic without making it unrepeatable.
    const at = (index + noise(seed, index, 1)) * spacing;
    const progress = (atSec - at) / lifeSec;
    if (progress >= 0 && progress < 1) alive.push({ index, progress });
  }
  return alive;
}

// --------------------------------------------------------------------------------
// The state at an instant
// --------------------------------------------------------------------------------

/** One sparkle, positioned in the text's own box: 0..1 is the box, outside is the margin. */
export interface SparkleState {
  readonly x: number;
  readonly y: number;
  /** 0 at birth, 1 at death. */
  readonly progress: number;
  /** Relative size, before the renderer scales it to the text. */
  readonly size: number;
  readonly color: string;
  /** Already faded in and out over its life. */
  readonly alpha: number;
}

/** One meteor, positioned in the stage's normalized space. */
export interface MeteorState {
  /** Head position, 0..1 across and down the playfield. */
  readonly x: number;
  readonly y: number;
  /** Tail length as a fraction of the playfield's diagonal. */
  readonly length: number;
  /** Direction of travel in radians, for the renderer to draw the tail along. */
  readonly angleRad: number;
  readonly alpha: number;
  readonly color: string;
}

export interface EffectState {
  /** 0..1 around the colour ramp. Always 0 when the gradient is still. */
  readonly gradientPhase: number;
  /**
   * Where the shimmer highlight is, 0 at the left edge of the text and 1 at the right,
   * or null when no sweep is running.
   */
  readonly shimmer: number | null;
  readonly shimmerAlpha: number;
  readonly sparkles: readonly SparkleState[];
  readonly meteors: readonly MeteorState[];
}

export const NO_EFFECTS: EffectState = {
  gradientPhase: 0,
  shimmer: null,
  shimmerAlpha: 0,
  sparkles: [],
  meteors: [],
};

/** Fade in over the first fifth of a life and out over the last two fifths. */
function envelope(progress: number): number {
  if (progress < 0.2) return progress / 0.2;
  if (progress > 0.6) return (1 - progress) / 0.4;
  return 1;
}

export interface EffectOptions {
  /**
   * Hold every moving part still.
   *
   * For `prefers-reduced-motion`. The resting appearance survives - a gradient still
   * colours the text and a glow still glows - because those are what the decoration
   * *is*; what stops is everything that moves. The chart is not touched: this is a
   * property of the machine doing the drawing, not of the document.
   */
  readonly reducedMotion?: boolean;
}

/**
 * The whole visual state of one decoration at one chart time.
 *
 * Time is measured from the start of the decoration's own display window, so an effect
 * travels with the decoration when it is dragged rather than re-rolling itself, and a
 * caption shown twice at different moments looks the same both times.
 */
export function effectStateAt(
  decoration: ChartDecoration,
  timeSec: number,
  options: EffectOptions = {},
): EffectState {
  const { startSec, endSec } = displayWindow(decoration);
  if (!usable(timeSec) || timeSec < startSec || timeSec > endSec) return NO_EFFECTS;

  const elapsed = timeSec - startSec;
  const seed = hashString(decoration.id);
  const reduced = options.reducedMotion === true;

  const gradient = decoration.style?.gradient;
  const cycleSec = inRange(gradient?.cycleSec, 0, 600, DEFAULT_GRADIENT_CYCLE_SEC);
  const gradientPhase =
    reduced || cycleSec <= 0 ? 0 : (elapsed / cycleSec) % 1;

  return {
    gradientPhase,
    ...shimmerAt(decoration.effects?.shimmer, elapsed, reduced),
    sparkles: sparklesAt(decoration.effects?.sparkle, seed, elapsed, reduced),
    meteors: meteorsAt(decoration.effects?.meteor, seed, elapsed, reduced),
  };
}

function shimmerAt(
  effect: ShimmerEffect | undefined,
  elapsed: number,
  reduced: boolean,
): { shimmer: number | null; shimmerAlpha: number } {
  if (!effect || reduced) return { shimmer: null, shimmerAlpha: 0 };
  const periodSec = inRange(effect.periodSec, 0.05, 600, DEFAULT_SHIMMER_PERIOD_SEC);
  const durationSec = Math.min(
    inRange(effect.durationSec, 0.01, 600, DEFAULT_SHIMMER_DURATION_SEC),
    periodSec,
  );
  const intoPeriod = elapsed % periodSec;
  if (intoPeriod >= durationSec) return { shimmer: null, shimmerAlpha: 0 };

  const progress = intoPeriod / durationSec;
  const intensity = inRange(effect.intensity, 0, 1, DEFAULT_SHIMMER_INTENSITY);
  // Travels a little past both edges, so the highlight enters and leaves rather than
  // appearing in the middle of the word.
  return {
    shimmer: -0.25 + progress * 1.5,
    shimmerAlpha: intensity * Math.sin(progress * Math.PI),
  };
}

function sparklesAt(
  effect: SparkleEffect | undefined,
  seed: number,
  elapsed: number,
  reduced: boolean,
): readonly SparkleState[] {
  if (!effect || reduced) return [];
  const ratePerSec = inRange(effect.ratePerSec, 0, 60, DEFAULT_SPARKLE_RATE);
  if (ratePerSec <= 0) return [];
  const scale = inRange(effect.scale, 0.1, 4, DEFAULT_SPARKLE_SCALE);
  const intensity = inRange(effect.intensity, 0, 1, DEFAULT_SPARKLE_INTENSITY);
  const palette =
    effect.colors && effect.colors.length > 0
      ? effect.colors.filter((c) => HEX_COLOR.test(c))
      : DEFAULT_SPARKLE_COLORS;
  const colors = palette.length > 0 ? palette : DEFAULT_SPARKLE_COLORS;

  return aliveEvents(seed, ratePerSec, SPARKLE_LIFE_SEC, elapsed).map(({ index, progress }) => ({
    // Scattered across the text and a little beyond it, so they read as being *around*
    // the word rather than printed on top of it.
    x: -0.12 + noise(seed, index, 2) * 1.24,
    y: -0.35 + noise(seed, index, 3) * 1.7,
    progress,
    size: scale * (0.6 + noise(seed, index, 4) * 0.8),
    color: colors[Math.floor(noise(seed, index, 5) * colors.length) % colors.length] as string,
    alpha: intensity * envelope(progress),
  }));
}

function meteorsAt(
  effect: MeteorEffect | undefined,
  seed: number,
  elapsed: number,
  reduced: boolean,
): readonly MeteorState[] {
  if (!effect || reduced) return [];
  const ratePerSec = inRange(effect.ratePerSec, 0, 20, DEFAULT_METEOR_RATE);
  if (ratePerSec <= 0) return [];
  const color = colorOr(effect.color, DEFAULT_METEOR_COLOR);
  const lengthScale = inRange(effect.lengthScale, 0.02, 1, DEFAULT_METEOR_LENGTH);
  const intensity = inRange(effect.intensity, 0, 1, DEFAULT_METEOR_INTENSITY);
  const direction: MeteorDirection = (METEOR_DIRECTIONS as readonly string[]).includes(
    effect.direction ?? "",
  )
    ? (effect.direction as MeteorDirection)
    : "downRight";

  // A shallow diagonal, the way a meteor reads on a screen. Mirrored for the other way.
  const angleRad = direction === "downRight" ? Math.PI / 5 : Math.PI - Math.PI / 5;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);

  // A meteor is meant to be seen once in a while. Each one crosses the whole playfield,
  // so the seed decides where it enters and it travels from off one edge to off the other.
  return aliveEvents(seed, ratePerSec, METEOR_LIFE_SEC, elapsed).map(({ index, progress }) => {
    const entryY = -0.35 + noise(seed, index, 6) * 0.9;
    const entryX = direction === "downRight" ? -0.35 : 1.35;
    const travel = 1.7;
    return {
      x: entryX + dx * travel * progress,
      y: entryY + dy * travel * progress,
      length: lengthScale * (0.7 + noise(seed, index, 7) * 0.6),
      angleRad,
      alpha: intensity * envelope(progress),
      color,
    };
  });
}

// --------------------------------------------------------------------------------
// Resolving the resting appearance
// --------------------------------------------------------------------------------

export interface ResolvedGradient {
  readonly colors: readonly string[];
  readonly angleDeg: number;
  readonly cycleSec: number;
}

/**
 * A gradient the renderer can use, or null when the text is a flat colour.
 *
 * Fewer than two usable stops is not a gradient, so it falls back to the flat colour
 * rather than being drawn as something half-specified. The contract test rejects such a
 * document; this is what happens if one arrives from somewhere that does not answer to it.
 */
export function resolveGradient(gradient?: TextGradient): ResolvedGradient | null {
  if (!gradient) return null;
  const colors = (gradient.colors ?? []).filter((c) => HEX_COLOR.test(c));
  if (colors.length < 2) return null;
  return {
    colors,
    angleDeg: inRange(gradient.angleDeg, -360, 360, DEFAULT_GRADIENT_ANGLE_DEG),
    cycleSec: inRange(gradient.cycleSec, 0, 600, DEFAULT_GRADIENT_CYCLE_SEC),
  };
}

export interface ResolvedGlow {
  readonly color: string;
  readonly radius: number;
  readonly intensity: number;
}

/** A glow the renderer can use, or null when there is none. */
export function resolveGlow(glow?: TextGlow): ResolvedGlow | null {
  if (!glow) return null;
  const intensity = inRange(glow.intensity, 0, 1, DEFAULT_GLOW_INTENSITY);
  const radius = inRange(glow.radius, 0, 1, DEFAULT_GLOW_RADIUS);
  if (intensity <= 0 || radius <= 0) return null;
  return { color: colorOr(glow.color, DEFAULT_GLOW_COLOR), radius, intensity };
}

/** Whether a decoration asks for anything beyond a flat, still caption. */
export function hasVisualEffects(decoration: ChartDecoration): boolean {
  const effects = decoration.effects;
  return (
    decoration.style?.gradient !== undefined ||
    decoration.style?.glow !== undefined ||
    effects?.shimmer !== undefined ||
    effects?.sparkle !== undefined ||
    effects?.meteor !== undefined
  );
}
