/**
 * Inspector Component
 *
 * Context panel showing details of the selected item:
 * - Plan view: analysis task + full analysis stream (single flow)
 * - Summary view: summary text with atomic insight cards and evidence
 */

import { Lightbulb } from 'lucide-react';
import { shallow } from 'zustand/shallow';
import { useStore } from '@/store/useStore';
import type { PlanLiveState } from '@/types';
import type {
  StorylineFilterSnapshot,
  StorylineInspectorFilterOverride,
} from './storylineFilter';
import FilterResultsInspector from './InspectorFilterResults';
import InsightInspector from './InspectorInsight';
import CoverageCellInspector from './InspectorCoverageCell';
import PlanInspector from './InspectorPlan';

interface InspectorProps {
  runId: string;
  storylineFilter?: Pick<StorylineFilterSnapshot, 'inspectorOverride'> | null;
}

type InspectorViewportMode = 'idle' | 'summary' | 'insight' | 'plan' | 'coverage_cell' | 'filter_results';

export type InspectorFilterOverride = StorylineInspectorFilterOverride;

const INSPECTOR_VIEWPORT_BASE_CLASS_NAME = 'h-full min-h-0';
const PLAN_INSPECTOR_VIEWPORT_CLASS_NAME = `${INSPECTOR_VIEWPORT_BASE_CLASS_NAME} overflow-hidden`;
const SCROLLING_INSPECTOR_VIEWPORT_CLASS_NAME = `${INSPECTOR_VIEWPORT_BASE_CLASS_NAME} overflow-auto`;
const PLAN_STREAM_BLOCK_CONTAINER_CLASS_NAME = 'flex-1 min-h-0 overflow-auto pr-1 space-y-3';

function getInspectorViewportClassName(mode: InspectorViewportMode): string {
  return mode === 'plan'
    ? PLAN_INSPECTOR_VIEWPORT_CLASS_NAME
    : SCROLLING_INSPECTOR_VIEWPORT_CLASS_NAME;
}

function getPlanStreamBlockContainerClassName(): string {
  return PLAN_STREAM_BLOCK_CONTAINER_CLASS_NAME;
}

export {
  default as InsightInspector,
} from './InspectorInsight';

export {
  sortFilterResultsEntries,
  type FilterResultsSortOrder,
} from './inspectorShared';

export default function Inspector({ runId, storylineFilter = null }: InspectorProps) {
  const {
    runState,
    selection,
    getInsightById,
    getPlanById,
    getExecutionByPlanId,
    addBookmark,
    removeBookmark,
    bookmarks,
    getPlanLogs,
  } = useStore(
    (state) => ({
      runState: state.runState,
      selection: state.selection,
      getInsightById: state.getInsightById,
      getPlanById: state.getPlanById,
      getExecutionByPlanId: state.getExecutionByPlanId,
      addBookmark: state.addBookmark,
      removeBookmark: state.removeBookmark,
      bookmarks: state.bookmarks,
      getPlanLogs: state.getPlanLogs,
    }),
    shallow
  );
  const filterOverride = storylineFilter?.inspectorOverride ?? null;

  if (filterOverride && filterOverride.selectedCells.length > 0) {
    return (
      <div className={getInspectorViewportClassName('filter_results')}>
        <FilterResultsInspector
          runId={runId}
          selectedCells={filterOverride.selectedCells}
          entries={filterOverride.entries}
        />
      </div>
    );
  }

  if (!selection.type || !selection.id) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <div className="p-8 text-center">
          <Lightbulb className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p className="text-sm">Select an item to inspect</p>
        </div>
      </div>
    );
  }

  if (!runId) {
    return <div className="p-4 text-slate-500">Run context unavailable</div>;
  }

  if (selection.type === 'summary' || selection.type === 'insight') {
    const insight = getInsightById(selection.id);
    if (!insight) return <div className="p-4 text-slate-500">Summary node not found</div>;

    const plan = getPlanById(insight.plan_id);
    const existingBookmark = bookmarks.find((bookmark) => bookmark.insight_id === insight.insight_id);
    const isBookmarked = !!existingBookmark;

    return (
      <div className={getInspectorViewportClassName(selection.type)}>
        <InsightInspector
          key={`${runId || 'run'}:${insight.insight_id}:${selection.atomicId || 'all'}`}
          runId={runId}
          insight={insight}
          plan={plan}
          selectedAtomicId={selection.atomicId}
          isBookmarked={isBookmarked}
          onBookmark={() => {
            if (existingBookmark) {
              removeBookmark(existingBookmark.id);
              return;
            }
            if (!isBookmarked) {
              addBookmark({
                id: `bookmark_${Date.now()}`,
                insight_id: insight.insight_id,
                note: '',
                created_at: new Date().toISOString(),
              });
            }
          }}
        />
      </div>
    );
  }

  if (selection.type === 'plan') {
    const plan = getPlanById(selection.id);
    if (!plan) return <div className="p-4 text-slate-500">Plan not found</div>;

    const execution = getExecutionByPlanId(plan.plan_id);
    const planLogs = getPlanLogs(plan.plan_id) as PlanLiveState | undefined;

    return (
      <div className={getInspectorViewportClassName('plan')}>
        <PlanInspector
          runId={runId}
          plan={plan}
          execution={execution}
          planLogs={planLogs}
          planStreamBlockContainerClassName={getPlanStreamBlockContainerClassName()}
        />
      </div>
    );
  }

  if (selection.type === 'coverage_cell') {
    if (!runState) return <div className="p-4 text-slate-500">Run not loaded</div>;
    return (
      <div className={getInspectorViewportClassName('coverage_cell')}>
        <CoverageCellInspector
          runId={runId}
          runState={runState}
          cellId={selection.id}
        />
      </div>
    );
  }

  return null;
}
