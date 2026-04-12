import type { RunState } from '@/types';

export function getConversationInputPlaceholder(
  status?: RunState['status'] | null
): string | undefined {
  switch (status) {
    case 'completed':
    case 'idle':
      return 'Start the next turn with a new analysis goal or follow-up question...';
    case 'paused':
    case 'running':
      return 'Continue entering guidance, constraints, or follow-up questions to steer this turn...';
    default:
      return undefined;
  }
}

export function getRunActivityLabel(
  runState: Pick<RunState, 'status' | 'frontier'> | null | undefined
): string | undefined {
  if (!runState || runState.status !== 'running') {
    return undefined;
  }

  const frontier = Array.isArray(runState.frontier) ? runState.frontier : [];
  if (frontier.some((plan) => plan.status === 'summarizing')) {
    return 'Summarizing results...';
  }
  if (frontier.some((plan) => plan.status === 'analyzing')) {
    return 'Running analysis...';
  }
  return 'Agent is thinking...';
}

