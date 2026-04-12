import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { buildStorylineTurnGrouping } from '../components/storylineTurnGrouping.ts';
import { useStore } from './useStore.ts';
import type { Event, RunState } from '../types/index.ts';

function makeRunState(): RunState {
  return {
    run_id: 'run_123',
    dataset_path: 'data/vgsales.csv',
    dataset_info: {
      rows: 10,
      columns: [{ name: 'Region', dtype: 'string' }],
      sample_rows: [],
    },
    dataset_schema: 'Region',
    step: 0,
    failure_count: 0,
    status: 'running',
    settings: {
      default_sub_agents_num: 1,
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
    frontier: [],
    insights: [],
    execution_records: [],
    user_messages: [],
    final_summary: '',
    created_at: '2026-03-07T22:00:00',
    updated_at: '2026-03-07T22:00:00',
  };
}

beforeEach(() => {
  useStore.setState({
    runs: [],
    runsLoading: false,
    currentRunId: 'run_123',
    runState: makeRunState(),
    events: [],
    timelineEvents: [],
    eventsLoading: false,
    planLogs: new Map(),
    selection: { type: null, id: null },
    bookmarks: [],
    reports: {},
    conversationEntries: [],
    planInsights: new Map(),
    viewMode: 'conversation',
    pendingDispatchAnchoredCreateMessageIds: [],
  });
});


test('setRunState normalizes canonical plans into frontier', () => {
  const legacyRunState = {
    ...makeRunState(),
    frontier: undefined,
    plans: [
      {
        plan_id: 'plan_legacy',
        kind: 'analysis',
        text: 'Analyze regional sales performance',
        filters: [],
        status: 'pending',
        parent_insight_id: null,
        created_at: '2026-03-08T00:00:00',
        updated_at: '2026-03-08T00:00:00',
      },
    ],
  } as unknown as RunState;

  useStore.getState().setRunState(legacyRunState);

  const runState = useStore.getState().runState!;
  assert.equal(runState.frontier.length, 1);
  assert.equal(runState.frontier[0]?.plan_id, 'plan_legacy');
});

test('setRunState normalizes summary and atomic keywords', () => {
  useStore.getState().setRunState({
    ...makeRunState(),
    insights: [
      {
        insight_id: 's1',
        plan_id: 'plan_1',
        summary: 'Revenue spikes in Q4.',
        keywords: ['Revenue', 'Q4', 'revenue', ''],
        atomic_insights: [
          {
            atomic_id: 'a1',
            text: 'North America drives the Q4 spike.',
            insight_type: 'trend',
            columns: ['Revenue', 'Region'],
            keywords: ['North America', 'Q4', 'north america', ''],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.5,
            significance: 0.5,
            impact: 0.5,
            importance: 0.8,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        short_label: 'Revenue spike',
        created_at: '2026-03-20T10:00:00.000Z',
      },
    ],
  } as RunState);

  const runState = useStore.getState().runState!;
  assert.deepEqual(runState.insights[0]?.keywords, ['Revenue', 'Q4']);
  assert.deepEqual(
    runState.insights[0]?.atomic_insights[0]?.keywords,
    ['North America', 'Q4']
  );
});

test('setRunState removes mixed cjk terminal punctuation from summary and atomic text', () => {
  useStore.getState().setRunState({
    ...makeRunState(),
    final_summary: '阶段总结。.',
    insights: [
      {
        insight_id: 's1',
        plan_id: 'plan_1',
        summary: '北美贡献最高。. 角色扮演在日本更强。.',
        keywords: [],
        atomic_insights: [
          {
            atomic_id: 'a1',
            text: '北美贡献最高。.',
            insight_type: 'proportion',
            columns: ['Region', 'Global_Sales'],
            keywords: [],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.5,
            significance: 0.5,
            impact: 0.5,
            importance: 0.8,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        short_label: '北美贡献',
        created_at: '2026-03-20T10:00:00.000Z',
      },
    ],
  } as RunState);

  const runState = useStore.getState().runState!;
  assert.equal(runState.final_summary, '阶段总结。');
  assert.equal(runState.insights[0]?.summary, '北美贡献最高。 角色扮演在日本更强。');
  assert.equal(runState.insights[0]?.atomic_insights[0]?.text, '北美贡献最高。');
});

test('upsertUserMessage deduplicates optimistic steer messages', () => {
  const message = {
    message_id: 'msg_123',
    timestamp: '2026-03-07T22:00:01',
    content: 'Focus on Q4',
  };

  useStore.getState().upsertUserMessage(message);
  useStore.getState().upsertUserMessage(message);

  const runState = useStore.getState().runState!;
  assert.equal(runState.user_messages!.length, 1);
  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['user_message']);
  assert.equal(entries[0]?.text, 'Focus on Q4');
});

test('upsertUserMessage reopens a completed run optimistically for follow-up steer', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      status: 'completed',
      final_summary: 'Completed round summary.',
    },
  });

  const message = {
    message_id: 'msg_124',
    timestamp: '2026-03-07T22:00:02',
    content: 'Now focus on publisher differences',
  };

  useStore.getState().upsertUserMessage(message);

  const runState = useStore.getState().runState!;
  assert.equal(runState.status, 'running');
  assert.equal(runState.master_agent_state?.completed, false);
});

