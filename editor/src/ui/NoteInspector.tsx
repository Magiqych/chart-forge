/**
 * What the selected Chart Note actually holds.
 *
 * A sibling of the Analysis event readout, not a merger of it: one describes something
 * measured in the recording, the other something the author wrote. Keeping them as two
 * sections, each saying which it is, is the same distinction the whole Editor rests on.
 *
 * Read-only. Times are shown at full precision because that is exactly what makes it
 * useful for checking an event-placed note against the event it came from.
 */

import { Fragment } from "react";

import {
  endFlickDirection, isStandaloneFlick, slidePoints,
  type ChartNote, type FlickDirection,
} from "../core/chart";

/**
 * Which way a standalone Flick points.
 *
 * The same two choices and the same screen convention as an end flick's - left is drawn
 * up, right is drawn down - but a different field on disk, which is why it is a different
 * control and a different command.
 */
const FLICK_DIRECTION_CHOICES: readonly {
  readonly value: FlickDirection;
  readonly label: string;
}[] = [
  { value: "left", label: "\u2191 Left" },
  { value: "right", label: "\u2193 Right" },
];

/** The three ways a note that has an end can finish. */
const END_ACTION_CHOICES: readonly {
  readonly value: FlickDirection | null;
  readonly label: string;
}[] = [
  { value: null, label: "Normal" },
  { value: "left", label: "\u2191 Flick" },
  { value: "right", label: "\u2193 Flick" },
];

/**
 * What a stored kind is called in the interface.
 *
 * A lookup with a fallback, because `chartNote.type` is an open vocabulary: a chart from
 * elsewhere may carry a word this Editor has never seen, and showing that word is better
 * than showing nothing or pretending it is something else.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  tap: "Single",
  hold: "Long",
  slide: "Slide",
  flick: "Flick",
};

function kindLabel(type: string): string {
  return KIND_LABELS[type] ?? type;
}

/**
 * What Select Mode can currently do to this note.
 *
 * Direct manipulation is only usable if it is discoverable, and a grip drawn three pixels
 * wide is not an advertisement. Saying it in words costs a line and saves a hunt.
 */
function affordances(note: ChartNote): string {
  if (isStandaloneFlick(note)) return "Drag to move. Change which way it points above.";
  if (note.endLane !== undefined) {
    return "Drag to move. Select another point and Connect to extend it, or Disconnect to split it up.";
  }
  if (note.endTimeSec !== undefined) return "Drag to move. Drag the end to change how long it is.";
  if (note.type === "slide") return "Drag to move. Select two points to Connect them.";
  return "Drag to move.";
}

export interface NoteInspectorProps {
  /** Every selected note, in selection order. */
  readonly notes: readonly ChartNote[];
  /** Deletes the whole selection through the same command the keyboard uses. */
  readonly onDelete: () => void;
  readonly canConnect: boolean;
  readonly connectHint: string;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  /** Change how the selected note finishes. `null` is an ordinary release. */
  readonly onEndAction: (direction: FlickDirection | null) => void;
  /** Turn a standalone Flick round. Separate from the end action, and a separate field. */
  readonly onFlickDirection: (direction: FlickDirection) => void;
  /** How many flicks the selected run has, or 0 when the selection is not one. */
  readonly runSize: number;
}

