# Analyzer

Turns an audio file into an **Analysis document** - guide information about what happens
in the music and when.

- **Input:** an audio file.
- **Output:** an Analysis JSON document conforming to
  [`../schemas/analysis.schema.json`](../schemas/analysis.schema.json).
- **Example output:** [`../examples/analysis.example.json`](../examples/analysis.example.json).

## Requirements

| | |
| --- | --- |
| Python | **3.11** (verified on 3.11.15) |
| GPU | **required** - NVIDIA with CUDA. There is no CPU path. |
| System CUDA Toolkit | not needed - the runtime ships inside the PyTorch wheels |

The Analyzer checks `torch.cuda.is_available()` before doing any work and stops with an
error if it is false. It does **not** fall back to CPU: that would silently turn a
one-minute run into something far longer, so an unusable GPU is treated as a
configuration problem rather than a slower path.

librosa 1.0.0 requires Python >= 3.12, so this component stays on Python 3.11 with
librosa 0.11.0. Moving to librosa 1.x means moving the Analyzer's Python version.

## Environment setup

The Analyzer manages its own environment. It does not share one with `editor/`,
`player/` or the contract tests - the contract tests are standard library only and need
nothing installed.

```powershell
# 1. a Python 3.11 environment, anywhere you like
uv venv --python 3.11 .venv

# 2. PyTorch with CUDA 12.6 - MUST come first, see below
uv pip install --python .venv\Scripts\python.exe -r analyzer\requirements-cuda.txt

# 3. the Analyzer's other direct dependencies
uv pip install --python .venv\Scripts\python.exe -r analyzer\requirements.txt
```

`pip` works in place of `uv pip` if you prefer.

### Why PyTorch is installed separately

`torch==2.13.0+cu126` and `torchaudio==2.11.0+cu126` do not exist on PyPI. The `+cu126`
builds live only on PyTorch's own index, and
[`requirements-cuda.txt`](requirements-cuda.txt) pins that index inside the file so the
right build is chosen without the reader having to remember a flag.

**Order matters.** Several of the packages in `requirements.txt` require `torch` and
`torchaudio`. With the CUDA builds already installed those requirements are satisfied and
left alone; installing in the other order pulls the PyPI builds instead and you end up
with a mismatched pair.

If you need a different CUDA version, change the index URL and the two `+cuXXX` pins
together - they must match.

### Verifying the environment

```powershell
# CUDA is visible
.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"

# unit tests - pure logic, no model is loaded and no GPU is needed
.venv\Scripts\python.exe -m unittest discover -s analyzer\tests

# the CLI starts
.venv\Scripts\python.exe -m analyzer --help

# the contract tests still pass (standard library only)
.venv\Scripts\python.exe tests\validate_contracts.py
```

### Model weights

Two models download themselves on first use, into PyTorch's usual hub cache
(`%USERPROFILE%\.cache\torch\hub\checkpoints`), never into this repository:

| Model | Size | Source |
| --- | ---: | --- |
| htdemucs_6s | ~50 MiB | dl.fbaipublicfiles.com |
| htdemucs | ~80 MiB | dl.fbaipublicfiles.com |
| Beat This! `final0` | ~77 MiB | cloud.cp.jku.at |

Only the model a run actually uses is fetched; `htdemucs` downloads nothing unless
`--model htdemucs` is asked for.

torchcrepe is the exception: its weights ship inside the wheel, so it downloads nothing.

The cache is shared between environments on one machine, so a second environment on the
same machine will not re-download. A genuinely fresh machine needs about 157 MiB and
network access on the first run.

### A note on reproducibility

Following these steps reproduces the **verified dependency set**. It does not make a run
reproducible: htdemucs separation is not bit-reproducible on the same GPU with the same
input, and that variation propagates into the event set. Beats, document structure and
ordering are stable; event counts and boundaries move by a few percent between runs. See
[`../docs/analyzer-stack.md`](../docs/analyzer-stack.md).

