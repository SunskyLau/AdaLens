import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'node:fs';
import path from 'path';

import { buildBackendProcessEnv, isStableLlmOutputEnabled } from './backendEnv';
import { resolveDatasetPathFromState } from './datasetPath';
import { clearRunProcessState, persistRunProcessState } from './runProcessState';

type ResumeRunStateLike = {
  dataset_path?: unknown;
};

type SpawnRunProcess = typeof spawn;

function logProcessOutput(runId: string, child: ChildProcess) {
  child.stdout?.on('data', (data) => {
    console.log(`[${runId}] stdout:`, data.toString().trim());
  });

  child.stderr?.on('data', (data) => {
    console.error(`[${runId}] stderr:`, data.toString().trim());
  });
}

async function waitForChildStartup(child: ChildProcess, timeoutMs = 300): Promise<void> {
  if (child.exitCode !== null) {
    throw new Error(`Resume process exited immediately with code ${child.exitCode}`);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      child.off('error', onError);
      child.off('exit', onExit);
      clearTimeout(timer);
      callback();
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number | null) =>
      finish(() => reject(new Error(`Resume process exited with code ${code ?? 1}`)));
    const timer = setTimeout(() => finish(resolve), timeoutMs);

    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export function buildResumeCliArgs(runDir: string, datasetPath: string): string[] {
  return ['-u', 'cli.py', '--resume', '--run-dir', runDir, '--dataset', datasetPath];
}

export async function ensureRunProcessForSteer(options: {
  backendDir: string;
  runId: string;
  runsDir: string;
  runningProcesses: Map<string, ChildProcess>;
  state: ResumeRunStateLike;
  userGoal?: string;
  resumeMessageJson?: string;
  userMessageId?: string;
  userMessageTimestamp?: string;
  spawnProcess?: SpawnRunProcess;
}): Promise<ChildProcess> {
  const {
    backendDir,
    runId,
    runsDir,
    runningProcesses,
    state,
    userGoal,
    resumeMessageJson,
    userMessageId,
    userMessageTimestamp,
    spawnProcess = spawn,
  } = options;

  const existing = runningProcesses.get(runId);
  if (existing && existing.exitCode === null) {
    return existing;
  }
  if (existing) {
    runningProcesses.delete(runId);
  }

  const savedDatasetPath = typeof state.dataset_path === 'string' ? state.dataset_path.trim() : '';
  if (!savedDatasetPath) {
    throw new Error('Run is missing dataset_path');
  }

  const repoRoot = path.dirname(backendDir);
  const datasetPath = resolveDatasetPathFromState(savedDatasetPath, repoRoot);
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset not found for resumed run: ${savedDatasetPath}`);
  }

  const runDir = path.join(runsDir, runId);
  const args = buildResumeCliArgs(runDir, datasetPath);
  if (typeof userGoal === 'string' && userGoal.trim()) {
    args.push('--user-goal', userGoal.trim());
  }
  if (typeof resumeMessageJson === 'string' && resumeMessageJson.trim()) {
    args.push('--resume-message-json', resumeMessageJson);
  } else if (typeof userMessageId === 'string' && userMessageId && typeof userMessageTimestamp === 'string' && userMessageTimestamp) {
    args.push('--user-message-id', userMessageId, '--user-message-timestamp', userMessageTimestamp);
  }
  if (isStableLlmOutputEnabled()) {
    args.push('--stable');
  }
  const child = spawnProcess('python', args, {
    cwd: backendDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildBackendProcessEnv(),
  });

  logProcessOutput(runId, child);
  child.on('error', (error) => {
    console.error(`[RunGateway] Failed to resume run ${runId}:`, error);
  });
  child.on('exit', (code) => {
    if (runningProcesses.get(runId) === child) {
      runningProcesses.delete(runId);
    }
    void clearRunProcessState(runsDir, runId, child.pid);
    console.log(`[RunGateway] Resumed run ${runId} process exited with code ${code ?? 1}`);
  });

  runningProcesses.set(runId, child);
  await persistRunProcessState(runsDir, runId, child);
  await waitForChildStartup(child);
  return child;
}
