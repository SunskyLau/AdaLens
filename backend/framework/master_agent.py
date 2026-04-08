"""
Master-agent loop for v0.1.
"""

from __future__ import annotations

import asyncio
import csv
import inspect
import json
import os
import re
from pathlib import Path
from time import monotonic
from typing import Any, Callable

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from cache_normalization import (  # noqa: E402
    build_dataset_identity,
    build_master_cache_normalization_context,
)
from model_cache import (  # noqa: E402
    activate_timestamp_binding,
    build_model_cache_run_context,
    consume_last_model_cache_binding,
    finalize_timestamp_binding,
    runtime_requires_serial_sub_agent_execution,
    use_model_cache_normalization_context,
    use_model_cache_run_context,
)
from runtime_clock import now_iso  # noqa: E402

from config import (  # noqa: E402
    create_chat_completion_with_sampling_controls,
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_MAX_INITIAL_PLANS,
    MASTER_AGENT_IDLE_TIMEOUT_SECS,
    MASTER_AGENT_MAX_TOKENS,
    MASTER_AGENT_MODEL_NAME,
    MASTER_AGENT_SYSTEM_PROMPT,
    MASTER_AGENT_TEMPERATURE,
    OPENAI_API_KEY,
    OPENAI_CLIENT,
    RESPOND_TO_USER_MAX_TOKENS,
    RESPOND_TO_USER_MODEL_NAME,
    RESPOND_TO_USER_TEMPERATURE,
    RUN_CONTROL_STOP_FILE,
    set_stable_llm_output_enabled,
)
from .context_builder import ContextBuilder
from .csv_utils import sniff_csv_delimiter_from_text
from .language_context import (
    contains_cjk_text,
    canonical_user_message_text,
    latest_user_authored_text,
    latest_user_prefers_chinese,
    strict_language_match_instruction,
)
from .models import (
    DispatchBatchState,
    Insight,
    PlanItem,
    ProvenanceCitation,
    RunSettings,
    RunState,
    SteeringTargetSnapshot,
    SubAgentResult,
    Turn,
    TimelineEntry,
    UserMessage,
    clamp_max_concurrency,
    normalize_steering_message_kind,
)
from .plan_control import (
    PlanControlRequest,
    apply_control_request_to_plan,
    latest_requests_by_plan,
    read_plan_control_requests,
)
from .steering_focus import append_focus_to_turn
from .steering_elaborate import append_elaborate_to_turn
from .steering_ignore import append_ignore_to_turn
from .store import RunStore
from .sub_agent import SubAgent
from .summary_window import (
    latest_summary_boundary_dispatch_turn_index,
    stage_summary_scope_batches,
)
from .tool_registry import build_master_tool_specs
from .user_steer import UserSteerQueue
from .runtime_control import RuntimeControlRequest, read_runtime_control_requests

DecisionProvider = Callable[[RunState, list[dict[str, Any]]], list[dict[str, Any]]]
ProgressCallback = Callable[[str], None]
CREATE_PLANS_REPLAY_ENV = "AGENTIC_EDA_CREATE_PLANS_REPLAY"


