# AGENTS.md (Storyline Agent)

## Scope
Storyline agent owns the turn/converge timeline visualization in the main exploration UI.

## Interaction Contract
- X-axis only zoom and pan.
- Y-axis is fixed (no Y pan/zoom interaction).
- Zoom range is `1% - 700%`.
- Remove the former top overview/minimap card, keep bottom-right zoom badge, and place the `Insight Types` legend in that top rail slot.
- Hover on storyline thread shows column name tooltip.
- Hovering any column line segment or column indicator must show the same column-name tooltip.
- Hovering an atomic glyph must show an enlarged non-interactive atomic preview card with insight type, columns, text, and plot preview only, regardless of pen mode; do not show `interest` / `significance` / `impact` / `importance`, and do not show code/output evidence in that hover card.
- Clicking an atomic glyph must not pin or fix a storyline atomic card; the storyline atomic card is hover-only now.
- Clicking summary area selects summary; Inspector and chat must sync to that summary.
- Clicking an already selected summary area again must clear storyline selection.
- Storyline steering creation comes from a persistent smaller top-left vertical pen toolbar with `Focus`, `Ignore`, and `Elaborate`. The toolbar and all of its internal content should stay compact; pen buttons should still share one compact width sized for the pen labels and keep icon/text centered. Clicking the active pen again, switching pens, switching runs, closing/canceling a steering popover, pressing `Esc`, or successfully confirming a pen request after it has been sent to the backend must clear the current pen mode.
- With no active pen, storyline keeps its existing selection/filter interactions. With an active pen, column clicks remain steering-only, while summary-area and atomic-glyph clicks must still replay their normal local selection/chat-link behavior before opening steering.
- `Focus` / `Ignore` pens may target columns, summary areas, and atomic glyphs.
- Column pen hit areas include converge lanes, converge endpoint markers, converge indicators, boundary branches, and summary-internal tracks.
- Column `Focus` / `Ignore` must use persistent staged multi-select without `Ctrl`: the first click opens one confirmation popover, later clicks toggle columns in the staged set, and all staged columns keep the selected-column rendering until submission or cancellation.
- Column steering writes must use `target.columns` as the only authoritative column-group field. Do not emit or depend on `target.column_name` / anchor-column semantics; historical payloads may still contain `column_name`, but runtime behavior must ignore it.
- Summary/glyph `Focus` / `Ignore` must open a keyword chooser panel. The panel shows up to 10 pre-generated keywords from the target, always includes an editable `Preview` textarea, and for non-column targets also includes a read-only `Background` block seeded from the summary/atomic text plus an `Included` label with a checkbox that controls whether that background is appended to `user_prompt`. Unchecked background blocks must switch to an explicitly excluded visual style. Remove the old free-form `Other` input. If stored keywords exist, require at least one selected keyword before submission; older runs with no stored keywords must still allow submission through the `Preview` / `Background` flow. The resulting chat card shows the keyword line first with no separate `Keywords` subheading, then a compact `Target` section.
- The `Preview` textarea must normalize away blank lines and follow a `generated prefix + preserved appended text` refresh model: target/keyword changes keep auto-refreshing the generated prefix, while user-appended text is preserved across those refreshes and must not be rewritten by later auto-refreshes. While that generated portion remains present, the auto-filled topic keywords, selected columns, and summary/atomic target text inside `Preview` must render as colored bold text. For summary/glyph `Focus` / `Ignore`, generated preview templates should start directly with keyword-priority wording and must not include fixed lead-ins such as `请继续围绕该总结开展后续分析` / `Focus follow-up analysis on this summary`, `请继续围绕该原子洞察开展后续分析` / `Focus follow-up analysis on this atomic insight`, `请降低后续对该总结的分析优先级` / `Ignore future follow-up analysis on this summary`, or `请降低后续对该原子洞察的分析优先级` / `Ignore future follow-up analysis on this atomic insight`.
- Summary/glyph `Focus` / `Ignore` chat cards must show the selected/provided keywords before the summary text or atomic text used as background context.
- `Elaborate` may target summary areas and atomic glyphs only. It never targets columns, does not support multi-select, and must open the same confirmation-style popover shell without the keyword chooser. Its popover/chat body is a compact `Target` section only; summary targets omit the full summary body.
- Column `Focus` / `Ignore` popovers and chat cards must show only a compact `Column` section with the selected column names and no extra enclosing body frame.
- Pen activation must not change summary/glyph hover behavior: hovering a summary-area background still shows the same lightweight summary preview card, and hovering a glyph still shows the same atomic hover preview card, without pen-only border treatment.
- Hovering a summary-area background must show a lightweight summary preview card that contains only `Source Task` plus the summary body and matches the atomic-hover card language.
- With X zoom `< 50%`, hovering an active plan area must show a lightweight plan preview card that contains only the first sentence of the analysis plan text, but that plan-hover card stays suppressed while a pen is active.
- Pen-triggered `Focus` / `Ignore` / `Elaborate` popovers must be draggable from non-interactive blank space inside the card (not from keyword chips, text inputs, checkboxes, or action buttons) and remain clamped inside the current storyline viewport after dragging. Blank-space `create` popovers now follow the same blank-space drag and clamping rules.
- Right-clicking blank storyline space opens the `create` popover. Blank-space detection must exclude plan cards, minimap, legend, badges, menus/popovers, and every other existing interactive layer.
- Left-clicking blank storyline space without dragging must clear current selection. Blank-space drag must keep pan interaction and must not clear selection.
- The create popover textarea submits on plain `Enter` and keeps `Shift+Enter` for newline insertion.
- Clicking a steering chat entry with a target must reuse the exact same local target-activation logic as storyline left-click, without sending a new steering request and without opening the context menu.
- Clicking a steering chat entry must also keep that exact steering message visibly highlighted in chat.
- Clicking a create-origin chat entry must not attempt storyline replay because `create` has no target snapshot.
- Steering replay from chat must not trigger the chat panel's summary auto-scroll side effect; selection/filter-driven highlight may still update locally.
- Steering replay hit area is the steering card body only: title, action badge, and summary text replay together, while the `Preview` `<details>` block must stay outside that click target. That details block shows the user-visible `user_prompt` only; the hidden `system_prompt` must not appear in chat.
- Clicking an inline citation superscript inside a stage-summary card or final-summary card must reuse the exact same local target-activation logic as clicking the referenced summary or atomic insight directly.
- Clicking an inline citation superscript inside a stage-summary card or final-summary card must not trigger the chat panel's summary auto-scroll side effect.
- Citation parsing must tolerate adjacent and grouped markers such as `[[1]],[[2,7]]`; unmatched markers may degrade to plain superscript text but must not drop characters or punctuation.
- Citation rendering stays inline-only as superscript markers inside the narrative body; do not add a separate bibliography block below the card.
- Agent-response cards are frontend projections of `OrchestratorAction(type='emit_response')`; this document does not impose additional backend sequencing rules beyond `agentic framework/implementation.md`.
- Agent-response cards may carry inline citations, and those cards must reuse the exact same inline citation rendering and target-activation logic as stage/final synthesis or final-report cards.
- A stage-summary chat card still anchors to the latest covered `dispatchTurnIndex`, but its narrative scope may cover multiple still-unsummarized dispatch batches since the previous stage/final summary; UI copy and interactions must not imply it represents only one completed turn.
- Clicking a steering chat entry whose target carries a `summary_id`, and clicking a chat summary anchor, must horizontally center the owning storyline turn in the current viewport while preserving the current zoom level.
- Clicking an atomic citation must also horizontally center the parent summary's storyline turn in the current viewport, matching other chat-origin activations that carry that `summary_id`.
- Clicking a dispatched plan card in chat must horizontally center the corresponding active plan area in storyline while preserving the current zoom level.
- Clicking an active plan area in storyline must scroll chat to the matching dispatched plan card, and the selected chat card / storyline plan area must stay visually highlighted on both sides.
- Clicking a stage-summary or final-summary converge button in storyline must first clear storyline selection, then scroll/focus the corresponding chat summary card while `stickToBottom` is turned off before that focus scroll runs. This bridge is specific to emitted stage-synthesis and final-report conversation entries, not a generic conversation-entry focus system. Converge summary buttons keep hover/pressed emphasis only and must not stay highlighted after click.
- Create-origin active plan areas are the exception: they should still keep plan selection highlighted, but chat focus should additionally highlight and scroll to the corresponding dispatch entry when one exists; only older runs without that dispatch anchor may fall back to a historical create-origin entry.
- Selecting a directly user-created summary area should keep the normal summary-card chat scroll target and must not add an extra highlight bridge to a create-origin entry.
- Clicking an already selected active plan area again must clear storyline selection.
- Selecting a summary or glyph should keep local storyline/chat highlight behavior unchanged without relying on minimap point rendering.
- Selecting a summary in storyline must scroll chat to the matching summary entry and keep that entry visibly highlighted.
- Atomic selection id stays `summaryId::atomicId`.
- Clicking an already selected atomic insight again must clear storyline selection.
- As new summaries or active plan areas are appended during the same run, storyline must update incrementally without forcing viewport re-centering or zoom reset.
- The measurable storyline root container must remain mounted even in empty state so first-render measurement and initial auto-fit still work without refresh.

