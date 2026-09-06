/**
 * The timeline's horizontal scrollbar.
 *
 * It has no scroll position of its own. The thumb's size and place are computed from the
 * viewport every render, and dragging it reports a new `startSec` back - so there is one
 * piece of state, not a DOM scroll offset trying to stay in step with a canvas. That is
 * also why this is a drawn thumb rather than an overflowing element: a real scrollbar
 * owns a `scrollLeft`, and keeping two authorities agreed through zooms, seeks and
 * project loads is exactly the bug this avoids.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  scrollbarGeometry, startSecForThumbLeft, MIN_SCROLL_THUMB_PX, type Viewport,
} from "../core/viewport";

export interface TimelineScrollbarProps {
  readonly view: Viewport;
  readonly durationSec: number;
  /** Reports a new left edge for the view. Scrolling is not an edit and is not undoable. */
  readonly onScrollTo: (startSec: number) => void;
}

export function TimelineScrollbar(props: TimelineScrollbarProps): React.JSX.Element {
  const { view, durationSec, onScrollTo } = props;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const dragRef = useRef<{ pointerId: number; grabOffsetPx: number } | null>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setTrackWidthPx(Math.max(0, Math.floor(entry.contentRect.width)));
    });
    observer.observe(track);
    setTrackWidthPx(Math.max(0, Math.floor(track.clientWidth)));
    return () => observer.disconnect();
  }, []);

  const geometry = scrollbarGeometry(view, durationSec, trackWidthPx, MIN_SCROLL_THUMB_PX);

  const scrollToThumbLeft = useCallback(
    (thumbLeftPx: number) => {
      onScrollTo(startSecForThumbLeft(thumbLeftPx, view, durationSec, trackWidthPx));
    },
    [onScrollTo, view, durationSec, trackWidthPx],
  );

  const handleThumbDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || !geometry.scrollable) return;
      event.preventDefault();
      event.stopPropagation();
      const x = event.clientX - track.getBoundingClientRect().left;
      // Remember where inside the thumb the pointer landed, so the thumb does not jump
      // under the hand on the first pixel of the drag.
      dragRef.current = { pointerId: event.pointerId, grabOffsetPx: x - geometry.thumbLeftPx };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [geometry.scrollable, geometry.thumbLeftPx],
  );

  const handleThumbMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || !track || drag.pointerId !== event.pointerId) return;
      const x = event.clientX - track.getBoundingClientRect().left;
      scrollToThumbLeft(x - drag.grabOffsetPx);
    },
    [scrollToThumbLeft],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  /** Clicking the track jumps so the thumb centres where it was clicked. */
  const handleTrackDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || !geometry.scrollable) return;
      const x = event.clientX - track.getBoundingClientRect().left;
      scrollToThumbLeft(x - geometry.thumbWidthPx / 2);
    },
    [geometry.scrollable, geometry.thumbWidthPx, scrollToThumbLeft],
  );

  return (
    <div
      className="timeline-scrollbar"
      ref={trackRef}
      onPointerDown={handleTrackDown}
      role="scrollbar"
      aria-orientation="horizontal"
      aria-label="Timeline position"
      aria-valuemin={0}
      aria-valuemax={Math.round(Math.max(0, durationSec))}
      aria-valuenow={Math.round(Math.max(0, view.startSec))}
    >
      <div
        className={geometry.scrollable ? "scroll-thumb" : "scroll-thumb inert"}
        style={{ left: `${geometry.thumbLeftPx}px`, width: `${geometry.thumbWidthPx}px` }}
        onPointerDown={handleThumbDown}
        onPointerMove={handleThumbMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}