test('applyEvent tracks received steer messages without processed lifecycle', () => {
  const receivedEvent: Event = {
    timestamp: '2026-03-07T22:00:01',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_123',
      timestamp: '2026-03-07T22:00:01',
      content: 'Focus on Q4',
    },
  };

  useStore.getState().applyEvent(receivedEvent);
  useStore.getState().applyEvent(receivedEvent);

  const runState = useStore.getState().runState!;
  assert.equal(runState.user_messages!.length, 1);
  assert.equal(runState.user_messages![0]?.content, 'Focus on Q4');
});

test('default view mode is conversation', () => {
  assert.equal((useStore.getState() as any).viewMode, 'conversation');
});

test('applyEvent builds conversation entry for plan creation tool result', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'create_plans',
      result: {
        plans: [
          {
            plan_id: 'plan_123',
            kind: 'analysis',
            text: 'Analyze regional sales performance',
            filters: [],
            status: 'pending',
            parent_insight_id: null,
            created_at: '2026-03-08T00:00:00',
          },
        ],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, 'plans_created');
});

test('plan status events update frontier from analyzing to summarizing', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_123',
          kind: 'analysis',
          text: 'Analyze regional sales performance',
          filters: [],
          status: 'pending',
          parent_insight_id: null,
          created_at: '2026-03-08T00:00:00',
          updated_at: '2026-03-08T00:00:00',
        },
      ],
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-08T00:00:01',
    event_type: 'plan_started',
    data: {
      plan_id: 'plan_123',
      kind: 'analysis',
      text: 'Analyze regional sales performance',
      filters: [],
      status: 'analyzing',
      parent_insight_id: null,
      created_at: '2026-03-08T00:00:00',
      updated_at: '2026-03-08T00:00:01',
    },
  } as Event);

  let runState = useStore.getState().runState!;
  assert.equal(runState.frontier[0]?.status, 'analyzing');

  useStore.getState().applyEvent({
    timestamp: '2026-03-08T00:00:02',
    event_type: 'plan_status_changed',
    data: {
      plan_id: 'plan_123',
      kind: 'analysis',
      text: 'Analyze regional sales performance',
      filters: [],
      status: 'summarizing',
      parent_insight_id: null,
      created_at: '2026-03-08T00:00:00',
      updated_at: '2026-03-08T00:00:02',
    },
  } as Event);

  runState = useStore.getState().runState!;
  assert.equal(runState.frontier[0]?.status, 'summarizing');
});

test('execution_completed does not force terminal plan status during incremental updates', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_pause',
          kind: 'analysis',
          text: 'Investigate retention anomaly',
          filters: [],
          status: 'summarizing',
          parent_insight_id: null,
          created_at: '2026-03-08T00:00:00',
          updated_at: '2026-03-08T00:00:00',
        },
      ],
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-08T00:00:03',
    event_type: 'execution_completed',
    data: {
      plan_id: 'plan_pause',
      success: true,
      code_path: null,
      stdout_path: null,
      stderr_path: null,
      plot_paths: [],
      analysis_path: 'analysis/plan_pause.md',
      stdout_content: '',
      stderr_content: '',
      error_message: null,
      execution_time_ms: 1200,
      created_at: '2026-03-08T00:00:03',
    },
  } as Event);

  const runState = useStore.getState().runState!;
  assert.equal(runState.frontier[0]?.status, 'summarizing');
  assert.equal(runState.execution_records.length, 1);
});

test('setEvents replay keeps paused status even if execution_completed appears later', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_pause_replay',
          kind: 'analysis',
          text: 'Investigate retention anomaly',
          filters: [],
          status: 'summarizing',
          parent_insight_id: null,
          created_at: '2026-03-08T00:00:00',
          updated_at: '2026-03-08T00:00:00',
        },
      ],
    },
  });

  useStore.getState().setEvents([
    {
      timestamp: '2026-03-08T00:00:04',
      event_type: 'plan_status_changed',
      data: {
        plan_id: 'plan_pause_replay',
        kind: 'analysis',
        text: 'Investigate retention anomaly',
        filters: [],
        status: 'paused',
        parent_insight_id: null,
        created_at: '2026-03-08T00:00:00',
        updated_at: '2026-03-08T00:00:04',
      },
    },
    {
      timestamp: '2026-03-08T00:00:05',
      event_type: 'execution_completed',
      data: {
        plan_id: 'plan_pause_replay',
        success: true,
        code_path: null,
        stdout_path: null,
        stderr_path: null,
        plot_paths: [],
        analysis_path: 'analysis/plan_pause_replay.md',
        stdout_content: '',
        stderr_content: '',
        error_message: null,
        execution_time_ms: 1300,
        created_at: '2026-03-08T00:00:05',
      },
    },
  ] as Event[]);

  const runState = useStore.getState().runState!;
  assert.equal(runState.frontier[0]?.status, 'paused');
});

test('applyEvent accepts plan creation payloads without priority metadata', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'create_plans',
      result: {
        plans: [
          {
            plan_id: 'plan_456',
            kind: 'analysis',
            text: 'Analyze yearly sales trends',
            filters: [],
            status: 'pending',
            parent_insight_id: null,
            created_at: '2026-03-08T00:00:00',
          },
        ],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    plans?: Array<{ plan_id: string; text: string }>;
  }>;
  assert.equal(entries[0]?.type, 'plans_created');
  assert.equal(entries[0]?.plans?.[0]?.plan_id, 'plan_456');
  assert.equal(entries[0]?.plans?.[0]?.text, 'Analyze yearly sales trends');
});

