"""
Core data models for agentic-eda-v0.1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
import uuid

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from runtime_clock import now_iso  # noqa: E402

from config import (  # noqa: E402
    DEFAULT_MAX_CONCURRENCY,
    MAX_CONCURRENCY_MAX,
    MAX_CONCURRENCY_MIN,
)

PlanKind = Literal["analysis"]
PlanStatus = Literal[
    "pending",
    "analyzing",
    "summarizing",
    "paused",
    "terminated",
    "completed",
    "failed",
    "skipped",
]
PlanControlState = Literal["none", "pause_requested", "terminate_requested", "yield_requested"]
PlanResumePhase = Literal["analyzing", "summarizing"]
RunStatus = Literal["pending", "running", "paused", "idle", "completed", "failed", "stopped"]
SteeringMessageKind = Literal[
    "chat",
    "focus",
    "ignore",
    "elaborate",
    "create",
]
InsightType = Literal[
    "value",
    "proportion",
    "rank",
    "difference",
    "trend",
    "distribution",
    "association",
    "outlier",
    "extreme",
    "cluster",
    "data_quality",
]


def _now_iso() -> str:
    return now_iso()


def clamp_max_concurrency(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_MAX_CONCURRENCY
    return max(MAX_CONCURRENCY_MIN, min(MAX_CONCURRENCY_MAX, parsed))


def normalize_keyword_list(raw_keywords: Any, *, limit: int = 10) -> list[str]:
    keywords: list[str] = []
    seen: set[str] = set()
    if not isinstance(raw_keywords, list):
        return keywords
    for item in raw_keywords:
        keyword = str(item or "").strip()
        if not keyword:
            continue
        lookup_key = keyword.casefold()
        if lookup_key in seen:
            continue
        seen.add(lookup_key)
        keywords.append(keyword)
        if len(keywords) >= limit:
            break
    return keywords


def normalize_steering_message_kind(raw_kind: Any) -> SteeringMessageKind | None:
    if not isinstance(raw_kind, str):
        return None
    normalized = raw_kind.strip().lower()
    legacy_aliases = {
        "dive_into": "focus",
        "cut_off": "ignore",
        "suppress": "ignore",
    }
    normalized = legacy_aliases.get(normalized, normalized)
    if normalized in {
        "chat",
        "focus",
        "ignore",
        "elaborate",
        "create",
    }:
        return normalized  # type: ignore[return-value]
    return None


@dataclass
class RunSettings:
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    stable_llm_output: bool = False
    poll_interval_seconds: float = 0.05

    def __post_init__(self) -> None:
        self.max_concurrency = clamp_max_concurrency(self.max_concurrency)
        self.stable_llm_output = bool(self.stable_llm_output)
        self.poll_interval_seconds = float(self.poll_interval_seconds)

    def to_dict(self) -> dict[str, Any]:
        return {
            "default_sub_agents_num": self.max_concurrency,
            "stable_llm_output": self.stable_llm_output,
            "poll_interval_seconds": self.poll_interval_seconds,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RunSettings":
        data = data or {}
        return cls(
            max_concurrency=clamp_max_concurrency(
                data.get(
                    "default_sub_agents_num",
                    data.get("max_concurrency", DEFAULT_MAX_CONCURRENCY),
                )
            ),
            stable_llm_output=bool(data.get("stable_llm_output", False)),
            poll_interval_seconds=float(data.get("poll_interval_seconds", 0.05)),
        )

    @property
    def default_sub_agents_num(self) -> int:
        return self.max_concurrency

    @default_sub_agents_num.setter
    def default_sub_agents_num(self, value: Any) -> None:
        self.max_concurrency = clamp_max_concurrency(value)


@dataclass
class PlanItem:
    plan_id: str
    kind: PlanKind
    text: str
    filters: list[dict[str, Any]] = field(default_factory=list)
    embedding: list[float] | None = None
    status: PlanStatus = "pending"
    parent_insight_id: str | None = None
    short_label: str = ""
    assigned_sub_agent_id: str | None = None
    control_state: PlanControlState = "none"
    resume_phase: PlanResumePhase | None = None
    checkpoint_path: str | None = None
    final_summary: str | None = None
    error_message: str | None = None
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "kind": self.kind,
            "text": self.text,
            "filters": self.filters,
            "embedding": self.embedding,
            "status": self.status,
            "parent_insight_id": self.parent_insight_id,
            "short_label": self.short_label,
            "assigned_sub_agent_id": self.assigned_sub_agent_id,
            "control_state": self.control_state,
            "resume_phase": self.resume_phase,
            "checkpoint_path": self.checkpoint_path,
            "final_summary": self.final_summary,
            "error_message": self.error_message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlanItem":
        return cls(
            plan_id=str(data["plan_id"]),
            kind=data.get("kind", "analysis"),
            text=str(data.get("text", "")),
            filters=data.get("filters", []) or [],
            embedding=data.get("embedding"),
            status=data.get("status", "pending"),
            parent_insight_id=data.get("parent_insight_id"),
            short_label=data.get("short_label", ""),
            assigned_sub_agent_id=data.get("assigned_sub_agent_id"),
            control_state=data.get("control_state", "none"),
            resume_phase=data.get("resume_phase"),
            checkpoint_path=data.get("checkpoint_path"),
            final_summary=data.get("final_summary"),
            error_message=data.get("error_message"),
            created_at=data.get("created_at", _now_iso()),
            updated_at=data.get("updated_at", data.get("created_at", _now_iso())),
        )

    @classmethod
    def create(
        cls,
        text: str,
        *,
        kind: PlanKind = "analysis",
        filters: list[dict[str, Any]] | None = None,
        parent_insight_id: str | None = None,
        short_label: str = "",
    ) -> "PlanItem":
        return cls(
            plan_id=f"plan_{uuid.uuid4().hex[:8]}",
            kind=kind,
            text=text,
            filters=filters or [],
            parent_insight_id=parent_insight_id,
            short_label=short_label,
            control_state="none",
            resume_phase=None,
            checkpoint_path=None,
        )


@dataclass
class ExecutionRecord:
    plan_id: str
    success: bool
    code_path: str | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    plot_paths: list[str] = field(default_factory=list)
    analysis_path: str | None = None
    stdout_content: str = ""
    stderr_content: str = ""
    error_message: str | None = None
    execution_time_ms: int = 0
    created_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "success": self.success,
            "code_path": self.code_path,
            "stdout_path": self.stdout_path,
            "stderr_path": self.stderr_path,
            "plot_paths": self.plot_paths,
            "analysis_path": self.analysis_path,
            "stdout_content": self.stdout_content,
            "stderr_content": self.stderr_content,
            "error_message": self.error_message,
            "execution_time_ms": self.execution_time_ms,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionRecord":
        return cls(
            plan_id=str(data["plan_id"]),
            success=bool(data.get("success", False)),
            code_path=data.get("code_path"),
            stdout_path=data.get("stdout_path"),
            stderr_path=data.get("stderr_path"),
            plot_paths=list(data.get("plot_paths", []) or []),
            analysis_path=data.get("analysis_path"),
            stdout_content=str(data.get("stdout_content", "")),
            stderr_content=str(data.get("stderr_content", "")),
            error_message=data.get("error_message"),
            execution_time_ms=int(data.get("execution_time_ms", 0)),
            created_at=data.get("created_at", _now_iso()),
        )


@dataclass
class InsightEvidence:
    code_path: str | None = None
    output_path: str | None = None
    plot_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code_path": self.code_path,
            "output_path": self.output_path,
            "plot_path": self.plot_path,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "InsightEvidence":
        data = data or {}
        return cls(
            code_path=data.get("code_path"),
            output_path=data.get("output_path"),
            plot_path=data.get("plot_path"),
        )


@dataclass
class AtomicInsight:
    atomic_id: str
    text: str
    insight_type: InsightType
    columns: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    evidence: InsightEvidence = field(default_factory=InsightEvidence)
    embedding: list[float] | None = None
    interest: float = 0.0
    significance: float = 0.0
    impact: float = 0.0
    importance: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "atomic_id": self.atomic_id,
            "text": self.text,
            "insight_type": self.insight_type,
            "columns": self.columns,
            "keywords": self.keywords,
            "evidence": self.evidence.to_dict(),
            "embedding": self.embedding,
            "interest": self.interest,
            "significance": self.significance,
            "impact": self.impact,
            "importance": self.importance,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AtomicInsight":
        raw_type = str(data.get("insight_type", "value")).strip().lower() or "value"
        if raw_type not in {
            "value",
            "proportion",
            "rank",
            "difference",
            "trend",
            "distribution",
            "association",
            "outlier",
            "extreme",
            "cluster",
            "data_quality",
        }:
            raw_type = "value"
        return cls(
            atomic_id=str(data.get("atomic_id", f"atomic_{uuid.uuid4().hex[:8]}")),
            text=str(data.get("text", "")),
            insight_type=raw_type,  # type: ignore[arg-type]
            columns=[str(item) for item in data.get("columns", []) or []],
            keywords=normalize_keyword_list(data.get("keywords")),
            evidence=InsightEvidence.from_dict(data.get("evidence")),
            embedding=data.get("embedding"),
            interest=float(data.get("interest", 0.0) or 0.0),
            significance=float(data.get("significance", 0.0) or 0.0),
            impact=float(data.get("impact", 0.0) or 0.0),
            importance=float(data.get("importance", 0.0) or 0.0),
        )

    @classmethod
    def create(
        cls,
        text: str,
        insight_type: InsightType = "value",
        columns: list[str] | None = None,
        keywords: list[str] | None = None,
        evidence: InsightEvidence | None = None,
    ) -> "AtomicInsight":
        return cls(
            atomic_id=f"atomic_{uuid.uuid4().hex[:8]}",
            text=text,
            insight_type=insight_type,
            columns=columns or [],
            keywords=normalize_keyword_list(keywords),
            evidence=evidence or InsightEvidence(),
        )


@dataclass
class Insight:
    insight_id: str
    plan_id: str
    summary: str
    atomic_insights: list[AtomicInsight] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    embedding: list[float] | None = None
    parent_insight_id: str | None = None
    short_label: str = ""
    created_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "insight_id": self.insight_id,
            "plan_id": self.plan_id,
            "summary": self.summary,
            "atomic_insights": [item.to_dict() for item in self.atomic_insights],
            "keywords": self.keywords,
            "embedding": self.embedding,
            "parent_insight_id": self.parent_insight_id,
            "short_label": self.short_label,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Insight":
        return cls(
            insight_id=str(data["insight_id"]),
            plan_id=str(data.get("plan_id", "")),
            summary=str(data.get("summary", "")),
            atomic_insights=[
                AtomicInsight.from_dict(item)
                for item in data.get("atomic_insights", []) or []
                if isinstance(item, dict)
            ],
            keywords=normalize_keyword_list(data.get("keywords")),
            embedding=data.get("embedding"),
            parent_insight_id=data.get("parent_insight_id"),
            short_label=str(data.get("short_label", "")),
            created_at=data.get("created_at", _now_iso()),
        )

    @classmethod
    def create(
        cls,
        *,
        plan_id: str,
        summary: str,
        atomic_insights: list[AtomicInsight] | None = None,
        keywords: list[str] | None = None,
        parent_insight_id: str | None = None,
        short_label: str = "",
    ) -> "Insight":
        return cls(
            insight_id=f"insight_{uuid.uuid4().hex[:8]}",
            plan_id=plan_id,
            summary=summary,
            atomic_insights=atomic_insights or [],
            keywords=normalize_keyword_list(keywords),
            parent_insight_id=parent_insight_id,
            short_label=short_label,
        )


Summary = Insight


@dataclass
class SteeringColumnAnchor:
    column: str
    converge_index: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "column": self.column,
            "converge_index": self.converge_index,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "SteeringColumnAnchor | None":
        if not data:
            return None
        column = str(data.get("column", "")).strip()
        raw_converge_index = data.get("converge_index")
        try:
            converge_index = int(raw_converge_index)
        except (TypeError, ValueError):
            return None
        if not column or converge_index < 0:
            return None
        return cls(column=column, converge_index=converge_index)


@dataclass
class SteeringTargetSnapshot:
    kind: Literal["summary", "atomic", "column"]
    summary_id: str
    summary_short_label: str = ""
    summary_text: str = ""
    columns: list[str] = field(default_factory=list)
    column_anchors: list[SteeringColumnAnchor] = field(default_factory=list)
    atomic_id: str | None = None
    atomic_text: str | None = None
    insight_type: InsightType | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "kind": self.kind,
            "summary_id": self.summary_id,
            "summary_short_label": self.summary_short_label,
            "summary_text": self.summary_text,
            "columns": self.columns,
        }
        if self.column_anchors:
            data["column_anchors"] = [anchor.to_dict() for anchor in self.column_anchors]
        if self.atomic_id is not None:
            data["atomic_id"] = self.atomic_id
        if self.atomic_text is not None:
            data["atomic_text"] = self.atomic_text
        if self.insight_type is not None:
            data["insight_type"] = self.insight_type
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "SteeringTargetSnapshot | None":
        if not data:
            return None
        raw_kind = str(data.get("kind", "summary")).strip().lower()
        kind: Literal["summary", "atomic", "column"]
        if raw_kind == "atomic":
            kind = "atomic"
        elif raw_kind == "column":
            kind = "column"
        else:
            kind = "summary"
        raw_type = data.get("insight_type")
        insight_type: InsightType | None
        if isinstance(raw_type, str) and raw_type in {
            "value",
            "proportion",
            "rank",
            "difference",
            "trend",
            "distribution",
            "association",
            "outlier",
            "extreme",
            "cluster",
            "data_quality",
        }:
            insight_type = raw_type  # type: ignore[assignment]
        else:
            insight_type = None
        columns = []
        seen_columns: set[str] = set()
        for item in data.get("columns", []) or []:
            normalized_column = str(item).strip()
            if not normalized_column or normalized_column in seen_columns:
                continue
            seen_columns.add(normalized_column)
            columns.append(normalized_column)
        if kind == "column":
            legacy_column_name = (
                str(data.get("column_name")).strip()
                if data.get("column_name") is not None
                else ""
            )
            if legacy_column_name and legacy_column_name not in seen_columns:
                columns = [legacy_column_name, *columns]
        column_anchors: list[SteeringColumnAnchor] = []
        seen_anchor_columns: set[str] = set()
        for item in data.get("column_anchors", []) or []:
            if not isinstance(item, dict):
                continue
            anchor = SteeringColumnAnchor.from_dict(item)
            if (
                anchor is None
                or anchor.column in seen_anchor_columns
                or (columns and anchor.column not in columns)
            ):
                continue
            seen_anchor_columns.add(anchor.column)
            column_anchors.append(anchor)
        return cls(
            kind=kind,
            summary_id=str(data.get("summary_id", "")),
            summary_short_label=str(data.get("summary_short_label", "")),
            summary_text=str(data.get("summary_text", "")),
            columns=columns,
            column_anchors=column_anchors,
            atomic_id=str(data.get("atomic_id")) if data.get("atomic_id") is not None else None,
            atomic_text=str(data.get("atomic_text")) if data.get("atomic_text") is not None else None,
            insight_type=insight_type,
        )


@dataclass
class UserMessage:
    message_id: str
    timestamp: str
    content: str
    kind: SteeringMessageKind | None = None
    display_text: str | None = None
    generated_prompt: str | None = None
    user_prompt: str | None = None
    system_prompt: str | None = None
    selected_keywords: list[str] = field(default_factory=list)
    target: SteeringTargetSnapshot | None = None

    def to_dict(self) -> dict[str, Any]:
        kind = normalize_steering_message_kind(self.kind)
        data: dict[str, Any] = {
            "message_id": self.message_id,
            "timestamp": self.timestamp,
            "content": self.content,
        }
        if kind is not None:
            data["kind"] = kind
        if self.display_text is not None:
            data["display_text"] = self.display_text
        if self.generated_prompt is not None:
            data["generated_prompt"] = self.generated_prompt
        if self.user_prompt is not None:
            data["user_prompt"] = self.user_prompt
        if self.system_prompt is not None:
            data["system_prompt"] = self.system_prompt
        if self.selected_keywords:
            data["selected_keywords"] = self.selected_keywords
        if self.target is not None:
            data["target"] = self.target.to_dict()
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UserMessage":
        kind = normalize_steering_message_kind(data.get("kind"))
        return cls(
            message_id=str(data.get("message_id", f"msg_{uuid.uuid4().hex[:8]}")),
            timestamp=str(data.get("timestamp", _now_iso())),
            content=str(data.get("content", "")),
            kind=kind,
            display_text=str(data.get("display_text")) if data.get("display_text") is not None else None,
            generated_prompt=(
                str(data.get("generated_prompt"))
                if data.get("generated_prompt") is not None
                else None
            ),
            user_prompt=(
                str(data.get("user_prompt"))
                if data.get("user_prompt") is not None
                else None
            ),
            system_prompt=(
                str(data.get("system_prompt"))
                if data.get("system_prompt") is not None
                else None
            ),
            selected_keywords=normalize_keyword_list(data.get("selected_keywords")),
            target=(
                SteeringTargetSnapshot.from_dict(data.get("target"))
                if isinstance(data.get("target"), dict)
                else None
            ),
        )

    @classmethod
    def create(
        cls,
        content: str,
        *,
        kind: SteeringMessageKind | None = None,
        display_text: str | None = None,
        generated_prompt: str | None = None,
        user_prompt: str | None = None,
        system_prompt: str | None = None,
        selected_keywords: list[str] | None = None,
        target: SteeringTargetSnapshot | None = None,
    ) -> "UserMessage":
        return cls(
            message_id=f"msg_{uuid.uuid4().hex[:8]}",
            timestamp=_now_iso(),
            content=content,
            kind=normalize_steering_message_kind(kind),
            display_text=display_text,
            generated_prompt=generated_prompt,
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            selected_keywords=normalize_keyword_list(selected_keywords),
            target=target,
        )


@dataclass
class TimelineEntry:
    entry_type: str   # "create_plans" | "dispatch_plans" | "plans_completed" |
                      # "plan_failed" | "user_steer" | "evaluate_progress" |
                      # "synthesize_findings" | "respond_to_user" | "mark_complete"
    content: Any
    timestamp: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry_type": self.entry_type,
            "content": self.content,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TimelineEntry":
        return cls(
            entry_type=str(data.get("entry_type", "")),
            content=data.get("content"),
            timestamp=str(data.get("timestamp", _now_iso())),
        )


@dataclass
class Turn:
    turn_id: int
    goal: str
    steers: list[str] = field(default_factory=list)
    timeline: list[TimelineEntry] = field(default_factory=list)
    status: Literal["running", "completed"] = "running"
    final_summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "goal": self.goal,
            "steers": self.steers,
            "timeline": [e.to_dict() for e in self.timeline],
            "status": self.status,
            "final_summary": self.final_summary,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Turn":
        return cls(
            turn_id=int(data.get("turn_id", 0)),
            goal=str(data.get("goal", "")),
            steers=list(data.get("steers", []) or []),
            timeline=[
                TimelineEntry.from_dict(item)
                for item in data.get("timeline", []) or []
                if isinstance(item, dict)
            ],
            status=data.get("status", "running"),
            final_summary=str(data.get("final_summary", "")),
        )


@dataclass
class ProvenanceCitation:
    marker: int
    target: SteeringTargetSnapshot
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "marker": self.marker,
            "target": self.target.to_dict(),
            "label": self.label,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ProvenanceCitation | None":
        if not data:
            return None
        target = SteeringTargetSnapshot.from_dict(data.get("target"))
        if target is None or target.kind not in {"summary", "atomic"}:
            return None
        raw_marker = data.get("marker", 0)
        try:
            marker = int(raw_marker)
        except (TypeError, ValueError):
            marker = 0
        if marker <= 0:
            return None
        return cls(
            marker=marker,
            target=target,
            label=str(data.get("label", "")),
        )


@dataclass
class DispatchBatchState:
    dispatch_turn_index: int
    plan_ids: list[str] = field(default_factory=list)
    status: Literal["dispatched", "waiting_for_stage_summary", "stage_summarized", "no_summary"] = "dispatched"
    stage_summary_emitted: bool = False
    batch_finished_user_response_emitted: bool = False
    stage_summary_markdown: str = ""
    stage_summary_citations: list[ProvenanceCitation] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dispatch_turn_index": self.dispatch_turn_index,
            "plan_ids": self.plan_ids,
            "status": self.status,
            "stage_summary_emitted": self.stage_summary_emitted,
            "batch_finished_user_response_emitted": self.batch_finished_user_response_emitted,
            "stage_summary_markdown": self.stage_summary_markdown,
            "stage_summary_citations": [item.to_dict() for item in self.stage_summary_citations],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "DispatchBatchState | None":
        if not data:
            return None
        raw_status = str(data.get("status", "dispatched"))
        status: Literal["dispatched", "waiting_for_stage_summary", "stage_summarized", "no_summary"]
        if raw_status in {"waiting_for_stage_summary", "stage_summarized", "no_summary"}:
            status = raw_status  # type: ignore[assignment]
        else:
            status = "dispatched"
        citations: list[ProvenanceCitation] = []
        for item in data.get("stage_summary_citations", []) or []:
            if not isinstance(item, dict):
                continue
            citation = ProvenanceCitation.from_dict(item)
            if citation is not None:
                citations.append(citation)
        return cls(
            dispatch_turn_index=int(data.get("dispatch_turn_index", 0)),
            plan_ids=[str(item) for item in data.get("plan_ids", []) or []],
            status=status,
            stage_summary_emitted=bool(data.get("stage_summary_emitted", False)),
            batch_finished_user_response_emitted=bool(
                data.get("batch_finished_user_response_emitted", False)
            ),
            stage_summary_markdown=str(data.get("stage_summary_markdown", "")),
            stage_summary_citations=citations,
        )


@dataclass
class MasterAgentState:
    current_goals: list[str] = field(default_factory=list)
    active_plan_ids: list[str] = field(default_factory=list)
    completed_plan_ids: list[str] = field(default_factory=list)
    all_insight_ids: list[str] = field(default_factory=list)
    dispatch_batches: list[DispatchBatchState] = field(default_factory=list)
    pending_direct_user_create_dispatch_plan_ids: list[str] = field(default_factory=list)
    pending_user_response_message_ids: list[str] = field(default_factory=list)
    pending_stop_completion_message_id: str | None = None
    message_history: list[dict[str, Any]] = field(default_factory=list)
    loop_count: int = 0
    completed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_goals": self.current_goals,
            "active_plan_ids": self.active_plan_ids,
            "completed_plan_ids": self.completed_plan_ids,
            "all_insight_ids": self.all_insight_ids,
            "dispatch_batches": [item.to_dict() for item in self.dispatch_batches],
            "pending_direct_user_create_dispatch_plan_ids": (
                self.pending_direct_user_create_dispatch_plan_ids
            ),
            "pending_user_response_message_ids": self.pending_user_response_message_ids,
            "pending_stop_completion_message_id": self.pending_stop_completion_message_id,
            "message_history": self.message_history,
            "loop_count": self.loop_count,
            "completed": self.completed,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "MasterAgentState":
        data = data or {}
        return cls(
            current_goals=list(data.get("current_goals", []) or []),
            active_plan_ids=list(data.get("active_plan_ids", []) or []),
            completed_plan_ids=list(data.get("completed_plan_ids", []) or []),
            all_insight_ids=list(data.get("all_insight_ids", []) or []),
            dispatch_batches=[
                batch
                for item in data.get("dispatch_batches", []) or []
                if isinstance(item, dict)
                for batch in [DispatchBatchState.from_dict(item)]
                if batch is not None
            ],
            pending_direct_user_create_dispatch_plan_ids=[
                str(item)
                for item in data.get("pending_direct_user_create_dispatch_plan_ids", []) or []
                if str(item)
            ],
            pending_user_response_message_ids=[
                str(item)
                for item in data.get("pending_user_response_message_ids", []) or []
                if str(item)
            ],
            pending_stop_completion_message_id=(
                str(data.get("pending_stop_completion_message_id", "")).strip() or None
            ),
            message_history=list(data.get("message_history", []) or []),
            loop_count=int(data.get("loop_count", 0)),
            completed=bool(data.get("completed", False)),
        )


@dataclass
class SubAgentResult:
    plan_id: str
    success: bool
    execution_records: list[ExecutionRecord] = field(default_factory=list)
    insight: Insight | None = None
    error: str | None = None
    control_action: Literal["pause", "terminate", "yield"] | None = None
    checkpoint_path: str | None = None
    resume_phase: PlanResumePhase | None = None
    timestamp_binding: Any | None = field(default=None, repr=False, compare=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "success": self.success,
            "execution_records": [record.to_dict() for record in self.execution_records],
            "insight": self.insight.to_dict() if self.insight is not None else None,
            "error": self.error,
            "control_action": self.control_action,
            "checkpoint_path": self.checkpoint_path,
            "resume_phase": self.resume_phase,
        }


@dataclass
class RunState:
    run_id: str
    dataset_path: str
    dataset_info: dict[str, Any] = field(default_factory=dict)
    dataset_schema: str = ""
    step: int = 0
    failure_count: int = 0
    status: RunStatus = "pending"
    settings: RunSettings = field(default_factory=RunSettings)
    master_agent_state: MasterAgentState = field(default_factory=MasterAgentState)
    plans: list[PlanItem] = field(default_factory=list)
    insights: list[Insight] = field(default_factory=list)
    execution_records: list[ExecutionRecord] = field(default_factory=list)
    user_messages: list[UserMessage] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)
    final_summary: str = ""
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        serialized_plans = [plan.to_dict() for plan in self.plans]
        return {
            "run_id": self.run_id,
            "dataset_path": self.dataset_path,
            "dataset_info": self.dataset_info,
            "dataset_schema": self.dataset_schema,
            "step": self.step,
            "failure_count": self.failure_count,
            "status": self.status,
            "settings": self.settings.to_dict(),
            "master_agent_state": self.master_agent_state.to_dict(),
            "plans": serialized_plans,
            "insights": [insight.to_dict() for insight in self.insights],
            "execution_records": [record.to_dict() for record in self.execution_records],
            "user_messages": [message.to_dict() for message in self.user_messages],
            "turns": [t.to_dict() for t in self.turns],
            "final_summary": self.final_summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunState":
        return cls(
            run_id=str(data["run_id"]),
            dataset_path=str(data.get("dataset_path", "")),
            dataset_info=data.get("dataset_info", {}) or {},
            dataset_schema=str(data.get("dataset_schema", "")),
            step=int(data.get("step", 0)),
            failure_count=int(data.get("failure_count", 0)),
            status=data.get("status", "pending"),
            settings=RunSettings.from_dict(data.get("settings")),
            master_agent_state=MasterAgentState.from_dict(data.get("master_agent_state")),
            plans=[
                PlanItem.from_dict(item)
                for item in (data.get("plans") or data.get("frontier") or [])
            ],
            insights=[Insight.from_dict(item) for item in data.get("insights", []) or []],
            execution_records=[
                ExecutionRecord.from_dict(item)
                for item in data.get("execution_records", []) or []
            ],
            user_messages=[
                UserMessage.from_dict(item) for item in data.get("user_messages", []) or []
            ],
            turns=[
                Turn.from_dict(item) for item in data.get("turns", []) or []
                if isinstance(item, dict)
            ],
            final_summary=str(data.get("final_summary", "")),
            created_at=str(data.get("created_at", _now_iso())),
            updated_at=str(data.get("updated_at", data.get("created_at", _now_iso()))),
        )

    @classmethod
    def create(
        cls,
        *,
        dataset_path: str,
        user_goal: str,
        settings: RunSettings | None = None,
    ) -> "RunState":
        return cls(
            run_id=f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}",
            dataset_path=dataset_path,
            status="running",
            settings=settings or RunSettings(),
            master_agent_state=MasterAgentState(current_goals=[user_goal]),
        )

    def get_plan_by_id(self, plan_id: str) -> PlanItem | None:
        for plan in self.plans:
            if plan.plan_id == plan_id:
                return plan
        return None

    def get_insight_by_id(self, insight_id: str) -> Insight | None:
        for insight in self.insights:
            if insight.insight_id == insight_id:
                return insight
        return None

    def total_summaries(self) -> int:
        return len(self.insights)

    def total_atomic_insights(self) -> int:
        return sum(len(item.atomic_insights) for item in self.insights)

    def current_turn(self) -> Turn | None:
        for turn in reversed(self.turns):
            if turn.status == "running":
                return turn
        return None
