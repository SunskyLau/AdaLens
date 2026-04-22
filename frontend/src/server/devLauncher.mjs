import { spawn } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

const STABLE_LLM_OUTPUT_ENV = 'AGENTIC_EDA_STABLE_LLM_OUTPUT';
const CREATE_PLANS_REPLAY_ENV = 'AGENTIC_EDA_CREATE_PLANS_REPLAY';

export function parseDevLauncherArgs(argv) {
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
    throw new Error(`Unknown dev launcher argument: ${arg}`);
  }

  return { replay, stableLlmOutput };
}

function withBackendLaunchEnv(baseEnv, options) {
  const env = { ...baseEnv };
  delete env[STABLE_LLM_OUTPUT_ENV];
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
  const serverEnv = withBackendLaunchEnv(baseEnv, {
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
