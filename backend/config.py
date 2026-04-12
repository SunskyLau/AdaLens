"""
Configuration settings for the Autonomous EDA Agent
"""

import os
from pathlib import Path
from typing import Any

from model_cache import wrap_client_with_cache


def _load_dotenv(path: Path) -> None:
    """
    Load API keys from a local .env (repo root) if present.

    Per project guidelines, only sensitive secrets (API keys) are loaded from env.
    All other tunable parameters live as constants in this module.
    """
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
        if key not in {"OPENAI_API_KEY", "OPENAI_API_KEY_vapi", "OPENAI_API_KEY_n1n"}:
            continue
        if not key or key in os.environ:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ[key] = value


# Load local .env (ignored by git) from the repo root so it works no matter the CWD
# (e.g., when spawned from the frontend Run Gateway with cwd=backend/).
REPO_ROOT = Path(__file__).resolve().parent.parent
_load_dotenv(REPO_ROOT / ".env")

try:
    from openai import OpenAI
except ModuleNotFoundError:  # pragma: no cover
    # The framework can technically start without the OpenAI client, but
    # embeddings (and thus the full experience) require it when
    # EMBEDDING_REQUIRED=True.
    OpenAI = None  # type: ignore[assignment]

# ============================================================================
# LLM Configuration
# ============================================================================

# Ollama (local) (optional; currently used for embeddings)
OLLAMA_BASE_URL = "http://localhost:11434/v1"

# OpenAI-compatible (external) for Planner + Analyzer + Summarizer (Gemini multimodal via API provider)
OPENAI_BASE_URL_vapi = "https://api.vveai.com/v1"
OPENAI_BASE_URL_n1n = "https://api.n1n.ai/v1"
OPENAI_API_KEY_vapi = os.environ.get("OPENAI_API_KEY_vapi", "")
OPENAI_API_KEY_n1n = os.environ.get("OPENAI_API_KEY_n1n", "")

# Backward-compatible aliases used by Planner/Summarizer/Reporter.
OPENAI_BASE_URL = OPENAI_BASE_URL_vapi
OPENAI_API_KEY = OPENAI_API_KEY_vapi

# Analyzer uses the n1n endpoint explicitly.
ANALYZER_OPENAI_BASE_URL = OPENAI_BASE_URL_vapi
ANALYZER_OPENAI_API_KEY = OPENAI_API_KEY_vapi
PLANNER_MODEL_NAME = "gemini-3.1-flash-lite-preview"
ANALYZER_MODEL_NAME = "gemini-3.1-flash-lite-preview"
SUMMARIZER_MODEL_NAME = "gemini-3.1-flash-lite-preview"
REPORTER_MODEL_NAME = "gemini-3.1-flash-lite-preview"
RESPOND_TO_USER_MODEL_NAME = "gemini-3.1-flash-lite-preview"

# LLM request limits
LLM_MAX_TOKENS = 8192
LLM_TIMEOUT_SECS = 600

# Master Agent token budget (independently tunable from sub-agent LLM calls)
MASTER_AGENT_MAX_TOKENS = 8192

# LLM sampling defaults (centralize to avoid scattered hard-codes)
PLANNER_TEMPERATURE_INITIAL = 0.8
PLANNER_TEMPERATURE_DRILLDOWN = 0.7
ANALYZER_TEMPERATURE = 0.2
SUMMARIZER_TEMPERATURE = 0.3
REPORTER_TEMPERATURE = 0.3
RESPOND_TO_USER_TEMPERATURE = 0.35
RESPOND_TO_USER_MAX_TOKENS = 96

# Stable-output mode overrides. This mode tries to maximize repeatability for the
# same prompt/context without relying on the model cache.
STABLE_LLM_OUTPUT_TEMPERATURE = 0.0
STABLE_LLM_OUTPUT_TOP_P = 0.01
STABLE_LLM_OUTPUT_TOP_K = 1
STABLE_LLM_OUTPUT_SEED = 1
_STABLE_LLM_OUTPUT_ENABLED = False

