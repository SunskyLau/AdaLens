"""
Helpers for runtime control requests written by the gateway.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from runtime_clock import now_iso  # noqa: E402

from .models import clamp_max_concurrency

RuntimeControlAction = Literal["update_settings", "reorder_latest_batch"]


def _now_iso() -> str:
    return now_iso()


@dataclass
class RuntimeControlRequest:
    action: RuntimeControlAction
    timestamp: str = field(default_factory=_now_iso)
    max_concurrency: int | None = None
    dispatch_turn_index: int | None = None
    plan_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RuntimeControlRequest | None":
        if not data:
            return None
        action = str(data.get("action", "")).strip()
        timestamp = str(data.get("timestamp", _now_iso()))
        if action == "update_settings":
            return cls(
                action="update_settings",
                timestamp=timestamp,
                max_concurrency=clamp_max_concurrency(
                    data.get("default_sub_agents_num", data.get("max_concurrency"))
                ),
            )
        if action == "reorder_latest_batch":
            raw_plan_ids = data.get("plan_ids", []) or []
            if not isinstance(raw_plan_ids, list):
                raw_plan_ids = []
            plan_ids: list[str] = []
            seen: set[str] = set()
            for item in raw_plan_ids:
                plan_id = str(item or "").strip()
                if not plan_id or plan_id in seen:
                    continue
                seen.add(plan_id)
                plan_ids.append(plan_id)
            raw_dispatch_turn_index = data.get("dispatch_turn_index")
            dispatch_turn_index = None
            if raw_dispatch_turn_index is not None:
                try:
                    dispatch_turn_index = int(raw_dispatch_turn_index)
                except (TypeError, ValueError):
                    dispatch_turn_index = None
            return cls(
                action="reorder_latest_batch",
                timestamp=timestamp,
                dispatch_turn_index=dispatch_turn_index,
                plan_ids=plan_ids,
            )
        return None


def read_runtime_control_requests(
    path: Path,
    *,
    start_offset: int = 0,
) -> tuple[list[RuntimeControlRequest], int]:
    if not path.exists():
        return [], start_offset
    with path.open("r", encoding="utf-8") as handle:
        handle.seek(start_offset)
        raw = handle.read()
        end_offset = handle.tell()
    requests: list[RuntimeControlRequest] = []
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
        request = RuntimeControlRequest.from_dict(payload)
        if request is not None:
            requests.append(request)
    return requests, end_offset