## Usage

```powershell
python -m analyzer "C:\Users\me\Music\Album\Song.wav"
```

That is the whole ordinary invocation. One run separates the audio into **six stems with
`htdemucs_6s`** and analyses them; no flag is needed to ask for stems, and no flag is
needed to say where they go.

```powershell
# write somewhere specific instead of the song's own asset root
python -m analyzer <audio-file> --output-dir <directory>

# reuse stems that already exist, skipping separation
python -m analyzer <audio-file> --stems-dir <existing-stems>
```

### Where the output goes

**Heavy assets follow the source audio.** Six stems come to several times the size of the
recording, so they belong on the drive that already holds the music - never on whichever
drive this repository happens to be checked out on. With no `--output-dir` the run derives
its own directory beside the audio:

```text
C:\Users\me\Music\Album\
├─ Song.wav                       the recording, untouched and never copied
└─ .chart-forge\
   └─ song\                       the song's asset root
      ├─ analysis.json            the Analysis document
      ├─ asset-manifest.json      what is here and how it was made
      └─ stems\
         ├─ vocals.wav  drums.wav  bass.wav
         └─ guitar.wav  piano.wav  other.wav
```

The directory name comes from the file name, lower-cased with runs of punctuation and
spaces collapsed to a hyphen: `RoomU 149.wav` becomes `roomu-149`. Letters are kept
whatever the script, so a Japanese title keeps its title rather than slugifying to nothing.

**The source audio is not copied.** It stays where you put it and remains the only
original; `analysis.json` reaches back up to it with a relative path (`../../Song.wav`), so
the whole asset root can be moved along with the recording.

**The stems are not temporary.** They are the song's assets for as long as the chart is
being authored. Nothing deletes them - not closing the Editor, not re-running the Analyzer.

### Explicit output directories

Precedence is: **what you asked for, then the song's own asset root.**

| | |
| --- | --- |
| `--output-dir DIR` given | the run writes into `DIR`, exactly as it always did |
| omitted | the run writes into the source-adjacent asset root above |

The difference between the two is what happens to files already there. **A song's own asset
root is the Analyzer's to bring up to date**: the stems are reused or re-separated, and
`analysis.json` is replaced. Nobody types that path - it is a per-song directory under a
hidden `.chart-forge` beside the recording - so anything in it was put there by this tool,
including the debris of a run that failed halfway, and replacing that is how the ordinary
one-argument command keeps working after a crash instead of refusing forever.

**A directory you named is yours**, and nothing in it is overwritten: the run refuses to
start if anything it would write already exists, so re-running into an explicit directory
means choosing a fresh one. The one exception is a directory that already carries an
`asset-manifest.json` this tool wrote, because then it *is* an asset root - so
`--output-dir <an existing asset root>` behaves exactly like the default rather than being a
second set of rules.

### Re-running the same song

Running the Analyzer twice over one recording does **not** separate it twice. Before
separating, the run checks the asset manifest against the recording in front of it. Stems
are reused only when every one of these still holds:

- the source audio is byte-for-byte the same - both its SHA-256 and its size;
- the checkpoint asked for is the checkpoint that produced them;
- the separator is the same package at the same version, with the same settings;
- the manifest lists **exactly** the stems this model produces;
- and every one of those files is present, large enough to be audio, and still hashes to
  what was recorded.

Anything else means separating again. Two consequences worth stating plainly:

**`guitar.wav exists` is not a valid cache.** A run interrupted during separation leaves
files behind, and a truncated stem reads as music that stops early rather than as an error,
so the hashes are checked and not just the names. Five of six stems - `other.wav` missing -
is not a six-stem cache either, whichever side the gap is on: a file the manifest never
listed has nothing vouching for where it came from, and a listed file that is not on disk
is simply not there.

