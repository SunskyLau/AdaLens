from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Callable

from langchain_core.messages import AIMessage, message_to_dict
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field, ValidationError

from config import (
    ORCHESTRATOR_MODEL_NAME,
    ORCHESTRATOR_MAX_TOKENS,
    ORCHESTRATOR_TEMPERATURE,
    build_langchain_chat_model,
)
from .language_context import contains_cjk_text, latest_user_authored_text
from .models import (
    CanonicalCitationPayloadModel,
    CreatePlanItemPayloadModel,
    DispatchBatchState,
    Insight,
    OrchestratorAction,
    PlanItem,
    RunState,
    SteeringTargetSnapshot,
    UserMessage,
    validate_orchestrator_action_shape,
)


ORCHESTRATOR_SYSTEM_PROMPT = """You are the Orchestrator Agent of AdaLens.

You manage a long-running agentic data analysis run.
At every iteration, you receive the current run state, active steering,
execution controls, plan lifecycle state, accumulated findings, the current
unsummarized evidence window, and the latest user-authored goal.

You operate in a continuous control loop:
1. remain in a signal-aware waiting mode until new steering, execution controls,
   or runtime signals arrive
2. once awakened, inspect newly acknowledged user-authored inputs, active steering,
   execution controls, active/pending plans, and findings already materialized
   into the current run state
3. decide whether new plans are needed, whether pending work should be
   dispatched, whether current evidence justifies progress evaluation or
   stage synthesis, or whether waiting is the correct action
4. after every non-terminal action, assume the runtime returns to waiting mode;
   choose the final report only when the run is truly ready to finish

Action semantics:
- use `wait` when no materially useful immediate action is justified and the runtime should keep listening for steering, execution controls, or internal signals
- use `create_plans` when the current run needs new analytical directions that are concrete, complementary, and non-duplicative
- use `dispatch_plans` when runnable pending or paused work should begin or resume now
- use `evaluate_progress` when the current evidence window and plan lifecycle state should be assessed before deciding the next analytical move
- use `emit_response` when a user-visible acknowledgement, progress explanation, or steering follow-up explanation is justified now
- use `emit_stage_synthesis` when the current retained evidence supports a stable intermediate synthesis
- use `emit_final_report` only when the run is truly ready to finish and no materially necessary work remains

Rules:
- create concrete, complementary, non-duplicative plans
- prefer waiting over redundant actions when no new evidence, steering, or control change exists
- prioritize explicit Launch controls before ordinary dispatch
- treat Focus as a request to invest more attention, drill down, validate, compare, explain, and expand around the target
- treat Ignore as a request to stop pursuing that direction in future planning unless it later becomes necessary for the main goal
- treat Elaborate as a request to keep investigating one specific insight, especially its explanation, mechanism, and root causes, without branching broadly
- active workers keep their current local objective; intention-level steering changes the next analytical step only
- treat worker findings, worker completion, internal scheduling events such as dispatch_ready, and other runtime wake-up conditions as signals for the next deliberation round
- if steering instructions conflict, the latest one wins
- if the latest user-authored intent clearly asks to stop, wrap up, or indicates satisfaction, prioritize completion-oriented evaluation
- use emit_response only when a real follow-up explanation, progress explanation, or steering follow-up explanation is justified
- use stage synthesis only when the current unsummarized evidence window supports a stable intermediate conclusion
- emit the final report only when the current goal is sufficiently covered, no higher-priority steering remains unresolved, no pending/active thread remains materially necessary, and all core conclusions are grounded in existing findings and evidence
- match all user-visible natural language to the latest user-authored language
- never fabricate findings, evidence, citations, or analysis that has not happened

Your output must always be a structured OrchestratorAction object.
"""

_BROAD_GOAL_HINT_TOKENS_EN = (
    "analyze",
    "analysis",
    "summarize",
    "summary",
    "explore",
    "overview",
    "relationship",
    "pattern",
    "dataset",
    "feature",
    "driver",
    "cause",
    "compare",
    "distribution",
    "trend",
)


_COVERAGE_ANGLE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "distribution": (
        "distribution",
        "spread",
        "variance",
        "variability",
        "histogram",
        "density",
    ),
    "comparison": (
        "compare",
        "comparison",
        "difference",
        "versus",
        "vs",
        "rank",
        "ranking",
        "top",
        "bottom",
    ),
    "relationship": (
        "relationship",
        "association",
        "correlation",
        "correlate",
        "interaction",
        "dependency",
        "joint",
        "pairwise",
    ),
    "trend": (
        "trend",
        "temporal",
        "over time",
        "trajectory",
        "season",
        "seasonality",
        "month",
        "quarter",
        "year",
    ),
    "segmentation": (
        "segment",
        "segmentation",
        "group",
        "cohort",
        "category",
        "region",
        "channel",
        "across",
        "within",
        "breakdown",
    ),
    "explanation": (
        "why",
        "driver",
        "drivers",
        "cause",
        "causes",
        "mechanism",
        "root cause",
        "explain",
        "explanation",
    ),
    "validation": (
        "validate",
        "validation",
        "verify",
        "verification",
        "check",
        "robust",
        "robustness",
        "sensitivity",
        "confirm",
    ),
    "anomaly_or_quality": (
        "outlier",
        "anomaly",
        "extreme",
        "exception",
        "missing",
        "null",
        "quality",
        "duplicate",
        "invalid",
    ),
}

_ANGLE_TO_COVERAGE_DIMENSION: dict[str, str] = {
    "distribution": "surface_patterns",
    "trend": "surface_patterns",
    "segmentation": "surface_patterns",
    "anomaly_or_quality": "surface_patterns",
    "comparison": "relationships_and_comparisons",
    "relationship": "relationships_and_comparisons",
    "explanation": "explanation_and_validation",
    "validation": "explanation_and_validation",
}

_COVERAGE_DIMENSION_LABELS: dict[str, str] = {
    "surface_patterns": "surface patterns",
    "relationships_and_comparisons": "relationships/comparisons",
    "explanation_and_validation": "explanation/validation",
}

_GENERIC_BROAD_GOAL_DIMENSIONS = (
    "surface_patterns",
    "relationships_and_comparisons",
    "explanation_and_validation",
)


def _build_orchestrator_augmentation_prompt() -> str:
    return (
        "Implementation-aligned orchestration guidance:\n"
        "- Treat the derived orchestration context as advisory state interpretation rather than a new runtime policy.\n"
        "- Reuse the old strong planning instinct in a coverage-driven way: if the current goal is still broad and one plan would leave obvious analytical angles uncovered, prefer decomposing into multiple concrete, complementary, non-duplicative plans rather than one vague umbrella plan.\n"
        "- Coverage, not raw plan count, is the deciding principle. Before returning a single create_plans action for a broad goal, sanity-check whether descriptive coverage, relationship/comparison coverage, and explanation/validation coverage are already sufficiently represented by existing or proposed plans.\n"
        "- When coverage is concentrated in one angle, or when one umbrella plan collapses several distinct questions into a single broad task, prefer a more angle-distinct decomposition.\n"
        "- Multi-plan decomposition is a bias, not a hard quota. Create only as many plans as the current evidence gaps and uncovered analytical angles justify.\n"
        "- When an elaborate steering is active, keep follow-up tightly scoped to that one insight. If multiple tightly coupled explanations or mechanism checks are still needed, 2-3 coordinated follow-up plans are allowed, but avoid unrelated branching.\n"
        "- Prefer plans that differ by analytical angle, mechanism, validation path, or evidence strategy. If multiple candidate plans overlap heavily, keep the more complementary decomposition.\n"
        "- Reuse rich derived context as a deliberation brief: read the narrative sections to understand uncovered follow-ups, already-covered angles, and where current plan coverage is still too flat.\n"
        "- If a new user-authored input or steering has not yet been acknowledged, prioritize one concise `emit_response` as the first action before planning, dispatch, or progress evaluation unless explicit execution control, stop handling, or completion-oriented wrapping up clearly takes precedence.\n"
        "- When the latest user-authored input is a direct question, a follow-up, or a progress/explanation request, and the current state already supports a grounded short explanation, consider `emit_response` instead of silent waiting.\n"
        "- When a dispatch batch has just finished or a stage synthesis has just been emitted, a concise `emit_response` can be appropriate if it helps the user understand what just happened and what the likely next step is.\n"
        "- After that first acknowledgement, if `dispatch_ready` is still present or runnable pending/paused work remains with no active worker, treat scheduling as still outstanding in the next round.\n"
        "- After that first acknowledgement, if `unprocessed_steering_ready` is present or active steering remains unlinked to any plan and has not been consumed, treat that steering follow-up as still unresolved in the next round.\n"
        "- Do not infer that work has already started merely because a batch exists or is marked dispatched; confirm worker activity from active plans / active workers before choosing to wait for execution.\n"
        "- Review-ready signals indicate that another deliberation round is worthwhile; they may require continuation, and `wait` remains valid when no materially useful action is justified.\n"
        "- Avoid repetitive acknowledgement loops. If a review-ready signal wakes a new round but there is no new substantive explanation or follow-up work to do, prefer `wait` over another redundant `emit_response`.\n"
        "- Treat `emit_stage_synthesis` as an intermediate checkpoint, not a completion signal.\n"
        "- For broad goals, one completed dispatch batch is provisional evidence, not completion proof.\n"
        "- After a finished dispatch batch with retained findings, prefer `evaluate_progress` first, then decide whether follow-up `create_plans` / `dispatch_plans` is still needed.\n"
        "- Completion gate for `emit_final_report`: do not finalize while any of these remains true: unresolved steering follow-up, runnable pending/paused work, or coverage gaps in `PLANNING COVERAGE HINTS` (`plan_coverage_is_narrow == true`, non-empty `missing_coverage_dimensions`, or `open_follow_up_signal_count > 0`).\n"
        "- For broad goals and/or complex tasks, avoid `emit_final_report` immediately after first substantive findings unless the user explicitly asks to stop or all requested coverage dimensions are already grounded by retained evidence.\n"
        "- For stage/final synthesis, cite inline with `[[n]]` markers in markdown and keep those markers aligned with `citations` markers.\n"
        "- For `emit_stage_synthesis` and `emit_final_report`, each citation must use canonical fields only: `marker`, `target`, and optional `label`.\n"
        "- Canonical citation targets must use `target.kind` as `summary` or `atomic`; include `target.summary_id` always, and include `target.atomic_id` when `target.kind` is `atomic`.\n"
        "- Citation markers must be positive integers, unique, and increasing.\n"
        "- Never use legacy citation keys: `insight_id`, `finding_id`, `source_id`, `plan_id`.\n"
        "- If multiple tool calls seem desirable in the same round, choose the single most important tool call first. The runtime can wake another round when continuation signals still remain.\n"
    )


