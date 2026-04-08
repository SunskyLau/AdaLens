# Agentic EDA Data Contract (MVP, v1.15)

This document describes the current backend/frontend wire contract used by the app.

Legacy note:
- Older saved runs may still contain legacy aliases such as `plans`, `insights`, or `budgets`.
- The frontend still normalizes some of those aliases on read, but new writes should follow the contract below.
- Steering reads still accept legacy `dive_into`, `cut_off`, and `suppress` kinds, but all new writes use canonical `focus`, `ignore`, `elaborate`, and `create`.
- Older saved runs may omit summary/atomic `keywords`; the UI must still allow summary/glyph steering through the editable `Preview` / `Background` flow without forcing keyword selection.
- Recent storyline boundary-window, route-box-clearance, and X-safety refinements are render-side/layout-side only; they do not introduce new persisted wire fields beyond the existing summary-local boundary-contract inputs already documented in code-facing layout modules.

---

## 1) Run directory structure

```text
runs/{run_id}/
├─ state.json                          # Run state snapshot
├─ events.jsonl                        # Append-only event stream
├─ STOP                                # Optional graceful-stop marker
├─ plan_controls.jsonl                 # Optional append-only plan control requests
├─ runtime_controls.jsonl              # Append-only runtime control changes (`update_settings`, `reorder_latest_batch`)
└─ artifacts/
   ├─ code/{plan_id}.py
   ├─ code/{plan_id}_attempt{n}.py
   ├─ stdout/{plan_id}_attempt{n}.txt
   ├─ stderr/{plan_id}_attempt{n}.txt
   ├─ sessions/{plan_id}.analysis.json
   ├─ sessions/{plan_id}.analysis.checkpoint.json
   ├─ plots/{plan_id}_N.png
   ├─ reports/report_{insight_id}.md
   └─ report_packs/{insight_id}/...
```

---

## 2) `state.json` models

### RunState

```ts
interface RunState {
  run_id: string;
  dataset_path: string;
  dataset_info: string;
  dataset_schema: string;
  step: number;
  failure_count: number;
  status: 'pending' | 'running' | 'paused' | 'idle' | 'completed' | 'failed' | 'stopped';
  settings: RunSettings;
  master_agent_state?: MasterAgentState;
  plans?: PlanItem[];                   // legacy/compat key
  frontier: PlanItem[];                 // canonical frontend field after normalization
  insights: Summary[];                  // legacy wire key name; values are summaries
  execution_records: ExecutionRecord[];
  user_messages?: UserMessage[];
  turns?: Turn[];
  final_summary?: string;
  created_at: string;
  updated_at: string;
}
```

### RunSettings

```ts
interface RunSettings {
  max_concurrency: number;
  poll_interval_seconds?: number;
}
```

Run-settings notes:
- Canonical `max_concurrency` range is `1-6`.
- Canonical default is `2`.
- Older saved runs should be clamped into that range on read.

### PlanItem

```ts
interface PlanItem {
  plan_id: string;
  kind: 'analysis';
  text: string;
  short_label?: string | null;
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
  control_state?: 'none' | 'pause_requested' | 'terminate_requested' | 'yield_requested';
  resume_phase?: 'analyzing' | 'summarizing' | null;
  checkpoint_path?: string | null;
  parent_insight_id: string | null;
  created_at: string;
  updated_at?: string;
}
```

Plan control semantics:
- `start` applies only to `pending` plans.
- `pause` on `pending` lands immediately in `paused` and should set `resume_phase='analyzing'`.
- `pause` on `analyzing` / `summarizing` should first expose `control_state='pause_requested'`, then land in `paused` at a safe point.
- `terminate` on `pending` / `paused` lands immediately in `terminated`.
- `terminate` on `analyzing` / `summarizing` should first expose `control_state='terminate_requested'`, then land in `terminated` at a safe point.
- `resume` applies only to `paused` plans and uses `resume_phase` to choose analyzer vs summarizer restart.
- `start` / `resume` share the same hard cap as normal dispatch: the number of active `analyzing` / `summarizing` plans must never exceed `settings.max_concurrency`.
- Automatic pending backfill is terminal-event-driven: only `completed` / `failed` / `terminated` transitions trigger a seat-fill check for waiting `pending` siblings, and that check must still honor available execution capacity. Plain `paused` never triggers that search on its own.
- `yield_requested` means the plan was displaced from the current batch's execution seats by an immediate latest-batch reorder; it should return to `pending` while preserving checkpoint/resume metadata.

