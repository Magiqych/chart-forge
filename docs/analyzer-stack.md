# Analyzer Stack

> **Living design document.** It records the technology currently selected for the
> Analyzer, what has actually been measured on real hardware, and which questions are
> still open. Components here are expected to be replaced as better ones appear; update
> this file when they are, rather than treating it as a historical log.
>
> Status legend used throughout: **verified** = run end-to-end on this machine;
> **planned** = selected but not yet installed; **deferred** = wanted later;
> **rejected** = ruled out for the current phase, with a reason.

## Purpose

The Analyzer turns an audio file into an **Analysis document** - guide information about
what happens in the music and when.

```text
Audio
  ↓
musical analysis
  ↓
Analysis JSON
  ↓
human authoring in the Editor
```

It does **not** generate game charts. Its job is to remove the mechanical part of
authoring - transcribing by ear, hunting for the exact millisecond a sound starts,
finding where a sustained note ends, aligning a beat grid - so that the human keeps the
part that matters: deciding which sounds deserve a note, in which lane, and how the
pattern should feel to play.

Nothing in this document changes the boundaries set in
[`architecture.md`](architecture.md) and [`../analyzer/README.md`](../analyzer/README.md):
the Analyzer emits observations about audio, an **Analysis Event** is not a **Chart
Note**, and no stage here converts one into the other. See
[`terminology.md`](terminology.md) for the vocabulary.

## Architecture

```text
                         ┌─► Beat This!
Audio ───────────────────┤      full mix
                         │      beats / downbeats / raw logits
                         │
                         └─► demucs-infer / htdemucs
                                │
                                ├─ drums ──► librosa onset / envelope
                                │
                                ├─ bass ───► torchcrepe
                                │
                                ├─ vocals ─► torchcrepe
                                │
                                └─ other ──► librosa onset / spectral features

                                      ↓

                              normalization / merge

                                      ↓

                                Analysis JSON
```

Six properties of this design are deliberate:

- **Beat tracking runs on the full mix, not on a stem.** Separation smears transients and
  beat trackers are trained on complete mixes; feeding the drums stem to the beat tracker
  would degrade it. The drums stem is for onset extraction, which is a different job.
- **Source separation and beat analysis are independent branches** off the same audio.
  Neither waits on the other, and neither consumes the other's output.
- **Tempo and BPM are derived downstream from beat timestamps.** Beat This! emits beat
  positions; it does not emit a tempo. A later stage computes local tempo from
  inter-beat intervals.
- **Fixed BPM is never assumed.** `tempo.map[]` is the real representation of tempo;
  `tempo.bpm` is a convenience summary. Music that changes tempo is the expected case,
  not an edge case.
