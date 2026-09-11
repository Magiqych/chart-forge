/**
 * Score, combo, and the numbers the result screen shows.
 *
 * Deliberately not a reproduction of any game's scoring formula. This Player exists to
 * verify a chart, and the question an author asks at the end is "did it hold together,
 * and where did it not" - not "what would this have been worth". So the score is a flat
 * share of a million spread over the judgement points, which has the one property that
 * matters here: a full combo is exactly 1,000,000, and anything less is missing
 * something you can go and look at.
 *
 * The timing statistics are the part worth caring about. `meanDeltaSec` over real hits is
 * what tells an author whether the whole chart sits a few milliseconds late, which is a
 * chart problem, or whether their own audio does, which is an offset problem.
 */

export const MAX_SCORE = 1_000_000;

/** What each result is worth, as a fraction of a point's share. */
export const RESULT_WEIGHT = Object.freeze({ perfect: 1, great: 0.7, good: 0.4, miss: 0 });

export function createScoreboard(totalPoints) {
  const total = Math.max(1, totalPoints);
  let weighted = 0;
  let counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  let judged = 0;
  let combo = 0;
  let maxCombo = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  let earliest = 0;
  let latest = 0;

  return {
    /**
     * Take one judgement.
     *
     * `auto` judgements - a long note resolving because it was held through, a point
     * retired when its note was dropped - count for score and combo exactly as any other,
     * but are left out of the timing statistics: they carry the clock's error rather than
     * the player's, and averaging them in would quietly pull the suggested offset towards
     * zero.
     */
    apply(judgement) {
      const result = judgement.result;
      counts[result] = (counts[result] ?? 0) + 1;
      judged += 1;
      weighted += RESULT_WEIGHT[result] ?? 0;
      if (result === "miss") combo = 0;
      else {
        combo += 1;
        if (combo > maxCombo) maxCombo = combo;
      }
      if (!judgement.auto && result !== "miss" && Number.isFinite(judgement.deltaSec)) {
        deltaSum += judgement.deltaSec;
        deltaCount += 1;
        if (judgement.deltaSec < earliest) earliest = judgement.deltaSec;
        if (judgement.deltaSec > latest) latest = judgement.deltaSec;
      }
    },

    reset() {
      weighted = 0;
      counts = { perfect: 0, great: 0, good: 0, miss: 0 };
      judged = 0;
      combo = 0;
      maxCombo = 0;
      deltaSum = 0;
      deltaCount = 0;
      earliest = 0;
      latest = 0;
    },

    snapshot() {
      return {
        score: Math.round((weighted / total) * MAX_SCORE),
        accuracy: judged === 0 ? 0 : weighted / judged,
        counts: { ...counts },
        judged,
        total,
        combo,
        maxCombo,
        fullCombo: judged === total && counts.miss === 0,
        /** Mean signed timing error of the player's own hits; positive is late. */
        meanDeltaSec: deltaCount === 0 ? 0 : deltaSum / deltaCount,
        sampleCount: deltaCount,
        earliestDeltaSec: earliest,
        latestDeltaSec: latest,
      };
    },
  };
}

/**
 * The offset that would have centred this run.
 *
 * Chart time is `audio time - offset`, so a player whose hits all read late by 20 ms has
 * been judged 20 ms early: adding that 20 ms to the offset moves the judgement to where
 * their hands already are. Returned in seconds, rounded to the millisecond, and only
 * once there are enough hits for the average to mean anything.
 */
export function suggestedOffsetSec(snapshot, currentOffsetSec, minimumSamples = 20) {
  if (!snapshot || snapshot.sampleCount < minimumSamples) return null;
  return Math.round((currentOffsetSec + snapshot.meanDeltaSec) * 1000) / 1000;
}

/** "PERFECT +12 ms" - what is shown at the judgement line after a hit. */
export function formatJudgement(judgement) {
  const label = judgement.result.toUpperCase();
  if (judgement.result === "miss") return label;
  const ms = Math.round(judgement.deltaSec * 1000);
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "±";
  return `${label} ${sign}${Math.abs(ms)} ms`;
}
