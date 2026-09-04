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
