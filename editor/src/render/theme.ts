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

  event: {
    tickWidth: 2,
    tickInsetPx: 8,
    spanHeightPx: 5,
    spanRadiusPx: 2,
    minSpanWidthPx: 2,
  },

  playhead: "#f05b5b",
  playheadWidth: 1.5,

  label: {
    text: "#6f7c8c",
    font: "10px ui-monospace, SFMono-Regular, Consolas, monospace",
  },
} as const;

export type LaneColourKey = keyof typeof theme.lanes;
