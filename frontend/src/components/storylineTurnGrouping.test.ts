import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStorylineTurnConvergeLayout } from './storylineTurnConvergeLayout';
import { buildStorylineTurnGrouping } from './storylineTurnGrouping';

test('late create-steering summaries stay in the current live dispatch turn instead of falling into a synthetic new turn', () => {
  const runState = {
    run_id: 'run_storyline_grouping_live_batch',
    dataset_path: 'data/test.csv',
    dataset_info: '{}',
    dataset_schema: 'Columns: ["Revenue"]',
    step: 2,
    failure_count: 0,
    status: 'running',
    budgets: {
      max_steps: 10,
      max_depth: 3,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 2,
    },
    frontier: [
      {
        plan_id: 'plan_base',
        kind: 'analysis',
        text: 'Base dispatched plan',
        filters: [],
        embedding: null,
        status: 'completed',
        parent_insight_id: null,
        short_label: 'Base',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        plan_id: 'plan_create',
        kind: 'analysis',
        text: 'Late create steering plan',
        filters: [],
        embedding: null,
        status: 'completed',
        parent_insight_id: null,
        short_label: 'Create',
        created_at: '2026-01-01T00:00:10.000Z',
      },
    ],
    insights: [
      {
        insight_id: 'summary_base',
        plan_id: 'plan_base',
        summary: 'Base summary',
        atomic_insights: [
          {
            atomic_id: 'atomic_base',
            text: 'Base atomic',
            insight_type: 'trend',
            columns: ['Revenue'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.5,
            significance: 0.5,
            impact: 0.5,
            importance: 0.5,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        short_label: 'Base',
        created_at: '2026-01-01T00:00:01.000Z',
      },
      {
        insight_id: 'summary_create',
        plan_id: 'plan_create',
        summary: 'Create summary',
        atomic_insights: [
          {
            atomic_id: 'atomic_create',
            text: 'Create atomic',
            insight_type: 'trend',
            columns: ['Revenue'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.5,
            significance: 0.5,
            impact: 0.5,
            importance: 0.5,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        short_label: 'Create',
        created_at: '2026-01-01T00:00:11.000Z',
      },
    ],
    execution_records: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:11.000Z',
    master_agent_state: {
      current_goals: ['Keep create steering work in the current turn'],
      active_plan_ids: [],
      completed_plan_ids: ['plan_base', 'plan_create'],
      all_insight_ids: ['summary_base', 'summary_create'],
      dispatch_batches: [
        {
          dispatch_turn_index: 0,
          plan_ids: ['plan_base', 'plan_create'],
          status: 'waiting_for_stage_summary',
          stage_summary_emitted: false,
          stage_summary_markdown: '',
          stage_summary_citations: [],
        },
      ],
      pending_user_response_message_ids: [],
      message_history: [],
      loop_count: 0,
      completed: false,
    },
  } as any;

  const events = [
    {
      timestamp: '2026-01-01T00:00:00.500Z',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'dispatch_plans',
        result: {
          dispatch_turn_index: 0,
          plan_ids: ['plan_base'],
          dispatched_plan_ids: ['plan_base'],
        },
      },
    },
  ] as any;

  const grouping = buildStorylineTurnGrouping(runState, events);

  assert.equal(grouping.planTurnIndexByPlanId.get('plan_base'), 0);
  assert.equal(grouping.planTurnIndexByPlanId.get('plan_create'), 0);
  assert.equal(grouping.summaryTurnIndexByInsightId.get('summary_base'), 0);
  assert.equal(grouping.summaryTurnIndexByInsightId.get('summary_create'), 0);

  const layout = buildStorylineTurnConvergeLayout(runState, 420, {
    laneMode: 'dataset_columns',
    viewportWidthPx: 980,
    xZoomRatio: 1,
    yUpperBoundPx: 24,
    yLowerBoundPx: 360,
    yMedianTargetPx: 192,
    events,
  });

  assert.equal(
    layout.summaryAreas.find((area) => area.summaryId === 'summary_base')?.turnIndex,
    0
  );
  assert.equal(
    layout.summaryAreas.find((area) => area.summaryId === 'summary_create')?.turnIndex,
    0
  );
});

test('live create-steering active plans stay in the current dispatch turn before they complete', () => {
  const runState = {
    run_id: 'run_storyline_grouping_live_active_create',
    dataset_path: 'data/test.csv',
    dataset_info: '{}',
    dataset_schema: 'Columns: ["Revenue"]',
    step: 2,
    failure_count: 0,
    status: 'running',
    budgets: {
      max_steps: 10,
      max_depth: 3,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 2,
    },
    frontier: [
      {
        plan_id: 'plan_base',
        kind: 'analysis',
        text: 'Base dispatched plan',
        filters: [],
        embedding: null,
        status: 'completed',
        parent_insight_id: null,
        short_label: 'Base',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        plan_id: 'plan_create_active',
        kind: 'analysis',
        text: 'Late create steering plan',
        filters: [],
        embedding: null,
        status: 'summarizing',
        parent_insight_id: null,
        short_label: 'Create Active',
        created_at: '2026-01-01T00:00:10.000Z',
      },
    ],
    insights: [
      {
        insight_id: 'summary_base',
        plan_id: 'plan_base',
        summary: 'Base summary',
        atomic_insights: [
          {
            atomic_id: 'atomic_base',
            text: 'Base atomic',
            insight_type: 'trend',
            columns: ['Revenue'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.5,
            significance: 0.5,
            impact: 0.5,
            importance: 0.5,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        short_label: 'Base',
        created_at: '2026-01-01T00:00:01.000Z',
      },
    ],
    execution_records: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:11.000Z',
    master_agent_state: {
      current_goals: ['Keep active create steering work in the current turn'],
      active_plan_ids: ['plan_create_active'],
      completed_plan_ids: ['plan_base'],
      all_insight_ids: ['summary_base'],
      dispatch_batches: [
        {
          dispatch_turn_index: 0,
          plan_ids: ['plan_base', 'plan_create_active'],
          status: 'dispatched',
          stage_summary_emitted: false,
          stage_summary_markdown: '',
          stage_summary_citations: [],
        },
      ],
      pending_user_response_message_ids: [],
      message_history: [],
      loop_count: 0,
      completed: false,
    },
  } as any;

  const events = [
    {
      timestamp: '2026-01-01T00:00:00.500Z',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'dispatch_plans',
        result: {
          dispatch_turn_index: 0,
          plan_ids: ['plan_base'],
          dispatched_plan_ids: ['plan_base'],
        },
      },
    },
  ] as any;

  const grouping = buildStorylineTurnGrouping(runState, events);

  assert.equal(grouping.planTurnIndexByPlanId.get('plan_create_active'), 0);

  const layout = buildStorylineTurnConvergeLayout(runState, 420, {
    laneMode: 'dataset_columns',
    viewportWidthPx: 980,
    xZoomRatio: 1,
    yUpperBoundPx: 24,
    yLowerBoundPx: 360,
    yMedianTargetPx: 192,
    events,
  });

  assert.equal(
    layout.activePlanAreas.find((area) => area.planId === 'plan_create_active')?.turnIndex,
    0
  );
});
