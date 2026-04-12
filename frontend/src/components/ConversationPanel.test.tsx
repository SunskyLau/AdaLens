import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ConversationPanel, {
  buildConversationTailKey,
  buildTargetSelectionScrollKey,
  consumeSuppressedSelectionScroll,
  resolveStickToBottomOnScroll,
  resolveSelectionScrollDisposition,
  shouldDeactivateStickToBottomOnSummaryFocus,
  shouldForceScrollToLatestConversationEntry,
  shouldSuppressSelectionScrollForSteeringReplay,
} from './ConversationPanel.tsx';
import type { ConversationEntry, RunState, SteeringTargetSnapshot } from '@/types';

function makeRunState(status: RunState['status'] = 'running'): RunState {
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
        status: 'analyzing',
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

function makePanelProps(overrides: Partial<Parameters<typeof ConversationPanel>[0]> = {}) {
  return {
    runState: makeRunState('running'),
    entries: [],
    planInsights: new Map(),
    steerDraft: '',
    setSteerDraft: () => {},
    onSteerSubmit: () => {},
    isSendingSteer: false,
    steerError: null,
    onSelectPlan: () => {},
    onSelectInsight: () => {},
    mode: 'run' as const,
    datasetPath: 'data/vgsales.csv',
    onDatasetPathChange: () => {},
    onNewConversation: () => {},
    onSelectConversation: () => {},
    ...overrides,
  };
}

function makeSteeringEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'user_message:msg_steer_1',
    type: 'steering_action',
    timestamp: '2026-03-16T12:00:00.000Z',
    steeringKind: 'focus',
    text: 'Revenue spike',
    displayText: 'Revenue spike',
    targetKind: 'summary',
    targetLabel: 'Revenue spike',
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue'],
    },
    ...overrides,
  };
}

test('ConversationPanel shows a running activity indicator with contextual label', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        runState: makeRunState('running'),
      })}
    />
  );

  assert.match(html, /Running analysis\.\.\./);
});

test('ConversationPanel hides the activity indicator when the run is not running', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        runState: makeRunState('completed'),
      })}
    />
  );

  assert.doesNotMatch(html, /Agent is thinking\.\.\.|Running analysis\.\.\.|Summarizing results\.\.\./);
});

test('ConversationPanel shows running-turn placeholder copy while a turn is running', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        runState: makeRunState('running'),
      })}
    />
  );

  assert.match(
    html,
    /Continue entering guidance, constraints, or follow-up questions to steer this turn\.\.\./
  );
});

test('ConversationPanel shows follow-up placeholder copy after completion', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        runState: makeRunState('completed'),
      })}
    />
  );

  assert.match(
    html,
    /Start the next turn with a new analysis goal or follow-up question\.\.\./
  );
});

test('ConversationPanel only suppresses auto-scroll for summary and atomic steering replay targets', () => {
  const summaryTarget: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4.',
    columns: ['Revenue'],
  };
  const atomicTarget: SteeringTargetSnapshot = {
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4.',
    columns: ['Revenue'],
    atomic_id: 'a1',
    atomic_text: 'Revenue spikes specifically in Q4.',
    insight_type: 'trend',
  };
  const columnTarget: SteeringTargetSnapshot = {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue'],
  };

  assert.equal(shouldSuppressSelectionScrollForSteeringReplay(summaryTarget), true);
  assert.equal(shouldSuppressSelectionScrollForSteeringReplay(atomicTarget), true);
  assert.equal(shouldSuppressSelectionScrollForSteeringReplay(columnTarget), false);
});

test('ConversationPanel consumes replay scroll suppression exactly once', () => {
  const suppressedKeysRef = { current: new Set(['summary:s1:']) };

  assert.equal(consumeSuppressedSelectionScroll(suppressedKeysRef, 'summary:s1:'), true);
  assert.equal(suppressedKeysRef.current.has('summary:s1:'), false);
  assert.equal(consumeSuppressedSelectionScroll(suppressedKeysRef, 'summary:s1:'), false);
});

