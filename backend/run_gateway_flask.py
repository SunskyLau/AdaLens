from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO, TypeGuard
from uuid import uuid4

from flask import Flask, Response, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

try:
    from flask_cors import CORS  # pyright: ignore[reportMissingModuleSource]
except ModuleNotFoundError:  # pragma: no cover
    CORS = None  # type: ignore[assignment]


# ============================================================================
# Shared constants (mirrors frontend/src/config.ts + src/server helpers)
# ============================================================================

RUN_GATEWAY_PORT = 3001
DATA_CONTRACT_VERSION = "v1.13"

DATA_VIEW_PREVIEW_ROWS = 30
DATA_VIEW_MAX_ROWS = 200
DATA_VIEW_MAX_FILE_BYTES = 8 * 1024 * 1024

DATASET_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
DATASET_UPLOAD_FIELD_NAME = "file"
DATASET_UPLOAD_SUBDIR = "_uploads"

MAX_CONCURRENCY_MIN = 1
MAX_CONCURRENCY_MAX = 6

STABLE_LLM_OUTPUT_ENV = "AGENTIC_EDA_STABLE_LLM_OUTPUT"
CREATE_PLANS_REPLAY_ENV = "AGENTIC_EDA_CREATE_PLANS_REPLAY"
RUN_GATEWAY_PROTECT_INTERRUPTS_ENV = "RUN_GATEWAY_PROTECT_INTERRUPTS"
RUN_GATEWAY_INTERRUPT_EXIT_WINDOW_SECONDS = 1.5

ENDED_SESSION_ERROR = "The analysis session has ended. Please start a new conversation."

CSV_DELIMITER_CANDIDATES = [",", ";", "\t", "|"]
CSV_DELIMITER_FALLBACK = ","
CSV_MIME_TYPES = {"", "text/csv", "application/csv", "application/vnd.ms-excel"}

RUN_ID_PATTERN = re.compile(r"run_\d{8}_\d{6}_[0-9a-f]{6}", re.IGNORECASE)
RUN_CONTROL_STOP_FILE = "STOP"
RESUME_RESETTABLE_RUN_STATUSES = {"completed", "stopped", "failed"}
CJK_TERMINAL_PUNCTUATION_WITH_DOT_PATTERN = re.compile(r"([。！？])\s*\.+")


# ============================================================================
# Paths
# ============================================================================

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
RUNS_DIR = BACKEND_DIR / "runs"
DATASET_UPLOADS_DIR = RUNS_DIR / DATASET_UPLOAD_SUBDIR


# ============================================================================
# App and process globals
# ============================================================================

app = Flask(__name__)
if CORS is not None:
    CORS(app)
app.config["MAX_CONTENT_LENGTH"] = DATASET_UPLOAD_MAX_BYTES


