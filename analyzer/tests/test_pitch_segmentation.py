"""Provisional voiced-run segmentation, exercised on small synthetic arrays.

No model is loaded: `segment_runs` is a pure function over a periodicity array, which is
exactly why it was written as one.
"""

import unittest

import numpy as np

from analyzer import pitch


class TestSegmentRuns(unittest.TestCase):
    def test_single_run_bounds_are_inclusive(self):
        periodicity = np.array([0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1])
        self.assertEqual(pitch.segment_runs(periodicity), [(2, 6)])

    def test_run_shorter_than_minimum_is_dropped(self):
        periodicity = np.array([0.1, 0.9, 0.9, 0.9, 0.9, 0.1])   # four frames
        self.assertEqual(pitch.segment_runs(periodicity), [])

    def test_run_of_exactly_minimum_length_is_kept(self):
        periodicity = np.array([0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1])   # five frames
        self.assertEqual(pitch.segment_runs(periodicity), [(1, 5)])

    def test_threshold_is_inclusive(self):
        exactly_at = np.full(6, 0.50)
        self.assertEqual(pitch.segment_runs(exactly_at), [(0, 5)])
        just_below = np.full(6, 0.499999)
        self.assertEqual(pitch.segment_runs(just_below), [])

    def test_multiple_runs_separated_by_a_dip(self):
        periodicity = np.array(
            [0.9] * 6 + [0.1] * 3 + [0.9] * 7 + [0.2] + [0.9] * 5
        )
        self.assertEqual(pitch.segment_runs(periodicity), [(0, 5), (9, 15), (17, 21)])

    def test_run_reaching_the_end_of_the_array_is_closed(self):
        periodicity = np.array([0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9])
        self.assertEqual(pitch.segment_runs(periodicity), [(2, 6)])

    def test_run_starting_at_index_zero(self):
        periodicity = np.array([0.9] * 5 + [0.0] * 3)
        self.assertEqual(pitch.segment_runs(periodicity), [(0, 4)])

    def test_all_unvoiced_gives_no_runs(self):
        self.assertEqual(pitch.segment_runs(np.zeros(50)), [])

    def test_all_voiced_gives_one_run_spanning_everything(self):
        self.assertEqual(pitch.segment_runs(np.ones(50)), [(0, 49)])

    def test_empty_input(self):
        self.assertEqual(pitch.segment_runs(np.array([])), [])

    def test_parameters_are_configurable_without_changing_the_default(self):
        periodicity = np.array([0.1, 0.6, 0.6, 0.1])
        self.assertEqual(pitch.segment_runs(periodicity), [])
        self.assertEqual(
            pitch.segment_runs(periodicity, threshold=0.5, minimum_frames=2), [(1, 2)])

    def test_defaults_match_the_documented_provisional_policy(self):
        self.assertEqual(pitch.PERIODICITY_THRESHOLD, 0.50)
        self.assertEqual(pitch.MINIMUM_RUN_FRAMES, 5)

    def test_rejects_multi_dimensional_input(self):
        with self.assertRaises(ValueError):
            pitch.segment_runs(np.zeros((4, 4)))

    def test_run_times_derive_from_the_frame_hop(self):
        # A run of frames [2, 6] at a 10 ms hop covers 0.02 s to 0.06 s.
        periodicity = np.array([0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1])
        (first, last), = pitch.segment_runs(periodicity)
        hop = 441 / 44100
        self.assertAlmostEqual(first * hop, 0.02, places=9)
        self.assertAlmostEqual(last * hop, 0.06, places=9)


class TestOnsetPeakStrengths(unittest.TestCase):
    def test_peak_is_taken_from_a_window_around_the_frame(self):
        from analyzer import onset

        envelope = np.array([0.0, 1.0, 9.0, 1.0, 0.0, 0.0, 0.0])
        hop = 0.01
        # An onset reported one frame early still picks up the real peak at index 2.
        strengths = onset.peak_strengths(envelope, np.array([0.01]), hop)
        self.assertAlmostEqual(strengths[0], 9.0)

    def test_no_onsets_gives_an_empty_array(self):
        from analyzer import onset

        self.assertEqual(onset.peak_strengths(np.ones(10), np.array([]), 0.01).size, 0)

    def test_indices_are_clamped_to_the_envelope(self):
        from analyzer import onset

        envelope = np.array([1.0, 2.0, 3.0])
        strengths = onset.peak_strengths(envelope, np.array([99.0]), 0.01)
        self.assertAlmostEqual(strengths[0], 3.0)


if __name__ == "__main__":
    unittest.main()
