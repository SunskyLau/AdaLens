import { format } from 'date-fns';
import {
  INSIGHT_TAXONOMY_COLORS,
  INSIGHT_TAXONOMY_FALLBACK_COLOR,
  INSIGHT_TAXONOMY_V1,
  STORYLINE_INTERSPACE_MIN_LENGTH_PX,
  STORYLINE_SLOT_GLYPH_PADDING_PX,
  STORYLINE_SLOT_MIN_LENGTH_PX,
  STORYLINE_TRACK_UNIFIED_COLOR_HEX,
} from '@/config';
import type { InsightType, RunState } from '@/types';
import {
  buildTrackSegments,
  type InterspaceTrackGeometry,
  type SlotTrackGeometry,
  type StorylineTrackSegment,
} from './storylineThreadRouting';
import {
  clamp,
  computeGlyphDiameterRange,
  computeRouteBoxRadius,
  createStorylineAdaptiveProfile,
  D1_HARD_FLOOR_PX,
  GLYPH_HIT_PADDING_PX,
  GLYPH_MIN_HIT_DIAMETER_PX,
  INTERSPACE_WIDTH_SCALE,
  NODE_PORT_GAP_PX,
  NODE_PORT_PADDING_PX,
  NODE_X_BASE_GAP_PX,
  NODE_X_MIN_GAP_PX,
  NO_COLUMN_LABEL,
  PLOT_HORIZONTAL_PADDING_PX,
  ROUTEBOX_GLYPH_PADDING_PX,
  SLOT_WIDTH_SCALE,
  STORYLINE_SLOT_SIDE_CLEARANCE_PX,
  TRACK_ENDPOINT_SEGMENT_PX,
  ZOOM_MIN,
} from './storylineGraphLayoutConstants';
import {
  buildOrderMatrix,
  computeGlyphYFromStructuralFlow,
  createInvolvedMatrix,
} from './storylineGraphLayoutOrder';
import {
  buildAlignmentMatrix,
  buildUninvolvedSideMatrix,
  computeSlotGapArrays,
  solveYByProjectedLeastSquares,
} from './storylineGraphLayoutSolve';

export type StorylineLaneMode = 'insight_type' | 'dataset_columns';

interface AtomicEntry {
  id: string;
  summaryId: string;
  atomicId: string;
  timestampMs: number;
  columns: string[];
  insightType: InsightType;
  importance: number;
}

export interface StorylineNodeGeometry {
  id: string;
  summaryId: string;
  atomicId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  glyphDiameter: number;
  hitDiameter: number;
  columns: string[];
  portOffsetByColumn: Record<string, number>;
  insightType: InsightType;
  sizeScale: number;
  sizeRatio: number;
  timestampMs: number;
}

export interface StorylineSlotGeometry {
  index: number;
  nodeId: string;
  centerX: number;
  left: number;
  right: number;
  nodeLeft: number;
  nodeRight: number;
  routeBoxRadius: number;
  routeBoxTopY: number;
  routeBoxBottomY: number;
  connectTopY: number;
  connectBottomY: number;
}

export interface StorylineInterspaceGeometry {
  index: number;
  left: number;
  right: number;
}

export interface StorylineSolvedLayout {
  slots: StorylineSlotGeometry[];
  interspaces: StorylineInterspaceGeometry[];
  slotBoundaryXs: number[];
  columnOrder: string[];
  M_order: number[][];
  M_align: number[][];
  yMatrix: number[][];
  d1BySlot: number[];
  d2BySlot: number[];
  crossingCount: number;
  yTop: number;
  yBottom: number;
}

export interface StorylineColumnTrack {
  id: string;
  column: string;
  color: string;
  path: string;
  segments: StorylineTrackSegment[];
  anchors: Array<{ x: number; y: number }>;
  leftExtension: { fromX: number; toX: number; y: number } | null;
  rightExtension: { fromX: number; toX: number; y: number } | null;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pointCount: number;
  indicatorCenterX?: number;
  indicatorLockToCenter?: boolean;
  indicatorLabelText?: string;
  indicatorFontSizePx?: number;
  indicatorMaskHeightPx?: number;
  indicatorSuppressConnector?: boolean;
  indicatorMustStayAboveAnchor?: boolean;
  indicatorMustStayBelowAnchor?: boolean;
  indicatorAnchorClearancePx?: number;
}

