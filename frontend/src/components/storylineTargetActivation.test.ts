import assert from 'node:assert/strict';
import test from 'node:test';

import type { Selection, SteeringTargetSnapshot } from '@/types';

import { activateStorylineTarget } from './storylineTargetActivation.ts';

function makeSelection(): Selection {
  return { type: null, id: null };
}

function makeSummaryTarget(): SteeringTargetSnapshot {
  return {
    kind: 'summary',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4.',
    columns: ['Revenue', 'Quarter'],
  };
}

function makeAtomicTarget(): SteeringTargetSnapshot {
  return {
    kind: 'atomic',
    summary_id: 's1',
    summary_short_label: 'Revenue spike',
    summary_text: 'Revenue spikes in Q4.',
    columns: ['Revenue'],
    atomic_id: 'a1',
    atomic_text: 'Revenue spikes specifically in Q4.',
    insight_type: 'trend',
  };
}

function makeColumnTarget(): SteeringTargetSnapshot {
  return {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: ['Revenue'],
  };
}

test('activateStorylineTarget replays summary click semantics and clears active filter first', () => {
  let cleared = 0;
  let nextSelection: Selection | null = null;

  activateStorylineTarget({
    target: makeSummaryTarget(),
    selection: makeSelection(),
    setSelection: (selection) => {
      nextSelection = selection;
    },
    storylineFilterSnapshot: { hasActiveFilter: true },
    storylineFilterActions: {
      clearAll: () => {
        cleared += 1;
      },
      replaceStorylineColumns: () => {
        throw new Error('column toggle should not run for summary replay');
      },
    },
  });

  assert.equal(cleared, 1);
  assert.deepEqual(nextSelection, { type: 'summary', id: 's1' });
});

test('activateStorylineTarget replays atomic click semantics and keeps atomic selection id stable', () => {
  let nextSelection: Selection | null = null;

  activateStorylineTarget({
    target: makeAtomicTarget(),
    selection: makeSelection(),
    setSelection: (selection) => {
      nextSelection = selection;
    },
    storylineFilterSnapshot: { hasActiveFilter: false },
    storylineFilterActions: {
      clearAll: () => {
        throw new Error('clearAll should not run when no filter is active');
      },
      replaceStorylineColumns: () => {
        throw new Error('column toggle should not run for atomic replay');
      },
    },
  });

  assert.deepEqual(nextSelection, { type: 'summary', id: 's1', atomicId: 'a1' });
});

test('activateStorylineTarget replays column steering as converge-style exclusive activation', () => {
  let replaced: { columns: string[]; source: string } | null = null;
  let setSelectionCalls = 0;

  activateStorylineTarget({
    target: makeColumnTarget(),
    selection: makeSelection(),
    setSelection: () => {
      setSelectionCalls += 1;
    },
    storylineFilterSnapshot: { hasActiveFilter: false },
    storylineFilterActions: {
      clearAll: () => {
        throw new Error('clearAll should not run for column replay');
      },
      replaceStorylineColumns: (columns, source) => {
        replaced = { columns: [...columns], source: source ?? 'non_converge' };
      },
    },
  });

  assert.equal(setSelectionCalls, 0);
  assert.deepEqual(replaced, { columns: ['Revenue'], source: 'chat_replay' });
});

test('activateStorylineTarget replays aggregated column steering by restoring the full selected column set', () => {
  let replaced: { columns: string[]; source: string } | null = null;

  activateStorylineTarget({
    target: {
      kind: 'column',
      summary_id: '',
      summary_short_label: '',
      summary_text: '',
      columns: ['Revenue', 'Region'],
    },
    selection: makeSelection(),
    setSelection: () => undefined,
    storylineFilterSnapshot: { hasActiveFilter: false },
    storylineFilterActions: {
      clearAll: () => {
        throw new Error('clearAll should not run for column replay');
      },
      replaceStorylineColumns: (columns, source) => {
        replaced = { columns: [...columns], source: source ?? 'non_converge' };
      },
    },
  });

  assert.deepEqual(replaced, { columns: ['Revenue', 'Region'], source: 'chat_replay' });
});