test('ConversationPanel builds keyed suppression tokens for summary and atomic targets', () => {
  assert.equal(
    buildTargetSelectionScrollKey({
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue'],
    }),
    'summary:s1:'
  );
  assert.equal(
    buildTargetSelectionScrollKey({
      kind: 'atomic',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue'],
      atomic_id: 'a1',
      atomic_text: 'Revenue spikes specifically in Q4.',
      insight_type: 'trend',
    }),
    'summary:s1:a1'
  );
  assert.equal(
    buildTargetSelectionScrollKey({
      kind: 'column',
      summary_id: '',
      summary_short_label: '',
      summary_text: '',
      columns: ['Revenue'],
    }),
    null
  );
});

test('ConversationPanel builds a stable tail key from the latest conversation entry', () => {
  const userEntry: ConversationEntry = {
    id: 'user_message:msg_1',
    type: 'user_message',
    timestamp: '2026-03-20T10:00:00.000Z',
    text: 'Please compare EU and NA.',
  };

  assert.equal(buildConversationTailKey([]), null);
  assert.equal(buildConversationTailKey([userEntry]), '1:user_message:msg_1:user_message');
});

test('ConversationPanel forces scroll when a new user-authored message becomes the latest entry', () => {
  assert.equal(
    shouldForceScrollToLatestConversationEntry({
      previousEntryCount: 3,
      currentEntryCount: 4,
      previousTailKey: '3:agent_response:msg_prev:agent_response',
      currentTailKey: '4:user_message:msg_1:user_message',
      currentTailType: 'user_message',
    }),
    true
  );
  assert.equal(
    shouldForceScrollToLatestConversationEntry({
      previousEntryCount: 4,
      currentEntryCount: 5,
      previousTailKey: '4:agent_response:msg_prev:agent_response',
      currentTailKey: '5:user_message:msg_steer:steering_action',
      currentTailType: 'steering_action',
    }),
    true
  );
});

test('ConversationPanel does not force scroll for non-user latest entries or unchanged tails', () => {
  assert.equal(
    shouldForceScrollToLatestConversationEntry({
      previousEntryCount: 3,
      currentEntryCount: 4,
      previousTailKey: '3:user_message:msg_prev:user_message',
      currentTailKey: '4:agent_response:msg_next:agent_response',
      currentTailType: 'agent_response',
    }),
    false
  );
  assert.equal(
    shouldForceScrollToLatestConversationEntry({
      previousEntryCount: 4,
      currentEntryCount: 4,
      previousTailKey: '4:user_message:msg_1:user_message',
      currentTailKey: '4:user_message:msg_1:user_message',
      currentTailType: 'user_message',
    }),
    false
  );
});

test('ConversationPanel scroll disposition only scrolls once per selection key', () => {
  assert.equal(
    resolveSelectionScrollDisposition({
      selectionScrollKey: 'summary:s1:',
      lastHandledSelectionScrollKey: null,
      suppressed: false,
    }),
    'scroll'
  );

  assert.equal(
    resolveSelectionScrollDisposition({
      selectionScrollKey: 'summary:s1:',
      lastHandledSelectionScrollKey: 'summary:s1:',
      suppressed: false,
    }),
    'skip'
  );
});

test('ConversationPanel marks suppressed selection scroll as handled', () => {
  assert.equal(
    resolveSelectionScrollDisposition({
      selectionScrollKey: 'insight:s1:a1',
      lastHandledSelectionScrollKey: null,
      suppressed: true,
    }),
    'mark_handled'
  );
});