## Canonical Turn/Converge Model
- X axis is segmented as `converge0, turn0, converge1, ..., turnN-1, convergeN`.
- Turn boundaries are vertical dashed lines.
- Each turn corresponds to one dispatch loop and contains multiple summaries stacked vertically.
- Turn geometry is `left margin + summary area + right margin`, with equal left/right margins.
- Every summary area must remain horizontally centered inside its owning turn at every zoom level.
- Turn side margins around each summary area should remain visibly wider (larger horizontal buffer than previous baseline).
- Each summary area is gray and its height is derived from internal storyline content height plus small vertical padding.
- Each summary area reserves a dedicated single-line top title band for `short_label`; this title band is part of the area height budget rather than a paint-only overlay on top of internal tracks.
- The summary title-band fill must stay inset from the outer area border so selected/connected border highlights remain visually continuous.
- Inside each summary area, slot/interspace structure is preserved.
- Summary-local high-zoom behavior must remain X-dominant: above `100%` zoom, do not keep inflating summary-internal Y geometry or summary-area height just because X zoom increased; prefer widening the turn/area instead.
- Summary-local slot width must never compress so far that any slot-horizontal lane enters a glyph route-box interior; if nominal turn width is insufficient, expand the turn/area instead of further compressing the summary-local X mapping.
- Summary-local X safety must be computed from geometry-driven minimum slot widths and minimum interspace widths derived from route-box size and neighboring branch drift, not only from a single global slot-scale heuristic.
- If a turn widens beyond the summary-local preferred content width, the extra width should remain primarily as symmetric internal gutter / breathing room instead of uniformly stretching every slot and interspace.
- Inside each summary area, every adjacent pair of column lanes must satisfy the summary-local `d1` minimum gap, regardless of whether the lanes are involved or uninvolved.
- The leftmost and rightmost glyph route-box edges inside each summary area must keep a small inner padding from the area boundary at every zoom level.
- Both outer ends are interspace and outermost lane segments are horizontal.
- For every involved slot lane, routing must terminate on glyph route-box left/right borders (one endpoint per side).
- Converge lanes are the union of adjacent-turn columns.
- Boundary connections from converge to summary area use cubic Bezier split/merge curves.
- One-sided columns in converge use extension semantics (`solid stub + endpoint marker`), while isolated columns use a centered placeholder marker.

