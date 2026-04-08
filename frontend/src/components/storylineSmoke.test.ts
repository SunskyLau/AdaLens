import test from 'node:test';
import assert from 'node:assert/strict';
import type { AtomicInsight, PlanItem, RunState, Summary } from '../types';
import { buildConvergeIndicatorTracks } from './StorylineGraph';
import {
  buildStorylineLayoutWithBoundaryContract,
  computeSlotSideLeadPx,
  createStorylineAdaptiveProfile,
} from './storylineGraphLayout';
import {
  solveEgressWindow,
  solveIngressConvergeWindow,
  solveIngressWindow,
  type BoundaryLaneState,
} from './storylineBoundaryWindowLayout';
import { buildVisibleTrackLabels } from './storylineTrackLabels';
import { buildStorylineTurnConvergeLayout } from './storylineTurnConvergeLayout';

function makeIsoTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
}

function makePlan(input: Partial<PlanItem> & Pick<PlanItem, 'plan_id' | 'text'>): PlanItem {
  return {
    plan_id: input.plan_id,
    kind: 'analysis',
    text: input.text,
    filters: [],
    embedding: null,
    status: input.status ?? 'completed',
    parent_insight_id: input.parent_insight_id ?? null,
    short_label: input.short_label ?? input.text,
    assigned_sub_agent_id: null,
    control_state: input.control_state ?? 'none',
    final_summary: input.final_summary ?? null,
    error_message: input.error_message ?? null,
    created_at: input.created_at ?? makeIsoTimestamp(0),
    updated_at: input.updated_at ?? input.created_at ?? makeIsoTimestamp(0),
  };
}

function makeAtomic(params: {
  id: string;
  text?: string;
  importance?: number;
  columns: string[];
}): AtomicInsight {
  return {
    atomic_id: params.id,
    text: params.text ?? params.id,
    insight_type: 'trend',
    columns: params.columns,
    evidence: {
      code_path: null,
      output_path: null,
      plot_path: null,
    },
    interest: 0.5,
    significance: 0.5,
    impact: 0.5,
    importance: params.importance ?? 0.5,
  };
}

function makeSummary(input: Partial<Summary> & Pick<Summary, 'insight_id' | 'plan_id'>): Summary {
  return {
    insight_id: input.insight_id,
    plan_id: input.plan_id,
    summary: input.summary ?? input.insight_id,
    atomic_insights: input.atomic_insights ?? [],
    embedding: null,
    parent_insight_id: input.parent_insight_id ?? null,
    children_insight_ids: input.children_insight_ids ?? [],
    short_label: input.short_label ?? input.summary ?? input.insight_id,
    created_at: input.created_at ?? makeIsoTimestamp(0),
  };
}

interface SummarySpec {
  id: string;
  shortLabel?: string;
  atomics: Array<{
    id?: string;
    text?: string;
    importance?: number;
    columns: string[];
  }>;
}

function buildTurnedRunState(turnSpecs: SummarySpec[][]): RunState {
  const frontier: PlanItem[] = [];
  const insights: Summary[] = [];
  const dispatchBatches: NonNullable<RunState['master_agent_state']>['dispatch_batches'] = [];
  const datasetColumns = new Set<string>();
  let timestampIndex = 0;

  for (let turnIndex = 0; turnIndex < turnSpecs.length; turnIndex += 1) {
    const batchPlanIds: string[] = [];
    for (let summaryIndex = 0; summaryIndex < turnSpecs[turnIndex].length; summaryIndex += 1) {
      const spec = turnSpecs[turnIndex][summaryIndex];
      const planId = `plan:${spec.id}`;
      const createdAt = makeIsoTimestamp(timestampIndex);
      timestampIndex += 1;
      frontier.push(makePlan({
        plan_id: planId,
        text: spec.shortLabel ?? spec.id,
        short_label: spec.shortLabel ?? spec.id,
        created_at: createdAt,
      }));
      insights.push(makeSummary({
        insight_id: spec.id,
        plan_id: planId,
        summary: spec.shortLabel ?? spec.id,
        short_label: spec.shortLabel ?? spec.id,
        created_at: createdAt,
        atomic_insights: spec.atomics.map((atomic, atomicIndex) => {
          for (const column of atomic.columns) datasetColumns.add(column);
          return makeAtomic({
            id: atomic.id ?? `${spec.id}:a${atomicIndex + 1}`,
            text: atomic.text ?? atomic.id ?? `${spec.id}:a${atomicIndex + 1}`,
            importance: atomic.importance ?? 0.45 + atomicIndex * 0.1,
            columns: atomic.columns,
          });
        }),
      }));
      batchPlanIds.push(planId);
    }
    dispatchBatches.push({
      dispatch_turn_index: turnIndex,
      plan_ids: batchPlanIds,
      status: 'waiting_for_stage_summary',
      stage_summary_emitted: false,
      stage_summary_markdown: '',
      stage_summary_citations: [],
    });
  }

  return {
    run_id: 'run_storyline_boundary_smoke',
    dataset_path: 'data/test.csv',
    dataset_info: '{}',
    dataset_schema: `Columns: ${JSON.stringify([...datasetColumns].sort())}`,
    step: insights.length,
    failure_count: 0,
    status: 'running',
    budgets: {
      max_steps: 20,
      max_depth: 4,
      max_children_per_insight: 4,
      max_failures: 3,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 3,
      max_concurrency: 2,
    },
    frontier,
    insights,
    execution_records: [],
    created_at: makeIsoTimestamp(0),
    updated_at: makeIsoTimestamp(Math.max(0, timestampIndex)),
    master_agent_state: {
      current_goals: [],
      active_plan_ids: [],
      completed_plan_ids: frontier.map((plan) => plan.plan_id),
      all_insight_ids: insights.map((summary) => summary.insight_id),
      dispatch_batches: dispatchBatches,
      pending_user_response_message_ids: [],
      message_history: [],
      loop_count: 0,
      completed: false,
    },
  };
}

function buildSingleSummaryRunState(summarySpec: SummarySpec): RunState {
  return buildTurnedRunState([[summarySpec]]);
}

function buildRunStateWithJoinedActivePlan(args: {
  turnSpecs: SummarySpec[][];
  turnIndex: number;
  planId: string;
  text: string;
  shortLabel?: string;
  status?: PlanItem['status'];
}): RunState {
  const runState = buildTurnedRunState(args.turnSpecs);
  const joinedPlan = makePlan({
    plan_id: args.planId,
    text: args.text,
    short_label: args.shortLabel ?? args.text,
    status: args.status ?? 'analyzing',
    created_at: makeIsoTimestamp(40),
    updated_at: makeIsoTimestamp(40),
  });
  const frontier = [...runState.frontier.map((plan) => ({ ...plan })), joinedPlan];
  const dispatchBatches = (runState.master_agent_state?.dispatch_batches ?? []).map((batch, index) => (
    index === args.turnIndex
      ? {
        ...batch,
        plan_ids: [...batch.plan_ids, joinedPlan.plan_id],
        status: 'dispatched' as const,
      }
      : batch
  ));
  return {
    ...runState,
    frontier,
    master_agent_state: runState.master_agent_state
      ? {
        ...runState.master_agent_state,
        active_plan_ids: [joinedPlan.plan_id],
        completed_plan_ids: frontier
          .filter((plan) => plan.plan_id !== joinedPlan.plan_id)
          .map((plan) => plan.plan_id),
        dispatch_batches: dispatchBatches,
      }
      : runState.master_agent_state,
  };
}

function countInversions(values: number[]): number {
  let inversions = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      if (values[i] > values[j]) inversions += 1;
    }
  }
  return inversions;
}