test('applyEvent creates conversation entry for received steer message', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_456',
      timestamp: '2026-03-08T00:00:01',
      content: 'Legacy dive-into prompt',
      kind: 'dive_into',
      display_text: 'Focus Revenue spike',
      generated_prompt: 'Legacy focus prompt',
      user_prompt: 'Focus follow-up analysis on the summary "Revenue spike".',
      system_prompt: 'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.',
      target: {
        kind: 'summary',
        summary_id: 's1',
        summary_short_label: 'Revenue spike',
        summary_text: 'Revenue spikes in Q4.',
        columns: ['Revenue', 'Quarter'],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    displayText?: string;
    steeringKind?: string;
    target?: { kind: string; summary_id: string };
    generatedPrompt?: string;
    userPrompt?: string;
    systemPrompt?: string;
  }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, 'steering_action');
  assert.equal(entries[0]?.steeringKind, 'focus');
  assert.equal(entries[0]?.displayText, 'Focus Revenue spike');
  assert.equal(entries[0]?.target?.kind, 'summary');
  assert.equal(entries[0]?.target?.summary_id, 's1');
  assert.equal(
    entries[0]?.generatedPrompt,
    'Focus follow-up analysis on the summary "Revenue spike".'
  );
  assert.equal(
    entries[0]?.userPrompt,
    'Focus follow-up analysis on the summary "Revenue spike".'
  );
  assert.equal(
    entries[0]?.systemPrompt,
    'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.'
  );
});

test('applyEvent keeps selected keywords and elaborate steering in conversation entries', () => {
  const event: Event = {
    timestamp: '2026-03-20T10:01:00.000Z',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_elaborate',
      timestamp: '2026-03-20T10:01:00.000Z',
      content: 'Explain the Q4 spike in more detail',
      kind: 'elaborate',
      display_text: 'Revenue spikes in Q4.',
      generated_prompt: 'Legacy elaborate prompt.',
      user_prompt: 'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
      system_prompt: 'Elaborate steering semantics:\n- Keep investigating the explanation, mechanism, and root causes of this specific insight.',
      selected_keywords: ['Revenue', 'Q4', 'revenue'],
      target: {
        kind: 'summary',
        summary_id: 's1',
        summary_short_label: 'Revenue spike',
        summary_text: 'Revenue spikes in Q4.',
        columns: ['Revenue', 'Quarter'],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const runState = useStore.getState().runState!;
  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    steeringKind?: string;
    selectedKeywords?: string[];
    userPrompt?: string;
    systemPrompt?: string;
  }>;

  assert.equal(runState.user_messages?.[0]?.kind, 'elaborate');
  assert.deepEqual(runState.user_messages?.[0]?.selected_keywords, ['Revenue', 'Q4']);
  assert.equal(entries[0]?.type, 'steering_action');
  assert.equal(entries[0]?.steeringKind, 'elaborate');
  assert.deepEqual(entries[0]?.selectedKeywords, ['Revenue', 'Q4']);
  assert.equal(
    entries[0]?.userPrompt,
    'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.'
  );
  assert.equal(
    entries[0]?.systemPrompt,
    'Elaborate steering semantics:\n- Keep investigating the explanation, mechanism, and root causes of this specific insight.'
  );
});

test('applyEvent preserves full column steering target and normalizes legacy suppress alias', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:02',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_457',
      timestamp: '2026-03-08T00:00:02',
      content: 'Legacy suppress Revenue',
      kind: 'suppress',
      display_text: 'Ignore Revenue',
      generated_prompt: 'Ignore Revenue',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue', 'Profit'],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const runState = useStore.getState().runState!;
  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    steeringKind?: string;
    target?: { kind: string; columns?: string[] };
  }>;

  assert.equal(runState.user_messages?.[0]?.kind, 'ignore');
  assert.equal(entries[0]?.type, 'steering_action');
  assert.equal(entries[0]?.steeringKind, 'ignore');
  assert.equal(entries[0]?.target?.kind, 'column');
  assert.deepEqual(entries[0]?.target?.columns, ['Revenue', 'Profit']);
});

test('applyEvent keeps legacy targetless create entries as steering actions without replay targets', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:03',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_create',
      timestamp: '2026-03-08T00:00:03',
      content: 'Check whether Q4 growth is concentrated in a single segment',
      kind: 'create',
      display_text: 'Check whether Q4 growth is concentrated in a single segment',
      generated_prompt: '',
      target: null,
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    steeringKind?: string;
    target?: unknown;
    generatedPrompt?: string;
  }>;

  assert.equal(entries[0]?.type, 'steering_action');
  assert.equal(entries[0]?.steeringKind, 'create');
  assert.equal(entries[0]?.target, null);
  assert.equal(entries[0]?.generatedPrompt, '');
});

test('applyEvent stores create user messages without generating a conversation entry for dispatch-anchored runs', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  const event: Event = {
    timestamp: '2026-03-30T00:00:03',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_create_new',
      timestamp: '2026-03-30T00:00:03',
      content: 'Check whether Q4 growth is concentrated in a single segment',
      kind: 'create',
      display_text: 'Check whether Q4 growth is concentrated in a single segment',
      generated_prompt: '',
      target: null,
    },
  };

  useStore.getState().applyEvent(event);

  const runState = useStore.getState().runState!;
  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;

  assert.equal(runState.user_messages?.length, 1);
  assert.equal(runState.user_messages?.[0]?.kind, 'create');
  assert.deepEqual(entries, []);
});

