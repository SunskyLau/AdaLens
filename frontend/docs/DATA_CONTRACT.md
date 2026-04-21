# Agentic EDA Frontend Projection of the Runtime Contract

## Authority and Scope

- `agentic framework/implementation.md` is the sole authoritative backend/runtime contract.
- This document is a frontend-facing projection of that runtime for UI, gateway, and state-consumption work.
- If a projection in this file conflicts with the implementation supplement, the implementation supplement wins.
- Transport adapters may rename or reshape fields for frontend convenience, but those adapter details must not redefine the canonical runtime semantics documented here.

## Canonical Runtime Objects

### Steering, Control, and Signals

```ts
type SteeringKind = 'focus' | 'ignore' | 'elaborate';

type ExecutionControlAction =
  | 'launch'
  | 'pause'
  | 'terminate'
  | 'modify'
  | 'create';

interface SteeringTargetSnapshot {
  kind: 'summary' | 'atomic' | 'column';
  summary_id?: string;
  summary_short_label?: string;
  summary_text?: string;
  atomic_id?: string;
  atomic_text?: string;
  columns: string[];
  evidence_refs?: string[];
  provenance_refs?: string[];
}

interface SteeringRequest {
  steering_id: string;
  kind: SteeringKind;
  source: string;
  timestamp: string;
  target: SteeringTargetSnapshot;
  selected_keywords?: string[];
  display_text?: string;
  lifecycle?: string;
  linked_plan_ids?: string[];
}

interface ExecutionControlRequest {
  control_id: string;
  action: ExecutionControlAction;
  source: string;
  timestamp: string;
  target_plan_id?: string;
  user_authored_text?: string;
  display_text?: string;
  lifecycle?: string;
  linked_plan_ids?: string[];
}

interface RuntimeSignal {
  kind:
    | 'worker_finding_ready'
    | 'worker_status_updated'
    | 'dispatch_ready'
    | 'post_emit_response_review_ready'
    | 'post_stage_summary_review_ready'
    | 'unprocessed_steering_ready'
    | string;
  plan_id?: string;
  finding_id?: string;
  checkpoint_ref?: string;
}
```

Notes:

- `create` is an execution-control action, not a steering kind.
- Ordinary free-form user goals and chat follow-ups may wake the same runtime boundary, but they do not change the canonical visible-element steering vocabulary in this document.
- `SteeringTargetSnapshot` is the stable snapshot of the selected target that survives later runtime changes.

### Orchestrator and Worker Outputs

```ts
type OrchestratorActionType =
  | 'wait'
  | 'create_plans'
  | 'dispatch_plans'
  | 'evaluate_progress'
  | 'emit_response'
  | 'emit_stage_synthesis'
  | 'emit_final_report';

interface OrchestratorAction {
  action_id: string;
  type: OrchestratorActionType;
  rationale: string;
  consumed_steering_ids: string[];
  payload: Record<string, unknown>;
}

interface EvaluateProgressPayload {
  progress_digest: string;
  dispatch_turn_index?: number;
  plan_ids?: string[];
}

interface EmitStageSynthesisPayload {
  stage_synthesis: string;
  dispatch_turn_index?: number;
  citations?: Array<{
    marker: number;
    target: SteeringTargetSnapshot;
    label: string;
  }>;
}

interface EmitFinalReportPayload {
  final_report: string;
  dispatch_turn_index?: number;
  citations?: Array<{
    marker: number;
    target: SteeringTargetSnapshot;
    label: string;
  }>;
}

interface RunCompletedPayload {
  total_steps: number;
  total_insights: number;
  total_summaries?: number;
  total_failures: number;
  final_status: string;
  final_report?: string;
  dispatch_turn_index?: number;
  citations?: Array<{
    marker: number;
    target: SteeringTargetSnapshot;
    label: string;
  }>;
}

interface InsightEvidence {
  code_path: string;
  output_path: string;
  plot_path: string;
}

interface AtomicInsight {
  atomic_id: string;
  text: string;
  insight_type: string;
  columns: string[];
  keywords: string[];
  importance_metrics?: Record<string, number>;
  evidence: InsightEvidence;
}

interface WorkerFindingAtomicInsight {
  text: string;
  insight_type: string;
  columns: string[];
  keywords: string[];
  evidence: InsightEvidence;
}

interface WorkerFinding {
  summary: string;
  short_label: string;
  keywords: string[];
  atomic_insights: WorkerFindingAtomicInsight[];
}
```

