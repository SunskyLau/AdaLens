"""
Importance calculation module for atomic insights.

This module computes interest/significance/impact for each atomic insight.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from cache_normalization import build_summarizer_cache_normalization_context  # noqa: E402
from model_cache import (  # noqa: E402
    build_model_cache_run_context,
    consume_last_model_cache_binding,
    use_model_cache_normalization_context,
    use_model_cache_run_context,
)

from .language_context import canonical_user_message_text, latest_user_authored_text
from .models import AtomicInsight, InsightType, PlanItem, normalize_steering_message_kind
from config import (
    create_chat_completion_with_sampling_controls,
    IMPORTANCE_WEIGHT_IMPACT,
    IMPORTANCE_WEIGHT_INTEREST,
    IMPORTANCE_WEIGHT_SIGNIFICANCE,
    LLM_MAX_TOKENS,
    LLM_TIMEOUT_SECS,
    OPENAI_API_KEY,
    OPENAI_CLIENT,
    SUMMARIZER_MODEL_NAME,
)

if TYPE_CHECKING:
    from .store import RunStore


DEFAULT_INTEREST_FALLBACK_SCORE = 0.5
DEFAULT_SIGNIFICANCE_FALLBACK_SCORE = 0.5
SIGNIFICANCE_MISSING_OUTPUT_FALLBACK_SCORE = 0.30
DEFAULT_IMPACT_FALLBACK_SCORE = 0.10
IMPACT_EMPTY_CONTEXT_FALLBACK_SCORE = 0.08
OUTPUT_TEXT_MAX_CHARS = 6000
CODE_TEXT_MAX_CHARS = 6000
NUMBER_PATTERN = r"[-+]?\d*\.?\d+(?:e[-+]?\d+)?"

TYPE_SIGNIFICANCE_FALLBACKS: Dict[InsightType, float] = {
    "value": 0.42,
    "proportion": 0.46,
    "rank": 0.40,
    "difference": 0.52,
    "trend": 0.50,
    "distribution": 0.45,
    "association": 0.53,
    "outlier": 0.58,
    "extreme": 0.60,
    "cluster": 0.49,
    "data_quality": 0.62,
}

_METRICS_STEERING_KINDS = {"focus", "ignore", "elaborate", "create"}


def _latest_metrics_language_text(user_messages: list[Any] | None) -> str:
    if not user_messages:
        return ""

    latest_chat_text = ""
    for message in reversed(list(user_messages)):
        text = canonical_user_message_text(message)
        if not text:
            continue
        kind = normalize_steering_message_kind(getattr(message, "kind", None))
        if kind in _METRICS_STEERING_KINDS:
            return text
        if not latest_chat_text and kind == "chat":
            latest_chat_text = text
    return latest_chat_text

INSIGHT_TYPE_SIGNIFICANCE_HINTS: Dict[InsightType, str] = {
    "value": (
        "Focus on whether the reported value is statistically reliable. Prefer p-value, confidence interval, "
        "z/t/f statistics, and sample size."
    ),
    "proportion": (
        "Assess reliability of a proportion/rate estimate. Prefer p-value, CI width, denominator/sample size, "
        "and absolute proportion deltas."
    ),
    "rank": (
        "Assess if rank/ordering is stable and meaningful. Prefer percentile, rank-gap statistics, p-value, "
        "and supporting sample size."
    ),
    "difference": (
        "Assess group-difference evidence. Prefer p-value, effect-size (delta/cohen's d), CI and sample size."
    ),
    "trend": (
        "Assess trend robustness. Prefer slope/beta, correlation (r/r2), p-value, and sample size/time-window support."
    ),
    "distribution": (
        "Assess distribution-shape claim strength. Prefer chi-square/KS-like stats, z-like statistics, p-value, and sample size."
    ),
    "association": (
        "Assess association/correlation strength and reliability. Prefer r/r2/chi2, p-value, and sample size."
    ),
    "outlier": (
        "Assess anomaly evidence quality. Prefer z-score, percentile tail position, outlier-rate, and population size."
    ),
    "extreme": (
        "Assess extremeness confidence. Prefer percentile tail metrics, z-like score, delta from baseline, and sample size."
    ),
    "cluster": (
        "Assess clustering validity. Prefer silhouette, Davies-Bouldin, Calinski-Harabasz, plus cluster sample size."
    ),
    "data_quality": (
        "Assess data-quality issue severity and statistical support. Prefer missing/duplicate/outlier rates and sample size."
    ),
}


def _clamp_score(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 2)


def _safe_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str):
        match = re.search(NUMBER_PATTERN, value.strip(), flags=re.IGNORECASE)
        if not match:
            return None
        try:
            number = float(match.group(0))
        except Exception:
            return None
        return number if math.isfinite(number) else None
    return None


def _normalize_response_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks: List[str] = []
        for part in content:
            if isinstance(part, str) and part.strip():
                chunks.append(part.strip())
                continue
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        return "\n".join(chunks).strip()
    return str(content or "").strip()


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    try:
        data = json.loads(cleaned)
    except Exception:
        data = None
    if isinstance(data, dict):
        return data

    decoder = json.JSONDecoder()
    i = 0
    while i < len(cleaned):
        j = cleaned.find("{", i)
        if j < 0:
            break
        try:
            obj, end = decoder.raw_decode(cleaned[j:])
        except json.JSONDecodeError:
            i = j + 1
            continue
        i = j + end
        if isinstance(obj, dict):
            return obj
    return None


def _resolve_run_output_path(store: Optional["RunStore"], output_path: str) -> Optional[Path]:
    if store is None or not output_path:
        return None
    run_dir_raw = getattr(store, "run_dir", None)
    if run_dir_raw is None:
        return None
    run_dir = Path(run_dir_raw).resolve()
    try:
        full_path = (run_dir / output_path).resolve()
        full_path.relative_to(run_dir)
    except Exception:
        return None
    if not full_path.exists() or not full_path.is_file():
        return None
    return full_path


def _read_atomic_output_text(
    atomic: AtomicInsight,
    store: Optional["RunStore"],
    max_chars: int = OUTPUT_TEXT_MAX_CHARS,
) -> str:
    evidence = getattr(atomic, "evidence", None)
    output_path = ""
    if evidence is not None:
        output_path = str(getattr(evidence, "output_path", "") or "").strip()
    if not output_path:
        return ""
    full_path = _resolve_run_output_path(store, output_path)
    if full_path is None:
        return ""
    try:
        text = full_path.read_text(encoding="utf-8", errors="ignore").strip()
    except Exception:
        return ""
    return text[:max_chars] if text else ""


def _read_atomic_code_text(
    atomic: AtomicInsight,
    store: Optional["RunStore"],
    max_chars: int = CODE_TEXT_MAX_CHARS,
) -> str:
    evidence = getattr(atomic, "evidence", None)
    code_path = ""
    if evidence is not None:
        code_path = str(getattr(evidence, "code_path", "") or "").strip()
    if not code_path:
        return ""
    full_path = _resolve_run_output_path(store, code_path)
    if full_path is None:
        return ""
    try:
        text = full_path.read_text(encoding="utf-8", errors="ignore").strip()
    except Exception:
        return ""
    return text[:max_chars] if text else ""


def _read_dataset_schema_text(store: Optional["RunStore"]) -> str:
    if store is None:
        return ""
    try:
        state = store.load_state()
    except Exception:
        return ""
    if state is None:
        return ""
    schema = str(getattr(state, "dataset_schema", "") or "").strip()
    if schema:
        return schema
    return str(getattr(state, "dataset_info", "") or "").strip()


def _extract_table_shape(dataset_schema: str) -> tuple[Optional[int], Optional[int]]:
    text = (dataset_schema or "").strip()
    if not text:
        return None, None
    m = re.search(r"Shape:\s*(\d+)\s*rows?\s*,\s*(\d+)\s*columns?", text, flags=re.IGNORECASE)
    if not m:
        return None, None
    try:
        rows = int(m.group(1))
        cols = int(m.group(2))
    except Exception:
        return None, None
    if rows <= 0 or cols <= 0:
        return None, None
    return rows, cols


def _extract_first_number(text: str, patterns: List[str], percent_to_ratio: bool = False) -> Optional[float]:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        value = _safe_float(match.group(1))
        if value is None:
            continue
        if percent_to_ratio or "%" in match.group(0):
            if value > 1:
                value /= 100.0
        return value
    return None


def _extract_p_value(text: str) -> Optional[float]:
    match = re.search(rf"\bp(?:-value)?\s*(<=|>=|=|<|>|:)\s*({NUMBER_PATTERN})", text, flags=re.IGNORECASE)
    if not match:
        return None
    value = _safe_float(match.group(2))
    if value is None:
        return None
    op = match.group(1)
    if op in ("<", "<="):
        value *= 0.95
    elif op in (">", ">="):
        value *= 1.05
    return max(0.0, min(1.0, value))


def _extract_ci_bounds(text: str) -> tuple[Optional[float], Optional[float]]:
    patterns = [
        rf"(?:95%?\s*ci|confidence interval)\s*[:=]?\s*[\[\(]?\s*({NUMBER_PATTERN})\s*[,，]\s*({NUMBER_PATTERN})",
        rf"(?:95%?\s*ci|confidence interval)\s*[:=]?\s*({NUMBER_PATTERN})\s*(?:to|-)\s*({NUMBER_PATTERN})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if not m:
            continue
        low = _safe_float(m.group(1))
        high = _safe_float(m.group(2))
        if low is None or high is None:
            continue
        if high < low:
            low, high = high, low
        return low, high
    return None, None


def _extract_direct_stats(output_text: str) -> Dict[str, float]:
    if not output_text.strip():
        return {}
    text = output_text
    stats: Dict[str, float] = {}

    p_value = _extract_p_value(text)
    if p_value is not None:
        stats["p"] = p_value

    extractors: Dict[str, List[str]] = {
        "r2": [rf"\br\s*[\^²]?\s*2\s*(?:=|:)\s*({NUMBER_PATTERN})", rf"\br-?squared\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "r": [rf"\br(?!\s*[\^²]?\s*2)\s*(?:=|:)\s*({NUMBER_PATTERN})", rf"\bcorrelation(?:\s+coefficient)?\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "z": [rf"\bz(?:\s*score)?\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "t": [rf"\bt(?:\s*\([^)]+\))?\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "f": [rf"\bf(?:\s*\([^)]+\))?\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "chi2": [rf"(?:chi[- ]?square|chi2|χ2|χ²)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "n": [rf"\bn\s*(?:=|:)\s*(\d+)\b", rf"\bsample size\s*(?:=|:)\s*(\d+)\b", rf"\b(\d+)\s+samples?\b"],
        "percentile": [rf"({NUMBER_PATTERN})\s*(?:th)?\s*percentile"],
        "effect_size": [rf"(?:effect size|cohen'?s d|eta(?:\s*squared)?|odds ratio)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "delta": [rf"(?:delta|difference|diff|change|lift)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "slope": [rf"(?:slope|trend coefficient|beta)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "missing_rate": [rf"(?:missing(?:ness)?(?: rate| ratio| proportion)?|null(?: rate)?|nan(?: rate)?)\s*(?:=|:)\s*({NUMBER_PATTERN})\s*%?"],
        "duplicate_rate": [rf"(?:duplicate(?:s)?(?: rate| ratio| proportion)?)\s*(?:=|:)\s*({NUMBER_PATTERN})\s*%?"],
        "outlier_rate": [rf"(?:outlier(?:s)?(?: rate| ratio| proportion)?|anomaly(?: rate| ratio)?)\s*(?:=|:)\s*({NUMBER_PATTERN})\s*%?"],
        "silhouette": [rf"(?:silhouette(?: score)?)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "dbi": [rf"(?:davies[- ]?bouldin(?: index)?|dbi)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
        "ch": [rf"(?:calinski[- ]?harabasz(?: score| index)?|ch(?: index)?)\s*(?:=|:)\s*({NUMBER_PATTERN})"],
    }

    for key, patterns in extractors.items():
        value = _extract_first_number(text, patterns, percent_to_ratio=key.endswith("_rate") or key.endswith("_ratio"))
        if value is None:
            continue
        if key == "percentile" and value <= 1:
            value *= 100.0
        stats[key] = value

    ci_low, ci_high = _extract_ci_bounds(text)
    if ci_low is not None and ci_high is not None:
        stats["ci_low"] = ci_low
        stats["ci_high"] = ci_high
        stats["ci_width"] = abs(ci_high - ci_low)

    return stats


def _normalize_stat_value(key: str, value: Any) -> Optional[float]:
    if isinstance(value, dict):
        for nested_key in ("value", "stat", "score", "raw"):
            if nested_key in value:
                return _normalize_stat_value(key, value[nested_key])
        return None
    number = _safe_float(value)
    if number is None:
        return None
    lowered = key.lower()
    if lowered == "percentile" and number <= 1:
        number *= 100.0
    elif lowered.endswith("_rate") or lowered.endswith("_ratio"):
        if number > 1:
            number /= 100.0
    return number if math.isfinite(number) else None


def _normalize_stats_dict(raw: Any) -> Dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    normalized: Dict[str, float] = {}
    for key, value in raw.items():
        key_str = str(key).strip().lower()
        if not key_str:
            continue
        number = _normalize_stat_value(key_str, value)
        if number is None:
            continue
        normalized[key_str] = number
    return normalized


def _stat_value(key: str, direct_stats: Dict[str, float], llm_stats: Dict[str, float]) -> Optional[float]:
    if key in direct_stats:
        value = _safe_float(direct_stats.get(key))
        if value is not None:
            return value
    return _safe_float(llm_stats.get(key))


def _weighted_average(parts: List[tuple[Optional[float], float]], default: float) -> float:
    total = 0.0
    total_weight = 0.0
    for value, weight in parts:
        if value is None or weight <= 0:
            continue
        total += value * weight
        total_weight += weight
    if total_weight <= 0:
        return default
    return total / total_weight


def _score_from_p_value(p_value: Optional[float]) -> Optional[float]:
    if p_value is None:
        return None
    p_value = max(0.0, min(1.0, p_value))
    if p_value <= 0.001:
        return 1.0
    if p_value <= 0.01:
        return 0.92
    if p_value <= 0.05:
        return 0.80
    if p_value <= 0.10:
        return 0.62
    if p_value <= 0.20:
        return 0.44
    if p_value <= 0.50:
        return 0.24
    return 0.10


def _score_from_abs_stat(value: Optional[float], full_score_at: float) -> Optional[float]:
    if value is None:
        return None
    return max(0.0, min(1.0, abs(value) / max(1e-6, full_score_at)))


def _score_from_sample_size(n_value: Optional[float]) -> Optional[float]:
    if n_value is None or n_value <= 0:
        return None
    return max(0.0, min(1.0, math.log10(n_value + 1) / 3.0))


def _score_from_percentile(percentile: Optional[float]) -> Optional[float]:
    if percentile is None:
        return None
    p = percentile * 100.0 if percentile <= 1 else percentile
    p = max(0.0, min(100.0, p))
    return max(0.0, min(1.0, abs(p - 50.0) / 50.0))


def _score_from_ci_width(ci_width: Optional[float]) -> Optional[float]:
    if ci_width is None:
        return None
    return max(0.0, min(1.0, 1.0 - min(1.0, abs(ci_width))))


def _score_from_effect_size(effect_size: Optional[float], full_score_at: float = 1.0) -> Optional[float]:
    if effect_size is None:
        return None
    return max(0.0, min(1.0, abs(effect_size) / max(1e-6, full_score_at)))


def _sig_value(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["value"]
    try:
        strength = max(abs(_stat_value("z", direct_stats, llm_stats) or 0.0), abs(_stat_value("t", direct_stats, llm_stats) or 0.0), abs(_stat_value("f", direct_stats, llm_stats) or 0.0) / 4.0)
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.34), (_score_from_abs_stat(strength, 3.0), 0.28), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.20), (_score_from_ci_width(_stat_value("ci_width", direct_stats, llm_stats)), 0.18), (score_hint, 0.12)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_proportion(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["proportion"]
    try:
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.34), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.26), (_score_from_ci_width(_stat_value("ci_width", direct_stats, llm_stats)), 0.20), (_score_from_effect_size(_stat_value("delta", direct_stats, llm_stats), 0.35), 0.20), (score_hint, 0.12)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_rank(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["rank"]
    try:
        return _clamp_score(_weighted_average([(_score_from_percentile(_stat_value("percentile", direct_stats, llm_stats)), 0.44), (_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.26), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.20), (score_hint, 0.10)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_difference(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["difference"]
    try:
        effect_strength = max(abs(_stat_value("delta", direct_stats, llm_stats) or 0.0), abs(_stat_value("effect_size", direct_stats, llm_stats) or 0.0))
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.34), (_score_from_effect_size(effect_strength, 0.8), 0.34), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.22), (score_hint, 0.10)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_trend(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["trend"]
    try:
        trend_strength = max(abs(_stat_value("slope", direct_stats, llm_stats) or 0.0), abs(_stat_value("r", direct_stats, llm_stats) or 0.0), math.sqrt(max(0.0, _stat_value("r2", direct_stats, llm_stats) or 0.0)))
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.30), (_score_from_effect_size(trend_strength, 0.9), 0.38), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.20), (score_hint, 0.12)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_distribution(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["distribution"]
    try:
        shape_strength = max(abs(_stat_value("chi2", direct_stats, llm_stats) or 0.0) / 10.0, abs(_stat_value("z", direct_stats, llm_stats) or 0.0))
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.30), (_score_from_abs_stat(shape_strength, 2.5), 0.36), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.22), (score_hint, 0.12)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_association(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["association"]
    try:
        assoc_strength = max(abs(_stat_value("r", direct_stats, llm_stats) or 0.0), math.sqrt(max(0.0, _stat_value("r2", direct_stats, llm_stats) or 0.0)))
        chi_strength = abs(_stat_value("chi2", direct_stats, llm_stats) or 0.0) / 10.0
        return _clamp_score(_weighted_average([(_score_from_p_value(_stat_value("p", direct_stats, llm_stats)), 0.30), (_score_from_effect_size(assoc_strength, 0.8), 0.34), (_score_from_abs_stat(chi_strength, 2.0), 0.16), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.20), (score_hint, 0.12)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_outlier(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["outlier"]
    try:
        return _clamp_score(_weighted_average([(_score_from_abs_stat(_stat_value("z", direct_stats, llm_stats), 4.0), 0.38), (_score_from_percentile(_stat_value("percentile", direct_stats, llm_stats)), 0.30), (_score_from_effect_size(_stat_value("outlier_rate", direct_stats, llm_stats), 0.2), 0.14), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.18), (score_hint, 0.10)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_extreme(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["extreme"]
    try:
        return _clamp_score(_weighted_average([(_score_from_percentile(_stat_value("percentile", direct_stats, llm_stats)), 0.44), (_score_from_effect_size(_stat_value("delta", direct_stats, llm_stats), 1.0), 0.24), (_score_from_abs_stat(_stat_value("z", direct_stats, llm_stats), 4.0), 0.16), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.16), (score_hint, 0.10)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_cluster(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["cluster"]
    try:
        sil = _stat_value("silhouette", direct_stats, llm_stats)
        dbi = _stat_value("dbi", direct_stats, llm_stats)
        ch = _stat_value("ch", direct_stats, llm_stats)
        sil_score = None if sil is None else max(0.0, min(1.0, (sil + 1.0) / 2.0))
        dbi_score = None if dbi is None else max(0.0, min(1.0, 1.0 - min(1.0, dbi / 3.0)))
        ch_score = None if ch is None else max(0.0, min(1.0, math.log10(ch + 1.0) / 3.0))
        return _clamp_score(_weighted_average([(sil_score, 0.40), (dbi_score, 0.22), (ch_score, 0.18), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.20), (score_hint, 0.10)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


def _sig_data_quality(direct_stats: Dict[str, float], llm_stats: Dict[str, float], score_hint: Optional[float]) -> float:
    fallback = TYPE_SIGNIFICANCE_FALLBACKS["data_quality"]
    try:
        rates = [value for value in [_stat_value("missing_rate", direct_stats, llm_stats), _stat_value("duplicate_rate", direct_stats, llm_stats), _stat_value("outlier_rate", direct_stats, llm_stats)] if value is not None]
        severity = max(rates) if rates else None
        if severity is not None:
            severity = max(0.0, min(1.0, severity))
        return _clamp_score(_weighted_average([(severity, 0.58), (_score_from_sample_size(_stat_value("n", direct_stats, llm_stats)), 0.24), (score_hint, 0.18)], score_hint if score_hint is not None else fallback))
    except Exception:
        return fallback


SIGNIFICANCE_BY_TYPE: Dict[InsightType, Callable[[Dict[str, float], Dict[str, float], Optional[float]], float]] = {
    "value": _sig_value,
    "proportion": _sig_proportion,
    "rank": _sig_rank,
    "difference": _sig_difference,
    "trend": _sig_trend,
    "distribution": _sig_distribution,
    "association": _sig_association,
    "outlier": _sig_outlier,
    "extreme": _sig_extreme,
    "cluster": _sig_cluster,
    "data_quality": _sig_data_quality,
}


def _calculate_significance_by_type(
    insight_type: InsightType,
    direct_stats: Dict[str, float],
    llm_stats: Dict[str, float],
    score_hint: Optional[float],
    output_text: str,
) -> float:
    if not (output_text or "").strip():
        return _clamp_score(SIGNIFICANCE_MISSING_OUTPUT_FALLBACK_SCORE)
    scorer = SIGNIFICANCE_BY_TYPE.get(insight_type)
    if scorer is None:
        return _clamp_score(DEFAULT_SIGNIFICANCE_FALLBACK_SCORE)
    return _clamp_score(scorer(direct_stats, llm_stats, score_hint))


def _build_metrics_prompts(
    atomic: AtomicInsight,
    plan: PlanItem,
    dataset_schema: str,
    code_text: str,
    output_text: str,
    direct_stats: Dict[str, float],
    latest_user_text: str = "",
) -> tuple[str, str]:
    type_hint = INSIGHT_TYPE_SIGNIFICANCE_HINTS.get(
        atomic.insight_type,
        "Assess significance only from evidence output text and extracted numeric support.",
    )
    rows_total, cols_total = _extract_table_shape(dataset_schema)
    evidence_output_path = str(getattr(getattr(atomic, "evidence", None), "output_path", "") or "").strip()
    evidence_code_path = str(getattr(getattr(atomic, "evidence", None), "code_path", "") or "").strip()
    has_output_text = "yes" if (output_text or "").strip() else "no"
    has_code_text = "yes" if (code_text or "").strip() else "no"

    system_prompt = (
        "You are an expert judge for atomic data-analysis insights.\n"
        "Match any natural-language note fields you generate to the user's language, using the "
        "latest user-authored message provided below.\n"
        "Keep JSON keys and schema fields in English. Return ONLY one strict JSON object. No markdown, no prose.\n\n"
        "Output schema (required keys):\n"
        "{\n"
        '  "interest": {\n'
        '    "score": 0.00,\n'
        '    "notes": "short note grounded in atomic text + task"\n'
        "  },\n"
        '  "significance": {\n'
        '    "score_hint": 0.00,\n'
        '    "stats": {\n'
        '      "p": 0.00,\n'
        '      "r": 0.00,\n'
        '      "r2": 0.00,\n'
        '      "z": 0.00,\n'
        '      "t": 0.00,\n'
        '      "f": 0.00,\n'
        '      "chi2": 0.00,\n'
        '      "n": 0,\n'
        '      "ci_low": 0.00,\n'
        '      "ci_high": 0.00,\n'
        '      "ci_width": 0.00,\n'
        '      "percentile": 0.00,\n'
        '      "effect_size": 0.00,\n'
        '      "delta": 0.00,\n'
        '      "slope": 0.00,\n'
        '      "missing_rate": 0.00,\n'
        '      "duplicate_rate": 0.00,\n'
        '      "outlier_rate": 0.00,\n'
        '      "silhouette": 0.00,\n'
        '      "dbi": 0.00,\n'
        '      "ch": 0.00\n'
        "    },\n"
        '    "notes": "short explanation referencing only evidence output text"\n'
        "  },\n"
        '  "impact": {\n'
        '    "score": 0.00,\n'
        '    "rows_ratio": 0.00,\n'
        '    "columns_ratio": 0.00,\n'
        '    "scope": {\n'
        '      "rows_touched": 0,\n'
        '      "columns_touched": 0,\n'
        '      "cell_fraction": 0.00\n'
        "    },\n"
        '    "notes": "how data scope was inferred from code + schema"\n'
        "  }\n"
        "}\n\n"
        "Hard constraints:\n"
        "1) All scores in [0,1], two decimals.\n"
        "2) significance.stats MUST come directly or indirectly from provided evidence output text only.\n"
        "3) Never fabricate unsupported statistics. Omit unknown stats from the stats object.\n"
        "4) If evidence output text is empty/insufficient, set significance.score_hint=0.30 and stats={}.\n"
        "5) impact means table-cell coverage ratio: (rows_ratio * columns_ratio), bounded to [0,1].\n"
        "6) impact inference MUST use dataset schema + atomic text + evidence code context; do not invent hidden data.\n\n"
        "Interest scoring rubric (must remain strict):\n"
        "- Semantic interestingness: how surprising/non-obvious.\n"
        "- Task relevance: alignment with analysis task.\n"
        "- Information richness: actionable quantitative content.\n"
        "- Contextual significance: importance in dataset context.\n"
        "Calibrate honestly:\n"
        "- 0.00-0.30 trivial/expected;\n"
        "- 0.31-0.60 useful but ordinary;\n"
        "- 0.61-0.80 insightful/surprising;\n"
        "- 0.81-1.00 highly novel/high-value.\n\n"
        "Significance instructions:\n"
        "- Use insight-type-specific statistical reasoning.\n"
        "- Prefer direct numeric evidence: p/r/r2/z/t/f/chi2/CI/n/percentile/effect-size/rates.\n"
        "- Favor well-supported, replicable evidence over narrative tone.\n"
        "- If extracted stats conflict, prefer the most explicit values from output text.\n"
        "\nImpact instructions (critical):\n"
        "- Read evidence code and identify data scope touched by the insight.\n"
        "- Infer rows_ratio from explicit filters/slices/conditions/group subsets in code.\n"
        "- Infer columns_ratio from selected/used columns supporting this atomic insight.\n"
        "- If code shows no row filtering, rows_ratio can be 1.0.\n"
        "- If ratio is uncertain but inferable, provide a conservative estimate and explain in notes.\n"
        "- If code/schema is missing and cannot infer scope, return impact.score=0.10 with clear uncertainty notes.\n"
    )
    user_prompt = (
        "Evaluation context:\n"
        "Latest user-authored message for language matching:\n"
        f"{latest_user_text or '<none provided>'}\n"
        f"- Atomic insight text: {atomic.text.strip()}\n"
        f"- Insight type: {atomic.insight_type}\n"
        f"- Related columns: {json.dumps(atomic.columns, ensure_ascii=False)}\n"
        f"- Analysis task: {plan.text.strip()}\n"
        f"- Dataset schema:\n{dataset_schema or '<none>'}\n"
        f"- Parsed table shape: rows={rows_total if rows_total is not None else '<unknown>'}, "
        f"columns={cols_total if cols_total is not None else '<unknown>'}\n"
        f"- Evidence code_path: {evidence_code_path or '<none>'}\n"
        f"- Evidence code text available: {has_code_text}\n"
        f"- Evidence output_path: {evidence_output_path or '<none>'}\n"
        f"- Evidence output text available: {has_output_text}\n\n"
        "Type-specific significance guidance:\n"
        f"{type_hint}\n\n"
        "Evidence code excerpt (authoritative source for data-scope/impact):\n"
        f"{code_text}\n\n"
        "Direct stats extracted before model call (higher-trust anchors):\n"
        f"{json.dumps(direct_stats, ensure_ascii=False)}\n\n"
        "Evidence output_text excerpt (authoritative source for significance stats):\n"
        f"{output_text}\n\n"
        "Return only the JSON object described in the schema."
    )
    return system_prompt, user_prompt


def _build_metrics_cache_context(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"],
) -> tuple[Any, Any]:
    run_context = build_model_cache_run_context(getattr(store, "run_dir", None))
    dataset_path = ""
    dataset_info: Dict[str, Any] | None = None
    if store is not None:
        try:
            state = store.load_state()
        except Exception:
            state = None
        if state is not None:
            dataset_path = str(getattr(state, "dataset_path", "") or "")
            raw_dataset_info = getattr(state, "dataset_info", None)
            if isinstance(raw_dataset_info, dict):
                dataset_info = raw_dataset_info
    evidence = getattr(atomic, "evidence", None)
    artifact_paths = [
        str(getattr(evidence, field_name, "") or "").strip()
        for field_name in ("code_path", "output_path", "plot_path")
        if str(getattr(evidence, field_name, "") or "").strip()
    ]
    normalization_context = build_summarizer_cache_normalization_context(
        plan_id=plan.plan_id,
        dataset_path=dataset_path,
        dataset_info=dataset_info,
        artifact_paths=artifact_paths,
    )
    return run_context, normalization_context


def _call_llm_metrics_once(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"],
    dataset_schema: str,
    code_text: str,
    output_text: str,
    direct_stats: Dict[str, float],
    latest_user_text: str = "",
) -> Optional[Dict[str, Any]]:
    if OPENAI_CLIENT is None or not OPENAI_API_KEY:
        return None
    system_prompt, user_prompt = _build_metrics_prompts(
        atomic,
        plan,
        dataset_schema,
        code_text,
        output_text,
        direct_stats,
        latest_user_text,
    )
    try:
        params: Dict[str, Any] = {
            "model": SUMMARIZER_MODEL_NAME,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [{"type": "text", "text": user_prompt}]},
            ],
            "response_format": {"type": "json_object"},
        }
        if LLM_MAX_TOKENS:
            params["max_tokens"] = LLM_MAX_TOKENS
        if LLM_TIMEOUT_SECS:
            params["timeout"] = LLM_TIMEOUT_SECS
        run_context, normalization_context = _build_metrics_cache_context(
            atomic,
            plan,
            store,
        )
        with use_model_cache_run_context(run_context):
            with use_model_cache_normalization_context(normalization_context):
                consume_last_model_cache_binding()
                response = create_chat_completion_with_sampling_controls(
                    OPENAI_CLIENT,
                    params=params,
                    temperature=0.1,
                )
                consume_last_model_cache_binding()
        return _extract_json_object(_normalize_response_text(response.choices[0].message.content))
    except Exception as exc:
        print(f"[IMPORTANCE] LLM metrics call failed; using fallbacks. error={exc}")
        return None


def _extract_interest_from_payload(payload: Optional[Dict[str, Any]]) -> float:
    if not isinstance(payload, dict):
        return DEFAULT_INTEREST_FALLBACK_SCORE
    interest_data = payload.get("interest")
    if isinstance(interest_data, dict):
        score = _safe_float(interest_data.get("score"))
        if score is not None:
            return _clamp_score(score)
    score = _safe_float(payload.get("score"))
    if score is not None:
        return _clamp_score(score)
    return DEFAULT_INTEREST_FALLBACK_SCORE


def _extract_significance_inputs_from_payload(payload: Optional[Dict[str, Any]]) -> tuple[Dict[str, float], Optional[float]]:
    if not isinstance(payload, dict):
        return {}, None
    significance_data = payload.get("significance")
    if not isinstance(significance_data, dict):
        return {}, None
    hint = _safe_float(significance_data.get("score_hint"))
    if hint is not None:
        hint = _clamp_score(hint)
    return _normalize_stats_dict(significance_data.get("stats")), hint


def _normalize_ratio_candidate(value: Any) -> Optional[float]:
    number = _safe_float(value)
    if number is None:
        return None
    if number < 0:
        return None
    if number <= 1:
        return number
    if number <= 100:
        return number / 100.0
    return None


def _extract_impact_from_payload(payload: Optional[Dict[str, Any]], dataset_schema: str) -> float:
    fallback = DEFAULT_IMPACT_FALLBACK_SCORE if dataset_schema.strip() else IMPACT_EMPTY_CONTEXT_FALLBACK_SCORE
    if not isinstance(payload, dict):
        return _clamp_score(fallback)
    impact_data = payload.get("impact")
    if not isinstance(impact_data, dict):
        return _clamp_score(fallback)

    score = _normalize_ratio_candidate(impact_data.get("score"))
    if score is not None:
        return _clamp_score(score)

    scope_data = impact_data.get("scope")
    if not isinstance(scope_data, dict):
        scope_data = {}

    for key in ("cell_fraction", "scope_fraction", "table_fraction", "data_scope_ratio", "scope_ratio"):
        candidate = _normalize_ratio_candidate(scope_data.get(key))
        if candidate is None:
            candidate = _normalize_ratio_candidate(impact_data.get(key))
        if candidate is not None:
            return _clamp_score(candidate)

    row_ratio = _normalize_ratio_candidate(scope_data.get("rows_ratio"))
    if row_ratio is None:
        row_ratio = _normalize_ratio_candidate(impact_data.get("rows_ratio"))
    col_ratio = _normalize_ratio_candidate(scope_data.get("columns_ratio"))
    if col_ratio is None:
        col_ratio = _normalize_ratio_candidate(impact_data.get("columns_ratio"))
    if row_ratio is not None and col_ratio is not None:
        return _clamp_score(row_ratio * col_ratio)

    rows_total, cols_total = _extract_table_shape(dataset_schema)
    rows_touched = _safe_float(scope_data.get("rows_touched"))
    if rows_touched is None:
        rows_touched = _safe_float(impact_data.get("rows_touched"))
    cols_touched = _safe_float(scope_data.get("columns_touched"))
    if cols_touched is None:
        cols_touched = _safe_float(impact_data.get("columns_touched"))
    if (
        rows_total is not None
        and cols_total is not None
        and rows_touched is not None
        and cols_touched is not None
        and rows_total > 0
        and cols_total > 0
    ):
        row_fraction = max(0.0, min(1.0, rows_touched / rows_total))
        col_fraction = max(0.0, min(1.0, cols_touched / cols_total))
        return _clamp_score(row_fraction * col_fraction)

    return _clamp_score(fallback)


def calculate_atomic_insight_metrics(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"] = None,
    user_messages: list[Any] | None = None,
) -> None:
    dataset_schema = _read_dataset_schema_text(store)
    code_text = _read_atomic_code_text(atomic, store, max_chars=CODE_TEXT_MAX_CHARS)
    output_text = _read_atomic_output_text(atomic, store, max_chars=OUTPUT_TEXT_MAX_CHARS)
    direct_stats = _extract_direct_stats(output_text)
    latest_user_text = _latest_metrics_language_text(user_messages) or latest_user_authored_text(user_messages)
    payload = _call_llm_metrics_once(
        atomic,
        plan,
        store,
        dataset_schema,
        code_text,
        output_text,
        direct_stats,
        latest_user_text,
    )
    atomic.interest = _clamp_score(_extract_interest_from_payload(payload))
    llm_stats, hint = _extract_significance_inputs_from_payload(payload)
    atomic.significance = _calculate_significance_by_type(
        atomic.insight_type,
        direct_stats=direct_stats,
        llm_stats=llm_stats,
        score_hint=hint,
        output_text=output_text,
    )
    atomic.impact = _extract_impact_from_payload(payload, dataset_schema)
    atomic.importance = calculate_importance_from_components(
        atomic.interest,
        atomic.significance,
        atomic.impact,
    )


def calculate_interest(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"] = None,
    user_messages: list[Any] | None = None,
) -> float:
    dataset_schema = _read_dataset_schema_text(store)
    code_text = _read_atomic_code_text(atomic, store, max_chars=CODE_TEXT_MAX_CHARS)
    output_text = _read_atomic_output_text(atomic, store, max_chars=OUTPUT_TEXT_MAX_CHARS)
    latest_user_text = _latest_metrics_language_text(user_messages) or latest_user_authored_text(user_messages)
    payload = _call_llm_metrics_once(
        atomic,
        plan,
        store,
        dataset_schema,
        code_text,
        output_text,
        _extract_direct_stats(output_text),
        latest_user_text,
    )
    return _extract_interest_from_payload(payload)


def calculate_significance(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"] = None,
    user_messages: list[Any] | None = None,
) -> float:
    dataset_schema = _read_dataset_schema_text(store)
    code_text = _read_atomic_code_text(atomic, store, max_chars=CODE_TEXT_MAX_CHARS)
    output_text = _read_atomic_output_text(atomic, store, max_chars=OUTPUT_TEXT_MAX_CHARS)
    direct_stats = _extract_direct_stats(output_text)
    latest_user_text = _latest_metrics_language_text(user_messages) or latest_user_authored_text(user_messages)
    payload = _call_llm_metrics_once(
        atomic,
        plan,
        store,
        dataset_schema,
        code_text,
        output_text,
        direct_stats,
        latest_user_text,
    )
    llm_stats, hint = _extract_significance_inputs_from_payload(payload)
    return _calculate_significance_by_type(atomic.insight_type, direct_stats, llm_stats, hint, output_text)


def calculate_impact(
    atomic: AtomicInsight,
    plan: PlanItem,
    store: Optional["RunStore"] = None,
    user_messages: list[Any] | None = None,
) -> float:
    dataset_schema = _read_dataset_schema_text(store)
    code_text = _read_atomic_code_text(atomic, store, max_chars=CODE_TEXT_MAX_CHARS)
    output_text = _read_atomic_output_text(atomic, store, max_chars=OUTPUT_TEXT_MAX_CHARS)
    latest_user_text = _latest_metrics_language_text(user_messages) or latest_user_authored_text(user_messages)
    payload = _call_llm_metrics_once(
        atomic,
        plan,
        store,
        dataset_schema,
        code_text,
        output_text,
        _extract_direct_stats(output_text),
        latest_user_text,
    )
    return _extract_impact_from_payload(payload, dataset_schema)


def calculate_importance_from_components(
    interest: float,
    significance: float,
    impact: float,
) -> float:
    return (
        interest * IMPORTANCE_WEIGHT_INTEREST
        + significance * IMPORTANCE_WEIGHT_SIGNIFICANCE
        + impact * IMPORTANCE_WEIGHT_IMPACT
    )
