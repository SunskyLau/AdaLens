import { INSIGHT_TAXONOMY_COLORS, INSIGHT_TAXONOMY_FALLBACK_COLOR } from '@/config';
import type { InsightType } from '@/types';
import { clamp, type StorylineColumnTrack } from './storylineGraphLayout';
import type {
  StorylineConvergeLaneMode,
  StorylineTurnConvergeLayout,
} from './storylineTurnConvergeLayout';
import { getTrackStrokeColor } from './storylineTurnConvergeLayout';
import { STORYLINE_GRAPH_RENDER_CONSTANTS } from './storylineGraphSelection';

export interface ViewTransform {
  zoomX: number;
  tx: number;
}

export interface MinimapState {
  width: number;
  height: number;
  left: number;
  top: number;
  worldMinX: number;
  worldMaxX: number;
  worldSpanX: number;
  worldLeft: number;
  worldWidth: number;
  focusX: number;
  focusY: number;
  focusWidth: number;
  focusHeight: number;
}

export interface MinimapPoint {
  id: string;
  kind: 'atomic' | 'plan';
  summaryId: string | null;
  planId: string | null;
  x: number;
  y: number;
  r: number;
  color: string;
  insightType?: InsightType;
  pulse?: boolean;
}

const STORYLINE_DATA_QUALITY_THEME_HEX = '#113C64';

export function isMinimapPointSelected(args: {
  pointId: string;
  pointSummaryId: string | null;
  pointPlanId?: string | null;
  selectedSummaryId: string | null;
  selectedAtomicNodeId: string | null;
  selectedPlanId?: string | null;
}): boolean {
  const {
    pointId,
    pointSummaryId,
    pointPlanId = null,
    selectedSummaryId,
    selectedAtomicNodeId,
    selectedPlanId = null,
  } = args;
  if (selectedPlanId) {
    return pointPlanId === selectedPlanId;
  }
  if (selectedAtomicNodeId) {
    return pointId === selectedAtomicNodeId;
  }
  return !!selectedSummaryId && pointSummaryId === selectedSummaryId;
}

const {
  MINIMAP_TOP_PX,
  MINIMAP_WIDTH_RATIO,
  MINIMAP_WIDTH_MIN_PX,
  MINIMAP_SIDE_MARGIN_PX,
  MINIMAP_HEIGHT_PX,
  MINIMAP_POINT_BASE_INNER_HEIGHT_PX,
  MINIMAP_POINT_GLYPH_SCALE,
  MINIMAP_POINT_MIN_HEIGHT_RATIO,
  MINIMAP_POINT_MAX_HEIGHT_RATIO,
} = STORYLINE_GRAPH_RENDER_CONSTANTS;

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampXTransform(
  t: number,
  viewportSpan: number,
  worldMin: number,
  worldMax: number
): number {
  const worldSpan = Math.max(1, worldMax - worldMin);
  if (worldSpan <= viewportSpan - 24) {
    const worldCenter = (worldMin + worldMax) / 2;
    return viewportSpan / 2 - worldCenter;
  }
  const minT = viewportSpan - worldMax - 18;
  const maxT = -worldMin + 18;
  return clamp(t, minT, maxT);
}

export function clampViewX(
  transform: ViewTransform,
  viewport: { width: number },
  plotBounds: { minX: number; maxX: number }
): ViewTransform {
  return {
    ...transform,
    tx: clampXTransform(transform.tx, viewport.width, plotBounds.minX, plotBounds.maxX),
  };
}

export function focusViewOnStorylineSummaryTurn(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'turns' | 'plotMinX' | 'plotMaxX'>;
  summaryId: string;
  currentView: ViewTransform;
  viewportWidth: number;
}): ViewTransform | null {
  const { layout, summaryId, currentView, viewportWidth } = args;
  const targetTurn = layout.turns.find((turn) => turn.summaryIds.includes(summaryId));
  if (!targetTurn) {
    return null;
  }
  const centerX = (targetTurn.xStart + targetTurn.xEnd) / 2;
  return clampViewX(
    {
      ...currentView,
      tx: viewportWidth / 2 - centerX,
    },
    { width: viewportWidth },
    { minX: layout.plotMinX, maxX: layout.plotMaxX }
  );
}

