export const ENDED_SESSION_ERROR =
  'The analysis session has ended. Please start a new conversation.';

export type ProcessStateLike = { exitCode: number | null } | null | undefined;
export type ResumableRunStatus = string | null | undefined;

export function isResumableRunStatus(status: ResumableRunStatus): boolean {
  return status === 'running' || status === 'paused' || status === 'idle' || status === 'completed';
}

export function getEndedSessionError(
  process: ProcessStateLike,
  status?: ResumableRunStatus
): string | null {
  if (process && process.exitCode === null) {
    return null;
  }
  if (isResumableRunStatus(status)) {
    return null;
  }
  return ENDED_SESSION_ERROR;
}
