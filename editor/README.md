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

On Windows, double-click **`start-editor.cmd`** in the repository root. It finds this
directory relative to itself, checks that `npm` and `cargo` are on PATH, installs
dependencies on a first run, and starts the desktop shell. It keeps the window open if
anything goes wrong so the reason is readable.

By hand, or on any other platform:

```powershell
cd editor
npm install
npm run test        # Vitest, no browser needed
npm run typecheck
npm run build       # type check + production bundle
npm run tauri dev   # desktop shell (needs the Rust toolchain)
```

`tauri dev` starts Vite itself through `beforeDevCommand`, so there is no need to run
`npm run dev` alongside it.

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

The Editor has two modes, and that split is the top-level control in the chart toolbar:

    [ Edit | Select ]

**Edit makes notes. Select chooses and removes them.** Which one is active decides what
every press in the lanes means, before the gesture starts - a drag rubber-bands under
Select and draws a note out under Edit. Nothing infers the intent from how far the pointer
subsequently moved, so the same movement never means two things on two different days.

The rule itself is a pure function in `core/pointerIntent.ts` rather than a branch buried
in a pointer handler, because it is the one place the split is actually decided and it can
then be tested exhaustively over every mode, kind and modifier.

In **Edit Mode** the toolbar offers `Note`, plus `Direction` when the kind is Flick, plus
the snap controls and `Place Note at Event`. Placing is a click in a lane band of the notes
row; the lane is whichever band was clicked - **nothing derives a lane from a stem or from
an analysis event**, and no such mapping exists anywhere in the code or in the contract.
Pressing on a note that is already there does **nothing at all**: stacking a second note on
the first is a mistake every time, and quietly selecting it instead would mix the two modes
back together, which is the confusion the modes exist to remove.

In **Select Mode** none of those controls appear - hidden rather than disabled, because a
control that cannot do anything is noise, and Select has nothing to say about which kind of
note it is not placing. What it shows instead is how many notes are selected and a
`Delete Selected` button.

#### The note kinds

Four gameplay kinds, stored as the Chart contract's own words:

| Toolbar | `type` | Authored by | Carries |
| --- | --- | --- | --- |
| Single | `tap` | a click | - |
| Long | `hold` | a drag along a lane | `endTimeSec`, optional `endAction` |
| Slide | `slide` | a click per point, then `Connect` | `waypoints`, `endTimeSec`, `endLane`, optional `endAction` |
| Flick | `flick` | a click | `direction` |

A Long is the only kind drawn out by dragging: it is a length, and a drag is the natural
way to say how long. Both ends go through the same snap, and a reversed drag is normalised,
so dragging right-to-left gives the same note.

A Slide is not a length. It is a chain of judgement points, so the Editor places the
**points** one click at a time and joins them afterwards - see Connect below. That makes
the second point something the author can see, move and reconsider before committing to a
connection, and it is the shape a multi-point slide will need.

Flick direction needed **no contract change**: `chartNote.direction` is already an
enumeration of the eight compass directions. The toolbar offers **Left and Right only**,
as a segmented pair shown when the kind is Flick, because those are the two a Deresute
flick uses and offering all eight would be offering choices this Editor has no opinion
about. All eight are still read, drawn and written back untouched, so a chart carrying
`upLeft` survives a round trip through the Editor unchanged.

Nothing here forecloses a Long that ends in a flick either, because `direction` is optional
on every type rather than something only a `flick` may carry.

**Purple was briefly a fifth entry here and is not any more.** It was never a settled
gameplay kind - the open question was whether it named a different thing to hit or just a
way a Tap is drawn - and offering it in the toolbar answered that question by accident.

Retiring it took **no contract change**, because adding it had taken none: `chartNote.type`
is an open vocabulary, so `purple` was only ever a word the Editor happened to write. A
chart that already contains one still loads, is still drawn as an ordinary instantaneous
note, and is **written back untouched** - opening a chart is not permission to rewrite it.
What went is the authoring surface: the toolbar entry, the placement, and the special
colour and click that made it look settled. It now draws and sounds like any other kind the
Editor has never heard of. If Purple returns it will be as a Tap plus something in the
game-specific extension namespace, decided with real charts in hand.

There is no `simultaneous` type and there should not be: two notes at the same time are two
notes, and simultaneity is a fact about a pair rather than a property of one.

#### Turning a flick round

A standalone Flick's direction can be changed after it is placed. Select it, and the
inspector offers the same two choices the toolbar offers while placing:

    Direction   [ \u2191 Left ]  [ \u2193 Right ]

Only the direction changes - the time, the lane, the id and any `sourceEventId` are the
note's identity and its provenance, and turning an arrow round says nothing about them.
One history step, and reselecting the direction it already has records nothing, so an
author checking which way a flick points does not fill the undo stack by looking.

It is a **different command from the end action below**, writing a different field.
`direction` is a Flick's own direction; `endAction.direction` is how a Long or a Slide
finishes. Both offer Left and Right and both draw left as up and right as down, but they
are different statements and one control doing both could not say which it meant. The
inspector shows `Direction` for a standalone Flick and `End` for a note that has an end,
so the two never appear together.

For now the control appears for exactly one selected Flick. Turning a whole selection round
at once is a reasonable thing to want, and nothing here forecloses it.

#### Finishing in a flick

A Long or a Slide can end in a flick rather than an ordinary release. The toolbar offers
it while the note is being placed and the inspector changes it afterwards, both through
the one command, so it is a single undo step either way:

    End   [ Normal ]  [ \u2191 Flick ]  [ \u2193 Flick ]

