from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from config import (
    INSIGHT_TAXONOMY_TYPES,
    SUMMARIZER_MAX_ATOMIC_INSIGHTS,
    SUMMARIZER_MAX_KEYWORDS,
)
from .analyzer_agent import AnalyzerAgent, AnalyzerExecutionResult
from .importance import calculate_atomic_insight_metrics
from .models import (
    ArtifactRecord,
    AtomicInsight,
    Insight,
    InsightEvidence,
    PlanItem,
    RunState,
    WorkerFinding,
    WorkerSessionState,
    normalize_keyword_list,
)
from .summarizer_agent import SummarizerAgent, SummarizerControlInterrupt


@dataclass
class WorkerSignal:
    kind: str
    plan_id: str
    finding_id: str | None = None
    checkpoint_ref: str | None = None


class WorkerRuntime:
    def __init__(
        self,
        *,
        store: Any,
        analyzer: AnalyzerAgent | None = None,
        summarizer: SummarizerAgent | None = None,
        progress_callback: Callable[[str], None] | None = None,
    ) -> None:
        self.store = store
        self.analyzer = analyzer or AnalyzerAgent()
        self.summarizer = summarizer or SummarizerAgent()
        self.progress_callback = progress_callback
        self._active_tasks: dict[str, asyncio.Task[Any]] = {}
        self._finished_signals: list[WorkerSignal] = []
        self._finished_results: list[tuple[str, Any]] = []

    def _log(self, message: str) -> None:
        if self.progress_callback is not None:
            self.progress_callback(message)

    def active_plan_ids(self) -> list[str]:
        return list(self._active_tasks.keys())

    def pop_finished_signals(self) -> list[WorkerSignal]:
        signals = list(self._finished_signals)
        self._finished_signals.clear()
        return signals

    def pop_finished_results(self) -> list[tuple[str, Any]]:
        results = list(self._finished_results)
        self._finished_results.clear()
        return results

    def dispatch(
        self,
        *,
        plan: PlanItem,
        run_state: RunState,
        control_callback: Callable[[], dict[str, Any]],
    ) -> None:
        if plan.plan_id in self._active_tasks:
            return
        self._log(
            f"[worker run={run_state.run_id}] schedule plan={plan.plan_id} "
            f"status={plan.status} resume_phase={plan.resume_phase or 'none'}"
        )
        task = asyncio.create_task(
            self.run_worker_async(
                plan=plan,
                run_state=run_state,
                control_callback=control_callback,
            ),
            name=f"worker:{plan.plan_id}",
        )
        self._active_tasks[plan.plan_id] = task

        def _on_done(completed: asyncio.Task[Any]) -> None:
            self._active_tasks.pop(plan.plan_id, None)
            try:
                payload = completed.result()
                if isinstance(payload, dict):
                    for signal in payload.get("signals", []) or []:
                        if isinstance(signal, WorkerSignal):
                            self._finished_signals.append(signal)
                    self._finished_results.append((plan.plan_id, payload.get("result")))
                else:
                    self._finished_results.append((plan.plan_id, payload))
            except Exception as exc:  # pragma: no cover
                self._log(
                    f"[worker plan={plan.plan_id}] task_error error={str(exc).strip() or '<unknown>'}"
                )
                self._finished_results.append((plan.plan_id, {"error": str(exc)}))

        task.add_done_callback(_on_done)

    async def _run_summarizer_with_control(
        self,
        *,
        plan: PlanItem,
        analysis_stream: str,
        execution_record: Any,
        run_state: RunState,
        control_callback: Callable[[], dict[str, Any]],
    ) -> tuple[WorkerFinding | None, str | None]:
        try:
            finding = await asyncio.to_thread(
                self.summarizer.summarize,
                plan=plan,
                analysis_stream=analysis_stream,
                execution_record=execution_record,
                store=self.store,
                user_messages=run_state.user_messages,
                control_callback=control_callback,
            )
        except SummarizerControlInterrupt as exc:
            return None, str(exc.control_action or "").strip() or None
        return finding, None

    async def run_worker_async(
        self,
        *,
        plan: PlanItem,
        run_state: RunState,
        control_callback: Callable[[], dict[str, Any]],
    ) -> Any:
        self._log(f"[worker run={run_state.run_id}] start plan={plan.plan_id} phase=analyzing")
        worker_context = WorkerSessionState.create(plan_id=plan.plan_id)
        initial_control = self._poll_control_action(control_callback)
        if initial_control in {"pause", "terminate"}:
            checkpoint_ref = self._checkpoint_worker_session(worker_context)
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action={initial_control} checkpoint={checkpoint_ref}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=checkpoint_ref,
                    )
                ],
                "result": AnalyzerExecutionResult(
                    control_action=initial_control,
                    checkpoint_path=checkpoint_ref,
                    resume_phase="analyzing",
                ),
            }

        run_state.dataset_metadata["plots_dir"] = str(self.store.plots_dir)
        analysis_result = await asyncio.to_thread(
            self.analyzer.analyze,
            plan=plan,
            state=run_state,
            store=self.store,
            worker_state=worker_context,
            prior_findings=run_state.findings,
            control_callback=control_callback,
            checkpoint_path=plan.checkpoint_path,
        )

        if analysis_result.control_action in {"pause", "terminate"}:
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action={analysis_result.control_action} checkpoint={analysis_result.checkpoint_path or '<none>'}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=analysis_result.checkpoint_path,
                    )
                ],
                "result": analysis_result,
            }

        self._log(
            f"[worker plan={plan.plan_id}] analysis_complete "
            f"records={len(analysis_result.execution_records)} error={bool(analysis_result.error)}"
        )
        latest_record = (
            analysis_result.execution_records[-1]
            if analysis_result.execution_records
            else None
        )
        if latest_record is not None:
            worker_context.artifact_refs.extend(
                [
                    path
                    for path in [
                        latest_record.code_path,
                        latest_record.stdout_path,
                        latest_record.stderr_path,
                        *latest_record.plot_paths,
                    ]
                    if path
                ]
            )

        between_phase_control = self._poll_control_action(control_callback)
        if between_phase_control in {"pause", "terminate"}:
            checkpoint_ref = self._checkpoint_worker_session(worker_context)
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action={between_phase_control} checkpoint={checkpoint_ref}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=checkpoint_ref,
                    )
                ],
                "result": AnalyzerExecutionResult(
                    control_action=between_phase_control,
                    checkpoint_path=checkpoint_ref,
                    resume_phase="summarizing",
                ),
            }

        if analysis_result.error:
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action=failed checkpoint={analysis_result.checkpoint_path or '<none>'}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=analysis_result.checkpoint_path,
                    )
                ],
                "result": analysis_result,
            }

        if latest_record is None:
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated action=no_execution_record"
            )
            return {
                "signals": [WorkerSignal(kind="worker_status_updated", plan_id=plan.plan_id)],
                "result": analysis_result,
            }

        worker_context.analysis_phase = "summarizing"
        latest_state = self.store.load_state()
        if latest_state is not None:
            latest_plan = latest_state.get_plan_by_id(plan.plan_id)
            if latest_plan is not None and latest_plan.status in {"analyzing", "pending", "paused"}:
                latest_plan.status = "summarizing"
                self.store.log_plan_status_changed(latest_plan)
                self.store.save_state(latest_state)

        self._log(f"[worker plan={plan.plan_id}] phase=summarizing start")
        finding, summarizer_control = await self._run_summarizer_with_control(
            plan=plan,
            analysis_stream=analysis_result.analysis_stream,
            execution_record=latest_record,
            run_state=run_state,
            control_callback=control_callback,
        )
        if summarizer_control in {"pause", "terminate"}:
            checkpoint_ref = self._checkpoint_worker_session(worker_context)
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action={summarizer_control} checkpoint={checkpoint_ref}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=checkpoint_ref,
                    )
                ],
                "result": AnalyzerExecutionResult(
                    control_action=summarizer_control,
                    checkpoint_path=checkpoint_ref,
                    resume_phase="summarizing",
                ),
            }
        if finding is None:
            return {
                "signals": [WorkerSignal(kind="worker_status_updated", plan_id=plan.plan_id)],
                "result": AnalyzerExecutionResult(
                    error="Summarizer did not return a finding.",
                    checkpoint_path=analysis_result.checkpoint_path,
                    resume_phase="summarizing",
                ),
            }

        post_summary_control = self._poll_control_action(control_callback)
        if post_summary_control in {"pause", "terminate"}:
            checkpoint_ref = self._checkpoint_worker_session(worker_context)
            self._log(
                f"[worker plan={plan.plan_id}] signal=worker_status_updated "
                f"action={post_summary_control} checkpoint={checkpoint_ref}"
            )
            return {
                "signals": [
                    WorkerSignal(
                        kind="worker_status_updated",
                        plan_id=plan.plan_id,
                        checkpoint_ref=checkpoint_ref,
                    )
                ],
                "result": AnalyzerExecutionResult(
                    control_action=post_summary_control,
                    checkpoint_path=checkpoint_ref,
                    resume_phase="summarizing",
                ),
            }

        persisted_finding = self._materialize_worker_finding(
            finding=finding,
            plan=plan,
            worker_context=worker_context,
            user_messages=run_state.user_messages,
        )
        self._log(
            f"[worker plan={plan.plan_id}] signal=worker_finding_ready "
            f"insight={persisted_finding.insight_id} short_label={persisted_finding.short_label or '<none>'}"
        )
        return {
            "signals": [
                WorkerSignal(
                    kind="worker_finding_ready",
                    plan_id=plan.plan_id,
                    finding_id=persisted_finding.insight_id,
                )
            ],
            "result": {
                "execution_records": analysis_result.execution_records,
                "insight": persisted_finding,
                "checkpoint_path": analysis_result.checkpoint_path,
            },
        }

    @staticmethod
    def _poll_control_action(control_callback: Callable[[], dict[str, Any]]) -> str | None:
        snapshot = control_callback() or {}
        state = str(snapshot.get("control_state", "") or "")
        if state == "pause_requested":
            return "pause"
        if state == "terminate_requested":
            return "terminate"
        return None

    def _checkpoint_worker_session(self, worker_context: WorkerSessionState) -> str:
        return self.store.save_analysis_checkpoint(
            worker_context.plan_id,
            worker_context.to_dict(),
        )

    def _materialize_worker_finding(
        self,
        *,
        finding: WorkerFinding,
        plan: PlanItem,
        worker_context: WorkerSessionState,
        user_messages: list[Any] | None,
    ) -> Insight:
        _ = worker_context
        summary = str(finding.summary or "").strip()
        short_label = str(finding.short_label or "").strip() or plan.short_label or "Finding"
        summary_keywords = normalize_keyword_list(
            list(finding.keywords or []),
            limit=SUMMARIZER_MAX_KEYWORDS,
        )
        atomics: list[AtomicInsight] = []
        for raw_atomic in list(finding.atomic_insights or [])[:SUMMARIZER_MAX_ATOMIC_INSIGHTS]:
            atomic_payload: dict[str, Any] | None = None
            if hasattr(raw_atomic, "model_dump"):
                atomic_payload = raw_atomic.model_dump()
            elif isinstance(raw_atomic, dict):
                atomic_payload = raw_atomic
            if atomic_payload is None:
                continue
            evidence_raw = atomic_payload.get("evidence", {})
            evidence = InsightEvidence.from_dict(
                evidence_raw if isinstance(evidence_raw, dict) else {}
            )
            if evidence is None:
                continue
            insight_type = str(atomic_payload.get("insight_type", "") or "").strip()
            if insight_type not in INSIGHT_TAXONOMY_TYPES:
                continue
            atomic = AtomicInsight.create(
                text=str(atomic_payload.get("text", "") or "").strip(),
                insight_type=insight_type,  # type: ignore[arg-type]
                evidence=evidence,
                columns=[
                    str(item)
                    for item in atomic_payload.get("columns", []) or []
                    if str(item)
                ],
                keywords=normalize_keyword_list(
                    atomic_payload.get("keywords"),
                    limit=SUMMARIZER_MAX_KEYWORDS,
                ),
            )
            calculate_atomic_insight_metrics(
                atomic=atomic,
                plan=plan,
                store=self.store,
                user_messages=list(user_messages or []),
            )
            atomics.append(atomic)

        insight = Insight.create(
            plan_id=plan.plan_id,
            summary=summary or (atomics[0].text if atomics else "No stable finding was extracted."),
            atomic_insights=atomics,
            short_label=short_label,
            keywords=summary_keywords,
            parent_insight_id=plan.parent_insight_id,
        )
        finding_path = self.store.save_worker_finding(plan.plan_id, insight)
        self.store.append_artifact_record(
            ArtifactRecord.create(
                type="worker_finding",
                path_or_uri=finding_path,
                owner_refs=[plan.plan_id, insight.insight_id],
            )
        )
        return insight