@app.after_request
def add_default_cors_headers(response: Response) -> Response:
    response.headers.setdefault("Access-Control-Allow-Origin", "*")
    response.headers.setdefault("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
    response.headers.setdefault("Access-Control-Allow-Headers", "Content-Type,Authorization")
    return response

running_processes: dict[str, subprocess.Popen[str]] = {}
running_processes_lock = threading.Lock()


# ============================================================================
# Utility helpers
# ============================================================================


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def is_record(value: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def normalize_cjk_terminal_punctuation(text: str | None) -> str:
    raw = text if isinstance(text, str) else ""
    if not raw:
        return ""
    return CJK_TERMINAL_PUNCTUATION_WITH_DOT_PATTERN.sub(r"\1", raw)


def normalize_target_columns(raw_columns: Any) -> list[str]:
    if not isinstance(raw_columns, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_column in raw_columns:
        column = str(raw_column or "").strip()
        if not column or column in seen:
            continue
        seen.add(column)
        normalized.append(column)
    return normalized


def normalize_keywords(raw_keywords: Any, limit: int = 10) -> list[str]:
    if not isinstance(raw_keywords, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_keyword in raw_keywords:
        keyword = str(raw_keyword or "").strip()
        if not keyword:
            continue
        lookup_key = keyword.lower()
        if lookup_key in seen:
            continue
        seen.add(lookup_key)
        normalized.append(keyword)
        if len(normalized) >= limit:
            break
    return normalized


def clamp_max_concurrency(value: Any) -> int:
    parsed: int
    if isinstance(value, (int, float)):
        try:
            parsed = int(value)
        except Exception:
            parsed = 2
    else:
        try:
            parsed = int(str(value or "").strip())
        except Exception:
            parsed = 2
    return max(MAX_CONCURRENCY_MIN, min(MAX_CONCURRENCY_MAX, parsed))


def normalize_settings_record(settings: Any) -> dict[str, Any] | None:
    if not is_record(settings):
        return None
    normalized_default_sub_agents_num = clamp_max_concurrency(
        settings.get("default_sub_agents_num", settings.get("max_concurrency"))
    )
    normalized = dict(settings)
    normalized["default_sub_agents_num"] = normalized_default_sub_agents_num
    return normalized


def normalize_target_column_anchors(
    value: Any,
    allowed_columns: list[str],
) -> list[dict[str, int | str]]:
    if not isinstance(value, list):
        return []
    allowed_column_set = set(allowed_columns)
    allow_any_column = len(allowed_column_set) == 0
    normalized: list[dict[str, int | str]] = []
    seen_columns: set[str] = set()
    for item in value:
        if not is_record(item):
            continue
        column = str(item.get("column", "")).strip()
        converge_index_raw = item.get("converge_index")
        if isinstance(converge_index_raw, bool):
            continue
        if isinstance(converge_index_raw, int):
            converge_index = converge_index_raw
        elif isinstance(converge_index_raw, float):
            if not converge_index_raw.is_integer():
                continue
            converge_index = int(converge_index_raw)
        elif isinstance(converge_index_raw, str):
            try:
                converge_index = int(converge_index_raw)
            except Exception:
                continue
        else:
            continue
        if (
            not column
            or column in seen_columns
            or (not allow_any_column and column not in allowed_column_set)
            or converge_index < 0
        ):
            continue
        seen_columns.add(column)
        normalized.append({"column": column, "converge_index": converge_index})
    return normalized


def normalize_steering_target_snapshot(target: Any) -> dict[str, Any] | None:
    if target is None:
        return None
    if not is_record(target):
        return None

    kind_raw = target.get("kind")
    kind = kind_raw if kind_raw in {"atomic", "column"} else "summary"
    explicit_columns = normalize_target_columns(target.get("columns"))
    anchor_columns = [
        str(anchor.get("column"))
        for anchor in normalize_target_column_anchors(target.get("column_anchors"), [])
    ]
    columns = explicit_columns if explicit_columns else anchor_columns
    base: dict[str, Any] = {
        "kind": kind,
        "summary_id": str(target.get("summary_id", "")) if target.get("summary_id") is not None else "",
        "summary_short_label": (
            str(target.get("summary_short_label", ""))
            if target.get("summary_short_label") is not None
            else ""
        ),
        "summary_text": normalize_cjk_terminal_punctuation(
            str(target.get("summary_text", "")) if target.get("summary_text") is not None else ""
        ),
        "columns": columns,
    }
    if kind == "column":
        legacy_column_name = str(target.get("column_name", "")).strip()
        normalized_columns = columns if columns else ([legacy_column_name] if legacy_column_name else [])
        column_anchors = normalize_target_column_anchors(
            target.get("column_anchors"),
            normalized_columns,
        )
        result: dict[str, Any] = {**base, "columns": normalized_columns}
        if column_anchors:
            result["column_anchors"] = column_anchors
        return result
    if kind == "atomic":
        result = dict(base)
        if target.get("atomic_id") is not None:
            result["atomic_id"] = str(target.get("atomic_id", ""))
        if target.get("atomic_text") is not None:
            result["atomic_text"] = normalize_cjk_terminal_punctuation(
                str(target.get("atomic_text", ""))
            )
        if target.get("insight_type") is not None:
            result["insight_type"] = str(target.get("insight_type", ""))
        return result
    return base


def count_atomic_insights(summary_nodes: list[dict[str, Any]]) -> int:
    total = 0
    for summary_node in summary_nodes:
        atomics = summary_node.get("atomic_insights")
        if isinstance(atomics, list):
            total += len(atomics)
    return total


def detect_legacy_state(state: dict[str, Any]) -> dict[str, Any]:
    settings = state.get("settings")
    if not is_record(settings):
        return {"is_legacy": True, "contract_version": "legacy", "reason": "missing settings"}

    default_sub_agents_num = settings.get("default_sub_agents_num", settings.get("max_concurrency"))
    if not isinstance(default_sub_agents_num, (int, float)):
        return {
            "is_legacy": True,
            "contract_version": "legacy",
            "reason": "missing settings.default_sub_agents_num",
        }

    plans = state.get("plans") if isinstance(state.get("plans"), list) else state.get("frontier")
    if not isinstance(plans, list):
        return {
            "is_legacy": True,
            "contract_version": "legacy",
            "reason": "missing plans/frontier",
        }

    for item in plans:
        if not is_record(item):
            continue
        kind = item.get("kind")
        if isinstance(kind, str) and kind != "analysis":
            return {
                "is_legacy": True,
                "contract_version": "legacy",
                "reason": f"unsupported PlanItem.kind={kind}",
            }
        if "filters" not in item:
            return {
                "is_legacy": True,
                "contract_version": "legacy",
                "reason": "missing PlanItem.filters",
            }
        if "status" not in item:
            return {
                "is_legacy": True,
                "contract_version": "legacy",
                "reason": "missing PlanItem.status",
            }

    insights = state.get("insights")
    if not isinstance(insights, list):
        return {"is_legacy": True, "contract_version": "legacy", "reason": "missing insights"}

    for insight in insights:
        if not is_record(insight):
            return {
                "is_legacy": True,
                "contract_version": "legacy",
                "reason": "invalid summary object",
            }
        if not isinstance(insight.get("summary"), str):
            return {"is_legacy": True, "contract_version": "legacy", "reason": "missing summary"}
        atomics = insight.get("atomic_insights")
        if not isinstance(atomics, list):
            return {
                "is_legacy": True,
                "contract_version": "legacy",
                "reason": "missing summary atomic_insights",
            }
        for atomic in atomics:
            if not is_record(atomic):
                return {
                    "is_legacy": True,
                    "contract_version": "legacy",
                    "reason": "invalid AtomicInsight object",
                }
            if not isinstance(atomic.get("insight_type"), str):
                return {
                    "is_legacy": True,
                    "contract_version": "legacy",
                    "reason": "missing AtomicInsight.insight_type",
                }
            if not isinstance(atomic.get("columns"), list):
                return {
                    "is_legacy": True,
                    "contract_version": "legacy",
                    "reason": "missing AtomicInsight.columns",
                }
            evidence = atomic.get("evidence")
            if not is_record(evidence) or "plot_path" not in evidence:
                return {
                    "is_legacy": True,
                    "contract_version": "legacy",
                    "reason": "missing AtomicInsight.evidence.plot_path",
                }

    return {"is_legacy": False, "contract_version": DATA_CONTRACT_VERSION}


def get_run_dirs() -> list[str]:
    try:
        entries = [entry for entry in RUNS_DIR.iterdir() if entry.is_dir() and entry.name.startswith("run_")]
    except Exception:
        return []
    return sorted([entry.name for entry in entries], reverse=True)


def read_json_file(file_path: Path) -> Any:
    return json.loads(file_path.read_text(encoding="utf-8"))


def normalize_state_for_client(state: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(state)

    if not isinstance(normalized.get("frontier"), list) and isinstance(normalized.get("plans"), list):
        normalized["frontier"] = normalized.get("plans")

    if isinstance(normalized.get("final_summary"), str):
        normalized["final_summary"] = normalize_cjk_terminal_punctuation(normalized["final_summary"])

    frontier = normalized.get("frontier")
    if isinstance(frontier, list):
        updated_frontier: list[Any] = []
        for item in frontier:
            if not is_record(item):
                updated_frontier.append(item)
                continue
            next_item = dict(item)
            if isinstance(next_item.get("final_summary"), str):
                next_item["final_summary"] = normalize_cjk_terminal_punctuation(next_item["final_summary"])
            updated_frontier.append(next_item)
        normalized["frontier"] = updated_frontier

    if isinstance(normalized.get("insights"), list):
        updated_insights: list[Any] = []
        for insight in normalized["insights"]:
            if not is_record(insight):
                updated_insights.append(insight)
                continue
            next_insight = dict(insight)
            atomic_insights = next_insight.get("atomic_insights")
            if isinstance(atomic_insights, list):
                updated_atomics: list[Any] = []
                for atomic in atomic_insights:
                    if not is_record(atomic):
                        updated_atomics.append(atomic)
                        continue
                    next_atomic = dict(atomic)
                    if isinstance(next_atomic.get("text"), str):
                        next_atomic["text"] = normalize_cjk_terminal_punctuation(next_atomic["text"])
                    updated_atomics.append(next_atomic)
                next_insight["atomic_insights"] = updated_atomics
            if isinstance(next_insight.get("summary"), str):
                next_insight["summary"] = normalize_cjk_terminal_punctuation(next_insight["summary"])
            parent_insight_id = next_insight.get("parent_insight_id")
            if not isinstance(parent_insight_id, str):
                lineage = next_insight.get("parent_lineage_refs")
                if isinstance(lineage, list) and lineage and isinstance(lineage[0], str):
                    next_insight["parent_insight_id"] = lineage[0]
            updated_insights.append(next_insight)
        normalized["insights"] = updated_insights

    if isinstance(normalized.get("user_messages"), list):
        updated_messages: list[Any] = []
        for message in normalized["user_messages"]:
            if not is_record(message):
                updated_messages.append(message)
                continue
            next_message = dict(message)
            next_message["target"] = normalize_steering_target_snapshot(next_message.get("target"))
            updated_messages.append(next_message)
        normalized["user_messages"] = updated_messages

    normalized_settings = normalize_settings_record(normalized.get("settings"))
    if normalized_settings is not None:
        normalized["settings"] = normalized_settings
    return normalized


def read_run_state(run_id: str) -> dict[str, Any] | None:
    state_path = RUNS_DIR / run_id / "state.json"
    try:
        state = read_json_file(state_path)
    except Exception:
        return None
    if not is_record(state):
        return None
    normalized_state = normalize_state_for_client(state)
    plan_controls_path = RUNS_DIR / run_id / "plan_controls.jsonl"
    control_payloads: list[Any] = []
    try:
        control_payloads = read_jsonl_file(plan_controls_path)
    except Exception:
        control_payloads = []
    return apply_pending_plan_control_previews(
        state=normalized_state,
        control_payloads=control_payloads,
    )


def read_jsonl_file(file_path: Path) -> list[Any]:
    events: list[Any] = []
    content = file_path.read_text(encoding="utf-8")
    for line in content.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            events.append(json.loads(trimmed))
        except Exception:
            continue
    return events


def read_text_file(file_path: Path) -> str:
    return file_path.read_text(encoding="utf-8")


def create_user_steer_message(
    content: str,
    *,
    kind: str | None = None,
    display_text: str | None = None,
    generated_prompt: str | None = None,
    user_prompt: str | None = None,
    system_prompt: str | None = None,
    selected_keywords: list[str] | None = None,
    target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "message_id": f"msg_{uuid4().hex[:8]}",
        "timestamp": now_iso(),
        "content": content,
    }
    if kind is not None:
        message["kind"] = kind
    if display_text is not None:
        message["display_text"] = display_text
    if generated_prompt is not None:
        message["generated_prompt"] = generated_prompt
    if user_prompt is not None:
        message["user_prompt"] = user_prompt
    if system_prompt is not None:
        message["system_prompt"] = system_prompt
    if selected_keywords:
        message["selected_keywords"] = selected_keywords
    if target is not None or "target" in message:
        message["target"] = target
    return message


def normalize_steering_kind(kind: Any) -> str:
    if kind == "dive_into":
        return "focus"
    if kind in {"cut_off", "suppress"}:
        return "ignore"
    if kind in {"chat", "focus", "ignore", "elaborate", "create"}:
        return str(kind)
    return "chat"


def append_jsonl_line(file_path: Path, payload: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with file_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def write_run_state(run_id: str, state: dict[str, Any]) -> None:
    state_path = RUNS_DIR / run_id / "state.json"
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def clear_run_stop_file(run_id: str) -> None:
    stop_path = RUNS_DIR / run_id / RUN_CONTROL_STOP_FILE
    try:
        stop_path.unlink(missing_ok=True)
    except Exception:
        return


def prepare_state_for_resume_input(state: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    changed = False
    status = str(state.get("status", "") or "").strip()
    if status in RESUME_RESETTABLE_RUN_STATUSES:
        state["status"] = "running"
        changed = True

    final_summary = state.get("final_summary")
    if isinstance(final_summary, str) and final_summary.strip():
        state["final_summary"] = ""
        changed = True

    master_agent_state = state.get("master_agent_state")
    if is_record(master_agent_state):
        next_master_agent_state = dict(master_agent_state)
        master_changed = False
        if bool(next_master_agent_state.get("completed")):
            next_master_agent_state["completed"] = False
            master_changed = True
        pending_stop_completion_message_id = next_master_agent_state.get("pending_stop_completion_message_id")
        if (
            isinstance(pending_stop_completion_message_id, str)
            and pending_stop_completion_message_id.strip()
        ):
            next_master_agent_state["pending_stop_completion_message_id"] = None
            master_changed = True
        if master_changed:
            state["master_agent_state"] = next_master_agent_state
            changed = True

    if changed:
        state["updated_at"] = now_iso()
    return state, changed


# ============================================================================
# Plan control helpers (ported from frontend/src/server/planControl.ts)
# ============================================================================


def is_nonterminal_plan_status(status: str) -> bool:
    return status in {"pending", "paused", "analyzing", "summarizing"}


def apply_plan_control_to_plan_record(plan: dict[str, Any], action: str) -> dict[str, bool]:
    status = str(plan.get("status", "pending"))
    if action == "pause":
        return {"allowed": status in {"pending", "analyzing", "summarizing"}, "changed": False}
    if action == "launch":
        return {"allowed": status in {"paused", "pending"}, "changed": False}
    if action == "modify":
        return {"allowed": status in {"pending", "paused", "analyzing", "summarizing"}, "changed": False}
    return {"allowed": status in {"pending", "paused", "analyzing", "summarizing"}, "changed": False}


def should_ensure_run_process_for_plan_control(plan: dict[str, Any], action: str) -> bool:
    status = str(plan.get("status", "pending"))
    if not is_nonterminal_plan_status(status):
        return False
    return action in {"launch", "pause", "terminate", "modify"}


def build_plan_control_request_id(plan_id: str, timestamp: str) -> str:
    return f"control_{timestamp}_{plan_id}"


def parse_plan_control_request_record(value: Any) -> dict[str, str] | None:
    if not is_record(value):
        return None
    plan_id = str(value.get("plan_id", "") or "").strip()
    action = str(value.get("action", "") or "").strip()
    timestamp = str(value.get("timestamp", "") or "").strip()
    if not plan_id or not timestamp:
        return None
    if action not in {"launch", "pause", "modify", "terminate"}:
        return None
    request_record: dict[str, str] = {
        "plan_id": plan_id,
        "action": action,
        "timestamp": timestamp,
    }
    user_authored_text = value.get("user_authored_text")
    if isinstance(user_authored_text, str):
        request_record["user_authored_text"] = user_authored_text
    return request_record


def apply_pending_plan_control_previews(
    state: dict[str, Any],
    control_payloads: list[Any],
) -> dict[str, Any]:
    next_state = deepcopy(state)
    frontier = next_state.get("frontier")
    plans = frontier if isinstance(frontier, list) else next_state.get("plans")
    if not isinstance(plans, list):
        return next_state

    applied_control_ids: set[str] = set()
    execution_control_state = next_state.get("execution_control_state")
    if is_record(execution_control_state):
        raw_applied_control_ids = execution_control_state.get("applied_control_ids")
        if isinstance(raw_applied_control_ids, list):
            for raw_control_id in raw_applied_control_ids:
                control_id = str(raw_control_id or "").strip()
                if control_id:
                    applied_control_ids.add(control_id)

    next_plans: list[dict[str, Any]] = []
    for raw_plan in plans:
        if not is_record(raw_plan):
            continue
        normalized_plan = normalize_plan_record(raw_plan)
        next_plans.append(normalized_plan)

    plan_index_by_id: dict[str, int] = {}
    for index, plan in enumerate(next_plans):
        plan_id = str(plan.get("plan_id", "") or "").strip()
        if plan_id:
            plan_index_by_id[plan_id] = index
        raw_linked_control_ids = plan.get("linked_control_ids")
        if isinstance(raw_linked_control_ids, list):
            for raw_control_id in raw_linked_control_ids:
                control_id = str(raw_control_id or "").strip()
                if control_id:
                    applied_control_ids.add(control_id)

    for raw_payload in control_payloads:
        request_record = parse_plan_control_request_record(raw_payload)
        if request_record is None:
            continue
        control_id = build_plan_control_request_id(
            request_record["plan_id"],
            request_record["timestamp"],
        )
        if control_id in applied_control_ids:
            continue
        plan_index = plan_index_by_id.get(request_record["plan_id"])
        if plan_index is None:
            continue
        existing_plan = next_plans[plan_index]
        next_plan = apply_plan_control_preview_to_plan_record(
            plan=existing_plan,
            action=request_record["action"],
            user_authored_text=request_record.get("user_authored_text"),
        )
        raw_linked_control_ids = next_plan.get("linked_control_ids")
        linked_control_ids = (
            [str(item) for item in raw_linked_control_ids if str(item)]
            if isinstance(raw_linked_control_ids, list)
            else []
        )
        if control_id not in linked_control_ids:
            linked_control_ids.append(control_id)
        next_plan["linked_control_ids"] = linked_control_ids
        next_plans[plan_index] = next_plan
        applied_control_ids.add(control_id)

    if isinstance(frontier, list):
        next_state["frontier"] = next_plans
    if isinstance(next_state.get("plans"), list):
        next_state["plans"] = next_plans
    return next_state


def normalize_plan_text(text: Any) -> str:
    return str(text or "").strip()


def apply_confirmed_modification_preview(plan: dict[str, Any], next_text: str) -> dict[str, Any]:
    normalized_current = normalize_plan_text(plan.get("text"))
    normalized_next = normalize_plan_text(next_text)
    next_plan = dict(plan)
    next_plan["pending_modified_text"] = None
    next_plan["status"] = "pending"
    next_plan["control_state"] = "none"
    next_plan["launch_requested"] = True
    if normalized_next == normalized_current:
        return next_plan
    next_plan["text"] = next_text
    next_plan["resume_phase"] = None
    next_plan["checkpoint_path"] = None
    revision = plan.get("revision")
    if isinstance(revision, (int, float)):
        next_plan["revision"] = int(revision) + 1
    else:
        next_plan["revision"] = 2
    next_plan["final_summary"] = None
    next_plan["error_message"] = None
    return next_plan


def apply_plan_control_preview_to_plan_record(
    plan: dict[str, Any],
    action: str,
    user_authored_text: str | None = None,
) -> dict[str, Any]:
    next_plan = dict(plan)
    next_text = normalize_plan_text(user_authored_text)
    status = str(next_plan.get("status", "pending"))

    if action == "pause":
        next_plan["launch_requested"] = False
        if status == "pending":
            next_plan["status"] = "paused"
            next_plan["control_state"] = "none"
            return next_plan
        if status in {"analyzing", "summarizing"}:
            next_plan["control_state"] = "pause_requested"
        return next_plan

    if action == "launch":
        next_plan["status"] = "pending"
        next_plan["control_state"] = "none"
        next_plan["launch_requested"] = True
        if next_plan.get("resume_phase") not in {"analyzing", "summarizing"}:
            next_plan["resume_phase"] = None
        return next_plan

    if action == "terminate":
        next_plan["launch_requested"] = False
        if status in {"pending", "paused"}:
            next_plan["status"] = "terminated"
            next_plan["control_state"] = "none"
            return next_plan
        if status in {"analyzing", "summarizing"}:
            next_plan["control_state"] = "terminate_requested"
        return next_plan

    if action == "modify":
        if status in {"analyzing", "summarizing"}:
            if next_text:
                next_plan["pending_modified_text"] = next_text
            next_plan["control_state"] = "pause_requested"
            next_plan["launch_requested"] = False
            return next_plan
        if next_text:
            return apply_confirmed_modification_preview(next_plan, next_text)

    return next_plan


def build_plan_control_response(
    plan: dict[str, Any],
    action: str,
    persisted_run_status: str,
    user_authored_text: str | None = None,
) -> dict[str, Any]:
    preview_plan = apply_plan_control_preview_to_plan_record(
        plan=plan,
        action=action,
        user_authored_text=user_authored_text,
    )
    return {"plan": preview_plan, "runStatus": persisted_run_status, "emitPlanStatusChanged": False}


def normalize_plan_record(plan: dict[str, Any]) -> dict[str, Any]:
    normalized_control_state: str
    if plan.get("control_state") == "yield_requested":
        normalized_control_state = "pause_requested"
    elif isinstance(plan.get("control_state"), str):
        normalized_control_state = str(plan.get("control_state"))
    else:
        normalized_control_state = "none"

    normalized = dict(plan)
    normalized["control_state"] = normalized_control_state
    normalized["launch_requested"] = bool(plan.get("launch_requested"))
    normalized["resume_phase"] = (
        plan.get("resume_phase") if plan.get("resume_phase") in {"analyzing", "summarizing"} else None
    )
    normalized["checkpoint_path"] = (
        str(plan.get("checkpoint_path")) if isinstance(plan.get("checkpoint_path"), str) else None
    )
    normalized["pending_modified_text"] = (
        str(plan.get("pending_modified_text"))
        if isinstance(plan.get("pending_modified_text"), str)
        else None
    )
    return normalized


def get_state_plans(state: dict[str, Any]) -> list[dict[str, Any]]:
    frontier = state.get("frontier")
    if isinstance(frontier, list):
        return [normalize_plan_record(item) for item in frontier if is_record(item)]
    plans = state.get("plans")
    if not isinstance(plans, list):
        return []
    return [normalize_plan_record(item) for item in plans if is_record(item)]


def is_plan_control_action(value: Any) -> bool:
    return value in {"launch", "pause", "modify", "terminate"}


# ============================================================================
# Dataset helpers
# ============================================================================


def is_csv_upload_filename(filename: str) -> bool:
    return Path(filename).suffix.lower() == ".csv"


def is_allowed_csv_mime_type(mime_type: str | None) -> bool:
    return (mime_type or "").strip().lower() in CSV_MIME_TYPES


def sanitize_uploaded_csv_filename(filename: str) -> str:
    basename = Path(filename).name.replace("\x00", "")
    ext = Path(basename).suffix.lower()
    if ext != ".csv":
        raise ValueError("Only CSV files are supported")
    stem = Path(basename).stem
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("_") or "dataset"
    return f"{safe_stem}.csv"


def build_uploaded_dataset_filename(original_filename: str, unique_id: str) -> str:
    safe_filename = sanitize_uploaded_csv_filename(original_filename)
    return f"upload_{unique_id}__{safe_filename}"


def append_candidate(candidates: list[Path], seen: set[Path], value: Path) -> None:
    resolved = value.resolve()
    if resolved in seen:
        return
    seen.add(resolved)
    candidates.append(resolved)


def resolve_dataset_path_from_state(raw_path: str, repo_root: Path) -> Path:
    trimmed = raw_path.strip()
    if not trimmed:
        return Path()

    candidates: list[Path] = []
    seen: set[Path] = set()

    source_path = Path(trimmed)
    absolute_path = source_path if source_path.is_absolute() else (repo_root / source_path)
    append_candidate(candidates, seen, absolute_path)

    normalized = trimmed.replace("\\", "/")
    segments = [segment for segment in normalized.split("/") if segment]
    lower_segments = [segment.lower() for segment in segments]
    try:
        data_index = len(lower_segments) - 1 - lower_segments[::-1].index("data")
    except ValueError:
        data_index = -1
    if 0 <= data_index < len(segments) - 1:
        append_candidate(candidates, seen, repo_root / "data" / Path(*segments[data_index + 1 :]))

    append_candidate(candidates, seen, repo_root / "data" / Path(trimmed).name)

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return absolute_path.resolve()


def normalize_csv_delimiter(value: Any) -> str | None:
    if isinstance(value, str) and value in CSV_DELIMITER_CANDIDATES:
        return value
    return None


def count_delimiters_outside_quotes(text: str, delimiter: str) -> list[int]:
    counts: list[int] = []
    in_quotes = False
    count = 0
    index = 0
    while index < len(text):
        ch = text[index]
        if ch == '"':
            next_char = text[index + 1] if index + 1 < len(text) else ""
            if in_quotes and next_char == '"':
                index += 2
                continue
            in_quotes = not in_quotes
            index += 1
            continue
        if not in_quotes and ch == delimiter:
            count += 1
            index += 1
            continue
        if not in_quotes and ch in {"\n", "\r"}:
            if count > 0:
                counts.append(count)
            count = 0
            if ch == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
                index += 2
            else:
                index += 1
            continue
        index += 1

    if count > 0:
        counts.append(count)
    return counts


def sniff_csv_delimiter(text: str) -> str:
    sample = text[:16384]
    if not sample.strip():
        return CSV_DELIMITER_FALLBACK

    best_delimiter = CSV_DELIMITER_FALLBACK
    best_score = (-1, -1, -1)
    for delimiter in CSV_DELIMITER_CANDIDATES:
        counts = count_delimiters_outside_quotes(sample, delimiter)
        if not counts:
            continue
        histogram: dict[int, int] = {}
        for count in counts:
            histogram[count] = histogram.get(count, 0) + 1
        dominant_count = max(histogram.values()) if histogram else 0
        score = (dominant_count, len(counts), sum(counts))
        if (
            score[0] > best_score[0]
            or (score[0] == best_score[0] and score[1] > best_score[1])
            or (score[0] == best_score[0] and score[1] == best_score[1] and score[2] > best_score[2])
        ):
            best_delimiter = delimiter
            best_score = score

    return best_delimiter


def parse_csv_records(text: str, delimiter: str) -> list[list[str]]:
    rows: list[list[str]] = []
    row: list[str] = []
    field = ""
    in_quotes = False
    index = 0

    def push_field() -> None:
        nonlocal field, row
        row.append(field)
        field = ""

    def push_row() -> None:
        nonlocal row, rows
        rows.append(row)
        row = []

    while index < len(text):
        ch = text[index]
        if in_quotes:
            if ch == '"':
                next_char = text[index + 1] if index + 1 < len(text) else ""
                if next_char == '"':
                    field += '"'
                    index += 2
                    continue
                in_quotes = False
                index += 1
                continue
            field += ch
            index += 1
            continue

        if ch == '"':
            in_quotes = True
            index += 1
            continue
        if ch == delimiter:
            push_field()
            index += 1
            continue
        if ch == "\n":
            push_field()
            push_row()
            index += 1
            continue
        if ch == "\r":
            if index + 1 < len(text) and text[index + 1] == "\n":
                index += 1
            push_field()
            push_row()
            index += 1
            continue
        field += ch
        index += 1

    if field or row:
        push_field()
        push_row()

    while rows:
        last = rows[-1]
        if len(last) == 1 and last[0] == "":
            rows.pop()
            continue
        break
    return rows


def build_csv_preview(text: str, row_limit: int, row_offset: int, delimiter: str) -> dict[str, Any]:
    records = parse_csv_records(text, delimiter)
    if not records:
        return {
            "delimiter": delimiter,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "offset": 0,
            "returned_rows": 0,
            "has_more": False,
        }

    header = records[0]
    data_rows = records[1:]
    max_cols = max([len(header)] + [len(row) for row in data_rows]) if data_rows else len(header)
    column_count = max(1, max_cols)

    columns: list[str] = []
    for idx in range(column_count):
        raw = header[idx] if idx < len(header) else ""
        normalized = raw.replace("\ufeff", "", 1) if isinstance(raw, str) and idx == 0 else raw
        if isinstance(normalized, str) and normalized.strip():
            columns.append(normalized)
        else:
            columns.append(f"col_{idx + 1}")

    normalized_rows = [
        [row[idx] if idx < len(row) else "" for idx in range(column_count)]
        for row in data_rows
    ]
    safe_offset = min(max(row_offset, 0), len(normalized_rows))
    rows = normalized_rows[safe_offset : safe_offset + row_limit]

    return {
        "delimiter": delimiter,
        "columns": columns,
        "rows": rows,
        "row_count": len(normalized_rows),
        "offset": safe_offset,
        "returned_rows": len(rows),
        "has_more": safe_offset + len(rows) < len(normalized_rows),
    }


# ============================================================================
# Process management helpers
# ============================================================================


def with_backend_launch_env(base_env: dict[str, str], *, stable_llm_output: bool = False) -> dict[str, str]:
    env = dict(base_env)
    env.pop(STABLE_LLM_OUTPUT_ENV, None)
    if stable_llm_output:
        env[STABLE_LLM_OUTPUT_ENV] = "1"
    return env


def is_stable_llm_output_enabled(base_env: dict[str, str] | None = None) -> bool:
    env = base_env if base_env is not None else dict(os.environ)
    return str(env.get(STABLE_LLM_OUTPUT_ENV, "")).strip() == "1"


def build_backend_process_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = with_backend_launch_env(
        base_env if base_env is not None else dict(os.environ),
        stable_llm_output=is_stable_llm_output_enabled(base_env),
    )
    env["PYTHONUNBUFFERED"] = "1"
    return env


def build_cli_subprocess_group_options() -> dict[str, Any]:
    if os.name == "nt":
        return {
            "creationflags": int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)),
        }
    return {"start_new_session": True}


def get_run_process_state_path(run_id: str) -> Path:
    return RUNS_DIR / run_id / ".run-process.json"


def is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return False


def persist_run_process_state(run_id: str, process: subprocess.Popen[str]) -> None:
    if process.pid is None or process.pid <= 0:
        return
    file_path = get_run_process_state_path(run_id)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": process.pid, "recorded_at": now_iso()}
    file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def clear_run_process_state(run_id: str, pid: int | None = None) -> None:
    file_path = get_run_process_state_path(run_id)
    try:
        if pid is not None and pid > 0:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
            if payload.get("pid") != pid:
                return
        file_path.unlink(missing_ok=True)
    except Exception:
        return


def get_persisted_run_process_status(run_id: str) -> str:
    file_path = get_run_process_state_path(run_id)
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return "missing"
    pid = payload.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        clear_run_process_state(run_id)
        return "dead"
    if not is_process_alive(pid):
        clear_run_process_state(run_id, pid=pid)
        return "dead"
    return "alive"


def get_running_process(run_id: str) -> subprocess.Popen[str] | None:
    with running_processes_lock:
        process = running_processes.get(run_id)
    if process is None:
        return None
    if process.poll() is not None:
        with running_processes_lock:
            if running_processes.get(run_id) is process:
                running_processes.pop(run_id, None)
        return None
    return process


def _start_process_output_logging(run_id: str, process: subprocess.Popen[str]) -> None:
    def _pump(stream: TextIO | None, channel: str) -> None:
        if stream is None:
            return
        try:
            for line in iter(stream.readline, ""):
                if line == "":
                    break
                text = line.rstrip("\r\n")
                if not text:
                    continue
                if channel == "stderr":
                    print(f"[{run_id}] stderr: {text}", file=sys.stderr, flush=True)
                else:
                    print(f"[{run_id}] stdout: {text}", flush=True)
        except Exception:
            return

    threading.Thread(target=_pump, args=(process.stdout, "stdout"), daemon=True).start()
    threading.Thread(target=_pump, args=(process.stderr, "stderr"), daemon=True).start()


def _start_process_exit_monitor(run_id: str, process: subprocess.Popen[str]) -> None:
    def _wait_and_cleanup() -> None:
        try:
            code = process.wait()
        except Exception:
            code = 1
        with running_processes_lock:
            if running_processes.get(run_id) is process:
                running_processes.pop(run_id, None)
        clear_run_process_state(run_id, pid=process.pid)
        print(f"[RunGateway] Run {run_id} process exited with code {code}", flush=True)

    threading.Thread(target=_wait_and_cleanup, daemon=True).start()


def register_running_process(
    run_id: str,
    process: subprocess.Popen[str],
    *,
    attach_output_logging: bool,
) -> None:
    with running_processes_lock:
        running_processes[run_id] = process
    persist_run_process_state(run_id, process)
    if attach_output_logging:
        _start_process_output_logging(run_id, process)
    _start_process_exit_monitor(run_id, process)


def is_resumable_run_status(status: str | None) -> bool:
    return status in {"running", "paused", "idle", "completed"}


def get_ended_session_error(process: subprocess.Popen[str] | None, status: str | None = None) -> str | None:
    if process is not None and process.poll() is None:
        return None
    if is_resumable_run_status(status):
        return None
    return ENDED_SESSION_ERROR


def wait_for_child_startup(child: subprocess.Popen[str], timeout_ms: int = 300) -> None:
    if child.poll() is not None:
        raise RuntimeError(f"Resume process exited immediately with code {child.returncode}")
    time.sleep(max(0, timeout_ms) / 1000.0)
    if child.poll() is not None:
        raise RuntimeError(f"Resume process exited with code {child.returncode}")


def build_resume_cli_args(run_dir: Path, dataset_path: Path) -> list[str]:
    return ["-u", "cli.py", "--resume", "--run-dir", str(run_dir), "--dataset", str(dataset_path)]


def ensure_run_process_for_steer(
    *,
    run_id: str,
    state: dict[str, Any],
    user_goal: str | None = None,
    resume_message_json: str | None = None,
    user_message_id: str | None = None,
    user_message_timestamp: str | None = None,
) -> subprocess.Popen[str]:
    existing = get_running_process(run_id)
    if existing is not None:
        return existing

    prepared_state = deepcopy(state)
    prepared_state, prepared_changed = prepare_state_for_resume_input(prepared_state)
    if prepared_changed:
        write_run_state(run_id, prepared_state)
    state = prepared_state
    clear_run_stop_file(run_id)

    saved_dataset_path = str(state.get("dataset_path", "")).strip()
    if not saved_dataset_path:
        raise RuntimeError("Run is missing dataset_path")

    dataset_path = resolve_dataset_path_from_state(saved_dataset_path, REPO_ROOT)
    if not dataset_path.exists():
        raise RuntimeError(f"Dataset not found for resumed run: {saved_dataset_path}")

    run_dir = RUNS_DIR / run_id
    args = build_resume_cli_args(run_dir, dataset_path)
    if isinstance(user_goal, str) and user_goal.strip():
        args.extend(["--user-goal", user_goal.strip()])
    if isinstance(resume_message_json, str) and resume_message_json.strip():
        args.extend(["--resume-message-json", resume_message_json])
    elif (
        isinstance(user_message_id, str)
        and user_message_id
        and isinstance(user_message_timestamp, str)
        and user_message_timestamp
    ):
        args.extend(["--user-message-id", user_message_id, "--user-message-timestamp", user_message_timestamp])
    if is_stable_llm_output_enabled(dict(os.environ)):
        args.append("--stable")

    child = subprocess.Popen(
        [sys.executable, *args],
        cwd=str(BACKEND_DIR),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=build_backend_process_env(dict(os.environ)),
        **build_cli_subprocess_group_options(),
    )

    register_running_process(run_id, child, attach_output_logging=True)
    wait_for_child_startup(child)
    return child


# ============================================================================
# Start-run helpers
# ============================================================================


@dataclass
class PreRunLoggingState:
    stdout_chunks: list[str]
    stderr_chunks: list[str]
    hint_lock: threading.Lock
    hinted_run_id: str | None
    assigned_run_id: str | None


def _start_pre_run_logging(
    process: subprocess.Popen[str],
    *,
    existing_run_ids: set[str],
) -> PreRunLoggingState:
    logging_state = PreRunLoggingState(
        stdout_chunks=[],
        stderr_chunks=[],
        hint_lock=threading.Lock(),
        hinted_run_id=None,
        assigned_run_id=None,
    )

    def _pump(stream: TextIO | None, channel: str) -> None:
        if stream is None:
            return
        try:
            for line in iter(stream.readline, ""):
                if line == "":
                    break
                with logging_state.hint_lock:
                    if channel == "stderr":
                        logging_state.stderr_chunks.append(line)
                    else:
                        logging_state.stdout_chunks.append(line)
                    if logging_state.hinted_run_id is None:
                        match = RUN_ID_PATTERN.search(line)
                        if match:
                            candidate = match.group(0)
                            if candidate not in existing_run_ids:
                                logging_state.hinted_run_id = candidate
                    tag = logging_state.assigned_run_id or logging_state.hinted_run_id or "pending-run"
                text = line.rstrip("\r\n")
                if not text:
                    continue
                if channel == "stderr":
                    print(f"[{tag}] stderr: {text}", file=sys.stderr, flush=True)
                else:
                    print(f"[{tag}] stdout: {text}", flush=True)
        except Exception:
            return

    threading.Thread(target=_pump, args=(process.stdout, "stdout"), daemon=True).start()
    threading.Thread(target=_pump, args=(process.stderr, "stderr"), daemon=True).start()
    return logging_state


def extract_tail(value: str, max_lines: int = 6) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    return " | ".join(lines[-max_lines:])


def is_run_ready(candidate: str) -> bool:
    state_path = RUNS_DIR / candidate / "state.json"
    try:
        return state_path.exists() and state_path.stat().st_size > 0
    except Exception:
        return False


def check_for_new_run(existing_run_ids: set[str]) -> str | None:
    for candidate in get_run_dirs():
        if candidate in existing_run_ids:
            continue
        if is_run_ready(candidate):
            return candidate
    return None


# ============================================================================
# API routes
# ============================================================================


@app.errorhandler(RequestEntityTooLarge)
def handle_request_entity_too_large(_exc: RequestEntityTooLarge) -> tuple[Response, int]:
    return jsonify({"error": f"Dataset upload exceeds the {DATASET_UPLOAD_MAX_BYTES} byte limit"}), 413


@app.post("/api/datasets/upload")
def upload_dataset() -> tuple[Response, int] | Response:
    file = request.files.get(DATASET_UPLOAD_FIELD_NAME)
    if file is None:
        return jsonify({"error": "file is required"}), 400
    if not is_csv_upload_filename(file.filename or ""):
        return jsonify({"error": "Only .csv files are supported"}), 400
    if not is_allowed_csv_mime_type(file.mimetype):
        return jsonify({"error": f"Unsupported CSV MIME type: {file.mimetype or 'unknown'}"}), 400

    try:
        DATASET_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        target_name = build_uploaded_dataset_filename(file.filename or "dataset.csv", str(uuid4()))
        target_path = DATASET_UPLOADS_DIR / target_name
        file.save(target_path)
        size_bytes = target_path.stat().st_size
        if size_bytes > DATASET_UPLOAD_MAX_BYTES:
            target_path.unlink(missing_ok=True)
            return jsonify({"error": f"Dataset upload exceeds the {DATASET_UPLOAD_MAX_BYTES} byte limit"}), 413
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify(
        {
            "dataset_path": str(target_path.resolve()),
            "original_filename": file.filename,
            "size_bytes": size_bytes,
            "temporary": True,
        }
    )


@app.post("/api/runs/start")
def start_run() -> tuple[Response, int] | Response:
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}

        dataset_path_raw = body.get("dataset_path")
        user_goal_raw = body.get("user_goal")
        if not isinstance(dataset_path_raw, str) or not dataset_path_raw.strip():
            return jsonify({"error": "dataset_path is required"}), 400
        if not isinstance(user_goal_raw, str) or not user_goal_raw.strip():
            return jsonify({"error": "user_goal is required"}), 400

        dataset_path = Path(dataset_path_raw)
        if not dataset_path.is_absolute():
            dataset_path = (REPO_ROOT / dataset_path).resolve()
        if not dataset_path.exists() or not dataset_path.is_file():
            return jsonify({"error": f"Dataset file not found: {dataset_path}"}), 400

        requested_default_sub_agents_num = body.get(
            "default_sub_agents_num",
            body.get("max_concurrency"),
        )

        def _check_int_param(name: str, value: Any, min_value: int, max_value: int | None = None) -> str | None:
            if value is None:
                return None
            if not isinstance(value, int):
                return f"{name} must be an integer"
            if value < min_value:
                return f"{name} must be >= {min_value}"
            if isinstance(max_value, int) and value > max_value:
                return f"{name} must be <= {max_value}"
            return None

        validation_error = (
            _check_int_param("default_sub_agents_num", requested_default_sub_agents_num, 1, 6)
            or _check_int_param("max_initial_plans", body.get("max_initial_plans"), 1, None)
        )
        if validation_error:
            return jsonify({"error": validation_error}), 400

        existing_run_ids = set(get_run_dirs())
        args = ["-u", "cli.py", "--dataset", str(dataset_path), "--user-goal", user_goal_raw.strip()]

        if isinstance(requested_default_sub_agents_num, int):
            args.extend(["--max-concurrency", str(requested_default_sub_agents_num)])
        if isinstance(body.get("max_initial_plans"), int):
            args.extend(["--max-initial-plans", str(body.get("max_initial_plans"))])
        if body.get("stable_output") is True or is_stable_llm_output_enabled(dict(os.environ)):
            args.append("--stable")

        print(f"\n[RunGateway] Starting new run: {args}", flush=True)

        try:
            process = subprocess.Popen(
                [sys.executable, *args],
                cwd=str(BACKEND_DIR),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=build_backend_process_env(dict(os.environ)),
                **build_cli_subprocess_group_options(),
            )
        except Exception as exc:
            return jsonify({"error": f"Failed to start Python process: {exc}"}), 500

        logging_state = _start_pre_run_logging(process, existing_run_ids=existing_run_ids)

        run_id: str | None = None
        timeout_seconds = 30.0
        start_time = time.monotonic()
        while time.monotonic() - start_time < timeout_seconds:
            with logging_state.hint_lock:
                hinted = logging_state.hinted_run_id
            if hinted:
                if is_run_ready(hinted):
                    run_id = hinted
                    break
            else:
                candidate = check_for_new_run(existing_run_ids)
                if candidate:
                    run_id = candidate
                    break

            if process.poll() is not None:
                break
            time.sleep(0.5)

        if run_id is None:
            if process.poll() is None:
                try:
                    process.kill()
                except Exception:
                    pass
            stderr_tail = extract_tail("".join(logging_state.stderr_chunks))
            stdout_tail = extract_tail("".join(logging_state.stdout_chunks))
            effective_exit_code = process.poll()

            error = "Timeout waiting for run to start"
            status_code = 504
            if effective_exit_code is not None:
                error = f"Run process exited before state initialization (exit code {effective_exit_code})"
                status_code = 500
            if stderr_tail:
                error = f"{error}: {stderr_tail}"
            elif stdout_tail and status_code == 500:
                error = f"{error}: {stdout_tail}"
            return jsonify({"error": error}), status_code

        with logging_state.hint_lock:
            logging_state.assigned_run_id = run_id

        register_running_process(run_id, process, attach_output_logging=False)
        print(f"[RunGateway] Run started: {run_id}", flush=True)
        return jsonify({"run_id": run_id, "status": "started"})
    except Exception as exc:
        print(f"Error starting run: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to start run"}), 500


@app.post("/api/runs/<run_id>/stop")
def stop_run(run_id: str) -> tuple[Response, int] | Response:
    try:
        child = get_running_process(run_id)
        force = request.args.get("force") in {"1", "true"}
        if child is None:
            return jsonify({"error": "Run not found or not running"}), 404

        try:
            stop_path = RUNS_DIR / run_id / "STOP"
            stop_path.parent.mkdir(parents=True, exist_ok=True)
            stop_path.write_text(f"stop requested: {now_iso()}\n", encoding="utf-8")
        except Exception:
            pass

        try:
            if force or os.name != "nt":
                child.terminate()
        except Exception:
            pass

        return jsonify({"run_id": run_id, "status": "stopping" if not force else "stopped"})
    except Exception as exc:
        print(f"Error stopping run: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to stop run"}), 500


@app.post("/api/runs/<run_id>/steer")
def steer_run(run_id: str) -> tuple[Response, int] | Response:
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}

        raw_content = str(body.get("content", "")).strip() if body.get("content") is not None else ""
        kind = normalize_steering_kind(body.get("kind"))
        display_text = str(body.get("display_text", "")).strip() if body.get("display_text") is not None else ""
        user_prompt = (
            str(body.get("user_prompt", "")).strip() if body.get("user_prompt") is not None else raw_content
        )
        system_prompt = str(body.get("system_prompt", "")).strip() if body.get("system_prompt") is not None else ""
        content = user_prompt or raw_content
        selected_keywords = (
            normalize_keywords(body.get("selected_keywords")) if kind in {"focus", "ignore"} else []
        )
        target = None if kind == "create" else normalize_steering_target_snapshot(body.get("target"))

        if not content:
            return jsonify({"error": "content is required"}), 400

        state = read_run_state(run_id)
        if state is None:
            return jsonify({"error": "Run not found or state unavailable"}), 404

        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

        status = str(state.get("status", "unknown"))
        if status not in {"running", "paused", "idle", "completed"}:
            return jsonify({"error": f"Run is not accepting messages (status={status})"}), 409

        message = create_user_steer_message(
            content,
            kind=kind,
            display_text=display_text or (content if kind == "create" else None),
            generated_prompt=(
                None
                if kind in {"focus", "ignore", "elaborate"} and isinstance(body.get("user_prompt"), str)
                else content
                if kind in {"focus", "ignore", "elaborate"}
                else ""
                if kind == "create"
                else None
            ),
            user_prompt=content if kind in {"focus", "ignore", "elaborate"} else None,
            system_prompt=system_prompt or None if kind in {"focus", "ignore", "elaborate"} else None,
            selected_keywords=selected_keywords,
            target=target,
        )

        existing_process = get_running_process(run_id)
        ended_session_error = get_ended_session_error(existing_process, status)
        if ended_session_error:
            return jsonify({"error": ended_session_error}), 410

        persisted_process_status = get_persisted_run_process_status(run_id)
        if status == "running" and existing_process is None and persisted_process_status == "missing":
            return (
                jsonify(
                    {
                        "error": (
                            "Run ownership is unknown after gateway restart; "
                            "cannot safely resume this active run."
                        )
                    }
                ),
                409,
            )

        resumed_for_this_steer = False
        if existing_process is None and persisted_process_status != "alive":
            ensure_run_process_for_steer(
                run_id=run_id,
                state=state,
                user_goal=content,
                resume_message_json=json.dumps(message, ensure_ascii=False),
                user_message_id=str(message.get("message_id", "")),
                user_message_timestamp=str(message.get("timestamp", "")),
            )
            resumed_for_this_steer = True

        if not resumed_for_this_steer:
            steer_path = RUNS_DIR / run_id / "steer.jsonl"
            append_jsonl_line(steer_path, message)

        return jsonify({"run_id": run_id, "status": "accepted", "message": message})
    except Exception as exc:
        print(f"Error steering run: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to steer run"}), 500