Notes:

- `WorkerFinding` is the summarizer's pre-materialization worker output object.
- `WorkerFinding.atomic_insights[].evidence.code_path`, `output_path`, and `plot_path` are required grounding fields in the implementation contract.
- Frontend adapters must not weaken the grounding requirement when they project findings into UI state.
- Citation payloads on `emit_stage_synthesis`, `emit_final_report`, and `run_completed` are canonical-only: each citation uses `marker` + `target` (+ optional `label`), where `target.kind` must be `summary` or `atomic`.
- Citation targets must include `target.summary_id`; `target.atomic_id` is required when `target.kind='atomic'`.
- Narrative markdown that references citations should use inline `[[n]]` markers aligned with citation markers (positive, unique, increasing).
- Legacy citation keys such as `insight_id`, `finding_id`, `source_id`, and `plan_id` are unsupported for new writes.

## Canonical Runtime State Model

These interfaces describe the runtime-state objects named in the implementation supplement. They intentionally document core fields rather than every transport- or adapter-specific detail.

```ts
interface RunState {
  run_id: string;
  dataset_metadata: Record<string, unknown>;
  status: string;
  settings: Record<string, unknown>;
  steering_state: SteeringState;
  execution_control_state: ExecutionControlState;
  turns: TurnState[];
  plans: PlanState[];
  batches: DispatchBatchState[];
  findings: Insight[];
  artifacts: ArtifactRecord[];
  timeline: TimelineEntry[];
}

interface TurnState {
  turn_id: string;
  current_goal: string;
  triggering_inputs: Array<SteeringRequest | ExecutionControlRequest | Record<string, unknown>>;
  accepted_steering_ids: string[];
  dispatch_batches: DispatchBatchState[];
  stage_syntheses: Array<Record<string, unknown>>;
  completion_status: string;
}

interface PlanState {
  plan_id: string;
  text: string;
  source: string;
  status: string;
  control_state?: 'none' | 'pause_requested' | 'terminate_requested';
  assigned_worker?: string;
  resume_phase?: string;
  checkpoint_ref?: string;
  pending_modified_text?: string | null;
  launch_requested?: boolean;
  final_summary?: string | null;
  error_message?: string | null;
  linked_steering_ids: string[];
  linked_control_ids: string[];
  revision: number;
}

interface DispatchBatchState {
  batch_id: string;
  ordered_plan_ids: string[];
  active_plan_ids: string[];
  waiting_plan_ids: string[];
  batch_status: string;
  stage_synthesis_refs: string[];
}

interface WorkerSessionState {
  worker_session_id: string;
  plan_id: string;
  analysis_phase: string;
  tool_history: Array<Record<string, unknown>>;
  artifact_refs: string[];
  checkpoint_ref?: string;
  latest_reflection?: string;
}

interface SteeringState {
  registered_steering_ids: string[];
  active_steering_ids: string[];
  consumed_steering_ids: string[];
  superseded_steering_ids: string[];
  target_index: Record<string, string[]>;
}

interface ExecutionControlState {
  registered_control_ids: string[];
  applied_control_ids: string[];
  superseded_control_ids: string[];
  controls_by_plan: Record<string, string[]>;
}

interface Insight {
  insight_id: string;
  plan_id: string;
  short_label: string;
  summary: string;
  keywords: string[];
  atomic_insights: AtomicInsight[];
  parent_lineage_refs: string[];
}

interface ArtifactRecord {
  artifact_id: string;
  type: string;
  owner_refs: string[];
  path_or_uri: string;
  metadata: Record<string, unknown>;
}

interface TimelineEntry {
  entry_id: string;
  entry_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
```

