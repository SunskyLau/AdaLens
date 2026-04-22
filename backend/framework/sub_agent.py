from __future__ import annotations

from typing import Any, Callable

from .analyzer_agent import AnalyzerAgent
from .models import PlanResumePhase, RunState, SubAgentResult, UserMessage
from .persistence import RunStore
from .summarizer_agent import SummarizerAgent
from .worker_runtime import WorkerRuntime


class SubAgent:
    def __init__(
        self,
        *,
        store: RunStore,
        analyzer: AnalyzerAgent | None = None,
        summarizer: SummarizerAgent | None = None,
        phase_callback: Callable[[str, str], None] | None = None,
        control_callback: Callable[[], dict[str, Any]] | None = None,
    ):
        self.store = store
        self.phase_callback = phase_callback
        self.control_callback = control_callback or (lambda: {})
        self.worker_runtime = WorkerRuntime(
            store=store,
            analyzer=analyzer or AnalyzerAgent(),
            summarizer=summarizer or SummarizerAgent(),
        )

    async def run(
        self,
        plan,
        dataset_info: dict[str, Any],
        *,
        resume_phase: PlanResumePhase | None = None,
        user_messages: list[UserMessage] | None = None,
    ) -> SubAgentResult:
        state = RunState.create(
            dataset_path=str(dataset_info.get("dataset_path", "")),
            user_goal=plan.text,
        )
        state.dataset_metadata = dict(dataset_info)
        state.dataset_schema = str(dataset_info.get("dataset_schema", ""))
        state.user_messages = list(user_messages or [])
        if resume_phase is not None:
            plan.resume_phase = resume_phase
        result = await self.worker_runtime.run_worker_async(
            plan=plan,
            run_state=state,
            control_callback=self.control_callback,
        )
        if isinstance(result, dict):
            worker_result = result.get("result")
            if isinstance(worker_result, dict):
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=worker_result.get("insight") is not None,
                    execution_records=list(worker_result.get("execution_records", []) or []),
                    insight=worker_result.get("insight"),
                    checkpoint_path=worker_result.get("checkpoint_path"),
                )
            if hasattr(worker_result, "control_action"):
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=list(getattr(worker_result, "execution_records", []) or []),
                    error=getattr(worker_result, "error", None),
                    control_action=getattr(worker_result, "control_action", None),
                    checkpoint_path=getattr(worker_result, "checkpoint_path", None),
                    resume_phase=getattr(worker_result, "resume_phase", None),
                )
            return SubAgentResult(
                plan_id=plan.plan_id,
                success=False,
                execution_records=[],
                error="Worker runtime returned an unexpected payload shape.",
            )
        if hasattr(result, "control_action"):
            return SubAgentResult(
                plan_id=plan.plan_id,
                success=False,
                execution_records=list(getattr(result, "execution_records", []) or []),
                error=getattr(result, "error", None),
                control_action=getattr(result, "control_action", None),
                checkpoint_path=getattr(result, "checkpoint_path", None),
                resume_phase=getattr(result, "resume_phase", None),
            )
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=False,
            execution_records=[],
            error="Worker runtime did not return a result.",
        )