### Filter

```ts
type FilterOp = 'eq' | 'in' | 'between' | 'gt' | 'gte' | 'lt' | 'lte' | 'isnull' | 'notnull';

interface Filter {
  col: string;
  op: FilterOp;
  value?: unknown;
  values?: unknown[];
  low?: unknown;
  high?: unknown;
}
```

### Summary / AtomicInsight

```ts
type InsightType =
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

interface InsightEvidence {
  code_path: string | null;
  output_path: string | null;
  plot_path: string | null;
}

interface AtomicInsight {
  atomic_id: string;
  text: string;
  insight_type: InsightType;
  columns: string[];
  keywords?: string[];
  evidence: InsightEvidence;
  embedding?: number[] | null;
}

interface Summary {
  insight_id: string;
  plan_id: string;
  summary: string;
  short_label?: string | null;
  atomic_insights: AtomicInsight[];
  keywords?: string[];
  embedding?: number[] | null;
  parent_insight_id: string | null;
  created_at: string;
}
```

Notes:
- `Summary.keywords` and `AtomicInsight.keywords` are summarizer-generated focus handles for insight-targeted steering.
- New writes should persist these fields as deduped, trimmed arrays capped at 10 items.
- Older runs may omit these fields entirely; the frontend should treat missing values as an empty keyword list.
- Summarizer output should strip stock meta lead-in first sentences such as `The analysis reveals...`, `Analysis of ... reveals...`, `关于……的分析已经完成`, or `根据您的要求...` before persisting `summary`.
- Summarizer output normalization should treat CJK terminal punctuation (`。`, `！`, `？`) as valid sentence endings and must not emit mixed terminal punctuation such as `。.` / `！.` / `？.` in persisted `summary` or `AtomicInsight.text`.
- Compatibility read-path normalization in gateway/frontend should also sanitize legacy persisted mixed endings (`。.` / `！.` / `？.`) in `Summary.summary`, `AtomicInsight.text`, and steering target snapshot text fields before rendering.

### SteeringTargetSnapshot / ProvenanceCitation

```ts
interface SteeringTargetSnapshot {
  kind: 'summary' | 'atomic' | 'column';
  summary_id: string;
  summary_short_label: string;
  summary_text: string;
  columns: string[];
  atomic_id?: string;
  atomic_text?: string;
  insight_type?: InsightType;
}

interface ProvenanceCitation {
  marker: number;
  target: SteeringTargetSnapshot;
  label: string;
}
```

Notes:
- For `kind='column'`, `columns` is the authoritative full column group.
- New writes must not include or depend on `column_name` / anchor-column semantics.
- Older single-column snapshots that only carry `column_name` or a one-item `columns` array remain valid on read; backend/frontend normalize them into `columns` and ignore the legacy field afterward.
- Summary/glyph steering continues to pass context through `summary_text` / `atomic_text`, and aggregated column steering continues to use `target.kind='column'` plus `target.columns`.

### MasterAgentState / dispatch batches

```ts
interface DispatchBatchState {
  dispatch_turn_index: number;           // One storyline turn == one dispatch_plans batch
  plan_ids: string[];
  status: 'dispatched' | 'waiting_for_stage_summary' | 'stage_summarized' | 'no_summary';
  stage_summary_emitted: boolean;
  stage_summary_markdown: string;
  stage_summary_citations: ProvenanceCitation[];
}

interface MasterAgentState {
  current_goals: string[];
  active_plan_ids: string[];
  completed_plan_ids: string[];
  all_insight_ids: string[];
  dispatch_batches: DispatchBatchState[];
  pending_user_response_message_ids?: string[];
  message_history: Array<Record<string, unknown>>;
  loop_count: number;
  completed: boolean;
}
```

Notes:
- `pending_user_response_message_ids` stores only one-time immediate acknowledgements still waiting to be emitted for user-authored `chat` / `focus` / `ignore` / `elaborate` / `create` messages.
- Each id is removed as soon as that single runtime-generated acknowledgement has been emitted.

Backend runtime note:
- Sub-agent runtime control results may also use `control_action='yield'` to distinguish a latest-batch reorder displacement from a user-authored pause.

### ExecutionRecord

```ts
interface ExecutionRecord {
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
```

---

## 3) `events.jsonl` types

