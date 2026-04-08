import { clamp, type StorylineColumnTrack, type StorylineNodeGeometry } from './storylineGraphLayout';

const TRACK_INLINE_LABEL_MIN_SCALE = 0.01;
const TRACK_INLINE_LABEL_FONT_SIZE_PX = 11;
const TRACK_INLINE_LABEL_PADDING_X_PX = 7;
const TRACK_INLINE_LABEL_MIN_WORLD_MARGIN_PX = 4;
const TRACK_INLINE_LABEL_OVERLAP_GAP_PX = 4;
const TRACK_INLINE_LABEL_FALLBACK_LINE_GAP_PX = 6;
const TRACK_LABEL_ROUTEBOX_CLEARANCE_PX = 2;
const TRACK_INLINE_LABEL_MIN_FONT_SIZE_PX = 6.2;
const TRACK_INLINE_LABEL_VERTICAL_PADDING_MIN_PX = 2;
const TRACK_INLINE_LABEL_VERTICAL_PADDING_MAX_PX = 4.4;
export const CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER = 1.08;

interface HorizontalSpan {
  startX: number;
  endX: number;
  y: number;
  slotIndex?: number;
  source: 'slot' | 'extension';
}

export interface TrackLabelViewTransform {
  zoomX: number;
  tx: number;
  ty?: number;
}

export interface StorylineTrackLabelSizing {
  labelScale?: number;
  maskHeightPx?: number;
}

export interface StorylineTrackLabelTypography {
  fontSize: number;
  paddingX: number;
  maskHeight: number;
}