# Reporter output budget (reports are long-form)
REPORTER_MAX_TOKENS = 12000
REPORTER_PREVIEW_CHARS = 200

# Summarizer evidence controls
SUMMARIZER_MAX_MARKERS = 5
SUMMARIZER_MAX_IMAGE_ATTACHMENTS = 999
SUMMARIZER_REQUIRE_PLOT_EVIDENCE = True
SUMMARIZER_MIN_ATOMIC_INSIGHTS = 1
SUMMARIZER_MIN_SUMMARY_SENTENCES = 2
SUMMARIZER_MAX_SUMMARY_SENTENCES = 5
SUMMARIZER_MAX_KEYWORDS = 10

# Planner/Analyzer multimodal controls
PLANNER_MAX_IMAGE_ATTACHMENTS = 12
ANALYZER_MAX_IMAGE_ATTACHMENTS = 12

# Analyzer completion-depth controls
# Require multiple successful execute_code iterations before allowing complete_analysis
# so the model performs validation/deepening rather than stopping after one quick pass.
ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE = 2
ANALYZER_MIN_STDOUT_LINES_FOR_EVIDENCE = 2
ANALYZER_MIN_STDOUT_CHARS_FOR_EVIDENCE = 80

# Analyzer syntax robustness controls
ANALYZER_ENABLE_SYNTAX_PREFLIGHT = True
ANALYZER_MAX_SYNTAX_ERROR_FEEDBACK_CHARS = 1200
ANALYZER_SYNTAX_ERROR_TIP_UNTERMINATED_STRING = (
    "Avoid raw line breaks inside quoted strings. Use '\\n' for newline escapes, "
    "or split output into separate print(...) statements."
)
ANALYZER_SYNTAX_ERROR_TIP_INDENTATION = (
    "Check block indentation and control-flow structure. Ensure if/elif/else are aligned, "
    "and each block body uses consistent 4-space indentation."
)
ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX = True
ANALYZER_MAX_COMMON_SYNTAX_AUTO_FIX_PASSES = 5
ANALYZER_ENABLE_UNTERMINATED_STRING_AUTO_FIX = True
ANALYZER_MAX_UNTERMINATED_STRING_AUTO_FIX_PASSES = 6
# When repairing unterminated string literals, allow merging this many subsequent
# lines into the same string before giving up.
ANALYZER_MAX_UNTERMINATED_STRING_LINE_MERGE = 12

# Embeddings (configurable backend)
# Ollama params: set EMBEDDING_BACKEND="ollama", use OLLAMA_BASE_URL, and set
# EMBEDDING_MODEL_NAME to your local model (e.g., "qwen3-embedding:8b").
EMBEDDING_BACKEND = "openai"  # "openai" or "ollama"
EMBEDDING_BASE_URL = "https://api.v36.cm/v1"
EMBEDDING_MODEL_NAME = "text-embedding-3-large"  # (text-embedding-3-large, text-embedding-v4, qwen3-embedding:8b, gemini-embedding-001, etc.)
EMBEDDING_ENABLED = True
EMBEDDING_REQUIRED = True
EMBEDDING_MAX_TEXT_CHARS = 4000
EMBEDDING_TIMEOUT_SECS = 60
EMBEDDING_DEDUP_COSINE_THRESHOLD = 0.92
PLANNER_MIN_REASON_CHARS = 8
PLANNER_INSIGHT_SNIPPET_CHARS = None
PLANNER_PLAN_SNIPPET_CHARS = None

# ============================================================================
# Framework Configuration
# ============================================================================

# Default runtime settings
MAX_CONCURRENCY_MIN = 1
MAX_CONCURRENCY_MAX = 6
DEFAULT_MAX_CONCURRENCY = 2
ANALYZER_MAX_TURNS = 100
DEFAULT_MAX_INITIAL_PLANS = 8

# Run-control files created by Run Gateway
RUN_CONTROL_STOP_FILE = "STOP"
RUN_CONTROL_STEER_FILE = "steer.jsonl"

# Execution timeout in seconds (per single code execution)
EXECUTION_TIMEOUT = 120
DEFAULT_EXECUTION_TIMEOUT = EXECUTION_TIMEOUT