@app.patch("/api/runs/<run_id>/settings")
def update_run_settings(run_id: str) -> tuple[Response, int] | Response:
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}

        requested_default_sub_agents_num = body.get(
            "default_sub_agents_num",
            body.get("max_concurrency"),
        )
        if not isinstance(requested_default_sub_agents_num, int):
            return jsonify({"error": "default_sub_agents_num must be an integer"}), 400
        if not (MAX_CONCURRENCY_MIN <= requested_default_sub_agents_num <= MAX_CONCURRENCY_MAX):
            return jsonify({"error": "default_sub_agents_num must be between 1 and 6"}), 400

        state = read_run_state(run_id)
        if state is None:
            return jsonify({"error": "Run not found or state unavailable"}), 404
        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

        next_settings = normalize_settings_record(state.get("settings")) or {}
        next_settings["default_sub_agents_num"] = clamp_max_concurrency(requested_default_sub_agents_num)
        state["settings"] = next_settings
        state["updated_at"] = now_iso()
        write_run_state(run_id, state)
        return jsonify({"run_id": run_id, "settings": next_settings})
    except Exception as exc:
        print(f"Error updating run settings: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to update run settings"}), 500


@app.post("/api/runs/<run_id>/plans/<plan_id>/control")
def control_plan(run_id: str, plan_id: str) -> tuple[Response, int] | Response:
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}
        action = body.get("action")
        if not is_plan_control_action(action):
            return jsonify({"error": "action must be one of launch, pause, modify, terminate"}), 400
        user_authored_text = body.get("user_authored_text")
        if not isinstance(user_authored_text, str):
            user_authored_text = None

        state = read_run_state(run_id)
        if state is None:
            return jsonify({"error": "Run not found or state unavailable"}), 404
        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

        plans = get_state_plans(state)
        plan = next((item for item in plans if str(item.get("plan_id", "")) == plan_id), None)
        if plan is None:
            return jsonify({"error": "Plan not found"}), 404

        if not apply_plan_control_to_plan_record(plan, str(action)).get("allowed"):
            return (
                jsonify(
                    {
                        "error": (
                            f"Plan control action {action} is not allowed "
                            f"for status={str(plan.get('status', 'unknown'))}"
                        )
                    }
                ),
                409,
            )

        if should_ensure_run_process_for_plan_control(plan, str(action)):
            existing_process = get_running_process(run_id)
            persisted_process_status = get_persisted_run_process_status(run_id)
            if existing_process is None and persisted_process_status != "alive":
                ensure_run_process_for_steer(run_id=run_id, state=state)

        timestamp = now_iso()
        plan_controls_path = RUNS_DIR / run_id / "plan_controls.jsonl"
        append_jsonl_line(
            plan_controls_path,
            {
                "plan_id": plan_id,
                "action": action,
                **({"user_authored_text": user_authored_text} if user_authored_text else {}),
                "timestamp": timestamp,
            },
        )

        refreshed_state = read_run_state(run_id) or state
        optimistic_state = deepcopy(refreshed_state)
        optimistic_plans: list[Any] = []
        optimistic_frontier = optimistic_state.get("frontier")
        optimistic_legacy_plans = optimistic_state.get("plans")
        if isinstance(optimistic_frontier, list):
            optimistic_plans = optimistic_frontier
        elif isinstance(optimistic_legacy_plans, list):
            optimistic_plans = optimistic_legacy_plans

        for idx, item in enumerate(list(optimistic_plans)):
            if is_record(item) and str(item.get("plan_id", "")) == plan_id:
                optimistic_plans[idx] = apply_plan_control_preview_to_plan_record(
                    plan=normalize_plan_record(item),
                    action=str(action),
                    user_authored_text=user_authored_text,
                )
                break

        refreshed_plan = next(
            (item for item in get_state_plans(refreshed_state) if str(item.get("plan_id", "")) == plan_id),
            normalize_plan_record(dict(plan)),
        )
        response_payload = build_plan_control_response(
            plan=refreshed_plan,
            action=str(action),
            persisted_run_status=str(optimistic_state.get("status", "pending")),
            user_authored_text=user_authored_text,
        )
        return jsonify(
            {
                "plan": response_payload["plan"],
                "run_status": response_payload["runStatus"],
                "run_state": normalize_state_for_client(optimistic_state),
            }
        )
    except Exception as exc:
        print(f"Error controlling plan: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to control plan"}), 500


