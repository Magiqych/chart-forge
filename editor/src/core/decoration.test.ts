/**
 * The display rules: when a decoration is on screen and what it looks like there.
 *
 * These are what a viewer actually experiences, and they are arithmetic, so they are
 * tested as arithmetic rather than by looking at a canvas. The cases that matter are the
 * boundaries - the instant it appears, the instant it goes, a zero-length animation, an
 * animation longer than the window it has to happen in - because those are the ones a
 * renderer gets subtly wrong and nobody notices until a chart looks broken in the game.
 */

import { describe, expect, it } from "vitest";

import {
  ANIMATION_KINDS, DEFAULT_DISPLAY_DURATION_SEC, DEFAULT_TEXT_STYLE, SCALE_ANIMATION_FROM,
  animationKindOf, clampPosition, clampUnit, compareDecorations, decorationAppearance,
  decorationsAt, displayDurationSec, displayWindow, fittedAnimation, isDisplayedAt,
  isTextDecoration, paintOrder, resolveTextStyle,
  type ChartDecoration,
} from "./decoration";

/**
 * A fixture, where passing `undefined` for a field means the decoration does not have it.
 *
 * The project compiles with `exactOptionalPropertyTypes`, so "absent" and "present and
 * undefined" are genuinely different - which is the distinction half these tests are
 * about, since a missing `endTimeSec` is what makes the reader supply a default.
 */
type Over = { readonly [K in keyof ChartDecoration]?: ChartDecoration[K] | undefined };

const text = (over: Over = {}): ChartDecoration => {
  const built: Record<string, unknown> = {
    id: "dec-0001",
    type: "text",
    startTimeSec: 10,
    endTimeSec: 12,
    position: { x: 0.5, y: 0.5 },
    text: "HELLO",
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete built[key];
    else built[key] = value;
  }
  return built as unknown as ChartDecoration;
};

describe("the display window", () => {
  it("is what the decoration says when it says", () => {
    expect(displayWindow(text())).toEqual({ startSec: 10, endSec: 12 });
    expect(displayDurationSec(text())).toBe(2);
  });

  it("falls back to the default duration when there is no end", () => {
    const open = text({ endTimeSec: undefined });
    expect(displayWindow(open)).toEqual({
      startSec: 10,
      endSec: 10 + DEFAULT_DISPLAY_DURATION_SEC,
    });
  });

  it("treats an end that is not after the start as no end at all", () => {
    // The contract forbids it, so a document carrying one is already wrong. Showing the
    // caption for the default second is a more useful reading than never showing it.
    for (const endTimeSec of [10, 9, -1]) {
      expect(displayWindow(text({ endTimeSec })).endSec).toBe(
        10 + DEFAULT_DISPLAY_DURATION_SEC,
      );
    }
  });

  it("survives a start that is not a number", () => {
    const broken = text({ startTimeSec: Number.NaN, endTimeSec: undefined });
    expect(Number.isFinite(displayWindow(broken).startSec)).toBe(true);
  });
});

describe("whether a decoration is on screen", () => {
  const decoration = text();

  it("is hidden before it starts", () => {
    expect(isDisplayedAt(decoration, 9.999)).toBe(false);
    expect(decorationAppearance(decoration, 0)).toEqual({
      visible: false, opacity: 0, scale: 1,
    });
  });

  it("is shown throughout its window", () => {
    for (const at of [10, 10.5, 11, 11.999, 12]) {
      expect(isDisplayedAt(decoration, at)).toBe(true);
    }
  });

  it("is shown at both instants of the boundary, inclusively", () => {
    expect(isDisplayedAt(decoration, 10)).toBe(true);
    expect(isDisplayedAt(decoration, 12)).toBe(true);
  });

  it("is hidden after it ends", () => {
    expect(isDisplayedAt(decoration, 12.001)).toBe(false);
    expect(isDisplayedAt(decoration, 1000)).toBe(false);
  });

  it("uses the default duration when no end was recorded", () => {
    const open = text({ endTimeSec: undefined });
    expect(isDisplayedAt(open, 10.5)).toBe(true);
    expect(isDisplayedAt(open, 10.999)).toBe(true);
    expect(isDisplayedAt(open, 11.001)).toBe(false);
  });

  it("is hidden at a time that is not a number", () => {
    expect(isDisplayedAt(decoration, Number.NaN)).toBe(false);
  });
});