export function focusViewOnStorylinePlanArea(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'activePlanAreas' | 'plotMinX' | 'plotMaxX'>;
  planId: string;
  currentView: ViewTransform;
  viewportWidth: number;
}): ViewTransform | null {
  const { layout, planId, currentView, viewportWidth } = args;
  const targetArea = layout.activePlanAreas.find((area) => area.planId === planId);
  if (!targetArea) {
    return null;
  }
  const centerX = (targetArea.left + targetArea.right) / 2;
  return clampViewX(
    {
      ...currentView,
      tx: viewportWidth / 2 - centerX,
    },
    { width: viewportWidth },
    { minX: layout.plotMinX, maxX: layout.plotMaxX }
  );
}

export function focusViewOnStorylineConvergeIndex(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'converges' | 'plotMinX' | 'plotMaxX'>;
  convergeIndex: number;
  currentView: ViewTransform;
  viewportWidth: number;
}): ViewTransform | null {
  const { layout, convergeIndex, currentView, viewportWidth } = args;
  const targetConverge = layout.converges.find((converge) => converge.index === convergeIndex);
  if (!targetConverge) {
    return null;
  }
  const centerX = (targetConverge.xStart + targetConverge.xEnd) / 2;
  return clampViewX(
    {
      ...currentView,
      tx: viewportWidth / 2 - centerX,
    },
    { width: viewportWidth },
    { minX: layout.plotMinX, maxX: layout.plotMaxX }
  );
}

export function getNodeColor(insightType: InsightType): string {
  if (insightType === 'data_quality') {
    return STORYLINE_DATA_QUALITY_THEME_HEX;
  }
  return INSIGHT_TAXONOMY_COLORS[insightType]?.hex || INSIGHT_TAXONOMY_FALLBACK_COLOR.hex;
}

export function isConvergeLabelId(labelId: string): boolean {
  return labelId.startsWith('indicator:converge:');
}

export function parseConvergeLabelId(labelId: string): { convergeIndex: number; column: string } | null {
  const matched = /^indicator:converge:(\d+):(.+)$/.exec(labelId);
  if (!matched) return null;
  return {
    convergeIndex: Number(matched[1]),
    column: matched[2],
  };
}

export interface ConvergeIndicatorVisualState {
  mode: StorylineConvergeLaneMode | undefined;
  filterHighlighted: boolean;
  forceUninvolvedTextColor: boolean;
  maskTone: 'default';
  textOpacity: number;
  connectorOpacity: number;
  anchor: 'converge' | 'marker';
}

export function collectFullyVisibleConvergeIndexes(
  converges: Array<{ index: number; xStart: number; xEnd: number }>,
  viewTx: number,
  viewportWidth: number
): Set<number> {
  const worldLeft = 0 - viewTx;
  const worldRight = viewportWidth - viewTx;
  const visible = new Set<number>();
  for (const converge of converges) {
    if (converge.xStart >= worldLeft && converge.xEnd <= worldRight) {
      visible.add(converge.index);
    }
  }
  return visible;
}

export function isSummaryAreaFullyVisibleInViewport(args: {
  area: { left: number; right: number; top: number; bottom: number };
  viewTx: number;
  plotTopOffset: number;
  plotViewportHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  layoutYOffset?: number;
}): boolean {
  const {
    area,
    viewTx,
    plotTopOffset,
    plotViewportHeight,
    viewportWidth,
    viewportHeight,
    layoutYOffset = 0,
  } = args;
  const screenLeft = area.left + viewTx;
  const screenRight = area.right + viewTx;
  const screenTop = area.top + plotTopOffset + layoutYOffset;
  const screenBottom = area.bottom + plotTopOffset + layoutYOffset;
  const visibleTop = plotTopOffset;
  const visibleBottom = Math.min(viewportHeight, plotTopOffset + plotViewportHeight);

  return (
    screenLeft >= 0 &&
    screenRight <= viewportWidth &&
    screenTop >= visibleTop &&
    screenBottom <= visibleBottom
  );
}

