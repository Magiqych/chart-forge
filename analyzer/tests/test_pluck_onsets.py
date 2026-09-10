"""The judgement inside the guitar onset detector.

`pick_onsets` is a pure function of an envelope, so the cases that actually decide whether
the feature is usable can be built directly rather than hoped for from a real recording:
a strummed chord that must collapse to one event, a fast cutting figure that must not, a
silent stem that must produce nothing at all.

The envelopes here are synthetic and are not claimed to be guitar. They are claimed to
have the *shape* that each awkward case has, which is what the picker sees.
"""

from __future__ import annotations

import unittest

import numpy as np

from analyzer import pluck

HOP = pluck.HOP_LENGTH / 44100.0     # 0.0116 s, the real frame rate


def envelope(length_sec=4.0, background=1.0):
    """A flat quiet background, long enough for the rolling median to be meaningful."""
    return np.full(int(round(length_sec / HOP)), float(background))


def frame(time_sec):
    return int(round(time_sec / HOP))


def spike(env, time_sec, height, width=1):
    """A transient: one or a few frames well above the background."""
    start = frame(time_sec)
    env[start:start + width] = height
    return env


def times(onsets):
    return [round(o.time_sec, 3) for o in onsets]


class TestOneClearAttack(unittest.TestCase):
    def test_finds_an_isolated_transient(self):
        env = spike(envelope(), 1.0, 20.0)
        onsets = pluck.pick_onsets(env, HOP)
        self.assertEqual(len(onsets), 1)
        self.assertAlmostEqual(onsets[0].time_sec, 1.0, places=2)

    def test_reports_the_envelope_height_as_strength(self):
        env = spike(envelope(), 1.0, 20.0)
        self.assertAlmostEqual(pluck.pick_onsets(env, HOP)[0].strength, 20.0)

    def test_a_transient_out_of_near_silence_is_confident(self):
        env = spike(envelope(background=0.05), 1.0, 20.0)
        self.assertGreater(pluck.pick_onsets(env, HOP)[0].confidence, 0.9)

    def test_a_transient_barely_above_its_background_is_not(self):
        env = spike(envelope(background=1.0), 1.0, 1.6)
        onsets = pluck.pick_onsets(env, HOP)
        if onsets:
            self.assertLess(onsets[0].confidence, 0.5)

    def test_nothing_is_ever_emitted_below_the_stated_confidence(self):
        # The threshold and the confidence floor are one rule, so this is the only floor
        # there is and everything emitted has to clear it.
        env = envelope(background=1.0)
        for i, height in enumerate((1.1, 1.35, 2.0, 4.0, 30.0)):
            spike(env, 0.5 + i * 0.5, height)
        for onset in pluck.pick_onsets(env, HOP):
            self.assertGreaterEqual(onset.confidence, pluck.MIN_CONFIDENCE)


class TestStrummedChord(unittest.TestCase):
    """Six strings over 25 ms is one event to a listener and must be one event here."""

    def setUp(self):
        self.env = envelope()
        for offset, height in ((0.000, 12.0), (0.007, 18.0), (0.016, 15.0), (0.025, 9.0)):
            spike(self.env, 2.0 + offset, height)

    def test_collapses_to_a_single_event(self):
        # The exact cluster the brief calls out: 12.100, 12.107, 12.116, 12.125.
        onsets = pluck.pick_onsets(self.env, HOP)
        self.assertEqual(len(onsets), 1, "a strum must not become four markers")

    def test_lands_at_the_start_of_the_strum_not_its_loudest_string(self):
        # The player's hand arrived at the first string; that is the beat they played.
        onset = pluck.pick_onsets(self.env, HOP)[0]
        self.assertLess(abs(onset.time_sec - 2.0), 0.02)


