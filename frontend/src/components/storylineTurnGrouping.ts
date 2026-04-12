import type { Event, RunState, Summary } from '@/types';

export interface StorylineTurnGrouping {
  planTurnIndexByPlanId: Map<string, number>;
  summaryTurnIndexByInsightId: Map<string, number>;
  replaySummaryIds: string[];
  dispatchTurnCount: number;
  turnCount: number;
  fallbackThresholdMs: number;
}

interface TimedEvent {
  event: Event;
  index: number;
  timestampMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toTimestampMs(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function sortEventsByTimestamp(events: Event[]): TimedEvent[] {
  return events
    .map((event, index) => ({
      event,
      index,
      timestampMs: toTimestampMs(event.timestamp),
    }))
    .sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
      return a.index - b.index;
    });
}

function extractDispatchBatch(event: Event): { planIds: string[]; dispatchTurnIndex: number | null } | null {
  if (event.event_type !== 'master_agent_tool_result') return null;
  const data = event.data as { tool_name?: unknown; result?: unknown };
  if (data?.tool_name !== 'dispatch_plans') return null;
  const result = data.result as { plan_ids?: unknown; dispatched_plan_ids?: unknown } | null;
  const rawPlanIds = Array.isArray(result?.plan_ids)
    ? result.plan_ids
    : Array.isArray(result?.dispatched_plan_ids)
      ? result.dispatched_plan_ids
      : null;
  if (!rawPlanIds) return null;
  return {
    planIds: rawPlanIds.map((item) => String(item)).filter(Boolean),
    dispatchTurnIndex:
      typeof (result as { dispatch_turn_index?: unknown }).dispatch_turn_index === 'number'
        ? (result as { dispatch_turn_index: number }).dispatch_turn_index
        : null,
  };
}

function extractInsightId(event: Event): string | null {
  if (event.event_type !== 'insight_extracted') return null;
  const data = event.data as { insight_id?: unknown };
  if (typeof data?.insight_id !== 'string' || !data.insight_id) return null;
  return data.insight_id;
}

function collectCompletedSummaries(runState: RunState): Summary[] {
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  return runState.insights.filter((summary) => {
    const plan = planById.get(summary.plan_id);
    if (!plan) return true;
    return plan.status === 'completed';
  });
}