@app.post("/api/runs/<run_id>/report")
def generate_report(run_id: str) -> tuple[Response, int] | Response:
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}
        insight_id = body.get("insight_id")
        if not isinstance(insight_id, str) or not insight_id:
            return jsonify({"error": "insight_id is required"}), 400
        return jsonify(
            {
                "ok": True,
                "insight_id": insight_id,
                "report_path": "",
                "report_pack_path": "",
                "chain_insight_ids": [],
                "created_at": now_iso(),
                "language": body.get("language", "en"),
                "mode": "unavailable",
                "segment_count": 0,
                "errors": [],
                "preview": "",
            }
        )
    except Exception as exc:
        print(f"Error generating report: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to generate report"}), 500


@app.get("/api/runs")
def list_runs() -> tuple[Response, int] | Response:
    try:
        include_legacy = request.args.get("includeLegacy") in {"1", "true"}
        runs: list[dict[str, Any]] = []
        for run_id in get_run_dirs():
            try:
                state = read_run_state(run_id)
                if state is None:
                    raise RuntimeError("state.json missing or invalid")
                legacy = detect_legacy_state(state)
                dataset_path = str(state.get("dataset_path", "")) if state.get("dataset_path") is not None else ""
                status = str(state.get("status", "unknown"))
                step = int(state.get("step", 0)) if isinstance(state.get("step"), (int, float)) else 0
                failure_count = (
                    int(state.get("failure_count", 0))
                    if isinstance(state.get("failure_count"), (int, float))
                    else 0
                )
                summary_nodes = [item for item in state.get("insights", []) if is_record(item)] if isinstance(
                    state.get("insights"),
                    list,
                ) else []
                summary_count = len(summary_nodes)
                atomic_insight_count = count_atomic_insights(summary_nodes)
                created_at = str(state.get("created_at", "")) if state.get("created_at") is not None else ""
                updated_at = str(state.get("updated_at", "")) if state.get("updated_at") is not None else ""
                user_messages_raw = state.get("user_messages")
                user_messages: list[Any] = user_messages_raw if isinstance(user_messages_raw, list) else []
                first_user_message = ""
                for message in user_messages:
                    if is_record(message) and isinstance(message.get("content"), str):
                        first_user_message = message["content"]
                        break
                last_activity_at = updated_at or created_at
                runs.append(
                    {
                        "run_id": run_id,
                        "dataset_path": dataset_path,
                        "status": status,
                        "step": step,
                        "failure_count": failure_count,
                        "insight_count": atomic_insight_count,
                        "summary_count": summary_count,
                        "created_at": created_at,
                        "updated_at": updated_at,
                        "first_user_message": first_user_message,
                        "last_activity_at": last_activity_at,
                        "is_legacy": bool(legacy.get("is_legacy")),
                        "contract_version": str(legacy.get("contract_version", "unknown")),
                        "legacy_reason": legacy.get("reason"),
                    }
                )
            except Exception:
                runs.append(
                    {
                        "run_id": run_id,
                        "dataset_path": "",
                        "status": "unknown",
                        "step": 0,
                        "failure_count": 0,
                        "insight_count": 0,
                        "summary_count": 0,
                        "created_at": "",
                        "updated_at": "",
                        "is_legacy": False,
                        "contract_version": "unknown",
                    }
                )
        if not include_legacy:
            runs = [run for run in runs if not bool(run.get("is_legacy"))]
        return jsonify(runs)
    except Exception as exc:
        print(f"Error listing runs: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to list runs"}), 500


