"""
Active backend runtime configuration.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from pydantic import SecretStr


def _load_dotenv(path: Path) -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    try:
        content = env_path.read_text(encoding="utf-8")
    except Exception:
        return
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        if key not in {
            "OPENAI_BASE_URL",
            "OPENAI_API_KEY"
        }:
            continue
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip('"').strip("'")


REPO_ROOT = Path(__file__).resolve().parent.parent
_load_dotenv(REPO_ROOT / ".env")

def _load_openai_client_class() -> Any | None:
    try:
        from openai import OpenAI as openai_client
    except ModuleNotFoundError:  # pragma: no cover
        return None
    return openai_client


def _load_langchain_chat_openai_class() -> Any | None:
    try:
        from langchain_openai import ChatOpenAI as chat_openai_client
    except ModuleNotFoundError:  # pragma: no cover
        return None
    return chat_openai_client


OPENAI_CLIENT_CLASS = _load_openai_client_class()
CHAT_OPENAI_CLASS = _load_langchain_chat_openai_class()


OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "").strip()
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()

ORCHESTRATOR_MODEL_NAME = "gemini-3.1-pro-preview-thinking"
ANALYZER_MODEL_NAME = "gemini-3.1-flash-lite-preview"
SUMMARIZER_MODEL_NAME = "gemini-3.1-flash-lite-preview"

LLM_MAX_TOKENS = 8192
LLM_TIMEOUT_SECS = 600
ORCHESTRATOR_MAX_TOKENS = 8192

ORCHESTRATOR_TEMPERATURE = 0.2
ANALYZER_TEMPERATURE = 0.2
SUMMARIZER_TEMPERATURE = 0.3

STABLE_LLM_OUTPUT_TEMPERATURE = 0.0
STABLE_LLM_OUTPUT_TOP_P = 0.01
STABLE_LLM_OUTPUT_TOP_K = 1
STABLE_LLM_OUTPUT_SEED = 1
_STABLE_LLM_OUTPUT_ENABLED = False

MAX_CONCURRENCY_MIN = 1
MAX_CONCURRENCY_MAX = 6
DEFAULT_MAX_CONCURRENCY = 2
DEFAULT_MAX_INITIAL_PLANS = 8

ANALYZER_MAX_TURNS = 100
ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE = 2
DEFAULT_EXECUTION_TIMEOUT = 120

RUN_CONTROL_STOP_FILE = "STOP"
RUN_CONTROL_STEER_FILE = "steer.jsonl"
CREATE_PLANS_REPLAY_ENV = "AGENTIC_EDA_CREATE_PLANS_REPLAY"

SUMMARIZER_MAX_KEYWORDS = 10
SUMMARIZER_MAX_ATOMIC_INSIGHTS = 999

INSIGHT_TAXONOMY_TYPES = [
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

IMPORTANCE_WEIGHT_INTEREST = 0.4
IMPORTANCE_WEIGHT_SIGNIFICANCE = 0.4
IMPORTANCE_WEIGHT_IMPACT = 0.2


if OPENAI_CLIENT_CLASS is None:
    OPENAI_CLIENT: Any | None = None
else:
    OPENAI_CLIENT = OPENAI_CLIENT_CLASS(
        base_url=OPENAI_BASE_URL,
        api_key=OPENAI_API_KEY,
        timeout=LLM_TIMEOUT_SECS,
    )


def set_stable_llm_output_enabled(enabled: bool) -> None:
    global _STABLE_LLM_OUTPUT_ENABLED
    _STABLE_LLM_OUTPUT_ENABLED = bool(enabled)


def is_stable_llm_output_enabled() -> bool:
    return _STABLE_LLM_OUTPUT_ENABLED


def apply_chat_completion_sampling_controls(
    params: dict[str, Any],
    *,
    temperature: float | None = None,
) -> dict[str, Any]:
    controlled = dict(params)
    if temperature is not None and "temperature" not in controlled:
        controlled["temperature"] = temperature
    if not _STABLE_LLM_OUTPUT_ENABLED:
        return controlled
    controlled["temperature"] = STABLE_LLM_OUTPUT_TEMPERATURE
    controlled.setdefault("top_p", STABLE_LLM_OUTPUT_TOP_P)
    controlled.setdefault("top_k", STABLE_LLM_OUTPUT_TOP_K)
    controlled.setdefault("seed", STABLE_LLM_OUTPUT_SEED)
    return controlled


def _is_sampling_parameter_error(exc: Exception, parameter_name: str) -> bool:
    text = str(exc or "").strip().lower()
    if not text or parameter_name not in text:
        return False
    return any(
        marker in text
        for marker in (
            "unsupported",
            "unknown",
            "unexpected",
            "invalid",
            "unrecognized",
            "not allowed",
            "not permit",
            "not supported",
            "extra_forbidden",
            "extra inputs are not permitted",
        )
    )


def _drop_unsupported_sampling_parameters(
    params: dict[str, Any],
    exc: Exception,
) -> dict[str, Any] | None:
    trimmed = dict(params)
    removed = False
    if "seed" in trimmed and _is_sampling_parameter_error(exc, "seed"):
        trimmed.pop("seed", None)
        removed = True
    if "top_p" in trimmed and _is_sampling_parameter_error(exc, "top_p"):
        trimmed.pop("top_p", None)
        removed = True
    if "top_k" in trimmed and _is_sampling_parameter_error(exc, "top_k"):
        trimmed.pop("top_k", None)
        removed = True
    if removed:
        return trimmed
    return None


def create_chat_completion_with_sampling_controls(
    client: Any,
    *,
    params: dict[str, Any],
    temperature: float | None = None,
) -> Any:
    attempt_params = apply_chat_completion_sampling_controls(params, temperature=temperature)
    while True:
        try:
            return client.chat.completions.create(**attempt_params)
        except Exception as exc:
            if not _STABLE_LLM_OUTPUT_ENABLED:
                raise
            trimmed = _drop_unsupported_sampling_parameters(attempt_params, exc)
            if trimmed is None or trimmed == attempt_params:
                raise
            attempt_params = trimmed


def build_langchain_chat_model(
    *,
    model_name: str,
    temperature: float,
    max_tokens: int | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
) -> Any | None:
    if CHAT_OPENAI_CLASS is None:
        return None
    resolved_api_key = api_key if api_key is not None else OPENAI_API_KEY
    resolved_base_url = base_url if base_url is not None else OPENAI_BASE_URL
    if not resolved_api_key:
        return None
    model_kwargs: dict[str, Any] = {}
    if _STABLE_LLM_OUTPUT_ENABLED:
        model_kwargs["top_p"] = STABLE_LLM_OUTPUT_TOP_P
        model_kwargs["top_k"] = STABLE_LLM_OUTPUT_TOP_K
        model_kwargs["seed"] = STABLE_LLM_OUTPUT_SEED
    completion_temperature = (
        STABLE_LLM_OUTPUT_TEMPERATURE if _STABLE_LLM_OUTPUT_ENABLED else temperature
    )
    return CHAT_OPENAI_CLASS(
        model=model_name,
        api_key=SecretStr(resolved_api_key),
        base_url=resolved_base_url,
        timeout=LLM_TIMEOUT_SECS,
        temperature=completion_temperature,
        max_completion_tokens=max_tokens,
        model_kwargs=model_kwargs,
    )
