# AdaLens

AdaLens is an exploratory data analysis workspace with a Python runtime and a React/Vite frontend. The frontend provides the chat, storyline, and inspector experience; the backend runs the orchestrator/worker analysis loop and persists run artifacts under `backend/runs/`.

## Project Layout

- `backend/` contains the runtime, worker pipeline, Flask Run Gateway, persistence layer, and backend tests.
- `frontend/` contains the UI, development launcher/helpers, and frontend tests.
- `data/` contains sample datasets you can use to try the system.

See [backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md) for file-level pointers.

## Prerequisites

- Python 3.12
- Node.js 20+
- npm

## Setup

### Backend

```powershell
cd backend
python -m pip install -r requirements.txt
```

### Frontend

```powershell
cd frontend
npm install
```

## Run the System

From the frontend directory:

```powershell
cd frontend
npm run dev
```

This starts the backend Flask Run Gateway and the Vite app together. Open the local URL printed by Vite in your browser, then upload a CSV or use one of the sample datasets from `data/`.

## Helpful Commands

### Frontend

```powershell
cd frontend
npm run test
npm run build
```

### Backend

```powershell
cd backend
python -m pytest -q
python main.py
```