**Pinned stems are never a cache.** A previous run's `--stems-dir` is recorded in the
manifest as `mode: supplied`, and those stems are never adopted as though this Analyzer had
generated them - their origin was unverifiable when they were pinned, and reusing them
silently would turn that into a provenance claim.

A reused run says so in the document: `generator.parameters.separation.mode` is `reused`
with `separationRun: false`, naming the checkpoint and version that were verified. Measured
on a 195-second track, separation drops from 18.3 s to 0.001 s.

The manifest is written as soon as the stems are settled, **before** the detectors run. A
run that separates and then fails in a later branch has still produced six usable stems,
and the next attempt skips straight past them.

### Which files go where

| | |
| --- | --- |
| source audio, stems, asset manifest, analysis document | beside the recording, on the music drive |
| source code, tests, docs, schemas | this repository |
| project JSON | anywhere; it is a few kilobytes |

The repository never holds audio. `.gitignore` covers `*.wav`, `stems/` and
`.chart-forge/`, so an `--output-dir` aimed into the checkout cannot be committed by
accident.

### Which model, and why six sources

```powershell
python -m analyzer <audio-file> --output-dir <directory> --model htdemucs
```

`htdemucs_6s` is the default. It is the same architecture as `htdemucs` with a different
checkpoint, and it returns guitar and piano as their own stems instead of folding both
into `other`. That is the whole reason it is the default: an author charting a guitar part
cannot hear the guitar, and cannot see where it was struck, while it is mixed in with
every other accompaniment instrument.

Its guitar and piano separation is acknowledged upstream to be weaker than its other four,
and that is accepted deliberately. The goal is to **locate notes in time**, not to produce
a release-quality guitar recording, and leakage costs nothing for that.

`--model htdemucs` selects the four-source checkpoint, so an earlier run can be reproduced.

### Reusing existing stems

`--stems-dir` points at a directory that already contains the stems:

```text
<stems-dir>/
├─ vocals.wav      required
├─ drums.wav       required
├─ bass.wav        required
├─ other.wav       required
├─ guitar.wav      used when present
└─ piano.wav       used when present
```

Only the four core stems are required, so **a directory pinned before guitar and piano
existed still works**: the run simply has no guitar or piano branch. Present-but-optional
stems are validated exactly like the rest - same sample rate, channel count and length.

The directory is **read only**. Nothing is written into it, and the stems are not copied
into the output directory - the run writes only `analysis.json` and its asset manifest, and
`stems[].path` refers to where the stems actually live. The manifest records the pin as
`mode: supplied`, which is also what stops a later run adopting those stems as a cache.

That has a consequence worth being explicit about. `stems[].sha256` is the stable
identity of a stem's content: it does not change when files move, and it is what tells
you whether two documents saw the same audio. `stems[].path` is only a **locator
relative to the document**, so moving `analysis.json` and the stem set independently can
leave it pointing nowhere. **A pinned run's `analysis.json` is therefore not a portable
bundle on its own**, and nothing here promises that it is. If a self-contained artifact
is wanted later - a document with its stems packaged alongside it - that belongs in a
separate bundle or export step, not in the behaviour of an ordinary Analyzer run.

Validation before anything runs: the directory exists, all four files are present and
readable as audio, they agree on sample rate, channel count and length, and their
duration is within 0.5 s of the source audio. If any check fails the run **stops** with a
non-zero exit; it never quietly separates instead, because a run that claimed to use
pinned stems and did not would make its own provenance false.

The audio argument stays **required**. Pinned stems are not a substitute for source
identity: the audio still supplies `audio.sha256`, the duration and sample-rate metadata,
and the full mix that the beat branch reads. Beat tracking never reads a stem.

### What stem pinning does and does not fix

Two different identities are recorded, and they answer different questions:

| | |
| --- | --- |
| `audio.sha256` | which recording was analysed |
| `stems[].sha256` | which separated audio the detectors actually saw |