## Grouping and Replay
- Build `plan_id -> turnIndex` from `master_agent_tool_result(tool_name=dispatch_plans)` with `dispatched_plan_ids`.
- Prefer `dispatch_plans.result.plan_ids` as the live full batch order when it is present, and fall back to `dispatched_plan_ids` only for older runs that do not persist the full ordered membership.
- Create-origin UI must not fabricate a target-bearing steering card for `create`. When chat displays create history, it should anchor to the relevant dispatch or execution-control entry; older persisted runs may still contain historical create-origin cards for compatibility.
- If dispatch events are missing, fallback to adaptive time-gap grouping.
- Replay order prefers `insight_extracted` arrival order; fallback to timestamp order.
- Layout is incrementally stable: newly appended summaries/branches are solved without reordering historical solved history.

## Boundary Window Layout
- Boundary layout is incremental by adjacent window. Except for the leftmost special case, `turn_i` depends only on `converge_i`, and `converge_{i+1}` depends only on `turn_i`; there is no global reordering pass and no backward propagation beyond the immediately adjacent converge.
- Each normal ingress window `W_in(i) = (converge_i, turn_i)` runs local `ordering -> alignment -> compaction`.
- Ingress `ordering` treats the left converge lane order as the fixed source order. Summary blocks use constrained crossing reduction with barycenter-style weights, block-internal left ports inherit the left converge relative order, and new columns may be introduced only by backpatching the immediately left converge once.
- When ingress introduces a new column into the immediate left converge, insertion should still minimize crossings first, but ties should be broken by an alignment-style preferred Y inferred from already solved neighboring summary anchors so the new extension lane does not twist unnecessarily.
- Ingress `ordering` emits the summary-local left-boundary port order contract `leftPortColumnsInOrder`. Summary-local slot-0 order must honor that ordering contract instead of freely regenerating its own left boundary.
- For ordinary ingress windows, run `ordering` on `(converge_i, turn_i)` first, then solve each summary area internally with its own summary-local `ordering -> alignment -> compaction`, and only then run ingress-side stage-3 `alignment -> compaction` on the full ordered converge band against the solved summary-local left anchors.
- For ordinary ingress windows, summary-local left-boundary contracts are order-only (`leftPortColumnsInOrder`). Summary-local left-port `d1/d2` remain governed by the summary-internal solver and must not be back-driven by converge-lane target Y, min-gap, span, or other external spacing inputs.
- Each normal egress window `W_out(i) = (turn_i, converge_{i+1})` also runs local `ordering -> alignment -> compaction`. It must keep each already solved summary area's internal layout fixed, but it should still use that summary area's solved right-port Y geometry as the alignment reference when solving `converge_{i+1}`. Later turns must not modify the already solved `converge_{i+1}` ordering or target Y values.
- Egress/converge compaction must preserve already-legal large inter-cluster gaps discovered during alignment instead of squeezing them away under `d2` pressure.
- The leftmost window is special: solve `turn0` internally first without a left boundary contract, then derive `converge0` afterward from the solved left ports using first-occurrence column order scanned top-to-bottom across `turn0` summaries.
- All boundary-window stages must consume the current `createStorylineAdaptiveProfile(...)` result. Do not replace zoom-adaptive spacing, width, label, or stroke rules with fixed pixel constants inside the boundary solver.