def _latest_user_message(run_state: RunState) -> UserMessage | None:
    if not run_state.user_messages:
        return None
    return run_state.user_messages[-1]


def _message_kind(message: UserMessage | None) -> str:
    if message is None:
        return "chat"
    raw_kind = str(message.kind or "").strip().lower()
    return raw_kind or "chat"


def _parse_iso_timestamp(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _text_looks_like_direct_question(text: str) -> bool:
    normalized = str(text or "").strip()
    if not normalized:
        return False
    lowered = normalized.casefold()
    if normalized.endswith("?") or normalized.endswith("？"):
        return True
    return any(
        lowered.startswith(prefix)
        for prefix in (
            "what ",
            "why ",
            "how ",
            "when ",
            "where ",
            "who ",
            "which ",
            "can ",
            "could ",
            "would ",
            "should ",
            "is ",
            "are ",
            "do ",
            "does ",
            "did ",
        )
    )


def _text_requests_progress_or_explanation(text: str) -> bool:
    lowered = str(text or "").casefold()
    if not lowered:
        return False
    return any(
        token in lowered
        for token in (
            "progress",
            "status",
            "update",
            "explain",
            "explanation",
            "why",
            "what happened",
            "what now",
            "next step",
            "next",
            "summary",
            "summarize",
        )
    )


def _message_id_to_turn_index(run_state: RunState) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for turn in run_state.turns:
        for item in turn.triggering_inputs:
            if not isinstance(item, dict):
                continue
            message_id = str(item.get("message_id", "") or "").strip()
            if message_id and message_id not in mapping:
                mapping[message_id] = turn.turn_id
    return mapping


def _format_steering_target(target: SteeringTargetSnapshot | None) -> str:
    if target is None:
        return "<no target>"
    if target.kind == "column":
        columns = ", ".join(target.columns) if target.columns else "<none>"
        return f"column[{columns}]"
    summary_label = target.summary_short_label or target.summary_id or "<summary>"
    if target.kind == "atomic":
        atomic_label = target.atomic_text or target.atomic_id or "<atomic>"
        return f"atomic[{summary_label} :: {atomic_label}]"
    return f"summary[{summary_label}]"


def _insight_by_plan_id(run_state: RunState) -> dict[str, Insight]:
    ordered: dict[str, Insight] = {}
    for insight in run_state.findings:
        plan_id = str(getattr(insight, "plan_id", "") or "").strip()
        if plan_id and plan_id not in ordered:
            ordered[plan_id] = insight
    return ordered


def _plan_inventory(run_state: RunState) -> dict[str, list[dict[str, Any]]]:
    linked_steering_by_plan: dict[str, list[str]] = {}
    for plan in run_state.plans:
        linked_steering_by_plan[plan.plan_id] = [str(item) for item in plan.linked_steering_ids if str(item)]
    insights_by_plan = _insight_by_plan_id(run_state)
    grouped: dict[str, list[dict[str, Any]]] = {
        "active": [],
        "pending": [],
        "paused": [],
        "completed": [],
        "failed": [],
        "terminated": [],
    }
    for plan in run_state.plans:
        status = str(plan.status or "").strip()
        key = status if status in grouped else "failed"
        grouped[key].append(
            {
                "plan_id": plan.plan_id,
                "status": plan.status,
                "text": plan.text,
                "resume_phase": plan.resume_phase,
                "linked_steering_ids": linked_steering_by_plan.get(plan.plan_id, []),
                "final_summary": plan.final_summary,
                "error_message": plan.error_message,
                "finding_summary": (
                    insights_by_plan[plan.plan_id].summary
                    if plan.plan_id in insights_by_plan
                    else ""
                ),
            }
        )
    return grouped


def _dispatch_batch_inventory(run_state: RunState) -> list[dict[str, Any]]:
    inventories: list[dict[str, Any]] = []
    insights_by_plan = _insight_by_plan_id(run_state)
    for batch in run_state.batches:
        plan_findings: list[dict[str, Any]] = []
        for plan_id in batch.plan_ids:
            finding = insights_by_plan.get(plan_id)
            plan_findings.append(
                {
                    "plan_id": plan_id,
                    "has_retained_finding": finding is not None,
                    "finding_id": finding.insight_id if finding is not None else None,
                    "finding_summary": finding.summary if finding is not None else "",
                }
            )
        inventories.append(
            {
                "dispatch_turn_index": batch.dispatch_turn_index,
                "status": batch.status,
                "plan_ids": list(batch.plan_ids),
                "active_plan_ids": list(batch.active_plan_ids),
                "waiting_plan_ids": list(batch.waiting_plan_ids),
                "terminal_plan_ids": [
                    plan_id
                    for plan_id in batch.plan_ids
                    if plan_id not in batch.active_plan_ids and plan_id not in batch.waiting_plan_ids
                ],
                "plan_findings": plan_findings,
            }
        )
    return inventories


def _stage_summary_window(
    unsummarized_batches: list[DispatchBatchState],
    unsummarized_findings: list[Insight],
) -> dict[str, Any]:
    findings_by_plan: dict[str, Insight] = {
        str(finding.plan_id): finding
        for finding in unsummarized_findings
        if str(getattr(finding, "plan_id", "") or "").strip()
    }
    if not unsummarized_batches:
        return {
            "summary_boundary_dispatch_turn_index": None,
            "unsummarized_dispatch_turn_indexes": [],
            "plan_finding_map": [],
        }
    plan_finding_map: list[dict[str, Any]] = []
    for batch in unsummarized_batches:
        for plan_id in batch.plan_ids:
            finding = findings_by_plan.get(plan_id)
            plan_finding_map.append(
                {
                    "dispatch_turn_index": batch.dispatch_turn_index,
                    "plan_id": plan_id,
                    "finding_id": finding.insight_id if finding is not None else None,
                    "finding_summary": finding.summary if finding is not None else "",
                }
            )
    return {
        "summary_boundary_dispatch_turn_index": unsummarized_batches[0].dispatch_turn_index,
        "unsummarized_dispatch_turn_indexes": [
            batch.dispatch_turn_index for batch in unsummarized_batches
        ],
        "plan_finding_map": plan_finding_map,
    }


def _steering_history(run_state: RunState) -> list[dict[str, Any]]:
    turn_index_by_message_id = _message_id_to_turn_index(run_state)
    linked_plan_ids_by_steering: dict[str, list[str]] = {}
    for plan in run_state.plans:
        for steering_id in plan.linked_steering_ids:
            normalized_steering_id = str(steering_id or "").strip()
            if not normalized_steering_id:
                continue
            linked_plan_ids_by_steering.setdefault(normalized_steering_id, [])
            if plan.plan_id not in linked_plan_ids_by_steering[normalized_steering_id]:
                linked_plan_ids_by_steering[normalized_steering_id].append(plan.plan_id)

    history: list[dict[str, Any]] = []
    for message in run_state.user_messages:
        kind = _message_kind(message)
        if kind not in {"focus", "ignore", "elaborate", "create"}:
            continue
        steering_id = f"steer_{message.message_id}"
        history.append(
            {
                "turn_id": turn_index_by_message_id.get(message.message_id),
                "message_id": message.message_id,
                "kind": kind,
                "display_text": message.display_text,
                "user_prompt": message.user_prompt or message.generated_prompt or message.content,
                "selected_keywords": list(message.selected_keywords),
                "target": _format_steering_target(message.target),
                "target_columns": list(message.target.columns) if message.target is not None else [],
                "active": steering_id in run_state.steering_state.active_steering_ids,
                "linked_plan_ids": linked_plan_ids_by_steering.get(steering_id, []),
            }
        )
    return history


def _open_follow_up_signals(run_state: RunState) -> list[dict[str, Any]]:
    history = _steering_history(run_state)
    open_items: list[dict[str, Any]] = []
    for item in history:
        if item["kind"] not in {"focus", "ignore", "elaborate"}:
            continue
        if not item["active"]:
            continue
        if item["linked_plan_ids"]:
            continue
        open_items.append(
            {
                "message_id": item["message_id"],
                "turn_id": item["turn_id"],
                "kind": item["kind"],
                "target": item["target"],
                "selected_keywords": item["selected_keywords"],
            }
        )
    return open_items


def _latest_timeline_timestamp(
    run_state: RunState,
    *,
    entry_types: set[str],
) -> datetime | None:
    timestamps = [
        _parse_iso_timestamp(getattr(entry, "timestamp", None))
        for entry in getattr(run_state, "timeline", [])
        if str(getattr(entry, "entry_type", "") or "").strip() in entry_types
    ]
    parsed_timestamps = [timestamp for timestamp in timestamps if timestamp is not None]
    if not parsed_timestamps:
        return None
    return max(parsed_timestamps)


def _response_opportunity_hints(run_state: RunState) -> dict[str, Any]:
    unprocessed_steering_items = _open_follow_up_signals(run_state)
    latest_message = _latest_user_message(run_state)
    latest_message_text = (
        str(
            latest_message.user_prompt
            or latest_message.generated_prompt
            or latest_message.content
            or ""
        ).strip()
        if latest_message is not None
        else ""
    )
    latest_message_kind = _message_kind(latest_message)
    latest_message_timestamp = (
        _parse_iso_timestamp(getattr(latest_message, "timestamp", None))
        if latest_message is not None
        else None
    )
    latest_emit_response_timestamp = _latest_timeline_timestamp(
        run_state,
        entry_types={"emit_response"},
    )
    latest_user_message_unacknowledged = bool(
        latest_message is not None and (
            latest_emit_response_timestamp is None
            or latest_message_timestamp is None
            or latest_emit_response_timestamp < latest_message_timestamp
        )
    )
    launch_priority_present = any(
        bool(plan.launch_requested) and plan.status in {"pending", "paused"}
        for plan in run_state.plans
    )
    waiting_for_stage_summary_present = any(
        batch.status == "waiting_for_stage_summary"
        for batch in run_state.batches
    )
    current_turn = run_state.current_turn()
    no_plan_and_goal_needs_expansion = bool(
        not run_state.plans
        and str(current_turn.goal if current_turn is not None else "").strip()
    )
    grounded_response_possible_from_existing_findings = bool(
        run_state.findings
        or any(str(plan.final_summary or "").strip() for plan in run_state.plans)
        or str(run_state.final_summary or "").strip()
    )
    latest_user_message_is_direct_question = _text_looks_like_direct_question(latest_message_text)
    latest_user_message_requests_progress_or_explanation = _text_requests_progress_or_explanation(
        latest_message_text
    )
    latest_user_message_is_new_goal_like = bool(
        latest_message_kind == "chat"
        and latest_message_text
        and not latest_user_message_is_direct_question
        and _looks_like_broad_goal(
            latest_message_text,
            active_elaborate_is_tight_scope=False,
        )
    )
    recent_signals = list(getattr(run_state, "timeline", [])[-10:])
    recent_batch_finished = any(
        str(getattr(entry, "entry_type", "") or "") == "worker_finding_ready"
        for entry in recent_signals
    ) and any(
        batch.status == "waiting_for_stage_summary" for batch in run_state.batches
    )
    dispatch_ready_present = any(
        str(getattr(entry, "entry_type", "") or "") == "dispatch_ready"
        for entry in recent_signals
    )
    unprocessed_steering_ready_present = any(
        str(getattr(entry, "entry_type", "") or "") == "unprocessed_steering_ready"
        for entry in recent_signals
    )
    runnable_without_active_worker = bool(
        any(plan.status in {"pending", "paused"} for plan in run_state.plans)
        and not any(plan.status in {"analyzing", "summarizing"} for plan in run_state.plans)
    )
    recent_batch_finished_has_retained_findings = bool(recent_batch_finished and run_state.findings)
    unprocessed_steering_present = bool(unprocessed_steering_items)
    fresh_user_acknowledgement_preferred = bool(
        latest_user_message_unacknowledged and latest_message is not None
    )
    response_should_not_preempt_higher_priority_action = bool(
        launch_priority_present
        or waiting_for_stage_summary_present
        or (no_plan_and_goal_needs_expansion and not fresh_user_acknowledgement_preferred)
        or (dispatch_ready_present and not fresh_user_acknowledgement_preferred)
        or (unprocessed_steering_present and not fresh_user_acknowledgement_preferred)
        or (runnable_without_active_worker and not fresh_user_acknowledgement_preferred)
    )

    advisory_notes: list[str] = []
    if fresh_user_acknowledgement_preferred:
        advisory_notes.append(
            "A fresh user-authored input or steering is still unacknowledged. Prefer one concise emit_response as the first action now, then let later rounds handle planning, dispatch, or evaluation."
        )
    if latest_user_message_unacknowledged and latest_user_message_is_direct_question:
        advisory_notes.append(
            "The latest user-authored message looks like a direct question. If the current state already supports a grounded answer, a short emit_response may be justified."
        )
    if latest_user_message_unacknowledged and latest_user_message_requests_progress_or_explanation:
        advisory_notes.append(
            "The latest user-authored message appears to request progress or explanation. A concise emit_response can be appropriate when it adds real clarity."
        )
    if latest_user_message_unacknowledged and latest_user_message_is_new_goal_like:
        advisory_notes.append(
            "The latest user-authored chat message looks like a new goal or broad follow-up. A brief acknowledgement is allowed, but it should not block necessary planning."
        )
    if recent_batch_finished_has_retained_findings:
        advisory_notes.append(
            "A dispatch batch appears to have just finished with retained findings. A short emit_response can help bridge from results to the next deliberate move."
        )
    if dispatch_ready_present:
        advisory_notes.append(
            "A dispatch_ready signal is still present. After the first acknowledgement, scheduling may still be the next materially useful step."
        )
    if unprocessed_steering_ready_present or unprocessed_steering_present:
        advisory_notes.append(
            "At least one steering follow-up is still unresolved. Use the first acknowledgement now if needed, but do not treat it as having completed the steering follow-up."
        )
    if runnable_without_active_worker:
        advisory_notes.append(
            "Runnable pending or paused work remains but no worker is active. After the first acknowledgement, execution handoff may still be the next action."
        )
    if response_should_not_preempt_higher_priority_action:
        advisory_notes.append(
            "A higher-priority action may already be available. Do not force emit_response when dispatch, planning, or stage synthesis is clearly due."
        )

    return {
        "latest_user_message_kind": latest_message_kind,
        "latest_user_message_present": latest_message is not None,
        "latest_user_message_is_direct_question": latest_user_message_is_direct_question,
        "latest_user_message_requests_progress_or_explanation": latest_user_message_requests_progress_or_explanation,
        "latest_user_message_is_new_goal_like": latest_user_message_is_new_goal_like,
        "latest_user_message_unacknowledged": latest_user_message_unacknowledged,
        "grounded_response_possible_from_existing_findings": grounded_response_possible_from_existing_findings,
        "fresh_user_acknowledgement_preferred": fresh_user_acknowledgement_preferred,
        "response_should_not_preempt_higher_priority_action": response_should_not_preempt_higher_priority_action,
        "dispatch_ready_present": dispatch_ready_present,
        "unprocessed_steering_present": unprocessed_steering_present,
        "unprocessed_steering_ready_present": unprocessed_steering_ready_present,
        "runnable_without_active_worker": runnable_without_active_worker,
        "recent_batch_finished": recent_batch_finished,
        "recent_batch_finished_has_retained_findings": recent_batch_finished_has_retained_findings,
        "advisory_notes": advisory_notes,
    }


def _review_opportunity_hints(run_state: RunState) -> dict[str, Any]:
    recent_signal_kinds = {
        str(getattr(entry, "entry_type", "") or "").strip()
        for entry in getattr(run_state, "timeline", [])[-20:]
    }
    unprocessed_steering_present = bool(_open_follow_up_signals(run_state))
    nonterminal_plans_present = any(
        plan.status in {"pending", "paused", "analyzing", "summarizing"}
        for plan in run_state.plans
    )
    waiting_for_stage_summary_present = any(
        batch.status == "waiting_for_stage_summary"
        for batch in run_state.batches
    )
    all_current_work_terminal = bool(run_state.plans) and not nonterminal_plans_present
    final_summary_missing = not str(run_state.final_summary or "").strip()
    findings_available = bool(run_state.findings)

    advisory_notes: list[str] = []
    if "post_emit_response_review_ready" in recent_signal_kinds:
        advisory_notes.append(
            "A post-emit_response review signal is present. Another deliberation round may be useful, but continuation is optional."
        )
    if "post_stage_summary_review_ready" in recent_signal_kinds:
        advisory_notes.append(
            "A post-stage-summary review signal is present. Another deliberation round may be useful, but continuation is optional."
        )
    if "unprocessed_steering_ready" in recent_signal_kinds:
        advisory_notes.append(
            "An unprocessed_steering_ready signal is present. Another deliberation round may be useful because at least one steering follow-up is still unresolved."
        )
    if all_current_work_terminal and findings_available and final_summary_missing:
        advisory_notes.append(
            "All current work is terminal and retained findings are available. Re-evaluating completion can be worthwhile."
        )
    if nonterminal_plans_present:
        advisory_notes.append(
            "Nonterminal work still exists. Review-ready signals should not be treated as mandatory closure instructions."
        )
    if unprocessed_steering_present:
        advisory_notes.append(
            "Active steering remains unprocessed. Review-ready signals should not be interpreted as proof that steering follow-up is already complete."
        )

    return {
        "post_emit_response_review_ready_present": "post_emit_response_review_ready" in recent_signal_kinds,
        "post_stage_summary_review_ready_present": "post_stage_summary_review_ready" in recent_signal_kinds,
        "unprocessed_steering_ready_present": "unprocessed_steering_ready" in recent_signal_kinds,
        "unprocessed_steering_present": unprocessed_steering_present,
        "nonterminal_plans_present": nonterminal_plans_present,
        "waiting_for_stage_summary_present": waiting_for_stage_summary_present,
        "all_current_work_terminal": all_current_work_terminal,
        "final_summary_missing": final_summary_missing,
        "findings_available": findings_available,
        "advisory_notes": advisory_notes,
    }


def _normalized_plan_text(text: str) -> str:
    return " ".join(str(text or "").split()).casefold()


def _unique_preserving_order(values: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _infer_coverage_angles(*parts: Any) -> list[str]:
    text = " ".join(str(part or "") for part in parts if str(part or "").strip()).casefold()
    if not text:
        return []
    angles: list[str] = []
    for angle, tokens in _COVERAGE_ANGLE_KEYWORDS.items():
        if any(token in text for token in tokens):
            angles.append(angle)
    return angles


def _coverage_dimensions_for_angles(angles: list[str]) -> list[str]:
    dimensions = [
        _ANGLE_TO_COVERAGE_DIMENSION[angle]
        for angle in angles
        if angle in _ANGLE_TO_COVERAGE_DIMENSION
    ]
    return _unique_preserving_order(dimensions)


def _format_dimension_labels(dimensions: list[str]) -> list[str]:
    return [
        _COVERAGE_DIMENSION_LABELS.get(dimension, dimension.replace("_", " "))
        for dimension in dimensions
    ]


def _requested_goal_dimensions(goal_text: str, *, goal_is_broad: bool) -> list[str]:
    angles = _infer_coverage_angles(goal_text)
    dimensions = _coverage_dimensions_for_angles(angles)
    if goal_is_broad:
        combined: list[str] = list(_GENERIC_BROAD_GOAL_DIMENSIONS)
        for dimension in dimensions:
            if dimension not in combined:
                combined.append(dimension)
        return combined
    return dimensions


def _coverage_plan_records(run_state: RunState) -> list[dict[str, Any]]:
    insights_by_plan = _insight_by_plan_id(run_state)
    relevant_statuses = {"analyzing", "summarizing", "pending", "paused", "completed"}
    records: list[dict[str, Any]] = []
    for plan in run_state.plans:
        if plan.status not in relevant_statuses:
            continue
        finding = insights_by_plan.get(plan.plan_id)
        angles = _infer_coverage_angles(plan.text, finding.summary if finding is not None else "")
        dimensions = _coverage_dimensions_for_angles(angles)
        records.append(
            {
                "plan_id": plan.plan_id,
                "status": plan.status,
                "text": plan.text,
                "angles": angles,
                "dimensions": dimensions,
                "looks_like_umbrella_plan": _looks_like_broad_goal(
                    plan.text,
                    active_elaborate_is_tight_scope=False,
                ),
            }
        )
    return records


def _looks_like_broad_goal(goal_text: str, *, active_elaborate_is_tight_scope: bool) -> bool:
    normalized = str(goal_text or "").strip()
    if not normalized or active_elaborate_is_tight_scope:
        return False
    lowered = normalized.casefold()
    token_match = any(token in lowered for token in _BROAD_GOAL_HINT_TOKENS_EN)
    if token_match:
        return True
    if contains_cjk_text(normalized):
        return len(normalized) >= 12
    return len(normalized.split()) >= 5


def _planning_coverage_hints(
    run_state: RunState,
    *,
    latest_user_goal: str,
) -> dict[str, Any]:
    active_elaborate_is_tight_scope = any(
        _message_kind(message) == "elaborate" and f"steer_{message.message_id}" in run_state.steering_state.active_steering_ids
        for message in run_state.user_messages
    )
    goal_is_broad = _looks_like_broad_goal(
        latest_user_goal,
        active_elaborate_is_tight_scope=active_elaborate_is_tight_scope,
    )
    coverage_plan_records = _coverage_plan_records(run_state)
    covered_dimensions = _unique_preserving_order(
        [
            dimension
            for record in coverage_plan_records
            for dimension in record["dimensions"]
        ]
    )
    requested_dimensions = _requested_goal_dimensions(
        latest_user_goal,
        goal_is_broad=goal_is_broad,
    )
    missing_dimensions = [
        dimension
        for dimension in requested_dimensions
        if dimension not in covered_dimensions
    ]
    active_or_pending_plans = [
        record
        for record in coverage_plan_records
        if record["status"] in {"analyzing", "summarizing", "pending", "paused"}
    ]
    open_follow_up_signals = _open_follow_up_signals(run_state)
    coverage_concentrated_in_one_angle = (
        goal_is_broad
        and bool(active_or_pending_plans)
        and len(
            _unique_preserving_order(
                [
                    dimension
                    for record in active_or_pending_plans
                    for dimension in record["dimensions"]
                ]
            )
        )
        <= 1
    )
    single_umbrella_plan = (
        goal_is_broad
        and len(active_or_pending_plans) == 1
        and (
            bool(active_or_pending_plans[0]["looks_like_umbrella_plan"])
            or len(active_or_pending_plans[0]["dimensions"]) <= 1
        )
    )
    plan_coverage_is_narrow = bool(
        goal_is_broad
        and (
            bool(missing_dimensions)
            or coverage_concentrated_in_one_angle
            or single_umbrella_plan
            or bool(open_follow_up_signals)
        )
    )
    normalized_plan_texts = [
        _normalized_plan_text(str(record["text"]))
        for record in active_or_pending_plans
        if _normalized_plan_text(str(record["text"]))
    ]
    active_dimensions = _unique_preserving_order(
        [
            dimension
            for record in active_or_pending_plans
            for dimension in record["dimensions"]
        ]
    )
    existing_plans_look_redundant = (
        len(normalized_plan_texts) != len(set(normalized_plan_texts))
        or (len(active_or_pending_plans) >= 2 and len(active_dimensions) <= 1)
    )

    advisory_notes: list[str] = []
    if plan_coverage_is_narrow:
        if missing_dimensions:
            advisory_notes.append(
                "Current goal still looks broader than the covered analytical dimensions. Missing coverage remains in: "
                + ", ".join(_format_dimension_labels(missing_dimensions))
                + "."
            )
        advisory_notes.append(
            "Prefer coverage-driven decomposition: if no tight elaborate scope is active, consider multiple complementary plans whose angles are meaningfully different rather than one umbrella plan."
        )
    if single_umbrella_plan:
        advisory_notes.append(
            "A single broad umbrella plan appears to be carrying too much scope. Split it only if doing so would produce clearer complementary coverage."
        )
    if open_follow_up_signals:
        advisory_notes.append(
            "There are active follow-up signals that still have no obvious linked plan coverage. Use those as coverage-gap hints, not as a hard planning quota."
        )
    if active_elaborate_is_tight_scope:
        advisory_notes.append(
            "An active elaborate steering is present. Keep follow-up tightly scoped to that insight and avoid unrelated branching."
        )
        advisory_notes.append(
            "If the same insight still requires multiple tightly coupled mechanism or explanation checks, 2-3 coordinated follow-up plans are allowed."
        )
    if existing_plans_look_redundant:
        advisory_notes.append(
            "Existing plans look repetitive. Prefer fewer but more angle-distinct plans."
        )
    return {
        "goal_is_broad": goal_is_broad,
        "plan_coverage_is_narrow": plan_coverage_is_narrow,
        "active_elaborate_is_tight_scope": active_elaborate_is_tight_scope,
        "requested_coverage_dimensions": requested_dimensions,
        "covered_coverage_dimensions": covered_dimensions,
        "missing_coverage_dimensions": missing_dimensions,
        "coverage_concentrated_in_one_angle": coverage_concentrated_in_one_angle,
        "single_umbrella_plan": single_umbrella_plan,
        "existing_plans_look_redundant": existing_plans_look_redundant,
        "open_follow_up_signal_count": len(open_follow_up_signals),
        "active_plan_angle_map": [
            {
                "plan_id": str(record["plan_id"]),
                "status": str(record["status"]),
                "angles": list(record["angles"]),
                "dimensions": list(record["dimensions"]),
            }
            for record in active_or_pending_plans
        ],
        "advisory_notes": advisory_notes,
    }


def _render_context_section(title: str, lines: list[str]) -> str:
    body = lines if lines else ["- <none>"]
    return "\n".join([f"== {title} =="] + body)


def _render_latest_user_context_text(
    *,
    latest_user_goal: str,
    latest_user_message: str,
    latest_kind: str,
    latest_language_hint: str,
) -> str:
    lines = [
        f"latest_user_goal: {latest_user_goal or '<none>'}",
        f"latest_user_authored_message: {latest_user_message or '<none>'}",
        f"latest_message_kind: {latest_kind}",
        f"latest_language_hint: {latest_language_hint}",
    ]
    return _render_context_section("LATEST USER CONTEXT", lines)


def _render_stage_summary_window_text(stage_summary_window: dict[str, Any]) -> str:
    lines = [
        "The next stage synthesis should cover the full unsummarized evidence window rather than only the latest completed plan."
    ]
    boundary = stage_summary_window.get("summary_boundary_dispatch_turn_index")
    lines.append(
        "summary_boundary_dispatch_turn_index: "
        + (str(boundary) if boundary is not None else "<none>")
    )
    lines.append(
        "unsummarized_dispatch_turn_indexes: "
        + json.dumps(
            stage_summary_window.get("unsummarized_dispatch_turn_indexes", []),
            ensure_ascii=False,
        )
    )
    plan_finding_map = stage_summary_window.get("plan_finding_map", [])
    if isinstance(plan_finding_map, list) and plan_finding_map:
        for item in plan_finding_map:
            if not isinstance(item, dict):
                continue
            lines.append(
                "- dispatch_turn_index="
                + str(item.get("dispatch_turn_index"))
                + f" plan_id={item.get('plan_id')} "
                + f"finding_id={item.get('finding_id') or '<none>'}"
            )
            finding_summary = str(item.get("finding_summary", "") or "").strip()
            if finding_summary:
                lines.append(f"  summary: {finding_summary}")
    else:
        lines.append("- <none>")
    return _render_context_section("CURRENT STAGE SUMMARY WINDOW", lines)


def _render_plan_inventory_text(
    plan_inventory: dict[str, list[dict[str, Any]]],
    planning_coverage_hints: dict[str, Any],
) -> str:
    lines = [
        "Coverage should be judged by distinct analytical angles and unresolved gaps, not by a fixed plan quota."
    ]
    for group_name in ("active", "pending", "paused", "completed", "failed", "terminated"):
        items = plan_inventory.get(group_name, [])
        lines.append(f"{group_name.upper()}:")
        if not items:
            lines.append("  - <none>")
            continue
        for item in items:
            text = str(item.get("text", "") or "").strip() or "<empty>"
            lines.append(
                f"  - {item.get('plan_id')}: {text} [{item.get('status') or group_name}]"
            )
            linked_steering_ids = item.get("linked_steering_ids", [])
            if isinstance(linked_steering_ids, list) and linked_steering_ids:
                lines.append(f"    linked_steering_ids: {linked_steering_ids}")
            finding_summary = str(item.get("finding_summary", "") or "").strip()
            if finding_summary:
                lines.append(f"    retained_finding: {finding_summary}")
    covered_labels = _format_dimension_labels(
        list(planning_coverage_hints.get("covered_coverage_dimensions", []))
    )
    missing_labels = _format_dimension_labels(
        list(planning_coverage_hints.get("missing_coverage_dimensions", []))
    )
    if covered_labels:
        lines.append("covered_dimensions: " + ", ".join(covered_labels))
    if missing_labels:
        lines.append("missing_dimensions: " + ", ".join(missing_labels))
    active_plan_angle_map = planning_coverage_hints.get("active_plan_angle_map", [])
    if isinstance(active_plan_angle_map, list) and active_plan_angle_map:
        lines.append("active_plan_angle_map:")
        for item in active_plan_angle_map:
            if not isinstance(item, dict):
                continue
            angle_labels = ", ".join(str(angle) for angle in item.get("angles", []) or []) or "<none>"
            dimension_labels = ", ".join(
                _format_dimension_labels(list(item.get("dimensions", []) or []))
            ) or "<none>"
            lines.append(
                f"  - {item.get('plan_id')} [{item.get('status')}]: angles={angle_labels}; dimensions={dimension_labels}"
            )
    return _render_context_section("PLAN INVENTORY", lines)


def _render_dispatch_batch_inventory_text(batch_inventory: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    if not batch_inventory:
        lines.append("- <none>")
        return _render_context_section("DISPATCH BATCH INVENTORY", lines)
    for batch in batch_inventory:
        lines.append(
            "- dispatch_turn_index="
            + str(batch.get("dispatch_turn_index"))
            + f" status={batch.get('status')} plan_ids={batch.get('plan_ids', [])}"
        )
        lines.append(f"  active_plan_ids: {batch.get('active_plan_ids', [])}")
        lines.append(f"  waiting_plan_ids: {batch.get('waiting_plan_ids', [])}")
        lines.append(f"  terminal_plan_ids: {batch.get('terminal_plan_ids', [])}")
        plan_findings = batch.get("plan_findings", [])
        if isinstance(plan_findings, list):
            for item in plan_findings:
                if not isinstance(item, dict):
                    continue
                lines.append(
                    f"  - {item.get('plan_id')} -> finding_id={item.get('finding_id') or '<none>'}"
                )
                finding_summary = str(item.get("finding_summary", "") or "").strip()
                if finding_summary:
                    lines.append(f"    summary: {finding_summary}")
    return _render_context_section("DISPATCH BATCH INVENTORY", lines)


def _render_steering_history_text(steering_history: list[dict[str, Any]]) -> str:
    lines = ["If steering actions conflict, the latest active one should dominate later planning."]
    if not steering_history:
        lines.append("- <none>")
        return _render_context_section("STEERING HISTORY", lines)
    for item in steering_history:
        lines.append(
            f"- turn={item.get('turn_id')} kind={item.get('kind')} target={item.get('target')}"
        )
        display_text = str(item.get("display_text", "") or "").strip()
        if display_text:
            lines.append(f"  display_text: {display_text}")
        user_prompt = str(item.get("user_prompt", "") or "").strip()
        if user_prompt:
            lines.append(f"  user_prompt: {user_prompt}")
        selected_keywords = item.get("selected_keywords", [])
        if isinstance(selected_keywords, list) and selected_keywords:
            lines.append(f"  selected_keywords: {selected_keywords}")
        lines.append(f"  active: {bool(item.get('active'))}")
        linked_plan_ids = item.get("linked_plan_ids", [])
        if isinstance(linked_plan_ids, list) and linked_plan_ids:
            lines.append(f"  linked_plan_ids: {linked_plan_ids}")
    return _render_context_section("STEERING HISTORY", lines)


def _render_open_follow_up_signals_text(open_follow_up_signals: list[dict[str, Any]]) -> str:
    lines = [
        "These are advisory coverage gaps. They indicate unresolved follow-up demand but do not create a hard create_plans quota."
    ]
    if not open_follow_up_signals:
        lines.append("- <none>")
        return _render_context_section("OPEN FOLLOW-UP SIGNALS", lines)
    for item in open_follow_up_signals:
        lines.append(
            f"- turn={item.get('turn_id')} kind={item.get('kind')} target={item.get('target')}"
        )
        selected_keywords = item.get("selected_keywords", [])
        if isinstance(selected_keywords, list) and selected_keywords:
            lines.append(f"  selected_keywords: {selected_keywords}")
    return _render_context_section("OPEN FOLLOW-UP SIGNALS", lines)


def _render_response_opportunity_hints_text(response_hints: dict[str, Any]) -> str:
    lines = [
        "These hints describe when a concise emit_response may be useful. They are advisory only and should not preempt clearly higher-priority work."
    ]
    lines.append(
        "latest_user_message_kind: "
        + str(response_hints.get("latest_user_message_kind", "chat"))
    )
    lines.append(
        "latest_user_message_present: "
        + str(bool(response_hints.get("latest_user_message_present")))
    )
    lines.append(
        "latest_user_message_is_direct_question: "
        + str(bool(response_hints.get("latest_user_message_is_direct_question")))
    )
    lines.append(
        "latest_user_message_requests_progress_or_explanation: "
        + str(bool(response_hints.get("latest_user_message_requests_progress_or_explanation")))
    )
    lines.append(
        "latest_user_message_is_new_goal_like: "
        + str(bool(response_hints.get("latest_user_message_is_new_goal_like")))
    )
    lines.append(
        "latest_user_message_unacknowledged: "
        + str(bool(response_hints.get("latest_user_message_unacknowledged")))
    )
    lines.append(
        "grounded_response_possible_from_existing_findings: "
        + str(bool(response_hints.get("grounded_response_possible_from_existing_findings")))
    )
    lines.append(
        "fresh_user_acknowledgement_preferred: "
        + str(bool(response_hints.get("fresh_user_acknowledgement_preferred")))
    )
    lines.append(
        "response_should_not_preempt_higher_priority_action: "
        + str(bool(response_hints.get("response_should_not_preempt_higher_priority_action")))
    )
    lines.append(
        "unprocessed_steering_present: "
        + str(bool(response_hints.get("unprocessed_steering_present")))
    )
    lines.append(
        "unprocessed_steering_ready_present: "
        + str(bool(response_hints.get("unprocessed_steering_ready_present")))
    )
    lines.append(
        "recent_batch_finished: "
        + str(bool(response_hints.get("recent_batch_finished")))
    )
    lines.append(
        "recent_batch_finished_has_retained_findings: "
        + str(bool(response_hints.get("recent_batch_finished_has_retained_findings")))
    )
    advisory_notes = response_hints.get("advisory_notes", [])
    if isinstance(advisory_notes, list) and advisory_notes:
        lines.append("advisory_notes:")
        for note in advisory_notes:
            normalized_note = str(note or "").strip()
            if normalized_note:
                lines.append(f"  - {normalized_note}")
    return _render_context_section("RESPONSE OPPORTUNITY HINTS", lines)


def _render_review_opportunity_hints_text(review_hints: dict[str, Any]) -> str:
    lines = [
        "Review-ready signals indicate another deliberation opportunity. They do not require continuation, and wait remains valid when no materially useful action is justified."
    ]
    lines.append(
        "post_emit_response_review_ready_present: "
        + str(bool(review_hints.get("post_emit_response_review_ready_present")))
    )
    lines.append(
        "post_stage_summary_review_ready_present: "
        + str(bool(review_hints.get("post_stage_summary_review_ready_present")))
    )
    lines.append(
        "unprocessed_steering_ready_present: "
        + str(bool(review_hints.get("unprocessed_steering_ready_present")))
    )
    lines.append(
        "unprocessed_steering_present: "
        + str(bool(review_hints.get("unprocessed_steering_present")))
    )
    lines.append(
        "nonterminal_plans_present: "
        + str(bool(review_hints.get("nonterminal_plans_present")))
    )
    lines.append(
        "waiting_for_stage_summary_present: "
        + str(bool(review_hints.get("waiting_for_stage_summary_present")))
    )
    lines.append(
        "all_current_work_terminal: "
        + str(bool(review_hints.get("all_current_work_terminal")))
    )
    lines.append(
        "final_summary_missing: "
        + str(bool(review_hints.get("final_summary_missing")))
    )
    lines.append(
        "findings_available: "
        + str(bool(review_hints.get("findings_available")))
    )
    advisory_notes = review_hints.get("advisory_notes", [])
    if isinstance(advisory_notes, list) and advisory_notes:
        lines.append("advisory_notes:")
        for note in advisory_notes:
            normalized_note = str(note or "").strip()
            if normalized_note:
                lines.append(f"  - {normalized_note}")
    return _render_context_section("REVIEW OPPORTUNITY HINTS", lines)


def _render_planning_coverage_hints_text(planning_coverage_hints: dict[str, Any]) -> str:
    lines = [
        "Interpret these hints as deliberation guidance only. They help explain where coverage is still too flat or repetitive."
    ]
    lines.append(f"goal_is_broad: {bool(planning_coverage_hints.get('goal_is_broad'))}")
    lines.append(
        "plan_coverage_is_narrow: "
        + str(bool(planning_coverage_hints.get("plan_coverage_is_narrow")))
    )
    lines.append(
        "active_elaborate_is_tight_scope: "
        + str(bool(planning_coverage_hints.get("active_elaborate_is_tight_scope")))
    )
    lines.append(
        "coverage_concentrated_in_one_angle: "
        + str(bool(planning_coverage_hints.get("coverage_concentrated_in_one_angle")))
    )
    lines.append(
        "single_umbrella_plan: "
        + str(bool(planning_coverage_hints.get("single_umbrella_plan")))
    )
    lines.append(
        "existing_plans_look_redundant: "
        + str(bool(planning_coverage_hints.get("existing_plans_look_redundant")))
    )
    lines.append(
        "requested_coverage_dimensions: "
        + json.dumps(
            _format_dimension_labels(
                list(planning_coverage_hints.get("requested_coverage_dimensions", []))
            ),
            ensure_ascii=False,
        )
    )
    lines.append(
        "covered_coverage_dimensions: "
        + json.dumps(
            _format_dimension_labels(
                list(planning_coverage_hints.get("covered_coverage_dimensions", []))
            ),
            ensure_ascii=False,
        )
    )
    lines.append(
        "missing_coverage_dimensions: "
        + json.dumps(
            _format_dimension_labels(
                list(planning_coverage_hints.get("missing_coverage_dimensions", []))
            ),
            ensure_ascii=False,
        )
    )
    lines.append(
        "open_follow_up_signal_count: "
        + str(int(planning_coverage_hints.get("open_follow_up_signal_count", 0) or 0))
    )
    advisory_notes = planning_coverage_hints.get("advisory_notes", [])
    if isinstance(advisory_notes, list) and advisory_notes:
        lines.append("advisory_notes:")
        for note in advisory_notes:
            normalized_note = str(note or "").strip()
            if normalized_note:
                lines.append(f"  - {normalized_note}")
    return _render_context_section("PLANNING COVERAGE HINTS", lines)


def _build_rich_derived_context_text(
    *,
    latest_user_goal: str,
    latest_user_message: str,
    latest_kind: str,
    latest_language_hint: str,
    stage_summary_window: dict[str, Any],
    plan_inventory: dict[str, list[dict[str, Any]]],
    batch_inventory: list[dict[str, Any]],
    steering_history: list[dict[str, Any]],
    open_follow_up_signals: list[dict[str, Any]],
    response_opportunity_hints: dict[str, Any],
    review_opportunity_hints: dict[str, Any],
    planning_coverage_hints: dict[str, Any],
) -> str:
    sections = [
        _render_latest_user_context_text(
            latest_user_goal=latest_user_goal,
            latest_user_message=latest_user_message,
            latest_kind=latest_kind,
            latest_language_hint=latest_language_hint,
        ),
        _render_stage_summary_window_text(stage_summary_window),
        _render_plan_inventory_text(plan_inventory, planning_coverage_hints),
        _render_dispatch_batch_inventory_text(batch_inventory),
        _render_steering_history_text(steering_history),
        _render_open_follow_up_signals_text(open_follow_up_signals),
        _render_response_opportunity_hints_text(response_opportunity_hints),
        _render_review_opportunity_hints_text(review_opportunity_hints),
        _render_planning_coverage_hints_text(planning_coverage_hints),
    ]
    return "\n\n".join(section for section in sections if section.strip())


def extract_canonical_orchestrator_snapshot(context_text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    cleaned = str(context_text or "").strip()
    cursor = 0
    while cursor < len(cleaned):
        start = cleaned.find("{", cursor)
        if start < 0:
            break
        try:
            payload, offset = decoder.raw_decode(cleaned[start:])
        except json.JSONDecodeError:
            cursor = start + 1
            continue
        if isinstance(payload, dict):
            return payload
        cursor = start + offset
    raise ValueError("Unable to extract canonical JSON snapshot from orchestrator context.")


def build_orchestrator_context(run_state: RunState) -> str:
    current_turn = run_state.current_turn()
    latest_user_goal = ""
    if current_turn is not None and current_turn.goal.strip():
        latest_user_goal = current_turn.goal.strip()
    elif run_state.master_agent_state.current_goals:
        latest_user_goal = str(run_state.master_agent_state.current_goals[-1] or "").strip()
    latest_user_message = latest_user_authored_text(run_state.user_messages)
    active_plans = [
        plan.to_dict()
        for plan in run_state.plans
        if plan.status in {"analyzing", "summarizing"}
    ]
    pending_plans = [
        plan.to_dict()
        for plan in run_state.plans
        if plan.status in {"pending", "paused"}
    ]
    recent_signals = [
        entry.to_dict()
        for entry in run_state.timeline[-20:]
        if entry.entry_type in {
            "worker_finding_ready",
            "worker_status_updated",
            "dispatch_ready",
            "unprocessed_steering_ready",
            "post_emit_response_review_ready",
            "post_stage_summary_review_ready",
        }
    ]
    unsummarized_batches = [
        batch
        for batch in run_state.batches
        if batch.status in {"dispatched", "waiting_for_stage_summary"}
    ]
    unsummarized_plan_ids = [
        plan_id
        for batch in unsummarized_batches
        for plan_id in batch.plan_ids
    ]
    unsummarized_findings = [
        finding.to_dict()
        for finding in run_state.findings
        if finding.plan_id in unsummarized_plan_ids
    ]
    latest_message = _latest_user_message(run_state)
    latest_kind = _message_kind(latest_message)
    latest_language_hint = (
        "cjk_or_mixed" if contains_cjk_text(latest_user_message) else "non_cjk_or_english_like"
    )
    plan_inventory = _plan_inventory(run_state)
    batch_inventory = _dispatch_batch_inventory(run_state)
    steering_history = _steering_history(run_state)
    open_follow_up_signals = _open_follow_up_signals(run_state)
    response_opportunity_hints = _response_opportunity_hints(run_state)
    review_opportunity_hints = _review_opportunity_hints(run_state)
    planning_coverage_hints = _planning_coverage_hints(
        run_state,
        latest_user_goal=latest_user_goal,
    )
    stage_summary_window = _stage_summary_window(
        unsummarized_batches,
        run_state.findings,
    )
    payload = {
        "run_id": run_state.run_id,
        "status": run_state.status,
        "latest_user_goal": latest_user_goal,
        "latest_user_authored_message": latest_user_message,
        "settings": run_state.settings.to_dict(),
        "worker_availability": {
            "max_concurrency": run_state.settings.max_concurrency,
            "active_worker_count": len(active_plans),
            "active_plan_ids": [plan["plan_id"] for plan in active_plans],
        },
        "current_turn": current_turn.to_dict() if current_turn is not None else None,
        "active_plans": active_plans,
        "pending_plans": pending_plans,
        "plans": [plan.to_dict() for plan in run_state.plans],
        "findings": [finding.to_dict() for finding in run_state.findings],
        "unsummarized_evidence_window": {
            "dispatch_batches": [batch.to_dict() for batch in unsummarized_batches],
            "findings": unsummarized_findings,
        },
        "recent_runtime_signals": recent_signals,
        "turns": [turn.to_dict() for turn in run_state.turns],
        "steering_state": run_state.steering_state.to_dict(),
        "execution_control_state": run_state.execution_control_state.to_dict(),
        "artifacts": [artifact.to_dict() for artifact in getattr(run_state, "artifacts", [])],
        "timeline": [entry.to_dict() for entry in getattr(run_state, "timeline", [])],
        "derived_orchestration_context": {
            "LATEST USER CONTEXT": {
                "latest_user_goal": latest_user_goal,
                "latest_user_authored_message": latest_user_message,
                "latest_message_kind": latest_kind,
                "latest_language_hint": latest_language_hint,
            },
            "CURRENT STAGE SUMMARY WINDOW": stage_summary_window,
            "PLAN INVENTORY": plan_inventory,
            "DISPATCH BATCH INVENTORY": batch_inventory,
            "STEERING HISTORY": steering_history,
            "OPEN FOLLOW-UP SIGNALS": open_follow_up_signals,
            "RESPONSE OPPORTUNITY HINTS": response_opportunity_hints,
            "REVIEW OPPORTUNITY HINTS": review_opportunity_hints,
            "PLANNING COVERAGE HINTS": planning_coverage_hints,
        },
    }
    canonical_snapshot = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    rich_derived_context = _build_rich_derived_context_text(
        latest_user_goal=latest_user_goal,
        latest_user_message=latest_user_message,
        latest_kind=latest_kind,
        latest_language_hint=latest_language_hint,
        stage_summary_window=stage_summary_window,
        plan_inventory=plan_inventory,
        batch_inventory=batch_inventory,
        steering_history=steering_history,
        open_follow_up_signals=open_follow_up_signals,
        response_opportunity_hints=response_opportunity_hints,
        review_opportunity_hints=review_opportunity_hints,
        planning_coverage_hints=planning_coverage_hints,
    )
    return canonical_snapshot + "\n\n" + rich_derived_context


class _OrchestratorToolArgsBase(BaseModel):
    action_id: str | None = None
    rationale: str = ""
    consumed_steering_ids: list[str] = Field(default_factory=list)


class _WaitToolArgs(_OrchestratorToolArgsBase):
    reason: str


class _CreatePlansToolArgs(_OrchestratorToolArgsBase):
    plans: list[CreatePlanItemPayloadModel]


class _DispatchPlansToolArgs(_OrchestratorToolArgsBase):
    plan_ids: list[str]


class _EvaluateProgressToolArgs(_OrchestratorToolArgsBase):
    progress_digest: str
    dispatch_turn_index: int | None = None
    plan_ids: list[str] = Field(default_factory=list)


class _EmitResponseToolArgs(_OrchestratorToolArgsBase):
    response: str


class _EmitStageSynthesisToolArgs(_OrchestratorToolArgsBase):
    stage_synthesis: str
    dispatch_turn_index: int | None = None
    citations: Any = Field(default_factory=list)


class _EmitFinalReportToolArgs(_OrchestratorToolArgsBase):
    final_report: str
    dispatch_turn_index: int | None = None
    citations: Any = Field(default_factory=list)


_ORCHESTRATOR_TOOL_ARG_MODELS: dict[str, type[_OrchestratorToolArgsBase]] = {
    "wait": _WaitToolArgs,
    "create_plans": _CreatePlansToolArgs,
    "dispatch_plans": _DispatchPlansToolArgs,
    "evaluate_progress": _EvaluateProgressToolArgs,
    "emit_response": _EmitResponseToolArgs,
    "emit_stage_synthesis": _EmitStageSynthesisToolArgs,
    "emit_final_report": _EmitFinalReportToolArgs,
}


def _canonical_citation_item_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "marker": {"type": "integer", "minimum": 1},
            "target": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["summary", "atomic"],
                    },
                    "summary_id": {"type": "string"},
                    "summary_short_label": {"type": "string"},
                    "summary_text": {"type": "string"},
                    "columns": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "atomic_id": {"type": "string"},
                    "atomic_text": {"type": "string"},
                    "insight_type": {"type": "string"},
                    "evidence_refs": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "provenance_refs": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["kind", "summary_id"],
            },
            "label": {"type": "string"},
        },
        "required": ["marker", "target"],
    }


