import { promises as fs } from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';

const RUN_PROCESS_STATE_FILE = '.run-process.json';

type PersistedRunProcessState = {
  pid: number;
  recorded_at: string;
};

export type PersistedRunProcessStatus = 'alive' | 'dead' | 'missing';

export function getRunProcessStatePath(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, RUN_PROCESS_STATE_FILE);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function persistRunProcessState(
  runsDir: string,
  runId: string,
  child: ChildProcess
): Promise<void> {
  if (typeof child.pid !== 'number' || child.pid <= 0) {
    return;
  }
  const filePath = getRunProcessStatePath(runsDir, runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: PersistedRunProcessState = {
    pid: child.pid,
    recorded_at: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

export async function clearRunProcessState(
  runsDir: string,
  runId: string,
  pid?: number | null
): Promise<void> {
  const filePath = getRunProcessStatePath(runsDir, runId);
  try {
    if (typeof pid === 'number' && pid > 0) {
      const content = await fs.readFile(filePath, 'utf-8');
      const payload = JSON.parse(content) as Partial<PersistedRunProcessState>;
      if (payload.pid !== pid) {
        return;
      }
    }
    await fs.unlink(filePath);
  } catch {
    // Ignore missing or unreadable state files.
  }
}

export async function getPersistedRunProcessStatus(
  runsDir: string,
  runId: string
): Promise<PersistedRunProcessStatus> {
  const filePath = getRunProcessStatePath(runsDir, runId);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const payload = JSON.parse(content) as Partial<PersistedRunProcessState>;
    if (typeof payload.pid !== 'number' || payload.pid <= 0) {
      await clearRunProcessState(runsDir, runId);
      return 'dead';
    }
    if (!isProcessAlive(payload.pid)) {
      await clearRunProcessState(runsDir, runId, payload.pid);
      return 'dead';
    }
    return 'alive';
  } catch {
    return 'missing';
  }
}

export async function hasLivePersistedRunProcess(
  runsDir: string,
  runId: string
): Promise<boolean> {
  return (await getPersistedRunProcessStatus(runsDir, runId)) === 'alive';
}