@app.get("/api/runs/<run_id>/state")
def get_run_state(run_id: str) -> tuple[Response, int] | Response:
    try:
        state = read_run_state(run_id)
        if state is None:
            return jsonify({"error": "Run not found or state unavailable"}), 404
        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409
        return jsonify(state)
    except Exception as exc:
        print(f"Error reading state: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Run not found or state unavailable"}), 404


@app.get("/api/runs/<run_id>/dataset/preview")
def get_dataset_preview(run_id: str) -> tuple[Response, int] | Response:
    try:
        state = read_run_state(run_id)
        if state is None:
            return jsonify({"error": "Run not found or state unavailable"}), 404
        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

        raw_path = state.get("dataset_path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            return jsonify({"error": "dataset_path is missing in run state"}), 400

        dataset_path = resolve_dataset_path_from_state(raw_path, REPO_ROOT)
        if dataset_path.suffix.lower() != ".csv":
            return jsonify({"error": "Only CSV datasets are supported in Data View"}), 400
        if not dataset_path.exists() or not dataset_path.is_file():
            return jsonify({"error": "Dataset file not found"}), 404
        if dataset_path.stat().st_size > DATA_VIEW_MAX_FILE_BYTES:
            return jsonify({"error": f"Dataset is too large for preview (> {DATA_VIEW_MAX_FILE_BYTES} bytes)"}), 413

        try:
            raw_limit = int(request.args.get("limit", ""))
        except Exception:
            raw_limit = DATA_VIEW_PREVIEW_ROWS
        try:
            raw_offset = int(request.args.get("offset", ""))
        except Exception:
            raw_offset = 0
        safe_limit = min(max(raw_limit, 1), DATA_VIEW_MAX_ROWS)
        safe_offset = max(raw_offset, 0)

        content = dataset_path.read_text(encoding="utf-8")
        dataset_info = state.get("dataset_info") if is_record(state.get("dataset_info")) else None
        delimiter = normalize_csv_delimiter(dataset_info.get("delimiter") if dataset_info else None) or sniff_csv_delimiter(content)
        preview = build_csv_preview(content, safe_limit, safe_offset, delimiter)
        payload = {"dataset_path": str(dataset_path), **preview}
        return jsonify(payload)
    except Exception as exc:
        print(f"Error reading dataset preview: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Failed to read dataset preview"}), 500


