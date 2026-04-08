import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPlanControlToPlanRecord,
  buildPlanControlResponse,
  type PlanRecord,
} from './planControl';

function makePlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    plan_id: 'plan_123',
    status: 'paused',
    control_state: 'none',
    resume_phase: 'analyzing',
    ...overrides,
  };
}

test('plan control allows resume for paused plans even when persisted fields stay the same', () => {
  const plan = makePlan();

  const result = applyPlanControlToPlanRecord(plan, 'resume');

  assert.equal(result.allowed, true);
  assert.equal(result.changed, false);
  assert.equal(plan.status, 'paused');
  assert.equal(plan.resume_phase, 'analyzing');
});

test('plan control response keeps persisted state and run status', () => {
  const persistedPlan = makePlan({
    status: 'paused',
    control_state: 'none',
    resume_phase: 'summarizing',
  });

  const response = buildPlanControlResponse({
    plan: persistedPlan,
    action: 'resume',
    persistedRunStatus: 'paused',
  });

  assert.equal(response.plan.status, 'paused');
  assert.equal(response.plan.control_state, 'none');
  assert.equal(response.runStatus, 'paused');
  assert.equal(response.emitPlanStatusChanged, false);
});

test('plan control validation allows terminate for running plans without mutating local state', () => {
  const plan = makePlan({
    status: 'analyzing',
    control_state: 'none',
  });
  const result = applyPlanControlToPlanRecord(plan, 'terminate');
  assert.equal(result.allowed, true);
  assert.equal(result.changed, false);
  assert.equal(plan.status, 'analyzing');
  assert.equal(plan.control_state, 'none');
});

test('plan control validation allows pause for pending plans', () => {
  const plan = makePlan({ status: 'pending' });

  const result = applyPlanControlToPlanRecord(plan, 'pause');

  assert.equal(result.allowed, true);
  assert.equal(result.changed, false);
});
