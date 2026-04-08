import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcess } from 'node:child_process';

import { buildResumeCliArgs, ensureRunProcessForSteer } from './resumeRun.ts';
import {
  LLM_CACHE_READ_FILE_ENV,
  LLM_CACHE_WRITE_FILE_ENV,
  STABLE_LLM_OUTPUT_ENV,
} from './backendEnv.ts';

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

test('buildResumeCliArgs targets cli resume mode for the existing run directory', () => {
  assert.deepEqual(buildResumeCliArgs('D:/runs/run_123', 'D:/data/vgsales.csv'), [
    '-u',
    'cli.py',
    '--resume',
    '--run-dir',
    'D:/runs/run_123',
    '--dataset',
    'D:/data/vgsales.csv',
  ]);
});

test('ensureRunProcessForSteer reuses an existing live process', async () => {
  const liveChild = new FakeChildProcess() as unknown as ChildProcess;
  const runningProcesses = new Map<string, ChildProcess>([['run_123', liveChild]]);
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'resume-run-live-'));
  let spawned = false;

  const child = await ensureRunProcessForSteer({
    backendDir: 'D:/backend',
    runId: 'run_123',
    runsDir,
    runningProcesses,
    state: { dataset_path: 'D:/data/vgsales.csv' },
    spawnProcess: (() => {
      spawned = true;
      return new FakeChildProcess() as unknown as ChildProcess;
    }) as typeof import('node:child_process').spawn,
  });

  assert.equal(child, liveChild);
  assert.equal(spawned, false);
  await rm(runsDir, { recursive: true, force: true });
});

test('ensureRunProcessForSteer spawns a resume process when the original one is gone', async () => {
  const runningProcesses = new Map<string, ChildProcess>();
  const resumedChild = new FakeChildProcess() as unknown as ChildProcess;
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'resume-run-spawn-'));
  const backendDir = path.join(repoRoot, 'backend');
  const runsDir = path.join(backendDir, 'runs');
  const currentDatasetPath = path.join(repoRoot, 'data', 'vgsales.csv');
  let captured:
    | {
        command: string;
        args: string[];
        options: { cwd?: string; env?: NodeJS.ProcessEnv };
      }
    | undefined;

  await mkdir(runsDir, { recursive: true });
  await mkdir(path.dirname(currentDatasetPath), { recursive: true });
  await writeFile(currentDatasetPath, 'name,value\nsample,1\n', 'utf8');
  const previousCacheRead = process.env[LLM_CACHE_READ_FILE_ENV];
  const previousCacheWrite = process.env[LLM_CACHE_WRITE_FILE_ENV];
  const previousStableOutput = process.env[STABLE_LLM_OUTPUT_ENV];

  try {
    process.env[LLM_CACHE_READ_FILE_ENV] = 'seed-cache.json';
    process.env[LLM_CACHE_WRITE_FILE_ENV] = 'record-cache.json';
    process.env[STABLE_LLM_OUTPUT_ENV] = '1';
    const child = await ensureRunProcessForSteer({
      backendDir,
      runId: 'run_123',
      runsDir,
      runningProcesses,
      state: { dataset_path: currentDatasetPath },
      userGoal: 'Follow-up goal',
      resumeMessageJson: JSON.stringify({
        message_id: 'msg_resume',
        timestamp: '2026-03-08T13:14:15.988Z',
        content: 'Follow-up goal',
        kind: 'focus',
      }),
      userMessageId: 'msg_resume',
      userMessageTimestamp: '2026-03-08T13:14:15.988Z',
      spawnProcess: ((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        captured = { command, args, options };
        return resumedChild;
      }) as typeof import('node:child_process').spawn,
    });

    assert.equal(child, resumedChild);
    assert.equal(captured?.command, 'python');
    assert.deepEqual(captured?.args, [
      ...buildResumeCliArgs(path.join(runsDir, 'run_123'), currentDatasetPath),
      '--user-goal',
      'Follow-up goal',
      '--resume-message-json',
      JSON.stringify({
        message_id: 'msg_resume',
        timestamp: '2026-03-08T13:14:15.988Z',
        content: 'Follow-up goal',
        kind: 'focus',
      }),
      '--stable',
    ]);
    assert.equal(captured?.options.cwd, backendDir);
    assert.equal(captured?.options.env?.[LLM_CACHE_READ_FILE_ENV], 'seed-cache.json');
    assert.equal(captured?.options.env?.[LLM_CACHE_WRITE_FILE_ENV], 'record-cache.json');
    assert.equal(runningProcesses.get('run_123'), resumedChild);
  } finally {
    if (previousCacheRead === undefined) {
      delete process.env[LLM_CACHE_READ_FILE_ENV];
    } else {
      process.env[LLM_CACHE_READ_FILE_ENV] = previousCacheRead;
    }
    if (previousCacheWrite === undefined) {
      delete process.env[LLM_CACHE_WRITE_FILE_ENV];
    } else {
      process.env[LLM_CACHE_WRITE_FILE_ENV] = previousCacheWrite;
    }
    if (previousStableOutput === undefined) {
      delete process.env[STABLE_LLM_OUTPUT_ENV];
    } else {
      process.env[STABLE_LLM_OUTPUT_ENV] = previousStableOutput;
    }
    (resumedChild as unknown as FakeChildProcess).emit('exit', 0);
    await rm(repoRoot, { recursive: true, force: true });
  }

  assert.equal(runningProcesses.has('run_123'), false);
});

test('ensureRunProcessForSteer remaps a stale absolute dataset path to the current repo data directory', async () => {
  const resumedChild = new FakeChildProcess() as unknown as ChildProcess;
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'resume-run-remap-'));
  const backendDir = path.join(repoRoot, 'backend');
  const runsDir = path.join(backendDir, 'runs');
  const currentDatasetPath = path.join(repoRoot, 'data', 'vgsales.csv');

  await mkdir(runsDir, { recursive: true });
  await mkdir(path.dirname(currentDatasetPath), { recursive: true });
  await writeFile(currentDatasetPath, 'name,value\nsample,1\n', 'utf8');

  let captured:
    | {
        command: string;
        args: string[];
      }
    | undefined;

  try {
    await ensureRunProcessForSteer({
      backendDir,
      runId: 'run_legacy_path',
      runsDir,
      runningProcesses: new Map<string, ChildProcess>(),
      state: { dataset_path: 'D:/legacy-repo/data/vgsales.csv' },
      spawnProcess: ((command: string, args: string[]) => {
        captured = { command, args };
        return resumedChild;
      }) as typeof import('node:child_process').spawn,
    });
  } finally {
    (resumedChild as unknown as FakeChildProcess).emit('exit', 0);
    await rm(repoRoot, { recursive: true, force: true });
  }

  assert.equal(captured?.command, 'python');
  assert.deepEqual(captured?.args, buildResumeCliArgs(path.join(runsDir, 'run_legacy_path'), currentDatasetPath));
});