@app.get("/api/runs/<run_id>/events")
def get_events(run_id: str) -> tuple[Response, int] | Response:
    try:
        state = read_run_state(run_id)
        if state is not None:
            legacy = detect_legacy_state(state)
            if legacy.get("is_legacy"):
                return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409
        events_path = RUNS_DIR / run_id / "events.jsonl"
        events = read_jsonl_file(events_path)
        return jsonify(events)
    except Exception as exc:
        print(f"Error reading events: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Events not found"}), 404


@app.get("/api/runs/<run_id>/events/stream")
def stream_events(run_id: str) -> tuple[Response, int] | Response:
    state = read_run_state(run_id)
    if state is not None:
        legacy = detect_legacy_state(state)
        if legacy.get("is_legacy"):
            return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

    events_path = RUNS_DIR / run_id / "events.jsonl"
    replay_from_start = request.args.get("replay") == "1" or request.args.get("fromStart") == "1"
    from_param_raw = request.args.get("from")
    from_param: int | None = None
    if from_param_raw is not None:
        try:
            from_param = int(from_param_raw)
        except Exception:
            from_param = None
    has_from = isinstance(from_param, int) and from_param >= 0

    def _send_lines(text: str, leftover: str) -> tuple[list[str], str]:
        combined = leftover + text
        parts = combined.split("\n")
        next_leftover = parts.pop() if parts else ""
        out: list[str] = []
        for line in parts:
            if line.strip():
                out.append(f"data: {line}\n\n")
        return out, next_leftover

    def _generator() -> Any:
        last_size = 0
        leftover = ""

        if replay_from_start:
            try:
                content = events_path.read_bytes()
                last_size = len(content)
                packets, leftover = _send_lines(content.decode("utf-8", errors="ignore"), leftover)
                for packet in packets:
                    yield packet
            except Exception:
                pass
        elif has_from:
            try:
                content = events_path.read_text(encoding="utf-8")
                last_size = len(content.encode("utf-8"))
                all_lines = [line for line in content.split("\n") if line.strip()]
                start_index = min(from_param or 0, len(all_lines))
                remaining = "\n".join(all_lines[start_index:])
                if remaining:
                    remaining += "\n"
                packets, leftover = _send_lines(remaining, leftover)
                for packet in packets:
                    yield packet
            except Exception:
                pass
        else:
            try:
                last_size = events_path.stat().st_size
            except Exception:
                last_size = 0

        last_keepalive = time.monotonic()
        try:
            while True:
                try:
                    current_size = events_path.stat().st_size
                except Exception:
                    current_size = 0

                if current_size > last_size:
                    with events_path.open("rb") as handle:
                        handle.seek(last_size)
                        chunk = handle.read(current_size - last_size)
                    packets, leftover = _send_lines(chunk.decode("utf-8", errors="ignore"), leftover)
                    for packet in packets:
                        yield packet
                    last_size = current_size
                elif current_size < last_size:
                    last_size = 0
                    leftover = ""

                now = time.monotonic()
                if now - last_keepalive >= 15.0:
                    yield ":keepalive\n\n"
                    last_keepalive = now
                time.sleep(1.0)
        except GeneratorExit:
            return

    headers = {"Cache-Control": "no-cache", "Connection": "keep-alive"}
    return Response(_generator(), mimetype="text/event-stream", headers=headers)


