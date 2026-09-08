/**
 * The visual effects, as arithmetic.
 *
 * The whole system is a pure function from a decoration and a chart time to a picture,
 * and that is not a stylistic choice: it is what makes seeking, pausing, screenshotting
 * and slow playback all show the right thing. So the properties worth testing are mostly
 * about time - that the same moment always gives the same state, that nothing exists
 * outside the display window, and that the playback rate cannot change what is drawn at a
 * given moment, only how quickly the moments arrive.
 */

import { describe, expect, it } from "vitest";

import type { ChartDecoration } from "./decoration";
import {
  DEFAULT_GLOW_INTENSITY, DEFAULT_GLOW_RADIUS, DEFAULT_SPARKLE_COLORS,
  METEOR_DIRECTIONS, METEOR_LIFE_SEC, NO_EFFECTS, SPARKLE_LIFE_SEC,
  aliveEvents, effectStateAt, hasVisualEffects, hashString, noise,
  resolveGlow, resolveGradient,
} from "./decorationEffects";

const RAINBOW = ["#ff9aa2", "#ffd8a8", "#fff3a8", "#b8f2c9", "#a8e6ff"];

const decoration = (over: Record<string, unknown> = {}): ChartDecoration => {
  const built: Record<string, unknown> = {
    id: "dec-0001",
    type: "text",
    startTimeSec: 10,
    endTimeSec: 20,
    position: { x: 0.5, y: 0.5 },
    text: "キラメキ☆",
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete built[key];
    else built[key] = value;
  }
  return built as unknown as ChartDecoration;
};

const sparkling = (over: Record<string, unknown> = {}) =>
  decoration({ effects: { sparkle: { ratePerSec: 6 } }, ...over });

const meteoric = (over: Record<string, unknown> = {}) =>
  decoration({ effects: { meteor: { ratePerSec: 2 } }, ...over });

describe("nothing happens outside the display window", () => {
  it("is silent before the decoration starts", () => {
    expect(effectStateAt(sparkling(), 9.999)).toEqual(NO_EFFECTS);
    expect(effectStateAt(meteoric(), 0)).toEqual(NO_EFFECTS);
  });

  it("is silent after it ends", () => {
    expect(effectStateAt(sparkling(), 20.001)).toEqual(NO_EFFECTS);
    expect(effectStateAt(meteoric(), 1000)).toEqual(NO_EFFECTS);
  });

  it("has meteors only inside the window", () => {
    const shown = meteoric();
    for (const at of [9.5, 9.99, 20.01, 25]) {
      expect(effectStateAt(shown, at).meteors).toEqual([]);
    }
    // And somewhere inside it, at a rate of two a second, there is something to see.
    const inside = Array.from({ length: 40 }, (_, i) =>
      effectStateAt(shown, 10 + i * 0.25).meteors.length,
    );
    expect(inside.some((n) => n > 0)).toBe(true);
  });

  it("uses the default window when the decoration states no end", () => {
    const open = decoration({ endTimeSec: undefined, effects: { sparkle: { ratePerSec: 20 } } });
    expect(effectStateAt(open, 10.5).sparkles.length).toBeGreaterThan(0);
    expect(effectStateAt(open, 11.5)).toEqual(NO_EFFECTS);
  });

  it("is silent at a time that is not a number", () => {
    expect(effectStateAt(sparkling(), Number.NaN)).toEqual(NO_EFFECTS);
  });
});

describe("the same moment always looks the same", () => {
  it("gives the identical state for the identical time", () => {
    const shown = decoration({
      style: { gradient: { colors: RAINBOW, cycleSec: 6 } },
      effects: {
        shimmer: { periodSec: 2, durationSec: 0.4 },
        sparkle: { ratePerSec: 8 },
        meteor: { ratePerSec: 3 },
      },
    });
    for (const at of [10.0, 11.37, 14.5, 19.999]) {
      const first = effectStateAt(shown, at);
      for (let i = 0; i < 8; i += 1) {
        expect(effectStateAt(shown, at)).toEqual(first);
      }
    }
  });

  it("gives the same state whether the moment was reached forwards or jumped to", () => {
    // Which is what makes a seek land on the picture the author expects.
    const shown = sparkling();
    const walked: unknown[] = [];
    for (let at = 10; at <= 12; at += 1 / 60) walked.push(effectStateAt(shown, at));
    const jumped = effectStateAt(shown, 12);
    expect(effectStateAt(shown, 12)).toEqual(jumped);
    expect(walked.length).toBeGreaterThan(100);
  });

  it("does not depend on how finely the clock was sampled", () => {
    // A tenth-speed pass samples the same moments far more often. The picture at a given
    // moment must be the same one, or slow playback would show a different effect.
    const shown = meteoric();
    const coarse = effectStateAt(shown, 13.5);
    const fine = effectStateAt(shown, 13.5);
    expect(fine).toEqual(coarse);
  });

  it("gives two decorations different patterns", () => {
    const a = effectStateAt(sparkling({ id: "dec-0001" }), 12.34);
    const b = effectStateAt(sparkling({ id: "dec-0002" }), 12.34);
    expect(a.sparkles.map((s) => s.x)).not.toEqual(b.sparkles.map((s) => s.x));
  });

  it("moves an effect with its decoration rather than re-rolling it", () => {
    // Time is measured from the decoration's own start, so dragging a caption along the
    // timeline carries its pattern with it.
    const early = sparkling({ startTimeSec: 10, endTimeSec: 20 });
    const late = sparkling({ startTimeSec: 30, endTimeSec: 40 });
    expect(effectStateAt(late, 32.5).sparkles).toEqual(effectStateAt(early, 12.5).sparkles);
  });
});

