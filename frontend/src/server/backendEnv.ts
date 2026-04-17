export const STABLE_LLM_OUTPUT_ENV = 'AGENTIC_EDA_STABLE_LLM_OUTPUT';
export const CREATE_PLANS_REPLAY_ENV = 'AGENTIC_EDA_CREATE_PLANS_REPLAY';

export type BackendLaunchEnvOptions = {
  stableLlmOutput?: boolean | undefined;
};

export function isStableLlmOutputEnabled(baseEnv: NodeJS.ProcessEnv = process.env): boolean {
  return String(baseEnv[STABLE_LLM_OUTPUT_ENV] ?? '').trim() === '1';
}

export function withBackendLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: BackendLaunchEnvOptions,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env[STABLE_LLM_OUTPUT_ENV];
  if (options.stableLlmOutput) {
    env[STABLE_LLM_OUTPUT_ENV] = '1';
  }
  return env;
}

export function buildBackendProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = withBackendLaunchEnv(baseEnv, {
    stableLlmOutput: isStableLlmOutputEnabled(baseEnv),
  });
  env.PYTHONUNBUFFERED = '1';
  return env;
}
