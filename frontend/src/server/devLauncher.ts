import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

import {
  normalizeLlmCacheFileName,
  withBackendLaunchEnv,
} from './backendEnv';

const CREATE_PLANS_REPLAY_ENV = 'AGENTIC_EDA_CREATE_PLANS_REPLAY';

type DevLauncherOptions = {
  llmCacheReadFile?: string;
  llmCacheWriteFile?: string;
  replay?: boolean;
  stableLlmOutput?: boolean;
};

type DevProcessSpec = {
  name: 'server' | 'client';
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
};

function resolveNpmLaunch(
  platform: NodeJS.Platform = process.platform,
): Pick<DevProcessSpec, 'command' | 'shell'> {
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

export function parseDevLauncherArgs(argv: string[]): DevLauncherOptions {
  let llmCacheReadFile: string | undefined;
  let llmCacheWriteFile: string | undefined;
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

export function buildDevProcessSpecs(
  argv: string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DevProcessSpec[] {
  const options = parseDevLauncherArgs(argv);
  const npmLaunch = resolveNpmLaunch(platform);
  const serverEnv = withBackendLaunchEnv(baseEnv, {
    readFile: options.llmCacheReadFile,
    writeFile: options.llmCacheWriteFile,
    stableLlmOutput: options.stableLlmOutput,
  });
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

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
}

async function main(): Promise<void> {
  const specs = buildDevProcessSpecs(process.argv.slice(2));
  const children = new Map<string, ChildProcess>();
  let shutdownRequested = false;
  let finalExitCode = 0;

  const requestShutdown = (exitCode: number) => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      finalExitCode = exitCode;
    }
    for (const child of children.values()) {
      terminateChild(child);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => requestShutdown(0));
  }

  await Promise.all(
    specs.map(
      (spec) =>
        new Promise<void>((resolve, reject) => {
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

if (entryHref === import.meta.url) {
  void main();
}
