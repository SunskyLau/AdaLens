import {
  STORYLINE_TRACK_UNIFIED_COLOR_HEX,
  STORYLINE_TRACK_UNINVOLVED_COLOR_HEX,
} from '@/config';
import type { Event, PlanItem, RunState, Summary } from '@/types';
import {
  buildStorylineLayout as buildLegacyAtomicLayout,
  buildStorylineLayoutWithBoundaryContract,
  clamp,
  computeGlyphDiameterRange,
  computeMinimumInterspaceWidthPx,
  computeMinimumSlotWidthPx,
  createStorylineAdaptiveProfile,
  type StorylineAdaptiveProfile,
  type StorylineBoundaryContractInput,
  type StorylineColumnTrack as LegacyStorylineColumnTrack,
  type StorylineLaneMode,
  type StorylineNodeGeometry as LegacyStorylineNodeGeometry,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_WHEEL_SPEED,
} from './storylineGraphLayout';
import type { StorylineTrackSegment as LegacyStorylineTrackSegment } from './storylineThreadRouting';
import {
  computeTrackLabelTypography,
  CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
} from './storylineTrackLabels';
import { buildStorylineTurnGrouping } from './storylineTurnGrouping';
import {
  solveEgressWindow,
  solveGapConstrainedPositionsPreservingFrozenLanes,
  solveIngressConvergeWindow,
  solveIngressWindow,
  solveInitialLeftConvergeWindow,
  type BoundaryLaneState,
  type SummaryBoundaryContract,
} from './storylineBoundaryWindowLayout';

export { ZOOM_MAX, ZOOM_MIN, ZOOM_WHEEL_SPEED };
export type { StorylineLaneMode };

export interface StorylineTurnGeometry {
  index: number;
  xStart: number;
  xEnd: number;
  areaLeft: number;
  areaRight: number;
  margin: number;
  summaryIds: string[];
}

export type StorylineConvergeLaneMode =
  | 'both'
  | 'left_extension'
  | 'right_extension'
  | 'isolated';

export type StorylineConvergeEndpointMarkerKind =
  | 'start'
  | 'terminate'
  | 'isolated';

export interface StorylineConvergeEndpointMarker {
  id: string;
  kind: StorylineConvergeEndpointMarkerKind;
  x: number;
  y: number;
  diameter: number;
}

export interface StorylineConvergeLane {
  id: string;
  column: string;
  y: number;
  mode: StorylineConvergeLaneMode;
  segments: LegacyStorylineTrackSegment[];
  endpointMarkers: StorylineConvergeEndpointMarker[];
  rightTurnAtomicCount: number;
  indicatorFontSizePx: number;
  indicatorRequiredClearancePx: number;
}

export interface StorylineConvergeGeometry {
  index: number;
  xStart: number;
  xEnd: number;
  lanes: StorylineConvergeLane[];
}

export interface StorylineTurnBoundary {
  id: string;
  x: number;
  turnIndex: number;
  side: 'left' | 'right';
}

export interface StorylineBoundaryBranch {
  id: string;
  summaryId: string;
  column: string;
  turnIndex: number;
  side: 'left' | 'right';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  c1X: number;
  c1Y: number;
  c2X: number;
  c2Y: number;
  path: string;
}

export interface StorylineSummaryArea {
  id: string;
  summaryId: string;
  shortLabel: string;
  turnIndex: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  titleBandHeight: number;
  tracks: LegacyStorylineColumnTrack[];
  nodes: LegacyStorylineNodeGeometry[];
  columns: string[];
  leftAnchorYByColumn: Record<string, number>;
  rightAnchorYByColumn: Record<string, number>;
}

export interface StorylineActivePlanArea {
  id: string;
  planId: string;
  shortLabel: string;
  text: string;
  status: PlanItem['status'];
  controlState: NonNullable<PlanItem['control_state']>;
  launchRequested: boolean;
  turnIndex: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  titleBandHeight: number;
}

export interface StorylineTurnConvergeLayout {
  laneMode: StorylineLaneMode;
  nodes: LegacyStorylineNodeGeometry[];
  summaryAreas: StorylineSummaryArea[];
  activePlanAreas: StorylineActivePlanArea[];
  turns: StorylineTurnGeometry[];
  converges: StorylineConvergeGeometry[];
  turnBoundaries: StorylineTurnBoundary[];
  boundaryBranches: StorylineBoundaryBranch[];
  plotMinX: number;
  plotMaxX: number;
  plotMinY: number;
  plotMaxY: number;
  plotWidth: number;
  plotHeight: number;
  adaptiveProfile: StorylineAdaptiveProfile;
}

export interface StorylineTurnConvergeLayoutOptions {
  laneMode?: StorylineLaneMode;
  events?: Event[];
  yUpperBoundPx?: number;
  yLowerBoundPx?: number;
  yMedianTargetPx?: number;
  xZoomRatio?: number;
  viewportWidthPx?: number;
}

interface SummaryReplayEntry {
  summary: Summary;
  turnIndex: number;
}

interface SummaryLocalDraft {
  kind: 'summary';
  summaryId: string;
  shortLabel: string;
  turnIndex: number;
  left: number;
  right: number;
  width: number;
  height: number;
  titleBandHeight: number;
  columns: string[];
  tracks: LegacyStorylineColumnTrack[];
  nodes: LegacyStorylineNodeGeometry[];
  leftAnchorYByColumn: Record<string, number>;
  rightAnchorYByColumn: Record<string, number>;
}

interface ActivePlanDraft {
  kind: 'active_plan';
  planId: string;
  shortLabel: string;
  text: string;
  status: PlanItem['status'];
  controlState: NonNullable<PlanItem['control_state']>;
  launchRequested: boolean;
  turnIndex: number;
  left: number;
  right: number;
  width: number;
  height: number;
  titleBandHeight: number;
  columns: string[];
  leftAnchorYByColumn: Record<string, number>;
  rightAnchorYByColumn: Record<string, number>;
}

type TurnAreaDraft = SummaryLocalDraft | ActivePlanDraft;

interface PreparedSummaryLocalLayout {
  kind: 'summary';
  summaryId: string;
  shortLabel: string;
  turnIndex: number;
  sourceMinX: number;
  sourceMaxX: number;
  sourceSpanX: number;
  safeScaleFloor: number;
  minimumContentWidth: number;
  contentEdgePaddingPx: number;
  requiredAreaWidth: number;
  height: number;
  titleBandHeight: number;
  columns: string[];
  tracks: LegacyStorylineColumnTrack[];
  nodes: LegacyStorylineNodeGeometry[];
  slotByIndex: Map<number, { left: number; right: number; nodeId: string }>;
  slotMinWidthByIndex: Map<number, number>;
  interspaceByIndex: Map<number, { left: number; right: number }>;
  interspaceMinWidthByIndex: Map<number, number>;
  leftAnchorYByColumn: Record<string, number>;
  rightAnchorYByColumn: Record<string, number>;
}

interface ConvergeLaneIndicatorMetadata {
  rightTurnAtomicCountByLaneKey: Map<string, number>;
  fontSizeByLaneKey: Map<string, number>;
  requiredClearanceByLaneKey: Map<string, number>;
}

const TURN_BASE_WIDTH_PX = 520;
const TURN_MARGIN_BASE_PX = 96;
const CONVERGE_BASE_WIDTH_PX = 116;
const SUMMARY_AREA_CONTENT_PADDING_PX = 10;
const SUMMARY_AREA_TITLE_BAND_BASE_PX = 22;
const SUMMARY_AREA_TITLE_BAND_MIN_PX = 18;
const SUMMARY_AREA_TITLE_BAND_MAX_PX = 32;
const SUMMARY_LOCAL_VIEWPORT_HEIGHT_PX = 180;
const SUMMARY_AREA_EDGE_PADDING_PX = 6;
const SUMMARY_TITLE_SIDE_PADDING_MIN_PX = 8;
const SUMMARY_TITLE_SIDE_PADDING_MAX_PX = 14;
const SUMMARY_TITLE_SIDE_PADDING_RATIO = 0.024;
const SUMMARY_TITLE_CHARACTER_WIDTH_FACTOR = 0.58;
const SUMMARY_TITLE_FONT_HEIGHT_FACTOR = 0.72;
const SUMMARY_TITLE_FONT_MIN_PX = 12.4;
const SUMMARY_TITLE_FONT_MAX_PX = 29;
const SUMMARY_LOCAL_VIEWPORT_GROWTH = 1.25;
const SUMMARY_LOCAL_MAX_LAYOUT_ATTEMPTS = 5;
const SUMMARY_LOCAL_NODE_PORT_GAP_PX = 10;
const SUMMARY_LOCAL_NODE_PORT_PADDING_PX = 16;
const SUMMARY_LOCAL_D1_HARD_FLOOR_PX = 8;
const SUMMARY_LOCAL_MAX_TURN_WIDTH_PASSES = 4;
const SUMMARY_LOCAL_SLOT_PREFERRED_SLACK_RATIO = 0.45;
const SUMMARY_LOCAL_INTERSPACE_PREFERRED_SLACK_RATIO = 0.2;
const ACTIVE_PLAN_TEXT_VISIBILITY_ZOOM_THRESHOLD = 0.5;
const CONVERGE_SUMMARY_BUTTON_RESERVED_TOP_PX = 60;
const ACTIVE_PLAN_LABEL_FONT_PX = 14;
const ACTIVE_PLAN_LABEL_LINE_HEIGHT_PX = 20;
const ACTIVE_PLAN_BODY_TEXT_FONT_PX = 12;
const ACTIVE_PLAN_BODY_TEXT_LINE_HEIGHT_PX = 20;
const ACTIVE_PLAN_BODY_TOP_MARGIN_PX = 8;
const ACTIVE_PLAN_STATUS_ROW_HEIGHT_PX = 20;
const ACTIVE_PLAN_STATUS_ROW_BOTTOM_GAP_PX = 8;
const ACTIVE_PLAN_TEXT_COLUMN_MIN_WIDTH_PX = 144;
const ACTIVE_PLAN_CONTROL_BUTTON_SIZE_PX = 20;
const ACTIVE_PLAN_CONTROL_BUTTON_GAP_PX = 6;
const ACTIVE_PLAN_STATUS_ROW_CONTROL_GAP_PX = 8;
const ACTIVE_PLAN_STATUS_BADGE_ICON_SIZE_PX = 12;
const ACTIVE_PLAN_STATUS_BADGE_LABEL_GAP_PX = 4;
const ACTIVE_PLAN_STATUS_BADGE_HORIZONTAL_PADDING_PX = 8;
const ACTIVE_PLAN_STATUS_BADGE_CHARACTER_WIDTH_PX = 5.8;
const ACTIVE_PLAN_HORIZONTAL_PADDING_PX = 12;
const ACTIVE_PLAN_VERTICAL_PADDING_PX = 10;
const CONVERGE_LANE_D1_BASE_PX = 30;
const CONVERGE_LANE_D2_BASE_PX = 78;
const CONVERGE_EXTENSION_LANE_D1_BOOST_PX = 10;
const TURN_AREA_STACK_D1_BASE_PX = 24;
const TURN_AREA_STACK_D2_BASE_PX = 84;
const TURN_FALLBACK_TOP_OFFSET_PX = 6;
const CONVERGE_EXTENSION_SPLIT_RATIO = 0.52;
const CONVERGE_LABEL_SIDE_PADDING_PX = 14;

