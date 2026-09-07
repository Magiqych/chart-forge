/**
 * The playback speeds the toolbar offers.
 *
 * A list, not a slider, so every speed an author uses is one they can return to exactly;
 * these tests are about that list staying the set it is meant to be, and about the two
 * slow ones being genuinely usable rather than merely present.
 */

import { describe, expect, it } from "vitest";

import { formatPlaybackRate, PLAYBACK_RATES } from "./Toolbar";

describe("the playback speeds on offer", () => {
  it("offers the two slow speeds a transcriber works at", () => {
    expect(PLAYBACK_RATES).toContain(0.25);
    expect(PLAYBACK_RATES).toContain(0.1);
  });

  it("keeps the speeds that were already there", () => {
    for (const rate of [0.5, 0.75, 1, 1.25]) expect(PLAYBACK_RATES).toContain(rate);
  });

  it("is exactly this set", () => {
    expect([...PLAYBACK_RATES]).toEqual([0.1, 0.25, 0.5, 0.75, 1, 1.25]);
  });

  it("ascends, so the list reads as a scale", () => {
    const sorted = [...PLAYBACK_RATES].sort((a, b) => a - b);
    expect([...PLAYBACK_RATES]).toEqual(sorted);
  });

  it("offers each speed once", () => {
    expect(new Set(PLAYBACK_RATES).size).toBe(PLAYBACK_RATES.length);
  });

  it("stays inside what a media element will actually play", () => {
    // Below about 1/16 speed a browser stops rendering audio and the note clicks would be
    // the only thing left to hear. 0.10x is comfortably above that floor.
    for (const rate of PLAYBACK_RATES) {
      expect(rate).toBeGreaterThanOrEqual(0.0625);
      expect(rate).toBeLessThanOrEqual(16);
    }
  });
});

describe("how a speed is written", () => {
  it("uses two decimals for every entry", () => {
    expect(PLAYBACK_RATES.map(formatPlaybackRate)).toEqual([
      "0.10x", "0.25x", "0.50x", "0.75x", "1.00x", "1.25x",
    ]);
  });

  it("gives every label the same width, so the list reads as a column", () => {
    const widths = new Set(PLAYBACK_RATES.map((rate) => formatPlaybackRate(rate).length));
    expect(widths.size).toBe(1);
  });
});
