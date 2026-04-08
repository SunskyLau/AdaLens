export interface InteractiveScrollbarMetrics {
  visible: boolean;
  thumbSizePx: number;
  thumbOffsetPx: number;
  maxThumbOffsetPx: number;
  maxScrollOffsetPx: number;
}

function clampValue(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeInteractiveScrollbarMetrics(args: {
  viewportSizePx: number;
  contentSizePx: number;
  scrollOffsetPx: number;
  trackSizePx: number;
  minThumbSizePx?: number;
}): InteractiveScrollbarMetrics {
  const viewportSizePx = Math.max(0, args.viewportSizePx);
  const contentSizePx = Math.max(0, args.contentSizePx);
  const trackSizePx = Math.max(0, args.trackSizePx);
  const minThumbSizePx = Math.max(8, args.minThumbSizePx ?? 24);
  const maxScrollOffsetPx = Math.max(0, contentSizePx - viewportSizePx);

  if (trackSizePx <= 0) {
    return {
      visible: false,
      thumbSizePx: 0,
      thumbOffsetPx: 0,
      maxThumbOffsetPx: 0,
      maxScrollOffsetPx,
    };
  }

  if (maxScrollOffsetPx <= 0 || viewportSizePx <= 0 || contentSizePx <= viewportSizePx) {
    return {
      visible: false,
      thumbSizePx: trackSizePx,
      thumbOffsetPx: 0,
      maxThumbOffsetPx: 0,
      maxScrollOffsetPx,
    };
  }

  const rawThumbSizePx = (viewportSizePx / contentSizePx) * trackSizePx;
  const thumbSizePx = clampValue(rawThumbSizePx, minThumbSizePx, trackSizePx);
  const maxThumbOffsetPx = Math.max(0, trackSizePx - thumbSizePx);
  const clampedScrollOffsetPx = clampValue(args.scrollOffsetPx, 0, maxScrollOffsetPx);
  const thumbOffsetPx =
    maxThumbOffsetPx > 0
      ? (clampedScrollOffsetPx / maxScrollOffsetPx) * maxThumbOffsetPx
      : 0;

  return {
    visible: true,
    thumbSizePx,
    thumbOffsetPx,
    maxThumbOffsetPx,
    maxScrollOffsetPx,
  };
}

export function resolveScrollOffsetFromThumbOffset(args: {
  thumbOffsetPx: number;
  maxThumbOffsetPx: number;
  maxScrollOffsetPx: number;
}): number {
  const maxThumbOffsetPx = Math.max(0, args.maxThumbOffsetPx);
  const maxScrollOffsetPx = Math.max(0, args.maxScrollOffsetPx);
  if (maxThumbOffsetPx <= 0 || maxScrollOffsetPx <= 0) {
    return 0;
  }
  const clampedThumbOffsetPx = clampValue(args.thumbOffsetPx, 0, maxThumbOffsetPx);
  return (clampedThumbOffsetPx / maxThumbOffsetPx) * maxScrollOffsetPx;
}

export function resolveThumbOffsetFromTrackPointer(args: {
  pointerOffsetPx: number;
  thumbSizePx: number;
  maxThumbOffsetPx: number;
}): number {
  const maxThumbOffsetPx = Math.max(0, args.maxThumbOffsetPx);
  if (maxThumbOffsetPx <= 0) {
    return 0;
  }
  const desiredThumbOffsetPx = args.pointerOffsetPx - args.thumbSizePx / 2;
  return clampValue(desiredThumbOffsetPx, 0, maxThumbOffsetPx);
}
