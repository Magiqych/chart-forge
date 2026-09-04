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
| Monophonic pitch | `torchcrepe==0.0.24` | verified | bass / vocals f0 + periodicity |
| Onset / features | `librosa==0.11.0` | verified | drums / other onsets, envelopes, spectral features |
| Audio I/O | `soundfile==0.14.0` | verified for WAV and FLAC | audio read/write, fallback path |
| Polyphonic transcription | Basic Pitch | deferred | phase 2 |
| Drum classification | ADTOF / LarsNet | deferred | phase 2 |

Every phase-1 role is now verified end-to-end on this machine. librosa is held at
**0.11.0** rather than the current 1.0.0 because 1.0.0 requires Python >= 3.12 while the
Analyzer runtime is Python 3.11; moving to librosa 1.x would be a decision to move the
Analyzer's Python version, not a routine bump.

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

Analyzer packages:
  demucs-infer  4.2.2
  beat-this     1.1.0
  torchcrepe    0.0.24
  librosa       0.11.0
  soundfile     0.14.0
  numpy         2.4.6
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

## Monophonic pitch - verified

### Configuration

```text
torchcrepe: 0.0.24
model: full
decoder: Viterbi (the library default, unmodified)
device: cuda:0
frequency range: 50-1000 Hz
hop: 441 samples @ 44100 Hz  (about 10 ms)
batch size: 512
```

Model weights ship **inside the wheel** as package assets -
`torchcrepe/assets/full.pth`, about 84.9 MiB, plus a `tiny.pth`. **No external download
occurs**, which makes this the only stage in the stack with no network dependency and no
cache directory to manage.

torchcrepe assumes **monophonic** input. Demucs stems are stereo, so the Analyzer must
downmix a stem to mono explicitly before calling it; stereo must never be passed through.

### Synthetic pitch test

Input: 9.0 s mono, 44100 Hz, with sustained sine tones separated by silence -
110 Hz over 1.0-3.0 s, 220 Hz over 3.5-5.5 s, 440 Hz over 6.0-8.0 s.

| Tone | Median predicted | Median abs. error | Median cents error | p95 cents |
| ---: | ---: | ---: | ---: | ---: |
| 110 Hz | 110.371 Hz | 0.444 Hz | ~7.0 | ~18.8 |
| 220 Hz | 220.791 Hz | 0.951 Hz | ~7.5 | ~18.8 |
| 440 Hz | 441.807 Hz | 2.016 Hz | ~7.9 | ~19.6 |

**No octave errors** occurred in the trimmed voiced regions: zero frames landed within
50 cents of half or double the true frequency, and every measured frame was within
50 cents of the truth.

> These are sustained pure sine tones - the easiest possible input for a pitch tracker.
> They say the stage runs correctly. They are **not** a real-song transcription accuracy
> figure and must not be quoted as one.

One systematic detail worth remembering: the cents error was **positive in all three
regions** (+5.8, +6.2, +7.1 median), so predictions ran slightly sharp rather than
scattering around zero.

### Periodicity

Alongside f0, torchcrepe returns a per-frame **periodicity**. Observed medians:

```text
voiced:
  110 Hz   0.8722
  220 Hz   0.9241
  440 Hz   0.9657

silence:
  leading  ~0.0001
  middle   ~0.0005 / ~0.0011
  trailing ~0.1412
```

The separation between voiced and silent regions is large, and periodicity alone was
enough to segment this signal. But the **trailing silence behaved differently from the
leading silence** - about 0.1412 against 0.0001 - despite both being identical digital
zero. The Viterbi decoder runs over the whole sequence, so the path is suspected to carry
state forward from the preceding voiced tone. The conclusion to carry forward:

```text
periodicity != calibrated probability
periodicity alone != reliable silence detector
```

### Silence gate - open issue

`torchcrepe.threshold.Silence(-60)` was applied as a documented experiment and
**changed nothing at all** on this signal.

The reason was traced in the library source rather than guessed. `torchcrepe`'s loudness
metric is **not absolute dBFS**: it takes an STFT, converts with
`librosa.amplitude_to_db` - whose default `top_db` clamps everything to within a fixed
range of *that clip's own peak* - applies A-weighting, then averages across frequency
bins. On this clip every frame landed between about -55.5 dB (digital silence) and
-54.3 dB (the loudest tone), a spread of roughly **1.2 dB**, with no frame below -60. The
threshold could not fire regardless of how silent the silence was.

