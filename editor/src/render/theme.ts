/**
 * Colours and weights for the timeline.
 *
 * The beat grid and the event lanes must not be told apart by hue alone: the grid is a
 * thin full-height rule behind everything, events are thicker marks and spans inside
 * their own row. Colour reinforces that, it does not carry it.
 */

export const theme = {
  background: "#12161c",
  rowAlt: "#161b23",
  rowBorder: "#232b36",

  ruler: {
    text: "#8b98a8",
    tick: "#39424f",
    font: "11px ui-monospace, SFMono-Regular, Consolas, monospace",
  },

  /** Structure: behind everything, never selectable. */
  grid: {
    beat: "#2c3542",
    beatWidth: 1,
    downbeat: "#4a5b70",
    downbeatWidth: 2,
  },

  waveform: "#33506b",
  waveformCentre: "#243545",

  /** Observations: in front of the grid, inside their row. */
  lanes: {
    drums: "#e0a33c",
    other: "#7f8fa6",
    bass: "#4fb3a5",
    vocals: "#d0708a",
  },

  /**
   * Only the stroke weight lives here. Where an event sits and how large it is are in
   * core/eventGeometry.ts, because the hit test needs the same numbers and two copies
   * would eventually disagree - which shows up as a click selecting the wrong event.
   */
  event: {
    tickWidth: 2,
  },

  /**
   * Authored objects: in front of the observations, in the notes row.
   *
   * A Chart Note must never be mistaken for an Analysis Event, so it is a different
   * shape and a different size before it is a different colour: a solid rounded block
   * with a border, sitting in a lane band, against the events' hairline ticks and thin
   * spans. The blue is a hue no stem lane uses, which reinforces the distinction rather
   * than carrying it.
   */
  note: {
    fill: "#4d8ff0",
    border: "#a9c9fb",
    selectedFill: "#f2f6ff",
    selectedBorder: "#ffffff",
    /**
     * Fill per authored kind.
     *
     * Colour is what separates one instantaneous kind from another; the shape stays a
     * bar for all of them, so the visual language does not fragment. A kind that is not
     * listed - and the vocabulary is open, so there will be some - falls back to `fill`.
     */
    byType: {
      tap: "#4d8ff0",
      flick: "#4d8ff0",
    } as Readonly<Record<string, string>>,
    borderByType: {
    } as Readonly<Record<string, string>>,

    /** A held note's body is lighter than its caps, so the ends read as ends. */
    boundedBody: "#3f7ad4",
    boundedCap: "#cfe0fb",
    /** The lane-change connector of a slide. */
    connector: "#7fb0f5",
    radiusPx: 3,
    borderWidth: 1.5,
    flickMarker: "#0d1218",
    flickArrowPx: 9,
    /** Halo behind a selected note, so it is findable among its neighbours. */
    selectedHalo: "rgba(255, 255, 255, 0.22)",
    selectedHaloPx: 3,

    /**
     * The slide trajectory: a translucent ribbon with a brighter line down it.
     *
     * Deliberately unlike the held body's fill. A Long is time under the finger; a slide
     * connector is a path between two instants, and the two must not be mistaken for one
     * another at a glance.
     */
    connectorRibbon: "rgba(120, 200, 236, 0.22)",
    connectorRibbonPx: 9,
    connectorLinePx: 2,
    /** Dotted, so a slide's route can never be mistaken for a Long's held body. */
    connectorDash: [2, 5] as readonly number[],

    /**
     * A run of flicks: a thin **solid** line, deliberately unlike the slide's dotted one.
     *
     * The two say different things. A slide's dots are a path a finger follows between
     * checkpoints of one note; a run's line joins separate notes that are swiped through
     * in one motion. Solid against dotted tells them apart at a glance without either
     * needing a label, and thin keeps the timeline readable rather than imitating the
     * game's thick ribbon.
     */
    runConnector: "#7fd6a8",
    runConnectorSelected: "#ffffff",
    runConnectorPx: 1.5,

    /** How much wider a marker gets when selected. It stays a bar, it does not become a box. */
    selectedMarkerGrowPx: 2,

    /** The grip at the end of a Long: quiet until the note is selected. */
    resizeHandle: "rgba(169, 201, 251, 0.30)",
    resizeHandleOn: "#ffffff",
  },

  /** The rubber band. Transient, like the preview: it selects, it never edits. */
  marquee: {
    fill: "rgba(127, 176, 245, 0.14)",
    border: "rgba(169, 201, 251, 0.85)",
  },

  /** Transient interaction feedback. Never part of the document. */
  preview: {
    fill: "rgba(77, 143, 240, 0.28)",
    border: "rgba(169, 201, 251, 0.75)",
    guide: "rgba(169, 201, 251, 0.45)",
    laneHighlight: "rgba(77, 143, 240, 0.10)",
  },

  /**
   * The line drawn while a dragged note is lined up with something.
   *
   * Warm and bright, where everything it has to be told apart from is cool: the beat grid
   * is a dim blue-grey, the placement guide and the rubber band are pale blue. The author
   * needs to see at a glance that the note has been *taken* by something rather than that
   * a grid line happens to be there, and hue does that faster than weight.
   *
   * Dashed for the same reason, and because a solid bright line at full height reads as
   * structure - something the document contains - when this is the opposite: it exists
   * only while the pointer is down and is never written anywhere.
   */
  /**
   * The decorations, on the timeline and on the stage.
   *
   * A muted violet, deliberately unlike any note colour and unlike every analysis lane:
   * a glance at the timeline has to say "this is presentation, not gameplay" before it
   * says anything else.
   */
  decoration: {
    fill: "rgba(146, 118, 200, 0.28)",
    border: "rgba(166, 138, 220, 0.75)",
    selectedFill: "rgba(186, 158, 240, 0.45)",
    selectedBorder: "#d8c8ff",
    handle: "#ffffff",
    label: "#cdbcea",
    selectedLabel: "#ffffff",
    /** The "this one has effects" mark on a timeline bar. */
    effectMark: "#ffe9a8",
    labelFont: "11px ui-sans-serif, system-ui, sans-serif",
    /** The stage: the playfield the decorations are positioned on. */
    stageBackground: "#0d1018",
    stageBorder: "#2a3142",
    stageGuide: "rgba(120, 132, 160, 0.35)",
    stageJudgement: "rgba(190, 120, 140, 0.55)",
    stageSelection: "#d8c8ff",
    stageHint: "#6b7488",
  },
  snapGuide: {
    stroke: "rgba(255, 199, 89, 0.98)",
    width: 2,
    dash: [6, 4] as readonly number[],
    /**
     * A soft wash laid down under the dashes.
     *
     * The dashes alone are the precise statement of where the note went; between them
     * there is nothing, and against a busy analysis overlay that is easy to miss at a
     * glance. A few pixels of faint colour behind them makes the line register in
     * peripheral vision - the author is looking at the note, not hunting for the guide -
     * without blurring which column of pixels it actually names.
     */
    glow: "rgba(255, 199, 89, 0.16)",
    glowWidth: 7,
  },

  noteLaneBorder: "#202834",
  noteLaneLabel: "#7f8c9e",

  /**
   * The Analysis Event the author is consulting.
   *
   * Must not read as a selected Chart Note. A note is a filled block that gets brighter
   * and gains a heavy white border when selected; a selected event keeps its lane colour
   * and its own thin shape, and is called out by a bracket drawn around it plus a
   * caret above - marks in the space around the event rather than a restyling of it,
   * because the event itself is a measurement and should look the same either way.
   */
  selectedEvent: {
    marker: "#ffffff",
    halo: "rgba(255, 255, 255, 0.14)",
    bracketWidth: 1.5,
    bracketPadPx: 4,
    caretHalfWidthPx: 4,
    caretHeightPx: 5,
  },

  playhead: "#f05b5b",
  playheadWidth: 1.5,

  label: {
    text: "#6f7c8c",
    font: "10px ui-monospace, SFMono-Regular, Consolas, monospace",
  },
} as const;

export type LaneColourKey = keyof typeof theme.lanes;