It is stored as its **own field**, not by reusing the note's `direction`:

```json
{ "type": "hold", "timeSec": 1.875, "lane": 1, "endTimeSec": 11.25,
  "endAction": { "type": "flick", "direction": "left" } }
```

The reason is ambiguity. On a plain Flick, `direction` already means that note's own
direction; on a Long it would say nothing about *which* moment it described. `endAction`
says plainly that it is the end. It is an object rather than a bare string so a later end
action - whatever a real chart turns out to need - is a new `type` here rather than
another shape change.

The persisted directions stay `left` and `right`, and the screen convention is the same as
a standalone Flick's: **left is drawn up, right is drawn down**, because on this timeline
the horizontal axis is time.

Geometrically the flick **replaces the last judgement marker** rather than sitting beside
it: the arrow is centred on `endTimeSec`, so the moment is the middle of the arrow exactly
as it is the middle of a bar. On a multi-point Slide only the final point becomes an arrow
- the middle points keep their bars, because only the end is flicked - and the last
connector runs to the arrow's centre. The arrow is the note's geometry for the hit test,
hover, selection, the rubber band and culling too, so clicking the arrow selects the note.
Where the arrow overlaps a Long's resize grip the grip wins, which is what a grip is for.

`Disconnect` **drops** an end action: standalone points have no end for one to happen at.
It is not moved onto the last point, because turning a slide point into a flick would
silently change what the player is asked to do, and it is not kept, because that would be
a document the contract rejects. Undo restores the chain and its end action together.

#### Selecting

In Select Mode, dragging from empty lane space draws a rubber band, and everything whose
**drawn parts it intersects** is selected - not everything whose start point it contains,
so a Long caught anywhere along its body, or a Slide caught anywhere along its trajectory,
is caught. The test uses the same `core/noteGeometry.ts` the renderer draws from, and it
tests the parts rather than the bounding box: a rectangle in the empty corner beside a
steep slide has not touched the slide and does not select it. What looks caught is what is
caught, at any zoom and any scroll position.

- Click a note: select just it. Click empty space: clear the selection.
- Shift-click a note: add it, or remove it if it was already selected.
- Drag a band: select what it caught. Shift-drag: add what it caught to what was there.
- Escape: clear the selection.
- Delete or Backspace: delete everything selected, as **one** undo step.
- **Drag a note**: move the selection in time and across lanes.
- **Drag a selected Long by its end**: change how long it is.
- **Select two slide points**: `Connect` joins them.

#### Editing what is already there

Select Mode is not only for choosing and deleting. Three edits go through it, and each is a
single command recorded once, when the pointer comes up:

**Move.** Dragging a note carries the whole selection, in snapped time and whole lanes. Both
ends of a note that has two move together - dragging a Long moves it, it does not stretch
it, because one gesture doing two things is how an author loses a length they had already
got right. The delta is clamped once for the set rather than per note, so a group meeting
the start of the recording or the edge of the playfield keeps its shape instead of
collapsing onto the boundary. A press that never travels is just a selection; the move
begins only after the pointer moves a few pixels.

**Resize.** A selected Long shows a grip at its end, and the cursor becomes `ew-resize`
when the pointer is over it. Dragging it changes `endTimeSec` and nothing else - the start
of a Long is the moment the player is asked to press, and a grip on the far end has no
business moving it. The end goes through the same snap a placement would. Shrinking stops
at a small minimum rather than refusing, so the grip stays usable at the limit and a Long
can never be turned into a zero-length hold. The grip is only drawn, and only grippable, on
a selected note: a handle you cannot see must not be one you can accidentally grab.

**Connect.** Selecting exactly two unconnected slide points enables `Connect`, in the
toolbar and in the inspector. It is disabled with the reason in its tooltip when the
selection is not two points, when one of them is not a slide point, or when the two are at
the same instant.

Throughout, the drag itself is transient: the preview is drawn from the same geometry the
committed note will have, but the chart and the history are untouched until the pointer
comes up. Undo therefore reverses the edit the author made rather than the hundred pointer
events it was made of.

#### Connect, and what it does to the data

A slide is a **chain of judgement points**, and `Connect` is how the chain grows. It takes
any two of:

- two loose points, making a two-point slide;
- a chain and a point, extending the chain at either end;
- two chains that do not overlap in time, merging them.

so it can be pressed again and again to build `A -> B -> C -> D`. That is the whole reason
a slide is authored point by point instead of dragged out in one gesture: every point is
something the author can see, move and reconsider before committing to a connection.

The result is **one note**. Every judgement point of every input is collected, ordered by
time, and written back as start, `waypoints` and end:

    point A + point B + point C + point D
      -> A keeps its id, and becomes
         { timeSec: A, lane, waypoints: [B, C], endTimeSec: D.timeSec, endLane: D.lane }
      -> B, C and D are removed

Which note survives is decided by **time**, never by the order the author clicked, so
selecting a pair either way round gives the same slide. Points at the same instant are not
a direction to travel in and are refused; so are two chains whose times interleave, because
joining those would need the points to cross and a slide is one path travelled forwards.
The surviving note keeps its id and its `sourceEventId`, so a slide built from a point that
cited an Analysis Event still cites it.

The other notes' identities do not survive - they have become the middle and the end of the
survivor. That is the cost of representing a slide as one note, and it is why this is a
single history step whatever the chain's length: **undo restores every original note
exactly**, because history restores whole states rather than replaying commands. Growing a
four-point slide is three Connects and therefore three undos, one per decision.