```ts
type EventType =
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
  | 'user_steer_received'
  | 'user_response'
  | 'run_status_change'
  | 'run_completed';
```

### UserMessage

```ts
interface UserMessage {
  message_id: string;
  timestamp: string;
  content: string;
  kind?: 'chat' | 'focus' | 'ignore' | 'elaborate' | 'create';
  display_text?: string;
  generated_prompt?: string;
  user_prompt?: string;
  system_prompt?: string;
  selected_keywords?: string[];
  target?: SteeringTargetSnapshot | null;
}
```

Notes:
- The first user input that opens a turn is that turn's goal.
- Additional user inputs while that turn is still active are appended as steers.
- `focus` / `ignore` are contextualized steering actions and may carry `summary`, `atomic`, or `column` targets.
- Summary/glyph `focus` / `ignore` may also carry `selected_keywords`, which should be treated as the user-prioritized focus handles while `target.summary_text` / `target.atomic_text` remains read-only background context that may optionally be appended to `user_prompt`.
- `focus` / `ignore` / `elaborate` new writes use `content = user_prompt`, may also carry hidden `system_prompt`, and keep `generated_prompt` only as a compatibility read field.
- `elaborate` is a contextualized steering action for `summary` / `atomic` targets only. Its visible `user_prompt` stays concise and target-kind-aware, while `system_prompt` carries the hidden semantic constraints.
- `create` is targetless: `target = null`, `display_text =` the raw user-authored plan text, `user_prompt` / `system_prompt` stay unset, and `generated_prompt = ''` only for compatibility.
- `create` always creates exactly one `PlanItem`; if a dispatch batch is currently running, that plan joins the current batch, otherwise it is dispatched once on its own.
- Legacy aliases still normalize on read as `dive_into -> focus`, `cut_off -> ignore`, and `suppress -> ignore`.
- The one-time immediate acknowledgement for new user-authored `chat` / `focus` / `ignore` / `elaborate` / `create` messages should come from the backend's dedicated fast LLM path using the full canonical user-authored text plus steering metadata, not from a truncated excerpt/template shortcut.

### Start run request

```ts
interface StartRunRequest {
  dataset_path: string;
  user_goal: string;
  max_concurrency?: number;
  max_initial_plans?: number;
}
```

### Dataset upload response

```ts
interface DatasetUploadResponse {
  dataset_path: string;
  original_filename: string;
  size_bytes: number;
  temporary: true;
}
```

### Steer request

```ts
interface SteerRunRequest {
  content: string;
  kind?: 'chat' | 'focus' | 'ignore' | 'elaborate' | 'create' | 'dive_into' | 'cut_off' | 'suppress';
  display_text?: string;
  user_prompt?: string;
  system_prompt?: string;
  selected_keywords?: string[];
  target?: SteeringTargetSnapshot | null;
}
```

Steer endpoint notes:
- Column `focus` / `ignore` may be single-column or aggregated multi-column actions. Aggregated requests use one `column` target where `target.columns` stores the full selected group in first-click order; new writes never include `target.column_name`.
- Summary/glyph `focus` / `ignore` carry `selected_keywords` plus the summary / atomic target snapshot.
- `user_prompt` is the user-visible preview text that the chat UI replays later; `system_prompt` carries hidden steering semantics and constraints for the backend/agents.
- For summary/glyph `focus` / `ignore`, the frontend now keeps a read-only background block plus an `Included` label and checkbox that decide whether that background is appended to `user_prompt`. The checkbox defaults to checked, and unchecked background blocks switch to an explicitly excluded visual style.
- The editable preview text is normalized to remove blank lines and uses a `generated prefix + preserved appended text` refresh model: target/keyword changes refresh the generated prefix while preserving appended user text, and those refreshes must not rewrite the user-authored appended portion. While that generated portion is still present, the auto-filled topic keywords, selected columns, and summary/atomic target text inside `Preview` render as colored bold text. For summary/glyph `focus` / `ignore`, generated preview templates start directly with keyword-priority wording and do not include fixed lead-ins such as `请继续围绕该总结开展后续分析` / `Focus follow-up analysis on this summary`, `请继续围绕该原子洞察开展后续分析` / `Focus follow-up analysis on this atomic insight`, `请降低后续对该总结的分析优先级` / `Ignore future follow-up analysis on this summary`, or `请降低后续对该原子洞察的分析优先级` / `Ignore future follow-up analysis on this atomic insight`.
- New structured steering writes align `content` to `user_prompt`; older requests that only send `content` / `generated_prompt` remain valid and are normalized on read.
- `elaborate` is valid only for `summary` / `atomic` targets and does not usually carry `selected_keywords`.
- `create` always sends `target: null`.

