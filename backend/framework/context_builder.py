"""
Turn-based context builder for master-agent decisions.

Builds a two-message prompt (system + user) from RunState. The user message
is organized by turn so the LLM sees its full history of actions, with no
truncation of plans, insights, or atomic insights.
"""

from __future__ import annotations

import json
from typing import Any

from cache_normalization import build_dataset_identity, iter_state_insights_in_stable_order

from .language_context import (
    canonical_user_message_text,
    latest_user_authored_message,
    natural_language_target_label,
    strict_language_match_instruction,
)
from .models import (
    PlanItem,
    RunState,
    SteeringTargetSnapshot,
    TimelineEntry,
    Turn,
    normalize_steering_message_kind,
)
from .summary_window import (
    latest_summary_boundary_dispatch_turn_index,
    stage_summary_scope_batches,
)


class ContextBuilder:

    def __init__(self) -> None:
        pass  # No truncation parameters; everything is shown in full.

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build_system_context(self, state: RunState) -> str:
        """Static dataset context."""
        info = state.dataset_info or {}
        lines = ["Dataset Overview"]
        lines.append(
            f"dataset_identity: {build_dataset_identity(state.dataset_path, info)}"
        )
        lines.append(f"rows: {info.get('rows', 'unknown')}")
        lines.append("columns:")
        lines.append(json.dumps(info.get("columns", []), ensure_ascii=False))
        if "sample_rows" in info:
            lines.append("sample_rows:")
            lines.append(json.dumps(info.get("sample_rows", []), ensure_ascii=False))
        return "\n".join(lines)

    def build_user_prompt(self, state: RunState) -> str:
        """Dynamic prompt organized by turn with explicit steering history."""
        sections: list[str] = [self._build_latest_user_language_context(state)]
        sections.append(self._build_stage_summary_window(state))

        for turn in state.turns:
            if turn.status == "completed":
                sections.append(self._format_turn(turn, state))

        for turn in state.turns:
            if turn.status == "running":
                sections.append(self._format_turn(turn, state))

        sections.append(self._build_steering_history(state))
        sections.append(self._build_open_steering_follow_ups(state))
        sections.append(self._build_full_state(state))
        return "\n\n".join(sections)

    def has_open_steering_follow_up(self, state: RunState) -> bool:
        return bool(self._open_steering_follow_up_entries(state))

    def _build_latest_user_language_context(self, state: RunState) -> str:
        lines = ["== LATEST USER MESSAGE FOR LANGUAGE MATCHING =="]
        message = latest_user_authored_message(state.user_messages)
        if message is None:
            lines.append(strict_language_match_instruction(""))
            lines.append("- <none>")
            return "\n".join(lines)

        canonical_text = canonical_user_message_text(message)
        kind = normalize_steering_message_kind(message.kind) or "chat"
        lines.append(f"target_language: {natural_language_target_label(canonical_text)}")
        lines.append(strict_language_match_instruction(canonical_text))
        lines.append(f"kind: {kind}")
        lines.append(f"text: {canonical_text}")
        return "\n".join(lines)

    def _build_stage_summary_window(self, state: RunState) -> str:
        lines = ["== CURRENT STAGE SUMMARY WINDOW =="]
        scope_batches = stage_summary_scope_batches(state)
        if not scope_batches:
            lines.append("- <none>")
            return "\n".join(lines)

        boundary_dispatch_turn_index = latest_summary_boundary_dispatch_turn_index(state)
        lines.append(
            "The next stage summary must cover every retained finding in this unsummarized window, "
            "not only the latest completed dispatch batch."
        )
        lines.append(
            "summary_boundary_dispatch_turn_index: "
            + (
                str(boundary_dispatch_turn_index)
                if boundary_dispatch_turn_index is not None
                else "<none>"
            )
        )
        lines.append(
            "unsummarized_dispatch_turn_indexes: "
            + json.dumps([batch.dispatch_turn_index for batch in scope_batches])
        )
        insights_by_plan_id = self._ordered_insight_by_plan_id(state)
        for batch in scope_batches:
            lines.append(
                f"- dispatch_turn_index={batch.dispatch_turn_index} plan_ids={batch.plan_ids}"
            )
            for plan_id in batch.plan_ids:
                insight = insights_by_plan_id.get(plan_id)
                if insight is None:
                    lines.append(f"    - {plan_id} -> summary_ids=[]")
                    continue
                lines.append(
                    f"    - {plan_id} -> summary_id={insight.insight_id!r} summary={insight.summary!r}"
                )
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Turn formatting
    # ------------------------------------------------------------------

    def _format_turn(self, turn: Turn, state: RunState) -> str:
        tag = "COMPLETED" if turn.status == "completed" else "RUNNING"
        lines = [f"== TURN {turn.turn_id} ({tag}) =="]
        lines.append(f"Goal: {turn.goal!r}")

        if turn.steers:
            lines.append("User steers:")
            for steer in turn.steers:
                lines.append(f"  - {steer!r}")

        if turn.timeline:
            lines.append("Timeline:")
            for entry in self._timeline_entries_for_prompt(turn.timeline, state):
                lines.append(f"  [{entry.entry_type}] {self._format_content(entry.content)}")

        if turn.status == "completed" and turn.final_summary:
            lines.append(f"Final summary: {turn.final_summary!r}")

        return "\n".join(lines)

    @staticmethod
    def _format_content(content: Any) -> str:
        sanitized = ContextBuilder._sanitize_prompt_content(content)
        if sanitized is None:
            return ""
        if isinstance(sanitized, str):
            return sanitized
        if isinstance(sanitized, (dict, list)):
            return json.dumps(sanitized, ensure_ascii=False, default=str)
        return str(sanitized)

    @staticmethod
    def _sanitize_prompt_content(content: Any) -> Any:
        if content is None:
            return None
        if isinstance(content, dict):
            sanitized: dict[str, Any] = {}
            for key, value in content.items():
                if str(key) == "message_id":
                    continue
                sanitized[str(key)] = ContextBuilder._sanitize_prompt_content(value)
            return sanitized
        if isinstance(content, list):
            return [ContextBuilder._sanitize_prompt_content(item) for item in content]
        if isinstance(content, tuple):
            return [ContextBuilder._sanitize_prompt_content(item) for item in content]
        if content is None:
            return ""
        return content

    @staticmethod
    def _plan_prompt_order_map(state: RunState) -> dict[str, int]:
        return {
            plan.plan_id: index
            for index, plan in enumerate(state.plans, start=1)
            if plan.plan_id
        }

    def _timeline_entries_for_prompt(
        self,
        entries: list[TimelineEntry],
        state: RunState,
    ) -> list[TimelineEntry]:
        plan_order = self._plan_prompt_order_map(state)
        sortable_types = {"plans_completed", "plan_failed", "plan_terminated"}
        stabilized: list[TimelineEntry] = []
        index = 0
        while index < len(entries):
            entry = entries[index]
            if entry.entry_type not in sortable_types:
                stabilized.append(entry)
                index += 1
                continue
            block: list[TimelineEntry] = []
            while index < len(entries) and entries[index].entry_type in sortable_types:
                block.append(entries[index])
                index += 1
            stabilized.extend(
                sorted(
                    block,
                    key=lambda item: self._timeline_plan_entry_sort_key(item, plan_order),
                )
            )
        return stabilized

    @staticmethod
    def _timeline_plan_entry_sort_key(
        entry: TimelineEntry,
        plan_order: dict[str, int],
    ) -> tuple[Any, ...]:
        content = entry.content if isinstance(entry.content, dict) else {}
        plan_id = str(content.get("plan_id", "") or "").strip()
        return (
            {
                "plans_completed": 0,
                "plan_failed": 1,
                "plan_terminated": 2,
            }.get(entry.entry_type, 99),
            plan_order.get(plan_id, len(plan_order) + 1),
            plan_id,
            str(content.get("plan_text", "") or ""),
            str(content.get("insight_summary", "") or ""),
            str(content.get("error", "") or ""),
        )

    @staticmethod
    def _ordered_insights(state: RunState) -> list[Any]:
        return iter_state_insights_in_stable_order(state)

    def _ordered_insight_by_plan_id(self, state: RunState) -> dict[str, Any]:
        ordered: dict[str, Any] = {}
        for insight in self._ordered_insights(state):
            plan_id = str(getattr(insight, "plan_id", "") or "").strip()
            if plan_id and plan_id not in ordered:
                ordered[plan_id] = insight
        return ordered

    def _build_steering_history(self, state: RunState) -> str:
        lines = ["== STEERING HISTORY =="]
        lines.append("If steering actions conflict, follow the latest action.")
        follow_up_status_by_message_id = self._steering_follow_up_status_by_message_id(state)
        steering_messages = [
            message
            for message in state.user_messages
            if normalize_steering_message_kind(message.kind) in {"focus", "ignore", "elaborate", "create"}
        ]
        if not steering_messages:
            lines.append("- <none>")
            return "\n".join(lines)

        for message in steering_messages:
            kind = normalize_steering_message_kind(message.kind) or "chat"
            user_prompt = message.user_prompt or message.generated_prompt or message.content
            lines.append(
                f"- {kind.upper()} "
                f"{self._format_steering_target(message.target)}"
            )
            if message.display_text:
                lines.append(f"  display_text: {message.display_text}")
            if message.selected_keywords:
                lines.append(f"  selected_keywords: {message.selected_keywords}")
            lines.append(f"  user_prompt: {user_prompt}")
            if message.system_prompt:
                lines.append(f"  system_prompt: {message.system_prompt}")
            follow_up_status = follow_up_status_by_message_id.get(message.message_id)
            if kind != "create" and follow_up_status is not None:
                lines.append(
                    "  follow_up_plan_create_recorded: "
                    + str(bool(follow_up_status.get("recorded")))
                )
                created_plan_ids = follow_up_status.get("created_plan_ids", [])
                if created_plan_ids:
                    lines.append(f"  follow_up_created_plan_ids: {created_plan_ids}")
        return "\n".join(lines)

    def _build_open_steering_follow_ups(self, state: RunState) -> str:
        lines = ["== OPEN STEERING FOLLOW-UPS =="]
        open_entries = self._open_steering_follow_up_entries(state)
        if not open_entries:
            lines.append("- <none>")
            return "\n".join(lines)

        lines.append(
            "You may emit evaluate_progress before handling these if a stage summary is justified now, "
            "but do not mark_complete until each open steering below has been addressed by a later create_plans call."
        )
        for item in open_entries:
            turn_id = item["turn_id"]
            kind = item["kind"]
            content = item["content"]
            lines.append(
                f"- TURN {turn_id} {kind.upper()} "
                f"{self._format_steering_target(self._coerce_target_snapshot(content.get('target')))}"
            )
            display_text = str(content.get("display_text", "") or "").strip()
            if display_text:
                lines.append(f"  display_text: {display_text}")
            selected_keywords = [
                str(keyword).strip()
                for keyword in content.get("selected_keywords", []) or []
                if str(keyword).strip()
            ]
            if selected_keywords:
                lines.append(f"  selected_keywords: {selected_keywords}")
            user_prompt = str(
                content.get("user_prompt")
                or content.get("generated_prompt")
                or content.get("content")
                or ""
            ).strip()
            if user_prompt:
                lines.append(f"  user_prompt: {user_prompt}")
        return "\n".join(lines)

    @staticmethod
    def _coerce_target_snapshot(target: Any) -> SteeringTargetSnapshot | None:
        if isinstance(target, SteeringTargetSnapshot):
            return target
        if isinstance(target, dict):
            return SteeringTargetSnapshot.from_dict(target)
        return None

    def _steering_follow_up_status_by_message_id(
        self,
        state: RunState,
    ) -> dict[str, dict[str, Any]]:
        status_by_message_id: dict[str, dict[str, Any]] = {}
        for item in self._iter_non_create_steering_entries(state):
            message_id = str(item["content"].get("message_id", "")).strip()
            if not message_id:
                continue
            status_by_message_id[message_id] = {
                "recorded": item["recorded"],
                "created_plan_ids": list(item["created_plan_ids"]),
                "turn_id": item["turn_id"],
            }
        return status_by_message_id

    def _open_steering_follow_up_entries(
        self,
        state: RunState,
    ) -> list[dict[str, Any]]:
        current_turn = state.current_turn()
        if current_turn is None or current_turn.status != "running":
            return []
        return [
            item
            for item in self._iter_non_create_steering_entries_in_turn(current_turn)
            if not item["recorded"]
        ]

    def _iter_non_create_steering_entries(
        self,
        state: RunState,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for turn in state.turns:
            items.extend(self._iter_non_create_steering_entries_in_turn(turn))
        return items

    def _iter_non_create_steering_entries_in_turn(
        self,
        turn: Turn,
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for entry in turn.timeline:
            if entry.entry_type != "user_steer" or not isinstance(entry.content, dict):
                continue
            kind = normalize_steering_message_kind(entry.content.get("kind")) or "chat"
            if kind == "create":
                continue
            created_plan_ids = [
                str(plan_id).strip()
                for plan_id in entry.content.get("follow_up_created_plan_ids", []) or []
                if str(plan_id).strip()
            ]
            items.append(
                {
                    "turn_id": turn.turn_id,
                    "kind": kind,
                    "content": entry.content,
                    "recorded": bool(entry.content.get("follow_up_plan_create_recorded")),
                    "created_plan_ids": created_plan_ids,
                }
            )
        return items

    @staticmethod
    def _format_steering_target(target: SteeringTargetSnapshot | None) -> str:
        if target is None:
            return "<no target>"
        if target.kind == "column":
            return f"target=column columns={target.columns}"
        summary_label = target.summary_short_label or target.summary_id or "<summary>"
        if target.kind == "atomic":
            atomic_label = target.atomic_text or target.atomic_id or "<atomic>"
            return (
                f"target=atomic summary={summary_label!r} atomic={atomic_label!r} "
                f"columns={target.columns}"
            )
        return f"target=summary summary={summary_label!r} columns={target.columns}"

    # ------------------------------------------------------------------
    # Full-state snapshot (plans, insights)
    # ------------------------------------------------------------------

    def _build_full_state(self, state: RunState) -> str:
        sections: list[str] = ["== CURRENT FULL STATE =="]
        sections.append(self._build_plans_section(state))
        sections.append(self._build_dispatch_batches_section(state))
        sections.append(self._build_insights_section(state))
        return "\n".join(sections)

    def _build_plans_section(self, state: RunState) -> str:
        running = [p for p in state.plans if p.status in {"analyzing", "summarizing"}]
        pending = [p for p in state.plans if p.status == "pending"]
        completed = [p for p in state.plans if p.status == "completed"]
        failed = [p for p in state.plans if p.status == "failed"]
        insights_by_plan_id = self._ordered_insight_by_plan_id(state)

        total = len(state.plans)
        lines = [f"### All Plans ({total} total)"]

        lines.append("Running:")
        if running:
            for plan in running:
                lines.append(f"  - {plan.plan_id}: {plan.text} ({plan.status})")
        else:
            lines.append("  - <none>")

        lines.append("Pending:")
        if pending:
            for plan in pending:
                lines.append(f"  - {plan.plan_id}: {plan.text}")
        else:
            lines.append("  - <none>")

        if completed:
            lines.append(f"Completed ({len(completed)}):")
            for plan in completed:
                summary = self._plan_insight_summary(plan, insights_by_plan_id)
                lines.append(f"  - {plan.plan_id}: {plan.text} -> {summary}")

        if failed:
            lines.append(f"Failed ({len(failed)}):")
            for plan in failed:
                lines.append(
                    f"  - {plan.plan_id}: {plan.text} -> ERROR: {plan.error_message or 'unknown'}"
                )

        return "\n".join(lines)

    @staticmethod
    def _plan_insight_summary(plan: PlanItem, insights_by_plan_id: dict[str, Any]) -> str:
        insight = insights_by_plan_id.get(plan.plan_id)
        if insight and insight.summary:
            return insight.summary
        return plan.final_summary or "<no summary>"

    def _build_dispatch_batches_section(self, state: RunState) -> str:
        batches = state.master_agent_state.dispatch_batches
        if not batches:
            return "### Dispatch Batches (storyline turns)\n  - <none>"

        insights_by_plan_id: dict[str, list[str]] = {}
        for insight in self._ordered_insights(state):
            insights_by_plan_id.setdefault(insight.plan_id, []).append(insight.insight_id)

        lines = [f"### Dispatch Batches ({len(batches)} total storyline turns)"]
        for batch in batches:
            lines.append(
                f"  - dispatch_turn_index={batch.dispatch_turn_index} "
                f"status={batch.status} plan_ids={batch.plan_ids}"
            )
            for plan_id in batch.plan_ids:
                summary_ids = insights_by_plan_id.get(plan_id, [])
                if summary_ids:
                    lines.append(f"      - {plan_id} -> summary_ids={summary_ids}")
                else:
                    lines.append(f"      - {plan_id} -> summary_ids=[]")
            if batch.stage_summary_markdown:
                lines.append(
                    f"      stage_summary_markdown={json.dumps(batch.stage_summary_markdown, ensure_ascii=False)}"
                )
            if batch.stage_summary_citations:
                citation_parts = [
                    f"[[{citation.marker}]]=>{self._format_steering_target(citation.target)}"
                    for citation in batch.stage_summary_citations
                ]
                lines.append(f"      stage_summary_citations={citation_parts}")
        return "\n".join(lines)

    def _build_insights_section(self, state: RunState) -> str:
        if not state.insights:
            return "### All Insights (0 total, 0 atomic findings)\n  - <none>"

        total_atomic = state.total_atomic_insights()
        lines = [f"### All Insights ({len(state.insights)} total, {total_atomic} atomic findings)"]
        for insight in self._ordered_insights(state):
            lines.append(
                f"  - [summary_id={insight.insight_id}] [plan_id={insight.plan_id}] "
                f"label={insight.short_label!r} keywords={insight.keywords} summary={insight.summary!r}"
            )
            for atomic in insight.atomic_insights:
                lines.append(
                    f"      - [atomic_id={atomic.atomic_id}] [{atomic.insight_type}] "
                    f"columns={atomic.columns} keywords={atomic.keywords} text={atomic.text!r}"
                )
        return "\n".join(lines)
