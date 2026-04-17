/**
 * Agentic EDA Frontend Type Definitions
 * Based on DATA_CONTRACT.md v1.14
 */

// ============================================================================
// Core Models
// ============================================================================

export interface LegacyBudgets {
  max_steps: number;
  max_depth: number;
  max_children_per_insight: number;
  max_failures: number;
}

export interface RunSettings {
  default_sub_agents_num: number;
  max_concurrency?: number; // Legacy field tolerated for older saved runs.
  poll_interval_seconds?: number;
  max_attempts_per_plan?: number; // Legacy field tolerated for older saved runs.
}

export type FilterOp =
  | 'eq'
  | 'in'
  | 'between'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isnull'
  | 'notnull';

export interface Filter {
  col: string;
  op: FilterOp;
  value?: unknown;
  values?: unknown[];
  low?: unknown;
  high?: unknown;
}

export interface PlanItem {
  plan_id: string;
  kind: 'analysis';
  text: string;
  filters: Filter[];
  embedding?: number[] | null;
  status:
    | 'pending'
    | 'analyzing'
    | 'summarizing'
    | 'paused'
    | 'terminated'
    | 'completed'
    | 'failed'
    | 'skipped';
  parent_insight_id: string | null;
  short_label?: string;
  assigned_sub_agent_id?: string | null;
  control_state?: 'none' | 'pause_requested' | 'terminate_requested';
  resume_phase?: 'analyzing' | 'summarizing' | null;
  checkpoint_path?: string | null;
  pending_modified_text?: string | null;
  launch_requested?: boolean;
  final_summary?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface DatasetColumnInfo {
  name: string;
  dtype: string;
}

export interface DatasetInfo {
  rows?: number;
  columns?: DatasetColumnInfo[];
  sample_rows?: Array<Record<string, string>>;
  dataset_schema?: string;
  dataset_path?: string;
  delimiter?: ',' | ';' | '\t' | '|';
  [key: string]: unknown;
}

export interface ExecutionRecord {
  plan_id: string;
  success: boolean;
  code_path: string | null;
  stdout_path: string | null;
  stderr_path: string | null;
  plot_paths: string[];
  analysis_path?: string | null;
  stdout_content: string;
  stderr_content: string;
  error_message: string | null;
  execution_time_ms: number;
  created_at: string;
}

// Insight Taxonomy Types (v3)
export type InsightType =
  | 'value'
  | 'proportion'
  | 'rank'
  | 'difference'
  | 'trend'
  | 'distribution'
  | 'association'
  | 'outlier'
  | 'extreme'
  | 'cluster'
  | 'data_quality';

export const INSIGHT_TAXONOMY_TYPES: InsightType[] = [
  'value',
  'proportion',
  'rank',
  'difference',
  'trend',
  'distribution',
  'association',
  'outlier',
  'extreme',
  'cluster',
  'data_quality',
];

export interface InsightEvidence {
  code_path: string | null;
  output_path: string | null;
  plot_path: string | null;
}

export interface AtomicInsight {
  atomic_id: string;
  text: string;
  insight_type: InsightType;
  columns: string[];
  keywords?: string[];
  evidence: InsightEvidence;
  embedding?: number[] | null;
  interest: number;
  significance: number;
  impact: number;
  importance: number;
}

/**
 * Summary node payload emitted by backend (legacy wire naming keeps `insights`).
 *
 * Product terminology:
 * - "insight" => atomic insight
 * - "summary" => graph node that groups multiple atomic insights
 */
export interface Summary {
  insight_id: string;
  plan_id: string;
  summary: string;
  atomic_insights: AtomicInsight[];
  keywords?: string[];
  embedding?: number[] | null;
  parent_lineage_refs?: string[];
  parent_insight_id: string | null;
  children_insight_ids?: string[]; // Legacy/client-synthesized lineage only.
  short_label?: string;
  created_at: string;
}

export type SoftSteeringKind = 'focus' | 'ignore' | 'elaborate';
export type LegacySoftSteeringKind = 'dive_into' | 'cut_off' | 'suppress';
export type SteeringActionKind = SoftSteeringKind | 'create';
export type SteeringMessageKind =
  | 'chat'
  | SteeringActionKind;
export type SteeringMessageKindInput = SteeringMessageKind | LegacySoftSteeringKind;

export interface SteeringTargetSnapshot {
  kind: 'summary' | 'atomic' | 'column';
  summary_id: string;
  summary_short_label: string;
  summary_text: string;
  columns: string[];
  column_anchors?: Array<{
    column: string;
    converge_index: number;
  }>;
  atomic_id?: string;
  atomic_text?: string;
  insight_type?: InsightType;
}

export interface ProvenanceCitation {
  marker: number;
  target: SteeringTargetSnapshot;
  label: string;
}

export interface DispatchBatchState {
  dispatch_turn_index: number;
  plan_ids: string[];
  status: 'dispatched' | 'waiting_for_stage_summary' | 'stage_summarized' | 'no_summary';
  stage_summary_emitted: boolean;
  batch_finished_user_response_emitted?: boolean;
  stage_summary_markdown: string;
  stage_summary_citations: ProvenanceCitation[];
}

export interface UserMessage {
  message_id: string;
  timestamp: string;
  content: string;
  kind?: SteeringMessageKindInput;
  display_text?: string;
  generated_prompt?: string;
  user_prompt?: string;
  system_prompt?: string;
  selected_keywords?: string[];
  target?: SteeringTargetSnapshot | null;
}

export interface TimelineEntry {
  entry_type: string;
  content: unknown;
  timestamp: string;
}

export interface Turn {
  turn_id: number;
  goal: string;
  steers: string[];
  timeline: TimelineEntry[];
  status: 'running' | 'completed';
  final_summary: string;
}

export interface MasterAgentState {
  current_goals: string[];
  active_plan_ids: string[];
  completed_plan_ids: string[];
  all_insight_ids: string[];
  dispatch_batches: DispatchBatchState[];
  pending_direct_user_create_dispatch_plan_ids?: string[];
  pending_user_response_message_ids?: string[];
  message_history: Array<Record<string, unknown>>;
  loop_count: number;
  completed: boolean;
}

export interface RunState {
  run_id: string;
  dataset_path: string;
  dataset_info: DatasetInfo | string;
  dataset_schema: string;
  step: number;
  failure_count: number;
  status: 'pending' | 'running' | 'paused' | 'idle' | 'completed' | 'failed' | 'stopped';
  budgets?: LegacyBudgets; // Legacy only; current backend no longer emits explicit run budgets.
  settings: RunSettings;
  master_agent_state?: MasterAgentState;
  plans?: PlanItem[];
  frontier: PlanItem[]; // Canonical frontend field; server normalizes plans into frontier when needed.
  // Legacy wire field name: `insights`. Values are summaries.
  insights: Summary[];
  execution_records: ExecutionRecord[];
  user_messages?: UserMessage[];
  turns?: Turn[];
  final_summary?: string;
  created_at: string;
  updated_at: string;
}

export type ConversationEntryType =
  | 'thinking'
  | 'plans_created'
  | 'plans_dispatched'
  | 'evaluation'
  | 'synthesis'
  | 'agent_response'
  | 'mark_complete'
  | 'user_message'
  | 'steering_action'
  | 'status_change';

export interface ConversationEntry {
  id: string;
  type: ConversationEntryType;
  timestamp: string;
  loopCount?: number;
  toolNames?: string[];
  plans?: PlanItem[];
  planIds?: string[];
  text?: string;
  markdownBody?: string;
  summary?: string;
  status?: string;
  reason?: string;
  dispatchTurnIndex?: number;
  citations?: ProvenanceCitation[];
  steeringKind?: SteeringActionKind;
  targetKind?: 'summary' | 'atomic' | 'column';
  targetLabel?: string;
  target?: SteeringTargetSnapshot | null;
  displayText?: string;
  generatedPrompt?: string;
  userPrompt?: string;
  systemPrompt?: string;
  selectedKeywords?: string[];
}

// ============================================================================
// Event Types
// ============================================================================

export type EventType =
  | 'run_started'
  | 'master_agent_thinking'
  | 'plan_created'
  | 'plan_started'
  | 'plan_status_changed'
  | 'plan_completed'
  | 'plan_attempt_started'
  | 'plan_log_delta'
  | 'plan_attempt_failed'
  | 'execution_completed'
  | 'insight_extracted'
  | 'report_generated'
  | 'drilldown_proposed'
  | 'master_agent_tool_result'
  | 'progress_evaluation'
  | 'synthesis_update'
  | 'run_status_change'
  | 'user_steer_received'
  | 'user_response'
  | 'run_completed';

export interface BaseEvent {
  timestamp: string;
  event_type: EventType;
  data: unknown;
}

export interface RunStartedEvent extends BaseEvent {
  event_type: 'run_started';
  data: {
    run_id: string;
    dataset_path: string;
    budgets?: LegacyBudgets;
    settings: RunSettings;
  };
}

export interface PlanCreatedEvent extends BaseEvent {
  event_type: 'plan_created';
  data: PlanItem;
}

export interface MasterAgentThinkingEvent extends BaseEvent {
  event_type: 'master_agent_thinking';
  data: {
    loop_count?: number;
    thought?: string;
  };
}

export interface PlanStartedEvent extends BaseEvent {
  event_type: 'plan_started';
  data: PlanItem;
}

export interface PlanStatusChangedEvent extends BaseEvent {
  event_type: 'plan_status_changed';
  data: PlanItem;
}

export interface PlanCompletedEvent extends BaseEvent {
  event_type: 'plan_completed';
  data: PlanItem;
}

export interface PlanAttemptStartedEvent extends BaseEvent {
  event_type: 'plan_attempt_started';
  data: {
    plan_id: string;
    attempt: number;
  };
}

export type PlanLogChannel = 'llm' | 'exec_stdout' | 'exec_stderr' | 'exec_plot' | 'system';

export interface PlanLogDeltaEvent extends BaseEvent {
  event_type: 'plan_log_delta';
  data: {
    plan_id: string;
    channel: PlanLogChannel;
    delta: string;
    seq: number;
    attempt: number;
  };
}

export interface PlanAttemptFailedEvent extends BaseEvent {
  event_type: 'plan_attempt_failed';
  data: {
    plan_id: string;
    attempt: number;
    error_summary: string;
  };
}

export interface ExecutionCompletedEvent extends BaseEvent {
  event_type: 'execution_completed';
  data: ExecutionRecord;
}

export interface InsightExtractedEvent extends BaseEvent {
  event_type: 'insight_extracted';
  // Legacy event name; payload is a summary.
  data: Summary;
}

export interface ReportGeneratedEvent extends BaseEvent {
  event_type: 'report_generated';
  data: {
    insight_id: string;
    report_path: string;
    report_pack_path: string;
    chain_insight_ids: string[];
    created_at: string;
    model: string;
    language: string;
    mode: string;
    segment_count?: number;
    errors?: string[];
    preview?: string;
  };
}

export interface DrilldownProposedEvent extends BaseEvent {
  event_type: 'drilldown_proposed';
  data: {
    parent_insight_id: string;
    new_plan_ids: string[];
  };
}

export interface MasterAgentToolResultEvent extends BaseEvent {
  event_type: 'master_agent_tool_result';
  data: {
    tool_name: string;
    result: Record<string, unknown>;
  };
}

export interface ProgressEvaluationEvent extends BaseEvent {
  event_type: 'progress_evaluation';
  data: {
    evaluation: string;
    stage_summary_markdown?: string;
    dispatch_turn_index?: number;
    plan_ids?: string[];
    covered_dispatch_turn_indexes?: number[];
    covered_plan_ids?: string[];
    citations?: ProvenanceCitation[];
  };
}

export interface SynthesisUpdateEvent extends BaseEvent {
  event_type: 'synthesis_update';
  data: {
    synthesis: string;
  };
}

export interface RunStatusChangeEvent extends BaseEvent {
  event_type: 'run_status_change';
  data: {
    old_status: string;
    new_status: string;
    reason: string;
  };
}

export interface UserSteerReceivedEvent extends BaseEvent {
  event_type: 'user_steer_received';
  data: UserMessage;
}

export interface UserResponseEvent extends BaseEvent {
  event_type: 'user_response';
  data: {
    message: string;
    citations?: ProvenanceCitation[];
  };
}

export interface RunCompletedEvent extends BaseEvent {
  event_type: 'run_completed';
  data: {
    total_steps: number;
    // Product terminology: "insights" == atomic insights.
    total_insights: number;
    total_summaries?: number;
    total_failures: number;
    final_status: string;
  };
}

export type Event =
  | RunStartedEvent
  | MasterAgentThinkingEvent
  | PlanCreatedEvent
  | PlanStartedEvent
  | PlanStatusChangedEvent
  | PlanCompletedEvent
  | PlanAttemptStartedEvent
  | PlanLogDeltaEvent
  | PlanAttemptFailedEvent
  | ExecutionCompletedEvent
  | InsightExtractedEvent
  | ReportGeneratedEvent
  | DrilldownProposedEvent
  | MasterAgentToolResultEvent
  | ProgressEvaluationEvent
  | SynthesisUpdateEvent
  | RunStatusChangeEvent
  | UserSteerReceivedEvent
  | UserResponseEvent
  | RunCompletedEvent;

// ============================================================================
// API Response Types
// ============================================================================

export interface RunSummary {
  run_id: string;
  dataset_path: string;
  status: string;
  step: number;
  failure_count: number;
  // Product terminology: atomic insight count.
  insight_count: number;
  summary_count?: number;
  created_at: string;
  updated_at: string;
  first_user_message?: string;
  last_activity_at?: string;
  is_legacy?: boolean;
  contract_version?: string;
  legacy_reason?: string;
}

// ============================================================================
// API Request/Response Types (Run Gateway)
// ============================================================================

export type {
  DatasetPreviewResponse,
  DatasetUploadResponse,
  GenerateReportRequest,
  GenerateReportResponse,
  PlanControlAction,
  ProvenanceCitation as ApiProvenanceCitation,
  ReportLanguage,
  SteeringTargetSnapshot as ApiSteeringTargetSnapshot,
  SteerRunRequest,
  SteerRunResponse,
  StartRunRequest,
  StartRunResponse,
  StopRunResponse,
  UpdateRunSettingsRequest,
  UpdateRunSettingsResponse,
} from './api';

export interface PlanControlResponse {
  plan: PlanItem;
  run_status: RunState['status'];
  run_state?: RunState;
}

export interface Selection {
  // `insight` kept for backward compatibility with older local UI state.
  type: 'plan' | 'summary' | 'insight' | 'coverage_cell' | null;
  id: string | null;
  atomicId?: string;
}

export type StructureViewMode = 'ego' | 'ltr' | 'storyline_columns';
export type WorkspaceViewMode = 'conversation' | 'dashboard';

// ============================================================================
// Bookmark Types
// ============================================================================

export interface Bookmark {
  id: string;
  // References summary node id (legacy key name retained for compatibility).
  insight_id: string;
  note: string;
  created_at: string;
}

// ============================================================================
// Report Types
// ============================================================================

export interface Report {
  // References summary node id (legacy key name retained for compatibility).
  insight_id: string;
  report_path: string;
  report_pack_path: string;
  chain_insight_ids: string[];
  created_at: string;
  model: string;
  language: string;
  mode: string;
  segment_count: number;
  errors: string[];
  preview: string;
}

// ============================================================================
// Plan Live Log Types (for real-time streaming)
// ============================================================================

export interface PlanLogEntry {
  channel: PlanLogChannel;
  content: string;
  seq: number;
  attempt: number;
  timestamp: string;
}

export interface PlanLiveState {
  plan_id: string;
  current_attempt: number;
  logs: PlanLogEntry[];
  attempts: PlanAttemptInfo[];
}

export interface PlanAttemptInfo {
  attempt: number;
  started_at: string;
  failed_at?: string;
  error_summary?: string;
}