### Dataset preview response

```ts
interface DatasetPreviewResponse {
  dataset_path: string;
  delimiter?: ',' | ';' | '\t' | '|';
  columns: string[];
  rows: string[][];
  row_count: number;
  offset: number;
  returned_rows: number;
  has_more: boolean;
}
```

Dataset-preview notes:
- Gateway preview supports common CSV delimiters beyond commas and returns the detected `delimiter` when available.
- Backend `dataset_info` may also persist the same `delimiter` so analyzer/runtime readers can reuse it.

### Plan control endpoint

```ts
POST /api/runs/:runId/plans/:planId/control

interface PlanControlRequest {
  action: 'start' | 'pause' | 'resume' | 'terminate';
}

interface PlanControlResponse {
  plan: PlanItem;
  run_status: RunState['status'];
}
```

Plan-control notes:
- Gateway validates the run/plan, writes a record into `plan_controls.jsonl`, and returns the updated plan plus current run status.
- For running plans, gateway may immediately update `control_state` while the final `paused` / `terminated` state is applied later by master/sub-agent orchestration.
- `start` / `resume` requests must still honor `settings.max_concurrency`; if seats are full, the request may reprioritize batch order but the plan remains non-running until a seat opens.

### Run settings endpoint

```ts
PATCH /api/runs/:runId/settings

interface UpdateRunSettingsRequest {
  max_concurrency: number;
}

interface UpdateRunSettingsResponse {
  run_id: string;
  settings: RunSettings;
}
```

Notes:
- Gateway clamps `max_concurrency` into the canonical `1-6` range.
- Persisted settings changes apply immediately to run state, but only affect later dispatch / seat-fill decisions rather than preempting the current batch on their own.
- Gateway appends the change to `runtime_controls.jsonl` as `action='update_settings'`.

### Latest dispatch-batch reorder endpoint

```ts
POST /api/runs/:runId/dispatch-batches/latest/reorder

interface ReorderLatestDispatchBatchRequest {
  dispatch_turn_index?: number;
  plan_ids: string[];                    // Full reordered list of the latest unresolved batch's nonterminal plans
}

interface ReorderLatestDispatchBatchResponse {
  run_id: string;
  dispatch_turn_index: number;
  plan_ids: string[];
  run_state: RunState;
}
```

Notes:
- This endpoint only accepts reorders for the latest unresolved dispatch batch.
- The submitted `plan_ids` must exactly match that batch's current nonterminal plan ids, just in a new order.
- The returned `run_state` already includes the immediate optimistic seat rebalance for the new order: the top `max_concurrency` nonterminal plans become the active seats, displaced running plans move to `pending` with `control_state='yield_requested'`, and resumable metadata is preserved.
- Gateway appends the change to `runtime_controls.jsonl` as `action='reorder_latest_batch'`.

### Conversation replay contract

```ts
interface ConversationEntry {
  id: string;
  type:
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
  timestamp: string;
  planIds?: string[];
  dispatchTurnIndex?: number;
  markdownBody?: string;
  citations?: ProvenanceCitation[];
  steeringKind?: 'focus' | 'ignore' | 'elaborate' | 'create';
  targetKind?: 'summary' | 'atomic' | 'column';
  targetLabel?: string;
  target?: SteeringTargetSnapshot | null;
  displayText?: string;
  generatedPrompt?: string;
  userPrompt?: string;
  systemPrompt?: string;
  selectedKeywords?: string[];
}
```

Notes:
- `ConversationEntry.target` is the source of truth for steering replay.
- `displayText`, `selectedKeywords`, and `userPrompt` preserve the structured steering-card content shown in chat.
- Steering cards show `userPrompt` in the expandable `Preview` block and fall back to historical `generatedPrompt` only for older runs. `systemPrompt` is stored but not shown in the UI.
- `create` entries intentionally keep `target = null`; they reuse steering-action card styling in chat but do not replay into storyline selection/filter state.
- `plans_dispatched` entries may carry `dispatchTurnIndex`, sourced from `dispatch_plans.result.dispatch_turn_index`.
- `evaluation` and `mark_complete` entries may also carry `dispatchTurnIndex`, sourced from `progress_evaluation.dispatch_turn_index` and `mark_complete.result.dispatch_turn_index`, so storyline can map stage/final summaries back onto converges.
- Clicking a steering entry or citation should reuse local storyline activation only; it must not send a new `/steer` request.
- Steering replay and citation replay must not trigger chat auto-scroll to the matching summary anchor.

