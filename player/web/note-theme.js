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
 *   | kind  | hue                   | centre mark       | band            |
 *   | tap   | rose red   ~350°      | nothing           | -               |
 *   | hold  | amber      ~35°       | a white disc      | wide, amber     |
 *   | slide | teal       ~170°      | a white bar       | narrower, teal  |
 *   | flick | violet     ~255-295°  | an arrowhead      | -               |
 *
 * - and every one of them is a pale ring around a dark outline, so the shape reads
 * against a bright decoration as well as against the night sky.
 *
 * The four hues are spaced so that no two neighbours are closer than about 45° of hue, and
 * none of them sits in the pale blue the stage furniture is drawn in - the tap targets, the
 * lane edges and the stars are all around 215°, and a note that shared that hue would be
 * competing with the floor it lands on. The bands carry their note's hue for the same
 * reason: a long note and a slide have to be tellable apart from the shape of the band
 * alone, before either of their heads is close enough to read.
 *
 * ## Left and right flicks
 *
 * A flick is violet, and its two sides are two violets: `flickLeft` is a warm, red-leaning
 * orchid and `flickRight` a cool, blue-leaning indigo. Hue alone would not be enough - 40°
 * of violet is not much to judge at speed, and it is exactly the difference a red-green
 * colour vision difference flattens - so three more things carry it:
 *
 *   - **lightness**: left is the light one, right the deep one, a gap of roughly 19 L*, so
 *     the two are still different in a greyscale photograph of the screen;
 *   - **arrow polarity**: the left note's arrowhead is dark plum on a light body and the
 *     right note's is white on a deep one, which is the largest, fastest-read difference on
 *     the note and needs no colour at all;
 *   - **rim and glow**: a pink-white rim over a magenta glow against a blue-white rim over
 *     a periwinkle one, which is what carries the difference in peripheral vision where the
 *     arrowhead is too small to resolve.
 *
 * A flick with no sideways component - `up`, `down`, or no direction at all - keeps the
 * neutral `flick` violet between the two, because there is no side for it to take.
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
    interior: ["#c8fff4", "#22dfc0", "#00a891"],
    ring: "#ffffff",
    outline: "rgba(0, 46, 42, 0.88)",
    glow: "rgba(38, 226, 196, 0.58)",
    mark: "bar",
    markColour: "rgba(255, 255, 255, 0.94)",
  }),
  /**
   * A flick with no side to take: `up`, `down`, or no direction at all.
   *
   * Mid violet, between the two sides, so an undirected flick still reads as a flick and
   * still cannot be mistaken for one that asks for a particular way.
   */
  flick: Object.freeze({
    interior: ["#eddcff", "#c084fc", "#8228e0"],
    ring: "#ffffff",
    outline: "rgba(40, 4, 74, 0.88)",
    glow: "rgba(184, 122, 255, 0.62)",
    mark: "arrow",
    markColour: "#ffffff",
  }),
  /** Leftward: the warm, light violet, with a dark arrowhead on it. */
  flickLeft: Object.freeze({
    interior: ["#ffe4ff", "#f58cff", "#b31fd6"],
    ring: "#ffeaff",
    outline: "rgba(64, 2, 74, 0.9)",
    glow: "rgba(244, 128, 255, 0.68)",
    mark: "arrow",
    markColour: "rgba(61, 2, 80, 0.95)",
  }),
  /** Rightward: the cool, deep violet, with a white arrowhead on it. */
  flickRight: Object.freeze({
    interior: ["#d9d0ff", "#8f6cff", "#5b25d6"],
    ring: "#e4e8ff",
    outline: "rgba(12, 4, 72, 0.9)",
    glow: "rgba(138, 116, 255, 0.68)",
    mark: "arrow",
    markColour: "#ffffff",
  }),
  /**
   * An unknown note type.
   *
   * Grey and unmarked, and still drawn: the contract calls `type` an open vocabulary, so a
   * word this Player has not met is a note it must still show rather than hide. The start
   * screen names it; the playfield draws it. Deliberately the one style with no hue at all,
   * so it cannot be read as any of the kinds above.
   */
  other: Object.freeze({
    interior: ["#eaedf2", "#b8bfca", "#7f8794"],
    ring: "#ffffff",
    outline: "rgba(20, 24, 32, 0.88)",
    glow: "rgba(198, 205, 218, 0.45)",
    mark: "none",
    markColour: "#ffffff",
  }),
});

/**
 * Which of the two flick styles a swipe direction is drawn in.
 *
 * Every direction with a sideways component takes that side, including the diagonals: a
 * player swiping `upLeft` is moving their hand left, and the note should look like the other
 * notes that ask for that. `up` and `down` are absent on purpose - they have no side, so
 * they fall through to the neutral `flick`.
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
 * A hold is a wide amber band; a slide is a narrower teal one. Each carries the hue of the
 * heads it joins, and that is the point: a band is visible from further away than a head is
 * legible, so it is the first thing a player can read about what is coming, and it should
 * say the same thing the heads will. It matters because the two are played completely
 * differently - one hand still, one hand travelling - and a band that said nothing about
 * which it was would waste the only early warning the playfield has.
 *
 * They were both near-white before, which looked calm and told the player nothing.
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
    fill: ["rgba(96, 236, 214, 0.2)", "rgba(128, 242, 222, 0.38)"],
    fillActive: ["rgba(140, 248, 228, 0.34)", "rgba(180, 252, 238, 0.6)"],
    fade: "rgba(96, 236, 214, 0)",
    core: "rgba(206, 255, 246, 0.24)",
    coreActive: "rgba(228, 255, 250, 0.44)",
    edge: "rgba(52, 230, 200, 0.58)",
    edgeActive: "rgba(168, 250, 232, 0.92)",
    widthFactor: SIZES.slideRibbon,
  }),
});

/**
 * The thin line the chart draws between notes swiped through in one motion.
 *
 * Pale lavender: it joins flicks, so it belongs to the violet family, but it is desaturated
 * and light rather than a third violet, because it has to read as the path between two notes
 * and not as a note itself.
 */
export const CONNECTION = Object.freeze({
  stroke: "rgba(206, 190, 255, 0.55)",
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
