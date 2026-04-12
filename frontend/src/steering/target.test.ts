import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunState, SteeringTargetSnapshot, UserMessage } from '@/types';

import {
  buildColumnSummaryOverview,
  buildColumnTarget,
  buildSteeringConversationEntryId,
  buildLatestSoftSteeringByTarget,
  normalizeSteeringTargetSnapshot,
} from './target.ts';

function makeRunState(): RunState {
  return {
    run_id: 'run_target_test',
    dataset_path: 'data/test.csv',
    dataset_info: {
      rows: 2,
      columns: [
        { name: 'Revenue', dtype: 'number' },
        { name: 'Region', dtype: 'string' },
      ],
      sample_rows: [],
    },
    dataset_schema: 'Revenue, Region',
    step: 0,
    failure_count: 0,
    status: 'running',
    settings: {
      default_sub_agents_num: 1,
    },
    frontier: [],
    insights: [
      {
        insight_id: 's1',
        plan_id: 'p1',
        summary: 'Revenue increases in the north.',
        short_label: 'North Revenue',
        atomic_insights: [
          {
            atomic_id: 'a1',
            text: 'Revenue rises in the north.',
            insight_type: 'trend',
            columns: ['Revenue', 'Region'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.4,
            significance: 0.4,
            impact: 0.4,
            importance: 0.4,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-16T10:00:00.000Z',
      },
      {
        insight_id: 's2',
        plan_id: 'p2',
        summary: 'Revenue falls in the south.',
        short_label: 'South Revenue',
        atomic_insights: [
          {
            atomic_id: 'a2',
            text: 'Revenue declines in the south.',
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
        created_at: '2026-03-16T10:01:00.000Z',
      },
    ],
    execution_records: [],
    user_messages: [],
    final_summary: '',
    created_at: '2026-03-16T10:00:00.000Z',
    updated_at: '2026-03-16T10:01:00.000Z',
  };
}

test('normalizeSteeringTargetSnapshot passively reads legacy column_name into columns', () => {
  const normalized = normalizeSteeringTargetSnapshot({
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: [],
    column_name: 'Revenue',
  } as SteeringTargetSnapshot & { column_name: string });

  assert.deepEqual(normalized, {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue'],
  });
});

test('normalizeSteeringTargetSnapshot removes mixed cjk terminal punctuation in summary and atomic text', () => {
  const normalized = normalizeSteeringTargetSnapshot({
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'North Revenue',
    summary_text: '北美贡献最高。.',
    columns: ['Revenue', 'Region'],
    atomic_id: 'a1',
    atomic_text: '角色扮演在日本更强。.',
    insight_type: 'trend',
  } as SteeringTargetSnapshot);

  assert.deepEqual(normalized, {
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'North Revenue',
    summary_text: '北美贡献最高。',
    columns: ['Revenue', 'Region'],
    atomic_id: 'a1',
    atomic_text: '角色扮演在日本更强。',
    insight_type: 'trend',
  });
});

test('buildColumnSummaryOverview lists current-run summaries that touch the column', () => {
  const overview = buildColumnSummaryOverview(makeRunState(), 'Revenue');

  assert.match(overview, /\[s1\] North Revenue/);
  assert.match(overview, /\[s2\] South Revenue/);
});

test('buildLatestSoftSteeringByTarget normalizes legacy aliases and applies latest-action-wins', () => {
  const messages: UserMessage[] = [
    {
      message_id: 'msg_summary_1',
      timestamp: '2026-03-16T10:00:00.000Z',
      content: 'Legacy focus summary',
      kind: 'focus',
      target: {
        kind: 'summary',
        summary_id: 's1',
        summary_short_label: 'North Revenue',
        summary_text: 'Revenue increases in the north.',
        columns: ['Revenue', 'Region'],
      },
    },
    {
      message_id: 'msg_summary_2',
      timestamp: '2026-03-16T10:00:01.000Z',
      content: 'Ignore summary',
      kind: 'ignore',
      target: {
        kind: 'summary',
        summary_id: 's1',
        summary_short_label: 'North Revenue',
        summary_text: 'Revenue increases in the north.',
        columns: ['Revenue', 'Region'],
      },
    },
    {
      message_id: 'msg_atomic_1',
      timestamp: '2026-03-16T10:00:02.000Z',
      content: 'Legacy suppress atomic',
      kind: 'suppress',
      target: {
        kind: 'atomic',
        summary_id: 's1',
        summary_short_label: 'North Revenue',
        summary_text: 'Revenue increases in the north.',
        columns: ['Revenue'],
        atomic_id: 'a1',
        atomic_text: 'Revenue rises in the north.',
        insight_type: 'trend',
      },
    },
    {
      message_id: 'msg_atomic_2',
      timestamp: '2026-03-16T10:00:03.000Z',
      content: 'Focus atomic',
      kind: 'focus',
      target: {
        kind: 'atomic',
        summary_id: 's1',
        summary_short_label: 'North Revenue',
        summary_text: 'Revenue increases in the north.',
        columns: ['Revenue'],
        atomic_id: 'a1',
        atomic_text: 'Revenue rises in the north.',
        insight_type: 'trend',
      },
    },
    {
      message_id: 'msg_column_1',
      timestamp: '2026-03-16T10:00:04.000Z',
      content: 'Focus Revenue',
      kind: 'focus',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue'],
      },
    },
    {
      message_id: 'msg_column_2',
      timestamp: '2026-03-16T10:00:05.000Z',
      content: 'Ignore Revenue',
      kind: 'ignore',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue'],
      },
    },
  ];

  const latest = buildLatestSoftSteeringByTarget(messages);

  assert.equal(latest.summaryKindsById.get('s1'), 'ignore');
  assert.equal(latest.atomicKindsByKey.get('s1::a1'), 'focus');
  assert.equal(latest.columnKindsByName.get('Revenue'), 'ignore');
  assert.equal(
    latest.summaryEntryIdsById.get('s1'),
    buildSteeringConversationEntryId('msg_summary_2')
  );
  assert.equal(
    latest.atomicEntryIdsByKey.get('s1::a1'),
    buildSteeringConversationEntryId('msg_atomic_2')
  );
  assert.equal(
    latest.columnEntryIdsByName.get('Revenue'),
    buildSteeringConversationEntryId('msg_column_2')
  );
});

test('buildColumnTarget preserves selected column group ordering from input columns', () => {
  const target = buildColumnTarget({
    runState: makeRunState(),
    columns: ['Region', 'Revenue'],
  });

  assert.deepEqual(target, {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Region', 'Revenue'],
  });
});

test('buildLatestSoftSteeringByTarget stamps an aggregated column message onto every targeted column', () => {
  const latest = buildLatestSoftSteeringByTarget([
    {
      message_id: 'msg_group',
      timestamp: '2026-03-16T10:10:00.000Z',
      content: 'Focus Revenue and Region',
      kind: 'focus',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue', 'Region'],
      },
    },
    {
      message_id: 'msg_region_latest',
      timestamp: '2026-03-16T10:11:00.000Z',
      content: 'Ignore Region',
      kind: 'ignore',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Region'],
      },
    },
  ]);

  assert.equal(latest.columnKindsByName.get('Revenue'), 'focus');
  assert.equal(latest.columnKindsByName.get('Region'), 'ignore');
  assert.equal(
    latest.columnEntryIdsByName.get('Revenue'),
    buildSteeringConversationEntryId('msg_group')
  );
  assert.equal(
    latest.columnEntryIdsByName.get('Region'),
    buildSteeringConversationEntryId('msg_region_latest')
  );
});

test('buildLatestSoftSteeringByTarget localizes column steering badges to anchored converge indicators', () => {
  const latest = buildLatestSoftSteeringByTarget([
    {
      message_id: 'msg_group_anchor',
      timestamp: '2026-03-16T10:12:00.000Z',
      content: 'Focus Revenue here and Region there',
      kind: 'focus',
      target: {
        kind: 'column',
        summary_id: '',
        summary_short_label: '',
        summary_text: '',
        columns: ['Revenue', 'Region'],
        column_anchors: [
          { column: 'Revenue', converge_index: 1 },
          { column: 'Region', converge_index: 3 },
        ],
      } as SteeringTargetSnapshot,
    },
  ]);

  assert.equal(latest.columnKindsByIndicatorId.get('indicator:converge:1:Revenue'), 'focus');
  assert.equal(latest.columnKindsByIndicatorId.get('indicator:converge:3:Region'), 'focus');
  assert.equal(
    latest.columnEntryIdsByIndicatorId.get('indicator:converge:1:Revenue'),
    buildSteeringConversationEntryId('msg_group_anchor')
  );
  assert.equal(
    latest.columnEntryIdsByIndicatorId.get('indicator:converge:3:Region'),
    buildSteeringConversationEntryId('msg_group_anchor')
  );
  assert.equal(latest.columnKindsByName.has('Revenue'), false);
  assert.equal(latest.columnKindsByName.has('Region'), false);
});
