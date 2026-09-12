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
 *   | kind  | hue            | centre mark        |
 *   | tap   | red / coral    | nothing            |
 *   | hold  | amber / orange | a white disc       |
 *   | slide | violet         | a white bar        |
 *   | flick | blue           | a white arrowhead  |
 *
 * - and every one of them is a white ring around a dark outline, so the shape reads
 * against a bright decoration as well as against the night sky.
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
  /** White ring thickness, as a fraction of the note's radius. */
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
 * The four gameplay kinds, plus the fallback for a `type` this Player has never seen.
 *
 * `interior` is a radial ramp from the lit top-left of the disc to its shaded bottom, and
 * `outline` is the thin dark edge that keeps the white ring from dissolving into a pale
 * background. `glow` is what the note casts onto the sky behind it.
 */
export const NOTE_STYLES = Object.freeze({
  tap: Object.freeze({
    interior: ["#ffc3ce", "#ff6f86", "#e11d48"],
    ring: "#ffffff",
    outline: "rgba(88, 6, 26, 0.85)",
    glow: "rgba(255, 96, 130, 0.55)",
    mark: "none",
    markColour: "#ffffff",
  }),
  hold: Object.freeze({
    interior: ["#ffeec2", "#ffc65c", "#f08a10"],
    ring: "#ffffff",
    outline: "rgba(94, 48, 0, 0.85)",
    glow: "rgba(255, 183, 70, 0.55)",
    mark: "disc",
    markColour: "rgba(255, 255, 255, 0.92)",
  }),
  slide: Object.freeze({
    interior: ["#eccdff", "#bb7bf0", "#8b30d4"],
    ring: "#ffffff",
    outline: "rgba(52, 8, 84, 0.85)",
    glow: "rgba(186, 120, 255, 0.55)",
    mark: "bar",
    markColour: "rgba(255, 255, 255, 0.94)",
  }),
  flick: Object.freeze({
    interior: ["#c9e6ff", "#63aef4", "#1766cf"],
    ring: "#ffffff",
    outline: "rgba(3, 34, 72, 0.85)",
    glow: "rgba(90, 172, 255, 0.6)",
    mark: "arrow",
    markColour: "#ffffff",
  }),
  /**
   * An unknown note type.
   *
   * Grey and unmarked, and still drawn: the contract calls `type` an open vocabulary, so a
   * word this Player has not met is a note it must still show rather than hide. The start
   * screen names it; the playfield draws it.
   */
  other: Object.freeze({
    interior: ["#e8eefb", "#b7c3d8", "#7f8da6"],
    ring: "#ffffff",
    outline: "rgba(20, 28, 44, 0.85)",
    glow: "rgba(190, 205, 230, 0.45)",
    mark: "none",
    markColour: "#ffffff",
  }),
});

/**
 * The bands that join the two ends of a long note or the points of a slide.
 *
 * A hold is a wide, pale, almost white band; a slide is a narrower violet one with a lit
 * edge. That is the second thing that tells them apart at a glance, after the colour of
 * their heads, and it matters because the two are played completely differently - one
 * hand still, one hand travelling.
 */
export const RIBBONS = Object.freeze({
  hold: Object.freeze({
    /** Far end, near end, and the fully transparent form the far cut fades into. */
    fill: ["rgba(255, 250, 238, 0.16)", "rgba(255, 246, 226, 0.3)"],
    fillActive: ["rgba(255, 252, 244, 0.3)", "rgba(255, 250, 235, 0.55)"],
    fade: "rgba(255, 250, 238, 0)",
    core: "rgba(255, 252, 240, 0.22)",
    coreActive: "rgba(255, 255, 250, 0.42)",
    edge: "rgba(255, 226, 168, 0.45)",
    edgeActive: "rgba(255, 244, 205, 0.85)",
    widthFactor: SIZES.holdRibbon,
  }),
  slide: Object.freeze({
    fill: ["rgba(196, 142, 248, 0.18)", "rgba(206, 158, 250, 0.34)"],
    fillActive: ["rgba(214, 168, 255, 0.32)", "rgba(226, 190, 255, 0.58)"],
    fade: "rgba(196, 142, 248, 0)",
    core: "rgba(238, 218, 255, 0.2)",
    coreActive: "rgba(248, 236, 255, 0.4)",
    edge: "rgba(206, 150, 255, 0.5)",
    edgeActive: "rgba(240, 214, 255, 0.9)",
    widthFactor: SIZES.slideRibbon,
  }),
});

/** The thin line the chart draws between notes swiped through in one motion. */
export const CONNECTION = Object.freeze({
  stroke: "rgba(150, 205, 255, 0.55)",
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