## Y Optimization Rules
- Boundary-window `ordering` decides discrete summary / lane / port order first, `alignment` decides which adjacent ports or lanes should stay straight/short, and only then may continuous `compaction` move Y positions inside that fixed order.
- For ordinary ingress windows, summary preferred tops come from the ingress boundary contract when available; otherwise they fall back to the pre-distributed anchor-free turn stacking targets.
- For ordinary egress windows, `converge_{i+1}` lane targets come from the solved right-port Y signatures of `turn_i` summary areas. That egress alignment may move the right converge, but it must not reopen or reshape those already solved summary-local internals. Later turns may add their own ingress contracts, but they must not retroactively reorder or retarget older egress converges.
- When later ingress adds extension columns into an already solved converge, insertion may legally land above the old top lane, below the old bottom lane, or between existing lanes. After the insertion order is chosen, stage 3 must compact the whole merged converge order together (preserved lanes plus new lanes), using the already solved left turn as the alignment reference and keeping the resulting converge Y coordinates frozen before the right turn solve begins.
- Ordinary ingress stage-3 compaction must size converge-lane `d1` against the current converge indicator-clearance requirement for the whole band, not only against the inserted extension subset, so neighboring column labels do not collide.
- Once an ingress converge has been frozen by that stage-3 solve, later cleanup passes may only whole-band center it inside the visible storyline window; they must not locally re-solve or squeeze that ingress converge again.
- `turn0` is anchor-free on entry. Its fallback preferred tops must still be pre-distributed across available height instead of collapsing all summaries to one default top.
- Converge lane solve must satisfy dedicated spacing constraints (`d1` min gap, `d2` max gap), independent from summary-internal storyline d1/d2.
- Converge lanes must remain strictly non-overlapping at every zoom level (no identical Y for different lanes).
- Turn-level area placement uses constrained projection (or equivalent DP-class method) to keep areas in viewport while minimizing total L1 mismatch.
- Turn-internal area spacing must satisfy dedicated dynamic `d1/d2` constraints (independent from summary-internal `d1/d2`), and areas must never overlap at any zoom.
- Turn-area dynamic `d2` should be capped by the current turn's maximum summary title-band height plus area content padding, so taller title bands directly constrain same-turn summary stacking.
- Converge-lane compaction and turn-area compaction may move geometry only within the already chosen order; they must not change lane order, summary order, or boundary port order.
- Under high zoom, adjacent summary areas in the same turn should keep a visibly readable gap when vertical space allows; do not degrade into a hairline seam merely because the turn is anchor-free.
- Storyline vertical geometry must remain inside the current plot viewport bounds (no persistent overflow beyond the panel at any zoom).
- After all turn/converge local solves finish, each solved `turn_i` band and each solved `converge_i` band should be vertically centered as much as possible inside the current `[yUpperBoundPx, yLowerBoundPx]` window at every zoom level.
- Preserve incremental freeze for solved summaries/converges in layout coordinates; final centering must not arbitrarily recompute historical converge lane Y values during ordinary ingress. The only allowed ordinary-ingress change to an already solved converge is the explicit insertion-slot opening move described above, where whole upper/lower clusters shift by one `d1` around the chosen extension slot without reshaping the cluster internally.

