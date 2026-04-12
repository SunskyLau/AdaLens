"""
Sub-agent wrapper around the reused analyzer + summarizer stack.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from config import ANALYZER_OPENAI_API_KEY, OPENAI_API_KEY
from .analyzer import Analyzer, AnalyzerRunResult
from .models import ExecutionRecord, PlanResumePhase, RunState, SubAgentResult, UserMessage
from .summarizer import Summarizer
from .store import RunStore


@dataclass
class SubAgentPlanStateUpdate:
    status: str
    control_state: str
    resume_phase: PlanResumePhase | None
    error_message: str | None = None
    final_summary: str | None = None


class SubAgent:
    def __init__(
        self,
        *,
        store: RunStore,
        analyzer: Analyzer | None = None,
        summarizer: Summarizer | None = None,
        phase_callback: Callable[[str, str], None] | None = None,
        control_callback: Callable[[], dict[str, Any]] | None = None,
    ):
        self.store = store
        self.analyzer = analyzer or Analyzer()
        self.summarizer = summarizer or Summarizer()
        self.phase_callback = phase_callback
        self.control_callback = control_callback

    def _current_control_state(self) -> str | None:
        if self.control_callback is None:
            return None
        try:
            snapshot = self.control_callback() or {}
        except Exception:
            return None
        if not isinstance(snapshot, dict):
            return None
        control_state = str(snapshot.get("control_state") or "").strip()
        if control_state in {"pause_requested", "terminate_requested", "yield_requested"}:
            return control_state
        return None

    @staticmethod
    def _control_action_from_state(control_state: str | None) -> str | None:
        if control_state == "pause_requested":
            return "pause"
        if control_state == "terminate_requested":
            return "terminate"
        if control_state == "yield_requested":
            return "yield"
        return None

    @staticmethod
    def _normalize_analyzer_result(
        result: ExecutionRecord | AnalyzerRunResult,
    ) -> tuple[ExecutionRecord | None, str | None, str | None, PlanResumePhase | None, Any | None]:
        if isinstance(result, AnalyzerRunResult):
            return (
                result.record,
                result.control_action,
                result.checkpoint_path,
                result.resume_phase,
                result.timestamp_binding,
            )
        return (result, None, None, None, None)

    @staticmethod
    def _drain_detached_task(task: asyncio.Task[Any]) -> None:
        try:
            task.result()
        except Exception:
            pass

    @staticmethod
    def derive_plan_state_update(plan: Any, result: SubAgentResult) -> SubAgentPlanStateUpdate:
        current_status = str(getattr(plan, "status", "") or "")
        current_resume_phase = getattr(plan, "resume_phase", None)
        inferred_resume_phase: PlanResumePhase | None
        if current_status == "summarizing":
            inferred_resume_phase = "summarizing"
        else:
            inferred_resume_phase = current_resume_phase or "analyzing"

        if result.control_action == "pause":
            return SubAgentPlanStateUpdate(
                status="paused",
                control_state="none",
                resume_phase=result.resume_phase or inferred_resume_phase,
            )
        if result.control_action == "yield":
            return SubAgentPlanStateUpdate(
                status="pending",
                control_state="yield_requested",
                resume_phase=result.resume_phase or inferred_resume_phase,
            )
        if result.control_action == "terminate":
            return SubAgentPlanStateUpdate(
                status="terminated",
                control_state="none",
                resume_phase=result.resume_phase or inferred_resume_phase,
            )
        if result.success and result.insight is None:
            return SubAgentPlanStateUpdate(
                status="failed",
                control_state="none",
                resume_phase=result.resume_phase or inferred_resume_phase,
                error_message="summarizer did not produce an insight",
            )
        if result.success:
            return SubAgentPlanStateUpdate(
                status="completed",
                control_state="none",
                resume_phase=result.resume_phase or inferred_resume_phase,
                final_summary=result.insight.summary if result.insight is not None else None,
            )
        return SubAgentPlanStateUpdate(
            status="failed",
            control_state="none",
            resume_phase=result.resume_phase or inferred_resume_phase,
            error_message=result.error,
        )

    @staticmethod
    def resume_phase_for_status(
        status: str,
        *,
        fallback: PlanResumePhase | None = None,
    ) -> PlanResumePhase:
        if status == "summarizing":
            return "summarizing"
        return fallback or "analyzing"

    @classmethod
    def resolve_resume_phase(
        cls,
        plan: Any,
        execution_records: list[ExecutionRecord],
    ) -> PlanResumePhase:
        resume_phase = getattr(plan, "resume_phase", None) or "analyzing"
        if resume_phase == "summarizing" and not any(
            record.plan_id == getattr(plan, "plan_id", "") and record.analysis_path
            for record in execution_records
        ):
            return "analyzing"
        return resume_phase  # type: ignore[return-value]

    @classmethod
    def derive_launch_state_update(
        cls,
        plan: Any,
        execution_records: list[ExecutionRecord],
    ) -> SubAgentPlanStateUpdate:
        resume_phase = cls.resolve_resume_phase(plan, execution_records)
        return SubAgentPlanStateUpdate(
            status="summarizing" if resume_phase == "summarizing" else "analyzing",
            control_state="none",
            resume_phase=resume_phase,
        )

    @classmethod
    def derive_phase_state_update(
        cls,
        plan: Any,
        next_status: str,
    ) -> SubAgentPlanStateUpdate:
        current_resume_phase = getattr(plan, "resume_phase", None)
        return SubAgentPlanStateUpdate(
            status=next_status,
            control_state=str(getattr(plan, "control_state", "none") or "none"),
            resume_phase=cls.resume_phase_for_status(
                next_status,
                fallback=current_resume_phase,
            ),
        )

    @staticmethod
    def is_midway_pending_plan(
        plan: Any,
        execution_records: list[ExecutionRecord],
    ) -> bool:
        if getattr(plan, "checkpoint_path", None):
            return True
        if getattr(plan, "resume_phase", None) == "summarizing":
            return True
        plan_id = getattr(plan, "plan_id", "")
        return any(record.plan_id == plan_id for record in execution_records)

    @staticmethod
    def can_auto_launch_plan_status(status: str) -> bool:
        """Only pending plans may be launched by automatic seat-fill/rebalance paths."""
        return status == "pending"

    @staticmethod
    def is_terminal_release_status(status: str) -> bool:
        return status in {"completed", "failed", "terminated"}

    @classmethod
    def should_trigger_pending_fill_for_transition(
        cls,
        *,
        previous_status: str | None,
        next_status: str,
    ) -> bool:
        """
        Pending seat-fill is event-driven and tied to release transitions only.

        Important: dispatch batch display order must not be rewritten due to these
        transitions. Scheduling decisions and display order are intentionally
        decoupled, so the UI can keep stable plan-area ordering.
        """
        _ = previous_status
        return cls.is_terminal_release_status(next_status)

    async def _run_summarizer_with_control(
        self,
        *,
        plan,
        record: ExecutionRecord,
        state: RunState,
    ) -> tuple[Any | None, str | None]:
        summarizer_task = asyncio.create_task(
            asyncio.to_thread(
                self.summarizer.summarize,
                plan=plan,
                record=record,
                store=self.store,
                dataset_schema=state.dataset_schema,
                user_messages=state.user_messages,
            ),
            name=f"summarize:{plan.plan_id}",
        )
        while not summarizer_task.done():
            control_state = self._current_control_state()
            if control_state is not None:
                summarizer_task.add_done_callback(self._drain_detached_task)
                return None, self._control_action_from_state(control_state)
            await asyncio.sleep(0.05)
        return await summarizer_task, None

    def _load_latest_execution_record(self, plan_id: str) -> ExecutionRecord | None:
        state = self.store.load_state()
        if state is None:
            return None
        for record in reversed(state.execution_records):
            if record.plan_id == plan_id:
                return record
        return None

    async def run(
        self,
        plan,
        dataset_info: dict[str, Any],
        *,
        resume_phase: PlanResumePhase | None = None,
        user_messages: list[UserMessage] | None = None,
    ) -> SubAgentResult:
        if not ANALYZER_OPENAI_API_KEY or not OPENAI_API_KEY:
            return SubAgentResult(
                plan_id=plan.plan_id,
                success=False,
                execution_records=[],
                insight=None,
                error="Analyzer or summarizer API credentials are not configured.",
            )

        state = RunState.create(
            dataset_path=str(dataset_info.get("dataset_path", "")),
            user_goal=plan.text,
        )
        state.dataset_info = dataset_info
        state.dataset_schema = str(dataset_info.get("dataset_schema", ""))
        state.user_messages = list(user_messages or [])

        checkpoint_path = getattr(plan, "checkpoint_path", None)
        effective_resume_phase = resume_phase or getattr(plan, "resume_phase", None)

        record: ExecutionRecord | None = None
        analyzer_checkpoint_path = checkpoint_path
        if effective_resume_phase == "summarizing":
            record = self._load_latest_execution_record(plan.plan_id)
            if record is None or not record.analysis_path:
                effective_resume_phase = "analyzing"

        if effective_resume_phase != "summarizing":
            analyzer_result = await asyncio.to_thread(
                self.analyzer.analyze,
                plan,
                state,
                self.store,
                self.control_callback,
                checkpoint_path,
            )
            (
                record,
                control_action,
                analyzer_checkpoint_path,
                analyzer_resume_phase,
                analyzer_timestamp_binding,
            ) = self._normalize_analyzer_result(
                analyzer_result
            )
            if control_action is not None:
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[],
                    insight=None,
                    error=None,
                    control_action=control_action,  # type: ignore[arg-type]
                    checkpoint_path=analyzer_checkpoint_path,
                    resume_phase=analyzer_resume_phase or "analyzing",
                    timestamp_binding=analyzer_timestamp_binding,
                )
        else:
            analyzer_timestamp_binding = None

        if record is None:
            return SubAgentResult(
                plan_id=plan.plan_id,
                success=False,
                execution_records=[],
                insight=None,
                error="Analyzer did not produce an execution record.",
                checkpoint_path=analyzer_checkpoint_path,
            )

        insight = None
        if record.success:
            pre_summary_control_state = self._current_control_state()
            if pre_summary_control_state is not None:
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[record],
                    insight=None,
                    error=None,
                    control_action=self._control_action_from_state(pre_summary_control_state),  # type: ignore[arg-type]
                    checkpoint_path=analyzer_checkpoint_path,
                    resume_phase="summarizing",
                )
            if self.phase_callback is not None:
                self.phase_callback(plan.plan_id, "summarizing")
            insight, summarizer_control_action = await self._run_summarizer_with_control(
                plan=plan,
                record=record,
                state=state,
            )
            consume_timestamp_binding = getattr(self.summarizer, "consume_timestamp_binding", None)
            summarizer_timestamp_binding = (
                consume_timestamp_binding()
                if callable(consume_timestamp_binding)
                else None
            )
            if summarizer_control_action is not None:
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[record],
                    insight=None,
                    error=None,
                    control_action=summarizer_control_action,  # type: ignore[arg-type]
                    checkpoint_path=analyzer_checkpoint_path,
                    resume_phase="summarizing",
                    timestamp_binding=summarizer_timestamp_binding,
                )
            post_summary_control_state = self._current_control_state()
            if post_summary_control_state is not None:
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[record],
                    insight=None,
                    error=None,
                    control_action=self._control_action_from_state(post_summary_control_state),  # type: ignore[arg-type]
                    checkpoint_path=analyzer_checkpoint_path,
                    resume_phase="summarizing",
                    timestamp_binding=summarizer_timestamp_binding,
                )
        else:
            summarizer_timestamp_binding = None

        return SubAgentResult(
            plan_id=plan.plan_id,
            success=record.success,
            execution_records=[record],
            insight=insight,
            error=record.error_message,
            checkpoint_path=analyzer_checkpoint_path,
            timestamp_binding=summarizer_timestamp_binding or analyzer_timestamp_binding,
        )
