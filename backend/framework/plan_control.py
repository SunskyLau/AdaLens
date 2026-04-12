"""
Helpers for plan-level pause/resume/terminate control requests.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from runtime_clock import now_iso  # noqa: E402

from .models import PlanItem

PlanControlAction = Literal["start", "pause", "resume", "terminate"]


def _now_iso() -> str:
    return now_iso()


@dataclass
class PlanControlRequest:
    plan_id: str
    action: PlanControlAction
    timestamp: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, str]:
        return {
            "plan_id": self.plan_id,
            "action": self.action,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, object] | None) -> "PlanControlRequest | None":
        if not data:
            return None
        plan_id = str(data.get("plan_id", "")).strip()
        action = str(data.get("action", "")).strip()
        if not plan_id or action not in {"start", "pause", "resume", "terminate"}:
            return None
        return cls(
            plan_id=plan_id,
            action=action,  # type: ignore[arg-type]
            timestamp=str(data.get("timestamp", _now_iso())),
        )


def read_plan_control_requests(
    path: Path,
    *,
    start_offset: int = 0,
) -> tuple[list[PlanControlRequest], int]:
    if not path.exists():
        return [], start_offset
    with path.open("r", encoding="utf-8") as handle:
        handle.seek(start_offset)
        raw = handle.read()
        end_offset = handle.tell()
    requests: list[PlanControlRequest] = []
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        request = PlanControlRequest.from_dict(payload)
        if request is not None:
            requests.append(request)
    return requests, end_offset


def latest_requests_by_plan(
    requests: list[PlanControlRequest],
) -> dict[str, PlanControlRequest]:
    latest: dict[str, PlanControlRequest] = {}
    for request in requests:
        latest[request.plan_id] = request
    return latest


def apply_control_request_to_plan(
    plan: PlanItem,
    request: PlanControlRequest,
) -> bool:
    changed = False
    if request.action == "start":
        if plan.status == "pending":
            if plan.control_state != "none":
                plan.control_state = "none"
                changed = True
            if plan.resume_phase is None:
                plan.resume_phase = "analyzing"
                changed = True
    elif request.action == "pause":
        if plan.status == "pending":
            if plan.status != "paused":
                plan.status = "paused"
                changed = True
            if plan.resume_phase != "analyzing":
                plan.resume_phase = "analyzing"
                changed = True
            if plan.control_state != "none":
                plan.control_state = "none"
                changed = True
        elif plan.status in {"analyzing", "summarizing"}:
            if plan.control_state != "pause_requested":
                plan.control_state = "pause_requested"
                changed = True
            next_phase = "analyzing" if plan.status == "analyzing" else "summarizing"
            if plan.resume_phase != next_phase:
                plan.resume_phase = next_phase
                changed = True
    elif request.action == "resume":
        if plan.status == "paused":
            if plan.control_state != "none":
                plan.control_state = "none"
                changed = True
            if plan.resume_phase is None:
                plan.resume_phase = "analyzing"
                changed = True
    elif request.action == "terminate":
        if plan.status in {"pending", "paused"}:
            if plan.status != "terminated":
                plan.status = "terminated"
                changed = True
            if plan.control_state != "none":
                plan.control_state = "none"
                changed = True
        elif plan.status in {"analyzing", "summarizing"}:
            if plan.control_state != "terminate_requested":
                plan.control_state = "terminate_requested"
                changed = True
    if changed:
        plan.updated_at = _now_iso()
    return changed
