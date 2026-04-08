import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFocusDisplayText,
  buildFocusSystemPrompt,
  buildFocusUserPromptPreview,
  createFocusSteerRequest,
} from './focus.ts';
import type { RunState, SteeringTargetSnapshot } from '@/types';

function makeRunState(): RunState {
  return {
    run_id: 'run_steering_display',
    dataset_path: 'data/test.csv',
    dataset_info: '{}',
    dataset_schema: 'Columns: ["Revenue", "Quarter"]',
    step: 0,
    failure_count: 0,
    status: 'running',
    settings: {
      default_sub_agents_num: 1,
    },
    frontier: [],
    insights: [],
    execution_records: [],
    user_messages: [],
    created_at: '2026-03-16T12:00:00.000Z',
    updated_at: '2026-03-16T12:00:00.000Z',
  };
}

test('createFocusSteerRequest uses the target label itself as display text', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4.',
    columns: ['Revenue'],
    atomic_id: 'a1',
    atomic_text: 'Revenue spikes specifically in Q4.',
    insight_type: 'trend',
  };

  const request = createFocusSteerRequest(makeRunState(), target);

  assert.equal(buildFocusDisplayText(target), 'Revenue spikes specifically in Q4.');
  assert.equal(request.display_text, 'Revenue spikes specifically in Q4.');
  assert.equal(request.kind, 'focus');
});

test('focus builders keep column previews direct while moving constraints into system prompt', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue', 'Region'],
  };

  const request = createFocusSteerRequest(makeRunState(), target);

  assert.equal(buildFocusDisplayText(target), 'Revenue, Region');
  assert.equal(request.display_text, 'Revenue, Region');
  assert.equal(
    buildFocusUserPromptPreview(target),
    'Focus follow-up analysis on the dataset columns Revenue, Region.'
  );
  assert.equal(request.content, request.user_prompt);
  assert.equal(request.user_prompt, 'Focus follow-up analysis on the dataset columns Revenue, Region.');
  assert.match(buildFocusSystemPrompt(makeRunState(), target), /Focus steering semantics:/);
  assert.match(buildFocusSystemPrompt(makeRunState(), target), /Columns: Revenue, Region/);
  assert.match(buildFocusSystemPrompt(makeRunState(), target), /Do not cancel or rewrite sub-agents/);
  assert.doesNotMatch(request.user_prompt ?? '', /Do not cancel or rewrite sub-agents/);
});

test('buildFocusUserPromptPreview keeps summary preview empty when no keyword is selected', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };

  assert.equal(buildFocusUserPromptPreview(target, { selectedKeywords: [] }), '');
});

test('createFocusSteerRequest distinguishes summary targets and splits user/system prompts', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };

  const request = createFocusSteerRequest(makeRunState(), target, {
    selectedKeywords: ['Revenue', 'North America'],
  });

  assert.equal(
    request.display_text,
    'Revenue, North America\n\nRevenue spikes in Q4 because of North America.'
  );
  assert.deepEqual(request.selected_keywords, ['Revenue', 'North America']);
  assert.equal(
    request.user_prompt,
    'In follow-up analysis, prioritize Revenue, North America for this summary.\n\nBackground:\nRevenue spikes in Q4 because of North America.'
  );
  assert.match(request.system_prompt ?? '', /Selected keywords: Revenue, North America/);
  assert.match(request.system_prompt ?? '', /Treat the user-authored background as contextual evidence/);
  assert.doesNotMatch(request.user_prompt ?? '', /Do not cancel or rewrite sub-agents/);
});

test('createFocusSteerRequest distinguishes atomic targets and keeps the preview lead-in removed', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
    atomic_id: 'a1',
    atomic_text: 'North America drives most of the Q4 spike.',
    insight_type: 'trend',
  };

  const request = createFocusSteerRequest(makeRunState(), target, {
    selectedKeywords: ['North America'],
    includeBackground: false,
  });

  assert.equal(
    request.user_prompt,
    'In follow-up analysis, prioritize North America for this atomic insight.'
  );
  assert.doesNotMatch(request.user_prompt ?? '', /Focus follow-up analysis on this atomic insight/);
});

test('createFocusSteerRequest can omit background from the user prompt while keeping display text context', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };

  const request = createFocusSteerRequest(makeRunState(), target, {
    selectedKeywords: ['Revenue'],
    includeBackground: false,
  });

  assert.equal(
    request.user_prompt,
    'In follow-up analysis, prioritize Revenue for this summary.'
  );
  assert.equal(
    request.display_text,
    'Revenue\n\nRevenue spikes in Q4 because of North America.'
  );
});

test('createFocusSteerRequest switches the preview template to Chinese when the latest user-authored message is Chinese', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue', 'Region'],
  };
  const runState = makeRunState();
  runState.user_messages = [
    {
      message_id: 'msg_cn_focus',
      timestamp: '2026-03-16T12:01:00.000Z',
      content: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
      kind: 'chat',
      user_prompt: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
    },
  ];

  const request = createFocusSteerRequest(runState, target);

  assert.equal(
    request.user_prompt,
    '\u8bf7\u7ee7\u7eed\u56f4\u7ed5\u6570\u636e\u5217 Revenue\u3001Region \u5f00\u5c55\u540e\u7eed\u5206\u6790\u3002'
  );
});
