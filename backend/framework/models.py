from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import uuid
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from runtime_clock import now_iso
from config import (
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
PlanControlState = Literal["none", "pause_requested", "terminate_requested"]
PlanResumePhase = Literal["analyzing", "summarizing"]
RunStatus = Literal["pending", "running", "paused", "idle", "completed", "failed", "stopped"]
UserMessageKind = Literal[
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


def generate_run_id() -> str:
    return f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"


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


def normalize_steering_message_kind(raw_kind: Any) -> UserMessageKind | None:
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


SteeringKind = Literal["focus", "ignore", "elaborate"]
ExecutionControlAction = Literal["launch", "pause", "terminate", "modify", "create"]


class WaitPayloadModel(BaseModel):
    reason: str


class CreatePlanItemPayloadModel(BaseModel):
    text: str
    source: str | None = None


class CreatePlansPayloadModel(BaseModel):
    plans: list[CreatePlanItemPayloadModel]


class DispatchPlansPayloadModel(BaseModel):
    plan_ids: list[str]


class EvaluateProgressPayloadModel(BaseModel):
    progress_digest: str
    dispatch_turn_index: int | None = None
    plan_ids: list[str] = Field(default_factory=list)


class EmitResponsePayloadModel(BaseModel):
    response: str


class CanonicalCitationTargetSummaryModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["summary"]
    summary_id: str = Field(min_length=1)
    summary_short_label: str = ""
    summary_text: str = ""
    columns: list[str] = Field(default_factory=list)
    insight_type: InsightType | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    provenance_refs: list[str] = Field(default_factory=list)


class CanonicalCitationTargetAtomicModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["atomic"]
    summary_id: str = Field(min_length=1)
    summary_short_label: str = ""
    summary_text: str = ""
    columns: list[str] = Field(default_factory=list)
    atomic_id: str = Field(min_length=1)
    atomic_text: str | None = None
    insight_type: InsightType | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    provenance_refs: list[str] = Field(default_factory=list)


CanonicalCitationTargetModel = Annotated[
    CanonicalCitationTargetSummaryModel | CanonicalCitationTargetAtomicModel,
    Field(discriminator="kind"),
]


class CanonicalCitationPayloadModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    marker: int = Field(ge=1)
    target: CanonicalCitationTargetModel
    label: str = ""

    @model_validator(mode="after")
    def _populate_default_label(self) -> "CanonicalCitationPayloadModel":
        if self.label.strip():
            return self
        if self.target.kind == "atomic":
            fallback = (
                self.target.atomic_id.strip()
                or self.target.summary_short_label.strip()
                or self.target.summary_id.strip()
            )
        else:
            fallback = (
                self.target.summary_short_label.strip()
                or self.target.summary_text.strip()
                or self.target.summary_id.strip()
            )
        self.label = fallback
        return self


class EmitStageSynthesisPayloadModel(BaseModel):
    stage_synthesis: str
    dispatch_turn_index: int | None = None
    citations: list[CanonicalCitationPayloadModel] = Field(default_factory=list)


class EmitFinalReportPayloadModel(BaseModel):
    final_report: str
    dispatch_turn_index: int | None = None
    citations: list[CanonicalCitationPayloadModel] = Field(default_factory=list)


ValidatedOrchestratorPayload = (
    WaitPayloadModel
    | CreatePlansPayloadModel
    | DispatchPlansPayloadModel
    | EvaluateProgressPayloadModel
    | EmitResponsePayloadModel
    | EmitStageSynthesisPayloadModel
    | EmitFinalReportPayloadModel
)


class _OrchestratorActionBase(BaseModel):
    action_id: str = Field(default_factory=lambda: f"action_{uuid.uuid4().hex[:8]}")
    rationale: str = ""
    consumed_steering_ids: list[str] = Field(default_factory=list)


class _WaitOrchestratorAction(_OrchestratorActionBase):
    type: Literal["wait"]
    payload: WaitPayloadModel


class _CreatePlansOrchestratorAction(_OrchestratorActionBase):
    type: Literal["create_plans"]
    payload: CreatePlansPayloadModel


class _DispatchPlansOrchestratorAction(_OrchestratorActionBase):
    type: Literal["dispatch_plans"]
    payload: DispatchPlansPayloadModel


class _EvaluateProgressOrchestratorAction(_OrchestratorActionBase):
    type: Literal["evaluate_progress"]
    payload: EvaluateProgressPayloadModel


class _EmitResponseOrchestratorAction(_OrchestratorActionBase):
    type: Literal["emit_response"]
    payload: EmitResponsePayloadModel


class _EmitStageSynthesisOrchestratorAction(_OrchestratorActionBase):
    type: Literal["emit_stage_synthesis"]
    payload: EmitStageSynthesisPayloadModel


class _EmitFinalReportOrchestratorAction(_OrchestratorActionBase):
    type: Literal["emit_final_report"]
    payload: EmitFinalReportPayloadModel


OrchestratorActionVariant = Annotated[
    _WaitOrchestratorAction
    | _CreatePlansOrchestratorAction
    | _DispatchPlansOrchestratorAction
    | _EvaluateProgressOrchestratorAction
    | _EmitResponseOrchestratorAction
    | _EmitStageSynthesisOrchestratorAction
    | _EmitFinalReportOrchestratorAction,
    Field(discriminator="type"),
]


_ORCHESTRATOR_ACTION_VARIANT_ADAPTER = TypeAdapter(OrchestratorActionVariant)


class OrchestratorAction(RootModel[OrchestratorActionVariant]):
    root: OrchestratorActionVariant

    def __init__(self, /, **data: Any) -> None:
        if "root" in data and len(data) == 1:
            super().__init__(root=data["root"])
            return
        validated = _ORCHESTRATOR_ACTION_VARIANT_ADAPTER.validate_python(data)
        super().__init__(root=validated)

    @property
    def action_id(self) -> str:
        return self.root.action_id

    @property
    def type(self) -> str:
        return self.root.type

    @property
    def rationale(self) -> str:
        return self.root.rationale

    @property
    def consumed_steering_ids(self) -> list[str]:
        return list(self.root.consumed_steering_ids)

    @property
    def payload(self) -> dict[str, Any]:
        return self.root.payload.model_dump()

    def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self.root.model_dump(*args, **kwargs)


def coerce_runtime_orchestrator_action(value: Any) -> OrchestratorAction:
    if isinstance(value, OrchestratorAction):
        return value
    return OrchestratorAction.model_validate(value)


def _normalize_validation_error(exc: ValidationError) -> str:
    details: list[str] = []
    for item in exc.errors():
        location = ".".join(str(part) for part in item.get("loc", ()) or ()) or "<root>"
        message = str(item.get("msg", "validation error")).strip() or "validation error"
        details.append(f"{location}: {message}")
    return "; ".join(details) if details else str(exc)


def _ensure_non_empty_text(value: Any, field_name: str) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return f"{field_name} must be a non-empty string"
    return None


def validate_orchestrator_action_shape(
    action: OrchestratorAction,
) -> tuple[ValidatedOrchestratorPayload | None, str | None]:
    try:
        coerced = coerce_runtime_orchestrator_action(action)
    except ValidationError as exc:
        return None, _normalize_validation_error(exc)
    payload_model = coerced.root.payload
    if coerced.type == "wait":
        parsed = WaitPayloadModel.model_validate(payload_model)
        return parsed, _ensure_non_empty_text(parsed.reason, "payload.reason")
    if coerced.type == "create_plans":
        parsed = CreatePlansPayloadModel.model_validate(payload_model)
        if not parsed.plans:
            return parsed, "payload.plans must contain at least one plan"
        for index, plan in enumerate(parsed.plans):
            error = _ensure_non_empty_text(plan.text, f"payload.plans[{index}].text")
            if error is not None:
                return parsed, error
        return parsed, None
    if coerced.type == "dispatch_plans":
        parsed = DispatchPlansPayloadModel.model_validate(payload_model)
        if not parsed.plan_ids:
            return parsed, "payload.plan_ids must contain at least one plan id"
        for index, plan_id in enumerate(parsed.plan_ids):
            error = _ensure_non_empty_text(plan_id, f"payload.plan_ids[{index}]")
            if error is not None:
                return parsed, error
        return parsed, None
    if coerced.type == "evaluate_progress":
        parsed = EvaluateProgressPayloadModel.model_validate(payload_model)
        return parsed, _ensure_non_empty_text(parsed.progress_digest, "payload.progress_digest")
    if coerced.type == "emit_response":
        parsed = EmitResponsePayloadModel.model_validate(payload_model)
        return parsed, _ensure_non_empty_text(parsed.response, "payload.response")
    if coerced.type == "emit_stage_synthesis":
        parsed = EmitStageSynthesisPayloadModel.model_validate(payload_model)
        return parsed, _ensure_non_empty_text(parsed.stage_synthesis, "payload.stage_synthesis")
    if coerced.type == "emit_final_report":
        parsed = EmitFinalReportPayloadModel.model_validate(payload_model)
        return parsed, _ensure_non_empty_text(parsed.final_report, "payload.final_report")
    return None, f"Unsupported orchestrator action type: {action.type}"


class WorkerFindingEvidence(BaseModel):
    code_path: str
    output_path: str
    plot_path: str


class WorkerFindingAtomicInsight(BaseModel):
    text: str
    insight_type: str
    columns: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    evidence: WorkerFindingEvidence


class WorkerFinding(BaseModel):
    summary: str
    short_label: str
    keywords: list[str] = Field(default_factory=list)
    atomic_insights: list[WorkerFindingAtomicInsight] = Field(default_factory=list)


def normalize_plan_control_state(raw_state: Any) -> PlanControlState:
    normalized = str(raw_state or "none").strip().lower()
    if normalized == "yield_requested":
        return "pause_requested"
    if normalized == "pause_requested":
        return "pause_requested"
    if normalized == "terminate_requested":
        return "terminate_requested"
    return "none"


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
    source: str = "orchestrator"
    filters: list[dict[str, Any]] = field(default_factory=list)
    embedding: list[float] | None = None
    status: PlanStatus = "pending"
    parent_insight_id: str | None = None
    short_label: str = ""
    assigned_sub_agent_id: str | None = None
    control_state: PlanControlState = "none"
    resume_phase: PlanResumePhase | None = None
    checkpoint_path: str | None = None
    linked_steering_ids: list[str] = field(default_factory=list)
    linked_control_ids: list[str] = field(default_factory=list)
    pending_modified_text: str | None = None
    final_summary: str | None = None
    error_message: str | None = None
    launch_requested: bool = False
    revision: int = 1
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "kind": self.kind,
            "text": self.text,
            "source": self.source,
            "filters": self.filters,
            "embedding": self.embedding,
            "status": self.status,
            "parent_insight_id": self.parent_insight_id,
            "short_label": self.short_label,
            "assigned_sub_agent_id": self.assigned_sub_agent_id,
            "assigned_worker": self.assigned_sub_agent_id,
            "control_state": self.control_state,
            "resume_phase": self.resume_phase,
            "checkpoint_path": self.checkpoint_path,
            "checkpoint_ref": self.checkpoint_path,
            "linked_steering_ids": list(self.linked_steering_ids),
            "linked_control_ids": list(self.linked_control_ids),
            "pending_modified_text": self.pending_modified_text,
            "final_summary": self.final_summary,
            "error_message": self.error_message,
            "launch_requested": self.launch_requested,
            "revision": self.revision,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PlanItem":
        return cls(
            plan_id=str(data["plan_id"]),
            kind=data.get("kind", "analysis"),
            text=str(data.get("text", "")),
            source=str(data.get("source", "orchestrator")),
            filters=data.get("filters", []) or [],
            embedding=data.get("embedding"),
            status=data.get("status", "pending"),
            parent_insight_id=data.get("parent_insight_id"),
            short_label=data.get("short_label", ""),
            assigned_sub_agent_id=data.get("assigned_sub_agent_id", data.get("assigned_worker")),
            control_state=normalize_plan_control_state(data.get("control_state", "none")),
            resume_phase=data.get("resume_phase"),
            checkpoint_path=data.get("checkpoint_path", data.get("checkpoint_ref")),
            linked_steering_ids=[str(item) for item in data.get("linked_steering_ids", []) or [] if str(item)],
            linked_control_ids=[str(item) for item in data.get("linked_control_ids", []) or [] if str(item)],
            pending_modified_text=(
                str(data.get("pending_modified_text")).strip()
                if data.get("pending_modified_text") is not None
                else None
            ),
            final_summary=data.get("final_summary"),
            error_message=data.get("error_message"),
            launch_requested=bool(data.get("launch_requested", False)),
            revision=int(data.get("revision", 1) or 1),
            created_at=data.get("created_at", _now_iso()),
            updated_at=data.get("updated_at", data.get("created_at", _now_iso())),
        )

    @classmethod
    def create(
        cls,
        text: str,
        *,
        kind: PlanKind = "analysis",
        source: str = "orchestrator",
        filters: list[dict[str, Any]] | None = None,
        parent_insight_id: str | None = None,
        short_label: str = "",
    ) -> "PlanItem":
        return cls(
            plan_id=f"plan_{uuid.uuid4().hex[:8]}",
            kind=kind,
            text=text,
            source=source,
            filters=filters or [],
            parent_insight_id=parent_insight_id,
            short_label=short_label,
            control_state="none",
            resume_phase=None,
            checkpoint_path=None,
            linked_steering_ids=[],
            linked_control_ids=[],
            pending_modified_text=None,
            launch_requested=False,
            revision=1,
        )

    @property
    def assigned_worker(self) -> str | None:
        return self.assigned_sub_agent_id

    @assigned_worker.setter
    def assigned_worker(self, value: str | None) -> None:
        self.assigned_sub_agent_id = value

    @property
    def checkpoint_ref(self) -> str | None:
        return self.checkpoint_path

    @checkpoint_ref.setter
    def checkpoint_ref(self, value: str | None) -> None:
        self.checkpoint_path = value


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
    code_path: str
    output_path: str
    plot_path: str

    def __post_init__(self) -> None:
        self.code_path = str(self.code_path or "").strip()
        self.output_path = str(self.output_path or "").strip()
        self.plot_path = str(self.plot_path or "").strip()
        if not self.code_path or not self.output_path or not self.plot_path:
            raise ValueError("InsightEvidence requires non-empty code_path, output_path, and plot_path.")

    def to_dict(self) -> dict[str, Any]:
        return {
            "code_path": self.code_path,
            "output_path": self.output_path,
            "plot_path": self.plot_path,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "InsightEvidence | None":
        data = data or {}
        code_path = str(data.get("code_path", "") or "").strip()
        output_path = str(data.get("output_path", "") or "").strip()
        plot_path = str(data.get("plot_path", "") or "").strip()
        if not code_path or not output_path or not plot_path:
            return None
        return cls(
            code_path=code_path,
            output_path=output_path,
            plot_path=plot_path,
        )


@dataclass
class AtomicInsight:
    atomic_id: str
    text: str
    insight_type: InsightType
    evidence: InsightEvidence
    columns: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    embedding: list[float] | None = None
    interest: float = 0.0
    significance: float = 0.0
    impact: float = 0.0
    importance: float = 0.0

    @property
    def importance_metrics(self) -> dict[str, float]:
        return {
            "interest": self.interest,
            "significance": self.significance,
            "impact": self.impact,
            "importance": self.importance,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "atomic_id": self.atomic_id,
            "text": self.text,
            "insight_type": self.insight_type,
            "columns": self.columns,
            "keywords": self.keywords,
            "evidence": self.evidence.to_dict(),
            "importance_metrics": self.importance_metrics,
            "embedding": self.embedding,
            "interest": self.interest,
            "significance": self.significance,
            "impact": self.impact,
            "importance": self.importance,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AtomicInsight | None":
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
        raw_metrics = data.get("importance_metrics")
        metrics = raw_metrics if isinstance(raw_metrics, dict) else {}
        evidence = InsightEvidence.from_dict(data.get("evidence"))
        if evidence is None:
            return None
        return cls(
            atomic_id=str(data.get("atomic_id", f"atomic_{uuid.uuid4().hex[:8]}")),
            text=str(data.get("text", "")),
            insight_type=raw_type,  # type: ignore[arg-type]
            evidence=evidence,
            columns=[str(item) for item in data.get("columns", []) or []],
            keywords=normalize_keyword_list(data.get("keywords")),
            embedding=data.get("embedding"),
            interest=float(metrics.get("interest", data.get("interest", 0.0)) or 0.0),
            significance=float(metrics.get("significance", data.get("significance", 0.0)) or 0.0),
            impact=float(metrics.get("impact", data.get("impact", 0.0)) or 0.0),
            importance=float(metrics.get("importance", data.get("importance", 0.0)) or 0.0),
        )

    @classmethod
    def create(
        cls,
        text: str,
        insight_type: InsightType = "value",
        *,
        evidence: InsightEvidence,
        columns: list[str] | None = None,
        keywords: list[str] | None = None,
    ) -> "AtomicInsight":
        return cls(
            atomic_id=f"atomic_{uuid.uuid4().hex[:8]}",
            text=text,
            insight_type=insight_type,
            evidence=evidence,
            columns=columns or [],
            keywords=normalize_keyword_list(keywords),
        )


@dataclass
class Insight:
    insight_id: str
    plan_id: str
    summary: str
    atomic_insights: list[AtomicInsight] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    embedding: list[float] | None = None
    parent_lineage_refs: list[str] = field(default_factory=list)
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
            "parent_lineage_refs": list(self.parent_lineage_refs),
            "parent_insight_id": self.parent_insight_id,
            "short_label": self.short_label,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Insight":
        parent_lineage_refs = [
            str(item)
            for item in data.get("parent_lineage_refs", []) or []
            if str(item)
        ]
        parent_insight_id = (
            str(data.get("parent_insight_id")).strip()
            if data.get("parent_insight_id") is not None
            else None
        )
        if parent_insight_id and parent_insight_id not in parent_lineage_refs:
            parent_lineage_refs.append(parent_insight_id)
        return cls(
            insight_id=str(data["insight_id"]),
            plan_id=str(data.get("plan_id", "")),
            summary=str(data.get("summary", "")),
            atomic_insights=[
                atomic
                for item in data.get("atomic_insights", []) or []
                if isinstance(item, dict)
                for atomic in [AtomicInsight.from_dict(item)]
                if atomic is not None
            ],
            keywords=normalize_keyword_list(data.get("keywords")),
            embedding=data.get("embedding"),
            parent_lineage_refs=parent_lineage_refs,
            parent_insight_id=parent_insight_id,
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
        parent_lineage_refs = [parent_insight_id] if parent_insight_id else []
        return cls(
            insight_id=f"insight_{uuid.uuid4().hex[:8]}",
            plan_id=plan_id,
            summary=summary,
            atomic_insights=atomic_insights or [],
            keywords=normalize_keyword_list(keywords),
            parent_lineage_refs=parent_lineage_refs,
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
        if raw_converge_index is None:
            return None
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
    evidence_refs: list[str] = field(default_factory=list)
    provenance_refs: list[str] = field(default_factory=list)

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
        if self.evidence_refs:
            data["evidence_refs"] = list(self.evidence_refs)
        if self.provenance_refs:
            data["provenance_refs"] = list(self.provenance_refs)
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
            evidence_refs=[str(item) for item in data.get("evidence_refs", []) or [] if str(item)],
            provenance_refs=[str(item) for item in data.get("provenance_refs", []) or [] if str(item)],
        )


@dataclass
class UserMessage:
    message_id: str
    timestamp: str
    content: str
    kind: UserMessageKind | None = None
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
        kind: UserMessageKind | None = None,
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
class SteeringRequest:
    steering_id: str
    kind: SteeringKind
    source: str
    timestamp: str
    target: SteeringTargetSnapshot
    selected_keywords: list[str] = field(default_factory=list)
    display_text: str = ""
    lifecycle: str = "registered"
    linked_plan_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "steering_id": self.steering_id,
            "kind": self.kind,
            "source": self.source,
            "timestamp": self.timestamp,
            "target": self.target.to_dict(),
            "selected_keywords": list(self.selected_keywords),
            "display_text": self.display_text,
            "lifecycle": self.lifecycle,
            "linked_plan_ids": list(self.linked_plan_ids),
        }


@dataclass
class ExecutionControlRequest:
    control_id: str
    action: ExecutionControlAction
    source: str
    timestamp: str
    target_plan_id: str | None = None
    user_authored_text: str | None = None
    display_text: str = ""
    lifecycle: str = "registered"
    linked_plan_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "control_id": self.control_id,
            "action": self.action,
            "source": self.source,
            "timestamp": self.timestamp,
            "target_plan_id": self.target_plan_id,
            "user_authored_text": self.user_authored_text,
            "display_text": self.display_text,
            "lifecycle": self.lifecycle,
            "linked_plan_ids": list(self.linked_plan_ids),
        }


@dataclass
class SteeringState:
    registered_steering_ids: list[str] = field(default_factory=list)
    active_steering_ids: list[str] = field(default_factory=list)
    consumed_steering_ids: list[str] = field(default_factory=list)
    superseded_steering_ids: list[str] = field(default_factory=list)
    target_index: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "registered_steering_ids": list(self.registered_steering_ids),
            "active_steering_ids": list(self.active_steering_ids),
            "consumed_steering_ids": list(self.consumed_steering_ids),
            "superseded_steering_ids": list(self.superseded_steering_ids),
            "target_index": {key: list(value) for key, value in self.target_index.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "SteeringState":
        data = data or {}
        return cls(
            registered_steering_ids=[str(item) for item in data.get("registered_steering_ids", []) or [] if str(item)],
            active_steering_ids=[str(item) for item in data.get("active_steering_ids", []) or [] if str(item)],
            consumed_steering_ids=[str(item) for item in data.get("consumed_steering_ids", []) or [] if str(item)],
            superseded_steering_ids=[str(item) for item in data.get("superseded_steering_ids", []) or [] if str(item)],
            target_index={
                str(key): [str(item) for item in value or [] if str(item)]
                for key, value in (data.get("target_index", {}) or {}).items()
            },
        )


@dataclass
class ExecutionControlState:
    registered_control_ids: list[str] = field(default_factory=list)
    applied_control_ids: list[str] = field(default_factory=list)
    superseded_control_ids: list[str] = field(default_factory=list)
    controls_by_plan: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "registered_control_ids": list(self.registered_control_ids),
            "applied_control_ids": list(self.applied_control_ids),
            "superseded_control_ids": list(self.superseded_control_ids),
            "controls_by_plan": {key: list(value) for key, value in self.controls_by_plan.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ExecutionControlState":
        data = data or {}
        return cls(
            registered_control_ids=[str(item) for item in data.get("registered_control_ids", []) or [] if str(item)],
            applied_control_ids=[str(item) for item in data.get("applied_control_ids", []) or [] if str(item)],
            superseded_control_ids=[str(item) for item in data.get("superseded_control_ids", []) or [] if str(item)],
            controls_by_plan={
                str(key): [str(item) for item in value or [] if str(item)]
                for key, value in (data.get("controls_by_plan", {}) or {}).items()
            },
        )


@dataclass
class WorkerSessionState:
    worker_session_id: str
    plan_id: str
    analysis_phase: str = "analyzing"
    tool_history: list[dict[str, Any]] = field(default_factory=list)
    artifact_refs: list[str] = field(default_factory=list)
    checkpoint_ref: str | None = None
    latest_reflection: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "worker_session_id": self.worker_session_id,
            "plan_id": self.plan_id,
            "analysis_phase": self.analysis_phase,
            "tool_history": list(self.tool_history),
            "artifact_refs": list(self.artifact_refs),
            "checkpoint_ref": self.checkpoint_ref,
            "latest_reflection": self.latest_reflection,
        }

    @classmethod
    def create(cls, *, plan_id: str) -> "WorkerSessionState":
        return cls(
            worker_session_id=f"worker_{uuid.uuid4().hex[:8]}",
            plan_id=plan_id,
        )


@dataclass
class ArtifactRecord:
    artifact_id: str
    type: str
    owner_refs: list[str] = field(default_factory=list)
    path_or_uri: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "type": self.type,
            "owner_refs": list(self.owner_refs),
            "path_or_uri": self.path_or_uri,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def create(
        cls,
        *,
        type: str,
        path_or_uri: str,
        owner_refs: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "ArtifactRecord":
        return cls(
            artifact_id=f"artifact_{uuid.uuid4().hex[:8]}",
            type=type,
            owner_refs=list(owner_refs or []),
            path_or_uri=path_or_uri,
            metadata=dict(metadata or {}),
        )

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ArtifactRecord":
        return cls(
            artifact_id=str(data.get("artifact_id", "") or f"artifact_{uuid.uuid4().hex[:8]}"),
            type=str(data.get("type", "") or ""),
            owner_refs=[str(item) for item in data.get("owner_refs", []) or [] if str(item)],
            path_or_uri=str(data.get("path_or_uri", "") or ""),
            metadata=dict(data.get("metadata", {}) or {}),
        )


@dataclass
class TimelineEntry:
    entry_type: str
    content: Any
    entry_id: str = field(default_factory=lambda: f"timeline_{uuid.uuid4().hex[:8]}")
    timestamp: str = field(default_factory=_now_iso)

    @property
    def payload(self) -> dict[str, Any]:
        return self.content if isinstance(self.content, dict) else {"value": self.content}

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry_id": self.entry_id,
            "entry_type": self.entry_type,
            "payload": self.payload,
            "content": self.content,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TimelineEntry":
        return cls(
            entry_id=str(data.get("entry_id", "") or f"timeline_{uuid.uuid4().hex[:8]}"),
            entry_type=str(data.get("entry_type", "")),
            content=data.get("content", data.get("payload")),
            timestamp=str(data.get("timestamp", _now_iso())),
        )


@dataclass
class Turn:
    turn_id: int
    goal: str
    triggering_inputs: list[dict[str, Any]] = field(default_factory=list)
    accepted_steering_ids: list[str] = field(default_factory=list)
    dispatch_batches: list[DispatchBatchState] = field(default_factory=list)
    stage_syntheses: list[dict[str, Any]] = field(default_factory=list)
    steers: list[str] = field(default_factory=list)
    timeline: list[TimelineEntry] = field(default_factory=list)
    status: Literal["running", "completed"] = "running"
    completion_status: str = "running"
    final_summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "turn_id": self.turn_id,
            "goal": self.goal,
            "current_goal": self.goal,
            "triggering_inputs": list(self.triggering_inputs),
            "accepted_steering_ids": list(self.accepted_steering_ids),
            "dispatch_batches": [batch.to_dict() for batch in self.dispatch_batches],
            "stage_syntheses": list(self.stage_syntheses),
            "steers": self.steers,
            "timeline": [e.to_dict() for e in self.timeline],
            "status": self.status,
            "completion_status": self.completion_status,
            "final_summary": self.final_summary,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Turn":
        return cls(
            turn_id=int(data.get("turn_id", 0)),
            goal=str(data.get("goal", data.get("current_goal", ""))),
            triggering_inputs=list(data.get("triggering_inputs", []) or []),
            accepted_steering_ids=[str(item) for item in data.get("accepted_steering_ids", []) or [] if str(item)],
            dispatch_batches=[
                batch
                for item in data.get("dispatch_batches", []) or []
                if isinstance(item, dict)
                for batch in [DispatchBatchState.from_dict(item)]
                if batch is not None
            ],
            stage_syntheses=list(data.get("stage_syntheses", []) or []),
            steers=list(data.get("steers", []) or []),
            timeline=[
                TimelineEntry.from_dict(item)
                for item in data.get("timeline", []) or []
                if isinstance(item, dict)
            ],
            status=data.get("status", "running"),
            completion_status=str(data.get("completion_status", data.get("status", "running"))),
            final_summary=str(data.get("final_summary", "")),
        )


@dataclass
class ProvenanceCitation:
    marker: int
    target: SteeringTargetSnapshot
    label: str = ""

    @staticmethod
    def _default_label(target: SteeringTargetSnapshot) -> str:
        if target.kind == "atomic":
            return (
                str(target.atomic_text or "").strip()
                or str(target.atomic_id or "").strip()
                or str(target.summary_short_label or "").strip()
                or str(target.summary_id or "").strip()
            )
        return (
            str(target.summary_short_label or "").strip()
            or str(target.summary_text or "").strip()
            or str(target.summary_id or "").strip()
        )

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
            label=str(data.get("label", "") or "").strip() or cls._default_label(target),
        )


@dataclass
class DispatchBatchState:
    dispatch_turn_index: int
    batch_id: str = field(default_factory=lambda: f"batch_{uuid.uuid4().hex[:8]}")
    plan_ids: list[str] = field(default_factory=list)
    status: Literal["dispatched", "waiting_for_stage_summary", "stage_summarized", "no_summary"] = "dispatched"
    stage_summary_emitted: bool = False
    batch_finished_user_response_emitted: bool = False
    stage_summary_markdown: str = ""
    stage_summary_citations: list[ProvenanceCitation] = field(default_factory=list)
    active_plan_ids: list[str] = field(default_factory=list)
    waiting_plan_ids: list[str] = field(default_factory=list)
    stage_synthesis_refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "dispatch_turn_index": self.dispatch_turn_index,
            "plan_ids": self.plan_ids,
            "status": self.status,
            "stage_summary_emitted": self.stage_summary_emitted,
            "batch_finished_user_response_emitted": self.batch_finished_user_response_emitted,
            "stage_summary_markdown": self.stage_summary_markdown,
            "stage_summary_citations": [item.to_dict() for item in self.stage_summary_citations],
            "ordered_plan_ids": list(self.plan_ids),
            "active_plan_ids": list(self.active_plan_ids),
            "waiting_plan_ids": list(self.waiting_plan_ids),
            "batch_status": self.status,
            "stage_synthesis_refs": list(self.stage_synthesis_refs),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "DispatchBatchState | None":
        if not data:
            return None
        raw_status = str(data.get("status", data.get("batch_status", "dispatched")))
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
            batch_id=str(data.get("batch_id", "") or f"batch_{uuid.uuid4().hex[:8]}"),
            dispatch_turn_index=int(data.get("dispatch_turn_index", 0)),
            plan_ids=[
                str(item)
                for item in (
                    data.get("ordered_plan_ids")
                    or data.get("plan_ids", [])
                    or []
                )
            ],
            status=status,
            stage_summary_emitted=bool(data.get("stage_summary_emitted", False)),
            batch_finished_user_response_emitted=bool(
                data.get("batch_finished_user_response_emitted", False)
            ),
            stage_summary_markdown=str(data.get("stage_summary_markdown", "")),
            stage_summary_citations=citations,
            active_plan_ids=[str(item) for item in data.get("active_plan_ids", []) or [] if str(item)],
            waiting_plan_ids=[str(item) for item in data.get("waiting_plan_ids", []) or [] if str(item)],
            stage_synthesis_refs=[str(item) for item in data.get("stage_synthesis_refs", []) or [] if str(item)],
        )

    @property
    def ordered_plan_ids(self) -> list[str]:
        return self.plan_ids

    @ordered_plan_ids.setter
    def ordered_plan_ids(self, value: list[str]) -> None:
        self.plan_ids = list(value)

    @property
    def batch_status(self) -> str:
        return self.status

    @batch_status.setter
    def batch_status(self, value: str) -> None:
        if value in {"dispatched", "waiting_for_stage_summary", "stage_summarized", "no_summary"}:
            self.status = value  # type: ignore[assignment]


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
    control_action: Literal["pause", "terminate"] | None = None
    checkpoint_path: str | None = None
    resume_phase: PlanResumePhase | None = None

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
    contract_version: str = "implementation_v1"
    dataset_info: dict[str, Any] = field(default_factory=dict)
    dataset_schema: str = ""
    step: int = 0
    failure_count: int = 0
    status: RunStatus = "pending"
    settings: RunSettings = field(default_factory=RunSettings)
    steering_state: SteeringState = field(default_factory=SteeringState)
    execution_control_state: ExecutionControlState = field(default_factory=ExecutionControlState)
    master_agent_state: MasterAgentState = field(default_factory=MasterAgentState)
    plans: list[PlanItem] = field(default_factory=list)
    insights: list[Insight] = field(default_factory=list)
    artifacts: list[ArtifactRecord] = field(default_factory=list)
    timeline: list[TimelineEntry] = field(default_factory=list)
    execution_records: list[ExecutionRecord] = field(default_factory=list)
    user_messages: list[UserMessage] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)
    final_summary: str = ""
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict[str, Any]:
        serialized_plans = [plan.to_dict() for plan in self.plans]
        serialized_findings = [insight.to_dict() for insight in self.findings]
        serialized_batches = [batch.to_dict() for batch in self.batches]
        serialized_dataset_metadata = dict(self.dataset_metadata)
        return {
            "contract_version": self.contract_version,
            "run_id": self.run_id,
            "dataset_path": self.dataset_path,
            "dataset_metadata": serialized_dataset_metadata,
            "dataset_info": serialized_dataset_metadata,
            "dataset_schema": self.dataset_schema,
            "step": self.step,
            "failure_count": self.failure_count,
            "status": self.status,
            "settings": self.settings.to_dict(),
            "steering_state": self.steering_state.to_dict(),
            "execution_control_state": self.execution_control_state.to_dict(),
            "master_agent_state": self.master_agent_state.to_dict(),
            "plans": serialized_plans,
            "batches": serialized_batches,
            "findings": serialized_findings,
            "insights": serialized_findings,
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            "timeline": [entry.to_dict() for entry in self.timeline],
            "execution_records": [record.to_dict() for record in self.execution_records],
            "user_messages": [message.to_dict() for message in self.user_messages],
            "turns": [t.to_dict() for t in self.turns],
            "final_summary": self.final_summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunState":
        dataset_metadata = data.get("dataset_metadata", data.get("dataset_info", {})) or {}
        if not isinstance(dataset_metadata, dict):
            dataset_metadata = {}
        raw_batches = data.get("batches")
        if not isinstance(raw_batches, list):
            raw_batches = None
        master_agent_state_payload = data.get("master_agent_state")
        if not isinstance(master_agent_state_payload, dict):
            master_agent_state_payload = {}
        if raw_batches is not None and not master_agent_state_payload.get("dispatch_batches"):
            master_agent_state_payload = {
                **master_agent_state_payload,
                "dispatch_batches": raw_batches,
            }
        return cls(
            run_id=str(data["run_id"]),
            contract_version=str(data.get("contract_version", "implementation_v1")),
            dataset_path=str(data.get("dataset_path", "")),
            dataset_info=dataset_metadata,
            dataset_schema=str(data.get("dataset_schema", "")),
            step=int(data.get("step", 0)),
            failure_count=int(data.get("failure_count", 0)),
            status=data.get("status", "pending"),
            settings=RunSettings.from_dict(data.get("settings")),
            steering_state=SteeringState.from_dict(data.get("steering_state")),
            execution_control_state=ExecutionControlState.from_dict(data.get("execution_control_state")),
            master_agent_state=MasterAgentState.from_dict(master_agent_state_payload),
            plans=[
                PlanItem.from_dict(item)
                for item in (data.get("plans") or data.get("frontier") or [])
            ],
            insights=[
                Insight.from_dict(item)
                for item in (data.get("findings") or data.get("insights", []) or [])
            ],
            artifacts=[
                ArtifactRecord.from_dict(item)
                for item in data.get("artifacts", []) or []
                if isinstance(item, dict)
            ],
            timeline=[
                TimelineEntry.from_dict(item)
                for item in data.get("timeline", []) or []
                if isinstance(item, dict)
            ],
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
        run_id: str | None = None,
    ) -> "RunState":
        state = cls(
            run_id=run_id or generate_run_id(),
            contract_version="implementation_v1",
            dataset_path=dataset_path,
            status="running",
            settings=settings or RunSettings(),
            master_agent_state=MasterAgentState(current_goals=[user_goal]),
        )
        if user_goal.strip():
            state.user_messages.append(UserMessage.create(content=user_goal, kind="chat"))
            state.turns.append(Turn(turn_id=0, goal=user_goal))
        return state

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

    @property
    def findings(self) -> list[Insight]:
        return self.insights

    @findings.setter
    def findings(self, value: list[Insight]) -> None:
        self.insights = list(value)

    @property
    def batches(self) -> list[DispatchBatchState]:
        return self.master_agent_state.dispatch_batches

    @batches.setter
    def batches(self, value: list[DispatchBatchState]) -> None:
        self.master_agent_state.dispatch_batches = list(value)

    @property
    def dataset_metadata(self) -> dict[str, Any]:
        return self.dataset_info

    @dataset_metadata.setter
    def dataset_metadata(self, value: dict[str, Any]) -> None:
        self.dataset_info = value


PlanState = PlanItem
TurnState = Turn
