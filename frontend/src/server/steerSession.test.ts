import assert from 'node:assert/strict';
import test from 'node:test';

import { ENDED_SESSION_ERROR, getEndedSessionError } from './steerSession.ts';

test('getEndedSessionError returns null while the run process is alive', () => {
  assert.equal(getEndedSessionError({ exitCode: null }, 'completed'), null);
});

test('getEndedSessionError allows resumable runs after process restart', () => {
  assert.equal(getEndedSessionError(undefined, 'running'), null);
  assert.equal(getEndedSessionError(undefined, 'paused'), null);
  assert.equal(getEndedSessionError(undefined, 'idle'), null);
  assert.equal(getEndedSessionError(undefined, 'completed'), null);
});

test('getEndedSessionError flags missing or exited processes for non-resumable runs', () => {
  assert.equal(getEndedSessionError(undefined, 'failed'), ENDED_SESSION_ERROR);
  assert.equal(getEndedSessionError({ exitCode: 0 }, 'stopped'), ENDED_SESSION_ERROR);
});
