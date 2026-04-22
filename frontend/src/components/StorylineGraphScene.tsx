import type { MouseEvent as ReactMouseEvent } from 'react';
import { CheckCheck, Gauge } from 'lucide-react';
import type { AtomicInsight, PlanControlAction, PlanItem, SoftSteeringKind } from '@/types';
import PlanDispatchCard from './conversation/PlanDispatchCard';
import InspectorAtomicInsightCard from './InspectorAtomicInsightCard';
import StorylineAtomicGlyph, { InsightTypeGlyphMark } from './StorylineAtomicGlyph';
import { STORYLINE_CONNECTOR_STROKE_WIDTH_PX } from '@/config';
import {
  getTrackStrokeColor,
  shouldRenderActivePlanText,
  type StorylineActivePlanArea,
  type StorylineConvergeLaneMode,
  type StorylineTurnConvergeLayout,
} from './storylineTurnConvergeLayout';
import { type StorylineTrackLabel } from './storylineTrackLabels';
import StorylineSoftSteeringIcon, {
  resolveStorylineSoftSteeringBadgeBounds,
} from './storylineSoftSteeringIcon';
import {
  COLUMN_HIGHLIGHT_WIDTH_MULTIPLIER,
  CONNECTED_SUMMARY_FILL_OPACITY,
  CONNECTED_SUMMARY_GLYPH_OPACITY,
  CONNECTED_SUMMARY_STROKE_OPACITY,
  CONVERGE_INVOLVED_SEGMENT_WIDTH_MULTIPLIER,
  FILTERED_INDICATOR_TEXT_OPACITY,
  buildTrackSegmentKey,
  buildSummaryTitleBandPath,
  buildSummaryConnectivityConvergeLaneKey,
  computeColumnHoverHitStrokeWidth,
  computeIndicatorHoverPaddingPx,
  computeSummaryAreaTitleTextMetrics,
  getLegendItemVisualState,
  HOVER_COLUMN_HIGHLIGHT_HEX,
  LEGEND_SCALE,
  resolveColumnHighlightStrokeColor,
  resolveConvergeFilledMarkerColor,
  resolveStorylineColumnFilterLineState,
  SELECTED_SUMMARY_FILL_OPACITY,
  SELECTED_SUMMARY_STROKE_WIDTH_PX,
  SUMMARY_AREA_FILL_HEX,
  SUMMARY_AREA_FILL_OPACITY,
  SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER,
  SUMMARY_TITLE_FILL_HEX,
  SUMMARY_TITLE_TEXT_HEX,
  shouldRenderSelectedConnectionHighlight,
  shouldRenderSelectedSummaryConnectivityHighlight,
  STORYLINE_GRAPH_RENDER_CONSTANTS,
  type StorylineColumnInteractionSource,
} from './storylineGraphSelection';
import {
  isConvergeLabelId,
  parseConvergeLabelId,
  type ConvergeIndicatorVisualState,
  type MinimapPoint,
  type MinimapState,
  type ViewTransform,
} from './storylineGraphViewport';
import type { StorylineConvergeSummaryButton } from './storylineSummaryButtons';

interface HoveredAtomicPreview {
  runId: string;
  atomic: AtomicInsight;
  index: number;
  x: number;
  y: number;
}

interface HoveredSummaryPreview {
  summaryId: string;
  sourceTask: string;
  summaryText: string;
  x: number;
  y: number;
}

interface HoveredPlanPreview {
  planId: string;
  text: string;
  status: PlanItem['status'];
  x: number;
  y: number;
}

interface StorylineGraphSceneProps {
  containerRef: any;
  svgRef: any;
  plotClipId: string;
  viewport: { width: number; height: number };
  view: ViewTransform;
  layout: StorylineTurnConvergeLayout;
  plotTopOffset: number;
  layoutVerticalOffset: number;
  isDragging: boolean;
  isEmptyStoryline: boolean;
  activeSteeringPen: 'focus' | 'ignore' | 'elaborate' | null;
  hoveredColumn: string | null;
  hoveredTrack: { column: string; x: number; y: number } | null;
  hoveredAtomicPreview: HoveredAtomicPreview | null;
  hoveredSummaryPreview: HoveredSummaryPreview | null;
  hoveredPlanPreview: HoveredPlanPreview | null;
  taxonomyLegendItems: Array<{ id: any; label: string; count: number; color: string }>;
  visibleTrackLabels: StorylineTrackLabel[];
  summaryInternalsRenderMode: any;
  storylineFilterSnapshot: any;
  selectionHighlightPolicy: any;
  selectedSummaryId: string | null;
  selectedPlanId: string | null;
  selectedAtomicNodeId: string | null;
  selectedGlyphColumnHighlightColor: string | null;
  selectedGlyphConnection: any;
  selectedGlyphBranchHighlightIds: Set<string>;
  selectedSummaryConnectivity: any;
  selectedSummarySharedColumnIds: Set<string>;
  selectedSummaryExtensionPromotion: any;
  selectedSummaryConnectivityActive: boolean;
  isStorylineFilterActive: boolean;
  convergeLaneModeByKey: Map<string, StorylineConvergeLaneMode>;
  minimapState: MinimapState | null;
  minimapInnerHeight: number;
  minimapPoints: MinimapPoint[];
  activePlanAreas: StorylineActivePlanArea[];
  convergeSummaryButtons: StorylineConvergeSummaryButton[];
  highlightedSummaryEntryId: string | null;
  planControlPendingById: Record<string, PlanControlAction | null>;
  editingPlanId?: string | null;
  editingPlanDraft?: string;
  disablePendingPlanLaunch?: boolean;
  onCanvasMouseDown: any;
  onCanvasClick: any;
  onCanvasMouseLeave: () => void;
  onBackgroundContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onWheel: any;
  onSummarySelect: (summaryId: string, event: ReactMouseEvent<Element>) => void;
  onAtomicSelect: (summaryId: string, atomicId: string, event: ReactMouseEvent<Element>) => void;
  onHoverSummaryTarget: (summaryId: string, clientX: number, clientY: number) => void;
  onLeaveSummaryTarget: (summaryId: string) => void;
  onActivePlanSelect: (planId: string) => void;
  onHoverActivePlanArea: (
    planId: string,
    status: PlanItem['status'],
    text: string,
    clientX: number,
    clientY: number
  ) => void;
  onLeaveActivePlanArea: (planId: string) => void;
  onPlanControl: (planId: string, action: PlanControlAction) => void;
  onPlanModifyStart?: (planId: string) => void;
  onPlanModifyDraftChange?: (draft: string) => void;
  onPlanModifyCancel?: () => void;
  onPlanModifySubmit?: (planId: string) => void;
  onHoverAtomicGlyph: (summaryId: string, atomicId: string, clientX: number, clientY: number) => void;
  onLeaveAtomicGlyph: (summaryId: string, atomicId: string) => void;
  onColumnContextMenu: (
    column: string,
    source: StorylineColumnInteractionSource,
    event: ReactMouseEvent<SVGElement>
  ) => void;
  onLegendToggle: (insightType: any) => void;
  onColumnPointerDown: (
    column: string,
    source: StorylineColumnInteractionSource,
    event: any,
    convergeIndex?: number
  ) => void;
  onColumnClick: (
    column: string,
    source: StorylineColumnInteractionSource,
    event: any,
    convergeIndex?: number
  ) => void;
  onHoverColumn: (column: string, clientX: number, clientY: number) => void;
  onLeaveColumn: (column: string) => void;
  onMinimapBackgroundMouseDown: any;
  onMinimapFocusMouseDown: any;
  isNodeKeptByFilter: (nodeId: string) => boolean;
  isSummaryKeptByFilter: (summaryId: string) => boolean;
  isTrackSegmentKeptByFilter: (segmentKey: string) => boolean;
  isBranchKeptByFilter: (branchId: string) => boolean;
  isConvergeLaneKeptByFilter: (laneKey: string) => boolean;
  getColumnFilterState: (column: string) => any;
  resolveConvergeColumnEmphasis: (column: string, mode: StorylineConvergeLaneMode | undefined) => any;
  resolveSummaryColumnEmphasis: (column: string) => any;
  resolveConvergeLabelTextColor: (labelId: string, hovered: boolean) => string;
  resolveConvergeLabelVisualState: (labelId: string) => ConvergeIndicatorVisualState | null;
  usesInvolvedConvergeVisual: (mode: StorylineConvergeLaneMode | undefined) => boolean;
  summarySteeringBadgeKinds: Map<string, SoftSteeringKind>;
  atomicSteeringBadgeKinds: Map<string, SoftSteeringKind>;
  columnSteeringBadgeKinds: Map<string, SoftSteeringKind>;
  columnSteeringBadgeKindsByIndicatorId: Map<string, SoftSteeringKind>;
  summarySteeringEntryIdsById: Map<string, string>;
  atomicSteeringEntryIdsByKey: Map<string, string>;
  columnSteeringEntryIdsByName: Map<string, string>;
  columnSteeringEntryIdsByIndicatorId: Map<string, string>;
  createOriginPlanIds: Set<string>;
  createOriginSummaryIds: Set<string>;
  onConversationEntryFocusRequest: (conversationEntryId: string) => void;
  onConvergeSummaryButtonClick: (conversationEntryId: string) => void;
}

