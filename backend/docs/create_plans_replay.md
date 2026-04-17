# Create Plans Replay

`create_plans` supports a development-only replay mode that replaces model-authored
plan text with hardcoded values from `backend/cache.json`.

## Enable Replay

Start the frontend dev launcher with:

```bash
npm run dev -- --replay
```

The launcher forwards `AGENTIC_EDA_CREATE_PLANS_REPLAY=1` to the backend server
process only.

Direct backend CLI usage may also enable replay explicitly:

```bash
cd backend
python cli.py --dataset ../data/vgsales.csv --user-goal "Summarize the dataset." --replay
```

Replay can be combined with stable backend sampling controls:

```bash
npm run dev -- --replay --stable
```

## Cache File

Replay data lives in `backend/cache.json`.

The file uses a simple JSON object:

```json
{
  "1": ["plan A", "plan B"],
  "2": ["plan C"]
}
```

- Each key is the 1-based `create_plans` call index as a string.
- Each value is the full ordered list of `plan.text` values to create for that
  call.

## Call Index

The backend does not store a separate replay counter.

Instead, the implementation-aligned runtime counts how many historical timeline
entries already have `entry_type == "create_plans"` in persisted run timeline
state, then uses
`count + 1` as the current call index.

Because timeline entries are already persisted in run state, the same indexing
continues to work after resume.

## Fallback Behavior

Replay only changes `create_plans`.

The backend falls back to the original tool arguments when any of the following
is true:

- replay mode is not enabled
- `backend/cache.json` is missing
- the current call index is not present in the file
- the matching value is not a non-empty string array

When replay is enabled and the cache entry is valid, those cached strings become
the created `PlanItem.text` values for that `create_plans` call.
