"""Ids, ordering, pitch conversion, endKind mapping and the write guard."""

import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from analyzer import document


class TestEventIds(unittest.TestCase):
    def test_branch_and_index_format(self):
        self.assertEqual(document.event_id("drums", 1), "ev-drums-000001")
        self.assertEqual(document.event_id("other", 1), "ev-other-000001")
        self.assertEqual(document.event_id("bass", 463), "ev-bass-000463")
        self.assertEqual(document.event_id("vocals", 477), "ev-vocals-000477")

    def test_six_digits_are_zero_padded_and_sort_lexicographically(self):
        ids = [document.event_id("drums", n) for n in (1, 2, 10, 100, 1093)]
        self.assertEqual(ids, sorted(ids),
                         "zero padding must make lexicographic order match numeric order")

    def test_index_is_one_based(self):
        with self.assertRaises(ValueError):
            document.event_id("drums", 0)

    def test_ids_are_deterministic(self):
        self.assertEqual(document.event_id("bass", 7), document.event_id("bass", 7))


class TestEventOrdering(unittest.TestCase):
    def test_sorted_by_start_then_id(self):
        events = [
            {"id": "ev-other-000001", "startSec": 2.0},
            {"id": "ev-drums-000002", "startSec": 1.0},
            {"id": "ev-drums-000001", "startSec": 1.0},
            {"id": "ev-bass-000001", "startSec": 0.5},
        ]
        ordered = [e["id"] for e in document.sort_events(events)]
        self.assertEqual(ordered, ["ev-bass-000001", "ev-drums-000001",
                                   "ev-drums-000002", "ev-other-000001"])

    def test_equal_timestamps_break_ties_on_id(self):
        events = [
            {"id": "ev-other-000005", "startSec": 3.0},
            {"id": "ev-bass-000009", "startSec": 3.0},
            {"id": "ev-drums-000007", "startSec": 3.0},
        ]
        ordered = [e["id"] for e in document.sort_events(events)]
        self.assertEqual(ordered, sorted(ordered))

    def test_sorting_is_stable_and_idempotent(self):
        events = [{"id": document.event_id("drums", n), "startSec": (n % 5) * 0.25}
                  for n in range(1, 40)]
        once = document.sort_events(events)
        self.assertEqual([e["id"] for e in once],
                         [e["id"] for e in document.sort_events(once)])


class TestPitchConversion(unittest.TestCase):
    def test_concert_a_is_midi_69(self):
        self.assertAlmostEqual(document.hz_to_midi(440.0), 69.0, places=9)

    def test_octaves(self):
        self.assertAlmostEqual(document.hz_to_midi(880.0), 81.0, places=9)
        self.assertAlmostEqual(document.hz_to_midi(220.0), 57.0, places=9)

    def test_fractional_midi_is_retained(self):
        midi = document.hz_to_midi(442.5)
        self.assertNotEqual(midi, round(midi), "detuning must not be rounded away")
        self.assertAlmostEqual(midi, 69.0 + 12.0 * math.log2(442.5 / 440.0), places=9)

    def test_standard_formula(self):
        for hz in (55.0, 123.47, 329.63, 987.77):
            self.assertAlmostEqual(document.hz_to_midi(hz),
                                   69.0 + 12.0 * math.log2(hz / 440.0), places=9)

    def test_non_positive_frequency_rejected(self):
        for hz in (0.0, -10.0):
            with self.assertRaises(ValueError):
                document.hz_to_midi(hz)

    def test_note_names_use_the_project_convention(self):
        self.assertEqual(document.hz_to_note_name(440.0), "A4")
        self.assertEqual(document.hz_to_note_name(261.626), "C4")
        # Sharps, not flats, and the Unicode sign librosa emits - the convention the
        # earlier real documents already use.
        self.assertEqual(document.hz_to_note_name(466.164), "A♯4")


