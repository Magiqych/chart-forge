# Chart Forge

> **Status: experimental / early-stage.**
> The schemas are draft contracts and are still expected to change. The Analyzer, the
> Editor and the Player all exist and are usable; each is its own component in its own
> stack, joined only by the JSON documents in [`schemas/`](schemas/).

Chart Forge is a toolchain for producing **hand-authored rhythm-game charts** with
machine assistance.

A song is analysed to find out *what happens in the music and when*. That analysis is
then shown to a human inside an editor as a **guide layer**, on top of which the human
places the actual notes. The result is played back and verified in a player.

## Motivation

Authoring a rhythm-game chart by hand is slow. Most of the time is not spent on
creative decisions — it is spent on mechanical work: locating the exact millisecond a
sound starts, finding where a sustained note ends, aligning a beat grid, hunting for
the hi-hat inside a dense mix.

Chart Forge's goal is **not to generate charts automatically.**

The goal is to **analyse event onsets, endings, pitches and other timing information in
the music, present them as a guide for a human author, and thereby cut the cost of
authoring an original chart by a large factor.** The musical judgement — which sounds
deserve a note, which lane, which pattern, how it should feel to play — stays with the
human. The machine only removes the tedious measurement work.

This distinction is a design constraint, not a slogan:

- The Analyzer emits **guide information**, never a chart.
- Analysis events and chart notes are **different concepts** with different schemas.
- Nothing in the pipeline turns an analysis event into a note without a human acting in
  the Editor.

## Architecture

Chart Forge is three independent components joined by JSON documents:

```text
Audio source
  ↓
Analyzer            extracts musical events from audio
  ↓
Analysis JSON       "what happens in the music, and when"
  ↓
Editor              human authoring, with the analysis shown as a guide layer
  ↓
Chart JSON          "where the notes go in the game"
  ↓
Player              playback and verification of a chart
```

The components are **loosely coupled**:

- Each one may be written in a different language. A plausible future split is a Python
  Analyzer and a TypeScript Editor/Player, but nothing in this repository assumes that.
- No component imports or reaches into another component's internals. They exchange
  files, not function calls.
- Any component can be replaced by a different implementation that reads and writes the
  same documents.

**The JSON Schemas in [`schemas/`](schemas/) are the contract between components.**
They — not the code — define what a valid exchange looks like. A component is
"compatible with Chart Forge" if it reads and writes documents that satisfy those
schemas.

## Data flow

| Document | Produced by | Consumed by | Answers |
| --- | --- | --- | --- |
| Analysis JSON | Analyzer | Editor | *What is happening in the audio, and when?* |
| Chart JSON | Editor | Player | *Where does the game place notes?* |
| Project JSON | Editor | Editor | *Which audio, analysis and chart belong together, and what is the authoring state?* |

See [docs/data-flow.md](docs/data-flow.md) for the detailed description, and
[docs/terminology.md](docs/terminology.md) for the vocabulary used throughout.

## Where the files live

The documents are small and the audio is not, and the two are kept on different terms.

**Heavy assets follow the source audio.** One run of the Analyzer separates a song into six
stems, which together come to several times the size of the recording, so they are written
beside the recording rather than anywhere near this repository:

```text
C:\Users\me\Music\Album\
├─ Song.wav                  the recording - never copied, never moved
└─ .chart-forge\song\        this song's asset root
   ├─ analysis.json          the Analysis document
   ├─ asset-manifest.json    what is stored here and how it was made
   └─ stems\                 vocals, drums, bass, guitar, piano, other
```

`analysis.json` is the single point of reference: it names its audio and its stems by paths
relative to itself, so a Project records one path into the asset root and no list of stems.
A Project is a few kilobytes and can live anywhere - including on a different drive from the
assets, which is the one case where the reference has to be absolute.

The repository itself holds only source, tests, docs, schemas and examples. No audio, no
stems, no analysis caches; see [.gitignore](.gitignore).

## Directory structure

```text
chart-forge/
├─ README.md                     this file
├─ CLAUDE.md                     working rules for agents/contributors in this repo
├─ .gitignore
│
├─ docs/
│  ├─ analyzer-stack.md          Analyzer technology selection and verified measurements
│  ├─ architecture.md            components, boundaries and why they are separate
│  ├─ data-flow.md               how documents move through the pipeline
│  └─ terminology.md             shared vocabulary (event vs. note, etc.)
│
├─ schemas/                      the contract between components (JSON Schema 2020-12)
│  ├─ analysis.schema.json
│  ├─ chart.schema.json
│  └─ project.schema.json
│
├─ analyzer/                     audio → Analysis JSON            (Python)
├─ editor/                       Analysis JSON → Chart JSON       (React + Tauri)
├─ player/                       Chart JSON → playback            (Node stdlib + browser)
│
├─ start-editor.cmd              launch the Editor  (Windows)
├─ start-player.cmd              launch the Player  (Windows)
│
├─ examples/                     minimal documents illustrating each schema
│  ├─ analysis.example.json
│  ├─ chart.example.json
│  └─ project.example.json
│
└─ tests/                        contract tests: python tests/validate_contracts.py
```

## Running the tools

On Windows, from the repository root:

```text
start-editor.cmd
start-player.cmd "D:\path\to\song-v2.project.json"
```

`start-player.cmd` also accepts a `.chart.json`, takes a file dropped onto it, and opens
a start screen when given nothing. The Player needs only Node.js and a browser - no
install step and no build - so it starts in a second; the Editor builds a Tauri desktop
shell and needs Node.js and the Rust toolchain. See [`editor/README.md`](editor/README.md)
and [`player/README.md`](player/README.md).

The Analyzer is a Python package run from the repository's own virtual environment:

```powershell
python -m analyzer "C:\path	o\Song.wav"
```

One run separates the song into six stems with `htdemucs_6s` - vocals, drums, bass, guitar,
piano and other - and analyses them, writing everything beside the recording. Re-running the
same song reuses the stems rather than separating again. See
[`analyzer/README.md`](analyzer/README.md).

## Target format

The long-term target is charts compatible with *THE iDOLM@STER CINDERELLA GIRLS
Starlight Stage* ("Deresute"). That format is **not** defined in this repository yet.

The chart model is deliberately split in two layers so this stays possible without
contaminating the core:

- a **generic** chart model (lanes, taps, holds, flicks, timing) that is not tied to any
  single game, and
- an `extensions` namespace where game-specific data lives.

Beside the notes, a chart may carry **Decorations**: presentation laid over the playfield,
such as the words that appear on screen during a song. A Decoration is not a Note - it has
no lane, nothing about it is judged or scored, and a Player that ignores them plays exactly
the same chart - so it lives in its own optional array with its own ids. See
[docs/decorations.md](docs/decorations.md).

## Non-goals for now

There is still no repository-wide language, build system, dependency manifest, CI or
container setup, and there is not meant to be: each component chose its own stack when it
needed one, and only for itself. The Editor picked React and Tauri; the Analyzer is a
Python package; the Player deliberately picked nothing at all and is Node's standard
library and a browser. Nothing binds the three together except the documents in
[`schemas/`](schemas/). See [CLAUDE.md](CLAUDE.md).
