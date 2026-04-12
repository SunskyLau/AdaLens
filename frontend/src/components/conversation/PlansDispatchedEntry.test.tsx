import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import PlansDispatchedEntry from './PlansDispatchedEntry.tsx';
import type { ConversationEntry, RunState, Summary } from '@/types';
import { shouldCollapsePlanDetailsByDefault } from './PlansDispatchedEntry.tsx';

function makeRunState(
  planStatus: RunState['frontier'][number]['status'] = 'completed'
): RunState {
  return {
    run_id: 'run_123',
    dataset_path: 'data/vgsales.csv',
    dataset_info: { rows: 10, columns: [], sample_rows: [] },
    dataset_schema: '',
    step: 1,
    failure_count: 0,
    status: 'running',
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

test('shouldCollapsePlanDetailsByDefault matches completed, failed, and terminated terminal states', () => {
  assert.equal(shouldCollapsePlanDetailsByDefault('completed'), true);
  assert.equal(shouldCollapsePlanDetailsByDefault('failed'), true);
  assert.equal(shouldCollapsePlanDetailsByDefault('terminated'), true);
  assert.equal(shouldCollapsePlanDetailsByDefault('analyzing'), false);
  assert.equal(shouldCollapsePlanDetailsByDefault('summarizing'), false);
  assert.equal(shouldCollapsePlanDetailsByDefault('paused'), false);
});

test('PlansDispatchedEntry expands selected completed plans and renders summary only without atomic insight details', () => {
  const entry: ConversationEntry = {
    id: 'entry_123',
    type: 'plans_dispatched',
    timestamp: '2026-03-08T00:00:01',
    planIds: ['plan_123'],
  };
  const insight: Summary = {
    insight_id: 'insight_123',
    plan_id: 'plan_123',
    summary: 'North America contributes the largest regional share.',
    atomic_insights: [
      {
        atomic_id: 'atomic_1',
        text: 'North America leads.',
        insight_type: 'rank',
        columns: ['Region', 'Sales'],
        evidence: {
          code_path: null,
          output_path: null,
          plot_path: 'artifacts/plots/example.png',
        },
        interest: 0.5,
        significance: 0.5,
        impact: 0.5,
        importance: 0.5,
      },
    ],
    parent_insight_id: null,
    children_insight_ids: [],
    created_at: '2026-03-08T00:00:01',
  };

  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={entry}
      runState={makeRunState()}
      planInsights={new Map([['plan_123', [insight]]])}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedPlanId="plan_123"
      selectedSummaryId={null}
    />
  );

  assert.match(html, /North America contributes the largest regional share\./);
  assert.doesNotMatch(html, /North America leads\./);
  assert.doesNotMatch(html, /rank/);
});

test('PlansDispatchedEntry uses the live latest batch order instead of the original event order', () => {
  const runState = makeRunState('analyzing');
  runState.frontier = [
    {
      ...runState.frontier[0],
      plan_id: 'plan_123',
      text: 'Analyze regional sales performance',
      status: 'analyzing',
    },
    {
      ...runState.frontier[0],
      plan_id: 'plan_456',
      text: 'Compare category retention',
      status: 'paused',
      created_at: '2026-03-08T00:00:02',
      updated_at: '2026-03-08T00:00:02',
    },
  ];
  runState.master_agent_state = {
    current_goals: ['Summarize the main patterns'],
    active_plan_ids: ['plan_123'],
    completed_plan_ids: [],
    all_insight_ids: [],
    dispatch_batches: [
      {
        dispatch_turn_index: 3,
        plan_ids: ['plan_456', 'plan_123'],
        status: 'dispatched',
        stage_summary_emitted: false,
        stage_summary_markdown: '',
        stage_summary_citations: [],
      },
    ],
    message_history: [],
    loop_count: 0,
    completed: false,
  };

  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_live_order',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123', 'plan_456'],
        dispatchTurnIndex: 3,
      }}
      runState={runState}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId={null}
    />
  );

  assert.ok(html.indexOf('data-plan-dispatch-card-id="plan_456"') < html.indexOf('data-plan-dispatch-card-id="plan_123"'));
  assert.match(html, /2 dispatch target\(s\)/);
});

