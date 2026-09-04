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
  core/       pure logic - projection, chart model, snapping, session,
              viewport maths, lane layout                            (unit tested)
  render/     Canvas 2D renderers (analysis overlay, chart notes) and theme
  audio/      playback element + display envelope
  io/         the one route to documents, via the Rust loader and saver
  ui/         React components: Toolbar, ChartBar, LayerPanel, Timeline host
src-tauri/    Rust: OS dialog, document loader, chart saver, narrow asset scope
```

The timeline is **two stacked canvases**. The back one draws the analysis overlay; the
front one draws the chart notes, the placement preview and the playhead. They repaint
independently, so moving the pointer across a lane does not redraw 2258 events, and the
stacking fixes the order the Editor needs: beat grid, then analysis overlay, then chart
notes, then the playhead and live interaction.

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

### Authoring a chart

Placing a note is a click in a lane band of the notes row. The lane is whichever band was
clicked - **nothing derives a lane from a stem or from an analysis event**, and no such
mapping exists anywhere in the code or in the contract. Clicking an existing note selects
it instead of stacking another on top; Delete removes the selected one.

Snapping subdivides the **detected** `beats[]` by the chosen division, interpolating
inside each real interval. It never generates a grid from `tempo.bpm`: the Analyzer emits
no tempo map, a performance drifts, and an averaged grid would agree with the audio at
the start of a song and be wrong by the end. Analysis events are **not** snap targets -
snapping a note to an onset would quietly make the Analyzer the author.

Everything that changes the chart goes through `core/editorSession.ts`: `place`, `remove`,
`select` and `setSnap` are pure and return a new session, so an undo stack is a later
addition rather than a rewrite. Selection and the placement preview never reach either
document.

A session can have **two** things unsaved, and they are tracked apart. Placing or deleting
a note changes the Chart; changing the snap setting or division changes the Project's
`editor` section, which the contract keeps so a session can be restored. They are saved
together but can fail apart, so one flag could not describe the outcome honestly. The
toolbar still shows a single indicator.

Saving is explicit; there is no autosave. The Rust command takes the **project** path, not
a chart path, and derives the destination itself, so the frontend cannot nominate a file
to overwrite. The editor settings it accepts are a typed struct of exactly the two snap
fields, so the only part of a project document the frontend can write is the part the
contract defines for it; every other key under `editor`, known or not, is left as found.

**Order is chart first, then project**, because the project holds the reference to the
chart: nothing should point at a file that does not exist yet. Each file is written to a
temporary file in its own directory, flushed, synced and renamed over the target in one
step, so a half-written document never exists. If the project write fails afterwards, the
chart on disk is complete and valid - merely not yet referenced, or referenced with a
stale hash - so the Editor reports the chart as saved, keeps the project side dirty, and
the next save finishes the job. That is why there is no rollback machinery here: no
reachable intermediate state is corrupt.

The project file is rewritten only when it must be: to record a chart reference it did not
have, to refresh a `sha256` this write invalidated, or to store snap settings that
changed. When none of those apply the whole save is a single atomic file write.

A chart the Editor creates is referenced by name and **without** a `sha256`, because the
Editor rewrites that file on every save and a recorded hash would go stale immediately
unless the project were rewritten every time too. A project whose chart reference is
`kind: "inline"` is refused with an explicit message rather than written to a file.

## Implementation status

Foundation and Analysis visualisation: project loading, the read-only projection, the
timeline with beat grid and four event lanes, per-layer visibility, zoom/pan, and audio
playback with a synchronised playhead.

Note placement MVP: chart loading and creation, click to place, select, delete,
beat-grid snapping, an explicit atomic save, and a visible clean/modified state that
guards against opening another project over unsaved work.

Not implemented, and deliberately so: event snapping, automatic event-to-note
conversion, dragging a note to move it, multi-select, undo/redo, long-note and slide
authoring, a keyboard shortcut system, autosave, spectrogram, pitch contours, stem
soloing, density aggregation, and Player integration.

`hold`, `slide` and any other type in the contract's open vocabulary are **read and
written back untouched**, but cannot be placed here: they need an end time or an end
lane, which needs a drag. `tap` and `flick` are what a single click can fully describe.

**No automatic conversion of Analysis events into Chart notes exists or is planned as a
shortcut.** The overlay is guidance; the author decides. That is the project's thesis,
not a limitation to be lifted later.