test('dispatch_plans tool results create the visible conversation entry for dispatch-anchored create runs', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:03',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_create_new',
      timestamp: '2026-03-30T00:00:03',
      content: 'Check whether Q4 growth is concentrated in a single segment',
      kind: 'create',
      display_text: 'Check whether Q4 growth is concentrated in a single segment',
      generated_prompt: '',
      target: null,
    },
  } as Event);

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:04',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'dispatch_plans',
      result: {
        dispatched_plan_ids: ['plan_create_1'],
        plan_ids: ['plan_create_1'],
        dispatch_turn_index: 2,
      },
    },
  } as Event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    planIds?: string[];
    dispatchTurnIndex?: number;
  }>;

  assert.deepEqual(entries.map((entry) => entry.type), ['plans_dispatched']);
  assert.deepEqual(entries[0]?.planIds, ['plan_create_1']);
  assert.equal(entries[0]?.dispatchTurnIndex, 2);
});

test('setEvents replays dispatch-anchored create runs without restoring a standalone create card', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  useStore.getState().setEvents([
    {
      timestamp: '2026-03-30T00:00:03',
      event_type: 'user_steer_received',
      data: {
        message_id: 'msg_create_new',
        timestamp: '2026-03-30T00:00:03',
        content: 'Check whether Q4 growth is concentrated in a single segment',
        kind: 'create',
        display_text: 'Check whether Q4 growth is concentrated in a single segment',
        generated_prompt: '',
        target: null,
      },
    },
    {
      timestamp: '2026-03-30T00:00:04',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'dispatch_plans',
        result: {
          dispatched_plan_ids: ['plan_create_1'],
          plan_ids: ['plan_create_1'],
          dispatch_turn_index: 2,
        },
      },
    },
  ] as Event[]);

  const runState = useStore.getState().runState!;
  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    planIds?: string[];
    dispatchTurnIndex?: number;
  }>;

  assert.equal(runState.user_messages?.length, 1);
  assert.equal(runState.user_messages?.[0]?.kind, 'create');
  assert.deepEqual(entries.map((entry) => entry.type), ['plans_dispatched']);
  assert.deepEqual(entries[0]?.planIds, ['plan_create_1']);
  assert.equal(entries[0]?.dispatchTurnIndex, 2);
});

test('applyEvent appends dispatch-anchored create plans into the latest unresolved batch immediately', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_live',
          kind: 'analysis',
          text: 'Continue the active investigation',
          filters: [],
          status: 'analyzing',
          parent_insight_id: null,
          created_at: '2026-03-30T00:00:00',
          updated_at: '2026-03-30T00:00:00',
        },
        {
          plan_id: 'plan_terminal',
          kind: 'analysis',
          text: 'Already finished sibling',
          filters: [],
          status: 'terminated',
          parent_insight_id: null,
          created_at: '2026-03-30T00:00:01',
          updated_at: '2026-03-30T00:00:01',
        },
      ],
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        dispatch_batches: [
          {
            dispatch_turn_index: 3,
            plan_ids: ['plan_live', 'plan_terminal'],
            status: 'dispatched',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ],
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:02',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_create_live',
      timestamp: '2026-03-30T00:00:02',
      content: 'Check whether Q4 growth is concentrated in a single segment',
      kind: 'create',
      display_text: 'Check whether Q4 growth is concentrated in a single segment',
      generated_prompt: '',
      target: null,
    },
  } as Event);

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:03',
    event_type: 'plan_created',
    data: {
      plan_id: 'plan_create_live',
      kind: 'analysis',
      text: 'Check whether Q4 growth is concentrated in a single segment',
      filters: [],
      status: 'pending',
      parent_insight_id: null,
      created_at: '2026-03-30T00:00:03',
      updated_at: '2026-03-30T00:00:03',
    },
  } as Event);

  let runState = useStore.getState().runState!;
  let entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;

  assert.deepEqual(
    runState.master_agent_state?.dispatch_batches[0]?.plan_ids,
    ['plan_live', 'plan_create_live', 'plan_terminal']
  );
  assert.equal(
    runState.frontier.find((plan) => plan.plan_id === 'plan_create_live')?.status,
    'pending'
  );
  assert.deepEqual(entries, []);

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:04',
    event_type: 'plan_started',
    data: {
      plan_id: 'plan_create_live',
      kind: 'analysis',
      text: 'Check whether Q4 growth is concentrated in a single segment',
      filters: [],
      status: 'analyzing',
      parent_insight_id: null,
      assigned_sub_agent_id: 'sub_002',
      created_at: '2026-03-30T00:00:03',
      updated_at: '2026-03-30T00:00:04',
    },
  } as Event);

  runState = useStore.getState().runState!;
  entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;

  assert.equal(
    runState.frontier.find((plan) => plan.plan_id === 'plan_create_live')?.status,
    'analyzing'
  );
  assert.deepEqual(
    runState.master_agent_state?.dispatch_batches[0]?.plan_ids,
    ['plan_live', 'plan_create_live', 'plan_terminal']
  );
  assert.deepEqual(entries, []);
});