function countBoundaryCrossings(args: {
  orderedSummaryIds: string[];
  laneOrder: string[];
  columnsBySummaryId: Map<string, string[]>;
}): number {
  const rankByColumn = new Map(args.laneOrder.map((column, index) => [column, index]));
  const sequence: number[] = [];
  for (const summaryId of args.orderedSummaryIds) {
    for (const column of args.columnsBySummaryId.get(summaryId) ?? []) {
      const rank = rankByColumn.get(column);
      if (typeof rank === 'number') sequence.push(rank);
    }
  }
  return countInversions(sequence);
}

function extractLeftAnchorYByColumn(layout: ReturnType<typeof buildStorylineLayoutWithBoundaryContract>): Record<string, number> {
  const anchorYByColumn: Record<string, number> = {};
  for (const track of layout.tracks) {
    const firstAnchor = track.anchors[0];
    if (firstAnchor) {
      anchorYByColumn[track.column] = firstAnchor.y;
    }
  }
  return anchorYByColumn;
}

function extractColumnOrderFromAnchorY(anchorYByColumn: Record<string, number>): string[] {
  return Object.entries(anchorYByColumn)
    .sort((a, b) => a[1] - b[1])
    .map(([column]) => column);
}

function normalizeBoundaryTargetsForLocalSolve(args: {
  rawTargetYByColumn: Record<string, number>;
  orderedColumns: string[];
  yTop: number;
  yBottom: number;
}): Record<string, number> {
  const rawValues = args.orderedColumns
    .map((column) => Number(args.rawTargetYByColumn[column]))
    .filter((value) => Number.isFinite(value));
  if (rawValues.length === 0) return {};

  const sortedRawValues = [...rawValues].sort((a, b) => a - b);
  const rawMedian = sortedRawValues[Math.floor(sortedRawValues.length / 2)] ?? 0;
  const localMedian = (args.yTop + args.yBottom) / 2;
  const normalized: Record<string, number> = {};
  for (const column of args.orderedColumns) {
    const rawY = Number(args.rawTargetYByColumn[column]);
    if (!Number.isFinite(rawY)) continue;
    normalized[column] = Math.max(args.yTop, Math.min(args.yBottom, rawY - rawMedian + localMedian));
  }
  return normalized;
}

function computeAnchorEnergy(anchorYByColumn: Record<string, number>, targetYByColumn: Record<string, number>): number {
  return Object.entries(targetYByColumn).reduce((sum, [column, targetY]) => {
    const anchorY = anchorYByColumn[column];
    if (!Number.isFinite(anchorY)) return sum;
    return sum + Math.abs(anchorY - targetY);
  }, 0);
}

function getLaneColumns(lanes: BoundaryLaneState[] | Array<{ column: string }>): string[] {
  return lanes.map((lane) => lane.column);
}

function boxesOverlap(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function extractTurnConvergeContentBounds(layout: ReturnType<typeof buildStorylineTurnConvergeLayout>): { minY: number; maxY: number } {
  const values: number[] = [];
  for (const area of layout.summaryAreas) {
    values.push(area.top, area.bottom);
    for (const node of area.nodes) {
      values.push(node.y - node.height / 2, node.y + node.height / 2);
    }
    for (const track of area.tracks) {
      values.push(track.minY, track.maxY);
    }
  }
  for (const area of layout.activePlanAreas) {
    values.push(area.top, area.bottom);
  }
  for (const converge of layout.converges) {
    for (const lane of converge.lanes) {
      values.push(lane.y);
      for (const marker of lane.endpointMarkers) {
        values.push(marker.y - marker.diameter / 2, marker.y + marker.diameter / 2);
      }
    }
  }
  for (const branch of layout.boundaryBranches) {
    values.push(branch.fromY, branch.toY, branch.c1Y, branch.c2Y);
  }
  return {
    minY: values.length > 0 ? Math.min(...values) : 0,
    maxY: values.length > 0 ? Math.max(...values) : 0,
  };
}

function parseSlotLeadSegment(segmentId: string): { slotIndex: number; side: 'left' | 'right' } | null {
  const match = segmentId.match(/:slot:(\d+):(left|right)$/);
  if (!match) return null;
  return {
    slotIndex: Number(match[1]),
    side: match[2] as 'left' | 'right',
  };
}

function extractMappedSlotWidths(area: { tracks: Array<{ segments: Array<{ id: string; kind: string; startX: number; endX: number }> }> }): number[] {
  const boundsBySlot = extractMappedSlotBounds(area);
  return [...boundsBySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bounds]) => Math.max(0, (bounds.right ?? 0) - (bounds.left ?? 0)));
}

function extractMappedSlotBounds(area: { tracks: Array<{ segments: Array<{ id: string; kind: string; startX: number; endX: number }> }> }): Map<number, { left?: number; right?: number }> {
  const boundsBySlot = new Map<number, { left?: number; right?: number }>();
  for (const track of area.tracks) {
    for (const segment of track.segments) {
      if (segment.kind !== 'slot_horizontal') continue;
      const parsedLead = parseSlotLeadSegment(segment.id);
      if (parsedLead) {
        const entry = boundsBySlot.get(parsedLead.slotIndex) ?? {};
        if (parsedLead.side === 'left') entry.left = Math.min(segment.startX, segment.endX);
        if (parsedLead.side === 'right') entry.right = Math.max(segment.startX, segment.endX);
        boundsBySlot.set(parsedLead.slotIndex, entry);
        continue;
      }
      const fullMatch = segment.id.match(/:slot:(\d+):full$/);
      if (!fullMatch) continue;
      boundsBySlot.set(Number(fullMatch[1]), {
        left: Math.min(segment.startX, segment.endX),
        right: Math.max(segment.startX, segment.endX),
      });
    }
  }

  return boundsBySlot;
}

function extractMappedInterspaceWidths(area: { tracks: Array<{ segments: Array<{ id: string; kind: string; startX: number; endX: number }> }> }): number[] {
  const orderedBounds = [...extractMappedSlotBounds(area).entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bounds]) => bounds);

  const widths: number[] = [];
  for (let index = 0; index < orderedBounds.length - 1; index += 1) {
    widths.push(Math.max(0, (orderedBounds[index + 1].left ?? 0) - (orderedBounds[index].right ?? 0)));
  }
  return widths;
}

