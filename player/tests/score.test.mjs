/**
 * Score, combo, and the timing statistics the offset control is built on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createScoreboard, suggestedOffsetSec, formatJudgement, MAX_SCORE } from "../web/score.js";
import { sanitize, DEFAULTS, OFFSET_LIMIT_MS } from "../web/settings.js";

const hit = (result, deltaSec = 0, extra = {}) => ({ result, deltaSec, auto: false, ...extra });

describe("scoreboard", () => {
  it("is a full million for a perfect run and nothing for a missed one", () => {
    const perfect = createScoreboard(4);
    for (let i = 0; i < 4; i += 1) perfect.apply(hit("perfect"));
    assert.equal(perfect.snapshot().score, MAX_SCORE);
    assert.ok(perfect.snapshot().fullCombo);

    const nothing = createScoreboard(4);
    for (let i = 0; i < 4; i += 1) nothing.apply(hit("miss"));
    assert.equal(nothing.snapshot().score, 0);
    assert.ok(!nothing.snapshot().fullCombo);
  });

  it("breaks the combo on a miss and remembers the best one", () => {
    const board = createScoreboard(6);
    board.apply(hit("perfect"));
    board.apply(hit("great"));
    board.apply(hit("good"));
    board.apply(hit("miss"));
    board.apply(hit("perfect"));
    const snapshot = board.snapshot();
    assert.equal(snapshot.combo, 1);
    assert.equal(snapshot.maxCombo, 3);
    assert.equal(snapshot.counts.miss, 1);
    assert.equal(snapshot.judged, 5);
  });

  it("is not a full combo until every point has been judged", () => {
    const board = createScoreboard(3);
    board.apply(hit("perfect"));
    board.apply(hit("perfect"));
    assert.ok(!board.snapshot().fullCombo);
    board.apply(hit("great"));
    assert.ok(board.snapshot().fullCombo);
  });

  it("averages the player's own timing and leaves automatic judgements out of it", () => {
    const board = createScoreboard(3);
    board.apply(hit("great", 0.02));
    board.apply(hit("great", 0.04));
    board.apply(hit("perfect", -1, { auto: true }));
    const snapshot = board.snapshot();
    assert.equal(snapshot.sampleCount, 2);
    assert.ok(Math.abs(snapshot.meanDeltaSec - 0.03) < 1e-9);
    assert.ok(Math.abs(snapshot.latestDeltaSec - 0.04) < 1e-9);
  });

  it("goes back to nothing when reset", () => {
    const board = createScoreboard(2);
    board.apply(hit("perfect"));
    board.reset();
    const snapshot = board.snapshot();
    assert.equal(snapshot.score, 0);
    assert.equal(snapshot.judged, 0);
    assert.equal(snapshot.maxCombo, 0);
  });
});

describe("suggested offset", () => {
  it("says nothing until there are enough hits to mean anything", () => {
    const board = createScoreboard(50);
    for (let i = 0; i < 5; i += 1) board.apply(hit("great", 0.03));
    assert.equal(suggestedOffsetSec(board.snapshot(), 0), null);
  });

  it("moves the offset towards where the player's hands already are", () => {
    const board = createScoreboard(50);
    for (let i = 0; i < 25; i += 1) board.apply(hit("great", 0.03));
    // Hits reading 30 ms late mean the judgement is 30 ms early: add it to the offset.
    assert.equal(suggestedOffsetSec(board.snapshot(), 0), 0.03);
    assert.equal(suggestedOffsetSec(board.snapshot(), 0.02), 0.05);
  });

  it("moves it the other way for a player who hits early", () => {
    const board = createScoreboard(50);
    for (let i = 0; i < 25; i += 1) board.apply(hit("great", -0.04));
    assert.equal(suggestedOffsetSec(board.snapshot(), 0), -0.04);
  });
});

describe("judgement text", () => {
  it("says how far off the hit was, and which way", () => {
    assert.equal(formatJudgement({ result: "perfect", deltaSec: 0.012 }), "PERFECT +12 ms");
    assert.equal(formatJudgement({ result: "great", deltaSec: -0.057 }), "GREAT −57 ms");
    assert.equal(formatJudgement({ result: "miss", deltaSec: 0 }), "MISS");
  });
});

describe("session settings", () => {
  it("replaces anything strange with its default", () => {
    const settings = sanitize({ noteSpeed: "fast", offsetMs: 9999, playbackRate: -3, autoplay: "yes" });
    assert.equal(settings.noteSpeed, DEFAULTS.noteSpeed);
    assert.equal(settings.offsetMs, OFFSET_LIMIT_MS);
    assert.equal(settings.playbackRate, 0.25);
    assert.equal(settings.autoplay, false, "only a real true turns autoplay on");
  });

  it("keeps what it was given when it is usable", () => {
    const settings = sanitize({ noteSpeed: 2.5, offsetMs: -40, playbackRate: 0.5, hitSound: false });
    assert.equal(settings.noteSpeed, 2.5);
    assert.equal(settings.offsetMs, -40);
    assert.equal(settings.playbackRate, 0.5);
    assert.equal(settings.hitSound, false);
  });

  it("survives being handed nothing at all", () => {
    assert.deepEqual(sanitize(undefined), { ...DEFAULTS });
    assert.deepEqual(sanitize(null), { ...DEFAULTS });
  });
});