test('applyEvent registers dispatch_plans batches for dispatch-anchored create runs without waiting for a later snapshot', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_done',
          kind: 'analysis',
          text: 'Finished earlier batch',
          filters: [],
          status: 'completed',
          parent_insight_id: null,
          created_at: '2026-03-30T00:00:00',
          updated_at: '2026-03-30T00:00:00',
        },
      ],
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        dispatch_batches: [
          {
            dispatch_turn_index: 0,
            plan_ids: ['plan_done'],
            status: 'no_summary',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ],
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:05',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_create_new_batch',
      timestamp: '2026-03-30T00:00:05',
      content: 'Check whether Q4 growth is concentrated in a single segment',
      kind: 'create',
      display_text: 'Check whether Q4 growth is concentrated in a single segment',
      generated_prompt: '',
      target: null,
    },
  } as Event);

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:06',
    event_type: 'plan_created',
    data: {
      plan_id: 'plan_create_new_batch',
      kind: 'analysis',
      text: 'Check whether Q4 growth is concentrated in a single segment',
      filters: [],
      status: 'pending',
      parent_insight_id: null,
      created_at: '2026-03-30T00:00:06',
      updated_at: '2026-03-30T00:00:06',
    },
  } as Event);

  useStore.getState().applyEvent({
    timestamp: '2026-03-30T00:00:07',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'dispatch_plans',
      result: {
        dispatched_plan_ids: ['plan_create_new_batch'],
        plan_ids: ['plan_create_new_batch'],
        dispatch_turn_index: 1,
      },
    },
  } as Event);

  const runState = useStore.getState().runState!;
  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    dispatchTurnIndex?: number;
    planIds?: string[];
  }>;

  assert.deepEqual(
    runState.master_agent_state?.dispatch_batches.map((batch) => ({
      turnIndex: batch.dispatch_turn_index,
      planIds: batch.plan_ids,
    })),
    [
      { turnIndex: 0, planIds: ['plan_done'] },
      { turnIndex: 1, planIds: ['plan_create_new_batch'] },
    ]
  );
  assert.deepEqual(entries.map((entry) => entry.type), ['plans_dispatched']);
  assert.equal(entries[0]?.dispatchTurnIndex, 1);
  assert.deepEqual(entries[0]?.planIds, ['plan_create_new_batch']);
});

test('setEvents replays live create appends into the current batch even when the snapshot is stale', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      frontier: [
        {
          plan_id: 'plan_live',
          kind: 'analysis',
          text: 'Continue the active investigation',
          filters: [],
          status: 'analyzing',
          parent_insight_id: null,
          created_at: '2026-03-30T00:00:00',
          updated_at: '2026-03-30T00:00:00',
        },
        {
          plan_id: 'plan_terminal',
          kind: 'analysis',
          text: 'Already finished sibling',
          filters: [],
          status: 'terminated',
          parent_insight_id: null,
          created_at: '2026-03-30T00:00:01',
          updated_at: '2026-03-30T00:00:01',
        },
      ],
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        dispatch_batches: [
          {
            dispatch_turn_index: 0,
            plan_ids: ['plan_live', 'plan_terminal'],
            status: 'dispatched',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ],
        pending_direct_user_create_dispatch_plan_ids: [],
      },
    },
  });

  const events: Event[] = [
    {
      timestamp: '2026-03-30T00:00:00',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'dispatch_plans',
        result: {
          dispatched_plan_ids: ['plan_live'],
          plan_ids: ['plan_live', 'plan_terminal'],
          dispatch_turn_index: 0,
        },
      },
    },
    {
      timestamp: '2026-03-30T00:00:02',
      event_type: 'user_steer_received',
      data: {
        message_id: 'msg_create_live_replay',
        timestamp: '2026-03-30T00:00:02',
        content: 'Check whether Q4 growth is concentrated in a single segment',
        kind: 'create',
        display_text: 'Check whether Q4 growth is concentrated in a single segment',
        generated_prompt: '',
        target: null,
      },
    },
    {
      timestamp: '2026-03-30T00:00:03',
      event_type: 'plan_created',
      data: {
        plan_id: 'plan_create_live_replay',
        kind: 'analysis',
        text: 'Check whether Q4 growth is concentrated in a single segment',
        filters: [],
        status: 'pending',
        parent_insight_id: null,
        created_at: '2026-03-30T00:00:03',
        updated_at: '2026-03-30T00:00:03',
      },
    },
    {
      timestamp: '2026-03-30T00:00:04',
      event_type: 'plan_started',
      data: {
        plan_id: 'plan_create_live_replay',
        kind: 'analysis',
        text: 'Check whether Q4 growth is concentrated in a single segment',
        filters: [],
        status: 'analyzing',
        parent_insight_id: null,
        assigned_sub_agent_id: 'sub_002',
        created_at: '2026-03-30T00:00:03',
        updated_at: '2026-03-30T00:00:04',
      },
    },
  ];

  useStore.getState().setEvents(events);

  const runState = useStore.getState().runState!;
  const grouping = buildStorylineTurnGrouping(runState, useStore.getState().events);

  assert.deepEqual(
    runState.master_agent_state?.dispatch_batches[0]?.plan_ids,
    ['plan_live', 'plan_create_live_replay', 'plan_terminal']
  );
  assert.equal(
    runState.frontier.find((plan) => plan.plan_id === 'plan_create_live_replay')?.status,
    'analyzing'
  );
  assert.equal(grouping.planTurnIndexByPlanId.get('plan_create_live_replay'), 0);
});

