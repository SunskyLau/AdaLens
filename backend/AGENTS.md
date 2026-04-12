# Steering Constraints

This backend implements four steering semantics:

- `focus`: continue investing attention around a selected target and prefer drill-down, validation, comparison, explanation, and expansion around that target.
- `ignore`: semantically stop pursuing a selected target or column direction in subsequent planning. This does not pause the run itself and does not cancel work that is already running.
- `elaborate`: keep investigating one specific summary or atomic insight, with emphasis on root causes and explanation of that insight itself.
- `create`: inject exactly one user-authored analysis plan into the current round. The backend must keep the user text verbatim rather than rewriting it through the LLM.

Canonical protocol names:

- `focus`
- `ignore`
- `elaborate`
- `create`

Legacy compatibility:

- historical `dive_into` inputs must be normalized to `focus`
- historical `cut_off` inputs must be normalized to `ignore`
- historical `suppress` inputs must be normalized to `ignore`
- new writes and new returned messages must use the canonical names above

## Prompt Engineering Rules

- `focus` / `ignore` / `elaborate` must first convert the selected target into contextualized text.
- Do not steer from a bare object id alone.
- The contextualized steer should include the target kind, label, relevant text, and related columns.
- `summary` targets should use summary label, summary text, summary columns, and any persisted summary keywords when available.
- `atomic` targets should use atomic text, insight type, parent summary context, atomic columns, and any persisted atomic keywords when available.
- Summary/glyph `focus` / `ignore` must treat `selected_keywords` as the user-prioritized focus handles and preserve them as structured data. Their visible `user_prompt` should foreground the selected keywords and clearly distinguish `summary` vs `atomic insight`, while the summary / atomic text is carried through a read-only background section that may be optionally appended to `user_prompt`, and the hidden `system_prompt` carries the richer steering constraints. In the frontend `Preview`, the generated topic/column/summary/atomic snippets inside that generated portion render as colored bold text. For summary/glyph `focus` / `ignore`, generated preview templates should start directly with keyword-priority wording and should not include fixed lead-ins such as `请继续围绕该总结开展后续分析` / `Focus follow-up analysis on this summary`, `请继续围绕该原子洞察开展后续分析` / `Focus follow-up analysis on this atomic insight`, `请降低后续对该总结的分析优先级` / `Ignore future follow-up analysis on this summary`, or `请降低后续对该原子洞察的分析优先级` / `Ignore future follow-up analysis on this atomic insight`.
- `elaborate` must only accept `summary` or `atomic` targets. Its visible `user_prompt` should clearly frame the request as a deeper explanation/root-cause investigation of that one insight, distinguishing `summary` vs `atomic insight`, while the hidden `system_prompt` keeps the tighter anti-branching semantics. This is a prompt/context constraint only, not a hard post-processing cap.
- `column` targets should use the full authoritative `columns` group plus any deduped summary overview across that full set.
- Multi-column `column` steering should preserve the staged first-click order in `target.columns` while deduping any summary overview across the full column set.
- New writes must not emit or depend on `target.column_name` / anchor-column semantics. Older payloads may still contain `column_name`; backend code may read that field only as passive compatibility input when rebuilding `columns`.
- Current UI creates column, summary, and atomic `focus` / `ignore` actions; it also creates summary/atomic `elaborate` actions. Column `focus` / `ignore` and summary/atomic `elaborate` are confirmed in the frontend before the request is sent, and a successfully confirmed pen submission clears the active pen there. `create` remains targetless. Pen-triggered steering popovers are draggable from non-interactive blank card space (not from chips/inputs/buttons) and stay viewport-clamped, and chat auto-scrolls to the latest message after user chat sends or successful steering submissions.
- Storyline viewport behavior is incremental: appending new summary/plan areas must not force re-centering or zoom reset; automatic fit is reserved for initial run/viewport-fit scenarios.
- `create` must not synthesize a target snapshot and must not generate a rewritten prompt. Its `target` stays `null`, `display_text` stays the raw user plan text, `user_prompt` / `system_prompt` stay unset, and `generated_prompt` stays empty only as a compatibility field.
- Summary and atomic `keywords` are summarizer-generated metadata. They should be deduped, trimmed, capped at 10 items, and persisted as empty arrays when the summarizer does not return them.
- Every new user-authored `chat`, `focus`, `ignore`, `elaborate`, or `create` input must trigger exactly one immediate runtime-generated `respond_to_user` acknowledgement before the master agent runs any other tool. That one-time acknowledgement must be removed from the pending queue once emitted. Healthy-path acknowledgements must come from the dedicated fast LLM path using the full canonical user-authored message plus steering metadata, not from a truncated excerpt/template shortcut.
- Every dispatch batch must emit exactly one separate `respond_to_user` when that batch first becomes fully terminal (`completed`, `failed`, or `terminated` for every plan in the batch), even if the backend decides not to emit a stage summary for that batch.
- Every `evaluate_progress` or `mark_complete` tool call must still be followed immediately by one separate `respond_to_user` tool call. That response must stay concise, briefly explain why the stage/final summary is justified now, mention what analysis directions still make sense next, and stay in the language of the latest user-authored request/steer/create message; when it cites summary or atomic evidence, it should reuse the same inline citation logic as the summary itself. If the model omits it, leaves it blank, or replies in the wrong language, backend post-processing must inject a fallback.
- No other standalone progress-update `respond_to_user` calls are valid backend runtime behavior beyond: immediate acknowledgement for each new user-authored input, one batch-finished reply per dispatch batch, and the required post-summary / post-completion reply.
- All agent system prompts must match natural-language output to the language of the latest user-authored request, steer, or create message, while keeping tool names, JSON keys, schema fields, and other protocol tokens in English.
- Stage-summary coverage is a contiguous unsummarized window, not a single-batch snapshot: when `evaluate_progress` fires, it must summarize every retained finding from all `waiting_for_stage_summary` dispatch batches after the latest prior stage-summary or final-summary boundary, while still attaching the emitted stage-summary card to the latest covered `dispatch_turn_index`.
- Dataset loading must tolerate common CSV delimiters beyond commas, including semicolons, tabs, and pipes; the detected delimiter should be persisted in shared dataset metadata and reused by analyzer runtime defaults.
- Summarizer output must not open with meta lead-in sentences such as `The analysis reveals...`, `Analysis of ... reveals...`, `关于……的分析已经完成`, or `根据您的要求...`; prompt instructions and post-normalization should both strip those templates so the saved summary starts directly from a substantive conclusion.
- Summarizer post-normalization must treat CJK terminal punctuation (`。`, `！`, `？`) as sentence endings. Saved `summary` and `atomic_insights[].text` must not append a trailing English period after those punctuation marks (no `。.` / `！.` / `？.`).
- Legacy runs may already contain persisted mixed endings (`。.` / `！.` / `？.`); gateway/frontend read normalization should sanitize those historical strings for display compatibility without requiring in-place run-file migration.