export function computeStorylineVerticalCenterOffset(args: {
  layout: StorylineTurnConvergeLayout;
  yUpperBound: number;
  yLowerBound: number;
}): number {
  const { layout, yUpperBound, yLowerBound } = args;
  const yValues: number[] = [];
  for (const area of layout.summaryAreas) {
    yValues.push(area.top, area.bottom);
    for (const node of area.nodes) {
      yValues.push(node.y - node.height / 2, node.y + node.height / 2);
    }
    for (const track of area.tracks) {
      yValues.push(track.minY, track.maxY);
    }
  }
  for (const area of layout.activePlanAreas) {
    yValues.push(area.top, area.bottom);
  }
  for (const converge of layout.converges) {
    for (const lane of converge.lanes) {
      yValues.push(lane.y);
    }
  }
  for (const branch of layout.boundaryBranches) {
    yValues.push(branch.fromY, branch.toY, branch.c1Y, branch.c2Y);
  }
  if (yValues.length === 0) return 0;

  const contentMinY = Math.min(...yValues);
  const contentMaxY = Math.max(...yValues);
  const desiredCenterY = (yUpperBound + yLowerBound) / 2;
  const contentCenterY = (contentMinY + contentMaxY) / 2;
  const rawOffset = desiredCenterY - contentCenterY;
  const minOffset = yUpperBound - contentMinY;
  const maxOffset = yLowerBound - contentMaxY;

  return clamp(
    rawOffset,
    Math.min(minOffset, maxOffset),
    Math.max(minOffset, maxOffset)
  );
}

export function buildConvergeIndicatorTracks(
  layout: StorylineTurnConvergeLayout,
  visibleConvergeIndexes: Set<number>
): StorylineColumnTrack[] {
  const branchCountByKey = new Map<string, number>();
  for (const branch of layout.boundaryBranches) {
    const key = `${branch.turnIndex}:${branch.side}:${branch.column}`;
    branchCountByKey.set(key, (branchCountByKey.get(key) || 0) + 1);
  }

  return layout.converges
    .filter((converge) => visibleConvergeIndexes.has(converge.index))
    .flatMap((converge) =>
    converge.lanes.map((lane) => {
      const segments = lane.segments.map((segment) => ({
        ...segment,
        id: `${lane.id}:${segment.id}`,
      }));
      const xValues: number[] = [];
      const yValues: number[] = [];
      for (const segment of segments) {
        xValues.push(segment.startX, segment.endX);
        yValues.push(segment.startY, segment.endY);
        if (segment.c1X !== undefined) xValues.push(segment.c1X);
        if (segment.c2X !== undefined) xValues.push(segment.c2X);
        if (segment.c1Y !== undefined) yValues.push(segment.c1Y);
        if (segment.c2Y !== undefined) yValues.push(segment.c2Y);
      }
      for (const marker of lane.endpointMarkers) {
        xValues.push(marker.x - marker.diameter / 2, marker.x + marker.diameter / 2);
        yValues.push(marker.y - marker.diameter / 2, marker.y + marker.diameter / 2);
      }

      const fromPrevTurnRightCount =
        branchCountByKey.get(`${converge.index - 1}:right:${lane.column}`) || 0;
      const fromNextTurnLeftCount =
        branchCountByKey.get(`${converge.index}:left:${lane.column}`) || 0;
      const pointCount = Math.max(1, fromPrevTurnRightCount + fromNextTurnLeftCount);
      const indicatorAnchorX = lane.endpointMarkers[0]?.x ?? (converge.xStart + converge.xEnd) / 2;
      const indicatorAnchors = lane.endpointMarkers.length > 0
        ? lane.endpointMarkers.map((marker) => ({ x: marker.x, y: marker.y }))
        : [
          { x: converge.xStart, y: lane.y },
          { x: converge.xEnd, y: lane.y },
        ];
      const indicatorAnchorClearancePx = lane.endpointMarkers.length > 0
        ? Math.max(1.5, (lane.endpointMarkers[0]?.diameter ?? 0) / 2 + 1.5)
        : undefined;

      return {
        id: `indicator:${lane.id}`,
        column: lane.column,
        color: getTrackStrokeColor(true),
        path: segments.map((segment) => segment.path).join(' '),
        segments,
        anchors: indicatorAnchors,
        leftExtension: null,
        rightExtension: null,
        minX: xValues.length > 0 ? Math.min(...xValues) : indicatorAnchorX,
        maxX: xValues.length > 0 ? Math.max(...xValues) : indicatorAnchorX,
        minY: yValues.length > 0 ? Math.min(...yValues) : lane.y,
        maxY: yValues.length > 0 ? Math.max(...yValues) : lane.y,
        pointCount,
        indicatorCenterX: indicatorAnchorX,
        indicatorLockToCenter: true,
        indicatorLabelText: lane.column,
        indicatorFontSizePx: lane.indicatorFontSizePx,
        indicatorSuppressConnector: lane.endpointMarkers.length > 0,
        indicatorMustStayBelowAnchor: lane.endpointMarkers.length > 0,
        indicatorAnchorClearancePx,
      };
    })
    );
}