Because the scale floats with the material, a threshold tuned on one track will not
transfer to another. **`Silence(-60)` must not be adopted as Chart Forge's production
silence policy.** This is an open design issue.

### Voiced runs - the result that matters

Using a provisional rule only - `periodicity >= 0.50`, minimum 5 consecutive frames:

| Ground truth | Detected run | Start error | End error | Duration error |
| --- | --- | ---: | ---: | ---: |
| 1.00 - 3.00 s | 1.02 - 2.98 s | +20 ms | -20 ms | -40 ms |
| 3.50 - 5.50 s | 3.51 - 5.49 s | +10 ms | -10 ms | -20 ms |
| 6.00 - 8.00 s | 5.99 - 8.00 s | -10 ms | 0 ms | +10 ms |

Exactly three runs were found, with no spurious segments, and every boundary landed
within roughly **±20 ms** - one to two frame hops, which is the resolution floor rather
than a limit of the method.

This is direct evidence that the path

```text
pitch / periodicity frame sequence
  -> provisional voiced run
  -> startSec / endSec
```

is technically sound, which matters because note ends are the weakest part of the whole
Analyzer design. The threshold of 0.50 is **not** a production policy; it was chosen to
test feasibility, not tuned.

### Performance

```text
cold:  38.372 s for 9 s of audio
warm:   0.842 s for 9 s of audio   (RTF 0.0936)

GPU peak allocated: ~1378.5 MiB
GPU peak reserved:  ~1646.0 MiB
```

**Implementation consideration:** the first call costs roughly 45x the warm call. The
Analyzer must construct and warm torchcrepe **once per process and reuse it** across
stems, never per call. Loading it separately for bass and for vocals would waste more
time than the entire rest of the pipeline.

## Onset extraction - verified

### Configuration

```text
librosa: 0.11.0        (not 1.0.0, which requires Python >= 3.12)

librosa.onset.onset_strength   ->  framewise spectral-flux envelope
librosa.onset.onset_detect     ->  onset times

sample rate: 44100
hop_length: 256
frame interval: ~5.805 ms
backtrack baseline: false
peak-picking: librosa 0.11.0 defaults, unmodified
```

The peak-picking defaults are the library's own hyper-parameter-optimized values: 30 ms
`pre_max`, 1 frame `post_max`, 100 ms `pre_avg` and `post_avg`, 30 ms `wait`,
`delta` 0.07, with `normalize=True`. The 30 ms `wait` sets a floor on the closest two
onsets can be.

librosa's beat tracker and tempo estimator are **not** used. Beat and downbeat remain
Beat This!'s responsibility.

As with pitch, stems are downmixed to mono explicitly before analysis.

### Synthetic result

Eight ground-truth transients of four kinds - kick, click, snare and hi-hat - placed over
12 s with a quiet harmonic bed:

```text
expected: 8
detected: 8
false positives: 0
missed: 0

median absolute error: ~6.02 ms   (p95 8.54 ms, max 8.93 ms)
all eight within ±20 ms
```

Every detection was **late**, by roughly 2.7-8.9 ms. That is not an accuracy score so
much as an observation about the method: the spectral-flux peak necessarily sits slightly
after the physical attack that produced it.

### Backtracking

With `backtrack=True` every detection moved earlier - median shift about **-8.71 ms**
(range -5.8 to -17.4) - which brought them closer to the true attack, improving median
absolute error from ~6.02 ms to about **~3.4 ms** on this material.

```text
backtrack=False -> spectral change peak
backtrack=True  -> preceding local energy minimum
```

**Neither is adopted yet.** Which one makes a better guide for placing rhythm-game notes
is a question about human authoring, to be settled against real songs and Editor UX, not
against synthetic transients.

## Onset strength semantics

This is the most important finding from the onset stage, and it generalises beyond
librosa.

### Onset strength is not loudness

In the synthetic test the *quietest* event scored higher than the *loudest* one:

```text
weak hi-hat, amplitude 0.18  ->  onset strength 12.59
strong kick, amplitude 1.00  ->  onset strength  6.79
```

