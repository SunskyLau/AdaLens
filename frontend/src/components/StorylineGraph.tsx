import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Crosshair, EyeOff, Search } from 'lucide-react';
import { shallow } from 'zustand/shallow';
import { INSIGHT_TAXONOMY_V1 } from '@/config';
import type {
  AtomicInsight,
  InsightType,
  PlanItem,
  PlanControlAction,
  RunState,
  Selection,
  SteeringTargetSnapshot,
} from '@/types';
import { controlPlan, steerRun } from '@/api/client';
import { useStore } from '@/store/useStore';
import {
  buildElaborateUserPromptPreview,
  createElaborateSteerRequest,
} from '@/steering/elaborate';
import {
  buildFocusUserPromptPreview,
  createFocusSteerRequest,
} from '@/steering/focus';
import {
  buildIgnoreUserPromptPreview,
  createIgnoreSteerRequest,
} from '@/steering/ignore';
import { getSoftSteeringDisplayLabel } from '@/steering/kinds';
import {
  composeSteeringPreviewDraft,
  deriveSteeringPreviewSuffix,
  getEditableSteeringBackgroundText,
  normalizeEditableSteeringPreview,
} from '@/steering/prompt';
import {
  getSteeringPreviewPlaceholder,
  resolveSteeringPreviewLanguage,
} from '@/steering/language';
import {
  buildColumnTarget,
  buildLatestSoftSteeringByTarget,
  doesSteeringTargetExist,
  findAtomicTarget,
  findSummaryTarget,
} from '@/steering/target';
import SteeringCardTitle from './SteeringCardTitle';
import StorylineGraphScene from './StorylineGraphScene';
import StorylineSteeringPopover, {
  type StorylineSteeringPopoverState,
} from './storylineSteeringPopover';
import {
  resolveStorylinePenClickBehavior,
  shouldPreserveSteeringPopoverOnNextSelectionChange,
} from './storylinePenInteraction';
import { activateStorylineTarget } from './storylineTargetActivation';
import {
  buildStorylineTurnConvergeLayout,
  type StorylineConvergeLaneMode,
  type StorylineLaneMode,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_WHEEL_SPEED,
} from './storylineTurnConvergeLayout';
import { buildVisibleTrackLabels, CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER } from './storylineTrackLabels';
import {
  clamp,
  type StorylineColumnTrack,
} from './storylineGraphLayout';
import {
  EMPTY_STORYLINE_FILTER_VIEW_MODEL,
  deriveStorylineFilterRenderState,
  type StorylineFilterTriState,
  type StorylineFilterViewModel,
} from './storylineFilter';
import {
  STORYLINE_GRAPH_RENDER_CONSTANTS,
  FILTERED_INDICATOR_TEXT_OPACITY,
  buildSummaryConnectivityConvergeLaneKey,
  computeSelectedGlyphConnectedTrackSegments,
  computeSelectedSummaryConnectivityHighlight,
  computeSelectedSummarySharedColumnSummaryIds,
  computeSelectedSummaryExtensionPromotionHighlight,
  createEmptySelectedGlyphConnectionHighlight,
  createEmptySelectedSummaryConnectivityHighlight,
  createEmptySelectedSummaryExtensionPromotionHighlight,
  deriveStorylineSelectionHighlightPolicy,
  isStorylineCanvasClickGesture,
  isStorylineColumnClickGesture,
  resolveStorylineColumnClickMode,
  resolveStorylineModifierPlatform,
  resolveConvergeIndicatorTextColor,
  resolveConvergeIndicatorMaskTone,
  resolveStorylineColumnEmphasisState,
  resolveStorylineColumnFilterLineState,
  resolveStorylinePlanSelectionAfterFilterClear,
  resolveSummaryInternalsRenderMode,
  SUMMARY_AREA_FILL_HEX,
  SUMMARY_TITLE_FILL_HEX,
  shouldRenderColumnIndicators,
  isSummarySelection,
  type SelectedGlyphConnectionHighlight,
  type SelectedSummaryConnectivityHighlight,
  type SelectedSummaryExtensionPromotionHighlight,
  type StorylineCanvasPointerDown,
  type StorylineColumnEmphasisState,
  type StorylineColumnInteractionSource,
  type StorylineLinePointerDown,
} from './storylineGraphSelection';
import {
  buildConvergeIndicatorTracks,
  buildStorylineAutoFitKey,
  chooseStorylineInitialScale,
  clampViewX,
  collectFullyVisibleConvergeIndexes,
  computeMinimapPointDiameter,
  computeStorylineMinimapFrame,
  computeStorylineVerticalCenterOffset,
  computeStorylineWorldBounds,
  focusViewOnStorylineConvergeIndex,
  focusViewOnStorylinePlanArea,
  focusViewOnStorylineSummaryTurn,
  getNodeColor,
  parseConvergeLabelId,
  type ConvergeIndicatorVisualState,
  type MinimapPoint,
  type MinimapState,
  type ViewTransform,
} from './storylineGraphViewport';
import {
  buildCreateOriginPlanIds,
  buildCreateOriginSummaryIds,
  buildCreateSteeringEntryIdByPlanId,
  isCreatePopoverSubmitKey,
  resolveStorylineCreatePopoverPosition,
  resolvePreferredConversationEntryForPlan,
} from './storylineCreateOrigin';
import {
} from './storylineDispatchBatch';
import {
  buildConvergeSummaryButtons,
  type StorylineConvergeSummaryButton,
} from './storylineSummaryButtons';
import {
  computeInteractiveScrollbarMetrics,
  resolveScrollOffsetFromThumbOffset,
  resolveThumbOffsetFromTrackPointer,
} from './interactiveScrollbar';
export * from './storylineGraphSelection';
export {
  buildConvergeIndicatorTracks,
  buildStorylineAutoFitKey,
  chooseStorylineInitialScale,
  collectFullyVisibleConvergeIndexes,
  computeMinimapPointDiameter,
  computeStorylineMinimapFrame,
  focusViewOnStorylineSummaryTurn,
  focusViewOnStorylineConvergeIndex,
  isMinimapPointSelected,
  isSummaryAreaFullyVisibleInViewport,
} from './storylineGraphViewport';
export { computeSummaryAverageImportance, buildSummaryAverageImportanceById } from './storylineImportance';

interface StorylineGraphProps {
  laneMode: StorylineLaneMode;
  storylineFilter?: StorylineFilterViewModel | null;
  activeSteeringPen?: SteeringPenKind | null;
  onActiveSteeringPenChange?: (penKind: SteeringPenKind | null) => void;
  turnFocusRequest?: { summaryId: string; nonce: number } | null;
  planFocusRequest?: { planId: string; nonce: number } | null;
  convergeFocusRequest?: { convergeIndex: number; nonce: number } | null;
  highlightedSummaryEntryId?: string | null;
  onConversationEntryFocusRequest?: (conversationEntryId: string) => void;
  onConversationEntryHighlightRequest?: (conversationEntryId: string) => void;
  onSummaryEntryFocusRequest?: (conversationEntryId: string) => void;
}

interface DragState {
  startX: number;
  originTx: number;
}

interface HoveredTrack {
  column: string;
  x: number;
  y: number;
}

