# Editor

Where a human authors a chart, with the analysis displayed as a guide layer.

- **Input:** a Project document ([`../schemas/project.schema.json`](../schemas/project.schema.json)),
  which references the audio and an Analysis document
  ([`../schemas/analysis.schema.json`](../schemas/analysis.schema.json)).
- **Output:** a Chart document conforming to
  [`../schemas/chart.schema.json`](../schemas/chart.schema.json), plus the updated
  Project document.
- **Examples:** [`../examples/project.example.json`](../examples/project.example.json),
  [`../examples/chart.example.json`](../examples/chart.example.json).

## Scope

Show the song on a timeline, with guide layers drawn over it:

- waveform
- spectrogram
- beat grid, derived from tempo and offset
- onsets
- note starts, ends and durations
- stems, individually viewable
- analysis events, filterable by type, source and confidence

and let the author place, move, retime and delete notes against that guide - with
snapping to the beat grid, playback with a moving playhead, and audition of the result.

Layer visibility, zoom, playhead position and snap settings are saved in the `editor`
section of the Project document, purely so a session can be restored.

## Out of scope

- **Analysing audio.** If the guide information is not good enough, the Analyzer is run
  again with different settings. The Editor does not grow its own analysis code.
- **Deciding notes.** The Editor may make placement *easy* - snapping, aligning to a
  nearby event, bulk operations on a selection - but the author chooses. There is no
  one-click conversion of events into notes that stands in for authoring.

## Design notes

- **Degrade gracefully.** An analysis may lack pitch, stems, sections or confidence, or
  may be missing entirely. Every layer must handle its data being absent.
- **Tolerate unknown values.** Event types, stem kinds and layer ids are open
  vocabularies: display what you do not recognise, do not reject the document.
- **Keep the chart clean.** Analysis values do not leak into the Chart document. The
  only bridge is the optional `sourceEventId` on a note, which records what the author
  was looking at and has no effect on playback.
- **Prefer file references.** Analysis documents get large; reference them from the
  project rather than embedding them, so editor state can be saved without rewriting
  the analysis.
- Times are seconds from the start of the audio, in fields named `...Sec`.

## Stack

| | |
| --- | --- |
| Desktop shell | Tauri 2 |
| UI | React 19 + TypeScript |
| Build | Vite |
| Timeline | native Canvas 2D |
| Audio | HTML media element streaming + Web Audio for the display envelope |
| Tests | Vitest |
| Package manager | npm |

Everything lives under `editor/`; no other component gains a JavaScript dependency, and
the JSON documents remain the only interface between components.

Deliberately **not** used yet: PixiJS, Konva, wavesurfer.js, Redux, Zustand, Tailwind,
any component framework, any database or server. Each would be added only when a measured
need appears.

## Running it

```powershell
cd editor
npm install
npm run test        # Vitest, no browser needed
npm run typecheck
npm run build       # type check + production bundle
npm run tauri dev   # desktop shell (needs the Rust toolchain)
```

The frontend builds and its tests run with Node alone. The desktop shell additionally
needs a Rust toolchain, the MSVC build tools and the WebView2 runtime - Tauri's standard
Windows prerequisites.

## Architecture

**React owns state, Canvas owns pixels.** React holds the viewport, playhead, layer
visibility and the loaded projection, and orchestrates interaction. The timeline -
waveform, beat grid, event overlay, playhead - is drawn by `src/render/timelineRenderer.ts`,
a plain TypeScript module that knows nothing about React.

That split is not stylistic. A real Analysis document carries **2258 events**; rendering
those as DOM nodes would put thousands of elements through the reconciler on every pan.
They are never React elements.

```text
src/
  core/       pure logic - projection, viewport maths, lane layout   (unit tested)
  render/     Canvas 2D renderer and theme
  audio/      playback element + display envelope
  io/         the one route to documents, via the Rust loader
  ui/         React components: Toolbar, LayerPanel, Timeline host
src-tauri/    Rust: OS dialog, document loader, narrow asset scope
```

### The filesystem boundary

The frontend gets **no general filesystem access**. It calls one Rust command with a
project path the user picked from the OS dialog; the loader resolves that Project's
`documentRef`s relative to the project file, canonicalises them, verifies the recorded
SHA-256, and returns only those documents. A `..` in a reference is legitimate - a
project commonly sits beside the runs directory it points into - so paths are resolved,
not rejected for their shape. No URL or network references are supported.

Audio is streamed through Tauri's asset protocol, whose scope starts empty and is widened
only to the single file the loader resolved. A 40 MB track is never marshalled through
IPC as base64.

### Analysis projection

The Analysis document is **read-only guidance**, never copied into an editor model. On
load it is reduced to a projection of the stable contract fields;
`metadata.experimental` is dropped, which on a real 5.01 MB document leaves **0.85 MB** -
an 83% reduction - and costs 5.4 ms.

Event shape is chosen by `endKind`, never by whether `endSec` happens to be present:
`instantaneous` draws a tick, `bounded` draws a span positioned by `pitch.midi` within
its lane, and a future `unknown` draws a mark with a fading tail so it can never be
mistaken for a measured end.

There is **no confidence control**, not even a disabled one: Analysis 0.2 emits no
`confidence`, and offering the affordance would promise what the data cannot deliver.

## Implementation status

Foundation and Analysis visualisation MVP: project loading, the read-only projection, the
timeline with beat grid and four event lanes, per-layer visibility, zoom/pan, and audio
playback with a synchronised playhead.

Not implemented, and deliberately so: note authoring, event snapping, automatic
event-to-note conversion, spectrogram, pitch contours, stem soloing, density
aggregation, undo/redo, and Player integration.

**No automatic conversion of Analysis events into Chart notes exists or is planned as a
shortcut.** The overlay is guidance; the author decides. That is the project's thesis,
not a limitation to be lifted later.
