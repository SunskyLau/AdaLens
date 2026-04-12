from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


_UPLOAD_PREFIX_RE = re.compile(r"^upload_[^_]+__(.+)$")


def _json_normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _json_normalize(item)
            for key, item in sorted(value.items(), key=lambda item: str(item[0]))
        }
    if isinstance(value, list):
        return [_json_normalize(item) for item in value]
    if isinstance(value, tuple):
        return [_json_normalize(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def normalize_dataset_logical_name(dataset_path: str) -> str:
    base_name = Path(str(dataset_path or "")).name or "dataset"
    match = _UPLOAD_PREFIX_RE.match(base_name)
    if match:
        base_name = match.group(1).strip() or base_name
    return base_name


def build_dataset_identity(
    dataset_path: str,
    dataset_info: dict[str, Any] | None = None,
) -> str:
    info = dataset_info if isinstance(dataset_info, dict) else {}
    effective_dataset_path = str(
        dataset_path
        or info.get("dataset_path")
        or ""
    )
    logical_name = normalize_dataset_logical_name(effective_dataset_path)
    payload = {
        "logical_name": logical_name,
        "rows": info.get("rows", 0),
        "delimiter": info.get("delimiter", ""),
        "columns": _json_normalize(info.get("columns", [])),
        "sample_rows": _json_normalize(info.get("sample_rows", [])),
    }
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    return f"ds_{digest}__{logical_name}"


def build_stable_plan_id(index: int) -> str:
    return f"cache_plan_{max(1, int(index)):04d}"


def build_stable_insight_id(index: int) -> str:
    return f"cache_insight_{max(1, int(index)):04d}"


def build_stable_atomic_id(insight_index: int, atomic_index: int) -> str:
    return f"cache_atomic_{max(1, int(insight_index)):04d}_{max(1, int(atomic_index)):04d}"


def _plan_order_map(state: Any) -> dict[str, int]:
    order: dict[str, int] = {}
    for index, plan in enumerate(getattr(state, "plans", []) or [], start=1):
        plan_id = str(getattr(plan, "plan_id", "") or "").strip()
        if plan_id and plan_id not in order:
            order[plan_id] = index
    return order


def _atomic_signature(atomic: Any) -> tuple[Any, ...]:
    return (
        str(getattr(atomic, "insight_type", "") or ""),
        tuple(str(column) for column in (getattr(atomic, "columns", []) or [])),
        tuple(str(keyword) for keyword in (getattr(atomic, "keywords", []) or [])),
        str(getattr(atomic, "text", "") or ""),
    )


def _insight_signature(insight: Any) -> tuple[Any, ...]:
    return (
        str(getattr(insight, "short_label", "") or ""),
        tuple(str(keyword) for keyword in (getattr(insight, "keywords", []) or [])),
        str(getattr(insight, "summary", "") or ""),
        tuple(
            _atomic_signature(atomic)
            for atomic in (getattr(insight, "atomic_insights", []) or [])
        ),
    )


def iter_state_insights_in_stable_order(state: Any) -> list[Any]:
    insights = list(getattr(state, "insights", []) or [])
    plan_order = _plan_order_map(state)

    def sort_key(item: tuple[int, Any]) -> tuple[Any, ...]:
        original_index, insight = item
        plan_id = str(getattr(insight, "plan_id", "") or "").strip()
        plan_rank = plan_order.get(plan_id)
        return (
            0 if plan_rank is not None else 1,
            plan_rank if plan_rank is not None else len(plan_order) + 1,
            plan_id,
            *_insight_signature(insight),
            original_index,
        )

    return [
        insight
        for _, insight in sorted(enumerate(insights), key=sort_key)
    ]


def classify_artifact_kind(path: str) -> str:
    lower = str(path or "").lower()
    if "/plots/" in lower or lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
        return "plot"
    if "/code/" in lower or lower.endswith(".py"):
        return "code"
    return "output"


def replace_string_tokens(value: str, replacements: dict[str, str]) -> str:
    text = str(value)
    if not replacements:
        return text
    for source, target in sorted(
        replacements.items(),
        key=lambda item: len(str(item[0])),
        reverse=True,
    ):
        source_text = str(source or "")
        if not source_text:
            continue
        text = text.replace(source_text, str(target))
    return text


def replace_value_tokens(value: Any, replacements: dict[str, str]) -> Any:
    if not replacements:
        return value
    if isinstance(value, dict):
        return {
            str(key): replace_value_tokens(item, replacements)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [replace_value_tokens(item, replacements) for item in value]
    if isinstance(value, tuple):
        return [replace_value_tokens(item, replacements) for item in value]
    if isinstance(value, str):
        return replace_string_tokens(value, replacements)
    return value


def value_contains_token(value: Any, token: str) -> bool:
    if not token:
        return False
    if isinstance(value, dict):
        return any(value_contains_token(item, token) for item in value.values())
    if isinstance(value, list):
        return any(value_contains_token(item, token) for item in value)
    if isinstance(value, tuple):
        return any(value_contains_token(item, token) for item in value)
    if isinstance(value, str):
        return token in value
    return False


def build_artifact_alias(real_path: str, replacements: dict[str, str]) -> str:
    return replace_string_tokens(str(real_path or ""), replacements)


def _empty_id_bindings() -> dict[str, list[dict[str, str]]]:
    return {
        "plan": [],
        "insight": [],
        "atomic": [],
    }


@dataclass
class CacheNormalizationBindings:
    dataset_identity: str = ""
    id_bindings: dict[str, list[dict[str, str]]] = field(default_factory=_empty_id_bindings)
    artifact_bindings: list[dict[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id_bindings": _json_normalize(self.id_bindings),
            "artifact_bindings": _json_normalize(self.artifact_bindings),
        }
        if self.dataset_identity:
            data["dataset_identity"] = self.dataset_identity
        return data

    def stable_tokens(self) -> set[str]:
        tokens: set[str] = set()
        for items in self.id_bindings.values():
            for item in items:
                stable_id = str(item.get("stable_id", "")).strip()
                if stable_id:
                    tokens.add(stable_id)
        for item in self.artifact_bindings:
            stable_alias = str(item.get("stable_alias", "")).strip()
            if stable_alias:
                tokens.add(stable_alias)
        return tokens

    @classmethod
    def from_dict(cls, data: Any) -> "CacheNormalizationBindings":
        if not isinstance(data, dict):
            return cls()
        raw_id_bindings = data.get("id_bindings")
        id_bindings = _empty_id_bindings()
        if isinstance(raw_id_bindings, dict):
            for kind in ("plan", "insight", "atomic"):
                raw_items = raw_id_bindings.get(kind, [])
                if not isinstance(raw_items, list):
                    continue
                normalized_items: list[dict[str, str]] = []
                for raw_item in raw_items:
                    if not isinstance(raw_item, dict):
                        continue
                    stable_id = str(raw_item.get("stable_id", "")).strip()
                    cached_real_id = str(raw_item.get("cached_real_id", "")).strip()
                    if not stable_id:
                        continue
                    item: dict[str, str] = {"stable_id": stable_id}
                    if cached_real_id:
                        item["cached_real_id"] = cached_real_id
                    normalized_items.append(item)
                id_bindings[kind] = normalized_items
        artifact_bindings: list[dict[str, str]] = []
        raw_artifact_bindings = data.get("artifact_bindings", [])
        if isinstance(raw_artifact_bindings, list):
            for raw_item in raw_artifact_bindings:
                if not isinstance(raw_item, dict):
                    continue
                stable_alias = str(raw_item.get("stable_alias", "")).strip()
                cached_real_path = str(raw_item.get("cached_real_path", "")).strip()
                kind = str(raw_item.get("kind", "")).strip()
                if not stable_alias:
                    continue
                item = {"stable_alias": stable_alias}
                if cached_real_path:
                    item["cached_real_path"] = cached_real_path
                if kind:
                    item["kind"] = kind
                artifact_bindings.append(item)
        return cls(
            dataset_identity=str(data.get("dataset_identity", "")).strip(),
            id_bindings=id_bindings,
            artifact_bindings=artifact_bindings,
        )


@dataclass
class CacheNormalizationContext:
    dataset_identity: str = ""
    request_real_to_stable: dict[str, str] = field(default_factory=dict)
    response_real_to_stable: dict[str, str] = field(default_factory=dict)
    stable_to_real: dict[str, str] = field(default_factory=dict)
    bindings: CacheNormalizationBindings = field(default_factory=CacheNormalizationBindings)

    def normalize_request_value(self, value: Any) -> Any:
        return replace_value_tokens(value, self.request_real_to_stable)

    def normalize_response_value(self, value: Any) -> Any:
        return replace_value_tokens(value, self.response_real_to_stable)

    def rehydrate_cached_value(
        self,
        value: Any,
        bindings: CacheNormalizationBindings | None,
    ) -> Any | None:
        active_bindings = bindings or self.bindings
        for token in sorted(active_bindings.stable_tokens(), key=len, reverse=True):
            if token in self.stable_to_real:
                continue
            if value_contains_token(value, token):
                return None
        return replace_value_tokens(value, self.stable_to_real)


def build_state_id_bindings(state: Any) -> tuple[dict[str, str], dict[str, str], dict[str, list[dict[str, str]]]]:
    real_to_stable: dict[str, str] = {}
    stable_to_real: dict[str, str] = {}
    bindings = _empty_id_bindings()

    plans = getattr(state, "plans", []) or []
    for index, plan in enumerate(plans, start=1):
        real_id = str(getattr(plan, "plan_id", "") or "").strip()
        if not real_id:
            continue
        stable_id = build_stable_plan_id(index)
        real_to_stable[real_id] = stable_id
        stable_to_real[stable_id] = real_id
        bindings["plan"].append(
            {"stable_id": stable_id, "cached_real_id": real_id}
        )

    insights = iter_state_insights_in_stable_order(state)
    for insight_index, insight in enumerate(insights, start=1):
        real_id = str(getattr(insight, "insight_id", "") or "").strip()
        stable_id = build_stable_insight_id(insight_index)
        if real_id:
            real_to_stable[real_id] = stable_id
            stable_to_real[stable_id] = real_id
            bindings["insight"].append(
                {"stable_id": stable_id, "cached_real_id": real_id}
            )
        atomic_items = getattr(insight, "atomic_insights", []) or []
        for atomic_index, atomic in enumerate(atomic_items, start=1):
            atomic_real_id = str(getattr(atomic, "atomic_id", "") or "").strip()
            if not atomic_real_id:
                continue
            atomic_stable_id = build_stable_atomic_id(insight_index, atomic_index)
            real_to_stable[atomic_real_id] = atomic_stable_id
            stable_to_real[atomic_stable_id] = atomic_real_id
            bindings["atomic"].append(
                {"stable_id": atomic_stable_id, "cached_real_id": atomic_real_id}
            )

    return real_to_stable, stable_to_real, bindings


def build_single_plan_bindings(plan_id: str) -> tuple[dict[str, str], dict[str, str], dict[str, list[dict[str, str]]]]:
    real_id = str(plan_id or "").strip()
    bindings = _empty_id_bindings()
    if not real_id:
        return {}, {}, bindings
    stable_id = build_stable_plan_id(1)
    bindings["plan"].append({"stable_id": stable_id, "cached_real_id": real_id})
    return {real_id: stable_id}, {stable_id: real_id}, bindings


def build_artifact_bindings(
    *,
    real_paths: Iterable[str],
    real_to_stable: dict[str, str],
) -> tuple[dict[str, str], dict[str, str], list[dict[str, str]]]:
    real_to_alias: dict[str, str] = {}
    alias_to_real: dict[str, str] = {}
    bindings: list[dict[str, str]] = []
    for raw_path in real_paths:
        real_path = str(raw_path or "").strip()
        if not real_path or real_path in real_to_alias:
            continue
        stable_alias = build_artifact_alias(real_path, real_to_stable)
        if not stable_alias or stable_alias == real_path:
            continue
        real_to_alias[real_path] = stable_alias
        alias_to_real[stable_alias] = real_path
        bindings.append(
            {
                "stable_alias": stable_alias,
                "cached_real_path": real_path,
                "kind": classify_artifact_kind(real_path),
            }
        )
    return real_to_alias, alias_to_real, bindings


def build_master_cache_normalization_context(state: Any) -> CacheNormalizationContext:
    dataset_path = str(getattr(state, "dataset_path", "") or "")
    dataset_info = getattr(state, "dataset_info", {}) or {}
    dataset_identity = build_dataset_identity(dataset_path, dataset_info)
    real_to_stable, stable_to_real, id_bindings = build_state_id_bindings(state)
    request_real_to_stable = dict(real_to_stable)
    if dataset_path:
        request_real_to_stable[dataset_path] = dataset_identity
    return CacheNormalizationContext(
        dataset_identity=dataset_identity,
        request_real_to_stable=request_real_to_stable,
        response_real_to_stable=dict(real_to_stable),
        stable_to_real=dict(stable_to_real),
        bindings=CacheNormalizationBindings(
            dataset_identity=dataset_identity,
            id_bindings=id_bindings,
            artifact_bindings=[],
        ),
    )


def build_analyzer_cache_normalization_context(
    *,
    state: Any,
    plan_id: str,
    artifact_paths: Iterable[str] | None = None,
) -> CacheNormalizationContext:
    dataset_path = str(getattr(state, "dataset_path", "") or "")
    dataset_info = getattr(state, "dataset_info", {}) or {}
    dataset_identity = build_dataset_identity(dataset_path, dataset_info)
    real_to_stable, stable_to_real, id_bindings = build_single_plan_bindings(plan_id)
    artifact_real_to_alias: dict[str, str] = {}
    artifact_alias_to_real: dict[str, str] = {}
    artifact_bindings: list[dict[str, str]] = []
    if artifact_paths is not None:
        (
            artifact_real_to_alias,
            artifact_alias_to_real,
            artifact_bindings,
        ) = build_artifact_bindings(
            real_paths=artifact_paths,
            real_to_stable=real_to_stable,
        )
    request_real_to_stable = {
        **real_to_stable,
        **artifact_real_to_alias,
    }
    if dataset_path:
        request_real_to_stable[dataset_path] = dataset_identity
    return CacheNormalizationContext(
        dataset_identity=dataset_identity,
        request_real_to_stable=request_real_to_stable,
        response_real_to_stable={
            **real_to_stable,
            **artifact_real_to_alias,
        },
        stable_to_real={
            **stable_to_real,
            **artifact_alias_to_real,
        },
        bindings=CacheNormalizationBindings(
            dataset_identity=dataset_identity,
            id_bindings=id_bindings,
            artifact_bindings=artifact_bindings,
        ),
    )


def build_summarizer_cache_normalization_context(
    *,
    plan_id: str,
    dataset_path: str,
    dataset_info: dict[str, Any] | None = None,
    artifact_paths: Iterable[str] | None = None,
) -> CacheNormalizationContext:
    dataset_identity = build_dataset_identity(dataset_path, dataset_info)
    real_to_stable, stable_to_real, id_bindings = build_single_plan_bindings(plan_id)
    artifact_real_to_alias, artifact_alias_to_real, artifact_bindings = build_artifact_bindings(
        real_paths=artifact_paths or [],
        real_to_stable=real_to_stable,
    )
    return CacheNormalizationContext(
        dataset_identity=dataset_identity,
        request_real_to_stable={
            **real_to_stable,
            **artifact_real_to_alias,
        },
        response_real_to_stable={
            **real_to_stable,
            **artifact_real_to_alias,
        },
        stable_to_real={
            **stable_to_real,
            **artifact_alias_to_real,
        },
        bindings=CacheNormalizationBindings(
            dataset_identity=dataset_identity,
            id_bindings=id_bindings,
            artifact_bindings=artifact_bindings,
        ),
    )
