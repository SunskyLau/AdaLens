import {
  STORYLINE_TRACK_UNINVOLVED_COLOR_HEX,
} from '@/config';
import type { Selection } from '@/types';
import { clamp } from './storylineGraphLayout';
import type {
  StorylineConvergeLaneMode,
  StorylineTurnConvergeLayout,
} from './storylineTurnConvergeLayout';
import { shouldRenderSummaryInternals } from './storylineTurnConvergeLayout';
import type { StorylineColumnTrack, StorylineNodeGeometry } from './storylineGraphLayout';
import type { StorylineFilterTriState } from './storylineFilter';

export type SummaryInternalsRenderMode = 'all' | 'selected_only' | 'none';

export interface StorylineLinePointerDown {
  column: string;
  source: StorylineColumnInteractionSource;
  convergeIndex?: number;
  clientX: number;
  clientY: number;
}

export interface StorylineCanvasPointerDown {
  clientX: number;
  clientY: number;
}

export type StorylineColumnInteractionSource =
  | 'converge_lane'
  | 'converge_marker'
  | 'converge_indicator'
  | 'summary_track'
  | 'boundary_branch';

export type StorylineModifierPlatform = 'mac' | 'non_mac';
export type StorylineColumnClickMode = 'exclusive' | 'group_toggle';

const MINIMAP_TOP_PX = 10;
const MINIMAP_WIDTH_RATIO = 0.56;
const MINIMAP_WIDTH_MIN_PX = 320;
const MINIMAP_SIDE_MARGIN_PX = 28;
const MINIMAP_HEIGHT_PX = 52;
const MINIMAP_CARD_PADDING_PX = 8;
const MINIMAP_POINT_BASE_INNER_HEIGHT_PX = MINIMAP_HEIGHT_PX - MINIMAP_CARD_PADDING_PX * 2;
const MINIMAP_POINT_GLYPH_SCALE = 0.24;
const MINIMAP_POINT_MIN_HEIGHT_RATIO = 0.03;
const MINIMAP_POINT_MAX_HEIGHT_RATIO = 0.29;
const STORYLINE_BODY_GAP_BELOW_MINIMAP_PX = 10;
const STORYLINE_BODY_BOTTOM_PADDING_PX = 8;
const STORYLINE_Y_TOP_GAP_BELOW_MINIMAP_PX = 8;
const STORYLINE_Y_BOTTOM_GAP_ABOVE_ZOOM_BADGE_PX = 8;
const ZOOM_BADGE_BOTTOM_PX = 16;
const ZOOM_BADGE_ESTIMATED_HEIGHT_PX = 32;
const STORYLINE_BG_TOP_HEX = '#fcfcfd';
const STORYLINE_BG_BOTTOM_HEX = '#f4f7fb';
const SUMMARY_AREA_FILL_HEX = '#e5e7eb';
const SUMMARY_AREA_FILL_OPACITY = 0.65;
const SELECTED_SUMMARY_FILL_OPACITY = 0.82;
const SELECTED_SUMMARY_STROKE_WIDTH_PX = 2.15;
const CONNECTED_SUMMARY_FILL_OPACITY = 0.48;
const CONNECTED_SUMMARY_STROKE_OPACITY = 0.56;
const CONNECTED_SUMMARY_GLYPH_OPACITY = 0.74;
const SUMMARY_TITLE_FILL_HEX = '#dbe2ea';
const SUMMARY_TITLE_TEXT_HEX = '#0f172a';
const SUMMARY_TITLE_SIDE_PADDING_PX = 8;
const SUMMARY_TITLE_FONT_MIN_PX = 12.4;
const SUMMARY_TITLE_FONT_MAX_PX = 29;
const AREA_INVOLVED_SEGMENT_WIDTH_MULTIPLIER = 2.05;
const CONVERGE_INVOLVED_SEGMENT_WIDTH_MULTIPLIER = 2.28;
const LEGEND_SCALE = 0.9;
const HOVER_COLUMN_HIGHLIGHT_HEX = '#0066cc';
const COLUMN_HIGHLIGHT_WIDTH_MULTIPLIER = 1.36;
const SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER = 1.26;
const COLUMN_HOVER_HIT_WIDTH_MIN_PX = 6.4;
const COLUMN_HOVER_HIT_WIDTH_MAX_LOW_ZOOM_PX = 26;
const INDICATOR_HOVER_PADDING_BASE_PX = 2.2;
const INDICATOR_HOVER_PADDING_MAX_LOW_ZOOM_PX = 11;
const STORYLINE_COLUMN_CLICK_MAX_DISTANCE_PX = 4;
const FILTERED_INDICATOR_TEXT_OPACITY = 0.42;

