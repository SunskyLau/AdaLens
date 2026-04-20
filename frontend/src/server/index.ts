/**
 * Run Gateway Server
 * 
 * Provides HTTP/SSE endpoints for the frontend to access run data:
 * - GET /api/runs - List all runs
 * - POST /api/datasets/upload - Upload a CSV and return a dataset_path
 * - POST /api/runs/start - Start a new run
 * - POST /api/runs/:runId/stop - Request a graceful stop for a running run
 * - POST /api/runs/:runId/steer - Send a steer message to a running run
 * - POST /api/runs/:runId/report - Generate a Summary report (drill-down chain)
 * - GET /api/runs/:runId/state - Get run state snapshot
 * - GET /api/runs/:runId/dataset/preview - Get CSV dataset preview for Data View
 * - GET /api/runs/:runId/events - Get all events (or stream via SSE)
 * - GET /api/runs/:runId/artifact/* - Get artifact file content
 */

import express from 'express';
import cors from 'cors';
import { mkdirSync, promises as fs } from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';

import {
  DATA_CONTRACT_VERSION,
  DATA_VIEW_MAX_FILE_BYTES,
  DATA_VIEW_MAX_ROWS,
  DATA_VIEW_PREVIEW_ROWS,
  RUN_GATEWAY_PORT,
} from '../config';
import type {
  GenerateReportRequest,
  PlanControlAction,
  StartRunRequest,
  SteerRunRequest,
  UpdateRunSettingsRequest,
} from '../types';
import { buildCsvPreview, normalizeCsvDelimiter, sniffCsvDelimiter } from './csvPreview';
import { resolveDatasetPathFromState } from './datasetPath';
import {
  buildUploadedDatasetFilename,
  DATASET_UPLOAD_FIELD_NAME,
  DATASET_UPLOAD_MAX_BYTES,
  DATASET_UPLOAD_SUBDIR,
  isAllowedCsvMimeType,
  isCsvUploadFilename,
} from './datasetsUpload';
import { ensureRunProcessForSteer } from './resumeRun';
import {
  applyPendingPlanControlPreviews,
  applyPlanControlToPlanRecord,
  applyPlanControlPreviewToPlanRecord,
  buildPlanControlResponse,
  shouldEnsureRunProcessForPlanControl,
  type PlanRecord,
} from './planControl';
import {
  clearRunProcessState,
  getPersistedRunProcessStatus,
  persistRunProcessState,
} from './runProcessState';
import { buildBackendProcessEnv, isStableLlmOutputEnabled } from './backendEnv';
import { getEndedSessionError } from './steerSession';
import { normalizeCjkTerminalPunctuation } from '../utils/textNormalization';

const app = express();
const PORT = RUN_GATEWAY_PORT;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Backend directory paths - relative to this server file (robust to process.cwd())
const REPO_ROOT = path.resolve(__dirname, '../../..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const RUNS_DIR = path.join(BACKEND_DIR, 'runs');
const DATASET_UPLOADS_DIR = path.join(RUNS_DIR, DATASET_UPLOAD_SUBDIR);
const MAX_CONCURRENCY_MIN = 1;
const MAX_CONCURRENCY_MAX = 6;
const DEV_STABLE_LLM_OUTPUT = isStableLlmOutputEnabled();

// Track running processes
const runningProcesses: Map<string, ChildProcess> = new Map();

app.use(cors());
app.use(express.json());

// ============================================================================
// Helper Functions
// ============================================================================

type LegacyCheck = {
  is_legacy: boolean;
  contract_version: string;
  reason?: string;
};

type UserSteerMessage = {
  message_id: string;
  timestamp: string;
  content: string;
  kind?: 'chat' | 'focus' | 'ignore' | 'elaborate' | 'create';
  display_text?: string;
  generated_prompt?: string;
  user_prompt?: string;
  system_prompt?: string;
  selected_keywords?: string[];
  target?: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTargetColumns(rawColumns: unknown): string[] {
  if (!Array.isArray(rawColumns)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawColumn of rawColumns) {
    const column = String(rawColumn ?? '').trim();
    if (!column || seen.has(column)) {
      continue;
    }
    seen.add(column);
    normalized.push(column);
  }
  return normalized;
}

function normalizeKeywords(rawKeywords: unknown, limit = 10): string[] {
  if (!Array.isArray(rawKeywords)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawKeyword of rawKeywords) {
    const keyword = String(rawKeyword ?? '').trim();
    if (!keyword) {
      continue;
    }
    const lookupKey = keyword.toLocaleLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }
    seen.add(lookupKey);
    normalized.push(keyword);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function clampMaxConcurrency(value: unknown): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return 2;
  }
  return Math.max(MAX_CONCURRENCY_MIN, Math.min(MAX_CONCURRENCY_MAX, parsed));
}

function normalizeSettingsRecord(settings: unknown): Record<string, unknown> | null {
  if (!isRecord(settings)) {
    return null;
  }
  const normalizedDefaultSubAgentsNum = clampMaxConcurrency(
    settings.default_sub_agents_num ?? settings.max_concurrency
  );
  return {
    ...settings,
    default_sub_agents_num: normalizedDefaultSubAgentsNum,
  };
}

function normalizeTargetColumnAnchors(
  value: unknown,
  allowedColumns: readonly string[]
): Array<{ column: string; converge_index: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowedColumnSet = new Set(allowedColumns);
  const allowAnyColumn = allowedColumnSet.size === 0;
  const normalized: Array<{ column: string; converge_index: number }> = [];
  const seenColumns = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const column = typeof item.column === 'string' ? item.column.trim() : '';
    const convergeIndex =
      typeof item.converge_index === 'number' && Number.isFinite(item.converge_index)
        ? Math.trunc(item.converge_index)
        : Number.parseInt(String(item.converge_index ?? ''), 10);
    if (
      !column
      || seenColumns.has(column)
      || (!allowAnyColumn && !allowedColumnSet.has(column))
      || !Number.isFinite(convergeIndex)
      || convergeIndex < 0
    ) {
      continue;
    }
    seenColumns.add(column);
    normalized.push({
      column,
      converge_index: convergeIndex,
    });
  }
  return normalized;
}