export interface StorylineTick {
  x: number;
  y: number;
  label: string;
  lineLength: number;
  fontSize: number;
  labelOffset: number;
}

export interface StorylineAdaptiveProfile {
  xZoomRatio: number;
  adaptive: number;
  glyphScale: number;
  routeBoxScale: number;
  slotWidthScale: number;
  interspaceWidthScale: number;
  trackStrokeScale: number;
  d1Scale: number;
  d2Scale: number;
  tickScale: number;
  labelScale: number;
}

export interface StorylineLayout {
  nodes: StorylineNodeGeometry[];
  tracks: StorylineColumnTrack[];
  ticks: StorylineTick[];
  solvedLayout: StorylineSolvedLayout | null;
  plotMinX: number;
  plotMaxX: number;
  plotMinY: number;
  plotMaxY: number;
  plotWidth: number;
  plotHeight: number;
  adaptiveProfile: StorylineAdaptiveProfile;
}

export interface StorylineLayoutOptions {
  yUpperBoundPx?: number;
  yLowerBoundPx?: number;
  yMedianTargetPx?: number;
  xZoomRatio?: number;
  viewportWidthPx?: number;
  boundaryContract?: StorylineBoundaryContractInput;
}

export interface StorylineBoundaryContractInput {
  leftPortColumnsInOrder?: string[];
  leftPortTargetYByColumn?: Record<string, number>;
  leftPortMinGapPx?: number;
}
export {
  clamp,
  computeGlyphDiameterRange,
  computeRouteBoxRadius,
  createStorylineAdaptiveProfile,
  STORYLINE_GLYPH_MAX_DIAMETER_PX,
  STORYLINE_GLYPH_MIN_DIAMETER_PX,
  STORYLINE_SLOT_SIDE_CLEARANCE_PX,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_WHEEL_SPEED,
} from './storylineGraphLayoutConstants';

function ensureRouteBoxDiameterForInvolvedGap(baseDiameter: number, involvedCount: number, minGap: number): number {
  if (involvedCount <= 1) return baseDiameter;

  const requiredConnectSpan = Math.max(0, (involvedCount - 1) * minGap);
  let diameter = Math.max(baseDiameter, 1);
  for (let iter = 0; iter < 12; iter += 1) {
    const radius = computeRouteBoxRadius(diameter, diameter);
    const connectSpan = Math.max(0, diameter - radius * 2);
    if (connectSpan >= requiredConnectSpan - 1e-6) break;

    const deficit = requiredConnectSpan - connectSpan;
    diameter += Math.max(2, deficit / 0.52);
  }
  return diameter;
}

export function computeSlotSideLeadPx(
  nodeWidth: number,
  nodeHeight: number,
  profile: Pick<StorylineAdaptiveProfile, 'slotWidthScale'>
): number {
  const heightSurplus = Math.max(0, nodeHeight - nodeWidth);
  const readableFloor = 4.5 * clamp(Math.pow(profile.slotWidthScale, 0.18), 0.88, 1.08);
  const geometryLead = 3.5 + heightSurplus * 0.34;
  return clamp(
    Math.max(readableFloor, geometryLead),
    STORYLINE_SLOT_SIDE_CLEARANCE_PX,
    22
  );
}

export function computeMinimumSlotWidthPx(
  nodeWidth: number,
  nodeHeight: number,
  profile: Pick<StorylineAdaptiveProfile, 'slotWidthScale'>
): number {
  return nodeWidth + computeSlotSideLeadPx(nodeWidth, nodeHeight, profile) * 2;
}

export function computeMinimumInterspaceWidthPx(args: {
  leftWidth: number;
  leftHeight: number;
  leftY: number;
  rightWidth: number;
  rightHeight: number;
  rightY: number;
  profile: Pick<StorylineAdaptiveProfile, 'interspaceWidthScale'>;
}): number {
  const avgHeight = (args.leftHeight + args.rightHeight) / 2;
  const avgWidth = (args.leftWidth + args.rightWidth) / 2;
  const heightSurplus = Math.max(0, avgHeight - avgWidth);
  const verticalDrift = Math.abs(args.leftY - args.rightY);
  const readableFloor = 8 * clamp(Math.pow(args.profile.interspaceWidthScale, 0.16), 0.9, 1.08);
  const geometryWidth = 8 + heightSurplus * 0.26 + verticalDrift * 0.08;
  return clamp(Math.max(readableFloor, geometryWidth), 8, 34);
}