def _normalize_canonical_citations(raw_items: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_items, list):
        return []
    normalized: list[dict[str, Any]] = []
    seen_markers: set[int] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        try:
            citation = CanonicalCitationPayloadModel.model_validate(item)
        except ValidationError:
            continue
        if citation.marker in seen_markers:
            continue
        seen_markers.add(citation.marker)
        normalized.append(citation.model_dump())
    normalized.sort(key=lambda item: int(item.get("marker", 0)))
    return normalized


def _orchestrator_tool_specs() -> list[dict[str, Any]]:
    base_properties = {
        "action_id": {"type": "string"},
        "rationale": {"type": "string"},
        "consumed_steering_ids": {
            "type": "array",
            "items": {"type": "string"},
        },
    }
    return [
        {
            "type": "function",
            "function": {
                "name": "wait",
                "description": "Return to listening mode when no immediate orchestrator action is justified.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "reason": {"type": "string"},
                    },
                    "required": ["reason"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "create_plans",
                "description": "Create one or more concrete analysis plans.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "plans": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text": {"type": "string"},
                                    "source": {"type": "string"},
                                },
                                "required": ["text"],
                            },
                        },
                    },
                    "required": ["plans"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "dispatch_plans",
                "description": "Dispatch one or more runnable plans.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "plan_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["plan_ids"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "evaluate_progress",
                "description": "Evaluate the current evidence window and lifecycle state.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "progress_digest": {"type": "string"},
                        "dispatch_turn_index": {"type": "integer"},
                        "plan_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["progress_digest"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "emit_response",
                "description": "Emit a user-visible acknowledgement or progress explanation.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "response": {"type": "string"},
                    },
                    "required": ["response"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "emit_stage_synthesis",
                "description": "Emit an intermediate synthesis grounded in retained findings.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "stage_synthesis": {"type": "string"},
                        "dispatch_turn_index": {"type": "integer"},
                        "citations": {
                            "type": "array",
                            "items": _canonical_citation_item_schema(),
                        },
                    },
                    "required": ["stage_synthesis"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "emit_final_report",
                "description": "Emit the final report and finish the run.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        **base_properties,
                        "final_report": {"type": "string"},
                        "dispatch_turn_index": {"type": "integer"},
                        "citations": {
                            "type": "array",
                            "items": _canonical_citation_item_schema(),
                        },
                    },
                    "required": ["final_report"],
                },
            },
        },
    ]


