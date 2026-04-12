import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConvergeSummaryButtons } from './storylineSummaryButtons.ts';
import type { ConversationEntry } from '@/types';

test('buildConvergeSummaryButtons maps evaluation and mark_complete entries onto the converge after their dispatch turn', () => {
  const entries: ConversationEntry[] = [
    {
      id: 'steer_1',
      type: 'steering_action',
      timestamp: '2026-03-21T10:00:00.000Z',
      text: 'Focus on revenue',
    },
    {
      id: 'evaluation_old',
      type: 'evaluation',
      timestamp: '2026-03-21T10:01:00.000Z',
      text: 'Old stage summary',
      dispatchTurnIndex: 0,
    },
    {
      id: 'evaluation_latest',
      type: 'evaluation',
      timestamp: '2026-03-21T10:02:00.000Z',
      text: 'Latest stage summary',
      dispatchTurnIndex: 0,
    },
    {
      id: 'mark_complete_latest',
      type: 'mark_complete',
      timestamp: '2026-03-21T10:03:00.000Z',
      text: 'Final summary',
      dispatchTurnIndex: 0,
    },
    {
      id: 'mark_complete_missing_turn',
      type: 'mark_complete',
      timestamp: '2026-03-21T10:04:00.000Z',
      text: 'Should be ignored',
    },
  ];

  assert.deepEqual(buildConvergeSummaryButtons(entries), [
    {
      id: 'converge-summary:stage:evaluation_latest',
      entryId: 'evaluation_latest',
      convergeIndex: 1,
      dispatchTurnIndex: 0,
      kind: 'stage',
    },
    {
      id: 'converge-summary:final:mark_complete_latest',
      entryId: 'mark_complete_latest',
      convergeIndex: 1,
      dispatchTurnIndex: 0,
      kind: 'final',
    },
  ]);
});
