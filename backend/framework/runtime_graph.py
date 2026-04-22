from __future__ import annotations

import asyncio
import csv
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import StateGraph

from config import (
    CREATE_PLANS_REPLAY_ENV,
    DEFAULT_MAX_INITIAL_PLANS,
    RUN_CONTROL_STOP_FILE,
    set_stable_llm_output_enabled,
)
from .csv_utils import sniff_csv_delimiter_from_text
from .input_mapping import map_plan_control_payload, map_user_message_to_runtime_input, read_jsonl_since
from .models import (
    CreatePlansPayloadModel,
    DispatchPlansPayloadModel,
    EmitFinalReportPayloadModel,
    EmitResponsePayloadModel,
    EmitStageSynthesisPayloadModel,
    EvaluateProgressPayloadModel,
    ExecutionControlRequest,
    OrchestratorAction,
    PlanItem,
    ProvenanceCitation,
    RunSettings,
    RunState,
    SteeringRequest,
    TimelineEntry,
    Turn,
    UserMessage,
    WaitPayloadModel,
    DispatchBatchState,
    validate_orchestrator_action_shape,
)
from .orchestrator_agent import OrchestratorAgent
from .persistence import RunStore
from .worker_runtime import WorkerRuntime


@dataclass
class RuntimeInputApplicationSummary:
    has_inputs: bool = False
    should_wake_orchestrator: bool = False

    def merge(self, other: "RuntimeInputApplicationSummary") -> "RuntimeInputApplicationSummary":
        self.has_inputs = self.has_inputs or other.has_inputs
        self.should_wake_orchestrator = (
            self.should_wake_orchestrator or other.should_wake_orchestrator
        )
        return self