function normalizeSteeringTargetSnapshot(
  target: unknown
): Record<string, unknown> | null | undefined {
  if (target === null) {
    return null;
  }
  if (!isRecord(target)) {
    return undefined;
  }
  const kind = target.kind === 'atomic' || target.kind === 'column' ? target.kind : 'summary';
  const explicitColumns = normalizeTargetColumns(target.columns);
  const anchorColumns = normalizeTargetColumnAnchors(target.column_anchors, []).map((anchor) => anchor.column);
  const columns = explicitColumns.length > 0 ? explicitColumns : anchorColumns;
  const base: Record<string, unknown> = {
    kind,
    summary_id: typeof target.summary_id === 'string' ? target.summary_id : '',
    summary_short_label: typeof target.summary_short_label === 'string' ? target.summary_short_label : '',
    summary_text:
      typeof target.summary_text === 'string'
        ? normalizeCjkTerminalPunctuation(target.summary_text)
        : '',
    columns,
  };
  if (kind === 'column') {
    const legacyColumnName = typeof target.column_name === 'string' ? target.column_name.trim() : '';
    const normalizedColumns = columns.length > 0 ? columns : (legacyColumnName ? [legacyColumnName] : []);
    const columnAnchors = normalizeTargetColumnAnchors(target.column_anchors, normalizedColumns);
    return {
      ...base,
      columns: normalizedColumns,
      ...(columnAnchors.length > 0 ? { column_anchors: columnAnchors } : {}),
    };
  }
  if (kind === 'atomic') {
    return {
      ...base,
      atomic_id: typeof target.atomic_id === 'string' ? target.atomic_id : undefined,
      atomic_text:
        typeof target.atomic_text === 'string'
          ? normalizeCjkTerminalPunctuation(target.atomic_text)
          : undefined,
      insight_type: typeof target.insight_type === 'string' ? target.insight_type : undefined,
    };
  }
  return base;
}

function countAtomicInsights(summaryNodes: Record<string, unknown>[]): number {
  return summaryNodes.reduce((acc, summaryNode) => {
    const atomics = Array.isArray(summaryNode.atomic_insights) ? summaryNode.atomic_insights : [];
    return acc + atomics.length;
  }, 0);
}

function detectLegacyState(state: Record<string, unknown>): LegacyCheck {
  // We only "support" the current contract. Older runs are treated as legacy to
  // avoid subtle UI/data-shape breakages.
  const settings = isRecord(state.settings) ? state.settings : null;
  if (!settings) {
    return {
      is_legacy: true,
      contract_version: 'legacy',
      reason: 'missing settings',
    };
  }

  const defaultSubAgentsNum = settings.default_sub_agents_num ?? settings.max_concurrency;
  if (typeof defaultSubAgentsNum !== 'number') {
    return {
      is_legacy: true,
      contract_version: 'legacy',
      reason: 'missing settings.default_sub_agents_num',
    };
  }

  const plans = Array.isArray(state.plans)
    ? state.plans
    : (Array.isArray(state.frontier) ? state.frontier : null);
  if (!plans) {
    return {
      is_legacy: true,
      contract_version: 'legacy',
      reason: 'missing plans/frontier',
    };
  }

  for (const item of plans) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (typeof kind === 'string' && kind !== 'analysis') {
      return {
        is_legacy: true,
        contract_version: 'legacy',
        reason: `unsupported PlanItem.kind=${kind}`,
      };
    }
    if (!('filters' in item)) {
      return { is_legacy: true, contract_version: 'legacy', reason: 'missing PlanItem.filters' };
    }
    if (!('status' in item)) {
      return { is_legacy: true, contract_version: 'legacy', reason: 'missing PlanItem.status' };
    }
  }

  // Summary payload checks for v1.13: summary + optional keywords + typed atomic insights + evidence object.
  const insights = Array.isArray(state.insights) ? state.insights : null;
  if (!insights) {
    return {
      is_legacy: true,
      contract_version: 'legacy',
      reason: 'missing insights',
    };
  }

  for (const insight of insights) {
    if (!isRecord(insight)) {
      return {
        is_legacy: true,
        contract_version: 'legacy',
        reason: 'invalid summary object',
      };
    }
    if (typeof insight.summary !== 'string') {
      return {
        is_legacy: true,
        contract_version: 'legacy',
        reason: 'missing summary',
      };
    }
 
    const atomics = Array.isArray(insight.atomic_insights) ? insight.atomic_insights : null;
    if (!atomics) {
      return {
        is_legacy: true,
        contract_version: 'legacy',
        reason: 'missing summary atomic_insights',
      };
    }

    for (const atomic of atomics) {
      if (!isRecord(atomic)) {
        return {
          is_legacy: true,
          contract_version: 'legacy',
          reason: 'invalid AtomicInsight object',
        };
      }
      if (typeof atomic.insight_type !== 'string') {
        return {
          is_legacy: true,
          contract_version: 'legacy',
          reason: 'missing AtomicInsight.insight_type',
        };
      }
      if (!Array.isArray(atomic.columns)) {
        return {
          is_legacy: true,
          contract_version: 'legacy',
          reason: 'missing AtomicInsight.columns',
        };
      }
      const evidence = isRecord(atomic.evidence) ? atomic.evidence : null;
      if (!evidence || !('plot_path' in evidence)) {
        return {
          is_legacy: true,
          contract_version: 'legacy',
          reason: 'missing AtomicInsight.evidence.plot_path',
        };
      }
    }
  }

  return { is_legacy: false, contract_version: DATA_CONTRACT_VERSION };
}

async function getRunDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('run_'))
      .map(entry => entry.name)
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