export {
  AREA_INVOLVED_SEGMENT_WIDTH_MULTIPLIER,
  COLUMN_HIGHLIGHT_WIDTH_MULTIPLIER,
  CONVERGE_INVOLVED_SEGMENT_WIDTH_MULTIPLIER,
  CONNECTED_SUMMARY_FILL_OPACITY,
  CONNECTED_SUMMARY_GLYPH_OPACITY,
  CONNECTED_SUMMARY_STROKE_OPACITY,
  FILTERED_INDICATOR_TEXT_OPACITY,
  HOVER_COLUMN_HIGHLIGHT_HEX,
  LEGEND_SCALE,
  SELECTED_SUMMARY_FILL_OPACITY,
  SELECTED_SUMMARY_STROKE_WIDTH_PX,
  SUMMARY_AREA_FILL_HEX,
  SUMMARY_AREA_FILL_OPACITY,
  SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER,
  SUMMARY_TITLE_FILL_HEX,
  SUMMARY_TITLE_TEXT_HEX,
};

export const STORYLINE_GRAPH_RENDER_CONSTANTS = {
  MINIMAP_TOP_PX,
  MINIMAP_WIDTH_RATIO,
  MINIMAP_WIDTH_MIN_PX,
  MINIMAP_SIDE_MARGIN_PX,
  MINIMAP_HEIGHT_PX,
  MINIMAP_CARD_PADDING_PX,
  MINIMAP_POINT_BASE_INNER_HEIGHT_PX,
  MINIMAP_POINT_GLYPH_SCALE,
  MINIMAP_POINT_MIN_HEIGHT_RATIO,
  MINIMAP_POINT_MAX_HEIGHT_RATIO,
  STORYLINE_BODY_GAP_BELOW_MINIMAP_PX,
  STORYLINE_BODY_BOTTOM_PADDING_PX,
  STORYLINE_Y_TOP_GAP_BELOW_MINIMAP_PX,
  STORYLINE_Y_BOTTOM_GAP_ABOVE_ZOOM_BADGE_PX,
  ZOOM_BADGE_BOTTOM_PX,
  ZOOM_BADGE_ESTIMATED_HEIGHT_PX,
  STORYLINE_BG_TOP_HEX,
  STORYLINE_BG_BOTTOM_HEX,
};

export interface SelectedGlyphConnectionHighlight {
  segmentKeys: Set<string>;
  columns: Set<string>;
  reachLeftBoundaryColumns: Set<string>;
  reachRightBoundaryColumns: Set<string>;
}

export interface SelectedSummaryConnectivityHighlight {
  summaryIds: Set<string>;
  summaryColumnsById: Map<string, Set<string>>;
  branchIds: Set<string>;
  convergeLaneKeys: Set<string>;
}

export interface SelectedSummaryExtensionPromotionHighlight {
  branchIds: Set<string>;
  convergeLaneKeys: Set<string>;
}

export function createEmptySelectedGlyphConnectionHighlight(): SelectedGlyphConnectionHighlight {
  return {
    segmentKeys: new Set<string>(),
    columns: new Set<string>(),
    reachLeftBoundaryColumns: new Set<string>(),
    reachRightBoundaryColumns: new Set<string>(),
  };
}

export function createEmptySelectedSummaryConnectivityHighlight(): SelectedSummaryConnectivityHighlight {
  return {
    summaryIds: new Set<string>(),
    summaryColumnsById: new Map<string, Set<string>>(),
    branchIds: new Set<string>(),
    convergeLaneKeys: new Set<string>(),
  };
}