class TestEndKind(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual(document.END_KIND_BY_TYPE["percussion"], "instantaneous")
        self.assertEqual(document.END_KIND_BY_TYPE["onset"], "instantaneous")
        self.assertEqual(document.END_KIND_BY_TYPE["pitch-run"], "bounded")

    def test_onset_event_is_instantaneous_with_no_end(self):
        event = document.make_onset_event("drums", 1, "percussion", 1.5, "stem-drums", 4.21)
        self.assertEqual(event["endKind"], "instantaneous")
        self.assertNotIn("endSec", event)
        self.assertNotIn("durationSec", event)
        self.assertEqual(event["detectorId"], document.DETECTOR_ONSET)
        self.assertEqual(event["source"], {"stemId": "stem-drums"})
        self.assertNotIn("instrument", event["source"])

    def test_generic_onset_type(self):
        event = document.make_onset_event("other", 3, "onset", 2.0, "stem-other", 1.9)
        self.assertEqual(event["type"], "onset")
        self.assertEqual(event["endKind"], "instantaneous")

    def test_pitch_run_is_bounded_with_consistent_duration(self):
        event = document.make_pitch_run_event(
            branch="bass", index=2, start_sec=1.0, end_sec=1.5,
            stem_id="stem-bass", instrument="bass",
            pitch_segment=np.array([110.0, 110.5, 109.5]),
            periodicity_segment=np.array([0.8, 0.85, 0.9]),
        )
        self.assertEqual(event["endKind"], "bounded")
        self.assertIn("endSec", event)
        self.assertAlmostEqual(
            event["durationSec"], event["endSec"] - event["startSec"], places=6)
        self.assertEqual(event["detectorId"], document.DETECTOR_PITCH)
        self.assertEqual(event["source"]["instrument"], "bass")
        self.assertEqual(event["metadata"]["frameCount"], 3)
        self.assertEqual(event["metadata"]["rawScore"]["kind"], "periodicity-median")
        self.assertAlmostEqual(event["metadata"]["rawScore"]["value"], 0.85, places=4)

    def test_pitch_uses_the_run_median(self):
        event = document.make_pitch_run_event(
            branch="vocals", index=1, start_sec=0.0, end_sec=0.1,
            stem_id="stem-vocals", instrument="vocal",
            pitch_segment=np.array([430.0, 440.0, 450.0]),
            periodicity_segment=np.array([0.7, 0.7, 0.7]),
        )
        self.assertAlmostEqual(event["pitch"]["hz"], 440.0, places=4)
        self.assertAlmostEqual(event["pitch"]["midi"], 69.0, places=4)
        self.assertEqual(event["pitch"]["name"], "A4")

    def test_point_like_type_required_for_onset_events(self):
        with self.assertRaises(ValueError):
            document.make_onset_event("bass", 1, "pitch-run", 1.0, "stem-bass", 1.0)

    def test_empty_pitch_run_rejected(self):
        with self.assertRaises(ValueError):
            document.make_pitch_run_event(
                branch="bass", index=1, start_sec=0.0, end_sec=0.1,
                stem_id="stem-bass", instrument="bass",
                pitch_segment=np.array([]), periodicity_segment=np.array([]))


class TestNoConfidence(unittest.TestCase):
    def test_events_never_carry_confidence(self):
        events = [
            document.make_onset_event("drums", 1, "percussion", 0.5, "stem-drums", 3.0),
            document.make_onset_event("other", 1, "onset", 0.7, "stem-other", 1.5),
            document.make_pitch_run_event(
                branch="bass", index=1, start_sec=1.0, end_sec=1.2,
                stem_id="stem-bass", instrument="bass",
                pitch_segment=np.array([82.4, 82.6]),
                periodicity_segment=np.array([0.6, 0.62])),
        ]
        for event in events:
            self.assertNotIn("confidence", event)
            self.assertNotIn("confidence", event.get("metadata", {}))

    def test_detector_identity_is_not_duplicated_into_metadata(self):
        event = document.make_onset_event("drums", 1, "percussion", 0.5, "stem-drums", 3.0)
        self.assertNotIn("detector", event["metadata"],
                         "provenance belongs in detectorId, not repeated per event")


class TestNonFiniteRejected(unittest.TestCase):
    def test_nan_start_is_refused(self):
        with self.assertRaises(ValueError):
            document.make_onset_event("drums", 1, "percussion", float("nan"),
                                      "stem-drums", 1.0)

    def test_infinite_strength_is_refused(self):
        with self.assertRaises(ValueError):
            document.make_onset_event("drums", 1, "percussion", 1.0,
                                      "stem-drums", float("inf"))


class TestWriteAtomic(unittest.TestCase):
    def test_writes_and_reparses(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "analysis.json"
            document.write_atomic({"version": "0.2.0", "note": "キラメキ"},
                                  target)
            reloaded = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(reloaded["version"], "0.2.0")
            self.assertEqual(reloaded["note"], "キラメキ")

    def test_refuses_to_overwrite_an_existing_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "analysis.json"
            target.write_text('{"existing": true}', encoding="utf-8")
            with self.assertRaises(FileExistsError):
                document.write_atomic({"version": "0.2.0"}, target)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")),
                             {"existing": True})

    def test_leaves_no_temporary_file_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "analysis.json"
            document.write_atomic({"version": "0.2.0"}, target)
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["analysis.json"])

    def test_non_finite_numbers_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "analysis.json"
            with self.assertRaises(ValueError):
                document.write_atomic({"bad": float("nan")}, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