class TestFastCutting(unittest.TestCase):
    """The opposite risk: real events close together that must all survive."""

    def test_keeps_sixteenths_at_200_bpm(self):
        env = envelope()
        expected = [1.0 + i * 0.075 for i in range(8)]
        for at in expected:
            spike(env, at, 15.0)
        onsets = pluck.pick_onsets(env, HOP)
        self.assertEqual(len(onsets), 8)
        for got, want in zip(times(onsets), expected):
            self.assertLess(abs(got - want), 0.02)

    def test_keeps_thirty_seconds_at_150_bpm(self):
        env = envelope()
        expected = [1.0 + i * 0.05 for i in range(6)]
        for at in expected:
            spike(env, at, 15.0)
        self.assertEqual(len(pluck.pick_onsets(env, HOP)), 6)

    def test_keeps_quiet_muted_cutting(self):
        # Muted strokes are quiet in absolute terms but sharp against their own passage,
        # which is exactly what an adaptive threshold is for.
        env = envelope(background=0.2)
        for i in range(6):
            spike(env, 1.0 + i * 0.09, 1.2)
        self.assertEqual(len(pluck.pick_onsets(env, HOP)), 6)

    def test_the_enforced_spacing_is_never_shorter_than_the_stated_one(self):
        # It was, by rounding: at the real frame rate a stated 40 ms became 34.8 ms,
        # because 40 ms is 3.44 frames and 3.44 rounds to 3. A pair placed just inside
        # the stated minimum must collapse, at this hop and at any other.
        for hop in (HOP, 0.01, 0.005, 0.02):
            # Stated in frames, because placing the pair in seconds quantises it back
            # onto the grid and can land it exactly on the boundary. The gap here is the
            # largest that is still strictly shorter than the stated minimum.
            gap = int(pluck.MIN_SPACING_SEC / hop)
            if gap * hop >= pluck.MIN_SPACING_SEC:
                gap -= 1
            self.assertGreater(gap, 0, "hop {0}".format(hop))

            first = int(round(1.0 / hop))
            env = np.full(int(round(6.0 / hop)), 1.0)
            env[first] = 20.0
            env[first + gap] = 18.0
            onsets = pluck.pick_onsets(env, hop)
            self.assertEqual(
                len(onsets), 1,
                "hop {0}: a pair {1:.4f} s apart is inside the stated {2} s minimum"
                .format(hop, gap * hop, pluck.MIN_SPACING_SEC),
            )

    def test_the_spacing_rule_admits_everything_a_player_can_play(self):
        # A statement about the constant rather than about one envelope: 40 ms allows
        # 25 events a second, well past any rhythm on a fretboard.
        self.assertLessEqual(pluck.MIN_SPACING_SEC, 0.05)
        self.assertGreaterEqual(pluck.MIN_SPACING_SEC, 0.02)


class TestSustainAndSwell(unittest.TestCase):
    def test_a_long_sustain_produces_one_event_not_hundreds(self):
        # A struck chord ringing on: one attack, then an exponential decay - which is
        # what a string does, and unlike a linear ramp it spends most of its length quiet.
        env = envelope(length_sec=8.0, background=0.1)
        start = frame(1.0)
        tail = int(round(4.0 / HOP))
        env[start:start + tail] = 20.0 * np.exp(-np.arange(tail) * HOP / 0.7) + 0.1
        self.assertEqual(len(pluck.pick_onsets(env, HOP)), 1)

    def test_a_slow_swell_is_not_an_onset_at_every_frame(self):
        # A volume-pedal swell has no attack; whatever is reported must not be a stream.
        env = envelope(background=0.1)
        start = frame(1.0)
        ramp = np.linspace(0.1, 8.0, int(round(2.0 / HOP)))
        env[start:start + ramp.size] = ramp
        self.assertLessEqual(len(pluck.pick_onsets(env, HOP)), 2)