export function createEmptySelectedSummaryExtensionPromotionHighlight(): SelectedSummaryExtensionPromotionHighlight {
  return {
    branchIds: new Set<string>(),
    convergeLaneKeys: new Set<string>(),
  };
}

export function buildTrackSegmentKey(trackId: string, segmentId: string): string {
  return `${trackId}::${segmentId}`;
}

function buildSummaryConnectivityBranchKey(
  summaryId: string,
  column: string,
  side: 'left' | 'right'
): string {
  return `${summaryId}::${side}::${column}`;
}

export function buildSummaryConnectivityConvergeLaneKey(convergeIndex: number, column: string): string {
  return `${convergeIndex}::${column}`;
}

export function resolveColumnHighlightStrokeColor(args: {
  defaultColor: string;
  isHovered: boolean;
  isFilterHighlighted?: boolean;
  isSelectedConnection: boolean;
  selectedConnectionColor: string | null;
}): string {
  const {
    defaultColor,
    isHovered,
    isFilterHighlighted = false,
    isSelectedConnection,
    selectedConnectionColor,
  } = args;
  if (isHovered) return HOVER_COLUMN_HIGHLIGHT_HEX;
  if (isSelectedConnection && selectedConnectionColor) return selectedConnectionColor;
  if (isFilterHighlighted) return HOVER_COLUMN_HIGHLIGHT_HEX;
  return defaultColor;
}

export function resolveConvergeIndicatorTextColor(args: {
  mode: StorylineConvergeLaneMode | undefined;
  hovered: boolean;
  filterHighlighted?: boolean;
  forceUninvolved?: boolean;
}): string {
  const { mode, hovered, filterHighlighted = false, forceUninvolved = false } = args;
  if (hovered) return HOVER_COLUMN_HIGHLIGHT_HEX;
  if (filterHighlighted) return HOVER_COLUMN_HIGHLIGHT_HEX;
  if (forceUninvolved || mode === 'left_extension') return STORYLINE_TRACK_UNINVOLVED_COLOR_HEX;
  if (mode === 'right_extension') return '#0e7490';
  return '#111827';
}

export function deriveStorylineSelectionHighlightPolicy(hasActiveFilter: boolean): {
  preserveSummaryAreaSelection: boolean;
  preserveGlyphSelection: boolean;
  preserveGlyphDirectConnections: boolean;
  preserveSummaryConnectivityLines: boolean;
} {
  return {
    preserveSummaryAreaSelection: true,
    preserveGlyphSelection: true,
    preserveGlyphDirectConnections: true,
    preserveSummaryConnectivityLines: !hasActiveFilter,
  };
}

export function resolveConvergeFilledMarkerColor(args: {
  markerKind: 'start' | 'isolated';
  isHovered: boolean;
  isFilterHighlighted: boolean;
  strokeColor: string;
  forceStrokeColor?: boolean;
}): string {
  const { markerKind, isHovered, isFilterHighlighted, strokeColor, forceStrokeColor = false } = args;
  if (forceStrokeColor) {
    return strokeColor;
  }
  if (markerKind === 'start') {
    return isHovered ? strokeColor : STORYLINE_TRACK_UNINVOLVED_COLOR_HEX;
  }
  return isHovered || isFilterHighlighted
    ? strokeColor
    : STORYLINE_TRACK_UNINVOLVED_COLOR_HEX;
}

