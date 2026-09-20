"""Where heavy assets go, and when stems already there may be used again.

The two claims this file exists to make, because getting either wrong is expensive rather
than merely wrong:

* **the drive.** A repository on `D:` and a recording on `C:` must put the stems on `C:`.
  A default derived from the working directory would fill the small drive with six copies
  of every song, and nothing in a test that ran in one temporary directory would notice.
* **the cache.** `guitar.wav exists` is not evidence that separation can be skipped. What
  is evidence is stated once, in `assets.inspect_stem_cache`, and every clause of it is
  exercised here by breaking exactly one thing at a time.

Real WAV files are written with soundfile, so the size and hash checks run against actual
bytes. No model is ever loaded, no GPU is touched, and `separation.separate` is replaced by
a recorder in the tests that care whether it would have been called - running htdemucs to
find out whether a cache works would defeat the point of the cache.
"""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from analyzer import assets, audio, cli, separation

SR = 44100
DURATION = 2.0
MODEL = separation.MODEL


def write_audio(path, duration=DURATION, sample_rate=SR, channels=2, seed=0):
    """A real, readable WAV file. Noise rather than silence, so hashes differ by `seed`."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    generator = np.random.default_rng(seed)
    frames = int(sample_rate * duration)
    data = (generator.standard_normal((frames, channels)) * 0.1).astype(np.float32)
    sf.write(path, data, sample_rate, subtype="PCM_16")
    return path


def write_stems(stems_dir, names=separation.STEM_NAMES, **kwargs):
    stems_dir = Path(stems_dir)
    for index, name in enumerate(names):
        write_audio(stems_dir / separation.STEM_FILENAME.format(name),
                    seed=index + 1, **kwargs)
    return stems_dir


def populate(asset_root, source, names=separation.STEM_NAMES, model=MODEL):
    """An asset root exactly as a completed run leaves it: stems plus a manifest."""
    asset_root = Path(asset_root)
    stems = write_stems(assets.stems_dir_in(asset_root), names=names)
    info = audio.probe(source)
    result = separation.SeparationResult(
        stem_paths={name: stems / separation.STEM_FILENAME.format(name) for name in names},
        sample_rate=SR, seconds=1.0, max_cuda_allocated=1, max_cuda_reserved=2,
        mode="generated", stems_dir=stems, model=model)
    assets.write_manifest(
        assets.build_manifest(
            asset_root=asset_root, audio_info=info, separation_result=result,
            separation_module=separation, analyzer_version="0.0.0-test",
            previous=assets.read_manifest(asset_root)),
        asset_root)
    return info


def edit_manifest(asset_root, change):
    """Rewrite one thing in the manifest, leaving everything else as a run wrote it."""
    path = assets.manifest_path(asset_root)
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


class TestSlug(unittest.TestCase):
    def test_the_real_song_name(self):
        self.assertEqual(assets.slug_for("RoomU 149.wav"), "roomu-149")

    def test_case_and_punctuation_collapse(self):
        self.assertEqual(
            assets.slug_for("33. Kirameki  (TV Size).flac"), "33-kirameki-tv-size")

    def test_a_japanese_title_keeps_its_title(self):
        # The common case in this project, not the exotic one. An ASCII-only rule would
        # slugify most of the user's library to nothing and collide every song with every
        # other, so letters are tested with isalnum rather than against ASCII.
        self.assertEqual(assets.slug_for("凪 補完計画.wav"), "凪-補完計画")

    def test_a_name_with_no_letters_at_all_falls_back(self):
        self.assertEqual(assets.slug_for("---.wav"), assets.FALLBACK_SLUG)

    def test_the_same_name_always_gives_the_same_slug(self):
        # The asset root has to be re-derivable on the next run, or nothing is ever
        # reused. That makes determinism a requirement rather than a nicety.
        self.assertEqual(assets.slug_for("RoomU 149.wav"), assets.slug_for("RoomU 149.wav"))


class TestAssetRootLocation(unittest.TestCase):
    """The storage rule: heavy assets follow the source audio, never the repository."""

    def test_the_root_sits_beside_the_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "RoomU 149.wav")
            root = assets.asset_root_for(source)
            self.assertEqual(root.parent.parent, source.parent)
            self.assertEqual(root.parent.name, assets.ASSET_DIRNAME)
            self.assertEqual(root.name, "roomu-149")

    def test_the_root_ignores_the_working_directory(self):
        # The heart of it, stated as a property rather than as a drive letter so it holds
        # on a machine with one drive: the answer must not move when the caller does.
        import os

        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "audio" / "song.wav")
            elsewhere = Path(tmp) / "elsewhere"
            elsewhere.mkdir()
            here = Path.cwd()
            try:
                os.chdir(elsewhere)
                from_elsewhere = assets.asset_root_for(source)
            finally:
                os.chdir(here)
            self.assertEqual(from_elsewhere, assets.asset_root_for(source))

    def test_a_source_on_another_drive_keeps_its_assets_on_that_drive(self):
        # The actual situation this work exists for: the repository is on D:, the music is
        # on C:, and C: is where 200 MB of stems must land. Path arithmetic only - nothing
        # is written - so it runs on any machine.
        source = Path("C:/Users/someone/Music/Album/Song.wav")
        root = assets.asset_root_for(source)
        self.assertEqual(root.drive.upper(), "C:")
        self.assertEqual(root.parent.parent, source.parent)
        self.assertEqual(root.parent.name, assets.ASSET_DIRNAME)

    def test_nothing_in_the_default_root_is_under_the_repository(self):
        repository = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            self.assertFalse(
                str(root).lower().startswith(str(repository).lower()),
                "assets must never default to somewhere inside the checkout")


class TestExplicitOverride(unittest.TestCase):
    """1. what the person asked for. 2. the source-adjacent default."""

    def test_an_explicit_directory_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "song.wav")
            chosen = Path(tmp) / "somewhere" / "else"
            self.assertEqual(cli.resolve_asset_root(source, chosen), chosen.resolve())

    def test_no_directory_falls_back_to_the_song_s_own_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "song.wav")
            self.assertEqual(
                cli.resolve_asset_root(source, None), assets.asset_root_for(source))

    def test_an_explicit_directory_is_not_treated_as_the_analyzer_s_own(self):
        # A directory the person named must never be refreshed in place, however much it
        # looks like an asset root - the marker is a manifest this tool wrote, not a name.
        with tempfile.TemporaryDirectory() as tmp:
            theirs = Path(tmp) / "runs" / "take-01"
            theirs.mkdir(parents=True)
            (theirs / "analysis.json").write_text("{}", encoding="utf-8")
            self.assertFalse(assets.is_asset_root(theirs))
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(theirs)


class TestWhoOwnsTheDirectory(unittest.TestCase):
    """Which directories the Analyzer may refresh, and which it must leave alone.

    `cli.run` decides this from two facts, and these cover the awkward corner between
    them: a *derived* root is the tool's own by construction, while a directory somebody
    named is theirs until it carries a manifest this tool wrote.
    """

    def managed(self, output_dir, derived):
        """The rule as `cli.run` applies it, without running a pipeline to reach it."""
        return derived or assets.read_manifest(output_dir) is not None

    def test_a_crashed_first_run_does_not_wedge_the_ordinary_command(self):
        # The case this exists for. Separation half-failed: stem files are on disk and no
        # manifest was ever written. Nothing in that directory is the person's work - it is
        # this tool's own debris, under a hidden directory nobody typed - so the next
        # ordinary run must proceed and replace it, not refuse forever.
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "song.wav")
            root = assets.asset_root_for(source)
            write_stems(assets.stems_dir_in(root), names=("vocals", "drums"))

            self.assertIsNone(assets.read_manifest(root), "no run ever completed here")
            self.assertTrue(self.managed(root, derived=True))
            # The guard would have refused, which is exactly why it is not consulted.
            with self.assertRaises(FileExistsError):
                cli.check_output_targets(root)

    def test_a_directory_somebody_named_is_still_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            theirs = Path(tmp) / "takes" / "01"
            theirs.mkdir(parents=True)
            write_stems(assets.stems_dir_in(theirs), names=("vocals",))
            self.assertFalse(self.managed(theirs, derived=False))

    def test_an_explicit_asset_root_behaves_exactly_like_the_default(self):
        # The rule is about the directory, not about how it was named: pointing
        # --output-dir at a root this tool already wrote must refresh it, not refuse.
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "song.wav")
            root = assets.asset_root_for(source)
            populate(root, source)
            self.assertTrue(self.managed(root, derived=False))
            self.assertTrue(self.managed(root, derived=True))


class TestNoSourceDuplication(unittest.TestCase):
    def test_a_completed_run_leaves_no_copy_of_the_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "RoomU 149.wav")
            root = assets.asset_root_for(source)
            populate(root, source)

            original = source.read_bytes()
            copies = [path for path in root.rglob("*")
                      if path.is_file() and path.read_bytes() == original]
            self.assertEqual(copies, [], "the source audio must not be copied")

    def test_the_manifest_points_back_at_the_recording_relatively(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "RoomU 149.wav")
            root = assets.asset_root_for(source)
            populate(root, source)

            manifest = assets.read_manifest(root)
            self.assertEqual(manifest["source"]["path"], "../../RoomU 149.wav")
            self.assertFalse(manifest["source"]["copied"])
            self.assertTrue((root / manifest["source"]["path"]).resolve().is_file())

    def test_the_manifest_holds_one_root_and_relative_paths_inside_it(self):
        # Not six absolute paths. Everything in the manifest resolves against the root it
        # sits in, which is what lets the whole directory move with its recording.
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "Music" / "song.wav")
            root = assets.asset_root_for(source)
            populate(root, source)

            stems = assets.read_manifest(root)["separation"]["stems"]
            self.assertEqual(sorted(stems), sorted(separation.STEM_NAMES))
            for name, entry in stems.items():
                self.assertEqual(entry["path"], "stems/{0}.wav".format(name))
                self.assertFalse(Path(entry["path"]).is_absolute())


class TestCrossDriveReferences(unittest.TestCase):
    def test_two_drives_fall_back_to_an_absolute_path(self):
        # There is no relative path from D: to C:, so `reference` must say so by giving an
        # absolute one rather than producing something that resolves nowhere.
        reference = assets.reference(Path("C:/Music/song.wav"), Path("D:/work/projects"))
        self.assertTrue(Path(reference).is_absolute())
        self.assertEqual(Path(reference), Path("C:/Music/song.wav"))

    def test_one_drive_gives_a_relative_posix_path(self):
        self.assertEqual(
            assets.reference(Path("C:/Music/.chart-forge/s/stems/guitar.wav"),
                             Path("C:/Music/.chart-forge/s")),
            "stems/guitar.wav")

    def test_a_document_in_the_root_reaches_the_recording_with_dot_dots(self):
        self.assertEqual(
            assets.reference(Path("C:/Music/Album/RoomU 149.wav"),
                             Path("C:/Music/Album/.chart-forge/roomu-149")),
            "../../RoomU 149.wav")


class TestCacheReuse(unittest.TestCase):
    def test_an_intact_root_is_reusable(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            info = populate(root, source)

            verdict = assets.inspect_stem_cache(root, info, MODEL, separation)
            self.assertTrue(verdict.reusable, verdict.reason)
            self.assertEqual(sorted(verdict.stem_paths), sorted(separation.STEM_NAMES))
            for path in verdict.stem_paths.values():
                self.assertTrue(path.is_file())

    def test_reuse_never_reaches_demucs(self):
        called = []
        original = separation.separate
        separation.separate = lambda *a, **k: called.append(1)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                source = write_audio(Path(tmp) / "song.wav")
                root = assets.asset_root_for(source)
                info = populate(root, source)
                verdict = assets.inspect_stem_cache(root, info, MODEL, separation)
                self.assertTrue(verdict.reusable)
                separation.reuse_cached(
                    assets.stems_dir_in(root), verdict.stem_paths, MODEL)
        finally:
            separation.separate = original
        self.assertEqual(called, [], "a valid cache must not run separation")

    def test_a_reused_result_is_marked_as_such_and_claims_no_gpu_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            info = populate(root, source)
            verdict = assets.inspect_stem_cache(root, info, MODEL, separation)
            result = separation.reuse_cached(
                assets.stems_dir_in(root), verdict.stem_paths, MODEL)

            self.assertEqual(result.mode, "reused")
            self.assertEqual(result.model, MODEL)
            self.assertEqual(result.seconds, 0.0)
            self.assertEqual(result.max_cuda_allocated, 0)
            self.assertEqual(result.sample_rate, SR)


class TestCacheInvalidation(unittest.TestCase):
    """One thing broken at a time, so a passing case cannot be passing by accident."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.source = write_audio(tmp / "song.wav")
        self.root = assets.asset_root_for(self.source)
        self.info = populate(self.root, self.source)
        # The baseline must hold, or every assertion below proves nothing.
        self.assertTrue(
            assets.inspect_stem_cache(self.root, self.info, MODEL, separation).reusable)

    def tearDown(self):
        self._tmp.cleanup()

    def verdict(self, info=None, model=MODEL):
        return assets.inspect_stem_cache(
            self.root, self.info if info is None else info, model, separation)

    def test_no_manifest_is_not_a_cache(self):
        assets.manifest_path(self.root).unlink()
        self.assertFalse(self.verdict().reusable)
        self.assertIn("manifest", self.verdict().reason)

    def test_a_changed_source_invalidates_it(self):
        write_audio(self.source, seed=99)
        changed = audio.probe(self.source)
        self.assertNotEqual(changed.sha256, self.info.sha256)
        verdict = self.verdict(info=changed)
        self.assertFalse(verdict.reusable)
        self.assertIn("source audio has changed", verdict.reason)

    def test_a_source_of_a_different_length_invalidates_it_on_size_alone(self):
        # The hash would catch this too; the size check is a second, independent
        # contradiction, and it is the one that costs nothing to record.
        edit_manifest(self.root, lambda data: data["source"].update(sizeBytes=1))
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("size in bytes", verdict.reason)

    def test_a_different_model_invalidates_it(self):
        verdict = self.verdict(model="htdemucs")
        self.assertFalse(verdict.reusable)
        self.assertIn("htdemucs_6s", verdict.reason)

    def test_a_different_demucs_version_invalidates_it(self):
        edit_manifest(self.root, lambda data: data["separation"].update(version="4.0.0"))
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("version", verdict.reason)

    def test_a_different_separator_package_invalidates_it(self):
        edit_manifest(self.root, lambda data: data["separation"].update(package="demucs"))
        self.assertFalse(self.verdict().reusable)

    def test_changed_separation_settings_invalidate_it(self):
        edit_manifest(
            self.root, lambda data: data["separation"]["settings"].update(overlap=0.5))
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("settings", verdict.reason)

    def test_a_manifest_this_analyzer_cannot_read_is_not_a_cache(self):
        edit_manifest(
            self.root, lambda data: data.update({assets.MANIFEST_MARKER: "99.0.0"}))
        self.assertFalse(self.verdict().reusable)

    def test_a_corrupt_manifest_is_not_a_cache_and_is_not_an_error(self):
        assets.manifest_path(self.root).write_text("{ not json", encoding="utf-8")
        self.assertFalse(self.verdict().reusable)
        self.assertIsNone(assets.read_manifest(self.root))

    def test_pinned_stems_recorded_by_a_previous_run_are_not_a_cache(self):
        # Their origin was unverified when they were pinned. Reusing them as though this
        # Analyzer had generated them would launder that into a provenance claim.
        edit_manifest(self.root, lambda data: data["separation"].update(mode="supplied"))
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("unverified", verdict.reason)


