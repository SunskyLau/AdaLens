import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildElaborateSystemPrompt,
  buildElaborateUserPromptPreview,
  createElaborateSteerRequest,
} from './elaborate.ts';
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

test('createElaborateSteerRequest keeps summary steering scoped while splitting user/system prompts', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };

  const request = createElaborateSteerRequest(target);

  assert.equal(request.kind, 'elaborate');
  assert.equal(request.display_text, 'Revenue spikes in Q4 because of North America.');
  assert.equal(
    buildElaborateUserPromptPreview(target),
    'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.'
  );
  assert.equal(request.content, request.user_prompt);
  assert.match(buildElaborateSystemPrompt(target), /Elaborate steering semantics:/);
  assert.match(buildElaborateSystemPrompt(target), /avoid broad branching into multiple unrelated new plans/);
  assert.doesNotMatch(request.user_prompt ?? '', /Do not cancel or rewrite sub-agents/);
});

test('createElaborateSteerRequest clearly distinguishes atomic targets in the preview text', () => {
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

  assert.equal(
    buildElaborateUserPromptPreview(target),
    'Elaborate on the atomic insight "North America drives most of the Q4 spike." from the summary "Revenue spike" by explaining what drives it and why it happens.'
  );
});

test('createElaborateSteerRequest switches the preview template to Chinese when the latest user-authored message is Chinese', () => {
  const target: SteeringTargetSnapshot = {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4 because of North America.',
    columns: ['Revenue', 'Quarter', 'Region'],
  };
  const runState = makeRunState();
  runState.user_messages = [
    {
      message_id: 'msg_cn_elaborate',
      timestamp: '2026-03-16T12:01:00.000Z',
      content: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
      kind: 'chat',
      user_prompt: '\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u3002',
    },
  ];

  const request = createElaborateSteerRequest(target, { runState });

  assert.equal(
    request.user_prompt,
    '\u8bf7\u8fdb\u4e00\u6b65\u5c55\u5f00\u603b\u7ed3\u201cRevenue spike\u201d\uff0c\u8bf4\u660e\u5b83\u610f\u5473\u7740\u4ec0\u4e48\u3001\u7531\u4ec0\u4e48\u9a71\u52a8\uff0c\u4ee5\u53ca\u4e3a\u4ec0\u4e48\u4f1a\u53d1\u751f\u3002'
  );
});
