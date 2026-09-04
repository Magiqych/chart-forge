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
    heightPx: 14,
    widthPx: 20,
    radiusPx: 3,
    borderWidth: 1.5,
    flickMarker: "#12161c",
  },

  /** Transient interaction feedback. Never part of the document. */
  preview: {
    fill: "rgba(77, 143, 240, 0.28)",
    border: "rgba(169, 201, 251, 0.75)",
    guide: "rgba(169, 201, 251, 0.45)",
    laneHighlight: "rgba(77, 143, 240, 0.10)",
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
