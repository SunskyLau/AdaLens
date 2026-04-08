# AdaLens: Interactive Storyline for Monitoring and Steering Long-Running Agentic Data Analysis

AdaLens is an interactive system for understanding and directing long-running agentic data analysis. It combines a storyline-based representation that unifies analytical plans, execution progress, intermediate findings, atomic insights, supporting evidence, and data-column involvement with steering interactions grounded in those same analytical elements. The system is designed to help analysts monitor an evolving analysis, recover context after interruptions, inspect the evidence behind intermediate results, and intervene without terminating and restarting the run.

## What AdaLens Is

AdaLens studies interactive oversight in long-running agentic data analysis. In this setting, analysis unfolds over multiple steps, may branch into concurrent lines of inquiry, and produces a growing set of intermediate artifacts that are difficult to track through a chat-only interface. AdaLens addresses this challenge by externalizing the evolving analytical process as an interactive storyline and by supporting direct steering over ongoing work.

Rather than treating oversight as a sequence of isolated prompts, AdaLens preserves essential analytical artifacts throughout the run and keeps them inspectable in context. This allows analysts to move between high-level understanding of the overall process and detailed examination of specific plans, findings, and evidence while the run is still in progress.

## Core Capabilities

- Storyline-based monitoring of ongoing analysis, including plans, summaries, atomic insights, and data-column involvement across steps.
- Coordinated inspection across storyline, chat, and inspector views so analysts can move from high-level process awareness to detailed evidence.
- Structured preservation of analytical artifacts, including plan states, summary findings, code, plots, outputs, and textual reports.
- Intention-level steering through `Focus`, `Ignore`, and `Elaborate`, grounded in visible analytical elements.
- Execution-level control over plan threads through `Launch`, `Pause`, `Terminate`, `Modify`, and `Create`.
- Real-time monitoring and steering for long-running runs without requiring a full restart.

## System Overview

AdaLens is a web-based client-server system with a React-TS frontend and a Flask-based Python backend. The backend exposes execution and steering requests over HTTP and streams real-time events and generated artifacts to the interface via Server-Sent Events (SSE). The system is model-agnostic by design.

At the backend, AdaLens adopts an orchestrator-worker architecture. The orchestrator handles high-level reasoning over the analytical process: it creates and dispatches plans, evaluates progress, synthesizes findings, and determines how the run should proceed across analytical steps. Each worker executes one analytical plan and consists of two sequential components:

- An `analyzer`, which performs iterative reasoning and analysis under a ReAct-style workflow, including generating code, executing it, interpreting results, and reflecting on progress.
- A `summarizer`, which consolidates the process and outcomes of the plan into a structured finding hierarchy, including a summary and a set of atomic insights linked to concrete supporting evidence such as code, plots, and textual outputs.

These findings are returned to the orchestrator and incorporated into subsequent planning. In parallel, AdaLens preserves plans, summaries, atomic insights, reports, and supporting evidence so they remain inspectable throughout the run. Analyst interventions are captured at both the intention level and the execution level, enabling the analytical trajectory to adapt while work is still ongoing.

## Interface Overview

AdaLens organizes the ongoing analytical process into three coordinated views.

### Storyline View

The storyline view is the primary interface. It represents long-running agentic data analysis as an evolving narrative and integrates multiple analytical elements into one temporal workspace. It visualizes:

- Plan cards and summary cards as the backbone of the analysis storyline.
- Atomic insight glyphs as fine-grained findings nested under summaries.
- Data columns as recurring characters whose participation splits, converges, and continues across analytical steps.
- Report anchors for stage-level or final textual synthesis.

This view supports multi-granularity inspection, preserves analytical lineage, and helps analysts track how findings remain grounded in data over time.

### Chat View

The chat view presents the run as a chronological conversation history that records user messages, orchestrator responses, plan creation and dispatch, progress evaluation, finding synthesis, and generated reports. It functions as a structured process log rather than a simple chat transcript, allowing analysts to trace how the analysis progresses step by step.

### Inspector View

The inspector view supports detailed examination of the current selection. It includes a coverage-oriented overview of extracted findings and a detailed panel for inspecting plans, summaries, atomic insights, evidence, code, plots, and textual outputs. This helps analysts trace high-level conclusions back to the concrete artifacts from which they were derived.

## Steering Interactions

AdaLens supports two complementary forms of steering.

### Intention-Level Steering

- `Focus`: prioritize promising directions for continued analysis.
- `Ignore`: deprioritize directions that appear redundant, low-value, or misaligned with the evolving goal.
- `Elaborate`: deepen explanation around one selected summary or atomic insight, especially its mechanism, cause, or rationale.

These interactions are grounded in visible analytical elements and are incorporated into subsequent planning by the orchestrator.

### Execution-Level Control

- `Launch`: start a pending plan thread or resume a paused one immediately.
- `Pause`: suspend a running thread while preserving it for later continuation.
- `Terminate`: permanently stop a thread that is no longer worth pursuing.
- `Modify`: revise the formulation of an existing plan while keeping that direction available for relaunch.
- `Create`: add a user-authored plan thread for a direction not yet covered by the current set of plans.

These controls give analysts fine-grained regulation over ongoing plan threads without discarding the rest of the run.

## Repository Structure

```text
AdaLens/
|- backend/   # Python backend and agent runtime
|- data/      # Sample datasets for exploration
|- frontend/  # React-TS interface and local development gateway
`- README.md
```

Key locations:

- `backend/framework/`: orchestrator-worker runtime, analyzer, summarizer, steering logic, and storage.
- `frontend/src/components/`: storyline, conversation, and inspector interface components.
- `frontend/src/server/`: local gateway and HTTP/SSE endpoints for frontend development.
- `data/vgsales.csv` and `data/student-mat.csv`: bundled sample datasets.

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+
- npm
- Access to the model provider(s) you want to use

### 1. Install backend dependencies

```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### 2. Configure model access

Provide the required API credentials through environment variables or a local `.env` file at the repository root. The backend configuration currently reads keys such as:

- `OPENAI_API_KEY_vapi`
- `OPENAI_API_KEY_n1n`

Do not commit credential files or secrets.

### 3. Install and launch the web interface

```bash
cd frontend
npm install
npm run dev
```

This starts the local gateway and the frontend development server. By default, the interface is available at:

- `http://localhost:5173` for the client
- `http://localhost:3001` for the local gateway

### 4. Optional backend CLI smoke run

If you want to run the backend directly on a sample dataset:

```bash
cd backend
python cli.py --dataset ..\data\vgsales.csv --user-goal "Explore the dataset"
```

You can also run the default smoke entrypoint:

```bash
cd backend
python main.py
```

## Datasets and Outputs

The repository includes bundled sample datasets under `data/`, including:

- `data/vgsales.csv`
- `data/student-mat.csv`

During execution, AdaLens persists per-run state, event logs, steering records, control records, and generated artifacts under backend-managed run directories. At a high level, these run directories include:

- `state.json` for the current run snapshot
- `events.jsonl` for the event stream
- `artifacts/` for generated plots, outputs, and other run artifacts

This structure supports inspection, replay, and frontend synchronization throughout the run lifecycle.