function toTimestampMs(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeToken(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeAtomicId(value: string, fallback: string): string {
  const normalized = normalizeToken(value);
  return normalized || fallback;
}

function normalizeColumns(columns: string[]): string[] {
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const rawColumn of columns) {
    const normalized = normalizeToken(rawColumn);
    if (!normalized || unique.has(normalized)) continue;
    unique.add(normalized);
    ordered.push(normalized);
  }
  if (ordered.length === 0) ordered.push(NO_COLUMN_LABEL);
  return ordered;
}

function normalizeBoundaryTargetYByColumn(args: {
  rawTargetYByColumn?: Record<string, number>;
  orderedColumns: string[];
  yTop: number;
  yBottom: number;
}): Map<string, number> {
  const { rawTargetYByColumn, orderedColumns, yTop, yBottom } = args;
  if (!rawTargetYByColumn) return new Map<string, number>();

  const rawEntries = orderedColumns
    .map((column) => [column, Number(rawTargetYByColumn[column])] as const)
    .filter((entry): entry is readonly [string, number] => Number.isFinite(entry[1]));
  if (rawEntries.length === 0) return new Map<string, number>();

  const rawValues = rawEntries.map((entry) => entry[1]);
  const sortedRawValues = [...rawValues].sort((a, b) => a - b);
  const rawMedian = sortedRawValues[Math.floor(sortedRawValues.length / 2)] ?? 0;
  const localMedian = (yTop + yBottom) / 2;
  const normalized = new Map<string, number>();

  for (const [column, rawY] of rawEntries) {
    normalized.set(column, clamp(rawY - rawMedian + localMedian, yTop, yBottom));
  }

  return normalized;
}

function extractAtomicImportance(atomic: {
  importance?: unknown;
  impact?: unknown;
  significance?: unknown;
  interest?: unknown;
}): number {
  const primary = Number(atomic.importance);
  if (Number.isFinite(primary)) return primary;

  const metrics = [atomic.impact, atomic.significance, atomic.interest]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (metrics.length === 0) return 0;
  return metrics.reduce((sum, value) => sum + value, 0) / metrics.length;
}

function computeCompactXPositions(
  entries: AtomicEntry[],
  nodeWidths: number[],
  xSpacingScale: number
): number[] {
  if (entries.length === 0) return [];

  const spacingScale = clamp(xSpacingScale, Math.pow(ZOOM_MIN, 0.55), 1.9);
  const baseGapPx = NODE_X_BASE_GAP_PX * spacingScale;
  const minGapPx = NODE_X_MIN_GAP_PX * clamp(Math.pow(spacingScale, 0.82), 0.08, 1.82);
  const horizontalPaddingPx = PLOT_HORIZONTAL_PADDING_PX * clamp(Math.pow(spacingScale, 0.7), 0.12, 1.76);

  const validTimestamps = entries.map((entry) => entry.timestampMs).filter((timestamp) => timestamp > 0);
  const hasTimeline = validTimestamps.length > 1;
  const minTimestamp = hasTimeline ? Math.min(...validTimestamps) : 0;
  const maxTimestamp = hasTimeline ? Math.max(...validTimestamps) : 0;
  const range = maxTimestamp - minTimestamp;

  const xPositions: number[] = [];
  let previousX = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < entries.length; i += 1) {
    const sequenceX = horizontalPaddingPx + i * baseGapPx;
    const sequenceRatio = entries.length > 1 ? i / (entries.length - 1) : 0;

    let x = sequenceX;
    if (hasTimeline && range > 0 && entries[i].timestampMs > 0 && entries.length > 1) {
      const timeRatio = (entries[i].timestampMs - minTimestamp) / range;
      const bias = (timeRatio - sequenceRatio) * baseGapPx * 0.62;
      x += bias;
    }

    if (previousX !== Number.NEGATIVE_INFINITY) {
      const prevWidth = nodeWidths[i - 1] || GLYPH_MIN_HIT_DIAMETER_PX;
      const currentWidth = nodeWidths[i] || GLYPH_MIN_HIT_DIAMETER_PX;
      const minGap = prevWidth / 2 + currentWidth / 2 + baseGapPx * 0.4;
      x = Math.max(x, previousX + Math.max(minGapPx, minGap));
    }

    xPositions.push(x);
    previousX = x;
  }

  return xPositions;
}