export function buildStorylineTurnGrouping(
  runState: RunState,
  events: Event[]
): StorylineTurnGrouping {
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  const summaries = collectCompletedSummaries(runState);
  const summaryById = new Map(summaries.map((summary) => [summary.insight_id, summary]));
  const timedEvents = sortEventsByTimestamp(events);

  const planTurnIndexByPlanId = new Map<string, number>();
  let nextImplicitDispatchTurnIndex = 0;
  let maxDispatchTurnIndex = -1;
  for (const timed of timedEvents) {
    const batch = extractDispatchBatch(timed.event);
    if (!batch || batch.planIds.length === 0) continue;
    const dispatchTurnIndex =
      batch.dispatchTurnIndex ?? nextImplicitDispatchTurnIndex;
    for (const planId of batch.planIds) {
      if (!planTurnIndexByPlanId.has(planId)) {
        planTurnIndexByPlanId.set(planId, dispatchTurnIndex);
      }
    }
    maxDispatchTurnIndex = Math.max(maxDispatchTurnIndex, dispatchTurnIndex);
    nextImplicitDispatchTurnIndex = Math.max(nextImplicitDispatchTurnIndex, dispatchTurnIndex + 1);
  }

  // Live dispatch batch state is the canonical turn-membership source once it
  // reaches the frontend. This is required for plans later appended into an
  // existing batch, such as create-steering work that joins the latest
  // unresolved batch without emitting a new dispatch_plans event.
  for (const batch of runState.master_agent_state?.dispatch_batches ?? []) {
    if (typeof batch.dispatch_turn_index !== 'number') {
      continue;
    }
    maxDispatchTurnIndex = Math.max(maxDispatchTurnIndex, batch.dispatch_turn_index);
    for (const rawPlanId of batch.plan_ids ?? []) {
      const planId = String(rawPlanId).trim();
      if (!planId) {
        continue;
      }
      planTurnIndexByPlanId.set(planId, batch.dispatch_turn_index);
    }
  }
  const dispatchTurnCount = maxDispatchTurnIndex + 1;

  const missingPlanIds = [...new Set(
    summaries
      .map((summary) => summary.plan_id)
      .filter((planId) => !planTurnIndexByPlanId.has(planId))
  )];
  const missingPlans = missingPlanIds.map((planId) => {
    const plan = planById.get(planId);
    const summaryTimestamps = summaries
      .filter((summary) => summary.plan_id === planId)
      .map((summary) => toTimestampMs(summary.created_at))
      .filter((timestamp) => timestamp > 0);
    const summaryTimestamp = summaryTimestamps.length > 0 ? Math.min(...summaryTimestamps) : 0;
    const planTimestamp = toTimestampMs(plan?.created_at);
    return {
      planId,
      timestampMs: summaryTimestamp || planTimestamp,
    };
  }).sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    return a.planId.localeCompare(b.planId);
  });

  const missingDiffs: number[] = [];
  for (let index = 1; index < missingPlans.length; index += 1) {
    const diff = missingPlans[index].timestampMs - missingPlans[index - 1].timestampMs;
    if (diff > 0) missingDiffs.push(diff);
  }
  const medianDiff = median(missingDiffs);
  const fallbackThresholdMs =
    medianDiff > 0 ? clamp(2.5 * medianDiff, 3_000, 120_000) : 3_000;

  let fallbackGroup = 0;
  for (let index = 0; index < missingPlans.length; index += 1) {
    if (index > 0) {
      const prev = missingPlans[index - 1];
      const current = missingPlans[index];
      if (current.timestampMs - prev.timestampMs > fallbackThresholdMs) {
        fallbackGroup += 1;
      }
    }
    planTurnIndexByPlanId.set(
      missingPlans[index].planId,
      dispatchTurnCount + fallbackGroup
    );
  }

  const summaryTurnIndexByInsightId = new Map<string, number>();
  for (const summary of summaries) {
    const planTurnIndex = planTurnIndexByPlanId.get(summary.plan_id);
    if (typeof planTurnIndex === 'number') {
      summaryTurnIndexByInsightId.set(summary.insight_id, planTurnIndex);
    }
  }

  const replaySummaryIds: string[] = [];
  const seenSummaryIds = new Set<string>();
  for (const timed of timedEvents) {
    const insightId = extractInsightId(timed.event);
    if (!insightId || seenSummaryIds.has(insightId) || !summaryById.has(insightId)) continue;
    seenSummaryIds.add(insightId);
    replaySummaryIds.push(insightId);
  }
  const unresolvedSummaries = summaries
    .filter((summary) => !seenSummaryIds.has(summary.insight_id))
    .sort((a, b) => {
      const aTs = toTimestampMs(a.created_at) || toTimestampMs(planById.get(a.plan_id)?.created_at);
      const bTs = toTimestampMs(b.created_at) || toTimestampMs(planById.get(b.plan_id)?.created_at);
      if (aTs !== bTs) return aTs - bTs;
      return a.insight_id.localeCompare(b.insight_id);
    });
  for (const summary of unresolvedSummaries) {
    replaySummaryIds.push(summary.insight_id);
  }

  const maxTurnIndex = (() => {
    const values = [...summaryTurnIndexByInsightId.values()];
    if (values.length === 0) return -1;
    return Math.max(...values);
  })();
  const turnCount = Math.max(dispatchTurnCount, maxTurnIndex + 1);

  return {
    planTurnIndexByPlanId,
    summaryTurnIndexByInsightId,
    replaySummaryIds,
    dispatchTurnCount,
    turnCount,
    fallbackThresholdMs,
  };
}