test('PlansDispatchedEntry shows plans that are appended later through the live dispatch batch state', () => {
  const runState = makeRunState('analyzing');
  runState.frontier = [
    {
      ...runState.frontier[0],
      plan_id: 'plan_123',
      text: 'Analyze regional sales performance',
      status: 'analyzing',
    },
    {
      ...runState.frontier[0],
      plan_id: 'plan_create_1',
      text: 'Check whether Q4 growth is concentrated in a single segment',
      status: 'pending',
      created_at: '2026-03-08T00:00:02',
      updated_at: '2026-03-08T00:00:02',
    },
  ];
  runState.master_agent_state = {
    current_goals: ['Summarize the main patterns'],
    active_plan_ids: ['plan_123'],
    completed_plan_ids: [],
    all_insight_ids: [],
    dispatch_batches: [
      {
        dispatch_turn_index: 3,
        plan_ids: ['plan_123', 'plan_create_1'],
        status: 'dispatched',
        stage_summary_emitted: false,
        batch_finished_user_response_emitted: false,
        stage_summary_markdown: '',
        stage_summary_citations: [],
      },
    ],
    message_history: [],
    loop_count: 0,
    completed: false,
  };

  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_live_append',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123'],
        dispatchTurnIndex: 3,
      }}
      runState={runState}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId={null}
    />
  );

  assert.match(html, /2 dispatch target\(s\)/);
  assert.match(html, /data-plan-dispatch-card-id="plan_123"/);
  assert.match(html, /data-plan-dispatch-card-id="plan_create_1"/);
});

test('PlansDispatchedEntry collapses completed plan details by default in chat', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_456',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01',
        planIds: ['plan_123'],
      }}
      runState={makeRunState()}
      planInsights={
        new Map([
          [
            'plan_123',
            [
              {
                insight_id: 'insight_123',
                plan_id: 'plan_123',
                summary: 'North America contributes the largest regional share.',
                atomic_insights: [],
                parent_insight_id: null,
                children_insight_ids: [],
                created_at: '2026-03-08T00:00:01',
              },
            ],
          ],
        ])
      }
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId={null}
    />
  );

  assert.match(html, /data-plan-dispatch-card-details-collapsed="true"/);
  assert.match(html, /data-plan-dispatch-card-details-collapsible="true"/);
  assert.match(html, /data-plan-dispatch-card-toggle="true"/);
  assert.match(html, /aria-label="Expand analysis plan details"/);
  assert.match(html, /class="[^"]*py-2[^"]*"/);
  assert.doesNotMatch(html, /Open analysis stream/);
  assert.doesNotMatch(html, /North America contributes the largest regional share\./);
  assert.doesNotMatch(html, /Analyze regional sales performance/);
});

test('PlansDispatchedEntry keeps a plan-level entry point to the analysis stream when a completed plan is selected', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_456',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01',
        planIds: ['plan_123'],
      }}
      runState={makeRunState()}
      planInsights={
        new Map([
          [
            'plan_123',
            [
              {
                insight_id: 'insight_123',
                plan_id: 'plan_123',
                summary: 'North America contributes the largest regional share.',
                atomic_insights: [],
                parent_insight_id: null,
                children_insight_ids: [],
                created_at: '2026-03-08T00:00:01',
              },
            ],
          ],
        ])
      }
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedPlanId="plan_123"
      selectedSummaryId={null}
    />
  );

  assert.match(html, /Open analysis stream/);
  assert.match(html, /data-plan-dispatch-card-toggle="true"/);
  assert.match(html, /aria-label="Collapse analysis plan details"/);
});

test('PlansDispatchedEntry renders the status badge before the plan text block when the plan details are expanded', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_789',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01',
        planIds: ['plan_123'],
      }}
      runState={makeRunState()}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedPlanId="plan_123"
      selectedSummaryId={null}
    />
  );

  assert.match(
    html,
    /completed[\s\S]*Analyze regional sales performance/
  );
});

