"""
Helpers for determining the current stage-summary coverage window.
"""

from __future__ import annotations

from typing import Any

from .models import DispatchBatchState, RunState


def _coerce_dispatch_turn_index(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _latest_final_summary_dispatch_turn_index(state: RunState) -> int | None:
    latest: int | None = None
    for turn in state.turns:
        for entry in turn.timeline:
            if entry.entry_type != "mark_complete" or not isinstance(entry.content, dict):
                continue
            result = entry.content.get("result")
            candidates: list[dict[str, Any]] = []
            if isinstance(result, dict):
                candidates.append(result)
            candidates.append(entry.content)
            for candidate in candidates:
                dispatch_turn_index = _coerce_dispatch_turn_index(
                    candidate.get("dispatch_turn_index")
                )
                if dispatch_turn_index is None:
                    continue
                latest = (
                    dispatch_turn_index
                    if latest is None
                    else max(latest, dispatch_turn_index)
                )
                break
    return latest


def latest_summary_boundary_dispatch_turn_index(state: RunState) -> int | None:
    latest_stage_summary = max(
        (
            batch.dispatch_turn_index
            for batch in state.master_agent_state.dispatch_batches
            if batch.stage_summary_emitted
        ),
        default=None,
    )
    latest_final_summary = _latest_final_summary_dispatch_turn_index(state)
    if latest_stage_summary is None:
        return latest_final_summary
    if latest_final_summary is None:
        return latest_stage_summary
    return max(latest_stage_summary, latest_final_summary)


def stage_summary_scope_batches(
    state: RunState,
    *,
    target_dispatch_turn_index: int | None = None,
) -> list[DispatchBatchState]:
    boundary_dispatch_turn_index = latest_summary_boundary_dispatch_turn_index(state)
    scope: list[DispatchBatchState] = []
    for batch in state.master_agent_state.dispatch_batches:
        dispatch_turn_index = batch.dispatch_turn_index
        if (
            boundary_dispatch_turn_index is not None
            and dispatch_turn_index <= boundary_dispatch_turn_index
        ):
            continue
        if (
            target_dispatch_turn_index is not None
            and dispatch_turn_index > target_dispatch_turn_index
        ):
            continue
        if batch.status != "waiting_for_stage_summary" or batch.stage_summary_emitted:
            continue
        scope.append(batch)
    return scope