function estimateSummaryTitleCharacterWidthPx(character: string, fontSizePx: number): number {
  if (/\s/.test(character)) {
    return fontSizePx * 0.24;
  }
  if (/[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(character)) {
    return fontSizePx * 0.92;
  }
  if (/[mwMW@#%&]/.test(character)) {
    return fontSizePx * 0.74;
  }
  if (/[A-Z]/.test(character)) {
    return fontSizePx * 0.54;
  }
  if (/[ilI1|.,'`:;]/.test(character)) {
    return fontSizePx * 0.26;
  }
  if (/[\-_/\\()[\]{}]/.test(character)) {
    return fontSizePx * 0.32;
  }
  if (/\d/.test(character)) {
    return fontSizePx * 0.5;
  }
  return fontSizePx * 0.48;
}

function estimateSummaryTitleWidthPx(label: string, fontSizePx: number): number {
  let width = 0;
  for (const character of label) {
    width += estimateSummaryTitleCharacterWidthPx(character, fontSizePx);
  }
  return width;
}

export function computeSummaryAreaTitleTextMetrics(args: {
  width: number;
  titleBandHeight: number;
  label: string;
  labelScale: number;
}): {
  fontSize: number;
  paddingX: number;
  shouldCompress: boolean;
} {
  const { width, titleBandHeight, label, labelScale } = args;
  const normalizedLabel = String(label || '').replace(/\s+/g, ' ').trim();
  const paddingX = clamp(width * 0.024, SUMMARY_TITLE_SIDE_PADDING_PX, 14);
  const availableWidth = Math.max(24, width - paddingX * 2);
  const safeLabelLength = Math.max(1, normalizedLabel.length);
  const fontSizeByWidth = availableWidth / Math.max(3.8, safeLabelLength * 0.58);
  const fontSizeByHeight = titleBandHeight * 0.72;
  const scaledFontSize = Math.min(fontSizeByWidth, fontSizeByHeight) * clamp(labelScale, 0.9, 1.15);
  const fontSize = clamp(scaledFontSize, SUMMARY_TITLE_FONT_MIN_PX, SUMMARY_TITLE_FONT_MAX_PX);
  const estimatedTextWidth = estimateSummaryTitleWidthPx(normalizedLabel, fontSize);
  return {
    fontSize,
    paddingX,
    shouldCompress: estimatedTextWidth > availableWidth,
  };
}

export function buildSummaryTitleBandPath(args: {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cornerRadius: number;
  inset: number;
}): string {
  const { left, right, top, bottom, cornerRadius, inset } = args;
  const x0 = left + inset;
  const x1 = right - inset;
  const y0 = top + inset;
  const y1 = Math.max(y0 + 1, bottom);
  const radius = clamp(
    cornerRadius - inset,
    0,
    Math.min((x1 - x0) / 2, Math.max(0, y1 - y0))
  );
  return [
    `M ${x0 + radius} ${y0}`,
    `H ${x1 - radius}`,
    `Q ${x1} ${y0} ${x1} ${y0 + radius}`,
    `V ${y1}`,
    `H ${x0}`,
    `V ${y0 + radius}`,
    `Q ${x0} ${y0} ${x0 + radius} ${y0}`,
    'Z',
  ].join(' ');
}

export function computeColumnHoverHitStrokeWidth(visibleStrokeWidth: number, zoomX: number): number {
  const safeVisibleWidth = Math.max(0.8, visibleStrokeWidth);
  if (zoomX >= 1) {
    return Math.max(COLUMN_HOVER_HIT_WIDTH_MIN_PX, safeVisibleWidth * 1.6);
  }
  const zoomDeficit = clamp(1 - zoomX, 0, 0.99);
  const boostedWidth = safeVisibleWidth * (1.6 + zoomDeficit * 2.2);
  return clamp(
    boostedWidth,
    Math.max(COLUMN_HOVER_HIT_WIDTH_MIN_PX, safeVisibleWidth * 2),
    COLUMN_HOVER_HIT_WIDTH_MAX_LOW_ZOOM_PX
  );
}

export function computeIndicatorHoverPaddingPx(zoomX: number): number {
  if (zoomX >= 1) return INDICATOR_HOVER_PADDING_BASE_PX;
  const zoomDeficit = clamp(1 - zoomX, 0, 0.99);
  return clamp(
    INDICATOR_HOVER_PADDING_BASE_PX + zoomDeficit * 8,
    INDICATOR_HOVER_PADDING_BASE_PX,
    INDICATOR_HOVER_PADDING_MAX_LOW_ZOOM_PX
  );
}

export function computeSelectedGlyphConnectedTrackSegments(args: {
  nodes: Array<Pick<StorylineNodeGeometry, 'id' | 'x' | 'columns'>>;
  tracks: StorylineColumnTrack[];
  selectedNodeId: string | null;
}): SelectedGlyphConnectionHighlight {
  const { nodes, tracks, selectedNodeId } = args;
  if (!selectedNodeId || nodes.length === 0 || tracks.length === 0) {
    return createEmptySelectedGlyphConnectionHighlight();
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  if (!selectedNode) return createEmptySelectedGlyphConnectionHighlight();

  const orderedNodes = [...nodes].sort((a, b) => a.x - b.x);
  const selectedSlotIndex = orderedNodes.findIndex((node) => node.id === selectedNodeId);
  if (selectedSlotIndex < 0) return createEmptySelectedGlyphConnectionHighlight();

  const selectedColumns = new Set(
    (selectedNode.columns || []).map((column) => String(column)).filter((column) => column.length > 0)
  );
  if (selectedColumns.size === 0) return createEmptySelectedGlyphConnectionHighlight();

  const segmentKeys = new Set<string>();
  const reachLeftBoundaryColumns = new Set<string>();
  const reachRightBoundaryColumns = new Set<string>();

  for (const track of tracks) {
    if (!selectedColumns.has(track.column)) continue;

    const involvedSlotIndexes = [...new Set(
      track.segments
        .filter((segment) =>
          segment.kind === 'slot_horizontal'
          && segment.tone === 'involved'
          && typeof segment.slotIndex === 'number'
        )
        .map((segment) => segment.slotIndex as number)
    )].sort((a, b) => a - b);

    const leftStopSlot = [...involvedSlotIndexes]
      .reverse()
      .find((slotIndex) => slotIndex < selectedSlotIndex);
    const rightStopSlot = involvedSlotIndexes.find((slotIndex) => slotIndex > selectedSlotIndex);

    if (typeof leftStopSlot !== 'number') {
      reachLeftBoundaryColumns.add(track.column);
    }
    if (typeof rightStopSlot !== 'number') {
      reachRightBoundaryColumns.add(track.column);
    }

    for (const segment of track.segments) {
      let shouldHighlight = false;

      if (segment.kind === 'slot_horizontal' && typeof segment.slotIndex === 'number') {
        const slotIndex = segment.slotIndex;
        if (slotIndex === selectedSlotIndex) {
          shouldHighlight = true;
        } else if (slotIndex < selectedSlotIndex) {
          if (typeof leftStopSlot !== 'number') {
            shouldHighlight = true;
          } else if (slotIndex > leftStopSlot) {
            shouldHighlight = true;
          } else if (slotIndex === leftStopSlot && segment.id.endsWith(':right')) {
            shouldHighlight = true;
          }
        } else if (slotIndex > selectedSlotIndex) {
          if (typeof rightStopSlot !== 'number') {
            shouldHighlight = true;
          } else if (slotIndex < rightStopSlot) {
            shouldHighlight = true;
          } else if (slotIndex === rightStopSlot && segment.id.endsWith(':left')) {
            shouldHighlight = true;
          }
        }
      } else if (segment.kind === 'interspace_cubic' && typeof segment.interspaceIndex === 'number') {
        const interspaceIndex = segment.interspaceIndex;
        if (interspaceIndex < selectedSlotIndex) {
          if (typeof leftStopSlot !== 'number') {
            shouldHighlight = true;
          } else if (interspaceIndex >= leftStopSlot) {
            shouldHighlight = true;
          }
        } else {
          if (typeof rightStopSlot !== 'number') {
            shouldHighlight = true;
          } else if (interspaceIndex < rightStopSlot) {
            shouldHighlight = true;
          }
        }
      } else if (segment.kind === 'extension_solid') {
        if (segment.id.endsWith(':left-boundary') && typeof leftStopSlot !== 'number') {
          shouldHighlight = true;
        }
        if (segment.id.endsWith(':right-boundary') && typeof rightStopSlot !== 'number') {
          shouldHighlight = true;
        }
      }

      if (shouldHighlight) {
        segmentKeys.add(buildTrackSegmentKey(track.id, segment.id));
      }
    }
  }

  return {
    segmentKeys,
    columns: selectedColumns,
    reachLeftBoundaryColumns,
    reachRightBoundaryColumns,
  };
}

export function isSummarySelection(selection: Selection): boolean {
  return selection.type === 'summary' || selection.type === 'insight';
}

export type StorylineColumnEmphasisState = 'default' | 'hovered' | 'faded';

export function resolveStorylineColumnEmphasisState(args: {
  hoveredColumn: string | null;
  emphasizedColumns?: ReadonlySet<string> | null;
  column: string;
  canFade: boolean;
}): StorylineColumnEmphasisState {
  const { hoveredColumn, emphasizedColumns = null, column, canFade } = args;
  const hasEmphasizedColumns = !!emphasizedColumns && emphasizedColumns.size > 0;
  if (!hoveredColumn && !hasEmphasizedColumns) return 'default';
  if (hoveredColumn === column) return 'hovered';
  if (emphasizedColumns?.has(column)) return 'hovered';
  return canFade ? 'faded' : 'default';
}

export function shouldRenderSelectedConnectionHighlight(args: {
  hoveredColumn: string | null;
  column: string;
  isSelectedConnection: boolean;
}): boolean {
  const { hoveredColumn, column, isSelectedConnection } = args;
  if (!isSelectedConnection) return false;
  return !hoveredColumn || hoveredColumn === column;
}

export function shouldRenderSelectedSummaryConnectivityHighlight(args: {
  hoveredColumn: string | null;
  column: string;
  isConnected: boolean;
}): boolean {
  const { hoveredColumn, column, isConnected } = args;
  if (!isConnected) return false;
  return !hoveredColumn || hoveredColumn === column;
}

export function computeSelectedSummaryConnectivityHighlight(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'summaryAreas' | 'boundaryBranches' | 'converges'>;
  selectedSummaryId: string | null;
}): SelectedSummaryConnectivityHighlight {
  const { layout, selectedSummaryId } = args;
  if (!selectedSummaryId) return createEmptySelectedSummaryConnectivityHighlight();

  const summaryAreaById = new Map(layout.summaryAreas.map((area) => [area.summaryId, area]));
  const selectedArea = summaryAreaById.get(selectedSummaryId);
  if (!selectedArea || selectedArea.columns.length === 0) {
    return createEmptySelectedSummaryConnectivityHighlight();
  }
  const highlight = createEmptySelectedSummaryConnectivityHighlight();
  const selectedColumns = new Set(
    selectedArea.columns.map((column) => String(column)).filter((column) => column.length > 0)
  );
  highlight.summaryIds.add(selectedArea.summaryId);
  highlight.summaryColumnsById.set(selectedArea.summaryId, selectedColumns);

  const convergeLaneKeySet = new Set<string>();
  for (const converge of layout.converges) {
    for (const lane of converge.lanes) {
      convergeLaneKeySet.add(buildSummaryConnectivityConvergeLaneKey(converge.index, lane.column));
    }
  }
  for (const branch of layout.boundaryBranches) {
    if (branch.summaryId !== selectedArea.summaryId || !selectedColumns.has(branch.column)) {
      continue;
    }
    highlight.branchIds.add(branch.id);
    const convergeIndex = branch.side === 'left' ? branch.turnIndex : branch.turnIndex + 1;
    const laneKey = buildSummaryConnectivityConvergeLaneKey(convergeIndex, branch.column);
    if (convergeLaneKeySet.has(laneKey)) {
      highlight.convergeLaneKeys.add(laneKey);
    }
  }

  return highlight;
}

export function computeSelectedSummarySharedColumnSummaryIds(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'summaryAreas'>;
  selectedSummaryId: string | null;
}): Set<string> {
  const { layout, selectedSummaryId } = args;
  if (!selectedSummaryId) {
    return new Set<string>();
  }
  const summaryAreaById = new Map(layout.summaryAreas.map((area) => [area.summaryId, area]));
  const selectedArea = summaryAreaById.get(selectedSummaryId);
  if (!selectedArea) {
    return new Set<string>();
  }
  const selectedColumns = new Set(
    selectedArea.columns.map((column) => String(column)).filter((column) => column.length > 0)
  );
  if (selectedColumns.size === 0) {
    return new Set<string>([selectedArea.summaryId]);
  }
  const relatedSummaryIds = new Set<string>([selectedArea.summaryId]);
  for (const area of layout.summaryAreas) {
    if (area.summaryId === selectedArea.summaryId) {
      continue;
    }
    if (area.columns.some((column) => selectedColumns.has(String(column)))) {
      relatedSummaryIds.add(area.summaryId);
    }
  }
  return relatedSummaryIds;
}

export function computeSelectedSummaryExtensionPromotionHighlight(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'boundaryBranches' | 'converges'>;
  connectivity: Pick<SelectedSummaryConnectivityHighlight, 'summaryColumnsById'>;
}): SelectedSummaryExtensionPromotionHighlight {
  const { layout, connectivity } = args;
  const laneModeByKey = new Map<string, StorylineConvergeLaneMode>();
  for (const converge of layout.converges) {
    for (const lane of converge.lanes) {
      laneModeByKey.set(
        buildSummaryConnectivityConvergeLaneKey(converge.index, lane.column),
        lane.mode
      );
    }
  }

  const branchBySummaryColumnSide = new Map<string, StorylineTurnConvergeLayout['boundaryBranches'][number]>();
  for (const branch of layout.boundaryBranches) {
    branchBySummaryColumnSide.set(
      buildSummaryConnectivityBranchKey(branch.summaryId, branch.column, branch.side),
      branch
    );
  }

  const highlight = createEmptySelectedSummaryExtensionPromotionHighlight();
  for (const [summaryId, columns] of connectivity.summaryColumnsById.entries()) {
    for (const column of columns) {
      for (const side of ['left', 'right'] as const) {
        const branch = branchBySummaryColumnSide.get(
          buildSummaryConnectivityBranchKey(summaryId, column, side)
        );
        if (!branch) continue;
        const convergeIndex = side === 'left' ? branch.turnIndex : branch.turnIndex + 1;
        const laneKey = buildSummaryConnectivityConvergeLaneKey(convergeIndex, branch.column);
        const laneMode = laneModeByKey.get(laneKey);
        if (!laneMode || laneMode === 'both') continue;
        highlight.branchIds.add(branch.id);
        highlight.convergeLaneKeys.add(laneKey);
      }
    }
  }
  return highlight;
}

export function toggleStorylineSummarySelection(
  selection: Selection,
  summaryId: string
): Selection {
  if (isSummarySelection(selection) && selection.id === summaryId && !selection.atomicId) {
    return { type: null, id: null };
  }
  return { type: 'summary', id: summaryId };
}

export function toggleStorylineAtomicSelection(
  selection: Selection,
  summaryId: string,
  atomicId: string
): Selection {
  if (isSummarySelection(selection) && selection.id === summaryId && selection.atomicId === atomicId) {
    return { type: null, id: null };
  }
  return { type: 'summary', id: summaryId, atomicId };
}

export function toggleStorylinePlanSelection(
  selection: Selection,
  planId: string
): Selection {
  if (selection.type === 'plan' && selection.id === planId) {
    return { type: null, id: null };
  }
  return { type: 'plan', id: planId };
}

export function resolveStorylineSummarySelectionAfterFilterClear(args: {
  selection: Selection;
  summaryId: string;
  hasActiveFilter: boolean;
}): Selection {
  const { selection, summaryId, hasActiveFilter } = args;
  return toggleStorylineSummarySelection(
    hasActiveFilter ? { type: null, id: null } : selection,
    summaryId
  );
}

export function resolveStorylineAtomicSelectionAfterFilterClear(args: {
  selection: Selection;
  summaryId: string;
  atomicId: string;
  hasActiveFilter: boolean;
}): Selection {
  const { selection, summaryId, atomicId, hasActiveFilter } = args;
  return toggleStorylineAtomicSelection(
    hasActiveFilter ? { type: null, id: null } : selection,
    summaryId,
    atomicId
  );
}

export function resolveStorylinePlanSelectionAfterFilterClear(args: {
  selection: Selection;
  planId: string;
  hasActiveFilter: boolean;
}): Selection {
  const { selection, planId, hasActiveFilter } = args;
  return toggleStorylinePlanSelection(
    hasActiveFilter ? { type: null, id: null } : selection,
    planId
  );
}

export function resolveSummaryInternalsRenderMode(
  zoomX: number,
  selectedSummaryId: string | null
): SummaryInternalsRenderMode {
  void zoomX;
  void selectedSummaryId;
  return 'all';
}

export function shouldRenderColumnIndicators(zoomX: number): boolean {
  return shouldRenderSummaryInternals(zoomX);
}

export function resolveStorylineModifierPlatform(platform: string | null | undefined): StorylineModifierPlatform {
  return /(mac|iphone|ipad|ipod)/i.test(String(platform ?? '')) ? 'mac' : 'non_mac';
}

export function shouldUseStorylineGroupToggleModifier(args: {
  platform: StorylineModifierPlatform;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  const { platform, ctrlKey, metaKey } = args;
  return platform === 'mac' ? metaKey : ctrlKey;
}

export function resolveStorylineColumnClickMode(args: {
  platform: StorylineModifierPlatform;
  ctrlKey: boolean;
  metaKey: boolean;
}): StorylineColumnClickMode {
  return shouldUseStorylineGroupToggleModifier(args) ? 'group_toggle' : 'exclusive';
}

export function isStorylineColumnClickGesture(args: {
  pointerDown: StorylineLinePointerDown | null;
  column: string;
  source: StorylineColumnInteractionSource;
  convergeIndex?: number;
  clientX: number;
  clientY: number;
  maxDistancePx?: number;
}): boolean {
  const {
    pointerDown,
    column,
    source,
    convergeIndex,
    clientX,
    clientY,
    maxDistancePx = STORYLINE_COLUMN_CLICK_MAX_DISTANCE_PX,
  } = args;
  if (
    !pointerDown
    || pointerDown.column !== column
    || pointerDown.source !== source
    || pointerDown.convergeIndex !== convergeIndex
  ) {
    return false;
  }
  const distance = Math.hypot(clientX - pointerDown.clientX, clientY - pointerDown.clientY);
  return distance <= maxDistancePx;
}

export function isStorylineCanvasClickGesture(args: {
  pointerDown: StorylineCanvasPointerDown | null;
  clientX: number;
  clientY: number;
  maxDistancePx?: number;
}): boolean {
  const {
    pointerDown,
    clientX,
    clientY,
    maxDistancePx = STORYLINE_COLUMN_CLICK_MAX_DISTANCE_PX,
  } = args;
  if (!pointerDown) {
    return false;
  }
  const distance = Math.hypot(clientX - pointerDown.clientX, clientY - pointerDown.clientY);
  return distance <= maxDistancePx;
}

export function resolveStorylineColumnFilterLineState(args: {
  hasActiveFilter: boolean;
  columnFilterState: StorylineFilterTriState;
  isExactKept: boolean;
}): {
  isKept: boolean;
  shouldUseNormalColumnVisual: boolean;
} {
  const { hasActiveFilter, columnFilterState, isExactKept } = args;
  if (!hasActiveFilter) {
    return {
      isKept: true,
      shouldUseNormalColumnVisual: false,
    };
  }
  if (columnFilterState === 'all') {
    return {
      isKept: true,
      shouldUseNormalColumnVisual: true,
    };
  }
  if (columnFilterState === 'partial') {
    return {
      isKept: isExactKept,
      shouldUseNormalColumnVisual: isExactKept,
    };
  }
  return {
    isKept: false,
    shouldUseNormalColumnVisual: false,
  };
}

export function getLegendItemVisualState(args: {
  triState: StorylineFilterTriState;
  hasActiveFilter: boolean;
}): {
  color: string;
  opacity: number;
  fontWeight: number;
  background: string;
} {
  const { triState, hasActiveFilter } = args;
  if (triState === 'all') {
    return {
      color: '#0f172a',
      opacity: 1,
      fontWeight: 700,
      background: 'rgba(148, 163, 184, 0.22)',
    };
  }
  if (triState === 'partial') {
    return {
      color: '#0f172a',
      opacity: 1,
      fontWeight: 600,
      background: 'rgba(148, 163, 184, 0.12)',
    };
  }
  return {
    color: '#334155',
    opacity: hasActiveFilter ? 0.4 : 1,
    fontWeight: 500,
    background: 'transparent',
  };
}

export function resolveConvergeIndicatorMaskTone(): 'default' {
  return 'default';
}


