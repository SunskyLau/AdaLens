import type { SteeringTargetSnapshot } from '@/types';

export type StorylinePenClickBehavior = 'default' | 'steer_only' | 'activate_and_steer';

export function resolveStorylinePenClickBehavior(
  activePen: 'focus' | 'ignore' | 'elaborate' | null,
  target: Pick<SteeringTargetSnapshot, 'kind'>
): StorylinePenClickBehavior {
  if (!activePen) {
    return 'default';
  }
  return target.kind === 'column' ? 'steer_only' : 'activate_and_steer';
}

export function shouldPreserveSteeringPopoverOnNextSelectionChange(
  clickBehavior: StorylinePenClickBehavior
): boolean {
  return clickBehavior === 'activate_and_steer';
}
