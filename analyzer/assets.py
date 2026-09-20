"""Where a song's heavy assets live, and whether the ones already there can be reused.

One module decides the layout, so nothing else has to guess at it. Everything that used
to be implicit in an `--output-dir` the caller typed is stated here instead: which
directory a song's assets belong in, what the files inside it are called, how a document
in it refers to something outside it, and what makes a set of stems on disk still good.

## Heavy assets follow the source audio

The rule, and the reason the module exists. Stems are the same order of magnitude as the
recording they came from - six of them are several times its size - so the drive that can
hold the song is the drive that can hold its stems, and the drive the *repository* happens
to be checked out on has nothing to do with it. A source audio file at

    C:\\Users\\me\\Music\\Album\\Song.wav

therefore gets its assets at

    C:\\Users\\me\\Music\\Album\\.chart-forge\\song\\

as a sibling of the recording, however far away the repository or the project file is.
Nothing here ever consults the working directory.

## What an asset root is

A directory holding everything the Analyzer produced for one song:

    <asset root>/
    ├─ analysis.json            the Analysis document - the contract, and the entry point
    ├─ asset-manifest.json      this module's bookkeeping: what is here and how it was made
    └─ stems/
       ├─ vocals.wav  drums.wav  bass.wav
       └─ guitar.wav  piano.wav  other.wav

The source audio is **not** in it. It stays where the user put it, and `analysis.json`
refers to it by a relative path - `../../Song.wav` for the layout above. Copying a 40 MB
recording into a directory sitting next to it would double it for nothing.

`analysis.json` is the single point of reference, because it already was: the Editor
resolves `audio.path` and every `stems[].path` against the document that names them, so
the asset root is simply the directory that document lives in and no consumer needs to be
told about it separately. The manifest never duplicates those paths as absolute ones.

## The manifest, and why it is not a second contract

`asset-manifest.json` answers one question `analysis.json` cannot: *may these stems be
reused, or must they be separated again?* It has to be answerable before the analysis
exists - that is the whole point of a cache - so it cannot live in the analysis document,
and it is deliberately not part of the contract between components. Nothing outside the
Analyzer reads it. It also serves as the marker that says a directory is an asset root
this tool manages, which is what makes re-running in place safe while a directory the user
named by hand is still never overwritten.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

from . import audio, document

#: The hidden directory that collects Chart Forge's assets beside a recording.
#:
#: Hidden and named, rather than a bare `stems/` beside the audio: a music directory
#: belongs to its owner, and one dotted entry that says who put it there is the smallest
#: footprint that is still self-explanatory.
ASSET_DIRNAME = ".chart-forge"

STEMS_DIRNAME = "stems"
ANALYSIS_FILENAME = "analysis.json"
MANIFEST_FILENAME = "asset-manifest.json"

#: Bumped when the manifest's own shape changes. A manifest this Analyzer cannot read is
#: not a valid cache, so an older one simply causes one re-separation and is then current.
MANIFEST_VERSION = "0.1.0"

#: The key whose presence means "the Analyzer manages this directory".
MANIFEST_MARKER = "chartForgeAssetRoot"

#: What a song slug falls back to when the title survives slugification as nothing at all.
FALLBACK_SLUG = "song"


def slug_for(audio_path) -> str:
    """A directory name for one song, derived from its file name.

    Lower-cased, with every run of characters that is not a letter or a digit collapsed
    into a single hyphen. `RoomU 149.wav` becomes `roomu-149`.

    Letters are tested with `str.isalnum`, not against ASCII, so a title written in
    Japanese keeps its title instead of slugifying to nothing - which matters here, where
    that is the common case rather than the exotic one. Only a name with no alphanumeric
    character at all falls back.
    """
    name = Path(audio_path).stem
    out = []
    for character in name.lower():
        if character.isalnum():
            out.append(character)
        elif out and out[-1] != "-":
            out.append("-")
    slug = "".join(out).strip("-")
    return slug or FALLBACK_SLUG


def asset_root_for(audio_path) -> Path:
    """Where this song's assets belong: `<audio's directory>/.chart-forge/<slug>`.

    Absolute, resolved, and a function of the audio path alone. Deliberately never of the
    working directory or of where the repository is, because those are on whichever drive
    the code happens to be checked out on and the stems are far too large to care.
    """
    source = Path(audio_path).expanduser().resolve()
    return source.parent / ASSET_DIRNAME / slug_for(source)


def reference(target, base) -> str:
    """How a document in `base` should refer to `target`.

    A relative POSIX path whenever one exists, because that is what keeps an asset root
    movable - and an absolute path when one does not. On Windows two drives have no
    relative path between them at all, which is exactly the case this project runs into:
    a project file on `D:` beside assets on `C:`.
    """
    target = Path(target)
    base = Path(base)
    try:
        return Path(os.path.relpath(target, base)).as_posix()
    except ValueError:
        return str(target)


def manifest_path(asset_root) -> Path:
    return Path(asset_root) / MANIFEST_FILENAME


def stems_dir_in(asset_root) -> Path:
    return Path(asset_root) / STEMS_DIRNAME


def analysis_path_in(asset_root) -> Path:
    return Path(asset_root) / ANALYSIS_FILENAME


def read_manifest(asset_root):
    """The manifest in `asset_root`, or None if there is not a readable one.

    A manifest that is missing, unparseable, not an object, unmarked or of a version this
    Analyzer does not know is all the same answer: there is nothing here to trust. None of
    those is an error, because the remedy is always the same - separate again and write a
    manifest this version wrote.
    """
    path = manifest_path(asset_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get(MANIFEST_MARKER) != MANIFEST_VERSION:
        return None
    return data


def is_asset_root(asset_root) -> bool:
    """Whether this directory is one the Analyzer wrote and may therefore refresh.

    The distinction the overwrite guard turns on. A directory the Analyzer created for a
    song is its own to bring up to date; any other directory - one the user named on the
    command line, most of all - is theirs, and nothing in it is replaced.
    """
    return read_manifest(asset_root) is not None


class CacheVerdict(NamedTuple):
    """Whether the stems already in an asset root may be used as they are."""

    reusable: bool
    #: One sentence, in the past tense, for the console. Always set - a refusal says what
    #: changed, and an acceptance says what was checked.
    reason: str
    #: name -> Path, in the model's order, only when `reusable`.
    stem_paths: dict


def inspect_stem_cache(asset_root, audio_info, model, separation_module) -> CacheVerdict:
    """Decide whether separation can be skipped, and say why either way.

    Every one of these has to hold. The list is the cache key, stated once:

    * the manifest exists, is this version's, and records stems this Analyzer generated
      (stems that were *pinned* into a previous run are not a cache: their origin was
      unverified then and reusing them would launder that into a provenance claim);
    * the source audio is byte-for-byte the one those stems came from - its SHA-256 and
      its size, so a file replaced by one of identical length is still caught;
    * the checkpoint asked for is the checkpoint that ran;
    * the separator is the same package at the same version, and its settings are
      unchanged, because either changes what comes out;
    * the manifest lists **exactly** the stems this model produces - a five-of-six cache
      is not a six-stem cache, and a four-stem one certainly is not;
    * and every one of those files is really on disk, is large enough to be audio, and
      still hashes to what the manifest recorded.

    That last clause is the difference between a cache and a guess. `guitar.wav exists` is
    not evidence: a run interrupted during separation leaves files behind, and a truncated
    stem reads as music that stops early rather than as an error.
    """
    manifest = read_manifest(asset_root)
    if manifest is None:
        return CacheVerdict(False, "no Chart Forge asset manifest was found here", {})

    separation = manifest.get("separation")
    if not isinstance(separation, dict):
        return CacheVerdict(False, "the manifest records no separation", {})
    if separation.get("mode") != "generated":
        return CacheVerdict(
            False,
            "the stems recorded here were supplied to a previous run rather than "
            "generated, so their origin is unverified and they are not a cache",
            {},
        )

    source = manifest.get("source")
    if not isinstance(source, dict):
        return CacheVerdict(False, "the manifest records no source audio", {})
    if source.get("sha256") != audio_info.sha256:
        return CacheVerdict(False, "the source audio has changed (SHA-256)", {})
    if source.get("sizeBytes") != audio_info.size_bytes:
        return CacheVerdict(False, "the source audio has changed (size in bytes)", {})

    if separation.get("model") != model:
        return CacheVerdict(
            False, "the stems here were separated with {0!r}, not {1!r}".format(
                separation.get("model"), model), {})
    if separation.get("package") != separation_module.PACKAGE:
        return CacheVerdict(
            False, "the stems here were separated by {0!r}, not {1!r}".format(
                separation.get("package"), separation_module.PACKAGE), {})
    if separation.get("version") != separation_module.VERSION:
        return CacheVerdict(
            False, "the separator has changed version: {0!r} then, {1!r} now".format(
                separation.get("version"), separation_module.VERSION), {})
    if separation.get("settings") != separation_module.SETTINGS:
        return CacheVerdict(False, "the separation settings have changed", {})

    recorded = separation.get("stems")
    if not isinstance(recorded, dict):
        return CacheVerdict(False, "the manifest lists no stems", {})
    wanted = separation_module.stem_names(model)
    if set(recorded) != set(wanted):
        return CacheVerdict(
            False,
            "the cache is not complete for {0}: it holds {1}, and {2} is wanted".format(
                model, ", ".join(sorted(recorded)) or "nothing", ", ".join(wanted)),
            {},
        )

    root = Path(asset_root)
    paths = {}
    for name in wanted:
        entry = recorded.get(name)
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            return CacheVerdict(False, "the manifest entry for {0} is malformed".format(name), {})
        path = root / entry["path"]
        if not path.is_file():
            return CacheVerdict(False, "{0} is missing from the cache".format(entry["path"]), {})
        if path.stat().st_size < separation_module.MINIMUM_STEM_BYTES:
            return CacheVerdict(
                False, "{0} is too small to be audio".format(entry["path"]), {})
        if audio.sha256_file(path) != entry.get("sha256"):
            return CacheVerdict(
                False, "{0} no longer matches the hash recorded for it".format(
                    entry["path"]), {})
        paths[name] = path

    return CacheVerdict(
        True,
        "source, model, separator version, settings and all {0} stem hashes match".format(
            len(wanted)),
        paths,
    )


def build_manifest(*, asset_root, audio_info, separation_result, separation_module,
                   analyzer_version, previous=None) -> dict:
    """The manifest to write after a run, describing what is now in the asset root.

    Paths are relative to the asset root, including the source audio's - so the whole
    directory can be moved beside its recording and still make sense, and nothing in it
    repeats an absolute path that `analysis.json` already states relatively. A run across
    drives is the exception the relative form cannot cover, and `reference` falls back to
    an absolute path there rather than inventing one.

    `createdAt` is carried over from a manifest already present, because it says when this
    song's assets first appeared and that is not what this run did.
    """
    root = Path(asset_root)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    created = (previous or {}).get("createdAt") if isinstance(previous, dict) else None

    if separation_result.mode == "supplied":
        separation = {
            "mode": "supplied",
            "stemsDir": reference(separation_result.stems_dir, root),
            "stems": {
                name: {"path": reference(path, root)}
                for name, path in separation_result.stem_paths.items()
            },
            "note": "pinned stems, read only; the Analyzer did not produce them and "
                    "cannot verify what did, so they are never treated as a cache",
        }
    else:
        separation = {
            "mode": "generated",
            "package": separation_module.PACKAGE,
            "version": separation_module.VERSION,
            "model": separation_result.model or separation_module.MODEL,
            "settings": dict(separation_module.SETTINGS),
            "stemsDir": reference(separation_result.stems_dir, root),
            "stems": {
                name: {
                    "path": reference(path, root),
                    "sha256": audio.sha256_file(path),
                }
                for name, path in separation_result.stem_paths.items()
            },
        }

    return {
        MANIFEST_MARKER: MANIFEST_VERSION,
        "generator": {"name": document.GENERATOR_NAME, "version": analyzer_version},
        "createdAt": created or now,
        "updatedAt": now,
        "source": {
            "path": reference(audio_info.path, root),
            "sha256": audio_info.sha256,
            "sizeBytes": audio_info.size_bytes,
            "durationSec": round(float(audio_info.duration_sec), 6),
            "copied": False,
        },
        "separation": separation,
    }


def write_manifest(manifest: dict, asset_root) -> Path:
    """Write the manifest, replacing any previous one, and never half-written.

    Replacing is right here where it is wrong for `analysis.json`: the manifest is this
    module's own record of the directory's current contents, and a stale one is worse than
    none. It goes through the same atomic write, so an interrupted run leaves either the
    old manifest or the new one.
    """
    return document.write_atomic(manifest, manifest_path(asset_root), allow_replace=True)
