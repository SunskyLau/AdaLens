# Agentic EDA Frontend

The frontend is the workspace UI for steerable agentic EDA. It combines chat, storyline, inspector, and run-history views on top of the local Run Gateway.

## Highlights

- Chat-first analysis workflow with resumable runs and follow-up turns.
- Storyline view for summaries, atomic insights, active plan areas, and replayable steering history.
- Header-level `Sub-agents` concurrency slider with canonical `1-6` range, default `2`, and persistence to run settings.
- Top-left vertical storyline pen toolbar for `focus`, `ignore`, and `elaborate` steering.
- Column, summary, and atomic steering with summarizer-generated keywords for insight-targeted `focus` / `ignore`.
- Blank-space storyline `create` flow for injecting exactly one user-authored analysis plan into the current dispatch flow.
- Latest-batch active-plan drag reordering in storyline, with immediate seat rebalance inside that batch.
- Historical compatibility for replaying older `dive_into`, `cut_off`, and `suppress` steering messages.

## Steering UX

- New steering writes use canonical `focus`, `ignore`, `elaborate`, and `create`.
- Storyline steering creation lives in a persistent top-left vertical toolbar. The toolbar itself and all internal pen content are intentionally compact; the pen buttons still share one compact width sized for the pen labels and keep the icon/text content centered. With no active pen, the existing storyline selection and filter behavior remains unchanged. Clicking the active pen again, switching pens, switching runs, closing/canceling a steering popover, pressing `Esc`, or successfully confirming a pen request after it has been sent to the backend clears pen mode.
- With an active pen, column clicks stay steering-only, while summary-area and atomic-glyph clicks still keep their normal local selection/chat-link behavior and also open the steering UI.
- `focus` / `ignore` can target columns, summary areas, and atomic glyphs.
- Column pen hit areas include converge lanes, converge endpoint markers, converge indicators, boundary branches, and summary-internal tracks.
- Column `focus` / `ignore` uses persistent staged multi-select without `Ctrl`: the first click opens one confirmation popover, later clicks toggle columns in the staged set, the popover updates live, and confirmed requests store only `target.columns` in first-click order. New writes do not emit or rely on `target.column_name`; older runs may still contain it for passive read-compat only.
- Summary/glyph `focus` / `ignore` opens a keyword chooser that shows up to 10 summarizer-generated keywords, an editable `Preview` textarea, and a read-only `Background` block seeded from the summary/atomic text. The `Background` header shows an `Included` label beside the checkbox that controls whether that block is appended to `user_prompt`, defaulting to checked. Unchecked background blocks switch to an explicitly excluded visual style. The old free-form `Other` input is removed.
- Summary/glyph `focus` / `ignore` requests persist `selected_keywords` when stored keywords are available. In chat cards, the selected keywords render first without a separate `Keywords` header, followed by a compact `Target` section, and the expandable `Preview` block shows the user-visible `user_prompt` only.
- Older runs may not have summary/atomic `keywords`; the UI still allows summary/glyph `focus` / `ignore` through the `Preview` / `Background` flow without forcing keyword selection.
- The editable `Preview` has no blank lines and now follows a `generated prefix + preserved appended text` model: target/keyword changes keep auto-refreshing the generated prefix, while user-appended text is preserved across those refreshes. While that generated portion remains present, the auto-filled topic keywords, selected columns, and summary/atomic target text inside `Preview` render as colored bold text. For summary/glyph `focus` / `ignore`, generated preview templates now start directly with keyword-priority wording and do not include fixed lead-ins such as `请继续围绕该总结开展后续分析` / `Focus follow-up analysis on this summary`, `请继续围绕该原子洞察开展后续分析` / `Focus follow-up analysis on this atomic insight`, `请降低后续对该总结的分析优先级` / `Ignore future follow-up analysis on this summary`, or `请降低后续对该原子洞察的分析优先级` / `Ignore future follow-up analysis on this atomic insight`.
- User-authored appended text in `Preview` must remain stable across target/keyword/column refreshes; those refreshes may only replace the generated prefix portion.
- Converge indicator font sizing uses only each converge's immediate right-turn atomic counts: `0` stays at the minimum font size, nonzero counts interpolate up to the current maximum, and when all nonzero counts inside one converge are identical they all use the midpoint font size.
- `elaborate` only targets summary areas and atomic glyphs. It opens the same confirmation-style popover shell, does not support multi-select, and does not open the keyword chooser. Its meaning is to deepen explanation around that one insight, especially its root cause, without encouraging broad branching.
- `elaborate` cards render only a compact `Target` section; summary-target cards omit the full summary background, and column `focus` / `ignore` cards render only a `Column` section with the selected column names.
- In pen mode, valid column hover keeps the existing column-hover treatment. Pen activation does not change summary/glyph hover behavior: summary hover still shows the same lightweight summary preview card, and glyph hover still shows the same atomic hover preview card, with no extra pen-only border style.
- Hovering a summary area background opens a lightweight summary preview card containing only `Source Task` and the summary body. Below `50%` zoom, hovering an active plan area opens a lightweight plan preview card containing only the first sentence that is hidden in the card itself at that zoom level, and this plan-hover card remains suppressed while a pen is active.
- Pen-triggered `focus` / `ignore` / `elaborate` popovers can be dragged from non-interactive blank space inside the card (not from keyword chips, text inputs, checkboxes, or action buttons) and stay clamped inside the storyline viewport while dragging. The blank-space `create` popover is intentionally not draggable.
- Right-clicking blank storyline space opens a `create` popover with a free-form plan textarea plus `Create` / `Cancel`.
- Left-clicking blank storyline space without dragging clears the current storyline selection. Blank-space dragging keeps pan behavior and does not clear selection.
- `create` always creates exactly one plan; it joins the current running dispatch batch when one exists, otherwise it is dispatched once on its own.
- The `create` popover uses `Enter` to submit and `Shift+Enter` to insert a newline.
- `create` reuses the chat-side steering-action card style, but it has no storyline badge and no replay target.
- After a user sends a chat message from the composer or successfully submits a steering action, chat auto-scrolls to the latest message.
- Clicking a create-origin active plan area keeps the plan-selection highlight and also highlights / scrolls to the corresponding create steering message in chat.
- Selecting a directly user-created summary area also highlights the corresponding create steering message in chat while preserving the summary card's normal chat linkage.
- The directly user-created active plan area and directly user-created summary area use the create accent border styling, keep the default text color, and active running plan areas pulse more strongly at the border while executing. The minimap also shows color-coded active-plan points, and running plan points pulse there too.
- Only the latest unresolved dispatch batch is reorderable in storyline. Dragging a current-batch plan area rewrites that batch's live order immediately for both storyline and chat; the top `max_concurrency` nonterminal plans in the new order take the active execution seats, while displaced running plans return to `pending`.
- When new summary areas or active plan areas arrive, storyline keeps the current viewport (no forced re-centering/zoom reset); automatic fit is limited to initial run/viewport-fit scenarios.
- Stage and final summaries are bridged back onto storyline converges through `dispatchTurnIndex`: each converge may show full-width summary buttons derived from those entries, with stage-summary buttons above that converge's own topmost current indicator geometry and final-summary buttons below that converge's lowest visible indicator geometry, including extension markers when they are the highest/lowest reference. Both placements keep the same intentionally roomier clearance rule. Clicking a converge summary button first clears storyline selection, then focuses the matching chat summary card with `stickToBottom` disabled before the scroll so the focus jump is not pulled back; buttons keep hover/press emphasis only and do not stay highlighted after click. Below `50%` zoom those buttons hide text and keep only color plus a scaled-down icon so the button still fits within the converge width.
- Every new user-authored `chat`, `focus`, `ignore`, `elaborate`, or `create` input receives exactly one immediate runtime-generated `respond_to_user` acknowledgement before the master agent runs any other tool. Healthy-path acknowledgements now come from the dedicated fast LLM path using the full canonical user-authored message plus steering metadata, not from a truncated excerpt/template shortcut.
- After every backend stage summary or final summary, the master agent must immediately emit one separate concise `respond_to_user` message explaining why that summary is justified now and what follow-up analysis directions still make sense. If it cites summary/atomic evidence, chat renders those inline citations with the same superscript logic used by stage/final summaries, and those citations bind to the same storyline summary / atomic activation behavior.
- No other standalone progress-only `respond_to_user` messages are part of the expected backend behavior.
- Summarizer-produced summary text removes stock first-sentence lead-ins such as `The analysis reveals...` / `根据您的要求...` so the visible summary begins directly with the substantive conclusion.
- Summarizer normalization also treats CJK terminal punctuation (`。`, `！`, `？`) as sentence endings, so visible summary and atomic text should not contain mixed endings like `。.` / `！.` / `？.`.
- For older runs that already persisted mixed endings, gateway/client read normalization also sanitizes those legacy `。.` / `！.` / `？.` sequences before rendering.
- In chat, `Plans Created` is collapsed by default, `thinking` entries are collapsed by default while still showing the `x tool(s) invoked` count, and completed / failed / terminated dispatched-plan cards collapse to a status-row-only header by default with a chevron for manual expansion/collapse while still auto-expanding for the selected plan or selected summary unless the user explicitly re-collapses them; tool chips only appear after expansion. Pure machine-only JSON such as `{\"tool_names\": [...]}` is hidden as raw text.

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Backend available under `../backend`