describe("the deterministic stream", () => {
  it("hashes a string stably", () => {
    expect(hashString("dec-0001")).toBe(hashString("dec-0001"));
    expect(hashString("dec-0001")).not.toBe(hashString("dec-0002"));
  });

  it("gives noise in range and stably", () => {
    for (let i = 0; i < 200; i += 1) {
      const value = noise(12345, i, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(noise(12345, i, 3)).toBe(value);
    }
  });

  it("spreads noise across the range rather than clustering", () => {
    const buckets = new Array(4).fill(0);
    for (let i = 0; i < 400; i += 1) buckets[Math.floor(noise(7, i) * 4)] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(40);
  });

  it("keeps an event alive for exactly its life", () => {
    const alive = (at: number) => aliveEvents(99, 1, 1, at).length;
    // At one a second with a one-second life there is essentially always one alive, and
    // never a runaway number of them.
    for (let at = 2; at < 12; at += 0.1) {
      expect(alive(at)).toBeLessThanOrEqual(3);
    }
  });

  it("reports a progress that runs from zero to one", () => {
    for (let at = 0; at < 6; at += 0.05) {
      for (const event of aliveEvents(5, 4, 0.5, at)) {
        expect(event.progress).toBeGreaterThanOrEqual(0);
        expect(event.progress).toBeLessThan(1);
      }
    }
  });

  it("produces roughly the rate it was asked for", () => {
    // Ten seconds at three a second is about thirty events; the jitter must not change
    // that, only where inside each interval they fall.
    const seen = new Set<number>();
    for (let at = 0; at < 10; at += 0.01) {
      for (const event of aliveEvents(31, 3, 0.2, at)) seen.add(event.index);
    }
    expect(seen.size).toBeGreaterThan(24);
    expect(seen.size).toBeLessThan(36);
  });

  it("has nothing at all at a rate of zero", () => {
    expect(aliveEvents(1, 0, 1, 5)).toEqual([]);
    expect(effectStateAt(sparkling({ effects: { sparkle: { ratePerSec: 0 } } }), 12).sparkles)
      .toEqual([]);
  });
});

describe("the gradient", () => {
  it("drifts through a full cycle and wraps", () => {
    const shown = decoration({ style: { gradient: { colors: RAINBOW, cycleSec: 4 } } });
    expect(effectStateAt(shown, 10).gradientPhase).toBeCloseTo(0, 9);
    expect(effectStateAt(shown, 11).gradientPhase).toBeCloseTo(0.25, 9);
    expect(effectStateAt(shown, 12).gradientPhase).toBeCloseTo(0.5, 9);
    expect(effectStateAt(shown, 14).gradientPhase).toBeCloseTo(0, 9);
  });

  it("stands still when no cycle was asked for", () => {
    const still = decoration({ style: { gradient: { colors: RAINBOW } } });
    for (const at of [10, 13, 17]) expect(effectStateAt(still, at).gradientPhase).toBe(0);
  });

  it("resolves two or more stops and refuses fewer", () => {
    expect(resolveGradient({ colors: RAINBOW })?.colors).toEqual(RAINBOW);
    expect(resolveGradient({ colors: ["#ff0000"] })).toBeNull();
    expect(resolveGradient({ colors: [] })).toBeNull();
    expect(resolveGradient(undefined)).toBeNull();
  });

  it("drops stops that are not colours, and falls back when too few survive", () => {
    expect(resolveGradient({ colors: ["#ff0000", "red", "#00ff00"] })?.colors)
      .toEqual(["#ff0000", "#00ff00"]);
    expect(resolveGradient({ colors: ["#ff0000", "nope"] })).toBeNull();
  });

  it("replaces a nonsense cycle with the still default", () => {
    expect(resolveGradient({ colors: RAINBOW, cycleSec: -5 })?.cycleSec).toBe(0);
    expect(resolveGradient({ colors: RAINBOW, cycleSec: Number.NaN })?.cycleSec).toBe(0);
  });
});

describe("the glow", () => {
  it("resolves what was asked for, and defaults the rest", () => {
    const glow = resolveGlow({ color: "#d8f6ff" });
    expect(glow?.color).toBe("#d8f6ff");
    expect(glow?.radius).toBe(DEFAULT_GLOW_RADIUS);
    expect(glow?.intensity).toBe(DEFAULT_GLOW_INTENSITY);
  });

  it("is nothing when absent, or when turned all the way down", () => {
    expect(resolveGlow(undefined)).toBeNull();
    expect(resolveGlow({ intensity: 0 })).toBeNull();
    expect(resolveGlow({ radius: 0 })).toBeNull();
  });

  it("does not vary with time, because it is a resting appearance", () => {
    const shown = decoration({ style: { glow: { intensity: 0.5 } } });
    const first = effectStateAt(shown, 11);
    const later = effectStateAt(shown, 17);
    expect(first).toEqual(later);
  });
});

describe("the shimmer", () => {
  const shown = decoration({
    effects: { shimmer: { periodSec: 2, durationSec: 0.5, intensity: 1 } },
  });

  it("sweeps at the start of every period and not in between", () => {
    expect(effectStateAt(shown, 10.0).shimmer).not.toBeNull();
    expect(effectStateAt(shown, 10.25).shimmer).not.toBeNull();
    expect(effectStateAt(shown, 10.6).shimmer).toBeNull();
    expect(effectStateAt(shown, 11.9).shimmer).toBeNull();
    expect(effectStateAt(shown, 12.0).shimmer).not.toBeNull();
  });

  it("travels left to right, entering and leaving past the edges", () => {
    const start = effectStateAt(shown, 10.0).shimmer as number;
    const middle = effectStateAt(shown, 10.25).shimmer as number;
    const end = effectStateAt(shown, 10.49).shimmer as number;
    expect(start).toBeLessThan(0);
    expect(middle).toBeGreaterThan(0.3);
    expect(end).toBeGreaterThan(1);
  });

  it("fades in and out rather than switching on", () => {
    expect(effectStateAt(shown, 10.0).shimmerAlpha).toBeCloseTo(0, 6);
    expect(effectStateAt(shown, 10.25).shimmerAlpha).toBeCloseTo(1, 6);
    expect(effectStateAt(shown, 10.499).shimmerAlpha).toBeLessThan(0.05);
  });

  it("never lets a sweep outlast its period", () => {
    const cramped = decoration({
      effects: { shimmer: { periodSec: 0.3, durationSec: 5 } },
    });
    // The duration is held to the period, so sweeps cannot overlap themselves.
    for (let at = 10; at < 11; at += 0.01) {
      const state = effectStateAt(cramped, at);
      if (state.shimmer !== null) expect(state.shimmerAlpha).toBeLessThanOrEqual(1);
    }
  });
});

describe("the sparkles", () => {
  it("stay near the text", () => {
    const shown = sparkling({ effects: { sparkle: { ratePerSec: 30 } } });
    for (let at = 10; at < 15; at += 0.05) {
      for (const sparkle of effectStateAt(shown, at).sparkles) {
        expect(sparkle.x).toBeGreaterThan(-0.3);
        expect(sparkle.x).toBeLessThan(1.3);
        expect(sparkle.y).toBeGreaterThan(-0.6);
        expect(sparkle.y).toBeLessThan(1.6);
      }
    }
  });

  it("fade in and out over a life", () => {
    const shown = sparkling();
    const alphas: number[] = [];
    for (let at = 10; at < 12; at += 0.02) {
      for (const sparkle of effectStateAt(shown, at).sparkles) alphas.push(sparkle.alpha);
    }
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(1);
  });

  it("draws from the palette it was given", () => {
    const shown = sparkling({
      effects: { sparkle: { ratePerSec: 30, colors: ["#112233"] } },
    });
    for (let at = 10; at < 12; at += 0.05) {
      for (const sparkle of effectStateAt(shown, at).sparkles) {
        expect(sparkle.color).toBe("#112233");
      }
    }
  });

  it("falls back to the default palette when given nothing usable", () => {
    const shown = sparkling({
      effects: { sparkle: { ratePerSec: 30, colors: ["nope", "also-nope"] } },
    });
    const seen = new Set<string>();
    for (let at = 10; at < 14; at += 0.05) {
      for (const sparkle of effectStateAt(shown, at).sparkles) seen.add(sparkle.color);
    }
    for (const color of seen) expect(DEFAULT_SPARKLE_COLORS).toContain(color);
  });

  it("does not pile up without limit at a sane rate", () => {
    const shown = sparkling({ effects: { sparkle: { ratePerSec: 3 } } });
    let most = 0;
    for (let at = 10; at < 20; at += 0.02) {
      most = Math.max(most, effectStateAt(shown, at).sparkles.length);
    }
    // Three a second living just over half a second apiece is a handful at a time.
    expect(most).toBeLessThanOrEqual(Math.ceil(3 * SPARKLE_LIFE_SEC) + 2);
  });
});

describe("the meteors", () => {
  it("cross the playfield rather than sitting in it", () => {
    const shown = meteoric({ effects: { meteor: { ratePerSec: 4 } } });
    const seen: number[] = [];
    for (let at = 10; at < 14; at += 0.02) {
      for (const meteor of effectStateAt(shown, at).meteors) seen.push(meteor.x);
    }
    expect(Math.min(...seen)).toBeLessThan(0.1);
    expect(Math.max(...seen)).toBeGreaterThan(0.9);
  });

  it("travels the other way when asked", () => {
    const right = effectStateAt(
      meteoric({ effects: { meteor: { ratePerSec: 4, direction: "downRight" } } }), 11.5,
    ).meteors;
    const left = effectStateAt(
      meteoric({ effects: { meteor: { ratePerSec: 4, direction: "downLeft" } } }), 11.5,
    ).meteors;
    if (right.length > 0 && left.length > 0) {
      expect(Math.cos(right[0]!.angleRad)).toBeGreaterThan(0);
      expect(Math.cos(left[0]!.angleRad)).toBeLessThan(0);
    }
    expect(METEOR_DIRECTIONS).toEqual(["downRight", "downLeft"]);
  });

  it("falls back to a known direction for one it has never heard of", () => {
    const odd = meteoric({
      effects: { meteor: { ratePerSec: 4, direction: "upLeft" as never } },
    });
    for (const meteor of effectStateAt(odd, 11.5).meteors) {
      expect(Math.cos(meteor.angleRad)).toBeGreaterThan(0);
    }
  });

  it("stays sparse at the rate a preset uses", () => {
    const shown = meteoric({ effects: { meteor: { ratePerSec: 0.45 } } });
    let most = 0;
    for (let at = 10; at < 20; at += 0.02) {
      most = Math.max(most, effectStateAt(shown, at).meteors.length);
    }
    // Half a meteor a second living under a second: one at a time, sometimes two.
    expect(most).toBeLessThanOrEqual(Math.ceil(0.45 * METEOR_LIFE_SEC) + 1);
  });
});

describe("reduced motion", () => {
  const busy = decoration({
    style: { gradient: { colors: RAINBOW, cycleSec: 4 }, glow: { intensity: 0.5 } },
    effects: {
      shimmer: { periodSec: 1, durationSec: 0.4 },
      sparkle: { ratePerSec: 20 },
      meteor: { ratePerSec: 5 },
    },
  });

  it("stops everything that moves", () => {
    for (let at = 10; at < 16; at += 0.1) {
      const state = effectStateAt(busy, at, { reducedMotion: true });
      expect(state.gradientPhase).toBe(0);
      expect(state.shimmer).toBeNull();
      expect(state.sparkles).toEqual([]);
      expect(state.meteors).toEqual([]);
    }
  });

  it("leaves the resting appearance alone", () => {
    // The gradient and the glow are what the caption *is*; only their motion stops.
    expect(resolveGradient(busy.style?.gradient)).not.toBeNull();
    expect(resolveGlow(busy.style?.glow)).not.toBeNull();
  });

  it("changes nothing about the decoration itself", () => {
    const before = JSON.stringify(busy);
    effectStateAt(busy, 12, { reducedMotion: true });
    expect(JSON.stringify(busy)).toBe(before);
  });
});

describe("knowing whether anything is set", () => {
  it("says no for a plain caption", () => {
    expect(hasVisualEffects(decoration())).toBe(false);
    expect(hasVisualEffects(decoration({ style: { color: "#ff0000" } }))).toBe(false);
    expect(hasVisualEffects(decoration({ effects: {} }))).toBe(false);
  });

  it("says yes for each of the five things it can carry", () => {
    expect(hasVisualEffects(decoration({ style: { gradient: { colors: RAINBOW } } }))).toBe(true);
    expect(hasVisualEffects(decoration({ style: { glow: {} } }))).toBe(true);
    expect(hasVisualEffects(decoration({ effects: { shimmer: {} } }))).toBe(true);
    expect(hasVisualEffects(decoration({ effects: { sparkle: {} } }))).toBe(true);
    expect(hasVisualEffects(decoration({ effects: { meteor: {} } }))).toBe(true);
  });
});
