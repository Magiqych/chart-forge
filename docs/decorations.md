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

## Visual effects

Three scopes, and they do not overlap:

| | Answers | Fields |
| --- | --- | --- |
| `style` | what it looks like standing still | colour or `gradient`, stroke, `glow` |
| `animation` | how it arrives and leaves | `enter`, `exit` |
| `effects` | what runs while it is shown | `shimmer`, `sparkle`, `meteor` |

`gradient` and `glow` are in `style` because they are what the text *is* — a gradient is
its colour and a glow is a property of its edge, exactly as `strokeColor` is. That a
gradient can also drift is a way of drawing a resting appearance, not a separate event.
`shimmer`, `sparkle` and `meteor` are none of those things: they run for the whole display
window, so they are neither a resting appearance nor a transition, and they got a group of
their own rather than being forced into one that already meant something else.

Every one of them is optional, and **absent means "not doing that"** — never "doing it with
defaults". A chart written before any of this behaves exactly as it did.

### Gradient

```json
"gradient": { "colors": ["#ff9aa2", "#ffd8a8", "#a8e6ff"], "angleDeg": 0, "cycleSec": 8 }
```

Deliberately a list of stops rather than a named palette: "rainbow" is not a mode the
contract has to understand, it is the colours an author chose. At least two stops are
required — fewer is not a ramp, and the contract test rejects it. `cycleSec` is how long
the ramp takes to travel one full cycle; `0`, the default, is a still gradient. It is
measured in **chart time**, so it drifts at the same musical rate however fast the
recording is being played.

### Glow

```json
"glow": { "color": "#d8f6ff", "radius": 0.02, "intensity": 0.42 }
```

`radius` is a fraction of the playfield's height, like `fontSize`. Drawn as its own pass
before the fill, so the blur never lands on the letters: the text stays exactly as crisp
as it was, and the stroke is unaffected.

### Shimmer, sparkle, meteor

```json
"effects": {
  "shimmer": { "periodSec": 3.4, "durationSec": 0.5, "intensity": 0.45 },
  "sparkle": { "ratePerSec": 2.6, "colors": ["#ffffff", "#d8f6ff"], "intensity": 0.55 },
  "meteor":  { "ratePerSec": 0.45, "direction": "downRight", "intensity": 0.4 }
}
```

A shimmer is a highlight travelling left to right across the letters. Sparkles are small
four-pointed lights appearing briefly around the text. A meteor is a thin streak crossing
the playfield behind everything, clipped to the playfield so it can enter from off the
edge.

**No individual particle is ever stored.** What a document holds is the configuration; the
particles are generated from it. That is not only a size argument — it is what keeps the
contract honest about what an author decided.

### Defaults

| Field | Default | | Field | Default |
| --- | --- | --- | --- | --- |
| `gradient.angleDeg` | `0` | | `sparkle.ratePerSec` | `3` |
| `gradient.cycleSec` | `0` (still) | | `sparkle.scale` | `1` |
| `glow.color` | `#ffffff` | | `sparkle.intensity` | `0.6` |
| `glow.radius` | `0.02` | | `meteor.ratePerSec` | `0.5` |
| `glow.intensity` | `0.5` | | `meteor.direction` | `downRight` |
| `shimmer.periodSec` | `3` | | `meteor.color` | `#dff4ff` |
| `shimmer.durationSec` | `0.45` | | `meteor.lengthScale` | `0.18` |
| `shimmer.intensity` | `0.5` | | `meteor.intensity` | `0.5` |

As everywhere else in a decoration, defaults are applied at the moment of drawing and
never written into the document.

### Deterministic by construction

Everything above is a **pure function of the decoration and a chart time**:

```ts
const state = effectStateAt(decoration, chartTimeSec);
```

There is no accumulation between frames and no `Math.random` anywhere. Each particle's
seed comes from the decoration's own `id`, and the *n*th event of a stream happens at a
time that depends on nothing but that seed and *n*. So:

- seeking to a moment shows what that moment looks like, every time — reaching 5.0 s by
  jumping, by playing forwards, or by coming back from 12 s gives the identical frame;
- a screenshot of a paused editor is reproducible;
- pausing and resuming cannot make particles jump or pile up;
- playing at a tenth speed shows the same effect a tenth as fast, not a different one;
- two decorations never share a pattern, and a copy — which gets a new id — gets its own;
- a Player written later can draw any frame from the document alone, without having
  replayed everything before it.

Time is measured from the decoration's own `startTimeSec`, so dragging a caption along the
timeline carries its pattern with it rather than re-rolling it.

### Reduced motion

When the machine asks for `prefers-reduced-motion: reduce`, everything that moves stops:
the gradient holds at phase zero, and there are no shimmers, sparkles or meteors. The
**resting appearance survives** — a gradient still colours the text and a glow still glows
— because those are what the caption is rather than something happening to it.

The chart is never touched. This is a property of the machine doing the drawing, and
turning the setting off restores the full appearance.

### Presets

The Editor offers Plain, Rainbow, Glow, Sparkle and Kirameki. A preset is a **UI
convenience and nothing else**: choosing one writes ordinary generic properties, and the
name is never stored. Kirameki, for instance, expands to a drifting pastel rainbow, a faint
glow, an occasional shimmer, sparse sparkles and the odd meteor — every one of them turned
down. The panel works out which preset is in effect by comparing the properties, and says
Custom the moment an author changes anything.

So no chart mentions a song, no Player has to know what a preset meant, and presets can be
retuned or dropped without touching a single file.

### For a future Player

A Player needs `effectStateAt` and a canvas, and nothing else — no history, no scheduler
and no state that has to be kept in step. The units are all resolution-independent
(`fontSize`, `glow.radius` and `meteor.lengthScale` are fractions of the playfield;
positions are normalized), so the same document draws correctly at any size. Anything it
does not implement it can skip: an unknown `meteor.direction` falls back to a known one,
and a decoration with no `effects` is a still caption.

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