`Disconnect` goes the other way on a selected chain: every point becomes its own standalone
note again. The first keeps the slide's id; the rest are **new** points with new ids,
because the ids they had before being folded in were retired and ids are never reissued.
Undo, not Disconnect, is what gets the originals back byte for byte.

#### Connecting flicks, which is not the same thing

Flicks can also be joined, and the result is deliberately *not* a slide. A **flick chain**
is several flicks that the player hits in succession, and the line drawn between them is
scenery: it carries no judgement of its own. So the notes stay notes. Four connected flicks
are four notes, each with its own `id`, `timeSec`, `lane` and `direction`, and the toolbar
goes on saying `4 notes`, because the player is asked to flick four times.

That is the opposite of what `Connect` does to slide points, and the two are kept apart by
the **kind of note selected**, not by a mode or a second button. A selection of flicks
connects as a run; a selection of slide points connects as a slide chain; a mixture -
slide with flick, tap with flick, long with flick - is refused rather than resolved into
whichever seems more likely. `Connect` reports which of the two it did.

A run grows the same way a slide chain does, and under the same rules: run + point at
either end, run + run where the times do not interleave, again and again, `A-B` then `+C`
then `+D`. Order comes from `timeSec` and never from the order of clicking.

Because the notes survive, so does everything about them. A flick in the middle of a run
can be selected on its own, turned round, and dragged to another lane; the connectors
follow it, and its neighbours are untouched. Clicking a **connector** selects the whole
run; clicking an **arrow** selects that one flick. `Disconnect` removes the connections and
leaves the flicks exactly as they were - nothing to restore, because nothing was folded
away.

Deleting a flick out of the middle of a run removes the connections that touched it and
**does not join its neighbours back up**. Re-joining would be a connection the author never
made, and a chart that quietly rewires itself when a note is deleted is worse to author
than one that leaves two shorter runs. Connect and Disconnect are one history step each,
as is the delete.

Three different things now use the word "direction", and they are separate on purpose:

| | what it is | where it lives |
|---|---|---|
| a flick's `direction` | which way to flick this note | `chartNote.direction` |
| a Long's or Slide's `endAction.direction` | which way to flick when the hold ends | `chartNote.endAction.direction` |
| a flick chain | which flicks are drawn as one run | `chart.connections[]` |

A connection says nothing about direction, and a direction says nothing about connection.
Each flick in a run points wherever its author set it; the run drawn through them is
allowed to zig-zag, because a chain of flicks in alternating directions is a real thing to
ask a player for.

Visually the two connectors must not be confused, so they are drawn differently: a slide's
connector is **dotted**, and a run's is a **solid thin line**. A run's line joins the
centres of the two arrows, and drawing it never moves a flick in time - the geometry
follows the notes, never the other way round.

#### Storing a chain: on the note, or on the chart

Two shapes were considered before anything was written.

`note.nextNoteId` puts the link on the note. It is compact, and a chain reads by following
one field. But it makes a **relation between two notes** into a property of one of them,
and it is the only field on `chartNote` that would say something about a note other than
itself: every other field - `timeSec`, `lane`, `direction`, `endTimeSec` - states what this
note asks of the player. It also puts the burden of consistency on note order, needs a
whole-array scan to answer "what points at me", and makes the delete rule above awkward,
because removing a note means finding and editing whichever note referenced it.

`chart.connections[]` puts the link where it belongs: a list, at the top of the chart, of
pairs of note ids. Notes stay untouched, so a flick is exactly the same document with or
without a chain around it; a connection can be added and removed without rewriting a note;
and a reader that does not know the field sees a valid chart of independent flicks - the
documented fallback, and the honest one, because each flick really is an independent
judgement. That is the shape that was implemented.

    "connections": [
      { "type": "flick", "fromNoteId": "n-0001", "toNoteId": "n-0002" },
      { "type": "flick", "fromNoteId": "n-0002", "toNoteId": "n-0003" }
    ]

`type` is open the way `chartNote.type` is open, so a future kind of visual link needs no
version bump; the Editor draws and edits only `flick`.

A connection is valid when both notes exist, they are not the same note, both are flicks,
`from` comes strictly before `to` in time, the pair is not already listed, and no note has
two connections leaving it or two arriving at it. Six rules, and they are enough: the
strict forward-time rule makes a **cycle unrepresentable** rather than merely forbidden,
so there is no traversal check to get wrong. Connections that fail any of them are dropped
on load rather than being allowed to poison the geometry, and `validate_contracts.py`
reports each as its own code.

#### The contract change this needed

Multi-point slides could not be expressed by the previous contract, so `chartNote` gained
one **optional** field:

```json
{
  "id": "n-0001", "type": "slide", "timeSec": 1.875, "lane": 0,
  "waypoints": [
    { "timeSec": 4.21875, "lane": 2 },
    { "timeSec": 6.5625,  "lane": 1 }
  ],
  "endTimeSec": 8.90625, "endLane": 4
}
```

`waypoints` lists the intermediate points, in strictly ascending time order, between
`timeSec`/`lane` and `endTimeSec`/`endLane`.

It is additive and backward compatible in both directions, so **the document `version` is
unchanged at 0.1.0**: every chart that was valid before is still valid, and a reader that
does not know the field still sees a valid slide with the right start and end - which is
exactly the documented fallback the schema rules ask for. The repository's rules reserve a
version bump for breaking changes, and adding an optional field is the kind they name as
preferred.