Within a single transient type, reducing amplitude did lower strength (kick 1.00 -> 0.25
gave 6.79 -> 4.32; click 0.80 -> 0.20 gave 20.75 -> 13.33). But **spectral character
dominated amplitude by a wide margin**: broadband and high-frequency transients score far
higher than low-frequency ones at any level. All eight events were detected regardless.

Therefore:

```text
onset strength != loudness
onset strength != correctness probability
```

Onset strength must **not** be written into an Analysis Event's `confidence` field as-is.
A quiet hi-hat is not less certain than a loud kick; it is a different kind of sound.

## Real-song observation

A local proof-of-concept input was analysed to see whether the synthetic results survive
contact with real music. The audio is a personal local file and is deliberately **not**
recorded here as a project requirement, committed, or referenced by any code; the stems
live outside the repository. Track length about **296.8 s**.

Separation used the already-verified `htdemucs` on `cuda:0`; onset analysis was run on the
`drums` and `other` stems only.

### Drums

```text
~1678 detected onsets   ->  ~339 per minute
median inter-onset interval  ~116 ms
first onset ~7.593 s, last ~277.606 s
```

- Dense, but within the range a rhythm-game guide layer plausibly occupies.
- Detected peak strength median is about **11.7x** the envelope median - sharp, isolated
  peaks rather than a raised noise floor.
- **No mass of weak detections**: zero percent of detections fell below 10% of the stem's
  maximum strength.
- No detections in the first or last second of the track.

### Other

```text
~335 detected onsets   ->  ~67.7 per minute
```

- The expected risk was a dense wall of spurious notes on a polyphonic stem. **That did
  not happen** - `other` came out far sparser than drums.
- Detected peak strength median is only about **4.0x** the envelope median, against 11.7x
  for drums: the background envelope is much flatter and detections are less prominent
  relative to it.
- **Using the same absolute threshold for both stems would therefore be wrong.**
- One detection near 0.929 s is worth checking by eye, but there was no clear
  track-boundary extrapolation pattern of the kind Beat This! showed.

### Event density and the Editor

```text
drums  ~339 onsets/min
other   ~67.7 onsets/min
```

Both look workable as guide layers today. Drums is dense enough that the Editor may need
filtering, a strength or confidence control, or zoom-dependent rendering to stay readable.
**No Editor implementation policy is decided here** - this is recorded so the question is
asked deliberately rather than discovered late.

Because there is no ground truth for a real song, none of the above is precision, recall
or accuracy. They are observations.

## Performance baseline

| Stage | Input | Inference | RTF | Peak CUDA allocated |
| --- | ---: | ---: | ---: | ---: |
| htdemucs (synthetic) | 8.0 s | 1.437 s | 0.1797 | ~549 MiB |
| htdemucs (real song) | 296.8 s | 12.51 s | 0.0422 | ~549 MiB |
| Beat This! | 33.5 s | 0.915 s | 0.0273 | ~235 MiB |
| torchcrepe (warm) | 9.0 s | 0.842 s | 0.0936 | ~1378 MiB |
| librosa onset (warm) | 296.8 s | 1.34 s | 0.0045 | CPU only |

Model load and first-run checkpoint download are excluded from the inference column:

| Stage | Weights | Download (first run) | Warm load |
| --- | ---: | ---: | ---: |
| htdemucs | 80.2 MiB | ~0.5 s | 0.389 s |
| Beat This! `final0` | 77.3 MiB | ~10.2 s | 0.431 s |
| torchcrepe `full` | 84.9 MiB, bundled in wheel | none | first call ~38.4 s |

Three cautions about reading this table:

- **Cold timings are not steady-state performance.** torchcrepe's first call costs ~38 s
  against 0.84 s warm. librosa's first `onset_strength` took 4.32 s against 1.34 s for
  identical-length audio on the next call, the difference being numba JIT compilation.
  Warm figures are the ones that describe a running Analyzer.
- **Demucs memory does not grow with track length.** The 296.8 s track peaked at the same
  ~549 MiB as the 8 s clip, because `split=True` performs segmented inference. Long tracks
  will not exhaust the card.
- The Beat This! peak includes a second model instance held resident on the GPU for load
  timing; a single-model run would peak lower.