export interface TrackLabelViewportBounds {
  width: number;
  height: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export type StorylineTrackLabelPlacement = 'embedded' | 'floating';

export interface StorylineTrackLabel {
  id: string;
  column: string;
  pointCount: number;
  slotIndex?: number;
  placement: StorylineTrackLabelPlacement;
  x: number;
  y: number;
  top: number;
  width: number;
  height: number;
  maskHeight: number;
  fontSize: number;
  paddingX: number;
  anchorX: number;
  anchorY: number;
  connector?: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface CandidateLabel {
  id: string;
  column: string;
  pointCount: number;
  slotIndex?: number;
  placement: StorylineTrackLabelPlacement;
  width: number;
  height: number;
  maskHeight: number;
  fontSize: number;
  paddingX: number;
  left: number;
  top: number;
  lineY: number;
  anchorX: number;
  anchorY: number;
  lockedCenterX?: number | null;
  suppressConnector?: boolean;
  mustStayAboveAnchor?: boolean;
  mustStayBelowAnchor?: boolean;
  anchorClearancePx?: number;
  score: number;
}

function collectTrackHorizontalSpans(track: StorylineColumnTrack): HorizontalSpan[] {
  const spans: HorizontalSpan[] = [];
  for (const segment of track.segments) {
    if (
      segment.kind !== 'slot_horizontal' &&
      segment.kind !== 'extension_solid' &&
      segment.kind !== 'extension_dashed'
    ) {
      continue;
    }
    spans.push({
      startX: Math.min(segment.startX, segment.endX),
      endX: Math.max(segment.startX, segment.endX),
      y: segment.startY,
      slotIndex: segment.slotIndex,
      source: segment.kind === 'slot_horizontal' ? 'slot' : 'extension',
    });
  }
  return spans
    .filter((span) => span.endX - span.startX > 0.8)
    .sort((a, b) => {
      if (a.startX !== b.startX) return a.startX - b.startX;
      return a.y - b.y;
    });
}

function clipSpanToViewport(
  span: HorizontalSpan,
  worldLeft: number,
  worldRight: number,
  worldTop: number,
  worldBottom: number
): HorizontalSpan | null {
  if (span.y < worldTop || span.y > worldBottom) return null;
  const startX = Math.max(span.startX, worldLeft);
  const endX = Math.min(span.endX, worldRight);
  if (endX - startX <= 0.8) return null;
  return { startX, endX, y: span.y, slotIndex: span.slotIndex, source: span.source };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function buildVisibleIntervalsOnSpan(
  span: HorizontalSpan,
  nodes: StorylineNodeGeometry[],
  clearance = TRACK_LABEL_ROUTEBOX_CLEARANCE_PX
): Array<{ startX: number; endX: number }> {
  const blockers: Array<{ left: number; right: number }> = [];
  for (const node of nodes) {
    const top = node.y - node.height / 2 - clearance;
    const bottom = node.y + node.height / 2 + clearance;
    if (span.y < top || span.y > bottom) continue;
    const left = Math.max(span.startX, node.x - node.width / 2 - clearance);
    const right = Math.min(span.endX, node.x + node.width / 2 + clearance);
    if (right - left <= 0.4) continue;
    blockers.push({ left, right });
  }
  blockers.sort((a, b) => a.left - b.left);

  const visible: Array<{ startX: number; endX: number }> = [];
  let cursor = span.startX;
  for (const blocker of blockers) {
    if (blocker.right <= cursor) continue;
    if (blocker.left > cursor) {
      visible.push({ startX: cursor, endX: blocker.left });
    }
    cursor = Math.max(cursor, blocker.right);
    if (cursor >= span.endX) break;
  }
  if (cursor < span.endX) {
    visible.push({ startX: cursor, endX: span.endX });
  }
  return visible.filter((interval) => interval.endX - interval.startX > 0.8);
}

function overlapsNodeWorld(args: {
  left: number;
  right: number;
  top: number;
  bottom: number;
  nodes: StorylineNodeGeometry[];
  clearance: number;
}): boolean {
  const { left, right, top, bottom, nodes, clearance } = args;
  const box: LabelBox = { left, right, top, bottom };
  return nodes.some((node) => {
    const nodeBox: LabelBox = {
      left: node.x - node.width / 2 - clearance,
      right: node.x + node.width / 2 + clearance,
      top: node.y - node.height / 2 - clearance,
      bottom: node.y + node.height / 2 + clearance,
    };
    return overlaps(box, nodeBox);
  });
}

function pickFallbackAnchor(
  track: StorylineColumnTrack,
  spans: HorizontalSpan[],
  worldLeft: number,
  worldRight: number,
  worldTop: number,
  worldBottom: number
): { x: number; y: number; slotIndex?: number } {
  if (spans.length > 0) {
    const center = (worldLeft + worldRight) / 2;
    const bestSpan = [...spans].sort((a, b) => {
      const aCenter = (a.startX + a.endX) / 2;
      const bCenter = (b.startX + b.endX) / 2;
      return Math.abs(aCenter - center) - Math.abs(bCenter - center);
    })[0];
    return {
      x: (bestSpan.startX + bestSpan.endX) / 2,
      y: bestSpan.y,
      slotIndex: bestSpan.slotIndex,
    };
  }

  const inViewAnchors = track.anchors.filter(
    (anchor) =>
      anchor.x >= worldLeft &&
      anchor.x <= worldRight &&
      anchor.y >= worldTop &&
      anchor.y <= worldBottom
  );
  if (inViewAnchors.length > 0) {
    const center = (worldLeft + worldRight) / 2;
    const best = [...inViewAnchors].sort((a, b) => Math.abs(a.x - center) - Math.abs(b.x - center))[0];
    return { x: best.x, y: best.y };
  }
  if (track.anchors.length > 0) {
    const anchor = track.anchors[0];
    return { x: anchor.x, y: anchor.y };
  }

  return { x: (worldLeft + worldRight) / 2, y: (worldTop + worldBottom) / 2 };
}

export function computeTrackLabelTypography(args: {
  zoomX: number;
  labelScale?: number;
  maskHeightPx?: number;
  fontSizePx?: number;
}): StorylineTrackLabelTypography {
  const zoomTightening = clamp(Math.pow(Math.max(1e-6, args.zoomX), 0.22), 0.58, 1);
  const labelScale = clamp((args.labelScale ?? 1) * zoomTightening, 0.16, 1.4);
  const defaultFontSize = TRACK_INLINE_LABEL_FONT_SIZE_PX * labelScale;
  const requestedFontSize = args.fontSizePx ?? defaultFontSize;
  const explicitMaskHeight = args.maskHeightPx ?? null;
  const fontSizeCapByMask = explicitMaskHeight == null
    ? Number.POSITIVE_INFINITY
    : Math.max(TRACK_INLINE_LABEL_MIN_FONT_SIZE_PX, (explicitMaskHeight - 2) / 1.15);
  const fontSize = Math.max(
    TRACK_INLINE_LABEL_MIN_FONT_SIZE_PX,
    Math.min(requestedFontSize, fontSizeCapByMask)
  );
  const paddingScale = fontSize / TRACK_INLINE_LABEL_FONT_SIZE_PX;
  const paddingX = Math.max(1, TRACK_INLINE_LABEL_PADDING_X_PX * paddingScale);
  const textVerticalPadding = clamp(
    fontSize * 0.2 + 1.2,
    TRACK_INLINE_LABEL_VERTICAL_PADDING_MIN_PX,
    TRACK_INLINE_LABEL_VERTICAL_PADDING_MAX_PX
  );
  const textTightMaskHeight = Math.max(8, Math.ceil(fontSize + textVerticalPadding * 2));
  const maskHeight = explicitMaskHeight == null
    ? textTightMaskHeight
    : Math.max(textTightMaskHeight, explicitMaskHeight);
  return {
    fontSize,
    paddingX,
    maskHeight,
  };
}

export function buildVisibleTrackLabels(
  tracks: StorylineColumnTrack[],
  nodes: StorylineNodeGeometry[],
  view: TrackLabelViewTransform,
  viewport: TrackLabelViewportBounds,
  sizing: StorylineTrackLabelSizing = {}
): StorylineTrackLabel[] {
  const zoomX = Math.max(1e-6, view.zoomX);
  const ty = view.ty ?? 0;
  if (zoomX < TRACK_INLINE_LABEL_MIN_SCALE) return [];

  const zoomTightening = clamp(Math.pow(zoomX, 0.22), 0.58, 1);
  const labelScale = clamp((sizing.labelScale ?? 1) * zoomTightening, 0.16, 1.4);
  const labelOverlapGap = TRACK_INLINE_LABEL_OVERLAP_GAP_PX * labelScale;

  const plotLeft = viewport.left ?? 0;
  const plotRight = viewport.right ?? viewport.width;
  const plotTop = viewport.top ?? 0;
  const plotBottom = viewport.bottom ?? viewport.height;
  const plotWorldLeft = plotLeft - view.tx;
  const plotWorldRight = plotRight - view.tx;
  const plotWorldTop = plotTop - ty;
  const plotWorldBottom = plotBottom - ty;
  const worldCenterX = (plotWorldLeft + plotWorldRight) / 2;

  const candidates: CandidateLabel[] = tracks.map((track) => {
    const typography = computeTrackLabelTypography({
      zoomX,
      labelScale: sizing.labelScale,
      maskHeightPx: track.indicatorMaskHeightPx ?? sizing.maskHeightPx,
      fontSizePx: track.indicatorFontSizePx,
    });
    const labelText = track.indicatorLabelText ?? `${track.column} (${track.pointCount})`;
    const lockedCenterWorldX =
      track.indicatorLockToCenter && typeof track.indicatorCenterX === 'number'
        ? track.indicatorCenterX
        : null;
    const suppressConnector = track.indicatorSuppressConnector ?? false;
    const mustStayAboveAnchor = track.indicatorMustStayAboveAnchor ?? false;
    const mustStayBelowAnchor = track.indicatorMustStayBelowAnchor ?? false;
    const anchorClearancePx = Math.max(
      0,
      track.indicatorAnchorClearancePx ?? TRACK_INLINE_LABEL_FALLBACK_LINE_GAP_PX
    );
    const width = Math.max(
      6,
      Math.round(labelText.length * (typography.fontSize * 0.54) + typography.paddingX * 2)
    );
    const labelWorldPadding =
      TRACK_INLINE_LABEL_MIN_WORLD_MARGIN_PX * clamp(Math.pow(zoomX, 0.35), 0.18, 1);
    const spans = collectTrackHorizontalSpans(track);
    let bestEmbedded: CandidateLabel | null = null;
    let bestAnchor: { x: number; y: number; slotIndex?: number; score: number } | null = null;

    for (const span of spans) {
      const clipped = clipSpanToViewport(span, plotWorldLeft, plotWorldRight, plotWorldTop, plotWorldBottom);
      if (!clipped) continue;
      const visibleIntervals = buildVisibleIntervalsOnSpan(clipped, nodes);
      const clippedCenterX = lockedCenterWorldX == null
        ? (clipped.startX + clipped.endX) / 2
        : clamp(lockedCenterWorldX, clipped.startX, clipped.endX);

      if (visibleIntervals.length === 0) {
        const score = (clipped.endX - clipped.startX) * 500 - Math.abs(clippedCenterX - worldCenterX);
        if (!bestAnchor || score > bestAnchor.score) {
          bestAnchor = { x: clippedCenterX, y: clipped.y, slotIndex: clipped.slotIndex, score };
        }
        continue;
      }

      for (const interval of visibleIntervals) {
        const intervalSpan = interval.endX - interval.startX;
        const intervalCenterX = lockedCenterWorldX == null
          ? (interval.startX + interval.endX) / 2
          : clamp(lockedCenterWorldX, interval.startX, interval.endX);
        const anchorScore = intervalSpan * 700 + (span.source === 'slot' ? 320 : 80) - Math.abs(intervalCenterX - worldCenterX);
        if (!bestAnchor || anchorScore > bestAnchor.score) {
          bestAnchor = { x: intervalCenterX, y: clipped.y, slotIndex: clipped.slotIndex, score: anchorScore };
        }

        if (mustStayAboveAnchor || mustStayBelowAnchor) {
          continue;
        }

        const availableWidth = intervalSpan - labelWorldPadding * 2;
        if (availableWidth < width) continue;

        const leftLimit = interval.startX + labelWorldPadding;
        const rightLimit = interval.endX - labelWorldPadding - width;
        if (rightLimit < leftLimit) continue;
        const leftWorld = lockedCenterWorldX == null
          ? clamp(intervalCenterX - width / 2, leftLimit, rightLimit)
          : lockedCenterWorldX - width / 2;
        if (lockedCenterWorldX != null && (leftWorld < leftLimit || leftWorld > rightLimit)) {
          continue;
        }
        const topWorld = clipped.y - typography.maskHeight / 2;

        if (
          overlapsNodeWorld({
            left: leftWorld,
            right: leftWorld + width,
            top: topWorld,
            bottom: topWorld + typography.maskHeight,
            nodes,
            clearance: TRACK_LABEL_ROUTEBOX_CLEARANCE_PX,
          })
        ) {
          continue;
        }

        const score = intervalSpan * 900 + (span.source === 'slot' ? 2200 : 300) - Math.abs(intervalCenterX - worldCenterX);
        if (!bestEmbedded || score > bestEmbedded.score) {
          bestEmbedded = {
            id: track.id,
            column: track.column,
            pointCount: track.pointCount,
            slotIndex: clipped.slotIndex,
            placement: 'embedded',
            width,
            height: typography.maskHeight,
            maskHeight: typography.maskHeight,
            fontSize: typography.fontSize,
            paddingX: typography.paddingX,
            left: leftWorld,
            top: topWorld,
            lineY: clipped.y,
            anchorX: intervalCenterX,
            anchorY: clipped.y,
            lockedCenterX: lockedCenterWorldX,
            suppressConnector,
            mustStayAboveAnchor,
            score,
          };
        }
      }
    }

    if (bestEmbedded) return bestEmbedded;

    const fallbackAnchor = bestAnchor
      ? { x: bestAnchor.x, y: bestAnchor.y, slotIndex: bestAnchor.slotIndex }
      : pickFallbackAnchor(track, spans, plotWorldLeft, plotWorldRight, plotWorldTop, plotWorldBottom);

    const anchorWorldX = clamp(fallbackAnchor.x, plotWorldLeft + 2, Math.max(plotWorldLeft + 2, plotWorldRight - 2));
    const anchorWorldY = clamp(fallbackAnchor.y, plotWorldTop + 2, Math.max(plotWorldTop + 2, plotWorldBottom - 2));
    const preferredLeft = lockedCenterWorldX == null
      ? clamp(anchorWorldX - width / 2, plotWorldLeft + 2, Math.max(plotWorldLeft + 2, plotWorldRight - width - 2))
      : clamp(lockedCenterWorldX - width / 2, plotWorldLeft + 2, Math.max(plotWorldLeft + 2, plotWorldRight - width - 2));
    const preferredTop = mustStayBelowAnchor
      ? clamp(
        anchorWorldY + anchorClearancePx,
        plotWorldTop + 2,
        Math.max(plotWorldTop + 2, plotWorldBottom - typography.maskHeight - 2)
      )
      : clamp(
        anchorWorldY - typography.maskHeight - TRACK_INLINE_LABEL_FALLBACK_LINE_GAP_PX,
        plotWorldTop + 2,
        Math.max(plotWorldTop + 2, plotWorldBottom - typography.maskHeight - 2)
      );
    return {
      id: track.id,
      column: track.column,
      pointCount: track.pointCount,
      slotIndex: fallbackAnchor.slotIndex,
      placement: 'floating',
      width,
      height: typography.maskHeight,
      maskHeight: typography.maskHeight,
      fontSize: typography.fontSize,
      paddingX: typography.paddingX,
      left: preferredLeft,
      top: preferredTop,
      lineY: anchorWorldY,
      anchorX: lockedCenterWorldX ?? anchorWorldX,
      anchorY: anchorWorldY,
      lockedCenterX: lockedCenterWorldX,
      suppressConnector,
      mustStayAboveAnchor,
      mustStayBelowAnchor,
      anchorClearancePx,
      score: -Math.abs(anchorWorldX - (plotWorldLeft + plotWorldRight) / 2),
    };
  });

  const nodeWorldBoxes = nodes.map((node) => ({
    left: node.x - node.width / 2 - TRACK_LABEL_ROUTEBOX_CLEARANCE_PX,
    right: node.x + node.width / 2 + TRACK_LABEL_ROUTEBOX_CLEARANCE_PX,
    top: node.y - node.height / 2 - TRACK_LABEL_ROUTEBOX_CLEARANCE_PX,
    bottom: node.y + node.height / 2 + TRACK_LABEL_ROUTEBOX_CLEARANCE_PX,
  }));
  const accepted: StorylineTrackLabel[] = [];
  const acceptedBoxes: LabelBox[] = [];

  const tryPlace = (candidate: CandidateLabel, left: number, top: number): StorylineTrackLabel | null => {
    const right = left + candidate.width;
    const bottom = top + candidate.height;
    if (
      top < plotWorldTop + 2 ||
      bottom > plotWorldBottom - 2 ||
      left < plotWorldLeft + 2 ||
      right > plotWorldRight - 2
    ) {
      return null;
    }

    const bounds: LabelBox = { left, right, top, bottom };
    if (nodeWorldBoxes.some((nodeBox) => overlaps(bounds, nodeBox))) {
      return null;
    }

    const withGap: LabelBox = {
      left: left - labelOverlapGap,
      right: right + labelOverlapGap,
      top: top - labelOverlapGap,
      bottom: bottom + labelOverlapGap,
    };
    if (acceptedBoxes.some((acceptedBox) => overlaps(withGap, acceptedBox))) {
      return null;
    }

    const connector =
      candidate.placement === 'floating' && !candidate.suppressConnector
        ? {
            fromX: candidate.anchorX,
            fromY: candidate.anchorY,
            toX: clamp(candidate.anchorX, left + 3, right - 3),
            toY: clamp(
              candidate.anchorY >= bottom ? bottom : top,
              plotWorldTop + 2,
              Math.max(plotWorldTop + 2, plotWorldBottom - 2)
            ),
          }
        : null;

    return {
      id: candidate.id,
      column: candidate.column,
      pointCount: candidate.pointCount,
      slotIndex: candidate.slotIndex,
      placement: candidate.placement,
      x: left,
      y: candidate.lineY,
      top,
      width: candidate.width,
      height: candidate.height,
      maskHeight: candidate.maskHeight,
      fontSize: candidate.fontSize,
      paddingX: candidate.paddingX,
      anchorX: candidate.anchorX,
      anchorY: candidate.anchorY,
      connector,
    };
  };

  const computeFloatingTopLowerBound = (candidate: CandidateLabel): number => (
    candidate.mustStayBelowAnchor
      ? Math.min(
        Math.max(plotWorldTop + 2, candidate.anchorY + (candidate.anchorClearancePx ?? 0)),
        Math.max(plotWorldTop + 2, plotWorldBottom - candidate.height - 2)
      )
      : plotWorldTop + 2
  );

  const computeFloatingTopUpperBound = (candidate: CandidateLabel): number => (
    candidate.mustStayAboveAnchor
      ? Math.max(
        plotWorldTop + 2,
        Math.min(
          plotWorldBottom - candidate.height - 2,
          candidate.anchorY - candidate.height - TRACK_INLINE_LABEL_FALLBACK_LINE_GAP_PX
        )
      )
      : Math.max(plotWorldTop + 2, plotWorldBottom - candidate.height - 2)
  );

  const computePreferredFloatingTop = (candidate: CandidateLabel): number => {
    const lowerBound = computeFloatingTopLowerBound(candidate);
    const upperBound = computeFloatingTopUpperBound(candidate);
    const preferredTop = candidate.mustStayBelowAnchor
      ? candidate.anchorY + (candidate.anchorClearancePx ?? 0)
      : candidate.anchorY - candidate.height - TRACK_INLINE_LABEL_FALLBACK_LINE_GAP_PX;
    return clamp(preferredTop, lowerBound, Math.max(lowerBound, upperBound));
  };

  const displacementOffsets = [
    { dx: 0, dy: 0 },
    { dx: 0, dy: -20 },
    { dx: 0, dy: 20 },
    { dx: -72, dy: -16 },
    { dx: 72, dy: -16 },
    { dx: -128, dy: -34 },
    { dx: 128, dy: -34 },
    { dx: -192, dy: -14 },
    { dx: 192, dy: -14 },
    { dx: 0, dy: -48 },
    { dx: 0, dy: 48 },
  ];
  const displacementScale = clamp(Math.pow(zoomX, 0.26), 0.34, 1);

  for (const candidate of candidates) {
    let placed: StorylineTrackLabel | null = null;

    if (candidate.placement === 'embedded') {
      placed = tryPlace(candidate, candidate.left, candidate.top);
    }

    const floatingCandidate =
      candidate.placement === 'floating'
        ? candidate
        : {
            ...candidate,
            placement: 'floating' as const,
            top: computePreferredFloatingTop(candidate),
          };
    const lockedLeft = floatingCandidate.lockedCenterX == null
      ? null
      : clamp(
        floatingCandidate.lockedCenterX - floatingCandidate.width / 2,
        plotWorldLeft + 2,
        Math.max(plotWorldLeft + 2, plotWorldRight - floatingCandidate.width - 2)
      );

    if (!placed) {
      const allowedOffsets = floatingCandidate.mustStayAboveAnchor
        ? displacementOffsets.filter((offset) => offset.dy <= 0)
        : floatingCandidate.mustStayBelowAnchor
          ? displacementOffsets.filter((offset) => offset.dy >= 0)
        : displacementOffsets;
      for (const offset of allowedOffsets) {
        const left = lockedLeft == null
          ? clamp(
            floatingCandidate.left + offset.dx * displacementScale,
            plotWorldLeft + 2,
            Math.max(plotWorldLeft + 2, plotWorldRight - floatingCandidate.width - 2)
          )
          : lockedLeft;
        const topLowerBound = computeFloatingTopLowerBound(floatingCandidate);
        const topUpperBound = computeFloatingTopUpperBound(floatingCandidate);
        const top = clamp(
          floatingCandidate.top + offset.dy * displacementScale,
          topLowerBound,
          Math.max(topLowerBound, topUpperBound)
        );
        placed = tryPlace(floatingCandidate, left, top);
        if (placed) break;
      }
    }

    if (!placed) {
      const stepX = Math.max(14, floatingCandidate.width + labelOverlapGap);
      const stepY = Math.max(12, floatingCandidate.height + labelOverlapGap);
      const scanTopMin = computeFloatingTopLowerBound(floatingCandidate);
      const scanTopMax = Math.max(scanTopMin, computeFloatingTopUpperBound(floatingCandidate));
      for (let top = scanTopMin; top <= scanTopMax && !placed; top += stepY) {
        if (lockedLeft != null) {
          placed = tryPlace(floatingCandidate, lockedLeft, top);
        } else {
          for (let left = plotWorldLeft + 2; left <= plotWorldRight - floatingCandidate.width - 2; left += stepX) {
            placed = tryPlace(floatingCandidate, left, top);
            if (placed) break;
          }
        }
      }
    }

    if (!placed) {
      const forcedLeft = lockedLeft == null
        ? clamp(
          floatingCandidate.anchorX - floatingCandidate.width / 2,
          plotWorldLeft + 2,
          Math.max(plotWorldLeft + 2, plotWorldRight - floatingCandidate.width - 2)
        )
        : lockedLeft;
      const forcedTop = computePreferredFloatingTop(floatingCandidate);
      const right = forcedLeft + floatingCandidate.width;
      const bottom = forcedTop + floatingCandidate.height;
      const connector = floatingCandidate.suppressConnector
        ? null
        : {
            fromX: floatingCandidate.anchorX,
            fromY: floatingCandidate.anchorY,
            toX: clamp(floatingCandidate.anchorX, forcedLeft + 3, right - 3),
            toY: clamp(
              floatingCandidate.anchorY >= bottom ? bottom : forcedTop,
              plotWorldTop + 2,
              Math.max(plotWorldTop + 2, plotWorldBottom - 2)
            ),
          };
      placed = {
        id: floatingCandidate.id,
        column: floatingCandidate.column,
        pointCount: floatingCandidate.pointCount,
        slotIndex: floatingCandidate.slotIndex,
        placement: 'floating',
        x: forcedLeft,
        y: floatingCandidate.lineY,
        top: forcedTop,
        width: floatingCandidate.width,
        height: floatingCandidate.height,
        maskHeight: floatingCandidate.maskHeight,
        fontSize: floatingCandidate.fontSize,
        paddingX: floatingCandidate.paddingX,
        anchorX: floatingCandidate.anchorX,
        anchorY: floatingCandidate.anchorY,
        connector: connector ?? undefined,
      };
    }

    accepted.push(placed);
    acceptedBoxes.push({
      left: placed.x,
      right: placed.x + placed.width,
      top: placed.top,
      bottom: placed.top + placed.height,
    });
  }

  return accepted;
}