### Install

```bash
cd frontend
npm install
```

### Development

Start both the Run Gateway and the Vite dev server:

```bash
npm run dev
```

Read cached model responses from a specific file under `backend/.cache/`:

```bash
npm run dev -- --llm-cache-read case-study-cache.json
```

Write newly generated cache entries into a specific file under `backend/.cache/`:

```bash
npm run dev -- --llm-cache-write recorded-cache.json
```

Read from one cache file and write misses into another:

```bash
npm run dev -- --llm-cache-read seed-cache.json --llm-cache-write replay-cache.json
```

Enable replay mode for `create_plans`:

```bash
npm run dev -- --replay
```

Enable stable LLM sampling controls for backend runs:

```bash
npm run dev -- --stable
```

Replay mode and stable mode can be enabled together:

```bash
npm run dev -- --replay --stable
```

Notes:

- `--llm-cache-read` and `--llm-cache-write` are parsed only at the project startup layer and are forwarded to backend Python processes through environment variables.
- `--replay` and `--stable` are also startup-layer flags; `--replay` affects the backend server process only, and `--stable` turns on stable backend sampling controls.
- Both flags also accept `--llm-cache-read=<file>` and `--llm-cache-write=<file>`.
- File names are resolved under `backend/.cache/`; passing no cache flags keeps the existing live-model behavior.
- If a file name omits `.json`, the launcher appends it automatically.