## Timing resolution

| Stage | Frame interval |
| --- | ---: |
| Beat This! | ~20 ms |
| torchcrepe | ~10 ms |
| librosa onset | ~5.8 ms |

> **Frame resolution is not detector accuracy.** These numbers bound how finely each stage
> *can* place an event; they say nothing about whether the event is in the right place.
> librosa's ~5.8 ms grid coexists with a systematic 2.7-8.9 ms late bias, and Beat This!'s
> coarser 20 ms grid still recovered meter and phase correctly.

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

`soundfile` has since also read a **FLAC** source directly for the real-song observation,
so the practical decode coverage is WAV and FLAC without any extra dependency.

TorchCodec is deliberately not adopted yet; it will be reconsidered when the real audio
I/O path is decided, in particular if compressed formats such as MP3 become necessary.

FFmpeg happens to be installed on this host, but it was not used by any of this work and
is **not** an Analyzer requirement. Nothing in the phase-1 stack should depend on it
being present.

## Confidence policy - unresolved

Different detectors emit scores on entirely different scales:

```text
Beat This!: raw logits          unbounded, roughly -15 .. +10 observed
torchcrepe: periodicity         bounded near 0..1, but not calibrated
librosa:    onset strength      unbounded, dominated by spectral character
```

All three are now verified and measured, and they are **not comparable**. Writing them
into the Analysis document's single `confidence` field as-is would make a filter like
`confidence > 0.5` mean something different for every event type, and the Editor's
filtering would silently mislead the author.

Measurement has since made the problem worse than "one mapping per detector". The same
detector produced **different distributions on different branches**:

```text
librosa onset strength, detected peak median / envelope median

  drums   ~11.7x     sharp isolated peaks
  other    ~4.0x     flatter background, less prominent detections
```

A calibration derived from the drums stem would therefore misrepresent the `other` stem,
even though both come from the same detector with the same parameters. The likely
requirement is calibration:

```text
per detector  AND  per branch
```

rather than per detector alone. Two further findings constrain any such mapping:
torchcrepe's periodicity is not a probability and misbehaves on trailing silence, and
librosa's onset strength tracks spectral character rather than loudness or correctness.

**This remains an open design issue**, and it is now the largest one blocking a
trustworthy first Analysis document. It is a design decision, not an implementation
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

Identified during technology selection, then re-evaluated against the first real Analysis
document. The list below is the original one, kept as written; the section after it
records which gaps the 0.2 contract candidate closes and which stay open.

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

These were recorded rather than acted on, pending evidence from a real song.

## Analysis contract 0.2 candidate

A real Analysis document has now been generated from a full track - 2258 events across
four branches, 461 beats, 940 events with a measured end and 1318 without, and 53 events
sharing a timestamp with another event. That evidence closed four of the nine gaps well
enough to put them in the contract; the rest are deliberately still open, because the
document did not tell us what the right answer is.

**Addressed by the 0.2 candidate**

- **G1 - per-event provenance.** The document now carries a top-level `detectors[]`
  registry, and every event and beat references one entry through a required
  `detectorId`. A registry rather than a per-event object was chosen because the real
  document's `events[]` had already reached ~1.99 MB at roughly 880 bytes per event, and
  repeating a detector object on all 2258 events would have made that worse for no
  information gain. `metadata` survives for analyzer-specific values such as raw scores,
  but it is no longer where provenance lives.
- **G3 - instantaneous versus unknown end.** Every event now carries a required
  `endKind` of `instantaneous`, `unknown` or `bounded`. In the real document 1318 events
  had no `endSec`, and nothing distinguished "a drum hit has no duration" from "the end
  could not be determined". The value is `bounded` rather than `measured` deliberately:
  these ends are detector-derived estimates, not physical measurements.
- **G6 - stem integrity.** `stems[]` entries take an optional `sha256`, matching the
  pattern already used by `audio`. It stays optional because an analysis may reference
  stems produced elsewhere, whose hash is unavailable. In the real document the four stem
  hashes had been exiled to experimental metadata - a block explicitly marked as
  undependable - which meant nothing could actually verify a stem.