### `progress_evaluation`

```ts
interface ProgressEvaluationEvent {
  event_type: 'progress_evaluation';
  data: {
    evaluation: string;
    stage_summary_markdown?: string;
    dispatch_turn_index?: number;
    plan_ids?: string[];
    citations?: ProvenanceCitation[];
  };
}
```

### `master_agent_tool_result` payloads used by the frontend

```ts
interface DispatchPlansToolResult {
  plan_ids?: string[];
  dispatched_plan_ids: string[];
  dispatch_turn_index?: number;
}

interface EvaluateProgressToolResult {
  evaluation?: string;
  stage_summary_markdown?: string;
  citations?: ProvenanceCitation[];
}

interface MarkCompleteToolResult {
  summary: string;
  citations?: ProvenanceCitation[];
  dispatch_turn_index?: number;
}

interface UserResponseEvent {
  event_type: 'user_response';
  data: {
    message: string;
    citations?: ProvenanceCitation[];
  };
}
```

---

## 4) UI mapping

- `progress_evaluation` renders one stage-summary card, including inline citation superscripts.
- `master_agent_tool_result(tool_name='mark_complete')` renders one final-summary card, including inline citation superscripts.
- Every new user-authored `chat`, `focus`, `ignore`, `elaborate`, or `create` input must be acknowledged by exactly one immediate runtime-generated `respond_to_user` before the master agent runs any other tool, and those one-time pending acknowledgements may persist briefly in `master_agent_state.pending_user_response_message_ids` until emitted.
- Those immediate acknowledgements should come from the backend's dedicated fast LLM path using the full canonical user-authored text plus steering metadata, not from a truncated excerpt/template shortcut.
- Every `progress_evaluation` or `mark_complete` summary must still be followed immediately by one separate concise `respond_to_user`, explaining why that summary is justified now and what follow-up analysis directions still make sense. `user_response` may carry inline `[[n]]` markers plus structured `citations`, and the chat UI renders those citations with the same superscript logic used by stage/final summaries.
- No other standalone progress-broadcast `user_response` events are part of the valid backend contract.
- `master_agent_tool_result(tool_name='dispatch_plans')` creates a `plans_dispatched` conversation entry and carries `dispatch_turn_index` for active-plan storyline placement. When available, `result.plan_ids` is the full live ordered batch membership, while `result.dispatched_plan_ids` is only the subset that started in that dispatch step.
- `plan_created` adds plans to the frontier.
- `plan_started` marks a plan as `analyzing`.
- `plan_status_changed` advances phase changes such as `summarizing`, and also surfaces `control_state` changes such as `pause_requested` / `terminate_requested` / `yield_requested`.
- `plan_log_delta` appends to the analysis stream.
- `execution_completed` updates evidence availability.
- `insight_extracted` adds a real summary node.
- `run_status_change(new_status='completed')` means the round is done, but the conversation can still accept follow-up goals.
- Storyline blank-space right-click opens the targetless `create` composer.
- Storyline blank-space left-click without dragging clears the current selection; blank-space dragging keeps pan behavior and does not clear selection.
- Storyline steering creation uses a persistent top-left vertical pen toolbar with `focus`, `ignore`, and `elaborate`; the pen buttons share one compact width sized for the pen labels and keep icon/text content centered. Clicking the active pen again, switching pens, switching runs, closing/canceling a steering popover, pressing `Esc`, or successfully confirming a pen request after it has been sent to the backend clears the current pen mode.
- Storyline top-rail `overview` card has been removed. The `Insight Types` legend now occupies that former slot, keeps its existing interaction visuals, enlarges legend text/glyph size, and prefers one row with fallback wrapping to two rows when width is limited.
- With an active pen, column clicks stay steering-only; summary-area and atomic-glyph clicks still replay their normal local selection/chat-link behavior while also opening the steering UI.
- Column `focus` / `ignore` stages a persistent toggleable multi-column group immediately and keeps one live confirmation popover open until submission or dismissal.
- Summary/glyph `focus` / `ignore` opens a keyword chooser populated from summary/atomic `keywords`, plus an editable `Preview` textarea and a read-only `Background` block seeded from the summary/atomic text. An `Included` label plus checkbox decide whether that background is appended to `user_prompt`, and unchecked background blocks switch to an explicitly excluded visual style. The confirmed request persists `selected_keywords` when stored keywords are available, and the generated topic/target snippets inside `Preview` render as colored bold text until they are replaced or edited away.
- Converge indicator label sizes use that converge's immediate right-turn atomic counts only: `0` stays at the minimum font size, nonzero counts interpolate up to the current maximum, and when all nonzero counts in the same converge are identical they all use the arithmetic midpoint font size.
- Storyline turn/converge boundary layout is incremental by adjacent window. Normal ingress `(converge_i, turn_i)` and egress `(turn_i, converge_{i+1})` solves run local `ordering -> alignment -> compaction` only against their immediate neighbor; later turns must not retroactively re-solve older converges, and a converge frozen by ingress stage 3 may only receive a later whole-band centering shift.
- Ingress summary-local boundary contracts are order-only: the atomic-layout facade consumes `leftPortColumnsInOrder`, while left-port target Y / min-gap / span remain summary-local concerns instead of being imposed from ingress converge compaction.
- When later ingress introduces extension columns into an already solved converge, those new columns may be placed above the old top lane, below the old bottom lane, or between preserved lanes. The frontend should then compact the whole merged converge order together, size ingress converge `d1` against current indicator-clearance needs for the whole band, and freeze the resulting converge Y coordinates before solving the new right turn.
- The leftmost `turn0/converge0` pair is special: `turn0` solves first without a left contract, then `converge0` is generated afterward from the solved `turn0` left-port order.
- Summary/glyph `focus` / `ignore` conversation cards render the chosen keywords first without a dedicated `Keywords` header, then a compact `Target` section with the target context.
- Summary/glyph `elaborate` opens a confirmation popover with an editable `Preview` textarea, skips the keyword chooser, and is intended to deepen explanation around that one insight.
- `Elaborate` popovers/conversation cards render only a compact `Target` section; summary targets omit the full summary body, and column `focus` / `ignore` popovers/conversation cards render only a compact `Column` section.
- `create` dispatch semantics are single-plan only: it either joins the current running dispatch batch or creates one new single-plan dispatch batch.
- Only the latest unresolved dispatch batch is reorderable in storyline. Dragging one of its active plan areas immediately rewrites that batch's live `plan_ids` order for both chat and storyline; the top `max_concurrency` nonterminal plans in that new order become the active execution seats, and displaced running plans return to `pending` with `control_state='yield_requested'`.
- Pen-triggered `focus` / `ignore` / `elaborate` popovers are draggable from non-interactive blank space inside the card (not from keyword chips, text inputs, checkboxes, or action buttons) and stay clamped inside the storyline viewport after dragging. The blank-space `create` popover now uses the same blank-space drag and clamping behavior.
- After a user sends a composer chat message or successfully submits a steering action, chat auto-scrolls to the latest message.
- Hovering a summary-area background shows a lightweight summary preview card with `Source Task` plus summary text, and hovering an atomic glyph shows the atomic hover preview card regardless of whether a pen is active. Below `50%` zoom, hovering an active plan area shows a lightweight plan preview card containing only the first sentence of the plan text, and that plan hover card remains suppressed while a pen is active.
- Each converge may show full-width summary buttons derived only from `evaluation` / `mark_complete` entries via `dispatchTurnIndex`: stage-summary buttons sit above that converge's own current topmost indicator geometry, while final-summary buttons sit below that converge's lowest visible indicator geometry. Extension markers count as the highest/lowest references, and both placements preserve the same roomier clearance rule. Clicking one of these buttons first clears storyline selection, then focuses the matching chat summary card after `stickToBottom` is disabled so chat focus scrolling is not pulled back to bottom. Buttons keep hover/pressed styling but do not persist a highlighted state after click. Below `50%` zoom those buttons hide text and keep only color plus icon.
- `Plans Created` chat entries are collapsed by default. `thinking` chat entries are collapsed by default, keep the `x tool(s) invoked` summary visible even while collapsed, and show tool chips only after expansion. Dispatched analysis-plan cards for `completed` / `failed` / `terminated` plans collapse to a status-row-only header by default, expose a chevron for manual expansion/collapse, and still auto-expand when that plan or one of its summaries is selected unless the user explicitly re-collapses them. Raw machine-only JSON such as `{\"tool_names\": [...]}` remains hidden.

