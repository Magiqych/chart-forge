# Decorations

Presentation an author puts **over** the playfield: the words that appear on screen
during a chart, and — later — other kinds of thing. Text Decoration 0.1 is the first and
currently only kind.

## A Decoration is not a Note

This is the distinction the whole design rests on, and it is the same kind of distinction
as the one between an Analysis Event and a Chart Note.

| | Note | Decoration |
| --- | --- | --- |
| Lives in | `chart.notes[]` | `chart.decorations[]` |
| Has a lane | yes | no — it has a position on the playfield |
| Is judged | yes | never |
| Affects the score | yes | never |
| Removing it | changes what the chart asks of the player | changes only what they see |
| Id prefix | `n-0001` | `dec-0001` |

A `{"type": "textNote"}` in `notes[]` would have put an object with no lane and no
judgement into the list of things that have both, and every function that reads a note —
the hit scheduler, the lane geometry, the connection rules, the Player — would have had to
learn to skip it. A separate array costs one optional field in the contract and nothing
else: a Player that ignores `decorations` plays exactly the same chart.

Decorations are also independent of each other and of the notes. None of them names a
note, so deleting a note can never invalidate one, and `chart.connections[]` is untouched
by anything here.

## The document

`decorations` is an optional top-level array, in ascending `startTimeSec` order — the same
streaming guarantee `notes` gives. It is exactly as additive as `connections` was, so the
chart format stays at **0.1.0**: an older reader that ignores the array sees the chart it
always saw, and nothing is written when there is nothing to say.

```json
{
  "id": "dec-0001",
  "type": "text",
  "startTimeSec": 58.42,
  "endTimeSec": 60.1,
  "text": "キラメキ☆",
  "position": { "x": 0.5, "y": 0.45 },
  "style": {
    "fontFamily": "sans-serif",
    "fontSize": 0.12,
    "fontWeight": 700,
    "align": "center",
    "rotationDeg": 0,
    "opacity": 1,
    "color": "#ffffff",
    "strokeColor": "#000000",
    "strokeWidth": 0.008
  },
  "animation": {
    "enter": "scale",
    "enterDurationSec": 0.12,
    "exit": "fade",
    "exitDurationSec": 0.2
  },
  "zIndex": 20
}
```

Only `id`, `type`, `startTimeSec` and `position` are required, plus `text` for a `text`
decoration. This is the smallest valid one:

```json
{
  "id": "dec-0002",
  "type": "text",
  "startTimeSec": 32.125,
  "text": "READY",
  "position": { "x": 0.5, "y": 0.4 }
}
```

`type` is an open vocabulary, exactly like `chartNote.type`. A reader that meets a kind it
does not know should skip it and play the chart — which it can always do, because no
decoration affects gameplay. The Editor keeps such a decoration, lists it and writes it
back untouched, the same way it treats a note kind it has never heard of.

## Normalized position

`position.x` and `position.y` run from 0 to 1 across the **playfield**, not the screen:

```
x = 0.0  left edge          y = 0.0  far edge of the playfield
x = 0.5  centre             y = 0.5  halfway
x = 1.0  right edge         y = 1.0  the judgement line
```

Deliberately not pixels. A chart is authored once and drawn at whatever size a player's
screen happens to be, so a pixel would name a different place on every device and an
author who lined a caption up with the centre lane would find it somewhere else on a
phone. `style.fontSize` and `style.strokeWidth` are fractions of the playfield's height
for the same reason.

A position outside 0..1 cannot be expressed, so the Editor clamps — per axis, so dragging
a caption off the right edge slides it along that edge rather than stopping the gesture.

## When a decoration is shown

```
startTimeSec <= currentTime <= endTimeSec
```

Both ends inclusive. `endTimeSec` is **optional**: a decoration without one is shown for a
default duration, currently **1.0 s**, which lets an author drop a caption in without
deciding how long it lingers.

That default belongs to the reader and is never written back. Loading

```json
{ "startTimeSec": 10, "text": "HEY!" }
```

and saving must not produce `"endTimeSec": 11` — a value the author never chose would then
be indistinguishable from one they did, and this Editor's taste would be frozen into their
file. Dragging the decoration's end grip *does* record one, because that is the author
asking for it.

## Style defaults

Every `style` field is optional and every one has a documented default, so a decoration
that says nothing about style still draws:

| Field | Default |
| --- | --- |
| `fontFamily` | `sans-serif` |
| `fontSize` | `0.06` |
| `fontWeight` | `400` |
| `align` | `center` |
| `rotationDeg` | `0` |
| `opacity` | `1` |
| `color` | `#ffffff` |
| `strokeColor` | `#000000` |
| `strokeWidth` | `0` (no outline) |

The defaults are applied at the moment of drawing and never materialised into the
document. Clearing a field in the inspector removes it rather than writing the default
back, so a chart stays a record of what its author actually chose.

**Fonts are logical families only** — `sans-serif`, `serif`, `monospace`. No font file is
ever embedded or named: a chart has to draw the same words on a machine that has never
heard of the author's fonts, and all three carry Japanese everywhere the Editor runs.

## Animation

`none`, `fade` and `scale`, for the entrance and the exit independently, each with its own
duration. `none` with a zero duration is the default, which is an instant appearance and
disappearance.

The vocabulary is closed, unlike `type`: a reader that meets an effect it does not
implement draws the decoration **without** that effect rather than not drawing it at all.
Adding `slideUp` and its siblings later is an additive enum change with that documented
fallback already in place. They are not here because each needs a decision about what it
slides relative to — the playfield, the text's own size, or a fixed distance — and that is
worth making with real charts in hand.

If the two durations together exceed the display window, both are scaled down by the same
factor so they meet exactly in the middle and their proportion survives.

## Painting order

`zIndex` orders decorations **against each other and nothing else**. Higher is drawn
later, over lower; ties fall back to document order, so the result never depends on the
order the list happened to be built in.

It says nothing about notes. In the Editor the two are not even on the same surface - the
notes live on the timeline, the decorations are drawn on the stage - so a `zIndex` of 1000
does not put a caption "in front of" a note here. What a Player does with the two layers
is the Player's business; the contract only fixes the order among decorations.

## Editing: two surfaces

A decoration has two independent coordinates, and the Editor's timeline can only express
one of them. Its axes are time and lane; a decoration has time and a position, and a
position is not a lane. So the two are edited on two surfaces:

- **the timeline row** answers *when*, and is dragged in time — with the same magnet as
  everything else, snapping to beats, note edges, other decorations' edges and Analysis
  Events, through the one shared candidate list;
- **the stage**, above the timeline, answers *where on the playfield*, shows the playhead's
  instant with the real font, colour, rotation and animation, and is dragged in space.

Neither gesture can change the other's coordinates, which is the whole answer to "I wanted
to move the caption sideways and its timing changed".

## Not in 0.1

Deliberately absent, and each will arrive with real requirements rather than an empty
definition waiting for them: keyframes, image / shape / effect decorations, embedded or
custom fonts, attachment to a note or a lane, screen-space anchoring, rich text,
per-character animation, 3D transforms, and an easing editor.

A future `image` decoration will need fields of its own, so the contract will gain them
additively then — the shared shape here carries only what every decoration has.