Three things moved with it, in the same change: `schemas/chart.schema.json` gained the
field and a `slideWaypoint` definition; `tests/validate_contracts.py` gained four rules
JSON Schema cannot state (waypoints only on a slide, waypoints only with an end, lanes
inside *this* chart's playfield, and points strictly ascending) with a negative fixture
each; and `examples/chart.example.json` gained a four-point slide.

One existing rule was also **relaxed**: `chart/hold-missing-end` used to require an
`endTimeSec` on every `hold` *and* every `slide`. A lone slide point legitimately has
neither, so the rule now applies only to a `hold`. That is a permissive change - nothing
that validated before stops validating - but it is a contract change and is listed here
because it is one.

`endAction` was added the same way and for the same reasons: optional, additive, and
therefore **no version bump**. A reader that ignores it sees a correct Long or Slide that
simply releases at the end. It brought three more validator rules with a negative fixture
each - an end action needs an end to happen at, only a `hold` or a `slide` can carry one,
and a flick end action needs a direction - plus a `noteEndAction` definition in the schema
and two examples. `direction` also became a shared `$defs/direction` rather than the enum
written out twice.

Neither change touched the Rust side. The loader and saver treat a chart's notes as opaque
JSON and never model a note's fields, so a new optional field needs nothing from them.

Shift-drag inside the lanes extends a selection rather than panning the view; outside them,
and on the middle mouse button anywhere, it pans as it always did. A modifier cannot mean
two things at once.

Changing mode drops any gesture in progress. A half-drawn note or a rubber band left over
from the other mode would otherwise finish under rules nobody chose; clearing it costs
nothing, because none of it has touched the chart or the history.

The selection is session state throughout. It is never written into the chart or the
project, never dirties anything, and never enters the undo history - the rubber band in
particular exists only as transient state in the timeline component and reaches the
session once, when the pointer comes up.

Deleting is one command with one implementation. The keyboard, the toolbar button and the
inspector's `Delete Selected` all call it, so twenty notes deleted together are one step
to undo: the author made one decision, and one press of Ctrl+Z reverses it, restoring all
twenty with their original ids and any `sourceEventId` intact.

Snapping subdivides the **detected** `beats[]` by the chosen division, interpolating
inside each real interval. It never generates a grid from `tempo.bpm`: the Analyzer emits
no tempo map, a performance drifts, and an averaged grid would agree with the audio at
the start of a song and be wrong by the end. Beat and Guide snapping are separate,
exclusive modes rather than two strengths of one control, because a beat and an onset are
different questions and a note should never be ambiguous about which of them it was
aligned to. Guide mode does not survive a reload: the Project contract's `editor.snap` is
`{enabled, division}` and nothing else, so there is nowhere to record a third mode, and it
reads back as Off. See **Snapping, and using the overlay as a guide** below.

### Placing a note from an Analysis Event

Clicking an event in the overlay **selects** it and nothing more. What it is - branch,
stem, type, start, end, duration, pitch, detector, id - appears in the sidebar, and a
separate `Place Note at Event` button is what actually authors a note. Two deliberate
actions, never one: an event is an observation, and turning observations into notes
without being asked is the thing this project exists not to do.

The author still chooses the lane and the note type in the toolbar. **No mapping from a
stem to a chart lane exists anywhere** - not in the code, not in the contract - and the
placement command's signature is the guarantee: it takes a time, a lane, a type and an
event *id*, so an event's stem, pitch or duration cannot reach a note. A bounded event
contributes only its start; its duration never becomes a hold.

The time is the event's `startSec` verbatim, deliberately **not** re-snapped. Picking an
event means wanting the measured position of the sound, and pulling the note back onto
the grid afterwards would discard the reason for the gesture. An ordinary click on the
timeline snaps as configured; this does not, and the toolbar and the status line both say
so.

Such a note records `sourceEventId`. It means what the contract says it means - "a
human-authored back-reference ... never a claim that the note was generated from the
event" - and an ordinary manual click records nothing, because no event was consulted.
Several notes may cite one event: building a chord from a single observed onset is
ordinary authoring, so the relationship is not one to one.

A click lands on the event under the pointer using one shared geometry function, the same
one the renderer draws with, so what is drawn and what is clickable cannot drift apart. A
pitched run is found by its pitch as well as its lane, so two runs an octave apart at the
same instant are separately selectable. Where several events are in range the winner is
decided in a fixed order - distance, then draw order, then `startSec`, then id - so the
same click always selects the same event. Only what is drawn is clickable: hidden layers
and events outside the viewport are not among the candidates, which reuses the renderer's
own range index rather than scanning the document.

Everything that changes the chart goes through `core/editorSession.ts`: `place`,
`placeAtEvent`, `remove`, `select` and `setSnap` are pure and return a new session.
Selection and the placement preview never reach either document.

### What a note looks like

This is a chart editor, not the game screen. Its job is to make **time** readable, so the
basic mark is a bar standing across a lane at one instant, not a decorative token. A note
is drawn from a small set of parts, and which parts it has is the whole visual language:

| Kind | Parts drawn |
| --- | --- |
| Single | `instantMarker` |
| Flick | `flickArrow` - and no marker at all |
| Long | `instantMarker` + `longBody` + `resizeHandle` + `instantMarker` |
| Slide point | `instantMarker` |
| Slide, connected | `instantMarker` + `slideConnector` + `instantMarker` |

A **marker** is a judgement point: a moment the player has to arrive at, drawn as a thin
bar three pixels wide. Its width is a constant, **not** a converted duration: a moment has
no width to scale, and a bar that grew with the zoom would become a box whose left and
right edges are both plausible readings of "when". The hit tolerance, not the drawn width,
is what makes it clickable.

A **body** is time spent holding something down. A **connector** is a path travelled
between lanes. A **grip** is what changes how long a body is.

A **flick has no bar**. It is drawn as an arrow and nothing else, centred on
`timeToX(timeSec)` so the moment is the middle of the arrow rather than something offset
beside a bar. The arrow is the note as far as the hit test, hover, selection, rubber band
and culling are concerned - all of them read the same `flickArrow` geometry, so clicking
the arrow is what selects the flick.

Left and right are drawn as **up and down**. The persisted `direction` is unchanged and a
round trip preserves `left` and `right` exactly; they are drawn vertically because on this
screen the horizontal axis is time, and a left-pointing arrow beside a note reads as
"earlier", which is not what a flick direction means. Putting the pair on the axis that is
not time keeps the indicator from making a claim about timing. Any other direction a chart
carries is drawn as the compass direction it names.

Keeping those apart is what stops a Slide being drawn as a diagonal Long. A Slide's
checkpoints are instants and the line between them is a trajectory - nothing is judged
along it - so drawing it as a held body would say the player keeps something pressed the
whole way, which is not what a slide asks for. Only a Long gets a body.

The connector is **dotted**, and that is the whole point of it: a Long is a solid body
because something is held down for its entire length, and a slide connector is a dotted
route between two instants. It goes down first so the markers sit on top of it, because
the markers are the thing being timed and nothing should obscure them.

Every judgement point is drawn identically, whether it is a Single, a loose Slide point or
one end of a Long, because they are the same thing. Only the colour says which kind it
belongs to. Selecting a note thickens its bar rather than boxing it: a three-pixel line has
to stay findable when it is selected, and turning it into a rectangle would undo the reason
it is a line.

`core/noteGeometry.ts` decides the parts from the fields a note carries, **never from its
type name**. `chartNote.type` is an open vocabulary, so a chart written elsewhere may use
a word this Editor has never seen:

- no `endTimeSec`, no `direction` - a marker, and nothing else;
- no `endTimeSec`, with a `direction` - **flick**: an arrow, and no marker;
- `endTimeSec` and no `endLane` - **held**: two markers, a body and a grip;
- `endTimeSec` and an `endLane` - **travelling**: two markers joined by a dotted connector.

A travelling note whose end lane equals its start lane is still travelling; it simply
travels nowhere, and is drawn as two checkpoints joined by a level line rather than as
something held.

Horizontal geometry is time. A held note's body spans `timeToX(endTimeSec) -
timeToX(timeSec)` and nothing else, so it stretches with the zoom exactly as its duration
deserves. A marker has no duration to scale, so it is given one - about 60 ms, roughly the
width of a drum hit - and that duration is converted through `pixelsPerSecond` like
everything else. Pixels appear only as clamps on the ends of that conversion, so the bar
stays visible when zoomed right out and does not swamp the lane when zoomed right in. Lane
height is not a time scale and does not zoom.

That one geometry module is the single source for the renderer, the hit test, the rubber
band, the placement preview and viewport culling, and all of them work part by part rather
than from a bounding box. So clicking a Long anywhere along its body selects it, a rubber
band catches a Slide by its trajectory, and neither of them selects the empty corner of a
rectangle that merely encloses a diagonal.

The parts are what let a slide be any length: geometry returns `markers[]` and
`connectors[]`, so a four-point slide is four bars and three dotted segments rather than a
special case. Nothing assumes there are exactly two of anything.

### Hearing the chart

During playback each note makes a short click, synthesised with Web Audio rather than
loaded from a file. This is the feedback that makes timing checkable: the track alone
tells you where the music is, the track plus your own notes tells you whether you put them
in the right place.

Which notes have been passed is decided by `core/hitScheduler.ts`, over a half-open
interval - `previous < timeSec <= current` - rather than by asking whether the playhead is
near a note. A dropped frame can advance the clock by a third of a second, and a nearness
test would silently swallow everything in the gap; an interval catches all of them, each
exactly once, and a chord fires every one of its lanes.

The clock is the audio element's own `currentTime`, never a wall clock. That is what makes
the clicks stay on the notes at 0.5x: chart time is chart time whatever speed it is played
at. A jump of more than a second is read as a seek, so moving the playhead does not fire
everything skipped over, in either direction; resuming announces nothing from before the
resume point.

The click has its own level, deliberately independent of the music, because charting is
done with the track turned down and the clicks kept audible. Placing a note auditions it
too - only a placement that actually succeeded, never a selection, an undo or a scroll.

### Moving around, and listening

The timeline has one position: `viewport.startSec`. The scrollbar under it draws no state
of its own - the thumb's size and place are computed from the viewport each render, and
dragging it reports a new start time back. It is a drawn thumb rather than an overflowing
element on purpose: a real scrollbar owns a `scrollLeft`, and keeping that agreed with the
canvas through zooms, seeks and project loads is precisely the class of bug this avoids.
A zoom needs no scrollbar code at all - the thumb narrows because the view got shorter.

Sideways movement is also on the wheel: shift plus the wheel scrolls horizontally
whichever axis the platform reports it on, and a trackpad's horizontal swipe arrives as
`deltaX` and pans directly. Shift-drag pans everywhere except inside the lanes, where
Shift belongs to the selection. None of it is an edit, so none of it enters the undo
history.

#### One viewport, and its real width

The viewport is `{ startSec, pixelsPerSecond, widthPx }`, and `widthPx` is the width of the
canvas the author is actually looking at. It has to be measured from the DOM, so the
timeline measures it - and then **publishes it upwards into that one viewport** rather than
keeping a copy.

This was a real bug, not a tidiness point. The width used to be a placeholder the App
guessed at (`1000`) which only got corrected as a side effect of the timeline happening to
send a viewport back. Every span the App worked out was therefore computed against a screen
that did not exist: `Fit` fitted the recording into 1000 px and left the rest of the canvas
empty, `Locate Playhead` centred on the wrong point, and **Follow concluded that the whole
recording already fitted on screen and refused to scroll at all**. A resize is not the
author taking the wheel, so a width report is applied directly and never switches Follow
off.

#### Moving with the keyboard

| Key | What it does |
| --- | --- |
| Space | Play / pause |
| `<-` `->` | Seek by a fixed distance **on screen**, so the step follows the zoom |
| Shift + `<-` `->` | The same step, five times as far |
| `Up` `Down` | Previous / next Analysis Event in the layers that are switched on |
| (any of those four) | Also plays a moment of the song where it lands - see below |
| Delete, Backspace | Delete the selection (Select Mode) |
| Escape | Clear the selection |
| Ctrl+Z, Ctrl+Y | Undo, redo |

All of it is navigation rather than editing, so it works the same in both modes: how to
move around a recording is not something the choice of chart tool should change. Every
binding defers to whatever the browser is already editing - a text box, a `select`, a
`contenteditable` - so typing is never hijacked. A checkbox is deliberately **not** in that
set: clicking a layer checkbox leaves it focused, and if it counted as editable then
toggling a layer would silently switch keyboard navigation off until the author clicked
somewhere else.

**A fixed number of seconds is the wrong unit for an arrow key.** At the zoom where a bar
fills the screen one second is a nudge; at the zoom where a single note fills it, one second
is off the edge. So the step is a distance on screen converted through `pixelsPerSecond`,
the same conversion the whole timeline is built on:

    stepSec = KEYBOARD_STEP_PX / pixelsPerSecond      (clamped, then x5 for Shift)

`KEYBOARD_STEP_PX` is 16, chosen by using it: below about ten pixels the playhead barely
appears to move, above about thirty a press overshoots the detail the author zoomed in to
look at. The result is measurable - at 15 px/s a press moves 1.054 s and at 305 px/s it
moves 0.052 s, which is 15.8 and 15.9 pixels respectively. Clamps at 0.01 s and 2 s bound
the conversion at the ends of the zoom range, where 16 px would otherwise be an inaudible
8 ms or a phrase-skipping 3.2 s.

**Up and down walk the Analysis Events**, moving the playhead to each and selecting it so
the inspector shows what the Analyzer found. Only events in lanes that are switched on are
candidates, which turns the layer checkboxes into a filter for reading: with Bass hidden
the keys stop visiting bass events. **Chart Notes are never candidates** - an Analysis Event
is an observation about the recording and a Chart Note is something the author wrote, and
this is navigation through the former.

The step is measured from the selected event when there is one and the playhead otherwise,
so a run of presses walks the list one event at a time instead of sticking wherever the
playhead happened to round to. Ties are broken by `(startSec, lane, id)`, so several
detectors firing on one instant give the same order every run.

#### Hearing where you landed

Moving the playhead with the keys tells the eye where it is. **Navigation audition** tells
the ear: after any of those four keys, the song plays for about a tenth of a second and
stops again, so an author frame-advancing through a bar hears *this is the kick*, *this is
where the vocal enters* without starting playback and hunting for the pause key. The
toolbar has a switch for it; it is on by default and is session state, like the rest of the
playback settings.

This is the **song**, not a note click. The hitsounds heard during playback and the click a
placement makes are separate features with their own switch, and a navigation seek is
announced to the hit scheduler as a seek, so stepping across notes does not set off a burst
of clicks.

Two rules matter more than the duration:

- **It only ever stops what it started.** While the song is already playing there is
  nothing to do - the author is listening, and the seek has taken them somewhere new.
  Pausing a tenth of a second later would be this feature stopping playback it did not
  start, so an audition auto-pauses only when the song was paused to begin with.
- **Only the newest press can stop the sound.** Holding a key down produces a stream of
  navigations, each starting a sound and asking for it to stop shortly after. If the third
  press's stop arrived during the fifth press's sound it would cut it off, and holding the
  key would give silence with occasional blips. The pending stop is cancelled on each new
  navigation, and every run carries a generation number so a callback already in flight
  finds itself stale and does nothing. Pressing play or pause cancels any pending stop
  outright, because the transport is the author's.

The audition advances the clock by its own duration, so it puts it back where the
navigation landed - otherwise five presses of an arrow would move five steps *plus* half a
second. The decision is a pure function (`planNavigationAudition`) and the cancellation is
a small controller taking its timers and its media as arguments, so both are tested without
a browser.

#### Following the playhead

Follow keeps a playing playhead inside a **safety zone**, from 20% to 78% of the width.
While it is inside that band nothing moves and the playhead itself travels across the
screen, which is what makes the timeline readable; when it reaches the edge the view steps
once and puts the playhead back at 30%, low enough to have most of the width to run through
before the next step. Occasional readable jumps, rather than a picture creeping continuously
under the eye.

The clock is the audio element's own `currentTime` throughout - the same clock the playhead
and the note clicks use. There is no second timer and no accumulated delta anywhere, so a
change of playback rate simply supplies bigger or smaller steps and Follow is unaffected:
it is a function of where the playhead is, never of how it got there.

Zooming anchors on the pointer, which is right, but at a close zoom that can carry the
playhead off the edge - and a playhead you cannot see is a playhead you have lost. So after
a zoom: if the playhead is still on screen the view does not move at all, because jumping
the timeline on every zoom would be worse than the problem it solves; if it has gone, it is
brought back to the middle rather than the edge it left by. With Follow on, Follow decides
instead, keeping the invariant it already promised.

The two are different questions and stay separate: **playback** follow only runs with Follow
on, and the **zoom** reveal only rescues a playhead a change of scale pushed off screen.
With Follow off, playback never scrolls the view. There is still one `viewport.startSec` and
one rule for the zoom, in `startSecAfterZoom`, so the wheel and the zoom slider cannot drift
apart. A zoom is not a manual pan, so it does not switch Follow off; a pan does.

Playback volume and mute live in the toolbar. Mute is the media element's own `muted`
rather than a volume of zero, so unmuting returns to the level that was set without
anything having to remember it. Both are session state: they change no document, are not
undoable, and are not persisted.

### Undo

`core/chartHistory.ts` keeps a past/present/future triple of whole `ChartState` values.
That is affordable because a chart state is immutable and every command already returns a
new one, so the entries share every note that did not change and a step costs one small
object. It also means **redo restores rather than replays**: putting the previous state
back returns the note that existed - its id, its time, its `sourceEventId` - where
re-running a `place` would mint a fresh id and lose the point of undoing a misplacement.

Only chart authoring is undoable: place, place-from-event, delete. The viewport, the
playhead, layer visibility, the snap mode and division, the lane and type pickers and both
selections are not - undo is for taking back an edit to the document, not for rewinding
where the author happens to be looking. A command that changed nothing records no step.

Whether the chart is dirty is an **identity comparison** against the state last written to
disk, not a flag: undoing back to what was saved reports clean by construction, and
undoing *past* a save reports dirty again because the file still holds the note that
memory no longer does. Saving does not clear the history - it only moves that baseline -
so an author can still take back the edits that went into a save.

Two things deliberately do not rewind. The saved baseline is held by reference, and the
note-id counter is a high-water mark: undo puts the chart's counter back, but an id that
was once handed out is never handed out again, so a note the author undid and one they
place afterwards can never share an identity. The canvas is given only `present`; no
renderer ever sees the history.

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

### Placement rules, in one place

| | Time | `sourceEventId` | Lane |
| --- | --- | --- | --- |
| Click the timeline | snapped per the current mode | not set | the lane band clicked |
| `Place Note at Event` | the event's `startSec`, exactly | the event's id | chosen in the toolbar |

Selecting an Analysis Event changes no document. Placing from one is a second, explicit
action, and several notes may come from the same event. It places whatever kind the tool
names, so it asks for a note tool rather than quietly picking one when the tool is Select
- which it is when the Editor opens, because an opening click should never create
something the author did not ask for.

### Snapping, and using the overlay as a guide

Snapping has three exclusive modes. **Off** and **Beat** are what `project.editor.snap`
can express and are saved with the project. **Guide** snaps to the Analysis Events in the
layers that are switched on; it is session-only, because the contract's snap object is
`{enabled, division}` and nothing else, so there is nowhere to record a third mode. It
reads back as Off, and the toolbar labels it `Guide (session)`.

A beat and an onset are different questions, so the modes stay exclusive and a note is
always aligned to one or the other.

**The guide source is the same one the arrow keys walk.** `navigableEvents` decides which
events are on screen and reachable, and both features read that one answer, so the layer
checkboxes mean the same thing to both: what you can step to with up and down is what you
can snap to, and hiding a layer removes it from both at once. Chart Notes are never a
source - snapping notes to other notes is a different feature with different rules.

    Analysis Events
      -> navigableEvents(events, visibleLanes)     one visible-layer rule
           -> up / down navigation                 event starts
           -> buildGuideAnchors(...)               anchors to snap to

An **anchor** is a time worth aiming at. Every event contributes its `startSec`; a bounded
event contributes its `endSec` **only when the question calls for it**. Placing a note asks
when a sound started, so only starts are candidates. Dragging the end of a Long asks when
one stopped, so both are - which is exactly what an author is looking at when they pull a
hold out to meet the end of a sustained note. Where a start and an end coincide the end
wins, because someone dragging an end was looking for where to let go; remaining ties go by
lane and then event id, so the same drag always gives the same answer.

The radius is **`GUIDE_SNAP_RADIUS_PX` = 12 CSS pixels**, converted through
`pixelsPerSecond`:

    radiusSec = GUIDE_SNAP_RADIUS_PX / pixelsPerSecond

so the pull feels the same at every zoom: zoomed out it covers a wide slice of time, zoomed
in it narrows until a note can be placed between two onsets a few milliseconds apart. A
fixed number of seconds would do the opposite of what the eye expects. Outside the radius
nothing happens and the author's own click stands - nothing is ever dragged across the
screen to an event they were not aiming at.

**One resolver.** `resolvePlacementTime` is the single place a raw pointer time becomes the
time a note is written at, and every placement goes through it: Single, Flick, a Slide
point, a Long's start and end as it is drawn, and a Long's end as it is dragged. A
kind that took a different route would be a kind that snapped differently, and the author
would have no way to know which. `Place Note at Event` is the one deliberate exception and
does not come through here at all - it uses the event's measured start verbatim, which is
the whole point of that button.

When a placement lands on an anchor, the new note records that event as its
`sourceEventId`. That is exactly what the contract says the field is for - "a
human-authored back-reference ... never a claim that the note was generated from the
event" - and the author still chose the lane, the kind and whether to place anything.
Beat-snapped and unsnapped placements record nothing, because no event was consulted.
**Resizing never touches an existing note's provenance**: dragging an end to a different
sound does not change which sound the author was looking at when they created the note.

## Implementation status

Foundation and Analysis visualisation: project loading, the read-only projection, the
timeline with beat grid and four event lanes, per-layer visibility, zoom/pan, and audio
playback with a synchronised playhead.

Note placement: chart loading and creation, click to place, select, delete, beat-grid
snapping, an explicit atomic save, and a visible clean/modified state that guards against
opening another project over unsaved work.

Analysis-assisted placement: selecting an event in the overlay, a readout of what it
measured, and an explicit `Place Note at Event` that uses its exact start and records the
reference. Experimental snapping to the nearest event start.

Undo and redo over chart authoring, with Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. Space plays and
pauses; left and right seek by a zoom-relative step, five times as far with Shift, and up
and down walk the visible Analysis Events. Locate Playhead brings the view
to the playhead, and Follow keeps it there during playback until the author scrolls by
hand, at which point it turns itself off rather than fighting them.

Separate Edit and Select modes, with rubber-band multiple selection and batch delete as a
single undo step. Long authoring by dragging, Slide authoring by placing points and joining
them with `Connect`, and Flick authoring in the two directions the toolbar offers.

Editing notes after they are placed: drag to move, drag a Long's grip to change its length,
`Connect` and `Disconnect` slide points, and change how a Long or a Slide finishes. Each is
one undo step.

Flick chains: `Connect` joins selected flicks into a run drawn as a solid line, without
merging them - each flick stays its own note, editable and movable on its own, and the run
is stored as `chart.connections[]` rather than on the notes.

Guide snapping: placing a note or dragging a Long's end lands it on the Analysis Events in
the layers that are switched on, using the same event source the arrow keys walk, and a
note placed that way records the event as its `sourceEventId`.

Navigation audition: the arrow keys play a moment of the song where they land, so a chart
can be stepped through by ear as well as by eye.

A note visual language of thin bars, arrows, bodies and dotted connectors, so a moment is
read as a position on the time axis and a Slide reads as checkpoints joined by a trajectory
rather than as a diagonal Long. A flick chain's run is a solid line, so it is never read as
a slide.

Not implemented, and deliberately so: automatic event-to-note conversion, bulk conversion,
turning an event's duration into a hold, any mapping from a stem to a lane, dragging a
batch placement, a general keyboard shortcut
framework, autosave, spectrogram, pitch contours, stem soloing, density aggregation, and
Player integration.

Known limitations:

- A rubber band does not auto-scroll when dragged past the edge of the view, so one sweep
  selects within what is on screen. Zoom out first for a longer sweep, or Shift-drag to add
  a second sweep to the first.
- A slide's individual points cannot be dragged on their own. Moving a chain moves all of
  it; to move one point, `Disconnect`, move it, and `Connect` again.
- Only a Long can be resized. A slide's end is a place rather than a length.
- `Connect` refuses two chains whose times interleave rather than guessing an order.
- The inspector is read-only. `time` and `lane` are shown at full precision but cannot be
  typed into; editing is by direct manipulation in the lanes.
- `Disconnect` gives the recreated end point a new id, and drops any end action. Undo is
  what restores the original chain exactly.
- Only a flick is offered as an end action. The field is shaped for others; none exist yet.
- A flick's direction can be changed for one selected note at a time, not for a selection.
- A flick chain is a straight run: a flick has at most one connection in and one out, so a
  run never branches. Selecting a run and pressing Connect again with a flick that already
  has a neighbour on that side is refused.
- Deleting a flick out of the middle of a run leaves two runs. Nothing re-joins them; the
  author connects them again if that is what they meant.
- There is no dedicated chain-drawing gesture. A run is built by placing flicks and
  pressing Connect, the same way a slide chain is.
- Navigation audition cannot be saved with the project; it is session state and comes back
  on after a reload.
- Guide snapping cannot be saved with the project - the contract's snap object has no room
  for a third mode - so it reads back as Off after a reload.
- Guide anchors come from event starts, plus event ends when a Long's end is being dragged.
  A bounded event's end is not a candidate for placing an ordinary note.
- There is no combined mode that considers beats and guide anchors together. The two are
  exclusive so that a note is never ambiguous about which it was aligned to.

#### What is still open about slides

The chain is stored as one note, so the points other than the first do not have ids of
their own. Nothing in the Editor needs them to - selection, movement and deletion all work
on the chain - but per-point editing (dragging one waypoint, or deleting a point out of the
middle) would want a way to name a point, and the natural one is its index in `waypoints`
rather than a new id in the contract.

There is also no notion of a slide's *shape* between points: the connector is drawn
straight, and Deresute's curved slides would need something the contract does not have. If
that turns out to matter, it is another additive optional field on the waypoint, and the
same fallback applies - a reader that ignores it draws the straight line that is drawn now.

**No automatic conversion of Analysis events into Chart notes exists or is planned as a
shortcut.** The overlay is guidance; the author decides. That is the project's thesis,
not a limitation to be lifted later.