test('applyEvent falls back to historical generated_prompt when user_prompt is absent', () => {
  const event: Event = {
    timestamp: '2026-03-21T10:00:00.000Z',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_legacy_generated',
      timestamp: '2026-03-21T10:00:00.000Z',
      content: 'Legacy ignore prompt',
      kind: 'ignore',
      display_text: 'Ignore Revenue',
      generated_prompt: 'Legacy generated prompt',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue'],
      },
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    userPrompt?: string;
    generatedPrompt?: string;
  }>;

  assert.equal(entries[0]?.type, 'steering_action');
  assert.equal(entries[0]?.userPrompt, 'Legacy generated prompt');
  assert.equal(entries[0]?.generatedPrompt, 'Legacy generated prompt');
});

test('completed status change does not duplicate mark_complete conversation entry', () => {
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'We have summarized the dataset.',
      },
    },
  };
  const completedStatusEvent: Event = {
    timestamp: '2026-03-08T00:00:02',
    event_type: 'run_status_change',
    data: {
      old_status: 'running',
      new_status: 'completed',
      reason: 'We have summarized the dataset.',
    },
  };

  useStore.getState().applyEvent(markCompleteEvent);
  useStore.getState().applyEvent(completedStatusEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['mark_complete']);
});

test('mark_complete tool result also aligns runState with completed status and final summary', () => {
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'We have summarized the dataset.',
      },
    },
  };

  useStore.getState().applyEvent(markCompleteEvent);

  const runState = useStore.getState().runState!;
  assert.equal(runState.status, 'completed');
  assert.equal(runState.final_summary, 'We have summarized the dataset.');
  assert.equal(runState.master_agent_state?.completed, true);
});

test('mark_complete preserves citation-aware markdown for the final summary card', () => {
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'Final conclusion [[1]]',
        citations: [
          {
            marker: 1,
            label: 'Regional spike atomic insight',
            target: {
              kind: 'atomic',
              summary_id: 'summary_1',
              summary_short_label: 'Regional spike',
              summary_text: 'Regional revenue spikes in Q4.',
              columns: ['Revenue', 'Region'],
              atomic_id: 'atomic_1',
              atomic_text: 'Q4 revenue spikes most strongly in North America.',
              insight_type: 'trend',
            },
          },
        ],
      },
    },
  };

  useStore.getState().applyEvent(markCompleteEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    summary?: string;
    markdownBody?: string;
    citations?: Array<{ marker: number; target?: { kind: string; atomic_id?: string } }>;
  }>;
  assert.equal(entries[0]?.type, 'mark_complete');
  assert.equal(entries[0]?.summary, 'Final conclusion [[1]]');
  assert.equal(entries[0]?.markdownBody, 'Final conclusion [[1]]');
  assert.equal(entries[0]?.citations?.[0]?.marker, 1);
  assert.equal(entries[0]?.citations?.[0]?.target?.kind, 'atomic');
  assert.equal(entries[0]?.citations?.[0]?.target?.atomic_id, 'atomic_1');
});

test('mark_complete conversation entry keeps dispatchTurnIndex for converge summary buttons', () => {
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'We have summarized the dataset.',
        dispatch_turn_index: 0,
      },
    },
  };

  useStore.getState().applyEvent(markCompleteEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    dispatchTurnIndex?: number;
  }>;
  assert.equal(entries[0]?.type, 'mark_complete');
  assert.equal(entries[0]?.dispatchTurnIndex, 0);
});

test('idle status change does not duplicate mark_complete summary text', () => {
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'We have summarized the dataset.',
      },
    },
  };
  const idleStatusEvent: Event = {
    timestamp: '2026-03-08T00:00:02',
    event_type: 'run_status_change',
    data: {
      old_status: 'running',
      new_status: 'idle',
      reason: 'We have summarized the dataset.',
    },
  };

  useStore.getState().applyEvent(markCompleteEvent);
  useStore.getState().applyEvent(idleStatusEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['mark_complete']);
});

test('mark_complete also suppresses a previously rendered idle status entry with the same text', () => {
  const idleStatusEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'run_status_change',
    data: {
      old_status: 'running',
      new_status: 'idle',
      reason: 'We have summarized the dataset.',
    },
  };
  const markCompleteEvent: Event = {
    timestamp: '2026-03-08T00:00:02',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'mark_complete',
      result: {
        summary: 'We have summarized the dataset.',
      },
    },
  };

  useStore.getState().applyEvent(idleStatusEvent);
  useStore.getState().applyEvent(markCompleteEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['mark_complete']);
});

test('setEvents also suppresses duplicated idle status entries during history replay', () => {
  const events: Event[] = [
    {
      timestamp: '2026-03-08T00:00:01',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'mark_complete',
        result: {
          summary: 'We have summarized the dataset.',
        },
      },
    },
    {
      timestamp: '2026-03-08T00:00:02',
      event_type: 'run_status_change',
      data: {
        old_status: 'running',
        new_status: 'idle',
        reason: 'We have summarized the dataset.',
      },
    },
  ];

  useStore.getState().setEvents(events);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['mark_complete']);
});

