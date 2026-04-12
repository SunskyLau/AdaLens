import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveStorylinePenClickBehavior,
  shouldPreserveSteeringPopoverOnNextSelectionChange,
} from './storylinePenInteraction.ts';

test('resolveStorylinePenClickBehavior keeps default clicks when no pen is active', () => {
  assert.equal(
    resolveStorylinePenClickBehavior(null, { kind: 'summary' }),
    'default'
  );
});

test('resolveStorylinePenClickBehavior preserves summary and glyph activation during pen mode', () => {
  assert.equal(
    resolveStorylinePenClickBehavior('focus', { kind: 'summary' }),
    'activate_and_steer'
  );
  assert.equal(
    resolveStorylinePenClickBehavior('elaborate', { kind: 'atomic' }),
    'activate_and_steer'
  );
});

test('resolveStorylinePenClickBehavior keeps column pen interactions steering-only', () => {
  assert.equal(
    resolveStorylinePenClickBehavior('ignore', { kind: 'column' }),
    'steer_only'
  );
});

test('shouldPreserveSteeringPopoverOnNextSelectionChange only preserves activate-and-steer clicks', () => {
  assert.equal(
    shouldPreserveSteeringPopoverOnNextSelectionChange('activate_and_steer'),
    true
  );
  assert.equal(
    shouldPreserveSteeringPopoverOnNextSelectionChange('steer_only'),
    false
  );
  assert.equal(
    shouldPreserveSteeringPopoverOnNextSelectionChange('default'),
    false
  );
});
