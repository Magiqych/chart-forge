/**
 * What the playfield looks like. Every colour, radius, width and glow, in one file.
 *
 * The renderer decides *where* things go and the theme decides *what they look like*, and
 * the reason to keep them apart is that tuning is the slow part of this work: moving a
 * note's hue or making a ribbon a shade wider should be one line in one file, not a hunt
 * through a drawing routine for a hard-coded `"#4fb8ff"`.
 *
 * ## Reading a note in a tenth of a second
 *
 * Everything below serves one requirement: a player falling towards a note has no time to
 * study it. So the four kinds are told apart three times over -
 *
 *   | kind  | hue                  | centre mark      | band             |
 *   | tap   | rose red   ~350°     | nothing          | -                |
 *   | hold  | amber      ~39°      | a white disc     | wide, amber      |
 *   | slide | violet     ~274°     | a white bar      | narrower, violet |
 *   | flick | green      ~97-174°  | an arrowhead     | -                |
 *
 * - and every one of them is a pale ring around a dark outline, so the shape reads
 * against a bright decoration as well as against the night sky.
 *
 * The four hues are spaced so that no two are closer than about 45° of hue, and none of
 * them sits in the pale blue the stage furniture is drawn in - the tap targets, the lane
 * edges and the stars are all around 215°, and a note that shared that hue would be
 * competing with the floor it lands on. The bands carry their note's hue for the same
 * reason: a long note and a slide have to be tellable apart from the shape of the band
 * alone, before either of their heads is close enough to read.
 *
 * ## Left and right flicks
 *
 * A flick is green, and its two sides are two greens: `flickLeft` a light chartreuse and
 * `flickRight` a deep teal. The family is green because violet belongs to the slide and the
 * pale blues belong to the stage, which leaves the greens as the one wide band of hue a flick
 * can have to itself.
 *
 * Hue alone would not be enough to separate the two sides - it is the first thing a colour
 * vision difference flattens - so three more things carry it:
 *
 *   - **lightness**: left is the light one, right the deep one, a gap of about 31 L*, so the
 *     two are still different in a greyscale photograph of the screen;
 *   - **arrow polarity**: the arrowhead is dark on the light body and white on the deep one,
 *     which is the largest, fastest-read difference on the note and needs no colour at all;
 *   - **rim and glow**: a yellow-white rim over a lime glow against a mint-white rim over an
 *     aqua one, which is what carries in peripheral vision, where the arrowhead is too small
 *     to resolve.
 *
 * ## Which flicks those two cover
 *
 * The Chart contract's `direction` enumerates all eight compass points, and the Editor
 * authors two of them: `left` and `right`. So those two are the flicks a player actually
 * meets, and they are the only flicks with a colour of their own. Every other direction the
 * contract allows is still read, judged and drawn with its own arrow - a diagonal takes the
 * side it leans towards - and `up`, `down` and a flick with no direction fall back to the
 * plain `flick` green, which is the kind's own colour and not a fourth identity. Nothing here
 * adds a note kind the contract does not have.
 *
 * Nothing here is traced from, sampled out of, or derived from any existing game's art.
 * These are circles, gradients and strokes written as numbers; the reference was a written
 * description of what a note has to communicate, and that is all a note is: a coloured
 * disc that says which of four things to do with your hand.
 */

/** The sizes that everything else is measured against, as fractions of `tapRadius`. */
export const SIZES = Object.freeze({
  /** A note at the tap line, relative to the tap target it lands on. */
  note: 0.92,
  /** A slide waypoint: smaller, because it is a place to pass through, not to strike. */
  waypoint: 0.6,
  /** Rim thickness, as a fraction of the note's radius. */
  ringWidth: 0.26,
  /** Dark outline thickness, as a fraction of the note's radius. */
  outlineWidth: 0.1,
  /** Glow radius under a note, as a fraction of its radius. */
  glow: 0.9,
  /** Ribbon widths, as a fraction of a lane's width at the tap line. */
  holdRibbon: 0.46,
  slideRibbon: 0.3,
});

