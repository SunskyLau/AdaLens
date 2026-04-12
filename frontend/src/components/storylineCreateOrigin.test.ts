import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCreateOriginPlanIds,
  buildCreateOriginSummaryIds,
  buildCreateSteeringEntryIdBySummaryId,
  buildCreateSteeringEntryIdByPlanId,
  isCreatePopoverSubmitKey,
  resolveStorylineCreatePopoverPosition,
  resolvePreferredConversationEntryForPlan,
} from './storylineCreateOrigin.ts';

test('buildCreateSteeringEntryIdByPlanId maps user-created plans to their steering entry ids', () => {
  const runState = {
    turns: [
      {
        timeline: [
          {
            entry_type: 'plan_created',
            content: {
              plan_id: 'plan_create_1',
              message_id: 'msg_create_1',
              source: 'user_create',
            },
          },
          {
            entry_type: 'plan_created',
            content: {
              plan_id: 'plan_auto_1',
              message_id: 'msg_auto_1',
              source: 'master_agent',
            },
          },
        ],
      },
    ],
  } as any;

  const mapping = buildCreateSteeringEntryIdByPlanId(runState);

  assert.equal(mapping.get('plan_create_1'), 'user_message:msg_create_1');
  assert.equal(mapping.has('plan_auto_1'), false);
});

test('buildCreateSteeringEntryIdByPlanId also recovers live create-origin plans from events when turns are stale', () => {
  const runState = {
    turns: [],
  } as any;
  const events = [
    {
      timestamp: '2026-03-20T10:00:00.000Z',
      event_type: 'user_steer_received',
      data: {
        message_id: 'msg_create_live',
        timestamp: '2026-03-20T10:00:00.000Z',
        content: 'Check the outliers around 2012 first',
        kind: 'create',
      },
    },
    {
      timestamp: '2026-03-20T10:00:01.000Z',
      event_type: 'plan_created',
      data: {
        plan_id: 'plan_create_live',
      },
    },
  ] as any;

  const mapping = buildCreateSteeringEntryIdByPlanId(runState, events);

  assert.equal(mapping.get('plan_create_live'), 'user_message:msg_create_live');
});

test('buildCreateSteeringEntryIdByPlanId keeps legacy create mappings when the create card still exists', () => {
  const mapping = buildCreateSteeringEntryIdByPlanId(
    {
      turns: [
        {
          timeline: [
            {
              entry_type: 'plan_created',
              content: {
                plan_id: 'plan_create_1',
                message_id: 'msg_create_1',
                source: 'user_create',
              },
            },
          ],
        },
      ],
    } as any,
    null,
    [
      {
        id: 'user_message:msg_create_1',
        type: 'steering_action',
        steeringKind: 'create',
        timestamp: '2026-03-19T10:00:00.000Z',
      },
    ] as any
  );

  assert.equal(mapping.get('plan_create_1'), 'user_message:msg_create_1');
});

test('buildCreateOriginPlanIds keeps directly user-created plan ids even when turns are stale', () => {
  const planIds = buildCreateOriginPlanIds(
    { turns: [] } as any,
    [
      {
        timestamp: '2026-03-20T10:00:00.000Z',
        event_type: 'user_steer_received',
        data: {
          message_id: 'msg_create_live',
          timestamp: '2026-03-20T10:00:00.000Z',
          content: 'Check the outliers around 2012 first',
          kind: 'create',
        },
      },
      {
        timestamp: '2026-03-20T10:00:01.000Z',
        event_type: 'plan_created',
        data: {
          plan_id: 'plan_create_live',
        },
      },
    ] as any
  );

  assert.deepEqual([...planIds], ['plan_create_live']);
});

test('buildCreateOriginSummaryIds keeps only summaries produced by directly user-created plans', () => {
  const runState = {
    insights: [
      { insight_id: 'summary_create_1', plan_id: 'plan_create_1' },
      { insight_id: 'summary_auto_1', plan_id: 'plan_auto_1' },
    ],
  } as any;

  const summaryIds = buildCreateOriginSummaryIds(
    runState,
    new Set(['plan_create_1'])
  );

  assert.deepEqual([...summaryIds], ['summary_create_1']);
});

test('buildCreateSteeringEntryIdBySummaryId maps directly user-created summaries to their create steering entry ids', () => {
  const runState = {
    insights: [
      { insight_id: 'summary_create_1', plan_id: 'plan_create_1' },
      { insight_id: 'summary_auto_1', plan_id: 'plan_auto_1' },
    ],
  } as any;

  const mapping = buildCreateSteeringEntryIdBySummaryId(
    runState,
    new Map([['plan_create_1', 'user_message:msg_create_1']])
  );

  assert.equal(mapping.get('summary_create_1'), 'user_message:msg_create_1');
  assert.equal(mapping.has('summary_auto_1'), false);
});

test('buildCreateSteeringEntryIdByPlanId filters out non-rendered create entries when conversation entries are missing', () => {
  const mapping = buildCreateSteeringEntryIdByPlanId(
    {
      turns: [
        {
          timeline: [
            {
              entry_type: 'plan_created',
              content: {
                plan_id: 'plan_create_1',
                message_id: 'msg_create_1',
                source: 'user_create',
              },
            },
          ],
        },
      ],
    } as any,
    null,
    []
  );

  assert.equal(mapping.size, 0);
});

test('resolvePreferredConversationEntryForPlan prefers the dispatch entry over the legacy create steering entry', () => {
  const entryId = resolvePreferredConversationEntryForPlan({
    planId: 'plan_create_1',
    createSteeringEntryIdByPlanId: new Map([['plan_create_1', 'user_message:msg_create_1']]),
    dispatchConversationEntryIdByPlanId: new Map([['plan_create_1', '2026-03-19:dispatch']]),
  });

  assert.equal(entryId, '2026-03-19:dispatch');
});

test('resolvePreferredConversationEntryForPlan falls back to the legacy create steering entry for older runs', () => {
  const entryId = resolvePreferredConversationEntryForPlan({
    planId: 'plan_create_1',
    createSteeringEntryIdByPlanId: new Map([['plan_create_1', 'user_message:msg_create_1']]),
    dispatchConversationEntryIdByPlanId: new Map(),
  });

  assert.equal(entryId, 'user_message:msg_create_1');
});

test('isCreatePopoverSubmitKey submits on Enter and keeps Shift+Enter for new lines', () => {
  assert.equal(
    isCreatePopoverSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false }),
    true
  );
  assert.equal(
    isCreatePopoverSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false }),
    false
  );
  assert.equal(
    isCreatePopoverSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true }),
    false
  );
});

test('resolveStorylineCreatePopoverPosition clamps dragged create popovers back into the viewport', () => {
  assert.deepEqual(
    resolveStorylineCreatePopoverPosition({
      popover: { x: 980, y: 640 },
      viewport: { width: 900, height: 600 },
    }),
    {
      left: 540,
      top: 332,
    }
  );
});