class TestSilenceAndDegenerateInput(unittest.TestCase):
    def test_a_silent_stem_produces_nothing(self):
        # Without a floor under the background this is where thousands of events came
        # from: in silence every trace of numerical noise clears a ratio test.
        self.assertEqual(pluck.pick_onsets(np.zeros(4000), HOP), ())

    def test_numerical_noise_in_silence_produces_nothing(self):
        rng = np.random.default_rng(7)
        env = rng.random(4000) * 1e-9
        self.assertEqual(pluck.pick_onsets(env, HOP), ())

    def test_a_stem_that_is_quiet_except_for_one_passage_stays_sensitive(self):
        # The floor is a fraction of the whole stem's mean, so a quiet passage inside a
        # loud song must still be able to report its own notes.
        env = envelope(background=0.1, length_sec=20.0)
        for i in range(20):
            spike(env, 1.0 + i * 0.5, 30.0)      # a loud passage, raising the mean
        for i in range(4):
            spike(env, 15.0 + i * 0.5, 2.0)      # a quiet one, still well above its floor
        found = [t for t in times(pluck.pick_onsets(env, HOP)) if t >= 14.9]
        self.assertEqual(len(found), 4)

    def test_an_empty_envelope_is_not_an_error(self):
        self.assertEqual(pluck.pick_onsets(np.zeros(0), HOP), ())

    def test_a_nonsensical_hop_is_not_an_error(self):
        env = spike(envelope(), 1.0, 20.0)
        self.assertEqual(pluck.pick_onsets(env, 0.0), ())
        self.assertEqual(pluck.pick_onsets(env, float("nan")), ())

    def test_non_finite_frames_never_reach_a_timestamp(self):
        env = spike(envelope(), 1.0, 20.0)
        env[frame(2.0)] = np.nan
        env[frame(2.5)] = np.inf
        for onset in pluck.pick_onsets(env, HOP):
            self.assertTrue(np.isfinite(onset.time_sec))
            self.assertTrue(np.isfinite(onset.strength))
            self.assertTrue(np.isfinite(onset.confidence))


class TestOutputShape(unittest.TestCase):
    def setUp(self):
        env = envelope()
        for i in range(12):
            spike(env, 0.5 + i * 0.27, 10.0 + i)
        self.onsets = pluck.pick_onsets(env, HOP)

    def test_is_ascending(self):
        got = times(self.onsets)
        self.assertEqual(got, sorted(got))

    def test_respects_the_minimum_spacing_everywhere(self):
        got = times(self.onsets)
        for earlier, later in zip(got, got[1:]):
            self.assertGreaterEqual(later - earlier, pluck.MIN_SPACING_SEC - 1e-9)

    def test_never_reports_a_negative_time(self):
        for onset in self.onsets:
            self.assertGreaterEqual(onset.time_sec, 0.0)

    def test_confidence_stays_inside_its_stated_range(self):
        for onset in self.onsets:
            self.assertGreaterEqual(onset.confidence, 0.0)
            self.assertLessEqual(onset.confidence, 1.0)

    def test_is_deterministic(self):
        env = envelope()
        for i in range(12):
            spike(env, 0.5 + i * 0.27, 10.0 + i)
        self.assertEqual(pluck.pick_onsets(env, HOP), self.onsets)


class TestConfidenceDefinition(unittest.TestCase):
    """The one number this branch asks a consumer to trust, checked against its sentence."""

    def test_a_peak_level_with_its_background_has_no_confidence(self):
        self.assertEqual(pluck.confidence_of(5.0, 5.0), 0.0)

    def test_a_peak_below_its_background_has_no_confidence(self):
        self.assertEqual(pluck.confidence_of(4.0, 5.0), 0.0)

    def test_it_is_the_fraction_standing_above_the_background(self):
        self.assertAlmostEqual(pluck.confidence_of(10.0, 2.5), 0.75)
        self.assertAlmostEqual(pluck.confidence_of(4.0, 3.0), 0.25)

    def test_it_approaches_one_out_of_silence(self):
        self.assertGreater(pluck.confidence_of(100.0, 0.0), 0.99)

    def test_it_rejects_nonsense_rather_than_propagating_it(self):
        for peak in (0.0, -1.0, float("nan"), float("inf")):
            value = pluck.confidence_of(peak, 1.0)
            self.assertTrue(0.0 <= value <= 1.0, peak)