@app.get("/api/runs/<run_id>/artifact/<path:artifact_path>")
def get_artifact(run_id: str, artifact_path: str) -> tuple[Response, int] | Response:
    try:
        state = read_run_state(run_id)
        if state is not None:
            legacy = detect_legacy_state(state)
            if legacy.get("is_legacy"):
                return jsonify({"error": "Legacy run is not supported", "reason": legacy.get("reason")}), 409

        if not artifact_path:
            return jsonify({"error": "Artifact path is required"}), 400

        run_dir = (RUNS_DIR / run_id).resolve()
        full_path = (run_dir / artifact_path).resolve()
        try:
            full_path.relative_to(run_dir)
        except Exception:
            return jsonify({"error": "Access denied"}), 403

        ext = full_path.suffix.lower()
        image_extensions = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
        if ext in image_extensions:
            content_type_map = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
            }
            return send_file(full_path, mimetype=content_type_map.get(ext, "application/octet-stream"))

        content = read_text_file(full_path)
        mimetype = "text/plain"
        if ext == ".py":
            mimetype = "text/x-python"
        elif ext == ".json":
            mimetype = "application/json"
        return Response(content, mimetype=mimetype)
    except Exception as exc:
        print(f"Error reading artifact: {exc}", file=sys.stderr, flush=True)
        return jsonify({"error": "Artifact not found"}), 404


