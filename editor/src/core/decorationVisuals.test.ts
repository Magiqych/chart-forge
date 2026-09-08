/**
 * The visual properties as a contract: what reaches the document, and what must not.
 *
 * Adding a way to make a caption sparkle is only worth having if every chart that existed
 * before it still loads, still saves and comes back the same bytes - so most of this is
 * about absence. An effect nobody asked for is not written; a default is never
 * materialised; a decoration with no visuals is exactly the object it always was.
 */

import { describe, expect, it } from "vitest";

import {
  emptyChart, placeDecoration, projectChart, serializeChart, updateDecoration,
  type ChartState,
} from "./chart";
import {
  chartOf, editDecoration, openSession, redo, selectDecoration, undo,
} from "./editorSession";
import { copySelection, pasteInto } from "./clipboard";
import {
  APPEARANCE_PRESETS, PASTEL_RAINBOW, matchingPreset, presetById, presetPatch,
} from "./decorationPresets";

const LEGACY = {
  version: "0.1.0",
  audio: { path: "song.wav", durationSec: 8 },
  timing: { offsetSec: 0 },
  playfield: { laneCount: 5, profile: "generic" },
  notes: [{ id: "n-0001", type: "tap", timeSec: 1, lane: 0 }],
  extensions: {},
} as const;

const blank = (): ChartState => emptyChart({ audioPath: "song.wav", audioDurationSec: 30 });

const place = (state: ChartState, over: Record<string, unknown> = {}) =>
  placeDecoration(state, {
    startTimeSec: 1,
    position: { x: 0.5, y: 0.5 },
    text: "キラメキ☆",
    ...over,
  });

const KIRAMEKI = presetById("kirameki");

describe("charts written before any of this existed", () => {
  it("still load, with no visuals", () => {
    const state = projectChart(LEGACY);
    expect(state.decorations).toEqual([]);
  });

  it("still round-trip byte for byte", () => {
    expect(serializeChart(projectChart(LEGACY))).toEqual(LEGACY);
  });

  it("keep a plain decoration plain through a load and a save", () => {
    const document = {
      ...LEGACY,
      decorations: [
        { id: "dec-0001", type: "text", startTimeSec: 1, position: { x: 0.5, y: 0.4 }, text: "READY" },
      ],
    };
    const round = serializeChart(projectChart(document));
    expect(round).toEqual(document);
    const written = (round["decorations"] as Record<string, unknown>[])[0]!;
    expect(written).not.toHaveProperty("effects");
    expect(written).not.toHaveProperty("style");
  });
});

describe("nothing is written that the author did not choose", () => {
  it("writes no effects key for a decoration that has none", () => {
    const { state } = place(blank());
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0]!;
    expect(written).not.toHaveProperty("effects");
  });

  it("writes no gradient or glow defaults", () => {
    const { state } = place(blank(), { style: { fontSize: 0.12 } });
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0]!;
    expect(written["style"]).toEqual({ fontSize: 0.12 });
  });

  it("writes only the effect members that were set", () => {
    const { state } = place(blank(), { effects: { sparkle: { ratePerSec: 2 } } });
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0]!;
    expect(written["effects"]).toEqual({ sparkle: { ratePerSec: 2 } });
  });

  it("does not materialise the reader's defaults for the members that are set", () => {
    // `{}` means "shimmer, with everything defaulted" and must stay `{}` on disk.
    const { state } = place(blank(), { effects: { shimmer: {} } });
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0]!;
    expect(written["effects"]).toEqual({ shimmer: {} });
  });
});

describe("a fully decorated caption survives the round trip", () => {
  const document = {
    ...LEGACY,
    decorations: [
      {
        id: "dec-0001",
        type: "text",
        startTimeSec: 1,
        endTimeSec: 4,
        position: { x: 0.5, y: 0.45 },
        text: "キラメキ☆",
        style: {
          fontSize: 0.12,
          fontWeight: 700,
          strokeColor: "#101426",
          strokeWidth: 0.006,
          gradient: { colors: [...PASTEL_RAINBOW], angleDeg: 0, cycleSec: 8 },
          glow: { color: "#d8f6ff", radius: 0.02, intensity: 0.42 },
        },
        animation: { enter: "scale", enterDurationSec: 0.12 },
        effects: {
          shimmer: { periodSec: 3.4, durationSec: 0.5, color: "#ffffff", intensity: 0.45 },
          sparkle: { ratePerSec: 2.6, colors: ["#ffffff", "#d8f6ff"], scale: 1, intensity: 0.55 },
          meteor: {
            ratePerSec: 0.45, direction: "downRight",
            color: "#dff4ff", lengthScale: 0.18, intensity: 0.4,
          },
        },
        zIndex: 20,
      },
    ],
  };

  it("reads every field back", () => {
    const [decoration] = projectChart(document).decorations;
    expect(decoration?.style?.gradient?.colors).toHaveLength(7);
    expect(decoration?.style?.glow?.intensity).toBe(0.42);
    expect(decoration?.effects?.shimmer?.periodSec).toBe(3.4);
    expect(decoration?.effects?.sparkle?.ratePerSec).toBe(2.6);
    expect(decoration?.effects?.meteor?.direction).toBe("downRight");
  });

  it("writes it back unchanged, twice over", () => {
    const once = serializeChart(projectChart(document));
    expect(once).toEqual(document);
    expect(serializeChart(projectChart(once))).toEqual(document);
  });

  it("does not disturb the style fields that were already there", () => {
    const [decoration] = projectChart(document).decorations;
    expect(decoration?.style?.strokeColor).toBe("#101426");
    expect(decoration?.style?.strokeWidth).toBe(0.006);
    expect(decoration?.animation?.enter).toBe("scale");
  });
});