class TestRollingMedian(unittest.TestCase):
    def test_ignores_a_spike_rather_than_following_it(self):
        values = np.ones(101)
        values[50] = 1000.0
        self.assertAlmostEqual(pluck.rolling_median(values, 10)[50], 1.0)

    def test_tracks_a_change_in_level(self):
        values = np.concatenate([np.ones(200), np.full(200, 5.0)])
        median = pluck.rolling_median(values, 10)
        self.assertAlmostEqual(median[100], 1.0)
        self.assertAlmostEqual(median[300], 5.0)

    def test_handles_the_edges_without_inventing_padding(self):
        values = np.arange(10, dtype=float)
        median = pluck.rolling_median(values, 3)
        self.assertEqual(median.size, values.size)
        self.assertTrue(np.all(np.isfinite(median)))

    def test_an_empty_array_stays_empty(self):
        self.assertEqual(pluck.rolling_median(np.zeros(0), 5).size, 0)


if __name__ == "__main__":
    unittest.main()


class TestPresenceAgainstTheMix(unittest.TestCase):
    """Whether a stem holds a played instrument or the bleed of everything else.

    The judgement that decides whether a whole guide layer exists, so it is checked
    against the levels actually measured on a real six-source run rather than in the
    abstract.
    """

    #: dB below the mix, measured on the first real run of "Kirameki (TV Size)".
    MEASURED = {
        "vocals": -6.0, "drums": -8.1, "bass": -7.3,
        "guitar": -10.2, "other": -13.9, "piano": -26.0,
    }

    def test_it_keeps_every_stem_that_was_actually_played(self):
        for name, level in self.MEASURED.items():
            if name == "piano":
                continue
            self.assertGreater(level, pluck.PRESENCE_FLOOR_DB, name)

    def test_it_rejects_the_bleed_stem_of_a_song_with_no_piano(self):
        # 2156 attacks were reported for this stem before the floor existed.
        self.assertLess(self.MEASURED["piano"], pluck.PRESENCE_FLOOR_DB)

    def test_the_floor_sits_between_them_with_room_on_both_sides(self):
        quietest_real = min(v for k, v in self.MEASURED.items() if k != "piano")
        self.assertGreater(quietest_real - pluck.PRESENCE_FLOOR_DB, 4.0)
        self.assertGreater(pluck.PRESENCE_FLOOR_DB - self.MEASURED["piano"], 4.0)

    def test_a_stem_as_loud_as_the_mix_is_present(self):
        self.assertTrue(pluck.is_present(0.28, 0.28))

    def test_a_silent_stem_is_not(self):
        self.assertFalse(pluck.is_present(0.0, 0.28))

    def test_a_silent_mix_does_not_divide_by_zero(self):
        self.assertFalse(pluck.is_present(0.1, 0.0))
        self.assertEqual(pluck.relative_level_db(0.1, 0.0), float("-inf"))

    def test_the_level_is_the_ordinary_dB_ratio(self):
        self.assertAlmostEqual(pluck.relative_level_db(0.5, 0.5), 0.0)
        self.assertAlmostEqual(pluck.relative_level_db(0.05, 0.5), -20.0)
        self.assertAlmostEqual(pluck.relative_level_db(0.25, 0.5), -6.0206, places=3)

    def test_rms_is_zero_for_nothing_rather_than_a_nan(self):
        self.assertEqual(pluck.rms(np.zeros(0)), 0.0)
        self.assertEqual(pluck.rms(np.zeros(100)), 0.0)
        self.assertAlmostEqual(pluck.rms(np.ones(100)), 1.0)

    def test_rms_ignores_a_broken_sample_rather_than_returning_nan(self):
        samples = np.ones(100)
        samples[7] = np.nan
        self.assertTrue(np.isfinite(pluck.rms(samples)))