@app.get("/api/health")
def health() -> Response:
    return jsonify({"status": "ok", "runsDir": str(RUNS_DIR)})


# ============================================================================
# Entrypoint
# ============================================================================


def _print_banner(port: int) -> None:
    print(f"\n[RunGateway] Server running at http://localhost:{port}", flush=True)
    print(f"[RunGateway] Serving runs from: {RUNS_DIR}", flush=True)
    print("\n[RunGateway] Endpoints:", flush=True)
    print("  POST /api/datasets/upload          - Upload a CSV dataset", flush=True)
    print("  POST /api/runs/start               - Start a new run", flush=True)
    print("  POST /api/runs/:runId/stop         - Stop a running run", flush=True)
    print("  POST /api/runs/:runId/steer        - Send a steer message", flush=True)
    print("  PATCH /api/runs/:runId/settings    - Update run settings", flush=True)
    print("  POST /api/runs/:runId/plans/:planId/control - Control a plan", flush=True)
    print("  POST /api/runs/:runId/report       - Generate a Summary Report", flush=True)
    print("  GET  /api/runs                     - List all runs", flush=True)
    print("  GET  /api/runs/:runId/state        - Get run state", flush=True)
    print("  GET  /api/runs/:runId/dataset/preview - Get dataset preview", flush=True)
    print("  GET  /api/runs/:runId/events       - Get all events", flush=True)
    print("  GET  /api/runs/:runId/events/stream - Stream events (SSE)", flush=True)
    print("  GET  /api/runs/:runId/artifact/*   - Get artifact content", flush=True)


def _is_interrupt_protection_enabled() -> bool:
    raw = str(os.environ.get(RUN_GATEWAY_PROTECT_INTERRUPTS_ENV, "1")).strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _install_gateway_signal_handlers() -> None:
    if not _is_interrupt_protection_enabled():
        return

    state: dict[str, float | None] = {"last_sigint_monotonic": None}

    def _on_signal(signum: int, _frame: Any) -> None:
        if signum == getattr(signal, "SIGTERM", None):
            print("[RunGateway] Received SIGTERM. Shutting down.", flush=True)
            raise KeyboardInterrupt

        now = time.monotonic()
        last = state.get("last_sigint_monotonic")
        if isinstance(last, float) and now - last <= RUN_GATEWAY_INTERRUPT_EXIT_WINDOW_SECONDS:
            print("[RunGateway] Received second SIGINT. Shutting down.", flush=True)
            raise KeyboardInterrupt

        state["last_sigint_monotonic"] = now
        print(
            (
                "[RunGateway] Ignored SIGINT to protect active runs from unintended interruption. "
                f"Press Ctrl+C again within {RUN_GATEWAY_INTERRUPT_EXIT_WINDOW_SECONDS:.1f}s to exit."
            ),
            flush=True,
        )

    signal.signal(signal.SIGINT, _on_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _on_signal)


if __name__ == "__main__":
    configured_port = os.environ.get("RUN_GATEWAY_PORT", "").strip()
    port = RUN_GATEWAY_PORT
    if configured_port:
        try:
            port = int(configured_port)
        except Exception:
            port = RUN_GATEWAY_PORT
    _install_gateway_signal_handlers()
    _print_banner(port)
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False)