/** The sky and the lanes: everything the notes are seen against. */
export const STAGE = Object.freeze({
  skyTop: "#060912",
  skyBottom: "#111730",
  star: "#cfe2ff",
  laneFill: "rgba(150, 180, 255, 0.016)",
  laneFillAlt: "rgba(150, 180, 255, 0.005)",
  laneEdge: "rgba(170, 200, 255, 0.26)",
  laneEdgeFar: "rgba(170, 200, 255, 0.02)",
  lanePress: "rgba(150, 205, 255, 0.22)",
});

/**
 * The five tap targets, and the line that threads them.
 *
 * Deliberately neutral. In the game this is modelled on there is a portrait inside each
 * circle; here there is nothing, because a Player whose job is to show a chart should not
 * be putting anything behind the notes that competes with them - and because the artwork
 * that would go there is not ours to use. A white ring, a darker inner ring and a dark
 * translucent middle read on a bright background and on a dark one, which is the whole
 * requirement.
 */
export const TAP_AREA = Object.freeze({
  /** The horizontal line joining the five centres. */
  link: "rgba(226, 236, 252, 0.5)",
  linkWidthFactor: 0.07,
  linkGlow: "rgba(150, 200, 255, 0.35)",

  outerRing: "rgba(244, 249, 255, 0.92)",
  outerRingWidthFactor: 0.13,
  innerRing: "rgba(150, 176, 214, 0.65)",
  innerRingWidthFactor: 0.08,
  innerRingFactor: 0.74,
  centre: "rgba(10, 16, 34, 0.55)",
  centreHighlight: "rgba(190, 215, 255, 0.10)",
  glow: "rgba(140, 195, 255, 0.45)",
  glowFactor: 0.55,

  /** How the target answers a press. */
  pressFill: "rgba(170, 220, 255, 0.30)",
  pressRing: "rgba(235, 248, 255, 0.95)",
});

/**
 * The four gameplay kinds, the two sides a flick can take, and the fallback for a `type`
 * this Player has never seen.
 *
 * `interior` is a radial ramp from the lit top-left of the disc to its shaded bottom, and
 * `outline` is the thin dark edge that keeps the pale ring from dissolving into a pale
 * background. `glow` is what the note casts onto the sky behind it. `ring` is the rim, which
 * is white on every kind except the two flick sides, where it is tinted - it is the largest
 * area on a distant note and therefore the last thing to stay readable as one shrinks.
 */
export const NOTE_STYLES = Object.freeze({
  tap: Object.freeze({
    interior: ["#ffd3dc", "#ff5470", "#e0114a"],
    ring: "#ffffff",
    outline: "rgba(74, 2, 22, 0.88)",
    glow: "rgba(255, 74, 108, 0.62)",
    mark: "none",
    markColour: "#ffffff",
  }),
  hold: Object.freeze({
    interior: ["#fff0c4", "#ffbc3d", "#e07a00"],
    ring: "#ffffff",
    outline: "rgba(78, 40, 0, 0.88)",
    glow: "rgba(255, 176, 48, 0.6)",
    mark: "disc",
    markColour: "rgba(255, 255, 255, 0.94)",
  }),
  slide: Object.freeze({
    interior: ["#f3deff", "#c983ff", "#a626f0"],
    ring: "#ffffff",
    outline: "rgba(48, 2, 82, 0.88)",
    glow: "rgba(198, 128, 255, 0.62)",
    mark: "bar",
    markColour: "rgba(255, 255, 255, 0.94)",
  }),
  /**
   * A flick, in the kind's own colour.
   *
   * What the word "flick" looks like when no side has been named: `up`, `down`, or a flick the
   * chart gave no direction at all. It is a fallback rather than a fourth kind, and it is also
   * the colour that stands for Flick wherever the four kinds are compared.
   */
  flick: Object.freeze({
    interior: ["#dcffd4", "#58d455", "#1e6e1c"],
    ring: "#ffffff",
    outline: "rgba(4, 40, 8, 0.88)",
    glow: "rgba(96, 224, 96, 0.62)",
    mark: "arrow",
    markColour: "rgba(8, 44, 16, 0.95)",
  }),
  /** Leftward: the light chartreuse, with a dark arrowhead on it. */
  flickLeft: Object.freeze({
    interior: ["#e4ffcc", "#7fee3c", "#3c8a00"],
    ring: "#f4ffe4",
    outline: "rgba(26, 54, 0, 0.9)",
    glow: "rgba(150, 240, 70, 0.66)",
    mark: "arrow",
    markColour: "rgba(22, 50, 0, 0.95)",
  }),
  /** Rightward: the deep teal, with a white arrowhead on it. */
  flickRight: Object.freeze({
    interior: ["#a8efe4", "#0b9184", "#006b60"],
    ring: "#e2fffa",
    outline: "rgba(0, 38, 34, 0.9)",
    glow: "rgba(20, 214, 194, 0.68)",
    mark: "arrow",
    markColour: "#ffffff",
  }),
});

