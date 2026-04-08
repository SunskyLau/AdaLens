import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PlanItem, PlanLiveState } from '@/types';
import PlanInspector from './InspectorPlan';

function makePlan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    plan_id: 'plan-1',
    kind: 'analysis',
    text: 'Inspect revenue behavior',
    filters: [],
    status: 'analyzing',
    parent_insight_id: null,
    short_label: 'Inspect revenue behavior',
    created_at: '2026-03-24T00:00:00.000Z',
    ...overrides,
  };
}

function makePlanLogs(): PlanLiveState {
  return {
    plan_id: 'plan-1',
    current_attempt: 2,
    logs: [],
    attempts: [
      {
        attempt: 1,
        started_at: '2026-03-24T00:00:00.000Z',
        failed_at: '2026-03-24T00:00:05.000Z',
        error_summary: 'Temporary failure',
      },
      {
        attempt: 2,
        started_at: '2026-03-24T00:00:06.000Z',
      },
    ],
  };
}

test('PlanInspector hides attempt counters from the analysis inspector', () => {
  const html = renderToStaticMarkup(
    <PlanInspector
      runId="run-1"
      plan={makePlan()}
      execution={undefined}
      planLogs={makePlanLogs()}
      planStreamBlockContainerClassName="min-h-0"
    />
  );

  assert.match(html, /Analysis Stream/);
  assert.doesNotMatch(html, /Attempt/);
});
