# Backend Runtime Constraints

## Authority

- `agentic framework/implementation.md` is the sole normative backend/runtime specification.
- This file is a derivative backend summary for engineers working in `backend/`.
- Do not introduce alternate runtime vocabulary, alternate action sequencing, or UI-specific policy that conflicts with the implementation supplement.

## Core Architecture

The backend is organized as a long-running orchestrator/worker runtime:

- The main `LangGraph` stays in a persistent listening state and wakes when new steering, execution controls, or internal runtime signals arrive.
- The orchestrator is the global strategy controller.
- Workers execute local plan-thread analysis asynchronously through an Analyzer + Summarizer pipeline.
- Persistence stores run state, steering/control history, findings, artifacts, checkpoints, and timeline entries needed for recovery and replay.
- Runtime-facing prompt templates in the three agent files must stay text-identical to `agentic framework/implementation.md`; do not introduce alternate prompt copies or runtime extraction logic.
- Legacy helper modules that belonged to the old custom runtime or the removed embedding/model-cache paths should not be reintroduced.

## Main Runtime Loop

The canonical main-graph flow is:

1. `wait_for_steering_or_signal`
2. `orchestrator_deliberation`
3. `execute_orchestrator_action`
4. `finalize_run` for finalizing actions only

`wait_for_steering_or_signal` is the single listening entry point and absorbs:

- steering ingestion
- execution-control registration
- signal ingestion
- state refresh / resume
- pending-update materialization before the next orchestrator round
- wake-up classification for the next deliberation round

The runtime graph persists checkpoints through the configured `LangGraph` checkpointer rather than relying on an in-memory-only loop.

## Runtime Inputs

### Intention-Level Steering

`SteeringRequest` is the canonical persistent steering object.

- Canonical steering kinds: `focus`, `ignore`, `elaborate`
- Purpose: influence the orchestrator's next analytical step
- Typical targets: summary, atomic insight, or column
- Steering changes future planning/synthesis priorities; it does not immediately rewrite an already running worker objective

### Execution-Level Control

`ExecutionControlRequest` is the canonical thread-level control object.

- Canonical actions: `launch`, `pause`, `terminate`, `modify`, `create`
- `launch` starts a pending thread or resumes a paused thread
- `pause` requests a safe stop and checkpoint
- `terminate` applies immediately to pending/paused work and at the next safe boundary to active work
- `modify` pauses safely, revises the plan text, increments the revision, and returns the plan to a schedulable state
- `create` introduces a user-authored plan thread without rewriting the user's text into a synthetic target snapshot

### Signals

Signals are internal runtime wake-up events rather than user-authored objects.

Canonical examples:

- `worker_finding_ready`
- `worker_status_updated`
- `dispatch_ready`
- `post_stage_summary_review_ready`

Signals wake `wait_for_steering_or_signal` and trigger the next orchestrator round against refreshed persisted state.

## UI-to-Runtime Mapping

The canonical UI-to-runtime mapping is:

- summary `focus` / `ignore` / `elaborate` -> `SteeringRequest(target=summary)`
- atomic `focus` / `ignore` / `elaborate` -> `SteeringRequest(target=atomic)`
- column `focus` / `ignore` -> `SteeringRequest(target=column)`
- blank-space create -> `ExecutionControlRequest(action=create)` with raw `user_authored_text`
- plan card controls -> `ExecutionControlRequest(action=launch/pause/terminate/modify)` bound to a concrete plan thread

## Orchestrator Contract

The orchestrator is the only global decision-maker.

Configured model names live in `backend/config.py`, but concrete model IDs are deployment
configuration rather than part of the canonical runtime contract. Do not treat specific
provider/model selections as normative backend semantics in docs or tests.

It reads:

- refreshed `RunState`
- `SteeringState`
- `ExecutionControlState`
- active plans and worker availability
- accumulated findings
- the latest user-authored goal

It emits a structured `OrchestratorAction`.

Canonical action types:

- `wait`
- `create_plans`
- `dispatch_plans`
- `evaluate_progress`
- `emit_response`
- `emit_stage_synthesis`
- `emit_final_report`

Implementation rules that must stay aligned with the supplement:

- prefer waiting over redundant work when no new evidence, steering, or control change exists
- create concrete, complementary, non-duplicative plans
- prioritize explicit launch controls before ordinary dispatch
- treat `focus`, `ignore`, and `elaborate` according to the implementation prompt semantics
- treat worker findings, worker completion, scheduling events, and other wake-up conditions as signals for the next deliberation round
- use stage synthesis only when the current unsummarized evidence window supports a stable intermediate conclusion
- emit the final report only when the run is truly ready to finish and core conclusions are grounded in existing findings and evidence

Do not reintroduce alternate orchestrator output names such as `respond_to_user`, `mark_complete`, or other parallel action vocabularies in backend contract docs.

## Worker Contract

### Analyzer

The Analyzer is a local analyst for one plan thread.

- It reads one `PlanState`, runtime context, dataset schema, selected artifacts, prior findings, and recovery/checkpoint context.
- It operates as a tool-driven ReAct loop over `reflect_on_results`, `execute_code`, and `complete_analysis`.
- It must answer one plan as fully as practical with repeated evidence-producing steps.

### Summarizer

The Summarizer converts one completed analysis stream into one `WorkerFinding`.

- It emits exactly one `summary` and one `short_label`.
- Atomic insights must map to real dataset columns.
- Each atomic insight must link to concrete code, output, and plot evidence.
- Keywords must stay concise, deduped, and useful for later steering.
- User-visible language must align with the latest user-authored language.
- Importance, interest, significance, and impact scoring continue to use the retained canonical implementation in `backend/framework/importance.py`.

### Asynchronous Worker Path

Worker execution is asynchronous relative to the main graph.

- `dispatch_plans` submits work to workers and returns the main graph to listening mode.
- Worker control polling occurs across analysis and summarization boundaries.
- Safe pauses checkpoint the worker session and emit `worker_status_updated`.
- Persisted findings emit `worker_finding_ready` after materialization.
- Worker finding materialization must happen before finding-ready signals are emitted.

## Runtime State and Persistence

The runtime state model is anchored on the following canonical objects:

- `RunState`
- `TurnState`
- `PlanState`
- `DispatchBatchState`
- `WorkerSessionState`
- `SteeringState`
- `ExecutionControlState`
- `Insight`
- `AtomicInsight`
- `ArtifactRecord`
- `TimelineEntry`

Persistence responsibilities:

- store graph state snapshots, steering/control history, findings, artifacts, and timeline events
- support run-level resume for the orchestrator graph
- support worker-level resume for individual plan threads
- preserve the provenance required to reconstruct summaries and atomic insights

## Logical Module Boundaries

- `backend/framework/models.py` owns runtime objects, finding structures, and compatibility projections
- `backend/framework/master_agent.py` and `backend/framework/sub_agent.py` are the runtime entry facades that correspond to the implementation supplement's orchestrator/worker module boundaries
- `backend/framework/runtime_graph.py`, `backend/framework/worker_runtime.py`, and `backend/framework/orchestrator_agent.py` / `analyzer_agent.py` / `summarizer_agent.py` are the internal implementation-aligned modules used by those facades
- `backend/framework/persistence.py` owns filesystem persistence and exports the `RunStore` alias used by callers
- `backend/framework/importance.py` remains the canonical implementation of importance / interest / significance / impact scoring

## Documentation Discipline

- When backend/runtime semantics change, update `agentic framework/implementation.md` first.
- Keep this file aligned to the implementation supplement; it should summarize and reinforce that baseline, not compete with it.