## Rendering Rules
- No timestamp/tick text in storyline.
- Summary internals remain rendered at every zoom level, including `< 50%`.
- At zoom `< 50%`, hide all converge column indicators.
- At zoom `>= 50%`, column indicators are rendered only for:
- converges fully inside current viewport;
- Converge indicators show only column name; summary-area internal column-name indicators are not rendered.
- Storyline top-right legend is `Insight Types`; the dedicated `Columns` legend is removed.
- Indicator visual style uses embedded cutout mask in SVG (small mask blending into the lane), not floating badge cards.
- Indicator placement/rendering stays active from `50%` zoom upward with adaptive label sizing.
- Soft steering markers in storyline are icon-only; do not render text pills or reintroduce `Focus` / `Ignore` label badges on summary/glyph/column targets.
- Summary soft steering icons render on the summary-area top-right corner, with the icon-badge bottom-right corner touching the summary border's top-right outer corner and the badge lower edge flush with the border upper edge.
- Atomic soft steering icons render on the route-box top-right corner, with the icon-badge bottom-right corner touching the route-box border's top-right outer corner and the badge lower edge flush with the border upper edge.
- Column soft steering icons render on visible converge indicators only, positioned over the indicator mask border's top-right area. The strict summary/glyph flush-corner geometry does not apply to column icons.
- Do not render column soft steering icons on lane paths, branches, or any low-zoom substitute when indicators are hidden.
- Summary/glyph soft steering icons may now reflect the latest `focus`, `ignore`, or `elaborate` action on that target. Column soft steering icons remain limited to `focus` / `ignore`.
- Clicking a storyline soft steering badge must scroll chat to the latest steering message for that exact target and keep that steering message highlighted; badge clicks must not trigger the underlying storyline target click or context menu logic.
- Dynamic converge-width expansion is allowed only when indicators are visible (`>= 50%` zoom); below that threshold, converges should stay at their baseline zoom-scaled width instead of reserving hidden-label space.
- When dynamic converge-width expansion is active, estimate the extra width from the longest current column indicator label and keep that estimate tight rather than adding large fixed slack.
- Summary area title text must scale with the actual rendered area size: narrower / shorter areas shrink the title font, while wider areas may use a larger title font without overflowing the title band.
- Summary area short-label rendering must not use horizontal glyph compression (`lengthAdjust`/`textLength` squish). When the title would overflow, expand summary-area width (and therefore turn width) instead of squeezing glyphs.
- Summary and converge indicators use an enlarged baseline font size compared with the previous tuning, but their cutout masks should stay tightly fitted to text height rather than reverting to a tall fixed badge.
- Converge indicator font size is encoded per converge by counting atomic insights in that converge's immediate right-adjacent turn for each column lane: lanes with count `0` stay at the current baseline font size, nonzero lanes interpolate from baseline to baseline `+8px` using only the nonzero counts in that same converge, and if all nonzero counts are identical they all use the arithmetic midpoint font size instead of collapsing to min or max.
- `both` converge indicators must stay horizontally centered within their converge span; extension / isolated indicators must stay horizontally anchored on their endpoint marker or directly below it, collision handling may only move them vertically downward, and these marker-anchored indicators must never render dashed connectors. No indicator label may cover its own extension marker or another lane's extension marker; if marker-bound labels become too crowded, prefer increasing converge `d1` so no other lane passes between a marker and its label.
- Floating column indicators and their dashed connectors must stay inside the current plot viewport bounds; fallback placement must never send them above the plot top.
- Column indicator labels and dashed connectors must share the exact same plot-visible coordinate system as their final SVG render coordinates; render-time code must not apply a second asymmetric offset correction.
- If indicator fallback crowding reappears during zoom, prefer increasing turn/converge `d1` spacing before loosening zoom semantics or reintroducing oversized label masks.
- Hovering a column line or a column indicator must highlight both the full hovered column line rendering and the corresponding visible column indicator.
- Hovering any column line or column indicator must weaken every other non-hover column across converge lanes, connected boundary branches, and summary-area internal tracks using extension/uninvolved semantics; lines already in extension-style semantics remain unchanged.
- When Filter keeps a line segment/branch/lane visible, that kept rendering should use the same blue highlight language as hover by default.
- When a summary is selected, line highlighting is local-only: only the summary's own in-area tracks plus the nearest left/right converges and the truly connected left/right margin branches may receive summary-selection connectivity emphasis.
- When a summary is selected, any extension-mode converge lane and boundary branch reachable through that same selected-summary connectivity logic must also be promoted to the normal involved converge style instead of staying in extension gray.
- Summaries that share at least one dataset column with the actively selected summary must remain undimmed, even though summary-selection line highlighting does not propagate into their turns.
- Only summaries with no shared selected-summary columns should be visibly dimmed during summary selection.
- Hover highlight color for column lines/indicators must use `#0066cc`.
- At zoom `< 100%`, hover trigger range for column lines/indicators must be enlarged to be more sensitive.
- While hovering column lines/indicators, X-axis drag interaction must remain available.
- Converge extension markers render as: `right_extension` = filled start circle in the same uninvolved gray family as extension lines, `left_extension` = gray hollow terminate circle, `isolated` = centered light-gray placeholder circle.
- Converge indicator text color defaults by lane mode:
- `left_extension` indicator text uses the same light gray family as extension/uninvolved lines;
- `right_extension` indicator text keeps its existing accent color;
- `both` and `isolated` indicator text keep the default dark label color.
- If a converge lane is currently rendered in extension / uninvolved / dimmed semantics because of hover fading, filter dimming, or non-connected summary dimming, its indicator text must also switch to the same uninvolved gray.
- When a converge indicator is filtered out (`column` state `none` while filter is active), its cutout mask must still use the container background paint so it truly covers the lane underneath; only the text/connector should be faded.
- Converge extension lanes (`left_extension` / `right_extension` / `isolated`) and their connected boundary Bezier branches must use the same uninvolved color/width semantics as summary-internal uninvolved tracks.
- Only non-extension converge lanes (`both`) and their connected branches use involved width/color.
- Involved lines inside summary areas and non-fade-out converge lanes/connected branches should use an increased involved stroke width.
- Glyph diameter min/max are adaptive to current storyline window short side, with a larger baseline range than previous tuning.
- Adaptive glyph min/max map to current dataset's atomic insight `importance` minimum and maximum within the visible run.
- Glyph diameter uses linear mapping between current `importance_min` and `importance_max`; when new atomic insights arrive, this mapping range updates dynamically.
- At zoom `>= 50%`, glyph absolute diameter must remain unchanged across zoom levels.
- Selected glyph does not render an extra circular halo; selection emphasis relies on route-box styling.
- Selecting a glyph must highlight its connected column lines inside the same summary until reaching another glyph or a converge boundary.
- Selected glyph connected-column highlight color must match the selected glyph color.
- If the selected glyph column reaches a converge boundary without another glyph in between, highlight the corresponding boundary branch up to that converge boundary.
- Under active Filter, summary selection must still highlight the selected summary area and its glyphs, but it must not propagate summary-connectivity line highlighting.
- Under active Filter, atomic/glyph selection must still highlight the selected summary area and glyph, and only the directly connected in-area segments plus directly reached boundary branches may override filter-blue with the glyph-selected color.
- Render priority stays `hover > selected glyph direct connection > filter highlight > selected summary connectivity > default/dimmed`; selected summary connectivity line propagation is disabled while Filter is active.
- Route-box should stay tightly fitted to glyph in width (`glyph + small padding`) and only track glyph size changes.
- Route-box height follows width by default, but may increase only when needed to fit all column port spacing in vertical direction.
- Route-box minimum width/height must always remain larger than glyph diameter by a small fixed padding (`>= glyph + 4px`).
- Uninvolved summary-local tracks should stay just outside route-box shoulders with a dedicated route-box clearance; they must not be repelled by the full summary-local `d2` gap as if the entire route-box were a hard forbidden band.
- Route-box stroke width remains thin in normal state (`0.9`) but uses a stronger selected emphasis (`~1.8`) with higher opacity and subtle route-box tint fill.
- The top-rail `Insight Types` legend now occupies the former overview slot, uses larger label text/glyph marks, and should prefer a single row while allowing two rows when width is insufficient.
- Active plan areas must reuse the dispatched-plan card styling from chat, use player-style icon controls for plan-thread execution control, map those controls to canonical backend actions (`launch`, `pause`, `terminate`, `modify`), and stay inside the owning real turn's vertical packing solution instead of reserving a standalone synthetic turn.
- Active plan placement must not disturb already solved summary/converge geometry for the same turn; after the summary/converge solve is frozen, active plans should be packed into the remaining same-turn vertical space.
- Only active plan areas belonging to the latest unresolved dispatch batch may be drag-reordered. Dropping a current-batch plan area must immediately rewrite the live batch order for both storyline and chat, and the new top `max_concurrency` nonterminal plans become the active execution seats while displaced running plans return to `pending`.
- Active plan areas in `analyzing` / `summarizing` state must show a stronger pulsing border treatment that reads as currently executing.
- Each converge may render one or two full-width summary buttons derived from emitted stage-synthesis and final-report entries: the stage-summary band sits immediately above that converge's own current topmost indicator geometry, while the final-summary band sits immediately below that converge's own lowest visible indicator geometry. Extension markers count as the highest/lowest references, both bands keep the same roomier clearance rule, stage summary uses `Gauge`, final summary uses `CheckCheck`, and below `50%` zoom those buttons must hide text while keeping color plus a shrunken icon that still fits within the converge width.
- The directly user-created active plan area and directly user-created summary area should use the create accent border palette; downstream automatically derived sibling work should not inherit that accent, and the text itself should keep the default non-create font color.
- Active plan area control buttons, including their visible chrome, must remain fully inside the area border and sit on the right side of the status row rather than in a bottom action row.
- Active plan areas show only the first sentence of the plan text, but English abbreviation periods such as `e.g.` / `i.e.` do not count as the sentence boundary, and the storyline variant must not render the chat-only plan-id row or `Open analysis stream` copy.
- At zoom `< 50%`, active plan areas must hide all plan text and keep only the compact status row plus controls.
- Active plan areas must stop shrinking horizontally once the status badge and action buttons reach their readable in-card minimum spacing, even if X zoom continues decreasing.
- Active plan card chrome should hug the rendered content height; do not force the visible card border to stretch down into unused internal whitespace.
- The chat `Back to bottom` affordance keeps its existing floating visual treatment but must sit above the dataset-upload controls, and the composer uses `Enter` to send while `Shift+Enter` / `Ctrl+Enter` insert newlines. After a user sends chat input or successfully submits a steering action, chat should auto-scroll to the latest message.
- Workspace header UI outside storyline now includes a `Sub-agents` concurrency slider immediately to the left of the run-status pill; it is persisted right away, clamps to `1-6`, defaults to `2`, and only affects later dispatch / seat-fill decisions rather than preempting the current batch by itself.