function normalizeToken(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cubicPath(
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number
): string {
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function mapSegmentPath(segment: LegacyStorylineTrackSegment): string {
  if (segment.kind === 'interspace_cubic') {
    return cubicPath(
      segment.startX,
      segment.startY,
      segment.c1X ?? segment.startX,
      segment.c1Y ?? segment.startY,
      segment.c2X ?? segment.endX,
      segment.c2Y ?? segment.endY,
      segment.endX,
      segment.endY
    );
  }
  return linePath(segment.startX, segment.startY, segment.endX, segment.endY);
}

function shiftSegmentY(
  segment: LegacyStorylineTrackSegment,
  deltaY: number
): LegacyStorylineTrackSegment {
  const next: LegacyStorylineTrackSegment = {
    ...segment,
    startY: segment.startY + deltaY,
    endY: segment.endY + deltaY,
    c1Y: segment.c1Y == null ? undefined : segment.c1Y + deltaY,
    c2Y: segment.c2Y == null ? undefined : segment.c2Y + deltaY,
  };
  next.path = mapSegmentPath(next);
  return next;
}

function mapLegacySegment(
  segment: LegacyStorylineTrackSegment,
  mapX: (value: number) => number,
  mapY: (value: number) => number
): LegacyStorylineTrackSegment {
  const next: LegacyStorylineTrackSegment = {
    ...segment,
    startX: mapX(segment.startX),
    startY: mapY(segment.startY),
    endX: mapX(segment.endX),
    endY: mapY(segment.endY),
    c1X: segment.c1X == null ? undefined : mapX(segment.c1X),
    c1Y: segment.c1Y == null ? undefined : mapY(segment.c1Y),
    c2X: segment.c2X == null ? undefined : mapX(segment.c2X),
    c2Y: segment.c2Y == null ? undefined : mapY(segment.c2Y),
  };
  next.path = mapSegmentPath(next);
  return next;
}

function buildSummaryRunState(runState: RunState, summary: Summary): RunState {
  const matchedPlan = runState.frontier.find((plan) => plan.plan_id === summary.plan_id);
  const frontier = matchedPlan
    ? [{ ...matchedPlan, status: 'completed' as const }]
    : [
      {
        plan_id: summary.plan_id,
        kind: 'analysis' as const,
        text: summary.short_label || summary.summary || summary.insight_id,
        filters: [],
        embedding: null,
        status: 'completed' as const,
        parent_insight_id: summary.parent_insight_id,
        short_label: summary.short_label || summary.summary || summary.insight_id,
        assigned_sub_agent_id: null,
        final_summary: summary.summary,
        error_message: null,
        created_at: summary.created_at,
        updated_at: summary.created_at,
      },
    ];

  return {
    ...runState,
    frontier,
    insights: [summary],
  };
}

function collectSummaryColumns(summary: Summary): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const atomic of summary.atomic_insights ?? []) {
    for (const rawColumn of atomic.columns ?? []) {
      const column = normalizeToken(rawColumn);
      if (!column || seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

function isPlanStatusTerminal(status: PlanItem['status']): boolean {
  return (
    status === 'completed'
    || status === 'failed'
    || status === 'skipped'
    || status === 'terminated'
  );
}

function collectDispatchTurnPlans(args: {
  runState: RunState;
  grouping: ReturnType<typeof buildStorylineTurnGrouping>;
  events: Event[];
}): Array<{ turnIndex: number; planIds: string[] }> {
  const { runState, grouping, events } = args;
  const planIdsByTurn = new Map<number, string[]>();
  const setTurnPlanIds = (turnIndex: number, rawPlanIds: string[]) => {
    const cleanPlanIds = rawPlanIds
      .map((planId) => String(planId || '').trim())
      .filter((planId) => planId.length > 0);
    if (cleanPlanIds.length === 0) {
      return;
    }
    const dedupedPlanIds: string[] = [];
    const seenIncoming = new Set<string>();
    for (const planId of cleanPlanIds) {
      if (seenIncoming.has(planId)) {
        continue;
      }
      seenIncoming.add(planId);
      dedupedPlanIds.push(planId);
    }
    const existingPlanIds = planIdsByTurn.get(turnIndex) ?? [];
    const trailingExisting = existingPlanIds.filter((planId) => !seenIncoming.has(planId));
    planIdsByTurn.set(turnIndex, [...dedupedPlanIds, ...trailingExisting]);
  };
  const appendPlanId = (turnIndex: number, rawPlanId: string) => {
    const planId = String(rawPlanId || '').trim();
    if (!planId) {
      return;
    }
    const turnPlanIds = planIdsByTurn.get(turnIndex) ?? [];
    if (turnPlanIds.includes(planId)) {
      return;
    }
    turnPlanIds.push(planId);
    planIdsByTurn.set(turnIndex, turnPlanIds);
  };
  const dispatchEvents = events
    .map((event, index) => ({
      event,
      index,
      timestampMs: (() => {
        const parsed = Date.parse(event.timestamp);
        return Number.isFinite(parsed) ? parsed : 0;
      })(),
    }))
    .sort((a, b) => (a.timestampMs === b.timestampMs ? a.index - b.index : a.timestampMs - b.timestampMs));
  for (const timed of dispatchEvents) {
    if (timed.event.event_type !== 'master_agent_tool_result') {
      continue;
    }
    const data = timed.event.data as { tool_name?: unknown; result?: unknown };
    if (data?.tool_name !== 'dispatch_plans') {
      continue;
    }
    const result = data.result as {
      dispatch_turn_index?: unknown;
      plan_ids?: unknown;
      dispatched_plan_ids?: unknown;
    } | null;
    const rawPlanIds = Array.isArray(result?.plan_ids)
      ? result.plan_ids
      : Array.isArray(result?.dispatched_plan_ids)
        ? result.dispatched_plan_ids
        : [];
    if (rawPlanIds.length === 0) {
      continue;
    }
    let turnIndex = typeof result?.dispatch_turn_index === 'number'
      ? result.dispatch_turn_index
      : null;
    if (turnIndex == null) {
      const firstMappedTurnIndex = rawPlanIds
        .map((planId) => grouping.planTurnIndexByPlanId.get(String(planId)))
        .find((value): value is number => typeof value === 'number');
      turnIndex = firstMappedTurnIndex ?? null;
    }
    if (turnIndex == null) {
      continue;
    }
    setTurnPlanIds(turnIndex, rawPlanIds.map((planId) => String(planId)));
  }
  for (const batch of runState.master_agent_state?.dispatch_batches ?? []) {
    setTurnPlanIds(batch.dispatch_turn_index, (batch.plan_ids ?? []).map((planId) => String(planId)));
  }
  for (const plan of runState.frontier) {
    const turnIndex = grouping.planTurnIndexByPlanId.get(plan.plan_id);
    if (typeof turnIndex !== 'number') {
      continue;
    }
    appendPlanId(turnIndex, plan.plan_id);
  }
  return [...planIdsByTurn.entries()]
    .map(([turnIndex, planIds]) => ({ turnIndex, planIds }))
    .sort((a, b) => a.turnIndex - b.turnIndex);
}

function collectLatestActivePlans(
  runState: RunState,
  grouping: ReturnType<typeof buildStorylineTurnGrouping>,
  events: Event[]
): Array<{
  plan: PlanItem;
  turnIndex: number;
}> {
  const batches = collectDispatchTurnPlans({ runState, grouping, events });
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    const plans = batch.planIds
      .map((planId) => planById.get(planId))
      .filter((plan): plan is PlanItem => Boolean(plan));
    if (!plans.some((plan) => !isPlanStatusTerminal(plan.status))) {
      continue;
    }
    return plans
      .filter((plan) => !isPlanStatusTerminal(plan.status))
      .map((plan) => ({
        plan,
        turnIndex: batch.turnIndex,
      }));
  }
  return [];
}

function estimateActivePlanCharacterWidthPx(character: string, fontSizePx: number): number {
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
    return fontSizePx * 0.58;
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

function estimateActivePlanTokenWidthPx(token: string, fontSizePx: number): number {
  let width = 0;
  for (const character of token) {
    width += estimateActivePlanCharacterWidthPx(character, fontSizePx);
  }
  return width;
}

function estimateWrappedTextLineCount(
  text: string,
  availableWidthPx: number,
  fontSizePx: number
): number {
  const safeWidth = Math.max(fontSizePx * 6, availableWidthPx);
  const paragraphs = text.split(/\r?\n/);
  return paragraphs.reduce((total, paragraph) => {
    const normalized = paragraph.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return total + 1;
    }

    const chunks = normalized.match(/\S+\s*/g) ?? [normalized];
    let lines = 1;
    let currentLineWidth = 0;

    for (const chunk of chunks) {
      const trimmedChunk = chunk.trimEnd();
      const chunkWidth = estimateActivePlanTokenWidthPx(trimmedChunk, fontSizePx);

      if (trimmedChunk && currentLineWidth > 0 && currentLineWidth + chunkWidth > safeWidth) {
        lines += 1;
        currentLineWidth = 0;
      }

      if (chunkWidth <= safeWidth) {
        currentLineWidth += chunkWidth;
        continue;
      }

      for (const character of trimmedChunk) {
        const characterWidth = estimateActivePlanCharacterWidthPx(character, fontSizePx);
        if (currentLineWidth > 0 && currentLineWidth + characterWidth > safeWidth) {
          lines += 1;
          currentLineWidth = 0;
        }
        currentLineWidth += characterWidth;
      }
    }

    return total + lines;
  }, 0);
}

function normalizeActivePlanDisplayText(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateActivePlanDisplayText(text: string | null | undefined): string {
  const normalized = normalizeActivePlanDisplayText(text);
  if (!normalized) {
    return '';
  }
  const englishPeriodIndex = normalized.indexOf('.');
  const chinesePeriodIndex = normalized.indexOf('。');
  const periodIndexes = [englishPeriodIndex, chinesePeriodIndex].filter((index) => index >= 0);
  if (periodIndexes.length === 0) {
    return normalized;
  }
  const cutoffIndex = Math.min(...periodIndexes);
  return normalized.slice(0, cutoffIndex + 1).trim();
}

const ACTIVE_PLAN_KNOWN_ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
]);

function normalizeActivePlanSentenceToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[\[\(\{'"`\u201c\u2018]+/, '')
    .replace(/[\]\)\}'"`\u201d\u2019,;:!?]+$/, '');
}

function isActivePlanAbbreviationToken(token: string): boolean {
  const normalizedToken = normalizeActivePlanSentenceToken(token);
  if (!normalizedToken) {
    return false;
  }
  if (ACTIVE_PLAN_KNOWN_ABBREVIATIONS.has(normalizedToken)) {
    return true;
  }
  return /^(?:[a-z]\.){2,}$/i.test(normalizedToken);
}

function isActivePlanSentenceBoundaryWithAbbreviationSupport(text: string, index: number): boolean {
  const character = text[index];
  if (
    character === '\u3002'
    || character === '\uff01'
    || character === '\uff1f'
    || character === '!'
    || character === '?'
  ) {
    return true;
  }
  if (character !== '.') {
    return false;
  }

  const previousChar = index > 0 ? text[index - 1] : '';
  const nextChar = index + 1 < text.length ? text[index + 1] : '';
  if (/\d/.test(previousChar) && /\d/.test(nextChar)) {
    return false;
  }

  let tokenStart = index;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? '')) {
    tokenStart -= 1;
  }
  let tokenEnd = index + 1;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) {
    tokenEnd += 1;
  }
  const token = text.slice(tokenStart, tokenEnd);
  if (isActivePlanAbbreviationToken(token)) {
    return false;
  }

  return true;
}

function truncateActivePlanDisplayTextPreservingAbbreviations(
  text: string | null | undefined
): string {
  const normalized = normalizeActivePlanDisplayText(text);
  if (!normalized) {
    return '';
  }
  const fallbackTruncation = truncateActivePlanDisplayText(normalized);
  const hasPotentialAbbreviation = /\b(?:[a-z]\.){2,}|(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc)\./i.test(normalized);
  if (!hasPotentialAbbreviation) {
    return fallbackTruncation;
  }
  for (let index = 0; index < normalized.length; index += 1) {
    if (!isActivePlanSentenceBoundaryWithAbbreviationSupport(normalized, index)) {
      continue;
    }
    return normalized.slice(0, index + 1).trim();
  }
  return normalized;
}

function resolveActivePlanDisplayFields(
  plan: Pick<PlanItem, 'plan_id' | 'short_label' | 'text'>
): {
  shortLabel: string;
  text: string;
  hasSeparateBodyText: boolean;
} {
  const shortLabel = normalizeActivePlanDisplayText(plan.short_label);
  const displayText = truncateActivePlanDisplayTextPreservingAbbreviations(plan.text);
  const fallbackText = normalizeActivePlanDisplayText(plan.text);
  const resolvedText = displayText || fallbackText || plan.plan_id;
  const hasMeaningfulShortLabel = (
    shortLabel.length > 0
    && shortLabel !== fallbackText
    && shortLabel !== resolvedText
  );
  const resolvedShortLabel = hasMeaningfulShortLabel
    ? shortLabel
    : resolvedText;
  return {
    shortLabel: resolvedShortLabel,
    text: resolvedText,
    hasSeparateBodyText: hasMeaningfulShortLabel && resolvedText.length > 0,
  };
}

function resolveActivePlanDisplayStatus(
  plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>
): PlanItem['status'] {
  if (plan.control_state === 'terminate_requested' && plan.status !== 'terminated') {
    return 'terminated';
  }
  if (plan.control_state === 'pause_requested' && plan.status !== 'paused') {
    return 'paused';
  }
  return plan.status;
}

function getActivePlanVisibleActionCount(
  plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>
): number {
  const displayStatus = resolveActivePlanDisplayStatus(plan);
  if (displayStatus === 'pending' || displayStatus === 'paused') {
    return 3;
  }
  if (displayStatus === 'analyzing' || displayStatus === 'summarizing') {
    return 3;
  }
  if (
    displayStatus === 'completed'
    || displayStatus === 'failed'
    || displayStatus === 'terminated'
  ) {
    return 1;
  }
  return 0;
}

function getActivePlanStatusLabel(plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>): string {
  if (resolveActivePlanDisplayStatus(plan) === 'pending' && plan.launch_requested) {
    return 'launch requested';
  }
  switch (resolveActivePlanDisplayStatus(plan)) {
    case 'paused':
      return 'paused';
    case 'terminated':
      return 'terminated';
    case 'completed':
      return 'completed';
    case 'analyzing':
      return 'analyzing';
    case 'summarizing':
      return 'summarizing';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

function estimateActivePlanStatusBadgeWidth(
  plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>
): number {
  const label = getActivePlanStatusLabel(plan);
  return Math.ceil(
    ACTIVE_PLAN_STATUS_BADGE_HORIZONTAL_PADDING_PX * 2
    + ACTIVE_PLAN_STATUS_BADGE_ICON_SIZE_PX
    + ACTIVE_PLAN_STATUS_BADGE_LABEL_GAP_PX
    + label.length * ACTIVE_PLAN_STATUS_BADGE_CHARACTER_WIDTH_PX
  );
}

function estimateActivePlanControlsWidth(
  plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>
): number {
  const actionCount = getActivePlanVisibleActionCount(plan);
  if (actionCount <= 0) {
    return 0;
  }
  return (
    actionCount * ACTIVE_PLAN_CONTROL_BUTTON_SIZE_PX
    + Math.max(0, actionCount - 1) * ACTIVE_PLAN_CONTROL_BUTTON_GAP_PX
  );
}

function estimateActivePlanRequiredAreaWidth(args: {
  plan: Pick<PlanItem, 'status' | 'control_state' | 'launch_requested'>;
  showPlanText: boolean;
}): number {
  const { plan, showPlanText } = args;
  const controlsWidth = estimateActivePlanControlsWidth(plan);
  const statusRowWidth = estimateActivePlanStatusBadgeWidth(plan) + (
    controlsWidth > 0
      ? ACTIVE_PLAN_STATUS_ROW_CONTROL_GAP_PX + controlsWidth
      : 0
  );
  const innerWidth = Math.max(
    statusRowWidth,
    showPlanText ? ACTIVE_PLAN_TEXT_COLUMN_MIN_WIDTH_PX : 0
  );
  return Math.ceil(innerWidth + ACTIVE_PLAN_HORIZONTAL_PADDING_PX * 2);
}

function estimateActivePlanAreaHeight(args: {
  shortLabel: string;
  text: string;
  width: number;
  hasSeparateBodyText: boolean;
  showPlanText: boolean;
}): number {
  const { shortLabel, text, width, hasSeparateBodyText, showPlanText } = args;
  const innerWidth = Math.max(1, width - ACTIVE_PLAN_HORIZONTAL_PADDING_PX * 2);
  const labelLineCount = showPlanText
    ? estimateWrappedTextLineCount(
      shortLabel,
      innerWidth,
      ACTIVE_PLAN_LABEL_FONT_PX
    )
    : 0;
  const headerBlockHeight = ACTIVE_PLAN_STATUS_ROW_HEIGHT_PX + (
    showPlanText
      ? ACTIVE_PLAN_STATUS_ROW_BOTTOM_GAP_PX + labelLineCount * ACTIVE_PLAN_LABEL_LINE_HEIGHT_PX
      : 0
  );
  const bodyLineCount = showPlanText && hasSeparateBodyText
    ? estimateWrappedTextLineCount(
      text,
      innerWidth,
      ACTIVE_PLAN_BODY_TEXT_FONT_PX
    )
    : 0;
  const bodyTextHeight = showPlanText && hasSeparateBodyText
    ? ACTIVE_PLAN_BODY_TOP_MARGIN_PX + bodyLineCount * ACTIVE_PLAN_BODY_TEXT_LINE_HEIGHT_PX
    : 0;
  return Math.ceil(
    ACTIVE_PLAN_VERTICAL_PADDING_PX * 2
    + headerBlockHeight
    + bodyTextHeight
  );
}

function estimateSummaryLocalViewportHeight(
  summary: Summary,
  profile: StorylineAdaptiveProfile,
  viewportWidthPx: number
): number {
  const maxColumnCount = Math.max(
    1,
    ...summary.atomic_insights.map((atomic) => {
      const normalizedColumns = (atomic.columns ?? [])
        .map((column) => normalizeToken(column))
        .filter(Boolean);
      return Math.max(1, normalizedColumns.length);
    })
  );
  const glyphRange = computeGlyphDiameterRange(viewportWidthPx, SUMMARY_LOCAL_VIEWPORT_HEIGHT_PX);
  const routeBoxMinDim = glyphRange.maxDiameter + 4;
  const requiredPortSpan = maxColumnCount <= 1
    ? routeBoxMinDim
    : Math.max(
      routeBoxMinDim,
      (maxColumnCount - 1) * SUMMARY_LOCAL_NODE_PORT_GAP_PX + SUMMARY_LOCAL_NODE_PORT_PADDING_PX
    );
  const estimatedRouteBoxHeight = Math.max(routeBoxMinDim, requiredPortSpan);
  return Math.max(
    SUMMARY_LOCAL_VIEWPORT_HEIGHT_PX,
    Math.ceil(
      44 +
      estimatedRouteBoxHeight +
      Math.max(0, maxColumnCount - 1) * SUMMARY_LOCAL_D1_HARD_FLOOR_PX * profile.d1Scale
    )
  );
}

function satisfiesSummaryLocalD1(layout: ReturnType<typeof buildLegacyAtomicLayout>): boolean {
  const solved = layout.solvedLayout;
  if (!solved || solved.yMatrix.length === 0) return true;
  const epsilon = 1e-4;

  for (let slotIndex = 0; slotIndex < solved.yMatrix.length; slotIndex += 1) {
    const rankEntries = solved.M_order[slotIndex]
      ?.map((rank, columnIndex) => ({ rank, columnIndex }))
      .sort((a, b) => a.rank - b.rank) ?? [];
    const requiredGap = solved.d1BySlot[slotIndex] ?? 0;
    for (let rank = 1; rank < rankEntries.length; rank += 1) {
      const prevColumn = rankEntries[rank - 1]?.columnIndex;
      const column = rankEntries[rank]?.columnIndex;
      if (typeof prevColumn !== 'number' || typeof column !== 'number') continue;
      const gap = solved.yMatrix[slotIndex][column] - solved.yMatrix[slotIndex][prevColumn];
      if (gap + epsilon < requiredGap) return false;
    }
  }

  return true;
}

function computeSummaryLocalMinimumContentWidth(layout: ReturnType<typeof buildLegacyAtomicLayout>): {
  minimumContentWidth: number;
  sourceContentWidth: number;
  safeScaleFloor: number;
  slotMinWidthByIndex: Map<number, number>;
  interspaceMinWidthByIndex: Map<number, number>;
} {
  const solved = layout.solvedLayout;
  if (!solved || solved.slots.length === 0) {
    return {
      minimumContentWidth: 1,
      sourceContentWidth: 1,
      safeScaleFloor: 1,
      slotMinWidthByIndex: new Map<number, number>(),
      interspaceMinWidthByIndex: new Map<number, number>(),
    };
  }

  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  let sourceContentWidth = 0;
  let minimumContentWidth = 0;
  const slotMinWidthByIndex = new Map<number, number>();
  const interspaceMinWidthByIndex = new Map<number, number>();

  for (const slot of solved.slots) {
    const node = nodeById.get(slot.nodeId);
    const sourceSlotWidth = Math.max(1e-6, slot.right - slot.left);
    const requiredSlotWidth = computeMinimumSlotWidthPx(
      node?.width ?? (slot.nodeRight - slot.nodeLeft),
      node?.height ?? 0,
      layout.adaptiveProfile
    );
    slotMinWidthByIndex.set(slot.index, requiredSlotWidth);
    sourceContentWidth += sourceSlotWidth;
    minimumContentWidth += requiredSlotWidth;
  }

  for (let interspaceIndex = 0; interspaceIndex < solved.interspaces.length; interspaceIndex += 1) {
    const interspace = solved.interspaces[interspaceIndex];
    const leftSlot = solved.slots[interspaceIndex];
    const rightSlot = solved.slots[interspaceIndex + 1];
    if (!interspace || !leftSlot || !rightSlot) continue;

    const leftNode = nodeById.get(leftSlot.nodeId);
    const rightNode = nodeById.get(rightSlot.nodeId);
    if (!leftNode || !rightNode) continue;

    const sourceInterspaceWidth = Math.max(1e-6, interspace.right - interspace.left);
    const requiredInterspaceWidth = computeMinimumInterspaceWidthPx({
      leftWidth: leftNode.width,
      leftHeight: leftNode.height,
      leftY: leftNode.y,
      rightWidth: rightNode.width,
      rightHeight: rightNode.height,
      rightY: rightNode.y,
      profile: layout.adaptiveProfile,
    });
    interspaceMinWidthByIndex.set(
      interspace.index,
      requiredInterspaceWidth
    );
    sourceContentWidth += sourceInterspaceWidth;
    minimumContentWidth += requiredInterspaceWidth;
  }

  return {
    minimumContentWidth: Math.max(1, minimumContentWidth),
    sourceContentWidth: Math.max(1, sourceContentWidth),
    safeScaleFloor: Math.max(1e-6, minimumContentWidth / Math.max(1e-6, sourceContentWidth)),
    slotMinWidthByIndex,
    interspaceMinWidthByIndex,
  };
}

function computeSummaryAreaTitleBandHeight(args: {
  profile: StorylineAdaptiveProfile;
  requiredAreaWidth: number;
}): number {
  const { profile, requiredAreaWidth } = args;
  const widthFactor = clamp(requiredAreaWidth / 360, 0.84, 1.14);
  return clamp(
    SUMMARY_AREA_TITLE_BAND_BASE_PX * profile.labelScale * widthFactor,
    SUMMARY_AREA_TITLE_BAND_MIN_PX,
    SUMMARY_AREA_TITLE_BAND_MAX_PX
  );
}

function normalizeSummaryTitleLabel(label: string): string {
  return String(label || '').replace(/\s+/g, ' ').trim();
}

function estimateSummaryTitleRequiredAreaWidth(args: {
  shortLabel: string;
  profile: StorylineAdaptiveProfile;
  minimumAreaWidth: number;
}): number {
  const { shortLabel, profile, minimumAreaWidth } = args;
  const normalizedLabel = normalizeSummaryTitleLabel(shortLabel);
  if (!normalizedLabel) {
    return Math.max(0, minimumAreaWidth);
  }

  let requiredAreaWidth = Math.max(0, minimumAreaWidth);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const titleBandHeight = computeSummaryAreaTitleBandHeight({
      profile,
      requiredAreaWidth,
    });
    const paddingX = clamp(
      requiredAreaWidth * SUMMARY_TITLE_SIDE_PADDING_RATIO,
      SUMMARY_TITLE_SIDE_PADDING_MIN_PX,
      SUMMARY_TITLE_SIDE_PADDING_MAX_PX
    );
    const availableWidth = Math.max(24, requiredAreaWidth - paddingX * 2);
    const fontSizeByWidth = availableWidth / Math.max(
      3.8,
      normalizedLabel.length * SUMMARY_TITLE_CHARACTER_WIDTH_FACTOR
    );
    const fontSizeByHeight = titleBandHeight * SUMMARY_TITLE_FONT_HEIGHT_FACTOR;
    const scaledFontSize = Math.min(fontSizeByWidth, fontSizeByHeight) * clamp(profile.labelScale, 0.9, 1.15);
    const fontSize = clamp(scaledFontSize, SUMMARY_TITLE_FONT_MIN_PX, SUMMARY_TITLE_FONT_MAX_PX);
    const estimatedTextWidth = estimateActivePlanTokenWidthPx(normalizedLabel, fontSize);
    const nextRequiredAreaWidth = Math.max(
      requiredAreaWidth,
      estimatedTextWidth + paddingX * 2 + 1
    );
    if (nextRequiredAreaWidth <= requiredAreaWidth + 0.5) {
      return nextRequiredAreaWidth;
    }
    requiredAreaWidth = nextRequiredAreaWidth;
  }

  return requiredAreaWidth;
}

function computeRequiredTurnWidth(args: {
  baseTurnWidth: number;
  turnMargin: number;
  requiredAreaWidth: number;
}): number {
  return Math.max(args.baseTurnWidth, args.requiredAreaWidth + args.turnMargin * 2);
}

function prepareSummaryLocalLayout(args: {
  summary: Summary;
  turnIndex: number;
  runState: RunState;
  profile: StorylineAdaptiveProfile;
  viewportWidthPx: number;
  boundaryContract?: SummaryBoundaryContract | null;
}): PreparedSummaryLocalLayout {
  const { summary, turnIndex, runState, profile, viewportWidthPx, boundaryContract } = args;
  const shortLabel = summary.short_label || summary.summary || summary.insight_id;
  const summaryRunState = buildSummaryRunState(runState, summary);
  const summaryLocalLayoutZoomX = Math.min(profile.xZoomRatio, 1);
  const boundaryLayoutContract: StorylineBoundaryContractInput | undefined = boundaryContract
    ? {
      leftPortColumnsInOrder: boundaryContract.leftPortColumnsInOrder,
      leftPortTargetYByColumn: boundaryContract.leftPortTargetYByColumn,
      leftPortMinGapPx: boundaryContract.leftPortMinGapPx,
    }
    : undefined;
  const requiredIngressSpanPx = typeof boundaryContract?.requiredIngressSpanPx === 'number'
    ? boundaryContract.requiredIngressSpanPx
    : 0;
  let localViewportHeight = Math.max(
    estimateSummaryLocalViewportHeight(summary, profile, viewportWidthPx),
    requiredIngressSpanPx > 0
      ? Math.ceil(requiredIngressSpanPx + 52)
      : 0
  );
  let legacyLayout = buildStorylineLayoutWithBoundaryContract(summaryRunState, localViewportHeight, {
    yUpperBoundPx: 16,
    yLowerBoundPx: localViewportHeight - 18,
    yMedianTargetPx: localViewportHeight / 2,
    xZoomRatio: summaryLocalLayoutZoomX,
    viewportWidthPx,
    boundaryContract: boundaryLayoutContract,
  });

  for (let attempt = 1; attempt < SUMMARY_LOCAL_MAX_LAYOUT_ATTEMPTS; attempt += 1) {
    if (legacyLayout.nodes.length === 0 || legacyLayout.tracks.length === 0 || satisfiesSummaryLocalD1(legacyLayout)) {
      break;
    }
    localViewportHeight = Math.ceil(localViewportHeight * SUMMARY_LOCAL_VIEWPORT_GROWTH);
    legacyLayout = buildStorylineLayoutWithBoundaryContract(summaryRunState, localViewportHeight, {
      yUpperBoundPx: 16,
      yLowerBoundPx: localViewportHeight - 18,
      yMedianTargetPx: localViewportHeight / 2,
      xZoomRatio: summaryLocalLayoutZoomX,
      viewportWidthPx,
      boundaryContract: boundaryLayoutContract,
    });
  }

  const fallbackColumns = collectSummaryColumns(summary);
  const fallbackRequiredAreaWidth = estimateSummaryTitleRequiredAreaWidth({
    shortLabel,
    profile,
    minimumAreaWidth: 0,
  });
  const fallbackTitleBandHeight = computeSummaryAreaTitleBandHeight({
    profile,
    requiredAreaWidth: fallbackRequiredAreaWidth,
  });
  if (legacyLayout.nodes.length === 0 || legacyLayout.tracks.length === 0) {
    return {
      kind: 'summary',
      summaryId: summary.insight_id,
      shortLabel,
      turnIndex,
      sourceMinX: 0,
      sourceMaxX: 1,
      sourceSpanX: 1,
      safeScaleFloor: 1,
      minimumContentWidth: 1,
      contentEdgePaddingPx: SUMMARY_AREA_EDGE_PADDING_PX,
      requiredAreaWidth: fallbackRequiredAreaWidth,
      height: 56 + fallbackTitleBandHeight,
      titleBandHeight: fallbackTitleBandHeight,
      columns: fallbackColumns,
      tracks: [],
      nodes: [],
      slotByIndex: new Map<number, { left: number; right: number; nodeId: string }>(),
      slotMinWidthByIndex: new Map<number, number>(),
      interspaceByIndex: new Map<number, { left: number; right: number }>(),
      interspaceMinWidthByIndex: new Map<number, number>(),
      leftAnchorYByColumn: {},
      rightAnchorYByColumn: {},
    };
  }

  const slotBoundaryXs = legacyLayout.solvedLayout?.slotBoundaryXs ?? [];
  const sourceMinX = slotBoundaryXs.length > 0
    ? Math.min(...slotBoundaryXs)
    : Math.min(...legacyLayout.nodes.map((node) => node.x));
  const sourceMaxX = slotBoundaryXs.length > 0
    ? Math.max(...slotBoundaryXs)
    : Math.max(...legacyLayout.nodes.map((node) => node.x));
  const sourceSpanX = Math.max(1, sourceMaxX - sourceMinX);
  const {
    minimumContentWidth,
    sourceContentWidth,
    safeScaleFloor,
    slotMinWidthByIndex,
    interspaceMinWidthByIndex,
  } = computeSummaryLocalMinimumContentWidth(legacyLayout);
  const lowZoomExpansionRatio = clamp((1 - profile.xZoomRatio) / 0.5, 0, 1);
  const requiredContentWidth = minimumContentWidth
    + (sourceContentWidth - minimumContentWidth) * lowZoomExpansionRatio;
  const contentRequiredAreaWidth = SUMMARY_AREA_EDGE_PADDING_PX * 2 + requiredContentWidth;
  const requiredAreaWidth = estimateSummaryTitleRequiredAreaWidth({
    shortLabel,
    profile,
    minimumAreaWidth: contentRequiredAreaWidth,
  });
  const titleBandHeight = computeSummaryAreaTitleBandHeight({
    profile,
    requiredAreaWidth,
  });

  const sourceMinY = legacyLayout.solvedLayout?.yTop
    ?? Math.min(...legacyLayout.nodes.map((node) => node.y));
  const normalizeY = (value: number) => value - sourceMinY;

  const nodes = legacyLayout.nodes.map((node) => ({
    ...node,
    y: normalizeY(node.y),
  }));

  const slotByIndex = new Map<number, { left: number; right: number; nodeId: string }>();
  for (const slot of legacyLayout.solvedLayout?.slots ?? []) {
    slotByIndex.set(slot.index, {
      left: slot.left,
      right: slot.right,
      nodeId: slot.nodeId,
    });
  }
  const interspaceByIndex = new Map<number, { left: number; right: number }>();
  for (const interspace of legacyLayout.solvedLayout?.interspaces ?? []) {
    interspaceByIndex.set(interspace.index, {
      left: interspace.left,
      right: interspace.right,
    });
  }

  const leftAnchorYByColumn: Record<string, number> = {};
  const rightAnchorYByColumn: Record<string, number> = {};

  const tracks = legacyLayout.tracks.map((track) => {
    const segments = track.segments
      .filter((segment) => segment.kind === 'slot_horizontal' || segment.kind === 'interspace_cubic')
      .map((segment) => mapLegacySegment(segment, (value) => value, normalizeY));

    const anchors = track.anchors.map((anchor) => ({ x: anchor.x, y: normalizeY(anchor.y) }));
    const fallbackY = nodes.length > 0 ? medianValue(nodes.map((node) => node.y)) : 0;
    const leftY = anchors.length > 0 ? anchors[0].y : fallbackY;
    const rightY = anchors.length > 0 ? anchors[anchors.length - 1].y : fallbackY;
    leftAnchorYByColumn[track.column] = leftY;
    rightAnchorYByColumn[track.column] = rightY;

    const xValues: number[] = [];
    const yValues: number[] = [];
    for (const segment of segments) {
      xValues.push(segment.startX, segment.endX);
      yValues.push(segment.startY, segment.endY);
      if (segment.c1X !== undefined && segment.c2X !== undefined) xValues.push(segment.c1X, segment.c2X);
      if (segment.c1Y !== undefined && segment.c2Y !== undefined) yValues.push(segment.c1Y, segment.c2Y);
    }

    return {
      ...track,
      id: track.id,
      segments,
      path: segments.map((segment) => segment.path).join(' '),
      anchors,
      minX: xValues.length > 0 ? Math.min(...xValues) : sourceMinX,
      maxX: xValues.length > 0 ? Math.max(...xValues) : sourceMaxX,
      minY: yValues.length > 0 ? Math.min(...yValues) : 0,
      maxY: yValues.length > 0 ? Math.max(...yValues) : 0,
      leftExtension: null,
      rightExtension: null,
    };
  });

  const nodeBounds = nodes.flatMap((node) => [node.y - node.height / 2, node.y + node.height / 2]);
  const trackBounds = tracks.flatMap((track) => [track.minY, track.maxY]);
  const contentMinY = Math.min(...(nodeBounds.length > 0 || trackBounds.length > 0
    ? [...nodeBounds, ...trackBounds]
    : [0]));
  const contentMaxY = Math.max(...(nodeBounds.length > 0 || trackBounds.length > 0
    ? [...nodeBounds, ...trackBounds]
    : [0]));
  const contentHeight = Math.max(1, contentMaxY - contentMinY);
  const localYOffset = titleBandHeight + SUMMARY_AREA_CONTENT_PADDING_PX - contentMinY;

  const normalizedNodes = nodes.map((node) => ({
    ...node,
    y: node.y + localYOffset,
  }));
  const normalizedTracks = tracks.map((track) => {
    const shiftedSegments = track.segments.map((segment) => shiftSegmentY(segment, localYOffset));
    return {
      ...track,
      segments: shiftedSegments,
      path: shiftedSegments.map((segment) => segment.path).join(' '),
      anchors: track.anchors.map((anchor) => ({ x: anchor.x, y: anchor.y + localYOffset })),
      minY: track.minY + localYOffset,
      maxY: track.maxY + localYOffset,
    };
  });
  const normalizedLeftAnchorYByColumn: Record<string, number> = {};
  const normalizedRightAnchorYByColumn: Record<string, number> = {};
  for (const [column, y] of Object.entries(leftAnchorYByColumn)) {
    normalizedLeftAnchorYByColumn[column] = y + localYOffset;
  }
  for (const [column, y] of Object.entries(rightAnchorYByColumn)) {
    normalizedRightAnchorYByColumn[column] = y + localYOffset;
  }

  const columns = tracks.map((track) => track.column);
  const height = titleBandHeight + contentHeight + SUMMARY_AREA_CONTENT_PADDING_PX * 2;

  return {
    kind: 'summary',
    summaryId: summary.insight_id,
    shortLabel,
    turnIndex,
    sourceMinX,
    sourceMaxX,
    sourceSpanX,
    safeScaleFloor,
    minimumContentWidth,
    contentEdgePaddingPx: SUMMARY_AREA_EDGE_PADDING_PX,
    requiredAreaWidth,
    height,
    titleBandHeight,
    columns: columns.length > 0 ? columns : fallbackColumns,
    tracks: normalizedTracks,
    nodes: normalizedNodes,
    slotByIndex,
    slotMinWidthByIndex,
    interspaceByIndex,
    interspaceMinWidthByIndex,
    leftAnchorYByColumn: normalizedLeftAnchorYByColumn,
    rightAnchorYByColumn: normalizedRightAnchorYByColumn,
  };
}

function createSummaryLocalXMapper(args: {
  prepared: PreparedSummaryLocalLayout;
  contentLeft: number;
  targetSpanX: number;
}): (value: number) => number {
  const { prepared, contentLeft, targetSpanX } = args;
  const slotEntries = [...prepared.slotByIndex.entries()].sort((a, b) => a[0] - b[0]);
  if (slotEntries.length === 0 || prepared.minimumContentWidth <= 1e-6) {
    return (value: number) => contentLeft + ((value - prepared.sourceMinX) / prepared.sourceSpanX) * targetSpanX;
  }

  const segments: Array<{
    sourceStart: number;
    sourceEnd: number;
    minTargetWidth: number;
    preferredTargetWidth: number;
  }> = [];

  for (let slotEntryIndex = 0; slotEntryIndex < slotEntries.length; slotEntryIndex += 1) {
    const [slotIndex, slot] = slotEntries[slotEntryIndex];
    if (slotEntryIndex > 0) {
      const interspace = prepared.interspaceByIndex.get(slotIndex - 1);
      if (interspace) {
        const sourceWidth = Math.max(1e-6, interspace.right - interspace.left);
        const minTargetWidth = prepared.interspaceMinWidthByIndex.get(slotIndex - 1)
          ?? sourceWidth;
        segments.push({
          sourceStart: interspace.left,
          sourceEnd: interspace.right,
          minTargetWidth,
          preferredTargetWidth: minTargetWidth
            + Math.max(0, sourceWidth - minTargetWidth) * SUMMARY_LOCAL_INTERSPACE_PREFERRED_SLACK_RATIO,
        });
      }
    }
    const sourceWidth = Math.max(1e-6, slot.right - slot.left);
    const minTargetWidth = prepared.slotMinWidthByIndex.get(slotIndex)
      ?? sourceWidth;
    segments.push({
      sourceStart: slot.left,
      sourceEnd: slot.right,
      minTargetWidth,
      preferredTargetWidth: minTargetWidth
        + Math.max(0, sourceWidth - minTargetWidth) * SUMMARY_LOCAL_SLOT_PREFERRED_SLACK_RATIO,
    });
  }

  const sourceStart = slotEntries[0]?.[1].left ?? prepared.sourceMinX;
  const sourceEnd = slotEntries[slotEntries.length - 1]?.[1].right ?? prepared.sourceMaxX;
  const preferredContentWidth = Math.max(
    prepared.minimumContentWidth,
    segments.reduce((sum, segment) => sum + segment.preferredTargetWidth, 0)
  );
  const usedContentWidth = Math.min(targetSpanX, preferredContentWidth);
  const centeredContentLeft = contentLeft + Math.max(0, targetSpanX - usedContentWidth) / 2;
  const minContentWidth = Math.max(1e-6, prepared.minimumContentWidth);
  const preferredOverflow = Math.max(0, preferredContentWidth - minContentWidth);
  const interpolation = preferredOverflow <= 1e-6
    ? 0
    : clamp((usedContentWidth - minContentWidth) / preferredOverflow, 0, 1);
  const targetBoundaries: number[] = [centeredContentLeft];
  for (const segment of segments) {
    const targetWidth = usedContentWidth + 1e-6 < minContentWidth
      ? segment.minTargetWidth * (usedContentWidth / minContentWidth)
      : segment.minTargetWidth
        + (segment.preferredTargetWidth - segment.minTargetWidth) * interpolation;
    targetBoundaries.push(
      targetBoundaries[targetBoundaries.length - 1] + targetWidth
    );
  }

  return (value: number) => {
    const clampedValue = clamp(value, sourceStart, sourceEnd);
    let segmentIndex = segments.findIndex((segment, index) => (
      clampedValue <= segment.sourceEnd || index === segments.length - 1
    ));
    if (segmentIndex < 0) segmentIndex = segments.length - 1;
    const segment = segments[segmentIndex];
    const sourceWidth = Math.max(1e-6, segment.sourceEnd - segment.sourceStart);
    const ratio = clamp((clampedValue - segment.sourceStart) / sourceWidth, 0, 1);
    const targetStart = targetBoundaries[segmentIndex];
    const targetEnd = targetBoundaries[segmentIndex + 1];
    return targetStart + (targetEnd - targetStart) * ratio;
  };
}

function mapPreparedSummaryLocalLayoutToTurn(args: {
  prepared: PreparedSummaryLocalLayout;
  areaLeft: number;
  areaRight: number;
}): SummaryLocalDraft {
  const { prepared, areaLeft, areaRight } = args;
  const width = Math.max(1, areaRight - areaLeft);
  const contentLeft = areaLeft + prepared.contentEdgePaddingPx;
  const contentRight = Math.max(contentLeft + 1, areaRight - prepared.contentEdgePaddingPx);
  const targetSpanX = Math.max(1, contentRight - contentLeft);
  const mapX = createSummaryLocalXMapper({
    prepared,
    contentLeft,
    targetSpanX,
  });

  const nodes = prepared.nodes.map((node) => ({
    ...node,
    x: mapX(node.x),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const mappedSlotsByIndex = new Map<number, {
    left: number;
    right: number;
    nodeLeft: number;
    nodeRight: number;
  }>();
  for (const [slotIndex, slot] of prepared.slotByIndex.entries()) {
    const mappedNode = nodeById.get(slot.nodeId);
    mappedSlotsByIndex.set(slotIndex, {
      left: mapX(slot.left),
      right: mapX(slot.right),
      nodeLeft: mappedNode ? mappedNode.x - mappedNode.width / 2 : mapX(slot.left),
      nodeRight: mappedNode ? mappedNode.x + mappedNode.width / 2 : mapX(slot.right),
    });
  }

  const mappedSlotEntries = [...mappedSlotsByIndex.entries()].sort((a, b) => a[0] - b[0]);
  const mappedFirstSlotLeft = mappedSlotEntries.length > 0 ? mappedSlotEntries[0][1].left : contentLeft;
  const mappedLastSlotRight = mappedSlotEntries.length > 0
    ? mappedSlotEntries[mappedSlotEntries.length - 1][1].right
    : contentRight;

  const leftAnchorYByColumn: Record<string, number> = {};
  const rightAnchorYByColumn: Record<string, number> = {};

  const tracks = prepared.tracks.map((track) => {
    const coreSegments = track.segments.map((segment) => {
      const mapped = mapLegacySegment(segment, mapX, (value) => value);
      if (segment.kind === 'slot_horizontal' && typeof segment.slotIndex === 'number') {
        const slot = mappedSlotsByIndex.get(segment.slotIndex);
        if (slot) {
          if (segment.id.endsWith(':left')) {
            mapped.startX = slot.left;
            mapped.endX = slot.nodeLeft;
          } else if (segment.id.endsWith(':right')) {
            mapped.startX = slot.nodeRight;
            mapped.endX = slot.right;
          } else if (segment.id.endsWith(':full')) {
            mapped.startX = slot.left;
            mapped.endX = slot.right;
          }
          mapped.endY = mapped.startY;
          mapped.path = mapSegmentPath(mapped);
        }
      }
      return mapped;
    });

    const anchors = track.anchors.map((anchor) => ({ x: mapX(anchor.x), y: anchor.y }));
    const fallbackY = nodes.length > 0 ? medianValue(nodes.map((node) => node.y)) : 0;
    const leftY = anchors.length > 0 ? anchors[0].y : fallbackY;
    const rightY = anchors.length > 0 ? anchors[anchors.length - 1].y : fallbackY;
    leftAnchorYByColumn[track.column] = leftY;
    rightAnchorYByColumn[track.column] = rightY;

    const firstSlotTone = track.segments.find(
      (segment) => segment.kind === 'slot_horizontal' && typeof segment.slotIndex === 'number'
    )?.tone ?? 'uninvolved';
    const lastSlotTone = [...track.segments]
      .reverse()
      .find((segment) => segment.kind === 'slot_horizontal' && typeof segment.slotIndex === 'number')
      ?.tone ?? 'uninvolved';

    const leftBoundarySegment: LegacyStorylineTrackSegment = {
      id: `${track.id}:left-boundary`,
      kind: 'extension_solid',
      tone: firstSlotTone,
      path: linePath(areaLeft, leftY, mappedFirstSlotLeft, leftY),
      dashed: false,
      startX: areaLeft,
      startY: leftY,
      endX: mappedFirstSlotLeft,
      endY: leftY,
    };
    const rightBoundarySegment: LegacyStorylineTrackSegment = {
      id: `${track.id}:right-boundary`,
      kind: 'extension_solid',
      tone: lastSlotTone,
      path: linePath(mappedLastSlotRight, rightY, areaRight, rightY),
      dashed: false,
      startX: mappedLastSlotRight,
      startY: rightY,
      endX: areaRight,
      endY: rightY,
    };

    const segments = [leftBoundarySegment, ...coreSegments, rightBoundarySegment];
    const xValues: number[] = [];
    const yValues: number[] = [];
    for (const segment of segments) {
      xValues.push(segment.startX, segment.endX);
      yValues.push(segment.startY, segment.endY);
      if (segment.c1X !== undefined && segment.c2X !== undefined) xValues.push(segment.c1X, segment.c2X);
      if (segment.c1Y !== undefined && segment.c2Y !== undefined) yValues.push(segment.c1Y, segment.c2Y);
    }

    return {
      ...track,
      id: `${prepared.summaryId}:${track.id}`,
      segments,
      path: segments.map((segment) => segment.path).join(' '),
      anchors,
      minX: xValues.length > 0 ? Math.min(...xValues) : areaLeft,
      maxX: xValues.length > 0 ? Math.max(...xValues) : areaRight,
      minY: yValues.length > 0 ? Math.min(...yValues) : 0,
      maxY: yValues.length > 0 ? Math.max(...yValues) : 0,
      leftExtension: null,
      rightExtension: null,
    };
  });

  return {
    kind: 'summary',
    summaryId: prepared.summaryId,
    shortLabel: prepared.shortLabel,
    turnIndex: prepared.turnIndex,
    left: areaLeft,
    right: areaRight,
    width,
    height: prepared.height,
    titleBandHeight: prepared.titleBandHeight,
    columns: prepared.columns,
    tracks,
    nodes,
    leftAnchorYByColumn,
    rightAnchorYByColumn,
  };
}

function mapActivePlanDraftToTurn(args: {
  plan: PlanItem;
  turnIndex: number;
  areaLeft: number;
  areaRight: number;
  adaptiveProfile: StorylineAdaptiveProfile;
}): ActivePlanDraft {
  const { plan, turnIndex, areaLeft, areaRight, adaptiveProfile } = args;
  const width = Math.max(1, areaRight - areaLeft);
  const displayFields = resolveActivePlanDisplayFields(plan);
  const showPlanText = shouldRenderActivePlanText(adaptiveProfile.xZoomRatio);
  const titleBandHeight = ACTIVE_PLAN_STATUS_ROW_HEIGHT_PX;
  return {
    kind: 'active_plan',
    planId: plan.plan_id,
    shortLabel: displayFields.shortLabel,
    text: displayFields.text,
    status: plan.status,
    controlState: plan.control_state ?? 'none',
    launchRequested: Boolean(plan.launch_requested),
    turnIndex,
    left: areaLeft,
    right: areaRight,
    width,
    height: estimateActivePlanAreaHeight({
      shortLabel: displayFields.shortLabel,
      text: displayFields.text,
      width,
      hasSeparateBodyText: displayFields.hasSeparateBodyText,
      showPlanText,
    }),
    titleBandHeight,
    columns: [],
    leftAnchorYByColumn: {},
    rightAnchorYByColumn: {},
  };
}

function offsetSummaryDraftY(draft: SummaryLocalDraft, offsetTop: number): StorylineSummaryArea {
  const nodes = draft.nodes.map((node) => ({
    ...node,
    y: node.y + offsetTop,
  }));
  const tracks = draft.tracks.map((track) => {
    const shiftedSegments = track.segments.map((segment) => shiftSegmentY(segment, offsetTop));
    const anchors = track.anchors.map((anchor) => ({ x: anchor.x, y: anchor.y + offsetTop }));
    return {
      ...track,
      segments: shiftedSegments,
      path: shiftedSegments.map((segment) => segment.path).join(' '),
      anchors,
      minY: track.minY + offsetTop,
      maxY: track.maxY + offsetTop,
    };
  });
  const leftAnchorYByColumn: Record<string, number> = {};
  const rightAnchorYByColumn: Record<string, number> = {};
  for (const [column, y] of Object.entries(draft.leftAnchorYByColumn)) {
    leftAnchorYByColumn[column] = y + offsetTop;
  }
  for (const [column, y] of Object.entries(draft.rightAnchorYByColumn)) {
    rightAnchorYByColumn[column] = y + offsetTop;
  }

  return {
    id: `summary-area:${draft.summaryId}`,
    summaryId: draft.summaryId,
    shortLabel: draft.shortLabel,
    turnIndex: draft.turnIndex,
    left: draft.left,
    right: draft.right,
    top: offsetTop,
    bottom: offsetTop + draft.height,
    width: draft.width,
    height: draft.height,
    titleBandHeight: draft.titleBandHeight,
    tracks,
    nodes,
    columns: draft.columns,
    leftAnchorYByColumn,
    rightAnchorYByColumn,
  };
}

function offsetActivePlanDraftY(
  draft: ActivePlanDraft,
  offsetTop: number
): StorylineActivePlanArea {
  return {
    id: `active-plan-area:${draft.planId}`,
    planId: draft.planId,
    shortLabel: draft.shortLabel,
    text: draft.text,
    status: draft.status,
    controlState: draft.controlState,
    launchRequested: draft.launchRequested,
    turnIndex: draft.turnIndex,
    left: draft.left,
    right: draft.right,
    top: offsetTop,
    bottom: offsetTop + draft.height,
    width: draft.width,
    height: draft.height,
    titleBandHeight: draft.titleBandHeight,
  };
}

interface TurnActivePlanPlacementInterval {
  top: number;
  bottom: number;
  alignment: 'top' | 'bottom' | 'center';
}

function buildTurnActivePlanPlacementIntervals(args: {
  summaryAreas: StorylineSummaryArea[];
  yTopBound: number;
  yBottomBound: number;
  gapPx: number;
}): TurnActivePlanPlacementInterval[] {
  const usableBottom = Math.max(args.yTopBound, args.yBottomBound - SUMMARY_AREA_CONTENT_PADDING_PX);
  if (args.summaryAreas.length === 0) {
    return [{
      top: args.yTopBound,
      bottom: usableBottom,
      alignment: 'center',
    }];
  }

  const sortedSummaryAreas = [...args.summaryAreas].sort((a, b) => a.top - b.top);
  const topIntervals: TurnActivePlanPlacementInterval[] = [];
  const middleIntervals: TurnActivePlanPlacementInterval[] = [];
  const bottomIntervals: TurnActivePlanPlacementInterval[] = [];
  const pushInterval = (
    target: TurnActivePlanPlacementInterval[],
    top: number,
    bottom: number,
    alignment: TurnActivePlanPlacementInterval['alignment']
  ) => {
    if (bottom - top <= 1e-6) {
      return;
    }
    target.push({ top, bottom, alignment });
  };

  pushInterval(
    topIntervals,
    args.yTopBound,
    sortedSummaryAreas[0]!.top - args.gapPx,
    'bottom'
  );

  for (let index = 1; index < sortedSummaryAreas.length; index += 1) {
    pushInterval(
      middleIntervals,
      sortedSummaryAreas[index - 1]!.bottom + args.gapPx,
      sortedSummaryAreas[index]!.top - args.gapPx,
      'center'
    );
  }

  pushInterval(
    bottomIntervals,
    sortedSummaryAreas[sortedSummaryAreas.length - 1]!.bottom + args.gapPx,
    usableBottom,
    'top'
  );

  middleIntervals.sort((left, right) => (
    (right.bottom - right.top) - (left.bottom - left.top)
  ));
  return [...bottomIntervals, ...topIntervals, ...middleIntervals];
}

function countActivePlanDraftsThatFitInterval(args: {
  drafts: ActivePlanDraft[];
  startIndex: number;
  intervalHeight: number;
}): number {
  let fitCount = 0;
  let usedHeight = 0;
  for (let index = args.startIndex; index < args.drafts.length; index += 1) {
    const nextHeight = Math.max(1, args.drafts[index]!.height);
    if (usedHeight + nextHeight > args.intervalHeight + 1e-6) {
      break;
    }
    usedHeight += nextHeight;
    fitCount += 1;
  }
  return fitCount;
}

function materializeActivePlanDraftsInInterval(args: {
  drafts: ActivePlanDraft[];
  top: number;
  bottom: number;
  alignment: TurnActivePlanPlacementInterval['alignment'];
  adaptiveProfile: StorylineAdaptiveProfile;
}): StorylineActivePlanArea[] {
  if (args.drafts.length === 0) {
    return [];
  }
  const intervalHeight = Math.max(0, args.bottom - args.top);
  const heights = args.drafts.map((draft) => Math.max(1, draft.height));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  if (totalHeight > intervalHeight + 1e-6) {
    return [];
  }

  const gapProfile = computeTurnAreaGapProfile({
    adaptiveProfile: args.adaptiveProfile,
    drafts: args.drafts,
  });
  const maxGap = args.drafts.length > 1
    ? (intervalHeight - totalHeight) / (args.drafts.length - 1)
    : 0;
  const gap = args.drafts.length > 1
    ? clamp(gapProfile.d1, 0, Math.max(0, maxGap))
    : 0;
  const stackHeight = totalHeight + gap * Math.max(0, args.drafts.length - 1);
  const startTop = (() => {
    const maxStartTop = Math.max(args.top, args.bottom - stackHeight);
    if (args.alignment === 'bottom') {
      return clamp(args.bottom - stackHeight, args.top, maxStartTop);
    }
    if (args.alignment === 'center') {
      return clamp(args.top + (intervalHeight - stackHeight) / 2, args.top, maxStartTop);
    }
    return clamp(args.top, args.top, maxStartTop);
  })();

  const activePlanAreas: StorylineActivePlanArea[] = [];
  let cursor = startTop;
  for (const draft of args.drafts) {
    activePlanAreas.push(offsetActivePlanDraftY(draft, cursor));
    cursor += draft.height + gap;
  }
  return activePlanAreas;
}

function materializeTurnActivePlans(args: {
  drafts: ActivePlanDraft[];
  summaryAreas: StorylineSummaryArea[];
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
}): StorylineActivePlanArea[] {
  if (args.drafts.length === 0) {
    return [];
  }

  const fullBandTop = args.yTopBound;
  const fullBandBottom = Math.max(args.yTopBound, args.yBottomBound - SUMMARY_AREA_CONTENT_PADDING_PX);
  if (args.summaryAreas.length === 0) {
    return materializeActivePlanDraftsInInterval({
      drafts: args.drafts,
      top: fullBandTop,
      bottom: fullBandBottom,
      alignment: 'center',
      adaptiveProfile: args.adaptiveProfile,
    });
  }

  const gapProfile = computeTurnAreaGapProfile({
    adaptiveProfile: args.adaptiveProfile,
    drafts: args.drafts,
  });
  const intervals = buildTurnActivePlanPlacementIntervals({
    summaryAreas: args.summaryAreas,
    yTopBound: fullBandTop,
    yBottomBound: args.yBottomBound,
    gapPx: gapProfile.d1,
  });

  const activePlanAreas: StorylineActivePlanArea[] = [];
  let nextDraftIndex = 0;
  for (const interval of intervals) {
    const fitCount = countActivePlanDraftsThatFitInterval({
      drafts: args.drafts,
      startIndex: nextDraftIndex,
      intervalHeight: Math.max(0, interval.bottom - interval.top),
    });
    if (fitCount <= 0) {
      continue;
    }
    activePlanAreas.push(...materializeActivePlanDraftsInInterval({
      drafts: args.drafts.slice(nextDraftIndex, nextDraftIndex + fitCount),
      top: interval.top,
      bottom: interval.bottom,
      alignment: interval.alignment,
      adaptiveProfile: args.adaptiveProfile,
    }));
    nextDraftIndex += fitCount;
    if (nextDraftIndex >= args.drafts.length) {
      return activePlanAreas;
    }
  }

  return materializeActivePlanDraftsInInterval({
    drafts: args.drafts,
    top: fullBandTop,
    bottom: fullBandBottom,
    alignment: 'center',
    adaptiveProfile: args.adaptiveProfile,
  });
}

function computeConvergeGapProfile(adaptiveProfile: StorylineAdaptiveProfile): {
  d1: number;
  d2: number;
} {
  const markerIndicatorClearanceBoost = clamp(15 * adaptiveProfile.labelScale, 6, 20);
  const d1 = Math.max(
    2.8,
    CONVERGE_LANE_D1_BASE_PX * clamp(adaptiveProfile.d1Scale, 0.14, 1.55) + markerIndicatorClearanceBoost
  );
  const d2Base = CONVERGE_LANE_D2_BASE_PX * clamp(adaptiveProfile.d2Scale, 0.16, 1.45);
  const d2 = Math.max(d2Base, d1 + Math.max(6, d1 * 0.75));
  return { d1, d2 };
}

function computeTurnAreaGapProfile(args: {
  adaptiveProfile: StorylineAdaptiveProfile;
  drafts: Array<Pick<TurnAreaDraft, 'titleBandHeight'>>;
}): {
  d1: number;
  d2: number;
} {
  const { adaptiveProfile, drafts } = args;
  const d1 = Math.max(2.4, TURN_AREA_STACK_D1_BASE_PX * clamp(adaptiveProfile.d1Scale, 0.18, 1.45));
  const d2Base = TURN_AREA_STACK_D2_BASE_PX * clamp(adaptiveProfile.d2Scale, 0.22, 1.45);
  const maxTitleBandHeight = drafts.reduce(
    (maxHeight, draft) => Math.max(maxHeight, draft.titleBandHeight),
    0
  );
  const titleAwareD2Cap = d1 + maxTitleBandHeight + SUMMARY_AREA_CONTENT_PADDING_PX * 2 + 6;
  const d2 = Math.max(d1, Math.min(Math.max(d1, d2Base), titleAwareD2Cap));
  return { d1, d2 };
}

function estimateRequiredConvergeWidth(args: {
  plannedColumnsByTurn: Map<number, Set<string>>;
  adaptiveProfile: StorylineAdaptiveProfile;
  markerDiameter: number;
}): number {
  const { plannedColumnsByTurn, adaptiveProfile, markerDiameter } = args;
  if (adaptiveProfile.xZoomRatio < 0.5) {
    return 0;
  }
  const allColumns = [...new Set(
    [...plannedColumnsByTurn.values()].flatMap((columns) => [...columns])
  )];
  if (allColumns.length === 0) return 0;

  const baselineFontSizePx = computeTrackLabelTypography({
    zoomX: adaptiveProfile.xZoomRatio,
    labelScale: adaptiveProfile.labelScale * CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
  }).fontSize;
  const maxTypography = computeTrackLabelTypography({
    zoomX: adaptiveProfile.xZoomRatio,
    labelScale: adaptiveProfile.labelScale * CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
    fontSizePx: baselineFontSizePx + 8,
  });
  const longestLabelLength = allColumns.reduce(
    (maxLength, column) => Math.max(maxLength, column.length),
    0
  );
  const requiredLabelWidth = Math.max(
    0,
    Math.ceil(longestLabelLength * (maxTypography.fontSize * 0.5) + maxTypography.paddingX * 1.5)
  );
  return Math.ceil(requiredLabelWidth + markerDiameter + CONVERGE_LABEL_SIDE_PADDING_PX);
}

function solveTurnAreaTopPositions(args: {
  drafts: TurnAreaDraft[];
  preferredTops: number[];
  yTopBound: number;
  yBottomBound: number;
  d1: number;
  d2: number;
}): number[] {
  const { drafts, preferredTops, yTopBound, yBottomBound } = args;
  const count = drafts.length;
  if (count === 0) return [];

  const heights = drafts.map((draft) => Math.max(1, draft.height));
  const bottomPadding = SUMMARY_AREA_CONTENT_PADDING_PX;
  const minTops = Array.from({ length: count }, () => yTopBound);
  const maxTops = heights.map((height) => yBottomBound - height - bottomPadding);

  const availableHeight = Math.max(0, yBottomBound - yTopBound - bottomPadding);
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  const maxFeasibleGap = count > 1 ? (availableHeight - totalHeight) / (count - 1) : 0;
  const d1 = count > 1
    ? clamp(args.d1, 0, Math.max(0, maxFeasibleGap))
    : 0;
  const d2 = count > 1
    ? Math.max(d1, clamp(args.d2, d1, Math.max(d1, availableHeight)))
    : 0;
  const projectFeasibleTops = (candidateTops: number[]): number[] => {
    if (count === 1) {
      return [clamp(candidateTops[0] ?? yTopBound, minTops[0], maxTops[0])];
    }

    const lowerGaps = heights.slice(0, -1).map((height) => height + d1);
    const upperGaps = heights.slice(0, -1).map((height) => height + d2);
    const futureMinTop = [...minTops];
    const futureMaxTop = [...maxTops];
    const epsilon = 1e-6;

    for (let index = count - 2; index >= 0; index -= 1) {
      futureMinTop[index] = Math.max(
        minTops[index],
        futureMinTop[index + 1] - upperGaps[index]
      );
      futureMaxTop[index] = Math.min(
        maxTops[index],
        futureMaxTop[index + 1] - lowerGaps[index]
      );
    }

    const seedPackingFromTop = (): number[] => {
      const packed = new Array<number>(count).fill(0);
      packed[0] = clamp(yTopBound, minTops[0], maxTops[0]);
      for (let index = 1; index < count; index += 1) {
        packed[index] = Math.max(
          minTops[index],
          packed[index - 1] + lowerGaps[index - 1]
        );
      }
      return packed;
    };

    if (futureMinTop[0] > futureMaxTop[0] + epsilon) {
      return seedPackingFromTop();
    }

    const projected = new Array<number>(count).fill(0);
    projected[0] = clamp(candidateTops[0] ?? yTopBound, futureMinTop[0], futureMaxTop[0]);

    for (let index = 1; index < count; index += 1) {
      const low = Math.max(
        minTops[index],
        futureMinTop[index],
        projected[index - 1] + lowerGaps[index - 1]
      );
      const high = Math.min(
        maxTops[index],
        futureMaxTop[index],
        projected[index - 1] + upperGaps[index - 1]
      );

      if (low > high + epsilon) {
        return seedPackingFromTop();
      }

      projected[index] = clamp(
        candidateTops[index] ?? low,
        low,
        Math.max(low, high)
      );
    }

    return projected;
  };

  const tops = heights.map((_height, index) =>
    clamp(preferredTops[index] ?? yTopBound, minTops[index], maxTops[index])
  );

  const project = () => {
    for (let index = 0; index < count; index += 1) {
      tops[index] = clamp(tops[index], minTops[index], maxTops[index]);
    }

    tops[0] = clamp(tops[0], minTops[0], maxTops[0]);
    for (let index = 1; index < count; index += 1) {
      const minAllowed = tops[index - 1] + heights[index - 1] + d1;
      const maxAllowed = tops[index - 1] + heights[index - 1] + d2;
      tops[index] = clamp(tops[index], minAllowed, maxAllowed);
    }

    tops[count - 1] = clamp(tops[count - 1], minTops[count - 1], maxTops[count - 1]);
    for (let index = count - 2; index >= 0; index -= 1) {
      const minAllowed = tops[index + 1] - heights[index] - d2;
      const maxAllowed = tops[index + 1] - heights[index] - d1;
      tops[index] = clamp(tops[index], minAllowed, maxAllowed);
    }

    for (let index = 0; index < count; index += 1) {
      tops[index] = clamp(tops[index], minTops[index], maxTops[index]);
    }
  };

  for (let iter = 0; iter < 18; iter += 1) {
    project();
  }

  const shiftCandidates = tops.map((value, index) => (preferredTops[index] ?? value) - value);
  const delta = medianValue(shiftCandidates);
  if (Number.isFinite(delta) && Math.abs(delta) > 1e-6) {
    for (let index = 0; index < count; index += 1) {
      tops[index] += delta;
    }
    for (let iter = 0; iter < 8; iter += 1) {
      project();
    }
  }

  for (let iter = 0; iter < 8; iter += 1) {
    project();
  }

  return projectFeasibleTops(tops);
}


function buildSummaryAreasByTurn(
  summaryAreas: StorylineSummaryArea[]
): Map<number, StorylineSummaryArea[]> {
  const grouped = new Map<number, StorylineSummaryArea[]>();
  for (const area of summaryAreas) {
    const areas = grouped.get(area.turnIndex) ?? [];
    areas.push(area);
    grouped.set(area.turnIndex, areas);
  }
  return grouped;
}

function countAtomicInsightsForTurnColumn(args: {
  summaryAreasByTurn: Map<number, StorylineSummaryArea[]>;
  summaryById: Map<string, Summary>;
  turnIndex: number;
  column: string;
}): number {
  const { summaryAreasByTurn, summaryById, turnIndex, column } = args;
  let count = 0;
  for (const area of summaryAreasByTurn.get(turnIndex) ?? []) {
    const summary = summaryById.get(area.summaryId);
    if (!summary) {
      continue;
    }
    for (const atomic of summary.atomic_insights ?? []) {
      if ((atomic.columns ?? []).includes(column)) {
        count += 1;
      }
    }
  }
  return count;
}

function countAtomicInsightsForReplayEntriesColumn(args: {
  entries: SummaryReplayEntry[];
  column: string;
}): number {
  const { entries, column } = args;
  let count = 0;
  for (const entry of entries) {
    for (const atomic of entry.summary.atomic_insights ?? []) {
      if ((atomic.columns ?? []).includes(column)) {
        count += 1;
      }
    }
  }
  return count;
}

interface ConvergeLaneIndicatorSizingInput {
  column: string;
  rightTurnAtomicCount: number;
  hasEndpointMarker: boolean;
  endpointMarkerDiameter: number;
}

function computeConvergeLaneIndicatorSizing(args: {
  lanes: ConvergeLaneIndicatorSizingInput[];
  zoomX: number;
  labelScale: number;
}): {
  fontSizeByColumn: Map<string, number>;
  requiredClearanceByColumn: Map<string, number>;
} {
  const {
    lanes,
    zoomX,
    labelScale,
  } = args;
  const fontSizeByColumn = new Map<string, number>();
  const requiredClearanceByColumn = new Map<string, number>();
  const perConvergeCounts = lanes
    .map((lane) => lane.rightTurnAtomicCount)
    .filter((count) => count > 0);
  const minCount = perConvergeCounts.length > 0 ? Math.min(...perConvergeCounts) : 0;
  const maxCount = perConvergeCounts.length > 0 ? Math.max(...perConvergeCounts) : 0;
  const baselineTypography = computeTrackLabelTypography({
    zoomX,
    labelScale,
  });
  const baselineFontSizePx = baselineTypography.fontSize;
  const maxFontSizePx = baselineFontSizePx + 8;
  const middleFontSizePx = (baselineFontSizePx + maxFontSizePx) / 2;
  const nonzeroCountsAreUniform = perConvergeCounts.length > 0 && minCount === maxCount;
  const indicatorsVisible = zoomX >= 0.5;

  for (const lane of lanes) {
    const count = lane.rightTurnAtomicCount;
    const fontSizePx = count <= 0
      ? baselineFontSizePx
      : nonzeroCountsAreUniform
        ? middleFontSizePx
        : baselineFontSizePx + 8 * clamp((count - minCount) / (maxCount - minCount), 0, 1);
    const typography = computeTrackLabelTypography({
      zoomX,
      labelScale,
      fontSizePx,
    });
    const anchorClearancePx = lane.hasEndpointMarker
      ? Math.max(1.5, lane.endpointMarkerDiameter / 2 + 1.5)
      : 0;
    const endpointMarkerBufferPx = lane.hasEndpointMarker ? lane.endpointMarkerDiameter : 0;
    const requiredClearancePx = !indicatorsVisible
      ? 0
      : lane.hasEndpointMarker
        ? Math.ceil(
          anchorClearancePx
          + typography.maskHeight
          + endpointMarkerBufferPx
          + Math.max(6, typography.fontSize * 0.4)
        )
        : Math.ceil(typography.maskHeight + Math.max(5, typography.fontSize * 0.34));
    fontSizeByColumn.set(lane.column, fontSizePx);
    requiredClearanceByColumn.set(lane.column, requiredClearancePx);
  }

  return {
    fontSizeByColumn,
    requiredClearanceByColumn,
  };
}

function computeConvergeIndicatorRequiredLaneGap(args: {
  laneStates: BoundaryLaneState[];
  leftColumns: Set<string>;
  rightColumns: Set<string>;
  rightTurnEntries: SummaryReplayEntry[];
  markerDiameter: number;
  zoomX: number;
  labelScale: number;
}): number {
  const sizing = computeConvergeLaneIndicatorSizing({
    lanes: args.laneStates.map((laneState) => {
      const inLeft = args.leftColumns.has(laneState.column);
      const inRight = args.rightColumns.has(laneState.column);
      return {
        column: laneState.column,
        rightTurnAtomicCount: countAtomicInsightsForReplayEntriesColumn({
          entries: args.rightTurnEntries,
          column: laneState.column,
        }),
        hasEndpointMarker: !(inLeft && inRight),
        endpointMarkerDiameter: args.markerDiameter,
      };
    }),
    zoomX: args.zoomX,
    labelScale: args.labelScale,
  });
  const clearanceValues = [...sizing.requiredClearanceByColumn.values()];
  return clearanceValues.length > 0
    ? Math.max(...clearanceValues.map((value) => value + 2))
    : 0;
}

function buildConvergeLaneIndicatorMetadata(args: {
  converges: StorylineConvergeGeometry[];
  summaryAreas: StorylineSummaryArea[];
  summaries: Summary[];
  zoomX: number;
  labelScale: number;
}): ConvergeLaneIndicatorMetadata {
  const {
    converges,
    summaryAreas,
    summaries,
    zoomX,
    labelScale,
  } = args;
  const summaryAreasByTurn = buildSummaryAreasByTurn(summaryAreas);
  const summaryById = new Map(summaries.map((summary) => [summary.insight_id, summary]));
  const rightTurnAtomicCountByLaneKey = new Map<string, number>();
  const fontSizeByLaneKey = new Map<string, number>();
  const requiredClearanceByLaneKey = new Map<string, number>();

  for (const converge of converges) {
    const rightTurnIndex = converge.index;
    const laneSizing = converge.lanes.map((lane) => ({
      column: lane.column,
      rightTurnAtomicCount: countAtomicInsightsForTurnColumn({
        summaryAreasByTurn,
        summaryById,
        turnIndex: rightTurnIndex,
        column: lane.column,
      }),
      hasEndpointMarker: lane.endpointMarkers.length > 0,
      endpointMarkerDiameter: lane.endpointMarkers[0]?.diameter ?? 0,
    }));
    const sizing = computeConvergeLaneIndicatorSizing({
      lanes: laneSizing,
      zoomX,
      labelScale,
    });
    for (const lane of laneSizing) {
      const laneKey = `${converge.index}::${lane.column}`;
      rightTurnAtomicCountByLaneKey.set(laneKey, lane.rightTurnAtomicCount);
      fontSizeByLaneKey.set(laneKey, sizing.fontSizeByColumn.get(lane.column) ?? 0);
      requiredClearanceByLaneKey.set(laneKey, sizing.requiredClearanceByColumn.get(lane.column) ?? 0);
    }
  }

  return {
    rightTurnAtomicCountByLaneKey,
    fontSizeByLaneKey,
    requiredClearanceByLaneKey,
  };
}

function computeSummaryAreaPreferredTop(args: {
  draft: TurnAreaDraft;
  leftConvergeYByColumn: Map<string, number>;
  minTop: number;
  maxTop: number;
  fallbackTop: number;
}): number {
  const { draft, leftConvergeYByColumn, minTop, maxTop, fallbackTop } = args;
  const leftTopCandidates: number[] = [];
  for (const column of draft.columns) {
    const laneY = leftConvergeYByColumn.get(column);
    const localAnchorY = draft.leftAnchorYByColumn[column];
    if (typeof laneY !== 'number' || typeof localAnchorY !== 'number') continue;
    leftTopCandidates.push(laneY - localAnchorY);
  }
  if (leftTopCandidates.length > 0) {
    return clamp(medianValue(leftTopCandidates), minTop, maxTop);
  }

  return clamp(fallbackTop, minTop, maxTop);
}

function buildFallbackTurnAreaPreferredTops(args: {
  drafts: TurnAreaDraft[];
  yTopBound: number;
  yBottomBound: number;
  d1: number;
  d2: number;
}): number[] {
  const { drafts, yTopBound, yBottomBound, d1, d2 } = args;
  if (drafts.length === 0) return [];

  const heights = drafts.map((draft) => Math.max(1, draft.height));
  const availableHeight = Math.max(0, yBottomBound - yTopBound - SUMMARY_AREA_CONTENT_PADDING_PX);
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  const averageGap = drafts.length > 1
    ? Math.max(0, (availableHeight - totalHeight) / (drafts.length - 1))
    : 0;
  const targetGap = drafts.length > 1
    ? clamp(averageGap, d1, d2)
    : 0;
  const stackHeight = totalHeight + targetGap * Math.max(0, drafts.length - 1);
  const maxStartTop = Math.max(
    yTopBound,
    yBottomBound - SUMMARY_AREA_CONTENT_PADDING_PX - stackHeight
  );
  const centeredStartTop = yTopBound + (availableHeight - stackHeight) / 2;
  let cursor = clamp(
    Math.max(yTopBound + TURN_FALLBACK_TOP_OFFSET_PX, centeredStartTop),
    yTopBound,
    maxStartTop
  );

  return heights.map((height) => {
    const top = cursor;
    cursor += height + targetGap;
    return top;
  });
}

function solveTurnAreaTops(args: {
  drafts: TurnAreaDraft[];
  leftConvergeYByColumn: Map<string, number>;
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
  preferredTopBySummaryId?: Map<string, number>;
}): number[] {
  const {
    drafts,
    leftConvergeYByColumn,
    adaptiveProfile,
    yTopBound,
    yBottomBound,
    preferredTopBySummaryId,
  } = args;
  const turnAreaGapProfile = computeTurnAreaGapProfile({
    adaptiveProfile,
    drafts,
  });
  const fallbackPreferredTops = buildFallbackTurnAreaPreferredTops({
    drafts,
    yTopBound,
    yBottomBound,
    d1: turnAreaGapProfile.d1,
    d2: turnAreaGapProfile.d2,
  });
  const preferredTops = drafts.map((draft, draftIndex) => {
    const maxTop = Math.max(
      yTopBound,
      yBottomBound - draft.height - SUMMARY_AREA_CONTENT_PADDING_PX
    );
    if (draft.kind === 'summary') {
      const preferredTop = preferredTopBySummaryId?.get(draft.summaryId);
      if (typeof preferredTop === 'number') {
        return clamp(preferredTop, yTopBound, maxTop);
      }
    }
    return computeSummaryAreaPreferredTop({
      draft,
      leftConvergeYByColumn,
      minTop: yTopBound,
      maxTop,
      fallbackTop: fallbackPreferredTops[draftIndex] ?? (yTopBound + TURN_FALLBACK_TOP_OFFSET_PX),
    });
  });
  const solvedTops = solveTurnAreaTopPositions({
    drafts,
    preferredTops,
    yTopBound,
    yBottomBound,
    d1: turnAreaGapProfile.d1,
    d2: turnAreaGapProfile.d2,
  });
  return solvedTops;
}

function materializeTurnAreasFromSolvedTops(args: {
  drafts: TurnAreaDraft[];
  solvedTops: number[];
  fallbackTop: number;
}): {
  summaryAreas: StorylineSummaryArea[];
  activePlanAreas: StorylineActivePlanArea[];
} {
  const summaryAreas: StorylineSummaryArea[] = [];
  const activePlanAreas: StorylineActivePlanArea[] = [];
  for (let draftIndex = 0; draftIndex < args.drafts.length; draftIndex += 1) {
    const draft = args.drafts[draftIndex];
    const top = args.solvedTops[draftIndex] ?? args.fallbackTop;
    if (draft.kind === 'summary') {
      summaryAreas.push(offsetSummaryDraftY(draft, top));
    } else {
      activePlanAreas.push(offsetActivePlanDraftY(draft, top));
    }
  }
  return {
    summaryAreas,
    activePlanAreas,
  };
}

function branchPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): { path: string; c1X: number; c1Y: number; c2X: number; c2Y: number } {
  const dx = toX - fromX;
  const controlOffset = Math.max(8, Math.abs(dx) * 0.42);
  const c1X = fromX + Math.sign(dx) * controlOffset;
  const c2X = toX - Math.sign(dx) * controlOffset;
  const c1Y = fromY;
  const c2Y = toY;
  return {
    path: cubicPath(fromX, fromY, c1X, c1Y, c2X, c2Y, toX, toY),
    c1X,
    c1Y,
    c2X,
    c2Y,
  };
}

export function computeConvergeEndpointMarkerDiameter(viewportWidthPx: number): number {
  const glyphRange = computeGlyphDiameterRange(viewportWidthPx, SUMMARY_LOCAL_VIEWPORT_HEIGHT_PX);
  const neutralDiameter =
    glyphRange.minDiameter + (glyphRange.maxDiameter - glyphRange.minDiameter) * 0.18;
  return clamp(
    neutralDiameter,
    Math.max(4.5, glyphRange.minDiameter * 0.95),
    Math.max(6.2, glyphRange.maxDiameter * 0.52)
  );
}

export function buildConvergeLaneGeometry(args: {
  convergeIndex: number;
  column: string;
  y: number;
  xStart: number;
  xEnd: number;
  mode: StorylineConvergeLaneMode;
  markerDiameter: number;
}): {
  segments: LegacyStorylineTrackSegment[];
  endpointMarkers: StorylineConvergeEndpointMarker[];
} {
  const { convergeIndex, column, y, xStart, xEnd, mode, markerDiameter } = args;
  const mid = xStart + (xEnd - xStart) * CONVERGE_EXTENSION_SPLIT_RATIO;
  if (mode === 'both') {
    return {
      segments: [
        {
          id: `converge:${convergeIndex}:${column}:both`,
          kind: 'extension_solid',
          tone: 'involved',
          path: linePath(xStart, y, xEnd, y),
          dashed: false,
          startX: xStart,
          startY: y,
          endX: xEnd,
          endY: y,
        },
      ],
      endpointMarkers: [],
    };
  }
  if (mode === 'left_extension') {
    return {
      segments: [
        {
          id: `converge:${convergeIndex}:${column}:left-solid`,
          kind: 'extension_solid',
          tone: 'uninvolved',
          path: linePath(xStart, y, mid, y),
          dashed: false,
          startX: xStart,
          startY: y,
          endX: mid,
          endY: y,
        },
      ],
      endpointMarkers: [
        {
          id: `converge:${convergeIndex}:${column}:terminate-marker`,
          kind: 'terminate',
          x: mid,
          y,
          diameter: markerDiameter,
        },
      ],
    };
  }
  if (mode === 'right_extension') {
    return {
      segments: [
        {
          id: `converge:${convergeIndex}:${column}:right-solid`,
          kind: 'extension_solid',
          tone: 'uninvolved',
          path: linePath(mid, y, xEnd, y),
          dashed: false,
          startX: mid,
          startY: y,
          endX: xEnd,
          endY: y,
        },
      ],
      endpointMarkers: [
        {
          id: `converge:${convergeIndex}:${column}:start-marker`,
          kind: 'start',
          x: mid,
          y,
          diameter: markerDiameter,
        },
      ],
    };
  }
  return {
    segments: [],
    endpointMarkers: [
      {
        id: `converge:${convergeIndex}:${column}:isolated-marker`,
        kind: 'isolated',
        x: (xStart + xEnd) / 2,
        y,
        diameter: markerDiameter,
      },
    ],
  };
}

function materializeConvergeLanes(args: {
  converge: StorylineConvergeGeometry;
  laneStates: BoundaryLaneState[];
  leftColumns: Set<string>;
  rightColumns: Set<string>;
  markerDiameter: number;
  metadata?: ConvergeLaneIndicatorMetadata | null;
}): StorylineConvergeLane[] {
  const {
    converge,
    laneStates,
    leftColumns,
    rightColumns,
    markerDiameter,
    metadata,
  } = args;
  return laneStates.map((laneState) => {
    const column = laneState.column;
    const y = laneState.y;
    const inLeft = leftColumns.has(column);
    const inRight = rightColumns.has(column);
    const mode: StorylineConvergeLaneMode = inLeft && inRight
      ? 'both'
      : inLeft
        ? 'left_extension'
        : inRight
          ? 'right_extension'
          : 'isolated';
    const laneGeometry = buildConvergeLaneGeometry({
      convergeIndex: converge.index,
      column,
      y,
      xStart: converge.xStart,
      xEnd: converge.xEnd,
      mode,
      markerDiameter,
    });
    const laneKey = `${converge.index}::${column}`;
    return {
      id: `converge:${converge.index}:${column}`,
      column,
      y,
      mode,
      segments: laneGeometry.segments,
      endpointMarkers: laneGeometry.endpointMarkers,
      rightTurnAtomicCount: metadata?.rightTurnAtomicCountByLaneKey.get(laneKey) ?? 0,
      indicatorFontSizePx: metadata?.fontSizeByLaneKey.get(laneKey) ?? 0,
      indicatorRequiredClearancePx: metadata?.requiredClearanceByLaneKey.get(laneKey) ?? 0,
    };
  });
}

function shiftSummaryAreaY(area: StorylineSummaryArea, deltaY: number): StorylineSummaryArea {
  if (Math.abs(deltaY) <= 1e-6) {
    return area;
  }
  const nodes = area.nodes.map((node) => ({
    ...node,
    y: node.y + deltaY,
  }));
  const tracks = area.tracks.map((track) => {
    const shiftedSegments = track.segments.map((segment) => shiftSegmentY(segment, deltaY));
    return {
      ...track,
      segments: shiftedSegments,
      path: shiftedSegments.map((segment) => segment.path).join(' '),
      anchors: track.anchors.map((anchor) => ({ x: anchor.x, y: anchor.y + deltaY })),
      minY: track.minY + deltaY,
      maxY: track.maxY + deltaY,
    };
  });
  const leftAnchorYByColumn: Record<string, number> = {};
  const rightAnchorYByColumn: Record<string, number> = {};
  for (const [column, y] of Object.entries(area.leftAnchorYByColumn)) {
    leftAnchorYByColumn[column] = y + deltaY;
  }
  for (const [column, y] of Object.entries(area.rightAnchorYByColumn)) {
    rightAnchorYByColumn[column] = y + deltaY;
  }
  return {
    ...area,
    top: area.top + deltaY,
    bottom: area.bottom + deltaY,
    nodes,
    tracks,
    leftAnchorYByColumn,
    rightAnchorYByColumn,
  };
}

function shiftActivePlanAreaY(area: StorylineActivePlanArea, deltaY: number): StorylineActivePlanArea {
  if (Math.abs(deltaY) <= 1e-6) {
    return area;
  }
  return {
    ...area,
    top: area.top + deltaY,
    bottom: area.bottom + deltaY,
  };
}

function collectStorylineContentYValues(args: {
  summaryAreas: StorylineSummaryArea[];
  activePlanAreas: StorylineActivePlanArea[];
  converges: StorylineConvergeGeometry[];
  boundaryBranches: StorylineBoundaryBranch[];
}): number[] {
  const values: number[] = [];
  for (const area of args.summaryAreas) {
    values.push(area.top, area.bottom);
    for (const node of area.nodes) {
      values.push(node.y - node.height / 2, node.y + node.height / 2);
    }
    for (const track of area.tracks) {
      values.push(track.minY, track.maxY);
    }
  }
  for (const area of args.activePlanAreas) {
    values.push(area.top, area.bottom);
  }
  for (const converge of args.converges) {
    for (const lane of converge.lanes) {
      values.push(lane.y);
      for (const marker of lane.endpointMarkers) {
        values.push(marker.y - marker.diameter / 2, marker.y + marker.diameter / 2);
      }
    }
  }
  for (const branch of args.boundaryBranches) {
    values.push(branch.fromY, branch.toY, branch.c1Y, branch.c2Y);
  }
  return values;
}

function computeCenteredBandDelta(args: {
  yValues: number[];
  yTopBound: number;
  yBottomBound: number;
}): number {
  if (args.yValues.length === 0) {
    return 0;
  }
  const minY = Math.min(...args.yValues);
  const maxY = Math.max(...args.yValues);
  const contentCenter = (minY + maxY) / 2;
  const windowCenter = (args.yTopBound + args.yBottomBound) / 2;
  const desiredDelta = windowCenter - contentCenter;
  const availableHeight = Math.max(0, args.yBottomBound - args.yTopBound);
  const contentHeight = Math.max(0, maxY - minY);
  const boundedMinDelta = args.yTopBound - minY;
  const boundedMaxDelta = args.yBottomBound - maxY;
  return contentHeight <= availableHeight + 1e-6 && boundedMinDelta <= boundedMaxDelta
    ? clamp(desiredDelta, boundedMinDelta, boundedMaxDelta)
    : desiredDelta;
}

function applyPerBandVerticalCentering(args: {
  summaryAreas: StorylineSummaryArea[];
  activePlanAreas: StorylineActivePlanArea[];
  converges: StorylineConvergeGeometry[];
  yTopBound: number;
  yBottomBound: number;
}): {
  summaryAreas: StorylineSummaryArea[];
  activePlanAreas: StorylineActivePlanArea[];
  converges: StorylineConvergeGeometry[];
} {
  let shiftedSummaryAreas = [...args.summaryAreas];
  let shiftedActivePlanAreas = [...args.activePlanAreas];

  const turnIndexes = new Set<number>();
  for (const area of shiftedSummaryAreas) {
    turnIndexes.add(area.turnIndex);
  }
  for (const area of shiftedActivePlanAreas) {
    turnIndexes.add(area.turnIndex);
  }

  for (const turnIndex of [...turnIndexes].sort((a, b) => a - b)) {
    const yValues = collectStorylineContentYValues({
      summaryAreas: shiftedSummaryAreas.filter((area) => area.turnIndex === turnIndex),
      activePlanAreas: shiftedActivePlanAreas.filter((area) => area.turnIndex === turnIndex),
      converges: [],
      boundaryBranches: [],
    });
    const deltaY = computeCenteredBandDelta({
      yValues,
      yTopBound: args.yTopBound,
      yBottomBound: args.yBottomBound,
    });
    if (Math.abs(deltaY) <= 1e-6) {
      continue;
    }
    shiftedSummaryAreas = shiftedSummaryAreas.map((area) => (
      area.turnIndex === turnIndex ? shiftSummaryAreaY(area, deltaY) : area
    ));
    shiftedActivePlanAreas = shiftedActivePlanAreas.map((area) => (
      area.turnIndex === turnIndex ? shiftActivePlanAreaY(area, deltaY) : area
    ));
  }

  return {
    summaryAreas: shiftedSummaryAreas,
    activePlanAreas: shiftedActivePlanAreas,
    converges: args.converges,
  };
}

export function shouldRenderSummaryInternals(zoomX: number): boolean {
  return zoomX >= 0.5;
}

export function shouldRenderActivePlanText(zoomX: number): boolean {
  return zoomX >= ACTIVE_PLAN_TEXT_VISIBILITY_ZOOM_THRESHOLD;
}

export function buildStorylineTurnConvergeLayout(
  runState: RunState | null | undefined,
  viewportHeight: number,
  options: StorylineTurnConvergeLayoutOptions = {}
): StorylineTurnConvergeLayout {
  const laneMode = options.laneMode ?? 'dataset_columns';
  const adaptiveProfile = createStorylineAdaptiveProfile(options.xZoomRatio ?? 1);
  if (!runState) {
    return {
      laneMode,
      nodes: [],
      summaryAreas: [],
      activePlanAreas: [],
      turns: [],
      converges: [],
      turnBoundaries: [],
      boundaryBranches: [],
      plotMinX: 0,
      plotMaxX: 0,
      plotMinY: 0,
      plotMaxY: viewportHeight,
      plotWidth: 0,
      plotHeight: viewportHeight,
      adaptiveProfile,
    };
  }

  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  const summaries = runState.insights.filter((summary) => {
    const plan = planById.get(summary.plan_id);
    if (!plan) return true;
    return plan.status === 'completed';
  });
  const grouping = buildStorylineTurnGrouping(runState, options.events ?? []);
  const activePlanEntries = collectLatestActivePlans(runState, grouping, options.events ?? []);
  if (summaries.length === 0 && activePlanEntries.length === 0) {
    return {
      laneMode,
      nodes: [],
      summaryAreas: [],
      activePlanAreas: [],
      turns: [],
      converges: [],
      turnBoundaries: [],
      boundaryBranches: [],
      plotMinX: 0,
      plotMaxX: 0,
      plotMinY: 0,
      plotMaxY: viewportHeight,
      plotWidth: 0,
      plotHeight: viewportHeight,
      adaptiveProfile,
    };
  }

  const summaryById = new Map(summaries.map((summary) => [summary.insight_id, summary]));
  const replayEntries: SummaryReplayEntry[] = grouping.replaySummaryIds
    .map((summaryId) => {
      const summary = summaryById.get(summaryId);
      if (!summary) return null;
      const turnIndex = grouping.summaryTurnIndexByInsightId.get(summary.insight_id);
      if (typeof turnIndex !== 'number') return null;
      return { summary, turnIndex };
    })
    .filter((item): item is SummaryReplayEntry => item !== null);

  const replayEntriesByTurn = new Map<number, SummaryReplayEntry[]>();
  const activePlanEntriesByTurn = new Map<number, Array<{ plan: PlanItem; turnIndex: number }>>();
  const plannedColumnsByTurn = new Map<number, Set<string>>();
  for (const entry of replayEntries) {
    const turnEntries = replayEntriesByTurn.get(entry.turnIndex) ?? [];
    turnEntries.push(entry);
    replayEntriesByTurn.set(entry.turnIndex, turnEntries);

    const plannedColumns = plannedColumnsByTurn.get(entry.turnIndex) ?? new Set<string>();
    for (const column of collectSummaryColumns(entry.summary)) {
      plannedColumns.add(column);
    }
    plannedColumnsByTurn.set(entry.turnIndex, plannedColumns);
  }
  for (const entry of activePlanEntries) {
    const turnEntries = activePlanEntriesByTurn.get(entry.turnIndex) ?? [];
    turnEntries.push(entry);
    activePlanEntriesByTurn.set(entry.turnIndex, turnEntries);
  }

  const dispatchBatchTurnCount = (runState.master_agent_state?.dispatch_batches ?? []).reduce(
    (maxTurn, batch) => Math.max(maxTurn, batch.dispatch_turn_index + 1),
    0
  );
  const activePlanTurnCount = activePlanEntries.reduce(
    (maxTurn, entry) => Math.max(maxTurn, entry.turnIndex + 1),
    0
  );
  const turnCount = Math.max(
    1,
    grouping.turnCount || replayEntries.reduce((maxTurn, entry) => Math.max(maxTurn, entry.turnIndex + 1), 0),
    dispatchBatchTurnCount,
    activePlanTurnCount
  );
  const viewportWidthPx = Math.max(1, options.viewportWidthPx ?? 980);
  const convergeEndpointMarkerDiameter = computeConvergeEndpointMarkerDiameter(viewportWidthPx);
  const xScale = clamp(
    Math.pow(adaptiveProfile.xZoomRatio, 0.48),
    Math.pow(ZOOM_MIN, 0.48),
    1.95
  );
  const baseTurnWidth = TURN_BASE_WIDTH_PX * xScale;
  const turnMargin = TURN_MARGIN_BASE_PX * xScale;
  const preparedLayoutsBySummaryId = new Map<string, PreparedSummaryLocalLayout>();
  const turnWidthByIndex = Array.from({ length: turnCount }, () => baseTurnWidth);

  for (const entry of replayEntries) {
    const prepared = prepareSummaryLocalLayout({
      summary: entry.summary,
      turnIndex: entry.turnIndex,
      runState,
      profile: adaptiveProfile,
      viewportWidthPx,
    });
    preparedLayoutsBySummaryId.set(entry.summary.insight_id, prepared);
    const requiredTurnWidth = computeRequiredTurnWidth({
      baseTurnWidth,
      turnMargin,
      requiredAreaWidth: prepared.requiredAreaWidth,
    });
    turnWidthByIndex[entry.turnIndex] = Math.max(turnWidthByIndex[entry.turnIndex] ?? baseTurnWidth, requiredTurnWidth);
  }
  const showActivePlanText = shouldRenderActivePlanText(adaptiveProfile.xZoomRatio);
  for (const entry of activePlanEntries) {
    const requiredAreaWidth = estimateActivePlanRequiredAreaWidth({
      plan: entry.plan,
      showPlanText: showActivePlanText,
    });
    const requiredTurnWidth = computeRequiredTurnWidth({
      baseTurnWidth,
      turnMargin,
      requiredAreaWidth,
    });
    turnWidthByIndex[entry.turnIndex] = Math.max(
      turnWidthByIndex[entry.turnIndex] ?? baseTurnWidth,
      requiredTurnWidth
    );
  }
  const convergeWidth = Math.max(
    CONVERGE_BASE_WIDTH_PX * xScale,
    estimateRequiredConvergeWidth({
      plannedColumnsByTurn,
      adaptiveProfile,
      markerDiameter: convergeEndpointMarkerDiameter,
    })
  );

  const yTopBound = clamp(options.yUpperBoundPx ?? 0, 0, Math.max(0, viewportHeight - 20));
  const yBottomBound = clamp(options.yLowerBoundPx ?? viewportHeight, yTopBound + 60, viewportHeight);
  const yMedianTarget = options.yMedianTargetPx == null
    ? (yTopBound + yBottomBound) / 2
    : clamp(options.yMedianTargetPx, yTopBound, yBottomBound);

  const convergeGapProfile = computeConvergeGapProfile(adaptiveProfile);
  const baseLaneGap = convergeGapProfile.d1;
  const laneMaxGap = convergeGapProfile.d2;
  let turns: StorylineTurnGeometry[] = [];
  let converges: StorylineConvergeGeometry[] = [];
  let turnBoundaries: StorylineTurnBoundary[] = [];
  let summaryAreas: StorylineSummaryArea[] = [];
  let activePlanAreas: StorylineActivePlanArea[] = [];
  let boundaryBranches: StorylineBoundaryBranch[] = [];
  let nodes: LegacyStorylineNodeGeometry[] = [];
  let plotMinY = 0;
  let plotMaxY = viewportHeight;
  let plotMinX = 0;
  let plotMaxX = 0;
  let activePlanDraftsByTurn = new Map<number, ActivePlanDraft[]>();

  for (let widthPass = 0; widthPass < SUMMARY_LOCAL_MAX_TURN_WIDTH_PASSES; widthPass += 1) {
    turns = [];
    converges = [];
    turnBoundaries = [];

    let xCursor = 0;
    for (let convergeIndex = 0; convergeIndex <= turnCount; convergeIndex += 1) {
      const xStart = xCursor;
      const xEnd = xStart + convergeWidth;
      converges.push({
        index: convergeIndex,
        xStart,
        xEnd,
        lanes: [],
      });
      xCursor = xEnd;

      if (convergeIndex >= turnCount) continue;

      const turnXStart = xCursor;
      const turnWidth = turnWidthByIndex[convergeIndex] ?? baseTurnWidth;
      const turnXEnd = turnXStart + turnWidth;
      turns.push({
        index: convergeIndex,
        xStart: turnXStart,
        xEnd: turnXEnd,
        areaLeft: turnXStart + turnMargin,
        areaRight: turnXEnd - turnMargin,
        margin: turnMargin,
        summaryIds: [],
      });
      turnBoundaries.push({
        id: `turn-boundary:${convergeIndex}:left`,
        x: turnXStart,
        turnIndex: convergeIndex,
        side: 'left',
      });
      turnBoundaries.push({
        id: `turn-boundary:${convergeIndex}:right`,
        x: turnXEnd,
        turnIndex: convergeIndex,
        side: 'right',
      });
      xCursor = turnXEnd;
    }

    const summaryAreasPass: StorylineSummaryArea[] = [];
    activePlanDraftsByTurn = new Map<number, ActivePlanDraft[]>();
    const columnsByTurn = new Map<number, Set<string>>();
    const convergeLaneStatesByIndex: BoundaryLaneState[][] = Array.from(
      { length: turnCount + 1 },
      () => []
    );
    const preferredConvergeTargetYByIndex = new Map<number, Map<string, number>>();
    let needsWidthRerun = false;

    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      const plannedColumns = plannedColumnsByTurn.get(turnIndex) ?? new Set<string>();
      columnsByTurn.set(turnIndex, new Set(plannedColumns));
    }

    for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
      const turn = turns[turnIndex];
      if (!turn) continue;
      const entries = replayEntriesByTurn.get(turnIndex) ?? [];
      const activePlans = activePlanEntriesByTurn.get(turnIndex) ?? [];
      const entryBySummaryId = new Map(entries.map((entry) => [entry.summary.insight_id, entry]));
      const ingressResult = turnIndex === 0
        ? null
        : solveIngressWindow({
            leftLanes: convergeLaneStatesByIndex[turnIndex],
            summaries: entries.map((entry) => ({
              summaryId: entry.summary.insight_id,
              columns: collectSummaryColumns(entry.summary),
              leftAnchorOffsetYByColumn: {},
            })),
            turnIndex,
            adaptiveProfile,
            yTopBound,
            yBottomBound,
            baseD1: baseLaneGap,
            baseD2: laneMaxGap,
          });
      const ingressOrderedLanes = ingressResult?.leftLanes ?? convergeLaneStatesByIndex[turnIndex];
      if (ingressResult) {
        convergeLaneStatesByIndex[turnIndex] = ingressOrderedLanes;
      }
      const orderedEntries = turnIndex === 0
        ? entries
        : (ingressResult?.orderedSummaryIds ?? [])
          .map((summaryId) => entryBySummaryId.get(summaryId))
          .filter((entry): entry is SummaryReplayEntry => Boolean(entry));

      const localDrafts = orderedEntries.map((entry) => {
        const summaryId = entry.summary.insight_id;
        const boundaryContract = turnIndex === 0
          ? null
          : ingressResult?.contractBySummaryId.get(summaryId) ?? null;
        const prepared = prepareSummaryLocalLayout({
          summary: entry.summary,
          turnIndex,
          runState,
          profile: adaptiveProfile,
          viewportWidthPx,
          boundaryContract,
        });
        preparedLayoutsBySummaryId.set(summaryId, prepared);
        const requiredTurnWidth = computeRequiredTurnWidth({
          baseTurnWidth,
          turnMargin,
          requiredAreaWidth: prepared.requiredAreaWidth,
        });
        if (requiredTurnWidth > (turnWidthByIndex[turnIndex] ?? baseTurnWidth) + 1e-6) {
          turnWidthByIndex[turnIndex] = requiredTurnWidth;
          needsWidthRerun = true;
        }
        return mapPreparedSummaryLocalLayoutToTurn({
          prepared,
          areaLeft: turn.areaLeft,
          areaRight: turn.areaRight,
        });
      });
      const activePlanDrafts = activePlans.map((entry) => mapActivePlanDraftToTurn({
        plan: entry.plan,
        turnIndex,
        areaLeft: turn.areaLeft,
        areaRight: turn.areaRight,
        adaptiveProfile,
      }));
      activePlanDraftsByTurn.set(turnIndex, activePlanDrafts);
      const turnDrafts: TurnAreaDraft[] = [...localDrafts];
      let resolvedLeftLanes = ingressOrderedLanes;
      if (turnIndex !== 0 && ingressResult) {
        const ingressLeftColumns = columnsByTurn.get(turnIndex - 1) ?? new Set<string>();
        const ingressRightColumns = columnsByTurn.get(turnIndex) ?? new Set<string>();
        const ingressHasMutableExtensionLane = ingressOrderedLanes.some((lane) => lane.frozenOrder === false);
        const ingressExtensionLaneGapBoost = ingressHasMutableExtensionLane
          ? clamp(CONVERGE_EXTENSION_LANE_D1_BOOST_PX * adaptiveProfile.labelScale, 6, 16)
          : 0;
        const ingressIndicatorRequiredGap = computeConvergeIndicatorRequiredLaneGap({
          laneStates: ingressOrderedLanes,
          leftColumns: ingressLeftColumns,
          rightColumns: ingressRightColumns,
          rightTurnEntries: entries,
          markerDiameter: convergeEndpointMarkerDiameter,
          zoomX: adaptiveProfile.xZoomRatio,
          labelScale: adaptiveProfile.labelScale * CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
        });
        const ingressLaneGap = Math.max(
          baseLaneGap,
          ingressIndicatorRequiredGap,
          baseLaneGap + ingressExtensionLaneGapBoost,
        );
        const ingressLaneMaxGap = Math.max(
          laneMaxGap,
          ingressLaneGap + Math.max(6, ingressLaneGap * 0.75)
        );
        resolvedLeftLanes = solveIngressConvergeWindow({
          leftLanes: ingressOrderedLanes,
          summaries: localDrafts.map((draft) => ({
            summaryId: draft.summaryId,
            columns: draft.columns,
            leftAnchorOffsetYByColumn: draft.leftAnchorYByColumn,
          })),
          adaptiveProfile,
          yTopBound,
          yBottomBound,
          baseD1: ingressLaneGap,
          baseD2: ingressLaneMaxGap,
        });
        preferredConvergeTargetYByIndex.set(
          turnIndex,
          new Map(resolvedLeftLanes.map((lane) => [lane.column, lane.y]))
        );
      }
      const resolvedLeftConvergeYByColumn = new Map<string, number>(
        resolvedLeftLanes.map((lane) => [lane.column, lane.y])
      );
      const solvedTurnTops = solveTurnAreaTops({
        drafts: turnDrafts,
        leftConvergeYByColumn: resolvedLeftConvergeYByColumn,
        adaptiveProfile,
        yTopBound,
        yBottomBound,
      });
      const solvedTurnAreas = materializeTurnAreasFromSolvedTops({
        drafts: turnDrafts,
        solvedTops: solvedTurnTops,
        fallbackTop: yTopBound,
      });
      const solvedSummaryAreas = solvedTurnAreas.summaryAreas;
      if (ingressResult) {
        convergeLaneStatesByIndex[turnIndex] = resolvedLeftLanes;
      }

      for (const area of solvedSummaryAreas) {
        summaryAreasPass.push(area);
        turn.summaryIds.push(area.summaryId);

        const turnColumns = columnsByTurn.get(turnIndex) ?? new Set<string>();
        for (const column of area.columns) {
          turnColumns.add(column);
        }
        columnsByTurn.set(turnIndex, turnColumns);
      }

      if (turnIndex === 0) {
        const initialSignature = solveInitialLeftConvergeWindow({
          summaries: solvedSummaryAreas.map((area) => ({
            summaryId: area.summaryId,
            top: area.top,
            rightAnchorYByColumn: area.leftAnchorYByColumn,
          })),
          adaptiveProfile,
          yTopBound,
          yBottomBound,
          baseD1: baseLaneGap,
          baseD2: laneMaxGap,
        });
        preferredConvergeTargetYByIndex.set(
          0,
          new Map(
            Object.keys(initialSignature.targetYByColumn).map((column) => ([
              column,
              initialSignature.targetYByColumn[column] ?? yMedianTarget,
            ]))
          )
        );
        convergeLaneStatesByIndex[0] = initialSignature.orderedColumns.map((column) => ({
          column,
          y: initialSignature.targetYByColumn[column] ?? yMedianTarget,
          frozenOrder: true,
          introducedForTurnIndex: 0,
        }));
      }

      if (turnIndex + 1 <= turnCount) {
        const egressSignature = solveEgressWindow({
          summaries: solvedSummaryAreas.map((area) => ({
            summaryId: area.summaryId,
            top: area.top,
            rightAnchorYByColumn: area.rightAnchorYByColumn,
          })),
          adaptiveProfile,
          yTopBound,
          yBottomBound,
          baseD1: baseLaneGap,
          baseD2: laneMaxGap,
        });
        convergeLaneStatesByIndex[turnIndex + 1] = egressSignature.orderedColumns.map((column) => ({
          column,
          y: egressSignature.targetYByColumn[column] ?? yMedianTarget,
          frozenOrder: true,
          introducedForTurnIndex: turnIndex,
        }));
      }
    }

    if (needsWidthRerun && widthPass + 1 < SUMMARY_LOCAL_MAX_TURN_WIDTH_PASSES) {
      continue;
    }

    for (let convergeIndex = 0; convergeIndex <= turnCount; convergeIndex += 1) {
      const leftColumns = convergeIndex > 0
        ? (columnsByTurn.get(convergeIndex - 1) ?? new Set<string>())
        : new Set<string>();
      const rightColumns = convergeIndex < turnCount
        ? (columnsByTurn.get(convergeIndex) ?? new Set<string>())
        : new Set<string>();
      converges[convergeIndex]!.lanes = materializeConvergeLanes({
        converge: converges[convergeIndex]!,
        laneStates: convergeLaneStatesByIndex[convergeIndex],
        leftColumns,
        rightColumns,
        markerDiameter: convergeEndpointMarkerDiameter,
      });
    }

    const convergeLaneIndicatorMetadata = buildConvergeLaneIndicatorMetadata({
      converges,
      summaryAreas: summaryAreasPass,
      summaries,
      zoomX: adaptiveProfile.xZoomRatio,
      labelScale: adaptiveProfile.labelScale * CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
    });
    const requiredLaneGapByConvergeIndex = new Map<number, number>();
    for (const converge of converges) {
      let maxRequiredGap = 0;
      for (const lane of converge.lanes) {
        const laneKey = `${converge.index}::${lane.column}`;
        maxRequiredGap = Math.max(
          maxRequiredGap,
          convergeLaneIndicatorMetadata.requiredClearanceByLaneKey.get(laneKey) ?? 0
        );
      }
      requiredLaneGapByConvergeIndex.set(converge.index, maxRequiredGap);
    }

    for (let convergeIndex = 0; convergeIndex <= turnCount; convergeIndex += 1) {
      const leftColumns = convergeIndex > 0
        ? (columnsByTurn.get(convergeIndex - 1) ?? new Set<string>())
        : new Set<string>();
      const rightColumns = convergeIndex < turnCount
        ? (columnsByTurn.get(convergeIndex) ?? new Set<string>())
        : new Set<string>();
      const laneStates = convergeLaneStatesByIndex[convergeIndex];
      const hasMutableExtensionLane = laneStates.some((lane) => lane.frozenOrder === false);
      const preserveResolvedIngressBand = hasMutableExtensionLane
        && preferredConvergeTargetYByIndex.has(convergeIndex);
      if (!preserveResolvedIngressBand) {
        const extensionLaneGapBoost = hasMutableExtensionLane
          ? clamp(CONVERGE_EXTENSION_LANE_D1_BOOST_PX * adaptiveProfile.labelScale, 6, 16)
          : 0;
        const laneGapForConverge = Math.max(
          baseLaneGap,
          requiredLaneGapByConvergeIndex.get(convergeIndex) ?? 0,
          baseLaneGap + extensionLaneGapBoost,
        );
        const laneMaxGapForConverge = Math.max(
          laneMaxGap,
          laneGapForConverge + Math.max(6, laneGapForConverge * 0.75)
        );
        const targetYByColumn = preferredConvergeTargetYByIndex.get(convergeIndex)
          ?? new Map<string, number>(laneStates.map((lane) => [lane.column, lane.y]));
        const solvedYByColumn = solveGapConstrainedPositionsPreservingFrozenLanes({
          lanes: laneStates,
          targetYByColumn,
          minY: yTopBound + 8,
          maxY: yBottomBound - 8,
          d1: laneGapForConverge,
          d2: laneMaxGapForConverge,
        });
        const preferredBandTargets = preferredConvergeTargetYByIndex.get(convergeIndex);
        if (preferredBandTargets && preferredBandTargets.size > 0) {
          const targetBandValues = laneStates
            .map((lane) => preferredBandTargets.get(lane.column))
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
          const solvedBandValues = laneStates
            .map((lane) => solvedYByColumn.get(lane.column))
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
          if (targetBandValues.length > 0 && solvedBandValues.length > 0) {
            const targetBandCenter = (Math.min(...targetBandValues) + Math.max(...targetBandValues)) / 2;
            const solvedBandMin = Math.min(...solvedBandValues);
            const solvedBandMax = Math.max(...solvedBandValues);
            const solvedBandCenter = (solvedBandMin + solvedBandMax) / 2;
            const delta = clamp(
              targetBandCenter - solvedBandCenter,
              (yTopBound + 8) - solvedBandMin,
              (yBottomBound - 8) - solvedBandMax,
            );
            if (Math.abs(delta) > 1e-6) {
              for (const lane of laneStates) {
                const y = solvedYByColumn.get(lane.column);
                if (typeof y !== 'number' || !Number.isFinite(y)) continue;
                solvedYByColumn.set(lane.column, clamp(y + delta, yTopBound + 8, yBottomBound - 8));
              }
            }
          }
        }
        convergeLaneStatesByIndex[convergeIndex] = laneStates.map((lane) => ({
          ...lane,
          y: solvedYByColumn.get(lane.column) ?? lane.y,
        }));
      }
      converges[convergeIndex]!.lanes = materializeConvergeLanes({
        converge: converges[convergeIndex]!,
        laneStates: convergeLaneStatesByIndex[convergeIndex],
        leftColumns,
        rightColumns,
        markerDiameter: convergeEndpointMarkerDiameter,
        metadata: convergeLaneIndicatorMetadata,
      });
    }

    const bandCenteredGeometry = applyPerBandVerticalCentering({
      summaryAreas: summaryAreasPass,
      activePlanAreas: [],
      converges,
      yTopBound,
      yBottomBound,
    });
    const centeredSummaryAreasPass = bandCenteredGeometry.summaryAreas;
    const centeredConverges = bandCenteredGeometry.converges;
    const summaryAreasByTurn = buildSummaryAreasByTurn(centeredSummaryAreasPass);
    const centeredActivePlanAreasPass = turns.flatMap((turn) => materializeTurnActivePlans({
      drafts: activePlanDraftsByTurn.get(turn.index) ?? [],
      summaryAreas: summaryAreasByTurn.get(turn.index) ?? [],
      adaptiveProfile,
      yTopBound,
      yBottomBound,
    }));

    const boundaryBranchesPass: StorylineBoundaryBranch[] = [];
    for (const area of centeredSummaryAreasPass) {
      const leftConverge = centeredConverges[area.turnIndex];
      const rightConverge = centeredConverges[area.turnIndex + 1];
      if (leftConverge) {
        for (const [column, toY] of Object.entries(area.leftAnchorYByColumn)) {
          const lane = leftConverge.lanes.find((item) => item.column === column);
          if (!lane) continue;
          const fromX = leftConverge.xEnd;
          const fromY = lane.y;
          const toX = area.left;
          const curve = branchPath(fromX, fromY, toX, toY);
          boundaryBranchesPass.push({
            id: `branch:${area.summaryId}:left:${column}`,
            summaryId: area.summaryId,
            column,
            turnIndex: area.turnIndex,
            side: 'left',
            fromX,
            fromY,
            toX,
            toY,
            c1X: curve.c1X,
            c1Y: curve.c1Y,
            c2X: curve.c2X,
            c2Y: curve.c2Y,
            path: curve.path,
          });
        }
      }
      if (rightConverge) {
        for (const [column, toY] of Object.entries(area.rightAnchorYByColumn)) {
          const lane = rightConverge.lanes.find((item) => item.column === column);
          if (!lane) continue;
          const fromX = rightConverge.xStart;
          const fromY = lane.y;
          const toX = area.right;
          const curve = branchPath(fromX, fromY, toX, toY);
          boundaryBranchesPass.push({
            id: `branch:${area.summaryId}:right:${column}`,
            summaryId: area.summaryId,
            column,
            turnIndex: area.turnIndex,
            side: 'right',
            fromX,
            fromY,
            toX,
            toY,
            c1X: curve.c1X,
            c1Y: curve.c1Y,
            c2X: curve.c2X,
            c2Y: curve.c2Y,
            path: curve.path,
          });
        }
      }
    }

    const nodesPass = centeredSummaryAreasPass.flatMap((area) => area.nodes);
    converges = centeredConverges;
    summaryAreas = centeredSummaryAreasPass;
    activePlanAreas = centeredActivePlanAreasPass;
    boundaryBranches = boundaryBranchesPass;
    nodes = nodesPass;
    const allYValues = collectStorylineContentYValues({
      summaryAreas: centeredSummaryAreasPass,
      activePlanAreas: centeredActivePlanAreasPass,
      converges: centeredConverges,
      boundaryBranches: boundaryBranchesPass,
    });
    const minY = allYValues.length > 0 ? Math.min(...allYValues) : yTopBound;
    const maxY = allYValues.length > 0 ? Math.max(...allYValues) : yBottomBound;
    plotMinY = Math.min(0, minY - 24 - CONVERGE_SUMMARY_BUTTON_RESERVED_TOP_PX);
    plotMaxY = Math.max(viewportHeight, maxY + 24, yBottomBound);
    plotMinX = 0;
    plotMaxX = xCursor;
    break;
  }

  return {
    laneMode,
    nodes,
    summaryAreas,
    activePlanAreas,
    turns,
    converges,
    turnBoundaries,
    boundaryBranches,
    plotMinX,
    plotMaxX,
    plotMinY,
    plotMaxY,
    plotWidth: Math.max(0, plotMaxX - plotMinX),
    plotHeight: Math.max(0, plotMaxY - plotMinY),
    adaptiveProfile,
  };
}

export function getTrackStrokeColor(involved: boolean): string {
  return involved ? STORYLINE_TRACK_UNIFIED_COLOR_HEX : STORYLINE_TRACK_UNINVOLVED_COLOR_HEX;
}