Endpoints:

- Run Gateway: `http://localhost:3001`
- Vite client: `http://localhost:5173`

### Build

```bash
npm run build
```

## Main Folders

```text
frontend/
  src/
    api/         API client for the Run Gateway
    components/  Workspace UI, storyline, conversation, inspector
    pages/       Route-level pages
    server/      Local Run Gateway implementation
    store/       Zustand application state
    types/       Shared frontend contracts
  docs/
    DATA_CONTRACT.md
```

## Gateway Endpoints

- `GET /api/runs`
- `POST /api/runs/start`
- `POST /api/runs/:runId/stop`
- `PATCH /api/runs/:runId/settings`
- `POST /api/runs/:runId/steer`
- `POST /api/runs/:runId/dispatch-batches/latest/reorder`
- `POST /api/runs/:runId/plans/:planId/control`
- `POST /api/runs/:runId/report`
- `GET /api/runs/:runId/state`
- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/events/stream`
- `GET /api/runs/:runId/artifact/*`

## Notes

- `/steer` accepts `chat`, `focus`, `ignore`, `elaborate`, and `create`, while still reading legacy aliases for older runs.
- `PATCH /api/runs/:runId/settings` persists `RunSettings.max_concurrency` immediately, clamps it to `1-6`, and the current UI defaults that setting to `2`.
- `POST /api/runs/:runId/plans/:planId/control` also respects that `max_concurrency` as a hard cap for `start` / `resume`: when all seats are occupied, the target plan stays non-running until a seat opens.
- Automatic pending backfill is terminal-event-driven: only `completed` / `failed` / `terminated` transitions trigger a seat-fill check for waiting `pending` siblings, and plain `paused` does not.
- `POST /api/runs/:runId/dispatch-batches/latest/reorder` only accepts a full reordered `plan_ids` list for the latest unresolved batch's nonterminal plans. The returned run state already includes the optimistic seat rebalance for that new order.
- `dispatch_plans.result.plan_ids` is the live full ordered batch membership, while `dispatch_plans.result.dispatched_plan_ids` is only the subset that actually started in that dispatch step.
- Paused runs are resumable and still accept `focus`, `ignore`, and `create`.
- Active plan areas render inside their real dispatch turn in storyline rather than in a synthetic extra turn.
- Summary-area short labels are never horizontally squished. If the current width cannot fit the short label, storyline expands the summary area (and owning turn width) instead of compressing title glyphs.
- Dataset preview and backend dataset loading both sniff common CSV delimiters (` , ; tab | `), persist the detected delimiter in shared dataset metadata, and reuse it for analyzer defaults when model-authored `pd.read_csv(DATASET_PATH)` code omits `sep`.
