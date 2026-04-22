import type { Selection, SteeringTargetSnapshot } from '@/types';

import type { StorylineFilterActions, StorylineFilterSnapshot } from './storylineFilter';
import {
  resolveStorylineAtomicSelectionAfterFilterClear,
  resolveStorylineSummarySelectionAfterFilterClear,
} from './storylineGraphSelection';

interface ActivateStorylineTargetArgs {
  target: SteeringTargetSnapshot;
  selection: Selection;
  setSelection: (selection: Selection) => void;
  storylineFilterSnapshot: Pick<StorylineFilterSnapshot, 'hasActiveFilter'>;
  storylineFilterActions: Pick<StorylineFilterActions, 'clearAll' | 'replaceStorylineColumns'>;
}

export function activateStorylineTarget(args: ActivateStorylineTargetArgs): void {
  const {
    target,
    selection,
    setSelection,
    storylineFilterSnapshot,
    storylineFilterActions,
  } = args;

  if (target.kind === 'summary') {
    const nextSelection = resolveStorylineSummarySelectionAfterFilterClear({
      selection,
      summaryId: target.summary_id,
      hasActiveFilter: storylineFilterSnapshot.hasActiveFilter,
    });
    if (storylineFilterSnapshot.hasActiveFilter) {
      storylineFilterActions.clearAll();
    }
    setSelection(nextSelection);
    return;
  }

  if (target.kind === 'atomic') {
    const atomicId = target.atomic_id ?? '';
    if (!atomicId) {
      return;
    }
    const nextSelection = resolveStorylineAtomicSelectionAfterFilterClear({
      selection,
      summaryId: target.summary_id,
      atomicId,
      hasActiveFilter: storylineFilterSnapshot.hasActiveFilter,
    });
    if (storylineFilterSnapshot.hasActiveFilter) {
      storylineFilterActions.clearAll();
    }
    setSelection(nextSelection);
    return;
  }

  const selectedColumns = target.columns.map((column) => column.trim()).filter(Boolean);
  if (selectedColumns.length === 0) {
    return;
  }
  storylineFilterActions.replaceStorylineColumns(selectedColumns, 'chat_replay');
}
