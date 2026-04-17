# Frontend Workspace Constraints

## Authority

- `agentic framework/implementation.md` is the sole authoritative backend/runtime baseline.
- This file defines frontend workspace and gateway-facing constraints that derive from that baseline.
- `frontend/src/components/AGENTS.md` contains the detailed storyline-visualization rules.
- `frontend/docs/DATA_CONTRACT.md` documents the frontend-facing projection of the runtime contract.

## Scope

The frontend owns the interactive workspace experience across:

- chat and conversation replay
- storyline and summary/atomic visualization
- inspector and filtering surfaces
- local gateway adapters and runtime projections

This file is intentionally frontend-focused. It must not introduce an alternate backend/runtime contract.

## Frontend Responsibilities

The frontend must project the implementation baseline without redefining it:

- render run, turn, plan, finding, and artifact state from the canonical runtime objects
- keep intention-level steering separate from execution-level control in UI flows and adapter code
- preserve stable target snapshots for visible-element steering
- render worker findings as summary and atomic-insight structures grounded in runtime evidence
- keep frontend-only view models clearly downstream of canonical runtime data
- keep `components/` and `pages/` presentation logic stable; compatibility work should stay in gateway, API, store, and type projection layers

## Canonical UI-to-Runtime Mapping

The workspace should map user interactions to runtime inputs as follows:

- summary `focus` / `ignore` / `elaborate` -> `SteeringRequest`
- atomic `focus` / `ignore` / `elaborate` -> `SteeringRequest`
- column `focus` / `ignore` -> `SteeringRequest`
- blank-space create -> `ExecutionControlRequest(action='create')`
- plan controls -> `ExecutionControlRequest(action='launch' | 'pause' | 'terminate' | 'modify')`

Frontend copy may distinguish pending-versus-paused launch behavior for users, but adapters and docs must preserve `launch` as the canonical execution-control action.

## Workspace Behavior Constraints

The following frontend behaviors remain part of the workspace contract as long as they do not redefine backend/runtime semantics:

- The workspace keeps a chat-first analysis workflow with storyline, inspector, and run-history views.
- Storyline steering creation uses a compact top-right pen toolbar for `focus`, `ignore`, and `elaborate`.
- Summary/glyph `focus` and `ignore` may use keyword-priority UI and editable preview text, but those affordances must preserve the canonical steering target snapshot.
- Blank-space create remains a distinct execution-control flow rather than a steering-kind flow.
- Active plan areas render inside their real dispatch turns rather than inside a synthetic extra turn.
- Stage-synthesis and final-report projections may be bridged back into storyline converges when the frontend has the provenance needed to do so.
- `/api/runs/:runId/report` is currently a compatibility placeholder that returns a successful empty result; the UI may keep its existing affordances, but the backend runtime does not currently generate report artifacts through the new core loop.
- The frontend should continue consuming gateway-projected compatibility payloads; the backend runtime may use implementation-aligned internal state objects that are richer than the component-facing facade.

Detailed rendering, layout, and interaction requirements for storyline remain in `frontend/src/components/AGENTS.md`.

## Folder Guide

- `src/api/` holds gateway client code
- `src/components/` holds workspace UI, storyline, conversation, and inspector components
- `src/pages/` holds route-level pages
- `src/server/` holds the local Run Gateway implementation
- `src/store/` holds application state
- `src/types/` holds shared frontend-side types and adapters

## Documentation Discipline

- When frontend work needs a backend/runtime decision, use `agentic framework/implementation.md` as the source of truth.
- If this file needs to describe runtime-facing behavior, describe it using the canonical implementation vocabulary.
- If a change alters the backend/runtime contract, update the implementation supplement first and then synchronize the frontend projection docs.
