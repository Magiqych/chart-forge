/**
 * Timeline coordinate maths and range queries.
 *
 * Everything here is a pure function of numbers so it can be tested without a canvas,
 * a DOM or a browser. The renderer stays thin precisely because this file is not.
 */

export interface Viewport {
  /** Time at the left edge of the drawing area, in seconds. */
  readonly startSec: number;
  /** Zoom: how many pixels one second occupies. */
  readonly pixelsPerSecond: number;
  /** Width of the drawing area in CSS pixels. */
  readonly widthPx: number;
}

export const MIN_PIXELS_PER_SECOND = 5;
export const MAX_PIXELS_PER_SECOND = 2000;

export function timeToX(timeSec: number, view: Viewport): number {
  return (timeSec - view.startSec) * view.pixelsPerSecond;
}

export function xToTime(x: number, view: Viewport): number {
  return view.startSec + x / view.pixelsPerSecond;
}

/** Seconds currently on screen. */
export function viewportDurationSec(view: Viewport): number {
  return view.widthPx / view.pixelsPerSecond;
}

export function viewportEndSec(view: Viewport): number {
  return view.startSec + viewportDurationSec(view);
}

export function clampZoom(pixelsPerSecond: number): number {
  return Math.min(MAX_PIXELS_PER_SECOND, Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecond));
}

/**
 * Keep the time under the cursor fixed while zooming.
 *
 * Without this, zooming walks the content out from under the pointer and the timeline
 * feels broken at high zoom, which is exactly where an author works.
 */
export function zoomAtAnchor(
  view: Viewport,
  nextPixelsPerSecond: number,
  anchorX: number,
): Viewport {
  const clamped = clampZoom(nextPixelsPerSecond);
  const anchorTime = xToTime(anchorX, view);
  return {
    ...view,
    pixelsPerSecond: clamped,
    startSec: anchorTime - anchorX / clamped,
  };
}

/** Keep the view inside the track, allowing the last screen to reach the end. */
export function clampViewportStart(startSec: number, view: Viewport, durationSec: number): number {
  const span = viewportDurationSec(view);
  const maxStart = Math.max(0, durationSec - span);
  return Math.min(maxStart, Math.max(0, startSec));
}

export function panBySeconds(view: Viewport, deltaSec: number, durationSec: number): Viewport {
  return { ...view, startSec: clampViewportStart(view.startSec + deltaSec, view, durationSec) };
}

/** Zoom level at which the whole track fits the width. */
export function fitToWidth(durationSec: number, widthPx: number): number {
  if (durationSec <= 0) return MIN_PIXELS_PER_SECOND;
  return clampZoom(widthPx / durationSec);
}

/**
 * First index whose `startSec` is >= `timeSec`, by binary search.
 *
 * The events array is sorted by (startSec, id) - the Analysis contract guarantees it -
 * so a real document's 2258 events never have to be scanned per frame.
 */
