from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import (
    ExecutionControlRequest,
    SteeringRequest,
    UserMessage,
    normalize_steering_message_kind,
)


def read_jsonl_since(file_path: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    if not file_path.exists():
        return [], offset
    entries: list[dict[str, Any]] = []
    current_offset = offset
    with file_path.open("r", encoding="utf-8") as handle:
        handle.seek(offset)
        while True:
            line = handle.readline()
            if not line:
                break
            current_offset = handle.tell()
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except Exception:
                continue
            if isinstance(payload, dict):
                entries.append(payload)
    return entries, current_offset


def map_user_message_to_runtime_input(message: UserMessage) -> SteeringRequest | ExecutionControlRequest | UserMessage:
    kind = normalize_steering_message_kind(message.kind) or "chat"
    if (
        kind in {"focus", "ignore", "elaborate"}
        and message.target is not None
        and (
            kind in {"focus", "ignore"}
            or message.target.kind in {"summary", "atomic"}
        )
    ):
        return SteeringRequest(
            steering_id=f"steer_{message.message_id}",
            kind=kind,  # type: ignore[arg-type]
            source="user",
            timestamp=message.timestamp,
            target=message.target,
            selected_keywords=list(message.selected_keywords),
            display_text=message.display_text or "",
        )
    if kind == "create":
        return ExecutionControlRequest(
            control_id=f"control_{message.message_id}",
            action="create",
            source="user",
            timestamp=message.timestamp,
            user_authored_text=message.content,
            display_text=message.display_text or "",
        )
    return message


def map_plan_control_payload(payload: dict[str, Any]) -> ExecutionControlRequest | None:
    action = str(payload.get("action", "") or "").strip().lower()
    mapped_action = {
        "pause": "pause",
        "terminate": "terminate",
        "modify": "modify",
        "launch": "launch",
        "create": "create",
    }.get(action)
    if mapped_action is None:
        return None
    return ExecutionControlRequest(
        control_id=f"control_{payload.get('timestamp', '')}_{payload.get('plan_id', '')}",
        action=mapped_action,  # type: ignore[arg-type]
        source="gateway",
        timestamp=str(payload.get("timestamp", "") or ""),
        target_plan_id=str(payload.get("plan_id", "") or "").strip() or None,
        user_authored_text=str(payload.get("user_authored_text", "") or "").strip() or None,
        display_text=str(payload.get("display_text", "") or "").strip(),
    )
