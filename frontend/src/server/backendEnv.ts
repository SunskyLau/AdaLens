export const LLM_CACHE_READ_FILE_ENV = 'AGENTIC_EDA_LLM_CACHE_READ_FILE';
export const LLM_CACHE_WRITE_FILE_ENV = 'AGENTIC_EDA_LLM_CACHE_WRITE_FILE';
export const STABLE_LLM_OUTPUT_ENV = 'AGENTIC_EDA_STABLE_LLM_OUTPUT';

export type LlmCacheEnvOptions = {
  readFile?: string | undefined;
  writeFile?: string | undefined;
};

export type BackendLaunchEnvOptions = LlmCacheEnvOptions & {
  stableLlmOutput?: boolean | undefined;
};

export function normalizeLlmCacheFileName(rawValue: unknown): string | undefined {
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

export function withLlmCacheEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: LlmCacheEnvOptions,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  delete env[LLM_CACHE_READ_FILE_ENV];
  delete env[LLM_CACHE_WRITE_FILE_ENV];

  const readFile = normalizeLlmCacheFileName(options.readFile);
  const writeFile = normalizeLlmCacheFileName(options.writeFile);

  if (readFile) {
    env[LLM_CACHE_READ_FILE_ENV] = readFile;
  }
  if (writeFile) {
    env[LLM_CACHE_WRITE_FILE_ENV] = writeFile;
  }
  return env;
}

export function isStableLlmOutputEnabled(baseEnv: NodeJS.ProcessEnv = process.env): boolean {
  return String(baseEnv[STABLE_LLM_OUTPUT_ENV] ?? '').trim() === '1';
}

export function withBackendLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: BackendLaunchEnvOptions,
): NodeJS.ProcessEnv {
  const env = withLlmCacheEnv(baseEnv, options);
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
    readFile: baseEnv[LLM_CACHE_READ_FILE_ENV],
    writeFile: baseEnv[LLM_CACHE_WRITE_FILE_ENV],
    stableLlmOutput: isStableLlmOutputEnabled(baseEnv),
  });
  env.PYTHONUNBUFFERED = '1';
  return env;
}