describe("animation", () => {
  const fade = (over: Over = {}) =>
    text({
      animation: {
        enter: "fade", enterDurationSec: 0.5, exit: "fade", exitDurationSec: 0.5,
      },
      ...over,
    });

  it("fades in from nothing to fully present", () => {
    expect(decorationAppearance(fade(), 10).opacity).toBeCloseTo(0, 9);
    expect(decorationAppearance(fade(), 10.25).opacity).toBeCloseTo(0.5, 9);
    expect(decorationAppearance(fade(), 10.5).opacity).toBeCloseTo(1, 9);
  });

  it("stays fully present between the two animations", () => {
    expect(decorationAppearance(fade(), 11).opacity).toBeCloseTo(1, 9);
  });

  it("fades out to nothing", () => {
    expect(decorationAppearance(fade(), 11.5).opacity).toBeCloseTo(1, 9);
    expect(decorationAppearance(fade(), 11.75).opacity).toBeCloseTo(0.5, 9);
    expect(decorationAppearance(fade(), 12).opacity).toBeCloseTo(0, 9);
  });

  it("scales in and out, leaving opacity alone", () => {
    const scaled = text({
      animation: { enter: "scale", enterDurationSec: 0.5, exit: "scale", exitDurationSec: 0.5 },
    });
    expect(decorationAppearance(scaled, 10).scale).toBeCloseTo(SCALE_ANIMATION_FROM, 9);
    expect(decorationAppearance(scaled, 10.5).scale).toBeCloseTo(1, 9);
    expect(decorationAppearance(scaled, 12).scale).toBeCloseTo(SCALE_ANIMATION_FROM, 9);
    expect(decorationAppearance(scaled, 10).opacity).toBeCloseTo(1, 9);
  });

  it("does nothing at all for `none`", () => {
    const none = text({
      animation: { enter: "none", enterDurationSec: 0.5, exit: "none", exitDurationSec: 0.5 },
    });
    for (const at of [10, 10.25, 11, 12]) {
      expect(decorationAppearance(none, at)).toEqual({ visible: true, opacity: 1, scale: 1 });
    }
  });

  it("does nothing for a zero-length animation, rather than dividing by zero", () => {
    const zero = text({
      animation: { enter: "fade", enterDurationSec: 0, exit: "fade", exitDurationSec: 0 },
    });
    for (const at of [10, 11, 12]) {
      const shown = decorationAppearance(zero, at);
      expect(shown.visible).toBe(true);
      expect(shown.opacity).toBe(1);
      expect(Number.isFinite(shown.opacity)).toBe(true);
    }
  });

  it("fits an animation longer than the window into the window", () => {
    // Half a second of entrance and a second of exit asked for, inside a window of a
    // fifth of a second. Both are compressed by the same factor, so their proportion
    // survives and they still meet exactly in the middle.
    const cramped = text({
      endTimeSec: 10.2,
      animation: { enter: "fade", enterDurationSec: 0.5, exit: "fade", exitDurationSec: 1 },
    });
    const fitted = fittedAnimation(cramped);
    expect(fitted.enterSec + fitted.exitSec).toBeCloseTo(0.2, 9);
    expect(fitted.exitSec / fitted.enterSec).toBeCloseTo(2, 9);

    // And nothing goes out of range anywhere across the window.
    for (let at = 10; at <= 10.2; at += 0.005) {
      const shown = decorationAppearance(cramped, at);
      expect(shown.opacity).toBeGreaterThanOrEqual(0);
      expect(shown.opacity).toBeLessThanOrEqual(1);
    }
  });

  it("scales an entrance alone when only it is too long", () => {
    const cramped = text({
      endTimeSec: 10.1,
      animation: { enter: "fade", enterDurationSec: 5 },
    });
    expect(fittedAnimation(cramped).enterSec).toBeCloseTo(0.1, 9);
  });

  it("ignores a duration attached to `none`", () => {
    const none = text({ animation: { enter: "none", enterDurationSec: 5 } });
    expect(fittedAnimation(none).enterSec).toBe(0);
  });

  it("ignores a negative or nonsense duration", () => {
    for (const enterDurationSec of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const odd = text({ animation: { enter: "fade", enterDurationSec } });
      expect(fittedAnimation(odd).enterSec).toBe(0);
      expect(decorationAppearance(odd, 10).opacity).toBe(1);
    }
  });

  it("multiplies the style's own opacity rather than replacing it", () => {
    const half = text({
      style: { opacity: 0.5 },
      animation: { enter: "fade", enterDurationSec: 0.5 },
    });
    expect(decorationAppearance(half, 10.25).opacity).toBeCloseTo(0.25, 9);
    expect(decorationAppearance(half, 11).opacity).toBeCloseTo(0.5, 9);
  });

  it("draws an effect it has never heard of as no effect at all", () => {
    // A chart from a later version of the contract must still show its captions.
    const future = text({
      animation: { enter: "slideUp" as never, enterDurationSec: 0.5 },
    });
    expect(animationKindOf("slideUp")).toBe("none");
    expect(decorationAppearance(future, 10)).toEqual({
      visible: true, opacity: 1, scale: 1,
    });
  });

  it("recognises exactly the kinds this version defines", () => {
    for (const kind of ANIMATION_KINDS) expect(animationKindOf(kind)).toBe(kind);
    expect(animationKindOf(undefined)).toBe("none");
  });
});

