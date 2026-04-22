"""
Filesystem-backed persistence for the implementation-aligned runtime.
"""

from __future__ import annotations

from datetime import datetime
import json
import threading
from pathlib import Path
from typing import Any
import uuid

from runtime_clock import now_iso
from .models import ArtifactRecord, ExecutionRecord, Insight, PlanItem, RunState, UserMessage


class RunPersistence:
    def __init__(self, run_id: str, base_dir: Path | str | None = None):
        self.run_id = run_id
        self._event_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._steer_lock = threading.Lock()
        self._plan_control_lock = threading.Lock()

        self.base_dir = self._resolve_base_dir(base_dir)
        self.run_dir = self.base_dir / run_id
        self.state_path = self.run_dir / "state.json"
        self.events_path = self.run_dir / "events.jsonl"
        self.steer_path = self.run_dir / "steer.jsonl"
        self.plan_controls_path = self.run_dir / "plan_controls.jsonl"
        self.artifacts_dir = self.run_dir / "artifacts"
        self.code_dir = self.artifacts_dir / "code"
        self.stdout_dir = self.artifacts_dir / "stdout"
        self.stderr_dir = self.artifacts_dir / "stderr"
        self.sessions_dir = self.artifacts_dir / "sessions"
        self.plots_dir = self.artifacts_dir / "plots"
        self.llm_dir = self.artifacts_dir / "llm"
        self.reports_dir = self.artifacts_dir / "reports"
        self.report_packs_dir = self.artifacts_dir / "report_packs"

    @staticmethod
    def _resolve_base_dir(base_dir: Path | str | None) -> Path:
        if base_dir is None:
            return (Path(__file__).resolve().parents[1] / "runs").resolve()
        return Path(base_dir).resolve()

    def initialize(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.code_dir.mkdir(parents=True, exist_ok=True)
        self.stdout_dir.mkdir(parents=True, exist_ok=True)
        self.stderr_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.plots_dir.mkdir(parents=True, exist_ok=True)
        self.llm_dir.mkdir(parents=True, exist_ok=True)
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self.report_packs_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _safe_filename_part(value: str) -> str:
        text = "".join(
            char if char.isalnum() or char in {"-", "_"} else "_"
            for char in str(value or "").strip()
        ).strip("_")
        return text or "item"

    def _record_artifact(
        self,
        *,
        type: str,
        path_or_uri: str,
        owner_refs: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        state = self.load_state()
        if state is None:
            return
        artifact = ArtifactRecord.create(
            type=type,
            path_or_uri=path_or_uri,
            owner_refs=list(owner_refs or []),
            metadata=dict(metadata or {}),
        )
        state.artifacts.append(artifact)
        self.save_state(state)

    def save_state(self, state: RunState) -> None:
        with self._state_lock:
            state.updated_at = now_iso()
            self.state_path.write_text(
                json.dumps(state.to_dict(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

    def load_state(self) -> RunState | None:
        if not self.state_path.exists():
            return None
        with self._state_lock:
            try:
                data = json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                return None
        try:
            return RunState.from_dict(data)
        except Exception:
            return None

    def append_event(self, event_type: str, data: Any) -> None:
        payload = {
            "timestamp": now_iso(),
            "event_type": event_type,
            "data": data if isinstance(data, dict) else {"value": data},
        }
        line = json.dumps(payload, ensure_ascii=False)
        with self._event_lock:
            with self.events_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()

    def append_steer_message(self, message: UserMessage) -> None:
        line = json.dumps(message.to_dict(), ensure_ascii=False)
        with self._steer_lock:
            with self.steer_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()

    def append_plan_control(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False)
        with self._plan_control_lock:
            with self.plan_controls_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()

    def log_plan_created(self, plan: PlanItem) -> None:
        self.append_event("plan_created", plan.to_dict())

    def log_plan_started(self, plan: PlanItem) -> None:
        self.append_event("plan_started", plan.to_dict())

    def log_plan_status_changed(self, plan: PlanItem) -> None:
        self.append_event("plan_status_changed", plan.to_dict())

    def log_plan_completed(self, plan: PlanItem) -> None:
        self.append_event("plan_completed", plan.to_dict())

    def log_execution_completed(self, record: ExecutionRecord) -> None:
        self.append_event("execution_completed", record.to_dict())

    def log_insight_extracted(self, insight: Insight) -> None:
        self.append_event("insight_extracted", insight.to_dict())

    def log_run_status_change(self, old_status: str, new_status: str, reason: str = "") -> None:
        self.append_event(
            "run_status_change",
            {
                "old_status": old_status,
                "new_status": new_status,
                "reason": reason,
            },
        )

    def log_plan_attempt_started(self, plan_id: str, attempt: int) -> None:
        self.append_event("plan_attempt_started", {"plan_id": plan_id, "attempt": attempt})

    def log_plan_attempt_failed(self, plan_id: str, attempt: int, error_summary: str) -> None:
        self.append_event(
            "plan_attempt_failed",
            {
                "plan_id": plan_id,
                "attempt": attempt,
                "error_summary": error_summary,
            },
        )

    def log_plan_log_delta(self, plan_id: str, channel: str, delta: str, seq: int, attempt: int) -> None:
        self.append_event(
            "plan_log_delta",
            {
                "plan_id": plan_id,
                "channel": channel,
                "delta": delta,
                "seq": seq,
                "attempt": attempt,
            },
        )

    def log_master_agent_thinking(self, thought: str, loop_count: int) -> None:
        self.append_event("master_agent_thinking", {"loop_count": loop_count, "thought": thought})

    def log_master_agent_tool_result(self, tool_name: str, result: Any) -> None:
        self.append_event("master_agent_tool_result", {"tool_name": tool_name, "result": result})

    def log_user_steer_received(self, message: UserMessage) -> None:
        self.append_event("user_steer_received", message.to_dict())

    def log_progress_evaluation(self, evaluation: str | dict[str, Any]) -> None:
        if isinstance(evaluation, dict):
            payload = dict(evaluation)
            payload.setdefault("evaluation", str(payload.get("stage_summary_markdown", "")))
            self.append_event("progress_evaluation", payload)
            return
        self.append_event("progress_evaluation", {"evaluation": evaluation})

    def log_synthesis_update(self, synthesis: str) -> None:
        self.append_event("synthesis_update", {"synthesis": synthesis})

    def save_worker_finding(self, plan_id: str, finding: Insight) -> str:
        target = self.sessions_dir / f"{plan_id}.finding.json"
        target.write_text(json.dumps(finding.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")
        state = self.load_state()
        if state is not None and not any(item.insight_id == finding.insight_id for item in state.findings):
            state.findings.append(finding)
            self.save_state(state)
        return target.relative_to(self.run_dir).as_posix()

    def append_artifact_record(self, artifact: ArtifactRecord) -> None:
        state = self.load_state()
        if state is None:
            return
        state.artifacts.append(artifact)
        self.save_state(state)

    def save_analysis_process(self, plan_id: str, data: Any) -> str:
        target = self.sessions_dir / f"{plan_id}.analysis.json"
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="analysis_stream", path_or_uri=rel, owner_refs=[plan_id])
        return rel

    def save_analysis_checkpoint(self, plan_id: str, data: Any) -> str:
        target = self.sessions_dir / f"{plan_id}.analysis.checkpoint.json"
        target.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="checkpoint", path_or_uri=rel, owner_refs=[plan_id])
        return rel

    def load_analysis_checkpoint(self, checkpoint_path: str) -> dict[str, Any] | None:
        if not checkpoint_path:
            return None
        target = self.run_dir / checkpoint_path
        if not target.exists():
            return None
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            return None

    def save_code(self, plan_id: str, code: str, attempt: int = 1) -> str:
        name = f"{plan_id}.py" if attempt == 1 else f"{plan_id}_attempt{attempt}.py"
        target = self.code_dir / name
        target.write_text(code, encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="code", path_or_uri=rel, owner_refs=[plan_id], metadata={"attempt": attempt})
        return rel

    def save_effective_code(self, plan_id: str, code: str, attempt: int = 1) -> str:
        name = (
            f"{plan_id}_effective.py"
            if attempt == 1
            else f"{plan_id}_attempt{attempt}_effective.py"
        )
        target = self.code_dir / name
        target.write_text(code, encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="code", path_or_uri=rel, owner_refs=[plan_id], metadata={"attempt": attempt, "effective": True})
        return rel

    def save_stdout(self, plan_id: str, stdout: str, attempt: int = 1) -> str | None:
        if not stdout.strip():
            return None
        target = self.stdout_dir / f"{plan_id}_attempt{attempt}.txt"
        target.write_text(stdout, encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="output", path_or_uri=rel, owner_refs=[plan_id], metadata={"attempt": attempt, "channel": "stdout"})
        return rel

    def save_stderr(self, plan_id: str, stderr: str, attempt: int = 1) -> str | None:
        if not stderr.strip():
            return None
        target = self.stderr_dir / f"{plan_id}_attempt{attempt}.txt"
        target.write_text(stderr, encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="output", path_or_uri=rel, owner_refs=[plan_id], metadata={"attempt": attempt, "channel": "stderr"})
        return rel

    def save_llm_output(
        self,
        agent_name: str,
        data: Any,
        *,
        plan_id: str | None = None,
        label: str | None = None,
        owner_refs: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        filename_parts = [self._safe_filename_part(agent_name)]
        if plan_id:
            filename_parts.append(self._safe_filename_part(plan_id))
        if label:
            filename_parts.append(self._safe_filename_part(label))
        filename_parts.extend([timestamp, uuid.uuid4().hex[:8]])
        target = self.llm_dir / ("_".join(filename_parts) + ".json")
        target.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        rel = target.relative_to(self.run_dir).as_posix()
        resolved_owner_refs = list(owner_refs or [])
        if plan_id and plan_id not in resolved_owner_refs:
            resolved_owner_refs.append(plan_id)
        artifact_metadata = dict(metadata or {})
        artifact_metadata.setdefault("agent_name", agent_name)
        if plan_id:
            artifact_metadata.setdefault("plan_id", plan_id)
        if label:
            artifact_metadata.setdefault("label", label)
        self._record_artifact(
            type="llm_output",
            path_or_uri=rel,
            owner_refs=resolved_owner_refs,
            metadata=artifact_metadata,
        )
        self.append_event(
            "llm_raw_output_saved",
            {
                "agent_name": agent_name,
                "plan_id": plan_id,
                "label": label,
                "path": rel,
            },
        )
        return rel

    def save_report(self, insight_id: str, content: str) -> str:
        target = self.reports_dir / f"report_{insight_id}.md"
        target.write_text(content, encoding="utf-8")
        rel = target.relative_to(self.run_dir).as_posix()
        self._record_artifact(type="report", path_or_uri=rel, owner_refs=[insight_id])
        return rel

    def get_report_pack_dir(self, insight_id: str) -> Path:
        target = self.report_packs_dir / insight_id
        target.mkdir(parents=True, exist_ok=True)
        return target


class RunStore(RunPersistence):
    """Backward-compatible alias over the filesystem persistence layer."""


__all__ = ["RunPersistence", "RunStore"]
