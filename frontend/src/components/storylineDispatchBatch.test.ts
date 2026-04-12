import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBatchNonterminalPlanIds,
  getLatestUnresolvedDispatchBatch,
  getLiveDispatchPlanIds,
} from './storylineDispatchBatch';
import type { RunState } from '@/types';

function makeRunState(): RunState {
  return {
    run_id: 'run_dispatch_batch',
    dataset_path: 'data/test.csv',
    dataset_info: { rows: 3, columns: [], sample_rows: [] },
    dataset_schema: 'Columns: ["A","B"]',
    step: 2,
    failure_count: 0,
    status: 'running',
    budgets: {
      max_steps: 10,
      max_depth: 2,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 2,
      max_attempts_per_plan: 2,
    },
    frontier: [
      {
        plan_id: 'plan_1',
        kind: 'analysis',
        text: 'Plan 1',
        filters: [],
        status: 'completed',
        parent_insight_id: null,
        created_at: '2026-03-01T00:00:00Z',
      },
      {
        plan_id: 'plan_2',
        kind: 'analysis',
        text: 'Plan 2',
        filters: [],
        status: 'terminated',
        parent_insight_id: null,
        created_at: '2026-03-01T00:00:01Z',
      },
      {
        plan_id: 'plan_3',
        kind: 'analysis',
        text: 'Plan 3',
        filters: [],
        status: 'paused',
        parent_insight_id: null,
        created_at: '2026-03-01T00:00:02Z',
      },
      {
        plan_id: 'plan_4',
        kind: 'analysis',
        text: 'Plan 4',
        filters: [],
        status: 'pending',
        parent_insight_id: null,
        created_at: '2026-03-01T00:00:03Z',
      },
    ],
    insights: [],
    execution_records: [],
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    master_agent_state: {
      current_goals: ['Goal'],
      active_plan_ids: ['plan_3'],
      completed_plan_ids: ['plan_1'],
      all_insight_ids: [],
      dispatch_batches: [
        {
          dispatch_turn_index: 0,
          plan_ids: ['plan_1', 'plan_2'],
          status: 'no_summary',
          stage_summary_emitted: false,
          stage_summary_markdown: '',
          stage_summary_citations: [],
        },
        {
          dispatch_turn_index: 1,
          plan_ids: ['plan_4', 'plan_3'],
          status: 'dispatched',
          stage_summary_emitted: false,
          stage_summary_markdown: '',
          stage_summary_citations: [],
        },
      ],
      message_history: [],
      loop_count: 0,
      completed: false,
    },
  };
}

test('storylineDispatchBatch resolves the latest unresolved batch and preserves live batch order', () => {
  const runState = makeRunState();
  const latestBatch = getLatestUnresolvedDispatchBatch(runState);

  assert.equal(latestBatch?.dispatch_turn_index, 1);
  assert.deepEqual(getBatchNonterminalPlanIds(runState, latestBatch), ['plan_4', 'plan_3']);
  assert.deepEqual(
    getLiveDispatchPlanIds({
      entryPlanIds: ['plan_1', 'plan_2'],
      dispatchTurnIndex: 1,
      runState,
    }),
    ['plan_4', 'plan_3']
  );
});