def _parse_orchestrator_tool_message(
    message: Any,
) -> tuple[OrchestratorAction | None, str | None]:
    if not isinstance(message, AIMessage):
        return None, "structured_output_parsed_action_missing"
    tool_calls = list(getattr(message, "tool_calls", []) or [])
    if not tool_calls:
        return None, "structured_output_parsed_action_missing"

    tool_call = tool_calls[0]
    tool_name = str(tool_call.get("name", "") or "").strip()
    raw_args = dict(tool_call.get("args", {}) or {})
    if tool_name not in _ORCHESTRATOR_TOOL_ARG_MODELS:
        return None, f"structured_output_unknown_action_tool: {tool_name or '<empty>'}"

    try:
        validated_args = _ORCHESTRATOR_TOOL_ARG_MODELS[tool_name].model_validate(raw_args)
    except ValidationError as exc:
        return None, f"structured_output_parsing_error: {str(exc).strip() or exc.__class__.__name__}"

    payload: dict[str, Any]
    if tool_name == "wait":
        validated_args = _WaitToolArgs.model_validate(validated_args)
        payload = {"reason": validated_args.reason}
    elif tool_name == "create_plans":
        validated_args = _CreatePlansToolArgs.model_validate(validated_args)
        payload = {"plans": [item.model_dump() for item in validated_args.plans]}
    elif tool_name == "dispatch_plans":
        validated_args = _DispatchPlansToolArgs.model_validate(validated_args)
        payload = {"plan_ids": list(validated_args.plan_ids)}
    elif tool_name == "evaluate_progress":
        validated_args = _EvaluateProgressToolArgs.model_validate(validated_args)
        payload = {"progress_digest": validated_args.progress_digest}
        if validated_args.dispatch_turn_index is not None:
            payload["dispatch_turn_index"] = validated_args.dispatch_turn_index
        if validated_args.plan_ids:
            payload["plan_ids"] = list(validated_args.plan_ids)
    elif tool_name == "emit_response":
        validated_args = _EmitResponseToolArgs.model_validate(validated_args)
        payload = {"response": validated_args.response}
    elif tool_name == "emit_stage_synthesis":
        validated_args = _EmitStageSynthesisToolArgs.model_validate(validated_args)
        payload = {"stage_synthesis": validated_args.stage_synthesis}
        if validated_args.dispatch_turn_index is not None:
            payload["dispatch_turn_index"] = validated_args.dispatch_turn_index
        normalized_citations = _normalize_canonical_citations(validated_args.citations)
        if "citations" in raw_args or normalized_citations:
            payload["citations"] = normalized_citations
    elif tool_name == "emit_final_report":
        validated_args = _EmitFinalReportToolArgs.model_validate(validated_args)
        payload = {"final_report": validated_args.final_report}
        if validated_args.dispatch_turn_index is not None:
            payload["dispatch_turn_index"] = validated_args.dispatch_turn_index
        normalized_citations = _normalize_canonical_citations(validated_args.citations)
        if "citations" in raw_args or normalized_citations:
            payload["citations"] = normalized_citations
    else:
        return None, f"structured_output_unknown_action_tool: {tool_name}"

    parsed_output = {
        "action_id": validated_args.action_id or f"action_{tool_name}_{tool_call.get('id', '') or 'tool'}",
        "type": tool_name,
        "rationale": validated_args.rationale,
        "consumed_steering_ids": list(validated_args.consumed_steering_ids),
        "payload": payload,
    }
    try:
        return OrchestratorAction.model_validate(parsed_output), None
    except Exception as exc:
        return None, f"structured_output_action_coercion_failed: {str(exc).strip() or exc.__class__.__name__}"