They are independent. The same audio can produce different stems, because htdemucs is not
bit-reproducible on the same GPU with the same input - separation is where run-to-run
variation enters. Pinning removes that variable, and the effect is measurable: two runs
over the same pinned stems produced **identical event ids, timestamps, durations,
`endKind`, `detectorId`, beat grid, stem hashes and onset strengths**, and an identical
event count of 2258.

It does **not** make a run byte-identical. torchcrepe's f0 estimation is itself
nondeterministic on the GPU, so `pitch.hz`, `pitch.midi` and the pitch summaries still
move between runs - measured at a median of 3.0 cents, p95 11.3, maximum 23.7, with none
exceeding 50 cents. Notably torchcrepe's *periodicity* output is bit-identical, which is
why segmentation - and therefore every event boundary - is stable.

So the accurate claim is narrow: **given the same source audio, the same Analyzer and
dependencies, and byte-identical pinned stems, the event set and its timings are
reproducible; pitch values are reproducible only to within a few cents.**

### Where the stems came from

`stems[].method` says it in prose and `generator.parameters.separation` says it in a form
a consumer can branch on:

```json
{ "mode": "generated", "separationRun": true, "package": "demucs-infer",
  "version": "4.2.2", "model": "htdemucs", "device": "cuda:0" }

{ "mode": "reused", "separationRun": false, "package": "demucs-infer",
  "version": "4.2.2", "model": "htdemucs_6s", "device": "cuda:0" }

{ "mode": "supplied", "separationRun": false, "stemsDir": "..." }
```

Three modes, because they are three different claims:

| | |
| --- | --- |
| `generated` | separation ran during this invocation |
| `reused` | this Analyzer generated these stems earlier, and the source, checkpoint, version, settings and every stem hash were re-verified before they were adopted |
| `supplied` | the stems came from outside and their origin is unverifiable |

`reused` names the checkpoint and the version because both were checked, not assumed - the
only thing that stops being true relative to `generated` is that separation ran this time.
For supplied stems the Analyzer records that it did not produce them and cannot verify what
did. Validation confirms the stems are usable and plausibly belong to the audio; it cannot
prove they were separated from it.

## How a project and the Editor reach these assets

There is one point of reference, and it is `analysis.json`. That was already true and has
not changed: the Editor resolves `audio.path` and every `stems[].path` **against the
Analysis document that names them**, so the asset root is simply the directory that
document lives in, and nothing needs to be told about it separately.

A Project therefore records one path into the asset root and nothing more:

```json
{
  "version": "0.1.0",
  "name": "Room U149",
  "audio": { "path": "C:\Users\me\Music\Album\Song.wav", "durationSec": 194.8 },
  "analysis": { "kind": "file", "path": "C:\Users\me\Music\Album\.chart-forge\song\analysis.json" }
}
```

No `assetRoot` field, and above all **no list of six stem paths**. Six copies of the same
information is six things to keep in step; the document that already names them is the one
place they are written down.

Relative paths are preferred and used wherever one exists. A project on `D:` referring to
assets on `C:` is the case where one does not: Windows has no relative path between two
drives, so the reference falls back to absolute. That is one absolute path, at the boundary
between the drives, with everything inside the asset root staying relative.

A project file is a few kilobytes, so it can live wherever suits - beside the other projects
on the small drive is fine:

```text
D:\10.repo\chart-forge-work\projects\roomu-149.project.json   ->  C:\...\.chart-forge\roomu-149\
```

### Mix and the six stems in the Editor

The Editor's mixer offers seven things to listen to: **Mix**, then Vocals, Drums, Bass,
Guitar, Piano and Other. Each has a fader, Mute and Solo, and several can be soloed at once -
"guitar and piano together" is one gesture.

Mix is the source recording itself, streamed from where it lives; it is never copied into the
asset root. The stems are decoded through Web Audio, and only when one is first actually
listened to, so opening a project costs nothing until the mixer is used. Every stem is
scheduled on one audio clock and lined up with the transport, so play, pause, seek and the
rate menu move all of them together - and Mix steps aside as soon as a stem is brought in,
because playing the whole mix underneath one of its own parts comb-filters that part.