export default function StorylineGraphScene(props: StorylineGraphSceneProps) {
  const {
    containerRef,
    svgRef,
    plotClipId,
    viewport,
    view,
    layout,
    plotTopOffset,
    layoutVerticalOffset,
    isDragging,
    isEmptyStoryline,
    activeSteeringPen,
    hoveredColumn,
    hoveredTrack,
    hoveredAtomicPreview,
    hoveredSummaryPreview,
    hoveredPlanPreview,
    taxonomyLegendItems,
    visibleTrackLabels,
    summaryInternalsRenderMode,
    storylineFilterSnapshot,
    selectionHighlightPolicy,
    selectedSummaryId,
    selectedPlanId,
    selectedAtomicNodeId,
    selectedGlyphColumnHighlightColor,
    selectedGlyphConnection,
    selectedGlyphBranchHighlightIds,
    selectedSummaryConnectivity,
    selectedSummarySharedColumnIds,
    selectedSummaryExtensionPromotion,
    selectedSummaryConnectivityActive,
    isStorylineFilterActive,
    convergeLaneModeByKey,
    minimapState,
    activePlanAreas,
    convergeSummaryButtons,
    planControlPendingById,
    editingPlanId = null,
    editingPlanDraft = '',
    disablePendingPlanLaunch = false,
    onCanvasMouseDown,
    onCanvasClick,
    onCanvasMouseLeave,
    onBackgroundContextMenu,
    onWheel,
    onSummarySelect,
    onAtomicSelect,
    onHoverSummaryTarget,
    onLeaveSummaryTarget,
    onActivePlanSelect,
    onHoverActivePlanArea,
    onLeaveActivePlanArea,
    onPlanControl,
    onPlanModifyStart,
    onPlanModifyDraftChange,
    onPlanModifyCancel,
    onPlanModifySubmit,
    onHoverAtomicGlyph,
    onLeaveAtomicGlyph,
    onLegendToggle,
    onColumnPointerDown,
    onColumnClick,
    onHoverColumn,
    onLeaveColumn,
    isNodeKeptByFilter,
    isSummaryKeptByFilter,
    isTrackSegmentKeptByFilter,
    isBranchKeptByFilter,
    isConvergeLaneKeptByFilter,
    getColumnFilterState,
    resolveConvergeColumnEmphasis,
    resolveSummaryColumnEmphasis,
    resolveConvergeLabelTextColor,
    resolveConvergeLabelVisualState,
    usesInvolvedConvergeVisual,
    onColumnContextMenu,
    summarySteeringBadgeKinds,
    atomicSteeringBadgeKinds,
    columnSteeringBadgeKinds,
    columnSteeringBadgeKindsByIndicatorId,
    summarySteeringEntryIdsById,
    atomicSteeringEntryIdsByKey,
    columnSteeringEntryIdsByName,
    columnSteeringEntryIdsByIndicatorId,
    createOriginPlanIds,
    createOriginSummaryIds,
    onConversationEntryFocusRequest,
    onConvergeSummaryButtonClick,
  } = props;

  const handleSteeringBadgeClick = (
    conversationEntryId: string,
    event: ReactMouseEvent<Element>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onConversationEntryFocusRequest(conversationEntryId);
  };
  const {
    MINIMAP_HEIGHT_PX,
    MINIMAP_TOP_PX,
    STORYLINE_BG_TOP_HEX,
    STORYLINE_BG_BOTTOM_HEX,
  } = STORYLINE_GRAPH_RENDER_CONSTANTS;
  const topRailTopPx = minimapState?.top ?? MINIMAP_TOP_PX;
  const topRailHeightPx = minimapState?.height ?? MINIMAP_HEIGHT_PX;
  const topRailSideMarginPx = 16;
  const legendFirstRowCount = 6;
  const legendItemSlotWidthPx = 98;
  const legendInnerHorizontalPaddingPx = 36;
  const legendWidthPx = Math.min(
    Math.max(
      240,
      legendFirstRowCount * legendItemSlotWidthPx + legendInnerHorizontalPaddingPx
    ),
    Math.max(240, viewport.width - topRailSideMarginPx * 2)
  );
  const legendLeftPx = Math.max(
    topRailSideMarginPx,
    (viewport.width - legendWidthPx) / 2
  );
  const legendTopPx = topRailTopPx;
  const legendFirstRowItems = taxonomyLegendItems.slice(0, legendFirstRowCount);
  const legendSecondRowItems = taxonomyLegendItems.slice(legendFirstRowCount);
  const legendRows = [legendFirstRowItems, legendSecondRowItems].filter((row) => row.length > 0);
  const computeConvergeMarkerHitDiameter = (marker: { diameter: number }, hoverHitStrokeWidth: number) =>
    Math.max(marker.diameter + 6, hoverHitStrokeWidth + 2);
  const hoveredAtomicCardWidthPx = 512;
  const hoveredAtomicCardHeightPx = 520;
  const hoveredSummaryCardWidthPx = 448;
  const hoveredSummaryCardHeightPx = 220;
  const hoveredPlanCardWidthPx = 320;
  const hoveredPlanCardHeightPx = 120;
  const hoveredAtomicCardLeft = hoveredAtomicPreview
    ? Math.min(
      Math.max(12, hoveredAtomicPreview.x + 16),
      Math.max(12, viewport.width - hoveredAtomicCardWidthPx - 12)
    )
    : 12;
  const hoveredAtomicCardTop = hoveredAtomicPreview
    ? Math.min(
      Math.max(12, hoveredAtomicPreview.y + 16),
      Math.max(12, viewport.height - hoveredAtomicCardHeightPx - 12)
    )
    : 12;
  const hoveredSummaryCardLeft = hoveredSummaryPreview
    ? Math.min(
      Math.max(12, hoveredSummaryPreview.x + 16),
      Math.max(12, viewport.width - hoveredSummaryCardWidthPx - 12)
    )
    : 12;
  const hoveredSummaryCardTop = hoveredSummaryPreview
    ? Math.min(
      Math.max(12, hoveredSummaryPreview.y + 16),
      Math.max(12, viewport.height - hoveredSummaryCardHeightPx - 12)
    )
    : 12;
  const hoveredPlanCardLeft = hoveredPlanPreview
    ? Math.min(
      Math.max(12, hoveredPlanPreview.x + 16),
      Math.max(12, viewport.width - hoveredPlanCardWidthPx - 12)
    )
    : 12;
  const hoveredPlanCardTop = hoveredPlanPreview
    ? Math.min(
      Math.max(12, hoveredPlanPreview.y + 16),
      Math.max(12, viewport.height - hoveredPlanCardHeightPx - 12)
    )
    : 12;
  const showActivePlanText = shouldRenderActivePlanText(view.zoomX);
  const showConvergeSummaryButtonText = view.zoomX >= 0.5;
  const convergeSummaryButtonClearancePx = 16;
  const convergeSummaryButtonsByIndex = new Map<number, StorylineConvergeSummaryButton[]>();
  const topConvergeVisualTopByIndex = new Map<number, number>();
  const bottomConvergeVisualBottomByIndex = new Map<number, number>();
  for (const button of convergeSummaryButtons) {
    const existing = convergeSummaryButtonsByIndex.get(button.convergeIndex) ?? [];
    existing.push(button);
    existing.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'stage' ? -1 : 1));
    convergeSummaryButtonsByIndex.set(button.convergeIndex, existing);
  }
  for (const converge of layout.converges) {
    let topVisual = Number.POSITIVE_INFINITY;
    let bottomVisual = Number.NEGATIVE_INFINITY;
    for (const lane of converge.lanes) {
      topVisual = Math.min(topVisual, lane.y);
      bottomVisual = Math.max(bottomVisual, lane.y);
      for (const marker of lane.endpointMarkers) {
        topVisual = Math.min(topVisual, marker.y - marker.diameter / 2);
        bottomVisual = Math.max(bottomVisual, marker.y + marker.diameter / 2);
      }
    }
    if (Number.isFinite(topVisual)) {
      topConvergeVisualTopByIndex.set(converge.index, topVisual);
    }
    if (Number.isFinite(bottomVisual)) {
      bottomConvergeVisualBottomByIndex.set(converge.index, bottomVisual);
    }
  }
  for (const label of visibleTrackLabels) {
    if (!isConvergeLabelId(label.id)) {
      continue;
    }
    const parsedLabelId = parseConvergeLabelId(label.id);
    if (!parsedLabelId) {
      continue;
    }
    const currentTop = topConvergeVisualTopByIndex.get(parsedLabelId.convergeIndex);
    topConvergeVisualTopByIndex.set(
      parsedLabelId.convergeIndex,
      currentTop == null ? label.top : Math.min(currentTop, label.top)
    );
    const currentBottom = bottomConvergeVisualBottomByIndex.get(parsedLabelId.convergeIndex);
    const labelBottom = label.top + label.height;
    bottomConvergeVisualBottomByIndex.set(
      parsedLabelId.convergeIndex,
      currentBottom == null ? labelBottom : Math.max(currentBottom, labelBottom)
    );
  }

  return (
    <div
      ref={containerRef}
      data-storyline-root="true"
      className="h-full w-full min-h-0 overflow-hidden bg-slate-50 relative"
      onContextMenu={onBackgroundContextMenu}
    >
      {isEmptyStoryline ? (
        <div data-storyline-empty-state-root="true" className="flex h-full w-full items-center justify-center">
          <div
            data-storyline-interactive="true"
            className="rounded-2xl border border-slate-200 bg-white/90 px-6 py-5 text-center shadow-sm"
          >
            <p className="text-sm font-medium text-slate-700">Storyline</p>
            <p className="mt-1 text-xs text-slate-500">
              No completed atomic insights are available for storyline plotting yet.
            </p>
          </div>
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            width={viewport.width}
            height={viewport.height}
            className={[
              'select-none',
              isDragging ? 'cursor-grabbing' : activeSteeringPen ? 'cursor-default' : 'cursor-grab',
            ].join(' ')}
            onMouseDown={onCanvasMouseDown}
            onClick={onCanvasClick}
            onWheel={onWheel}
            onMouseLeave={onCanvasMouseLeave}
          >
        <defs>
          <linearGradient id="storyline-bg" x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor={STORYLINE_BG_TOP_HEX} />
            <stop offset="100%" stopColor={STORYLINE_BG_BOTTOM_HEX} />
          </linearGradient>
          <linearGradient
            id={`${plotClipId}-label-cutout-bg`}
            gradientUnits="userSpaceOnUse"
            x1={0}
            x2={0}
            y1={0}
            y2={viewport.height}
          >
            <stop offset="0%" stopColor={STORYLINE_BG_TOP_HEX} />
            <stop offset="100%" stopColor={STORYLINE_BG_BOTTOM_HEX} />
          </linearGradient>
          <clipPath id={plotClipId}>
            <rect
              x={0}
              y={plotTopOffset}
              width={viewport.width}
              height={Math.max(0, viewport.height - plotTopOffset)}
            />
          </clipPath>
        </defs>

        <rect x={0} y={0} width={viewport.width} height={viewport.height} fill="url(#storyline-bg)" />

          <g clipPath={`url(#${plotClipId})`}>
          <g transform={`translate(${view.tx}, ${plotTopOffset + layoutVerticalOffset})`}>
            {layout.converges.map((converge) => (
              <rect
                key={`converge-bg-${converge.index}`}
                x={converge.xStart}
                y={layout.plotMinY}
                width={Math.max(1, converge.xEnd - converge.xStart)}
                height={Math.max(1, layout.plotMaxY - layout.plotMinY)}
                fill="#f8fafc"
                fillOpacity={0.9}
              />
            ))}

            {layout.summaryAreas.map((area) => {
              const isSelected =
                selectionHighlightPolicy.preserveSummaryAreaSelection
                && selectedSummaryId === area.summaryId;
              const isCreateOrigin = createOriginSummaryIds.has(area.summaryId);
              const summarySteeringKind = summarySteeringBadgeKinds.get(area.summaryId);
              const isSharedColumnRelated = selectedSummarySharedColumnIds.has(area.summaryId);
              const isConnectivityDimmed = selectedSummaryConnectivityActive && !isSharedColumnRelated;
              const isKeptByFilter = isSummaryKeptByFilter(area.summaryId);
              const baseFillOpacity = isSelected
                ? SELECTED_SUMMARY_FILL_OPACITY
                : isSharedColumnRelated
                  ? CONNECTED_SUMMARY_FILL_OPACITY
                  : isConnectivityDimmed
                    ? SUMMARY_AREA_FILL_OPACITY * 0.34
                    : SUMMARY_AREA_FILL_OPACITY;
              const fillOpacity = isKeptByFilter ? baseFillOpacity : baseFillOpacity * 0.34;
              const baseStroke = isCreateOrigin
                ? (isSelected ? '#047857' : '#10b981')
                : isSelected
                  ? '#334155'
                  : isSharedColumnRelated
                    ? '#64748b'
                    : '#cbd5e1';
              const baseStrokeWidth = isCreateOrigin
                ? (isSelected ? Math.max(2, SELECTED_SUMMARY_STROKE_WIDTH_PX) : 1.3)
                : isSelected
                  ? SELECTED_SUMMARY_STROKE_WIDTH_PX
                  : isSharedColumnRelated
                    ? 1.15
                    : 1;
              const baseStrokeOpacity = isSelected
                ? (isCreateOrigin ? 0.9 : 0.78)
                : isCreateOrigin
                  ? (isConnectivityDimmed ? 0.4 : 0.8)
                  : isSharedColumnRelated
                    ? CONNECTED_SUMMARY_STROKE_OPACITY
                    : isConnectivityDimmed
                      ? 0.34
                      : 0.62;
              const strokeOpacityBase = isKeptByFilter ? baseStrokeOpacity : baseStrokeOpacity * 0.34;
              const stroke = baseStroke;
              const strokeWidth = baseStrokeWidth;
              const strokeOpacity = strokeOpacityBase;
              const titleMetrics = computeSummaryAreaTitleTextMetrics({
                width: area.width,
                titleBandHeight: area.titleBandHeight,
                label: area.shortLabel,
                labelScale: layout.adaptiveProfile.labelScale,
              });
              const titleBandInset = Math.max(0.8, strokeWidth * 0.56);
              const titleBandPath = buildSummaryTitleBandPath({
                left: area.left,
                right: area.right,
                top: area.top,
                bottom: area.top + area.titleBandHeight,
                cornerRadius: 8,
                inset: titleBandInset,
              });
              const titleBandFillOpacity = isKeptByFilter
                ? Math.min(0.94, fillOpacity + 0.12)
                : Math.min(0.42, fillOpacity + 0.06);
              const titleTextOpacity = isKeptByFilter
                ? (isSelected ? 0.96 : isConnectivityDimmed ? 0.48 : 0.82)
                : (isSelected ? 0.48 : 0.32);
              const titleDividerStroke = isCreateOrigin
                ? (isSelected ? '#059669' : '#6ee7b7')
                : isSelected
                  ? '#475569'
                  : isSharedColumnRelated
                    ? '#94a3b8'
                    : '#cbd5e1';
              const summaryBadgeEntryId = summarySteeringEntryIdsById.get(area.summaryId) ?? null;
              const summaryBadgeAnchorX = area.right + strokeWidth / 2;
              const summaryBadgeAnchorY = area.top - strokeWidth / 2;
              const summaryBadgeBounds =
                summarySteeringKind && summaryBadgeEntryId
                  ? resolveStorylineSoftSteeringBadgeBounds({
                    anchorX: summaryBadgeAnchorX,
                    anchorY: summaryBadgeAnchorY,
                    scope: 'summary',
                    paddingPx: 3,
                  })
                  : null;
              return (
                <g key={`summary-area-bg-${area.summaryId}`}>
                  <rect
                    x={area.left}
                    y={area.top}
                    width={Math.max(1, area.right - area.left)}
                    height={Math.max(1, area.bottom - area.top)}
                    fill={SUMMARY_AREA_FILL_HEX}
                    fillOpacity={fillOpacity}
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeOpacity={strokeOpacity}
                    rx={8}
                    className="cursor-pointer"
                    data-storyline-interactive="true"
                    data-storyline-summary-id={area.summaryId}
                    data-storyline-summary-create-origin={isCreateOrigin ? 'true' : undefined}
                    onMouseEnter={(event) => onHoverSummaryTarget(area.summaryId, event.clientX, event.clientY)}
                    onMouseMove={(event) => onHoverSummaryTarget(area.summaryId, event.clientX, event.clientY)}
                    onMouseLeave={() => onLeaveSummaryTarget(area.summaryId)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSummarySelect(area.summaryId, event);
                    }}
                  />
                  {summaryBadgeBounds && summaryBadgeEntryId ? (
                    <rect
                      x={summaryBadgeBounds.x}
                      y={summaryBadgeBounds.y}
                      width={summaryBadgeBounds.width}
                      height={summaryBadgeBounds.height}
                      rx={summaryBadgeBounds.rx}
                      fill="transparent"
                      pointerEvents="all"
                      data-storyline-interactive="true"
                      data-storyline-soft-steering-badge-hit-target="summary"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => handleSteeringBadgeClick(summaryBadgeEntryId, event)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    />
                  ) : null}
                  <path
                    d={titleBandPath}
                    fill={isCreateOrigin ? '#ecfdf5' : SUMMARY_TITLE_FILL_HEX}
                    fillOpacity={titleBandFillOpacity}
                    pointerEvents="none"
                  />
                  <line
                    x1={area.left + Math.max(6, titleBandInset + 4)}
                    y1={area.top + area.titleBandHeight}
                    x2={area.right - Math.max(6, titleBandInset + 4)}
                    y2={area.top + area.titleBandHeight}
                    stroke={titleDividerStroke}
                    strokeOpacity={Math.min(0.72, strokeOpacity + 0.08)}
                    strokeWidth={0.9}
                    pointerEvents="none"
                  />
                  <text
                    x={(area.left + area.right) / 2}
                    y={area.top + area.titleBandHeight / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={SUMMARY_TITLE_TEXT_HEX}
                    fillOpacity={titleTextOpacity}
                    fontSize={titleMetrics.fontSize}
                    fontWeight={isSelected ? 700 : 620}
                    pointerEvents="none"
                  >
                    {area.shortLabel}
                  </text>
                  {summarySteeringKind
                    ? (
                      <StorylineSoftSteeringIcon
                        kind={summarySteeringKind}
                        anchorX={summaryBadgeAnchorX}
                        anchorY={summaryBadgeAnchorY}
                        scope="summary"
                      />
                    )
                    : null}
                </g>
              );
            })}

            {layout.turnBoundaries.map((boundary) => (
              <line
                key={boundary.id}
                x1={boundary.x}
                y1={layout.plotMinY}
                x2={boundary.x}
                y2={layout.plotMaxY}
                stroke="#94a3b8"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ))}

            {layout.converges.map((converge) =>
              converge.lanes.map((lane) => (
                <g key={lane.id}>
                  {(() => {
                    const laneKey = buildSummaryConnectivityConvergeLaneKey(converge.index, lane.column);
                    const columnFilterState = getColumnFilterState(lane.column);
                    const lineFilterState = resolveStorylineColumnFilterLineState({
                      hasActiveFilter: isStorylineFilterActive,
                      columnFilterState,
                      isExactKept: isConvergeLaneKeptByFilter(laneKey),
                    });
                    const emphasis = resolveConvergeColumnEmphasis(lane.column, lane.mode);
                    const isHovered = emphasis === 'hovered';
                    const isConnectivityConnected = selectedSummaryConnectivity.convergeLaneKeys.has(laneKey);
                    const isPromotedSelectedExtension =
                      selectedSummaryExtensionPromotion.convergeLaneKeys.has(laneKey);
                    const forceExtensionVisual =
                      !isHovered
                      && selectedSummaryConnectivityActive
                      && !isConnectivityConnected
                      && usesInvolvedConvergeVisual(lane.mode);
                    const useDimmedVisual =
                      emphasis === 'faded' || forceExtensionVisual || !lineFilterState.isKept;
                    const isFilterHighlighted = isStorylineFilterActive && lineFilterState.isKept;
                    const summaryConnectivityHighlight = shouldRenderSelectedSummaryConnectivityHighlight({
                      hoveredColumn,
                      column: lane.column,
                      isConnected: isConnectivityConnected && lineFilterState.isKept,
                    });
                    const useInvolvedVisual =
                      !useDimmedVisual
                      && (usesInvolvedConvergeVisual(lane.mode) || isPromotedSelectedExtension);
                    const baseStrokeWidth =
                      (STORYLINE_CONNECTOR_STROKE_WIDTH_PX * layout.adaptiveProfile.trackStrokeScale) / 6
                        * (useInvolvedVisual ? CONVERGE_INVOLVED_SEGMENT_WIDTH_MULTIPLIER : 1);
                    const hoverHitStrokeWidth = computeColumnHoverHitStrokeWidth(baseStrokeWidth, view.zoomX);
                    const strokeColor = resolveColumnHighlightStrokeColor({
                      defaultColor: getTrackStrokeColor(useInvolvedVisual),
                      isHovered,
                      isFilterHighlighted,
                      isSelectedConnection: false,
                      selectedConnectionColor: null,
                    });
                    const highlightWidthMultiplier = isHovered || isFilterHighlighted
                      ? COLUMN_HIGHLIGHT_WIDTH_MULTIPLIER
                      : summaryConnectivityHighlight
                        ? SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER
                        : 1;
                    const strokeOpacity = isHovered || isFilterHighlighted
                      ? 0.98
                      : summaryConnectivityHighlight
                        ? (useInvolvedVisual ? 0.94 : 0.86)
                        : (useDimmedVisual ? 0.7 : (useInvolvedVisual ? 0.9 : 0.82));

                    return (
                      <>
                        {lane.segments.map((segment) => (
                          <g key={segment.id}>
                            <path
                              d={segment.path}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth={baseStrokeWidth * highlightWidthMultiplier}
                              strokeOpacity={strokeOpacity}
                              strokeDasharray={segment.dashed ? '5 4' : undefined}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              pointerEvents="none"
                            />
                            <path
                              d={segment.path}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={hoverHitStrokeWidth}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              pointerEvents="stroke"
                              onMouseDown={(event) => onColumnPointerDown(lane.column, 'converge_lane', event, converge.index)}
                              onClick={(event) => onColumnClick(lane.column, 'converge_lane', event, converge.index)}
                              onContextMenu={(event) => onColumnContextMenu(lane.column, 'converge_lane', event)}
                              onMouseEnter={(event) => onHoverColumn(lane.column, event.clientX, event.clientY)}
                              onMouseMove={(event) => onHoverColumn(lane.column, event.clientX, event.clientY)}
                              onMouseLeave={() => onLeaveColumn(lane.column)}
                            />
                          </g>
                        ))}
                        {lane.endpointMarkers.map((marker) => {
                          const markerRadius = marker.diameter / 2;
                          const markerHitDiameter = computeConvergeMarkerHitDiameter(marker, hoverHitStrokeWidth);
                          const markerStrokeWidth = Math.max(
                            1,
                            baseStrokeWidth * Math.min(1.2, highlightWidthMultiplier)
                          );
                          const markerOpacity = isHovered || isFilterHighlighted
                            ? 0.98
                            : summaryConnectivityHighlight
                              ? 0.88
                              : (useDimmedVisual ? 0.72 : 0.84);
                          return (
                            <g key={marker.id}>
                              {marker.kind === 'terminate' ? (
                                <circle
                                  cx={marker.x}
                                  cy={marker.y}
                                  r={Math.max(1.2, markerRadius - markerStrokeWidth / 2)}
                                  fill={`url(#${plotClipId}-label-cutout-bg)`}
                                  stroke={strokeColor}
                                  strokeWidth={markerStrokeWidth}
                                  strokeOpacity={markerOpacity}
                                  pointerEvents="none"
                                  data-storyline-converge-marker-kind={marker.kind}
                                />
                              ) : (
                                <circle
                                  cx={marker.x}
                                  cy={marker.y}
                                  r={markerRadius}
                                  fill={resolveConvergeFilledMarkerColor({
                                    markerKind: marker.kind,
                                    isHovered,
                                    isFilterHighlighted,
                                    strokeColor,
                                    forceStrokeColor: isPromotedSelectedExtension,
                                  })}
                                  fillOpacity={markerOpacity}
                                  stroke={isHovered ? strokeColor : 'none'}
                                  strokeWidth={isHovered ? Math.max(0.9, markerStrokeWidth * 0.72) : 0}
                                  pointerEvents="none"
                                  data-storyline-converge-marker-kind={marker.kind}
                                />
                              )}
                              <circle
                                cx={marker.x}
                                cy={marker.y}
                                r={markerHitDiameter / 2}
                                fill="transparent"
                                pointerEvents="all"
                                onMouseDown={(event) => onColumnPointerDown(lane.column, 'converge_marker', event, converge.index)}
                                onClick={(event) => onColumnClick(lane.column, 'converge_marker', event, converge.index)}
                                onContextMenu={(event) => onColumnContextMenu(lane.column, 'converge_marker', event)}
                                onMouseEnter={(event) => onHoverColumn(lane.column, event.clientX, event.clientY)}
                                onMouseMove={(event) => onHoverColumn(lane.column, event.clientX, event.clientY)}
                                onMouseLeave={() => onLeaveColumn(lane.column)}
                              />
                            </g>
                          );
                        })}
                      </>
                    );
                  })()}
                </g>
              ))
            )}

            {layout.boundaryBranches.map((branch) => {
              const convergeIndex = branch.side === 'left' ? branch.turnIndex : branch.turnIndex + 1;
              const laneMode = convergeLaneModeByKey.get(`${convergeIndex}::${branch.column}`);
              const columnFilterState = getColumnFilterState(branch.column);
              const lineFilterState = resolveStorylineColumnFilterLineState({
                hasActiveFilter: isStorylineFilterActive,
                columnFilterState,
                isExactKept: isBranchKeptByFilter(branch.id),
              });
              const emphasis = resolveConvergeColumnEmphasis(branch.column, laneMode);
              const isHovered = emphasis === 'hovered';
              const isConnectivityConnected = selectedSummaryConnectivity.branchIds.has(branch.id);
              const isPromotedSelectedExtension = selectedSummaryExtensionPromotion.branchIds.has(branch.id);
              const forceExtensionVisual =
                !isHovered
                && selectedSummaryConnectivityActive
                && !isConnectivityConnected
                && usesInvolvedConvergeVisual(laneMode);
              const selectedConnectionHighlight = shouldRenderSelectedConnectionHighlight({
                hoveredColumn,
                column: branch.column,
                isSelectedConnection: lineFilterState.isKept && selectedGlyphBranchHighlightIds.has(branch.id),
              });
              const summaryConnectivityHighlight = shouldRenderSelectedSummaryConnectivityHighlight({
                hoveredColumn,
                column: branch.column,
                isConnected: isConnectivityConnected && lineFilterState.isKept,
              });
              const useDimmedVisual =
                emphasis === 'faded' || forceExtensionVisual || !lineFilterState.isKept;
              const isFilterHighlighted = isStorylineFilterActive && lineFilterState.isKept;
              const useInvolvedWidth =
                !useDimmedVisual
                && (usesInvolvedConvergeVisual(laneMode) || isPromotedSelectedExtension);
              const useInvolvedColor =
                !useDimmedVisual
                && (usesInvolvedConvergeVisual(laneMode) || isPromotedSelectedExtension);
              const isHighlighted = isHovered || selectedConnectionHighlight || summaryConnectivityHighlight;
              const baseStrokeWidth =
                (STORYLINE_CONNECTOR_STROKE_WIDTH_PX * layout.adaptiveProfile.trackStrokeScale) / 6
                  * (useInvolvedWidth ? CONVERGE_INVOLVED_SEGMENT_WIDTH_MULTIPLIER : 1);
              const strokeColor = resolveColumnHighlightStrokeColor({
                defaultColor: getTrackStrokeColor(useInvolvedColor),
                isHovered,
                isFilterHighlighted,
                isSelectedConnection: selectedConnectionHighlight,
                selectedConnectionColor: selectedGlyphColumnHighlightColor,
              });
              const highlightWidthMultiplier = isHovered || isFilterHighlighted || selectedConnectionHighlight
                ? COLUMN_HIGHLIGHT_WIDTH_MULTIPLIER
                : summaryConnectivityHighlight
                  ? SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER
                  : 1;
              const strokeOpacity = isHighlighted || isFilterHighlighted
                ? selectedConnectionHighlight || isHovered || isFilterHighlighted
                  ? 0.98
                  : (useInvolvedColor ? 0.94 : 0.86)
                : (useDimmedVisual ? 0.7 : (useInvolvedColor ? 0.88 : 0.75));
              const hoverHitStrokeWidth = computeColumnHoverHitStrokeWidth(baseStrokeWidth, view.zoomX);
              return (
                <g key={branch.id}>
                  <path
                    d={branch.path}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={baseStrokeWidth * highlightWidthMultiplier}
                    strokeOpacity={strokeOpacity}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                  <path
                    d={branch.path}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={hoverHitStrokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    pointerEvents="stroke"
                    onMouseDown={(event) => onColumnPointerDown(branch.column, 'boundary_branch', event, convergeIndex)}
                    onClick={(event) => onColumnClick(branch.column, 'boundary_branch', event, convergeIndex)}
                    onContextMenu={(event) => onColumnContextMenu(branch.column, 'boundary_branch', event)}
                    onMouseEnter={(event) => onHoverColumn(branch.column, event.clientX, event.clientY)}
                    onMouseMove={(event) => onHoverColumn(branch.column, event.clientX, event.clientY)}
                    onMouseLeave={() => onLeaveColumn(branch.column)}
                  />
                </g>
              );
            })}

            {summaryInternalsRenderMode === 'none'
              ? null
              : layout.summaryAreas
                .filter((area) => (
                  summaryInternalsRenderMode === 'all'
                  || (summaryInternalsRenderMode === 'selected_only' && selectedSummaryId === area.summaryId)
                ))
                .map((area) => {
                  const connectedColumns = selectedSummaryConnectivity.summaryColumnsById.get(area.summaryId);
                  const isSelectedSummary = selectedSummaryId === area.summaryId;
                  return area.tracks.map((track) => (
                    <g key={track.id}>
                      {track.segments.map((segment) => {
                        const segmentKey = buildTrackSegmentKey(track.id, segment.id);
                        const columnFilterState = getColumnFilterState(track.column);
                        const lineFilterState = resolveStorylineColumnFilterLineState({
                          hasActiveFilter: isStorylineFilterActive,
                          columnFilterState,
                          isExactKept: isTrackSegmentKeptByFilter(segmentKey),
                        });
                        const emphasis = resolveSummaryColumnEmphasis(track.column);
                        const isHovered = emphasis === 'hovered';
                        const isConnectivityConnected = connectedColumns?.has(track.column) ?? false;
                        const forceExtensionVisual =
                          !isHovered && selectedSummaryConnectivityActive && !isConnectivityConnected;
                        const useDimmedVisual =
                          emphasis === 'faded' || forceExtensionVisual || !lineFilterState.isKept;
                        const isFilterHighlighted = isStorylineFilterActive && lineFilterState.isKept;
                        const selectedConnectionHighlight = shouldRenderSelectedConnectionHighlight({
                          hoveredColumn,
                          column: track.column,
                          isSelectedConnection:
                            lineFilterState.isKept && selectedGlyphConnection.segmentKeys.has(segmentKey),
                        });
                        const summaryConnectivityHighlight = shouldRenderSelectedSummaryConnectivityHighlight({
                          hoveredColumn,
                          column: track.column,
                          isConnected: isConnectivityConnected && lineFilterState.isKept,
                        });
                        const isHighlighted = isHovered || selectedConnectionHighlight || summaryConnectivityHighlight;
                        const baseStrokeWidth =
                          (STORYLINE_CONNECTOR_STROKE_WIDTH_PX * layout.adaptiveProfile.trackStrokeScale) / 6;
                        const hoverHitStrokeWidth = computeColumnHoverHitStrokeWidth(baseStrokeWidth, view.zoomX);
                        const strokeColor = resolveColumnHighlightStrokeColor({
                          defaultColor: getTrackStrokeColor(isSelectedSummary && !useDimmedVisual),
                          isHovered,
                          isFilterHighlighted,
                          isSelectedConnection: selectedConnectionHighlight,
                          selectedConnectionColor: selectedGlyphColumnHighlightColor,
                        });
                        const strokeOpacity =
                          isHighlighted || isFilterHighlighted
                            ? selectedConnectionHighlight || isHovered || isFilterHighlighted
                              ? 0.98
                              : (segment.dashed ? 0.84 : 0.92)
                            : useDimmedVisual
                              ? (segment.dashed ? 0.58 : 0.66)
                              : (segment.dashed ? 0.76 : 0.86);
                        return (
                          <g key={`${track.id}:${segment.id}`}>
                            <path
                              d={segment.path}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth={baseStrokeWidth}
                              strokeOpacity={strokeOpacity}
                              strokeDasharray={segment.dashed ? '5 4' : undefined}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              pointerEvents="none"
                            />
                            <path
                              d={segment.path}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={hoverHitStrokeWidth}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              pointerEvents="stroke"
                              onMouseDown={(event) => {
                                const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                                const localWorldX =
                                  svgRect
                                    ? event.clientX - svgRect.left - view.tx
                                    : (area.left + area.right) / 2;
                                const anchorConvergeIndex =
                                  localWorldX <= (area.left + area.right) / 2
                                    ? area.turnIndex
                                    : area.turnIndex + 1;
                                onColumnPointerDown(track.column, 'summary_track', event, anchorConvergeIndex);
                              }}
                              onClick={(event) => {
                                const svgRect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                                const localWorldX =
                                  svgRect
                                    ? event.clientX - svgRect.left - view.tx
                                    : (area.left + area.right) / 2;
                                const anchorConvergeIndex =
                                  localWorldX <= (area.left + area.right) / 2
                                    ? area.turnIndex
                                    : area.turnIndex + 1;
                                onColumnClick(track.column, 'summary_track', event, anchorConvergeIndex);
                              }}
                              onContextMenu={(event) => onColumnContextMenu(track.column, 'summary_track', event)}
                              onMouseEnter={(event) => onHoverColumn(track.column, event.clientX, event.clientY)}
                              onMouseMove={(event) => onHoverColumn(track.column, event.clientX, event.clientY)}
                              onMouseLeave={() => onLeaveColumn(track.column)}
                            />
                          </g>
                        );
                      })}
                    </g>
                  ));
                })}

            {visibleTrackLabels.map((label) => {
              if (!label.connector) return null;
              const isHovered = hoveredColumn === label.column;
              const isConvergeIndicator = isConvergeLabelId(label.id);
              const convergeVisualState = isConvergeIndicator
                ? resolveConvergeLabelVisualState(label.id)
                : null;
              const filterHighlighted = convergeVisualState?.filterHighlighted ?? false;
              const columnFilterState = getColumnFilterState(label.column);
              const connectorOpacity = isConvergeIndicator
                ? (isHovered ? 1 : (convergeVisualState?.connectorOpacity ?? 1))
                : (!isStorylineFilterActive || columnFilterState !== 'none' ? 1 : FILTERED_INDICATOR_TEXT_OPACITY);
              return (
                <line
                  key={`label-connector-${label.id}`}
                  x1={label.connector.fromX}
                  y1={label.connector.fromY}
                  x2={label.connector.toX}
                  y2={label.connector.toY}
                  stroke={isHovered || filterHighlighted ? HOVER_COLUMN_HIGHLIGHT_HEX : '#94a3b8'}
                  strokeWidth={((isHovered || filterHighlighted) ? 1.2 : 1) * layout.adaptiveProfile.labelScale}
                  strokeOpacity={connectorOpacity}
                  strokeDasharray="3 3"
                  strokeLinecap="round"
                  pointerEvents="none"
                  data-storyline-converge-indicator-connector={isConvergeIndicator ? 'true' : undefined}
                />
              );
            })}

            {visibleTrackLabels.map((label) => {
              const isHovered = hoveredColumn === label.column;
              const isConvergeIndicator = isConvergeLabelId(label.id);
              const interactionSource: StorylineColumnInteractionSource = isConvergeIndicator
                ? 'converge_indicator'
                : 'summary_track';
              const convergeVisualState = isConvergeIndicator
                ? resolveConvergeLabelVisualState(label.id)
                : null;
              const columnFilterState = getColumnFilterState(label.column);
              const textOpacity = isConvergeIndicator
                ? (isHovered ? 1 : (convergeVisualState?.textOpacity ?? 1))
                : (!isStorylineFilterActive || columnFilterState !== 'none' ? 1 : FILTERED_INDICATOR_TEXT_OPACITY);
              const hoverPadding = computeIndicatorHoverPaddingPx(view.zoomX);
              const labelText = isConvergeIndicator
                ? label.column
                : `${label.column} (${label.pointCount})`;
              const textColor = isConvergeIndicator
                ? resolveConvergeLabelTextColor(label.id, isHovered)
                : isHovered
                  ? HOVER_COLUMN_HIGHLIGHT_HEX
                  : '#111827';
              const convergeMaskTone = convergeVisualState?.maskTone ?? 'default';
              const indicatorBadgeKind = columnSteeringBadgeKindsByIndicatorId.get(label.id) ?? null;
              const columnBadgeKind =
                indicatorBadgeKind
                ?? (isConvergeIndicator ? (columnSteeringBadgeKinds.get(label.column) ?? null) : null);
              const columnBadgeEntryId =
                columnSteeringEntryIdsByIndicatorId.get(label.id)
                ?? (isConvergeIndicator ? (columnSteeringEntryIdsByName.get(label.column) ?? null) : null);
              const columnBadgeBounds =
                isConvergeIndicator && columnBadgeKind && columnBadgeEntryId
                  ? resolveStorylineSoftSteeringBadgeBounds({
                    anchorX: label.x + label.width,
                    anchorY: label.top,
                    scope: 'column',
                    paddingPx: 3,
                  })
                  : null;

              return (
                <g
                  key={`embedded-label-${label.id}`}
                  data-storyline-interactive="true"
                  data-storyline-converge-indicator={isConvergeIndicator ? 'true' : undefined}
                  data-storyline-converge-indicator-mask-tone={isConvergeIndicator ? convergeMaskTone : undefined}
                  data-storyline-converge-indicator-anchor={isConvergeIndicator ? (convergeVisualState?.anchor ?? 'converge') : undefined}
                  onMouseDown={(event) => onColumnPointerDown(
                    label.column,
                    interactionSource,
                    event,
                    isConvergeIndicator ? parseConvergeLabelId(label.id)?.convergeIndex : undefined
                  )}
                  onClick={(event) => onColumnClick(
                    label.column,
                    interactionSource,
                    event,
                    isConvergeIndicator ? parseConvergeLabelId(label.id)?.convergeIndex : undefined
                  )}
                  onContextMenu={(event) => onColumnContextMenu(label.column, interactionSource, event)}
                  onMouseEnter={(event) => onHoverColumn(label.column, event.clientX, event.clientY)}
                  onMouseMove={(event) => onHoverColumn(label.column, event.clientX, event.clientY)}
                  onMouseLeave={() => onLeaveColumn(label.column)}
                >
                  <rect
                    x={label.x - hoverPadding}
                    y={label.top - hoverPadding}
                    width={label.width + hoverPadding * 2}
                    height={label.maskHeight + hoverPadding * 2}
                    rx={Math.max(1.8, label.maskHeight * 0.22 + hoverPadding * 0.65)}
                    fill="transparent"
                    pointerEvents="all"
                  />
                  {isConvergeIndicator ? (
                    <rect
                      x={label.x}
                      y={label.top}
                      width={label.width}
                      height={label.maskHeight}
                      rx={Math.max(1.8, label.maskHeight * 0.22)}
                      fill={`url(#${plotClipId}-label-cutout-bg)`}
                      fillOpacity={0.98}
                      stroke={isHovered ? HOVER_COLUMN_HIGHLIGHT_HEX : 'none'}
                      strokeWidth={isHovered ? Math.max(0.9, label.fontSize * 0.08) : 0}
                      data-storyline-converge-indicator-mask={isConvergeIndicator ? 'base' : undefined}
                    />
                  ) : (
                    <>
                      <rect
                        x={label.x}
                        y={label.top}
                        width={label.width}
                        height={label.maskHeight}
                        rx={Math.max(1.8, label.maskHeight * 0.22)}
                        fill={`url(#${plotClipId}-label-cutout-bg)`}
                        fillOpacity={1}
                        stroke={isHovered ? HOVER_COLUMN_HIGHLIGHT_HEX : 'none'}
                        strokeWidth={isHovered ? Math.max(0.9, label.fontSize * 0.08) : 0}
                      />
                      <rect
                        x={label.x}
                        y={label.top}
                        width={label.width}
                        height={label.maskHeight}
                        rx={Math.max(1.8, label.maskHeight * 0.22)}
                        fill={SUMMARY_AREA_FILL_HEX}
                        fillOpacity={isHovered ? Math.min(1, SUMMARY_AREA_FILL_OPACITY + 0.15) : SUMMARY_AREA_FILL_OPACITY}
                      />
                    </>
                  )}
                  <text
                    x={label.x + label.width / 2}
                    y={label.top + label.maskHeight / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={textColor}
                    fillOpacity={textOpacity}
                    fontSize={label.fontSize}
                    fontWeight={isHovered ? 700 : 650}
                    pointerEvents="none"
                  >
                    {labelText}
                  </text>
                  {columnBadgeBounds && columnBadgeEntryId ? (
                    <rect
                      x={columnBadgeBounds.x}
                      y={columnBadgeBounds.y}
                      width={columnBadgeBounds.width}
                      height={columnBadgeBounds.height}
                      rx={columnBadgeBounds.rx}
                      fill="transparent"
                      pointerEvents="all"
                      data-storyline-interactive="true"
                      data-storyline-soft-steering-badge-hit-target="column"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => handleSteeringBadgeClick(columnBadgeEntryId, event)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    />
                  ) : null}
                  {isConvergeIndicator && columnBadgeKind
                    ? (
                      <StorylineSoftSteeringIcon
                        kind={columnBadgeKind}
                        anchorX={label.x + label.width}
                        anchorY={label.top}
                        scope="column"
                      />
                    )
                    : null}
                </g>
              );
            })}

            {summaryInternalsRenderMode === 'none'
              ? null
              : layout.nodes
                .filter((node) => (
                  summaryInternalsRenderMode === 'all'
                  || (summaryInternalsRenderMode === 'selected_only' && selectedSummaryId === node.summaryId)
                ))
                .map((node) => {
                  const selectedByAtomic =
                    selectionHighlightPolicy.preserveGlyphSelection && selectedAtomicNodeId === node.id;
                  const selectedBySummary =
                    selectionHighlightPolicy.preserveGlyphSelection
                    && !selectedAtomicNodeId
                    && selectedSummaryId !== null
                    && selectedSummaryId === node.summaryId;
                  const isSelected = selectedByAtomic || selectedBySummary;
                  const isDimmedByFilter = !isNodeKeptByFilter(node.id);
                  const isSharedColumnRelated = selectedSummarySharedColumnIds.has(node.summaryId);
                  const connectivityOpacity = !selectedSummaryConnectivityActive
                    ? 1
                    : isSelected
                      ? 1
                      : isSharedColumnRelated
                        ? CONNECTED_SUMMARY_GLYPH_OPACITY
                        : 0.24;
                  const opacity = connectivityOpacity * (isDimmedByFilter ? 0.2 : 1);
                  return (
                    <StorylineAtomicGlyph
                      key={node.id}
                      node={node}
                      isSelected={isSelected}
                      opacity={opacity}
                      steeringKind={atomicSteeringBadgeKinds.get(node.id) ?? null}
                      steeringEntryId={atomicSteeringEntryIdsByKey.get(node.id) ?? null}
                      onSelect={onAtomicSelect}
                      onSteeringBadgeClick={onConversationEntryFocusRequest}
                      onHoverStart={onHoverAtomicGlyph}
                      onHoverMove={onHoverAtomicGlyph}
                      onHoverEnd={onLeaveAtomicGlyph}
                    />
                  );
                })}
          </g>
        </g>
          </svg>

          {activePlanAreas.map((area) => {
            const isSelected = selectedPlanId === area.planId;
            const isCreateOrigin = createOriginPlanIds.has(area.planId);
            const pendingAction = planControlPendingById[area.planId] ?? null;
            const isEditing = editingPlanId === area.planId;
            const planCardState = {
              plan_id: area.planId,
              text: area.text,
              short_label: area.shortLabel,
              status: area.status,
              control_state: area.controlState,
              launch_requested: area.launchRequested,
            };
            return (
              <div
                key={area.id}
                data-storyline-interactive="true"
                data-storyline-active-plan-id={area.planId}
                data-storyline-active-plan-create-origin={isCreateOrigin ? 'true' : undefined}
                className={[
                  'absolute z-20',
                ].join(' ').trim()}
                style={{
                  left: view.tx + area.left,
                  top: plotTopOffset + layoutVerticalOffset + area.top,
                  width: area.width,
                  height: area.height,
                }}
                onMouseEnter={(event) => onHoverActivePlanArea(
                  area.planId,
                  area.status,
                  area.text,
                  event.clientX,
                  event.clientY
                )}
                onMouseMove={(event) => onHoverActivePlanArea(
                  area.planId,
                  area.status,
                  area.text,
                  event.clientX,
                  event.clientY
                )}
                onMouseLeave={() => onLeaveActivePlanArea(area.planId)}
              >
                <PlanDispatchCard
                  planId={area.planId}
                  plan={planCardState}
                  selected={isSelected}
                  pendingAction={pendingAction}
                  disablePendingLaunchControl={disablePendingPlanLaunch}
                  variant="storyline"
                  accentVariant={isCreateOrigin ? 'create' : 'default'}
                  hidePlanText={!showActivePlanText}
                  isEditing={isEditing}
                  modifyDraft={isEditing ? editingPlanDraft : ''}
                  disableModifyControl={editingPlanId !== null && editingPlanId !== area.planId}
                  onModifyStart={() => onPlanModifyStart?.(area.planId)}
                  onModifyDraftChange={onPlanModifyDraftChange}
                  onModifyCancel={onPlanModifyCancel}
                  onModifySubmit={() => onPlanModifySubmit?.(area.planId)}
                  style={isEditing ? { height: '100%' } : undefined}
                  onSelect={() => onActivePlanSelect(area.planId)}
                  onControl={(action) => {
                    void onPlanControl(area.planId, action);
                  }}
                />
              </div>
            );
          })}

          {layout.converges.map((converge) => {
            const buttons = convergeSummaryButtonsByIndex.get(converge.index) ?? [];
            if (buttons.length === 0) {
              return null;
            }
            const stageButtons = buttons.filter((button) => button.kind === 'stage');
            const finalButtons = buttons.filter((button) => button.kind === 'final');
            const convergeWidth = Math.max(0, converge.xEnd - converge.xStart);
            const buttonHorizontalPaddingPx = showConvergeSummaryButtonText ? 6 : 2;
            const iconSizePx = showConvergeSummaryButtonText
              ? 14
              : Math.max(2, Math.min(10, convergeWidth - buttonHorizontalPaddingPx * 2 - 2));
            const buttonHeightPx = showConvergeSummaryButtonText
              ? 24
              : Math.max(12, iconSizePx + 4);
            const buttonGapPx = showConvergeSummaryButtonText ? 4 : 2;
            const topConvergeVisualTop = topConvergeVisualTopByIndex.get(converge.index);
            const bottomConvergeVisualBottom = bottomConvergeVisualBottomByIndex.get(converge.index);
            const renderConvergeSummaryBand = (
              bandButtons: StorylineConvergeSummaryButton[],
              bandKind: 'stage' | 'final'
            ) => {
              if (bandButtons.length === 0) {
                return null;
              }
              const buttonBandHeightPx =
                bandButtons.length * buttonHeightPx + Math.max(0, bandButtons.length - 1) * buttonGapPx;
              const bandWorldTop = bandKind === 'stage'
                ? (
                  topConvergeVisualTop == null
                    ? layout.plotMinY + 8
                    : topConvergeVisualTop - buttonBandHeightPx - convergeSummaryButtonClearancePx
                )
                : (
                  bottomConvergeVisualBottom == null
                    ? layout.plotMaxY - buttonBandHeightPx - 8
                    : bottomConvergeVisualBottom + convergeSummaryButtonClearancePx
                );
              return (
                <div
                  key={`converge-summary-buttons-${converge.index}-${bandKind}`}
                  data-storyline-converge-summary-band={converge.index}
                  data-storyline-converge-summary-band-kind={bandKind}
                  data-storyline-converge-summary-band-top={Math.round(bandWorldTop)}
                  data-storyline-converge-summary-band-anchor-top={
                    bandKind === 'stage' && topConvergeVisualTop != null
                      ? Math.round(topConvergeVisualTop)
                      : undefined
                  }
                  data-storyline-converge-summary-band-anchor-bottom={
                    bandKind === 'final' && bottomConvergeVisualBottom != null
                      ? Math.round(bottomConvergeVisualBottom)
                      : undefined
                  }
                  className="absolute z-20 flex flex-col"
                  style={{
                    left: view.tx + converge.xStart,
                    top: plotTopOffset + layoutVerticalOffset + bandWorldTop,
                    width: convergeWidth,
                    gap: `${buttonGapPx}px`,
                  }}
                >
                  {bandButtons.map((button) => {
                    const isFinal = button.kind === 'final';
                    const Icon = isFinal ? CheckCheck : Gauge;
                    return (
                      <button
                        key={button.id}
                        type="button"
                        data-storyline-interactive="true"
                        data-storyline-converge-summary-button={button.entryId}
                        data-storyline-converge-summary-kind={button.kind}
                        data-storyline-converge-summary-icon-size={Math.round(iconSizePx)}
                        className={[
                          'flex w-full items-center justify-center overflow-hidden rounded-md border font-semibold shadow-sm backdrop-blur-sm transition',
                          showConvergeSummaryButtonText ? 'gap-1 px-1.5 text-[11px]' : 'gap-0 px-0.5',
                          isFinal
                            ? (
                              'border-emerald-300 bg-emerald-100/95 text-emerald-800 hover:bg-emerald-200/95 active:border-emerald-400 active:bg-emerald-200/95 active:text-emerald-900'
                            )
                            : (
                              'border-amber-300 bg-amber-100/95 text-amber-800 hover:bg-amber-200/95 active:border-amber-400 active:bg-amber-200/95 active:text-amber-900'
                            ),
                        ].join(' ')}
                        style={{
                          height: `${buttonHeightPx}px`,
                        }}
                        onClick={() => onConvergeSummaryButtonClick(button.entryId)}
                      >
                        <Icon
                          className="shrink-0"
                          style={{
                            width: `${iconSizePx}px`,
                            height: `${iconSizePx}px`,
                          }}
                        />
                        {showConvergeSummaryButtonText ? (
                          <span className="truncate">{isFinal ? 'Final Summary' : 'Stage Summary'}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            };
            return (
              [
                renderConvergeSummaryBand(stageButtons, 'stage'),
                renderConvergeSummaryBand(finalButtons, 'final'),
              ]
            );
          })}

          {taxonomyLegendItems.length > 0 ? (
            <div
              data-storyline-top-rail-card="legend"
              className="pointer-events-auto absolute z-30 inline-flex items-center rounded-xl border border-slate-200 bg-white/90 px-2.5 py-2 shadow-sm backdrop-blur-sm"
              style={{
                left: `${legendLeftPx}px`,
                top: `${legendTopPx}px`,
                width: `${legendWidthPx}px`,
                minHeight: `${topRailHeightPx}px`,
              }}
            >
              <div className="flex w-full flex-col items-center justify-center gap-y-1">
                {legendRows.map((rowItems, rowIndex) => (
                  <div
                    key={`legend-row-${rowIndex + 1}`}
                    data-storyline-legend-row={rowIndex + 1}
                    className="flex w-full items-center justify-center gap-x-2.5"
                  >
                    {rowItems.map((item) => {
                      const legendState = storylineFilterSnapshot.rowStates.get(item.id) ?? 'none';
                      const legendVisual = getLegendItemVisualState({
                        triState: legendState,
                        hasActiveFilter: storylineFilterSnapshot.hasActiveFilter,
                      });
                      return (
                        <button
                          key={`taxonomy-${item.id}`}
                          type="button"
                          data-storyline-interactive="true"
                          data-storyline-legend-key={`taxonomy:${item.id}`}
                          data-storyline-filter-state={legendState}
                          className="inline-flex items-center gap-1 rounded-md px-1 py-px text-left text-[12px] leading-none transition-colors hover:bg-slate-100/80"
                          style={{
                            color: legendVisual.color,
                            opacity: legendVisual.opacity,
                            fontWeight: legendVisual.fontWeight,
                            background: legendVisual.background,
                          }}
                          onClick={() => onLegendToggle(item.id)}
                        >
                          <svg
                            width={18}
                            height={18}
                            viewBox="-8 -8 16 16"
                            overflow="visible"
                            aria-hidden="true"
                          >
                            <InsightTypeGlyphMark
                              insightType={item.id}
                              size={16 * LEGEND_SCALE}
                              color={item.color}
                            />
                          </svg>
                          <span className="font-medium">{item.label}</span>
                          <span className="text-slate-500">({item.count})</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div
            data-storyline-interactive="true"
            className="absolute bottom-4 right-4 z-30 rounded-lg border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm"
          >
            {Math.round(view.zoomX * 100)}%
          </div>

          {hoveredTrack ? (
            <div
              className="pointer-events-none absolute z-40 rounded-md border border-slate-300/90 bg-white/95 px-2 py-1 text-[11px] font-medium text-slate-700 shadow-sm"
              style={{
                left: hoveredTrack.x + 12,
                top: hoveredTrack.y + 12,
              }}
            >
              {hoveredTrack.column}
            </div>
          ) : null}

          {hoveredAtomicPreview ? (
            <div
              data-storyline-hover-atomic-card="true"
              className="pointer-events-none absolute z-40 w-[32rem] max-w-[calc(100%-1.5rem)]"
              style={{
                left: hoveredAtomicCardLeft,
                top: hoveredAtomicCardTop,
              }}
            >
              <InspectorAtomicInsightCard
                runId={hoveredAtomicPreview.runId}
                atomic={hoveredAtomicPreview.atomic}
                index={hoveredAtomicPreview.index}
                showMetrics={false}
                showCodeEvidence={false}
                showOutputEvidence={false}
                enablePlotZoom={false}
                className="border-slate-300 bg-white/95 shadow-xl backdrop-blur-sm"
              />
            </div>
          ) : null}
          {hoveredSummaryPreview ? (
            <div
              data-storyline-hover-summary-card="true"
              className="pointer-events-none absolute z-40 w-[28rem] max-w-[calc(100%-1.5rem)] rounded-2xl border border-slate-300 bg-white/95 px-4 py-3 shadow-xl backdrop-blur-sm"
              style={{
                left: hoveredSummaryCardLeft,
                top: hoveredSummaryCardTop,
              }}
            >
              {hoveredSummaryPreview.sourceTask ? (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Source Task
                  </div>
                  <div className="mt-1 text-sm font-medium leading-6 text-slate-800">
                    {hoveredSummaryPreview.sourceTask}
                  </div>
                </div>
              ) : null}
              <div className={hoveredSummaryPreview.sourceTask ? 'mt-3' : ''}>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Summary
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                  {hoveredSummaryPreview.summaryText}
                </div>
              </div>
            </div>
          ) : null}
          {hoveredPlanPreview && !activeSteeringPen ? (
            <div
              data-storyline-hover-plan-card="true"
              className="pointer-events-none absolute z-40 w-[20rem] max-w-[calc(100%-1.5rem)] rounded-2xl border border-slate-300 bg-white/95 px-4 py-3 shadow-xl backdrop-blur-sm"
              style={{
                left: hoveredPlanCardLeft,
                top: hoveredPlanCardTop,
              }}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Analysis Plan
              </div>
              <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {hoveredPlanPreview.text}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