- **Event end is not one detector.** There is no general offset detector. Each event type
  gets its own rule - see [Event end / offset policy](#event-end--offset-policy).
- **Frame-level detector output is not an Analysis Event.** Detectors emit dense framewise
  scores at their own rate; Analysis Events are sparse, typed and carry `startSec`. The
  normalization stage converts between them, and that conversion is a design decision,
  not a formatting step.

## Selected stack

| Role | Selected | Status | Purpose |
| --- | --- | --- | --- |
| Runtime | Python 3.11 | verified | Analyzer runtime, `uv`-managed |
| ML runtime | PyTorch CUDA (cu126) | verified | GPU inference |
| Source separation | `demucs-infer==4.2.2` / `htdemucs` | verified | drums / bass / other / vocals |
| Beat / downbeat | `beat-this==1.1.0` (Beat This!) | verified | beats, downbeats, raw framewise logits |
| Audio I/O | `soundfile` | verified for WAV | WAV read/write, fallback path |
| Monophonic pitch | `torchcrepe` | planned | bass / vocals f0 + periodicity |
| Onset / features | `librosa` | planned | drums / other onsets, envelopes, spectral features |
| Polyphonic transcription | Basic Pitch | deferred | phase 2 |
| Drum classification | ADTOF / LarsNet | deferred | phase 2 |

The separation package is **`demucs-infer`**, not the original `demucs`. The original
repository is archived and its dependency metadata and documentation still assume older
torch and torchaudio releases; `demucs-infer` is a maintained inference-only fork
targeting PyTorch 2.x with Windows and CUDA support. Its import module is `demucs_infer`
and its console script is `demucs-infer`.

## Verified environment

```text
Host:
  Windows 11

Python:
  3.11.15
  managed by uv
  project environment: .venv  (git-ignored, not part of the repository)

uv:
  0.11.6

GPU:
  NVIDIA GeForce RTX 3060
  12 GB
  compute capability 8.6

NVIDIA driver:
  595.97

PyTorch:
  2.13.0+cu126

TorchAudio:
  2.11.0+cu126

PyTorch CUDA runtime:
  12.6
```

Notes that matter for anyone reproducing this:

- **A system CUDA Toolkit is not a prerequisite.** No Toolkit is installed on this
  machine and `nvcc` is not on `PATH`. The CUDA runtime bundled inside the PyTorch cu126
  wheels is what the Analyzer uses.
- `torch.cuda.is_available()` returns `True`, and a real 2048x2048 matrix multiplication
  has been executed on the RTX 3060 - not merely device enumeration.
- The driver reports CUDA 13.2, comfortably above what the cu126 wheels require. Newer
  drivers run older CUDA runtimes.
- **TorchAudio 2.11 is present but is not the audio I/O path.** It is a dependency of the
  stack rather than a component of it - see [Audio I/O](#audio-io). TorchAudio 2.11 is
  its terminal release: the project entered maintenance mode at 2.8, moved to a stable
  ABI, and is documented as compatible with PyTorch 2.11 and every later release. There
  is no torchaudio matching torch 2.13, and there will not be one.
- **TorchCodec is not installed.** WAV I/O goes through `soundfile`.

## Source separation - verified

`demucs-infer==4.2.2`, model `htdemucs`, run on `cuda:0`.

### Model

```text
htdemucs
41,984,456 parameters

sources:
- drums
- bass
- other
- vocals
```

Weights are fetched on first use into the normal PyTorch hub cache
(`%USERPROFILE%\.cache\torch\hub\checkpoints`), outside the repository. Checkpoint
`955717e8-8726e21a.th`, 80.2 MiB. Warm model load is 0.389 s; the first load including
download took 0.894 s.

### Synthetic smoke test

```text
input:
  duration: 8.0 s
  sample rate: 44100 Hz
  channels: 2
  format: PCM_16 WAV

inference:
  device: cuda:0
  wall-clock: 1.437 s
  real-time factor: 0.1797

GPU:
  max allocated: 575,712,768 B
  max reserved: 807,403,520 B
```

All four stems - `drums`, `bass`, `other`, `vocals` - were written and read back
successfully:

- written as WAV and re-readable with `soundfile`
- 44100 Hz, stereo, PCM_16
- duration 8.0 s each, delta against the input 0.0000 s
- no NaN, no Inf

**Smoke-test observation, not a quality benchmark.** The synthetic input was a sum of
simple signals, and the separation routed them plausibly: the 80 Hz sine landed in
`bass` (highest RMS), the decaying noise bursts in `drums` (highest peak), the 440 Hz and
660 Hz tones in `other`, and `vocals` came back essentially silent - correct, since the
input contains no voice. This says the model genuinely ran and is not a pass-through. It
says nothing about separation quality on real music, which this test cannot measure.

Execution really happened on the GPU: model parameters were resident on `cuda:0`,
161.8 MiB of weights were allocated before inference, and peak allocation rose to
549 MiB during `apply_model` - roughly 387 MiB of activations that a CPU run would never
have allocated.

## Beat / downbeat - verified

### Configuration

```text
package: beat-this==1.1.0
checkpoint: final0
device: cuda:0
dbn: false
input: full mix
```

```text
20,251,712 parameters
```

`final0` is the model trained on all data except GTZAN with seed 0. The checkpoint
(`beat_this-final0.ckpt`, 77.3 MiB) is cached in the PyTorch hub directory outside the
repository. Warm model load is 0.431 s; the first construction including download took
10.623 s.

DBN post-processing is **off**. Beyond the published finding that the DBN's
tempo-continuity prior hurts on expressive material, `dbn=True` would pull in madmom,
whose pretrained models are CC BY-NC-SA licensed while the rest of this stack is
permissive.

### Synthetic test

```text
duration: 33.5 s
sample rate: 44100 Hz
channels: 2
tempo: 120 BPM
meter: 4/4
bars: 16

ground truth:
  beats: 64
  downbeats: 16
```

Detected:

```text
beats: 68
downbeats: 17

median beat interval: 0.5 s
median downbeat interval: 2.0 s
```

Both sequences were strictly ascending, entirely finite, and contained within the audio
duration. All 64 ground-truth beats and all 16 ground-truth downbeats were matched within
±70 ms - 100% of both.

The meter was recovered correctly: downbeats came out at 0.5, 2.5, 4.5 s and so on, every
2.0 s, phase-locked to the accented click rather than to the start of the file.

> **The measured 0.00 ms timing error is an artifact of the test, not a real-world
> accuracy figure.** The synthetic beats sit at exact multiples of 0.5 s, which fall
> precisely on Beat This!'s 20 ms output frame grid, so quantised predictions land exactly
> on the ground truth. Real music will not line up this way. Do not quote this number as
> accuracy.

What the test does establish, and what matters practically, is the model's timing
resolution:

```text
frame rate ≈ 50 fps
hop ≈ 20 ms
```

Output timestamps are quantised to that grid. This is a floor on how precisely a beat
grid can be placed, independent of how good the model is.

### Boundary extrapolation

Four beats were emitted where there was no percussive evidence:

```text
0.0
32.5
33.02
33.5
```

One before the first click, three after the last one over the quiet harmonic bed. The
tail spacing also wobbles - 0.52 s then 0.48 s - where nothing anchors it.

This is **not treated as a failure**: extrapolating a pulse across a gap is reasonable
behaviour. It is recorded as an observation that a **post-processing or trimming policy
may be needed near track boundaries**, so that the Editor's beat grid does not present
invented beats in an intro or outro with the same authority as measured ones.

### Raw logits

`Audio2Frames` exposes the framewise output directly:

```text
beat logits:
  shape: [1676]
  min: -13.2173
  max: 10.2933
  mean: -9.2211

downbeat logits:
  shape: [1676]
  min: -15.2612
  max: 10.1092
  mean: -12.4794
```

These are **raw logits**, not probabilities - the class docstring says so, and the
inference code returns the model output with no sigmoid applied. They are unbounded and
must not be treated as, or silently renamed to, `confidence`.

Frames near a detected beat score much higher than the rest:

```text
beat-near mean logit:  -0.80
other-frame mean:     -11.31

gap ≈ 10.50
```

```text
downbeat near mean: +0.53
other:             -13.17

gap ≈ 13.71
```

So the logits carry real signal that could inform a confidence value. However **the
distributions overlap in the tails**: the 5th percentile of beat-near frames is -8.56
while the 99th percentile of other frames is -5.11, and some non-beat frames reach +5.00.
A global threshold applied to every frame would therefore not reproduce the detected beat
set.

The candidate approach - **not yet decided, not yet implemented** - is to take the logit
at the frame the postprocessor actually selected for each detected beat, rather than
thresholding the frame sequence. That matches how the postprocessor works: peak-picking,
not thresholding. See [Confidence policy](#confidence-policy---unresolved).

## Performance baseline

| Stage | Input | Inference | RTF | Peak CUDA allocated |
| --- | ---: | ---: | ---: | ---: |
| htdemucs | 8.0 s | 1.437 s | 0.1797 | ~549 MiB |
| Beat This! | 33.5 s | 0.915 s | 0.0273 | ~235 MiB |

Model load and first-run checkpoint download are excluded from the inference column:

| Stage | Checkpoint | Download (first run) | Warm load |
| --- | ---: | ---: | ---: |
| htdemucs | 80.2 MiB | ~0.5 s | 0.389 s |
| Beat This! `final0` | 77.3 MiB | ~10.2 s | 0.431 s |

These are initial baselines from synthetic smoke tests on one machine. They do not
predict performance on real songs, which are longer, denser and far more varied. The
Beat This! peak figure also includes a second model instance held resident on the GPU for
load timing; a single-model run would peak lower.

## Audio I/O

In this environment:

```python
torchaudio.load(...)
```

fails with `ImportError: TorchCodec is required for load_with_torchcodec`, because
TorchAudio's decoding has migrated to TorchCodec and TorchCodec is not installed.

Beat This! handles this itself - its `load_audio` tries `torchaudio.load` first and falls
back to `soundfile`, which succeeded. That fallback is a **normal supported path, not a
failure**.

For phase 1 the baseline is therefore:

```text
WAV + soundfile
```

TorchCodec is deliberately not adopted yet; it will be reconsidered when the real audio
I/O path is decided, in particular if formats other than WAV become necessary.

FFmpeg happens to be installed on this host, but it was not used by any of this work and
is **not** an Analyzer requirement. Nothing in the phase-1 stack should depend on it
being present.

## Confidence policy - unresolved

Different detectors emit scores on entirely different scales:

```text
Beat This!: raw logits          unbounded, roughly -15 .. +10 observed
torchcrepe: periodicity         a different quantity entirely
librosa:    onset strength      unbounded, signal-dependent
```

These are not comparable. Writing them into the Analysis document's single
`confidence` field as-is would make a filter like `confidence > 0.5` mean something
different for every event type, and the Editor's filtering would silently mislead the
author.

A per-detector calibration policy is required before the first real Analysis document is
written. **This is an open design issue.** It is a design decision, not an implementation
detail, and it should be settled and documented rather than improvised in code.

## Event end / offset policy

There is no general offset detector. The current intent, per event type:

```text
pitch notes:
  voiced / periodicity runs

transcription model:
  model-provided note offsets

percussion:
  RMS / spectral decay estimate, or omit

generic onset:
  end may remain unknown
```

The governing principle is that the Analyzer must not manufacture precision it does not
have:

```text
unknown > fabricated
```

An omitted `endSec` is always better than a confidently wrong one. Where an end is
estimated rather than measured, it should carry a correspondingly low confidence, and a
percussion "end" should be understood as a decay estimate rather than a physical end -
a kick drum has a decay time, not an end.

This has a schema consequence: an absent `endSec` currently means **both** "this event is
instantaneous" and "the end could not be determined". Those are different facts and a
human placing a hold note would want to tell them apart. Recorded below as gap **G3**.

## Current schema gaps

Identified during technology selection, to be re-evaluated against real data:

- **G1** - per-event provenance is weak; `generator` is global while every event comes
  from a different detector.
- **G2** - `confidence` is a single scalar, though onset, offset and pitch reliabilities
  differ sharply for the same event.
- **G3** - no distinction between "no end" and "end unknown".
- **G4** - `pitch` holds one value; pitch curves, vibrato and bends cannot be represented.
- **G5** - no way to state a time signature.
- **G6** - `stems[]` entries have no `sha256`, so a re-separation is invisible.
- **G7** - no home for frame-level curves such as onset-strength envelopes or beat
  activations.
- **G8** - `events[]` ordering policy is not stated.
- **G9** - no relative or normalized loudness, only absolute dB.

**No schema change is being made now.** These are recorded, not acted on. They will be
re-evaluated after an Analysis document has been generated from a real song, because
that is what will show which gaps are real and which are theoretical.

## Deferred / rejected

### Deferred

| Technology | Reason |
| --- | --- |
| Basic Pitch | Wanted for model-provided note ends; held back by its Python ≤3.11 ceiling and its noisiness on dense stems. |
| ADTOF | Drum class labels (kick / snare / hi-hat / tom / cymbal) are a phase-2 improvement. |
| LarsNet | Drum sub-separation as an alternative route to instrument labels; needs a ground truth to evaluate against. |
| Mel-Band RoFormer | Better separation quality, but community model weights need a licensing review first. |
| all-in-one | The best route to `sections[]`, but requires madmom and a NATTEN source build on Windows. |
| BeatFM | Reported to beat Beat This! on downbeats; research code, no packaging story yet. |
| PESTO, SwiftF0 | Faster successors to CREPE; revisit if torchcrepe's runtime becomes a bottleneck. |

### Rejected for the current Windows phase-1 stack

| Technology | Reason |
| --- | --- |
| Essentia | No Python bindings or wheels for Windows; the C++ core builds but the bindings do not. |
| madmom | Breaks on Python ≥3.10, needs a Cython and MSVC source build, and its pretrained models are CC BY-NC-SA (non-commercial). |
| aubio | Source-only on PyPI, stalled at 0.4.9, and duplicates capability librosa already provides. |
| MT3 / MR-MT3 | JAX/T5X based, with no practical packaged inference path on Windows. |
| CREPE (TensorFlow) | Would add a second deep-learning framework for what torchcrepe does on the PyTorch already installed. |

## Next steps

```text
DONE
  Python 3.11 / uv
  CUDA PyTorch
  demucs-infer / htdemucs
  Beat This!

NEXT
  torchcrepe
  librosa

THEN
  real-song PoC
  Analysis JSON emission
  contract validation
  schema review based on real data
```

The next milestone is running one real song through the whole chain once:

```text
Audio
 ├─ Beat This!
 └─ htdemucs
      ├─ drums → onset
      ├─ bass → pitch
      ├─ vocals → pitch
      └─ other → onset
             ↓
        Analysis JSON
```

and validating the result with `python tests/validate_contracts.py`. A real document
passing a contract test that was written before any data existed is the outcome worth
having - it is what will turn the schema gaps above from speculation into evidence.