## X Scaling Rule
- Keep dynamic X layout effective down to `1%` zoom (no early saturation around very small zoom).

## Modularity
- `StorylineGraph.tsx` should remain the stateful orchestration shell: store wiring, viewport state, hover/filter/selection coordination, and auto-fit triggers live there.
- `StorylineGraphScene.tsx` should remain render-only and own the SVG / DOM layer contract for summary areas, converges, branches, labels, minimap, and steering icons.
- `storylineGraphSelection.ts` owns hover/selection/filter highlight policy plus shared render constants used by the graph shell and scene.
- `storylineGraphViewport.ts` owns X-fit, minimap, world-bounds, vertical-centering, and visible-indicator viewport helpers.
- `storylineGraphLayout.ts` remains the public atomic-layout facade and shared export surface, including summary-local boundary contracts through `buildStorylineLayoutWithBoundaryContract(...)`; `storylineGraphLayoutConstants.ts` owns adaptive sizing constants/helpers, `storylineGraphLayoutOrder.ts` owns column ordering plus initial atomic-Y seeding, and `storylineGraphLayoutSolve.ts` owns slot-gap/alignment/projection solve internals including slot-0 target overrides from boundary contracts.
- `storylineBoundaryWindowLayout.ts` owns the local boundary `ordering -> alignment -> compaction` solver for ingress windows, egress windows, and the special initial `turn0/converge0` window.
- `storylineTurnConvergeLayout.ts` remains the only module that lifts atomic layout into turn/converge geometry, summary-area stacking, and boundary-branch/converge-lane assembly.
- Keep atomic glyph rendering component separate.
- Keep coverage-grid selection/data derivation reusable so Workspace Filter and any future coverage-based inspector modes do not duplicate row/column/cell toggle logic.