describe("editing the visuals", () => {
  const one = () => place(blank()).state;

  it("merges an effects patch over what is there", () => {
    let state = updateDecoration(one(), "dec-0001", { effects: { sparkle: { ratePerSec: 2 } } });
    state = updateDecoration(state, "dec-0001", { effects: { meteor: { ratePerSec: 1 } } });
    expect(state.decorations[0]?.effects).toEqual({
      sparkle: { ratePerSec: 2 },
      meteor: { ratePerSec: 1 },
    });
  });

  it("removes an effect turned off, rather than storing it disabled", () => {
    let state = updateDecoration(one(), "dec-0001", {
      effects: { sparkle: { ratePerSec: 2 }, meteor: { ratePerSec: 1 } },
    });
    state = updateDecoration(state, "dec-0001", { effects: { meteor: undefined } });
    expect(state.decorations[0]?.effects).toEqual({ sparkle: { ratePerSec: 2 } });

    // And emptying it entirely drops the whole group off the document.
    state = updateDecoration(state, "dec-0001", { effects: { sparkle: undefined } });
    expect(state.decorations[0]?.effects).toBeUndefined();
    const written = (serializeChart(state)["decorations"] as Record<string, unknown>[])[0]!;
    expect(written).not.toHaveProperty("effects");
  });

  it("removes a gradient turned off", () => {
    let state = updateDecoration(one(), "dec-0001", {
      style: { gradient: { colors: [...PASTEL_RAINBOW] } },
    });
    expect(state.decorations[0]?.style?.gradient).toBeDefined();
    state = updateDecoration(state, "dec-0001", { style: { gradient: undefined } });
    expect(state.decorations[0]?.style).toBeUndefined();
  });

  it("records nothing when an edit changes nothing", () => {
    const state = updateDecoration(one(), "dec-0001", { effects: { sparkle: { ratePerSec: 2 } } });
    expect(updateDecoration(state, "dec-0001", { effects: { sparkle: { ratePerSec: 2 } } }))
      .toBe(state);
  });
});