Notes:

- The implementation supplement defines these objects by responsibility and core fields. Frontend adapters may add derived view-model fields, but those additions are projections rather than canonical backend semantics.
- Read-compat projections may still expose aliases such as `plans` / `frontier` and `parent_insight_id` alongside canonical fields like `parent_lineage_refs`; new backend semantics still follow `implementation.md`.

## Frontend Submission Rules

The canonical UI-to-runtime mapping is:

- summary `focus` / `ignore` / `elaborate` -> `SteeringRequest(target=summary)`
- atomic `focus` / `ignore` / `elaborate` -> `SteeringRequest(target=atomic)`
- column `focus` / `ignore` -> `SteeringRequest(target=column)`
- blank-space create -> `ExecutionControlRequest(action='create')` with raw `user_authored_text`
- plan-thread controls -> `ExecutionControlRequest(action='launch' | 'pause' | 'terminate' | 'modify')`

Frontend adapters must preserve the following rules:

- do not project `create` into the steering-kind namespace
- do not document or persist an alternate canonical plan-control vocabulary in place of `launch`, `pause`, `terminate`, and `modify`
- for active plans, `modify` may be sent first without `user_authored_text` to request pause; text revision is then sent by a follow-up `modify`
- keep `selected_keywords` as a steering-level affordance for summary/atomic `focus` and `ignore` when the frontend uses keyword-priority UI
- preserve the target snapshot rather than fabricating alternate target models on the client

## Frontend Consumption Rules

Frontend consumers should map canonical backend outputs as follows:

- `OrchestratorAction(type='emit_response')` -> response or explanation UI
- `OrchestratorAction(type='emit_stage_synthesis')` -> stage-synthesis UI and storyline projection
- `OrchestratorAction(type='emit_final_report')` -> final-report UI and storyline projection
- `WorkerFinding` -> summary and atomic-insight rendering in chat, storyline, and inspector
- evaluate/stage/final payloads may include `dispatch_turn_index` and `citations` to keep storyline/chat provenance aligned
- `run_completed` may include `final_report`, `dispatch_turn_index`, and `citations` when the latest terminal action was `emit_final_report`
- citation rendering relies on canonical citation payloads plus inline `[[n]]` markers; consumers should treat non-canonical citation shapes as compatibility-only and ignore them
- runtime signals -> refresh or wake-up cues for streaming/event consumers

The frontend may maintain additional derived view models for chat cards, storyline nodes, filters, or inspector state, but those projections must remain traceable to the canonical runtime objects above.

## Compatibility Placeholder APIs

The current frontend still exposes `/api/runs/:runId/report` as a compatibility route for existing UI flows.

- This route is not part of the canonical backend runtime in `implementation.md`.
- The current compatibility behavior is a successful empty result rather than report generation through the core runtime.
- Frontend consumers should treat empty `report_path` / `report_pack_path` values as "no generated report is available".
- Gateway state reads may also include optimistic projection of still-unapplied `plan_controls.jsonl` entries; treat projected plan-control fields as compatibility view-model state rather than a separate canonical contract.

## Persistence and Artifact Projection

The implementation supplement treats persistence as responsible for:

- graph state snapshots
- worker checkpoints
- steering and control history
- artifact references
- timeline events
- provenance needed to reconstruct summaries and atomic insights

Frontend consumers should expect persisted artifacts to include, at minimum:

- code artifacts
- stdout / stderr artifacts
- plot artifacts
- report artifacts
- checkpoint/session artifacts

Adapters may project these into gateway URLs or local file access helpers, but the canonical provenance remains the persisted artifact references attached to findings, worker state, and timeline entries.

## Legacy Compatibility

If frontend code still contains read-only compatibility normalization for older saved runs or older gateway payloads, treat that logic as a compatibility adapter only.

- Compatibility code must not redefine the canonical runtime vocabulary in this document.
- New writes, new projections, and new docs must align to the implementation supplement.
