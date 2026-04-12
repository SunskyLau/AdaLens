import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearRunProcessState,
  getPersistedRunProcessStatus,
  getRunProcessStatePath,
  hasLivePersistedRunProcess,
  isProcessAlive,
  persistRunProcessState,
} from './runProcessState.ts';

test('persistRunProcessState records a live child pid and clearRunProcessState removes it', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'run-process-state-'));
  const runId = 'run_123';
  const child = { pid: process.pid } as ChildProcess;

  await persistRunProcessState(runsDir, runId, child);

  const filePath = getRunProcessStatePath(runsDir, runId);
  const raw = await readFile(filePath, 'utf-8');
  assert.match(raw, new RegExp(`\"pid\":\\s*${process.pid}`));
  assert.equal(await getPersistedRunProcessStatus(runsDir, runId), 'alive');
  assert.equal(await hasLivePersistedRunProcess(runsDir, runId), true);

  await clearRunProcessState(runsDir, runId, process.pid);
  assert.equal(await getPersistedRunProcessStatus(runsDir, runId), 'missing');
  assert.equal(await hasLivePersistedRunProcess(runsDir, runId), false);
  await rm(runsDir, { recursive: true, force: true });
});

test('hasLivePersistedRunProcess clears malformed or dead process records', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'run-process-dead-'));
  const runId = 'run_456';
  const filePath = getRunProcessStatePath(runsDir, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ pid: 999999999 }), 'utf-8');

  assert.equal(isProcessAlive(999999999), false);
  assert.equal(await getPersistedRunProcessStatus(runsDir, runId), 'dead');
  assert.equal(await hasLivePersistedRunProcess(runsDir, runId), false);
  await rm(runsDir, { recursive: true, force: true });
});