/**
 * Which of the two flick styles a swipe direction is drawn in.
 *
 * `left` and `right` are the two the Editor authors and the two a player meets. The diagonals
 * are in here because the contract allows them and its own example chart uses one: a player
 * swiping `upLeft` is moving their hand left, so the note should look like the other notes
 * that ask for that. `up` and `down` are absent on purpose - they have no side, so they fall
 * through to the plain `flick`, and so does a flick with no direction at all.
 */
export const FLICK_VARIANTS = Object.freeze({
  left: "flickLeft",
  upLeft: "flickLeft",
  downLeft: "flickLeft",
  right: "flickRight",
  upRight: "flickRight",
  downRight: "flickRight",
});

/**
 * The bands that join the two ends of a long note or the points of a slide.
 *
 * A hold is a wide amber band; a slide is a narrower violet one. Each carries the hue of the
 * heads it joins, and that is the point: a band is visible from further away than a head is
 * legible, so it is the first thing a player can read about what is coming, and it should
 * say the same thing the heads will. It matters because the two are played completely
 * differently - one hand still, one hand travelling - and a band that said nothing about
 * which it was would waste the only early warning the playfield has.
 *
 * `widthFactor` is the width the kind has when it stays in its lane. A note that travels
 * across lanes is drawn at the narrower width whatever its kind, which is a separate question
 * from colour and is answered in `drawNoteRibbon`.
 */
export const RIBBONS = Object.freeze({
  hold: Object.freeze({
    /** Far end, near end, and the fully transparent form the far cut fades into. */
    fill: ["rgba(255, 228, 170, 0.2)", "rgba(255, 214, 130, 0.36)"],
    fillActive: ["rgba(255, 240, 200, 0.34)", "rgba(255, 226, 150, 0.6)"],
    fade: "rgba(255, 228, 170, 0)",
    core: "rgba(255, 242, 212, 0.26)",
    coreActive: "rgba(255, 250, 232, 0.46)",
    edge: "rgba(255, 194, 88, 0.55)",
    edgeActive: "rgba(255, 224, 150, 0.9)",
    widthFactor: SIZES.holdRibbon,
  }),
  slide: Object.freeze({
    fill: ["rgba(178, 122, 255, 0.2)", "rgba(198, 150, 255, 0.38)"],
    fillActive: ["rgba(212, 168, 255, 0.34)", "rgba(228, 196, 255, 0.6)"],
    fade: "rgba(178, 122, 255, 0)",
    core: "rgba(238, 220, 255, 0.24)",
    coreActive: "rgba(248, 238, 255, 0.44)",
    edge: "rgba(190, 120, 255, 0.58)",
    edgeActive: "rgba(220, 168, 255, 0.92)",
    widthFactor: SIZES.slideRibbon,
  }),
});

/**
 * The thin line the chart draws between notes swiped through in one motion.
 *
 * Pale green: it joins flicks, so it belongs to their family, but it is desaturated and light
 * rather than a third green, because it has to read as the path between two notes and not as a
 * note itself.
 */
export const CONNECTION = Object.freeze({
  stroke: "rgba(206, 248, 196, 0.55)",
  widthFactor: 0.1,
});

/** Judgement feedback: the ring that opens at the tap target, and the word above it. */
export const FEEDBACK = Object.freeze({
  perfect: "#ffe98a",
  great: "#7fe7a6",
  good: "#7fc4ff",
  miss: "#ff7c7c",
});

/** The debug overlay, which is off unless the page was opened with `?debug=1`. */
export const DEBUG = Object.freeze({
  text: "rgba(190, 220, 255, 0.9)",
  trajectory: "rgba(120, 255, 190, 0.5)",
  spawnLine: "rgba(255, 120, 200, 0.6)",
  tapLine: "rgba(120, 220, 255, 0.75)",
  laneCentre: "rgba(255, 255, 255, 0.2)",
});