test('ConversationPanel deactivates stick-to-bottom for a fresh summary focus request', () => {
  assert.equal(
    shouldDeactivateStickToBottomOnSummaryFocus({
      hasScrollContainer: true,
      entryId: 'evaluation_1',
      requestNonce: 3,
      lastConsumedNonce: 2,
    }),
    true
  );
  assert.equal(
    shouldDeactivateStickToBottomOnSummaryFocus({
      hasScrollContainer: true,
      entryId: 'evaluation_1',
      requestNonce: 3,
      lastConsumedNonce: 3,
    }),
    false
  );
  assert.equal(
    shouldDeactivateStickToBottomOnSummaryFocus({
      hasScrollContainer: false,
      entryId: 'evaluation_1',
      requestNonce: 3,
      lastConsumedNonce: 2,
    }),
    false
  );
  assert.equal(
    shouldDeactivateStickToBottomOnSummaryFocus({
      hasScrollContainer: true,
      entryId: null,
      requestNonce: 3,
      lastConsumedNonce: 2,
    }),
    false
  );
});

test('ConversationPanel ignores near-bottom reactivation while a programmatic focus scroll is still settling', () => {
  assert.equal(
    resolveStickToBottomOnScroll({
      isProgrammaticFocusScrollLocked: true,
      nearBottom: true,
    }),
    null
  );
  assert.equal(
    resolveStickToBottomOnScroll({
      isProgrammaticFocusScrollLocked: true,
      nearBottom: false,
    }),
    null
  );
  assert.equal(
    resolveStickToBottomOnScroll({
      isProgrammaticFocusScrollLocked: false,
      nearBottom: true,
    }),
    true
  );
  assert.equal(
    resolveStickToBottomOnScroll({
      isProgrammaticFocusScrollLocked: false,
      nearBottom: false,
    }),
    false
  );
});

test('ConversationPanel keeps steering entry highlight independent from summary-anchor highlight', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        entries: [makeSteeringEntry()],
        highlightedSteeringEntryId: 'user_message:msg_steer_1',
      })}
    />
  );

  assert.match(html, /data-steering-entry-id="user_message:msg_steer_1"/);
  assert.match(html, /data-steering-entry-highlighted="true"/);
  assert.doesNotMatch(html, /data-summary-anchor-id="s1"/);
});

test('ConversationPanel renders mark_complete entries as interactive highlighted summary cards when converge focus is available', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        entries: [
          {
            id: 'mark_complete_1',
            type: 'mark_complete',
            timestamp: '2026-03-21T10:00:00.000Z',
            summary: 'Run complete final summary.',
            markdownBody: 'Run complete final summary.',
            dispatchTurnIndex: 2,
          },
        ],
        highlightedSummaryEntryId: 'mark_complete_1',
        onFocusSummaryEntry: () => undefined,
      })}
    />
  );

  assert.match(html, /data-conversation-final-summary-card="true"/);
  assert.match(html, /data-conversation-final-summary-highlighted="true"/);
  assert.match(html, /role="button"/);
  assert.match(html, /Run Complete/);
  assert.match(html, /Run complete final summary\./);
});

test('ConversationPanel wires agent_response citations through the shared storyline activation path', () => {
  const html = renderToStaticMarkup(
    <ConversationPanel
      {...makePanelProps({
        entries: [
          {
            id: 'agent_response_1',
            type: 'agent_response',
            timestamp: '2026-03-22T10:00:00.000Z',
            text: 'This checkpoint is justified by the revenue summary [[1]].',
            markdownBody: 'This checkpoint is justified by the revenue summary [[1]].',
            citations: [
              {
                marker: 1,
                label: 'Revenue spike',
                target: {
                  kind: 'summary',
                  summary_id: 's1',
                  summary_short_label: 'Revenue spike',
                  summary_text: 'Revenue spikes in Q4.',
                  columns: ['Revenue'],
                },
              },
            ],
          },
        ],
        onActivateSteeringTarget: () => undefined,
      })}
    />
  );

  assert.match(html, /data-provenance-marker="1"/);
  assert.match(html, /<button[^>]*title="Revenue spike"/);
});