class _ProviderCompatibleStructuredOutputModel:
    def __init__(self, *, bound_model: Any, parser: Callable[[Any], tuple[Any | None, str | None]]) -> None:
        self._bound_model = bound_model
        self._parser = parser

    def invoke(self, messages: list[Any]) -> dict[str, Any]:
        raw_message = self._bound_model.invoke(messages)
        parsed, parsing_error = self._parser(raw_message)
        tool_calls = list(getattr(raw_message, "tool_calls", []) or [])
        ignored_extra_tool_calls = [
            {
                "id": str(tool_call.get("id", "") or ""),
                "name": str(tool_call.get("name", "") or ""),
                "args": dict(tool_call.get("args", {}) or {}),
            }
            for tool_call in tool_calls[1:]
            if isinstance(tool_call, dict)
        ]
        return {
            "raw": raw_message,
            "parsed": parsed,
            "parsing_error": parsing_error,
            "ignored_extra_tool_calls": ignored_extra_tool_calls,
        }


class _ProviderCompatibleChatModelWrapper:
    def __init__(self, chat_model: Any) -> None:
        self._chat_model = chat_model

    def with_structured_output(self, schema: Any, **kwargs: Any) -> Any:
        if schema is OrchestratorAction:
            bound_model = self._chat_model.bind_tools(
                _orchestrator_tool_specs(),
                tool_choice="required",
            )
            return _ProviderCompatibleStructuredOutputModel(
                bound_model=bound_model,
                parser=_parse_orchestrator_tool_message,
            )
        return self._chat_model.with_structured_output(schema, **kwargs)


