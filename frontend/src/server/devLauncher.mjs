import { spawn } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

const LLM_CACHE_READ_FILE_ENV = 'AGENTIC_EDA_LLM_CACHE_READ_FILE';
const LLM_CACHE_WRITE_FILE_ENV = 'AGENTIC_EDA_LLM_CACHE_WRITE_FILE';
const STABLE_LLM_OUTPUT_ENV = 'AGENTIC_EDA_STABLE_LLM_OUTPUT';
const CREATE_PLANS_REPLAY_ENV = 'AGENTIC_EDA_CREATE_PLANS_REPLAY';

function normalizeLlmCacheFileName(rawValue) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`Invalid cache file name: ${trimmed}`);
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error(`Cache file name must stay within backend/.cache: ${trimmed}`);
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) {
    throw new Error(`Invalid cache file name: ${trimmed}`);
  }
  if (trimmed.toLowerCase().endsWith('.json')) {
    return trimmed;
  }
  return `${trimmed}.json`;
}

export function parseDevLauncherArgs(argv) {
  let llmCacheReadFile;
  let llmCacheWriteFile;
  let replay = false;
  let stableLlmOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--replay') {
      replay = true;
      continue;
    }
    if (arg === '--stable') {
      stableLlmOutput = true;
      continue;
    }
    if (arg.startsWith('--llm-cache-read=')) {
      llmCacheReadFile = normalizeLlmCacheFileName(arg.slice('--llm-cache-read='.length));
      continue;
    }
    if (arg.startsWith('--llm-cache-write=')) {
      llmCacheWriteFile = normalizeLlmCacheFileName(arg.slice('--llm-cache-write='.length));
      continue;
    }
    if (arg === '--llm-cache-read') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error('--llm-cache-read requires a cache file name');
      }
      llmCacheReadFile = normalizeLlmCacheFileName(nextValue);
      index += 1;
      continue;
    }
    if (arg === '--llm-cache-write') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error('--llm-cache-write requires a cache file name');
      }
      llmCacheWriteFile = normalizeLlmCacheFileName(nextValue);
      index += 1;
      continue;
    }
    throw new Error(`Unknown dev launcher argument: ${arg}`);
  }

  return { llmCacheReadFile, llmCacheWriteFile, replay, stableLlmOutput };
}

function withBackendLaunchEnv(baseEnv, options) {
  const env = { ...baseEnv };
  delete env[LLM_CACHE_READ_FILE_ENV];
  delete env[LLM_CACHE_WRITE_FILE_ENV];
  delete env[STABLE_LLM_OUTPUT_ENV];

  const readFile = normalizeLlmCacheFileName(options.llmCacheReadFile);
  const writeFile = normalizeLlmCacheFileName(options.llmCacheWriteFile);

  if (readFile) {
    env[LLM_CACHE_READ_FILE_ENV] = readFile;
  }
  if (writeFile) {
    env[LLM_CACHE_WRITE_FILE_ENV] = writeFile;
  }
  if (options.stableLlmOutput) {
    env[STABLE_LLM_OUTPUT_ENV] = '1';
  }

  return env;
}

function resolveNpmLaunch(platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'npm',
      shell: true,
    };
  }
  return {
    command: 'npm',
    shell: false,
  };
}

export function buildDevProcessSpecs(argv, baseEnv = process.env, platform = process.platform) {
  const options = parseDevLauncherArgs(argv);
  const npmLaunch = resolveNpmLaunch(platform);
  const serverEnv = withBackendLaunchEnv(baseEnv, options);
  if (options.replay) {
    serverEnv[CREATE_PLANS_REPLAY_ENV] = '1';
  } else {
    delete serverEnv[CREATE_PLANS_REPLAY_ENV];
  }
  const clientEnv = withBackendLaunchEnv(baseEnv, {});
  delete clientEnv[CREATE_PLANS_REPLAY_ENV];
  return [
    {
      name: 'server',
      ...npmLaunch,
      args: ['run', 'dev:server'],
      env: serverEnv,
    },
    {
      name: 'client',
      ...npmLaunch,
      args: ['run', 'dev:client'],
      env: clientEnv,
    },
  ];
}

function terminateChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
}

async function main() {
  const specs = buildDevProcessSpecs(process.argv.slice(2));
  const children = new Map();
  let shutdownRequested = false;
  let finalExitCode = 0;

  const requestShutdown = (exitCode) => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      finalExitCode = exitCode;
    }
    for (const child of children.values()) {
      terminateChild(child);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => requestShutdown(0));
  }

  await Promise.all(
    specs.map(
      (spec) =>
        new Promise((resolve, reject) => {
          const child = spawn(spec.command, spec.args, {
            stdio: 'inherit',
            env: spec.env,
            shell: spec.shell,
          });
          children.set(spec.name, child);
          child.once('error', (error) => {
            requestShutdown(1);
            reject(error);
          });
          child.once('exit', (code) => {
            children.delete(spec.name);
            if (!shutdownRequested && (code ?? 0) !== 0) {
              requestShutdown(code ?? 1);
            } else if (!shutdownRequested && children.size === 1) {
              requestShutdown(code ?? 0);
            }
            resolve();
          });
        }),
    ),
  );

  process.exitCode = finalExitCode;
}

const entryHref = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';

if (import.meta.url === entryHref) {
  void main();
}
