/**
 * What the selected Analysis Event actually says.
 *
 * Small on purpose. This is a readout of a measurement the author is consulting, not a
 * form: nothing here can be edited, and it sits with the other analysis information in
 * the sidebar rather than beside the authoring controls.
 *
 * No confidence is shown, because Analysis 0.2 emits none - the detectors' raw scores
 * are incommensurate and uncalibrated, so any number here would be an invented
 * certainty. Nothing reads `metadata.experimental` either; the projection drops it.
 */

import type { AnalysisProjection, ProjectedEvent } from "../core/analysis";

export interface EventInspectorProps {
  readonly event: ProjectedEvent | null;
  readonly projection: AnalysisProjection | null;
}

export function EventInspector(props: EventInspectorProps): React.JSX.Element {
  const { event, projection } = props;

  if (!event) {
    return (
      <section className="inspector">
        <h2>Selected event</h2>
        <p className="inspector-empty">Click an event in the overlay.</p>
      </section>
    );
  }

  const detector = projection?.detectors.find((d) => d.id === event.detectorId);
  const detectorLabel = detector
    ? `${detector.name}${detector.version ? ` ${detector.version}` : ""}`
    : event.detectorId || "-";

  const duration =
    event.endKind === "bounded" && event.endSec !== undefined
      ? event.endSec - event.startSec
      : null;

  return (
    <section className="inspector">
      <h2>Selected event</h2>
      <dl className="inspector-grid">
        <dt>Branch</dt>
        <dd>{event.lane ?? "unassigned"}</dd>

        <dt>Stem</dt>
        <dd>{event.stemId || "-"}</dd>

        <dt>Type</dt>
        <dd>{event.type || "-"}</dd>

        <dt>End</dt>
        <dd>{event.endKind}</dd>

        <dt>Start</dt>
        <dd className="numeric">{event.startSec.toFixed(3)}s</dd>

        {/* Only a bounded event has a measured end; the others are shown as having none
            rather than being given one that was never observed. */}
        {event.endSec !== undefined && (
          <>
            <dt>Ends</dt>
            <dd className="numeric">{event.endSec.toFixed(3)}s</dd>
          </>
        )}
        {duration !== null && (
          <>
            <dt>Duration</dt>
            <dd className="numeric">{duration.toFixed(3)}s</dd>
          </>
        )}

        {event.pitch && (
          <>
            <dt>Pitch</dt>
            <dd className="numeric">
              {event.pitch.name} · {event.pitch.midi.toFixed(1)} · {event.pitch.hz.toFixed(1)} Hz
            </dd>
          </>
        )}

        <dt>Detector</dt>
        <dd>{detectorLabel}</dd>

        <dt>Id</dt>
        <dd className="numeric inspector-id">{event.id}</dd>
      </dl>
    </section>
  );
}
