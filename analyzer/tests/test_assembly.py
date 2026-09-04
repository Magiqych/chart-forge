"""Whole-document assembly and the CLI's overwrite protection.

The document is built from stub detector results, so this exercises the contract logic
without a GPU. It deliberately checks the same things the repository's contract
validator would, so a regression shows up here before a real run is spent on it.
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from analyzer import audio, beat, cli, document, onset, pitch


def _beat_stub():
    return SimpleNamespace(
        beat_times=np.array([0.5, 1.0, 1.5, 2.0]),
        downbeat_times=np.array([0.5, 2.0]),
        beat_logits=np.array([-5.0, 2.0, -4.0, 1.0, -3.0, 0.5, -2.0, 3.0]),
        downbeat_logits=np.array([-6.0, 1.0, -5.0, 0.0, -4.0, 0.2, -3.0, 2.0]),
        frame_hop_sec=0.02,
        seconds=1.0,
        max_cuda_allocated=1, max_cuda_reserved=2,
    )


def _pitch_stub():
    return SimpleNamespace(
        pitch_hz=np.full(12, 110.0), periodicity=np.full(12, 0.8),
        frame_hop_sec=0.01, seconds=1.0,
        max_cuda_allocated=1, max_cuda_reserved=2,
    )


def _onset_stub():
    return SimpleNamespace(
        onset_times=np.array([0.3, 0.9]), onset_strength=np.array([4.0, 2.0]),
        envelope=np.array([0.1, 4.0, 0.2, 2.0]), frame_hop_sec=0.005805, seconds=1.0,
    )


def _build():
    events = [
        document.make_onset_event("drums", 1, "percussion", 0.3, "stem-drums", 4.0),
        document.make_onset_event("drums", 2, "percussion", 0.9, "stem-drums", 2.0),
        document.make_onset_event("other", 1, "onset", 0.3, "stem-other", 1.5),
        document.make_pitch_run_event(
            branch="bass", index=1, start_sec=0.0, end_sec=0.11,
            stem_id="stem-bass", instrument="bass",
            pitch_segment=np.full(12, 110.0), periodicity_segment=np.full(12, 0.8)),
        document.make_pitch_run_event(
            branch="vocals", index=1, start_sec=1.0, end_sec=1.11,
            stem_id="stem-vocals", instrument="vocal",
            pitch_segment=np.full(12, 440.0), periodicity_segment=np.full(12, 0.9)),
    ]
    info = audio.AudioInfo(path=Path("/music/song.flac"), sha256="a" * 64,
                           duration_sec=2.5, sample_rate=44100, channels=2)
    stems = [{"id": "stem-{0}".format(n), "kind": n,
              "path": "stems/{0}.wav".format(n), "sha256": "b" * 64,
              "method": "demucs-infer 4.2.2 / htdemucs"}
             for n in ("drums", "bass", "other", "vocals")]
    beat_result = _beat_stub()
    return document.build_document(
        analyzer_version="0.1.0", audio_info=info, stems=stems,
        detectors=document.build_detectors(pitch, onset, beat),
        beat_times=beat_result.beat_times,
        downbeat_flags=beat.downbeat_flags(beat_result.beat_times,
                                           beat_result.downbeat_times),
        tempo_bpm=beat.representative_bpm(beat_result.beat_times),
        events=events,
        experimental=document.build_experimental(
            beat_result=beat_result,
            pitch_results={"bass": _pitch_stub(), "vocals": _pitch_stub()},
            onset_results={"drums": _onset_stub(), "other": _onset_stub()},
            event_counts={"percussion": 2, "onset": 1,
                          "pitch-run-bass": 1, "pitch-run-vocals": 1},
            stage_seconds={"separate": 1.0},
        ),
    )


class TestDocumentAssembly(unittest.TestCase):
    def setUp(self):
        self.doc = _build()

    def test_versions_are_distinct_concepts(self):
        self.assertEqual(self.doc["version"], "0.2.0")
        self.assertEqual(self.doc["generator"]["version"], "0.1.0")
        self.assertEqual(self.doc["generator"]["name"], "chart-forge-analyzer")

    def test_events_are_ordered_by_start_then_id(self):
        keys = [(e["startSec"], e["id"]) for e in self.doc["events"]]
        self.assertEqual(keys, sorted(keys))

    def test_detector_registry_declares_three_detectors(self):
        ids = [d["id"] for d in self.doc["detectors"]]
        self.assertEqual(sorted(ids), ["det-beat-this", "det-librosa-onset",
                                       "det-torchcrepe"])
        for detector in self.doc["detectors"]:
            self.assertIn("name", detector)
            self.assertIn("version", detector)

    def test_every_event_references_a_declared_detector(self):
        ids = {d["id"] for d in self.doc["detectors"]}
        for event in self.doc["events"]:
            self.assertIn(event["detectorId"], ids)

    def test_every_beat_references_the_beat_detector(self):
        for entry in self.doc["beats"]:
            self.assertEqual(entry["detectorId"], "det-beat-this")

    def test_detector_refs_match_the_branch(self):
        by_stem = {e["source"]["stemId"]: e["detectorId"] for e in self.doc["events"]}
        self.assertEqual(by_stem["stem-drums"], "det-librosa-onset")
        self.assertEqual(by_stem["stem-other"], "det-librosa-onset")
        self.assertEqual(by_stem["stem-bass"], "det-torchcrepe")
        self.assertEqual(by_stem["stem-vocals"], "det-torchcrepe")

    def test_end_kind_agrees_with_the_presence_of_an_end(self):
        for event in self.doc["events"]:
            if event["endKind"] == "bounded":
                self.assertIn("endSec", event)
                self.assertGreaterEqual(event["endSec"], event["startSec"])
            else:
                self.assertNotIn("endSec", event)
                self.assertNotIn("durationSec", event)

    def test_no_confidence_anywhere(self):
        self.assertNotIn("confidence", self.doc["tempo"])
        for entry in self.doc["beats"]:
            self.assertNotIn("confidence", entry)
        for event in self.doc["events"]:
            self.assertNotIn("confidence", event)

    def test_meter_and_tempo_map_are_not_generated(self):
        self.assertNotIn("map", self.doc["tempo"])
        self.assertNotIn("sections", self.doc)
        for entry in self.doc["beats"]:
            self.assertNotIn("barIndex", entry)
            self.assertNotIn("beatInBar", entry)

    def test_downbeat_flags_follow_the_downbeat_times(self):
        flags = [b["isDownbeat"] for b in self.doc["beats"]]
        self.assertEqual(flags, [True, False, False, True])

    def test_tempo_is_derived_from_the_median_interval(self):
        self.assertAlmostEqual(self.doc["tempo"]["bpm"], 120.0, places=4)

    def test_stem_paths_are_relative_to_the_document(self):
        for stem in self.doc["stems"]:
            self.assertFalse(Path(stem["path"]).is_absolute())
            self.assertTrue(stem["path"].startswith("stems/"))

    def test_experimental_block_carries_a_disclaimer_and_the_curves(self):
        experimental = self.doc["metadata"]["experimental"]
        self.assertIn("consumers must not depend on it", experimental["disclaimer"])
        self.assertEqual(len(experimental["beatThis"]["beatLogits"]), 8)
        self.assertEqual(len(experimental["beatThis"]["detectedBeats"]), 4)
        self.assertIn("bass", experimental["torchcrepe"])
        self.assertIn("drums", experimental["librosa"])


class TestBeatHelpers(unittest.TestCase):
    def test_representative_bpm_ignores_a_single_outlier_interval(self):
        # Four regular 0.5 s beats plus one spurious extra close behind: the median
        # interval must still describe the real tempo.
        times = np.array([0.0, 0.5, 0.55, 1.0, 1.5, 2.0, 2.5])
        self.assertAlmostEqual(beat.representative_bpm(times), 120.0, places=4)

    def test_needs_at_least_two_beats(self):
        with self.assertRaises(ValueError):
            beat.representative_bpm(np.array([1.0]))

    def test_downbeat_flags_match_on_time_not_index(self):
        flags = beat.downbeat_flags(np.array([0.0, 0.5, 1.0]), np.array([1.0]))
        self.assertEqual(flags, [False, False, True])


class TestAudioHelpers(unittest.TestCase):
    def test_downmix_averages_channels(self):
        stereo = np.array([[1.0, 3.0], [0.0, 2.0]])
        np.testing.assert_allclose(audio.downmix_to_mono(stereo), [2.0, 1.0])

    def test_mono_input_is_returned_unchanged(self):
        mono = np.array([1.0, 2.0, 3.0])
        np.testing.assert_allclose(audio.downmix_to_mono(mono), mono)

    def test_rejects_three_dimensional_input(self):
        with self.assertRaises(ValueError):
            audio.downmix_to_mono(np.zeros((2, 2, 2)))


class TestOutputSafety(unittest.TestCase):
    def test_empty_directory_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            cli.check_output_targets(Path(tmp))       # must not raise

    def test_existing_analysis_blocks_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "analysis.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(Path(tmp))

    def test_existing_stem_blocks_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = Path(tmp) / "stems"
            stems.mkdir()
            (stems / "drums.wav").write_bytes(b"not really audio")
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(Path(tmp))

    def test_error_names_the_offending_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "analysis.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(FileExistsError) as caught:
                cli.check_output_targets(Path(tmp))
            self.assertIn("analysis.json", str(caught.exception))

    def test_unrelated_files_do_not_block_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "notes.txt").write_text("hello", encoding="utf-8")
            cli.check_output_targets(Path(tmp))       # must not raise


if __name__ == "__main__":
    unittest.main()