- **G8 - event ordering.** `events[]` is now contractually ordered by `startSec`
  ascending and then `id` lexicographically, and the validator enforces the full key
  rather than just the timestamp. The secondary key is not decoration: 53 events in the
  real document shared a timestamp, so without it the order was not reproducible. The
  schema states explicitly that the tie order carries no musical priority.

Alongside these, the validator gained a supported way to check a real document:
`python tests/validate_contracts.py --analysis <path>`. Generating the first real
document had exposed that no such entry point existed.

**Still open, deliberately**

- **G2 - confidence semantics.** Still unresolved, and the real document made it sharper
  rather than easier: the same detector produced different distributions per branch. The
  document omits `confidence` entirely rather than emitting a number that looks
  comparable and is not.
- **G4 - pitch curves.** Confirmed as a real loss - the median pitch run is 0.16-0.18 s
  and is compressed to a single median frequency - but the right representation for a
  contour is not yet designed.
- **G5 - time signature.** Meter was constant in the test track, so nothing forced the
  issue. The real document omits `barIndex` and `beatInBar` because the intro's meter
  phase was unreliable, which leaves 461 beat times carrying no meter information at all.
- **G7 - frame-level curves.** Inlining them worked but cost a 2.7x size multiplier
  (5.63 MiB for a 3.4-minute track). Whether they belong inline, in a sidecar, or nowhere
  in the contract is a design decision, not a missing field.
- **G9 - normalized prominence.** Raw onset strength now lives only in experimental
  metadata, so a consumer reading the stable contract has no prominence signal at all.
  The honest fix is tied to G2 and should be designed with it.

Nothing about the open gaps should be read as solved.

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
IMPLEMENTED  (analyzer/, one CLI command)
  ingest
  separate
  beat
  pitch
  onset
  merge
  emit Analysis 0.2

NEXT
  dependency manifest / fresh-environment bootstrap
  confidence calibration design            (G2, G9)
  voiced-run segmentation beyond a bare threshold
  decide what to do about drum bleed in the other branch

STILL OPEN
  G2  confidence semantics
  G4  pitch curves
  G5  time signature
  G7  frame-level curve storage
  G9  normalized prominence
```

Phase 1 is no longer a set of isolated experiments: `python -m analyzer <audio>
--output-dir <dir>` runs the whole chain and writes a contract-valid Analysis 0.2
document. See [`../analyzer/README.md`](../analyzer/README.md).

### What the first formal runs showed

The implementation was checked against the proof-of-concept reference on the same track.
Run **on the same stems** it reproduces the PoC exactly - identical event counts
(1093 / 225 / 463 / 477) and every timestamp identical to the last decimal. Run
end-to-end from the audio, the counts move by a few percent, and the reason is upstream:

**htdemucs separation is not bit-reproducible on this GPU.** Two runs over the same input
produced stems sharing only 2-4% of their samples exactly, with a mean absolute
difference around 0.005 and a maximum around 0.18. That is inaudible, but it is enough to
move a peak across a picking threshold or a periodicity value across the voiced cut, so
every branch downstream of separation inherits the variation.

What that means for reproducibility of an Analysis document:

```text
deterministic across runs
  document structure, detector registry, audio.sha256, tempo.bpm
  beats and downbeats - 461/461 identical to the microsecond, because the beat
    branch reads the original mix and never touches a stem
  endKind vocabulary, detectorId assignment, event ordering, absence of confidence

not deterministic
  stem hashes, and therefore every count and boundary downstream of them
  drums onsets  - p95 within about 6 ms, but counts drift ~0.1%
  other onsets  - far looser, p95 in the hundreds of milliseconds
  pitch-run boundaries and counts - runs drift by a few percent
  pitch values  - median ~3-4 cents between runs
```

The pitch differences above 50 cents are a **matching artefact, not f0 drift**: pairs
exceeding 50 cents have a median duration difference of 220-230 ms, while pairs under
50 cents differ in duration by 0 ms. They are different musical spans that happen to
start within 20 ms of each other. Measured on identical input, torchcrepe's f0 drift
stays under 20 cents and its periodicity is bit-identical.

The practical consequence: an Analysis document's **structure and beat grid are
reproducible, its event set is not**, and a document hash is not a stable identity.
Anything that needs exact reproducibility must pin the stems, not just the input audio.

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