class MasterAgent:

    def __init__(
        self,
        *,
        store: RunStore | None = None,
        settings: RunSettings | None = None,
        context_builder: ContextBuilder | None = None,
        decision_provider: DecisionProvider | None = None,
        sub_agent_factory: Callable[[], Any] | None = None,
        max_initial_plans: int = DEFAULT_MAX_INITIAL_PLANS,
        idle_timeout_seconds: float = MASTER_AGENT_IDLE_TIMEOUT_SECS,
        progress_callback: ProgressCallback | None = None,
    ):
        self.store = store
        self.settings = settings or RunSettings(max_concurrency=DEFAULT_MAX_CONCURRENCY)
        self._sync_runtime_llm_stability()
        self.context_builder = context_builder or ContextBuilder()
        self.decision_provider = decision_provider
        self.sub_agent_factory = sub_agent_factory
        self.max_initial_plans = max(1, max_initial_plans)
        self.idle_timeout_seconds = max(0.0, idle_timeout_seconds)
        self.progress_callback = progress_callback
        self.state: RunState | None = None
        self.user_steer_queue = UserSteerQueue()
        self._active_tasks: dict[str, asyncio.Task[SubAgentResult]] = {}
        self._active_task_generations: dict[str, int] = {}
        self._detached_tasks: set[asyncio.Task[Any]] = set()
        self._plan_run_generations: dict[str, int] = {}
        self._latest_synthesis = ""
        self._stop_requested = False
        self._idle_started_at: float | None = None
        self._plan_control_offset = 0
        self._runtime_control_offset = 0
        self._pending_direct_user_create_launch_plan_ids: list[str] = []

    def _sub_agent_run_kwargs(
        self,
        sub_agent: Any,
        *,
        resume_phase: str | None = None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        try:
            parameters = inspect.signature(sub_agent.run).parameters
        except Exception:
            parameters = {}
        if resume_phase is not None and "resume_phase" in parameters:
            kwargs["resume_phase"] = resume_phase
        if self.state is not None and "user_messages" in parameters:
            kwargs["user_messages"] = self.state.user_messages
        return kwargs

    def _append_timeline_entry(self, entry_type: str, content: Any) -> None:
        """Append an entry to the current running Turn's timeline."""
        if self.state is None:
            return
        current = self.state.current_turn()
        if current is None:
            return
        current.timeline.append(TimelineEntry(entry_type=entry_type, content=content))

    def _sync_runtime_llm_stability(self) -> None:
        set_stable_llm_output_enabled(self.settings.stable_llm_output)

    async def run(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        dataset_info_override: dict[str, Any] | None = None,
        resume: bool = False,
        resume_message: UserMessage | None = None,
    ) -> RunState:
        self._active_tasks = {}
        self._active_task_generations = {}
        self._detached_tasks = set()
        self._plan_run_generations = {}
        self._latest_synthesis = ""
        self._stop_requested = False
        self._idle_started_at = None
        self._plan_control_offset = 0
        self._runtime_control_offset = 0
        self._pending_direct_user_create_launch_plan_ids = []
        self.user_steer_queue = UserSteerQueue()
        self._initialize(
            dataset_path=dataset_path,
            user_goal=user_goal,
            dataset_info_override=dataset_info_override,
            resume=resume,
            resume_message=resume_message,
        )
        assert self.state is not None

        while not self._should_stop():
            finished_results = await self._collect_finished_sub_agents()
            self._check_stop_file()
            applied_runtime_controls = await self._process_runtime_controls()
            applied_plan_controls = await self._process_plan_controls()
            saw_new_steer = self._process_user_steer()
            if self.state.master_agent_state.completed and not self._active_tasks:
                self._enter_completed_wait_state()
            if self.state.status in {"completed", "idle"} and self.state.master_agent_state.completed:
                if self._completion_wait_timed_out():
                    break
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue
            if self._should_stop(
                allow_post_processing=(
                    finished_results
                    or saw_new_steer
                    or applied_plan_controls
                    or applied_runtime_controls
                )
            ):
                break

            pending_user_response_tool_call = self._build_next_pending_user_response_tool_call()
            tool_calls_from_model_or_fallback = False
            active_timestamp_binding = None
            if pending_user_response_tool_call is not None:
                tool_calls = [pending_user_response_tool_call]
                active_timestamp_binding = pending_user_response_tool_call.get("_timestamp_binding")
            else:
                pending_direct_user_create_dispatch_tool_call = (
                    self._build_next_pending_direct_user_create_dispatch_tool_call()
                )
                if pending_direct_user_create_dispatch_tool_call is not None:
                    tool_calls = [pending_direct_user_create_dispatch_tool_call]
                else:
                    batch_finished_user_response = (
                        self._build_next_batch_finished_user_response_tool_call()
                    )
                    if batch_finished_user_response is not None:
                        tool_calls = [batch_finished_user_response]
                    else:
                        tool_calls = None

            if (
                tool_calls is None
                and await self._process_pending_direct_user_create_launches()
            ):
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue

            # Wait for ALL active sub-agents to finish before calling the LLM,
            # so the master agent sees complete results before deciding next steps.
            # Exception: user steer messages interrupt the wait immediately.
            if tool_calls is None and self._active_tasks and not saw_new_steer:
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue
            if tool_calls is None and self._should_wait_for_paused_batch():
                self._refresh_run_status_from_plans()
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue

            if tool_calls is None:
                self._emit_progress(
                    f"Loop {self.state.master_agent_state.loop_count + 1}: calling master agent"
                )
                tool_calls, active_timestamp_binding = await self._call_llm()
                if not tool_calls:
                    tool_calls = self._fallback_decision()
                    active_timestamp_binding = None
                tool_calls_from_model_or_fallback = True

            tool_calls = self._ensure_post_steer_follow_up_planning(tool_calls)
            tool_calls = self._filter_summary_tool_calls_until_all_plans_terminal(tool_calls)
            tool_calls = self._ensure_post_summary_user_responses(tool_calls)
            tool_calls = self._filter_disallowed_respond_to_user_tool_calls(tool_calls)

            if tool_calls_from_model_or_fallback and not tool_calls:
                tool_calls = self._fallback_decision()
                active_timestamp_binding = None
                tool_calls = self._ensure_post_steer_follow_up_planning(tool_calls)
                tool_calls = self._filter_summary_tool_calls_until_all_plans_terminal(tool_calls)
                tool_calls = self._ensure_post_summary_user_responses(tool_calls)
                tool_calls = self._filter_disallowed_respond_to_user_tool_calls(tool_calls)

            if not tool_calls and self._active_tasks:
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue
            if not tool_calls:
                await asyncio.sleep(self.settings.poll_interval_seconds)
                continue

            try:
                with activate_timestamp_binding(active_timestamp_binding):
                    self.store.log_master_agent_thinking(
                        thought=json.dumps(
                            {"tool_names": [item.get("name", "") for item in tool_calls]},
                            ensure_ascii=False,
                        ),
                        loop_count=self.state.master_agent_state.loop_count,
                    )
                    if tool_calls:
                        self._emit_progress(
                            "Executing tools: "
                            + ", ".join(item.get("name", "") for item in tool_calls)
                        )
                    await self._execute_tool_calls(tool_calls)
                    if tool_calls:
                        self.state.step += 1
                    self.state.master_agent_state.loop_count += 1
                    self.store.save_state(self.state)
            finally:
                finalize_timestamp_binding(active_timestamp_binding)

            if self._active_tasks and not self._stop_requested:
                await asyncio.sleep(self.settings.poll_interval_seconds)

        while self._stop_requested and self._active_tasks:
            await asyncio.sleep(self.settings.poll_interval_seconds)
            await self._collect_finished_sub_agents()
        await self._collect_finished_sub_agents()
        if self._stop_requested and self.state is not None and self.state.status == "running":
            old_status = self.state.status
            self.state.status = "stopped"
            self.store.log_run_status_change(old_status, "stopped", "stop requested")
        await self._finalize()
        return self.state

    def _model_cache_run_context(self):
        if self.store is None:
            return None
        return build_model_cache_run_context(getattr(self.store, "run_dir", None))

    def _effective_max_concurrency(self) -> int:
        configured = (
            self.state.settings.max_concurrency
            if self.state is not None
            else self.settings.max_concurrency
        )
        if runtime_requires_serial_sub_agent_execution():
            return 1
        return max(1, configured)

    def _initialize(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        dataset_info_override: dict[str, Any] | None,
        resume: bool = False,
        resume_message: UserMessage | None = None,
    ) -> None:
        if resume:
            self._restore_from_store(
                dataset_path=dataset_path,
                user_goal=user_goal,
                dataset_info_override=dataset_info_override,
                resume_message=resume_message,
            )
            return

        state = RunState.create(
            dataset_path=dataset_path,
            user_goal=user_goal,
            settings=self.settings,
        )
        if self.store is None:
            self.store = RunStore(run_id=state.run_id)
            self.store.initialize()
        else:
            state.run_id = self.store.run_id
            self.store.initialize()

        info = dataset_info_override or self._load_dataset_info(dataset_path)
        info["dataset_path"] = dataset_path
        info["dataset_schema"] = self._dataset_schema_text(info)
        state.dataset_info = info
        state.dataset_schema = str(info.get("dataset_schema", ""))
        state.status = "running"
        self.state = state
        self._sync_runtime_llm_stability()
        self.user_steer_queue.attach(state=state, store=self.store)
        if user_goal.strip():
            self._append_initial_user_goal(user_goal)
            state.turns.append(Turn(turn_id=0, goal=self._canonical_message_text(state.user_messages[-1])))
        self.store.save_state(state)
        self.store.log_run_status_change("pending", "running", "run initialized")
        self._plan_control_offset = (
            self.store.plan_controls_path.stat().st_size
            if self.store.plan_controls_path.exists()
            else 0
        )
        self._runtime_control_offset = (
            self.store.runtime_controls_path.stat().st_size
            if self.store.runtime_controls_path.exists()
            else 0
        )
        self._emit_progress(f"Run initialized: {state.run_id}")

    def _restore_from_store(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        dataset_info_override: dict[str, Any] | None,
        resume_message: UserMessage | None,
    ) -> None:
        if self.store is None:
            raise ValueError("resume=True requires an existing RunStore")

        self.store.initialize()
        state = self.store.load_state()
        if state is None:
            raise ValueError("resume=True requires an existing persisted run state")

        incoming_dataset_path = dataset_path.strip()
        persisted_dataset_path = str(state.dataset_path or "").strip()
        dataset_path_changed = bool(incoming_dataset_path) and incoming_dataset_path != persisted_dataset_path
        if dataset_path_changed:
            state.dataset_path = incoming_dataset_path
            info = dataset_info_override or self._load_dataset_info(incoming_dataset_path)
            info["dataset_path"] = incoming_dataset_path
            info["dataset_schema"] = self._dataset_schema_text(info)
            state.dataset_info = info
            state.dataset_schema = str(info.get("dataset_schema", ""))
        elif not state.dataset_path and incoming_dataset_path:
            state.dataset_path = incoming_dataset_path
        effective_dataset_path = state.dataset_path or incoming_dataset_path
        if not state.dataset_info:
            info = dataset_info_override or self._load_dataset_info(effective_dataset_path)
            info["dataset_path"] = effective_dataset_path
            info["dataset_schema"] = self._dataset_schema_text(info)
            state.dataset_info = info
        if not state.dataset_schema:
            state.dataset_schema = self._dataset_schema_text(state.dataset_info)

        stop_path = self.store.run_dir / RUN_CONTROL_STOP_FILE
        if stop_path.exists():
            stop_path.unlink(missing_ok=True)

        resume_stable_llm_output = self.settings.stable_llm_output
        self.settings = state.settings
        if resume_stable_llm_output and not self.settings.stable_llm_output:
            self.settings.stable_llm_output = True
        self._sync_runtime_llm_stability()
        self._normalize_resumed_state(state)
        # Bootstrap Turn for old state.json files that lack turns
        if not state.turns:
            goals = state.master_agent_state.current_goals or []
            goal_text = goals[0] if goals else user_goal or ""
            if goal_text:
                state.turns.append(Turn(turn_id=0, goal=goal_text))
        self.state = state
        self.user_steer_queue.attach(state=state, store=self.store)
        if resume_message is not None:
            self.user_steer_queue.enqueue(resume_message, persist=False)
        elif user_goal.strip():
            self.user_steer_queue.push(user_goal)
        self.store.save_state(state)
        self._plan_control_offset = (
            self.store.plan_controls_path.stat().st_size
            if self.store.plan_controls_path.exists()
            else 0
        )
        self._runtime_control_offset = (
            self.store.runtime_controls_path.stat().st_size
            if self.store.runtime_controls_path.exists()
            else 0
        )
        self._emit_progress(f"Run resumed: {state.run_id}")

    def _normalize_resumed_state(self, state: RunState) -> None:
        active_plan_ids = set(state.master_agent_state.active_plan_ids)
        reset_any_plan = False

        for plan in state.plans:
            if plan.status not in {"analyzing", "summarizing"} and plan.plan_id not in active_plan_ids:
                continue
            if plan.status in {"analyzing", "summarizing"}:
                plan.resume_phase = SubAgent.resume_phase_for_status(plan.status)
            plan.status = "pending"
            plan.control_state = "none"
            plan.assigned_sub_agent_id = None
            plan.updated_at = now_iso()
            reset_any_plan = True

        state.master_agent_state.active_plan_ids = []
        if reset_any_plan:
            state.master_agent_state.completed = False
            if state.status in {"completed", "idle", "running"}:
                state.status = "running"
        if state.status == "running" and state.master_agent_state.completed and not reset_any_plan:
            state.status = "completed"
        self._sync_dispatch_batches(state)

    def _load_dataset_info(self, dataset_path: str) -> dict[str, Any]:
        path = Path(dataset_path)
        info: dict[str, Any] = {"rows": 0, "columns": [], "sample_rows": [], "delimiter": ","}
        if not path.exists():
            return info

        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(16384)
            delimiter = sniff_csv_delimiter_from_text(sample)
            handle.seek(0)
            reader = csv.DictReader(handle, delimiter=delimiter)
            sample_rows: list[dict[str, Any]] = []
            row_count = 0
            for row in reader:
                row_count += 1
                if len(sample_rows) < 5:
                    sample_rows.append(dict(row))
            fieldnames = reader.fieldnames or []

        info["rows"] = row_count
        info["columns"] = [{"name": name, "dtype": "unknown"} for name in fieldnames]
        info["sample_rows"] = sample_rows
        info["delimiter"] = delimiter
        info["dataset_schema"] = self._dataset_schema_text(info)
        return info

    @staticmethod
    def _message_kind(message: UserMessage) -> str:
        return normalize_steering_message_kind(message.kind) or "chat"

    @staticmethod
    def _canonical_message_text(message: UserMessage) -> str:
        return (message.user_prompt or message.generated_prompt or message.content or "").strip()

    @staticmethod
    def _normalize_plan_identity_text(text: str) -> str:
        return " ".join(str(text or "").split()).casefold()

    def _current_turn_goal_identity_text(self) -> str:
        if self.state is None:
            return ""
        current_turn = self.state.current_turn()
        if current_turn is None:
            return ""
        return self._normalize_plan_identity_text(current_turn.goal)

    def _user_authored_plan_identity_texts(self) -> set[str]:
        if self.state is None:
            return set()
        normalized_texts: set[str] = set()
        for message in self.state.user_messages:
            normalized = self._normalize_plan_identity_text(
                self._canonical_message_text(message)
            )
            if normalized:
                normalized_texts.add(normalized)
        return normalized_texts

    def _existing_plan_identity_texts(self) -> set[str]:
        if self.state is None:
            return set()
        return {
            normalized
            for normalized in (
                self._normalize_plan_identity_text(plan.text)
                for plan in self.state.plans
            )
            if normalized
        }

    def _reused_plan_text_reason(self, text: str) -> str | None:
        if self.state is None:
            return None
        normalized_text = self._normalize_plan_identity_text(text)
        if not normalized_text:
            return None
        if normalized_text in self._existing_plan_identity_texts():
            return "duplicate_existing_plan"
        if self.state.plans and normalized_text == self._current_turn_goal_identity_text():
            return "duplicate_turn_goal"
        if self.state.plans and normalized_text in self._user_authored_plan_identity_texts():
            return "duplicate_user_message"
        return None

    @staticmethod
    def _message_requires_leading_user_response(kind: str) -> bool:
        return kind in {"chat", "focus", "ignore", "elaborate", "create"}

    def _enqueue_pending_user_response(self, message: UserMessage) -> bool:
        assert self.state is not None
        kind = self._message_kind(message)
        if not self._message_requires_leading_user_response(kind):
            return False
        pending_ids = self.state.master_agent_state.pending_user_response_message_ids
        if message.message_id in pending_ids:
            return False
        pending_ids.append(message.message_id)
        return True

    def _pending_user_response_messages(self) -> list[UserMessage]:
        assert self.state is not None
        messages_by_id = {
            message.message_id: message
            for message in self.state.user_messages
        }
        pending_ids = self.state.master_agent_state.pending_user_response_message_ids
        cleaned_ids: list[str] = []
        pending_messages: list[UserMessage] = []
        seen: set[str] = set()
        for message_id in pending_ids:
            if not message_id or message_id in seen:
                continue
            seen.add(message_id)
            message = messages_by_id.get(message_id)
            if message is None:
                continue
            cleaned_ids.append(message_id)
            pending_messages.append(message)
        if cleaned_ids != pending_ids:
            self.state.master_agent_state.pending_user_response_message_ids = cleaned_ids
        return pending_messages

    def _has_pending_user_responses(self) -> bool:
        return bool(self.state is not None and self._pending_user_response_messages())

    def _acknowledge_pending_user_response(self, message_id: str | None) -> None:
        if self.state is None or not message_id:
            return
        self.state.master_agent_state.pending_user_response_message_ids = [
            existing_id
            for existing_id in self.state.master_agent_state.pending_user_response_message_ids
            if existing_id != message_id
        ]

    def _pending_direct_user_create_dispatch_plan_ids(self) -> list[str]:
        assert self.state is not None
        queued_ids = self.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids
        cleaned_ids: list[str] = []
        seen: set[str] = set()
        for raw_plan_id in queued_ids:
            plan_id = str(raw_plan_id or "").strip()
            if not plan_id or plan_id in seen:
                continue
            seen.add(plan_id)
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            if self._dispatch_batch_for_plan(plan_id) is not None:
                continue
            cleaned_ids.append(plan_id)
        if cleaned_ids != queued_ids:
            self.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids = (
                cleaned_ids
            )
        return cleaned_ids

    def _enqueue_pending_direct_user_create_dispatch_plan_id(self, plan_id: str) -> bool:
        assert self.state is not None
        normalized_plan_id = str(plan_id or "").strip()
        if not normalized_plan_id:
            return False
        queued_ids = self._pending_direct_user_create_dispatch_plan_ids()
        if normalized_plan_id in queued_ids:
            return False
        self.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids = [
            *queued_ids,
            normalized_plan_id,
        ]
        return True

    def _dequeue_pending_direct_user_create_dispatch_plan_ids(
        self,
        plan_ids: list[str],
    ) -> None:
        if self.state is None:
            return
        remove_ids = {
            str(plan_id or "").strip()
            for plan_id in plan_ids
            if str(plan_id or "").strip()
        }
        if not remove_ids:
            return
        self.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids = [
            existing_id
            for existing_id in self._pending_direct_user_create_dispatch_plan_ids()
            if existing_id not in remove_ids
        ]

    def _clear_pending_direct_user_create_dispatch_queue(self) -> None:
        if self.state is None:
            return
        self.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids = []

    def _prefers_chinese_response(self, message: UserMessage | None = None) -> bool:
        if message is not None:
            canonical_text = canonical_user_message_text(message)
            if canonical_text:
                return latest_user_prefers_chinese([message])
        if self.state is None:
            return False
        return latest_user_prefers_chinese(self.state.user_messages)

    def _latest_chat_message(self) -> UserMessage | None:
        if self.state is None or not self.state.user_messages:
            return None
        message = self.state.user_messages[-1]
        if self._message_kind(message) != "chat":
            return None
        return message

    def _pending_stop_completion_message(self) -> UserMessage | None:
        if self.state is None:
            return None
        message_id = str(
            self.state.master_agent_state.pending_stop_completion_message_id or ""
        ).strip()
        if not message_id:
            return None
        for message in self.state.user_messages:
            if message.message_id == message_id:
                return message
        return None

    def _pending_stop_completion_active(self) -> bool:
        return self._pending_stop_completion_message() is not None

    def _clear_pending_stop_completion(self) -> None:
        if self.state is None:
            return
        self.state.master_agent_state.pending_stop_completion_message_id = None

    def _mark_pending_stop_completion(self, message_id: str | None) -> None:
        if self.state is None:
            return
        normalized_message_id = str(message_id or "").strip()
        if not normalized_message_id:
            return
        self.state.master_agent_state.pending_stop_completion_message_id = (
            normalized_message_id
        )

    def _generic_goal_fallback_is_allowed(self) -> bool:
        return (
            self._latest_chat_message() is not None
            and not self._pending_stop_completion_active()
        )

    _BROKEN_LEADING_USER_RESPONSE_BLOCK = """

    def _describe_user_response_target(self, message: UserMessage, *, chinese: bool) -> str:
        target = message.target
        if target is None:
            return "当前请求" if chinese else "your latest request"
        if target.kind == "column":
            columns = [column.strip() for column in target.columns if column.strip()]
            if not columns:
                return "这组选中的列" if chinese else "the selected column group"
            delimiter = "、" if chinese else ", "
            joined = delimiter.join(columns)
            return f"列 {joined}" if chinese else f"the columns {joined}"
        label = self._default_citation_label(target).strip()
        if not label:
            if target.kind == "atomic":
                return "这条 insight" if chinese else "that insight"
            return "这条 summary" if chinese else "that summary"
        if target.kind == "atomic":
            return f"“{label}”这条 insight" if chinese else f'the insight "{label}"'
        return f"“{label}”这条 summary" if chinese else f'the summary "{label}"'

    def _build_leading_user_response(self, message: UserMessage) -> dict[str, Any]:
        kind = self._message_kind(message)
        chinese = self._prefers_chinese_response(message)
        target_label = self._describe_user_response_target(message, chinese=chinese)
        if chinese:
            if kind == "focus":
                response = f"我会优先围绕{target_label}继续分析，并相应调整后续计划。"
            elif kind == "ignore":
                response = f"我会在后续分析里避开{target_label}这条方向，除非回答主目标时确实别无选择。"
            elif kind == "elaborate":
                response = f"我会继续围绕{target_label}深挖它的解释和成因。"
            elif kind == "create":
                response = "我已接收你新增的分析计划，接下来会把它纳入当前流程。"
            else:
                response = "我收到你的最新需求了，接下来会按这个方向继续推进分析。"
        else:
            if kind == "focus":
                response = f"I'll prioritize follow-up analysis around {target_label} and adjust the next plans accordingly."
            elif kind == "ignore":
                response = f"I'll avoid spending future analysis on {target_label} unless it becomes necessary to answer the main goal."
            elif kind == "elaborate":
                response = f"I'll keep the next follow-up tightly centered on {target_label} and dig further into its explanation and causes."
            elif kind == "create":
                response = "I've accepted your requested analysis plan and will route it through the current run flow next."
            else:
                response = "I received your latest request and will use it to steer the next analysis steps."
        return {
            "name": "respond_to_user",
            "arguments": {"message": response},
            "_pending_user_response_message_id": message.message_id,
        }

    """

    def _describe_user_response_target(self, message: UserMessage, *, chinese: bool) -> str:
        target = message.target
        if target is None:
            return "\u5f53\u524d\u8bf7\u6c42" if chinese else "your latest request"
        if target.kind == "column":
            columns = [column.strip() for column in target.columns if column.strip()]
            if not columns:
                return "\u8fd9\u7ec4\u9009\u4e2d\u7684\u5217" if chinese else "the selected column group"
            delimiter = "\u3001" if chinese else ", "
            joined = delimiter.join(columns)
            return f"\u5217 {joined}" if chinese else f"the columns {joined}"
        label = self._default_citation_label(target).strip()
        if not label:
            if target.kind == "atomic":
                return "\u8fd9\u6761 insight" if chinese else "that insight"
            return "\u8fd9\u6761 summary" if chinese else "that summary"
        if target.kind == "atomic":
            return f"\u201c{label}\u201d\u8fd9\u6761 insight" if chinese else f'the insight "{label}"'
        return f"\u201c{label}\u201d\u8fd9\u6761 summary" if chinese else f'the summary "{label}"'

    @staticmethod
    def _strip_background_section(text: str) -> str:
        working = str(text or "")
        for marker in ("\n\nBackground:\n", "\nBackground:\n", "\n\n\u80cc\u666f\uff1a\n", "\n\u80cc\u666f\uff1a\n"):
            if marker in working:
                working = working.split(marker, 1)[0]
        return working.strip()

    def _leading_user_response_request_text(self, message: UserMessage) -> str:
        kind = self._message_kind(message)
        if kind == "create":
            return str(message.content or canonical_user_message_text(message)).strip()
        return str(canonical_user_message_text(message) or "").strip()

    def _leading_user_response_keywords(self, message: UserMessage, *, chinese: bool) -> str:
        keywords = [keyword.strip() for keyword in message.selected_keywords if keyword.strip()]
        if not keywords:
            return ""
        delimiter = "\u3001" if chinese else ", "
        return delimiter.join(keywords)

    @staticmethod
    def _normalize_model_text_content(content: Any) -> str:
        if isinstance(content, str):
            return " ".join(content.split()).strip()
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str) and item.strip():
                    parts.append(item.strip())
                    continue
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
            return " ".join(" ".join(parts).split()).strip()
        return " ".join(str(content or "").split()).strip()

    @staticmethod
    def _strip_leading_user_response_label(text: str) -> str:
        normalized = " ".join(str(text or "").split()).strip()
        if not normalized:
            return ""
        prefixes = (
            "acknowledgement:",
            "acknowledgment:",
            "reply:",
            "response:",
            "确认：",
            "确认:",
            "回复：",
            "回复:",
            "答复：",
            "答复:",
        )
        lowered = normalized.lower()
        for prefix in prefixes:
            if lowered.startswith(prefix.lower()):
                stripped = normalized[len(prefix) :].strip()
                return stripped.strip("\"' ")
        return normalized

    @staticmethod
    def _parse_leading_user_response_payload(
        content: Any,
    ) -> dict[str, Any] | None:
        def _raw_text(value: Any) -> str:
            if isinstance(value, str):
                return value.strip()
            if isinstance(value, list):
                parts: list[str] = []
                for item in value:
                    if isinstance(item, str) and item.strip():
                        parts.append(item.strip())
                        continue
                    if isinstance(item, dict):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                return "\n".join(parts).strip()
            return str(value or "").strip()

        raw_text = _raw_text(content)
        if not raw_text:
            return None

        candidates: list[str] = [raw_text]
        if raw_text.startswith("```"):
            lines = raw_text.splitlines()
            if len(lines) >= 3 and lines[-1].strip().startswith("```"):
                inner = "\n".join(lines[1:-1]).strip()
                if inner.casefold().startswith("json"):
                    inner = inner[4:].lstrip()
                if inner:
                    candidates.append(inner)
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start >= 0 and end > start:
            candidates.append(raw_text[start : end + 1])

        for candidate in candidates:
            try:
                payload = json.loads(candidate)
            except Exception:
                continue
            if isinstance(payload, dict):
                return payload
        return None

    def _build_leading_user_response_fallback_message(self, message: UserMessage) -> str:
        kind = self._message_kind(message)
        chinese = self._prefers_chinese_response(message)
        target_label = self._describe_user_response_target(message, chinese=chinese)
        request_text = self._leading_user_response_request_text(message)
        keyword_text = self._leading_user_response_keywords(message, chinese=chinese)
        if chinese:
            if kind == "focus":
                if keyword_text:
                    response = f"\u6536\u5230\uff0c\u6211\u4f1a\u4f18\u5148\u56f4\u7ed5{target_label}\u7ee7\u7eed\u5206\u6790\uff0c\u91cd\u70b9\u770b{keyword_text}\u3002"
                else:
                    response = f"\u6536\u5230\uff0c\u6211\u4f1a\u4f18\u5148\u56f4\u7ed5{target_label}\u7ee7\u7eed\u5206\u6790\uff0c\u5e76\u76f8\u5e94\u8c03\u6574\u540e\u7eed\u8ba1\u5212\u3002"
            elif kind == "ignore":
                if keyword_text:
                    response = f"\u6536\u5230\uff0c\u6211\u4f1a\u5728\u540e\u7eed\u5206\u6790\u91cc\u5148\u907f\u5f00{target_label}\uff0c\u5c24\u5176\u4e0d\u518d\u5c55\u5f00{keyword_text}\u8fd9\u6761\u65b9\u5411\u3002"
                else:
                    response = f"\u6536\u5230\uff0c\u6211\u4f1a\u5728\u540e\u7eed\u5206\u6790\u91cc\u907f\u5f00{target_label}\u8fd9\u6761\u65b9\u5411\uff0c\u9664\u975e\u56de\u7b54\u4e3b\u76ee\u6807\u65f6\u786e\u5b9e\u522b\u65e0\u9009\u62e9\u3002"
            elif kind == "elaborate":
                response = f"\u6536\u5230\uff0c\u6211\u4f1a\u7ee7\u7eed\u56f4\u7ed5{target_label}\u6df1\u6316\u5b83\u7684\u89e3\u91ca\u548c\u6210\u56e0\u3002"
            elif kind == "create":
                if request_text:
                    response = f"\u6536\u5230\uff0c\u6211\u4f1a\u628a\u4f60\u65b0\u589e\u7684\u5206\u6790\u60f3\u6cd5\u201c{request_text}\u201d\u7eb3\u5165\u5f53\u524d\u6d41\u7a0b\u3002"
                else:
                    response = "\u6536\u5230\uff0c\u6211\u4f1a\u628a\u4f60\u65b0\u589e\u7684\u5206\u6790\u60f3\u6cd5\u7eb3\u5165\u5f53\u524d\u6d41\u7a0b\u3002"
            else:
                if request_text:
                    response = f"\u6536\u5230\uff0c\u4f60\u521a\u624d\u63d0\u5230\u201c{request_text}\u201d\u3002\u6211\u4f1a\u5148\u6309\u8fd9\u4e2a\u65b9\u5411\u63a8\u8fdb\u63a5\u4e0b\u6765\u7684\u5206\u6790\u3002"
                else:
                    response = "\u6536\u5230\uff0c\u6211\u4f1a\u5148\u6309\u4f60\u521a\u624d\u7684\u9700\u6c42\u63a8\u8fdb\u63a5\u4e0b\u6765\u7684\u5206\u6790\u3002"
        else:
            if kind == "focus":
                if keyword_text:
                    response = f"Understood. I'll prioritize follow-up analysis around {target_label}, especially {keyword_text}."
                else:
                    response = f"Understood. I'll prioritize follow-up analysis around {target_label} and adjust the next plans accordingly."
            elif kind == "ignore":
                if keyword_text:
                    response = f"Understood. I'll deprioritize {target_label}, especially the {keyword_text} direction, unless it becomes necessary for the main goal."
                else:
                    response = f"Understood. I'll avoid spending future analysis on {target_label} unless it becomes necessary to answer the main goal."
            elif kind == "elaborate":
                response = f"Understood. I'll keep the next follow-up tightly centered on {target_label} and dig further into its explanation and causes."
            elif kind == "create":
                if request_text:
                    response = f'Understood. I\'ll add "{request_text}" into the current run flow next.'
                else:
                    response = "Understood. I'll add your requested analysis plan into the current run flow next."
            else:
                if request_text:
                    response = f'Understood. You asked for "{request_text}". I\'ll use that to steer the next analysis steps.'
                else:
                    response = "Understood. I'll use your latest request to steer the next analysis steps."
        return response

    def _build_leading_user_response_via_llm(
        self,
        message: UserMessage,
    ) -> tuple[str | None, Any | None]:
        if OPENAI_CLIENT is None or not OPENAI_API_KEY:
            return None, None
        kind = self._message_kind(message)
        chinese = self._prefers_chinese_response(message)
        request_text = self._leading_user_response_request_text(message)
        latest_user_text = request_text
        if self.state is not None:
            latest_user_text = latest_user_authored_text(self.state.user_messages) or request_text
        target_label = self._describe_user_response_target(message, chinese=chinese)
        keyword_text = self._leading_user_response_keywords(message, chinese=chinese)
        system_prompt = (
            "You write immediate runtime replies for a data-analysis assistant.\n"
            "Write exactly one short acknowledgement in 1-2 sentences.\n"
            "Sound like a concise human teammate in a live analysis session.\n"
            "Be specific to the concrete request details instead of using a stock template.\n"
            "Vary the wording naturally and avoid canned openings or fixed sentence patterns.\n"
            "Do not start with bare 'Understood', 'Got it', '收到', or '明白了' unless the rest of the sentence immediately becomes request-specific.\n"
            "Mention the actual direction, target, or selected keywords when they are useful.\n"
            "Do not mention tools, system prompts, policy, or internal orchestration.\n"
            "Do not promise final answers; only confirm the next analytical direction.\n"
            "Do not use markdown or bullet points.\n"
            "Return only the acknowledgement text.\n"
            + strict_language_match_instruction(latest_user_text)
        )
        user_prompt = "\n".join(
            [
                f"kind: {kind}",
                f"latest user-authored message for language matching: {latest_user_text or '<none>'}",
                f"current request text: {request_text or '<none>'}",
                f"display text: {message.display_text or '<none>'}",
                f"target: {target_label}",
                f"selected keywords: {keyword_text or '<none>'}",
                (
                    "Write only the acknowledgement text. Keep it short, natural, and specific to this request."
                    if not chinese
                    else "\u53ea\u8f93\u51fa\u786e\u8ba4\u56de\u590d\u672c\u8eab\u3002\u8bf7\u5199\u4e00\u53e5\u6216\u4e24\u53e5\u7b80\u77ed\u3001\u81ea\u7136\u3001\u76f4\u63a5\u54cd\u5e94\u8fd9\u6761\u5177\u4f53\u8bf7\u6c42\u7684\u786e\u8ba4\uff0c\u4e0d\u8981\u5957\u8bdd\u5316\u3002"
                ),
            ]
        )
        try:
            with use_model_cache_run_context(self._model_cache_run_context()):
                consume_last_model_cache_binding()
                response = create_chat_completion_with_sampling_controls(
                    OPENAI_CLIENT,
                    params={
                        "model": RESPOND_TO_USER_MODEL_NAME,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "max_tokens": min(RESPOND_TO_USER_MAX_TOKENS or 80, 80),
                    },
                    temperature=RESPOND_TO_USER_TEMPERATURE,
                )
                timestamp_binding = consume_last_model_cache_binding()
        except Exception:
            return None, None
        message_text = self._strip_leading_user_response_label(
            self._normalize_model_text_content(response.choices[0].message.content)
        )
        if not message_text:
            return None, None
        if chinese and not contains_cjk_text(message_text):
            return None, None
        return message_text, timestamp_binding

    def _build_leading_user_response(self, message: UserMessage) -> dict[str, Any]:
        response = None
        timestamp_binding = None
        if not self._is_stop_intent_message(message):
            response, timestamp_binding = self._build_leading_user_response_via_llm(message)
        if not response:
            response = self._build_leading_user_response_fallback_message(message)
        return {
            "name": "respond_to_user",
            "arguments": {"message": response},
            "_pending_user_response_message_id": message.message_id,
            "_timestamp_binding": timestamp_binding,
        }

    def _build_pending_user_response_tool_calls(self) -> list[dict[str, Any]]:
        return [
            self._build_leading_user_response(message)
            for message in self._pending_user_response_messages()
        ]

    def _build_next_pending_user_response_tool_call(self) -> dict[str, Any] | None:
        pending_messages = self._pending_user_response_messages()
        if not pending_messages:
            return None
        return self._build_leading_user_response(pending_messages[0])

    def _build_leading_user_response_via_llm(
        self,
        message: UserMessage,
    ) -> tuple[dict[str, Any] | None, Any | None]:
        if OPENAI_CLIENT is None or not OPENAI_API_KEY:
            return None, None
        kind = self._message_kind(message)
        chinese = self._prefers_chinese_response(message)
        request_text = self._leading_user_response_request_text(message)
        latest_user_text = request_text
        if self.state is not None:
            latest_user_text = latest_user_authored_text(self.state.user_messages) or request_text
        target_label = self._describe_user_response_target(message, chinese=chinese)
        keyword_text = self._leading_user_response_keywords(message, chinese=chinese)
        system_prompt = (
            "You write immediate runtime replies for a data-analysis assistant.\n"
            "Return exactly one JSON object with two keys: "
            "\"message\" (string) and \"probable_stop\" (boolean).\n"
            "The message must be one short acknowledgement in 1-2 sentences.\n"
            "Sound like a concise human teammate in a live analysis session.\n"
            "Be specific to the concrete request details instead of using a stock template.\n"
            "Vary the wording naturally and avoid canned openings or fixed sentence patterns.\n"
            "Do not mention tools, system prompts, policy, or internal orchestration.\n"
            "Do not promise final answers unless the user is clearly asking to end the current run.\n"
            "Set probable_stop=true only when the user is explicitly asking to stop, end, finish, or wrap up the current run or further analysis.\n"
            "Set probable_stop=false for ordinary chat, follow-up questions, or non-terminal steering.\n"
            "Do not use markdown, code fences, or extra keys.\n"
            + strict_language_match_instruction(latest_user_text)
        )
        user_prompt = "\n".join(
            [
                f"kind: {kind}",
                f"latest user-authored message for language matching: {latest_user_text or '<none>'}",
                f"current request text: {request_text or '<none>'}",
                f"display text: {message.display_text or '<none>'}",
                f"target: {target_label}",
                f"selected keywords: {keyword_text or '<none>'}",
                (
                    "Return only JSON. Keep the acknowledgement short, natural, and specific to this request."
                    if not chinese
                    else "鍙緭鍑?JSON 瀵硅薄銆傜‘璁ゅ洖澶嶈淇濇寔绠€鐭€佽嚜鐒躲€佸苟鐩存帴鍥炲簲杩欐潯璇锋眰銆?"
                ),
            ]
        )
        try:
            with use_model_cache_run_context(self._model_cache_run_context()):
                consume_last_model_cache_binding()
                response = create_chat_completion_with_sampling_controls(
                    OPENAI_CLIENT,
                    params={
                        "model": RESPOND_TO_USER_MODEL_NAME,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        "max_tokens": min(RESPOND_TO_USER_MAX_TOKENS or 120, 120),
                    },
                    temperature=RESPOND_TO_USER_TEMPERATURE,
                )
                timestamp_binding = consume_last_model_cache_binding()
        except Exception:
            return None, None
        payload = self._parse_leading_user_response_payload(
            response.choices[0].message.content
        )
        if not isinstance(payload, dict):
            return None, None
        message_text = self._strip_leading_user_response_label(
            str(payload.get("message", "")).strip()
        )
        if not message_text:
            return None, None
        if chinese and not contains_cjk_text(message_text):
            return None, None
        return {
            "message": message_text,
            "probable_stop": bool(payload.get("probable_stop", False)),
        }, timestamp_binding

    def _build_leading_user_response(self, message: UserMessage) -> dict[str, Any]:
        response_payload, timestamp_binding = self._build_leading_user_response_via_llm(message)
        if not response_payload:
            response_payload = {
                "message": self._build_leading_user_response_fallback_message(message),
                "probable_stop": False,
            }
        return {
            "name": "respond_to_user",
            "arguments": {"message": str(response_payload.get("message", "")).strip()},
            "_pending_user_response_message_id": message.message_id,
            "_probable_stop": bool(response_payload.get("probable_stop", False)),
            "_timestamp_binding": timestamp_binding,
        }

    def _append_stop_intent_message_to_turn(
        self,
        turn: Turn,
        message: UserMessage,
    ) -> None:
        turn.timeline.append(
            TimelineEntry(
                entry_type="user_stop_request",
                content=self._build_user_steer_timeline_content(message, "chat"),
            )
        )

    def _apply_stop_intent_to_run(
        self,
        message: UserMessage,
        *,
        turn: Turn | None = None,
    ) -> None:
        assert self.state is not None
        if turn is not None:
            self._append_stop_intent_message_to_turn(turn, message)
        self._pending_direct_user_create_launch_plan_ids = []
        self._clear_pending_direct_user_create_dispatch_queue()
        for plan in self.state.plans:
            if plan.status not in {"pending", "paused", "analyzing", "summarizing"}:
                continue
            request = PlanControlRequest(plan_id=plan.plan_id, action="terminate")
            if not apply_control_request_to_plan(plan, request):
                continue
            if plan.status == "terminated":
                plan.assigned_sub_agent_id = None
                self.state.master_agent_state.active_plan_ids = [
                    plan_id
                    for plan_id in self.state.master_agent_state.active_plan_ids
                    if plan_id != plan.plan_id
                ]
                self._persist_plan_update(plan)
                if turn is not None:
                    turn.timeline.append(
                        TimelineEntry(
                            entry_type="plan_terminated",
                            content={
                                "plan_id": plan.plan_id,
                                "plan_text": plan.text,
                            },
                        )
                    )
                continue
            self._persist_plan_update(plan)
        self._sync_dispatch_batches()
        self._refresh_run_status_from_plans()
        self.store.save_state(self.state)

    def _append_initial_user_goal(self, user_goal: str) -> None:
        assert self.state is not None
        message = UserMessage.create(content=user_goal, kind="chat")
        self.state.user_messages.append(message)
        self._enqueue_pending_user_response(message)
        self.user_steer_queue.attach(state=self.state, store=self.store)
        self.store.log_user_steer_received(message)

    def _set_plan_status(self, plan: PlanItem, status: str) -> None:
        assert self.state is not None
        if plan.status == status:
            return
        plan.status = status  # type: ignore[assignment]
        plan.updated_at = now_iso()
        self._persist_plan_update(plan)

    def _persist_plan_update(self, plan: PlanItem) -> None:
        assert self.state is not None
        plan.updated_at = now_iso()
        self.store.log_plan_status_changed(plan)
        self.store.save_state(self.state)

    def _set_run_status(self, new_status: str, reason: str = "") -> None:
        assert self.state is not None
        if self.state.status == new_status:
            return
        old_status = self.state.status
        self.state.status = new_status  # type: ignore[assignment]
        self.store.log_run_status_change(old_status, new_status, reason)
        self.store.save_state(self.state)

    def _should_pause_for_blocked_nonterminal_plans(self) -> bool:
        """Return True when unresolved work is blocked and fallback must not auto-dispatch it."""
        assert self.state is not None
        nonterminal_plans = [
            plan
            for plan in self.state.plans
            if plan.status in {"pending", "paused", "analyzing", "summarizing"}
        ]
        if not nonterminal_plans:
            return False
        has_executing = any(
            plan.status in {"analyzing", "summarizing"}
            for plan in nonterminal_plans
        ) or bool(self._active_tasks)
        if has_executing:
            return False
        latest_unresolved_batch = self._latest_unresolved_dispatch_batch()
        if latest_unresolved_batch is None:
            # Before any dispatch exists, "all pending" is a normal pre-dispatch
            # state and should keep the run in running mode so dispatch can proceed.
            return False
        if self._pending_direct_user_create_launch_plan_ids:
            return False
        return not self._can_fallback_dispatch_pending_for_batch(latest_unresolved_batch)

    def _refresh_run_status_from_plans(self) -> None:
        assert self.state is not None
        if self.state.master_agent_state.completed:
            return
        should_pause = self._should_pause_for_blocked_nonterminal_plans()
        if should_pause:
            self._set_run_status("paused", "waiting for paused/pending plan control")
            return
        if self.state.status == "paused":
            self._set_run_status("running", "plan execution resumed")

    def _enter_completed_wait_state(self, reason: str | None = None) -> None:
        assert self.state is not None
        if self.state.status == "completed":
            return
        old_status = self.state.status
        self.state.status = "completed"
        self._idle_started_at = monotonic()
        message = reason or self.state.final_summary or "Waiting for new instructions"
        self.store.log_run_status_change(old_status, "completed", message)
        self._emit_progress("Run completed and is waiting for follow-up instructions")

    def _resume_with_new_turn_goal(self, message: UserMessage) -> None:
        assert self.state is not None
        goal_text = self._canonical_message_text(message)
        old_status = self.state.status
        self.state.status = "running"
        self.state.master_agent_state.completed = False
        self.state.master_agent_state.current_goals = [goal_text]
        new_turn = Turn(turn_id=len(self.state.turns), goal=goal_text)
        self.state.turns.append(new_turn)
        self._idle_started_at = None
        self.store.log_run_status_change(old_status, "running", "Resumed with new goal")
        self.store.save_state(self.state)
        self._emit_progress(f"Resumed with new goal: {goal_text}")

    def _completion_wait_timed_out(self) -> bool:
        assert self.state is not None
        if self.state.status != "completed":
            return False
        if self.idle_timeout_seconds <= 0:
            return True
        if self._idle_started_at is None:
            self._idle_started_at = monotonic()
            return False
        if monotonic() - self._idle_started_at < self.idle_timeout_seconds:
            return False
        return True

    def _dataset_schema_text(self, dataset_info: dict[str, Any]) -> str:
        columns = [
            item.get("name", "")
            for item in dataset_info.get("columns", [])
            if isinstance(item, dict)
        ]
        dataset_identity = build_dataset_identity(
            str(dataset_info.get("dataset_path", "") or ""),
            dataset_info,
        )
        return (
            f"Dataset Identity: {dataset_identity}\n"
            f"Rows: {dataset_info.get('rows', 0)}\n"
            f"Columns: {columns}\n"
        )

    @staticmethod
    def _is_plan_terminal(plan: PlanItem | None) -> bool:
        return plan is not None and plan.status not in {"pending", "analyzing", "summarizing", "paused"}

    @staticmethod
    def _summary_target_from_insight(insight: Insight) -> SteeringTargetSnapshot:
        columns = sorted(
            {
                column
                for atomic in insight.atomic_insights
                for column in atomic.columns
                if column
            }
        )
        return SteeringTargetSnapshot(
            kind="summary",
            summary_id=insight.insight_id,
            summary_short_label=insight.short_label,
            summary_text=insight.summary,
            columns=columns,
        )

    @staticmethod
    def _default_citation_label(target: SteeringTargetSnapshot) -> str:
        if target.kind == "atomic":
            return target.atomic_text or target.atomic_id or target.summary_short_label or target.summary_id
        return target.summary_short_label or target.summary_text or target.summary_id

    def _serialize_citations(self, citations: list[ProvenanceCitation]) -> list[dict[str, Any]]:
        return [item.to_dict() for item in citations]

    def _parse_citations(self, raw_items: Any) -> list[ProvenanceCitation]:
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
            if not citation.label:
                citation.label = self._default_citation_label(citation.target)
            citations.append(citation)
            seen_markers.add(citation.marker)
        citations.sort(key=lambda item: item.marker)
        return citations

    def _next_dispatch_turn_index(self) -> int:
        assert self.state is not None
        batches = self.state.master_agent_state.dispatch_batches
        if not batches:
            return 0
        return max(batch.dispatch_turn_index for batch in batches) + 1

    def _register_dispatch_batch(self, plan_ids: list[str]) -> DispatchBatchState | None:
        assert self.state is not None
        plan_ids = [plan_id for plan_id in plan_ids if plan_id]
        if not plan_ids:
            return None
        batch = DispatchBatchState(
            dispatch_turn_index=self._next_dispatch_turn_index(),
            plan_ids=plan_ids,
        )
        self.state.master_agent_state.dispatch_batches.append(batch)
        return batch

    def _dispatch_batch_for_plan(self, plan_id: str) -> DispatchBatchState | None:
        assert self.state is not None
        if not plan_id:
            return None
        for batch in self.state.master_agent_state.dispatch_batches:
            if plan_id in batch.plan_ids:
                return batch
        return None

    def _latest_running_dispatch_batch(self) -> DispatchBatchState | None:
        assert self.state is not None
        for batch in reversed(self.state.master_agent_state.dispatch_batches):
            plans = [
                self.state.get_plan_by_id(plan_id)
                for plan_id in batch.plan_ids
            ]
            if any(
                plan is not None and plan.status in {"analyzing", "summarizing"}
                for plan in plans
            ):
                return batch
        return None

    def _attach_plan_to_dispatch_batch(
        self,
        batch: DispatchBatchState | None,
        plan_id: str,
    ) -> DispatchBatchState | None:
        if batch is None or not plan_id:
            return batch
        if plan_id not in batch.plan_ids:
            running_ids, nonrunning_ids, terminal_ids = self._dispatch_batch_segments(
                batch,
            )
            batch.plan_ids = [*running_ids, *nonrunning_ids, plan_id, *terminal_ids]
        return batch

    def _dispatch_batch_segments(
        self,
        batch: DispatchBatchState,
        *,
        exclude_plan_id: str | None = None,
    ) -> tuple[list[str], list[str], list[str]]:
        assert self.state is not None
        running_ids: list[str] = []
        nonrunning_ids: list[str] = []
        terminal_ids: list[str] = []
        for plan_id in batch.plan_ids:
            if exclude_plan_id is not None and plan_id == exclude_plan_id:
                continue
            plan = self.state.get_plan_by_id(plan_id)
            if plan is not None and plan.status in {"analyzing", "summarizing"}:
                running_ids.append(plan_id)
            elif plan is not None and plan.status in {"pending", "paused"}:
                nonrunning_ids.append(plan_id)
            else:
                terminal_ids.append(plan_id)
        return running_ids, nonrunning_ids, terminal_ids

    def _move_plan_to_batch_running_tail(
        self,
        batch: DispatchBatchState | None,
        plan_id: str,
    ) -> bool:
        if batch is None or not plan_id:
            return False
        running_ids, nonrunning_ids, terminal_ids = self._dispatch_batch_segments(
            batch,
            exclude_plan_id=plan_id,
        )
        next_plan_ids = [*running_ids, plan_id, *nonrunning_ids, *terminal_ids]
        if next_plan_ids == batch.plan_ids:
            return False
        batch.plan_ids = next_plan_ids
        return True

    def _move_plan_to_batch_nonrunning_tail(
        self,
        batch: DispatchBatchState | None,
        plan_id: str,
    ) -> bool:
        if batch is None or not plan_id:
            return False
        running_ids, nonrunning_ids, terminal_ids = self._dispatch_batch_segments(
            batch,
            exclude_plan_id=plan_id,
        )
        next_plan_ids = [*running_ids, *nonrunning_ids, plan_id, *terminal_ids]
        if next_plan_ids == batch.plan_ids:
            return False
        batch.plan_ids = next_plan_ids
        return True

    def _move_plan_to_batch_terminal_tail(
        self,
        batch: DispatchBatchState | None,
        plan_id: str,
    ) -> bool:
        if batch is None or not plan_id:
            return False
        running_ids, nonrunning_ids, terminal_ids = self._dispatch_batch_segments(
            batch,
            exclude_plan_id=plan_id,
        )
        next_plan_ids = [*running_ids, *nonrunning_ids, *terminal_ids, plan_id]
        if next_plan_ids == batch.plan_ids:
            return False
        batch.plan_ids = next_plan_ids
        return True

    def _normalize_dispatch_batch_plan_order(self, batch: DispatchBatchState) -> None:
        running_ids, nonrunning_ids, terminal_ids = self._dispatch_batch_segments(batch)
        batch.plan_ids = [*running_ids, *nonrunning_ids, *terminal_ids]

    def _insights_for_plan_ids(
        self,
        plan_ids: list[str],
        *,
        state: RunState | None = None,
    ) -> list[Insight]:
        target_state = state or self.state
        if target_state is None:
            return []
        plan_id_set = {plan_id for plan_id in plan_ids if plan_id}
        return [insight for insight in target_state.insights if insight.plan_id in plan_id_set]

    def _sync_dispatch_batches(self, state: RunState | None = None) -> None:
        target_state = state or self.state
        if target_state is None:
            return
        for batch in target_state.master_agent_state.dispatch_batches:
            if batch.status == "stage_summarized" or batch.stage_summary_emitted:
                batch.status = "stage_summarized"
                continue
            plans = [target_state.get_plan_by_id(plan_id) for plan_id in batch.plan_ids]
            if not plans or not all(self._is_plan_terminal(plan) for plan in plans):
                batch.status = "dispatched"
                continue
            if self._insights_for_plan_ids(batch.plan_ids, state=target_state):
                batch.status = "waiting_for_stage_summary"
            else:
                batch.status = "no_summary"

    def _batch_has_all_terminal_plans(self, batch: DispatchBatchState) -> bool:
        if self.state is None:
            return False
        plans = [self.state.get_plan_by_id(plan_id) for plan_id in batch.plan_ids]
        return bool(plans) and all(self._is_plan_terminal(plan) for plan in plans)

    def _latest_unresolved_dispatch_batch(self) -> DispatchBatchState | None:
        assert self.state is not None
        for batch in reversed(self.state.master_agent_state.dispatch_batches):
            plans = [
                self.state.get_plan_by_id(plan_id)
                for plan_id in batch.plan_ids
            ]
            if any(
                plan is not None
                and plan.status in {"pending", "analyzing", "summarizing", "paused"}
                for plan in plans
            ):
                return batch
        return None

    @staticmethod
    def _is_plan_nonterminal(plan: PlanItem | None) -> bool:
        return plan is not None and plan.status in {"pending", "analyzing", "summarizing", "paused"}

    def _has_nonterminal_plans(self) -> bool:
        if self.state is None:
            return False
        return any(
            self._is_plan_nonterminal(plan)
            for plan in self.state.plans
        )

    def _all_plans_are_terminal(self) -> bool:
        return bool(self.state is not None and self.state.plans) and not self._has_nonterminal_plans()

    def _nonterminal_plan_ids_for_batch(self, batch: DispatchBatchState) -> list[str]:
        assert self.state is not None
        ordered_ids: list[str] = []
        for plan_id in batch.plan_ids:
            plan = self.state.get_plan_by_id(plan_id)
            if self._is_plan_nonterminal(plan):
                ordered_ids.append(plan_id)
        return ordered_ids

    def _active_execution_seat_count(self) -> int:
        assert self.state is not None
        return sum(
            1
            for plan_id in self._active_tasks
            if self.state.get_plan_by_id(plan_id) is not None
            and self.state.get_plan_by_id(plan_id).status in {"analyzing", "summarizing"}
        )

    def _can_consider_summary_or_completion(self) -> bool:
        return self._all_plans_are_terminal()

    def _latest_summary_boundary_dispatch_turn_index(self) -> int | None:
        if self.state is None:
            return None
        return latest_summary_boundary_dispatch_turn_index(self.state)

    def _current_stage_summary_scope_batches(
        self,
        target_batch: DispatchBatchState | None = None,
    ) -> list[DispatchBatchState]:
        if self.state is None:
            return []
        target_dispatch_turn_index = (
            target_batch.dispatch_turn_index
            if target_batch is not None
            else None
        )
        return stage_summary_scope_batches(
            self.state,
            target_dispatch_turn_index=target_dispatch_turn_index,
        )

    @staticmethod
    def _ordered_unique_plan_ids(plan_ids: list[str]) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for plan_id in plan_ids:
            if not plan_id or plan_id in seen:
                continue
            seen.add(plan_id)
            ordered.append(plan_id)
        return ordered

    def _stage_summary_scope_plan_ids(
        self,
        batches: list[DispatchBatchState],
    ) -> list[str]:
        return self._ordered_unique_plan_ids(
            [plan_id for batch in batches for plan_id in batch.plan_ids]
        )

    def _next_plan_generation(self, plan_id: str) -> int:
        generation = self._plan_run_generations.get(plan_id, 0) + 1
        self._plan_run_generations[plan_id] = generation
        return generation

    def _is_current_plan_generation(self, plan_id: str, generation: int | None) -> bool:
        if generation is None:
            return True
        return self._plan_run_generations.get(plan_id, 0) == generation

    def _detach_task(self, task: asyncio.Task[Any]) -> None:
        self._detached_tasks.add(task)

        def _discard(detached: asyncio.Task[Any]) -> None:
            self._detached_tasks.discard(detached)
            try:
                detached.result()
            except Exception:
                pass

        task.add_done_callback(_discard)

    def _should_wait_for_paused_batch(self) -> bool:
        if self.state is None:
            return False
        return self._should_pause_for_blocked_nonterminal_plans()

    def _build_control_snapshot_for_plan(
        self,
        plan_id: str,
        *,
        generation: int | None = None,
    ) -> dict[str, Any]:
        persisted_state = self.store.load_state() if self.store is not None else None
        persisted_plan = persisted_state.get_plan_by_id(plan_id) if persisted_state is not None else None
        plan = persisted_plan or (self.state.get_plan_by_id(plan_id) if self.state is not None else None)
        if generation is not None and not self._is_current_plan_generation(plan_id, generation):
            return {
                "control_state": "yield_requested",
                "status": "pending",
                "resume_phase": plan.resume_phase if plan is not None else None,
                "checkpoint_path": plan.checkpoint_path if plan is not None else None,
            }
        return {
            "control_state": plan.control_state if plan is not None else "none",
            "status": plan.status if plan is not None else "",
            "resume_phase": plan.resume_phase if plan is not None else None,
            "checkpoint_path": plan.checkpoint_path if plan is not None else None,
        }

    def _handle_sub_agent_phase_change(self, plan_id: str, status: str, *, generation: int | None = None) -> None:
        if generation is not None and not self._is_current_plan_generation(plan_id, generation):
            return
        assert self.state is not None
        plan = self.state.get_plan_by_id(plan_id)
        if plan is None:
            return
        phase_update = SubAgent.derive_phase_state_update(plan, status)
        if phase_update.resume_phase is not None:
            plan.resume_phase = phase_update.resume_phase
        self._set_plan_status(plan, phase_update.status)

    def _build_sub_agent(self, plan_id: str, generation: int) -> Any:
        if self.sub_agent_factory:
            sub_agent = self.sub_agent_factory()
            if hasattr(sub_agent, "phase_callback"):
                setattr(
                    sub_agent,
                    "phase_callback",
                    lambda callback_plan_id, status, *, _generation=generation: self._handle_sub_agent_phase_change(
                        callback_plan_id,
                        status,
                        generation=_generation,
                    ),
                )
            if hasattr(sub_agent, "control_callback"):
                setattr(
                    sub_agent,
                    "control_callback",
                    lambda callback_plan_id=plan_id, _generation=generation: self._build_control_snapshot_for_plan(
                        callback_plan_id,
                        generation=_generation,
                    ),
                )
            return sub_agent
        return SubAgent(
            store=self.store,
            phase_callback=lambda callback_plan_id, status, *, _generation=generation: self._handle_sub_agent_phase_change(
                callback_plan_id,
                status,
                generation=_generation,
            ),
            control_callback=lambda callback_plan_id=plan_id, _generation=generation: self._build_control_snapshot_for_plan(
                callback_plan_id,
                generation=_generation,
            ),
        )

    async def _launch_plan(
        self,
        plan: PlanItem,
    ) -> bool:
        assert self.state is not None
        if self._active_execution_seat_count() >= self._effective_max_concurrency():
            return False
        if plan.plan_id in self._active_tasks:
            return False
        if plan.status not in {"pending", "paused"}:
            return False
        launch_update = SubAgent.derive_launch_state_update(plan, self.state.execution_records)
        resume_phase = launch_update.resume_phase or "analyzing"
        plan.control_state = launch_update.control_state  # type: ignore[assignment]
        plan.status = launch_update.status  # type: ignore[assignment]
        plan.resume_phase = launch_update.resume_phase
        plan.assigned_sub_agent_id = f"sub_{len(self._active_tasks) + 1:03d}"
        if plan.plan_id not in self.state.master_agent_state.active_plan_ids:
            self.state.master_agent_state.active_plan_ids.append(plan.plan_id)
        generation = self._next_plan_generation(plan.plan_id)
        sub_agent = self._build_sub_agent(plan.plan_id, generation)
        task = asyncio.create_task(
            sub_agent.run(
                plan,
                self.state.dataset_info,
                **self._sub_agent_run_kwargs(sub_agent, resume_phase=resume_phase),
            ),
            name=plan.plan_id,
        )
        self._active_tasks[plan.plan_id] = task
        self._active_task_generations[plan.plan_id] = generation
        self.store.log_plan_started(plan)
        self.store.save_state(self.state)
        return True

    async def _resume_paused_plan(self, plan: PlanItem) -> bool:
        if plan.status != "paused":
            return False
        existing_task = self._active_tasks.get(plan.plan_id)
        if existing_task is not None and existing_task.done():
            self._active_tasks.pop(plan.plan_id, None)
            self._active_task_generations.pop(plan.plan_id, None)
            self._detach_task(existing_task)
        return await self._launch_plan(plan)

    async def _process_plan_controls(self) -> bool:
        assert self.state is not None
        requests, next_offset = read_plan_control_requests(
            self.store.plan_controls_path,
            start_offset=self._plan_control_offset,
        )
        self._plan_control_offset = next_offset
        if not requests:
            self._refresh_run_status_from_plans()
            return False
        changed = False
        # Seat-fill is intentionally event-driven. We only backfill pending plans
        # after terminal release transitions, never as a side effect of pause.
        release_triggered = False
        latest = latest_requests_by_plan(requests)
        for request in latest.values():
            plan = self.state.get_plan_by_id(request.plan_id)
            if plan is None:
                continue
            batch = self._dispatch_batch_for_plan(plan.plan_id)
            request_changed = False
            previous_status = plan.status
            previous_control_state = plan.control_state
            previous_resume_phase = plan.resume_phase
            if request.action == "start":
                if plan.status != "pending":
                    continue
                if batch is None:
                    batch = self._register_dispatch_batch([plan.plan_id])
                if await self._launch_plan(plan):
                    request_changed = True
                changed = request_changed or changed
                continue
            if request.action == "resume":
                if batch is None:
                    batch = self._register_dispatch_batch([plan.plan_id])
                active_task = self._active_tasks.get(plan.plan_id)
                if active_task is not None and not active_task.done():
                    if plan.control_state != "none":
                        plan.control_state = "none"
                        request_changed = True
                    if request_changed:
                        self._persist_plan_update(plan)
                        changed = True
                    continue
                if plan.status == "paused":
                    if (
                        self._active_execution_seat_count()
                        >= self._effective_max_concurrency()
                    ):
                        if plan.status != "pending":
                            plan.status = "pending"
                            request_changed = True
                        if plan.control_state != "none":
                            plan.control_state = "none"
                            request_changed = True
                        if request_changed:
                            self._persist_plan_update(plan)
                            changed = True
                        continue
                    if await self._resume_paused_plan(plan):
                        request_changed = True
                    changed = request_changed or changed
                    continue
                if plan.status != "pending":
                    continue
                if await self._launch_plan(plan):
                    request_changed = True
                changed = request_changed or changed
                continue
            if request.action == "pause" and plan.status in {"analyzing", "summarizing"}:
                next_phase = SubAgent.resume_phase_for_status(
                    plan.status,
                    fallback=plan.resume_phase,
                )
                if plan.control_state != "pause_requested":
                    plan.control_state = "pause_requested"
                    request_changed = True
                if plan.resume_phase != next_phase:
                    plan.resume_phase = next_phase
                    request_changed = True
                if request_changed:
                    self._persist_plan_update(plan)
                    changed = True
                continue
            if apply_control_request_to_plan(plan, request):
                request_changed = True
                if plan.status in {"paused", "terminated"} and plan.plan_id in self.state.master_agent_state.active_plan_ids:
                    self.state.master_agent_state.active_plan_ids = [
                        item for item in self.state.master_agent_state.active_plan_ids
                        if item != plan.plan_id
                    ]
                self._persist_plan_update(plan)
            elif (
                previous_status != plan.status
                or previous_control_state != plan.control_state
                or previous_resume_phase != plan.resume_phase
            ):
                request_changed = True
            if request_changed and SubAgent.should_trigger_pending_fill_for_transition(
                previous_status=previous_status,
                next_status=plan.status,
            ):
                release_triggered = True
            changed = request_changed or changed
        if changed:
            self._sync_dispatch_batches()
            if release_triggered:
                await self._fill_dispatch_batch_seats()
            self.store.save_state(self.state)
        self._refresh_run_status_from_plans()
        return changed

    async def _fill_dispatch_batch_seats(self) -> bool:
        batch = self._latest_unresolved_dispatch_batch()
        if batch is None or self.state is None:
            return False
        launched = await self._launch_pending_plans_for_batch(batch)
        if not launched:
            return False
        self._sync_dispatch_batches()
        self._refresh_run_status_from_plans()
        return True

    def _is_midway_pending_plan(self, plan: PlanItem) -> bool:
        assert self.state is not None
        return SubAgent.is_midway_pending_plan(plan, self.state.execution_records)

    def _pending_launch_candidates_for_batch(self, batch: DispatchBatchState) -> list[str]:
        assert self.state is not None
        ranked: list[tuple[int, int, str]] = []
        for index, plan_id in enumerate(batch.plan_ids):
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            priority = 0 if self._is_midway_pending_plan(plan) else 1
            ranked.append((priority, index, plan_id))
        ranked.sort()
        return [plan_id for _, _, plan_id in ranked]

    def _can_fallback_dispatch_pending_for_batch(self, batch: DispatchBatchState) -> bool:
        """
        Fallback may auto-dispatch only a fresh pending-only batch.

        Once a batch already contains a paused or terminal member, later pending
        launches must come from terminal-release seat-fill or explicit control
        instead of opportunistic fallback dispatch.
        """
        assert self.state is not None
        found_plan = False
        for plan_id in batch.plan_ids:
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None:
                continue
            found_plan = True
            if plan.status != "pending":
                return False
        return found_plan

    async def _launch_pending_plans_for_batch(self, batch: DispatchBatchState) -> list[str]:
        assert self.state is not None
        launched: list[str] = []
        for plan_id in self._pending_launch_candidates_for_batch(batch):
            if self._active_execution_seat_count() >= self._effective_max_concurrency():
                break
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            if await self._launch_plan(plan):
                launched.append(plan.plan_id)
        return launched

    def _evict_plan_from_active_seat(self, plan: PlanItem) -> bool:
        assert self.state is not None
        changed = False
        if plan.status in {"analyzing", "summarizing"}:
            plan.resume_phase = SubAgent.resume_phase_for_status(
                plan.status,
                fallback=plan.resume_phase,
            )
            plan.status = "pending"
            changed = True
        if plan.control_state != "yield_requested":
            plan.control_state = "yield_requested"
            changed = True
        if plan.assigned_sub_agent_id is not None:
            plan.assigned_sub_agent_id = None
            changed = True
        self.state.master_agent_state.active_plan_ids = [
            item
            for item in self.state.master_agent_state.active_plan_ids
            if item != plan.plan_id
        ]
        task = self._active_tasks.pop(plan.plan_id, None)
        self._active_task_generations.pop(plan.plan_id, None)
        if task is not None:
            self._detach_task(task)
            changed = True
        if changed:
            self._persist_plan_update(plan)
        return changed

    async def _rebalance_dispatch_batch_execution(self, batch: DispatchBatchState) -> bool:
        assert self.state is not None
        nonterminal_plan_ids = self._nonterminal_plan_ids_for_batch(batch)
        effective_max_concurrency = self._effective_max_concurrency()
        target_plan_ids = set(nonterminal_plan_ids[:effective_max_concurrency])
        changed = False

        for plan_id in list(self._active_tasks.keys()):
            if plan_id in target_plan_ids:
                continue
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None:
                continue
            changed = self._evict_plan_from_active_seat(plan) or changed

        for plan_id in nonterminal_plan_ids[:effective_max_concurrency]:
            if plan_id in self._active_tasks:
                continue
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None:
                continue
            if SubAgent.can_auto_launch_plan_status(plan.status):
                if await self._launch_plan(plan):
                    changed = True

        if changed:
            self._sync_dispatch_batches()
            self._refresh_run_status_from_plans()
            self.store.save_state(self.state)
        return changed

    def _apply_runtime_settings_update(self, request: RuntimeControlRequest) -> bool:
        assert self.state is not None
        if request.max_concurrency is None:
            return False
        next_max_concurrency = clamp_max_concurrency(request.max_concurrency)
        if self.state.settings.max_concurrency == next_max_concurrency:
            return False
        self.state.settings.max_concurrency = next_max_concurrency
        self.settings.max_concurrency = next_max_concurrency
        self.store.save_state(self.state)
        return True

    async def _apply_runtime_batch_reorder(self, request: RuntimeControlRequest) -> bool:
        assert self.state is not None
        batch = self._latest_unresolved_dispatch_batch()
        if batch is None:
            return False
        if (
            request.dispatch_turn_index is not None
            and request.dispatch_turn_index != batch.dispatch_turn_index
        ):
            return False
        current_nonterminal_plan_ids = self._nonterminal_plan_ids_for_batch(batch)
        requested_plan_ids = [
            plan_id
            for plan_id in request.plan_ids
            if plan_id in current_nonterminal_plan_ids
        ]
        if not requested_plan_ids or set(requested_plan_ids) != set(current_nonterminal_plan_ids):
            return False
        terminal_plan_ids = [
            plan_id for plan_id in batch.plan_ids
            if plan_id not in current_nonterminal_plan_ids
        ]
        next_plan_ids = requested_plan_ids + terminal_plan_ids
        if next_plan_ids == batch.plan_ids:
            return False
        batch.plan_ids = next_plan_ids
        rebalanced = await self._rebalance_dispatch_batch_execution(batch)
        if not rebalanced:
            self._sync_dispatch_batches()
            self._refresh_run_status_from_plans()
            self.store.save_state(self.state)
        return True

    async def _process_runtime_controls(self) -> bool:
        assert self.state is not None
        requests, next_offset = read_runtime_control_requests(
            self.store.runtime_controls_path,
            start_offset=self._runtime_control_offset,
        )
        self._runtime_control_offset = next_offset
        if not requests:
            return False
        changed = False
        for request in requests:
            if request.action == "update_settings":
                changed = self._apply_runtime_settings_update(request) or changed
                continue
            if request.action == "reorder_latest_batch":
                changed = await self._apply_runtime_batch_reorder(request) or changed
        if changed:
            self._sync_dispatch_batches()
            self._refresh_run_status_from_plans()
            self.store.save_state(self.state)
        return changed

    def _pending_stage_summary_batch(self) -> DispatchBatchState | None:
        self._sync_dispatch_batches()
        assert self.state is not None
        if not self._can_consider_summary_or_completion():
            return None
        scope_batches = self._current_stage_summary_scope_batches()
        if scope_batches:
            return scope_batches[-1]
        return None

    def _build_batch_finished_user_response_message(
        self,
        batch: DispatchBatchState,
    ) -> str:
        chinese = self._prefers_chinese_response()
        if self._latest_stop_intent_chat_message() is not None:
            if chinese:
                return "\u8fd9\u6279\u4efb\u52a1\u5df2\u7ecf\u7ed3\u675f\uff0c\u6211\u5c06\u6309\u4f60\u7684\u8981\u6c42\u7ed3\u675f\u672c\u8f6e\uff0c\u4e0d\u518d\u6269\u5c55\u65b0\u8ba1\u5212\u3002"
            return (
                "This batch has finished. Per your request, I'll end this run here and won't "
                "open more plans."
            )
        has_insights = bool(self._insights_for_plan_ids(batch.plan_ids))
        if chinese:
            if has_insights:
                return (
                    "这一批计划已经全部结束，我已经拿到这一批的结果。"
                    "接下来我会先判断是否还需要继续补开新的计划，"
                    "再决定是否适合做阶段总结或结束当前 run。"
                )
            return (
                "这一批计划已经全部结束，但这批里还没有形成可保留的发现。"
                "接下来我会判断是否需要补开新的计划或调整分析方向。"
            )
        if has_insights:
            return (
                "This dispatch batch has finished running, and I have the results from it. "
                "Next I'll decide whether more plans are still needed before considering a stage summary or completion."
            )
        return (
            "This dispatch batch has finished running, but it did not produce a retained finding yet. "
            "Next I'll decide whether to open more plans or adjust the direction."
        )

    def _build_next_batch_finished_user_response_tool_call(self) -> dict[str, Any] | None:
        if self.state is None:
            return None
        self._sync_dispatch_batches()
        for batch in self.state.master_agent_state.dispatch_batches:
            if batch.batch_finished_user_response_emitted:
                continue
            if not self._batch_has_all_terminal_plans(batch):
                continue
            return {
                "name": "respond_to_user",
                "arguments": {
                    "message": self._build_batch_finished_user_response_message(batch),
                },
                "_runtime_internal_user_response": True,
                "_batch_finished_dispatch_turn_index": batch.dispatch_turn_index,
            }
        return None

    def _build_next_pending_direct_user_create_dispatch_tool_call(
        self,
    ) -> dict[str, Any] | None:
        if self.state is None:
            return None
        if self._has_pending_user_responses():
            return None
        if self._pending_stop_completion_active():
            self._clear_pending_direct_user_create_dispatch_queue()
            return None
        queued_plan_ids = self._pending_direct_user_create_dispatch_plan_ids()
        if not queued_plan_ids:
            return None
        return {
            "name": "dispatch_plans",
            "arguments": {"plan_ids": queued_plan_ids},
            "_runtime_internal_pending_direct_user_create_dispatch": True,
        }

    async def _process_pending_direct_user_create_launches(self) -> bool:
        if not self._pending_direct_user_create_launch_plan_ids:
            return False
        pending_launch_plan_ids = list(self._pending_direct_user_create_launch_plan_ids)
        self._pending_direct_user_create_launch_plan_ids = []
        launched_any = False
        for plan_id in pending_launch_plan_ids:
            if self._active_execution_seat_count() >= self._effective_max_concurrency():
                self._pending_direct_user_create_launch_plan_ids.append(plan_id)
                continue
            if self.state is None:
                continue
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            if await self._launch_plan(plan):
                launched_any = True
        if launched_any:
            self._sync_dispatch_batches()
            self._refresh_run_status_from_plans()
            self.store.save_state(self.state)
        return launched_any or bool(pending_launch_plan_ids)

    def _latest_post_steer_follow_up_state(self) -> dict[str, Any] | None:
        if self.state is None:
            return None
        if self._latest_stop_intent_chat_message() is not None:
            return None
        current_turn = self.state.current_turn()
        if current_turn is None or current_turn.status != "running":
            return None

        latest_steer_index: int | None = None
        for index in range(len(current_turn.timeline) - 1, -1, -1):
            entry = current_turn.timeline[index]
            if entry.entry_type != "user_steer" or not isinstance(entry.content, dict):
                continue
            kind = normalize_steering_message_kind(entry.content.get("kind")) or "chat"
            if kind == "create":
                continue
            latest_steer_index = index
            break

        if latest_steer_index is None:
            return None

        latest_steer_entry = current_turn.timeline[latest_steer_index]
        if not isinstance(latest_steer_entry.content, dict):
            return None
        if bool(latest_steer_entry.content.get("follow_up_plan_create_recorded")):
            return {"status": "satisfied", "pending_plan_ids": []}
        return {"status": "needs_create", "pending_plan_ids": []}

    def _build_post_steer_follow_up_dispatch_tool_call(self) -> dict[str, Any] | None:
        follow_up_state = self._latest_post_steer_follow_up_state()
        if follow_up_state is None:
            return None
        pending_plan_ids = [
            str(plan_id).strip()
            for plan_id in follow_up_state.get("pending_plan_ids", []) or []
            if str(plan_id).strip()
        ]
        if (
            str(follow_up_state.get("status", "")).strip() != "needs_dispatch"
            or not pending_plan_ids
        ):
            return None
        return {
            "name": "dispatch_plans",
            "arguments": {"plan_ids": pending_plan_ids},
        }

    def _ensure_post_steer_follow_up_planning(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return tool_calls

    async def _call_master_llm_with_messages(
        self,
        messages: list[dict[str, str]],
    ) -> tuple[list[dict[str, Any]], Any | None]:
        assert self.state is not None
        normalization_context = build_master_cache_normalization_context(self.state)
        run_context = self._model_cache_run_context()
        with use_model_cache_run_context(run_context):
            with use_model_cache_normalization_context(normalization_context):
                consume_last_model_cache_binding()
                response = create_chat_completion_with_sampling_controls(
                    OPENAI_CLIENT,
                    params={
                        "model": MASTER_AGENT_MODEL_NAME,
                        "messages": messages,
                        "tools": build_master_tool_specs(),
                        "tool_choice": "required",
                        "max_tokens": MASTER_AGENT_MAX_TOKENS,
                    },
                    temperature=MASTER_AGENT_TEMPERATURE,
                )
                active_timestamp_binding = consume_last_model_cache_binding()
        normalized = self._parse_llm_tool_calls(response.choices[0].message)
        mismatches = self._language_mismatch_details_for_tool_calls(normalized)
        retried = normalized
        retried_mismatches = mismatches
        retry_timestamp_binding = active_timestamp_binding
        if mismatches:
            retry_messages = list(messages)
            retry_messages.append(
                {
                    "role": "user",
                    "content": (
                        strict_language_match_instruction(latest_user_authored_text(self.state.user_messages))
                        + "\nRetry the tool calls now using the correct user-facing language.\n"
                        "Keep tool names, JSON keys, ids, citations, and schema tokens unchanged.\n"
                        + "Fields that still need correction:\n"
                        + json.dumps(mismatches, ensure_ascii=False)
                    ),
                }
            )
            with use_model_cache_run_context(run_context):
                with use_model_cache_normalization_context(normalization_context):
                    consume_last_model_cache_binding()
                    retry_response = create_chat_completion_with_sampling_controls(
                        OPENAI_CLIENT,
                        params={
                            "model": MASTER_AGENT_MODEL_NAME,
                            "messages": retry_messages,
                            "tools": build_master_tool_specs(),
                            "tool_choice": "required",
                            "max_tokens": MASTER_AGENT_MAX_TOKENS,
                        },
                        temperature=MASTER_AGENT_TEMPERATURE,
                    )
                    retry_timestamp_binding = consume_last_model_cache_binding()
            retried = self._parse_llm_tool_calls(retry_response.choices[0].message)
            retried_mismatches = self._language_mismatch_details_for_tool_calls(retried)
        if not retried_mismatches:
            normalized = retried
            active_timestamp_binding = retry_timestamp_binding
        return normalized, active_timestamp_binding

    async def _call_llm(self) -> tuple[list[dict[str, Any]], Any | None]:
        if self.decision_provider is not None:
            assert self.state is not None
            return self.decision_provider(self.state, []), None  # backward compat

        if OPENAI_CLIENT is None or not OPENAI_API_KEY:
            return [], None

        messages = self._build_llm_messages()
        return await self._call_master_llm_with_messages(messages)

    def _build_stop_completion_summary(self) -> str:
        assert self.state is not None
        if self.state.final_summary.strip():
            return self.state.final_summary.strip()
        if self._latest_synthesis.strip():
            return self._latest_synthesis.strip()

        chinese = self._prefers_chinese_response()
        retained_summaries = self._retained_finding_summaries()

        if retained_summaries:
            if chinese:
                joined = "\uFF1B".join(retained_summaries)
                return f"\u5f53\u524d\u5df2\u4fdd\u7559\u7684\u4e3b\u8981\u53d1\u73b0\uff1a{joined}"
            return "Current retained findings: " + "; ".join(retained_summaries)

        if chinese:
            return "\u6309\u4f60\u7684\u8981\u6c42\uff0c\u6211\u63d0\u524d\u7ed3\u675f\u4e86\u672c\u8f6e\u5206\u6790\uff0c\u76ee\u524d\u8fd8\u6ca1\u6709\u4fdd\u7559\u65b0\u7684\u6709\u6548\u53d1\u73b0\u3002"
        return (
            "I ended the run at your request before any additional retained findings were produced."
        )

    def _retained_finding_summaries(
        self,
        *,
        plan_ids: list[str] | None = None,
    ) -> list[str]:
        if self.state is None:
            return []
        plan_id_filter = {
            str(plan_id).strip()
            for plan_id in plan_ids or []
            if str(plan_id).strip()
        } or None
        retained_summaries: list[str] = []
        seen: set[str] = set()
        for insight in self.state.insights:
            if plan_id_filter is not None and insight.plan_id not in plan_id_filter:
                continue
            summary = str(insight.summary or "").strip()
            if not summary:
                continue
            lookup_key = summary.casefold()
            if lookup_key in seen:
                continue
            seen.add(lookup_key)
            retained_summaries.append(summary)
        return retained_summaries

    def _fallback_decision(self) -> list[dict[str, Any]]:
        assert self.state is not None
        pending = [plan for plan in self.state.plans if plan.status == "pending"]
        current_turn = self.state.current_turn()
        current_goal = current_turn.goal if current_turn else (
            self.state.master_agent_state.current_goals[0]
            if self.state.master_agent_state.current_goals
            else ""
        )
        normalized_current_goal = current_goal.strip()
        if not self.state.plans:
            return [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {"text": normalized_current_goal}
                        ][: self.max_initial_plans],
                    },
                }
            ]
        latest_unresolved_batch = self._latest_unresolved_dispatch_batch()
        if (
            latest_unresolved_batch is not None
            and self._can_fallback_dispatch_pending_for_batch(latest_unresolved_batch)
        ):
            pending_batch_plan_ids = self._pending_launch_candidates_for_batch(latest_unresolved_batch)
            if pending_batch_plan_ids:
                return [
                    {
                        "name": "dispatch_plans",
                        "arguments": {"plan_ids": [pending_batch_plan_ids[0]]},
                    }
                ]
        if (
            normalized_current_goal
            and self._generic_goal_fallback_is_allowed()
            and not any(
                plan.text.strip() == normalized_current_goal
                for plan in self.state.plans
            )
        ):
            return [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {
                                "text": normalized_current_goal,
                                "source": "current_goal_fallback",
                            }
                        ][: self.max_initial_plans],
                    },
                }
            ]
        if pending and latest_unresolved_batch is None:
            return [
                {
                    "name": "dispatch_plans",
                    "arguments": {
                        "plan_ids": [
                            plan.plan_id
                            for plan in pending[: self._effective_max_concurrency()]
                        ]
                    },
                }
            ]
        if self._active_tasks:
            return []
        if (
            self.state.insights
            and not self.state.master_agent_state.completed
            and self._can_consider_summary_or_completion()
        ):
            return [
                {
                    "name": "synthesize_findings",
                    "arguments": {"synthesis": self.state.insights[-1].summary},
                },
                {
                    "name": "mark_complete",
                    "arguments": {"summary": self.state.insights[-1].summary},
                },
            ]
        return []

    async def _execute_tool_calls(self, tool_calls: list[dict[str, Any]]) -> None:
        for tool_call in tool_calls:
            name = str(tool_call.get("name", "")).strip()
            arguments = tool_call.get("arguments", {}) or {}
            # Capture the turn reference before execution — some tools (mark_complete)
            # change the turn status, which would make current_turn() return None.
            turn_ref = self.state.current_turn() if self.state else None
            if name == "create_plans":
                result = self._tool_create_plans(arguments)
            elif name == "dispatch_plans":
                result = await self._tool_dispatch_plans(arguments)
            elif name == "evaluate_progress":
                result = self._tool_evaluate_progress(arguments)
            elif name == "synthesize_findings":
                result = self._tool_synthesize_findings(arguments)
            elif name == "respond_to_user":
                result = self._tool_respond_to_user(arguments)
            elif name == "mark_complete":
                result = self._tool_mark_complete(arguments)
            else:
                result = {"ignored": True, "reason": f"unknown tool {name}"}
            self.store.log_master_agent_tool_result(name, result)
            pending_user_response_message_id = str(
                tool_call.get("_pending_user_response_message_id", "")
            ).strip()
            if pending_user_response_message_id:
                self._acknowledge_pending_user_response(pending_user_response_message_id)
            batch_finished_dispatch_turn_index = tool_call.get("_batch_finished_dispatch_turn_index")
            if (
                name == "respond_to_user"
                and isinstance(batch_finished_dispatch_turn_index, int)
                and self.state is not None
            ):
                for batch in self.state.master_agent_state.dispatch_batches:
                    if batch.dispatch_turn_index == batch_finished_dispatch_turn_index:
                        batch.batch_finished_user_response_emitted = True
                        break
            if turn_ref is not None:
                turn_ref.timeline.append(TimelineEntry(entry_type=name, content={"arguments": arguments, "result": result}))

    @staticmethod
    def _normalize_tool_call(tool_call: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(tool_call)
        normalized["name"] = str(tool_call.get("name", "")).strip()
        normalized["arguments"] = dict(tool_call.get("arguments", {}) or {})
        return normalized

    @staticmethod
    def _natural_language_fields_for_tool_call(tool_call: dict[str, Any]) -> list[tuple[str, str]]:
        name = str(tool_call.get("name", "")).strip()
        arguments = dict(tool_call.get("arguments", {}) or {})
        fields: list[tuple[str, str]] = []
        if name == "create_plans":
            plans = arguments.get("plans")
            if isinstance(plans, list):
                for index, plan in enumerate(plans):
                    if not isinstance(plan, dict):
                        continue
                    text = str(plan.get("text", "")).strip()
                    if text:
                        fields.append((f"plans[{index}].text", text))
        elif name == "evaluate_progress":
            for field_name in ("evaluation", "stage_summary_markdown"):
                text = str(arguments.get(field_name, "")).strip()
                if text:
                    fields.append((field_name, text))
        elif name == "synthesize_findings":
            text = str(arguments.get("synthesis", "")).strip()
            if text:
                fields.append(("synthesis", text))
        elif name == "respond_to_user":
            text = str(arguments.get("message", "")).strip()
            if text:
                fields.append(("message", text))
        elif name == "mark_complete":
            text = str(arguments.get("summary", "")).strip()
            if text:
                fields.append(("summary", text))
        return fields

    def _language_mismatch_details_for_tool_calls(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[str]:
        if self.state is None or not latest_user_prefers_chinese(self.state.user_messages):
            return []
        mismatches: list[str] = []
        for tool_call in tool_calls:
            name = str(tool_call.get("name", "")).strip()
            for field_name, text in self._natural_language_fields_for_tool_call(tool_call):
                if contains_cjk_text(text):
                    continue
                mismatches.append(f"{name}.{field_name}={text[:160]}")
        return mismatches

    def _matches_latest_user_language(self, text: str) -> bool:
        normalized = str(text or "").strip()
        if not normalized:
            return False
        if self.state is None:
            return True
        if latest_user_prefers_chinese(self.state.user_messages):
            return contains_cjk_text(normalized)
        return True

    def _parse_llm_tool_calls(self, message: Any) -> list[dict[str, Any]]:
        tool_calls = getattr(message, "tool_calls", None) or []
        normalized: list[dict[str, Any]] = []
        for call in tool_calls:
            fn = getattr(call, "function", None)
            name = getattr(fn, "name", "") or ""
            raw_args = getattr(fn, "arguments", "{}") or "{}"
            try:
                arguments = json.loads(raw_args)
            except Exception:
                arguments = {}
            normalized.append({"name": name, "arguments": arguments})
        return normalized

    @staticmethod
    def _is_runtime_generated_user_response(tool_call: dict[str, Any]) -> bool:
        return bool(str(tool_call.get("_pending_user_response_message_id", "")).strip())

    @staticmethod
    def _is_internal_user_response(tool_call: dict[str, Any]) -> bool:
        return bool(tool_call.get("_runtime_internal_user_response"))

    @staticmethod
    def _is_post_summary_user_response(
        tool_calls: list[dict[str, Any]],
        index: int,
    ) -> bool:
        if index <= 0:
            return False
        previous_name = str(tool_calls[index - 1].get("name", "")).strip()
        return previous_name in {"evaluate_progress", "mark_complete"}

    def _filter_disallowed_respond_to_user_tool_calls(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        filtered: list[dict[str, Any]] = []
        for index, tool_call in enumerate(tool_calls):
            name = str(tool_call.get("name", "")).strip()
            if name != "respond_to_user":
                filtered.append(tool_call)
                continue
            if (
                self._is_runtime_generated_user_response(tool_call)
                or self._is_internal_user_response(tool_call)
                or self._is_post_summary_user_response(tool_calls, index)
            ):
                filtered.append(tool_call)
        return filtered

    def _filter_summary_tool_calls_until_all_plans_terminal(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not self._can_consider_summary_or_completion():
            summary_tool_names = {"evaluate_progress", "synthesize_findings", "mark_complete"}
            return [
                tool_call
                for tool_call in tool_calls
                if str(tool_call.get("name", "")).strip() not in summary_tool_names
            ]
        if self._pending_stage_summary_batch() is not None:
            return tool_calls
        return [
            tool_call
            for tool_call in tool_calls
            if str(tool_call.get("name", "")).strip() != "evaluate_progress"
        ]

    def _build_post_summary_user_response(
        self,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        citations = self._parse_citations(arguments.get("citations"))
        cited_reference = ""
        if citations:
            primary = citations[0]
            if self._prefers_chinese_response():
                cited_reference = f"（参考 {self._default_citation_label(primary.target)} [[{primary.marker}]])"
            else:
                cited_reference = f" around {self._default_citation_label(primary.target)} [[{primary.marker}]]"
        chinese = self._prefers_chinese_response()
        if self._latest_stop_intent_chat_message() is not None:
            if tool_name == "evaluate_progress":
                message = (
                    "\u6211\u5148\u628a\u622a\u81f3\u76ee\u524d\u5df2\u4fdd\u7559\u7684\u53d1\u73b0\u6c47\u603b\u5728\u4e0a\u9762\u4e86\uff0c\u63a5\u4e0b\u6765\u4f1a\u6309\u4f60\u7684\u8981\u6c42\u7ed3\u675f\u672c\u8f6e\uff0c\u4e0d\u518d\u6269\u5c55\u65b0\u8ba1\u5212\u3002"
                    if chinese
                    else "I summarized the retained findings so far above. Next I'll end the run here as you requested without opening more plans."
                )
            else:
                message = (
                    "\u6211\u5df2\u6309\u4f60\u7684\u8981\u6c42\u5728\u8fd9\u91cc\u7ed3\u675f\u672c\u8f6e\uff1b\u5982\u679c\u4e4b\u540e\u8fd8\u60f3\u7ee7\u7eed\uff0c\u53ef\u4ee5\u76f4\u63a5\u57fa\u4e8e\u4e0a\u9762\u7684\u603b\u7ed3\u6307\u5b9a\u4e0b\u4e00\u6b65\u8981\u8ffd\u95ee\u7684\u65b9\u5411\u3002"
                    if chinese
                    else "I ended the run here as you requested. If you want to continue later, we can start from the summary above and follow a more specific next question."
                )
            response_arguments: dict[str, Any] = {"message": message}
            if citations:
                response_arguments["citations"] = self._serialize_citations(citations)
            return {"name": "respond_to_user", "arguments": response_arguments}
        if tool_name == "evaluate_progress":
            if chinese:
                message = (
                    "我记录这次阶段总结，是因为最新一批 dispatch 已经积累出足够具体的证据"
                    f"{cited_reference}，适合先做一次阶段性收束。接下来可以继续深挖最强发现，"
                    "补齐离用户目标最近的剩余空白，或先验证一个关键边界情况，再决定是否收尾。"
                )
            else:
                message = (
                    "I recorded this stage summary because the latest dispatch batch added enough concrete evidence"
                    f"{cited_reference} to justify a checkpoint. Next I can either drill into the strongest finding, "
                    "cover a remaining gap against the user goal, or validate an edge case before deciding whether "
                    "the run is ready to complete."
                )
        else:
            if chinese:
                message = (
                    "我将这次 run 标记为完成，是因为当前证据已经覆盖了活跃目标"
                    f"{cited_reference}，没有留下明显必须继续展开的分析路径。后续如果还想继续，"
                    "可以深入解释最强发现、定向验证边界情况，或提出一个超出当前目标的新问题。"
                )
            else:
                message = (
                    "I marked the run complete because the current evidence already covers the active goal"
                    f"{cited_reference} without leaving a clearly necessary analysis path unexplored. Optional next "
                    "steps would be deeper explanation of the strongest finding, targeted validation of edge cases, "
                    "or a new follow-up question beyond the current goal."
                )
        response_arguments: dict[str, Any] = {"message": message}
        if citations:
            response_arguments["citations"] = self._serialize_citations(citations)
        return {"name": "respond_to_user", "arguments": response_arguments}

    def _ensure_post_summary_user_responses(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        normalized_calls = [
            self._normalize_tool_call(tool_call)
            for tool_call in tool_calls
        ]
        result: list[dict[str, Any]] = []
        consumed_indexes: set[int] = set()

        for index, tool_call in enumerate(normalized_calls):
            if index in consumed_indexes:
                continue
            name = tool_call["name"]
            result.append(tool_call)
            if name not in {"evaluate_progress", "mark_complete"}:
                continue

            respond_index: int | None = None
            immediate_index = index + 1
            if (
                immediate_index < len(normalized_calls)
                and immediate_index not in consumed_indexes
                and normalized_calls[immediate_index]["name"] == "respond_to_user"
            ):
                respond_index = immediate_index
            else:
                for candidate_index in range(index + 1, len(normalized_calls)):
                    if candidate_index in consumed_indexes:
                        continue
                    if normalized_calls[candidate_index]["name"] == "respond_to_user":
                        respond_index = candidate_index
                        break

            if respond_index is None:
                result.append(
                    self._build_post_summary_user_response(name, tool_call["arguments"])
                )
                continue

            consumed_indexes.add(respond_index)
            respond_call = normalized_calls[respond_index]
            message = str(respond_call["arguments"].get("message", "")).strip()
            if not message or not self._matches_latest_user_language(message):
                respond_call = self._build_post_summary_user_response(
                    name,
                    tool_call["arguments"],
                )
            result.append(respond_call)

        return result

    def _tool_create_plans(self, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self.state is not None
        created_ids: list[str] = []
        created_plans: list[dict[str, Any]] = []
        rejected_plans: list[dict[str, str]] = []
        current_turn = self.state.current_turn()
        raw_plans = self._plans_to_create_for_current_call(arguments)
        for raw in raw_plans:
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text", "")).strip()
            if not text:
                continue
            rejection_reason = self._reused_plan_text_reason(text)
            if (
                rejection_reason in {"duplicate_turn_goal", "duplicate_user_message"}
                and str(raw.get("source", "")).strip() == "current_goal_fallback"
                and self._generic_goal_fallback_is_allowed()
            ):
                rejection_reason = None
            if rejection_reason is not None:
                rejected_plans.append({
                    "text": text,
                    "reason": rejection_reason,
                })
                continue
            plan = PlanItem.create(text=text)
            self.state.plans.append(plan)
            created_ids.append(plan.plan_id)
            created_plans.append(plan.to_dict())
            self.store.log_plan_created(plan)
            source = str(raw.get("source", "")).strip()
            if current_turn is not None and source:
                current_turn.timeline.append(
                    TimelineEntry(
                        entry_type="plan_created",
                        content={
                            "plan_id": plan.plan_id,
                            "plan_text": plan.text,
                            "message_id": str(raw.get("message_id", "")).strip(),
                            "source": source,
                        },
                    )
                )
        recorded_steering_message_ids = self._record_follow_up_create_for_recent_steering(
            current_turn,
            created_ids,
        )
        result = {
            "created_plan_ids": created_ids,
            "plans": created_plans,
            "rejected_plans": rejected_plans,
        }
        if recorded_steering_message_ids:
            result["recorded_steering_message_ids"] = recorded_steering_message_ids
        return result

    def _plans_to_create_for_current_call(
        self,
        arguments: dict[str, Any],
    ) -> list[dict[str, Any]]:
        raw_plans = [
            item
            for item in arguments.get("plans", []) or []
            if isinstance(item, dict)
        ]
        replay_texts = self._replay_create_plan_texts_for_current_call()
        if not replay_texts:
            return raw_plans

        replay_plans: list[dict[str, Any]] = []
        for index, text in enumerate(replay_texts):
            replay_plan: dict[str, Any] = {"text": text}
            if index < len(raw_plans):
                source = str(raw_plans[index].get("source", "")).strip()
                message_id = str(raw_plans[index].get("message_id", "")).strip()
                if source:
                    replay_plan["source"] = source
                if message_id:
                    replay_plan["message_id"] = message_id
            replay_plans.append(replay_plan)
        return replay_plans

    def _replay_create_plan_texts_for_current_call(self) -> list[str] | None:
        if not self._create_plans_replay_enabled():
            return None
        call_index = self._create_plans_call_index()
        return self._load_replay_plan_texts(call_index)

    def _create_plans_replay_enabled(self) -> bool:
        return str(os.environ.get(CREATE_PLANS_REPLAY_ENV, "")).strip() == "1"

    def _create_plans_call_index(self) -> int:
        assert self.state is not None
        historical_calls = sum(
            1
            for turn in self.state.turns
            for entry in turn.timeline
            if entry.entry_type == "create_plans"
        )
        return historical_calls + 1

    def _create_plans_replay_cache_path(self) -> Path:
        return (Path(__file__).resolve().parents[1] / "cache.json").resolve()

    def _load_replay_plan_texts(self, call_index: int) -> list[str] | None:
        cache_path = self._create_plans_replay_cache_path()
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        raw_entry = payload.get(str(call_index))
        if not isinstance(raw_entry, list) or not raw_entry:
            return None

        replay_texts: list[str] = []
        for item in raw_entry:
            if not isinstance(item, str):
                return None
            text = item.strip()
            if not text:
                return None
            replay_texts.append(text)
        return replay_texts

    async def _tool_dispatch_plans(self, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self.state is not None
        plan_ids = [str(item) for item in arguments.get("plan_ids", []) or []]
        requested_pending_ids: list[str] = []
        seen: set[str] = set()
        reused_batch: DispatchBatchState | None = None

        for plan_id in plan_ids:
            if not plan_id or plan_id in seen:
                continue
            seen.add(plan_id)
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            if reused_batch is None:
                reused_batch = self._dispatch_batch_for_plan(plan.plan_id)
            requested_pending_ids.append(plan.plan_id)
        batch = reused_batch
        if batch is None:
            batch = self._register_dispatch_batch(requested_pending_ids)
        else:
            for plan_id in requested_pending_ids:
                self._attach_plan_to_dispatch_batch(batch, plan_id)
        if requested_pending_ids:
            self._dequeue_pending_direct_user_create_dispatch_plan_ids(requested_pending_ids)
        dispatched = await self._launch_pending_plans_for_batch(batch) if batch is not None else []
        if batch is None:
            batch = self._register_dispatch_batch(dispatched)
        self._refresh_run_status_from_plans()
        result: dict[str, Any] = {"dispatched_plan_ids": dispatched}
        if batch is not None:
            result["dispatch_turn_index"] = batch.dispatch_turn_index
            result["plan_ids"] = list(batch.plan_ids)
        return result

    def _tool_evaluate_progress(self, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self.state is not None
        if not self._can_consider_summary_or_completion():
            return {"ignored": True, "reason": "nonterminal plans remain"}
        pending_batch = self._pending_stage_summary_batch()
        if pending_batch is None:
            return {"ignored": True, "reason": "no completed batch awaiting stage summary"}
        scope_batches = self._current_stage_summary_scope_batches(pending_batch)
        if not scope_batches:
            scope_batches = [pending_batch]
        evaluation = str(arguments.get("evaluation", "")).strip()
        stage_summary_markdown = str(arguments.get("stage_summary_markdown", "")).strip()
        if not stage_summary_markdown:
            stage_summary_markdown = evaluation
        if not evaluation:
            evaluation = stage_summary_markdown
        citations = self._parse_citations(arguments.get("citations"))

        result: dict[str, Any] = {
            "evaluation": evaluation,
        }
        if stage_summary_markdown:
            result["stage_summary_markdown"] = stage_summary_markdown
        if citations:
            result["citations"] = self._serialize_citations(citations)

        covered_dispatch_turn_indexes = [
            batch.dispatch_turn_index
            for batch in scope_batches
        ]
        covered_plan_ids = self._stage_summary_scope_plan_ids(scope_batches)
        for batch in scope_batches:
            batch.status = "stage_summarized"
            batch.stage_summary_emitted = True
            if batch.dispatch_turn_index == pending_batch.dispatch_turn_index:
                batch.stage_summary_markdown = stage_summary_markdown
                batch.stage_summary_citations = citations

        result["dispatch_turn_index"] = pending_batch.dispatch_turn_index
        result["plan_ids"] = list(pending_batch.plan_ids)
        result["covered_dispatch_turn_indexes"] = covered_dispatch_turn_indexes
        result["covered_plan_ids"] = covered_plan_ids

        self.store.log_progress_evaluation(result)
        self.store.save_state(self.state)
        return result

    def _tool_synthesize_findings(self, arguments: dict[str, Any]) -> dict[str, Any]:
        synthesis = str(arguments.get("synthesis", "")).strip()
        self._latest_synthesis = synthesis
        self.store.log_synthesis_update(synthesis)
        return {"synthesis": synthesis}

    def _tool_respond_to_user(self, arguments: dict[str, Any]) -> dict[str, Any]:
        message = str(arguments.get("message", "")).strip()
        citations = self._parse_citations(arguments.get("citations"))
        payload: dict[str, Any] = {"message": message}
        if citations:
            payload["citations"] = self._serialize_citations(citations)
        self.store.append_event("user_response", payload)
        return payload

    def _tool_mark_complete(self, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self.state is not None
        stop_intent_completion = (
            self._latest_stop_intent_chat_message() is not None
            and not self._has_nonterminal_plans()
        )
        if not self._can_consider_summary_or_completion() and not stop_intent_completion:
            return {"ignored": True, "reason": "nonterminal plans remain"}
        summary = str(arguments.get("summary", "")).strip()
        citations = self._parse_citations(arguments.get("citations"))
        dispatch_batch = (
            self.state.master_agent_state.dispatch_batches[-1]
            if self.state.master_agent_state.dispatch_batches
            else None
        )
        self.state.master_agent_state.completed = True
        self.state.final_summary = summary
        current = self.state.current_turn()
        if current is not None:
            current.status = "completed"
            current.final_summary = summary
        if not self._active_tasks:
            self._enter_completed_wait_state(reason=summary)
        result: dict[str, Any] = {"summary": summary}
        if dispatch_batch is not None:
            result["dispatch_turn_index"] = dispatch_batch.dispatch_turn_index
        if citations:
            result["citations"] = self._serialize_citations(citations)
        return result

    async def _collect_finished_sub_agents(self) -> bool:
        assert self.state is not None
        finished = [
            plan_id for plan_id, task in self._active_tasks.items() if task.done()
        ]
        if not finished:
            return False
        # Same rule as control processing: pending seat-fill happens only after
        # terminal release transitions (completed/failed/terminated).
        release_triggered = False
        for plan_id in finished:
            task = self._active_tasks.pop(plan_id)
            task_generation = self._active_task_generations.pop(plan_id, None)
            plan = self.state.get_plan_by_id(plan_id)
            try:
                result = await task
            except Exception as exc:
                result = SubAgentResult(
                    plan_id=plan_id,
                    success=False,
                    execution_records=[],
                    insight=None,
                    error=str(exc),
                )
            if not self._is_current_plan_generation(plan_id, task_generation):
                continue
            if plan is None:
                continue

            result_timestamp_binding = result.timestamp_binding
            try:
                with activate_timestamp_binding(result_timestamp_binding):
                    self.state.master_agent_state.active_plan_ids = [
                        item
                        for item in self.state.master_agent_state.active_plan_ids
                        if item != plan_id
                    ]
                    for record in result.execution_records:
                        self.state.execution_records.append(record)
                        self.store.log_execution_completed(record)
                    previous_status = plan.status
                    state_update = SubAgent.derive_plan_state_update(plan, result)
                    if result.checkpoint_path:
                        plan.checkpoint_path = result.checkpoint_path
                    if state_update.resume_phase is not None:
                        plan.resume_phase = state_update.resume_phase
                    plan.status = state_update.status  # type: ignore[assignment]
                    plan.control_state = state_update.control_state  # type: ignore[assignment]
                    plan.assigned_sub_agent_id = None
                    plan.error_message = state_update.error_message
                    if state_update.final_summary is not None:
                        plan.final_summary = state_update.final_summary
                    if SubAgent.should_trigger_pending_fill_for_transition(
                        previous_status=previous_status,
                        next_status=plan.status,
                    ):
                        release_triggered = True

                    if state_update.status == "paused":
                        self._persist_plan_update(plan)
                        self._emit_progress(f"Plan paused: {plan.plan_id}")
                        self._append_timeline_entry("plan_paused", {
                            "plan_id": plan.plan_id,
                            "plan_text": plan.text,
                            "resume_phase": plan.resume_phase,
                        })
                        continue
                    if state_update.status == "pending" and state_update.control_state == "yield_requested":
                        plan.assigned_sub_agent_id = None
                        self._persist_plan_update(plan)
                        self._emit_progress(f"Plan yielded: {plan.plan_id}")
                        continue
                    if state_update.status == "terminated":
                        self._persist_plan_update(plan)
                        self._emit_progress(f"Plan terminated: {plan.plan_id}")
                        self._append_timeline_entry("plan_terminated", {
                            "plan_id": plan.plan_id,
                            "plan_text": plan.text,
                        })
                        continue
                    if state_update.status == "completed":
                        if plan_id not in self.state.master_agent_state.completed_plan_ids:
                            self.state.master_agent_state.completed_plan_ids.append(plan_id)
                        self.store.log_plan_completed(plan)
                        self._emit_progress(f"Plan completed: {plan.plan_id}")
                    elif state_update.status == "failed":
                        self.state.failure_count += 1
                        self._emit_progress(f"Plan failed: {plan.plan_id}")
                        self.store.log_plan_status_changed(plan)
                        self._append_timeline_entry("plan_failed", {
                            "plan_id": plan.plan_id, "plan_text": plan.text,
                            "error": plan.error_message or "unknown",
                        })

                    if result.success and result.insight is not None:
                        insight = result.insight
                        insight.plan_id = plan.plan_id
                        insight.parent_insight_id = plan.parent_insight_id
                        insight.short_label = plan.short_label or insight.short_label
                        self.state.insights.append(insight)
                        self.state.master_agent_state.all_insight_ids.append(insight.insight_id)
                        self.store.log_insight_extracted(insight)
                        self._append_timeline_entry("plans_completed", {
                            "plan_id": plan.plan_id, "plan_text": plan.text,
                            "insight_summary": insight.summary,
                        })
            finally:
                finalize_timestamp_binding(result_timestamp_binding)
        if release_triggered:
            await self._fill_dispatch_batch_seats()
        self._sync_dispatch_batches()
        self._refresh_run_status_from_plans()
        return True

    @staticmethod
    def _build_user_steer_timeline_content(message: UserMessage, kind: str) -> dict[str, Any]:
        content = {
            "message_id": message.message_id,
            "kind": kind,
            "content": message.content,
            "display_text": message.display_text,
            "user_prompt": (
                message.user_prompt
                if message.user_prompt is not None
                else (
                    message.generated_prompt
                    if message.generated_prompt is not None
                    else message.content
                )
            ),
            "system_prompt": message.system_prompt,
            "generated_prompt": (
                message.generated_prompt
                if message.generated_prompt is not None
                else message.content
            ),
            "selected_keywords": list(message.selected_keywords),
            "target": message.target.to_dict() if message.target is not None else None,
        }
        if kind != "create":
            content["follow_up_plan_create_recorded"] = False
            content["follow_up_created_plan_ids"] = []
            content["follow_up_create_recorded_at"] = None
        return content

    @staticmethod
    def _steering_entry_requires_follow_up_create(entry: TimelineEntry) -> bool:
        if entry.entry_type != "user_steer" or not isinstance(entry.content, dict):
            return False
        kind = normalize_steering_message_kind(entry.content.get("kind")) or "chat"
        return kind != "create"

    def _record_follow_up_create_for_recent_steering(
        self,
        turn: Turn | None,
        created_plan_ids: list[str],
    ) -> list[str]:
        if turn is None or not created_plan_ids:
            return []

        previous_create_index = -1
        for index in range(len(turn.timeline) - 1, -1, -1):
            if turn.timeline[index].entry_type == "create_plans":
                previous_create_index = index
                break

        recorded_message_ids: list[str] = []
        recorded_at = now_iso()
        for entry in turn.timeline[previous_create_index + 1 :]:
            if not self._steering_entry_requires_follow_up_create(entry):
                continue
            content = entry.content
            if bool(content.get("follow_up_plan_create_recorded")):
                continue
            message_id = str(content.get("message_id", "")).strip()
            content["follow_up_plan_create_recorded"] = True
            content["follow_up_created_plan_ids"] = list(created_plan_ids)
            content["follow_up_create_recorded_at"] = recorded_at
            if message_id:
                recorded_message_ids.append(message_id)
        return recorded_message_ids

    def _append_steering_message_to_turn(self, turn: Turn, message: UserMessage) -> None:
        kind = self._message_kind(message)
        if kind == "focus":
            append_focus_to_turn(turn, message)
        elif kind == "ignore":
            append_ignore_to_turn(turn, message)
        elif kind == "elaborate":
            append_elaborate_to_turn(turn, message)
        else:
            canonical_text = self._canonical_message_text(message)
            if canonical_text:
                turn.steers.append(canonical_text)
            turn.timeline.append(
                TimelineEntry(
                    entry_type="user_steer",
                    content=self._build_user_steer_timeline_content(message, kind),
                )
            )
        self.store.save_state(self.state)

    def _create_user_plan_from_message(self, turn: Turn, message: UserMessage) -> PlanItem | None:
        assert self.state is not None
        plan_text = str(message.content or "").strip()
        if not plan_text:
            return None
        target_batch = self._latest_unresolved_dispatch_batch()
        plan = PlanItem.create(text=plan_text)
        self.state.plans.append(plan)
        if target_batch is not None:
            self._attach_plan_to_dispatch_batch(target_batch, plan.plan_id)
            self._sync_dispatch_batches()
        else:
            self._enqueue_pending_direct_user_create_dispatch_plan_id(plan.plan_id)
        self.store.log_plan_created(plan)
        turn.timeline.append(
            TimelineEntry(
                entry_type="plan_created",
                content={
                    "plan_id": plan.plan_id,
                    "plan_text": plan.text,
                    "message_id": message.message_id,
                    "source": "user_create",
                },
            )
        )
        if (
            target_batch is not None
            and self._active_execution_seat_count() < self._effective_max_concurrency()
        ):
            self._pending_direct_user_create_launch_plan_ids.append(plan.plan_id)
        self._refresh_run_status_from_plans()
        self.store.save_state(self.state)
        return plan

    def _process_user_steer(self) -> bool:
        assert self.state is not None
        self.user_steer_queue.poll_file()
        new_messages = self.user_steer_queue.drain_new_messages()
        if not new_messages:
            return False

        current = self.state.current_turn()
        for message in new_messages:
            kind = self._message_kind(message)
            stop_intent = self._is_stop_intent_message(message)
            used_as_new_turn_goal = False
            if current is None or current.status != "running":
                if not stop_intent:
                    self._resume_with_new_turn_goal(message)
                    current = self.state.current_turn()
                    used_as_new_turn_goal = True
                    if current is None:
                        continue

            queued_user_response = self._enqueue_pending_user_response(message)
            if stop_intent:
                stop_turn = current if current is not None else self.state.current_turn()
                self._apply_stop_intent_to_run(message, turn=stop_turn)
                current = self.state.current_turn()
            elif not (used_as_new_turn_goal and kind == "chat"):
                self._append_steering_message_to_turn(current, message)
            if kind == "create":
                self._create_user_plan_from_message(current, message)
            elif queued_user_response and used_as_new_turn_goal and kind == "chat" and self.store is not None:
                self.store.save_state(self.state)
        return True

    def _check_stop_file(self) -> None:
        assert self.state is not None
        stop_path = self.store.run_dir / RUN_CONTROL_STOP_FILE
        if not stop_path.exists():
            return
        self._stop_requested = True

    def _should_stop(self, *, allow_post_processing: bool = False) -> bool:
        assert self.state is not None
        if self.state.status in {"failed", "stopped"}:
            return True
        terminal_plans = (
            bool(self.state.plans)
            and not any(
                plan.status in {"pending", "analyzing", "summarizing", "paused"}
                for plan in self.state.plans
            )
        )
        if terminal_plans and not self.state.insights and self.state.failure_count > 0:
            old_status = self.state.status
            self.state.status = "failed"
            self.store.log_run_status_change(
                old_status,
                "failed",
                "all terminal plans failed without extracting insights",
            )
            return True
        if self._stop_requested and not self._active_tasks:
            return True
        return False

    async def _finalize(self) -> None:
        assert self.state is not None
        if not self.state.final_summary:
            if self._latest_synthesis:
                self.state.final_summary = self._latest_synthesis
            elif self.state.insights:
                self.state.final_summary = self.state.insights[-1].summary
        if self.state.status in {"running", "idle"} and self.state.master_agent_state.completed:
            self.state.status = "completed"
        self.store.save_state(self.state)
        self._emit_progress(f"Run finished with status: {self.state.status}")

    def _build_llm_messages(self) -> list[dict[str, str]]:
        assert self.state is not None
        latest_user_text = latest_user_authored_text(self.state.user_messages)
        system_content = (
            MASTER_AGENT_SYSTEM_PROMPT + "\n\n"
            + self.context_builder.build_system_context(self.state)
        )
        if latest_user_text:
            system_content += (
                "\n\n"
                "Language-match priority:\n"
                + strict_language_match_instruction(latest_user_text)
                + "\n"
                "This applies to plans, stage summaries, syntheses, final summaries, and all other "
                "user-visible natural-language tool arguments, even if earlier plan text uses another language.\n"
                f"Latest user-authored message:\n{latest_user_text}"
            )
        user_content = self.context_builder.build_user_prompt(self.state)
        return [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

    def _is_stop_intent_message(self, message: UserMessage | None) -> bool:
        return False

    def _latest_stop_intent_chat_message(self) -> UserMessage | None:
        return self._pending_stop_completion_message()

    def _resume_with_new_turn_goal(self, message: UserMessage) -> None:
        assert self.state is not None
        goal_text = self._canonical_message_text(message)
        old_status = self.state.status
        self.state.status = "running"
        self.state.master_agent_state.completed = False
        self._clear_pending_stop_completion()
        self.state.master_agent_state.current_goals = [goal_text]
        new_turn = Turn(turn_id=len(self.state.turns), goal=goal_text)
        self.state.turns.append(new_turn)
        self._idle_started_at = None
        self.store.log_run_status_change(old_status, "running", "Resumed with new goal")
        self.store.save_state(self.state)
        self._emit_progress(f"Resumed with new goal: {goal_text}")

    def _apply_pending_stop_completion_after_ack(self, message_id: str | None) -> None:
        assert self.state is not None
        normalized_message_id = str(message_id or "").strip()
        if not normalized_message_id:
            return
        if (
            str(self.state.master_agent_state.pending_stop_completion_message_id or "").strip()
            == normalized_message_id
        ):
            return
        self._mark_pending_stop_completion(normalized_message_id)
        self._pending_direct_user_create_launch_plan_ids = []
        self._clear_pending_direct_user_create_dispatch_queue()
        current_turn = self.state.current_turn()
        for plan in self.state.plans:
            if plan.status not in {"pending", "paused"}:
                continue
            request = PlanControlRequest(plan_id=plan.plan_id, action="terminate")
            if not apply_control_request_to_plan(plan, request):
                continue
            if plan.status != "terminated":
                continue
            plan.assigned_sub_agent_id = None
            self.state.master_agent_state.active_plan_ids = [
                plan_id
                for plan_id in self.state.master_agent_state.active_plan_ids
                if plan_id != plan.plan_id
            ]
            self._persist_plan_update(plan)
            if current_turn is not None:
                current_turn.timeline.append(
                    TimelineEntry(
                        entry_type="plan_terminated",
                        content={
                            "plan_id": plan.plan_id,
                            "plan_text": plan.text,
                        },
                    )
                )
        self._sync_dispatch_batches()
        self._refresh_run_status_from_plans()
        self.store.save_state(self.state)

    def _build_batch_finished_user_response_message(
        self,
        batch: DispatchBatchState,
    ) -> str:
        chinese = self._prefers_chinese_response()
        if self._pending_stop_completion_active():
            if chinese:
                return "\u8fd9\u6279\u4efb\u52a1\u5df2\u7ecf\u7ed3\u675f\uff0c\u6211\u5c06\u6309\u4f60\u7684\u8981\u6c42\u7ed3\u675f\u672c\u8f6e\uff0c\u4e0d\u518d\u6269\u5c55\u65b0\u8ba1\u5212\u3002"
            return (
                "This batch has finished. Per your request, I'll end this run here and "
                "won't open more plans."
            )
        has_insights = bool(self._insights_for_plan_ids(batch.plan_ids))
        if chinese:
            if has_insights:
                return (
                    "\u8fd9\u4e00\u6279\u8ba1\u5212\u5df2\u7ecf\u5168\u90e8\u7ed3\u675f\uff0c\u6211\u5df2\u7ecf\u62ff\u5230\u8fd9\u4e00\u6279\u7684\u7ed3\u679c\u3002"
                    "\u63a5\u4e0b\u6765\u6211\u4f1a\u5148\u5224\u65ad\u662f\u5426\u8fd8\u9700\u8981\u7ee7\u7eed\u8865\u5f00\u65b0\u7684\u8ba1\u5212\uff0c"
                    "\u518d\u51b3\u5b9a\u662f\u5426\u9002\u5408\u505a\u9636\u6bb5\u6027\u603b\u7ed3\u6216\u7ed3\u675f\u5f53\u524d run\u3002"
                )
            return (
                "\u8fd9\u4e00\u6279\u8ba1\u5212\u5df2\u7ecf\u5168\u90e8\u7ed3\u675f\uff0c\u4f46\u8fd9\u6279\u91cc\u8fd8\u6ca1\u6709\u5f62\u6210\u53ef\u4fdd\u7559\u7684\u53d1\u73b0\u3002"
                "\u63a5\u4e0b\u6765\u6211\u4f1a\u5224\u65ad\u662f\u5426\u9700\u8981\u8865\u5f00\u65b0\u7684\u8ba1\u5212\u6216\u8c03\u6574\u5206\u6790\u65b9\u5411\u3002"
            )
        if has_insights:
            return (
                "This dispatch batch has finished running, and I have the results from it. "
                "Next I'll decide whether more plans are still needed before considering a stage summary or completion."
            )
        return (
            "This dispatch batch has finished running, but it did not produce a retained finding yet. "
            "Next I'll decide whether to open more plans or adjust the direction."
        )

    async def _process_pending_direct_user_create_launches(self) -> bool:
        if self._pending_stop_completion_active():
            self._pending_direct_user_create_launch_plan_ids = []
            return False
        if not self._pending_direct_user_create_launch_plan_ids:
            return False
        pending_launch_plan_ids = list(self._pending_direct_user_create_launch_plan_ids)
        self._pending_direct_user_create_launch_plan_ids = []
        launched_any = False
        for plan_id in pending_launch_plan_ids:
            if self._active_execution_seat_count() >= self._effective_max_concurrency():
                self._pending_direct_user_create_launch_plan_ids.append(plan_id)
                continue
            if self.state is None:
                continue
            plan = self.state.get_plan_by_id(plan_id)
            if plan is None or plan.status != "pending":
                continue
            if await self._launch_plan(plan):
                launched_any = True
        if launched_any:
            self._sync_dispatch_batches()
            self._refresh_run_status_from_plans()
            self.store.save_state(self.state)
        return launched_any or bool(pending_launch_plan_ids)

    async def _fill_dispatch_batch_seats(self) -> bool:
        if self._pending_stop_completion_active():
            return False
        batch = self._latest_unresolved_dispatch_batch()
        if batch is None or self.state is None:
            return False
        launched = await self._launch_pending_plans_for_batch(batch)
        if not launched:
            return False
        self._sync_dispatch_batches()
        self._refresh_run_status_from_plans()
        return True

    def _filter_summary_tool_calls_until_all_plans_terminal(
        self,
        tool_calls: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if self._pending_stop_completion_active():
            tool_calls = [
                tool_call
                for tool_call in tool_calls
                if str(tool_call.get("name", "")).strip()
                not in {"evaluate_progress", "synthesize_findings"}
            ]
        if not self._can_consider_summary_or_completion():
            summary_tool_names = {"evaluate_progress", "synthesize_findings", "mark_complete"}
            return [
                tool_call
                for tool_call in tool_calls
                if str(tool_call.get("name", "")).strip() not in summary_tool_names
            ]
        if self._pending_stage_summary_batch() is not None and not self._pending_stop_completion_active():
            return tool_calls
        return [
            tool_call
            for tool_call in tool_calls
            if str(tool_call.get("name", "")).strip() != "evaluate_progress"
        ]

    def _fallback_decision(self) -> list[dict[str, Any]]:
        assert self.state is not None
        pending = [plan for plan in self.state.plans if plan.status == "pending"]
        current_turn = self.state.current_turn()
        current_goal = current_turn.goal if current_turn else (
            self.state.master_agent_state.current_goals[0]
            if self.state.master_agent_state.current_goals
            else ""
        )
        normalized_current_goal = current_goal.strip()
        if self._pending_stop_completion_active():
            if self._active_tasks or self._has_nonterminal_plans():
                return []
            return [
                {
                    "name": "mark_complete",
                    "arguments": {"summary": self._build_stop_completion_summary()},
                    "_runtime_internal_stop_completion": True,
                }
            ]
        if self._pending_direct_user_create_dispatch_plan_ids():
            return []
        if not self.state.plans:
            return [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {
                                "text": normalized_current_goal,
                                "source": "current_goal_fallback",
                            }
                        ][: self.max_initial_plans],
                    },
                }
            ]
        latest_unresolved_batch = self._latest_unresolved_dispatch_batch()
        if (
            latest_unresolved_batch is not None
            and self._can_fallback_dispatch_pending_for_batch(latest_unresolved_batch)
        ):
            pending_batch_plan_ids = self._pending_launch_candidates_for_batch(latest_unresolved_batch)
            if pending_batch_plan_ids:
                return [
                    {
                        "name": "dispatch_plans",
                        "arguments": {"plan_ids": [pending_batch_plan_ids[0]]},
                    }
                ]
        if (
            normalized_current_goal
            and self._generic_goal_fallback_is_allowed()
            and not any(
                plan.text.strip() == normalized_current_goal
                for plan in self.state.plans
            )
        ):
            return [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {
                                "text": normalized_current_goal,
                                "source": "current_goal_fallback",
                            }
                        ][: self.max_initial_plans],
                    },
                }
            ]
        if pending and latest_unresolved_batch is None:
            return [
                {
                    "name": "dispatch_plans",
                    "arguments": {
                        "plan_ids": [
                            plan.plan_id
                            for plan in pending[: self._effective_max_concurrency()]
                        ]
                    },
                }
            ]
        if self._active_tasks:
            return []
        if (
            self.state.insights
            and not self.state.master_agent_state.completed
            and self._can_consider_summary_or_completion()
        ):
            return [
                {
                    "name": "synthesize_findings",
                    "arguments": {"synthesis": self.state.insights[-1].summary},
                },
                {
                    "name": "mark_complete",
                    "arguments": {"summary": self.state.insights[-1].summary},
                },
            ]
        return []

    async def _execute_tool_calls(self, tool_calls: list[dict[str, Any]]) -> None:
        for tool_call in tool_calls:
            name = str(tool_call.get("name", "")).strip()
            arguments = tool_call.get("arguments", {}) or {}
            turn_ref = self.state.current_turn() if self.state else None
            if name == "create_plans":
                result = self._tool_create_plans(arguments)
            elif name == "dispatch_plans":
                result = await self._tool_dispatch_plans(arguments)
            elif name == "evaluate_progress":
                result = self._tool_evaluate_progress(arguments)
            elif name == "synthesize_findings":
                result = self._tool_synthesize_findings(arguments)
            elif name == "respond_to_user":
                result = self._tool_respond_to_user(arguments)
            elif name == "mark_complete":
                result = self._tool_mark_complete(arguments)
            else:
                result = {"ignored": True, "reason": f"unknown tool {name}"}
            self.store.log_master_agent_tool_result(name, result)
            pending_user_response_message_id = str(
                tool_call.get("_pending_user_response_message_id", "")
            ).strip()
            if pending_user_response_message_id:
                self._acknowledge_pending_user_response(pending_user_response_message_id)
                if name == "respond_to_user" and bool(tool_call.get("_probable_stop")):
                    self._apply_pending_stop_completion_after_ack(
                        pending_user_response_message_id
                    )
            batch_finished_dispatch_turn_index = tool_call.get("_batch_finished_dispatch_turn_index")
            if (
                name == "respond_to_user"
                and isinstance(batch_finished_dispatch_turn_index, int)
                and self.state is not None
            ):
                for batch in self.state.master_agent_state.dispatch_batches:
                    if batch.dispatch_turn_index == batch_finished_dispatch_turn_index:
                        batch.batch_finished_user_response_emitted = True
                        break
            if turn_ref is not None:
                turn_ref.timeline.append(
                    TimelineEntry(
                        entry_type=name,
                        content={"arguments": arguments, "result": result},
                    )
                )

    def _tool_mark_complete(self, arguments: dict[str, Any]) -> dict[str, Any]:
        assert self.state is not None
        if not self._can_consider_summary_or_completion():
            return {"ignored": True, "reason": "nonterminal plans remain"}
        summary = str(arguments.get("summary", "")).strip()
        citations = self._parse_citations(arguments.get("citations"))
        dispatch_batch = (
            self.state.master_agent_state.dispatch_batches[-1]
            if self.state.master_agent_state.dispatch_batches
            else None
        )
        self.state.master_agent_state.completed = True
        self.state.final_summary = summary
        current = self.state.current_turn()
        if current is not None:
            current.status = "completed"
            current.final_summary = summary
        self._clear_pending_stop_completion()
        if not self._active_tasks:
            self._enter_completed_wait_state(reason=summary)
        result: dict[str, Any] = {"summary": summary}
        if dispatch_batch is not None:
            result["dispatch_turn_index"] = dispatch_batch.dispatch_turn_index
        if citations:
            result["citations"] = self._serialize_citations(citations)
        return result

    def _build_llm_messages(self) -> list[dict[str, str]]:
        assert self.state is not None
        latest_user_text = latest_user_authored_text(self.state.user_messages)
        system_content = (
            MASTER_AGENT_SYSTEM_PROMPT + "\n\n"
            + self.context_builder.build_system_context(self.state)
        )
        if latest_user_text:
            system_content += (
                "\n\n"
                "Language-match priority:\n"
                + strict_language_match_instruction(latest_user_text)
                + "\n"
                "This applies to plans, stage summaries, syntheses, final summaries, and all other "
                "user-visible natural-language tool arguments, even if earlier plan text uses another language.\n"
                f"Latest user-authored message:\n{latest_user_text}"
            )
        if self.context_builder.has_open_steering_follow_up(self.state):
            system_content += (
                "\n\n"
                "Open steering follow-up rule:\n"
                "- Some non-create steering messages in the run have not yet been followed by a later create_plans call.\n"
                "- You may still call evaluate_progress before handling those steering follow-ups when a stage summary is justified now.\n"
                "- Do not call mark_complete while any open steering follow-up remains unresolved.\n"
                "- Resolve an open steering follow-up by creating at least one relevant plan in a later create_plans call informed by that steering.\n"
            )
        pending_stop_message = self._pending_stop_completion_message()
        if pending_stop_message is not None:
            system_content += (
                "\n\n"
                "Stop-completion context:\n"
                "The latest user-authored chat message asks to end the current run.\n"
                "Do not create new plans, dispatch pending plans, emit evaluate_progress, or synthesize findings.\n"
                "Pending or paused work must stay stopped, while already-running work may finish naturally.\n"
                "If any work is still active or any plan is still nonterminal, wait instead of expanding the run.\n"
                "Once all current work is terminal, return mark_complete with a comprehensive final summary of the retained findings from the full run.\n"
                f"Stop request:\n{canonical_user_message_text(pending_stop_message)}"
            )
        user_content = self.context_builder.build_user_prompt(self.state)
        return [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

    def _emit_progress(self, message: str) -> None:
        if self.progress_callback is None:
            return
        try:
            self.progress_callback(message)
        except Exception:
            return

