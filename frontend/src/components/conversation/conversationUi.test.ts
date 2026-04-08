import assert from 'node:assert/strict';
import test from 'node:test';

import { getConversationInputPlaceholder, getRunActivityLabel } from './conversationUi.ts';
import type { RunState } from '@/types';

function makeRunState(status: RunState['status'], planStatus: RunState['frontier'][number]['status']): RunState {
  return {
    run_id: 'run_123',
    dataset_path: 'data/vgsales.csv',
    dataset_info: { rows: 10, columns: [], sample_rows: [] },
    dataset_schema: '',
    step: 1,
    failure_count: 0,
    status,
    budgets: {
      max_steps: 10,
      max_depth: 2,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 2,
    },
    master_agent_state: {
      current_goals: ['Summarize the main patterns'],
      active_plan_ids: [],
      completed_plan_ids: [],
      all_insight_ids: [],
      dispatch_batches: [],
      message_history: [],
      loop_count: 0,
      completed: false,
    },
    frontier: [
      {
        plan_id: 'plan_123',
        kind: 'analysis',
        text: 'Analyze regional sales performance',
        filters: [],
        status: planStatus,
        parent_insight_id: null,
        created_at: '2026-03-08T00:00:00',
        updated_at: '2026-03-08T00:00:00',
      },
    ],
    insights: [],
    execution_records: [],
    user_messages: [],
    final_summary: '',
    created_at: '2026-03-08T00:00:00',
    updated_at: '2026-03-08T00:00:00',
  };
}

test('getConversationInputPlaceholder guides follow-up messages for completed and idle runs', () => {
  assert.equal(
    getConversationInputPlaceholder('completed'),
    'Start the next turn with a new analysis goal or follow-up question...'
  );
  assert.equal(
    getConversationInputPlaceholder('idle'),
    'Start the next turn with a new analysis goal or follow-up question...'
  );
  assert.equal(
    getConversationInputPlaceholder('running'),
    'Continue entering guidance, constraints, or follow-up questions to steer this turn...'
  );
  assert.equal(getConversationInputPlaceholder('failed'), undefined);
});

test('getRunActivityLabel prioritizes summarizing over analyzing and ignores non-running runs', () => {
  assert.equal(getRunActivityLabel(makeRunState('running', 'summarizing')), 'Summarizing results...');
  assert.equal(getRunActivityLabel(makeRunState('running', 'analyzing')), 'Running analysis...');
  assert.equal(getRunActivityLabel(makeRunState('running', 'pending')), 'Agent is thinking...');
  assert.equal(getRunActivityLabel(makeRunState('completed', 'analyzing')), undefined);
});