class OrchestratorAgent:
    def __init__(
        self,
        *,
        decision_provider: Callable[[RunState], OrchestratorAction] | None = None,
    ) -> None:
        self._decision_provider = decision_provider
        chat_model = build_langchain_chat_model(
            model_name=ORCHESTRATOR_MODEL_NAME,
            temperature=ORCHESTRATOR_TEMPERATURE,
            max_tokens=ORCHESTRATOR_MAX_TOKENS,
        )
        self._prompt = None
        self._structured_model = None
        if chat_model is not None:
            structured_chat_model = _ProviderCompatibleChatModelWrapper(chat_model)
            self._prompt = ChatPromptTemplate.from_messages(
                [
                    ("system", ORCHESTRATOR_SYSTEM_PROMPT),
                    ("system", "{augmentation_prompt}"),
                    ("human", "{state_snapshot}"),
                ]
            )
            self._structured_model = structured_chat_model.with_structured_output(
                OrchestratorAction,
                include_raw=True,
            )

    def decide(self, state: RunState, *, store: Any | None = None) -> OrchestratorAction:
        if self._decision_provider is not None:
            return self._decision_provider(state)
        if self._structured_model is not None and self._prompt is not None:
            try:
                base_messages = self._prompt.format_messages(
                    augmentation_prompt=_build_orchestrator_augmentation_prompt(),
                    state_snapshot=build_orchestrator_context(state),
                )
                raw_message = self._structured_model.invoke(base_messages)
                (
                    action,
                    parsed_output,
                    parsing_error,
                    validation_error,
                    ignored_extra_tool_calls,
                ) = self._coerce_validated_action(raw_message)
                self._persist_raw_output(
                    store,
                    state,
                    raw_message=raw_message,
                    parsed_output=parsed_output,
                    parsing_error=parsing_error,
                    validation_error=validation_error,
                    ignored_extra_tool_calls=ignored_extra_tool_calls,
                    final_outcome="accepted" if action is not None else "fallback",
                )
                if action is not None:
                    return action
            except Exception as exc:
                self._persist_invocation_error(store, state, exc, final_outcome="fallback")
        return self._fallback_decision(state)

    @staticmethod
    def _coerce_validated_action(
        result: Any,
    ) -> tuple[OrchestratorAction | None, dict[str, Any] | None, str | None, str | None, list[dict[str, Any]]]:
        ignored_extra_tool_calls: list[dict[str, Any]] = []
        if isinstance(result, dict):
            parsed = result.get("parsed")
            parsing_error = result.get("parsing_error")
            raw_ignored_extra_tool_calls = result.get("ignored_extra_tool_calls")
            if isinstance(raw_ignored_extra_tool_calls, list):
                ignored_extra_tool_calls = [
                    item for item in raw_ignored_extra_tool_calls if isinstance(item, dict)
                ]
            parsed_output = (
                parsed.model_dump()
                if isinstance(parsed, OrchestratorAction)
                else (parsed if isinstance(parsed, dict) else None)
            )
        else:
            parsed, parsing_error = _parse_orchestrator_tool_message(result)
            if isinstance(result, AIMessage):
                ignored_extra_tool_calls = [
                    {
                        "id": str(tool_call.get("id", "") or ""),
                        "name": str(tool_call.get("name", "") or ""),
                        "args": dict(tool_call.get("args", {}) or {}),
                    }
                    for tool_call in list(getattr(result, "tool_calls", []) or [])[1:]
                    if isinstance(tool_call, dict)
                ]
            parsed_output = parsed.model_dump() if isinstance(parsed, OrchestratorAction) else None
        if parsing_error is not None:
            return None, parsed_output, str(parsing_error).strip() or None, None, ignored_extra_tool_calls
        if parsed is None:
            return None, None, "structured_output_parsed_action_missing", None, ignored_extra_tool_calls
        try:
            action = parsed if isinstance(parsed, OrchestratorAction) else OrchestratorAction.model_validate(parsed)
        except Exception as exc:
            return None, parsed_output, None, f"structured_output_action_coercion_failed: {str(exc).strip() or exc.__class__.__name__}", ignored_extra_tool_calls
        _, validation_error = validate_orchestrator_action_shape(action)
        if validation_error is not None:
            return None, parsed_output, None, validation_error, ignored_extra_tool_calls
        return action, parsed_output, None, None, ignored_extra_tool_calls

    @staticmethod
    def _serialize_message(message: Any) -> dict[str, Any]:
        if isinstance(message, AIMessage):
            return message_to_dict(message)
        if hasattr(message, "model_dump"):
            return message.model_dump()
        return {
            "content": str(getattr(message, "content", "") or message or ""),
        }

    @staticmethod
    def _serialize_value(value: Any) -> Any:
        if value is None:
            return None
        if hasattr(value, "model_dump"):
            return value.model_dump()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return value

    @classmethod
    def _extract_provider_raw_payload(cls, message: Any) -> dict[str, Any] | None:
        if not isinstance(message, AIMessage):
            return None
        payload: dict[str, Any] = {}
        content = message.content
        if isinstance(content, str):
            payload["content"] = content
        elif content not in (None, []):
            payload["content"] = content
        additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
        if additional_kwargs:
            payload["additional_kwargs"] = additional_kwargs
        response_metadata = dict(getattr(message, "response_metadata", {}) or {})
        if response_metadata:
            payload["response_metadata"] = response_metadata
        return payload or None

    @classmethod
    def _extract_raw_output_text(cls, message: Any) -> str:
        provider_payload = cls._extract_provider_raw_payload(message)
        if provider_payload is not None:
            additional_kwargs = provider_payload.get("additional_kwargs")
            if isinstance(additional_kwargs, dict):
                raw_tool_calls = additional_kwargs.get("tool_calls")
                if raw_tool_calls:
                    return json.dumps(
                        {"tool_calls": raw_tool_calls},
                        ensure_ascii=False,
                        indent=2,
                        default=str,
                    )
            content = provider_payload.get("content")
            if isinstance(content, str) and content.strip():
                return content
            if content not in (None, [], ""):
                return json.dumps(content, ensure_ascii=False, indent=2, default=str)
        if isinstance(message, AIMessage):
            tool_calls = list(getattr(message, "tool_calls", []) or [])
            invalid_tool_calls = list(getattr(message, "invalid_tool_calls", []) or [])
            if tool_calls or invalid_tool_calls:
                return json.dumps(
                    {
                        "tool_calls_normalized": tool_calls,
                        "invalid_tool_calls_normalized": invalid_tool_calls,
                    },
                    ensure_ascii=False,
                    indent=2,
                    default=str,
                )
        return str(getattr(message, "content", "") or "").strip()

    def _persist_raw_output(
        self,
        store: Any | None,
        state: RunState,
        *,
        raw_message: Any,
        parsed_output: dict[str, Any] | None,
        parsing_error: str | None,
        validation_error: str | None = None,
        ignored_extra_tool_calls: list[dict[str, Any]] | None = None,
        final_outcome: str | None = None,
    ) -> None:
        if store is None:
            return
        payload = {
            "agent_name": "orchestrator",
            "model_name": ORCHESTRATOR_MODEL_NAME,
            "run_id": state.run_id,
            "loop_count": state.master_agent_state.loop_count + 1,
            "raw_output_text": self._extract_raw_output_text(raw_message),
            "provider_raw_payload": self._extract_provider_raw_payload(raw_message),
            "raw_message": self._serialize_message(raw_message),
            "parsed_output": self._serialize_value(parsed_output),
            "parsing_error": parsing_error,
            "validation_error": validation_error,
            "ignored_extra_tool_calls": list(ignored_extra_tool_calls or []),
            "ignored_extra_tool_call_count": len(ignored_extra_tool_calls or []),
            "final_outcome": final_outcome,
        }
        label = f"loop{state.master_agent_state.loop_count + 1:04d}"
        store.save_llm_output(
            "orchestrator",
            payload,
            label=label,
            metadata={
                "model_name": ORCHESTRATOR_MODEL_NAME,
                "final_outcome": final_outcome,
                "validation_error": validation_error,
            },
        )

    def _persist_invocation_error(
        self,
        store: Any | None,
        state: RunState,
        exc: Exception,
        *,
        final_outcome: str | None = None,
    ) -> None:
        if store is None:
            return
        label = f"loop{state.master_agent_state.loop_count + 1:04d}"
        store.save_llm_output(
            "orchestrator",
            {
                "agent_name": "orchestrator",
                "model_name": ORCHESTRATOR_MODEL_NAME,
                "run_id": state.run_id,
                "loop_count": state.master_agent_state.loop_count + 1,
                "raw_output_text": "",
                "provider_raw_payload": None,
                "raw_message": None,
                "parsed_output": None,
                "parsing_error": None,
                "invocation_error": str(exc).strip() or exc.__class__.__name__,
                "final_outcome": final_outcome,
            },
            label=f"{label}_error",
            metadata={
                "model_name": ORCHESTRATOR_MODEL_NAME,
                "error": True,
                "final_outcome": final_outcome,
            },
        )

    def _fallback_decision(self, state: RunState) -> OrchestratorAction:
        active = [plan for plan in state.plans if plan.status in {"analyzing", "summarizing"}]
        launch_priority = [
            plan.plan_id
            for plan in state.plans
            if plan.launch_requested and plan.status in {"pending", "paused"}
        ]
        pending = [plan for plan in state.plans if plan.status in {"pending", "paused"}]

        if launch_priority or pending:
            return OrchestratorAction(
                type="dispatch_plans",
                rationale=(
                    "Explicit launch controls should take priority before ordinary dispatch."
                    if launch_priority
                    else "Runnable pending or paused plans are available."
                ),
                payload={
                    "plan_ids": launch_priority + [
                        plan.plan_id
                        for plan in pending
                        if plan.plan_id not in launch_priority
                    ]
                },
            )

        if not state.plans and state.user_messages:
            latest = state.user_messages[-1]
            plan_text = latest.user_prompt or latest.display_text or latest.content
            return OrchestratorAction(
                type="create_plans",
                rationale="The run has no plans yet.",
                payload={"plans": [{"text": plan_text, "source": "user_goal"}]},
            )

        pending_stage_batches = [
            batch
            for batch in state.batches
            if batch.status == "waiting_for_stage_summary"
        ]
        if not active and not pending and pending_stage_batches:
            return OrchestratorAction(
                type="emit_stage_synthesis",
                rationale="The current unsummarized evidence window is stable enough for an intermediate synthesis.",
                payload={"stage_synthesis": self._fallback_stage_synthesis(state)},
            )

        if not active and not pending and state.plans and not state.final_summary.strip():
            return OrchestratorAction(
                type="emit_final_report",
                rationale="No active or pending plans remain.",
                payload={"final_report": self._fallback_final_report(state)},
            )

        return OrchestratorAction(
            type="wait",
            rationale="No immediate orchestrator action is justified.",
            payload={"reason": "waiting_for_signal"},
        )

    @staticmethod
    def _fallback_final_report(state: RunState) -> str:
        summaries = [insight.summary.strip() for insight in state.findings if insight.summary.strip()]
        if not summaries:
            return "No retained findings were produced."
        return "\n\n".join(summaries)

    @staticmethod
    def _fallback_stage_synthesis(state: RunState) -> str:
        summaries = [insight.summary.strip() for insight in state.findings if insight.summary.strip()]
        if not summaries:
            return "No stable intermediate findings are available yet."
        return "\n\n".join(summaries)