class TestIncompleteCache(unittest.TestCase):
    """Five of six is not six. Both the manifest and the disk are checked."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.source = write_audio(tmp / "song.wav")
        self.root = assets.asset_root_for(self.source)
        self.info = populate(self.root, self.source)

    def tearDown(self):
        self._tmp.cleanup()

    def verdict(self):
        return assets.inspect_stem_cache(self.root, self.info, MODEL, separation)

    def test_a_missing_stem_file_is_not_a_complete_cache(self):
        # The exact case from the brief: everything but other.wav. The manifest still
        # lists six, so only looking at the manifest would call this valid.
        (assets.stems_dir_in(self.root) / "other.wav").unlink()
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("other.wav", verdict.reason)
        self.assertIn("missing", verdict.reason)

    def test_a_manifest_listing_five_stems_is_not_a_six_stem_cache(self):
        # And the mirror image: the file is there, but the manifest never claimed it, so
        # nothing vouches for where it came from.
        edit_manifest(self.root,
                      lambda data: data["separation"]["stems"].pop("piano"))
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("not complete", verdict.reason)

    def test_a_four_stem_cache_is_not_a_six_stem_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "four.wav")
            root = assets.asset_root_for(source)
            info = populate(root, source, names=separation.MODEL_STEMS["htdemucs"],
                            model="htdemucs")
            self.assertFalse(
                assets.inspect_stem_cache(root, info, "htdemucs_6s", separation).reusable)
            self.assertTrue(
                assets.inspect_stem_cache(root, info, "htdemucs", separation).reusable)

    def test_a_truncated_stem_is_not_audio(self):
        (assets.stems_dir_in(self.root) / "guitar.wav").write_bytes(b"RIFF")
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("too small", verdict.reason)

    def test_a_stem_whose_content_changed_is_not_reusable(self):
        # Same length, different bytes - the one thing only a hash catches, and the reason
        # "the file is there and the right size" is not enough.
        write_audio(assets.stems_dir_in(self.root) / "bass.wav", seed=1234)
        verdict = self.verdict()
        self.assertFalse(verdict.reusable)
        self.assertIn("hash", verdict.reason)

    def test_an_empty_stems_directory_is_not_a_cache(self):
        for path in assets.stems_dir_in(self.root).iterdir():
            path.unlink()
        self.assertFalse(self.verdict().reusable)


class TestDefaultStemSet(unittest.TestCase):
    """An ordinary run separates six sources, and these are they."""

    def test_the_default_model_produces_the_six_the_editor_offers(self):
        self.assertEqual(
            separation.stem_names(separation.MODEL),
            ("vocals", "drums", "bass", "guitar", "piano", "other"))

    def test_no_flag_is_needed_to_get_them(self):
        # The whole point of the change: the ordinary invocation is the audio file and
        # nothing else. argparse shows an optional argument in brackets and a required one
        # bare, so the usage line is where that claim is actually checkable.
        import contextlib
        import io

        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            with self.assertRaises(SystemExit):
                cli.main(["--help"])
        usage = " ".join(captured.getvalue().split())
        self.assertIn("[--output-dir DIR]", usage)
        self.assertIn("[--stems-dir DIR]", usage)

    def test_a_run_would_write_all_six_stems_plus_the_document(self):
        self.assertEqual(
            sorted(cli.target_files(separation.stem_names(MODEL))),
            sorted(["analysis.json"] + ["stems/{0}.wav".format(name) for name in
                                        ("vocals", "drums", "bass", "guitar", "piano",
                                         "other")]))


class TestManifestBookkeeping(unittest.TestCase):
    def test_a_refresh_keeps_the_date_the_assets_first_appeared(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            populate(root, source)
            first = assets.read_manifest(root)

            edit_manifest(root, lambda data: data.update(createdAt="2020-01-01T00:00:00Z"))
            populate(root, source)
            second = assets.read_manifest(root)

            self.assertEqual(second["createdAt"], "2020-01-01T00:00:00Z")
            self.assertNotEqual(second["updatedAt"], "2020-01-01T00:00:00Z")
            self.assertEqual(first["separation"]["model"], second["separation"]["model"])

    def test_the_manifest_is_the_marker_that_makes_a_root_refreshable(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            root.mkdir(parents=True)
            self.assertFalse(assets.is_asset_root(root))
            populate(root, source)
            self.assertTrue(assets.is_asset_root(root))

    def test_the_manifest_does_not_restate_the_analysis_document(self):
        # analysis.json is the single point of reference for consumers; the manifest is
        # the Analyzer's own bookkeeping, and a second copy of the same paths is exactly
        # the duplication this layout exists to avoid.
        with tempfile.TemporaryDirectory() as tmp:
            source = write_audio(Path(tmp) / "song.wav")
            root = assets.asset_root_for(source)
            populate(root, source)
            self.assertNotIn("analysis", assets.read_manifest(root))


if __name__ == "__main__":
    unittest.main()
