/**
 * API Client for Run Gateway
 */

import type {
  DatasetPreviewResponse,
  DatasetUploadResponse,
  Event,
  GenerateReportRequest,
  GenerateReportResponse,
  PlanControlAction,
  PlanControlResponse,
  RunState,
  RunSummary,
  SteerRunRequest,
  SteerRunResponse,
  StartRunRequest,
  StartRunResponse,
  StopRunResponse,
  UpdateRunSettingsRequest,
  UpdateRunSettingsResponse,
} from '@/types';

import { API_BASE, DATA_VIEW_PREVIEW_ROWS } from '@/config';

type ErrorPayload = { error?: unknown; reason?: unknown };

function normalizeArtifactPath(artifactPath: string): string {
  return artifactPath.replace(/\\/g, '/');
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const e = payload as ErrorPayload;
    const base = typeof e.error === 'string' && e.error ? e.error : fallback;
    const reason = typeof e.reason === 'string' && e.reason ? ` (${e.reason})` : '';
    return base + reason;
  }
  return fallback;
}

// ============================================================================
// Run Management
// ============================================================================

export type StartRunOptions = StartRunRequest;

export async function startRun(options: StartRunOptions): Promise<StartRunResponse> {
  const requestBody = {
    dataset_path: options.dataset_path,
    user_goal: options.user_goal,
    ...(options.default_sub_agents_num !== undefined
      ? { default_sub_agents_num: options.default_sub_agents_num }
      : {}),
    ...(options.max_concurrency !== undefined
      ? { max_concurrency: options.max_concurrency }
      : {}),
    ...(options.max_initial_plans !== undefined
      ? { max_initial_plans: options.max_initial_plans }
      : {}),
  };
  const response = await fetch(`${API_BASE}/runs/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to start run'));
  }
  
  return response.json();
}

export async function uploadDataset(file: File): Promise<DatasetUploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE}/datasets/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to upload dataset'));
  }

  return response.json();
}

export async function stopRun(runId: string): Promise<StopRunResponse> {
  const response = await fetch(`${API_BASE}/runs/${runId}/stop`, {
    method: 'POST',
  });
  
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to stop run'));
  }
  
  return response.json();
}

export async function updateRunSettings(
  runId: string,
  options: UpdateRunSettingsRequest
): Promise<UpdateRunSettingsResponse> {
  const response = await fetch(`${API_BASE}/runs/${runId}/settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update run settings'));
  }

  return response.json();
}

export async function controlPlan(
  runId: string,
  planId: string,
  action: PlanControlAction
): Promise<PlanControlResponse> {
  const response = await fetch(`${API_BASE}/runs/${runId}/plans/${planId}/control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to control plan'));
  }

  return response.json();
}

export type SteerRunOptions = SteerRunRequest;

export async function steerRun(
  runId: string,
  options: SteerRunOptions
): Promise<SteerRunResponse> {
  const response = await fetch(`${API_BASE}/runs/${runId}/steer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to steer run'));
  }

  return response.json();
}

// ============================================================================
// Data Fetching
// ============================================================================

export async function fetchRuns(options?: { includeLegacy?: boolean }): Promise<RunSummary[]> {
  const params = new URLSearchParams();
  if (options?.includeLegacy) {
    params.set('includeLegacy', '1');
  }
  const query = params.toString();
  const url = query ? `${API_BASE}/runs?${query}` : `${API_BASE}/runs`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch runs');
  }
  return response.json();
}

export async function fetchRunState(runId: string): Promise<RunState> {
  const response = await fetch(`${API_BASE}/runs/${runId}/state`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch run state'));
  }
  return response.json();
}

export async function fetchEvents(runId: string): Promise<Event[]> {
  const response = await fetch(`${API_BASE}/runs/${runId}/events`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch events'));
  }
  return response.json();
}

export async function fetchDatasetPreview(
  runId: string,
  limit: number = DATA_VIEW_PREVIEW_ROWS,
  offset: number = 0
): Promise<DatasetPreviewResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(Math.max(0, offset)),
  });
  const response = await fetch(`${API_BASE}/runs/${runId}/dataset/preview?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch dataset preview'));
  }
  return response.json();
}

export async function fetchArtifact(runId: string, artifactPath: string): Promise<string> {
  const normalizedPath = normalizeArtifactPath(artifactPath);
  const response = await fetch(`${API_BASE}/runs/${runId}/artifact/${normalizedPath}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to fetch artifact'));
  }
  return response.text();
}

// ============================================================================
// Reporting
// ============================================================================

export type GenerateReportOptions = GenerateReportRequest;

export async function generateReport(runId: string, options: GenerateReportOptions): Promise<GenerateReportResponse> {
  const response = await fetch(`${API_BASE}/runs/${runId}/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to generate report'));
  }

  return response.json();
}

export function getArtifactUrl(runId: string, artifactPath: string): string {
  const normalizedPath = normalizeArtifactPath(artifactPath);
  return `${API_BASE}/runs/${runId}/artifact/${normalizedPath}`;
}

export function subscribeToEvents(
  runId: string,
  onEvent: (event: Event) => void,
  onError?: (error: Error) => void,
  options?: { from?: number }
): () => void {
  const params = new URLSearchParams();
  if (typeof options?.from === 'number') {
    params.set('from', String(options.from));
  }
  const query = params.toString();
  const url = query
    ? `${API_BASE}/runs/${runId}/events/stream?${query}`
    : `${API_BASE}/runs/${runId}/events/stream`;
  const eventSource = new EventSource(url);
  
  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as Event;
      onEvent(event);
    } catch (error) {
      console.error('Failed to parse event:', error);
    }
  };
  
  eventSource.onerror = () => {
    if (onError) {
      onError(new Error('Event stream error'));
    }
  };
  
  return () => {
    eventSource.close();
  };
}
