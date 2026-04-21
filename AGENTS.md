# Repository Guidelines

## Documentation Authority

- The sole authoritative backend/runtime specification is `agentic framework/implementation.md`.
- This file, `backend/AGENTS.md`, `frontend/AGENTS.md`, `frontend/src/components/AGENTS.md`, and `frontend/docs/DATA_CONTRACT.md` are derivative guidance documents.
- If any backend/runtime statement in another document conflicts with `agentic framework/implementation.md`, the implementation supplement wins.
- Frontend-only presentation rules may extend the docs, but they must not introduce a second backend/runtime contract.

## Project Structure & Module Organization

This repository is split into `backend/` and `frontend/`.

- `backend/main.py` and `backend/cli.py` are the main Python entry points.
- `backend/run_gateway_flask.py` is the local HTTP/SSE Run Gateway used by the frontend dev flow.
- `backend/framework/models.py` contains the shared runtime and projection models.
- `backend/framework/master_agent.py` and `backend/framework/sub_agent.py` are the backend runtime entry facades aligned to the implementation supplement.
- `backend/framework/runtime_graph.py`, `backend/framework/worker_runtime.py`, and `backend/framework/orchestrator_agent.py` / `analyzer_agent.py` / `summarizer_agent.py` are the internal implementation-aligned runtime modules behind those facades.
- `backend/framework/persistence.py` contains filesystem persistence and exports the `RunStore` alias used by callers.
- `backend/framework/importance.py` remains the canonical implementation for importance and related scoring metrics.
- `backend/test/` contains backend tests.
- `frontend/src/` contains the React/Vite workspace UI, organized into `components/`, `pages/`, `server/`, `store/`, `api/`, and `utils/`.
- `frontend/src/server/devLauncher.mjs` starts Vite together with the backend Flask Run Gateway for local development.
- `frontend/docs/` holds frontend-facing projections of runtime contracts.
- `data/` contains sample datasets.

## Build, Test, and Development Commands

- `cd backend; python main.py` runs the backend against `data/vgsales.csv`.
- `cd backend; python -m pytest -q` runs the backend test suite.
- `cd frontend; npm run dev` starts the Vite client and the local Run Gateway.
- `cd frontend; npm run build` type-checks and produces the production bundle.
- `cd frontend; npx tsx --test src/**/*.test.ts src/**/*.test.tsx` runs the frontend tests.

## Coding Style & Naming Conventions

- Use 4 spaces in Python and preserve type hints where modules already use them.
- Keep backend modules focused around the runtime boundaries in `backend/framework/`.
- Use TypeScript with strict settings, single quotes, and semicolons in the frontend.
- Use `PascalCase` for React components and `camelCase` for helpers/utilities.
- Prefer the `@/` alias for frontend imports from `src/`.

## Testing Guidelines

- Add or update tests with every behavior change.
- Backend tests use `pytest` discovery with `backend/test/test_*.py`.
- Frontend tests use Node's test runner via `tsx`; keep tests close to the code they verify.
- Favor focused tests around runtime contracts, gateway projections, storyline layout helpers, and store behavior.

## Runtime Baseline Summary

The runtime model in `agentic framework/implementation.md` is the canonical product baseline for backend-facing semantics:

- The main graph is a signal-aware control loop with `wait_for_steering_or_signal`, `orchestrator_deliberation`, `execute_orchestrator_action`, and `finalize_run`.
- Runtime inputs are split into intention-level steering and execution-level control.
- `SteeringRequest` covers `focus`, `ignore`, and `elaborate`.
- `ExecutionControlRequest` covers `launch`, `pause`, `terminate`, `modify`, and `create`.
- `create` is an execution-control action that introduces a user-authored plan thread without rewriting the user's text into a synthetic target snapshot.
- The orchestrator emits `OrchestratorAction` values whose canonical action types are `wait`, `create_plans`, `dispatch_plans`, `evaluate_progress`, `emit_response`, `emit_stage_synthesis`, and `emit_final_report`.
- Worker execution is asynchronous relative to the main graph and re-enters the runtime through signals such as `worker_finding_ready`, `worker_status_updated`, and `dispatch_ready`.
- `WorkerFinding` and its atomic insights must be grounded in concrete code, output, and plot evidence before they are treated as stable findings.
- Stage synthesis is justified by the current unsummarized evidence window being stable enough for intermediate synthesis, not by an alternate product-specific rule set.

## Agent-Specific Notes

- Check `backend/AGENTS.md` before editing backend runtime behavior or runtime-facing prompts.
- Check `frontend/AGENTS.md` before editing frontend workspace behavior or gateway-facing projections.
- Check `frontend/src/components/AGENTS.md` before editing storyline visualization behavior.
- Frontend component and page behavior should remain stable; compatibility work belongs in gateway/types/store/api layers rather than UI presentation logic.

## Commit & Pull Request Guidelines

- Use imperative Conventional Commit messages such as `feat(scope): ...` or `fix(scope): ...`.
- Describe user-visible changes in pull requests, list verification commands, and include screenshots or recordings for UI changes when useful.
- If runtime contracts or sequencing semantics change, update the implementation supplement first and then synchronize the derivative docs in the same change.