---

## 5) Notes

- Narrative citations use inline `[[n]]` placeholders; grouped placeholders such as `[[1,3]]` and adjacent groups such as `[[1]],[[2,7]]` are also supported.
- `respond_to_user` citations reuse the same summary/atomic storyline activation, focus/highlight, centering, and auto-scroll-suppression rules used by stage/final summary citations.
- Citation clicks update local selection and storyline focus only; they must not trigger delayed chat jumps while analysis is still streaming.
- Hovering a storyline atomic glyph shows an enlarged, non-interactive preview card.
- Clicking a storyline atomic glyph no longer pins an interactive storyline atomic card; the storyline atomic preview is hover-only.
- Current UI writes new column / summary / atomic `focus` and `ignore` messages, summary / atomic `elaborate` messages, and targetless `create` messages.
- Multi-column column steering is persisted as one aggregated `column` target rather than one message per column.
- Summary/glyph `focus` / `ignore` chat cards render selected keywords before the summary text or atomic text used as background context.
- The latest steering action wins per target. For summary/glyph targets that may now be `focus`, `ignore`, or `elaborate`; for column targets that remains `focus` or `ignore`.
- In pen mode, summary/glyph hover behavior remains identical to no-pen mode: no pen-only border highlight is added, while summary and atomic hover preview cards continue to render.
- Active plan storyline areas are temporary overlays derived from the latest unresolved dispatch batch and live in the real `dispatch_turn_index` turn, not in a synthetic extra turn.
- Active plan storyline placement must not perturb the already-solved summary/converge geometry of that turn; the frontend should place active plans into the remaining same-turn vertical space after the summary/converge solve has been finalized.
- Storyline active-plan areas reuse the dispatched-plan card styling, but in storyline they support click-again deselection, place `pause` / `resume` / `terminate` controls on the status row's right side while keeping them fully inside the card border, display only the first sentence of the plan text without the chat-only plan-id / `Open analysis stream` rows, treat English abbreviation periods such as `e.g.` / `i.e.` as non-terminal punctuation for that truncation, hide plan text below `50%` zoom, stop shrinking horizontally once the status row reaches its readable minimum width, and keep the visible card chrome tight to the rendered content height instead of stretching into unused whitespace.
- Appending new summary areas or active plan areas must not force storyline viewport recentering or zoom reset; these updates are incremental render-only changes. Automatic fit/recenter applies only to initial run/viewport-fit scenarios.
- Summary-area short labels must not use horizontal glyph compression. When title width is insufficient, storyline expands the summary area (and owning turn width) instead of squeezing title glyphs.
- Storyline boundary-window compaction may compress whitespace only; it must not violate existing summary-local / turn-level spacing, route-box clearance, converge indicator clearance, or the zoom-adaptive sizing rules already defined elsewhere in this contract.
- Workspace header shows a `Sub-agents` slider immediately to the left of the run-status pill whenever a run exists. It persists `RunSettings.max_concurrency` right away, clamps it to `1-6`, defaults to `2`, and only affects later dispatch / seat-fill decisions rather than preempting the current batch on its own.
- Clicking a directly user-created active plan area keeps the plan selection highlight and additionally highlights / scrolls chat to the corresponding `create` steering entry.
- Selecting a directly user-created summary area also highlights the corresponding `create` steering entry in chat without replacing the summary card's normal chat scroll target.
- The directly user-created active plan area and directly user-created summary area use the `create` accent border palette; downstream automatically derived follow-up work does not inherit that accent, and text color stays on the default non-create palette.
- Paused plans still count as active-plan overlays until resumed or terminated.
- Prompt composer uses `Enter` to submit, while `Shift+Enter` and `Ctrl+Enter` keep newline insertion in the textarea.
- Summarizer continues to use `sessions/{plan}.analysis.json` for chronological analysis context.
- Analyzer resumability uses `artifacts/sessions/{plan}.analysis.checkpoint.json`.
- `PlanItem` no longer includes legacy plan `depth` / motivation metadata in the wire contract; storyline and inspector ordering now rely on timestamps and lineage links instead.