function normalizeStateForClient(state: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...state };
  if (!Array.isArray(normalized.frontier) && Array.isArray(normalized.plans)) {
    normalized.frontier = normalized.plans;
  }
  if (typeof normalized.final_summary === 'string') {
    normalized.final_summary = normalizeCjkTerminalPunctuation(normalized.final_summary);
  }
  if (Array.isArray(normalized.frontier)) {
    normalized.frontier = normalized.frontier.map((item) => {
      if (!isRecord(item)) {
        return item;
      }
      return {
        ...item,
        final_summary:
          typeof item.final_summary === 'string'
            ? normalizeCjkTerminalPunctuation(item.final_summary)
            : item.final_summary,
      };
    });
  }
  if (Array.isArray(normalized.insights)) {
    normalized.insights = normalized.insights.map((insight) => {
      if (!isRecord(insight)) {
        return insight;
      }
      const atomicInsights = Array.isArray(insight.atomic_insights)
        ? insight.atomic_insights.map((atomic) => {
            if (!isRecord(atomic)) {
              return atomic;
            }
            return {
              ...atomic,
              text:
                typeof atomic.text === 'string'
                  ? normalizeCjkTerminalPunctuation(atomic.text)
                  : atomic.text,
            };
          })
        : insight.atomic_insights;
      return {
        ...insight,
        parent_insight_id:
          typeof insight.parent_insight_id === 'string'
            ? insight.parent_insight_id
            : Array.isArray(insight.parent_lineage_refs) && typeof insight.parent_lineage_refs[0] === 'string'
              ? insight.parent_lineage_refs[0]
              : insight.parent_insight_id,
        summary:
          typeof insight.summary === 'string'
            ? normalizeCjkTerminalPunctuation(insight.summary)
            : insight.summary,
        atomic_insights: atomicInsights,
      };
    });
  }
  if (Array.isArray(normalized.user_messages)) {
    normalized.user_messages = normalized.user_messages.map((message) => {
      if (!isRecord(message)) {
        return message;
      }
      return {
        ...message,
        target: normalizeSteeringTargetSnapshot(message.target),
      };
    });
  }
  const normalizedSettings = normalizeSettingsRecord(normalized.settings);
  if (normalizedSettings) {
    normalized.settings = normalizedSettings;
  }
  return normalized;
}

async function readRunState(runId: string): Promise<Record<string, unknown> | null> {
  const statePath = path.join(RUNS_DIR, runId, 'state.json');
  try {
    const state = await readJsonFile(statePath);
    if (!isRecord(state)) {
      return null;
    }
    const normalizedState = normalizeStateForClient(state);
    const planControlsPath = path.join(RUNS_DIR, runId, 'plan_controls.jsonl');
    let controlPayloads: unknown[] = [];
    try {
      controlPayloads = await readJsonlFile(planControlsPath);
    } catch {
      controlPayloads = [];
    }
    return applyPendingPlanControlPreviews({
      state: normalizedState,
      controlPayloads,
    });
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const events: unknown[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial/corrupt lines (common when reading while the file is being appended).
      continue;
    }
  }
  return events;
}

async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

