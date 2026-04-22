import type { ConversationEntry } from '@/types';

export type StorylineConvergeSummaryButtonKind = 'stage' | 'final';

export interface StorylineConvergeSummaryButton {
  id: string;
  entryId: string;
  convergeIndex: number;
  dispatchTurnIndex: number;
  kind: StorylineConvergeSummaryButtonKind;
}

export function buildConvergeSummaryButtons(
  entries: readonly ConversationEntry[] | null | undefined
): StorylineConvergeSummaryButton[] {
  const latestByKey = new Map<string, StorylineConvergeSummaryButton>();

  for (const entry of entries ?? []) {
    if (
      (entry.type !== 'evaluation' && entry.type !== 'mark_complete')
      || typeof entry.dispatchTurnIndex !== 'number'
    ) {
      continue;
    }

    const kind: StorylineConvergeSummaryButtonKind =
      entry.type === 'evaluation' ? 'stage' : 'final';
    const convergeIndex = entry.dispatchTurnIndex + 1;
    latestByKey.set(`${convergeIndex}:${kind}`, {
      id: `converge-summary:${kind}:${entry.id}`,
      entryId: entry.id,
      convergeIndex,
      dispatchTurnIndex: entry.dispatchTurnIndex,
      kind,
    });
  }

  return [...latestByKey.values()].sort((left, right) => {
    if (left.convergeIndex !== right.convergeIndex) {
      return left.convergeIndex - right.convergeIndex;
    }
    if (left.kind === right.kind) {
      return left.entryId.localeCompare(right.entryId);
    }
    return left.kind === 'stage' ? -1 : 1;
  });
}