The row labels come from each stem's `kind`, capitalised. `kind` is an open vocabulary in the
Analysis contract, so a separator that one day yields something else gets a row without any
code being changed.

### Guitar Guide and Piano Guide

These are guide **layers over the Analysis events**, not separate audio paths. The Analyzer
detects plucked-string attacks in `stems/guitar.wav` and `stems/piano.wav` and writes them as
events carrying `source.stemId`; the Editor draws each event in the lane named for its stem
and lets the author snap to it. There is no guitar-specific path and no piano-specific path
anywhere - one resolver, one asset root, and a lane per stem kind - which is what makes bass,
drums or vocals guides a matter of adding a detector rather than another special case.

### Older projects

Nothing about an existing project is migrated, and nothing needs to be. The rules a project
is read by have not changed, so a project written before asset roots existed goes on loading
exactly as it did:

| | |
| --- | --- |
| no stems at all | the mixer is simply absent, which it always was |
| four stems only | four rows plus Mix; the guitar and piano guides are empty |
| stems in an old `runs/` tree | resolved from its own analysis document, as before |
| an absolute `audio.path` | still accepted - the contract allows absolute or relative |

The new layout is the default for **new** analyses. An old project adopts it by being
re-analysed, when and if its author wants that.

## Current pipeline

```text
full mix        -> Beat This!            beats, downbeats, raw logits
audio           -> htdemucs_6s           six stems
  drums, other  -> librosa               onsets
  bass, vocals  -> torchcrepe            pitch, periodicity, voiced runs
  guitar, piano -> pluck                 attacks, with a confidence
                                         -> Analysis 0.2
```

Beat tracking runs on the full mix rather than a stem, and is an independent branch of
the pipeline rather than a consumer of separation.

### The plucked-string branch

Guitar and piano get their own detector rather than librosa's defaults, because a guitar
is not one instrument to a transient detector. A strummed chord is six transients over
20-40 ms and is **one** event; a muted cutting figure is four transients in the same span
and is **four**. Nothing tells those apart by spacing, so `pluck.py` uses one spacing rule
set at the boundary of what a player can physically produce (40 ms, which admits
thirty-seconds at 150 BPM) and lets everything above it through.

A candidate is kept when it is a local peak, stands far enough above a rolling-median
local background, and is far enough from the last one kept. All of it is a pure function
of an onset-strength envelope, so the awkward cases are tested directly.

Guitar and piano share the branch because they pose the same problem. Giving piano its own
tuning would be inventing a distinction nobody has measured.

#### A stem that is only bleed

Six-source separation always writes six files, whether or not the song contains six
instruments. A song with no piano still gets a piano stem, and what lands in it is bleed
with real transient structure - the first real run produced **2156 piano attacks for a
song with no piano in it**.

So each plucked stem is weighed against the recording it came from before it is searched.
Measured on that run:

```text
vocals -6.0 dB   drums -8.1 dB   bass  -7.3 dB
guitar -10.2 dB  other -13.9 dB  piano -26.0 dB
```

A stem more than 20 dB below the mix contributes about one percent of its power - nobody
is charting to it, because they cannot hear it - and reports no attacks. The stem is still
separated and still playable in the Editor's mixer, so an author can listen and judge for
themselves; only the guide layer is withheld, and the run says so on the console.

## Scope

Things the Analyzer is meant to extract, as it becomes able to:

- tempo / BPM, including tempo changes
- beats and downbeats
- onsets (when a sound starts)
- note or event starts and ends, and therefore durations
- pitch
- percussive hits
- instrument or source attribution
- loudness
- a confidence value for each of the above
- references to source-separated stems