export function NoteInspector(props: NoteInspectorProps): React.JSX.Element {
  const {
    notes, onDelete, canConnect, connectHint, onConnect, onDisconnect, onEndAction,
    onFlickDirection, runSize,
  } = props;

  if (notes.length === 0) {
    return (
      <section className="inspector">
        <h2>Selected note</h2>
        <p className="inspector-empty">
          In Select Mode, click a note or drag a rectangle across the lanes.
        </p>
      </section>
    );
  }

  // Several notes: a count and what they are. Twenty detail panels would answer no
  // question anyone was asking, and the one thing an author does want to know before
  // pressing Delete is how much is about to go.
  // A run of flicks is one thing the author made, not a coincidental selection, so it is
  // described as what it is - and offers the one action that applies to it.
  if (runSize > 1 && notes.length === runSize) {
    return (
      <section className="inspector">
        <h2>Selected run</h2>
        <p className="inspector-count">{`${runSize} Flicks Connected`}</p>
        <p className="inspector-hint">
          Click one of them to change which way it points, or to move it.
        </p>
        <button type="button" className="inspector-action" onClick={onDisconnect}>
          Disconnect
        </button>
        <button type="button" className="inspector-delete" onClick={onDelete}>
          Delete Selected
        </button>
      </section>
    );
  }

  if (notes.length > 1) {
    const byType = new Map<string, number>();
    for (const note of notes) byType.set(note.type, (byType.get(note.type) ?? 0) + 1);

    return (
      <section className="inspector">
        <h2>Selected notes</h2>
        <p className="inspector-count">{`${notes.length} Notes Selected`}</p>
        <dl className="inspector-grid">
          {[...byType].map(([type, count]) => (
            <Fragment key={type}>
              <dt>{kindLabel(type)}</dt>
              <dd className="numeric">{count}</dd>
            </Fragment>
          ))}
        </dl>
        {notes.length === 2 && (
          <button
            type="button"
            className="inspector-action"
            onClick={onConnect}
            disabled={!canConnect}
            title={connectHint}
          >
            Connect
          </button>
        )}
        <button type="button" className="inspector-delete" onClick={onDelete}>
          Delete Selected
        </button>
      </section>
    );
  }

  const note = notes[0] as ChartNote;
  const duration =
    note.endTimeSec !== undefined && note.endTimeSec > note.timeSec
      ? note.endTimeSec - note.timeSec
      : null;

  return (
    <section className="inspector">
      <h2>Selected note</h2>
      <dl className="inspector-grid">
        <dt>Id</dt>
        <dd className="numeric inspector-id">{note.id}</dd>

        <dt>Type</dt>
        <dd>{kindLabel(note.type)}</dd>

        <dt>Lane</dt>
        <dd className="numeric">{`L${note.lane + 1}`}</dd>

        {/* Full precision on purpose: this is how an event-placed note is checked
            against the event it cites. */}
        <dt>Time</dt>
        <dd className="numeric">{note.timeSec}</dd>

        {note.endTimeSec !== undefined && (
          <>
            <dt>Ends</dt>
            <dd className="numeric">{note.endTimeSec}</dd>
          </>
        )}
        {duration !== null && (
          <>
            <dt>Duration</dt>
            <dd className="numeric">{`${duration.toFixed(3)}s`}</dd>
          </>
        )}
        {note.endLane !== undefined && (
          <>
            <dt>End lane</dt>
            <dd className="numeric">{`L${note.endLane + 1}`}</dd>
          </>
        )}
        {note.waypoints !== undefined && note.waypoints.length > 0 && (
          <>
            <dt>Points</dt>
            <dd className="numeric">{slidePoints(note).length}</dd>
          </>
        )}
        {note.direction !== undefined && (
          <>
            <dt>Direction</dt>
            <dd>{note.direction}</dd>
          </>
        )}
        {note.sourceEventId !== undefined && (
          <>
            <dt>From event</dt>
            <dd className="numeric inspector-id">{note.sourceEventId}</dd>
          </>
        )}
      </dl>

      {/* A standalone Flick's own direction. Shown only for one, and only for exactly one
          selected note - a batch turn is a reasonable thing to want later, and nothing
          here forecloses it, but guessing at it now would be guessing. */}
      {isStandaloneFlick(note) && (
        <div className="inspector-field">
          <span className="inspector-fieldlabel">Direction</span>
          <div className="segmented" role="group" aria-label="Flick direction">
            {FLICK_DIRECTION_CHOICES.map((choice) => {
              const active = note.direction === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  className={active ? "seg on" : "seg"}
                  onClick={() => onFlickDirection(choice.value)}
                  aria-pressed={active}
                  title={`Flick ${choice.value}, drawn ${choice.value === "left" ? "up" : "down"}`}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Editing a note after it exists: deciding a hold ends in a flick is a judgement
          an author makes listening back, not always one they had when they drew it. */}
      {note.endTimeSec !== undefined && (
        <div className="inspector-field">
          <span className="inspector-fieldlabel">End</span>
          <div className="segmented" role="group" aria-label="End action">
            {END_ACTION_CHOICES.map((choice) => {
              const active = endFlickDirection(note) === choice.value;
              return (
                <button
                  key={choice.label}
                  type="button"
                  className={active ? "seg on" : "seg"}
                  onClick={() => onEndAction(choice.value)}
                  aria-pressed={active}
                >
                  {choice.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* What can be done to this note right now, so the gestures are discoverable
          without having to find them by trial. */}
      <p className="inspector-hint">{affordances(note)}</p>

      {note.endLane !== undefined && (
        <button type="button" className="inspector-action" onClick={onDisconnect}>
          Disconnect
        </button>
      )}

      {/* At the foot of the readout rather than beside the values, so it is deliberate
          to reach and hard to hit while reading. Delete and Backspace do the same
          thing, and all three go through the one command, so undo covers them all. */}
      <button type="button" className="inspector-delete" onClick={onDelete}>
        Delete note
      </button>
    </section>
  );
}
