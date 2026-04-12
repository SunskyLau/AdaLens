import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { ConversationEntry, PlanItem, RunState, Summary } from '@/types';
import { getLiveDispatchPlanIds } from '@/components/storylineDispatchBatch';
import PlanDispatchCard, {
  isActivePlanStatus,
} from './PlanDispatchCard';

function getPlan(planId: string, runState: RunState | null): PlanItem | undefined {
  return runState?.frontier.find((plan) => plan.plan_id === planId);
}

function buildElapsedSecondsByPlan(
  planIds: string[],
  runState: RunState | null,
  dispatchTimestamp: string,
  nowMs: number
): Map<string, number> {
  const startedAt = Date.parse(dispatchTimestamp);
  if (!Number.isFinite(startedAt)) {
    return new Map();
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const elapsedByPlan = new Map<string, number>();
  for (const planId of planIds) {
    const plan = getPlan(planId, runState);
    if (isActivePlanStatus(plan?.status)) {
      elapsedByPlan.set(planId, elapsedSeconds);
    }
  }
  return elapsedByPlan;
}

export { getPlan, isActivePlanStatus };

export function shouldCollapsePlanDetailsByDefault(
  status: PlanItem['status'] | undefined
): boolean {
  return status === 'completed' || status === 'failed' || status === 'terminated';
}

export default function PlansDispatchedEntry({
  entry,
  runState,
  planInsights,
  onSelectPlan,
  onSelectInsight,
  selectedPlanId = null,
  selectedSummaryId,
}: {
  entry: ConversationEntry;
  runState: RunState | null;
  planInsights: Map<string, Summary[]>;
  onSelectPlan: (planId: string) => void;
  onSelectInsight: (insightId: string) => void;
  selectedPlanId?: string | null;
  selectedSummaryId: string | null;
}) {
  const planIds = useMemo(
    () => getLiveDispatchPlanIds({
      entryPlanIds: entry.planIds ?? [],
      dispatchTurnIndex: entry.dispatchTurnIndex,
      runState,
    }),
    [entry.dispatchTurnIndex, entry.planIds, runState]
  );
  const hasActivePlans = useMemo(
    () => planIds.some((planId) => isActivePlanStatus(getPlan(planId, runState)?.status)),
    [planIds, runState]
  );
  const [now, setNow] = useState(() => Date.now());
  const [manuallyExpandedPlanIds, setManuallyExpandedPlanIds] = useState<Set<string>>(() => new Set());
  const [manuallyCollapsedPlanIds, setManuallyCollapsedPlanIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setNow(Date.now());
    if (!hasActivePlans) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [entry.timestamp, hasActivePlans, planIds, runState]);

  useEffect(() => {
    setManuallyExpandedPlanIds((current) => {
      const next = new Set([...current].filter((planId) => planIds.includes(planId)));
      if (next.size === current.size) {
        let changed = false;
        for (const planId of next) {
          if (!current.has(planId)) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          return current;
        }
      }
      return next;
    });
    setManuallyCollapsedPlanIds((current) => {
      const next = new Set([...current].filter((planId) => planIds.includes(planId)));
      if (next.size === current.size) {
        let changed = false;
        for (const planId of next) {
          if (!current.has(planId)) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          return current;
        }
      }
      return next;
    });
  }, [planIds]);

  const elapsedByPlan = useMemo(
    () => buildElapsedSecondsByPlan(planIds, runState, entry.timestamp, now),
    [entry.timestamp, now, planIds, runState]
  );

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-emerald-50 p-1.5 text-emerald-600">
          <ArrowUpRight className="h-3.5 w-3.5" />
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Sub-Agents Dispatched
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {planIds.length} dispatch target(s)
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {planIds.map((planId) => {
          const plan = getPlan(planId, runState);
          const insights = planInsights.get(planId) ?? [];
          const elapsedSeconds = elapsedByPlan.get(planId);
          const hasSelectedSummary =
            insights.some((insight) => insight.insight_id === selectedSummaryId);
          const isCollapsible = shouldCollapsePlanDetailsByDefault(plan?.status);
          const isManuallyCollapsed = manuallyCollapsedPlanIds.has(planId);
          const isDetailExpanded =
            !isCollapsible
            || (
              !isManuallyCollapsed && (
                selectedPlanId === planId
                || hasSelectedSummary
                || manuallyExpandedPlanIds.has(planId)
              )
            );
          return (
            <PlanDispatchCard
              key={planId}
              planId={planId}
              plan={plan}
              elapsedSeconds={elapsedSeconds}
              selected={selectedPlanId === planId}
              showChatDetails={isDetailExpanded}
              canToggleChatDetails={isCollapsible}
              onToggleChatDetails={() => {
                if (isDetailExpanded) {
                  setManuallyExpandedPlanIds((current) => {
                    if (!current.has(planId)) {
                      return current;
                    }
                    const next = new Set(current);
                    next.delete(planId);
                    return next;
                  });
                  setManuallyCollapsedPlanIds((current) => {
                    if (current.has(planId)) {
                      return current;
                    }
                    const next = new Set(current);
                    next.add(planId);
                    return next;
                  });
                  return;
                }
                setManuallyCollapsedPlanIds((current) => {
                  if (!current.has(planId)) {
                    return current;
                  }
                  const next = new Set(current);
                  next.delete(planId);
                  return next;
                });
                setManuallyExpandedPlanIds((current) => {
                  if (current.has(planId)) {
                    return current;
                  }
                  const next = new Set(current);
                  next.add(planId);
                  return next;
                });
              }}
              onSelect={() => onSelectPlan(planId)}
            >
              {isDetailExpanded && insights.length > 0 ? (
                <div className="mt-2.5 space-y-2 border-t border-slate-200 pt-2.5">
                  {insights.map((insight) => {
                    const isSelected = selectedSummaryId === insight.insight_id;
                    return (
                      <button
                        type="button"
                        key={insight.insight_id}
                        data-summary-anchor-id={insight.insight_id}
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => onSelectInsight(insight.insight_id)}
                        className={[
                          'block w-full rounded-md px-3 py-2 text-left shadow-sm transition',
                          isSelected
                            ? 'border border-sky-300 bg-sky-50 ring-2 ring-sky-200/70'
                            : 'border border-transparent bg-white hover:bg-slate-50',
                        ].join(' ')}
                      >
                        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                          Summary
                        </div>
                        <div className="mt-1 text-sm text-slate-600">
                          {insight.summary}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </PlanDispatchCard>
          );
        })}
      </div>
    </div>
  );
}