describe("presets", () => {
  it("never put their own name into the document", () => {
    // The point of a preset being a UI convenience: a chart must never say which one an
    // author reached for, so no Player has to know what any of them meant and a preset
    // can be retuned or dropped without touching a single file.
    //
    // Checked over the document's *values*, not its text. Some preset ids - `glow`,
    // `sparkle` - are also the contract's own names for properties, and those keys are
    // exactly what a decorated caption is supposed to contain. What must never appear is
    // a preset's name stored as data.
    const names = new Set(
      APPEARANCE_PRESETS.flatMap((preset) => [preset.id, preset.label, preset.hint]),
    );
    const values = (node: unknown): string[] => {
      if (typeof node === "string") return [node];
      if (Array.isArray(node)) return node.flatMap(values);
      if (node !== null && typeof node === "object") {
        return Object.values(node as Record<string, unknown>).flatMap(values);
      }
      return [];
    };

    for (const preset of APPEARANCE_PRESETS) {
      const patch = presetPatch(preset);
      const state = updateDecoration(place(blank()).state, "dec-0001", {
        style: patch.style, effects: patch.effects,
      });
      for (const value of values(serializeChart(state))) {
        expect(names.has(value)).toBe(false);
      }
    }
  });

  it("never put the song this was built for into the document", () => {
    const patch = presetPatch(KIRAMEKI!);
    const state = updateDecoration(place(blank()).state, "dec-0001", {
      style: patch.style, effects: patch.effects,
    });
    // The caption itself is the author's text and of course survives; nothing else in
    // the document may name the preset or the song.
    const written = serializeChart(state);
    const decoration = (written["decorations"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const withoutText = JSON.stringify({ ...decoration, text: undefined });
    for (const name of ["kirameki", "Kirameki", "キラメキ"]) {
      expect(withoutText).not.toContain(name);
    }
  });

  it("expand Kirameki into ordinary generic properties", () => {
    expect(KIRAMEKI).not.toBeNull();
    const patch = presetPatch(KIRAMEKI!);
    const state = updateDecoration(place(blank()).state, "dec-0001", {
      style: patch.style, effects: patch.effects,
    });
    const decoration = state.decorations[0];
    expect(decoration?.style?.gradient?.colors).toEqual(PASTEL_RAINBOW);
    expect(decoration?.style?.gradient?.cycleSec).toBe(8);
    expect(decoration?.style?.glow).toBeDefined();
    expect(decoration?.effects?.shimmer).toBeDefined();
    expect(decoration?.effects?.sparkle).toBeDefined();
    expect(decoration?.effects?.meteor).toBeDefined();
  });

  it("are recognised again from the properties alone", () => {
    for (const preset of APPEARANCE_PRESETS) {
      const patch = presetPatch(preset);
      const state = updateDecoration(place(blank()).state, "dec-0001", {
        style: patch.style, effects: patch.effects,
      });
      const decoration = state.decorations[0];
      expect(matchingPreset(decoration?.style, decoration?.effects)?.id).toBe(preset.id);
    }
  });

  it("report nothing once an author changes a value by hand", () => {
    const patch = presetPatch(KIRAMEKI!);
    let state = updateDecoration(place(blank()).state, "dec-0001", {
      style: patch.style, effects: patch.effects,
    });
    state = updateDecoration(state, "dec-0001", {
      effects: { sparkle: { ratePerSec: 30 } },
    });
    const decoration = state.decorations[0];
    expect(matchingPreset(decoration?.style, decoration?.effects)).toBeNull();
  });

  it("take a decoration back to plain, removing what the last preset added", () => {
    const kirameki = presetPatch(KIRAMEKI!);
    let state = updateDecoration(place(blank()).state, "dec-0001", {
      style: kirameki.style, effects: kirameki.effects,
    });
    const plain = presetPatch(presetById("plain")!);
    state = updateDecoration(state, "dec-0001", {
      style: plain.style, effects: plain.effects,
    });
    const decoration = state.decorations[0];
    expect(decoration?.style?.gradient).toBeUndefined();
    expect(decoration?.style?.glow).toBeUndefined();
    expect(decoration?.effects).toBeUndefined();
  });

  it("leave the text's size and position alone", () => {
    const state = place(blank(), { style: { fontSize: 0.2 }, position: { x: 0.2, y: 0.8 } }).state;
    const patch = presetPatch(KIRAMEKI!);
    const after = updateDecoration(state, "dec-0001", {
      style: patch.style, effects: patch.effects,
    });
    expect(after.decorations[0]?.style?.fontSize).toBe(0.2);
    expect(after.decorations[0]?.position).toEqual({ x: 0.2, y: 0.8 });
  });
});

describe("through the session", () => {
  const withVisuals = () => {
    const session = openSession(place(blank()).state);
    const patch = presetPatch(KIRAMEKI!);
    return editDecoration(selectDecoration(session, "dec-0001"), "dec-0001", {
      style: patch.style, effects: patch.effects,
    });
  };

  it("applying a preset is one step of undo", () => {
    const after = withVisuals();
    expect(chartOf(after).decorations[0]?.effects).toBeDefined();
    const back = undo(after);
    expect(chartOf(back).decorations[0]?.effects).toBeUndefined();
    expect(chartOf(redo(back)).decorations[0]?.effects).toBeDefined();
  });

  it("a further tweak is its own step", () => {
    let session = withVisuals();
    session = editDecoration(session, "dec-0001", { effects: { sparkle: { ratePerSec: 12 } } });
    expect(chartOf(session).decorations[0]?.effects?.sparkle?.ratePerSec).toBe(12);
    // Undoing the tweak leaves the preset standing.
    const back = undo(session);
    expect(chartOf(back).decorations[0]?.effects?.sparkle?.ratePerSec).toBe(2.6);
    expect(chartOf(back).decorations[0]?.style?.gradient).toBeDefined();
  });

  it("copy and paste carries the visuals to the new decoration", () => {
    const session = withVisuals();
    const clipboard = copySelection(chartOf(session), [], ["dec-0001"]);
    const pasted = pasteInto(chartOf(session), clipboard, 20);
    const copy = pasted.state.decorations.find((d) => d.id !== "dec-0001");
    expect(copy?.style?.gradient?.colors).toEqual(PASTEL_RAINBOW);
    expect(copy?.effects?.meteor?.direction).toBe("downRight");
    // A different id, so its sparkle pattern is its own rather than a duplicate.
    expect(copy?.id).not.toBe("dec-0001");
  });
});