interface HoveredAtomicPreview {
  summaryId: string;
  atomicId: string;
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

interface MinimapDragState {
  startClientX: number;
  startWorldLeft: number;
}

interface StorylineHorizontalScrollbarDragState {
  pointerOffsetX: number;
}

interface CreatePopoverState {
  draft: string;
  x: number;
  y: number;
}

export interface PendingColumnPenSelection {
  kind: 'focus' | 'ignore';
  columns: string[];
  columnAnchors: Array<{ column: string; converge_index: number }>;
  x: number;
  y: number;
}

interface SteeringPopoverDragState {
  pointerOffsetX: number;
  pointerOffsetY: number;
}

const STEERING_PEN_ORDER = ['focus', 'ignore', 'elaborate'] as const;
export type SteeringPenKind = (typeof STEERING_PEN_ORDER)[number];

const {
  MINIMAP_HEIGHT_PX,
  MINIMAP_TOP_PX,
  MINIMAP_CARD_PADDING_PX,
  STORYLINE_BODY_GAP_BELOW_MINIMAP_PX,
  STORYLINE_BODY_BOTTOM_PADDING_PX,
  STORYLINE_Y_BOTTOM_GAP_ABOVE_ZOOM_BADGE_PX,
  STORYLINE_Y_TOP_GAP_BELOW_MINIMAP_PX,
  ZOOM_BADGE_BOTTOM_PX,
  ZOOM_BADGE_ESTIMATED_HEIGHT_PX,
} = STORYLINE_GRAPH_RENDER_CONSTANTS;

const STEERING_KEYWORD_LIMIT = 10;
const STORYLINE_PEN_BUTTON_WIDTH_PX = 96;
const STORYLINE_BOTTOM_SCROLLBAR_LEFT_PX = 12;
const STORYLINE_BOTTOM_SCROLLBAR_RIGHT_SAFE_GAP_PX = 108;
const STORYLINE_BOTTOM_SCROLLBAR_BOTTOM_PX = 8;
const STORYLINE_BOTTOM_SCROLLBAR_HEIGHT_PX = 12;
const STORYLINE_BOTTOM_SCROLLBAR_MIN_THUMB_PX = 34;

const STEERING_PEN_META: Record<
  SteeringPenKind,
  {
    icon: typeof Crosshair;
    description: string;
    activeButtonClassName: string;
    idleButtonClassName: string;
    chipActiveClassName: string;
    chipIdleClassName: string;
    accentTextClassName: string;
  }
> = {
  focus: {
    icon: Crosshair,
    description: 'Click columns, summaries, or glyphs to focus follow-up analysis.',
    activeButtonClassName: 'border-amber-300 bg-amber-100 text-amber-900 shadow-sm',
    idleButtonClassName: 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:bg-amber-50',
    chipActiveClassName: 'border-amber-300 bg-amber-100 text-amber-900',
    chipIdleClassName: 'border-slate-200 bg-slate-50 text-slate-600 hover:border-amber-200 hover:bg-amber-50',
    accentTextClassName: 'text-amber-700',
  },
  ignore: {
    icon: EyeOff,
    description: 'Click columns, summaries, or glyphs to suppress that direction.',
    activeButtonClassName: 'border-rose-300 bg-rose-100 text-rose-900 shadow-sm',
    idleButtonClassName: 'border-slate-200 bg-white text-slate-600 hover:border-rose-200 hover:bg-rose-50',
    chipActiveClassName: 'border-rose-300 bg-rose-100 text-rose-900',
    chipIdleClassName: 'border-slate-200 bg-slate-50 text-slate-600 hover:border-rose-200 hover:bg-rose-50',
    accentTextClassName: 'text-rose-700',
  },
  elaborate: {
    icon: Search,
    description: 'Click a summary or glyph to deepen explanation around that insight.',
    activeButtonClassName: 'border-sky-300 bg-sky-100 text-sky-900 shadow-sm',
    idleButtonClassName: 'border-slate-200 bg-white text-slate-600 hover:border-sky-200 hover:bg-sky-50',
    chipActiveClassName: 'border-sky-300 bg-sky-100 text-sky-900',
    chipIdleClassName: 'border-slate-200 bg-slate-50 text-slate-600 hover:border-sky-200 hover:bg-sky-50',
    accentTextClassName: 'text-sky-700',
  },
};

export function StorylinePenToolbar({
  activeSteeringPen,
  pendingColumnPenSelection,
  steeringActionError = null,
  topPx,
  heightPx,
  placement = 'overlay',
  onTogglePen,
}: {
  activeSteeringPen: SteeringPenKind | null;
  pendingColumnPenSelection: PendingColumnPenSelection | null;
  steeringActionError?: string | null;
  topPx?: number;
  heightPx?: number;
  placement?: 'overlay' | 'inline';
  onTogglePen: (penKind: SteeringPenKind) => void;
}) {
  const isOverlayPlacement = placement === 'overlay';
  const buttons = STEERING_PEN_ORDER.map((penKind) => {
    const meta = STEERING_PEN_META[penKind];
    const Icon = meta.icon;
    const isActive = activeSteeringPen === penKind;
    const pendingCount =
      penKind !== 'elaborate' && pendingColumnPenSelection?.kind === penKind
        ? pendingColumnPenSelection.columns.length
        : 0;
    return (
      <button
        key={penKind}
        type="button"
        data-storyline-pen={penKind}
        data-storyline-pen-active={isActive ? 'true' : undefined}
        className={[
          'inline-flex rounded-lg border px-2 py-1.5 text-center transition',
          isActive ? meta.activeButtonClassName : meta.idleButtonClassName,
        ].join(' ')}
        style={{ width: `${STORYLINE_PEN_BUTTON_WIDTH_PX}px` }}
        onClick={() => onTogglePen(penKind)}
      >
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-1">
          <div className="col-start-2 inline-flex items-center justify-center gap-1 text-[12px] font-semibold leading-none">
            <Icon className="h-3 w-3 shrink-0" />
            <span>{getSoftSteeringDisplayLabel(penKind)}</span>
          </div>
          {pendingCount > 0 ? (
            <span className="col-start-3 justify-self-end rounded-full bg-white/80 px-1.5 py-px text-[9px] font-semibold leading-none text-slate-700">
              {pendingCount}
            </span>
          ) : null}
        </div>
      </button>
    );
  });

  if (!isOverlayPlacement) {
    return (
      <>
        {buttons}
        {steeringActionError ? (
          <div className="text-xs text-rose-600">
            {steeringActionError}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div
      data-storyline-top-rail-card="pens"
      data-storyline-toolbar-placement={placement}
      data-storyline-interactive="true"
      data-storyline-pen-toolbar="true"
      className="absolute left-4 z-40 inline-flex items-center rounded-xl border border-slate-200 bg-white/95 px-2.5 py-2 shadow-md backdrop-blur-sm"
      style={{
        top: `${topPx ?? MINIMAP_TOP_PX}px`,
        minHeight: `${heightPx ?? MINIMAP_HEIGHT_PX}px`,
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        {buttons}
      </div>
      {steeringActionError ? (
        <div className="absolute left-0 top-full mt-2 rounded-md border border-rose-200 bg-white px-2 py-1 text-xs text-rose-600 shadow-sm">
          {steeringActionError}
        </div>
      ) : null}
    </div>
  );
}

export function resolveActiveSteeringPenAfterSuccessfulSubmit(
  _current: SteeringPenKind | null
): SteeringPenKind | null {
  return null;
}

export function resolveSelectionAfterConvergeSummaryButtonClick(): Selection {
  return { type: null, id: null };
}

function normalizeKeywordOptions(
  keywords: readonly string[] | null | undefined,
  limit = STEERING_KEYWORD_LIMIT
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawKeyword of keywords ?? []) {
    const keyword = String(rawKeyword ?? '').trim();
    if (!keyword) {
      continue;
    }
    const lookupKey = keyword.toLocaleLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }
    seen.add(lookupKey);
    normalized.push(keyword);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

export function parseCustomKeywords(customKeywords: string): string[] {
  return normalizeKeywordOptions(
    customKeywords
      .split(/[\n,，、]+/g)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
  );
}

function buildDefaultSteeringPreviewBase(
  kind: StorylineSteeringPopoverState['kind'],
  target: SteeringTargetSnapshot,
  selectedKeywords: readonly string[] = [],
  runState?: RunState | null
): string {
  const language = resolveSteeringPreviewLanguage(runState);
  if (kind === 'focus') {
    return buildFocusUserPromptPreview(target, {
      selectedKeywords: [...selectedKeywords],
      language,
    });
  }
  if (kind === 'ignore') {
    return buildIgnoreUserPromptPreview(target, {
      selectedKeywords: [...selectedKeywords],
      language,
    });
  }
  return buildElaborateUserPromptPreview(target, { language });
}

function buildDefaultSteeringBackgroundText(target: SteeringTargetSnapshot): string {
  return getEditableSteeringBackgroundText(target);
}

function createStorylineSteeringPopoverState(args: {
  kind: StorylineSteeringPopoverState['kind'];
  target: SteeringTargetSnapshot;
  x: number;
  y: number;
  selectedKeywords?: string[];
  runState?: RunState | null;
}): StorylineSteeringPopoverState {
  const selectedKeywords = normalizeKeywordOptions(args.selectedKeywords);
  const generatedPreviewBase = buildDefaultSteeringPreviewBase(
    args.kind,
    args.target,
    selectedKeywords,
    args.runState
  );
  return {
    kind: args.kind,
    target: args.target,
    x: args.x,
    y: args.y,
    selectedKeywords,
    generatedPreviewBase,
    userPromptSuffix: '',
    userPromptDraft: composeSteeringPreviewDraft(generatedPreviewBase),
    backgroundText:
      args.kind === 'elaborate' || args.target.kind === 'column'
        ? ''
        : buildDefaultSteeringBackgroundText(args.target),
    includeBackground: true,
    error: null,
  };
}

function getActivePlanMinimapColor(status: PlanItem['status']): string {
  if (status === 'analyzing') {
    return '#38bdf8';
  }
  if (status === 'summarizing') {
    return '#8b5cf6';
  }
  if (status === 'paused') {
    return '#f59e0b';
  }
  if (status === 'completed') {
    return '#10b981';
  }
  if (status === 'failed' || status === 'terminated') {
    return '#94a3b8';
  }
  return '#64748b';
}

export function togglePendingColumnPenSelection(args: {
  current: PendingColumnPenSelection | null;
  penKind: PendingColumnPenSelection['kind'];
  column: string;
  convergeIndex?: number;
  x: number;
  y: number;
}): PendingColumnPenSelection | null {
  const currentSamePen = args.current?.kind === args.penKind ? args.current : null;
  const baseColumns = currentSamePen?.columns ?? [];
  const baseAnchors = currentSamePen?.columnAnchors ?? [];
  const isRemoving = baseColumns.includes(args.column);
  const nextColumns = baseColumns.includes(args.column)
    ? baseColumns.filter((item) => item !== args.column)
    : [...baseColumns, args.column];
  const nextColumnAnchors = isRemoving
    ? baseAnchors.filter((anchor) => anchor.column !== args.column)
    : [
      ...baseAnchors.filter((anchor) => anchor.column !== args.column),
      ...(typeof args.convergeIndex === 'number' && args.convergeIndex >= 0
        ? [{ column: args.column, converge_index: args.convergeIndex }]
        : []),
    ];
  if (nextColumns.length === 0) {
    return null;
  }
  if (currentSamePen) {
    return {
      ...currentSamePen,
      columns: nextColumns,
      columnAnchors: nextColumnAnchors,
    };
  }
  return {
    kind: args.penKind,
    columns: nextColumns,
    columnAnchors: nextColumnAnchors,
    x: args.x,
    y: args.y,
  };
}

export default function StorylineGraph({
  laneMode,
  storylineFilter = null,
  activeSteeringPen = null,
  onActiveSteeringPenChange,
  turnFocusRequest = null,
  planFocusRequest = null,
  convergeFocusRequest = null,
  highlightedSummaryEntryId = null,
  onConversationEntryFocusRequest,
  onSummaryEntryFocusRequest,
}: StorylineGraphProps) {
  const { runState, selection, setSelection, setRunState, timelineEvents, conversationEntries } = useStore(
    (state) => {
      return {
        runState: state.runState,
        selection: state.selection,
        setSelection: state.setSelection,
        setRunState: state.setRunState,
        timelineEvents: state.timelineEvents,
        conversationEntries: state.conversationEntries,
      };
    },
    shallow
  );
  const upsertUserMessage = useStore((state) => state.upsertUserMessage);

  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const createTextareaRef = useRef<HTMLTextAreaElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const horizontalScrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const plotClipId = useId();
  const storylineLinePointerDownRef = useRef<StorylineLinePointerDown | null>(null);
  const storylineCanvasPointerDownRef = useRef<StorylineCanvasPointerDown | null>(null);

  const [viewport, setViewport] = useState({ width: 980, height: 620 });
  const [view, setView] = useState<ViewTransform>({ zoomX: 1, tx: 24 });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredTrack, setHoveredTrack] = useState<HoveredTrack | null>(null);
  const [hoveredAtomicPreview, setHoveredAtomicPreview] = useState<HoveredAtomicPreview | null>(null);
  const [hoveredSummaryPreview, setHoveredSummaryPreview] = useState<HoveredSummaryPreview | null>(null);
  const [hoveredPlanPreview, setHoveredPlanPreview] = useState<HoveredPlanPreview | null>(null);
  const [minimapDragState, setMinimapDragState] = useState<MinimapDragState | null>(null);
  const [horizontalScrollbarTrackWidth, setHorizontalScrollbarTrackWidth] = useState(0);
  const [horizontalScrollbarDragState, setHorizontalScrollbarDragState] =
    useState<StorylineHorizontalScrollbarDragState | null>(null);
  const [pendingColumnPenSelection, setPendingColumnPenSelection] = useState<PendingColumnPenSelection | null>(null);
  const [steeringPopover, setSteeringPopover] = useState<StorylineSteeringPopoverState | null>(null);
  const [steeringPopoverDragState, setSteeringPopoverDragState] = useState<SteeringPopoverDragState | null>(null);
  const [createPopover, setCreatePopover] = useState<CreatePopoverState | null>(null);
  const [createPopoverDragState, setCreatePopoverDragState] = useState<SteeringPopoverDragState | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmittingSteeringAction, setIsSubmittingSteeringAction] = useState(false);
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [planControlPendingById, setPlanControlPendingById] = useState<Record<string, PlanControlAction | null>>({});
  const [editingPlanState, setEditingPlanState] = useState<{
    planId: string;
    draft: string;
  } | null>(null);
  const lastAutoFitKeyRef = useRef<string | null>(null);
  const lastConsumedTurnFocusNonceRef = useRef<number | null>(null);
  const lastConsumedPlanFocusNonceRef = useRef<number | null>(null);
  const lastConsumedConvergeFocusNonceRef = useRef<number | null>(null);
  const preserveSteeringPopoverOnNextSelectionChangeRef = useRef(false);
  const previousActiveSteeringPenRef = useRef<SteeringPenKind | null>(activeSteeringPen);
  const activeStorylineFilter = storylineFilter ?? EMPTY_STORYLINE_FILTER_VIEW_MODEL;
  const storylineFilterSnapshot = activeStorylineFilter.snapshot;
  const storylineFilterActions = activeStorylineFilter.actions;
  const latestSoftSteeringByTarget = useMemo(
    () => buildLatestSoftSteeringByTarget(runState?.user_messages),
    [runState?.user_messages]
  );
  const maxPlanConcurrency = useMemo(() => {
    const raw = typeof runState?.settings?.default_sub_agents_num === 'number'
      ? runState.settings.default_sub_agents_num
      : typeof runState?.settings?.max_concurrency === 'number'
        ? runState.settings.max_concurrency
        : 2;
    return Math.max(1, Math.floor(raw));
  }, [runState?.settings?.default_sub_agents_num, runState?.settings?.max_concurrency]);
  const activeExecutionSeatCount = useMemo(() => {
    if (!runState) {
      return 0;
    }
    return runState.frontier.reduce((count, plan) => {
      if (plan.status === 'analyzing' || plan.status === 'summarizing') {
        return count + 1;
      }
      return count;
    }, 0);
  }, [runState]);
  const disablePendingPlanLaunch = activeExecutionSeatCount >= maxPlanConcurrency;
  const modifierPlatform = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return resolveStorylineModifierPlatform(null);
    }
    return resolveStorylineModifierPlatform(navigator.platform || navigator.userAgent);
  }, []);

  useEffect(() => {
    if (preserveSteeringPopoverOnNextSelectionChangeRef.current) {
      preserveSteeringPopoverOnNextSelectionChangeRef.current = false;
      return;
    }
    setPendingColumnPenSelection(null);
    setSteeringPopoverDragState(null);
    setSteeringPopover(null);
    setCreatePopoverDragState(null);
    setCreatePopover(null);
    setCreateError(null);
  }, [runState?.run_id, selection.id, selection.atomicId, selection.type]);

  useEffect(() => {
    preserveSteeringPopoverOnNextSelectionChangeRef.current = false;
    lastConsumedTurnFocusNonceRef.current = null;
    lastConsumedPlanFocusNonceRef.current = null;
    lastConsumedConvergeFocusNonceRef.current = null;
    setHorizontalScrollbarDragState(null);
    setEditingPlanState(null);
  }, [runState?.run_id]);

  useEffect(() => {
    setEditingPlanState((current) => {
      if (!current || !runState) {
        return current;
      }
      const plan = runState.frontier.find((item) => item.plan_id === current.planId);
      if (!plan || (plan.status !== 'pending' && plan.status !== 'paused')) {
        return null;
      }
      return current;
    });
  }, [runState]);

  useEffect(() => {
    if (previousActiveSteeringPenRef.current === activeSteeringPen) {
      return;
    }
    previousActiveSteeringPenRef.current = activeSteeringPen;
    setCreatePopoverDragState(null);
    setCreatePopover(null);
    setCreateError(null);
    clearPenTransientState();
  }, [activeSteeringPen]);

  useEffect(() => {
    setHoveredAtomicPreview(null);
    setHoveredSummaryPreview(null);
    setHoveredPlanPreview(null);
    setPlanControlPendingById({});
    onActiveSteeringPenChange?.(null);
    setPendingColumnPenSelection(null);
    setSteeringPopoverDragState(null);
    setCreatePopoverDragState(null);
  }, [onActiveSteeringPenChange, runState?.run_id]);


  useEffect(() => {
    if (!steeringPopover || !runState) {
      return;
    }
    const stillExists = doesSteeringTargetExist(runState, steeringPopover.target);
    if (!stillExists) {
      setSteeringPopoverDragState(null);
      setSteeringPopover(null);
    }
  }, [steeringPopover, runState]);

  useEffect(() => {
    if (!steeringPopover && !createPopover) {
      return undefined;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (overlayRef.current?.contains(event.target as Node)) {
        return;
      }
      setPendingColumnPenSelection(null);
      setSteeringPopoverDragState(null);
      setSteeringPopover(null);
      setCreatePopoverDragState(null);
      setCreatePopover(null);
      setCreateError(null);
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [steeringPopover, createPopover]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      onActiveSteeringPenChange?.(null);
      setHoveredSummaryPreview(null);
      setHoveredPlanPreview(null);
      setPendingColumnPenSelection(null);
      setSteeringPopoverDragState(null);
      setSteeringPopover(null);
      setCreatePopoverDragState(null);
      setCreatePopover(null);
      setCreateError(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onActiveSteeringPenChange]);

  useEffect(() => {
    if (!createPopover) {
      return;
    }
    createTextareaRef.current?.focus();
  }, [Boolean(createPopover)]);

  useEffect(() => {
    if (!steeringPopover || !steeringPopoverDragState || !containerRef.current) {
      return undefined;
    }
    const container = containerRef.current;
    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      setSteeringPopover((current) => (
        current
          ? {
            ...current,
            x: localX - steeringPopoverDragState.pointerOffsetX,
            y: localY - steeringPopoverDragState.pointerOffsetY,
          }
          : current
      ));
    };
    const handleMouseUp = () => {
      setSteeringPopoverDragState(null);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [steeringPopover, steeringPopoverDragState]);

  useEffect(() => {
    if (!createPopover || !createPopoverDragState || !containerRef.current) {
      return undefined;
    }
    const container = containerRef.current;
    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      setCreatePopover((current) => (
        current
          ? {
            ...current,
            x: localX - createPopoverDragState.pointerOffsetX,
            y: localY - createPopoverDragState.pointerOffsetY,
          }
          : current
      ));
    };
    const handleMouseUp = () => {
      setCreatePopoverDragState(null);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [createPopover, createPopoverDragState]);

  useEffect(() => {
    if (activeSteeringPen || view.zoomX >= 0.5) {
      setHoveredPlanPreview(null);
    }
  }, [activeSteeringPen, view.zoomX]);

  const clearPenTransientState = () => {
    setHoveredPlanPreview(null);
    setPendingColumnPenSelection(null);
    setSteeringPopoverDragState(null);
    setSteeringPopover(null);
  };


  const isDragging = dragState !== null;
  const minimapFrame = useMemo(
    () => computeStorylineMinimapFrame(viewport.width, viewport.height),
    [viewport.height, viewport.width]
  );
  const plotTopOffset = minimapFrame.top + minimapFrame.height + STORYLINE_BODY_GAP_BELOW_MINIMAP_PX;
  const plotViewport = useMemo(
    () => ({
      width: viewport.width,
      height: Math.max(220, viewport.height - plotTopOffset - STORYLINE_BODY_BOTTOM_PADDING_PX),
    }),
    [plotTopOffset, viewport.height, viewport.width]
  );
  const storylineYUpperBound = useMemo(
    () => clamp(STORYLINE_Y_TOP_GAP_BELOW_MINIMAP_PX, 0, Math.max(0, plotViewport.height - 60)),
    [plotViewport.height]
  );
  const storylineYBottomBound = useMemo(() => {
    const zoomBadgeTop = viewport.height - ZOOM_BADGE_BOTTOM_PX - ZOOM_BADGE_ESTIMATED_HEIGHT_PX;
    const inPlot = zoomBadgeTop - plotTopOffset - STORYLINE_Y_BOTTOM_GAP_ABOVE_ZOOM_BADGE_PX;
    return clamp(inPlot, storylineYUpperBound + 60, plotViewport.height);
  }, [plotTopOffset, plotViewport.height, storylineYUpperBound, viewport.height]);
  const storylineYMedianTarget = useMemo(
    () => storylineYUpperBound + (storylineYBottomBound - storylineYUpperBound) * 0.5,
    [storylineYBottomBound, storylineYUpperBound]
  );

  useEffect(() => {
    const updateViewport = () => {
      if (!containerRef.current) return;
      setViewport({
        width: containerRef.current.clientWidth || 980,
        height: containerRef.current.clientHeight || 620,
      });
    };

    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!horizontalScrollbarTrackRef.current) {
      return undefined;
    }
    const element = horizontalScrollbarTrackRef.current;
    const updateTrackWidth = () => {
      setHorizontalScrollbarTrackWidth(element.clientWidth);
    };
    updateTrackWidth();
    const observer = new ResizeObserver(updateTrackWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const autoFitBaseLayout = useMemo(
    () => buildStorylineTurnConvergeLayout(runState, plotViewport.height, {
      laneMode,
      events: timelineEvents,
      yUpperBoundPx: storylineYUpperBound,
      yLowerBoundPx: storylineYBottomBound,
      yMedianTargetPx: storylineYMedianTarget,
      xZoomRatio: 1,
      viewportWidthPx: plotViewport.width,
    }),
    [
      laneMode,
      plotViewport.height,
      plotViewport.width,
      runState,
      storylineYBottomBound,
      storylineYMedianTarget,
      storylineYUpperBound,
      timelineEvents,
    ]
  );
  const layout = useMemo(
    () => buildStorylineTurnConvergeLayout(runState, plotViewport.height, {
      laneMode,
      events: timelineEvents,
      yUpperBoundPx: storylineYUpperBound,
      yLowerBoundPx: storylineYBottomBound,
      yMedianTargetPx: storylineYMedianTarget,
      xZoomRatio: view.zoomX,
      viewportWidthPx: plotViewport.width,
    }),
    [
      laneMode,
      plotViewport.height,
      plotViewport.width,
      runState,
      storylineYBottomBound,
      storylineYMedianTarget,
      storylineYUpperBound,
      timelineEvents,
      view.zoomX,
    ]
  );
  const transformBounds = useMemo(() => computeStorylineWorldBounds(layout), [layout]);
  const storylineHorizontalScrollbarMetrics = useMemo(() => {
    const fallbackTrackWidth = Math.max(
      0,
      viewport.width - STORYLINE_BOTTOM_SCROLLBAR_LEFT_PX - STORYLINE_BOTTOM_SCROLLBAR_RIGHT_SAFE_GAP_PX
    );
    const effectiveTrackWidth = horizontalScrollbarTrackWidth > 0
      ? horizontalScrollbarTrackWidth
      : fallbackTrackWidth;
    const worldSpanX = Math.max(1, transformBounds.maxX - transformBounds.minX);
    const worldLeftRaw = 0 - view.tx;
    const maxWorldLeft = Math.max(transformBounds.minX, transformBounds.maxX - plotViewport.width);
    const clampedWorldLeft = clamp(worldLeftRaw, transformBounds.minX, maxWorldLeft);
    const scrollOffsetX = clampedWorldLeft - transformBounds.minX;
    return computeInteractiveScrollbarMetrics({
      viewportSizePx: plotViewport.width,
      contentSizePx: worldSpanX,
      scrollOffsetPx: scrollOffsetX,
      trackSizePx: effectiveTrackWidth,
      minThumbSizePx: STORYLINE_BOTTOM_SCROLLBAR_MIN_THUMB_PX,
    });
  }, [
    horizontalScrollbarTrackWidth,
    plotViewport.width,
    transformBounds.maxX,
    transformBounds.minX,
    viewport.width,
    view.tx,
  ]);
  const layoutVerticalOffset = useMemo(
    () => computeStorylineVerticalCenterOffset({
      layout,
      yUpperBound: storylineYUpperBound,
      yLowerBound: storylineYBottomBound,
    }),
    [layout, storylineYBottomBound, storylineYUpperBound]
  );
  const taxonomyLegendItems = useMemo(() => {
    const counts = new Map<InsightType, number>();
    for (const node of layout.nodes) {
      counts.set(node.insightType, (counts.get(node.insightType) || 0) + 1);
    }
    return INSIGHT_TAXONOMY_V1
      .map((taxonomy) => ({
        id: taxonomy.id as InsightType,
        label: taxonomy.label,
        count: counts.get(taxonomy.id as InsightType) || 0,
        color: getNodeColor(taxonomy.id as InsightType),
      }));
  }, [layout.nodes]);

  useEffect(() => {
    if (!runState || (
      autoFitBaseLayout.nodes.length === 0
      && autoFitBaseLayout.activePlanAreas.length === 0
    )) {
      lastAutoFitKeyRef.current = null;
      return;
    }
    if (dragState || minimapDragState || horizontalScrollbarDragState) return;
    // Keep viewport stable while summaries/plans append; auto-fit keys track
    // run/viewport context only, not incremental storyline content growth.
    const autoFitKey = buildStorylineAutoFitKey({
      runId: runState.run_id,
      viewportWidth: plotViewport.width,
      viewportHeight: plotViewport.height,
      laneMode,
    });
    if (lastAutoFitKeyRef.current === autoFitKey) return;

    const nextZoomX = clamp(
      chooseStorylineInitialScale({
        plotWidth: autoFitBaseLayout.plotWidth,
        plotHeight: autoFitBaseLayout.plotHeight,
        viewportWidth: plotViewport.width,
        viewportHeight: plotViewport.height,
      }),
      ZOOM_MIN,
      1
    );

    const targetLayout = Math.abs(nextZoomX - 1) < 1e-6
      ? autoFitBaseLayout
      : buildStorylineTurnConvergeLayout(runState, plotViewport.height, {
        laneMode,
        events: timelineEvents,
        yUpperBoundPx: storylineYUpperBound,
        yLowerBoundPx: storylineYBottomBound,
        yMedianTargetPx: storylineYMedianTarget,
        xZoomRatio: nextZoomX,
        viewportWidthPx: plotViewport.width,
      });
    const targetBounds = computeStorylineWorldBounds(targetLayout);
    const centeredTx = plotViewport.width / 2 - targetBounds.centerX;

    setView(clampViewX(
      { zoomX: nextZoomX, tx: centeredTx },
      { width: plotViewport.width },
      targetBounds
    ));
    lastAutoFitKeyRef.current = autoFitKey;
  }, [
    autoFitBaseLayout,
    dragState,
    laneMode,
    minimapDragState,
    plotViewport.height,
    plotViewport.width,
    runState?.run_id,
    runState,
    storylineYBottomBound,
    storylineYMedianTarget,
    storylineYUpperBound,
    timelineEvents,
    horizontalScrollbarDragState,
  ]);

  useEffect(() => {
    if (!runState || (layout.nodes.length === 0 && layout.activePlanAreas.length === 0)) return;
    setView((current) => {
      const next = clampViewX(current, { width: plotViewport.width }, transformBounds);
      const unchanged = Math.abs(next.tx - current.tx) < 0.01;
      if (unchanged) return current;
      return next;
    });
  }, [layout.activePlanAreas.length, layout.nodes.length, plotViewport.width, runState, transformBounds]);

  useEffect(() => {
    if (!turnFocusRequest || !turnFocusRequest.summaryId || layout.turns.length === 0) {
      return;
    }
    if (lastConsumedTurnFocusNonceRef.current === turnFocusRequest.nonce) {
      return;
    }
    setView((current) => {
      const next = focusViewOnStorylineSummaryTurn({
        layout,
        summaryId: turnFocusRequest.summaryId,
        currentView: current,
        viewportWidth: plotViewport.width,
      });
      if (!next) {
        return current;
      }
      lastConsumedTurnFocusNonceRef.current = turnFocusRequest.nonce;
      if (Math.abs(next.tx - current.tx) < 0.01) {
        return current;
      }
      return next;
    });
  }, [layout, plotViewport.width, turnFocusRequest]);

  useEffect(() => {
    if (!planFocusRequest || !planFocusRequest.planId || layout.activePlanAreas.length === 0) {
      return;
    }
    if (lastConsumedPlanFocusNonceRef.current === planFocusRequest.nonce) {
      return;
    }
    setView((current) => {
      const next = focusViewOnStorylinePlanArea({
        layout,
        planId: planFocusRequest.planId,
        currentView: current,
        viewportWidth: plotViewport.width,
      });
      if (!next) {
        return current;
      }
      lastConsumedPlanFocusNonceRef.current = planFocusRequest.nonce;
      if (Math.abs(next.tx - current.tx) < 0.01) {
        return current;
      }
      return next;
    });
  }, [layout, planFocusRequest, plotViewport.width]);

  useEffect(() => {
    if (!convergeFocusRequest || layout.converges.length === 0) {
      return;
    }
    if (lastConsumedConvergeFocusNonceRef.current === convergeFocusRequest.nonce) {
      return;
    }
    setView((current) => {
      const next = focusViewOnStorylineConvergeIndex({
        layout,
        convergeIndex: convergeFocusRequest.convergeIndex,
        currentView: current,
        viewportWidth: plotViewport.width,
      });
      if (!next) {
        return current;
      }
      lastConsumedConvergeFocusNonceRef.current = convergeFocusRequest.nonce;
      if (Math.abs(next.tx - current.tx) < 0.01) {
        return current;
      }
      return next;
    });
  }, [convergeFocusRequest, layout, plotViewport.width]);

  useEffect(() => {
    if (!dragState) return undefined;
    const handleMouseMove = (event: MouseEvent) => {
      const deltaX = event.clientX - dragState.startX;
      const rawTx = dragState.originTx + deltaX;
      setView((current) => clampViewX({
        ...current,
        tx: rawTx,
      }, { width: plotViewport.width }, transformBounds));
    };
    const handleMouseUp = () => setDragState(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, plotViewport.width, transformBounds]);

  useEffect(() => {
    if (
      !horizontalScrollbarDragState
      || !horizontalScrollbarTrackRef.current
      || !storylineHorizontalScrollbarMetrics.visible
    ) {
      return undefined;
    }
    const handleMouseMove = (event: MouseEvent) => {
      const trackElement = horizontalScrollbarTrackRef.current;
      if (!trackElement) {
        return;
      }
      const trackRect = trackElement.getBoundingClientRect();
      const pointerOffsetX = clamp(event.clientX - trackRect.left, 0, trackRect.width);
      const thumbOffset = pointerOffsetX - horizontalScrollbarDragState.pointerOffsetX;
      const nextScrollOffset = resolveScrollOffsetFromThumbOffset({
        thumbOffsetPx: thumbOffset,
        maxThumbOffsetPx: storylineHorizontalScrollbarMetrics.maxThumbOffsetPx,
        maxScrollOffsetPx: storylineHorizontalScrollbarMetrics.maxScrollOffsetPx,
      });
      setView((current) => clampViewX({
        ...current,
        tx: -(transformBounds.minX + nextScrollOffset),
      }, { width: plotViewport.width }, transformBounds));
    };
    const handleMouseUp = () => {
      setHorizontalScrollbarDragState(null);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    horizontalScrollbarDragState,
    plotViewport.width,
    storylineHorizontalScrollbarMetrics.maxScrollOffsetPx,
    storylineHorizontalScrollbarMetrics.maxThumbOffsetPx,
    storylineHorizontalScrollbarMetrics.visible,
    transformBounds,
  ]);

  const minimapState = useMemo<MinimapState | null>(() => {
    if (!runState || layout.nodes.length === 0) return null;
    const worldMinX = transformBounds.minX;
    const worldMaxX = transformBounds.maxX;
    const worldSpanX = Math.max(1, worldMaxX - worldMinX);
    const worldLeftRaw = 0 - view.tx;
    const worldWidth = Math.max(1, plotViewport.width);
    const clampedWorldLeft = clamp(worldLeftRaw, worldMinX, Math.max(worldMinX, worldMaxX - worldWidth));

    const width = minimapFrame.width;
    const height = minimapFrame.height;
    const left = minimapFrame.left;
    const top = minimapFrame.top;
    const innerWidth = width - MINIMAP_CARD_PADDING_PX * 2;
    const innerHeight = height - MINIMAP_CARD_PADDING_PX * 2;

    const toMiniX = (worldX: number) =>
      MINIMAP_CARD_PADDING_PX + ((worldX - worldMinX) / worldSpanX) * innerWidth;
    const focusX = toMiniX(clampedWorldLeft);
    const focusY = MINIMAP_CARD_PADDING_PX;
    const focusWidth = Math.max(
      14,
      (Math.min(worldWidth, worldSpanX) / worldSpanX) * innerWidth
    );
    const focusHeight = innerHeight;

    return {
      width,
      height,
      left,
      top,
      worldMinX,
      worldMaxX,
      worldSpanX,
      worldLeft: clampedWorldLeft,
      worldWidth: Math.min(worldWidth, worldSpanX),
      focusX,
      focusY,
      focusWidth,
      focusHeight,
    };
  }, [
    layout.nodes.length,
    minimapFrame.height,
    minimapFrame.left,
    minimapFrame.top,
    minimapFrame.width,
    plotViewport.width,
    runState,
    transformBounds.maxX,
    transformBounds.minX,
    view.tx,
  ]);

  const minimapPoints = useMemo<MinimapPoint[]>(() => {
    if (!minimapState || (layout.nodes.length === 0 && layout.activePlanAreas.length === 0)) {
      return [];
    }
    const innerWidth = minimapState.width - MINIMAP_CARD_PADDING_PX * 2;
    const innerHeight = minimapState.height - MINIMAP_CARD_PADDING_PX * 2;
    const worldMinY = transformBounds.minY;
    const worldSpanY = Math.max(1, transformBounds.maxY - transformBounds.minY);
    const atomicPoints = layout.nodes.map((node) => {
      const x = MINIMAP_CARD_PADDING_PX + ((node.x - minimapState.worldMinX) / minimapState.worldSpanX) * innerWidth;
      const y = MINIMAP_CARD_PADDING_PX + ((node.y - worldMinY) / worldSpanY) * innerHeight;
      const diameter = computeMinimapPointDiameter(node.glyphDiameter, innerHeight);
      const r = diameter / 2;
      return {
        id: node.id,
        kind: 'atomic' as const,
        summaryId: node.summaryId,
        planId: null,
        x,
        y,
        r,
        color: getNodeColor(node.insightType),
        insightType: node.insightType,
        pulse: false,
      };
    });
    const planPoints = layout.activePlanAreas.map((area) => {
      const centerX = (area.left + area.right) / 2;
      const centerY = (area.top + area.bottom) / 2;
      return {
        id: `plan:${area.planId}`,
        kind: 'plan' as const,
        summaryId: null,
        planId: area.planId,
        x: MINIMAP_CARD_PADDING_PX + ((centerX - minimapState.worldMinX) / minimapState.worldSpanX) * innerWidth,
        y: MINIMAP_CARD_PADDING_PX + ((centerY - worldMinY) / worldSpanY) * innerHeight,
        r: Math.max(2.8, Math.min(5.4, innerHeight * 0.11)),
        color: getActivePlanMinimapColor(area.status),
        pulse: area.status === 'analyzing' || area.status === 'summarizing',
      };
    });

    return [...atomicPoints, ...planPoints];
  }, [layout.activePlanAreas, layout.nodes, minimapState, transformBounds.maxY, transformBounds.minY]);

  useEffect(() => {
    if (!minimapDragState || !minimapState) return undefined;
    const innerWidth = minimapState.width - MINIMAP_CARD_PADDING_PX * 2;

    const handleMouseMove = (event: MouseEvent) => {
      const deltaX = event.clientX - minimapDragState.startClientX;
      const worldDeltaX = (deltaX / Math.max(1, innerWidth)) * minimapState.worldSpanX;
      const nextWorldLeft = clamp(
        minimapDragState.startWorldLeft + worldDeltaX,
        minimapState.worldMinX,
        Math.max(minimapState.worldMinX, minimapState.worldMaxX - minimapState.worldWidth)
      );

      setView((current) => clampViewX({
        ...current,
        tx: -nextWorldLeft,
      }, { width: plotViewport.width }, transformBounds));
    };

    const handleMouseUp = () => setMinimapDragState(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minimapDragState, minimapState, plotViewport.width, transformBounds]);

  const selectedSummaryId = isSummarySelection(selection) ? selection.id : null;
  const selectedPlanId = selection.type === 'plan' && selection.id ? selection.id : null;
  const summaryInternalsRenderMode = resolveSummaryInternalsRenderMode(view.zoomX, selectedSummaryId);
  const selectedAtomicNodeId =
    isSummarySelection(selection) && selection.id && selection.atomicId
      ? `${selection.id}::${selection.atomicId}`
      : null;
  const storylineRenderFilterState = useMemo(
    () => deriveStorylineFilterRenderState({
      layout,
      selectedCellKeySet: storylineFilterSnapshot.selectedCellKeySet,
    }),
    [layout, storylineFilterSnapshot.selectedCellKeySet]
  );
  const selectionHighlightPolicy = useMemo(
    () => deriveStorylineSelectionHighlightPolicy(storylineRenderFilterState.hasActiveFilter),
    [storylineRenderFilterState.hasActiveFilter]
  );
  const selectedGlyphNode = useMemo(
    () => (
      selectionHighlightPolicy.preserveGlyphSelection && selectedAtomicNodeId
        ? layout.nodes.find((item) => item.id === selectedAtomicNodeId) ?? null
        : null
    ),
    [layout.nodes, selectedAtomicNodeId, selectionHighlightPolicy.preserveGlyphSelection]
  );
  const selectedGlyphColumnHighlightColor = selectedGlyphNode
    ? getNodeColor(selectedGlyphNode.insightType)
    : null;
  const atomicPreviewByKey = useMemo(() => {
    const previewByKey = new Map<string, { atomic: AtomicInsight; index: number }>();
    for (const summary of runState?.insights ?? []) {
      for (let index = 0; index < (summary.atomic_insights ?? []).length; index += 1) {
        const atomic = summary.atomic_insights[index];
        const atomicId = String(atomic?.atomic_id ?? '').trim();
        if (!atomicId) {
          continue;
        }
        previewByKey.set(`${summary.insight_id}::${atomicId}`, {
          atomic,
          index: index + 1,
        });
      }
    }
    return previewByKey;
  }, [runState?.insights]);
  const summaryPreviewById = useMemo(() => {
    const previewById = new Map<string, { sourceTask: string; summaryText: string }>();
    const planTextById = new Map(
      (runState?.frontier ?? []).map((plan) => [plan.plan_id, plan.text.trim()])
    );
    for (const summary of runState?.insights ?? []) {
      previewById.set(summary.insight_id, {
        sourceTask: planTextById.get(summary.plan_id) ?? '',
        summaryText: summary.summary.trim(),
      });
    }
    return previewById;
  }, [runState?.frontier, runState?.insights]);
  useEffect(() => {
    setHoveredAtomicPreview((current) => {
      if (!current) {
        return null;
      }
      return atomicPreviewByKey.has(`${current.summaryId}::${current.atomicId}`) ? current : null;
    });
  }, [atomicPreviewByKey]);
  useEffect(() => {
    setHoveredSummaryPreview((current) => {
      if (!current) {
        return null;
      }
      return summaryPreviewById.has(current.summaryId) ? current : null;
    });
  }, [summaryPreviewById]);
  const dispatchConversationEntryIdByPlanId = useMemo(() => {
    const mapping = new Map<string, string>();
    for (let index = conversationEntries.length - 1; index >= 0; index -= 1) {
      const entry = conversationEntries[index];
      if (entry.type !== 'plans_dispatched') {
        continue;
      }
      for (const planId of entry.planIds ?? []) {
        if (!mapping.has(planId)) {
          mapping.set(planId, entry.id);
        }
      }
    }
    return mapping;
  }, [conversationEntries]);
  const createSteeringEntryIdByPlanId = useMemo(
    () => buildCreateSteeringEntryIdByPlanId(runState, timelineEvents, conversationEntries),
    [conversationEntries, runState, timelineEvents]
  );
  const createOriginPlanIds = useMemo(
    () => buildCreateOriginPlanIds(runState, timelineEvents),
    [runState, timelineEvents]
  );
  const createOriginSummaryIds = useMemo(
    () => buildCreateOriginSummaryIds(runState, createOriginPlanIds),
    [createOriginPlanIds, runState]
  );
  const convergeSummaryButtons = useMemo<StorylineConvergeSummaryButton[]>(
    () => buildConvergeSummaryButtons(conversationEntries).filter(
      (button) => button.convergeIndex >= 0 && button.convergeIndex < layout.converges.length
    ),
    [conversationEntries, layout.converges.length]
  );
  const stagedColumnPenColumns = useMemo(
    () => new Set(pendingColumnPenSelection?.columns ?? []),
    [pendingColumnPenSelection]
  );
  const convergeLaneModeByKey = useMemo(() => {
    const modeByKey = new Map<string, StorylineConvergeLaneMode>();
    for (const converge of layout.converges) {
      for (const lane of converge.lanes) {
        modeByKey.set(`${converge.index}::${lane.column}`, lane.mode);
      }
    }
    return modeByKey;
  }, [layout.converges]);
  const usesInvolvedConvergeVisual = (mode: StorylineConvergeLaneMode | undefined): boolean =>
    mode === 'both';
  const hoveredColumn = hoveredTrack?.column ?? null;
  const resolveConvergeColumnEmphasis = (
    column: string,
    mode: StorylineConvergeLaneMode | undefined
  ): StorylineColumnEmphasisState =>
    resolveStorylineColumnEmphasisState({
      hoveredColumn,
      emphasizedColumns: stagedColumnPenColumns,
      column,
      canFade: usesInvolvedConvergeVisual(mode),
    });
  const resolveSummaryColumnEmphasis = (column: string): StorylineColumnEmphasisState =>
    resolveStorylineColumnEmphasisState({
      hoveredColumn,
      emphasizedColumns: stagedColumnPenColumns,
      column,
      canFade: true,
    });
  const selectedSummaryArea = useMemo(
    () => (
      selectionHighlightPolicy.preserveSummaryAreaSelection && selectedSummaryId
        ? layout.summaryAreas.find((area) => area.summaryId === selectedSummaryId) ?? null
        : null
    ),
    [layout.summaryAreas, selectedSummaryId, selectionHighlightPolicy.preserveSummaryAreaSelection]
  );
  const selectedSummaryConnectivity = useMemo<SelectedSummaryConnectivityHighlight>(
    () => (
      !selectionHighlightPolicy.preserveSummaryConnectivityLines
        ? createEmptySelectedSummaryConnectivityHighlight()
        : computeSelectedSummaryConnectivityHighlight({ layout, selectedSummaryId })
    ),
    [layout, selectedSummaryId, selectionHighlightPolicy.preserveSummaryConnectivityLines]
  );
  const selectedSummarySharedColumnIds = useMemo(
    () => (
      !selectionHighlightPolicy.preserveSummaryConnectivityLines
        ? new Set<string>()
        : computeSelectedSummarySharedColumnSummaryIds({ layout, selectedSummaryId })
    ),
    [layout, selectedSummaryId, selectionHighlightPolicy.preserveSummaryConnectivityLines]
  );
  const selectedSummaryExtensionPromotion = useMemo<SelectedSummaryExtensionPromotionHighlight>(
    () => (
      !selectionHighlightPolicy.preserveSummaryConnectivityLines
        ? createEmptySelectedSummaryExtensionPromotionHighlight()
        : computeSelectedSummaryExtensionPromotionHighlight({
          layout,
          connectivity: selectedSummaryConnectivity,
        })
    ),
    [layout, selectedSummaryConnectivity, selectionHighlightPolicy.preserveSummaryConnectivityLines]
  );
  const selectedSummaryConnectivityActive =
    selectionHighlightPolicy.preserveSummaryConnectivityLines
    && selectedSummaryId !== null
    && selectedSummaryConnectivity.summaryIds.size > 0;
  const convergeIndicatorVisualStateByKey = useMemo(() => {
    const states = new Map<string, ConvergeIndicatorVisualState>();
    for (const converge of layout.converges) {
      for (const lane of converge.lanes) {
        const laneKey = buildSummaryConnectivityConvergeLaneKey(converge.index, lane.column);
        const columnFilterState = storylineFilterSnapshot.columnStates.get(lane.column) ?? 'none';
        const lineFilterState = resolveStorylineColumnFilterLineState({
          hasActiveFilter: storylineRenderFilterState.hasActiveFilter,
          columnFilterState,
          isExactKept:
            !storylineRenderFilterState.hasActiveFilter
            || storylineRenderFilterState.keptConvergeLaneKeys.has(laneKey),
        });
        const emphasis = resolveConvergeColumnEmphasis(lane.column, lane.mode);
        const isHovered = emphasis === 'hovered';
        const isConnectivityConnected = selectedSummaryConnectivity.convergeLaneKeys.has(laneKey);
        const forceExtensionVisual =
          !isHovered
          && selectedSummaryConnectivityActive
          && !isConnectivityConnected
          && usesInvolvedConvergeVisual(lane.mode);
        const useDimmedVisual =
          emphasis === 'faded' || forceExtensionVisual || !lineFilterState.isKept;
        const filterHighlighted = storylineRenderFilterState.hasActiveFilter && lineFilterState.isKept;
        states.set(`${converge.index}::${lane.column}`, {
          mode: lane.mode,
          filterHighlighted,
          forceUninvolvedTextColor: useDimmedVisual && !filterHighlighted,
          maskTone: resolveConvergeIndicatorMaskTone(),
          textOpacity:
            !storylineRenderFilterState.hasActiveFilter || columnFilterState !== 'none'
              ? 1
              : FILTERED_INDICATOR_TEXT_OPACITY,
          connectorOpacity:
            !storylineRenderFilterState.hasActiveFilter || columnFilterState !== 'none'
              ? 1
              : FILTERED_INDICATOR_TEXT_OPACITY,
          anchor: lane.endpointMarkers.length > 0 ? 'marker' : 'converge',
        });
      }
    }
    return states;
  }, [
    layout.converges,
    resolveConvergeColumnEmphasis,
    selectedSummaryConnectivity.convergeLaneKeys,
    selectedSummaryConnectivityActive,
    storylineFilterSnapshot.columnStates,
    storylineRenderFilterState.hasActiveFilter,
    storylineRenderFilterState.keptConvergeLaneKeys,
    usesInvolvedConvergeVisual,
  ]);
  const resolveConvergeLabelTextColor = (labelId: string, hovered: boolean): string => {
    const parsed = parseConvergeLabelId(labelId);
    if (!parsed) return '#111827';
    const key = `${parsed.convergeIndex}::${parsed.column}`;
    const state = convergeIndicatorVisualStateByKey.get(key);
    return resolveConvergeIndicatorTextColor({
      mode: state?.mode ?? convergeLaneModeByKey.get(key),
      hovered,
      filterHighlighted: state?.filterHighlighted,
      forceUninvolved: state?.forceUninvolvedTextColor,
    });
  };
  const resolveConvergeLabelVisualState = (labelId: string): ConvergeIndicatorVisualState | null => {
    const parsed = parseConvergeLabelId(labelId);
    if (!parsed) return null;
    return convergeIndicatorVisualStateByKey.get(`${parsed.convergeIndex}::${parsed.column}`) ?? null;
  };
  const selectedGlyphConnection = useMemo<SelectedGlyphConnectionHighlight>(
    () => (
      selectionHighlightPolicy.preserveGlyphDirectConnections && selectedSummaryArea && selectedAtomicNodeId
        ? computeSelectedGlyphConnectedTrackSegments({
          nodes: selectedSummaryArea.nodes,
          tracks: selectedSummaryArea.tracks,
          selectedNodeId: selectedAtomicNodeId,
        })
        : createEmptySelectedGlyphConnectionHighlight()
    ),
    [selectedAtomicNodeId, selectedSummaryArea, selectionHighlightPolicy.preserveGlyphDirectConnections]
  );
  const selectedGlyphBranchHighlightIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedSummaryArea || !selectedAtomicNodeId) return ids;
    for (const branch of layout.boundaryBranches) {
      if (branch.summaryId !== selectedSummaryArea.summaryId) continue;
      if (branch.side === 'left' && selectedGlyphConnection.reachLeftBoundaryColumns.has(branch.column)) {
        ids.add(branch.id);
      }
      if (branch.side === 'right' && selectedGlyphConnection.reachRightBoundaryColumns.has(branch.column)) {
        ids.add(branch.id);
      }
    }
    return ids;
  }, [
    layout.boundaryBranches,
    selectedAtomicNodeId,
    selectedGlyphConnection,
    selectedSummaryArea?.summaryId,
  ]);
  const fullyVisibleConvergeIndexes = useMemo(
    () => collectFullyVisibleConvergeIndexes(layout.converges, view.tx, viewport.width),
    [layout.converges, view.tx, viewport.width]
  );
  const indicatorTracks = useMemo<StorylineColumnTrack[]>(() => {
    if (!shouldRenderColumnIndicators(view.zoomX)) return [];
    const convergeTracks = buildConvergeIndicatorTracks(layout, fullyVisibleConvergeIndexes);
    return convergeTracks;
  }, [
    fullyVisibleConvergeIndexes,
    layout,
    view.zoomX,
  ]);
  const indicatorLabelSizing = useMemo(
    () => ({
      labelScale: layout.adaptiveProfile.labelScale * CONVERGE_INDICATOR_LABEL_SCALE_MULTIPLIER,
    }),
    [layout.adaptiveProfile.labelScale]
  );
  const visibleTrackLabels = useMemo(() => {
    if (indicatorTracks.length === 0) return [];
    return buildVisibleTrackLabels(
      indicatorTracks,
      layout.nodes,
      { zoomX: view.zoomX, tx: view.tx, ty: plotTopOffset + layoutVerticalOffset },
      {
        width: viewport.width,
        height: viewport.height,
        left: 0,
        right: viewport.width,
        top: plotTopOffset,
        bottom: Math.min(viewport.height, plotTopOffset + plotViewport.height),
      },
      indicatorLabelSizing
    );
  }, [
    indicatorLabelSizing,
    indicatorTracks,
    layout.nodes,
    layoutVerticalOffset,
    plotTopOffset,
    view.tx,
    view.zoomX,
    viewport.height,
    viewport.width,
  ]);
  const isStorylineFilterActive = storylineRenderFilterState.hasActiveFilter;
  const getColumnFilterState = (column: string): StorylineFilterTriState =>
    storylineFilterSnapshot.columnStates.get(column) ?? 'none';
  const isNodeKeptByFilter = (nodeId: string): boolean =>
    !isStorylineFilterActive || storylineRenderFilterState.matchedNodeIds.has(nodeId);
  const isSummaryKeptByFilter = (summaryId: string): boolean =>
    !isStorylineFilterActive || storylineRenderFilterState.matchedSummaryIds.has(summaryId);
  const isTrackSegmentKeptByFilter = (segmentKey: string): boolean =>
    !isStorylineFilterActive || storylineRenderFilterState.keptTrackSegmentKeys.has(segmentKey);
  const isBranchKeptByFilter = (branchId: string): boolean =>
    !isStorylineFilterActive || storylineRenderFilterState.keptBranchIds.has(branchId);
  const isConvergeLaneKeptByFilter = (laneKey: string): boolean =>
    !isStorylineFilterActive || storylineRenderFilterState.keptConvergeLaneKeys.has(laneKey);

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (!svgRef.current || !runState) return;
    const rect = svgRef.current.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;

    setView((current) => {
      const zoomFactor = Math.exp(-event.deltaY * ZOOM_WHEEL_SPEED);
      const nextZoomX = clamp(current.zoomX * zoomFactor, ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(nextZoomX - current.zoomX) < 1e-6) return current;

      const currentSpanX = Math.max(1, transformBounds.maxX - transformBounds.minX);
      const worldX = pointerX - current.tx;
      const anchorRatio = clamp((worldX - transformBounds.minX) / currentSpanX, 0, 1);

      const nextLayout = buildStorylineTurnConvergeLayout(runState, plotViewport.height, {
        laneMode,
        events: timelineEvents,
        yUpperBoundPx: storylineYUpperBound,
        yLowerBoundPx: storylineYBottomBound,
        yMedianTargetPx: storylineYMedianTarget,
        xZoomRatio: nextZoomX,
        viewportWidthPx: plotViewport.width,
      });
      const nextBounds = computeStorylineWorldBounds(nextLayout);
      const nextSpanX = Math.max(1, nextBounds.maxX - nextBounds.minX);
      const anchoredWorldX = nextBounds.minX + anchorRatio * nextSpanX;
      const nextTxRaw = pointerX - anchoredWorldX;
      return clampViewX(
        {
          zoomX: nextZoomX,
          tx: nextTxRaw,
        },
        { width: plotViewport.width },
        nextBounds
      );
    });
  };

  const beginCanvasDrag = (event: ReactMouseEvent<Element>) => {
    setDragState({
      startX: event.clientX,
      originTx: view.tx,
    });
  };

  const handleCanvasMouseDown = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    storylineCanvasPointerDownRef.current = null;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-storyline-interactive="true"]')) {
      return;
    }
    storylineCanvasPointerDownRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    event.preventDefault();
    beginCanvasDrag(event);
  };

  const handleCanvasClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      storylineCanvasPointerDownRef.current = null;
      return;
    }
    if (target.closest('[data-storyline-interactive="true"]')) {
      storylineCanvasPointerDownRef.current = null;
      return;
    }
    const isClick = isStorylineCanvasClickGesture({
      pointerDown: storylineCanvasPointerDownRef.current,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    storylineCanvasPointerDownRef.current = null;
    if (!isClick) {
      return;
    }
    setSelection({ type: null, id: null });
  };

  const updateHoveredTrack = (column: string, clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setHoveredTrack({
      column,
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  };

  const handleStorylineColumnPointerDown = (
    column: string,
    source: StorylineColumnInteractionSource,
    event: ReactMouseEvent<SVGElement>,
    convergeIndex?: number
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    storylineLinePointerDownRef.current = {
      column,
      source,
      convergeIndex,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (!activeSteeringPen) {
      beginCanvasDrag(event);
    }
  };

  const getExclusiveColumnToggleSource = (
    source: StorylineColumnInteractionSource
  ): 'converge' | 'non_converge' =>
    source === 'converge_lane' || source === 'converge_marker' || source === 'converge_indicator'
      ? 'converge'
      : 'non_converge';

  const handleStorylineColumnClick = (
    column: string,
    source: StorylineColumnInteractionSource,
    event: ReactMouseEvent<SVGElement>,
    convergeIndex?: number
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const shouldToggle = isStorylineColumnClickGesture({
      pointerDown: storylineLinePointerDownRef.current,
      column,
      source,
      convergeIndex,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if (event.detail !== 1) {
      return;
    }
    storylineLinePointerDownRef.current = null;
    if (!shouldToggle) {
      return;
    }
    if (activeSteeringPen) {
      if (!runState || activeSteeringPen === 'elaborate') {
        return;
      }
      if (!containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const popoverX = event.clientX - rect.left;
      const popoverY = event.clientY - rect.top;
      const nextSelection = togglePendingColumnPenSelection({
        current: pendingColumnPenSelection,
        penKind: activeSteeringPen,
        column,
        convergeIndex,
        x: popoverX,
        y: popoverY,
      });
      if (!nextSelection) {
        setPendingColumnPenSelection(null);
        setSteeringPopover((current) => (
          current?.target.kind === 'column' ? null : current
        ));
        return;
      }
      const target = buildColumnTarget({
        runState,
        columns: nextSelection.columns,
        columnAnchors: nextSelection.columnAnchors,
      });
      if (!target) {
        return;
      }
      setPendingColumnPenSelection(nextSelection);
      setCreatePopoverDragState(null);
      setCreatePopover(null);
      setSteeringPopover((current) => {
        const reuseCurrent =
          !!current
          && current.kind === activeSteeringPen
          && current.target.kind === 'column';
        const generatedPreviewBase = buildDefaultSteeringPreviewBase(
          activeSteeringPen,
          target,
          [],
          runState
        );
        const userPromptSuffix = reuseCurrent ? current.userPromptSuffix : '';
        return {
          kind: activeSteeringPen,
          target,
          x: reuseCurrent ? current.x : nextSelection.x,
          y: reuseCurrent ? current.y : nextSelection.y,
          selectedKeywords: [],
          generatedPreviewBase,
          userPromptSuffix,
          userPromptDraft: composeSteeringPreviewDraft(generatedPreviewBase, userPromptSuffix),
          backgroundText: '',
          includeBackground: true,
          error: null,
        };
      });
      return;
    }
    const clickMode = resolveStorylineColumnClickMode({
      platform: modifierPlatform,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    if (clickMode === 'group_toggle') {
      storylineFilterActions.toggleStorylineColumn(column);
    } else {
      storylineFilterActions.toggleExclusiveStorylineColumn(
        column,
        getExclusiveColumnToggleSource(source)
      );
    }
  };

  const handleMinimapBackgroundMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!minimapState || event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = clamp(event.clientX - bounds.left, MINIMAP_CARD_PADDING_PX, bounds.width - MINIMAP_CARD_PADDING_PX);
    const innerWidth = minimapState.width - MINIMAP_CARD_PADDING_PX * 2;
    const ratio = clamp((localX - MINIMAP_CARD_PADDING_PX) / Math.max(1, innerWidth), 0, 1);
    const centerWorldX = minimapState.worldMinX + ratio * minimapState.worldSpanX;
    const nextWorldLeft = clamp(
      centerWorldX - minimapState.worldWidth / 2,
      minimapState.worldMinX,
      Math.max(minimapState.worldMinX, minimapState.worldMaxX - minimapState.worldWidth)
    );

    setView((current) => clampViewX({
      ...current,
      tx: -nextWorldLeft,
    }, { width: plotViewport.width }, transformBounds));

    setMinimapDragState({
      startClientX: event.clientX,
      startWorldLeft: nextWorldLeft,
    });
  };

  const handleMinimapFocusMouseDown = (event: ReactMouseEvent<SVGRectElement>) => {
    if (!minimapState || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setMinimapDragState({
      startClientX: event.clientX,
      startWorldLeft: minimapState.worldLeft,
    });
  };

  const isEmptyStoryline =
    !runState || (layout.nodes.length === 0 && layout.activePlanAreas.length === 0);
  const minimapInnerHeight = minimapState ? minimapState.height - MINIMAP_CARD_PADDING_PX * 2 : 0;
  const handleCanvasMouseLeave = () => {
    storylineLinePointerDownRef.current = null;
    storylineCanvasPointerDownRef.current = null;
    setHoveredTrack(null);
    setHoveredAtomicPreview(null);
    setHoveredSummaryPreview(null);
    setHoveredPlanPreview(null);
  };

  const handleLeaveColumn = (column: string) => {
    setHoveredTrack((current) => (current?.column === column ? null : current));
  };

  const handleHoverSummaryTarget = (
    summaryId: string,
    clientX: number,
    clientY: number
  ) => {
    if (!containerRef.current) {
      return;
    }
    const preview = summaryPreviewById.get(summaryId);
    if (!preview) {
      setHoveredSummaryPreview(null);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setHoveredSummaryPreview({
      summaryId,
      sourceTask: preview.sourceTask,
      summaryText: preview.summaryText,
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  };

  const handleLeaveSummaryTarget = (summaryId: string) => {
    setHoveredSummaryPreview((current) => (current?.summaryId === summaryId ? null : current));
  };

  const updateHoveredAtomicPreview = (
    summaryId: string,
    atomicId: string,
    clientX: number,
    clientY: number
  ) => {
    setHoveredSummaryPreview(null);
    if (!containerRef.current) {
      return;
    }
    const preview = atomicPreviewByKey.get(`${summaryId}::${atomicId}`);
    if (!preview) {
      setHoveredAtomicPreview(null);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setHoveredAtomicPreview({
      summaryId,
      atomicId,
      atomic: preview.atomic,
      index: preview.index,
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  };

  const handleLeaveAtomicPreview = (summaryId: string, atomicId: string) => {
    setHoveredAtomicPreview((current) => (
      current?.summaryId === summaryId && current?.atomicId === atomicId
        ? null
        : current
    ));
  };

  const handleHoverActivePlanArea = (
    planId: string,
    status: PlanItem['status'],
    text: string,
    clientX: number,
    clientY: number
  ) => {
    if (activeSteeringPen || view.zoomX >= 0.5 || !containerRef.current) {
      setHoveredPlanPreview(null);
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setHoveredPlanPreview({
      planId,
      status,
      text: text.trim(),
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  };

  const handleLeaveActivePlanArea = (planId: string) => {
    setHoveredPlanPreview((current) => (current?.planId === planId ? null : current));
  };

  const applyPlanToRunState = (
    targetRunId: string,
    nextPlan: PlanItem,
    nextRunStatus?: RunState['status']
  ) => {
    useStore.setState((state) => {
      if (!state.runState || state.runState.run_id !== targetRunId) {
        return {};
      }
      const replacePlan = (plans: PlanItem[] | undefined): PlanItem[] | undefined => {
        if (!Array.isArray(plans)) {
          return plans;
        }
        return plans.map((plan) => (plan.plan_id === nextPlan.plan_id ? nextPlan : plan));
      };
      return {
        runState: {
          ...state.runState,
          status: nextRunStatus ?? state.runState.status,
          frontier: replacePlan(state.runState.frontier) ?? state.runState.frontier,
          plans: replacePlan(state.runState.plans),
        },
      };
    });
  };

  const focusConversationEntryForPlan = (planId: string) => {
    const conversationEntryId = resolvePreferredConversationEntryForPlan({
      planId,
      createSteeringEntryIdByPlanId,
      dispatchConversationEntryIdByPlanId,
    });
    if (conversationEntryId) {
      onConversationEntryFocusRequest?.(conversationEntryId);
    }
  };

  const handleConvergeSummaryButtonClick = (conversationEntryId: string) => {
    setSelection(resolveSelectionAfterConvergeSummaryButtonClick());
    onSummaryEntryFocusRequest?.(conversationEntryId);
  };

  const handleActivePlanSelect = (planId: string) => {
    const nextSelection = resolveStorylinePlanSelectionAfterFilterClear({
      selection,
      planId,
      hasActiveFilter: storylineFilterSnapshot.hasActiveFilter,
    });
    if (storylineFilterSnapshot.hasActiveFilter) {
      storylineFilterActions.clearAll();
    }
    setSelection(nextSelection);
    if (nextSelection.type === 'plan' && nextSelection.id === planId) {
      focusConversationEntryForPlan(planId);
    }
  };

  const handlePlanModifyStart = (planId: string) => {
    if (!runState || (editingPlanState && editingPlanState.planId !== planId)) {
      return;
    }
    const plan = runState.frontier.find((item) => item.plan_id === planId);
    if (
      !plan
      || (
        plan.status !== 'pending'
        && plan.status !== 'paused'
        && plan.status !== 'analyzing'
        && plan.status !== 'summarizing'
      )
    ) {
      return;
    }
    setEditingPlanState({
      planId,
      draft: plan.text ?? '',
    });
  };

  const handlePlanModifyDraftChange = (draft: string) => {
    setEditingPlanState((current) => (
      current
        ? {
          ...current,
          draft,
        }
        : current
    ));
  };

  const handlePlanModifyCancel = () => {
    if (!editingPlanState) {
      setEditingPlanState(null);
      return;
    }
    setEditingPlanState(null);
  };

  const handlePlanModifySubmit = async (planId: string) => {
    if (!runState || editingPlanState?.planId !== planId) {
      return;
    }
    const nextText = editingPlanState.draft.trim();
    if (!nextText) {
      return;
    }
    const currentPlan =
      useStore.getState().runState?.frontier.find((plan) => plan.plan_id === planId)
      ?? runState.frontier.find((plan) => plan.plan_id === planId);
    if (
      !currentPlan
      || (
        currentPlan.status !== 'pending'
        && currentPlan.status !== 'paused'
        && currentPlan.status !== 'analyzing'
        && currentPlan.status !== 'summarizing'
      )
    ) {
      setEditingPlanState(null);
      return;
    }
    setPlanControlPendingById((current) => ({ ...current, [planId]: 'modify' }));
    try {
      const response = await controlPlan(runState.run_id, planId, 'modify', {
        userAuthoredText: nextText,
      });
      setEditingPlanState(null);
      if (response.plan) {
        applyPlanToRunState(runState.run_id, response.plan, response.run_status);
      } else if (response.run_state) {
        setRunState(response.run_state);
      }
    } catch (error) {
      console.error('Failed to modify plan:', error);
    } finally {
      setPlanControlPendingById((current) => {
        const next = { ...current };
        delete next[planId];
        return next;
      });
    }
  };

  const handlePlanControl = async (planId: string, action: PlanControlAction) => {
    if (!runState) {
      return;
    }
    const currentPlan =
      useStore.getState().runState?.frontier.find((plan) => plan.plan_id === planId)
      ?? runState.frontier.find((plan) => plan.plan_id === planId);
    if (!currentPlan) {
      return;
    }
    setPlanControlPendingById((current) => ({ ...current, [planId]: action }));
    try {
      const response = await controlPlan(runState.run_id, planId, action);
      if (response.plan) {
        applyPlanToRunState(runState.run_id, response.plan, response.run_status);
      } else if (response.run_state) {
        setRunState(response.run_state);
      }
    } catch (error) {
      console.error('Failed to control plan:', error);
    } finally {
      setPlanControlPendingById((current) => {
        const next = { ...current };
        delete next[planId];
        return next;
      });
    }
  };

  const activateLocalStorylineTarget = (target: SteeringTargetSnapshot) => {
    activateStorylineTarget({
      target,
      selection,
      setSelection,
      storylineFilterSnapshot,
      storylineFilterActions,
    });
  };

  const resolveTargetKeywordOptions = (target: SteeringTargetSnapshot): string[] => {
    if (!runState || target.kind === 'column') {
      return [];
    }
    if (target.kind === 'atomic') {
      return normalizeKeywordOptions(
        runState.insights
          .find((summary) => summary.insight_id === target.summary_id)
          ?.atomic_insights.find((atomic) => atomic.atomic_id === target.atomic_id)
          ?.keywords
      );
    }
    return normalizeKeywordOptions(
      runState.insights.find((summary) => summary.insight_id === target.summary_id)?.keywords
    );
  };

  const submitSteeringRequest = async (request: Parameters<typeof steerRun>[1]) => {
    if (!runState) {
      return;
    }
    setIsSubmittingSteeringAction(true);
    try {
      const response = await steerRun(runState.run_id, request);
      upsertUserMessage(response.message);
    } catch (error) {
      throw error;
    } finally {
      setIsSubmittingSteeringAction(false);
    }
  };

  const openSteeringPopover = (
    kind: StorylineSteeringPopoverState['kind'],
    target: SteeringTargetSnapshot,
    event: ReactMouseEvent<Element>
  ): boolean => {
    if (!containerRef.current) {
      return false;
    }
    const rect = containerRef.current.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    setPendingColumnPenSelection(null);
    setSteeringPopoverDragState(null);
    setCreatePopoverDragState(null);
    setCreatePopover(null);
    setSteeringPopover(
      createStorylineSteeringPopoverState({
        kind,
        target,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        runState,
      })
    );
    return true;
  };

  const handleSteeringPopoverDragStart = (
    event: ReactMouseEvent<HTMLDivElement>,
    position: { left: number; top: number }
  ) => {
    if (!containerRef.current) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setSteeringPopoverDragState({
      pointerOffsetX: event.clientX - rect.left - position.left,
      pointerOffsetY: event.clientY - rect.top - position.top,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const handleCreatePopoverDragStart = (
    event: ReactMouseEvent<HTMLDivElement>,
    position: { left: number; top: number }
  ) => {
    if (!containerRef.current) {
      return;
    }
    const eventTarget = event.target;
    if (
      event.button !== 0
      || (
        eventTarget instanceof Element
        && eventTarget.closest('button, input, textarea, select, label')
      )
    ) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setCreatePopoverDragState({
      pointerOffsetX: event.clientX - rect.left - position.left,
      pointerOffsetY: event.clientY - rect.top - position.top,
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeywordToggle = (keyword: string) => {
    setSteeringPopover((current) => {
      if (!current) {
        return current;
      }
      const nextSelectedKeywords = current.selectedKeywords.includes(keyword)
        ? current.selectedKeywords.filter((item) => item !== keyword)
        : normalizeKeywordOptions([...current.selectedKeywords, keyword]);
      const nextGeneratedPreviewBase = buildDefaultSteeringPreviewBase(
        current.kind,
        current.target,
        nextSelectedKeywords,
        runState
      );
      return {
        ...current,
        selectedKeywords: nextSelectedKeywords,
        generatedPreviewBase: nextGeneratedPreviewBase,
        userPromptDraft: composeSteeringPreviewDraft(
          nextGeneratedPreviewBase,
          current.userPromptSuffix
        ),
        error: null,
      };
    });
  };

  const handleSteeringPreviewChange = (userPromptDraft: string) => {
    const normalizedPreview = normalizeEditableSteeringPreview(userPromptDraft);
    setSteeringPopover((current) => (
      current
        ? {
          ...current,
          userPromptDraft: normalizedPreview,
          userPromptSuffix:
            normalizedPreview.length === 0
              ? ''
              : (deriveSteeringPreviewSuffix(normalizedPreview, current.generatedPreviewBase)
                ?? current.userPromptSuffix),
          error: null,
        }
        : current
    ));
  };

  const handleSteeringIncludeBackgroundChange = (includeBackground: boolean) => {
    setSteeringPopover((current) => (
      current
        ? {
          ...current,
          includeBackground,
          error: null,
        }
        : current
    ));
  };

  const handleSteeringPopoverCancel = () => {
    setPendingColumnPenSelection(null);
    setSteeringPopoverDragState(null);
    setSteeringPopover(null);
  };

  const handleSteeringPopoverSubmit = async () => {
    if (!runState || !steeringPopover) {
      return;
    }
    let request: Parameters<typeof steerRun>[1];
    if (
      steeringPopover.kind !== 'elaborate'
      && steeringPopover.target.kind !== 'column'
    ) {
      const selectedKeywords = normalizeKeywordOptions(steeringPopover.selectedKeywords);
      if (selectedKeywords.length === 0) {
        setSteeringPopover((current) => (
          current
            ? {
              ...current,
              error: 'Choose at least one keyword.',
            }
            : current
        ));
        return;
      }
      if (!steeringPopover.userPromptDraft.trim()) {
        setSteeringPopover((current) => (
          current
            ? {
              ...current,
              error: 'Preview cannot be empty.',
            }
            : current
        ));
        return;
      }
      request = steeringPopover.kind === 'focus'
        ? createFocusSteerRequest(runState, steeringPopover.target, {
            selectedKeywords,
            userPromptPreview: steeringPopover.userPromptDraft,
            backgroundText: steeringPopover.backgroundText,
            includeBackground: steeringPopover.includeBackground,
          })
        : createIgnoreSteerRequest(runState, steeringPopover.target, {
            selectedKeywords,
            userPromptPreview: steeringPopover.userPromptDraft,
            backgroundText: steeringPopover.backgroundText,
            includeBackground: steeringPopover.includeBackground,
          });
    } else if (steeringPopover.kind === 'elaborate') {
      if (!steeringPopover.userPromptDraft.trim()) {
        setSteeringPopover((current) => (
          current
            ? {
              ...current,
              error: 'Preview cannot be empty.',
            }
            : current
        ));
        return;
      }
      request = createElaborateSteerRequest(steeringPopover.target, {
        userPromptPreview: steeringPopover.userPromptDraft,
        runState,
      });
    } else {
      if (!steeringPopover.userPromptDraft.trim()) {
        setSteeringPopover((current) => (
          current
            ? {
              ...current,
              error: 'Preview cannot be empty.',
            }
            : current
        ));
        return;
      }
      request = steeringPopover.kind === 'focus'
        ? createFocusSteerRequest(runState, steeringPopover.target, {
            userPromptPreview: steeringPopover.userPromptDraft,
          })
        : createIgnoreSteerRequest(runState, steeringPopover.target, {
            userPromptPreview: steeringPopover.userPromptDraft,
          });
    }
    try {
      await submitSteeringRequest(request);
      onActiveSteeringPenChange?.(resolveActiveSteeringPenAfterSuccessfulSubmit(activeSteeringPen));
      clearPenTransientState();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit steering action';
      setSteeringPopover((current) => (
        current
          ? {
            ...current,
            error: message,
          }
          : current
      ));
    }
  };

  const handleSummarySelect = (summaryId: string, event: ReactMouseEvent<Element>) => {
    if (!runState) {
      return;
    }
    const target = findSummaryTarget(runState, summaryId);
    if (!target) {
      return;
    }
    const clickBehavior = resolveStorylinePenClickBehavior(activeSteeringPen, target);
    if (clickBehavior === 'activate_and_steer' && activeSteeringPen) {
      preserveSteeringPopoverOnNextSelectionChangeRef.current =
        shouldPreserveSteeringPopoverOnNextSelectionChange(clickBehavior);
      activateLocalStorylineTarget(target);
      if (!openSteeringPopover(activeSteeringPen, target, event)) {
        preserveSteeringPopoverOnNextSelectionChangeRef.current = false;
      }
      return;
    }
    if (clickBehavior === 'steer_only') {
      return;
    }
    activateLocalStorylineTarget(target);
  };

  const handleAtomicSelect = (
    summaryId: string,
    atomicId: string,
    event: ReactMouseEvent<Element>
  ) => {
    if (!runState) {
      return;
    }
    const target = findAtomicTarget(runState, summaryId, atomicId);
    if (!target) {
      return;
    }
    const clickBehavior = resolveStorylinePenClickBehavior(activeSteeringPen, target);
    if (clickBehavior === 'activate_and_steer' && activeSteeringPen) {
      preserveSteeringPopoverOnNextSelectionChangeRef.current =
        shouldPreserveSteeringPopoverOnNextSelectionChange(clickBehavior);
      activateLocalStorylineTarget(target);
      if (!openSteeringPopover(activeSteeringPen, target, event)) {
        preserveSteeringPopoverOnNextSelectionChangeRef.current = false;
      }
      return;
    }
    if (clickBehavior === 'steer_only') {
      return;
    }
    activateLocalStorylineTarget(target);
  };

  const openCreatePopover = (event: ReactMouseEvent<HTMLElement>) => {
    if (!containerRef.current || !runState) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    setSteeringPopover(null);
    setSteeringPopoverDragState(null);
    setCreatePopoverDragState(null);
    setCreateError(null);
    setCreatePopover({
      draft: '',
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handleColumnContextMenu = (
    _column: string,
    _source: StorylineColumnInteractionSource,
    event: ReactMouseEvent<SVGElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleBackgroundContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const eventTarget = event.target;
    if (!(eventTarget instanceof Element)) {
      return;
    }
    if (eventTarget.closest('[data-storyline-interactive="true"]')) {
      return;
    }
    openCreatePopover(event);
  };

  const handleCreateDraftChange = (draft: string) => {
    setCreateError(null);
    setCreatePopover((current) => (
      current
        ? {
          ...current,
          draft,
        }
        : current
    ));
  };

  const handleCreateSubmit = async () => {
    if (!runState || !createPopover) {
      return;
    }
    const draft = createPopover.draft.trim();
    if (!draft) {
      setCreateError('Plan text is required.');
      return;
    }
    setIsSubmittingCreate(true);
    setCreateError(null);
    try {
      const response = await steerRun(runState.run_id, {
        content: draft,
        kind: 'create',
        display_text: draft,
        target: null,
      });
      upsertUserMessage(response.message);
      setCreatePopoverDragState(null);
      setCreatePopover(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to create plan');
    } finally {
      setIsSubmittingCreate(false);
    }
  };

  const handleCreateTextareaKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (!isCreatePopoverSubmitKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) {
      return;
    }
    event.preventDefault();
    void handleCreateSubmit();
  };

  const keywordOptions = steeringPopover
    ? resolveTargetKeywordOptions(steeringPopover.target)
    : [];
  const steeringPreviewPlaceholder = getSteeringPreviewPlaceholder(
    resolveSteeringPreviewLanguage(runState)
  );
  const isKeywordSelectionRequired = Boolean(
    steeringPopover
    && steeringPopover.kind !== 'elaborate'
    && steeringPopover.target.kind !== 'column'
  );
  const isSteeringConfirmDisabled = isKeywordSelectionRequired
    && normalizeKeywordOptions(steeringPopover?.selectedKeywords).length === 0;
  const createPopoverLayout = createPopover
    ? resolveStorylineCreatePopoverPosition({
        popover: createPopover,
        viewport,
      })
    : null;

  return (
    <div className="relative h-full w-full">
      <StorylineGraphScene
        containerRef={containerRef}
        svgRef={svgRef}
        plotClipId={plotClipId}
        viewport={viewport}
        view={view}
        layout={layout}
        plotTopOffset={plotTopOffset}
        layoutVerticalOffset={layoutVerticalOffset}
        isDragging={isDragging}
        isEmptyStoryline={isEmptyStoryline}
        activeSteeringPen={activeSteeringPen}
        hoveredColumn={hoveredColumn}
        hoveredTrack={hoveredTrack}
        hoveredAtomicPreview={
          runState && hoveredAtomicPreview
            ? {
              runId: runState.run_id,
              atomic: hoveredAtomicPreview.atomic,
              index: hoveredAtomicPreview.index,
              x: hoveredAtomicPreview.x,
              y: hoveredAtomicPreview.y,
            }
            : null
        }
        hoveredSummaryPreview={hoveredSummaryPreview}
        hoveredPlanPreview={hoveredPlanPreview}
        taxonomyLegendItems={taxonomyLegendItems}
        visibleTrackLabels={visibleTrackLabels}
        summaryInternalsRenderMode={summaryInternalsRenderMode}
        storylineFilterSnapshot={storylineFilterSnapshot}
        selectionHighlightPolicy={selectionHighlightPolicy}
        selectedSummaryId={selectedSummaryId}
        selectedPlanId={selectedPlanId}
        selectedAtomicNodeId={selectedAtomicNodeId}
        selectedGlyphColumnHighlightColor={selectedGlyphColumnHighlightColor}
        selectedGlyphConnection={selectedGlyphConnection}
        selectedGlyphBranchHighlightIds={selectedGlyphBranchHighlightIds}
        selectedSummaryConnectivity={selectedSummaryConnectivity}
        selectedSummarySharedColumnIds={selectedSummarySharedColumnIds}
        selectedSummaryExtensionPromotion={selectedSummaryExtensionPromotion}
        selectedSummaryConnectivityActive={selectedSummaryConnectivityActive}
        isStorylineFilterActive={isStorylineFilterActive}
        convergeLaneModeByKey={convergeLaneModeByKey}
        minimapState={minimapState}
        minimapInnerHeight={minimapInnerHeight}
        minimapPoints={minimapPoints}
        activePlanAreas={layout.activePlanAreas}
        convergeSummaryButtons={convergeSummaryButtons}
        highlightedSummaryEntryId={highlightedSummaryEntryId}
        planControlPendingById={planControlPendingById}
        editingPlanId={editingPlanState?.planId ?? null}
        editingPlanDraft={editingPlanState?.draft ?? ''}
        disablePendingPlanLaunch={disablePendingPlanLaunch}
        onCanvasMouseDown={handleCanvasMouseDown}
        onCanvasClick={handleCanvasClick}
        onCanvasMouseLeave={handleCanvasMouseLeave}
        onWheel={handleWheel}
        onSummarySelect={handleSummarySelect}
        onAtomicSelect={handleAtomicSelect}
        onHoverSummaryTarget={handleHoverSummaryTarget}
        onLeaveSummaryTarget={handleLeaveSummaryTarget}
        onActivePlanSelect={handleActivePlanSelect}
        onHoverActivePlanArea={handleHoverActivePlanArea}
        onLeaveActivePlanArea={handleLeaveActivePlanArea}
        onPlanControl={handlePlanControl}
        onPlanModifyStart={handlePlanModifyStart}
        onPlanModifyDraftChange={handlePlanModifyDraftChange}
        onPlanModifyCancel={handlePlanModifyCancel}
        onPlanModifySubmit={(planId) => {
          void handlePlanModifySubmit(planId);
        }}
        onBackgroundContextMenu={handleBackgroundContextMenu}
        onHoverAtomicGlyph={updateHoveredAtomicPreview}
        onLeaveAtomicGlyph={handleLeaveAtomicPreview}
        onLegendToggle={(insightType) => storylineFilterActions.toggleLegendType(insightType)}
        onColumnPointerDown={handleStorylineColumnPointerDown}
        onColumnClick={handleStorylineColumnClick}
        onHoverColumn={updateHoveredTrack}
        onLeaveColumn={handleLeaveColumn}
        onMinimapBackgroundMouseDown={handleMinimapBackgroundMouseDown}
        onMinimapFocusMouseDown={handleMinimapFocusMouseDown}
        isNodeKeptByFilter={isNodeKeptByFilter}
        isSummaryKeptByFilter={isSummaryKeptByFilter}
        isTrackSegmentKeptByFilter={isTrackSegmentKeptByFilter}
        isBranchKeptByFilter={isBranchKeptByFilter}
        isConvergeLaneKeptByFilter={isConvergeLaneKeptByFilter}
        getColumnFilterState={getColumnFilterState}
        resolveConvergeColumnEmphasis={resolveConvergeColumnEmphasis}
        resolveSummaryColumnEmphasis={resolveSummaryColumnEmphasis}
        resolveConvergeLabelTextColor={resolveConvergeLabelTextColor}
        resolveConvergeLabelVisualState={resolveConvergeLabelVisualState}
        usesInvolvedConvergeVisual={usesInvolvedConvergeVisual}
        onColumnContextMenu={handleColumnContextMenu}
        summarySteeringBadgeKinds={latestSoftSteeringByTarget.summaryKindsById}
        atomicSteeringBadgeKinds={latestSoftSteeringByTarget.atomicKindsByKey}
        columnSteeringBadgeKinds={latestSoftSteeringByTarget.columnKindsByName}
        columnSteeringBadgeKindsByIndicatorId={latestSoftSteeringByTarget.columnKindsByIndicatorId}
        summarySteeringEntryIdsById={latestSoftSteeringByTarget.summaryEntryIdsById}
        atomicSteeringEntryIdsByKey={latestSoftSteeringByTarget.atomicEntryIdsByKey}
        columnSteeringEntryIdsByName={latestSoftSteeringByTarget.columnEntryIdsByName}
        columnSteeringEntryIdsByIndicatorId={latestSoftSteeringByTarget.columnEntryIdsByIndicatorId}
        createOriginPlanIds={createOriginPlanIds}
        createOriginSummaryIds={createOriginSummaryIds}
        onConversationEntryFocusRequest={(conversationEntryId) => {
          onConversationEntryFocusRequest?.(conversationEntryId);
        }}
        onConvergeSummaryButtonClick={handleConvergeSummaryButtonClick}
      />
      {!isEmptyStoryline ? (
        <div
          className="pointer-events-none absolute z-40"
          style={{
            left: STORYLINE_BOTTOM_SCROLLBAR_LEFT_PX,
            right: STORYLINE_BOTTOM_SCROLLBAR_RIGHT_SAFE_GAP_PX,
            bottom: STORYLINE_BOTTOM_SCROLLBAR_BOTTOM_PX,
            height: STORYLINE_BOTTOM_SCROLLBAR_HEIGHT_PX,
          }}
        >
          <div
            ref={horizontalScrollbarTrackRef}
            data-storyline-interactive="true"
            data-storyline-bottom-scrollbar-track="true"
            className="pointer-events-auto relative h-full w-full rounded-full border border-slate-400/85 shadow-sm"
            style={{
              backgroundColor: SUMMARY_AREA_FILL_HEX,
              opacity: storylineHorizontalScrollbarMetrics.visible ? 1 : 0.78,
            }}
            onMouseDown={(event) => {
              if (
                event.button !== 0
                || !horizontalScrollbarTrackRef.current
                || !storylineHorizontalScrollbarMetrics.visible
              ) {
                return;
              }
              event.preventDefault();
              const trackRect = horizontalScrollbarTrackRef.current.getBoundingClientRect();
              const pointerOffsetX = clamp(event.clientX - trackRect.left, 0, trackRect.width);
              const thumbOffset = resolveThumbOffsetFromTrackPointer({
                pointerOffsetPx: pointerOffsetX,
                thumbSizePx: storylineHorizontalScrollbarMetrics.thumbSizePx,
                maxThumbOffsetPx: storylineHorizontalScrollbarMetrics.maxThumbOffsetPx,
              });
              const nextScrollOffset = resolveScrollOffsetFromThumbOffset({
                thumbOffsetPx: thumbOffset,
                maxThumbOffsetPx: storylineHorizontalScrollbarMetrics.maxThumbOffsetPx,
                maxScrollOffsetPx: storylineHorizontalScrollbarMetrics.maxScrollOffsetPx,
              });
              setView((current) => clampViewX({
                ...current,
                tx: -(transformBounds.minX + nextScrollOffset),
              }, { width: plotViewport.width }, transformBounds));
              setHorizontalScrollbarDragState({
                pointerOffsetX: storylineHorizontalScrollbarMetrics.thumbSizePx / 2,
              });
            }}
          >
            <div
              data-storyline-interactive="true"
              data-storyline-bottom-scrollbar-thumb="true"
              className="absolute left-0 top-0 h-full rounded-full border border-slate-400/90 transition-colors"
              style={{
                backgroundColor: SUMMARY_TITLE_FILL_HEX,
                width: storylineHorizontalScrollbarMetrics.thumbSizePx,
                transform: `translateX(${storylineHorizontalScrollbarMetrics.thumbOffsetPx}px)`,
                opacity: storylineHorizontalScrollbarMetrics.visible ? 1 : 0.86,
              }}
              onMouseDown={(event) => {
                if (
                  event.button !== 0
                  || !horizontalScrollbarTrackRef.current
                  || !storylineHorizontalScrollbarMetrics.visible
                ) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const trackRect = horizontalScrollbarTrackRef.current.getBoundingClientRect();
                const pointerOffsetX = clamp(event.clientX - trackRect.left, 0, trackRect.width);
                setHorizontalScrollbarDragState({
                  pointerOffsetX: pointerOffsetX - storylineHorizontalScrollbarMetrics.thumbOffsetPx,
                });
              }}
            />
          </div>
        </div>
      ) : null}
      {steeringPopover ? (
        <StorylineSteeringPopover
          popoverRef={overlayRef}
          popover={steeringPopover}
          viewport={viewport}
          keywordOptions={keywordOptions}
          isSubmitting={isSubmittingSteeringAction}
          isConfirmDisabled={isSteeringConfirmDisabled}
          previewPlaceholder={steeringPreviewPlaceholder}
          chipActiveClassName={STEERING_PEN_META[steeringPopover.kind].chipActiveClassName}
          chipIdleClassName={STEERING_PEN_META[steeringPopover.kind].chipIdleClassName}
          isDraggable={true}
          onKeywordToggle={handleKeywordToggle}
          onUserPromptChange={handleSteeringPreviewChange}
          onIncludeBackgroundChange={handleSteeringIncludeBackgroundChange}
          onPopoverMouseDown={handleSteeringPopoverDragStart}
          onCancel={handleSteeringPopoverCancel}
          onConfirm={() => void handleSteeringPopoverSubmit()}
        />
      ) : null}
      {createPopover && (
        <div
          ref={overlayRef}
          data-storyline-interactive="true"
          data-storyline-create-popover="true"
          data-storyline-create-popover-draggable-surface="true"
          className="absolute z-50 w-[22rem] rounded-xl border border-slate-200 bg-white p-3 shadow-xl cursor-grab"
          style={{
            left: createPopoverLayout?.left ?? createPopover.x,
            top: createPopoverLayout?.top ?? createPopover.y,
          }}
          onMouseDown={(event) => handleCreatePopoverDragStart(
            event,
            createPopoverLayout ?? { left: createPopover.x, top: createPopover.y }
          )}
        >
          <div className="px-1 pb-2">
            <div data-storyline-create-popover-title="true">
              <SteeringCardTitle kind="create" variant="popover" />
            </div>
          </div>
          <textarea
            ref={createTextareaRef}
            value={createPopover.draft}
            onChange={(event) => handleCreateDraftChange(event.target.value)}
            onKeyDown={handleCreateTextareaKeyDown}
            rows={5}
            className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            placeholder="Describe the analysis plan you want to add to this turn..."
          />
          {createError ? (
            <div className="px-1 pt-2 text-xs text-rose-600">{createError}</div>
          ) : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
              onClick={() => {
                setCreatePopoverDragState(null);
                setCreatePopover(null);
                setCreateError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmittingCreate}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleCreateSubmit()}
            >
              {isSubmittingCreate ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
