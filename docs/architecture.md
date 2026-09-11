# Architecture

Chart Forge is three independent components connected by JSON documents. This document
explains what each component is responsible for, what it is deliberately *not*
responsible for, and why the boundaries are drawn where they are.

## Overview

```text
        audio file
            |
            v
   +------------------+
   |     Analyzer     |   observes the audio
   +------------------+
            |
            |  Analysis JSON   (schemas/analysis.schema.json)
            v
   +------------------+
   |      Editor      |   a human authors the chart, guided by the analysis
   +------------------+
            |
            |  Chart JSON      (schemas/chart.schema.json)
            v
   +------------------+
   |      Player      |   plays and verifies the chart
   +------------------+
```

The Editor additionally reads and writes a Project JSON
(`schemas/project.schema.json`) that ties one audio file, one analysis and one chart
together with the editor's own working state.

## Components

### Analyzer

**Responsibility.** Given an audio file, produce an Analysis document describing what
happens in the music: tempo, beats and downbeats, onsets, note starts and ends,
durations, pitch, percussive hits, loudness, and how confident it is about each of
these. It may also perform source separation and reference the resulting stems.

**Not its responsibility.** Deciding anything about gameplay. The Analyzer does not know
what a lane is, how many lanes exist, what difficulty is being authored, or which sounds
deserve a note. Its output is *guide information for a human author*, not a draft chart.

This is the most important boundary in the project. If the Analyzer ever starts emitting
"suggested notes", the tool has quietly become a chart generator, and the human's
judgement — the part that actually makes a chart good — gets replaced by an average.

**Likely implementation.** Batch processing, offline, plausibly Python. Nothing outside
`analyzer/` may assume this.

### Editor

**Responsibility.** Load a project, show the audio and the analysis as layers on a
timeline — waveform, spectrogram, beat grid, onsets, note durations, stems, analysis
events — and let a human place, move and delete notes on top of that guide layer.
Writes the Chart document.

**Not its responsibility.** Analysing audio. If the Editor needs better guide
information, the answer is to run the Analyzer again with different settings, not to
grow a second analysis implementation inside the Editor.

**Likely implementation.** An interactive application, plausibly TypeScript. Nothing
outside `editor/` may assume this.

### Player

**Responsibility.** Load a Chart document and the audio, play them in sync, and let the
result be verified — visually, and eventually as actual gameplay.

**Not its responsibility.** Editing charts, or reading Analysis documents. The Player
sees only the chart; if a chart plays badly, that is information for the author, not
something the Player fixes.

It does accept a Project document, and only for one thing: finding the chart and the
audio. A project is where an author's files are actually associated, so requiring them to
be dug out by hand would make a worse tool and buy no purity. Nothing else in the project
reaches playback — the analysis is not read, the editor state is not read — and nothing
is ever written back.

**Likely implementation.** Whatever can be started without ceremony. It is currently a
small local server on Node's standard library plus a browser application, with no
dependency manifest and no build step. Nothing outside `player/` may assume this.

## Why the components are separate

**Different lifecycles.** Analysis is slow, batch, and rerun rarely. Editing is
interactive and constant. Playback is real-time. Fusing them would force the slowest and
the most latency-sensitive parts of the system into the same process and the same
release cycle.

**Different technology fits.** Audio analysis and machine learning are strongest in
Python; interactive timeline UI and rendering are strongest on the web platform. Forcing
one stack on all three would compromise at least one of them. The JSON boundary lets
each component pick what suits it.

**Replaceability.** Any component can be swapped for a different implementation that
speaks the same documents. A different Analyzer, a scripted chart generator writing Chart
JSON directly, or an alternative Player are all possible without touching the others.

**Testability.** Every boundary is a file. Each component can be tested against
fixture documents, with no other component present.

## The contract

The schemas in [`../schemas/`](../schemas/) are the contract. Components exchange
documents, never function calls, objects or database rows. Concretely:

- No component imports source from another component.
- No component reads another component's internal files, caches or build output.
- Shared vocabulary lives in [`terminology.md`](terminology.md); shared structure lives
  in the schemas. Neither lives inside a component.
- A field that only one component understands does not belong in the core schema. It
  belongs in that component's own state (`editor` in the project document) or in an
  extension namespace.

## Separating game-specific concerns

The long-term target is Deresute-compatible charts, but the chart model is split so that
this stays a target rather than an assumption:

- The **core chart model** describes lanes, notes, holds, flicks, slides and timing in
  game-neutral terms. `playfield.laneCount` is explicit rather than implied.
- `playfield.profile` names the gameplay profile a chart targets.
- The **`extensions`** object holds anything specific to one game, keyed by profile
  name.

The rule that keeps this honest: *a chart must still be meaningful when every extension
is ignored.* A Player that understands only the core model must be able to play the
chart, even if it plays it imperfectly for the target game.

## Deferred decisions

The following are deliberately undecided, and adding them now would constrain the data
model for no benefit: UI framework, desktop shell, ML framework and separation model,
dependency manifests, CI, containerisation, and the exact Deresute chart format. See
[`../CLAUDE.md`](../CLAUDE.md).