@dataclass
class RuntimeGraph:
    store: RunStore
    settings: RunSettings
    orchestrator: OrchestratorAgent
    worker_runtime: WorkerRuntime
    max_initial_plans: int = DEFAULT_MAX_INITIAL_PLANS
    create_plans_replay_enabled: bool = False
    progress_callback: Callable[[str], None] | None = None

    def __post_init__(self) -> None:
        self.state: RunState | None = None
        self._steer_offset = 0
        self._plan_control_offset = 0
        self._initial_wake_pending = True
        self._pending_runtime_inputs: list[SteeringRequest | ExecutionControlRequest] = []
        self._pending_internal_signals: list[dict[str, Any]] = []
        self._last_action: OrchestratorAction | None = None
        self._finalize_pending = False
        if not self.create_plans_replay_enabled:
            self.create_plans_replay_enabled = (
                os.environ.get(CREATE_PLANS_REPLAY_ENV, "").strip() == "1"
            )
        if getattr(self.worker_runtime, "progress_callback", None) is None:
            self.worker_runtime.progress_callback = self.progress_callback

    def _log(self, message: str) -> None:
        if self.progress_callback is not None:
            self.progress_callback(message)

    def _run_tag(self) -> str:
        if self.state is not None and self.state.run_id:
            return self.state.run_id
        return self.store.run_id

    def _sync_runtime_settings_from_state(self) -> None:
        if self.state is None:
            return
        self.settings.max_concurrency = self.state.settings.max_concurrency
        self.settings.stable_llm_output = self.state.settings.stable_llm_output
        self.settings.poll_interval_seconds = self.state.settings.poll_interval_seconds
        set_stable_llm_output_enabled(self.settings.stable_llm_output)

    @staticmethod
    def _truncate(text: str, limit: int = 160) -> str:
        normalized = " ".join(text.split())
        if len(normalized) <= limit:
            return normalized
        return normalized[: max(0, limit - 3)].rstrip() + "..."

    def _log_action(self, action: OrchestratorAction) -> None:
        rationale = self._truncate(action.rationale or "<none>", limit=220)
        payload = action.payload or {}
        detail = ""
        if action.type == "emit_response":
            detail = f" response={self._truncate(str(payload.get('response', '')), 120)!r}"
        elif action.type == "create_plans":
            plan_count = len(payload.get("plans", []) or [])
            detail = f" requested_plans={plan_count}"
        elif action.type == "dispatch_plans":
            plan_ids = [str(item) for item in payload.get("plan_ids", []) or [] if str(item)]
            detail = f" plan_ids={plan_ids}"
        elif action.type == "evaluate_progress":
            detail = f" progress_digest={self._truncate(str(payload.get('progress_digest', '')), 120)!r}"
        elif action.type == "emit_stage_synthesis":
            detail = f" stage_synthesis={self._truncate(str(payload.get('stage_synthesis', '')), 120)!r}"
        elif action.type == "emit_final_report":
            detail = f" final_report={self._truncate(str(payload.get('final_report', '')), 120)!r}"
        elif action.type == "wait":
            detail = f" reason={self._truncate(str(payload.get('reason', '')), 120)!r}"
        self._log(
            f"[runtime run={self._run_tag()}] orchestrator action={action.type}{detail} "
            f"rationale={rationale}"
        )

    def _build_graph(self, checkpointer: Any):
        graph = StateGraph(RunState)
        graph.add_node("wait_for_steering_or_signal", self.wait_for_steering_or_signal)
        graph.add_node("orchestrator_deliberation", self.orchestrator_deliberation)
        graph.add_node("execute_orchestrator_action", self.execute_orchestrator_action)
        graph.add_node("finalize_run", self.finalize_run)
        graph.set_entry_point("wait_for_steering_or_signal")
        graph.add_edge("wait_for_steering_or_signal", "orchestrator_deliberation")
        graph.add_edge("orchestrator_deliberation", "execute_orchestrator_action")
        graph.add_conditional_edges(
            "execute_orchestrator_action",
            self._route_after_action,
        )
        return graph.compile(checkpointer=checkpointer)

    def _route_after_action(self, _state: RunState) -> str:
        if self._finalize_pending:
            return "finalize_run"
        return "wait_for_steering_or_signal"

    def _execution_control_requires_orchestrator(
        self,
        control: ExecutionControlRequest,
    ) -> bool:
        assert self.state is not None
        if control.action in {"launch", "create"}:
            return True
        if control.action in {"pause", "terminate"}:
            return False
        if control.action != "modify":
            return False
        if not control.target_plan_id:
            return False
        plan = self.state.get_plan_by_id(control.target_plan_id)
        if plan is None:
            return False
        return plan.status in {"pending", "paused"}

    def _enqueue_internal_signal(self, signal: dict[str, Any]) -> bool:
        kind = str(signal.get("kind", "") or "").strip()
        if not kind:
            return False
        dispatch_turn_index = signal.get("dispatch_turn_index")
        source_action = str(signal.get("source_action", "") or "").strip()
        plan_ids = [str(plan_id) for plan_id in signal.get("plan_ids", []) or [] if str(plan_id)]
        steering_ids = [
            str(steering_id)
            for steering_id in signal.get("steering_ids", []) or []
            if str(steering_id)
        ]
        for existing in self._pending_internal_signals:
            existing_kind = str(existing.get("kind", "") or "").strip()
            existing_dispatch_turn_index = existing.get("dispatch_turn_index")
            existing_source_action = str(existing.get("source_action", "") or "").strip()
            existing_plan_ids = [str(plan_id) for plan_id in existing.get("plan_ids", []) or [] if str(plan_id)]
            existing_steering_ids = [
                str(steering_id)
                for steering_id in existing.get("steering_ids", []) or []
                if str(steering_id)
            ]
            if existing_kind != kind:
                continue
            if existing_dispatch_turn_index != dispatch_turn_index:
                continue
            if existing_source_action != source_action:
                continue
            if existing_plan_ids != plan_ids:
                continue
            if existing_steering_ids != steering_ids:
                continue
            return False
        self._pending_internal_signals.append(dict(signal))
        return True

    def _materialize_pending_internal_signals(self) -> list[str]:
        assert self.state is not None
        signal_kinds: list[str] = []
        while self._pending_internal_signals:
            signal = self._pending_internal_signals.pop(0)
            kind = str(signal.get("kind", "signal") or "signal")
            signal_kinds.append(kind)
            self.state.timeline.append(
                TimelineEntry(
                    entry_type=kind,
                    content=signal,
                )
            )
        if signal_kinds:
            self.store.save_state(self.state)
        return signal_kinds

    def _has_nonterminal_plans(self) -> bool:
        assert self.state is not None
        return any(
            plan.status in {"pending", "paused", "analyzing", "summarizing"}
            for plan in self.state.plans
        )

    def _should_enqueue_post_stage_summary_review(self, batch: DispatchBatchState | None) -> bool:
        assert self.state is not None
        if batch is None:
            return False
        if self.state.master_agent_state.completed:
            return False
        if str(self.state.final_summary or "").strip():
            return False
        if self._has_nonterminal_plans():
            return False
        if not self.state.findings:
            return False
        return True

    def _parse_provenance_citations(self, raw_items: Any) -> list[ProvenanceCitation]:
        citations: list[ProvenanceCitation] = []
        if not isinstance(raw_items, list):
            return citations
        seen_markers: set[int] = set()
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            citation = ProvenanceCitation.from_dict(item)
            if citation is None or citation.marker in seen_markers:
                continue
            citations.append(citation)
            seen_markers.add(citation.marker)
        citations.sort(key=lambda item: item.marker)
        return citations

    @staticmethod
    def _serialize_provenance_citations(citations: list[ProvenanceCitation]) -> list[dict[str, Any]]:
        return [citation.to_dict() for citation in citations]

    def _active_unprocessed_steering_ids(self) -> list[str]:
        assert self.state is not None
        steering_kind_by_id: dict[str, str] = {}
        for message in self.state.user_messages:
            steering_id = f"steer_{message.message_id}"
            kind = str(message.kind or "").strip()
            if kind in {"focus", "ignore", "elaborate"}:
                steering_kind_by_id[steering_id] = kind

        linked_steering_ids = {
            str(steering_id)
            for plan in self.state.plans
            for steering_id in plan.linked_steering_ids
            if str(steering_id)
        }
        unprocessed_ids: list[str] = []
        for steering_id in self.state.steering_state.active_steering_ids:
            normalized_steering_id = str(steering_id or "").strip()
            if not normalized_steering_id:
                continue
            if normalized_steering_id not in steering_kind_by_id:
                continue
            if normalized_steering_id in self.state.steering_state.consumed_steering_ids:
                continue
            if normalized_steering_id in linked_steering_ids:
                continue
            unprocessed_ids.append(normalized_steering_id)
        return unprocessed_ids

    def _unprocessed_steering_signal(
        self,
        *,
        source_action: str | None = None,
    ) -> dict[str, Any] | None:
        steering_ids = self._active_unprocessed_steering_ids()
        if not steering_ids:
            return None
        signal: dict[str, Any] = {
            "kind": "unprocessed_steering_ready",
            "steering_ids": steering_ids,
            "reason": "active_steering_remains_unprocessed",
        }
        if source_action:
            signal["source_action"] = source_action
        return signal

    def _enqueue_continuation_signals(
        self,
        *,
        source_action: str,
        target_batch: DispatchBatchState | None = None,
    ) -> None:
        if source_action == "emit_response" and self._should_enqueue_post_emit_response_review():
            signal = {
                "kind": "post_emit_response_review_ready",
                "source_action": "emit_response",
                "reason": "response_emitted_but_follow_up_work_may_remain",
            }
            if self._enqueue_internal_signal(signal):
                self._log(
                    f"[runtime run={self._run_tag()}] signal=post_emit_response_review_ready "
                    f"reason={signal.get('reason')!r}"
                )

        if (
            source_action == "emit_stage_synthesis"
            and self._should_enqueue_post_stage_summary_review(target_batch)
        ):
            signal = {
                "kind": "post_stage_summary_review_ready",
                "source_action": "emit_stage_synthesis",
                "dispatch_turn_index": (
                    target_batch.dispatch_turn_index if target_batch is not None else None
                ),
                "reason": "stage_summary_emitted_and_all_current_work_is_terminal",
            }
            if self._enqueue_internal_signal(signal):
                self._log(
                    f"[runtime run={self._run_tag()}] signal=post_stage_summary_review_ready "
                    f"dispatch_turn_index={signal.get('dispatch_turn_index')}"
                )

        if not self.worker_runtime.active_plan_ids():
            dispatch_ready_signal = self._dispatch_ready_signal_for_runnable_plans(
                source_action=source_action,
            )
            if dispatch_ready_signal is not None and self._enqueue_internal_signal(dispatch_ready_signal):
                self._log(
                    f"[runtime run={self._run_tag()}] signal=dispatch_ready "
                    f"plan_ids={dispatch_ready_signal.get('plan_ids', [])} "
                    f"source_action={source_action!r}"
                )

        steering_signal = self._unprocessed_steering_signal(source_action=source_action)
        if steering_signal is not None and self._enqueue_internal_signal(steering_signal):
            self._log(
                f"[runtime run={self._run_tag()}] signal=unprocessed_steering_ready "
                f"steering_ids={steering_signal.get('steering_ids', [])} "
                f"source_action={source_action!r}"
            )

    def _latest_user_goal_text(self) -> str:
        assert self.state is not None
        current_turn = self.state.current_turn()
        if current_turn is not None and str(current_turn.goal or "").strip():
            return str(current_turn.goal or "").strip()
        if self.state.master_agent_state.current_goals:
            return str(self.state.master_agent_state.current_goals[-1] or "").strip()
        return ""

    def _should_enqueue_post_emit_response_review(self) -> bool:
        assert self.state is not None
        if self.state.master_agent_state.completed:
            return False
        if str(self.state.final_summary or "").strip():
            return False
        if self._active_unprocessed_steering_ids():
            return True
        if any(plan.status in {"pending", "paused", "analyzing", "summarizing"} for plan in self.state.plans):
            return True
        if any(batch.status == "waiting_for_stage_summary" for batch in self.state.batches):
            return True
        if not self.state.plans and self._latest_user_goal_text():
            return True
        if self.state.findings and not self._has_nonterminal_plans():
            return True
        return False

    async def run(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        resume: bool = False,
        resume_message: UserMessage | None = None,
    ) -> RunState:
        self.store.initialize()
        if resume:
            loaded = self.store.load_state()
            if loaded is None:
                raise RuntimeError("Cannot resume: state.json is missing or invalid.")
            self.state = loaded
            self._log(
                f"[runtime run={self._run_tag()}] resume dataset={dataset_path} "
                f"status={self.state.status}"
            )
            self._sync_runtime_settings_from_state()
            self._normalize_resumed_state()
            self._initialize_offsets_from_existing_files()
            if resume_message is not None:
                self._register_user_message(resume_message, append_to_input_log=True)
        else:
            self.state = RunState.create(
                dataset_path=dataset_path,
                user_goal=user_goal,
                settings=self.settings,
                run_id=self.store.run_id,
            )
            self.state.dataset_metadata = self._load_dataset_info(dataset_path)
            self.state.dataset_schema = self._dataset_schema_text(self.state.dataset_metadata)
            self._sync_runtime_settings_from_state()
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] initialize dataset={dataset_path} "
                f"rows={self.state.dataset_metadata.get('rows', 0)} "
                f"columns={len(self.state.dataset_metadata.get('columns', []) or [])}"
            )
            if self.state.user_messages:
                self.store.log_user_steer_received(self.state.user_messages[0])
        set_stable_llm_output_enabled(self.settings.stable_llm_output)
        checkpoint_path = (self.store.run_dir / ".langgraph_checkpoints.sqlite").resolve()
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(str(checkpoint_path)) as checkpointer:
            graph = self._build_graph(checkpointer)
            final_state = await graph.ainvoke(
                self.state,
                config={"configurable": {"thread_id": self.store.run_id}},
            )
            if isinstance(final_state, RunState):
                self.state = final_state
        assert self.state is not None
        return self.state

    async def wait_for_steering_or_signal(self, state: RunState) -> RunState:
        self.state = state
        assert self.state is not None
        while True:
            refreshed = self.store.load_state()
            if refreshed is not None:
                self.state = refreshed
                self._sync_runtime_settings_from_state()
            pending_input_summary = RuntimeInputApplicationSummary()
            if self._pending_runtime_inputs:
                pending_input_summary = self._apply_pending_runtime_inputs()
            if self._initial_wake_pending:
                self._initial_wake_pending = False
                self._log(
                    f"[runtime run={self._run_tag()}] node=wait_for_steering_or_signal wake=initial"
                )
                return self.state

            wake_reasons: list[str] = []
            ingested_inputs = await self._ingest_runtime_inputs()
            if ingested_inputs:
                wake_reasons.append("input")
            if self._pending_runtime_inputs:
                pending_input_summary.merge(self._apply_pending_runtime_inputs())
            if pending_input_summary.should_wake_orchestrator:
                if "input" not in wake_reasons:
                    wake_reasons.append("input")
            elif wake_reasons == ["input"]:
                wake_reasons.clear()
            if await self._ingest_finished_workers():
                wake_reasons.append("worker_update")
            signal_kinds = self._materialize_pending_internal_signals()
            if signal_kinds:
                wake_reasons.extend(f"signal:{kind}" for kind in signal_kinds)
            if wake_reasons:
                self._log(
                    f"[runtime run={self._run_tag()}] wake=materialized reasons={wake_reasons}"
                )
                return self.state

            stop_path = self.store.run_dir / RUN_CONTROL_STOP_FILE
            if stop_path.exists() and not self.worker_runtime.active_plan_ids():
                self.state.status = "stopped"
                self.store.save_state(self.state)
                self._log(
                    f"[runtime run={self._run_tag()}] stop_detected active_workers=0 status=stopped"
                )
                return self.state

            await asyncio.sleep(self.settings.poll_interval_seconds)

    async def orchestrator_deliberation(self, state: RunState) -> RunState:
        self.state = state
        assert self.state is not None
        self._last_action = self.orchestrator.decide(self.state, store=self.store)
        self._log_action(self._last_action)
        return self.state

    async def execute_orchestrator_action(self, state: RunState) -> RunState:
        self.state = state
        assert self.state is not None
        action = self._last_action
        self._finalize_pending = False
        if action is None:
            return self.state
        rejection_reason = self._validate_action_for_execution(action)
        if rejection_reason is not None:
            rejection_payload = {
                "action_type": action.type,
                "reason": rejection_reason,
                "payload": action.payload,
            }
            self.store.append_event("orchestrator_action_rejected", rejection_payload)
            self.state.timeline.append(
                TimelineEntry(entry_type="orchestrator_action_rejected", content=rejection_payload)
            )
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] execute action=rejected "
                f"type={action.type} reason={self._truncate(rejection_reason, 160)!r}"
            )
            return self.state
        self.state.master_agent_state.loop_count += 1

        if action.type == "wait":
            self.store.log_master_agent_tool_result("wait", action.payload)
            self.state.timeline.append(TimelineEntry(entry_type="wait", content=action.payload))
            self._log(
                f"[runtime run={self._run_tag()}] execute action=wait "
                f"reason={self._truncate(str(action.payload.get('reason', '')), 120)!r}"
            )
            return self.state

        if action.type == "emit_response":
            message_text = str(
                action.payload.get("response", action.payload.get("message", "")) or ""
            ).strip()
            if message_text:
                response_payload: dict[str, Any] = {"message": message_text}
                self.store.append_event("user_response", response_payload)
                self.store.log_master_agent_tool_result(
                    "emit_response",
                    {"response": message_text},
                )
                self.state.timeline.append(
                    TimelineEntry(entry_type="emit_response", content=response_payload)
                )
                self._log(
                        f"[runtime run={self._run_tag()}] execute action=emit_response "
                        f"message={self._truncate(message_text, 160)!r}"
                    )
            self._consume_steering_ids(action.consumed_steering_ids)
            if message_text:
                self._enqueue_continuation_signals(source_action="emit_response")
            self.state.step += 1
            self.store.save_state(self.state)
            return self.state

        if action.type == "create_plans":
            created = self._create_plans_from_action(action)
            self.store.log_master_agent_tool_result(
                "create_plans",
                {
                    "created_plan_ids": [plan.plan_id for plan in created],
                    "plans": [plan.to_dict() for plan in created],
                },
            )
            self.state.timeline.append(
                TimelineEntry(
                    entry_type="create_plans",
                    content={"plan_ids": [plan.plan_id for plan in created]},
                )
            )
            self._consume_steering_ids(action.consumed_steering_ids)
            if created:
                self._enqueue_continuation_signals(source_action="create_plans")
            if created:
                self.state.step += 1
                self._log(
                    f"[runtime run={self._run_tag()}] execute action=create_plans "
                    f"created={len(created)} ids={[plan.plan_id for plan in created]}"
                )
            else:
                requested_plan_count = len(action.payload.get("plans", []) or [])
                self._log(
                    f"[runtime run={self._run_tag()}] execute action=create_plans "
                    f"created=0 requested={requested_plan_count}"
                )
            self.store.save_state(self.state)
            return self.state

        if action.type == "dispatch_plans":
            dispatched = await self._dispatch_from_action(action)
            self.store.log_master_agent_tool_result(
                "dispatch_plans",
                dispatched,
            )
            self.state.timeline.append(
                TimelineEntry(entry_type="dispatch_plans", content=dispatched)
            )
            self._consume_steering_ids(action.consumed_steering_ids)
            self.state.step += 1
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] execute action=dispatch_plans "
                f"requested={dispatched.get('plan_ids', [])} dispatched={dispatched.get('dispatched_plan_ids', [])}"
            )
            return self.state

        if action.type == "evaluate_progress":
            progress_digest = str(
                action.payload.get("progress_digest", action.payload.get("evaluation", "")) or ""
            )
            progress_payload: dict[str, Any] = {
                "evaluation": progress_digest,
                "progress_digest": progress_digest,
            }
            if isinstance(action.payload.get("dispatch_turn_index"), int):
                progress_payload["dispatch_turn_index"] = int(action.payload["dispatch_turn_index"])
            if isinstance(action.payload.get("plan_ids"), list):
                progress_payload["plan_ids"] = [
                    str(item) for item in action.payload.get("plan_ids", []) if str(item)
                ]
            self.store.log_progress_evaluation(progress_payload)
            self.store.log_master_agent_tool_result("evaluate_progress", progress_payload)
            self.state.timeline.append(
                TimelineEntry(entry_type="evaluate_progress", content=progress_payload)
            )
            self._consume_steering_ids(action.consumed_steering_ids)
            self.state.step += 1
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] execute action=evaluate_progress "
                f"digest={self._truncate(progress_digest, 160)!r}"
            )
            return self.state

        if action.type == "emit_stage_synthesis":
            stage_summary = str(action.payload.get("stage_synthesis", "") or "")
            batch = self._resolve_target_batch(action.payload)
            citations = self._parse_provenance_citations(action.payload.get("citations"))
            if batch is not None:
                batch.stage_summary_emitted = True
                batch.stage_summary_markdown = stage_summary
                batch.stage_summary_citations = citations
                batch.status = "stage_summarized"
                if stage_summary:
                    batch.stage_synthesis_refs.append(stage_summary)
            current_turn = self.state.current_turn()
            if current_turn is not None and stage_summary:
                current_turn.stage_syntheses.append(
                    {
                        "dispatch_turn_index": batch.dispatch_turn_index if batch is not None else None,
                        "stage_synthesis": stage_summary,
                        "citations": self._serialize_provenance_citations(citations),
                    }
                )
            stage_payload: dict[str, Any] = {
                "evaluation": stage_summary,
                "progress_digest": stage_summary,
                "stage_summary_markdown": stage_summary,
                "dispatch_turn_index": batch.dispatch_turn_index if batch is not None else None,
                "covered_dispatch_turn_indexes": (
                    [batch.dispatch_turn_index] if batch is not None else []
                ),
                "plan_ids": list(batch.plan_ids) if batch is not None else [],
            }
            if citations:
                stage_payload["citations"] = self._serialize_provenance_citations(citations)
            self.store.log_progress_evaluation(stage_payload)
            self.store.log_master_agent_tool_result("emit_stage_synthesis", stage_payload)
            self.state.timeline.append(
                TimelineEntry(entry_type="emit_stage_synthesis", content=stage_payload)
            )
            self._consume_steering_ids(action.consumed_steering_ids)
            self._enqueue_continuation_signals(
                source_action="emit_stage_synthesis",
                target_batch=batch,
            )
            self.state.step += 1
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] execute action=emit_stage_synthesis "
                f"dispatch_turn_index={stage_payload.get('dispatch_turn_index')} "
                f"summary={self._truncate(stage_summary, 160)!r}"
            )
            return self.state

        if action.type == "emit_final_report":
            self.state.final_summary = str(action.payload.get("final_report", "") or "")
            self.state.status = "completed"
            self.state.master_agent_state.completed = True
            current_turn = self.state.current_turn()
            if current_turn is not None:
                current_turn.status = "completed"
                current_turn.completion_status = "completed"
                current_turn.final_summary = self.state.final_summary
            final_report_payload: dict[str, Any] = {
                "final_report": self.state.final_summary,
            }
            citations = self._parse_provenance_citations(action.payload.get("citations"))
            latest_batch = self._resolve_target_batch(action.payload)
            if latest_batch is not None:
                final_report_payload["dispatch_turn_index"] = latest_batch.dispatch_turn_index
            if citations:
                final_report_payload["citations"] = self._serialize_provenance_citations(citations)
            self.store.log_master_agent_tool_result(
                "emit_final_report",
                final_report_payload,
            )
            self.state.timeline.append(
                TimelineEntry(
                    entry_type="emit_final_report",
                    content=final_report_payload,
                )
            )
            self._consume_steering_ids(action.consumed_steering_ids)
            self._finalize_pending = True
            self.state.step += 1
            self.store.save_state(self.state)
            self._log(
                f"[runtime run={self._run_tag()}] execute action=emit_final_report "
                f"dispatch_turn_index={final_report_payload.get('dispatch_turn_index')} "
                f"final_report={self._truncate(self.state.final_summary, 160)!r}"
            )
            return self.state

        return self.state

    def _validate_action_for_execution(self, action: OrchestratorAction) -> str | None:
        assert self.state is not None
        parsed_payload, shape_error = validate_orchestrator_action_shape(action)
        if shape_error is not None:
            return f"shape_invalid: {shape_error}"
        if isinstance(parsed_payload, CreatePlansPayloadModel):
            for index, plan in enumerate(parsed_payload.plans):
                if not str(plan.text or "").strip():
                    return f"plan_text_empty at index={index}"
            return None
        if isinstance(parsed_payload, DispatchPlansPayloadModel):
            for plan_id in parsed_payload.plan_ids:
                normalized_plan_id = str(plan_id or "").strip()
                if not normalized_plan_id:
                    return "dispatch_plan_id_empty"
                plan = self.state.get_plan_by_id(normalized_plan_id)
                if plan is None:
                    return f"dispatch_plan_not_found: {normalized_plan_id}"
                if plan.status not in {"pending", "paused"}:
                    return f"dispatch_plan_not_runnable: {normalized_plan_id} status={plan.status}"
            return None
        if isinstance(parsed_payload, WaitPayloadModel):
            return None if parsed_payload.reason.strip() else "wait_reason_empty"
        if isinstance(parsed_payload, EvaluateProgressPayloadModel):
            return None if parsed_payload.progress_digest.strip() else "progress_digest_empty"
        if isinstance(parsed_payload, EmitResponsePayloadModel):
            return None if parsed_payload.response.strip() else "response_empty"
        if isinstance(parsed_payload, EmitStageSynthesisPayloadModel):
            return None if parsed_payload.stage_synthesis.strip() else "stage_synthesis_empty"
        if isinstance(parsed_payload, EmitFinalReportPayloadModel):
            return None if parsed_payload.final_report.strip() else "final_report_empty"
        return None

    async def finalize_run(self, state: RunState) -> RunState:
        self.state = state
        assert self.state is not None
        self.store.save_state(self.state)
        completion_payload: dict[str, Any] = {
            "total_steps": self.state.step,
            "total_insights": self.state.total_atomic_insights(),
            "total_summaries": self.state.total_summaries(),
            "total_failures": self.state.failure_count,
            "final_status": self.state.status,
        }
        if self.state.timeline:
            latest_entry = self.state.timeline[-1]
            if str(latest_entry.entry_type or "") == "emit_final_report":
                latest_content = latest_entry.content if isinstance(latest_entry.content, dict) else {}
                final_report = str(latest_content.get("final_report", "") or "").strip()
                if final_report:
                    completion_payload["final_report"] = final_report
                if isinstance(latest_content.get("dispatch_turn_index"), int):
                    completion_payload["dispatch_turn_index"] = int(latest_content["dispatch_turn_index"])
                if isinstance(latest_content.get("citations"), list):
                    completion_payload["citations"] = latest_content["citations"]
        self.store.append_event("run_completed", completion_payload)
        self._log(
            f"[runtime run={self._run_tag()}] node=finalize_run "
            f"status={self.state.status} steps={self.state.step}"
        )
        return self.state

    async def _ingest_runtime_inputs(self) -> bool:
        new_steers, self._steer_offset = read_jsonl_since(self.store.steer_path, self._steer_offset)
        for steer_payload in new_steers:
            message = UserMessage.from_dict(steer_payload)
            self._register_user_message(message, append_to_input_log=False)

        new_controls, self._plan_control_offset = read_jsonl_since(
            self.store.plan_controls_path,
            self._plan_control_offset,
        )
        for control_payload in new_controls:
            mapped_control = map_plan_control_payload(control_payload)
            if mapped_control is not None:
                self._pending_runtime_inputs.append(mapped_control)

        if new_steers or new_controls:
            self._log(
                f"[runtime run={self._run_tag()}] wake=input "
                f"steers={len(new_steers)} plan_controls={len(new_controls)}"
            )
        return bool(new_steers or new_controls)

    async def _ingest_finished_workers(self) -> bool:
        assert self.state is not None
        signals = self.worker_runtime.pop_finished_signals()
        if not signals:
            return False
        should_wake_orchestrator = False
        dispatch_ready_plan_ids: list[str] = []
        finished_results = self.worker_runtime.pop_finished_results()
        overridden_plan_ids = {
            plan_id
            for plan_id, _result in finished_results
            if (
                (plan := self.state.get_plan_by_id(plan_id)) is not None
                and plan.control_state in {"pause_requested", "terminate_requested"}
            )
        }
        latest_persisted = self.store.load_state()
        if latest_persisted is not None:
            self.state.artifacts = latest_persisted.artifacts
            self.state.findings = [
                finding
                for finding in latest_persisted.findings
                if finding.plan_id not in overridden_plan_ids
            ]
        for plan_id, result in finished_results:
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None:
                continue
            if result is None:
                continue
            if plan.control_state == "terminate_requested":
                plan.status = "terminated"
                plan.control_state = "none"
                plan.pending_modified_text = None
                plan.launch_requested = False
                checkpoint_path = getattr(result, "checkpoint_path", None)
                if checkpoint_path:
                    plan.checkpoint_path = checkpoint_path
                self.store.log_plan_status_changed(plan)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_status_updated "
                    f"plan={plan_id} action=terminate checkpoint={plan.checkpoint_path or '<none>'}"
                )
                continue
            if plan.control_state == "pause_requested":
                checkpoint_path = getattr(result, "checkpoint_path", None)
                if checkpoint_path:
                    plan.checkpoint_path = checkpoint_path
                if plan.pending_modified_text:
                    self._apply_pending_modification(plan)
                    dispatch_ready_plan_ids.append(plan_id)
                    should_wake_orchestrator = True
                else:
                    plan.status = "paused"
                    plan.control_state = "none"
                    plan.launch_requested = False
                self.store.log_plan_status_changed(plan)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_status_updated "
                    f"plan={plan_id} action=pause checkpoint={plan.checkpoint_path or '<none>'}"
                )
                continue
            control_action = getattr(result, "control_action", None)
            if control_action == "yield":
                control_action = "pause"
            if control_action == "pause":
                checkpoint_path = getattr(result, "checkpoint_path", None)
                if checkpoint_path:
                    plan.checkpoint_path = checkpoint_path
                if plan.pending_modified_text:
                    self._apply_pending_modification(plan)
                else:
                    plan.status = "paused"
                    plan.control_state = "none"
                    plan.launch_requested = False
                self.store.log_plan_status_changed(plan)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_status_updated "
                    f"plan={plan_id} action=pause checkpoint={plan.checkpoint_path or '<none>'}"
                )
                continue
            if control_action == "terminate":
                plan.status = "terminated"
                plan.control_state = "none"
                plan.pending_modified_text = None
                plan.launch_requested = False
                checkpoint_path = getattr(result, "checkpoint_path", None)
                if checkpoint_path:
                    plan.checkpoint_path = checkpoint_path
                self.store.log_plan_status_changed(plan)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_status_updated "
                    f"plan={plan_id} action=terminate checkpoint={plan.checkpoint_path or '<none>'}"
                )
                continue

            if isinstance(result, dict) and result.get("insight") is not None:
                should_wake_orchestrator = True
                for record in result.get("execution_records", []) or []:
                    self.state.execution_records.append(record)
                    self.store.log_execution_completed(record)
                plan.status = "completed"
                plan.control_state = "none"
                plan.resume_phase = None
                plan.pending_modified_text = None
                plan.launch_requested = False
                insight = result["insight"]
                if not any(item.insight_id == insight.insight_id for item in self.state.findings):
                    self.state.findings.append(insight)
                plan.final_summary = insight.summary
                if plan.plan_id not in self.state.master_agent_state.completed_plan_ids:
                    self.state.master_agent_state.completed_plan_ids.append(plan.plan_id)
                if insight.insight_id not in self.state.master_agent_state.all_insight_ids:
                    self.state.master_agent_state.all_insight_ids.append(insight.insight_id)
                self.store.log_plan_completed(plan)
                self.store.log_insight_extracted(insight)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_finding_ready "
                    f"plan={plan_id} insight={insight.insight_id} short_label={insight.short_label or '<none>'}"
                )
            else:
                should_wake_orchestrator = True
                plan.status = "failed"
                plan.control_state = "none"
                plan.pending_modified_text = None
                plan.launch_requested = False
                self.state.failure_count += 1
                self.store.log_plan_status_changed(plan)
                self._sync_batches_for_plan_transition(plan_id)
                self._log(
                    f"[runtime run={self._run_tag()}] signal=worker_status_updated "
                    f"plan={plan_id} action=failed"
                )
        for signal in signals:
            if signal.plan_id in overridden_plan_ids and signal.kind == "worker_finding_ready":
                continue
            self.state.timeline.append(
                TimelineEntry(
                    entry_type=signal.kind,
                    content={
                        "plan_id": signal.plan_id,
                        "finding_id": signal.finding_id,
                        "checkpoint_ref": signal.checkpoint_ref,
                    },
                )
            )
        if dispatch_ready_plan_ids:
            dispatch_ready_signal = self._dispatch_ready_signal_for_runnable_plans(
                dispatch_ready_plan_ids,
                source_action="modify_launch_ready",
            )
            if dispatch_ready_signal is not None and self._enqueue_internal_signal(dispatch_ready_signal):
                self._log(
                    f"[runtime run={self._run_tag()}] signal=dispatch_ready "
                    f"plan_ids={dispatch_ready_signal.get('plan_ids', [])} "
                    "source_action='modify_launch_ready'"
                )
        if should_wake_orchestrator:
            self._enqueue_continuation_signals(source_action="worker_update")
        self.store.save_state(self.state)
        return should_wake_orchestrator

    def _apply_pending_runtime_inputs(self) -> RuntimeInputApplicationSummary:
        assert self.state is not None
        summary = RuntimeInputApplicationSummary()
        while self._pending_runtime_inputs:
            item = self._pending_runtime_inputs.pop(0)
            if isinstance(item, SteeringRequest):
                summary.has_inputs = True
                summary.should_wake_orchestrator = True
                self._register_steering(item)
                self.state.master_agent_state.message_history.append(item.to_dict())
                current_turn = self.state.current_turn()
                if current_turn is not None:
                    current_turn.triggering_inputs.append(item.to_dict())
                    if item.steering_id not in current_turn.accepted_steering_ids:
                        current_turn.accepted_steering_ids.append(item.steering_id)
                continue
            if isinstance(item, ExecutionControlRequest):
                summary.has_inputs = True
                if self._execution_control_requires_orchestrator(item):
                    summary.should_wake_orchestrator = True
                self._register_execution_control(item)
                self._apply_execution_control(item)
                current_turn = self.state.current_turn()
                if current_turn is not None:
                    current_turn.triggering_inputs.append(item.to_dict())
                continue
        self.store.save_state(self.state)
        return summary

    def _apply_execution_control(self, control: ExecutionControlRequest) -> None:
        assert self.state is not None
        if control.action == "create":
            text = str(control.user_authored_text or "").strip()
            if not text:
                return
            plan = PlanItem.create(text=text, source="user_create")
            plan.linked_control_ids.append(control.control_id)
            self.state.plans.append(plan)
            attach_batch = self._latest_unresolved_dispatch_batch()
            if attach_batch is not None:
                if plan.plan_id not in attach_batch.plan_ids:
                    attach_batch.plan_ids.append(plan.plan_id)
                if plan.plan_id not in attach_batch.waiting_plan_ids:
                    attach_batch.waiting_plan_ids.append(plan.plan_id)
            existing_control_ids = list(
                self.state.execution_control_state.controls_by_plan.get(plan.plan_id, [])
            )
            if control.control_id not in existing_control_ids:
                existing_control_ids.append(control.control_id)
            self.state.execution_control_state.controls_by_plan[plan.plan_id] = existing_control_ids
            self.store.log_plan_created(plan)
            self._sync_batches_for_plan_transition(plan.plan_id)
            return
        if not control.target_plan_id:
            return
        target_plan = self.state.get_plan_by_id(control.target_plan_id)
        if target_plan is None:
            return
        if control.control_id not in target_plan.linked_control_ids:
            target_plan.linked_control_ids.append(control.control_id)
        if control.action == "launch" and target_plan.status in {"pending", "paused"}:
            target_plan.status = "pending"
            target_plan.control_state = "none"
            target_plan.launch_requested = True
            if target_plan.resume_phase not in {"analyzing", "summarizing"}:
                target_plan.resume_phase = None
        elif control.action == "pause":
            target_plan.launch_requested = False
            if target_plan.status == "pending":
                target_plan.status = "paused"
            elif target_plan.status in {"analyzing", "summarizing"}:
                target_plan.control_state = "pause_requested"
        elif control.action == "terminate":
            target_plan.launch_requested = False
            if target_plan.status in {"pending", "paused"}:
                target_plan.status = "terminated"
            else:
                target_plan.control_state = "terminate_requested"
        elif control.action == "modify":
            next_text = (
                str(control.user_authored_text)
                if control.user_authored_text is not None
                else None
            )
            if target_plan.status in {"analyzing", "summarizing"}:
                if next_text is not None:
                    target_plan.pending_modified_text = next_text
                target_plan.control_state = "pause_requested"
                target_plan.launch_requested = False
            elif next_text:
                self._apply_pending_modification(target_plan, next_text)
        self.store.log_plan_status_changed(target_plan)

    def _register_steering(self, steering: SteeringRequest) -> None:
        assert self.state is not None
        state = self.state.steering_state
        target_key = self._steering_target_key(steering)
        previous_ids = list(state.target_index.get(target_key, []))
        for steering_id in previous_ids:
            if steering_id in state.active_steering_ids:
                state.active_steering_ids.remove(steering_id)
            if steering_id not in state.superseded_steering_ids:
                state.superseded_steering_ids.append(steering_id)
        if steering.steering_id not in state.registered_steering_ids:
            state.registered_steering_ids.append(steering.steering_id)
        if steering.steering_id not in state.active_steering_ids:
            state.active_steering_ids.append(steering.steering_id)
        state.target_index[target_key] = [steering.steering_id]

    def _register_execution_control(self, control: ExecutionControlRequest) -> None:
        assert self.state is not None
        state = self.state.execution_control_state
        if control.control_id not in state.registered_control_ids:
            state.registered_control_ids.append(control.control_id)
        if control.target_plan_id:
            existing_control_ids = list(state.controls_by_plan.get(control.target_plan_id, []))
            if existing_control_ids:
                latest_control_id = existing_control_ids[-1]
                if latest_control_id not in state.superseded_control_ids:
                    state.superseded_control_ids.append(latest_control_id)
            if control.control_id not in existing_control_ids:
                existing_control_ids.append(control.control_id)
            state.controls_by_plan[control.target_plan_id] = existing_control_ids
        if control.control_id not in state.applied_control_ids:
            state.applied_control_ids.append(control.control_id)

    def _consume_steering_ids(self, steering_ids: list[str]) -> None:
        assert self.state is not None
        state = self.state.steering_state
        for steering_id in steering_ids:
            if steering_id in state.active_steering_ids:
                state.active_steering_ids.remove(steering_id)
            if steering_id not in state.consumed_steering_ids:
                state.consumed_steering_ids.append(steering_id)

    def _sync_batches_for_plan_transition(self, plan_id: str) -> None:
        assert self.state is not None
        self.state.master_agent_state.active_plan_ids = [
            item.plan_id
            for item in self.state.plans
            if item.status in {"analyzing", "summarizing"}
        ]
        for batch in self.state.master_agent_state.dispatch_batches:
            if plan_id not in batch.plan_ids:
                continue
            batch.active_plan_ids = [
                item.plan_id
                for item in self.state.plans
                if item.plan_id in batch.plan_ids and item.status in {"analyzing", "summarizing"}
            ]
            batch.waiting_plan_ids = [
                item.plan_id
                for item in self.state.plans
                if item.plan_id in batch.plan_ids and item.status in {"pending", "paused"}
            ]
            if not batch.active_plan_ids and not batch.waiting_plan_ids and batch.status == "dispatched":
                batch.status = "waiting_for_stage_summary"

    def _latest_unresolved_dispatch_batch(self) -> DispatchBatchState | None:
        assert self.state is not None
        nonterminal_statuses = {"pending", "analyzing", "summarizing", "paused"}
        for batch in reversed(self.state.master_agent_state.dispatch_batches):
            if any(
                (plan := self.state.get_plan_by_id(plan_id)) is not None
                and plan.status in nonterminal_statuses
                for plan_id in batch.plan_ids
            ):
                return batch
        return None

    def _batch_for_plan(self, plan_id: str) -> DispatchBatchState | None:
        assert self.state is not None
        for batch in self.state.master_agent_state.dispatch_batches:
            if plan_id in batch.plan_ids:
                return batch
        return None

    def _pending_unbatched_create_group_for_plan(self, plan_id: str) -> list[str]:
        assert self.state is not None
        normalized_plan_id = str(plan_id or "").strip()
        if not normalized_plan_id:
            return []
        for entry in reversed(self.state.timeline):
            if str(getattr(entry, "entry_type", "") or "") != "create_plans":
                continue
            content = entry.content if isinstance(entry.content, dict) else {}
            group_plan_ids = [
                str(item).strip()
                for item in content.get("plan_ids", []) or []
                if str(item).strip()
            ]
            if normalized_plan_id not in group_plan_ids:
                continue
            return [
                group_plan_id
                for group_plan_id in group_plan_ids
                if (plan := self.state.get_plan_by_id(group_plan_id)) is not None
                and plan.status in {"pending", "paused"}
                and self._batch_for_plan(group_plan_id) is None
            ]
        return []

    def _normalize_dispatch_request_to_single_batch(
        self,
        requested_plan_ids: list[str],
    ) -> tuple[DispatchBatchState | None, list[str]]:
        ordered_requested = [str(plan_id or "").strip() for plan_id in requested_plan_ids if str(plan_id or "").strip()]
        if not ordered_requested:
            return None, []
        first_plan_batch = self._batch_for_plan(ordered_requested[0])
        if first_plan_batch is not None:
            return (
                first_plan_batch,
                [plan_id for plan_id in ordered_requested if plan_id in first_plan_batch.plan_ids],
            )
        first_create_group = self._pending_unbatched_create_group_for_plan(ordered_requested[0])
        if first_create_group:
            return (None, first_create_group)
        return (
            None,
            [plan_id for plan_id in ordered_requested if self._batch_for_plan(plan_id) is None],
        )

    def _dispatch_ready_signal_for_runnable_plans(
        self,
        requested_plan_ids: list[str] | None = None,
        *,
        source_action: str | None = None,
    ) -> dict[str, Any] | None:
        assert self.state is not None
        raw_requested = [
            str(plan_id or "").strip()
            for plan_id in requested_plan_ids or []
            if str(plan_id or "").strip()
        ]
        if raw_requested:
            candidate_ids = [
                plan_id
                for plan_id in raw_requested
                if (plan := self.state.get_plan_by_id(plan_id)) is not None
                and plan.status in {"pending", "paused"}
            ]
        else:
            candidate_ids = self._ordered_dispatch_candidates([])
        target_batch, normalized_plan_ids = self._normalize_dispatch_request_to_single_batch(candidate_ids)
        if not normalized_plan_ids:
            return None
        signal: dict[str, Any] = {
            "kind": "dispatch_ready",
            "plan_ids": normalized_plan_ids,
        }
        if target_batch is not None:
            signal["dispatch_turn_index"] = target_batch.dispatch_turn_index
        if source_action:
            signal["source_action"] = source_action
        return signal

    @staticmethod
    def _steering_target_key(steering: SteeringRequest) -> str:
        target = steering.target
        if target.kind == "summary":
            return f"summary:{target.summary_id}"
        if target.kind == "atomic":
            return f"atomic:{target.atomic_id}"
        return "column:" + ",".join(sorted({column for column in target.columns if column}))

    def _register_user_message(self, message: UserMessage, *, append_to_input_log: bool) -> None:
        assert self.state is not None
        self.state.user_messages.append(message)
        mapped = map_user_message_to_runtime_input(message)
        if not isinstance(mapped, UserMessage):
            self._pending_runtime_inputs.append(mapped)
        if append_to_input_log:
            self.store.append_steer_message(message)
        self.store.log_user_steer_received(message)
        current_turn = self.state.current_turn()
        if current_turn is None or current_turn.status == "completed":
            next_turn_id = len(self.state.turns)
            self.state.turns.append(
                Turn(
                    turn_id=next_turn_id,
                    goal=message.content,
                    triggering_inputs=[message.to_dict()],
                )
            )
            self.state.master_agent_state.current_goals.append(message.content)
        else:
            if isinstance(mapped, UserMessage):
                current_turn.triggering_inputs.append(message.to_dict())
            current_turn.steers.append(message.content)
        self.store.save_state(self.state)

    def _create_plans_from_action(self, action: OrchestratorAction) -> list[PlanItem]:
        assert self.state is not None
        raw_plans = list(action.payload.get("plans", []) or [])
        replay_texts = self._load_replay_plan_texts(self._create_plans_call_index())
        created: list[PlanItem] = []
        raw_plan_count = max(len(raw_plans), len(replay_texts)) if replay_texts else len(raw_plans)
        for index in range(min(raw_plan_count, self.max_initial_plans)):
            raw = raw_plans[index] if index < len(raw_plans) else {}
            raw_plan = raw if isinstance(raw, dict) else {}
            replay_text = replay_texts[index] if index < len(replay_texts) else None
            text = str(replay_text or raw_plan.get("text", "") or "").strip()
            if not text:
                continue
            plan = PlanItem.create(
                text=text,
                source=str(raw_plan.get("source", "orchestrator")),
            )
            for steering_id in action.consumed_steering_ids:
                if steering_id not in plan.linked_steering_ids:
                    plan.linked_steering_ids.append(steering_id)
            created.append(plan)
            self.state.plans.append(plan)
            self.store.log_plan_created(plan)
        self.store.save_state(self.state)
        return created

    async def _dispatch_from_action(self, action: OrchestratorAction) -> dict[str, Any]:
        assert self.state is not None
        requested_plan_ids = [
            str(item)
            for item in action.payload.get("plan_ids", []) or []
            if str(item)
        ]
        requested_plan_ids = self._ordered_dispatch_candidates(requested_plan_ids)
        target_batch, normalized_plan_ids = self._normalize_dispatch_request_to_single_batch(
            requested_plan_ids,
        )
        if target_batch is None and normalized_plan_ids:
            target_batch = DispatchBatchState(
                dispatch_turn_index=len(self.state.master_agent_state.dispatch_batches),
                plan_ids=list(normalized_plan_ids),
                waiting_plan_ids=list(normalized_plan_ids),
            )
            self.state.master_agent_state.dispatch_batches.append(target_batch)
            current_turn = self.state.current_turn()
            if current_turn is not None:
                current_turn.dispatch_batches.append(target_batch)
        elif target_batch is not None:
            normalized_plan_ids = [
                plan_id
                for plan_id in normalized_plan_ids
                if plan_id in target_batch.plan_ids
            ]
        active_count = len(self.worker_runtime.active_plan_ids())
        available = max(0, self.settings.max_concurrency - active_count)
        dispatched: list[str] = []
        for plan_id in normalized_plan_ids:
            if len(dispatched) >= available:
                break
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status not in {"pending", "paused"}:
                continue
            plan.status = "summarizing" if plan.resume_phase == "summarizing" else "analyzing"
            plan.control_state = "none"
            plan.launch_requested = False
            self.store.log_plan_started(plan)
            self.worker_runtime.dispatch(
                plan=plan,
                run_state=self.state,
                control_callback=self._build_plan_control_callback(plan.plan_id),
            )
            dispatched.append(plan.plan_id)
            if plan.plan_id not in self.state.master_agent_state.active_plan_ids:
                self.state.master_agent_state.active_plan_ids.append(plan.plan_id)
            self._sync_batches_for_plan_transition(plan.plan_id)
        self.store.save_state(self.state)
        if not dispatched:
            self._log(
                f"[runtime run={self._run_tag()}] dispatch_plans no_dispatch "
                f"requested={normalized_plan_ids} available_slots={available}"
            )
        return {
            "plan_ids": normalized_plan_ids,
            "dispatched_plan_ids": dispatched,
            "dispatch_turn_index": target_batch.dispatch_turn_index if target_batch is not None else 0,
        }

    def _build_plan_control_callback(self, plan_id: str) -> Callable[[], dict[str, Any]]:
        def _control_snapshot() -> dict[str, Any]:
            assert self.state is not None
            current_plan = self.state.get_plan_by_id(plan_id)
            if current_plan is None:
                return {"control_state": "none"}
            return {"control_state": current_plan.control_state}

        return _control_snapshot

    @staticmethod
    def _normalize_plan_text(text: str | None) -> str:
        return " ".join(str(text or "").split()).strip()

    @classmethod
    def _apply_pending_modification(cls, plan: PlanItem, next_text: str | None = None) -> None:
        pending_text = next_text if next_text is not None else plan.pending_modified_text
        if pending_text is None:
            return
        normalized_current = cls._normalize_plan_text(plan.text)
        normalized_next = cls._normalize_plan_text(pending_text)
        plan.pending_modified_text = None
        plan.status = "pending"
        plan.control_state = "none"
        plan.launch_requested = True
        if normalized_next == normalized_current:
            return
        plan.text = str(pending_text)
        plan.pending_modified_text = None
        plan.resume_phase = None
        plan.checkpoint_path = None
        plan.revision = getattr(plan, "revision", 1) + 1
        plan.final_summary = None
        plan.error_message = None

    def _ordered_dispatch_candidates(self, requested_plan_ids: list[str]) -> list[str]:
        assert self.state is not None

        def _dedupe(values: list[str]) -> list[str]:
            seen: set[str] = set()
            ordered: list[str] = []
            for value in values:
                if not value or value in seen:
                    continue
                seen.add(value)
                ordered.append(value)
            return ordered

        if not requested_plan_ids:
            batch_order = [
                plan_id
                for batch in self.state.batches
                for plan_id in batch.ordered_plan_ids
            ]
            pending_outside_batches = [
                plan.plan_id
                for plan in self.state.plans
                if plan.status in {"pending", "paused"} and plan.plan_id not in batch_order
            ]
            requested_plan_ids = batch_order + pending_outside_batches

        launch_priority_ids = [
            plan.plan_id
            for plan in self.state.plans
            if plan.launch_requested and plan.status in {"pending", "paused"}
        ]
        candidate_ids = _dedupe(launch_priority_ids + requested_plan_ids)
        return [
            plan_id
            for plan_id in candidate_ids
            if (plan := self.state.get_plan_by_id(plan_id)) is not None
            and plan.status in {"pending", "paused"}
        ]

    def _resolve_target_batch(self, payload: dict[str, Any]) -> DispatchBatchState | None:
        assert self.state is not None
        requested_dispatch_turn_index = payload.get("dispatch_turn_index")
        if isinstance(requested_dispatch_turn_index, int):
            for batch in self.state.master_agent_state.dispatch_batches:
                if batch.dispatch_turn_index == requested_dispatch_turn_index:
                    return batch
        if self.state.master_agent_state.dispatch_batches:
            return self.state.master_agent_state.dispatch_batches[-1]
        return None

    def _create_plans_call_index(self) -> int:
        assert self.state is not None
        return (
            sum(
                1
                for entry in self.state.timeline
                if entry.entry_type == "create_plans"
            )
            + 1
        )

    def _load_replay_plan_texts(self, call_index: int) -> list[str]:
        if not self.create_plans_replay_enabled:
            return []
        cache_path = Path(__file__).resolve().parents[1] / "cache.json"
        if not cache_path.exists():
            return []
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        raw_texts = payload.get(str(call_index))
        if not isinstance(raw_texts, list):
            return []
        replay_texts = [str(item or "").strip() for item in raw_texts if str(item or "").strip()]
        return replay_texts

    @staticmethod
    def _load_dataset_info(dataset_path: str) -> dict[str, Any]:
        path = Path(dataset_path)
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return {
                "dataset_path": dataset_path,
                "rows": 0,
                "columns": [],
                "sample_rows": [],
            }
        delimiter = sniff_csv_delimiter_from_text(text)
        reader = csv.DictReader(text.splitlines(), delimiter=delimiter)
        sample_rows: list[dict[str, str]] = []
        row_count = 0
        fieldnames = [str(item or "") for item in reader.fieldnames or []]
        for row in reader:
            row_count += 1
            if len(sample_rows) < 5:
                sample_rows.append(
                    {str(key or ""): str(value or "") for key, value in (row or {}).items()}
                )
        return {
            "dataset_path": dataset_path,
            "rows": row_count,
            "delimiter": delimiter,
            "columns": [{"name": name, "dtype": "unknown"} for name in fieldnames],
            "sample_rows": sample_rows,
        }

    @staticmethod
    def _dataset_schema_text(dataset_info: dict[str, Any]) -> str:
        columns = [item.get("name", "") for item in dataset_info.get("columns", []) if isinstance(item, dict)]
        return (
            f"Shape: {dataset_info.get('rows', 0)} rows, {len(columns)} columns\n"
            f"Columns: {columns}\n"
        )

    def _normalize_resumed_state(self) -> None:
        assert self.state is not None
        for plan in self.state.plans:
            if plan.status == "analyzing":
                plan.status = "paused"
                plan.control_state = "none"
                if not plan.resume_phase:
                    plan.resume_phase = "analyzing"
            elif plan.status == "summarizing":
                plan.status = "paused"
                plan.control_state = "none"
                plan.resume_phase = "summarizing"
        for batch in self.state.master_agent_state.dispatch_batches:
            if batch.plan_ids:
                self._sync_batches_for_plan_transition(batch.plan_ids[0])

    def _initialize_offsets_from_existing_files(self) -> None:
        self._steer_offset = self.store.steer_path.stat().st_size if self.store.steer_path.exists() else 0
        self._plan_control_offset = (
            self.store.plan_controls_path.stat().st_size if self.store.plan_controls_path.exists() else 0
        )
