/**
 * Named starting points for a decoration's appearance.
 *
 * A preset is a **UI convenience and nothing else**. Choosing one writes ordinary,
 * generic properties into the decoration - a list of colours, a glow radius, a sparkle
 * rate - and the name is never stored. That matters more than it might look:
 *
 *   - a chart never says "Kirameki", so the contract carries no song's taste and a
 *     Player never has to know what any preset meant;
 *   - an author can pick a preset and then change one number without the document
 *     becoming inconsistent with a name it is still claiming;
 *   - presets can be renamed, retuned or removed here without touching a single chart.
 *
 * The reverse mapping is by comparison: a decoration matches a preset when its
 * properties are exactly what that preset produces. So the panel can show which one is
 * in effect without anything having been recorded, and shows "Custom" the moment an
 * author changes something. That is the whole of the round trip.
 */

import type { DecorationEffects, TextDecorationStyle } from "./decoration";

/**
 * The style fields a preset sets, where `undefined` means "take this out".
 *
 * The project compiles with `exactOptionalPropertyTypes`, so an absent field and a field
 * holding `undefined` are different types - and that is exactly the distinction a preset
 * needs. Switching from Kirameki to Plain has to *remove* the gradient from the document,
 * not leave a stale one behind under a new name.
 */
type PresetStyle = { readonly [K in keyof TextDecorationStyle]?: TextDecorationStyle[K] | undefined };
type PresetEffects = { readonly [K in keyof DecorationEffects]?: DecorationEffects[K] | undefined };

export interface AppearancePreset {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /**
   * The style fields the preset sets. Fields it does not mention are left alone, so
   * choosing a preset never resizes an author's text or moves it.
   */
  readonly style: PresetStyle;
  /** The effects it sets. An empty object means "no ambient effects". */
  readonly effects: PresetEffects;
}

/**
 * A pastel rainbow rather than the primaries.
 *
 * Saturated red-through-violet on a dark playfield reads as a warning stripe and fights
 * everything around it. Lifting the whites and dropping the saturation keeps the hues
 * recognisable while leaving the text legible, which is the only thing a caption has to
 * be. Seven stops, so the ramp is smooth rather than banded.
 */
export const PASTEL_RAINBOW: readonly string[] = [
  "#ff9aa2", "#ffd8a8", "#fff3a8", "#b8f2c9", "#a8e6ff", "#b3c7ff", "#e0b3ff",
];

/**
 * The presets the panel offers.
 *
 * Deliberately few and deliberately restrained. The default of every one of them is on
 * the quiet side: an author who wants more turns it up in Advanced, and one who reached
 * for a preset was asking for a look rather than for a fireworks display.
 */
export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  {
    id: "plain",
    label: "Plain",
    hint: "A flat white caption. What a decoration looks like with nothing added.",
    style: { color: "#ffffff", gradient: undefined, glow: undefined },
    effects: {},
  },
  {
    id: "rainbow",
    label: "Rainbow",
    hint: "A soft pastel ramp that drifts slowly across the text.",
    style: {
      gradient: { colors: PASTEL_RAINBOW, angleDeg: 0, cycleSec: 8 },
      glow: undefined,
    },
    effects: {},
  },
  {
    id: "glow",
    label: "Glow",
    hint: "A quiet light around the letters, and nothing moving.",
    style: {
      gradient: undefined,
      glow: { color: "#d8f6ff", radius: 0.022, intensity: 0.5 },
    },
    effects: {},
  },
  {
    id: "sparkle",
    label: "Sparkle",
    hint: "Small lights appearing around the text now and then.",
    style: {
      gradient: undefined,
      glow: { color: "#ffffff", radius: 0.016, intensity: 0.35 },
    },
    effects: {
      sparkle: {
        ratePerSec: 2.4,
        colors: ["#ffffff", "#d8f6ff", "#ffe3f2"],
        scale: 1,
        intensity: 0.55,
      },
    },
  },
  {
    /**
     * Everything at once, and every one of them turned down.
     *
     * The look this was built for: a night sky rather than a slot machine. The rainbow
     * drifts over eight seconds, which is slow enough to read as a colour rather than as
     * motion; the glow is barely there; the shimmer crosses about every three and a half
     * seconds; sparkles are sparse; and a meteor comes past roughly every other second,
     * dim and behind the words. Turning any of these up is one number in Advanced - and
     * all of them up at once is exactly what this preset exists to avoid.
     */
    id: "kirameki",
    label: "Kirameki",
    hint: "Drifting pastel rainbow, faint glow, occasional shimmer, sparse sparkles and the odd meteor.",
    style: {
      gradient: { colors: PASTEL_RAINBOW, angleDeg: 0, cycleSec: 8 },
      glow: { color: "#d8f6ff", radius: 0.02, intensity: 0.42 },
    },
    effects: {
      shimmer: { periodSec: 3.4, durationSec: 0.5, color: "#ffffff", intensity: 0.45 },
      sparkle: {
        ratePerSec: 2.6,
        colors: ["#ffffff", "#d8f6ff", "#ffe3f2"],
        scale: 1,
        intensity: 0.55,
      },
      meteor: {
        ratePerSec: 0.45,
        direction: "downRight",
        color: "#dff4ff",
        lengthScale: 0.18,
        intensity: 0.4,
      },
    },
  },
];

export function presetById(id: string): AppearancePreset | null {
  return APPEARANCE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * The patch that applies a preset.
 *
 * Every field the preset does not want is set to `undefined`, which the decoration
 * commands read as "remove this" - so switching from Kirameki to Plain actually takes the
 * gradient out of the document rather than leaving a stale one behind under a new name.
 */
export function presetPatch(preset: AppearancePreset): {
  readonly style: Record<string, unknown>;
  readonly effects: Record<string, unknown>;
} {
  return {
    style: {
      gradient: preset.style.gradient,
      glow: preset.style.glow,
      ...(preset.style.color !== undefined ? { color: preset.style.color } : {}),
    },
    effects: {
      shimmer: preset.effects.shimmer,
      sparkle: preset.effects.sparkle,
      meteor: preset.effects.meteor,
    },
  };
}

/** Deep value equality over the plain data these objects are made of. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Which preset a decoration currently matches, or null for anything else.
 *
 * Compares only what a preset actually sets, so an author who picked Rainbow and then
 * changed the font size still sees Rainbow - the size was never part of the claim. It is
 * the visual properties that decide.
 */
export function matchingPreset(
  style: TextDecorationStyle | undefined,
  effects: DecorationEffects | undefined,
): AppearancePreset | null {
  for (const preset of APPEARANCE_PRESETS) {
    const wantColor = preset.style.color;
    if (wantColor !== undefined && !same(style?.color ?? "#ffffff", wantColor)) continue;
    if (!same(style?.gradient, preset.style.gradient)) continue;
    if (!same(style?.glow, preset.style.glow)) continue;
    if (!same(effects?.shimmer, preset.effects.shimmer)) continue;
    if (!same(effects?.sparkle, preset.effects.sparkle)) continue;
    if (!same(effects?.meteor, preset.effects.meteor)) continue;
    return preset;
  }
  return null;
}