describe("style defaults", () => {
  it("gives a decoration with no style the documented defaults", () => {
    expect(resolveTextStyle(undefined)).toEqual(DEFAULT_TEXT_STYLE);
    expect(resolveTextStyle({})).toEqual(DEFAULT_TEXT_STYLE);
  });

  it("keeps what the author did say and defaults the rest", () => {
    const style = resolveTextStyle({ fontSize: 0.2, color: "#ff0000" });
    expect(style.fontSize).toBe(0.2);
    expect(style.color).toBe("#ff0000");
    expect(style.align).toBe(DEFAULT_TEXT_STYLE.align);
    expect(style.fontWeight).toBe(DEFAULT_TEXT_STYLE.fontWeight);
  });

  it("replaces a value outside its range with the default rather than guessing", () => {
    expect(resolveTextStyle({ opacity: 5 }).opacity).toBe(1);
    expect(resolveTextStyle({ opacity: -1 }).opacity).toBe(1);
    expect(resolveTextStyle({ fontSize: 0 }).fontSize).toBe(DEFAULT_TEXT_STYLE.fontSize);
    expect(resolveTextStyle({ fontSize: 4 }).fontSize).toBe(DEFAULT_TEXT_STYLE.fontSize);
    expect(resolveTextStyle({ fontWeight: 50 }).fontWeight).toBe(400);
    expect(resolveTextStyle({ strokeWidth: -1 }).strokeWidth).toBe(0);
  });

  it("rejects a colour that is not six hex digits", () => {
    for (const color of ["red", "#fff", "#12345g", "", "#1234567"]) {
      expect(resolveTextStyle({ color }).color).toBe(DEFAULT_TEXT_STYLE.color);
    }
    expect(resolveTextStyle({ color: "#AABBCC" }).color).toBe("#AABBCC");
  });

  it("rejects a font family that is not one of the three logical ones", () => {
    expect(resolveTextStyle({ fontFamily: "Comic Sans" as never }).fontFamily)
      .toBe("sans-serif");
    expect(resolveTextStyle({ fontFamily: "monospace" }).fontFamily).toBe("monospace");
  });

  it("survives values that are not numbers at all", () => {
    const style = resolveTextStyle({
      fontSize: Number.NaN, opacity: Number.POSITIVE_INFINITY, rotationDeg: Number.NaN,
    });
    expect(style).toEqual(DEFAULT_TEXT_STYLE);
  });
});

describe("clamping a position", () => {
  it("holds each axis inside the playfield", () => {
    expect(clampPosition({ x: 1.4, y: -0.2 })).toEqual({ x: 1, y: 0 });
    expect(clampPosition({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
  });

  it("clamps per axis, so dragging off one edge slides along it", () => {
    expect(clampPosition({ x: 2, y: 0.42 })).toEqual({ x: 1, y: 0.42 });
  });

  it("treats a value that is not a number as zero", () => {
    expect(clampUnit(Number.NaN)).toBe(0);
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("ordering", () => {
  const at = (id: string, startTimeSec: number, zIndex?: number): ChartDecoration =>
    text({ id, startTimeSec, endTimeSec: startTimeSec + 1, ...(zIndex !== undefined ? { zIndex } : {}) });

  it("orders the document by start, then id", () => {
    const sorted = [at("dec-0003", 5), at("dec-0001", 1), at("dec-0002", 1)]
      .sort(compareDecorations)
      .map((d) => d.id);
    expect(sorted).toEqual(["dec-0001", "dec-0002", "dec-0003"]);
  });

  it("paints by zIndex first, back to front", () => {
    const painted = paintOrder([
      at("dec-0001", 1, 50), at("dec-0002", 2, 0), at("dec-0003", 3, 10),
    ]).map((d) => d.id);
    expect(painted).toEqual(["dec-0002", "dec-0003", "dec-0001"]);
  });

  it("treats a missing zIndex as zero", () => {
    const painted = paintOrder([at("dec-0001", 1, 5), at("dec-0002", 2)]).map((d) => d.id);
    expect(painted).toEqual(["dec-0002", "dec-0001"]);
  });

  it("falls back to document order inside one layer, so the answer is never arbitrary", () => {
    const painted = paintOrder([
      at("dec-0002", 5, 3), at("dec-0001", 1, 3),
    ]).map((d) => d.id);
    expect(painted).toEqual(["dec-0001", "dec-0002"]);
  });

  it("does not disturb the list it was given", () => {
    const list = [at("dec-0002", 5, 3), at("dec-0001", 1, 0)];
    paintOrder(list);
    expect(list.map((d) => d.id)).toEqual(["dec-0002", "dec-0001"]);
  });

  it("gives what is on screen at an instant, back to front", () => {
    const shown = decorationsAt(
      [at("dec-0001", 1, 9), at("dec-0002", 1, 1), at("dec-0003", 30)],
      1.5,
    ).map((d) => d.id);
    expect(shown).toEqual(["dec-0002", "dec-0001"]);
  });
});

describe("what kind a decoration is", () => {
  it("recognises the one kind this Editor draws", () => {
    expect(isTextDecoration(text())).toBe(true);
  });

  it("does not claim a kind from a later contract", () => {
    expect(isTextDecoration(text({ type: "image", text: undefined }))).toBe(false);
  });
});