## Runtime Semantics

- `focus` means continue allocating attention and drilling down around the target.
- `ignore` means stop pursuing that direction in future planning, expansion, comparison, validation, and explanation unless the user explicitly reopens it or there is no viable alternative path to answer the main goal.
- `elaborate` means continue investigating one specific summary or atomic insight, especially by explaining the mechanism, cause, or reason behind that insight.
- `create` means immediately create one user-authored `PlanItem` without rewriting the user text.
- If a turn is already running, `create` joins that current turn.
- If the latest dispatch batch still has any nonterminal plan (`pending`, `analyzing`, `summarizing`, or `paused`), the new user-created plan must join that unresolved batch instead of opening a second dispatch batch.
- If that unresolved batch still has free execution capacity, the new user-created plan should launch directly without resuming or otherwise disturbing older paused/pending siblings in that batch.
- If that unresolved batch is already at the concurrency cap, the new user-created plan remains `pending` inside that batch until a seat opens.
- Only when every existing dispatch batch is already fully terminal (`completed`, `failed`, or `terminated`) should the new user-created plan open and dispatch a brand-new batch of its own.
- If no runnable turn exists because the run is `paused`, `idle`, or `completed`, `create` must reopen or start a runnable turn and that new user-created turn should initially contain only that one plan.
- A `create` plan must not be duplicated later by automatic fallback planning when the turn goal text matches the user-authored plan text.
- Automatic `create_plans` must still reject reused text once the run already has plans: do not create a plan whose text matches any existing plan text, and do not satisfy non-chat steering by reusing the current turn goal or prior user-authored message text. The generic current-goal fallback path is allowed only for ordinary `chat` steering; once a chat message has already been acknowledged as a probable stop/finish request, runtime must not reopen generic planning from that message.
- If steering actions conflict, the latest action wins.
- `focus` / `ignore` / `elaborate` / `create` do not cancel sub-agents that are already running.
- Explicit stop/finish-intent `chat` messages are handled through the fast acknowledgement model path, which must return both an acknowledgement message and an internal `probable_stop` routing signal. After a chat is marked `probable_stop`, runtime should stop pending/paused work from starting, let already-running work finish naturally, skip post-steer follow-up-plan requirements, keep the normal batch-finished reply contract, and filter out any model- or fallback-proposed `evaluate_progress`, `synthesize_findings`, or ordinary `mark_complete` while stop-completion is pending. Once all current work is terminal, only one internal stop-completion `mark_complete` final summary for the full run may proceed, without emitting `evaluate_progress`.
- Stage summaries may only be considered after every current plan in the run is already terminal. A single finished dispatch batch is never enough while any other plan remains `pending`, `analyzing`, `summarizing`, or `paused`.
- Non-`create` steering follow-up work must produce real post-steer planning rather than turning `user_prompt` into a synthetic plan text. Backend runtime logic must block `evaluate_progress`, `synthesize_findings`, and `mark_complete` until at least one real post-steer `create_plans` has happened, and if that real follow-up work leaves plans `pending`, it must dispatch them before allowing those summary/completion tools.
- `dispatch_plans` must now return both `plan_ids` for the full ordered batch membership and `dispatched_plan_ids` for the subset actually launched in that dispatch step.
- A plan-level `terminate_requested` must still resolve promptly even if the sub-agent is already in summarizing; summarizer-phase control polling must prevent that plan from remaining stuck forever after sibling plans finish.
- `mark_complete` results must carry the latest relevant `dispatch_turn_index` so the frontend can bind the final summary back onto the converge that follows that dispatch turn.
- Runtime control changes are append-only in `runs/{run_id}/runtime_controls.jsonl`; at minimum the backend must log `update_settings` and `reorder_latest_batch`.