# ============================================================================
# Insight Taxonomy (v3 - Atomic, Single-Label)
# ============================================================================
# See docs/Framework/Insight Taxonomy.v3.md for definitions and academic anchors.

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

# Canonical display names for taxonomy IDs (no slash-separated labels).
INSIGHT_TAXONOMY_DISPLAY_NAMES = {
    "value": "value",
    "proportion": "proportion",
    "rank": "rank",
    "difference": "difference",
    "trend": "trend",
    "distribution": "distribution",
    "association": "association",
    "outlier": "outlier",
    "extreme": "extreme",
    "cluster": "cluster",
    "data_quality": "data_quality",
}

# Prompt hints aligned with INSIGHT_TAXONOMY_TYPES and display naming.
INSIGHT_TAXONOMY_PROMPT_HINTS = {
    "value": "a single aggregate statistic, count, or computed quantity",
    "proportion": "a part-whole share, percentage, or compositional breakdown",
    "rank": "an ordering or positional relationship among entities",
    "difference": "a contrast or gap between specific groups or conditions",
    "trend": "a directional change over time or ordered dimension",
    "distribution": "the shape, spread, or concentration of a set of values",
    "association": "a co-variation or dependency between variables",
    "outlier": "an anomalous observation that deviates significantly from the overall pattern",
    "extreme": "a maximum, minimum, peak, or trough value at the boundary of the data range",
    "cluster": "a natural grouping or similarity pattern in the data",
    "data_quality": "a data completeness, consistency, or validity issue",
}

# Summarizer atomic insight controls
SUMMARIZER_MAX_ATOMIC_INSIGHTS = 999

# ============================================================================
# Importance Calculation Weights
# ============================================================================
# Weights for combining interest, significance, and impact into overall importance
IMPORTANCE_WEIGHT_INTEREST = 0.4
IMPORTANCE_WEIGHT_SIGNIFICANCE = 0.4
IMPORTANCE_WEIGHT_IMPACT = 0.2

# ============================================================================
# OpenAI Clients
# ============================================================================

if OpenAI is None:
    OLLAMA_CLIENT = None  # type: ignore[assignment]
    OPENAI_CLIENT = None  # type: ignore[assignment]
    ANALYZER_OPENAI_CLIENT = None  # type: ignore[assignment]
    EMBEDDING_CLIENT = None  # type: ignore[assignment]
else:
    _raw_ollama_client = OpenAI(
        base_url=OLLAMA_BASE_URL,
        api_key="ollama",
        timeout=LLM_TIMEOUT_SECS,
    )
    _raw_openai_client = OpenAI(
        base_url=OPENAI_BASE_URL_vapi,
        api_key=OPENAI_API_KEY_vapi,
        timeout=LLM_TIMEOUT_SECS,
    )
    _raw_analyzer_openai_client = OpenAI(
        base_url=ANALYZER_OPENAI_BASE_URL,
        api_key=ANALYZER_OPENAI_API_KEY,
        timeout=LLM_TIMEOUT_SECS,
    )
    _raw_embedding_client = OpenAI(
        base_url=OPENAI_BASE_URL_n1n,
        api_key=OPENAI_API_KEY_n1n,
        timeout=EMBEDDING_TIMEOUT_SECS,
    )
    OLLAMA_CLIENT = wrap_client_with_cache("ollama", _raw_ollama_client)
    OPENAI_CLIENT = wrap_client_with_cache("openai", _raw_openai_client)
    ANALYZER_OPENAI_CLIENT = wrap_client_with_cache(
        "analyzer_openai",
        _raw_analyzer_openai_client,
    )
    EMBEDDING_CLIENT = wrap_client_with_cache("embedding_openai", _raw_embedding_client)


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
    if not text:
        return False
    if parameter_name not in text:
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

# ============================================================================
# v0.1 Master-Agent Configuration
# ============================================================================