test('setEvents suppresses duplicated idle status entries even when idle arrives first', () => {
  const events: Event[] = [
    {
      timestamp: '2026-03-08T00:00:01',
      event_type: 'run_status_change',
      data: {
        old_status: 'running',
        new_status: 'idle',
        reason: 'We have summarized the dataset.',
      },
    },
    {
      timestamp: '2026-03-08T00:00:02',
      event_type: 'master_agent_tool_result',
      data: {
        tool_name: 'mark_complete',
        result: {
          summary: 'We have summarized the dataset.',
        },
      },
    },
  ];

  useStore.getState().setEvents(events);

  const entries = (useStore.getState() as any).conversationEntries as Array<{ type: string }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['mark_complete']);
});

test('distinct idle status message still appears when it adds new information', () => {
  const idleStatusEvent: Event = {
    timestamp: '2026-03-08T00:00:03',
    event_type: 'run_status_change',
    data: {
      old_status: 'running',
      new_status: 'idle',
      reason: 'Waiting for new instructions',
    },
  };

  useStore.getState().applyEvent(idleStatusEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    status?: string;
    reason?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['status_change']);
  assert.equal(entries[0]?.status, 'idle');
  assert.equal(entries[0]?.reason, 'Waiting for new instructions');
});

test('progress evaluation does not duplicate when both tool_result and dedicated event arrive', () => {
  const text = 'We should inspect regional preferences next.';
  const toolResultEvent: Event = {
    timestamp: '2026-03-08T00:00:01',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'evaluate_progress',
      result: {
        evaluation: text,
      },
    },
  };
  const dedicatedEvent: Event = {
    timestamp: '2026-03-08T00:00:02',
    event_type: 'progress_evaluation',
    data: {
      evaluation: text,
    },
  };

  useStore.getState().applyEvent(toolResultEvent);
  useStore.getState().applyEvent(dedicatedEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['evaluation']);
  assert.equal(entries[0]?.text, text);
});

test('progress_evaluation updates the dispatch batch and keeps structured citations', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        dispatch_batches: [
          {
            dispatch_turn_index: 0,
            plan_ids: ['plan_123'],
            status: 'waiting_for_stage_summary',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ],
      },
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-08T00:00:03',
    event_type: 'progress_evaluation',
    data: {
      evaluation: 'Plain-text alias for older clients.',
      stage_summary_markdown: 'Stage summary [[1]]',
      dispatch_turn_index: 0,
      plan_ids: ['plan_123'],
      citations: [
        {
          marker: 1,
          label: 'Revenue spike summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
      ],
    },
  } as Event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
    markdownBody?: string;
    dispatchTurnIndex?: number;
    planIds?: string[];
    citations?: Array<{ marker: number; target?: { kind: string; summary_id?: string } }>;
  }>;
  const runState = useStore.getState().runState!;

  assert.equal(entries[0]?.type, 'evaluation');
  assert.equal(entries[0]?.text, 'Plain-text alias for older clients.');
  assert.equal(entries[0]?.markdownBody, 'Stage summary [[1]]');
  assert.equal(entries[0]?.dispatchTurnIndex, 0);
  assert.deepEqual(entries[0]?.planIds, ['plan_123']);
  assert.equal(entries[0]?.citations?.[0]?.marker, 1);
  assert.equal(entries[0]?.citations?.[0]?.target?.kind, 'summary');
  assert.equal(entries[0]?.citations?.[0]?.target?.summary_id, 'summary_1');
  assert.equal(runState.master_agent_state?.dispatch_batches[0]?.status, 'stage_summarized');
  assert.equal(runState.master_agent_state?.dispatch_batches[0]?.stage_summary_emitted, true);
  assert.equal(
    runState.master_agent_state?.dispatch_batches[0]?.stage_summary_markdown,
    'Stage summary [[1]]'
  );
  assert.equal(
    runState.master_agent_state?.dispatch_batches[0]?.stage_summary_citations[0]?.marker,
    1
  );
});

test('progress_evaluation marks every covered dispatch batch as stage_summarized while keeping markdown on the latest batch only', () => {
  useStore.setState({
    runState: {
      ...makeRunState(),
      master_agent_state: {
        ...makeRunState().master_agent_state!,
        dispatch_batches: [
          {
            dispatch_turn_index: 0,
            plan_ids: ['plan_older'],
            status: 'waiting_for_stage_summary',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
          {
            dispatch_turn_index: 1,
            plan_ids: ['plan_latest'],
            status: 'waiting_for_stage_summary',
            stage_summary_emitted: false,
            stage_summary_markdown: '',
            stage_summary_citations: [],
          },
        ],
      },
    },
  });

  useStore.getState().applyEvent({
    timestamp: '2026-03-28T00:00:03',
    event_type: 'progress_evaluation',
    data: {
      evaluation: 'Latest checkpoint.',
      stage_summary_markdown: 'Latest checkpoint [[1]]',
      dispatch_turn_index: 1,
      plan_ids: ['plan_latest'],
      covered_dispatch_turn_indexes: [0, 1],
      citations: [
        {
          marker: 1,
          label: 'Latest summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_latest',
            summary_short_label: 'Latest',
            summary_text: 'Latest checkpoint',
            columns: ['Revenue'],
          },
        },
      ],
    },
  } as Event);

  const runState = useStore.getState().runState!;

  assert.equal(runState.master_agent_state?.dispatch_batches[0]?.status, 'stage_summarized');
  assert.equal(runState.master_agent_state?.dispatch_batches[0]?.stage_summary_emitted, true);
  assert.equal(runState.master_agent_state?.dispatch_batches[0]?.stage_summary_markdown, '');
  assert.equal(runState.master_agent_state?.dispatch_batches[1]?.status, 'stage_summarized');
  assert.equal(runState.master_agent_state?.dispatch_batches[1]?.stage_summary_emitted, true);
  assert.equal(
    runState.master_agent_state?.dispatch_batches[1]?.stage_summary_markdown,
    'Latest checkpoint [[1]]'
  );
  assert.equal(
    runState.master_agent_state?.dispatch_batches[1]?.stage_summary_citations[0]?.marker,
    1
  );
});