function createUserSteerMessage(
  content: string,
  options?: {
    kind?: UserSteerMessage['kind'];
    display_text?: string;
    generated_prompt?: string;
    user_prompt?: string;
    system_prompt?: string;
    selected_keywords?: string[];
    target?: Record<string, unknown> | null;
  }
): UserSteerMessage {
  const message: UserSteerMessage = {
    message_id: `msg_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    content,
  };
  if (options?.kind) {
    message.kind = options.kind;
  }
  if (options?.display_text !== undefined) {
    message.display_text = options.display_text;
  }
  if (options?.generated_prompt !== undefined) {
    message.generated_prompt = options.generated_prompt;
  }
  if (options?.user_prompt !== undefined) {
    message.user_prompt = options.user_prompt;
  }
  if (options?.system_prompt !== undefined) {
    message.system_prompt = options.system_prompt;
  }
  if (options?.selected_keywords && options.selected_keywords.length > 0) {
    message.selected_keywords = options.selected_keywords;
  }
  if (options && 'target' in options) {
    message.target = options.target;
  }
  return message;
}

function normalizeSteeringKind(kind: unknown): UserSteerMessage['kind'] {
  if (kind === 'dive_into') return 'focus';
  if (kind === 'cut_off' || kind === 'suppress') return 'ignore';
  if (
    kind === 'chat'
    || kind === 'focus'
    || kind === 'ignore'
    || kind === 'elaborate'
    || kind === 'create'
  ) {
    return kind;
  }
  return 'chat';
}

async function appendJsonlLine(filePath: string, payload: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

async function writeRunState(runId: string, state: Record<string, unknown>): Promise<void> {
  const statePath = path.join(RUNS_DIR, runId, 'state.json');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function normalizePlanRecord(plan: PlanRecord): PlanRecord {
  const normalizedControlState =
    plan.control_state === 'yield_requested'
      ? 'pause_requested'
      : typeof plan.control_state === 'string'
        ? plan.control_state
        : 'none';
  return {
    ...plan,
    control_state: normalizedControlState,
    launch_requested: Boolean(plan.launch_requested),
    resume_phase:
      plan.resume_phase === 'analyzing' || plan.resume_phase === 'summarizing'
        ? plan.resume_phase
        : null,
    checkpoint_path:
      typeof plan.checkpoint_path === 'string' ? plan.checkpoint_path : null,
    pending_modified_text:
      typeof plan.pending_modified_text === 'string' ? plan.pending_modified_text : null,
  };
}

function getStatePlans(state: Record<string, unknown>): PlanRecord[] {
  const frontier = Array.isArray(state.frontier) ? state.frontier : null;
  if (frontier) {
    return frontier.filter(isRecord).map((item) => normalizePlanRecord(item as PlanRecord));
  }
  const plans = Array.isArray(state.plans) ? state.plans : [];
  return plans.filter(isRecord).map((item) => normalizePlanRecord(item as PlanRecord));
}

function isPlanControlAction(value: unknown): value is PlanControlAction {
  return (
    value === 'launch'
    || value === 'pause'
    || value === 'modify'
    || value === 'terminate'
  );
}

const datasetUploadStorage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    try {
      mkdirSync(DATASET_UPLOADS_DIR, { recursive: true });
      callback(null, DATASET_UPLOADS_DIR);
    } catch (error) {
      callback(error as Error, DATASET_UPLOADS_DIR);
    }
  },
  filename: (_req, file, callback) => {
    try {
      callback(null, buildUploadedDatasetFilename(file.originalname, randomUUID()));
    } catch (error) {
      callback(error as Error, '');
    }
  },
});

const datasetUploadMiddleware = multer({
  storage: datasetUploadStorage,
  limits: {
    fileSize: DATASET_UPLOAD_MAX_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    if (!isCsvUploadFilename(file.originalname)) {
      callback(new Error('Only .csv files are supported'));
      return;
    }
    if (!isAllowedCsvMimeType(file.mimetype)) {
      callback(new Error(`Unsupported CSV MIME type: ${file.mimetype || 'unknown'}`));
      return;
    }
    callback(null, true);
  },
});

function getDatasetUploadError(error: unknown): { status: number; message: string } {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return {
        status: 413,
        message: `Dataset upload exceeds the ${DATASET_UPLOAD_MAX_BYTES} byte limit`,
      };
    }
    return {
      status: 400,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      status: 400,
      message: error.message,
    };
  }
  return {
    status: 500,
    message: 'Failed to upload dataset',
  };
}

// ============================================================================
// API Endpoints
// ============================================================================

app.post('/api/datasets/upload', (req, res) => {
  datasetUploadMiddleware.single(DATASET_UPLOAD_FIELD_NAME)(req, res, (error: unknown) => {
    if (error) {
      const { status, message } = getDatasetUploadError(error);
      res.status(status).json({ error: message });
      return;
    }

    const uploadedFile = req.file;
    if (!uploadedFile) {
      res.status(400).json({ error: 'file is required' });
      return;
    }

    res.json({
      dataset_path: path.resolve(uploadedFile.path),
      original_filename: uploadedFile.originalname,
      size_bytes: uploadedFile.size,
      temporary: true,
    });
  });
});

app.post('/api/runs/start', async (req, res) => {
  try {
    const body = req.body as StartRunRequest;
    
    if (!body.dataset_path) {
      res.status(400).json({ error: 'dataset_path is required' });
      return;
    }
    if (!body.user_goal || !body.user_goal.trim()) {
      res.status(400).json({ error: 'user_goal is required' });
      return;
    }

    const datasetPath = path.isAbsolute(body.dataset_path)
      ? body.dataset_path
      : path.resolve(REPO_ROOT, body.dataset_path);

    try {
      const stats = await fs.stat(datasetPath);
      if (!stats.isFile()) {
        res.status(400).json({ error: `Dataset path is not a file: ${datasetPath}` });
        return;
      }
    } catch {
      res.status(400).json({ error: `Dataset file not found: ${datasetPath}` });
      return;
    }

    const checkIntParam = (
      name: keyof StartRunRequest,
      value: unknown,
      min: number,
      max?: number
    ): string | null => {
      if (value === undefined) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return `${String(name)} must be an integer`;
      }
      if (value < min) {
        return `${String(name)} must be >= ${min}`;
      }
      if (typeof max === 'number' && value > max) {
        return `${String(name)} must be <= ${max}`;
      }
      return null;
    };

    const requestedDefaultSubAgentsNum =
      body.default_sub_agents_num ?? body.max_concurrency;
    const validationError =
      checkIntParam('default_sub_agents_num', requestedDefaultSubAgentsNum, 1, 6) ||
      checkIntParam('max_initial_plans', body.max_initial_plans, 1);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    // Capture existing runs so we can reliably detect the new one (even if another run is active).
    const existingRunIds = new Set(await getRunDirs());

    // Build CLI arguments
    const args = [
      '-u',
      'cli.py',
      '--dataset', datasetPath,
      '--user-goal', body.user_goal.trim(),
    ];

    if (typeof requestedDefaultSubAgentsNum === 'number') {
      args.push('--max-concurrency', requestedDefaultSubAgentsNum.toString());
    }
    if (typeof body.max_initial_plans === 'number') {
      args.push('--max-initial-plans', body.max_initial_plans.toString());
    }
    if (body.stable_output === true || DEV_STABLE_LLM_OUTPUT) {
      args.push('--stable');
    }
    console.log('\n[RunGateway] Starting new run:', args);

    // Spawn Python CLI
    const pythonProcess = spawn('python', args, {
      cwd: BACKEND_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildBackendProcessEnv(),
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let spawnErrorMessage: string | null = null;
    let observedExitCode: number | null = null;
    let runId: string | null = null;
    let hintedRunId: string | null = null;
    const RUN_ID_PATTERN = /run_\d{8}_\d{6}_[0-9a-f]{6}/i;

    const extractTail = (value: string, maxLines = 6): string => {
      return value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-maxLines)
        .join(' | ');
    };

    const ingestRunIdHint = (text: string) => {
      if (runId || hintedRunId) return;
      const match = text.match(RUN_ID_PATTERN);
      if (!match) return;
      const candidate = match[0];
      if (existingRunIds.has(candidate)) return;
      hintedRunId = candidate;
    };

    pythonProcess.stdout?.on('data', (data) => {
      const text = data.toString();
      stdoutChunks.push(text);
      ingestRunIdHint(text);
      const tag = runId || hintedRunId || 'pending-run';
      console.log(`[${tag}] stdout:`, text.trim());
    });

    pythonProcess.stderr?.on('data', (data) => {
      const text = data.toString();
      stderrChunks.push(text);
      ingestRunIdHint(text);
      const tag = runId || hintedRunId || 'pending-run';
      console.error(`[${tag}] stderr:`, text.trim());
    });

    pythonProcess.on('error', (error) => {
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
    });

    pythonProcess.on('exit', (code) => {
      observedExitCode = typeof code === 'number' ? code : 1;
      if (runId) {
        console.log(`[RunGateway] Run ${runId} process exited with code ${observedExitCode}`);
        runningProcesses.delete(runId);
        void clearRunProcessState(RUNS_DIR, runId, pythonProcess.pid);
      } else {
        console.log(`[RunGateway] Pre-run process exited with code ${observedExitCode}`);
      }
    });

    // Wait for the run_id to appear (by watching runs directory)
    const startTime = Date.now();
    const timeout = 30000; // 30 seconds timeout
    
    // Poll for new run directory
    const isRunReady = async (candidate: string): Promise<boolean> => {
      const statePath = path.join(RUNS_DIR, candidate, 'state.json');
      try {
        const stats = await fs.stat(statePath);
        return stats.size > 0;
      } catch {
        return false;
      }
    };

    const checkForNewRun = async (): Promise<string | null> => {
      const runDirs = await getRunDirs();
      for (const candidate of runDirs) {
        if (existingRunIds.has(candidate)) continue;
        if (await isRunReady(candidate)) return candidate;
      }
      return null;
    };

    // Poll until we find the new run
    while (Date.now() - startTime < timeout) {
      if (spawnErrorMessage) break;

      if (hintedRunId) {
        if (await isRunReady(hintedRunId)) {
          runId = hintedRunId;
          break;
        }
      } else {
        runId = await checkForNewRun();
        if (runId) break;
      }

      if (pythonProcess.exitCode !== null || observedExitCode !== null) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
    }

    if (!runId) {
      if (pythonProcess.exitCode === null && observedExitCode === null && !pythonProcess.killed) {
        pythonProcess.kill();
      }

      const stderrTail = extractTail(stderrChunks.join(''));
      const stdoutTail = extractTail(stdoutChunks.join(''));
      const effectiveExitCode =
        typeof pythonProcess.exitCode === 'number' ? pythonProcess.exitCode : observedExitCode;

      let error = 'Timeout waiting for run to start';
      let statusCode = 504;

      if (spawnErrorMessage) {
        error = `Failed to start Python process: ${spawnErrorMessage}`;
        statusCode = 500;
      } else if (effectiveExitCode !== null) {
        error = `Run process exited before state initialization (exit code ${effectiveExitCode})`;
        statusCode = 500;
      }

      if (stderrTail) {
        error = `${error}: ${stderrTail}`;
      } else if (stdoutTail && statusCode === 500) {
        error = `${error}: ${stdoutTail}`;
      }

      res.status(statusCode).json({ error });
      return;
    }

    // Track the process
    runningProcesses.set(runId, pythonProcess);
    await persistRunProcessState(RUNS_DIR, runId, pythonProcess);

    console.log(`[RunGateway] Run started: ${runId}`);
    res.json({ run_id: runId, status: 'started' });

  } catch (error) {
    console.error('Error starting run:', error);
    res.status(500).json({ error: 'Failed to start run' });
  }
});

// Stop a running exploration
app.post('/api/runs/:runId/stop', async (req, res) => {
  try {
    const { runId } = req.params;
    const child = runningProcesses.get(runId);
    const force = req.query.force === '1' || req.query.force === 'true';
    
    if (child) {
      // Best-effort graceful stop:
      // 1) Create a STOP file that the backend orchestrator polls for.
      // 2) Send SIGTERM as a fallback (on Windows this is mapped to TerminateProcess).
      try {
        const stopPath = path.join(RUNS_DIR, runId, 'STOP');
        await fs.writeFile(stopPath, `stop requested: ${new Date().toISOString()}\n`, 'utf-8');
      } catch {
        // Ignore: the process might have exited before the run dir exists.
      }

      try {
        // On Windows, child_process.kill('SIGTERM') does not deliver a POSIX signal to Python
        // (it typically terminates the process immediately). Prefer STOP-file-only there.
        if (force || process.platform !== 'win32') {
          child.kill('SIGTERM');
        }
      } catch {
        // Ignore: already exited.
      }

      // Do not delete from runningProcesses here; the exit handler will clean it up.
      res.json({ run_id: runId, status: force ? 'stopped' : 'stopping' });
    } else {
      res.status(404).json({ error: 'Run not found or not running' });
    }
  } catch (error) {
    console.error('Error stopping run:', error);
    res.status(500).json({ error: 'Failed to stop run' });
  }
});

app.post('/api/runs/:runId/steer', async (req, res) => {
  try {
    const { runId } = req.params;
    const body = req.body as SteerRunRequest;
    const rawContent = typeof body?.content === 'string' ? body.content.trim() : '';
    const kind = normalizeSteeringKind(body?.kind);
    const displayText = typeof body?.display_text === 'string' ? body.display_text.trim() : '';
    const userPrompt = typeof body?.user_prompt === 'string' ? body.user_prompt.trim() : rawContent;
    const systemPrompt = typeof body?.system_prompt === 'string' ? body.system_prompt.trim() : '';
    const content = userPrompt || rawContent;
    const selectedKeywords =
      kind === 'focus' || kind === 'ignore'
        ? normalizeKeywords(body?.selected_keywords)
        : [];
    const target = kind === 'create'
      ? null
      : normalizeSteeringTargetSnapshot(body?.target);

    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const state = await readRunState(runId);
    if (!state) {
      res.status(404).json({ error: 'Run not found or state unavailable' });
      return;
    }

    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }

    const status = typeof state.status === 'string' ? state.status : 'unknown';
    if (!['running', 'paused', 'idle', 'completed'].includes(status)) {
      res.status(409).json({ error: `Run is not accepting messages (status=${status})` });
      return;
    }

    const message = createUserSteerMessage(content, {
      kind,
      display_text: displayText || (kind === 'create' ? content : undefined),
      generated_prompt:
        kind === 'focus' || kind === 'ignore' || kind === 'elaborate'
          ? (typeof body?.user_prompt === 'string' ? undefined : content)
          : kind === 'create'
            ? ''
            : undefined,
      user_prompt:
        kind === 'focus' || kind === 'ignore' || kind === 'elaborate'
          ? content
          : undefined,
      system_prompt:
        kind === 'focus' || kind === 'ignore' || kind === 'elaborate'
          ? (systemPrompt || undefined)
          : undefined,
      selected_keywords: selectedKeywords,
      target,
    });

    const existingProcess = runningProcesses.get(runId);
    const endedSessionError = getEndedSessionError(existingProcess, status);
    if (endedSessionError) {
      res.status(410).json({ error: endedSessionError });
      return;
    }

    const persistedProcessStatus = await getPersistedRunProcessStatus(RUNS_DIR, runId);
    if (
      status === 'running' &&
      (!existingProcess || existingProcess.exitCode !== null) &&
      persistedProcessStatus === 'missing'
    ) {
      res.status(409).json({
        error: 'Run ownership is unknown after gateway restart; cannot safely resume this active run.',
      });
      return;
    }

    let resumedForThisSteer = false;
    if (
      (!existingProcess || existingProcess.exitCode !== null) &&
      persistedProcessStatus !== 'alive'
    ) {
      await ensureRunProcessForSteer({
        backendDir: BACKEND_DIR,
        runId,
        runsDir: RUNS_DIR,
        runningProcesses,
        state,
        userGoal: content,
        resumeMessageJson: JSON.stringify(message),
        userMessageId: message.message_id,
        userMessageTimestamp: message.timestamp,
      });
      resumedForThisSteer = true;
    }

    if (!resumedForThisSteer) {
      const steerPath = path.join(RUNS_DIR, runId, 'steer.jsonl');
      await appendJsonlLine(steerPath, message);
    }

    res.json({
      run_id: runId,
      status: 'accepted',
      message,
    });
  } catch (error) {
    console.error('Error steering run:', error);
    res.status(500).json({ error: 'Failed to steer run' });
  }
});

app.patch('/api/runs/:runId/settings', async (req, res) => {
  try {
    const { runId } = req.params;
    const body = (isRecord(req.body) ? req.body : {}) as unknown as UpdateRunSettingsRequest;
    const requestedDefaultSubAgentsNum =
      body.default_sub_agents_num ?? (body as { max_concurrency?: unknown }).max_concurrency;
    if (
      typeof requestedDefaultSubAgentsNum !== 'number'
      || !Number.isFinite(requestedDefaultSubAgentsNum)
      || !Number.isInteger(requestedDefaultSubAgentsNum)
    ) {
      res.status(400).json({ error: 'default_sub_agents_num must be an integer' });
      return;
    }
    if (
      requestedDefaultSubAgentsNum < MAX_CONCURRENCY_MIN
      || requestedDefaultSubAgentsNum > MAX_CONCURRENCY_MAX
    ) {
      res.status(400).json({ error: 'default_sub_agents_num must be between 1 and 6' });
      return;
    }

    const state = await readRunState(runId);
    if (!state) {
      res.status(404).json({ error: 'Run not found or state unavailable' });
      return;
    }

    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }

    const timestamp = new Date().toISOString();
    const nextSettings = {
      ...(normalizeSettingsRecord(state.settings) ?? {}),
      default_sub_agents_num: clampMaxConcurrency(requestedDefaultSubAgentsNum),
    };
    state.settings = nextSettings;
    state.updated_at = timestamp;

    await writeRunState(runId, state);

    res.json({
      run_id: runId,
      settings: nextSettings,
    });
  } catch (error) {
    console.error('Error updating run settings:', error);
    res.status(500).json({ error: 'Failed to update run settings' });
  }
});

app.post('/api/runs/:runId/plans/:planId/control', async (req, res) => {
  try {
    const { runId, planId } = req.params;
    const action = isRecord(req.body) ? req.body.action : undefined;
    if (!isPlanControlAction(action)) {
      res.status(400).json({ error: 'action must be one of launch, pause, modify, terminate' });
      return;
    }
    const userAuthoredText = isRecord(req.body) && typeof req.body.user_authored_text === 'string'
      ? req.body.user_authored_text
      : undefined;

    const state = await readRunState(runId);
    if (!state) {
      res.status(404).json({ error: 'Run not found or state unavailable' });
      return;
    }

    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }

    const plans = getStatePlans(state);
    const plan = plans.find((item) => String(item.plan_id ?? '') === planId);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }

    if (!applyPlanControlToPlanRecord(plan, action).allowed) {
      res.status(409).json({
        error: `Plan control action ${action} is not allowed for status=${String(plan.status ?? 'unknown')}`,
      });
      return;
    }

    if (shouldEnsureRunProcessForPlanControl(plan, action)) {
      const existingProcess = runningProcesses.get(runId);
      const persistedProcessStatus = await getPersistedRunProcessStatus(RUNS_DIR, runId);
      if (
        (!existingProcess || existingProcess.exitCode !== null)
        && persistedProcessStatus !== 'alive'
      ) {
        await ensureRunProcessForSteer({
          backendDir: BACKEND_DIR,
          runId,
          runsDir: RUNS_DIR,
          runningProcesses,
          state,
        });
      }
    }

    const timestamp = new Date().toISOString();
    const planControlsPath = path.join(RUNS_DIR, runId, 'plan_controls.jsonl');
    await appendJsonlLine(planControlsPath, {
      plan_id: planId,
      action,
      ...(userAuthoredText ? { user_authored_text: userAuthoredText } : {}),
      timestamp,
    });

    const refreshedState = (await readRunState(runId)) ?? state;
    const optimisticState = structuredClone(refreshedState);
    const optimisticPlans =
      (Array.isArray(optimisticState.frontier) ? optimisticState.frontier : null)
      ?? (Array.isArray(optimisticState.plans) ? optimisticState.plans : null)
      ?? [];
    const optimisticPlanIndex = optimisticPlans.findIndex(
      (item) => isRecord(item) && String(item.plan_id ?? '') === planId
    );
    if (optimisticPlanIndex >= 0) {
      optimisticPlans[optimisticPlanIndex] = applyPlanControlPreviewToPlanRecord({
        plan: normalizePlanRecord(optimisticPlans[optimisticPlanIndex] as PlanRecord),
        action,
        userAuthoredText,
      });
    }
    const refreshedPlan = getStatePlans(refreshedState)
      .find((item) => String(item.plan_id ?? '') === planId)
      ?? normalizePlanRecord({ ...plan });
    const responsePayload = buildPlanControlResponse({
      plan: refreshedPlan,
      action,
      persistedRunStatus:
        typeof optimisticState.status === 'string' ? optimisticState.status : 'pending',
      userAuthoredText,
    });

    res.json({
      plan: responsePayload.plan,
      run_status: responsePayload.runStatus,
      run_state: normalizeStateForClient(optimisticState),
    });
  } catch (error) {
    console.error('Error controlling plan:', error);
    res.status(500).json({ error: 'Failed to control plan' });
  }
});

app.post('/api/runs/:runId/report', async (req, res) => {
  try {
    const body = req.body as GenerateReportRequest;

    if (!body.insight_id) {
      res.status(400).json({ error: 'insight_id is required' });
      return;
    }

    res.json({
      ok: true,
      insight_id: body.insight_id,
      report_path: '',
      report_pack_path: '',
      chain_insight_ids: [],
      created_at: new Date().toISOString(),
      language: body.language || 'en',
      mode: 'unavailable',
      segment_count: 0,
      errors: [],
      preview: '',
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// List all runs with summary info
app.get('/api/runs', async (req, res) => {
  try {
    const includeLegacy = req.query.includeLegacy === '1' || req.query.includeLegacy === 'true';
    const runDirs = await getRunDirs();
    let runs = await Promise.all(
      runDirs.map(async (runId) => {
        try {
          const state = await readRunState(runId);
          if (!state) {
            throw new Error('state.json missing or invalid');
          }
          const legacy = detectLegacyState(state);
          const dataset_path = typeof state.dataset_path === 'string' ? state.dataset_path : '';
          const status = typeof state.status === 'string' ? state.status : 'unknown';
          const step = typeof state.step === 'number' ? state.step : 0;
          const failure_count = typeof state.failure_count === 'number' ? state.failure_count : 0;
          const summaryNodes = Array.isArray(state.insights)
            ? state.insights.filter(isRecord)
            : [];
          const summaryCount = summaryNodes.length;
          const atomicInsightCount = countAtomicInsights(summaryNodes);
          const created_at = typeof state.created_at === 'string' ? state.created_at : '';
          const updated_at = typeof state.updated_at === 'string' ? state.updated_at : '';
          const userMessages = Array.isArray(state.user_messages) ? state.user_messages : [];
          const firstUserMessageRecord = userMessages.find((item) => isRecord(item) && typeof item.content === 'string');
          const first_user_message =
            firstUserMessageRecord && typeof firstUserMessageRecord.content === 'string'
              ? firstUserMessageRecord.content
              : '';
          const last_activity_at = updated_at || created_at;
          return {
            run_id: runId,
            dataset_path,
            status,
            step,
            failure_count,
            insight_count: atomicInsightCount,
            summary_count: summaryCount,
            created_at,
            updated_at,
            first_user_message,
            last_activity_at,
            is_legacy: legacy.is_legacy,
            contract_version: legacy.contract_version,
            legacy_reason: legacy.reason,
          };
        } catch {
          return {
            run_id: runId,
            dataset_path: '',
            status: 'unknown',
            step: 0,
            failure_count: 0,
            insight_count: 0,
            summary_count: 0,
            created_at: '',
            updated_at: '',
            is_legacy: false,
            contract_version: 'unknown',
          };
        }
      })
    );

    if (!includeLegacy) {
      runs = runs.filter((r) => !(r as { is_legacy?: boolean }).is_legacy);
    }
    res.json(runs);
  } catch (error) {
    console.error('Error listing runs:', error);
    res.status(500).json({ error: 'Failed to list runs' });
  }
});

// Get run state snapshot
app.get('/api/runs/:runId/state', async (req, res) => {
  try {
    const { runId } = req.params;
    const state = await readRunState(runId);
    if (!state) {
      res.status(404).json({ error: 'Run not found or state unavailable' });
      return;
    }
    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }
    res.json(state);
  } catch (error) {
    console.error('Error reading state:', error);
    res.status(404).json({ error: 'Run not found or state unavailable' });
  }
});

// Get CSV dataset preview
app.get('/api/runs/:runId/dataset/preview', async (req, res) => {
  try {
    const { runId } = req.params;
    const state = await readRunState(runId);
    if (!state) {
      res.status(404).json({ error: 'Run not found or state unavailable' });
      return;
    }

    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }

    const rawPath = state.dataset_path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      res.status(400).json({ error: 'dataset_path is missing in run state' });
      return;
    }

    const datasetPath = resolveDatasetPathFromState(rawPath, REPO_ROOT);
    if (path.extname(datasetPath).toLowerCase() !== '.csv') {
      res.status(400).json({ error: 'Only CSV datasets are supported in Data View' });
      return;
    }

    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const rawOffset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : NaN;
    const safeLimit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), DATA_VIEW_MAX_ROWS)
      : DATA_VIEW_PREVIEW_ROWS;
    const safeOffset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

    const stats = await fs.stat(datasetPath);
    if (!stats.isFile()) {
      res.status(404).json({ error: 'Dataset file not found' });
      return;
    }
    if (stats.size > DATA_VIEW_MAX_FILE_BYTES) {
      res.status(413).json({
        error: `Dataset is too large for preview (> ${DATA_VIEW_MAX_FILE_BYTES} bytes)`,
      });
      return;
    }

    const content = await fs.readFile(datasetPath, 'utf-8');
    const datasetInfo = isRecord(state.dataset_info) ? state.dataset_info : null;
    const delimiter =
      normalizeCsvDelimiter(datasetInfo?.delimiter)
      ?? sniffCsvDelimiter(content);
    const preview = buildCsvPreview(content, safeLimit, safeOffset, delimiter);
    res.json({
      dataset_path: datasetPath,
      ...preview,
    });
  } catch (error) {
    console.error('Error reading dataset preview:', error);
    res.status(500).json({ error: 'Failed to read dataset preview' });
  }
});

// Get all events (full history)
app.get('/api/runs/:runId/events', async (req, res) => {
  try {
    const { runId } = req.params;
    const state = await readRunState(runId);
    if (state) {
      const legacy = detectLegacyState(state);
      if (legacy.is_legacy) {
        res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
        return;
      }
    }
    const eventsPath = path.join(RUNS_DIR, runId, 'events.jsonl');
    const events = await readJsonlFile(eventsPath);
    res.json(events);
  } catch (error) {
    console.error('Error reading events:', error);
    res.status(404).json({ error: 'Events not found' });
  }
});

// Stream events via SSE (Server-Sent Events)
app.get('/api/runs/:runId/events/stream', async (req, res) => {
  const { runId } = req.params;
  const state = await readRunState(runId);
  if (state) {
    const legacy = detectLegacyState(state);
    if (legacy.is_legacy) {
      res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
      return;
    }
  }
  const eventsPath = path.join(RUNS_DIR, runId, 'events.jsonl');
  const replayFromStart = req.query.replay === '1' || req.query.fromStart === '1';
  const fromParam = typeof req.query.from === 'string' ? Number.parseInt(req.query.from, 10) : null;
  const hasFrom = Number.isFinite(fromParam) && (fromParam as number) >= 0;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Track file position
  let lastSize = 0;
  let leftover = '';

  const sendLines = (text: string) => {
    const combined = leftover + text;
    const lines = combined.split('\n');
    leftover = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      res.write(`data: ${line}\n\n`);
    }
  };

  const readIncremental = async (startPos: number, endPos: number) => {
    if (endPos <= startPos) return;
    const handle = await fs.open(eventsPath, 'r');
    try {
      const length = endPos - startPos;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, startPos);
      if (bytesRead > 0) {
        sendLines(buffer.subarray(0, bytesRead).toString('utf-8'));
      }
    } finally {
      await handle.close();
    }
  };

  if (replayFromStart) {
    // Send initial events (full replay)
    try {
      const content = await fs.readFile(eventsPath);
      lastSize = content.length;
      sendLines(content.toString('utf-8'));
    } catch {
      // File might not exist yet, that's ok
    }
  } else if (hasFrom) {
    // Send events from a specific cursor (skip first N)
    try {
      const content = await fs.readFile(eventsPath);
      lastSize = content.length;

      const allLines = content.toString('utf-8').split('\n').filter(line => line.trim());
      const startIndex = Math.min(fromParam as number, allLines.length);
      const remaining = allLines.slice(startIndex).join('\n') + '\n';
      sendLines(remaining);
    } catch {
      // File might not exist yet, that's ok
    }
  } else {
    // Default: start from end of file (incremental only)
    try {
      const stats = await fs.stat(eventsPath);
      lastSize = stats.size;
    } catch {
      // File might not exist yet, start from 0
      lastSize = 0;
    }
  }

  // Keep-alive ping to prevent proxies from closing the connection
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  // Watch for file changes
  const watcher = chokidar.watch(eventsPath, {
    persistent: true,
    ignoreInitial: true,
  });
  let syncing = false;

  const handleFileChange = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const stats = await fs.stat(eventsPath);
      const currentSize = stats.size;

      if (currentSize > lastSize) {
        await readIncremental(lastSize, currentSize);
        lastSize = currentSize;
      } else if (currentSize < lastSize) {
        // File was truncated or rotated; reset position
        lastSize = 0;
        leftover = '';
      }
    } catch (error) {
      console.error('Error reading new events:', error);
    } finally {
      syncing = false;
    }
  };

  watcher.on('add', handleFileChange);
  watcher.on('change', handleFileChange);
  // Close the race window between initial snapshot replay and watcher wiring.
  // If events were appended in that gap, this immediate sync sends the missed tail.
  void handleFileChange();

  // Fallback poll to prevent stale streams if OS file-watch events are missed.
  const pollTimer = setInterval(() => {
    void handleFileChange();
  }, 1000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    clearInterval(pollTimer);
    watcher.close();
  });
});

// Get artifact file content
app.get('/api/runs/:runId/artifact/*', async (req, res) => {
  try {
    const { runId } = req.params;
    const state = await readRunState(runId);
    if (state) {
      const legacy = detectLegacyState(state);
      if (legacy.is_legacy) {
        res.status(409).json({ error: 'Legacy run is not supported', reason: legacy.reason });
        return;
      }
    }
    const artifactPath = (req.params as Record<string, string | undefined>)['0'] || '';
    if (!artifactPath) {
      res.status(400).json({ error: 'Artifact path is required' });
      return;
    }

    const runDir = path.resolve(RUNS_DIR, runId);
    const fullPath = path.resolve(runDir, artifactPath);

    // Security check: ensure path is within run directory
    if (fullPath !== runDir && !fullPath.startsWith(runDir + path.sep)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Determine content type based on extension
    const ext = path.extname(fullPath).toLowerCase();
    
    // Handle binary files (images)
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (imageExtensions.includes(ext)) {
      // For images, use sendFile to send binary data
      const contentTypeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      };
      res.setHeader('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
      res.sendFile(fullPath);
      return;
    }
    
    // Handle text files
    const content = await readTextFile(fullPath);
    
    if (ext === '.py') {
      res.setHeader('Content-Type', 'text/x-python');
    } else if (ext === '.json') {
      res.setHeader('Content-Type', 'application/json');
    } else {
      res.setHeader('Content-Type', 'text/plain');
    }
    
    res.send(content);
  } catch (error) {
    console.error('Error reading artifact:', error);
    res.status(404).json({ error: 'Artifact not found' });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', runsDir: RUNS_DIR });
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n[RunGateway] Server running at http://localhost:${PORT}`);
  console.log(`[RunGateway] Serving runs from: ${RUNS_DIR}`);
  console.log(`\n[RunGateway] Endpoints:`);
  console.log(`  POST /api/datasets/upload          - Upload a CSV dataset`);
  console.log(`  POST /api/runs/start                - Start a new run`);
  console.log(`  POST /api/runs/:runId/stop          - Stop a running run`);
  console.log(`  POST /api/runs/:runId/steer         - Send a steer message`);
  console.log(`  POST /api/runs/:runId/plans/:planId/control - Control a plan`);
  console.log(`  POST /api/runs/:runId/report        - Generate a Summary Report`);
  console.log(`  GET  /api/runs                      - List all runs`);
  console.log(`  GET  /api/runs/:runId/state         - Get run state`);
  console.log(`  GET  /api/runs/:runId/dataset/preview - Get dataset preview`);
  console.log(`  GET  /api/runs/:runId/events        - Get all events`);
  console.log(`  GET  /api/runs/:runId/events/stream - Stream events (SSE)`);
  console.log(`  GET  /api/runs/:runId/artifact/*    - Get artifact content`);
});