function collectAtomicEntries(runState: RunState): AtomicEntry[] {
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  const orderedSummaries = [...runState.insights]
    .filter((summary) => {
      const plan = planById.get(summary.plan_id);
      if (!plan) return true;
      return plan.status === 'completed';
    })
    .sort((a, b) => {
      const aTs = toTimestampMs(a.created_at) || toTimestampMs(planById.get(a.plan_id)?.created_at);
      const bTs = toTimestampMs(b.created_at) || toTimestampMs(planById.get(b.plan_id)?.created_at);
      if (aTs !== bTs) return aTs - bTs;
      return a.insight_id.localeCompare(b.insight_id);
    });

  const entries: AtomicEntry[] = [];
  for (const summary of orderedSummaries) {
    const summaryTs = toTimestampMs(summary.created_at) || toTimestampMs(planById.get(summary.plan_id)?.created_at);
    for (let index = 0; index < summary.atomic_insights.length; index += 1) {
      const atomic = summary.atomic_insights[index];
      const fallbackAtomicId = `atomic_${index + 1}`;
      const atomicId = normalizeAtomicId(atomic.atomic_id, fallbackAtomicId);
      const columns = normalizeColumns(atomic.columns || []);
      entries.push({
        id: `${summary.insight_id}::${atomicId}`,
        summaryId: summary.insight_id,
        atomicId,
        timestampMs: summaryTs,
        columns,
        insightType: atomic.insight_type,
        importance: extractAtomicImportance(atomic),
      });
    }
  }
  return entries;
}

function computeImportanceRatio(importance: number, minImportance: number, maxImportance: number): number {
  if (!Number.isFinite(importance)) return 0;
  if (!Number.isFinite(minImportance) || !Number.isFinite(maxImportance)) return 0;
  if (maxImportance <= minImportance + 1e-9) return 0.5;
  return clamp((importance - minImportance) / (maxImportance - minImportance), 0, 1);
}

function buildSlots(
  nodes: StorylineNodeGeometry[],
  profile: StorylineAdaptiveProfile
): { slots: StorylineSlotGeometry[]; interspaces: StorylineInterspaceGeometry[] } {
  const effectiveSlotWidthScale = SLOT_WIDTH_SCALE * profile.slotWidthScale;
  const effectiveInterspaceWidthScale = INTERSPACE_WIDTH_SCALE * profile.interspaceWidthScale;
  const slotWidths = nodes.map((node) => {
    const baseWidth = Math.max(node.width + STORYLINE_SLOT_GLYPH_PADDING_PX * 2, STORYLINE_SLOT_MIN_LENGTH_PX);
    const scaledWidth = baseWidth * effectiveSlotWidthScale;
    const minSafeSlotWidth = computeMinimumSlotWidthPx(node.width, node.height, profile);
    return Math.max(scaledWidth, minSafeSlotWidth);
  });
  const xCenters = nodes.map((node) => node.x);

  for (let index = 1; index < xCenters.length; index += 1) {
    const minCenterGap = (slotWidths[index - 1] + slotWidths[index]) / 2
      + STORYLINE_INTERSPACE_MIN_LENGTH_PX * effectiveInterspaceWidthScale;
    xCenters[index] = Math.max(xCenters[index], xCenters[index - 1] + minCenterGap);
  }

  const slots = nodes.map((node, index) => {
    node.x = xCenters[index];
    const routeBoxTopY = node.y - node.height / 2;
    const routeBoxBottomY = node.y + node.height / 2;
    const routeBoxRadius = computeRouteBoxRadius(node.width, node.height);
    const connectTopY = routeBoxTopY + routeBoxRadius;
    const connectBottomY = routeBoxBottomY - routeBoxRadius;
    return {
      index,
      nodeId: node.id,
      centerX: xCenters[index],
      left: xCenters[index] - slotWidths[index] / 2,
      right: xCenters[index] + slotWidths[index] / 2,
      nodeLeft: node.x - node.width / 2,
      nodeRight: node.x + node.width / 2,
      routeBoxRadius,
      routeBoxTopY,
      routeBoxBottomY,
      connectTopY,
      connectBottomY,
    };
  });

  const interspaces: StorylineInterspaceGeometry[] = [];
  for (let index = 0; index < slots.length - 1; index += 1) {
    interspaces.push({ index, left: slots[index].right, right: slots[index + 1].left });
  }

  return { slots, interspaces };
}

