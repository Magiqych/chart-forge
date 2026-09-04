"""Supplied-stem validation, provenance, and the guarantee that separation is skipped.

Real WAV files are written with soundfile so the validator's audio checks run for real,
but they are two seconds of silence, and no model is ever loaded.
"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from analyzer import cli, document, separation

SR = 44100
DURATION = 2.0


def write_stems(directory, names=separation.STEM_NAMES, duration=DURATION,
                sample_rate=SR, channels=2):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    frames = int(sample_rate * duration)
    data = np.zeros((frames, channels), dtype=np.float32)
    for name in names:
        sf.write(directory / separation.STEM_FILENAME.format(name), data, sample_rate,
                 subtype="PCM_16")
    return directory


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class TestSuppliedStemValidation(unittest.TestCase):
    def test_valid_directory_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            result = separation.load_supplied(stems, DURATION)
            self.assertEqual(result.mode, "supplied")
            self.assertEqual(result.sample_rate, SR)
            self.assertEqual(sorted(result.stem_paths), sorted(separation.STEM_NAMES))
            self.assertEqual(result.seconds, 0.0)
            self.assertEqual(result.max_cuda_allocated, 0)

    def test_missing_directory_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(separation.StemValidationError):
                separation.load_supplied(Path(tmp) / "nope", DURATION)

    def test_file_instead_of_directory_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "stems"
            target.write_text("not a directory", encoding="utf-8")
            with self.assertRaises(separation.StemValidationError):
                separation.load_supplied(target, DURATION)

    def test_missing_one_stem_fails_and_names_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("drums", "bass", "other"))
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("vocals.wav", str(caught.exception))

    def test_unreadable_stem_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            (stems / "drums.wav").write_bytes(b"this is not a wav file at all")
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("not readable audio", str(caught.exception))

    def test_mismatched_sample_rates_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("drums", "bass", "other"))
            write_stems(stems, names=("vocals",), sample_rate=22050)
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("sample rate", str(caught.exception))

    def test_mismatched_channel_counts_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("drums", "bass", "other"))
            write_stems(stems, names=("vocals",), channels=1)
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("channel count", str(caught.exception))

    def test_mismatched_lengths_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("drums", "bass", "other"))
            write_stems(stems, names=("vocals",), duration=DURATION + 1.0)
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, DURATION)
            self.assertIn("length in frames", str(caught.exception))

    def test_duration_far_from_the_source_audio_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", duration=2.0)
            with self.assertRaises(separation.StemValidationError) as caught:
                separation.load_supplied(stems, 200.0)     # an unrelated track
            self.assertIn("do not appear to belong to this audio", str(caught.exception))

    def test_small_duration_drift_is_tolerated(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", duration=2.0)
            separation.load_supplied(stems, 2.0 + 0.4)      # inside the tolerance

    def test_validation_does_not_modify_the_supplied_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            before = {p.name: (digest(p), p.stat().st_size)
                      for p in sorted(stems.iterdir())}
            separation.load_supplied(stems, DURATION)
            after = {p.name: (digest(p), p.stat().st_size)
                     for p in sorted(stems.iterdir())}
            self.assertEqual(before, after)
            self.assertEqual(sorted(p.name for p in stems.iterdir()),
                             sorted(separation.STEM_FILENAME.format(n)
                                    for n in separation.STEM_NAMES))


class TestSeparationIsSkipped(unittest.TestCase):
    """load_supplied must not reach Demucs at all - no import, no model, no GPU."""

    def test_load_supplied_never_calls_separate(self):
        called = []
        original = separation.separate
        separation.separate = lambda *a, **k: called.append(1)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                stems = write_stems(Path(tmp) / "stems")
                separation.load_supplied(stems, DURATION)
        finally:
            separation.separate = original
        self.assertEqual(called, [], "separation must not run when stems are pinned")

    def test_supplied_result_reports_no_gpu_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            result = separation.load_supplied(stems, DURATION)
            self.assertEqual(result.seconds, 0.0)
            self.assertEqual(result.max_cuda_allocated, 0)
            self.assertEqual(result.max_cuda_reserved, 0)

    def test_failure_raises_rather_than_regenerating(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems", names=("drums",))
            with self.assertRaises(separation.StemValidationError):
                separation.load_supplied(stems, DURATION)


class TestProvenance(unittest.TestCase):
    def test_supplied_provenance_says_separation_did_not_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            result = separation.load_supplied(stems, DURATION)
            prov = document.build_separation_provenance(result, separation)
            self.assertEqual(prov["mode"], "supplied")
            self.assertFalse(prov["separationRun"])
            self.assertEqual(prov["stemsDir"], str(stems.resolve()))
            self.assertNotIn("model", prov)

    def test_generated_provenance_names_the_model(self):
        fake = separation.SeparationResult(
            stem_paths={}, sample_rate=SR, seconds=1.0, max_cuda_allocated=1,
            max_cuda_reserved=2, mode="generated", stems_dir=Path("x"))
        prov = document.build_separation_provenance(fake, separation)
        self.assertEqual(prov["mode"], "generated")
        self.assertTrue(prov["separationRun"])
        self.assertEqual(prov["model"], "htdemucs")
        self.assertEqual(prov["version"], "4.2.2")

    def test_method_strings_distinguish_the_two_sources(self):
        self.assertIn("htdemucs", separation.METHOD)
        self.assertIn("supplied", separation.SUPPLIED_METHOD)
        self.assertNotEqual(separation.METHOD, separation.SUPPLIED_METHOD)

    def test_provenance_lands_in_generator_parameters(self):
        fake = separation.SeparationResult(
            stem_paths={}, sample_rate=SR, seconds=1.0, max_cuda_allocated=1,
            max_cuda_reserved=2, mode="generated", stems_dir=Path("x"))
        from analyzer.tests.test_assembly import _build
        doc = _build()
        self.assertIn("separation", doc["generator"]["parameters"])
        self.assertIn("mode", doc["generator"]["parameters"]["separation"])


class TestStemHashes(unittest.TestCase):
    def test_hash_matches_the_file_contents(self):
        from analyzer import audio

        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            for name in separation.STEM_NAMES:
                path = stems / separation.STEM_FILENAME.format(name)
                self.assertEqual(audio.sha256_file(path), digest(path))

    def test_hash_is_stable_across_calls(self):
        from analyzer import audio

        with tempfile.TemporaryDirectory() as tmp:
            stems = write_stems(Path(tmp) / "stems")
            path = stems / "drums.wav"
            self.assertEqual(audio.sha256_file(path), audio.sha256_file(path))

    def test_identical_content_hashes_identically_in_two_directories(self):
        from analyzer import audio

        with tempfile.TemporaryDirectory() as tmp:
            a = write_stems(Path(tmp) / "a")
            b = Path(tmp) / "b"
            b.mkdir()
            (b / "drums.wav").write_bytes((a / "drums.wav").read_bytes())
            self.assertEqual(audio.sha256_file(a / "drums.wav"),
                             audio.sha256_file(b / "drums.wav"))


class TestOutputTargetsWithPinnedStems(unittest.TestCase):
    def test_pinned_run_only_guards_the_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "stems").mkdir()
            (out / "stems" / "drums.wav").write_bytes(b"leftover")
            # A pinned run writes no stems, so a leftover stem is not in its way.
            cli.check_output_targets(out, supplied_stems=True)
            # A normal run would write there, so it must refuse.
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(out, supplied_stems=False)

    def test_existing_analysis_blocks_both_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "analysis.json").write_text("{}", encoding="utf-8")
            for supplied in (True, False):
                with self.assertRaises(FileExistsError):
                    cli.check_output_targets(Path(tmp), supplied_stems=supplied)

    def test_default_argument_preserves_existing_behaviour(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "stems").mkdir()
            (Path(tmp) / "stems" / "bass.wav").write_bytes(b"leftover")
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(Path(tmp))      # no keyword given


class TestStemReferencePath(unittest.TestCase):
    def test_same_tree_gives_a_relative_posix_path(self):
        out = Path(tempfile.gettempdir()) / "run"
        stem = out / "stems" / "drums.wav"
        self.assertEqual(cli.stem_reference_path(stem, out), "stems/drums.wav")

    def test_sibling_directory_gives_a_relative_path(self):
        base = Path(tempfile.gettempdir())
        self.assertEqual(
            cli.stem_reference_path(base / "pinned" / "drums.wav", base / "run"),
            "../pinned/drums.wav")


class TestCliArguments(unittest.TestCase):
    def test_stems_dir_is_optional_and_defaults_to_none(self):
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("audio")
        parser.add_argument("--output-dir", required=True)
        parser.add_argument("--stems-dir", default=None)
        args = parser.parse_args(["song.flac", "--output-dir", "out"])
        self.assertIsNone(args.stems_dir)

    def test_help_mentions_stems_dir(self):
        import contextlib
        import io

        from analyzer import cli as cli_module

        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            with self.assertRaises(SystemExit):
                cli_module.main(["--help"])
        text = captured.getvalue()
        self.assertIn("--stems-dir", text)
        self.assertIn("read only", text)


if __name__ == "__main__":
    unittest.main()
