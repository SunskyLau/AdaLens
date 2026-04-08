import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDevProcessSpecs, parseDevLauncherArgs } from './devLauncher.ts';
import {
  LLM_CACHE_READ_FILE_ENV,
  LLM_CACHE_WRITE_FILE_ENV,
  STABLE_LLM_OUTPUT_ENV,
} from './backendEnv.ts';

const CREATE_PLANS_REPLAY_ENV = 'AGENTIC_EDA_CREATE_PLANS_REPLAY';

test('parseDevLauncherArgs defaults cache read/write files to undefined', () => {
  assert.deepEqual(parseDevLauncherArgs([]), {
    llmCacheReadFile: undefined,
    llmCacheWriteFile: undefined,
    replay: false,
    stableLlmOutput: false,
  });
});

test('parseDevLauncherArgs accepts cache read/write file names', () => {
  assert.deepEqual(parseDevLauncherArgs(['--llm-cache-read', 'case-study']), {
    llmCacheReadFile: 'case-study.json',
    llmCacheWriteFile: undefined,
    replay: false,
    stableLlmOutput: false,
  });
  assert.deepEqual(parseDevLauncherArgs(['--llm-cache-write=recorded.json']), {
    llmCacheReadFile: undefined,
    llmCacheWriteFile: 'recorded.json',
    replay: false,
    stableLlmOutput: false,
  });
  assert.deepEqual(
    parseDevLauncherArgs([
      '--llm-cache-read',
      'seed-cache.json',
      '--llm-cache-write',
      'session-cache',
      '--replay',
      '--stable',
    ]),
    {
      llmCacheReadFile: 'seed-cache.json',
      llmCacheWriteFile: 'session-cache.json',
      replay: true,
      stableLlmOutput: true,
    },
  );
});

test('buildDevProcessSpecs sends cache file env only to the server process', () => {
  const specs = buildDevProcessSpecs(
    ['--llm-cache-read', 'seed-cache', '--llm-cache-write', 'record-cache'],
    {
      PATH: 'C:/Windows/System32',
      [LLM_CACHE_READ_FILE_ENV]: 'stale-read.json',
      [LLM_CACHE_WRITE_FILE_ENV]: 'stale-write.json',
    },
  );

  assert.equal(specs.length, 2);
  assert.equal(specs[0]?.name, 'server');
  assert.equal(specs[0]?.env[LLM_CACHE_READ_FILE_ENV], 'seed-cache.json');
  assert.equal(specs[0]?.env[LLM_CACHE_WRITE_FILE_ENV], 'record-cache.json');
  assert.equal(specs[0]?.env[STABLE_LLM_OUTPUT_ENV], undefined);
  assert.equal(specs[0]?.env[CREATE_PLANS_REPLAY_ENV], undefined);
  assert.deepEqual(specs[0]?.args, ['run', 'dev:server']);

  assert.equal(specs[1]?.name, 'client');
  assert.equal(specs[1]?.env[LLM_CACHE_READ_FILE_ENV], undefined);
  assert.equal(specs[1]?.env[LLM_CACHE_WRITE_FILE_ENV], undefined);
  assert.equal(specs[1]?.env[STABLE_LLM_OUTPUT_ENV], undefined);
  assert.equal(specs[1]?.env[CREATE_PLANS_REPLAY_ENV], undefined);
  assert.deepEqual(specs[1]?.args, ['run', 'dev:client']);
});

test('buildDevProcessSpecs sends replay env only to the server process', () => {
  const specs = buildDevProcessSpecs(['--replay'], {
    PATH: 'C:/Windows/System32',
    [CREATE_PLANS_REPLAY_ENV]: 'stale',
  });

  assert.equal(specs[0]?.name, 'server');
  assert.equal(specs[0]?.env[CREATE_PLANS_REPLAY_ENV], '1');
  assert.equal(specs[1]?.name, 'client');
  assert.equal(specs[1]?.env[CREATE_PLANS_REPLAY_ENV], undefined);
});

test('buildDevProcessSpecs enables stable output only for the server process', () => {
  const specs = buildDevProcessSpecs(['--stable'], {
    PATH: 'C:/Windows/System32',
  });

  assert.equal(specs[0]?.name, 'server');
  assert.equal(specs[0]?.env[STABLE_LLM_OUTPUT_ENV], '1');
  assert.equal(specs[1]?.name, 'client');
  assert.equal(specs[1]?.env[STABLE_LLM_OUTPUT_ENV], undefined);
});

test('buildDevProcessSpecs allows replay and stable flags together for the server process', () => {
  const specs = buildDevProcessSpecs(['--replay', '--stable'], {
    PATH: 'C:/Windows/System32',
  });

  assert.equal(specs[0]?.name, 'server');
  assert.equal(specs[0]?.env[CREATE_PLANS_REPLAY_ENV], '1');
  assert.equal(specs[0]?.env[STABLE_LLM_OUTPUT_ENV], '1');
  assert.equal(specs[1]?.name, 'client');
  assert.equal(specs[1]?.env[CREATE_PLANS_REPLAY_ENV], undefined);
  assert.equal(specs[1]?.env[STABLE_LLM_OUTPUT_ENV], undefined);
});

test('buildDevProcessSpecs uses a shell-backed npm launch on Windows', () => {
  const specs = buildDevProcessSpecs(
    [],
    {
      PATH: 'C:/Windows/System32',
    },
    'win32',
  );

  assert.equal(specs[0]?.command, 'npm');
  assert.equal(specs[0]?.shell, true);
  assert.equal(specs[1]?.command, 'npm');
  assert.equal(specs[1]?.shell, true);
});

test('parseDevLauncherArgs rejects old cache mode flags', () => {
  assert.throws(
    () => parseDevLauncherArgs(['--llm-cache-mode', 'on']),
    /Unknown dev launcher argument/,
  );
  assert.throws(
    () => parseDevLauncherArgs(['--llm-cache-clear']),
    /Unknown dev launcher argument/,
  );
});

test('parseDevLauncherArgs rejects missing cache file names', () => {
  assert.throws(
    () => parseDevLauncherArgs(['--llm-cache-read']),
    /--llm-cache-read requires a cache file name/,
  );
  assert.throws(
    () => parseDevLauncherArgs(['--llm-cache-write']),
    /--llm-cache-write requires a cache file name/,
  );
});