## Workspace Filter
- The Workspace right rail is split into a top filter panel and a bottom inspector panel under the shared right-column chrome, but the visible section title is shown only in the top header and uses the `Inspector` label; the lower header remains intentionally blank.
- Storyline filter has a single Workspace-local source of truth: the selected `(insightType, column)` cell set.
- `Insight Types` legend, coverage-grid row/column/cell clicks, and storyline column-line clicks must all read from and write to that same selected-cell set.
- Single-clicking a storyline column line performs an exclusive full-column toggle: if that column is currently unselected, replace the current selected-cell set with that column's full cell set; if that column is already selected or partial, clear only that column's cells.
- `Ctrl+single-click` on Windows/Linux and `Cmd+single-click` on macOS keeps the existing deterministic full-column group-toggle semantics; storyline clicks still operate on global dataset columns rather than summary-local or segment-local state.
- Grid and legend row/column group toggles keep deterministic alternating semantics: initial click selects all cells in the group, next click clears the group, then repeats, regardless of whether the current visible state is `partial`.
- Filter mode and glyph/summary click-selection are mutually exclusive: when filter becomes active, clear the current graph/chat selection; when filter is active and the user clicks a glyph or summary area, clear all filter cells first and then apply the click selection. Glyph selection still must not drive legend highlight.
- `partial` is a real state for legends, coverage-grid headers, and storyline column state; it must stay visually distinct from `all`.
- A single selected cell only keeps matched glyphs and the line parts directly connected to those glyphs; it must not auto-expand into the whole row or whole column.
- The coverage-grid `Count / Importance` color-mode control is Workspace-owned and rendered in the right-rail header, not inside the grid body.
- The coverage-grid legend row should read as `Count/Importance <min-value> gradient-bar <max-value>` using actual numeric endpoint values rather than literal percentage text.
- The coverage-grid top-left header cell is a `Clear All` button that resets all selected filter cells to the unselected state; do not revert it back to a static `Taxonomy` label.
- The coverage grid is transposed: header columns are insight-type glyphs only, while row headers are dataset column names with their involved atomic-insight counts.
- The coverage-grid row-header width should stay just large enough for the longer of `Clear All` and the longest dataset column name, with only a small fixed allowance for the count suffix.
- In Storyline rendering, unmatched minimap points, glyphs, route-boxes, summary areas with no matched glyphs, and non-kept column-line parts must use the existing dimming language.
- When Filter has any selected cells, Inspector must ignore Source Task / summary text and show the union of matched atomic insights derived from the unified storyline filter state.
- Filter-driven Inspector results must dedupe repeated atomics across cells, show the deduped atomic-entry count as the right-aligned `xx selected` text, and use a single icon button between the title and count to toggle ascending/descending `importance` ordering.

## Lean Test Policy
- Keep `storylineThreadRouting` core tests.
- Cover the `storylineGraphLayout.ts` facade together with its internal constants/solver split through retained storyline smoke tests; do not reintroduce standalone micro-tests for those helper files unless a regression cannot be expressed at the public layout API level.
- Maintain concise tests for:
1. turn grouping (dispatch mapping + fallback),
2. converge lane union/extension behavior,
3. incremental freeze invariants,
4. `<50%` internals-visible behavior with hidden indicators,
5. slot endpoint anchoring to route-box borders,
6. converge visibility gating for indicators,
7. low-zoom (`~1%`) dynamic X layout behavior,
8. high-zoom anchor-free first-turn summary-area spacing so `turn0` summaries keep a visible gap rather than collapsing into overlap or a near-zero seam, while summary-local high zoom does not re-inflate area height above its `100%` vertical baseline,
9. storyline single-click exclusive column filtering, `Ctrl/Cmd+single-click` deterministic column toggling, badge-to-chat steering replay focus, and filter/click-selection mutual exclusion,
10. converge indicator font/width scaling, including hidden-indicator zoom levels that must not expand converge width,
11. coverage-grid legend endpoint labels plus filter-mode Inspector count/sort-header behavior.