test('PlansDispatchedEntry renders requested control states as paused or terminated badges', () => {
  const runState = makeRunState('analyzing');
  runState.frontier = [
    {
      ...runState.frontier[0],
      plan_id: 'plan_pause_requested',
      text: 'Pause requested plan',
      status: 'analyzing',
      control_state: 'pause_requested',
    },
    {
      ...runState.frontier[0],
      plan_id: 'plan_terminate_requested',
      text: 'Terminate requested plan',
      status: 'summarizing',
      control_state: 'terminate_requested',
      created_at: '2026-03-08T00:00:02',
      updated_at: '2026-03-08T00:00:02',
    },
  ];

  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_requested_control_states',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_pause_requested', 'plan_terminate_requested'],
      }}
      runState={runState}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId={null}
    />
  );

  assert.match(html, />paused</);
  assert.match(html, />terminated</);
  assert.doesNotMatch(html, /pause requested/);
  assert.doesNotMatch(html, /terminate requested/);
});

test('PlansDispatchedEntry shows elapsed runtime for analyzing plans', () => {
  const originalNow = Date.now;
  Date.now = () => new Date('2026-03-08T00:01:16Z').getTime();

  try {
    const runState = makeRunState();
    runState.frontier[0] = {
      ...runState.frontier[0],
      status: 'analyzing',
    };

    const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_999',
          type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123'],
      }}
      runState={runState}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
        selectedSummaryId={null}
      />
    );

    assert.match(html, /analyzing[\s\S]*1m 15s/);
  } finally {
    Date.now = originalNow;
  }
});

test('PlansDispatchedEntry highlights the selected summary anchor', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_selected',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123'],
      }}
      runState={makeRunState()}
      planInsights={
        new Map([
          [
            'plan_123',
            [
              {
                insight_id: 'insight_123',
                plan_id: 'plan_123',
                summary: 'North America contributes the largest regional share.',
                atomic_insights: [],
                parent_insight_id: null,
                children_insight_ids: [],
                created_at: '2026-03-08T00:00:01',
              },
            ],
          ],
        ])
      }
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId="insight_123"
    />
  );

  assert.doesNotMatch(html, /data-plan-dispatch-card-details-collapsed="true"/);
  assert.match(html, /data-plan-dispatch-card-toggle="true"/);
  assert.match(html, /aria-label="Collapse analysis plan details"/);
  assert.match(html, /data-summary-anchor-id="insight_123"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /ring-2 ring-sky-200\/70/);
});

test('PlansDispatchedEntry leaves active analyzing plans expanded without a collapse arrow', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_active',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123'],
      }}
      runState={makeRunState('analyzing')}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedSummaryId={null}
    />
  );

  assert.doesNotMatch(html, /data-plan-dispatch-card-details-collapsed="true"/);
  assert.doesNotMatch(html, /data-plan-dispatch-card-toggle="true"/);
  assert.match(html, /Analyze regional sales performance/);
  assert.match(html, /Open analysis stream/);
});

test('PlansDispatchedEntry highlights the selected plan card', () => {
  const html = renderToStaticMarkup(
    <PlansDispatchedEntry
      entry={{
        id: 'entry_plan_selected',
        type: 'plans_dispatched',
        timestamp: '2026-03-08T00:00:01Z',
        planIds: ['plan_123'],
      }}
      runState={makeRunState()}
      planInsights={new Map()}
      onSelectPlan={() => undefined}
      onSelectInsight={() => undefined}
      selectedPlanId="plan_123"
      selectedSummaryId={null}
    />
  );

  assert.match(html, /data-plan-dispatch-card-id="plan_123"/);
  assert.match(html, /data-plan-dispatch-card-selected="true"/);
  assert.match(html, /border-sky-300 bg-sky-50 ring-2 ring-sky-200\/70/);
});

