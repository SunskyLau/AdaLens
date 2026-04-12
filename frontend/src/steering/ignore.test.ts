import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIgnoreDisplayText,
  buildIgnoreSystemPrompt,
  buildIgnoreUserPromptPreview,
  createIgnoreSteerRequest,
} from './ignore.ts';
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

test('createIgnoreSteerRequest uses the target label itself as display text', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue'],
  };

  const request = createIgnoreSteerRequest(makeRunState(), target);

  assert.equal(buildIgnoreDisplayText(target), 'Revenue');
  assert.equal(request.display_text, 'Revenue');
  assert.equal(request.kind, 'ignore');
});

test('ignore builders keep column previews direct while moving constraints into system prompt', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue', 'Region'],
  };

  const request = createIgnoreSteerRequest(makeRunState(), target);

  assert.equal(buildIgnoreDisplayText(target), 'Revenue, Region');
  assert.equal(request.display_text, 'Revenue, Region');
  assert.equal(
    buildIgnoreUserPromptPreview(target),
    'Deprioritize future analysis on the dataset columns Revenue, Region.'
  );
  assert.equal(request.content, request.user_prompt);
  assert.equal(request.user_prompt, 'Deprioritize future analysis on the dataset columns Revenue, Region.');
  assert.match(buildIgnoreSystemPrompt(makeRunState(), target), /Ignore steering semantics:/);
  assert.match(buildIgnoreSystemPrompt(makeRunState(), target), /Columns: Revenue, Region/);
  assert.match(buildIgnoreSystemPrompt(makeRunState(), target), /Do not cancel or rewrite sub-agents/);
  assert.doesNotMatch(request.user_prompt ?? '', /Do not cancel or rewrite sub-agents/);
});

test('buildIgnoreUserPromptPreview keeps atomic preview empty when no keyword is selected', () => {
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

  assert.equal(buildIgnoreUserPromptPreview(target, { selectedKeywords: [] }), '');
});

test('createIgnoreSteerRequest distinguishes atomic targets and splits user/system prompts', () => {
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

  const request = createIgnoreSteerRequest(makeRunState(), target, {
    selectedKeywords: ['North America', 'Q4'],
  });

  assert.equal(
    request.display_text,
    'North America, Q4\n\nNorth America drives most of the Q4 spike.'
  );
  assert.deepEqual(request.selected_keywords, ['North America', 'Q4']);
  assert.equal(
    request.user_prompt,
    'In follow-up analysis, deprioritize North America, Q4 for this atomic insight.\n\nBackground:\nNorth America drives most of the Q4 spike.'
  );
  assert.match(request.system_prompt ?? '', /Selected keywords: North America, Q4/);
  assert.match(request.system_prompt ?? '', /Treat the user-authored background as contextual disambiguation only/);
  assert.doesNotMatch(request.user_prompt ?? '', /Do not cancel or rewrite sub-agents/);
});

test('createIgnoreSteerRequest distinguishes summary targets and keeps the preview lead-in removed', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };

  const request = createIgnoreSteerRequest(makeRunState(), target, {
    selectedKeywords: ['North America'],
    includeBackground: false,
  });

  assert.equal(
    request.user_prompt,
    'In follow-up analysis, deprioritize North America for this summary.'
  );
  assert.doesNotMatch(request.user_prompt ?? '', /Ignore future follow-up analysis on this summary/);
});

test('createIgnoreSteerRequest switches the preview template to Chinese when the latest user-authored message is Chinese', () => {
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
      message_id: 'msg_cn_ignore',
      timestamp: '2026-03-16T12:01:00.000Z',
      content: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
      kind: 'chat',
      user_prompt: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
    },
  ];

  const request = createIgnoreSteerRequest(runState, target);

  assert.equal(
    request.user_prompt,
    '\u8bf7\u964d\u4f4e\u540e\u7eed\u5bf9\u6570\u636e\u5217 Revenue\u3001Region \u7684\u5206\u6790\u4f18\u5148\u7ea7\u3002'
  );
});