test('ingress ordering inherits left converge lane order and reduces boundary crossings', () => {
  const leftLanes: BoundaryLaneState[] = [
    { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
    { column: 'B', y: 140, frozenOrder: true, introducedForTurnIndex: 0 },
    { column: 'C', y: 180, frozenOrder: true, introducedForTurnIndex: 0 },
    { column: 'D', y: 220, frozenOrder: true, introducedForTurnIndex: 0 },
  ];
  const summaries: Array<{
    summaryId: string;
    columns: string[];
    leftAnchorOffsetYByColumn: Record<string, number>;
  }> = [
    { summaryId: 'late', columns: ['D'], leftAnchorOffsetYByColumn: { D: 18 } },
    { summaryId: 'early', columns: ['A', 'B'], leftAnchorOffsetYByColumn: { A: 18, B: 32 } },
    { summaryId: 'middle', columns: ['C'], leftAnchorOffsetYByColumn: { C: 18 } },
  ];
  const baselineColumnsBySummaryId = new Map(summaries.map((summary) => [summary.summaryId, summary.columns]));
  const baselineCrossings = countBoundaryCrossings({
    orderedSummaryIds: summaries.map((summary) => summary.summaryId),
    laneOrder: getLaneColumns(leftLanes),
    columnsBySummaryId: baselineColumnsBySummaryId,
  });

  const result = solveIngressWindow({
    leftLanes,
    summaries,
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 24,
    yBottomBound: 760,
    baseD1: 30,
    baseD2: 78,
  });

  assert.deepEqual(result.orderedSummaryIds, ['early', 'middle', 'late']);
  assert.deepEqual(result.contractBySummaryId.get('early')?.leftPortColumnsInOrder, ['A', 'B']);
  assert.deepEqual(result.contractBySummaryId.get('late')?.leftPortColumnsInOrder, ['D']);
  assert.ok(result.crossingCount < baselineCrossings);
});

test('ingress alignment contract reduces left-port energy and restores requested port order', () => {
  const runState = buildSingleSummaryRunState({
    id: 'summary_alignment',
    shortLabel: 'Alignment',
    atomics: [
      { columns: ['C', 'A', 'B'], importance: 0.3 },
      { columns: ['C'], importance: 0.5 },
      { columns: ['C'], importance: 0.7 },
    ],
  });
  const viewportHeight = 260;
  const yUpperBoundPx = 16;
  const yLowerBoundPx = 242;
  const rawTargetYByColumn = { A: 110, B: 170, C: 230 };
  const targetOrder = ['A', 'B', 'C'];
  const normalizedTargetYByColumn = normalizeBoundaryTargetsForLocalSolve({
    rawTargetYByColumn,
    orderedColumns: targetOrder,
    yTop: yUpperBoundPx,
    yBottom: yLowerBoundPx,
  });

  const legacyLayout = buildStorylineLayoutWithBoundaryContract(runState, viewportHeight, {
    yUpperBoundPx,
    yLowerBoundPx,
    yMedianTargetPx: 128,
    viewportWidthPx: 960,
    xZoomRatio: 1,
  });
  const contractedLayout = buildStorylineLayoutWithBoundaryContract(runState, viewportHeight, {
    yUpperBoundPx,
    yLowerBoundPx,
    yMedianTargetPx: 128,
    viewportWidthPx: 960,
    xZoomRatio: 1,
    boundaryContract: {
      leftPortColumnsInOrder: targetOrder,
      leftPortTargetYByColumn: rawTargetYByColumn,
      leftPortMinGapPx: 18,
    },
  });

  const legacyAnchorYByColumn = extractLeftAnchorYByColumn(legacyLayout);
  const contractedAnchorYByColumn = extractLeftAnchorYByColumn(contractedLayout);
  const legacyOrder = extractColumnOrderFromAnchorY(legacyAnchorYByColumn);
  const contractedOrder = extractColumnOrderFromAnchorY(contractedAnchorYByColumn);
  const targetRank = new Map(targetOrder.map((column, index) => [column, index]));
  const legacyInversions = countInversions(legacyOrder.map((column) => targetRank.get(column) ?? 0));
  const contractedInversions = countInversions(contractedOrder.map((column) => targetRank.get(column) ?? 0));
  const legacyEnergy = computeAnchorEnergy(legacyAnchorYByColumn, normalizedTargetYByColumn);
  const contractedEnergy = computeAnchorEnergy(contractedAnchorYByColumn, normalizedTargetYByColumn);

  assert.deepEqual(contractedOrder, targetOrder);
  assert.ok(contractedInversions < legacyInversions);
  assert.ok(contractedEnergy < legacyEnergy);
});

test('ingress ordering inserts new extension columns between preserved converge columns when summary order requires it', () => {
  const result = solveIngressWindow({
    leftLanes: [
      { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'C', y: 130, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'D', y: 160, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'extension_summary',
        columns: ['A', 'X'],
        leftAnchorOffsetYByColumn: {
          A: 20,
          X: 35,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 80,
    yBottomBound: 180,
    baseD1: 30,
    baseD2: 78,
  });

  const contract = result.contractBySummaryId.get('extension_summary');

  assert.deepEqual(result.leftLanes.map((lane) => lane.column), ['A', 'X', 'C', 'D']);
  assert.ok(contract);
  assert.deepEqual(contract?.leftPortColumnsInOrder, ['A', 'X']);
  assert.equal(contract?.leftPortTargetYByColumn, undefined);
  assert.equal(contract?.leftPortMinGapPx, undefined);
  assert.equal(contract?.requiredIngressSpanPx, undefined);
});

test('ingress ordering may place new extension columns above or below the existing converge band', () => {
  const result = solveIngressWindow({
    leftLanes: [
      { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'C', y: 130, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'upper_extension_summary',
        columns: ['UpperExtension', 'A'],
        leftAnchorOffsetYByColumn: {
          UpperExtension: 0,
          A: 20,
        },
      },
      {
        summaryId: 'lower_extension_summary',
        columns: ['C', 'LowerExtension'],
        leftAnchorOffsetYByColumn: {
          C: 20,
          LowerExtension: 50,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 210,
    baseD1: 30,
    baseD2: 78,
  });

  const upperLane = result.leftLanes.find((lane) => lane.column === 'UpperExtension');
  const lowerLane = result.leftLanes.find((lane) => lane.column === 'LowerExtension');
  const laneA = result.leftLanes.find((lane) => lane.column === 'A');
  const laneC = result.leftLanes.find((lane) => lane.column === 'C');

  assert.deepEqual(
    result.leftLanes.map((lane) => lane.column),
    ['UpperExtension', 'A', 'C', 'LowerExtension']
  );
  assert.ok(upperLane && lowerLane && laneA && laneC);
});

test('ingress ordering jointly places multiple inserted extension lanes inside the same slot', () => {
  const result = solveIngressWindow({
    leftLanes: [
      { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'D', y: 160, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'joint_extension_summary',
        columns: ['A', 'B', 'C', 'D'],
        leftAnchorOffsetYByColumn: {
          A: 20,
          B: 40,
          C: 60,
          D: 80,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 220,
    baseD1: 30,
    baseD2: 78,
  });

  const laneA = result.leftLanes.find((lane) => lane.column === 'A');
  const laneB = result.leftLanes.find((lane) => lane.column === 'B');
  const laneC = result.leftLanes.find((lane) => lane.column === 'C');
  const laneD = result.leftLanes.find((lane) => lane.column === 'D');

  assert.deepEqual(result.leftLanes.map((lane) => lane.column), ['A', 'B', 'C', 'D']);
  assert.ok(laneA && laneB && laneC && laneD);
});

test('ingress ordering contracts stay order-only so summary-local spacing is not constrained by converge y', () => {
  const result = solveIngressWindow({
    leftLanes: [
      { column: 'Anchor', y: 170, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'multi_extension_contract_summary',
        columns: ['UpperExtension1', 'UpperExtension2', 'UpperExtension3', 'Anchor'],
        leftAnchorOffsetYByColumn: {
          UpperExtension1: 0,
          UpperExtension2: 20,
          UpperExtension3: 40,
          Anchor: 60,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 250,
    baseD1: 30,
    baseD2: 78,
  });

  const contract = result.contractBySummaryId.get('multi_extension_contract_summary');
  assert.ok(contract);
  assert.deepEqual(contract?.leftPortColumnsInOrder, ['UpperExtension1', 'UpperExtension2', 'UpperExtension3', 'Anchor']);
  assert.equal(contract?.leftPortTargetYByColumn, undefined);
  assert.equal(contract?.leftPortMinGapPx, undefined);
  assert.equal(contract?.requiredIngressSpanPx, undefined);
});

test('ingress converge solve gives top/bottom extension lanes legal gaps after ordering', () => {
  const ordered = solveIngressWindow({
    leftLanes: [
      { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'C', y: 130, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'upper_extension_summary',
        columns: ['UpperExtension', 'A'],
        leftAnchorOffsetYByColumn: {
          UpperExtension: 0,
          A: 20,
        },
      },
      {
        summaryId: 'lower_extension_summary',
        columns: ['C', 'LowerExtension'],
        leftAnchorOffsetYByColumn: {
          C: 20,
          LowerExtension: 50,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 210,
    baseD1: 30,
    baseD2: 78,
  });
  const aligned = solveIngressConvergeWindow({
    leftLanes: ordered.leftLanes,
    summaries: [
      {
        summaryId: 'upper_extension_summary',
        columns: ['UpperExtension', 'A'],
        leftAnchorOffsetYByColumn: {
          UpperExtension: 0,
          A: 20,
        },
      },
      {
        summaryId: 'lower_extension_summary',
        columns: ['C', 'LowerExtension'],
        leftAnchorOffsetYByColumn: {
          C: 20,
          LowerExtension: 50,
        },
      },
    ],
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 210,
    baseD1: 30,
    baseD2: 78,
  });

  const upperLane = aligned.find((lane) => lane.column === 'UpperExtension');
  const lowerLane = aligned.find((lane) => lane.column === 'LowerExtension');
  const laneA = aligned.find((lane) => lane.column === 'A');
  const laneC = aligned.find((lane) => lane.column === 'C');

  assert.deepEqual(aligned.map((lane) => lane.column), ['UpperExtension', 'A', 'C', 'LowerExtension']);
  assert.ok(upperLane && lowerLane && laneA && laneC);
  assert.ok((laneA!.y - upperLane!.y) >= 30);
  assert.ok((lowerLane!.y - laneC!.y) >= 30);
});

test('ingress converge solve jointly spaces multiple inserted extension lanes and may move preserved lanes', () => {
  const ordered = solveIngressWindow({
    leftLanes: [
      { column: 'A', y: 100, frozenOrder: true, introducedForTurnIndex: 0 },
      { column: 'D', y: 160, frozenOrder: true, introducedForTurnIndex: 0 },
    ],
    summaries: [
      {
        summaryId: 'joint_extension_summary',
        columns: ['A', 'B', 'C', 'D'],
        leftAnchorOffsetYByColumn: {
          A: 20,
          B: 40,
          C: 60,
          D: 80,
        },
      },
    ],
    turnIndex: 1,
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 220,
    baseD1: 30,
    baseD2: 78,
  });
  const aligned = solveIngressConvergeWindow({
    leftLanes: ordered.leftLanes,
    summaries: [
      {
        summaryId: 'joint_extension_summary',
        columns: ['A', 'B', 'C', 'D'],
        leftAnchorOffsetYByColumn: {
          A: 20,
          B: 40,
          C: 60,
          D: 80,
        },
      },
    ],
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 60,
    yBottomBound: 220,
    baseD1: 30,
    baseD2: 78,
  });

  const laneA = aligned.find((lane) => lane.column === 'A');
  const laneB = aligned.find((lane) => lane.column === 'B');
  const laneC = aligned.find((lane) => lane.column === 'C');
  const laneD = aligned.find((lane) => lane.column === 'D');

  assert.deepEqual(aligned.map((lane) => lane.column), ['A', 'B', 'C', 'D']);
  assert.ok(laneA && laneB && laneC && laneD);
  assert.ok((laneB!.y - laneA!.y) >= 30);
  assert.ok((laneC!.y - laneB!.y) >= 30);
  assert.ok((laneD!.y - laneC!.y) >= 30);
  assert.ok(
    Math.abs(laneA!.y - 100) > 1e-6 || Math.abs(laneD!.y - 160) > 1e-6,
    'expected preserved converge lanes to move during ingress compaction when the inserted block needs room'
  );
});

test('ordinary ingress keeps existing converge order and gives inserted extension lanes room', () => {
  const extendedLayout = buildStorylineTurnConvergeLayout(buildTurnedRunState([
    [
      {
        id: 'base_turn0',
        shortLabel: 'Base Turn 0',
        atomics: [
          { columns: ['A'], importance: 0.35 },
          { columns: ['C'], importance: 0.55 },
          { columns: ['D'], importance: 0.75 },
        ],
      },
    ],
    [
      {
        id: 'turn1_extension',
        shortLabel: 'Extension Turn',
        atomics: [
          { columns: ['A', 'X'], importance: 0.62 },
          { columns: ['X', 'C'], importance: 0.74 },
        ],
      },
    ],
  ]), 920, {
    xZoomRatio: 1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 800,
    yMedianTargetPx: 420,
  });

  const extendedConverge = extendedLayout.converges[1];
  assert.ok(extendedConverge);

  const extendedColumns = extendedConverge!.lanes.map((lane) => lane.column);
  const extensionIndex = extendedColumns.indexOf('X');
  const laneX = extensionIndex >= 0 ? extendedConverge!.lanes[extensionIndex] : null;

  assert.equal(extensionIndex >= 0, true);
  assert.deepEqual(extendedColumns.filter((column) => column !== 'X'), ['A', 'C', 'D']);

  const adjacentGaps: number[] = [];
  if (extensionIndex > 0) {
    adjacentGaps.push(extendedConverge!.lanes[extensionIndex].y - extendedConverge!.lanes[extensionIndex - 1].y);
  }
  if (extensionIndex >= 0 && extensionIndex < extendedConverge!.lanes.length - 1) {
    adjacentGaps.push(extendedConverge!.lanes[extensionIndex + 1].y - extendedConverge!.lanes[extensionIndex].y);
  }
  assert.ok(laneX);
  assert.ok(adjacentGaps.length > 0);
  const minimumGapAroundExtension = Math.min(...adjacentGaps);
  const minimumAdjacentGapAcrossBand = Math.min(
    ...extendedConverge!.lanes.slice(1).map((lane, laneIndex) => lane.y - extendedConverge!.lanes[laneIndex]!.y)
  );
  const requiredBandGap = Math.max(
    24,
    ...extendedConverge!.lanes.map((lane) => lane.indicatorRequiredClearancePx + 2)
  );
  assert.ok(
    minimumGapAroundExtension >= Math.max(24, laneX!.indicatorRequiredClearancePx + 2),
    'expected extension-lane compaction to keep a roomier d1 gap around the inserted indicator'
  );
  assert.ok(
    minimumAdjacentGapAcrossBand >= requiredBandGap,
    'expected ingress stage-3 compaction to keep all converge indicator labels separated'
  );
});

test('incoming converge spacing does not significantly inflate summary-local area height', () => {
  const joinedSpec: SummarySpec = {
    id: 'joined_turn_summary',
    shortLabel: 'Joined Turn Summary',
    atomics: [
      { columns: ['A', 'B', 'C'], importance: 0.62 },
      { columns: ['A', 'B', 'C'], importance: 0.78 },
    ],
  };
  const layoutOptions = {
    xZoomRatio: 1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 840,
    yMedianTargetPx: 420,
  } as const;

  const baselineLayout = buildStorylineTurnConvergeLayout(
    buildTurnedRunState([[joinedSpec]]),
    920,
    layoutOptions
  );
  const constrainedLayout = buildStorylineTurnConvergeLayout(
    buildTurnedRunState([
      [
        { id: 'turn0_top_A', shortLabel: 'Top A', atomics: [{ columns: ['A'], importance: 0.35 }] },
        { id: 'turn0_mid_B', shortLabel: 'Middle B', atomics: [{ columns: ['B'], importance: 0.55 }] },
        { id: 'turn0_bot_C', shortLabel: 'Bottom C', atomics: [{ columns: ['C'], importance: 0.75 }] },
      ],
      [joinedSpec],
    ]),
    920,
    layoutOptions
  );

  const baselineArea = baselineLayout.summaryAreas.find((area) => area.summaryId === joinedSpec.id);
  const constrainedArea = constrainedLayout.summaryAreas.find((area) => area.summaryId === joinedSpec.id);
  assert.ok(baselineArea);
  assert.ok(constrainedArea);
  assert.ok(
    constrainedArea!.height <= baselineArea!.height + 24,
    `expected summary-local height to stay near baseline after outer alignment; baseline=${baselineArea!.height}, constrained=${constrainedArea!.height}`
  );
});

test('egress ordering and alignment stay unchanged when only later turns are added or removed', () => {
  const turnSpecs: SummarySpec[][] = [
    [
      {
        id: 'turn0_summary',
        shortLabel: 'Turn 0',
        atomics: [
          { columns: ['Revenue', 'Cost'], importance: 0.3 },
          { columns: ['Revenue'], importance: 0.5 },
        ],
      },
    ],
    [
      {
        id: 'turn1_cost',
        shortLabel: 'Turn 1 Cost',
        atomics: [
          { columns: ['Cost'], importance: 0.6 },
          { columns: ['Margin', 'Cost'], importance: 0.55 },
        ],
      },
      {
        id: 'turn1_profit',
        shortLabel: 'Turn 1 Profit',
        atomics: [
          { columns: ['Revenue', 'Profit'], importance: 0.75 },
        ],
      },
    ],
    [
      {
        id: 'turn2_future',
        shortLabel: 'Turn 2 Future',
        atomics: [
          { columns: ['Profit', 'Segment'], importance: 0.8 },
        ],
      },
    ],
  ];
  const fullLayout = buildStorylineTurnConvergeLayout(buildTurnedRunState(turnSpecs), 900, {
    xZoomRatio: 1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 780,
    yMedianTargetPx: 420,
  });
  const truncatedLayout = buildStorylineTurnConvergeLayout(buildTurnedRunState(turnSpecs.slice(0, 2)), 900, {
    xZoomRatio: 1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 780,
    yMedianTargetPx: 420,
  });

  const fullConverge = fullLayout.converges[1];
  const truncatedConverge = truncatedLayout.converges[1];
  assert.ok(fullConverge);
  assert.ok(truncatedConverge);
  assert.deepEqual(fullConverge.lanes.map((lane) => lane.column), truncatedConverge.lanes.map((lane) => lane.column));
  assert.deepEqual(fullConverge.lanes.map((lane) => lane.y), truncatedConverge.lanes.map((lane) => lane.y));

  const directSignature = solveEgressWindow({
    summaries: fullLayout.summaryAreas
      .filter((area) => area.turnIndex === 0)
      .map((area) => ({
        summaryId: area.summaryId,
        top: area.top,
        rightAnchorYByColumn: area.rightAnchorYByColumn,
      })),
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 24,
    yBottomBound: 780,
    baseD1: 30,
    baseD2: 78,
  });
  assert.deepEqual(
    directSignature.orderedColumns,
    fullLayout.summaryAreas
      .filter((area) => area.turnIndex === 0)
      .flatMap((area) => Object.entries(area.rightAnchorYByColumn).sort((a, b) => a[1] - b[1]).map(([column]) => column))
      .filter((column, index, columns) => columns.indexOf(column) === index)
  );
});

test('egress compaction preserves legal inter-cluster gaps instead of pulling the converge block upward', () => {
  const signature = solveEgressWindow({
    summaries: [
      {
        summaryId: 'upper',
        top: 80,
        rightAnchorYByColumn: {
          Name: 120,
          Publisher: 154,
          Genre: 188,
        },
      },
      {
        summaryId: 'lower',
        top: 360,
        rightAnchorYByColumn: {
          Year: 430,
          Platform: 464,
          Global_Sales: 498,
        },
      },
    ],
    adaptiveProfile: createStorylineAdaptiveProfile(1),
    yTopBound: 24,
    yBottomBound: 760,
    baseD1: 30,
    baseD2: 78,
  });

  assert.deepEqual(
    signature.orderedColumns,
    ['Name', 'Publisher', 'Genre', 'Year', 'Platform', 'Global_Sales']
  );
  const gapAcrossClusters =
    signature.targetYByColumn.Year - signature.targetYByColumn.Genre;
  assert.ok(
    gapAcrossClusters > 180,
    `expected the inter-cluster gap to stay large, received ${gapAcrossClusters}`
  );
});

test('summary-local solver widens tall multi-port slots and keeps uninvolved tracks just outside route boxes', () => {
  const tallLayout = buildStorylineLayoutWithBoundaryContract(buildSingleSummaryRunState({
    id: 'summary_tall_slot',
    shortLabel: 'Tall Slot',
    atomics: [
      { columns: ['A', 'B', 'C', 'D', 'E', 'F'], importance: 0.7 },
    ],
  }), 280, {
    yUpperBoundPx: 16,
    yLowerBoundPx: 252,
    yMedianTargetPx: 134,
    viewportWidthPx: 960,
    xZoomRatio: 1,
  });
  assert.ok(tallLayout.solvedLayout);
  const tallNode = tallLayout.nodes[0];
  const tallSlot = tallLayout.solvedLayout!.slots[0];
  const tallSlotWidth = tallSlot.right - tallSlot.left;

  assert.ok(tallNode.height > tallNode.width + 20);
  assert.ok(
    tallSlotWidth - tallNode.width >= 10,
    `expected tall route boxes to receive wider slots, received lead ${tallSlotWidth - tallNode.width}`
  );

  const clearanceLayout = buildStorylineLayoutWithBoundaryContract(buildSingleSummaryRunState({
    id: 'summary_routebox_clearance',
    shortLabel: 'Route Box Clearance',
    atomics: [
      { columns: ['A'], importance: 0.35 },
      { columns: ['B'], importance: 0.55 },
      { columns: ['C'], importance: 0.75 },
    ],
  }), 280, {
    yUpperBoundPx: 16,
    yLowerBoundPx: 252,
    yMedianTargetPx: 134,
    viewportWidthPx: 960,
    xZoomRatio: 1,
    boundaryContract: {
      leftPortColumnsInOrder: ['A', 'B', 'C'],
      leftPortTargetYByColumn: { A: 92, B: 134, C: 176 },
      leftPortMinGapPx: 18,
    },
  });
  assert.ok(clearanceLayout.solvedLayout);
  const solved = clearanceLayout.solvedLayout!;
  const slotIndex = 1;
  const slot = solved.slots[slotIndex];
  const columnIndexByName = new Map(solved.columnOrder.map((column, index) => [column, index]));
  const yA = solved.yMatrix[slotIndex][columnIndexByName.get('A') ?? -1];
  const yC = solved.yMatrix[slotIndex][columnIndexByName.get('C') ?? -1];
  const topGap = slot.routeBoxTopY - yA;
  const bottomGap = yC - slot.routeBoxBottomY;

  assert.ok(topGap >= 1.5 && bottomGap >= 1.5);
  assert.ok(
    topGap < solved.d2BySlot[slotIndex] * 0.6,
    `expected uninvolved top track to avoid route box without being pushed by full d2, received gap ${topGap}`
  );
  assert.ok(
    bottomGap < solved.d2BySlot[slotIndex] * 0.6,
    `expected uninvolved bottom track to avoid route box without being pushed by full d2, received gap ${bottomGap}`
  );
});

test('low-zoom turn mapping keeps tall route boxes clear by widening the owning turn when needed', () => {
  const layout = buildStorylineTurnConvergeLayout(buildTurnedRunState([
    [
      {
        id: 'turn0_sparse',
        shortLabel: 'Sparse',
        atomics: [
          { columns: ['A'], importance: 0.55 },
        ],
      },
    ],
    [
      {
        id: 'turn1_dense',
        shortLabel: 'Dense',
        atomics: [
          { columns: ['A', 'B', 'C', 'D', 'E', 'F'], importance: 0.95 },
          { columns: ['A', 'C', 'E'], importance: 0.8 },
          { columns: ['B', 'D', 'F'], importance: 0.78 },
        ],
      },
    ],
  ]), 920, {
    xZoomRatio: 0.5,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 800,
    yMedianTargetPx: 420,
  });

  const area = layout.summaryAreas.find((item) => item.summaryId === 'turn1_dense');
  const sparseTurn = layout.turns.find((item) => item.index === 0);
  const turn = layout.turns.find((item) => item.index === 1);
  assert.ok(area);
  assert.ok(sparseTurn);
  assert.ok(turn);

  const leadLengthsBySlot = new Map<number, { left?: number; right?: number }>();
  for (const track of area!.tracks) {
    for (const segment of track.segments) {
      if (segment.kind !== 'slot_horizontal') continue;
      const parsed = parseSlotLeadSegment(segment.id);
      if (!parsed) continue;
      const entry = leadLengthsBySlot.get(parsed.slotIndex) ?? {};
      entry[parsed.side] = Math.abs(segment.endX - segment.startX);
      leadLengthsBySlot.set(parsed.slotIndex, entry);
    }
  }

  const nodesBySlot = [...area!.nodes].sort((a, b) => a.x - b.x);
  assert.equal(leadLengthsBySlot.size, nodesBySlot.length);
  for (let slotIndex = 0; slotIndex < nodesBySlot.length; slotIndex += 1) {
    const node = nodesBySlot[slotIndex];
    const leadLengths = leadLengthsBySlot.get(slotIndex);
    assert.ok(leadLengths?.left != null && leadLengths?.right != null);
    const requiredLead = computeSlotSideLeadPx(node.width, node.height, layout.adaptiveProfile);
    assert.ok(
      (leadLengths.left ?? 0) + 1e-4 >= requiredLead,
      `expected left slot lead >= ${requiredLead}, received ${leadLengths.left}`
    );
    assert.ok(
      (leadLengths.right ?? 0) + 1e-4 >= requiredLead,
      `expected right slot lead >= ${requiredLead}, received ${leadLengths.right}`
    );
  }

  const baseTurnWidth = 520 * Math.max(Math.pow(0.5, 0.48), Math.pow(0.01, 0.48));
  assert.ok(
    turn!.xEnd - turn!.xStart > baseTurnWidth + 1,
    'expected low-zoom dense summary to widen its owning turn beyond the base turn width'
  );
  assert.ok(
    sparseTurn!.xEnd - sparseTurn!.xStart <= baseTurnWidth + 1e-4,
    'expected sparse low-demand turn to stay at the base turn width'
  );
  assert.ok(
    turn!.xEnd - turn!.xStart > sparseTurn!.xEnd - sparseTurn!.xStart + 1,
    'expected dense turn to remain wider than sparse turn'
  );
});

test('high-zoom wide summaries keep extra width in gutters instead of uniformly inflating slot widths', () => {
  const summarySpec: SummarySpec = {
    id: 'high_zoom_summary',
    shortLabel: 'This summary label is intentionally long so the area widens without needing wider slots',
    atomics: [
      { columns: ['A'], importance: 0.62 },
      { columns: ['A'], importance: 0.78 },
    ],
  };
  const localLayout = buildStorylineLayoutWithBoundaryContract(buildSingleSummaryRunState(summarySpec), 260, {
    yUpperBoundPx: 16,
    yLowerBoundPx: 242,
    yMedianTargetPx: 128,
    viewportWidthPx: 960,
    xZoomRatio: 1,
  });
  assert.ok(localLayout.solvedLayout);
  const sourceSlotWidths = localLayout.solvedLayout!.slots.map((slot) => slot.right - slot.left);
  const sourceInterspaceWidths = localLayout.solvedLayout!.interspaces.map((interspace) => interspace.right - interspace.left);

  const fullLayout = buildStorylineTurnConvergeLayout(buildTurnedRunState([[summarySpec]]), 920, {
    xZoomRatio: 2.4,
    viewportWidthPx: 1440,
    yUpperBoundPx: 24,
    yLowerBoundPx: 800,
    yMedianTargetPx: 420,
  });
  const area = fullLayout.summaryAreas.find((item) => item.summaryId === summarySpec.id);
  assert.ok(area);
  const mappedSlotWidths = extractMappedSlotWidths(area!);
  const mappedInterspaceWidths = extractMappedInterspaceWidths(area!);

  assert.equal(mappedSlotWidths.length, sourceSlotWidths.length);
  for (let index = 0; index < mappedSlotWidths.length; index += 1) {
    assert.ok(
      mappedSlotWidths[index] <= sourceSlotWidths[index] * 1.08 + 1e-4,
      `expected mapped slot ${index} to stay near its preferred width; source=${sourceSlotWidths[index]}, mapped=${mappedSlotWidths[index]}`
    );
  }
  assert.equal(mappedInterspaceWidths.length, sourceInterspaceWidths.length);
  for (let index = 0; index < mappedInterspaceWidths.length; index += 1) {
    assert.ok(
      mappedInterspaceWidths[index] + 1e-4 < sourceInterspaceWidths[index],
      `expected mapped interspace ${index} to tighten instead of preserving the full source gap; source=${sourceInterspaceWidths[index]}, mapped=${mappedInterspaceWidths[index]}`
    );
  }
  const totalMappedSlotWidth = mappedSlotWidths.reduce((sum, value) => sum + value, 0);
  assert.ok(
    area!.width > totalMappedSlotWidth + 60,
    'expected high-zoom extra width to remain mostly as gutter instead of stretching slots'
  );
});

test('turn layout preserves left-boundary column order without forcing summary-local anchor gaps to match converge gaps', () => {
  const runState = buildTurnedRunState([
    [
      {
        id: 'turn0_boundary',
        shortLabel: 'Boundary Source',
        atomics: [
          { columns: ['A'], importance: 0.35 },
          { columns: ['B'], importance: 0.55 },
          { columns: ['C'], importance: 0.75 },
        ],
      },
    ],
    [
      {
        id: 'turn1_target',
        shortLabel: 'Boundary Target',
        atomics: [
          { columns: ['A', 'B', 'C'], importance: 0.82 },
          { columns: ['A'], importance: 0.64 },
        ],
      },
    ],
  ]);

  for (const xZoomRatio of [0.5, 0.7, 1]) {
    const layout = buildStorylineTurnConvergeLayout(runState, 920, {
      xZoomRatio,
      viewportWidthPx: 1280,
      yUpperBoundPx: 24,
      yLowerBoundPx: 800,
      yMedianTargetPx: 420,
    });
    const leftConverge = layout.converges[1];
    const area = layout.summaryAreas.find((summaryArea) => summaryArea.summaryId === 'turn1_target');

    assert.ok(leftConverge);
    assert.ok(area);

    const orderedColumns = leftConverge!.lanes
      .map((lane) => lane.column)
      .filter((column) => Number.isFinite(area!.leftAnchorYByColumn[column]));
    assert.deepEqual(orderedColumns, ['A', 'B', 'C']);

    const gapDifferences: number[] = [];
    for (let index = 1; index < orderedColumns.length; index += 1) {
      const previousColumn = orderedColumns[index - 1];
      const column = orderedColumns[index];
      const previousLane = leftConverge!.lanes.find((lane) => lane.column === previousColumn);
      const lane = leftConverge!.lanes.find((lane) => lane.column === column);
      assert.ok(previousLane && lane);
      const convergeGap = lane!.y - previousLane!.y;
      const anchorGap = area!.leftAnchorYByColumn[column] - area!.leftAnchorYByColumn[previousColumn];
      assert.ok(anchorGap > 0, `expected a positive left-anchor gap for ${previousColumn}-${column} at zoom ${xZoomRatio}`);
      gapDifferences.push(Math.abs(anchorGap - convergeGap));
    }
    assert.ok(
      gapDifferences.some((difference) => difference > 1),
      `expected at least one left-anchor gap to stay summary-local instead of matching converge compaction at zoom ${xZoomRatio}`
    );
  }
});

test('boundary-window layout preserves summary-local spacing, summary-area gaps, and converge lane clearance', () => {
  const localRunState = buildSingleSummaryRunState({
    id: 'summary_spacing',
    shortLabel: 'Spacing',
    atomics: [
      { columns: ['A', 'B', 'C'], importance: 0.35 },
      { columns: ['A', 'C'], importance: 0.55 },
      { columns: ['B'], importance: 0.75 },
    ],
  });
  const localLayout = buildStorylineLayoutWithBoundaryContract(localRunState, 280, {
    yUpperBoundPx: 16,
    yLowerBoundPx: 254,
    yMedianTargetPx: 135,
    viewportWidthPx: 960,
    xZoomRatio: 1.2,
    boundaryContract: {
      leftPortColumnsInOrder: ['A', 'B', 'C'],
      leftPortTargetYByColumn: { A: 120, B: 170, C: 220 },
      leftPortMinGapPx: 18,
    },
  });
  assert.ok(localLayout.solvedLayout);
  const solved = localLayout.solvedLayout!;
  for (let slotIndex = 0; slotIndex < solved.yMatrix.length; slotIndex += 1) {
    const orderedColumns = solved.M_order[slotIndex]
      .map((rank, columnIndex) => ({ rank, columnIndex }))
      .sort((a, b) => a.rank - b.rank);
    for (let rank = 1; rank < orderedColumns.length; rank += 1) {
      const prevColumn = orderedColumns[rank - 1].columnIndex;
      const column = orderedColumns[rank].columnIndex;
      const gap = solved.yMatrix[slotIndex][column] - solved.yMatrix[slotIndex][prevColumn];
      assert.ok(gap >= solved.d1BySlot[slotIndex] - 1e-4);
    }
  }

  const layout = buildStorylineTurnConvergeLayout(buildTurnedRunState([
    [
      {
        id: 'turn0_a',
        shortLabel: 'Turn 0 A',
        atomics: [
          { columns: ['A', 'B'], importance: 0.4 },
          { columns: ['A'], importance: 0.55 },
        ],
      },
      {
        id: 'turn0_b',
        shortLabel: 'Turn 0 B',
        atomics: [
          { columns: ['B', 'C'], importance: 0.6 },
          { columns: ['C'], importance: 0.7 },
        ],
      },
    ],
    [
      {
        id: 'turn1_c',
        shortLabel: 'Turn 1 C',
        atomics: [
          { columns: ['A', 'C', 'D'], importance: 0.8 },
          { columns: ['B', 'D'], importance: 0.65 },
        ],
      },
    ],
  ]), 920, {
    xZoomRatio: 1.4,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 800,
    yMedianTargetPx: 420,
  });

  const turnZeroAreas = layout.summaryAreas
    .filter((area) => area.turnIndex === 0)
    .sort((a, b) => a.top - b.top);
  assert.equal(turnZeroAreas.length, 2);
  assert.ok(turnZeroAreas[1].top - turnZeroAreas[0].bottom >= 4);

  for (const converge of layout.converges) {
    const lanes = [...converge.lanes].sort((a, b) => a.y - b.y);
    for (let index = 1; index < lanes.length; index += 1) {
      const gap = lanes[index].y - lanes[index - 1].y;
      const requiredGap = Math.min(
        lanes[index - 1].indicatorRequiredClearancePx || gap,
        lanes[index].indicatorRequiredClearancePx || gap,
      );
      assert.ok(gap >= Math.max(12, requiredGap) - 1e-4);
    }
  }
});

test('indicator labels stay non-overlapping and clear of markers across zoom levels', () => {
  const runState = buildTurnedRunState([
    [
      {
        id: 'long_turn0',
        shortLabel: 'Long 0',
        atomics: [
          { columns: ['Average Order Value', 'Gross Margin Percentage'], importance: 0.45 },
          { columns: ['Net Promoter Score'], importance: 0.65 },
        ],
      },
    ],
    [
      {
        id: 'long_turn1',
        shortLabel: 'Long 1',
        atomics: [
          { columns: ['Average Order Value', 'Customer Lifetime Value'], importance: 0.7 },
          { columns: ['Gross Margin Percentage'], importance: 0.55 },
          { columns: ['Net Promoter Score'], importance: 0.8 },
        ],
      },
    ],
  ]);

  for (const xZoomRatio of [0.5, 2]) {
    const layout = buildStorylineTurnConvergeLayout(runState, 940, {
      xZoomRatio,
      viewportWidthPx: 1680,
      yUpperBoundPx: 24,
      yLowerBoundPx: 820,
      yMedianTargetPx: 420,
    });
    const indicatorTracks = buildConvergeIndicatorTracks(
      layout,
      new Set(layout.converges.map((converge) => converge.index))
    );
    const labels = buildVisibleTrackLabels(
      indicatorTracks,
      layout.nodes,
      { zoomX: xZoomRatio, tx: 0, ty: 0 },
      { width: 3200, height: 1400 },
      { labelScale: layout.adaptiveProfile.labelScale }
    );
    const trackById = new Map(indicatorTracks.map((track) => [track.id, track]));

    for (let index = 0; index < labels.length; index += 1) {
      const current = labels[index];
      const currentBox = {
        left: current.x - current.width / 2,
        right: current.x + current.width / 2,
        top: current.top,
        bottom: current.top + current.height,
      };
      for (let nextIndex = index + 1; nextIndex < labels.length; nextIndex += 1) {
        const next = labels[nextIndex];
        const nextBox = {
          left: next.x - next.width / 2,
          right: next.x + next.width / 2,
          top: next.top,
          bottom: next.top + next.height,
        };
        assert.equal(boxesOverlap(currentBox, nextBox), false);
      }

      const track = trackById.get(current.id);
      if (track?.indicatorMustStayBelowAnchor && typeof track.indicatorAnchorClearancePx === 'number') {
        assert.ok(current.top >= current.anchorY + track.indicatorAnchorClearancePx - 1e-4);
      }
    }
  }
});

test('first window special rule builds converge0 from solved turn0 left-port order', () => {
  const layout = buildStorylineTurnConvergeLayout(buildTurnedRunState([
    [
      {
        id: 'turn0_first',
        shortLabel: 'First',
        atomics: [
          { columns: ['B', 'A'], importance: 0.35 },
          { columns: ['A'], importance: 0.45 },
        ],
      },
      {
        id: 'turn0_second',
        shortLabel: 'Second',
        atomics: [
          { columns: ['C', 'B'], importance: 0.65 },
          { columns: ['D'], importance: 0.85 },
        ],
      },
    ],
    [
      {
        id: 'turn1_followup',
        shortLabel: 'Followup',
        atomics: [
          { columns: ['A', 'D'], importance: 0.75 },
        ],
      },
    ],
  ]), 920, {
    xZoomRatio: 1.1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 800,
    yMedianTargetPx: 420,
  });

  const expectedConvergeZeroOrder: string[] = [];
  const seen = new Set<string>();
  for (const area of layout.summaryAreas
    .filter((summaryArea) => summaryArea.turnIndex === 0)
    .sort((a, b) => a.top - b.top)) {
    for (const [column] of Object.entries(area.leftAnchorYByColumn).sort((a, b) => a[1] - b[1])) {
      if (seen.has(column)) continue;
      seen.add(column);
      expectedConvergeZeroOrder.push(column);
    }
  }

  assert.deepEqual(layout.converges[0]?.lanes.map((lane) => lane.column), expectedConvergeZeroOrder);
});

test('turn0 converge0 stays centered near the solved turn0 left-anchor band after clearance re-spacing', () => {
  const layout = buildStorylineTurnConvergeLayout(buildTurnedRunState([
    [
      {
        id: 'turn0_summary_0',
        shortLabel: 'Score and completeness',
        atomics: [
          { columns: ['gameid'], importance: 0.532 },
          { columns: ['home_score', 'visitor_score'], importance: 0.56 },
          { columns: ['home_score', 'visitor_score'], importance: 0.344 },
        ],
      },
      {
        id: 'turn0_summary_1',
        shortLabel: 'Ball space and status',
        atomics: [
          { columns: ['ball_status'], importance: 0.642 },
          { columns: ['ball_x', 'ball_y'], importance: 0.426 },
          { columns: ['ball_z'], importance: 0.394 },
        ],
      },
      {
        id: 'turn0_summary_2',
        shortLabel: 'Player movement',
        atomics: [
          { columns: ['player_1_x', 'player_1_y', 'player_2_x', 'player_2_y'], importance: 0.48 },
          { columns: ['player_1_player_name', 'player_2_player_name'], importance: 0.42 },
        ],
      },
      {
        id: 'turn0_summary_3',
        shortLabel: 'Events and possessions',
        atomics: [
          { columns: ['event_result'], importance: 0.574 },
          { columns: ['possession_start_index', 'possession_end_index'], importance: 0.44 },
          { columns: ['event_result', 'visitor_score', 'home_score'], importance: 0.356 },
        ],
      },
    ],
  ]), 1000, {
    xZoomRatio: 1,
    viewportWidthPx: 683,
    yUpperBoundPx: 24,
    yLowerBoundPx: 980,
    yMedianTargetPx: 502,
  });

  const converge0 = layout.converges[0];
  const turn0Areas = layout.summaryAreas
    .filter((area) => area.turnIndex === 0)
    .sort((a, b) => a.top - b.top);
  assert.ok(converge0);
  assert.equal(turn0Areas.length, 4);

  const anchorValues = turn0Areas.flatMap((area) => Object.values(area.leftAnchorYByColumn));
  const laneValues = converge0!.lanes.map((lane) => lane.y);
  assert.ok(anchorValues.length > 0);
  assert.ok(laneValues.length > 0);

  const anchorCenter = (Math.min(...anchorValues) + Math.max(...anchorValues)) / 2;
  const laneCenter = (Math.min(...laneValues) + Math.max(...laneValues)) / 2;
  assert.ok(
    Math.abs(laneCenter - anchorCenter) <= 24,
    'expected converge0 lane band to stay centered near turn0 left anchors; anchorCenter='
      + String(anchorCenter)
      + ', laneCenter='
      + String(laneCenter)
  );
});

test('joining a create-style active plan keeps the solved summary band stable and places the plan into remaining turn space', () => {
  const turnSpecs: SummarySpec[][] = [
    [
      {
        id: 'joined_turn_top',
        shortLabel: 'Joined turn top',
        atomics: [
          { columns: ['hot_degree', 'status_type'], importance: 0.68 },
          { columns: ['verified'], importance: 0.52 },
        ],
      },
      {
        id: 'joined_turn_bottom',
        shortLabel: 'Joined turn bottom',
        atomics: [
          { columns: ['hot_degree', 'statuses_count'], importance: 0.74 },
          { columns: ['media_count'], importance: 0.48 },
        ],
      },
    ],
  ];
  const baseRunState = buildTurnedRunState(turnSpecs);
  const joinedRunState = buildRunStateWithJoinedActivePlan({
    turnSpecs,
    turnIndex: 0,
    planId: 'plan:create_joined',
    text: 'Inspect statuses_count around hot_degree.',
    shortLabel: 'Inspect statuses_count',
  });
  const layoutOptions = {
    xZoomRatio: 1,
    viewportWidthPx: 1280,
    yUpperBoundPx: 24,
    yLowerBoundPx: 780,
    yMedianTargetPx: 402,
  } as const;
  const baseLayout = buildStorylineTurnConvergeLayout(baseRunState, 920, layoutOptions);
  const joinedLayout = buildStorylineTurnConvergeLayout(joinedRunState, 920, layoutOptions);

  const baseAreasById = new Map(
    baseLayout.summaryAreas.map((area) => [area.summaryId, area])
  );
  for (const joinedArea of joinedLayout.summaryAreas) {
    const baseArea = baseAreasById.get(joinedArea.summaryId);
    assert.ok(baseArea, `missing baseline summary area for ${joinedArea.summaryId}`);
    assert.equal(joinedArea.top, baseArea!.top);
    assert.equal(joinedArea.bottom, baseArea!.bottom);
  }

  assert.equal(joinedLayout.activePlanAreas.length, 1);
  const joinedPlanArea = joinedLayout.activePlanAreas[0]!;
  const sameTurnSummaryAreas = joinedLayout.summaryAreas.filter((area) => area.turnIndex === joinedPlanArea.turnIndex);
  assert.equal(joinedPlanArea.turnIndex, 0);
  assert.equal(
    boxesOverlap(joinedPlanArea, sameTurnSummaryAreas[0]!)
      || boxesOverlap(joinedPlanArea, sameTurnSummaryAreas[1]!),
    false
  );
  const maxSummaryBottom = Math.max(...sameTurnSummaryAreas.map((area) => area.bottom));
  assert.ok(
    joinedPlanArea.top >= maxSummaryBottom,
    `expected joined active plan to use remaining space below solved summaries; planTop=${joinedPlanArea.top}, summaryBottom=${maxSummaryBottom}`
  );
});

test('final layout vertically centers each solved turn and converge band within the available window across zoom levels', () => {
  const yUpperBoundPx = 24;
  const yLowerBoundPx = 800;
  const expectedCenter = (yUpperBoundPx + yLowerBoundPx) / 2;
  const runState = buildTurnedRunState([
    [
      {
        id: 'center_turn0_top',
        shortLabel: 'Top group',
        atomics: [
          { columns: ['A'], importance: 0.35 },
          { columns: ['A', 'B'], importance: 0.52 },
        ],
      },
      {
        id: 'center_turn0_bottom',
        shortLabel: 'Bottom group',
        atomics: [
          { columns: ['C'], importance: 0.68 },
          { columns: ['B', 'C'], importance: 0.74 },
        ],
      },
    ],
    [
      {
        id: 'center_turn1_joined',
        shortLabel: 'Joined followup',
        atomics: [
          { columns: ['A', 'B', 'C'], importance: 0.81 },
          { columns: ['B'], importance: 0.57 },
        ],
      },
    ],
  ]);

  for (const xZoomRatio of [0.35, 0.8, 2.1]) {
    const layout = buildStorylineTurnConvergeLayout(runState, 920, {
      xZoomRatio,
      viewportWidthPx: 1280,
      yUpperBoundPx,
      yLowerBoundPx,
      yMedianTargetPx: 260,
    });
    const { minY, maxY } = extractTurnConvergeContentBounds(layout);
    assert.ok(minY >= yUpperBoundPx - 1e-4, `expected centered content to stay within top bound at zoom ${xZoomRatio}`);
    assert.ok(maxY <= yLowerBoundPx + 1e-4, `expected centered content to stay within bottom bound at zoom ${xZoomRatio}`);

    for (const turn of layout.turns) {
      const turnAreas = layout.summaryAreas.filter((area) => area.turnIndex === turn.index);
      const turnPlans = layout.activePlanAreas.filter((area) => area.turnIndex === turn.index);
      if (turnAreas.length === 0 && turnPlans.length === 0) continue;
      const turnValues = extractTurnConvergeContentBounds({
        ...layout,
        summaryAreas: turnAreas,
        activePlanAreas: turnPlans,
        converges: [],
        boundaryBranches: [],
      });
      const turnCenter = (turnValues.minY + turnValues.maxY) / 2;
      assert.ok(
        Math.abs(turnCenter - expectedCenter) <= 1e-4,
        `expected turn ${turn.index} center ${turnCenter} to match window center ${expectedCenter} at zoom ${xZoomRatio}`
      );
    }

    for (const converge of layout.converges) {
      if (converge.lanes.length === 0) continue;
      const convergeValues = extractTurnConvergeContentBounds({
        ...layout,
        summaryAreas: [],
        activePlanAreas: [],
        converges: [converge],
        boundaryBranches: [],
      });
      const convergeCenter = (convergeValues.minY + convergeValues.maxY) / 2;
      assert.ok(
        Math.abs(convergeCenter - expectedCenter) <= 1e-4,
        `expected converge ${converge.index} center ${convergeCenter} to match window center ${expectedCenter} at zoom ${xZoomRatio}`
      );
    }
  }
});