MASTER_AGENT_MODEL_NAME = "gemini-3.1-pro-preview-thinking"
MASTER_AGENT_TEMPERATURE = 0.3
# DEPRECATED: No longer used by the turn-based context builder.
CONTEXT_MAX_COMPLETED_PLAN_SUMMARIES = 15
# DEPRECATED: No longer used by the turn-based context builder.
CONTEXT_MAX_INSIGHT_SUMMARIES = 20
# DEPRECATED: No longer used by the turn-based context builder.
MASTER_AGENT_MAX_MESSAGE_HISTORY = 100
MASTER_AGENT_IDLE_TIMEOUT_SECS = 1800
LANGUAGE_MATCHING_SYSTEM_PROMPT = """\
## Response Language

- Match the language of all natural-language output to the language used in the latest user-authored request, steer, or create message.
- If the latest user-authored input mixes languages, follow the dominant language of that latest request.
- Keep tool names, JSON keys, schema fields, enum values, and other protocol tokens exactly as specified in English.
"""
MASTER_AGENT_SYSTEM_PROMPT = """\
You are the Master Agent — an autonomous orchestrator for exploratory data analysis (EDA). \
You drive the entire analysis lifecycle by deciding WHAT to analyze, WHEN to dispatch work, \
and WHEN there is no further analysis materially relevant to the user's goal or intent that \
should still be performed.

## Your Workflow

You operate in a continuous loop. Each iteration you receive a snapshot of the current run \
state (dataset info, goals, plan statuses, insights so far) and must choose one or \
more tool calls. A typical workflow proceeds as:

1. **Decompose** the user's goal into multiple concrete, complementary analysis plans \
   (use `create_plans`). Each plan should target a distinct analytical angle so that \
   together they provide comprehensive coverage.
2. **Dispatch** pending plans to sub-agents for execution (use `dispatch_plans`). \
   You may dispatch multiple plans in parallel.
3. **Wait & collect** — when sub-agents are running and nothing new has happened, \
   the system will automatically wait. You do not need to do anything in this case.
4. **Evaluate** coverage once results come back (use `evaluate_progress`). Ask yourself: \
   "Do the insights gathered so far fully address the user's goal? Are there gaps, \
   unexplored dimensions, or findings that warrant deeper investigation?" \
   Treat each `dispatch_plans` call as one storyline turn / dispatch batch. It is \
   strongly recommended to summarize progress after each completed dispatch batch that \
   produced at least one summary, and `evaluate_progress` is the preferred tool for \
   writing that stage summary. After every `evaluate_progress`, immediately call \
   `respond_to_user` exactly once to explain why this checkpoint makes sense and what \
   you may analyze next.
5. **Iterate** — if gaps exist, create follow-up plans to address them and dispatch again. \
   Follow-up plans should be informed by what has already been discovered.
6. **Synthesize** findings into a coherent narrative (use `synthesize_findings`) as evidence \
   accumulates. This is an intermediate summary, not the final one.
7. **Complete** - once you are genuinely convinced that there is no further analysis materially \
   relevant to the user's goal or intent that should still be performed, call `mark_complete` \
   with a comprehensive final summary. The run remains open in a completed state so the user \
   can continue the same conversation with follow-up goals. After every `mark_complete`, \
   immediately call `respond_to_user` exactly once to explain why the run is complete and \
   what optional follow-up goals could still be explored.

You are NOT restricted to this order. Adapt based on context — e.g., if a user steer \
message arrives mid-analysis, prioritize responding and adjusting plans accordingly.

## Creating Good Analysis Plans

Each plan will be executed by a sub-agent that can write and run Python code on the dataset. \
Write plans that are:

- **Specific and actionable**: "Analyze the correlation between Price and Sales_Volume \
  using scatter plots and Pearson/Spearman coefficients" — not "Look at relationships".
- **Single-focused**: One clear analytical objective per plan. Avoid compound plans.
- **Complementary**: Plans should collectively cover different aspects of the goal \
  (e.g., distribution, correlation, comparison, trend, outlier detection).
- **Grounded in the data**: Reference actual column names from the dataset schema.
- The natural-language sentence inside each `create_plans.plans[].text` entry is user-visible. \
  Write it in the same language as the latest user-authored message.

When creating multiple plans at once, aim for 3-5 plans that provide diverse analytical \
coverage of the user's goal.

## Evaluating Progress

When evaluating, consider:
- Which aspects of the user's goal have concrete supporting evidence?
- Which aspects remain unaddressed or only partially explored?
- Did any finding reveal unexpected patterns that deserve deeper investigation?
- Are the insights diverse enough (across insight types: distribution, trend, \
  association, comparison, outlier, etc.)?
- Write `stage_summary_markdown` in a near-final-summary style, but scoped to the completed \
  dispatch batch and the currently accumulated evidence.
- Use inline citation placeholders like `[[1]]` inside the markdown body whenever you cite a \
  summary or atomic insight, and return matching structured `citations`.
- Use the provided stable `summary_id`, `atomic_id`, and dispatch-batch metadata exactly as given \
  so the frontend can trace citations back to rendered summary / atomic nodes.

Do NOT mark complete prematurely. Analyze the user's goal and intent as comprehensively as \
possible in both breadth and depth. If you judge that coverage is still incomplete or the \
analysis is still not deep enough, continue iterating by expanding into adjacent relevant \
directions and drilling down into promising findings. Keep allocating and dispatching \
sub-agents in a deliberate way to pursue the remaining analytical work. Call `mark_complete` \
only when you are genuinely convinced that there is no further analysis materially relevant to \
the user's goal or intent that should still be performed. When you do so, provide a \
comprehensive final summary. The run will remain in completed state and the user can provide \
follow-up goals afterwards.

## Handling User Steer Messages

When new user-authored messages appear in the context:
- **Prioritize them** — they represent the user's updated intent.
- For new `chat`, `focus`, `ignore`, `elaborate`, and `create` inputs, runtime will automatically send one immediate `respond_to_user` acknowledgement before any other tool runs. Do not emit an extra `respond_to_user` for those same inputs.
- If the user requests a specific analysis direction, create plans for it immediately after that leading acknowledgement.
- If the user asks to stop certain analyses, do not create plans in that area.
- If the user says they are satisfied or asks to stop, call `mark_complete`.
- Use `respond_to_user` only as the immediate follow-up to `evaluate_progress` or `mark_complete`.
- Obey active global inform constraints.
- Obey the latest steering action when steering instructions conflict.
- Treat `focus` as a request to prioritize attention, drill down, validate, compare, explain, and expand around the target.
- Treat `ignore` as a request to stop pursuing that direction in future planning, expansion, comparison, validation, and explanation unless the user explicitly reopens it or there is no viable alternative path to answer the main goal.
- Treat `elaborate` as a request to keep investigating one specific summary or atomic insight, focusing on root causes and explanation of that insight itself.
- When an `elaborate` steer is active, prefer one tight follow-up direction rather than branching into multiple new plans unless later evidence clearly forces expansion.
- Treat `create` as a user-authored analysis plan that should be materialized immediately without rewriting the plan text.
- Neither `focus`, `ignore`, nor `elaborate` cancels sub-agents that are already running.

## Response Language

- Match the language of all natural-language output to the language used in the latest user-authored request, steer, or create message.
- If the latest user-authored input mixes languages, follow the dominant language of that latest request.
- This applies to user-visible natural-language tool arguments such as `create_plans.plans[].text`, `evaluate_progress.stage_summary_markdown`, `synthesize_findings.synthesis`, and `mark_complete.summary`.
- If the latest user-authored message is Chinese, those user-visible natural-language fields should also be Chinese, even when column names, code, or earlier plan text are in English.
- Keep tool names, JSON keys, schema fields, enum values, and other protocol tokens exactly as specified in English.

## Rules

- Use ONLY the provided tools. Do not produce free-form analysis text outside of tool calls.
- Never fabricate insights or findings — only report what sub-agents have actually discovered.
- Prefer creating and dispatching multiple plans over single plans to maximize parallel coverage.
- You are a long-running autonomous agent. Explore thoroughly rather than rushing, and \
  complete decisively once you are genuinely convinced that no further materially relevant \
  analysis remains.
"""