## Implementation Note

- This file is a repository constraint document.
- Runtime behavior must be enforced through backend prompt/context construction and steering-processing code rather than by reading this file directly at runtime.

## Plan Control Runtime Notes

- Backend run state now treats `paused` as a first-class resumable status alongside `running` / `idle` / `completed`.
- Plan items may move through `pending`, `analyzing`, `summarizing`, `paused`, `terminated`, `completed`, `failed`, and `skipped`, with `control_state` carrying `none`, `pause_requested`, `terminate_requested`, or `yield_requested`.
- Plan-level control requests are persisted in `runs/{run_id}/plan_controls.jsonl`; analyzer checkpoints live under `runs/{run_id}/artifacts/sessions/`.
- Gateway-side `resume` handling must ensure a paused run process exists before appending the control request when the current gateway is not already hosting that run, otherwise a freshly resumed process can miss the request on startup.
- Plan-level `start` / `resume` requests must obey `RunSettings.max_concurrency` as a hard cap. If execution seats are full, the request can still reorder the latest unresolved dispatch batch, but it must not launch extra analyzing/summarizing work until capacity opens.
- Automatic pending backfill is terminal-event-driven: only `completed` / `failed` / `terminated` transitions may trigger a seat-fill scan for waiting `pending` siblings, and that scan must still respect free execution capacity. A plain `paused` transition must never trigger that search by itself.
- The master agent must stay in the current dispatch batch when it is blocked by already-paused members and waiting `pending` siblings; it should wait for terminal seat-fill or explicit control instead of letting fallback dispatch those pending plans on its own.
- A newly created user plan must still be able to escape an old paused dispatch-batch wait state; paused waiting must not starve new pending user-authored plans forever.
- `backend/framework/sub_agent.py` keeps its existing auth-check -> temporary `RunState` -> analyzer -> summarizer -> `SubAgentResult` mainline. Control/resume support and steering changes must wrap that flow instead of deleting or rewriting it.
- Current-batch reordering is immediately effective only for the latest unresolved dispatch batch. When that batch order changes, the top `max_concurrency` nonterminal plans become the new execution seats, displaced running plans must checkpoint and return `SubAgentResult.control_action='yield'`, and the master agent must translate that into `pending` plus `control_state='yield_requested'` without losing checkpoint / resume-phase data.
- Legacy plan `depth` / motivation metadata and the standalone backend trace sidecar have been removed from the runtime contract.
- Any change to runtime sequencing, dispatch-batch membership, `create steering`, or `respond_to_user` legality must update this document and the matching automated tests in the same change.
