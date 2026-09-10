"""How a guitar attack reaches the document, and what happens without one.

Two things are being protected. First, that a plucked-string event is an *ordinary* event
- an `onset` with a `source.stemId`, not a type of its own - so a consumer that has never
heard of guitars reads it as a sound starting, which is what the contract's open
vocabulary is for. Second, that everything written before six-source separation existed
goes on working: a four-stem pin, a four-stem model, an analysis with no guitar at all.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from analyzer import cli, document, separation

SR = 44100
DURATION = 2.0


def write_stems(directory: Path, names=separation.CORE_STEM_NAMES) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    samples = np.zeros((int(SR * DURATION), 2), dtype="float32")
    for name in names:
        sf.write(str(directory / separation.STEM_FILENAME.format(name)), samples, SR)
    return directory


class TestGuitarEventShape(unittest.TestCase):
    def setUp(self):
        self.event = document.make_onset_event(
            branch="guitar", index=7, event_type="onset", start_sec=12.3456789,
            stem_id="stem-guitar", strength=4.219876,
            detector_id=document.DETECTOR_PLUCK, instrument="guitar",
            confidence=0.734512, score_kind="pluck-onset-strength",
        )

    def test_is_an_ordinary_onset_rather_than_a_type_of_its_own(self):
        self.assertEqual(self.event["type"], "onset")
        self.assertEqual(self.event["endKind"], "instantaneous")

    def test_names_the_stem_and_the_instrument_it_came_from(self):
        self.assertEqual(self.event["source"]["stemId"], "stem-guitar")
        self.assertEqual(self.event["source"]["instrument"], "guitar")

    def test_names_its_own_detector_so_provenance_is_not_guessed(self):
        self.assertEqual(self.event["detectorId"], document.DETECTOR_PLUCK)
        self.assertNotEqual(document.DETECTOR_PLUCK, document.DETECTOR_ONSET)

    def test_has_a_deterministic_id_from_its_branch_and_position(self):
        self.assertEqual(self.event["id"], "ev-guitar-000007")

    def test_carries_no_end_because_an_attack_is_a_moment(self):
        self.assertNotIn("endSec", self.event)
        self.assertNotIn("durationSec", self.event)

    def test_keeps_the_raw_score_separate_from_the_confidence(self):
        # One is uncalibrated and lives in metadata; the other has a definition and is a
        # contract field. Collapsing them is what the confidence policy exists to prevent.
        self.assertEqual(self.event["metadata"]["rawScore"]["kind"], "pluck-onset-strength")
        self.assertAlmostEqual(self.event["metadata"]["rawScore"]["value"], 4.2199)
        self.assertAlmostEqual(self.event["confidence"], 0.7345)

    def test_rounds_rather_than_emitting_full_float_noise(self):
        self.assertEqual(self.event["startSec"], 12.345679)

    def test_survives_a_json_round_trip_unchanged(self):
        self.assertEqual(json.loads(json.dumps(self.event)), self.event)


class TestConfidenceIsRefusedWhenItIsNotOne(unittest.TestCase):
    """The contract says 0..1. A detector that produced 1.4 has a bug worth hearing about."""

    def test_rejects_a_confidence_above_one(self):
        with self.assertRaises(ValueError):
            document.make_onset_event(
                branch="guitar", index=1, event_type="onset", start_sec=1.0,
                stem_id="stem-guitar", strength=1.0, confidence=1.4)

    def test_rejects_a_negative_confidence(self):
        with self.assertRaises(ValueError):
            document.make_onset_event(
                branch="guitar", index=1, event_type="onset", start_sec=1.0,
                stem_id="stem-guitar", strength=1.0, confidence=-0.1)

    def test_rejects_a_non_finite_confidence(self):
        for value in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                document.make_onset_event(
                    branch="guitar", index=1, event_type="onset", start_sec=1.0,
                    stem_id="stem-guitar", strength=1.0, confidence=value)

    def test_accepts_the_two_ends_of_the_range(self):
        for value in (0.0, 1.0):
            event = document.make_onset_event(
                branch="guitar", index=1, event_type="onset", start_sec=1.0,
                stem_id="stem-guitar", strength=1.0, confidence=value)
            self.assertEqual(event["confidence"], value)


class TestOtherBranchesStillSayNothing(unittest.TestCase):
    """Emitting a confidence for one branch must not start emitting one for the rest."""

    def test_a_percussion_event_has_no_confidence(self):
        event = document.make_onset_event(
            branch="drums", index=1, event_type="percussion", start_sec=1.0,
            stem_id="stem-drums", strength=2.0)
        self.assertNotIn("confidence", event)

    def test_a_generic_onset_has_no_confidence(self):
        event = document.make_onset_event(
            branch="other", index=1, event_type="onset", start_sec=1.0,
            stem_id="stem-other", strength=2.0)
        self.assertNotIn("confidence", event)
        self.assertNotIn("instrument", event["source"])
        self.assertEqual(event["detectorId"], document.DETECTOR_ONSET)


class TestDetectorRegistry(unittest.TestCase):
    def test_the_pluck_detector_is_declared_when_it_ran(self):
        from analyzer import beat, onset, pitch, pluck

        detectors = document.build_detectors(pitch, onset, beat, pluck)
        entry = next(d for d in detectors if d["id"] == document.DETECTOR_PLUCK)
        self.assertIn("minSpacingSec", entry["parameters"])
        self.assertIn("confidence", entry["parameters"])

    def test_it_is_absent_from_a_run_that_had_no_plucked_stems(self):
        # A four-stem document must not advertise a detector that never ran.
        from analyzer import beat, onset, pitch

        detectors = document.build_detectors(pitch, onset, beat)
        self.assertNotIn(document.DETECTOR_PLUCK, [d["id"] for d in detectors])


class TestSuppliedStemsWithoutGuitar(unittest.TestCase):
    """A stems directory pinned before guitar existed."""

    def test_four_stems_are_still_accepted_under_the_six_stem_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            result = separation.load_supplied(stems, DURATION, model_name="htdemucs_6s")
            self.assertEqual(
                sorted(result.stem_paths), sorted(separation.CORE_STEM_NAMES))

    def test_guitar_and_piano_are_adopted_when_they_happen_to_be_there(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(
                Path(tmp) / "stems",
                names=separation.CORE_STEM_NAMES + ("guitar", "piano"))
            result = separation.load_supplied(stems, DURATION, model_name="htdemucs_6s")
            self.assertIn("guitar", result.stem_paths)
            self.assertIn("piano", result.stem_paths)

    def test_they_are_listed_in_the_analyzers_order_not_the_filesystems(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(
                Path(tmp) / "stems",
                names=separation.CORE_STEM_NAMES + ("guitar", "piano"))
            result = separation.load_supplied(stems, DURATION, model_name="htdemucs_6s")
            self.assertEqual(
                list(result.stem_paths), list(separation.stem_names("htdemucs_6s")))

    def test_a_missing_core_stem_is_still_a_hard_error(self):
        # Guitar being optional must not make bass optional.
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("vocals", "drums", "other"))
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("bass", str(caught.exception))

    def test_a_partial_guitar_stem_is_checked_like_the_rest(self):
        # Present but at a different length: it belongs to a different render.
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            sf.write(str(stems / "guitar.wav"),
                     np.zeros((int(SR * (DURATION + 5)), 2), dtype="float32"), SR)
            with self.assertRaises(separation.StemValidationError):
                separation.load_supplied(stems, DURATION, model_name="htdemucs_6s")


class TestModelSelection(unittest.TestCase):
    def test_the_four_stem_model_is_still_reachable(self):
        self.assertEqual(
            separation.stem_names("htdemucs"), ("vocals", "drums", "bass", "other"))

    def test_an_unknown_model_is_named_rather_than_crashing_obscurely(self):
        with self.assertRaises(ValueError) as caught:
            separation.stem_names("htdemucs_9s")
        self.assertIn("htdemucs_9s", str(caught.exception))

    def test_the_run_guard_covers_exactly_what_the_model_would_write(self):
        self.assertEqual(
            cli.target_files(separation.stem_names("htdemucs_6s")),
            ("analysis.json", "stems/vocals.wav", "stems/drums.wav", "stems/bass.wav",
             "stems/guitar.wav", "stems/piano.wav", "stems/other.wav"),
        )
        self.assertNotIn(
            "stems/guitar.wav", cli.target_files(separation.stem_names("htdemucs")))

    def test_an_existing_guitar_stem_blocks_a_six_stem_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "stems").mkdir()
            (out / "stems" / "guitar.wav").write_bytes(b"x")
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(out, separation.stem_names("htdemucs_6s"))

    def test_the_same_stem_does_not_block_a_four_stem_run(self):
        # The guard covers what this run would touch, and nothing wider.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "stems").mkdir()
            (out / "stems" / "guitar.wav").write_bytes(b"x")
            cli.check_output_targets(out, separation.stem_names("htdemucs"))


class TestWrittenStemVerification(unittest.TestCase):
    def test_a_missing_stem_is_reported_rather_than_read_as_silence(self):
        with self.assertRaises(RuntimeError) as caught:
            separation.verify_written(Path("nowhere/guitar.wav"), "guitar")
        self.assertIn("guitar", str(caught.exception))

    def test_a_zero_byte_stem_is_reported_rather_than_read_as_silence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "guitar.wav"
            path.write_bytes(b"")
            with self.assertRaises(RuntimeError) as caught:
                separation.verify_written(path, "guitar")
            self.assertIn("cannot be audio", str(caught.exception))

    def test_a_header_only_stem_is_reported_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "guitar.wav"
            path.write_bytes(b"RIFF" + b"\0" * 40)
            with self.assertRaises(RuntimeError):
                separation.verify_written(path, "guitar")

    def test_a_real_stem_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("guitar",))
            separation.verify_written(stems / "guitar.wav", "guitar")


class TestDeterminism(unittest.TestCase):
    def test_the_same_envelope_gives_the_same_events_every_time(self):
        from analyzer import pluck

        hop = pluck.HOP_LENGTH / SR
        env = np.full(int(round(6.0 / hop)), 1.0)
        for i in range(20):
            env[int(round((0.5 + i * 0.25) / hop))] = 10.0 + (i % 5)

        first = pluck.pick_onsets(env, hop)
        for _ in range(3):
            self.assertEqual(pluck.pick_onsets(env, hop), first)

    def test_ids_follow_position_so_two_runs_agree(self):
        from analyzer import pluck

        hop = pluck.HOP_LENGTH / SR
        env = np.full(int(round(6.0 / hop)), 1.0)
        for i in range(5):
            env[int(round((0.5 + i * 0.3) / hop))] = 12.0

        def build():
            return [
                document.make_onset_event(
                    branch="guitar", index=index, event_type="onset",
                    start_sec=attack.time_sec, stem_id="stem-guitar",
                    strength=attack.strength, detector_id=document.DETECTOR_PLUCK,
                    instrument="guitar", confidence=attack.confidence)["id"]
                for index, attack in enumerate(pluck.pick_onsets(env, hop), 1)
            ]

        self.assertEqual(build(), build())
        self.assertEqual(build()[0], "ev-guitar-000001")


class TestSchemaAcceptsAGuitarDocument(unittest.TestCase):
    """The contract, checked against a document with guitar in it rather than in prose."""

    def setUp(self):
        import sys

        root = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(root / "tests"))
        import validate_contracts

        self.validator = validate_contracts
        self.schema = json.loads(
            (root / "schemas" / "analysis.schema.json").read_text(encoding="utf-8"))
        self.example = json.loads(
            (root / "examples" / "analysis.example.json").read_text(encoding="utf-8"))

    def _problems(self, doc):
        # The validator's own collector, so this checks the same rules the repository's
        # contract test does rather than a re-implementation of them.
        problems = self.validator.Problems()
        self.validator.validate_against_schema(doc, self.schema, "test", problems)
        return problems.items

    def test_the_example_already_carries_a_guitar_stem_and_attack(self):
        kinds = [s["kind"] for s in self.example["stems"]]
        self.assertIn("guitar", kinds)
        guitar = [e for e in self.example["events"]
                  if e.get("source", {}).get("stemId") == "stem-guitar"]
        self.assertTrue(guitar, "the example should show what a guitar event looks like")
        self.assertEqual(guitar[0]["type"], "onset")

    def test_a_document_with_six_stems_validates(self):
        doc = json.loads(json.dumps(self.example))
        doc["stems"] = [
            {"id": "stem-{0}".format(kind), "kind": kind,
             "path": "stems/{0}.wav".format(kind), "method": "example-separator"}
            for kind in separation.stem_names("htdemucs_6s")
        ]
        self.assertEqual(self._problems(doc), [])

    def test_a_guitar_event_built_by_the_analyzer_validates(self):
        doc = json.loads(json.dumps(self.example))
        doc["events"].append(document.make_onset_event(
            branch="guitar", index=1, event_type="onset", start_sec=3.5,
            stem_id="stem-guitar", strength=4.2,
            detector_id="det-onset", instrument="guitar", confidence=0.81,
            score_kind="pluck-onset-strength"))
        self.assertEqual(self._problems(doc), [])

    def test_a_confidence_outside_the_range_is_rejected_by_the_schema_too(self):
        # Belt and braces: the builder refuses it, and so would the contract.
        doc = json.loads(json.dumps(self.example))
        doc["events"][0]["confidence"] = 1.5
        self.assertTrue(self._problems(doc))


if __name__ == "__main__":
    unittest.main()


class TestStageCounting(unittest.TestCase):
    """The progress counter has to agree with the number of stages actually run."""

    def test_six_stems_run_nine_stages(self):
        # ingest, stems, beat, then drums/other onset, bass/vocals pitch, guitar/piano.
        self.assertEqual(cli.stage_count(separation.stem_names("htdemucs_6s")), 9)

    def test_four_stems_run_seven(self):
        # The number the module used as a constant before any of this existed.
        self.assertEqual(cli.stage_count(separation.stem_names("htdemucs")), 7)

    def test_it_counts_the_beat_branch_even_though_it_reads_no_stem(self):
        # Leaving it out is what printed "[7/6]".
        self.assertEqual(cli.stage_count(()), cli.FIXED_STAGES)

    def test_a_pin_with_no_guitar_drops_exactly_those_two_stages(self):
        full = cli.stage_count(separation.stem_names("htdemucs_6s"))
        without = cli.stage_count(separation.CORE_STEM_NAMES)
        self.assertEqual(full - without, 2)