export function lowerBoundByStart<T extends { startSec: number }>(
  items: readonly T[],
  timeSec: number,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((items[mid] as T).startSec < timeSec) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The slice of events that can touch [fromSec, toSec].
 *
 * A bounded event can start before the window and still be visible inside it, so the
 * search starts `maxEventDurationSec` early. That value comes from the data rather than
 * a guess: the caller measures it once when the projection is built.
 */
export function visibleRange<T extends { startSec: number }>(
  items: readonly T[],
  fromSec: number,
  toSec: number,
  maxEventDurationSec = 0,
): { readonly from: number; readonly to: number } {
  const from = lowerBoundByStart(items, fromSec - maxEventDurationSec);
  const to = lowerBoundByStart(items, toSec);
  return { from, to };
}

export function visibleSlice<T extends { startSec: number }>(
  items: readonly T[],
  fromSec: number,
  toSec: number,
  maxEventDurationSec = 0,
): readonly T[] {
  const { from, to } = visibleRange(items, fromSec, toSec, maxEventDurationSec);
  return items.slice(from, to);
}

/** Longest bounded event, used to widen the range query correctly. */
export function maxBoundedDuration(
  items: readonly { startSec: number; endSec?: number }[],
): number {
  let longest = 0;
  for (const item of items) {
    if (item.endSec !== undefined) {
      const span = item.endSec - item.startSec;
      if (span > longest) longest = span;
    }
  }
  return longest;
}

/**
 * Geometry of the horizontal scrollbar.
 *
 * Derived from the viewport every time it is needed, never stored. A scrollbar that kept
 * its own position would be a second copy of `startSec`, and the two would disagree the
 * moment anything else moved the view - a zoom, a pan, a seek, loading a project. There
 * is one piece of state, and this function is a view of it.
 */
export interface ScrollbarGeometry {
  /** Left edge of the thumb within the track, in CSS pixels. */
  readonly thumbLeftPx: number;
  readonly thumbWidthPx: number;
  readonly trackWidthPx: number;
  /** False when the whole track already fits on screen and there is nowhere to scroll. */
  readonly scrollable: boolean;
}

/**
 * Smallest thumb we will draw.
 *
 * A three-minute song at high zoom would otherwise produce a thumb a fraction of a pixel
 * wide - accurate, and impossible to grab.
 */
export const MIN_SCROLL_THUMB_PX = 28;

/** Total seconds the scrollbar spans: the track, or the screen when that is longer. */
export function scrollableSpanSec(view: Viewport, durationSec: number): number {
  return Math.max(durationSec, viewportDurationSec(view));
}

/** The largest `startSec` that still shows content, i.e. the end of the scroll range. */
export function maxScrollStartSec(view: Viewport, durationSec: number): number {
  return Math.max(0, scrollableSpanSec(view, durationSec) - viewportDurationSec(view));
}

export function scrollbarGeometry(
  view: Viewport,
  durationSec: number,
  trackWidthPx: number,
  minThumbPx: number = MIN_SCROLL_THUMB_PX,
): ScrollbarGeometry {
  const track = Math.max(0, trackWidthPx);
  const span = scrollableSpanSec(view, durationSec);
  const visible = viewportDurationSec(view);

  if (track === 0 || span <= 0) {
    return { thumbLeftPx: 0, thumbWidthPx: track, trackWidthPx: track, scrollable: false };
  }

  const proportional = track * (visible / span);
  const thumbWidthPx = Math.min(track, Math.max(Math.min(minThumbPx, track), proportional));

  const maxStart = maxScrollStartSec(view, durationSec);
  const travel = track - thumbWidthPx;
  const fraction = maxStart > 0 ? Math.min(1, Math.max(0, view.startSec / maxStart)) : 0;

  return {
    thumbLeftPx: travel * fraction,
    thumbWidthPx,
    trackWidthPx: track,
    scrollable: maxStart > 0 && travel > 0,
  };
}

/**
 * The `startSec` that would put the thumb's left edge at `thumbLeftPx`.
 *
 * The exact inverse of `scrollbarGeometry`, so dragging the thumb and reading its
 * position back give the same number rather than drifting a pixel per drag.
 */
export function startSecForThumbLeft(
  thumbLeftPx: number,
  view: Viewport,
  durationSec: number,
  trackWidthPx: number,
  minThumbPx: number = MIN_SCROLL_THUMB_PX,
): number {
  const geometry = scrollbarGeometry(view, durationSec, trackWidthPx, minThumbPx);
  const travel = geometry.trackWidthPx - geometry.thumbWidthPx;
  const maxStart = maxScrollStartSec(view, durationSec);
  if (travel <= 0 || maxStart <= 0) return 0;

  const fraction = Math.min(1, Math.max(0, thumbLeftPx / travel));
  return fraction * maxStart;
}

/**
 * Where the view should start for a time to sit in the middle of it.
 *
 * The Locate Playhead action. Clamped like every other way of moving the view, so
 * locating a playhead near either end of the song scrolls as far as it can and no
 * further rather than leaving blank space on screen.
 */
export function centreOnTime(view: Viewport, timeSec: number, durationSec: number): number {
  return clampViewportStart(timeSec - viewportDurationSec(view) / 2, view, durationSec);
}

/**
 * The safety zone: fractions of the width a followed playhead is allowed to sit between.
 *
 * While it is inside this band nothing moves and the playhead itself travels across the
 * screen, which is what makes the timeline readable. Only when it reaches the edge of the
 * band does the view step.
 */
export const FOLLOW_LOW_FRACTION = 0.2;
export const FOLLOW_HIGH_FRACTION = 0.78;
/**
 * Where the playhead is put when the view has to be moved.
 *
 * Deliberately near the low edge of the band rather than in the middle: landing it at
 * 30% gives it most of the width to travel before the next step, so playback scrolls in
 * occasional readable jumps instead of creeping continuously under the eye.
 */
export const FOLLOW_LEAD_FRACTION = 0.3;

/**
 * Where the view should start to keep a playing playhead on screen, or null to leave it.
 *
 * Deliberately a step rather than a slide: while the playhead sits in the comfortable
 * band the view does not move at all, and when it leaves the band the view jumps once so
 * the playhead lands well inside it. Nudging every frame would make the whole timeline
 * creep under the eye, which is far harder to read than an occasional jump.
 *
 * Returns a start time, not a viewport: there is exactly one viewport, and the caller
 * writes this into it. Nothing here keeps a scroll position of its own.
 */
export function followStartSec(
  view: Viewport,
  playheadSec: number,
  durationSec: number,
): number | null {
  const span = viewportDurationSec(view);
  if (span <= 0) return null;

  const offset = playheadSec - view.startSec;
  if (offset >= span * FOLLOW_LOW_FRACTION && offset <= span * FOLLOW_HIGH_FRACTION) {
    return null;
  }

  const wanted = clampViewportStart(
    playheadSec - span * FOLLOW_LEAD_FRACTION,
    view,
    durationSec,
  );
  return wanted === view.startSec ? null : wanted;
}

/**
 * Where the view should start after a zoom, or null to leave it where the zoom put it.
 *
 * The one rule, in one place, so the wheel and the zoom slider cannot drift apart. With
 * Follow on it is Follow's answer, because Follow has already promised the author where
 * the playhead will sit and a zoom must not overrule that. With Follow off the view only
 * moves when the playhead has actually left the screen.
 */
export function startSecAfterZoom(
  view: Viewport,
  playheadSec: number,
  durationSec: number,
  following: boolean,
): number | null {
  return following
    ? followStartSec(view, playheadSec, durationSec)
    : revealStartSec(view, playheadSec, durationSec);
}

/** Whether a time is on screen at all. */
export function isTimeVisible(view: Viewport, timeSec: number): boolean {
  return timeSec >= view.startSec && timeSec <= viewportEndSec(view);
}

/**
 * Where the view should start so a time is on screen, or null to leave it alone.
 *
 * Used after a zoom. Zooming keeps the time under the cursor fixed, which is right, but
 * it can carry the playhead off the edge - and a playhead you cannot see is a playhead
 * you have lost. When it is still visible the view does not move at all: jumping the
 * timeline on every zoom would be far more disruptive than the occasional recentre.
 *
 * When it has gone, the playhead is brought back to the middle rather than to the edge
 * it left by, because an edge is where it is about to disappear from again.
 */
export function revealStartSec(
  view: Viewport,
  timeSec: number,
  durationSec: number,
): number | null {
  if (isTimeVisible(view, timeSec)) return null;
  const wanted = centreOnTime(view, timeSec, durationSec);
  return wanted === view.startSec ? null : wanted;
}
