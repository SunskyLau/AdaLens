# Backend Overview

## Key Files

- `main.py` runs the backend directly against a dataset for local experimentation.
- `cli.py` is the command-line entrypoint used by the Run Gateway for start/resume flows.
- `run_gateway_flask.py` is the local HTTP/SSE Run Gateway used by `frontend/npm run dev`.
- `config.py` holds model names, runtime defaults, and shared backend configuration.
- `runtime_clock.py` provides runtime timestamp helpers.
- `utils.py` contains shared backend utilities such as streaming Python execution.

## Runtime Modules

- `framework/models.py` defines the canonical runtime state objects and compatibility projections.
- `framework/runtime_graph.py` implements the main signal-aware orchestrator loop.
- `framework/orchestrator_agent.py` contains the orchestrator prompt wrapper and context builder.
- `framework/worker_runtime.py` runs the analyzer/summarizer worker path and materializes findings.
- `framework/analyzer_agent.py` implements the local tool-driven analysis loop for one plan.
- `framework/summarizer_agent.py` converts one completed analysis stream into one `WorkerFinding`.
- `framework/persistence.py` owns run directories, events, artifacts, and checkpoint writes.
- `framework/master_agent.py` and `framework/sub_agent.py` are compatibility facades over the current runtime modules.

## Generated Output

- `runs/` stores run state, event logs, artifacts, and uploaded datasets created while the system is running.