test('synthesis does not duplicate when both tool_result and dedicated event arrive', () => {
  const text = 'Regional and platform patterns are now consolidated.';
  const toolResultEvent: Event = {
    timestamp: '2026-03-08T00:00:03',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'synthesize_findings',
      result: {
        synthesis: text,
      },
    },
  };
  const dedicatedEvent: Event = {
    timestamp: '2026-03-08T00:00:04',
    event_type: 'synthesis_update',
    data: {
      synthesis: text,
    },
  };

  useStore.getState().applyEvent(toolResultEvent);
  useStore.getState().applyEvent(dedicatedEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['synthesis']);
  assert.equal(entries[0]?.text, text);
});

test('agent response does not duplicate when both tool_result and dedicated event arrive', () => {
  const text = 'I will focus on publisher breakdown next.';
  const toolResultEvent: Event = {
    timestamp: '2026-03-08T00:00:05',
    event_type: 'master_agent_tool_result',
    data: {
      tool_name: 'respond_to_user',
      result: {
        message: text,
      },
    },
  };
  const dedicatedEvent: Event = {
    timestamp: '2026-03-08T00:00:06',
    event_type: 'user_response',
    data: {
      message: text,
    },
  };

  useStore.getState().applyEvent(toolResultEvent);
  useStore.getState().applyEvent(dedicatedEvent);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['agent_response']);
  assert.equal(entries[0]?.text, text);
});

test('agent response preserves markdown body and citations from the dedicated event', () => {
  const markdown = 'Checkpoint is justified by the latest summary [[1]].';
  const event: Event = {
    timestamp: '2026-03-08T00:00:06',
    event_type: 'user_response',
    data: {
      message: markdown,
      citations: [
        {
          marker: 1,
          label: 'Revenue spike',
          target: {
            kind: 'summary',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
      ],
    },
  };

  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    markdownBody?: string;
    citations?: Array<{ marker: number }>;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['agent_response']);
  assert.equal(entries[0]?.markdownBody, markdown);
  assert.equal(entries[0]?.citations?.[0]?.marker, 1);
});

test('replayed identical event does not append duplicate conversation entry', () => {
  const event: Event = {
    timestamp: '2026-03-08T00:00:07',
    event_type: 'user_steer_received',
    data: {
      message_id: 'msg_789',
      timestamp: '2026-03-08T00:00:07',
      content: 'Focus on Europe',
    },
  };

  useStore.getState().applyEvent(event);
  useStore.getState().applyEvent(event);

  const entries = (useStore.getState() as any).conversationEntries as Array<{
    type: string;
    text?: string;
  }>;
  assert.deepEqual(entries.map((entry) => entry.type), ['user_message']);
  assert.equal(entries[0]?.text, 'Focus on Europe');
});

test('resetConversation clears current run state for new chat mode', () => {
  useStore.setState({
    selection: { type: 'plan', id: 'plan_123' },
    events: [
      {
        timestamp: '2026-03-08T00:00:07',
        event_type: 'user_steer_received',
        data: {
          message_id: 'msg_789',
          timestamp: '2026-03-08T00:00:07',
          content: 'Focus on Europe',
        },
      } as Event,
    ],
    conversationEntries: [
      {
        id: 'entry_1',
        type: 'user_message',
        timestamp: '2026-03-08T00:00:07',
        text: 'Focus on Europe',
      },
    ],
    planInsights: new Map([
      [
        'plan_123',
        [
          {
            insight_id: 'insight_123',
            plan_id: 'plan_123',
            summary: 'Europe is secondary.',
            atomic_insights: [],
            parent_insight_id: null,
            children_insight_ids: [],
            created_at: '2026-03-08T00:00:07',
          },
        ],
      ],
    ]),
  });

  const store = useStore.getState() as ReturnType<typeof useStore.getState> & {
    resetConversation: () => void;
  };
  store.resetConversation();

  const state = useStore.getState();
  assert.equal(state.runState, null);
  assert.equal(state.events.length, 0);
  assert.equal(state.conversationEntries.length, 0);
  assert.equal(state.planInsights.size, 0);
  assert.deepEqual(state.selection, { type: null, id: null });
});

test('legacy user_steer_processed events are ignored during replay', () => {
  const events = [
    {
      timestamp: '2026-03-08T00:00:01',
      event_type: 'user_steer_received',
      data: {
        message_id: 'msg_111',
        timestamp: '2026-03-08T00:00:01',
        content: 'Focus on Europe',
      },
    },
    {
      timestamp: '2026-03-08T00:00:02',
      event_type: 'user_steer_processed',
      data: {
        message_id: 'msg_111',
        timestamp: '2026-03-08T00:00:01',
        content: 'Focus on Europe',
      },
    },
  ] as Event[];

  useStore.getState().setEvents(events);

  const runState = useStore.getState().runState!;
  assert.equal(runState.user_messages?.length, 1);
  assert.equal(runState.user_messages?.[0]?.content, 'Focus on Europe');
});