export function computeStorylineMinimapFrame(viewportWidth: number, viewportHeight: number): {
  width: number;
  height: number;
  left: number;
  top: number;
} {
  void viewportHeight;
  const maxWidth = Math.max(220, viewportWidth - MINIMAP_SIDE_MARGIN_PX * 2);
  const minWidth = Math.min(MINIMAP_WIDTH_MIN_PX, maxWidth);
  const width = clamp(Math.round(viewportWidth * MINIMAP_WIDTH_RATIO), minWidth, maxWidth);
  const height = MINIMAP_HEIGHT_PX;
  return {
    width,
    height,
    left: (viewportWidth - width) / 2,
    top: MINIMAP_TOP_PX,
  };
}

export function computeMinimapPointDiameter(
  glyphDiameter: number,
  minimapInnerHeight: number,
  minHeightRatio = MINIMAP_POINT_MIN_HEIGHT_RATIO,
  maxHeightRatio = MINIMAP_POINT_MAX_HEIGHT_RATIO
): number {
  const safeGlyph = Math.max(0, glyphDiameter);
  const safeInnerHeight = Math.max(1, minimapInnerHeight);
  const heightScale = clamp(safeInnerHeight / MINIMAP_POINT_BASE_INNER_HEIGHT_PX, 0.82, 1.3);
  const rawDiameter = safeGlyph * MINIMAP_POINT_GLYPH_SCALE * heightScale;
  const minDiameter = safeInnerHeight * minHeightRatio;
  const maxDiameter = safeInnerHeight * maxHeightRatio;
  return clamp(rawDiameter, minDiameter, maxDiameter);
}

export function chooseStorylineInitialScale(args: {
  plotWidth: number;
  plotHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): number {
  const availableWidth = Math.max(1, args.viewportWidth - 34);
  void args.plotHeight;
  void args.viewportHeight;
  const fitsAt100 = args.plotWidth <= availableWidth;
  return fitsAt100 ? 1 : 0.5;
}

export function buildStorylineAutoFitKey(args: {
  runId: string;
  viewportWidth: number;
  viewportHeight: number;
  laneMode?: string;
}): string {
  return [
    args.runId,
    Math.round(args.viewportWidth),
    Math.round(args.viewportHeight),
    args.laneMode ?? '',
  ].join('::');
}

export function computeStorylineWorldBounds(layout: StorylineTurnConvergeLayout): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
} {
  const minX = layout.plotMinX;
  const maxX = layout.plotMaxX;
  const centerX = (minX + maxX) / 2;
  if (layout.nodes.length === 0) {
    return {
      minX,
      maxX,
      minY: layout.plotMinY,
      maxY: layout.plotMaxY,
      centerX,
      centerY: (layout.plotMinY + layout.plotMaxY) / 2,
    };
  }

  const nodeMedianY = medianValue(layout.nodes.map((node) => node.y));
  const halfSpanY = Math.max(
    1,
    Math.abs(layout.plotMinY - nodeMedianY),
    Math.abs(layout.plotMaxY - nodeMedianY)
  );
  return {
    minX,
    maxX,
    minY: nodeMedianY - halfSpanY,
    maxY: nodeMedianY + halfSpanY,
    centerX,
    centerY: nodeMedianY,
  };
}