function buildTicks(
  entries: AtomicEntry[],
  nodes: StorylineNodeGeometry[],
  profile: StorylineAdaptiveProfile
): StorylineTick[] {
  if (entries.length === 0 || nodes.length === 0) return [];
  const lineLength = 8 * profile.tickScale;
  const fontSize = clamp(9 * profile.tickScale, 7.2, 14);
  const labelOffset = 4 * profile.tickScale;
  const lift = 9 * profile.tickScale;
  return nodes.map((node, index) => ({
    x: node.x,
    y: node.y - node.hitDiameter / 2 - lift,
    label: entries[index]?.timestampMs > 0 ? format(entries[index].timestampMs, 'HH:mm:ss') : `Step ${index + 1}`,
    lineLength,
    fontSize,
    labelOffset,
  }));
}

export function getInsightTypeHex(insightType: InsightType): string {
  return INSIGHT_TAXONOMY_COLORS[insightType]?.hex ?? INSIGHT_TAXONOMY_FALLBACK_COLOR.hex;
}

export function getInsightTypeLabel(insightType: InsightType): string {
  return INSIGHT_TAXONOMY_V1.find((item) => item.id === insightType)?.label || insightType;
}

export function buildStorylineLayout(
  runState: RunState | null | undefined,
  viewportHeight: number,
  options: StorylineLayoutOptions = {}
): StorylineLayout {
  const adaptiveProfile = createStorylineAdaptiveProfile(options.xZoomRatio ?? 1);
  if (!runState) {
    return {
      nodes: [],
      tracks: [],
      ticks: [],
      solvedLayout: null,
      plotMinX: 0,
      plotMaxX: 0,
      plotMinY: 0,
      plotMaxY: viewportHeight,
      plotWidth: 0,
      plotHeight: viewportHeight,
      adaptiveProfile,
    };
  }

  const entries = collectAtomicEntries(runState);
  if (entries.length === 0) {
    return {
      nodes: [],
      tracks: [],
      ticks: [],
      solvedLayout: null,
      plotMinX: 0,
      plotMaxX: 0,
      plotMinY: 0,
      plotMaxY: viewportHeight,
      plotWidth: 0,
      plotHeight: viewportHeight,
      adaptiveProfile,
    };
  }

  const yTop = clamp(options.yUpperBoundPx ?? 0, 0, Math.max(0, viewportHeight - 20));
  const yBottom = clamp(options.yLowerBoundPx ?? viewportHeight * 0.9, yTop + 60, viewportHeight);
  const yMedianTarget = options.yMedianTargetPx == null
    ? undefined
    : clamp(options.yMedianTargetPx, yTop, yBottom);
  const viewportWidth = Math.max(1, options.viewportWidthPx ?? 980);
  const glyphDiameterRange = computeGlyphDiameterRange(viewportWidth, viewportHeight);

  const columnFrequency = new Map<string, number>();
  for (const entry of entries) {
    for (const column of entry.columns) columnFrequency.set(column, (columnFrequency.get(column) || 0) + 1);
  }

  const defaultOrderedColumns = [...columnFrequency.entries()]
    .sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([column]) => column);
  const boundaryLeftOrder = options.boundaryContract?.leftPortColumnsInOrder
    ?.map((column) => normalizeToken(column))
    .filter((column) => columnFrequency.has(column)) ?? [];
  const seenBoundaryColumns = new Set(boundaryLeftOrder);
  const orderedColumns = boundaryLeftOrder.concat(
    defaultOrderedColumns.filter((column) => !seenBoundaryColumns.has(column))
  );

  const columnRank = new Map(orderedColumns.map((column, index) => [column, index]));
  const involvedMatrix = createInvolvedMatrix(entries, orderedColumns);
  const initialOrder = orderedColumns.map((_column, index) => index);
  const fixedOrderBySlotIndex = new Map<number, number[]>();
  if (boundaryLeftOrder.length > 0) {
    fixedOrderBySlotIndex.set(
      0,
      boundaryLeftOrder
        .map((column) => columnRank.get(column))
        .filter((value): value is number => typeof value === 'number')
    );
  }
  const orderResult = buildOrderMatrix(
    involvedMatrix,
    orderedColumns.length,
    initialOrder,
    { fixedOrderBySlotIndex }
  );
  const finiteImportance = entries.map((entry) => entry.importance).filter((value) => Number.isFinite(value));
  const minImportance = finiteImportance.length > 0 ? Math.min(...finiteImportance) : 0;
  const maxImportance = finiteImportance.length > 0 ? Math.max(...finiteImportance) : 1;

  const nodeDraft = entries.map((entry, entryIndex) => {
    const orderedNodeColumns = [...entry.columns].sort((a, b) => {
      const aRank = columnRank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bRank = columnRank.get(b) ?? Number.MAX_SAFE_INTEGER;
      return aRank !== bRank ? aRank - bRank : a.localeCompare(b);
    });

    const count = orderedNodeColumns.length;
    const importanceRatio = computeImportanceRatio(entry.importance, minImportance, maxImportance);
    const sizeScale = 1 + importanceRatio * 3;
    const glyphDiameter =
      glyphDiameterRange.minDiameter +
      importanceRatio * (glyphDiameterRange.maxDiameter - glyphDiameterRange.minDiameter);
    const portGap = entryIndex === 0 && typeof options.boundaryContract?.leftPortMinGapPx === 'number'
      ? Math.max(NODE_PORT_GAP_PX, options.boundaryContract.leftPortMinGapPx)
      : NODE_PORT_GAP_PX;
    const portPadding = NODE_PORT_PADDING_PX;
    const routeBoxMinDim = glyphDiameter + ROUTEBOX_GLYPH_PADDING_PX;
    const requiredPortSpan = count <= 1
      ? routeBoxMinDim
      : Math.max(routeBoxMinDim, (count - 1) * portGap + portPadding);
    const slotMinGap = entryIndex === 0 && typeof options.boundaryContract?.leftPortMinGapPx === 'number'
      ? Math.max(D1_HARD_FLOOR_PX, options.boundaryContract.leftPortMinGapPx)
      : D1_HARD_FLOOR_PX;
    const routeBoxHeight = ensureRouteBoxDiameterForInvolvedGap(
      requiredPortSpan,
      count,
      slotMinGap
    );
    const routeBoxWidth = routeBoxMinDim;
    const hitDiameter = Math.max(
      GLYPH_MIN_HIT_DIAMETER_PX,
      Math.max(routeBoxWidth, routeBoxHeight) + GLYPH_HIT_PADDING_PX
    );

    const portOffsetByColumn: Record<string, number> = {};
    for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
      portOffsetByColumn[orderedNodeColumns[columnIndex]] = (columnIndex - (count - 1) / 2) * portGap;
    }

    return {
      entry,
      width: routeBoxWidth,
      height: routeBoxHeight,
      glyphDiameter,
      hitDiameter,
      sizeScale,
      sizeRatio: importanceRatio,
      portOffsetByColumn,
    };
  });

  const xPositions = computeCompactXPositions(
    entries,
    nodeDraft.map((item) => item.width),
    adaptiveProfile.slotWidthScale
  );
  const yPositions = computeGlyphYFromStructuralFlow({
    orderBySlot: orderResult.orderBySlot,
    involvedMatrix,
    hitDiameters: nodeDraft.map((item) => item.hitDiameter),
    yTop,
    yBottom,
    yMedianTarget,
  });

  const nodes: StorylineNodeGeometry[] = nodeDraft.map((draft, index) => ({
    id: draft.entry.id,
    summaryId: draft.entry.summaryId,
    atomicId: draft.entry.atomicId,
    x: xPositions[index],
    y: yPositions[index],
    width: draft.width,
    height: draft.height,
    glyphDiameter: draft.glyphDiameter,
    hitDiameter: draft.hitDiameter,
    columns: draft.entry.columns,
    portOffsetByColumn: draft.portOffsetByColumn,
    insightType: draft.entry.insightType,
    sizeScale: draft.sizeScale,
    sizeRatio: draft.sizeRatio,
    timestampMs: draft.entry.timestampMs,
  }));

  const { slots, interspaces } = buildSlots(nodes, adaptiveProfile);
  const uninvolvedSideMatrix = buildUninvolvedSideMatrix(orderResult.orderBySlot, involvedMatrix);
  const gapArrays = computeSlotGapArrays({
    slots,
    involvedMatrix,
    yTopBound: yTop,
    yBottomBound: yBottom,
    profile: adaptiveProfile,
  });
  if (typeof options.boundaryContract?.leftPortMinGapPx === 'number' && gapArrays.d1BySlot.length > 0) {
    gapArrays.d1BySlot[0] = Math.max(
      gapArrays.d1BySlot[0],
      options.boundaryContract.leftPortMinGapPx
    );
    gapArrays.d2BySlot[0] = Math.max(gapArrays.d2BySlot[0], gapArrays.d1BySlot[0] + 0.5);
  }
  const M_align = buildAlignmentMatrix({
    orderMatrix: orderResult.M_order,
    involvedMatrix,
    uninvolvedSideMatrix,
    slots,
    d1BySlot: gapArrays.d1BySlot,
    d2BySlot: gapArrays.d2BySlot,
    yTopBound: yTop,
    yBottomBound: yBottom,
  });
  const normalizedBoundaryTargetYByColumn = normalizeBoundaryTargetYByColumn({
    rawTargetYByColumn: options.boundaryContract?.leftPortTargetYByColumn,
    orderedColumns,
    yTop,
    yBottom,
  });
  const targetYOverridesBySlotIndex = new Map<number, Map<number, number>>();
  if (normalizedBoundaryTargetYByColumn.size > 0) {
    const slotZeroOverrides = new Map<number, number>();
    for (const [column, targetY] of normalizedBoundaryTargetYByColumn.entries()) {
      const columnIndex = columnRank.get(column);
      if (typeof columnIndex !== 'number') continue;
      slotZeroOverrides.set(columnIndex, targetY);
    }
    if (slotZeroOverrides.size > 0) {
      targetYOverridesBySlotIndex.set(0, slotZeroOverrides);
    }
  }

  const ySolveResult = solveYByProjectedLeastSquares({
    slots,
    orderBySlot: orderResult.orderBySlot,
    M_align,
    involvedMatrix,
    uninvolvedSideMatrix,
    d1BySlot: gapArrays.d1BySlot,
    d2BySlot: gapArrays.d2BySlot,
    yTopBound: yTop,
    yBottomBound: yBottom,
    targetYOverridesBySlotIndex,
  });

  const extensionLength = TRACK_ENDPOINT_SEGMENT_PX * adaptiveProfile.slotWidthScale;
  const tracks: StorylineColumnTrack[] = orderedColumns.map((column, columnIndex) => {
    const slotSeries: SlotTrackGeometry[] = slots.map((slot, slotIndex) => ({
      slotIndex,
      left: slot.left,
      right: slot.right,
      nodeLeft: slot.nodeLeft,
      nodeRight: slot.nodeRight,
      y: ySolveResult.yMatrix[slotIndex][columnIndex],
      involved: involvedMatrix[slotIndex][columnIndex],
    }));

    const interspaceSeries: InterspaceTrackGeometry[] = interspaces.map((interspace, slotIndex) => ({
      interspaceIndex: interspace.index,
      left: interspace.left,
      right: interspace.right,
      fromY: ySolveResult.yMatrix[slotIndex][columnIndex],
      toY: ySolveResult.yMatrix[slotIndex + 1][columnIndex],
      aligned: M_align[slotIndex + 1][columnIndex] === 1,
    }));

    const segments = buildTrackSegments({
      column,
      slots: slotSeries,
      interspaces: interspaceSeries,
      extensionLength,
    });

    const xValues: number[] = [];
    const yValues: number[] = [];
    for (const segment of segments) {
      xValues.push(segment.startX, segment.endX);
      yValues.push(segment.startY, segment.endY);
      if (segment.c1X !== undefined && segment.c2X !== undefined) xValues.push(segment.c1X, segment.c2X);
      if (segment.c1Y !== undefined && segment.c2Y !== undefined) yValues.push(segment.c1Y, segment.c2Y);
    }

    const first = slotSeries[0];
    const last = slotSeries[slotSeries.length - 1];
    const leftExtension = { fromX: first.left - extensionLength * 2, toX: first.left, y: first.y };
    const rightExtension = { fromX: last.right, toX: last.right + extensionLength * 2, y: last.y };

    return {
      id: `track:${column}`,
      column,
      color: STORYLINE_TRACK_UNIFIED_COLOR_HEX,
      path: segments.map((segment) => segment.path).join(' '),
      segments,
      anchors: slotSeries.map((slot) => ({ x: (slot.left + slot.right) / 2, y: slot.y })),
      leftExtension,
      rightExtension,
      minX: xValues.length > 0 ? Math.min(...xValues) : 0,
      maxX: xValues.length > 0 ? Math.max(...xValues) : 0,
      minY: yValues.length > 0 ? Math.min(...yValues) : 0,
      maxY: yValues.length > 0 ? Math.max(...yValues) : 0,
      pointCount: involvedMatrix.reduce((sum, row) => sum + (row[columnIndex] ? 1 : 0), 0),
    };
  });

  const ticks = buildTicks(entries, nodes, adaptiveProfile);

  const boundarySet = new Set<number>();
  for (const slot of slots) {
    boundarySet.add(slot.left);
    boundarySet.add(slot.right);
  }
  for (const interspace of interspaces) {
    boundarySet.add(interspace.left);
    boundarySet.add(interspace.right);
  }
  const slotBoundaryXs = [...boundarySet].sort((a, b) => a - b);

  const solvedLayout: StorylineSolvedLayout = {
    slots,
    interspaces,
    slotBoundaryXs,
    columnOrder: orderedColumns,
    M_order: orderResult.M_order,
    M_align,
    yMatrix: ySolveResult.yMatrix,
    d1BySlot: ySolveResult.d1BySlot,
    d2BySlot: ySolveResult.d2BySlot,
    crossingCount: orderResult.crossingCount,
    yTop,
    yBottom,
  };

  const minNodeX = Math.min(...nodes.map((node) => node.x - node.width / 2 - 26));
  const maxNodeX = Math.max(...nodes.map((node) => node.x + node.width / 2 + 26));
  const minTrackX = tracks.length > 0 ? Math.min(...tracks.map((track) => track.minX - 4)) : minNodeX;
  const maxTrackX = tracks.length > 0 ? Math.max(...tracks.map((track) => track.maxX + 4)) : maxNodeX;
  const minSlotX = slotBoundaryXs.length > 0 ? Math.min(...slotBoundaryXs) : minNodeX;
  const maxSlotX = slotBoundaryXs.length > 0 ? Math.max(...slotBoundaryXs) : maxNodeX;
  const minX = Math.min(minNodeX, minTrackX, minSlotX);
  const maxX = Math.max(maxNodeX, maxTrackX, maxSlotX);

  const minNodeY = Math.min(...nodes.map((node) => node.y - node.height / 2 - 16));
  const maxNodeY = Math.max(...nodes.map((node) => node.y + node.height / 2 + 16));
  const minTrackY = tracks.length > 0 ? Math.min(...tracks.map((track) => track.minY - 8)) : minNodeY;
  const maxTrackY = tracks.length > 0 ? Math.max(...tracks.map((track) => track.maxY + 8)) : maxNodeY;
  const minTickY = ticks.length > 0 ? Math.min(...ticks.map((tick) => tick.y - 16)) : minNodeY;
  const minY = Math.min(0, minTickY, minNodeY, minTrackY);
  const maxY = Math.max(viewportHeight, maxTrackY, maxNodeY, yBottom);

  return {
    nodes,
    tracks,
    ticks,
    solvedLayout,
    plotMinX: minX,
    plotMaxX: maxX,
    plotMinY: minY,
    plotMaxY: maxY,
    plotWidth: maxX - minX,
    plotHeight: maxY - minY,
    adaptiveProfile,
  };
}

export function buildStorylineLayoutWithBoundaryContract(
  runState: RunState | null | undefined,
  viewportHeight: number,
  options: StorylineLayoutOptions = {}
): StorylineLayout {
  return buildStorylineLayout(runState, viewportHeight, options);
}
