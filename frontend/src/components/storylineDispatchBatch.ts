import type { DispatchBatchState, PlanItem, RunState } from '@/types';

export interface DispatchBatchPlanDropTarget {
  planId: string;
  position: 'before' | 'after';
}

export function isNonterminalPlanStatus(status: PlanItem['status'] | undefined): boolean {
  return (
    status === 'pending'
    || status === 'analyzing'
    || status === 'summarizing'
    || status === 'paused'
  );
}

export function getBatchNonterminalPlanIds(
  runState: RunState | null | undefined,
  batch: DispatchBatchState | null | undefined
): string[] {
  if (!runState || !batch) {
    return [];
  }
  const planById = new Map(runState.frontier.map((plan) => [plan.plan_id, plan]));
  return (batch.plan_ids ?? []).filter((planId) => isNonterminalPlanStatus(planById.get(planId)?.status));
}

export function getLatestUnresolvedDispatchBatch(
  runState: RunState | null | undefined
): DispatchBatchState | null {
  if (!runState) {
    return null;
  }
  const batches = runState.master_agent_state?.dispatch_batches ?? [];
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (getBatchNonterminalPlanIds(runState, batch).length > 0) {
      return batch;
    }
  }
  return null;
}

export function getLiveDispatchPlanIds(args: {
  entryPlanIds?: string[];
  dispatchTurnIndex?: number;
  runState?: RunState | null;
}): string[] {
  const { entryPlanIds = [], dispatchTurnIndex, runState } = args;
  if (runState && typeof dispatchTurnIndex === 'number') {
    const batch = (runState.master_agent_state?.dispatch_batches ?? []).find(
      (item) => item.dispatch_turn_index === dispatchTurnIndex
    );
    if (batch && Array.isArray(batch.plan_ids) && batch.plan_ids.length > 0) {
      return batch.plan_ids.map((planId) => String(planId));
    }
  }
  return entryPlanIds.map((planId) => String(planId));
}