Source separation (for example with a Demucs-style model) is a legitimate Analyzer
concern; the separated audio is written next to the analysis and referenced from it by
path, never embedded.

## Out of scope

**The Analyzer does not produce charts.** It has no notion of lanes, note types,
difficulty, or which sounds deserve a note. It reports what it hears; a human decides
what to do about it in the Editor.

This is not a temporary limitation to be lifted later. It is the design: the value of
the tool is that it removes the mechanical measurement work from chart authoring while
leaving the creative decisions with the author.

## Design notes

- **Emit what you know, omit what you do not.** Every field except `version`, `audio`
  and `events` is optional. A partial analysis is a valid analysis; a fabricated field
  is not. Absent confidence means unknown, not zero.
- **Be honest about confidence.** The Editor will use it to fade or filter guide
  markers, so a poorly calibrated confidence is worse than none.
- **Stay reproducible.** An analysis must be regenerable from its audio. Nothing
  human-authored may exist only in an Analysis document.
- **Write provenance.** Fill in `generator` with the tool, version and parameters so a
  surprising analysis can be traced.
- Times are seconds from the start of the audio, in fields named `...Sec`.

## Current limitations

Every one of these is a known, deliberate gap rather than an oversight:

- **`confidence` is emitted for plucked-string attacks only.** Beat This! logits,
  torchcrepe periodicity and librosa onset strength are uncalibrated and mutually
  incomparable, so writing any of them into one field would mislead, and those branches
  emit none - absent goes on meaning unknown. The plucked-string branch is the exception
  because it has a definition rather than a score: `(peak - local background) / peak`, the
  fraction of a transient standing above the passage around it, bounded in 0..1 and
  comparable between events and between documents.
- **A guitar attack is not a guitar note.** It is where a string was struck. Nothing
  measures how long it rang, and a hammer-on, a pull-off or a slide has no attack to find
  - so a passage played legato reports fewer events than it has notes.
- **A `pitch-run` is not a musical note.** It is a provisional voiced segment from a
  periodicity threshold; one note can fragment into several runs.
- **No tempo map.** Only a single representative `tempo.bpm`, derived from the median
  inter-beat interval.
- **No meter or bar indexing.** `barIndex` and `beatInBar` are not generated, because
  meter phase proved unreliable at the start of real tracks.
- **`other` onsets include drum bleed.** A large share coincide with drums onsets;
  nothing is deduplicated, suppressed or merged.
- **Raw frame curves live in `metadata.experimental`.** The contract has no home for
  frame-level data yet, and consumers must not depend on that block.
- **CUDA is required.** There is no CPU path; an unavailable GPU is a hard error rather
  than a silent, far slower fallback.

## Implementation status

The Phase-1 Analyzer CLI is implemented: ingest, separation, beat/downbeat, pitch, onset,
merge and emission of an Analysis 0.2 document, verified end to end on a real track on
the target Windows / CUDA environment.

Verified environment: Python 3.11.15 with torch 2.13.0+cu126, torchaudio 2.11.0+cu126,
demucs-infer 4.2.2, beat-this 1.1.0, torchcrepe 0.0.24, librosa 0.11.0, soundfile 0.14.0,
numpy 2.4.6 - reproduced from [`requirements.txt`](requirements.txt) and
[`requirements-cuda.txt`](requirements-cuda.txt) into a clean Python 3.11 environment.
Those two files list only what the Analyzer imports; transitive dependencies are left to
the resolver, and there is no lock file.

See [`../docs/analyzer-stack.md`](../docs/analyzer-stack.md) for the selected stack,
measurements, open design questions and next steps.

This choice of stack stays inside this directory. No other component may assume it, and
nothing outside this directory may import from it; the Analysis document is the only
interface.

## Tests

```powershell
python -m unittest discover -s analyzer/tests -v
```

They cover the pure logic only - ids, ordering, pitch conversion, segmentation, document
assembly and the overwrite guard. No model is loaded and no GPU is needed.
