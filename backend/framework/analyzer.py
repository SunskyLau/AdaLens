"""
Analyzer for the Agentic EDA Framework

MVP design (see docs/Framework/Agent Architecture.md):
- Multi-turn LLM loop that uses tools to analyze the dataset
- The ONLY normal completion signal is an explicit complete_analysis tool call
- System fallback: max_turns / timeout -> mark failed

This module is intentionally minimal and focuses on robustness over performance.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
import textwrap
import time
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Literal, Optional

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    # Allow running as a script: `python backend/framework/analyzer.py`
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from cache_normalization import (  # noqa: E402
    build_analyzer_cache_normalization_context,
    build_dataset_identity,
)
from model_cache import (  # noqa: E402
    activate_timestamp_binding,
    build_model_cache_run_context,
    consume_last_model_cache_binding,
    use_model_cache_normalization_context,
    use_model_cache_run_context,
)

from config import (
    create_chat_completion_with_sampling_controls,
    ANALYZER_OPENAI_CLIENT,
    ANALYZER_OPENAI_API_KEY,
    ANALYZER_OPENAI_BASE_URL,
    ANALYZER_MODEL_NAME,
    ANALYZER_TEMPERATURE,
    ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE,
    ANALYZER_MIN_STDOUT_LINES_FOR_EVIDENCE,
    ANALYZER_MIN_STDOUT_CHARS_FOR_EVIDENCE,
    ANALYZER_ENABLE_SYNTAX_PREFLIGHT,
    ANALYZER_MAX_SYNTAX_ERROR_FEEDBACK_CHARS,
    ANALYZER_SYNTAX_ERROR_TIP_UNTERMINATED_STRING,
    ANALYZER_SYNTAX_ERROR_TIP_INDENTATION,
    ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX,
    ANALYZER_MAX_COMMON_SYNTAX_AUTO_FIX_PASSES,
    ANALYZER_ENABLE_UNTERMINATED_STRING_AUTO_FIX,
    ANALYZER_MAX_UNTERMINATED_STRING_AUTO_FIX_PASSES,
    ANALYZER_MAX_UNTERMINATED_STRING_LINE_MERGE,
    LLM_MAX_TOKENS,
    LLM_TIMEOUT_SECS,
    ANALYZER_MAX_TURNS,
    DEFAULT_EXECUTION_TIMEOUT,
)
from utils import execute_python_code_streaming
from .language_context import (
    contains_cjk_text,
    latest_user_authored_text,
    prefers_chinese_text,
    strict_language_match_instruction,
)
from .models import RunState, PlanItem, ExecutionRecord
from .store import RunStore


def _extract_text_content(content: Any) -> str:
    """Normalize chat message content into plain text for tracing/debugging."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    chunks: List[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str):
            chunks.append(text)
    return "\n".join(chunks).strip()


def _serialize_raw_assistant_message(message: Any) -> Dict[str, Any]:
    """Serialize a ChatCompletionMessage preserving all vendor-specific fields.

    Reasoning models (e.g. Gemini) embed fields like ``thought_signature``
    inside tool-call objects.  Stripping them causes strict history validation
    to fail on subsequent turns.  Using the SDK's own serializer keeps the
    payload intact.
    """
    if hasattr(message, "model_dump"):
        raw = message.model_dump(exclude_none=True, exclude_unset=True)
    elif hasattr(message, "dict"):
        raw = message.dict(exclude_none=True, exclude_unset=True)
    else:
        raw = {"role": "assistant", "content": getattr(message, "content", "")}
        if getattr(message, "tool_calls", None):
            raw["tool_calls"] = [
                tc.model_dump(exclude_none=True, exclude_unset=True)
                if hasattr(tc, "model_dump")
                else tc
                for tc in message.tool_calls
            ]
    raw.setdefault("role", "assistant")
    return raw


def _sanitize_indentation(code: str) -> str:
    """
    Conservative indentation cleanup.

    We only remove uniform leading indentation across the whole snippet
    (common when code is nested in markdown/list formatting). This preserves
    relative block structure and avoids corrupting valid if/elif/else blocks.
    """
    if not code:
        return code

    normalized = code.replace("\t", "    ")
    dedented = textwrap.dedent(normalized)
    return dedented


@dataclass
class AnalysisSession:
    """Holds the full analysis process for a single plan execution."""

    plan_id: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    trace_messages: List[Dict[str, Any]] = field(default_factory=list)
    completed: bool = False
    failed: bool = False
    error_message: Optional[str] = None


@dataclass
class AnalyzerRunResult:
    record: ExecutionRecord | None = None
    control_action: Literal["pause", "terminate", "yield"] | None = None
    checkpoint_path: str | None = None
    resume_phase: Literal["analyzing"] | None = None
    timestamp_binding: Any | None = None


def _call_analyzer_with_cache_context(
    normalization_context: Any,
    run_context: Any,
    params: Dict[str, Any],
) -> Any:
    with use_model_cache_run_context(run_context):
        with use_model_cache_normalization_context(normalization_context):
            return create_chat_completion_with_sampling_controls(
                ANALYZER_OPENAI_CLIENT,
                params=params,
            )


class Analyzer:
    """
    Multi-turn analysis agent.

    The agent uses native OpenAI-compatible function calling and keeps
    strict tool-order constraints for robust ReAct-style execution.
    """

    def __init__(
        self,
        timeout: int = DEFAULT_EXECUTION_TIMEOUT,
        max_turns: int = ANALYZER_MAX_TURNS,
        enable_streaming: bool = True,
    ):
        self.timeout = timeout
        self.max_turns = max_turns
        self.enable_streaming = enable_streaming

    def _tool_specs(self) -> List[Dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": "execute_code",
                    "description": (
                        "Execute Python code for EDA. Use variables already in runtime: "
                        "df, DATASET_PATH, PLOTS_DIR, PLAN_ID. Each execute_code call should "
                        "be self-contained: do not assume temporary variables from prior "
                        "execute_code calls still exist; recreate prerequisites when needed. "
                        "Prefer the existing df variable. If you must reload the dataset, use "
                        "pd.read_csv(DATASET_PATH) only and never paste a literal local or "
                        "upload file path into the code."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code": {"type": "string", "description": "Python code to execute."},
                        },
                        "required": ["code"],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "reflect_on_results",
                    "description": (
                        "Write a short user-facing reflection (1-3 sentences): what you did, "
                        "what you observed, and what you will do next. The reflection must match "
                        "the latest user-authored message's language."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "reflection": {
                                "type": "string",
                                "description": (
                                    "1-3 short user-facing sentences in the latest user-authored "
                                    "message's language."
                                ),
                            }
                        },
                        "required": ["reflection"],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "complete_analysis",
                    "description": "Mark analysis complete after at least one execute_code call.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "note": {
                                "type": "string",
                                "description": (
                                    "Optional final note in the latest user-authored message's "
                                    "language."
                                ),
                            }
                        },
                        "additionalProperties": False,
                    },
                },
            },
        ]

    def _tool_choice_for_turn(
        self,
        initial_reflection_done: bool,
        must_reflect_next: bool,
    ) -> Any:
        if not initial_reflection_done or must_reflect_next:
            return {"type": "function", "function": {"name": "reflect_on_results"}}
        return "required"

    def _parse_tool_arguments(self, arguments_raw: Any) -> Dict[str, Any]:
        if arguments_raw is None:
            return {}
        if isinstance(arguments_raw, dict):
            return arguments_raw
        if not isinstance(arguments_raw, str):
            raise ValueError("Tool arguments must be a JSON object string.")
        text = arguments_raw.strip()
        if not text:
            return {}
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            raise ValueError("Tool arguments must decode to a JSON object.")
        return parsed

    def _normalize_tool_calls(self, message: Any, turn: int) -> List[Dict[str, Any]]:
        raw_calls = getattr(message, "tool_calls", None) or []
        calls: List[Dict[str, Any]] = []
        for idx, raw in enumerate(raw_calls, start=1):
            if isinstance(raw, dict):
                fn = raw.get("function") or {}
                name = str(fn.get("name") or "").strip()
                args = fn.get("arguments")
                call_id = str(raw.get("id") or f"tool_call_{turn}_{idx}")
            else:
                fn = getattr(raw, "function", None)
                name = str(getattr(fn, "name", "") or "").strip()
                args = getattr(fn, "arguments", None)
                call_id = str(getattr(raw, "id", "") or f"tool_call_{turn}_{idx}")

            if isinstance(args, str):
                args_text = args
            elif isinstance(args, dict):
                args_text = json.dumps(args, ensure_ascii=False)
            else:
                args_text = "{}"

            calls.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args_text,
                    },
                }
            )
        return calls

    @staticmethod
    def _known_tool_names() -> set[str]:
        return {"execute_code", "reflect_on_results", "complete_analysis"}

    def _is_tool_allowed_now(
        self,
        tool_name: str,
        *,
        initial_reflection_done: bool,
        must_reflect_next: bool,
    ) -> bool:
        if tool_name not in self._known_tool_names():
            return False
        if must_reflect_next:
            return tool_name == "reflect_on_results"
        if not initial_reflection_done:
            return tool_name == "reflect_on_results"
        return True

    def _select_tool_call_for_execution(
        self,
        tool_calls: List[Dict[str, Any]],
        *,
        initial_reflection_done: bool,
        must_reflect_next: bool,
    ) -> int | None:
        for index, call in enumerate(tool_calls):
            fn = call.get("function") or {}
            tool_name = str(fn.get("name") or "").strip()
            if self._is_tool_allowed_now(
                tool_name,
                initial_reflection_done=initial_reflection_done,
                must_reflect_next=must_reflect_next,
            ):
                return index
        if tool_calls:
            return 0
        return None

    def _ignored_extra_tool_call_feedback(
        self,
        *,
        initial_reflection_done: bool,
        must_reflect_next: bool,
    ) -> str:
        if must_reflect_next or not initial_reflection_done:
            return (
                "Only one tool call is allowed per assistant response. I ignored this extra "
                "tool call. The next assistant response must only call reflect_on_results."
            )
        return (
            "Only one tool call is allowed per assistant response. I ignored this extra tool "
            "call. If it is still needed, send it in a new assistant response after reviewing "
            "the latest tool result."
        )

    def _build_tool_trace_content(self, tool_calls: List[Dict[str, Any]]) -> str:
        """
        Keep assistant content trace-compatible so downstream reporter parsing
        still works even when execution is done via native tool_calls.
        """
        lines: List[str] = []
        for call in tool_calls:
            fn = call.get("function") or {}
            tool_name = str(fn.get("name") or "").strip()
            args_text = fn.get("arguments")
            payload: Dict[str, Any] = {"tool": tool_name}
            try:
                parsed = self._parse_tool_arguments(args_text)
                payload.update(parsed)
            except Exception:
                payload["raw_arguments"] = str(args_text or "")
            lines.append(json.dumps(payload, ensure_ascii=False))
        return "\n".join(lines).strip()

    def _append_tool_message(self, session: AnalysisSession, tool_call_id: str, payload: Dict[str, Any]) -> None:
        msg = {
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": json.dumps(payload, ensure_ascii=False),
        }
        session.messages.append(msg)
        session.trace_messages.append(msg)

    def _is_thought_signature_invalid_error(self, error: Exception) -> bool:
        text = str(error or "").lower()
        return "thought signature" in text and "not valid" in text

    def _reset_messages_after_signature_error(self, session: AnalysisSession) -> None:
        # Keep only the initial system+user context to avoid replaying invalid vendor signatures.
        base_messages = session.messages[:2] if len(session.messages) >= 2 else list(session.messages)
        reset_note = {
            "role": "system",
            "content": (
                "Context reset after upstream thought_signature validation failure. "
                "Continue analysis from current plan state and call tools normally."
            ),
        }
        session.messages = [*base_messages, reset_note]
        session.trace_messages.append(reset_note)

    def _stdout_has_meaningful_evidence(self, stdout_text: str) -> bool:
        stripped = (stdout_text or "").strip()
        if not stripped:
            return False
        non_empty_lines = [line for line in stripped.splitlines() if line.strip()]
        return (
            len(non_empty_lines) >= ANALYZER_MIN_STDOUT_LINES_FOR_EVIDENCE
            or len(stripped) >= ANALYZER_MIN_STDOUT_CHARS_FOR_EVIDENCE
        )

    def _normalize_replay_history(self, raw_history: Any) -> List[str]:
        history: List[str] = []
        if not isinstance(raw_history, list):
            return history
        for item in raw_history:
            if not isinstance(item, str):
                continue
            snippet = item.strip()
            if snippet:
                history.append(snippet)
        return history

    def _build_effective_user_code(self, replay_history: List[str], current_code: str) -> str:
        snippets = [snippet.strip() for snippet in replay_history if snippet.strip()]
        current = current_code.strip()
        if current:
            snippets.append(current)
        return "\n\n".join(snippets).strip() + "\n"

    def _build_runtime_user_code(self, replay_history: List[str], current_code: str) -> str:
        steps = [
            f"_run_replay_snippet({snippet!r})"
            for snippet in replay_history
            if isinstance(snippet, str) and snippet.strip()
        ]
        steps.append(current_code.strip())
        return "\n\n".join(step for step in steps if step).strip() + "\n"

    def _normalize_dataset_path_literals(
        self,
        code: str,
        dataset_path: str,
    ) -> tuple[str, str | None]:
        normalized_dataset_path = str(dataset_path or "").strip()
        if not normalized_dataset_path:
            return code, None

        working = code
        literal_variants = {
            normalized_dataset_path,
            normalized_dataset_path.replace("\\", "/"),
            normalized_dataset_path.replace("/", "\\"),
        }
        for candidate in sorted(literal_variants, key=len, reverse=True):
            if not candidate:
                continue
            for literal in (
                f"r'{candidate}'",
                f'r"{candidate}"',
                f"R'{candidate}'",
                f'R"{candidate}"',
                f"'{candidate}'",
                f'"{candidate}"',
            ):
                working = working.replace(literal, "DATASET_PATH")

        dataset_name = os.path.basename(normalized_dataset_path.replace("\\", "/")).strip()
        if dataset_name:
            string_literal_pattern = re.compile(
                r"(?P<prefix>[rR]?)(?P<quote>['\"])(?P<body>[^'\"]+)(?P=quote)"
            )
            updated_lines: List[str] = []
            for line in working.splitlines():
                if dataset_name.lower() not in line.lower() or "DATASET_PATH" in line:
                    updated_lines.append(line)
                    continue

                def _replace_path_literal(match: re.Match[str]) -> str:
                    body = str(match.group("body") or "")
                    if dataset_name.lower() not in body.lower():
                        return match.group(0)
                    if not any(sep in body for sep in ("\\", "/", ":")):
                        return match.group(0)
                    return "DATASET_PATH"

                updated_lines.append(string_literal_pattern.sub(_replace_path_literal, line))
            working = "\n".join(updated_lines)

        if working == code:
            return code, None
        return working, "Auto-replaced literal dataset path with DATASET_PATH."

    def _is_dataset_path_feedback_needed(self, result_error: Any, stderr_text: str) -> bool:
        combined = "\n".join(
            part.strip()
            for part in [str(result_error or ""), str(stderr_text or "")]
            if str(part or "").strip()
        ).lower()
        if not combined:
            return False
        error_hints = (
            "filenotfounderror",
            "no such file or directory",
            "unicodeescape",
            "truncated \\u",
            "truncated \\x",
            "invalid escape",
        )
        path_hints = (
            "dataset_path",
            ".csv",
            "_uploads",
            "runs/",
            "runs\\",
            "c:/",
            "c:\\",
            "/users/",
            "\\users\\",
        )
        return any(hint in combined for hint in error_hints) and any(
            hint in combined for hint in path_hints
        )

    def _dataset_path_next_action(self) -> str:
        return (
            "Do not paste a literal dataset file path into code. Reuse the existing df "
            "variable when possible, or reload with pd.read_csv(DATASET_PATH) only. "
            "After the next execute_code result, call reflect_on_results before anything else."
        )

    def _is_name_error_feedback_needed(self, result_error: Any, stderr_text: str) -> bool:
        combined = "\n".join(
            part.strip()
            for part in [str(result_error or ""), str(stderr_text or "")]
            if str(part or "").strip()
        ).lower()
        return "nameerror" in combined and "is not defined" in combined

    def _runtime_next_action(self, result_error: Any, stderr_text: str) -> str:
        if self._is_dataset_path_feedback_needed(result_error, stderr_text):
            return self._dataset_path_next_action()
        if self._is_name_error_feedback_needed(result_error, stderr_text):
            return (
                "A NameError suggests the current code depended on a missing variable. "
                "Do not assume temporary variables from an earlier execute_code still exist. "
                "Your next execute_code must be self-contained and recreate any prerequisite "
                "variables, imports, or transformations before using them. After execution, "
                "call reflect_on_results with 1-3 user-facing sentences."
            )
        return "Call reflect_on_results with 1-3 user-facing sentences."

    def _syntax_next_action(self, syntax_error: Dict[str, Any] | None) -> str:
        syntax_error = syntax_error or {}
        combined = "\n".join(
            str(part or "").strip()
            for part in (
                syntax_error.get("msg"),
                syntax_error.get("text"),
                syntax_error.get("guidance"),
            )
            if str(part or "").strip()
        )
        if self._is_dataset_path_feedback_needed(combined, ""):
            return self._dataset_path_next_action()
        return (
            "Fix the Python syntax issue first, then call execute_code again. After execution, "
            "call reflect_on_results with 1-3 user-facing sentences."
        )

    def _complete_analysis_next_action(
        self,
        *,
        successful_execute_count: int,
        successful_execute_with_evidence_count: int,
        successful_execute_with_plot_count: int,
    ) -> str:
        needed_steps: List[str] = []
        remaining_successes = max(
            0,
            ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE - successful_execute_count,
        )
        if remaining_successes > 0:
            needed_steps.append(
                f"run at least {remaining_successes} more successful execute_code iteration(s)"
            )
        if successful_execute_with_evidence_count <= 0:
            needed_steps.append("produce meaningful stdout or other concrete evidence")
        if successful_execute_with_plot_count <= 0:
            needed_steps.append("save at least one meaningful single-chart plot")
        if not needed_steps:
            needed_steps.append("continue validating the current conclusion with another execute_code step")
        return (
            "Do not call complete_analysis yet. Next, "
            + ", ".join(needed_steps)
            + ". After that tool result, the next assistant response must only call "
            "reflect_on_results."
        )

    def _truncate_feedback(self, text: str, max_chars: int = ANALYZER_MAX_SYNTAX_ERROR_FEEDBACK_CHARS) -> str:
        if len(text) <= max_chars:
            return text
        return text[: max_chars - 3].rstrip() + "..."

    def _count_unescaped_quote(self, text: str, quote: str) -> int:
        count = 0
        escaped = False
        for ch in text:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == quote:
                count += 1
        return count

    def _infer_unterminated_quote_type(self, line: str, err: SyntaxError) -> Optional[str]:
        candidates: List[str] = []
        for quote in ('"', "'"):
            if quote * 3 in line:
                continue
            if self._count_unescaped_quote(line, quote) % 2 == 1:
                candidates.append(quote)

        if len(candidates) == 1:
            return candidates[0]

        err_text = str(getattr(err, "text", "") or "")
        err_offset = int(getattr(err, "offset", 0) or 0)
        if err_text and err_offset > 0 and err_offset <= len(err_text):
            ch = err_text[err_offset - 1]
            if ch in ('"', "'") and ch in candidates:
                return ch

        if '"' in candidates:
            return '"'
        if "'" in candidates:
            return "'"
        return None

    def _auto_fix_unterminated_string_literal_once(self, code: str, err: SyntaxError) -> Optional[str]:
        line_no = int(getattr(err, "lineno", 0) or 0)
        if line_no <= 0:
            return None
        lines = code.splitlines()
        idx = line_no - 1
        if idx < 0 or idx + 1 >= len(lines):
            return None

        line = lines[idx]
        quote = self._infer_unterminated_quote_type(line, err)
        if quote is None:
            return None
        if quote * 3 in line:
            return None

        merged = line.rstrip()
        max_merge = max(1, ANALYZER_MAX_UNTERMINATED_STRING_LINE_MERGE)
        end = min(len(lines), idx + 1 + max_merge)
        consumed = 0
        for j in range(idx + 1, end):
            merged = merged + r"\n" + lines[j]
            consumed += 1
            if self._count_unescaped_quote(merged, quote) % 2 == 0:
                fixed_lines = lines[:idx] + [merged] + lines[idx + consumed + 1 :]
                return "\n".join(fixed_lines)

        # Fallback for the most common case: line ends with an opening quote
        # (e.g. print(") and next line contains the continuation text.
        stripped = line.rstrip()
        if stripped.endswith(quote):
            merged = stripped + r"\n" + lines[idx + 1]
            fixed_lines = lines[:idx] + [merged] + lines[idx + 2 :]
            return "\n".join(fixed_lines)
        return None

    def _auto_fix_smart_quotes_once(self, code: str) -> Optional[str]:
        replacements = {
            "“": '"',
            "”": '"',
            "‘": "'",
            "’": "'",
        }
        fixed = code
        for src, dst in replacements.items():
            fixed = fixed.replace(src, dst)
        if fixed == code:
            return None
        return fixed

    def _auto_fix_code_fences_once(self, code: str) -> Optional[str]:
        lines = code.splitlines()
        filtered = [line for line in lines if not line.lstrip().startswith("```")]
        if len(filtered) == len(lines):
            return None
        return "\n".join(filtered)

    def _auto_fix_expected_colon_once(self, code: str, err: SyntaxError) -> Optional[str]:
        line_no = int(getattr(err, "lineno", 0) or 0)
        if line_no <= 0:
            return None
        lines = code.splitlines()
        idx = line_no - 1
        if idx < 0 or idx >= len(lines):
            return None
        line = lines[idx]
        if "#" in line:
            return None
        stripped = line.rstrip()
        if stripped.endswith(":"):
            return None
        head = stripped.lstrip()
        tokens = (
            "if ",
            "elif ",
            "else",
            "for ",
            "while ",
            "try",
            "except",
            "finally",
            "with ",
            "def ",
            "class ",
            "match ",
            "case ",
        )
        if not head.startswith(tokens):
            return None
        lines[idx] = stripped + ":"
        return "\n".join(lines)

    def _auto_fix_unclosed_bracket_once(self, code: str, err: SyntaxError) -> Optional[str]:
        msg = str(getattr(err, "msg", "") or "")
        bracket_map = {"(": ")", "[": "]", "{": "}"}
        opening = None
        for op in bracket_map:
            if f"'{op}' was never closed" in msg:
                opening = op
                break
        if opening is None:
            return None
        lines = code.splitlines()
        line_no = int(getattr(err, "lineno", 0) or 0)
        idx = line_no - 1 if line_no > 0 else len(lines) - 1
        if idx < 0 or idx >= len(lines):
            return None
        line = lines[idx]
        if line.count(opening) <= line.count(bracket_map[opening]):
            return None
        lines[idx] = line + bracket_map[opening]
        return "\n".join(lines)

    def _auto_fix_trailing_backslash_once(self, code: str, err: SyntaxError) -> Optional[str]:
        line_no = int(getattr(err, "lineno", 0) or 0)
        lines = code.splitlines()
        idx = line_no - 1 if line_no > 0 else len(lines) - 1
        if idx < 0 or idx >= len(lines):
            return None
        line = lines[idx]
        if not line.rstrip().endswith("\\"):
            return None
        lines[idx] = line.rstrip()[:-1].rstrip()
        return "\n".join(lines)

    def _auto_fix_backtick_strings_once(self, code: str, err: SyntaxError) -> Optional[str]:
        line_no = int(getattr(err, "lineno", 0) or 0)
        if line_no <= 0:
            return None
        lines = code.splitlines()
        idx = line_no - 1
        if idx < 0 or idx >= len(lines):
            return None
        line = lines[idx]
        if "`" not in line:
            return None
        if "'" in line:
            return None
        replaced = line.replace("`", "'")
        if replaced == line:
            return None
        lines[idx] = replaced
        return "\n".join(lines)

    def _build_syntax_error_guidance(self, err: SyntaxError, line_text: str) -> str:
        msg = (err.msg or "").lower()
        line_lower = (line_text or "").lower()
        if "unterminated string literal" in msg or "eol while scanning string literal" in msg:
            return ANALYZER_SYNTAX_ERROR_TIP_UNTERMINATED_STRING
        if "indent" in msg or "expected an indented block" in msg:
            return ANALYZER_SYNTAX_ERROR_TIP_INDENTATION
        if "invalid syntax" in msg and ("elif" in line_lower or "else" in line_lower):
            return ANALYZER_SYNTAX_ERROR_TIP_INDENTATION
        return (
            "Fix Python syntax first, then rerun execute_code. Keep statements simple and avoid "
            "complex inline string formatting when debugging syntax issues."
        )

    def _preflight_syntax_check(self, code: str, dataset_path: str = "") -> Dict[str, Any]:
        working = code
        notes: List[str] = []
        last_err: Optional[SyntaxError] = None

        normalized_paths, path_note = self._normalize_dataset_path_literals(working, dataset_path)
        if normalized_paths != working:
            working = normalized_paths
            if path_note:
                notes.append(path_note)
        if not ANALYZER_ENABLE_SYNTAX_PREFLIGHT:
            if notes:
                return {
                    "ok": True,
                    "code": working,
                    "auto_fixed": True,
                    "auto_fix_note": "; ".join(notes),
                }
            return {"ok": True, "code": working}

        if ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX:
            smart = self._auto_fix_smart_quotes_once(working)
            if smart and smart != working:
                working = smart
                notes.append("Auto-normalized smart quotes to ASCII quotes.")
            no_fences = self._auto_fix_code_fences_once(working)
            if no_fences and no_fences != working:
                working = no_fences
                notes.append("Auto-removed stray markdown code fences.")

        max_passes = max(1, ANALYZER_MAX_COMMON_SYNTAX_AUTO_FIX_PASSES)
        for _ in range(max_passes):
            try:
                compile(working, "<analyzer_user_code>", "exec")
                if notes:
                    return {
                        "ok": True,
                        "code": working,
                        "auto_fixed": True,
                        "auto_fix_note": "; ".join(notes),
                    }
                return {"ok": True, "code": working}
            except SyntaxError as err:
                last_err = err
                msg = (getattr(err, "msg", "") or "").lower()
                fixed: Optional[str] = None
                note: Optional[str] = None

                if (
                    ANALYZER_ENABLE_UNTERMINATED_STRING_AUTO_FIX
                    and ("unterminated string literal" in msg or "eol while scanning string literal" in msg)
                ):
                    for _ in range(ANALYZER_MAX_UNTERMINATED_STRING_AUTO_FIX_PASSES):
                        candidate = self._auto_fix_unterminated_string_literal_once(working, err)
                        if not candidate or candidate == working:
                            break
                        working = candidate
                        note = (
                            "Auto-fixed unterminated string literal by replacing raw line break(s) "
                            "inside a quoted string with '\\n'."
                        )
                        try:
                            compile(working, "<analyzer_user_code>", "exec")
                            notes.append(note)
                            return {
                                "ok": True,
                                "code": working,
                                "auto_fixed": True,
                                "auto_fix_note": "; ".join(notes),
                            }
                        except SyntaxError as next_err:
                            err = next_err
                            last_err = next_err
                    msg = (getattr(err, "msg", "") or "").lower()

                if fixed is None and ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX:
                    if "expected ':'" in msg:
                        candidate = self._auto_fix_expected_colon_once(working, err)
                        if candidate and candidate != working:
                            fixed = candidate
                            note = "Auto-added missing ':' for Python block header."

                if fixed is None and ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX:
                    if "was never closed" in msg:
                        candidate = self._auto_fix_unclosed_bracket_once(working, err)
                        if candidate and candidate != working:
                            fixed = candidate
                            note = "Auto-added missing closing bracket for unclosed expression."

                if fixed is None and ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX:
                    if "unexpected eof while parsing" in msg or "unexpected character after line continuation character" in msg:
                        candidate = self._auto_fix_trailing_backslash_once(working, err)
                        if candidate and candidate != working:
                            fixed = candidate
                            note = "Auto-removed dangling trailing backslash line continuation."

                if fixed is None and ANALYZER_ENABLE_COMMON_SYNTAX_AUTO_FIX:
                    err_text = (getattr(err, "text", None) or "")
                    if "`" in err_text and "invalid syntax" in msg:
                        candidate = self._auto_fix_backtick_strings_once(working, err)
                        if candidate and candidate != working:
                            fixed = candidate
                            note = "Auto-replaced accidental backtick string quoting with single quotes."

                if fixed is None:
                    break

                working = fixed
                if note:
                    notes.append(note)

        err = last_err or SyntaxError("invalid syntax")
        line_no = int(getattr(err, "lineno", 0) or 0)
        col_no = int(getattr(err, "offset", 0) or 0)
        raw_line = (getattr(err, "text", None) or "").rstrip("\n")
        if (not raw_line) and line_no > 0:
            lines = working.splitlines()
            if 1 <= line_no <= len(lines):
                raw_line = lines[line_no - 1]

        guidance = self._build_syntax_error_guidance(err, raw_line)
        err_msg = str(getattr(err, "msg", "") or "invalid syntax")
        summary = (
            f"SyntaxError: {err_msg} (line {line_no}, column {col_no}).\n"
            f"Code line: {raw_line}\n"
            f"Guidance: {guidance}"
        ).strip()
        return {
            "ok": False,
            "error_type": "syntax_error",
            "error": self._truncate_feedback(summary),
            "syntax_error": {
                "msg": err_msg,
                "line": line_no,
                "offset": col_no,
                "text": raw_line,
                "guidance": guidance,
            },
        }

    def analyze(
        self,
        plan: PlanItem,
        state: RunState,
        store: RunStore,
        control_callback: Callable[[], Dict[str, Any]] | None = None,
        checkpoint_path: str | None = None,
    ) -> ExecutionRecord | AnalyzerRunResult:
        """
        Run analysis for a single plan.

        Normal completion returns an ExecutionRecord wrapped in AnalyzerRunResult
        so callers can also observe checkpoint metadata. Controlled pause or
        terminate exits return AnalyzerRunResult with control_action set.
        """
        start_time = time.time()

        session = AnalysisSession(plan_id=plan.plan_id)
        tools_used: List[Dict[str, Any]] = []
        replay_history: List[str] = []
        initial_reflection_done = False
        must_reflect_next = False
        seq_counter = 0
        seq_lock = threading.Lock()
        attempt_failed_logged = False
        terminal_error_logged = False
        active_timestamp_binding: Any | None = None
        latest_user_text = latest_user_authored_text(state.user_messages)
        prefer_chinese_output = prefers_chinese_text(latest_user_text)
        run_context = build_model_cache_run_context(getattr(store, "run_dir", None))

        def log_attempt_failed(summary: Optional[str]) -> None:
            nonlocal attempt_failed_logged
            if attempt_failed_logged:
                return
            text = (summary or "").strip() or "Plan attempt failed"
            # Keep the event small enough for SSE + UI.
            if len(text) > 800:
                text = text[:800].rstrip() + "..."
            with activate_timestamp_binding(active_timestamp_binding):
                store.log_plan_attempt_failed(plan.plan_id, attempt=1, error_summary=text)
            attempt_failed_logged = True

        def next_seq() -> int:
            nonlocal seq_counter
            with seq_lock:
                seq_counter += 1
                return seq_counter

        def log_system(message: str) -> None:
            with activate_timestamp_binding(active_timestamp_binding):
                store.log_plan_log_delta(
                    plan.plan_id,
                    "system",
                    message if message.endswith("\n") else message + "\n",
                    seq=next_seq(),
                    attempt=1,
                )

        def current_control_state() -> str | None:
            if control_callback is None:
                return None
            try:
                snapshot = control_callback() or {}
            except Exception:
                return None
            if not isinstance(snapshot, dict):
                return None
            control_state = str(snapshot.get("control_state") or "").strip()
            if control_state in {"pause_requested", "terminate_requested", "yield_requested"}:
                return control_state
            return None

        def control_action_from_state(
            control_state: str | None,
        ) -> Literal["pause", "terminate", "yield"] | None:
            if control_state == "pause_requested":
                return "pause"
            if control_state == "terminate_requested":
                return "terminate"
            if control_state == "yield_requested":
                return "yield"
            return None

        def interruptible_model_call(
            params: Dict[str, Any],
            *,
            resume_phase: Literal["analyzing"],
            turn_number: int,
        ) -> tuple[Any | None, AnalyzerRunResult | None]:
            normalization_context = build_analyzer_cache_normalization_context(
                state=state,
                plan_id=plan.plan_id,
            )
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future = executor.submit(
                _call_analyzer_with_cache_context,
                normalization_context,
                run_context,
                params,
            )
            try:
                while True:
                    pending_control_state = current_control_state()
                    if pending_control_state is not None:
                        save_runtime_checkpoint(turn_number)
                        future.cancel()
                        executor.shutdown(wait=False, cancel_futures=True)
                        return (
                            None,
                            AnalyzerRunResult(
                                control_action=control_action_from_state(pending_control_state),
                                checkpoint_path=checkpoint_rel_path,
                                resume_phase=resume_phase,
                            ),
                        )
                    try:
                        response = future.result(timeout=0.05)
                    except concurrent.futures.TimeoutError:
                        continue
                    executor.shutdown(wait=False, cancel_futures=False)
                    return response, None
            except Exception:
                executor.shutdown(wait=False, cancel_futures=True)
                raise

        system_prompt = (
            "You are an autonomous data analyst (Analyzer) running EDA.\n"
            "You MUST use native function-calling tools only.\n"
            "Do NOT emit raw JSON commands or free-form analysis in assistant text.\n\n"
            "Rules:\n"
            "- Each assistant response may contain exactly one tool call.\n"
            "- Normal completion is ONLY via complete_analysis.\n"
            "- Do NOT call complete_analysis early. Only call it when the plan objective has been answered as fully as possible with concrete evidence.\n"
            "- If any key uncertainty remains, or evidence is insufficient to answer the plan objective, continue analysis with another execute_code step.\n"
            "- Prefer additional validation over early stopping: run multiple execute_code iterations when needed to make the conclusion robust.\n"
            f"- Before complete_analysis, run at least {ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE} successful execute_code iteration(s); use later iteration(s) to validate/deepen findings.\n"
            "- Prefer the existing df variable for the loaded dataset. If you must reload the raw dataset, use pd.read_csv(DATASET_PATH) only.\n"
            "- Never paste a literal local path, upload path, or Windows backslash dataset path into code.\n"
            "- If you need evidence, run execute_code; for plots, use the provided PLOTS_DIR variable (do NOT create a literal folder named 'PLOTS_DIR').\n"
            "- For plots, save as PNG with filenames starting with PLAN_ID. Do NOT call plt.show().\n"
            "- Generate plots only when they are meaningful and supported by sufficient valid data.\n"
            "- For each important finding or key conclusion, provide a corresponding chart as supporting evidence whenever meaningful and feasible.\n"
            "- Do NOT generate any code producing images containing more than one chart (multi-panel/subplot grids are not allowed).\n"
            "- Each saved image must contain exactly one chart (multi-panel/subplot grids are not allowed).\n"
            "- If a meaningful plot is not possible, do not plot and explain why in stdout.\n"
            "- Before complete_analysis, self-check whether key conclusions are chart-supported; if not feasible, explain the limitation in stdout.\n"
            "- For each key finding, print concise numeric evidence to stdout so downstream summarization can link output artifacts.\n"
            "- Treat every execute_code as self-contained: do not assume temporary variables or intermediate state from prior execute_code turns will still exist; recreate prerequisites when needed.\n"
            "- Keep Python syntax strict: never place raw line breaks inside quoted strings.\n"
            "- For debug output, prefer simple prints, e.g. print('label') then print(value).\n"
            "- If a syntax error is reported, fix syntax first and run execute_code again.\n"
            "- After execute_code, use stdout/stderr and artifact paths in the tool result for reflection.\n"
            "- First: call reflect_on_results with a short plan (1-3 user-facing sentences).\n"
            "- Only after that, call execute_code.\n"
            "- After each execute_code, call reflect_on_results with 1-3 user-facing sentences: what you did, what you saw, and what you will do next. Avoid hidden chain-of-thought.\n"
            "- Keep code efficient and deterministic.\n"
            "- Match any natural-language reflections, explanations, and final analysis text to the user's language.\n"
            f"- {strict_language_match_instruction(latest_user_text)}\n"
            "- Latest user-authored message for language matching:\n"
            f"{latest_user_text or '<none provided>'}\n"
            "- Keep tool names, JSON keys, schema fields, and Python code in English.\n"
        )

        # Initial context is provided once. Tool results are appended as tool messages.
        base_messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"PLAN_ID: {plan.plan_id}\n"
                    f"Plan: {plan.text}\n"
                    + f"Target natural-language output language: {'Chinese' if prefer_chinese_output else 'match latest user-authored message'}\n"
                    + "Latest user-authored message for language matching:\n"
                    + f"{latest_user_text or '<none provided>'}\n"
                    f"Dataset identity: {build_dataset_identity(state.dataset_path, state.dataset_info)}\n"
                    f"Dataset schema:\n{state.dataset_schema}\n"
                ),
            },
        ]
        session.messages = list(base_messages)
        session.trace_messages = list(base_messages)

        code_path = None
        stdout_path = None
        stderr_path = None
        plot_paths: List[str] = []
        stdout_content = ""
        stderr_content = ""
        error_message = None
        success = False
        did_execute_code = False
        any_code_success = False
        successful_execute_count = 0
        successful_execute_with_evidence_count = 0
        successful_execute_with_plot_count = 0
        code_attempt = 0
        thought_signature_retry_used = False
        analysis_path: str | None = None
        checkpoint_rel_path = checkpoint_path or plan.checkpoint_path
        start_turn = 1

        def save_runtime_checkpoint(turn: int) -> str:
            nonlocal analysis_path, checkpoint_rel_path
            analysis_path = self._save_analysis_process(
                store,
                plan,
                session,
                tools_used,
                replay_history,
            )
            payload = {
                "plan_id": plan.plan_id,
                "plan_text": plan.text,
                "messages": session.messages,
                "trace_messages": session.trace_messages,
                "tools_used": tools_used,
                "replay_history": replay_history,
                "completed": session.completed,
                "failed": session.failed,
                "error_message": session.error_message,
                "turn": turn,
                "seq_counter": seq_counter,
                "code_attempt": code_attempt,
                "initial_reflection_done": initial_reflection_done,
                "must_reflect_next": must_reflect_next,
                "did_execute_code": did_execute_code,
                "any_code_success": any_code_success,
                "successful_execute_count": successful_execute_count,
                "successful_execute_with_evidence_count": successful_execute_with_evidence_count,
                "successful_execute_with_plot_count": successful_execute_with_plot_count,
                "code_path": code_path,
                "stdout_path": stdout_path,
                "stderr_path": stderr_path,
                "plot_paths": plot_paths,
                "stdout_content": stdout_content,
                "stderr_content": stderr_content,
                "analysis_path": analysis_path,
            }
            checkpoint_rel_path = store.save_analysis_checkpoint(plan.plan_id, payload)
            return checkpoint_rel_path

        def append_tool_feedback(tool_call_id: str, payload: Dict[str, Any], turn: int) -> None:
            self._append_tool_message(session, tool_call_id, payload)
            save_runtime_checkpoint(turn)

        restore_payload = store.load_analysis_checkpoint(checkpoint_rel_path or "")
        if restore_payload:
            restored_messages = restore_payload.get("messages")
            if isinstance(restored_messages, list) and restored_messages:
                session.messages = restored_messages
            restored_trace_messages = restore_payload.get("trace_messages")
            if isinstance(restored_trace_messages, list) and restored_trace_messages:
                session.trace_messages = restored_trace_messages
            restored_tools_used = restore_payload.get("tools_used")
            if isinstance(restored_tools_used, list):
                tools_used = [item for item in restored_tools_used if isinstance(item, dict)]
            replay_history = self._normalize_replay_history(restore_payload.get("replay_history"))
            session.completed = bool(restore_payload.get("completed", False))
            session.failed = bool(restore_payload.get("failed", False))
            session.error_message = (
                str(restore_payload.get("error_message"))
                if restore_payload.get("error_message") is not None
                else None
            )
            start_turn = max(1, int(restore_payload.get("turn", 1) or 1))
            seq_counter = int(restore_payload.get("seq_counter", 0) or 0)
            code_attempt = int(restore_payload.get("code_attempt", 0) or 0)
            initial_reflection_done = bool(restore_payload.get("initial_reflection_done", False))
            must_reflect_next = bool(restore_payload.get("must_reflect_next", False))
            did_execute_code = bool(restore_payload.get("did_execute_code", False))
            any_code_success = bool(restore_payload.get("any_code_success", False))
            successful_execute_count = int(restore_payload.get("successful_execute_count", 0) or 0)
            successful_execute_with_evidence_count = int(
                restore_payload.get("successful_execute_with_evidence_count", 0) or 0
            )
            successful_execute_with_plot_count = int(
                restore_payload.get("successful_execute_with_plot_count", 0) or 0
            )
            code_path = restore_payload.get("code_path") if isinstance(restore_payload.get("code_path"), str) else None
            stdout_path = restore_payload.get("stdout_path") if isinstance(restore_payload.get("stdout_path"), str) else None
            stderr_path = restore_payload.get("stderr_path") if isinstance(restore_payload.get("stderr_path"), str) else None
            restored_plot_paths = restore_payload.get("plot_paths")
            if isinstance(restored_plot_paths, list):
                plot_paths = [str(item) for item in restored_plot_paths if str(item).strip()]
            stdout_content = str(restore_payload.get("stdout_content", "") or "")
            stderr_content = str(restore_payload.get("stderr_content", "") or "")
            restored_analysis_path = restore_payload.get("analysis_path")
            if isinstance(restored_analysis_path, str) and restored_analysis_path.strip():
                analysis_path = restored_analysis_path
            if (
                session.messages
                and isinstance(session.messages[-1], dict)
                and session.messages[-1].get("role") == "assistant"
                and session.messages[-1].get("tool_calls")
            ):
                session.messages.pop()
            if (
                session.trace_messages
                and isinstance(session.trace_messages[-1], dict)
                and session.trace_messages[-1].get("role") == "assistant"
                and session.trace_messages[-1].get("tool_calls")
            ):
                session.trace_messages.pop()
        else:
            # Log that the plan attempt started (attempt=1 for MVP).
            store.log_plan_attempt_started(plan.plan_id, attempt=1)

        if ANALYZER_OPENAI_CLIENT is None or not ANALYZER_OPENAI_API_KEY:
            # Degraded mode: framework can still run, but Analyzer requires an LLM to drive the tool loop.
            error_message = (
                "OpenAI-compatible LLM client is not configured for Analyzer. "
                "Set OPENAI_API_KEY_n1n in .env and ensure ANALYZER_OPENAI_BASE_URL is reachable: "
                f"{ANALYZER_OPENAI_BASE_URL}"
            )
            log_system(f"[SYSTEM ERROR]\n{error_message}")
            session.failed = True
            session.error_message = error_message
            log_attempt_failed(error_message)
            save_runtime_checkpoint(start_turn)
            return AnalyzerRunResult(
                record=ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=False,
                    code_path=code_path,
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    plot_paths=plot_paths,
                    stdout_content=stdout_content,
                    stderr_content=stderr_content,
                    error_message=error_message,
                    execution_time_ms=int((time.time() - start_time) * 1000),
                    analysis_path=analysis_path,
                ),
                checkpoint_path=checkpoint_rel_path,
                timestamp_binding=active_timestamp_binding,
            )

        tool_specs = self._tool_specs()

        for turn in range(start_turn, self.max_turns + 1):
            active_timestamp_binding = None
            pending_control_state = current_control_state()
            if pending_control_state is not None:
                save_runtime_checkpoint(turn)
                return AnalyzerRunResult(
                    control_action=control_action_from_state(pending_control_state),
                    checkpoint_path=checkpoint_rel_path,
                    resume_phase="analyzing",
                    timestamp_binding=active_timestamp_binding,
                )
            # LLM call via native tool-calling.
            try:
                params: Dict[str, Any] = {
                    "model": ANALYZER_MODEL_NAME,
                    "messages": session.messages,
                    "temperature": ANALYZER_TEMPERATURE,
                    "tools": tool_specs,
                    "tool_choice": self._tool_choice_for_turn(
                        initial_reflection_done=initial_reflection_done,
                        must_reflect_next=must_reflect_next,
                    ),
                }
                if LLM_MAX_TOKENS:
                    params["max_tokens"] = LLM_MAX_TOKENS
                if LLM_TIMEOUT_SECS:
                    params["timeout"] = LLM_TIMEOUT_SECS
                consume_last_model_cache_binding()
                resp, interrupt_result = interruptible_model_call(
                    params,
                    resume_phase="analyzing",
                    turn_number=turn,
                )
                if interrupt_result is not None:
                    return interrupt_result
                assert resp is not None
                active_timestamp_binding = consume_last_model_cache_binding()
                assistant_message = resp.choices[0].message
            except Exception as e:
                if (
                    not thought_signature_retry_used
                    and self._is_thought_signature_invalid_error(e)
                ):
                    thought_signature_retry_used = True
                    log_system(
                        "[SYSTEM NOTE]\nDetected invalid thought_signature in LLM history. "
                        "Resetting chat history to base context and retrying once."
                    )
                    self._reset_messages_after_signature_error(session)
                    try:
                        params["messages"] = session.messages
                        consume_last_model_cache_binding()
                        resp, interrupt_result = interruptible_model_call(
                            params,
                            resume_phase="analyzing",
                            turn_number=turn,
                        )
                        if interrupt_result is not None:
                            return interrupt_result
                        assert resp is not None
                        active_timestamp_binding = consume_last_model_cache_binding()
                        assistant_message = resp.choices[0].message
                    except Exception as retry_error:
                        error_message = (
                            "LLM call failed after thought_signature reset retry: "
                            f"{retry_error}"
                        )
                        session.error_message = error_message
                        log_system(f"[SYSTEM ERROR]\n{error_message}")
                        terminal_error_logged = True
                        break
                else:
                    error_message = f"LLM call failed: {e}"
                    session.error_message = error_message
                    log_system(f"[SYSTEM ERROR]\n{error_message}")
                    terminal_error_logged = True
                    break

            # Normalized tool calls — used ONLY for internal execution routing
            normalized_tool_calls = self._normalize_tool_calls(assistant_message, turn)
            assistant_text = _extract_text_content(getattr(assistant_message, "content", ""))

            # Track 1: Raw message for LLM context (preserves thought_signature etc.)
            raw_assistant_msg = _serialize_raw_assistant_message(assistant_message)
            session.messages.append(raw_assistant_msg)

            # Track 2: Trace-formatted message for reporter
            trace_content = (
                self._build_tool_trace_content(normalized_tool_calls)
                if normalized_tool_calls
                else assistant_text
            )
            trace_msg: Dict[str, Any] = {"role": "assistant", "content": trace_content}
            if normalized_tool_calls:
                trace_msg["tool_calls"] = normalized_tool_calls
            session.trace_messages.append(trace_msg)
            save_runtime_checkpoint(turn)

            if not normalized_tool_calls:
                log_system(
                    "[SYSTEM NOTE]\nProtocol violation: expected native tool_calls, received plain assistant text."
                )
                nudge_msg = {
                    "role": "system",
                    "content": (
                        "Protocol reminder: use native tool-calling only. Call one of: "
                        "execute_code, reflect_on_results, complete_analysis."
                    ),
                }
                session.messages.append(nudge_msg)
                session.trace_messages.append(nudge_msg)
                save_runtime_checkpoint(turn)
                continue

            selected_tool_call_index = self._select_tool_call_for_execution(
                normalized_tool_calls,
                initial_reflection_done=initial_reflection_done,
                must_reflect_next=must_reflect_next,
            )
            if len(normalized_tool_calls) > 1:
                log_system(
                    "[SYSTEM NOTE]\nProtocol reminder: each assistant response may contain only "
                    "one tool call. Extra tool calls will be ignored."
                )

            handled_any = False
            for index, call in enumerate(normalized_tool_calls):
                pending_control_state = current_control_state()
                if pending_control_state is not None:
                    save_runtime_checkpoint(turn)
                    return AnalyzerRunResult(
                        control_action=control_action_from_state(pending_control_state),
                        checkpoint_path=checkpoint_rel_path,
                        resume_phase="analyzing",
                        timestamp_binding=active_timestamp_binding,
                    )
                call_id = str(call.get("id") or "")
                fn = call.get("function") or {}
                tool = str(fn.get("name") or "").strip()
                arguments_raw = fn.get("arguments")

                if selected_tool_call_index is not None and index != selected_tool_call_index:
                    append_tool_feedback(
                        call_id,
                        {
                            "success": False,
                            "error": self._ignored_extra_tool_call_feedback(
                                initial_reflection_done=initial_reflection_done,
                                must_reflect_next=must_reflect_next,
                            ),
                        },
                        turn,
                    )
                    continue

                handled_any = True

                if session.completed:
                    append_tool_feedback(
                        call_id,
                        {"success": False, "error": "Analysis already completed."},
                        turn,
                    )
                    continue

                try:
                    cmd = self._parse_tool_arguments(arguments_raw)
                except Exception as e:
                    err = f"Invalid tool arguments for '{tool}': {e}"
                    log_system(f"[SYSTEM ERROR]\n{err}")
                    append_tool_feedback(call_id, {"success": False, "error": err}, turn)
                    continue

                if must_reflect_next and tool != "reflect_on_results":
                    err = "After execute_code, call reflect_on_results first."
                    log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                    append_tool_feedback(
                        call_id,
                        {
                            "success": False,
                            "error": err,
                            "next_action": (
                                "Your next assistant response must only call "
                                "reflect_on_results. Do not call execute_code or "
                                "complete_analysis until after that reflection."
                            ),
                        },
                        turn,
                    )
                    continue

                if tool == "reflect_on_results":
                    reflection = str(cmd.get("reflection", "")).strip()
                    if not reflection:
                        err = "reflect_on_results requires a non-empty reflection."
                        log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                        append_tool_feedback(call_id, {"success": False, "error": err}, turn)
                        continue
                    if prefer_chinese_output and not contains_cjk_text(reflection):
                        err = (
                            "reflect_on_results must match the latest user-authored message's language. "
                            "Please rewrite the reflection in Chinese."
                        )
                        error_message = err
                        log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": (
                                    "Call reflect_on_results again with 1-3 short user-facing sentences in Chinese."
                                ),
                            },
                            turn,
                        )
                        continue
                    tools_used.append({"turn": turn, "tool": tool, "reflection": reflection[:2000]})
                    log_system(f"[REFLECTION]\n{reflection}")
                    initial_reflection_done = True
                    must_reflect_next = False
                    append_tool_feedback(call_id, {"success": True}, turn)
                    continue

                if tool == "complete_analysis":
                    log_system("[TOOL] complete_analysis")
                    note = str(cmd.get("note", "")).strip()
                    if note and prefer_chinese_output and not contains_cjk_text(note):
                        err = (
                            "complete_analysis.note must match the latest user-authored message's language. "
                            "If you include a note here, write it in Chinese."
                        )
                        error_message = err
                        log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": (
                                    "If you include complete_analysis.note, keep it in Chinese."
                                ),
                            },
                            turn,
                        )
                        continue
                    if not did_execute_code:
                        err = (
                            "You must call execute_code at least once to produce evidence "
                            "(stdout and/or plots) before complete_analysis."
                        )
                        log_system("[SYSTEM ERROR]\nProtocol violation: complete_analysis before any execute_code.")
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": self._complete_analysis_next_action(
                                    successful_execute_count=successful_execute_count,
                                    successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                                    successful_execute_with_plot_count=successful_execute_with_plot_count,
                                ),
                            },
                            turn,
                        )
                        continue
                    if successful_execute_count < ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE:
                        err = (
                            "Insufficient analysis depth: run at least "
                            f"{ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE} successful execute_code "
                            "iterations before complete_analysis."
                        )
                        log_system(
                            "[SYSTEM ERROR]\nProtocol violation: complete_analysis called before minimum "
                            "successful execute_code depth."
                        )
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": self._complete_analysis_next_action(
                                    successful_execute_count=successful_execute_count,
                                    successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                                    successful_execute_with_plot_count=successful_execute_with_plot_count,
                                ),
                            },
                            turn,
                        )
                        continue
                    if successful_execute_with_evidence_count <= 0:
                        err = (
                            "No meaningful evidence found yet. Generate non-empty stdout and/or meaningful "
                            "plot artifacts before complete_analysis."
                        )
                        log_system(
                            "[SYSTEM ERROR]\nProtocol violation: complete_analysis called without meaningful evidence."
                        )
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": self._complete_analysis_next_action(
                                    successful_execute_count=successful_execute_count,
                                    successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                                    successful_execute_with_plot_count=successful_execute_with_plot_count,
                                ),
                            },
                            turn,
                        )
                        continue
                    if successful_execute_with_plot_count <= 0:
                        err = (
                            "No plot artifacts found yet. Generate at least one meaningful plot before "
                            "complete_analysis."
                        )
                        log_system(
                            "[SYSTEM ERROR]\nProtocol violation: complete_analysis called without plot artifacts."
                        )
                        append_tool_feedback(
                            call_id,
                            {
                                "success": False,
                                "error": err,
                                "next_action": self._complete_analysis_next_action(
                                    successful_execute_count=successful_execute_count,
                                    successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                                    successful_execute_with_plot_count=successful_execute_with_plot_count,
                                ),
                            },
                            turn,
                        )
                        continue

                    tools_used.append(
                        {"turn": turn, "tool": tool, "note": note[:2000]}
                    )
                    success = any_code_success
                    session.completed = True
                    append_tool_feedback(
                        call_id,
                        {"success": True, "completed": True},
                        turn,
                    )
                    continue

                if tool != "execute_code":
                    err = f"Unknown tool '{tool}'. Use the defined tools only."
                    log_system(f"[SYSTEM ERROR]\n{err}")
                    append_tool_feedback(call_id, {"success": False, "error": err}, turn)
                    continue

                # execute_code
                if not initial_reflection_done:
                    err = "Call reflect_on_results with a brief plan before execute_code."
                    log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                    append_tool_feedback(call_id, {"success": False, "error": err}, turn)
                    continue

                user_code = cmd.get("code")
                if not isinstance(user_code, str) or not user_code.strip():
                    err = "execute_code requires a non-empty 'code' string."
                    log_system(f"[SYSTEM ERROR]\nProtocol violation: {err}")
                    append_tool_feedback(call_id, {"success": False, "error": err}, turn)
                    continue

                cleaned_code = _sanitize_indentation(user_code)
                if cleaned_code != user_code:
                    log_system("[SYSTEM NOTE]\nApplied indentation cleanup before execution.")
                user_code = cleaned_code

                log_system("[TOOL] execute_code")
                code_attempt += 1

                syntax_check = self._preflight_syntax_check(user_code, state.dataset_path)
                if bool(syntax_check.get("ok")):
                    checked_code = syntax_check.get("code")
                    if isinstance(checked_code, str) and checked_code.strip():
                        if checked_code != user_code and bool(syntax_check.get("auto_fixed")):
                            log_system(
                                "[SYSTEM NOTE]\n"
                                + str(
                                    syntax_check.get("auto_fix_note")
                                    or "Auto-fixed syntax issue before execution."
                                )
                            )
                        user_code = checked_code
                log_system(f"[CODE]\n{user_code.strip()}")
                if not bool(syntax_check.get("ok")):
                    did_execute_code = True
                    stdout_content = ""
                    stderr_content = str(syntax_check.get("error") or "SyntaxError: invalid syntax")
                    code_path = store.save_code(plan.plan_id, user_code, attempt=code_attempt)
                    stdout_path = store.save_stdout(plan.plan_id, stdout_content, attempt=code_attempt)
                    stderr_path = store.save_stderr(plan.plan_id, stderr_content, attempt=code_attempt)
                    plot_paths = []
                    has_meaningful_stdout = False
                    has_meaningful_artifacts = False

                    tools_used.append(
                        {
                            "turn": turn,
                            "tool": tool,
                            "code_path": code_path,
                            "stdout_path": stdout_path,
                            "stderr_path": stderr_path,
                            "plot_paths": plot_paths,
                            "success": False,
                            "has_meaningful_stdout": has_meaningful_stdout,
                            "has_meaningful_artifacts": has_meaningful_artifacts,
                            "error_type": "syntax_error",
                            "syntax_error": syntax_check.get("syntax_error"),
                            "error": stderr_content,
                        }
                    )
                    log_system(f"[EXECUTION ERROR]\n{stderr_content}")

                    tool_feedback = {
                        "success": False,
                        "stdout": stdout_content,
                        "stderr": stderr_content,
                        "artifacts": {
                            "stdout_path": stdout_path,
                            "stderr_path": stderr_path,
                            "plot_paths": plot_paths,
                        },
                        "analysis_depth": {
                            "successful_execute_count": successful_execute_count,
                            "successful_execute_with_evidence_count": successful_execute_with_evidence_count,
                            "successful_execute_with_plot_count": successful_execute_with_plot_count,
                            "min_successful_execute_count_for_complete": ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE,
                        },
                        "error_type": "syntax_error",
                        "syntax_error": syntax_check.get("syntax_error"),
                        "error": stderr_content,
                        "next_action": self._syntax_next_action(syntax_check.get("syntax_error")),
                    }
                    append_tool_feedback(call_id, tool_feedback, turn)
                    must_reflect_next = True
                    continue

                code_path = store.save_code(plan.plan_id, user_code, attempt=code_attempt)
                effective_user_code = self._build_effective_user_code(replay_history, user_code)
                effective_code_path = store.save_effective_code(
                    plan.plan_id,
                    effective_user_code,
                    attempt=code_attempt,
                )
                runtime_user_code = self._build_runtime_user_code(replay_history, user_code)
                injected = self._inject_execution_context(
                    runtime_user_code,
                    store,
                    state.dataset_path,
                    plan.plan_id,
                    state.dataset_info,
                )
                existing_plots = self._get_existing_plots(store, plan.plan_id)

                stdout_chunks: List[str] = []
                stderr_chunks: List[str] = []

                def on_stdout(delta: str) -> None:
                    stdout_chunks.append(delta)
                    if self.enable_streaming:
                        store.log_plan_log_delta(
                            plan.plan_id,
                            "exec_stdout",
                            delta,
                            seq=next_seq(),
                            attempt=code_attempt,
                        )

                def on_stderr(delta: str) -> None:
                    stderr_chunks.append(delta)
                    if self.enable_streaming:
                        store.log_plan_log_delta(
                            plan.plan_id,
                            "exec_stderr",
                            delta,
                            seq=next_seq(),
                            attempt=code_attempt,
                        )

                result = execute_python_code_streaming(
                    injected,
                    on_stdout=on_stdout,
                    on_stderr=on_stderr,
                    timeout=self.timeout,
                    cwd=store.run_dir,
                    stop_requested=current_control_state,
                )
                did_execute_code = True
                any_code_success = any_code_success or bool(result.get("success"))

                stdout_content = "".join(stdout_chunks)
                stderr_content = "".join(stderr_chunks)

                stdout_path = store.save_stdout(plan.plan_id, stdout_content, attempt=code_attempt)
                stderr_path = store.save_stderr(plan.plan_id, stderr_content, attempt=code_attempt)

                plot_paths = self._collect_new_plots(store, plan.plan_id, existing_plots)
                if self.enable_streaming and plot_paths:
                    for path in plot_paths:
                        store.log_plan_log_delta(
                            plan.plan_id,
                            "exec_plot",
                            path + "\n",
                            seq=next_seq(),
                            attempt=code_attempt,
                        )
                has_meaningful_stdout = self._stdout_has_meaningful_evidence(stdout_content)
                has_meaningful_artifacts = has_meaningful_stdout or bool(plot_paths)
                if bool(result.get("success")):
                    successful_execute_count += 1
                    if has_meaningful_artifacts:
                        successful_execute_with_evidence_count += 1
                    if plot_paths:
                        successful_execute_with_plot_count += 1
                    replay_history.append(user_code.strip())

                tools_used.append(
                    {
                        "turn": turn,
                        "tool": tool,
                        "code_path": code_path,
                        "effective_code_path": effective_code_path,
                        "stdout_path": stdout_path,
                        "stderr_path": stderr_path,
                        "plot_paths": plot_paths,
                        "success": bool(result.get("success")),
                        "has_meaningful_stdout": has_meaningful_stdout,
                        "has_meaningful_artifacts": has_meaningful_artifacts,
                        "error_type": None if bool(result.get("success")) else "runtime_error",
                        "syntax_error": None,
                        "error": result.get("error"),
                    }
                )
                if not result.get("success"):
                    error_summary = result.get("error") or "Execution failed"
                    log_system(f"[EXECUTION ERROR]\n{error_summary}")
                save_runtime_checkpoint(turn)

                tool_feedback = {
                    "success": bool(result.get("success")),
                    "stdout": stdout_content,
                    "stderr": stderr_content,
                    "artifacts": {
                        "stdout_path": stdout_path,
                        "stderr_path": stderr_path,
                        "plot_paths": plot_paths,
                    },
                    "analysis_depth": {
                        "successful_execute_count": successful_execute_count,
                        "successful_execute_with_evidence_count": successful_execute_with_evidence_count,
                        "successful_execute_with_plot_count": successful_execute_with_plot_count,
                        "min_successful_execute_count_for_complete": ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE,
                    },
                    "error_type": None if bool(result.get("success")) else "runtime_error",
                    "syntax_error": None,
                    "error": result.get("error"),
                    "next_action": self._runtime_next_action(
                        result.get("error"),
                        stderr_content,
                    ),
                }
                append_tool_feedback(call_id, tool_feedback, turn)
                if result.get("stopped"):
                    return AnalyzerRunResult(
                        control_action=control_action_from_state(str(result.get("control_state") or "")),
                        checkpoint_path=checkpoint_rel_path,
                        resume_phase="analyzing",
                        timestamp_binding=active_timestamp_binding,
                    )
                must_reflect_next = True

            if session.completed:
                break
            if not handled_any:
                log_system(
                    "[SYSTEM NOTE]\nProtocol violation: no valid tool command found. "
                    "Call one of the defined native tools."
                )
                save_runtime_checkpoint(turn)

        if not session.completed:
            session.failed = True
            success = False
            if error_message is None:
                error_message = f"Analyzer did not call complete_analysis within max_turns={self.max_turns}"
            session.error_message = error_message
            if not terminal_error_logged:
                log_system(f"[SYSTEM ERROR]\n{error_message}")
        elif session.completed and not success and error_message is None:
            error_message = "All code executions failed; no successful analysis output."
            session.error_message = error_message
            log_system(f"[SYSTEM ERROR]\n{error_message}")

        if not success:
            log_attempt_failed(error_message)

        save_runtime_checkpoint(self.max_turns)
        return AnalyzerRunResult(
            record=ExecutionRecord(
                plan_id=plan.plan_id,
                success=success,
                code_path=code_path,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                plot_paths=plot_paths,
                stdout_content=stdout_content,
                stderr_content=stderr_content,
                error_message=error_message,
                execution_time_ms=int((time.time() - start_time) * 1000),
                analysis_path=analysis_path,
            ),
            checkpoint_path=checkpoint_rel_path,
            timestamp_binding=active_timestamp_binding,
        )

    def _save_analysis_process(
        self,
        store: RunStore,
        plan: PlanItem,
        session: AnalysisSession,
        tools_used: List[Dict[str, Any]],
        replay_history: List[str],
    ) -> str:
        # Store alongside other logs.
        payload = {
            "plan_id": plan.plan_id,
            "plan_text": plan.text,
            "messages": session.messages,
            "trace_messages": session.trace_messages,
            "tools_used": tools_used,
            "replay_history": replay_history,
            "completed": session.completed,
            "failed": session.failed,
            "error_message": session.error_message,
        }
        rel_path = store.save_analysis_process(plan.plan_id, payload)
        return rel_path

    def _inject_execution_context(
        self,
        code: str,
        store: RunStore,
        dataset_path: str,
        plan_id: str,
        dataset_info: dict[str, Any] | None = None,
    ) -> str:
        """Prepend a stable context so LLM code can focus on analysis."""
        dataset_delimiter = ","
        if isinstance(dataset_info, dict):
            raw_delimiter = dataset_info.get("delimiter")
            if isinstance(raw_delimiter, str) and raw_delimiter in {",", ";", "\t", "|"}:
                dataset_delimiter = raw_delimiter
        backend_setup = (
            "import os\n"
            "import warnings\n"
            "import pandas as pd\n"
            "import matplotlib\n"
            "matplotlib.use('Agg')\n"
            "import matplotlib.pyplot as plt\n"
            "try:\n"
            "    import seaborn as sns\n"
            "except Exception as _sns_import_error:\n"
            "    class _MissingSeaborn:\n"
            "        def __getattr__(self, _name):\n"
            "            raise ImportError('seaborn is unavailable in runtime. Install seaborn to use sns.* APIs.') from _sns_import_error\n"
            "    sns = _MissingSeaborn()\n"
            "import builtins\n"
            "from matplotlib.figure import Figure\n"
            "warnings.filterwarnings('ignore', message='FigureCanvasAgg is non-interactive')\n"
            "_orig_print = builtins.print\n"
            "_REPLAY_MODE = False\n"
            "def _patched_print(*args, **kwargs):\n"
            "    if _REPLAY_MODE:\n"
            "        return None\n"
            "    if 'flush' not in kwargs:\n"
            "        kwargs['flush'] = True\n"
            "    return _orig_print(*args, **kwargs)\n"
            "builtins.print = _patched_print\n"
            f"DATASET_PATH = r\"{dataset_path}\"\n"
            f"DATASET_DELIMITER = {dataset_delimiter!r}\n"
            f"PLOTS_DIR = r\"{store.plots_dir}\"\n"
            f"TABLES_DIR = r\"{(store.artifacts_dir / 'tables')}\"\n"
            f"REPO_ROOT = r\"{store.run_dir.parents[2]}\"\n"
            f"PLAN_ID = \"{plan_id}\"\n"
            # Compatibility: some generated code reads PLOTS_DIR via os.environ or mistakenly
            # creates/saves to a literal folder named "PLOTS_DIR" or "artifacts/plots".
            "os.environ['PLOTS_DIR'] = PLOTS_DIR\n"
            "os.environ['TABLES_DIR'] = TABLES_DIR\n"
            "os.makedirs(TABLES_DIR, exist_ok=True)\n"
            "def _coerce_path_string(_p):\n"
            "    try:\n"
            "        raw = os.fspath(_p)\n"
            "    except Exception:\n"
            "        return None\n"
            "    if isinstance(raw, bytes):\n"
            "        try:\n"
            "            raw = raw.decode()\n"
            "        except Exception:\n"
            "            return None\n"
            "    s = str(raw or '')\n"
            "    if not s:\n"
            "        return None\n"
            "    return s\n"
            "def _is_remote_path(s_l):\n"
            "    return s_l.startswith(('http://', 'https://', 's3://', 'gs://', 'ftp://'))\n"
            "def _resolve_csv_write_path(_p):\n"
            "    # Route relative CSV writes into TABLES_DIR to avoid polluting repo root.\n"
            "    s = _coerce_path_string(_p)\n"
            "    if s is None:\n"
            "        return _p, False\n"
            "    s_l = s.lower()\n"
            "    if _is_remote_path(s_l):\n"
            "        return _p, False\n"
            "    if os.path.isabs(s):\n"
            "        return _p, False\n"
            "    if not s_l.endswith('.csv'):\n"
            "        return _p, False\n"
            "    rel = s.lstrip('./\\\\')\n"
            "    return os.path.join(TABLES_DIR, rel), True\n"
            "_orig_pd_read_csv = pd.read_csv\n"
            "def _is_same_dataset_path(_p):\n"
            "    s = _coerce_path_string(_p)\n"
            "    if s is None:\n"
            "        return False\n"
            "    try:\n"
            "        return os.path.normcase(os.path.abspath(s)) == os.path.normcase(os.path.abspath(DATASET_PATH))\n"
            "    except Exception:\n"
            "        return False\n"
            "def _dataset_basename():\n"
            "    return os.path.basename(DATASET_PATH).lower()\n"
            "def _looks_like_dataset_alias_path(_p):\n"
            "    s = _coerce_path_string(_p)\n"
            "    if s is None:\n"
            "        return False\n"
            "    s_l = s.replace('\\\\', '/').lower()\n"
            "    dataset_name = _dataset_basename()\n"
            "    if not dataset_name or not s_l.endswith(dataset_name):\n"
            "        return False\n"
            "    if _is_same_dataset_path(s):\n"
            "        return False\n"
            "    if any(token in s_l for token in ('/_uploads/', '/runs/', '/data/', '/backend/')):\n"
            "        return True\n"
            "    try:\n"
            "        return not os.path.exists(s)\n"
            "    except Exception:\n"
            "        return True\n"
            "def _rewrite_dataset_read_path(_p):\n"
            "    if _is_same_dataset_path(_p):\n"
            "        return DATASET_PATH, True\n"
            "    if _looks_like_dataset_alias_path(_p):\n"
            "        return DATASET_PATH, True\n"
            "    return _p, False\n"
            "def _patched_pd_read_csv(filepath_or_buffer, *args, **kwargs):\n"
            "    dataset_rewritten, dataset_changed = _rewrite_dataset_read_path(filepath_or_buffer)\n"
            "    rewritten, changed = _resolve_csv_write_path(dataset_rewritten)\n"
            "    if changed and not dataset_changed:\n"
            "        try:\n"
            "            if not os.path.exists(rewritten):\n"
            "                original = _coerce_path_string(dataset_rewritten)\n"
            "                if original:\n"
            "                    repo_candidate = os.path.join(REPO_ROOT, original.lstrip('./\\\\'))\n"
            "                    if os.path.exists(repo_candidate):\n"
            "                        rewritten = repo_candidate\n"
            "        except Exception:\n"
            "            pass\n"
            "    read_kwargs = dict(kwargs)\n"
            "    if (\n"
            "        DATASET_DELIMITER\n"
            "        and 'sep' not in read_kwargs\n"
            "        and 'delimiter' not in read_kwargs\n"
            "        and 'dialect' not in read_kwargs\n"
            "        and (\n"
            "            _is_same_dataset_path(filepath_or_buffer)\n"
            "            or _is_same_dataset_path(dataset_rewritten)\n"
            "            or _is_same_dataset_path(rewritten)\n"
            "        )\n"
            "    ):\n"
            "        read_kwargs['sep'] = DATASET_DELIMITER\n"
            "    return _orig_pd_read_csv(rewritten, *args, **read_kwargs)\n"
            "pd.read_csv = _patched_pd_read_csv\n"
            "_orig_df_to_csv = pd.DataFrame.to_csv\n"
            "def _patched_df_to_csv(self, path_or_buf=None, *args, **kwargs):\n"
            "    if path_or_buf is not None:\n"
            "        rewritten, _changed = _resolve_csv_write_path(path_or_buf)\n"
            "        try:\n"
            "            parent = os.path.dirname(os.fspath(rewritten))\n"
            "            if parent:\n"
                "                os.makedirs(parent, exist_ok=True)\n"
            "        except Exception:\n"
            "            pass\n"
            "        return _orig_df_to_csv(self, rewritten, *args, **kwargs)\n"
            "    return _orig_df_to_csv(self, path_or_buf, *args, **kwargs)\n"
            "pd.DataFrame.to_csv = _patched_df_to_csv\n"
            "_orig_series_to_csv = pd.Series.to_csv\n"
            "def _patched_series_to_csv(self, path_or_buf=None, *args, **kwargs):\n"
            "    if path_or_buf is not None:\n"
            "        rewritten, _changed = _resolve_csv_write_path(path_or_buf)\n"
            "        try:\n"
            "            parent = os.path.dirname(os.fspath(rewritten))\n"
            "            if parent:\n"
                "                os.makedirs(parent, exist_ok=True)\n"
            "        except Exception:\n"
            "            pass\n"
            "        return _orig_series_to_csv(self, rewritten, *args, **kwargs)\n"
            "    return _orig_series_to_csv(self, path_or_buf, *args, **kwargs)\n"
            "pd.Series.to_csv = _patched_series_to_csv\n"
            "_orig_os_mkdir = os.mkdir\n"
            "_orig_os_makedirs = os.makedirs\n"
            "def _rewrite_plot_dir(_p):\n"
            "    try:\n"
            "        raw = os.fspath(_p)\n"
            "    except Exception:\n"
            "        raw = str(_p)\n"
            "    if isinstance(raw, bytes):\n"
            "        try:\n"
            "            raw = raw.decode()\n"
            "        except Exception:\n"
            "            return _p\n"
            "    s = (raw or '').replace('\\\\', '/')\n"
            "    if s.startswith('./'):\n"
            "        s = s[2:]\n"
            "    s_l = s.lower()\n"
            "    cwd = os.getcwd().replace('\\\\', '/').rstrip('/')\n"
            "    cwd_l = cwd.lower()\n"
            "    # Common mistakes: treat these as aliases of the real PLOTS_DIR.\n"
            "    if s_l == 'plots_dir' or s_l == 'plots_dir/':\n"
            "        return PLOTS_DIR\n"
            "    if s_l.startswith('plots_dir/'):\n"
            "        return os.path.join(PLOTS_DIR, s[len('PLOTS_DIR/'):])\n"
            "    if s_l == 'artifacts/plots' or s_l == 'artifacts/plots/':\n"
            "        return PLOTS_DIR\n"
            "    if s_l.startswith('artifacts/plots/'):\n"
            "        return os.path.join(PLOTS_DIR, s[len('artifacts/plots/'):])\n"
            "    # Also catch absolute paths anchored at CWD (common when code uses abspath/getcwd).\n"
            "    if s_l == f\"{cwd_l}/plots_dir\" or s_l == f\"{cwd_l}/plots_dir/\":\n"
            "        return PLOTS_DIR\n"
            "    if s_l.startswith(f\"{cwd_l}/plots_dir/\"):\n"
            "        return os.path.join(PLOTS_DIR, s[len(cwd) + 1 + len('PLOTS_DIR/'):])\n"
            "    if s_l == f\"{cwd_l}/artifacts/plots\" or s_l == f\"{cwd_l}/artifacts/plots/\":\n"
            "        return PLOTS_DIR\n"
            "    if s_l.startswith(f\"{cwd_l}/artifacts/plots/\"):\n"
            "        return os.path.join(PLOTS_DIR, s[len(cwd) + 1 + len('artifacts/plots/'):])\n"
            "    return _p\n"
            "def _patched_mkdir(path, *args, **kwargs):\n"
            "    return _orig_os_mkdir(_rewrite_plot_dir(path), *args, **kwargs)\n"
            "def _patched_makedirs(name, *args, **kwargs):\n"
            "    return _orig_os_makedirs(_rewrite_plot_dir(name), *args, **kwargs)\n"
            "os.mkdir = _patched_mkdir\n"
            "os.makedirs = _patched_makedirs\n"
            "try:\n"
            "    import pathlib\n"
            "    _orig_path_mkdir = pathlib.Path.mkdir\n"
            "    def _patched_path_mkdir(self, *args, **kwargs):\n"
            "        rewritten = _rewrite_plot_dir(self)\n"
            "        if rewritten is self:\n"
            "            return _orig_path_mkdir(self, *args, **kwargs)\n"
            "        return _orig_path_mkdir(pathlib.Path(rewritten), *args, **kwargs)\n"
            "    pathlib.Path.mkdir = _patched_path_mkdir\n"
            "except Exception:\n"
            "    pass\n"
            "os.makedirs(PLOTS_DIR, exist_ok=True)\n"
            "_orig_plt_subplots = plt.subplots\n"
            "def _patched_plt_subplots(nrows=1, ncols=1, *args, **kwargs):\n"
            "    try:\n"
            "        rows = int(nrows)\n"
            "        cols = int(ncols)\n"
            "    except Exception:\n"
            "        rows, cols = 1, 1\n"
            "    if rows * cols > 1:\n"
            "        raise ValueError('Multi-panel subplots are disabled. Save one chart per image.')\n"
            "    return _orig_plt_subplots(nrows=nrows, ncols=ncols, *args, **kwargs)\n"
            "plt.subplots = _patched_plt_subplots\n"
            "_orig_plt_subplot = plt.subplot\n"
            "def _patched_plt_subplot(*args, **kwargs):\n"
            "    rows = cols = 1\n"
            "    try:\n"
            "        if len(args) >= 3:\n"
            "            rows = int(args[0]); cols = int(args[1])\n"
            "        elif len(args) >= 1:\n"
            "            code = int(args[0])\n"
            "            if 111 <= code <= 999:\n"
            "                rows = code // 100\n"
            "                cols = (code // 10) % 10\n"
            "        elif 'nrows' in kwargs and 'ncols' in kwargs:\n"
            "            rows = int(kwargs.get('nrows', 1)); cols = int(kwargs.get('ncols', 1))\n"
            "    except Exception:\n"
            "        rows = cols = 1\n"
            "    if rows * cols > 1:\n"
            "        raise ValueError('Multi-panel subplots are disabled. Save one chart per image.')\n"
            "    return _orig_plt_subplot(*args, **kwargs)\n"
            "plt.subplot = _patched_plt_subplot\n"
            "_PLOT_COUNTER = 0\n"
            "_SAVED_FIGNUMS = set()\n"
            "def _axes_with_data(fig):\n"
            "    axes = []\n"
            "    try:\n"
            "        for ax in getattr(fig, 'axes', []) or []:\n"
            "            has_data = getattr(ax, 'has_data', None)\n"
            "            if callable(has_data) and ax.has_data():\n"
            "                axes.append(ax)\n"
            "    except Exception:\n"
            "        return []\n"
            "    return axes\n"
            "def _axis_bounds(ax):\n"
            "    try:\n"
            "        bounds = ax.get_position().bounds\n"
            "        return tuple(float(v) for v in bounds)\n"
            "    except Exception:\n"
            "        return None\n"
            "def _is_probable_support_axis(ax, axes):\n"
            "    bounds = _axis_bounds(ax)\n"
            "    if bounds is None:\n"
            "        return False\n"
            "    width = max(bounds[2], 0.0)\n"
            "    height = max(bounds[3], 0.0)\n"
            "    if width <= 0.0 or height <= 0.0:\n"
            "        return True\n"
            "    for other in axes:\n"
            "        if other is ax:\n"
            "            continue\n"
            "        other_bounds = _axis_bounds(other)\n"
            "        if other_bounds is None:\n"
            "            continue\n"
            "        other_width = max(other_bounds[2], 0.0)\n"
            "        other_height = max(other_bounds[3], 0.0)\n"
            "        if other_width <= 0.0 or other_height <= 0.0:\n"
            "            continue\n"
            "        shares_vertical_span = abs(bounds[1] - other_bounds[1]) <= 0.08 and abs(height - other_height) <= 0.2\n"
            "        shares_horizontal_span = abs(bounds[0] - other_bounds[0]) <= 0.08 and abs(width - other_width) <= 0.2\n"
            "        if shares_vertical_span and width <= other_width * 0.35:\n"
            "            return True\n"
            "        if shares_horizontal_span and height <= other_height * 0.35:\n"
            "            return True\n"
            "    return False\n"
            "def _chart_axes(fig):\n"
            "    axes = _axes_with_data(fig)\n"
            "    if len(axes) <= 1:\n"
            "        return axes\n"
            "    filtered = [ax for ax in axes if not _is_probable_support_axis(ax, axes)]\n"
            "    return filtered or axes\n"
            "def _fig_has_data(fig):\n"
            "    # Avoid saving empty figures (common after failed plotting code).\n"
            "    return len(_chart_axes(fig)) > 0\n"
            "def _is_single_chart_figure(fig):\n"
            "    axes = _chart_axes(fig)\n"
            "    if len(axes) <= 1:\n"
            "        return True\n"
            "    positions = set()\n"
            "    for ax in axes:\n"
            "        bounds = _axis_bounds(ax)\n"
            "        if bounds is None:\n"
            "            return False\n"
            "        key = tuple(round(float(v), 4) for v in bounds)\n"
            "        positions.add(key)\n"
            "        if len(positions) > 1:\n"
            "            return False\n"
            "    return True\n"
            "def _enforce_single_chart(fig):\n"
            "    if not _is_single_chart_figure(fig):\n"
            "        raise ValueError('Multi-panel figures are not allowed. Save one chart per image.')\n"
            "def _normalize_plot_path(fname):\n"
            "    # Always save plots into PLOTS_DIR and prefix filenames with PLAN_ID\n"
            "    try:\n"
            "        raw = os.fspath(fname)\n"
            "    except Exception:\n"
            "        raw = str(fname)\n"
            "    base = os.path.basename(raw)\n"
            "    if not os.path.splitext(base)[1]:\n"
            "        base = base + '.png'\n"
            "    if not base.startswith(f\"{PLAN_ID}_\"):\n"
            "        base = f\"{PLAN_ID}_{base}\"\n"
            "    return os.path.join(PLOTS_DIR, base)\n"
            "def _mark_current_fig_saved():\n"
            "    try:\n"
            "        _SAVED_FIGNUMS.add(int(plt.gcf().number))\n"
            "    except Exception:\n"
            "        pass\n"
            "_orig_plt_savefig = plt.savefig\n"
            "def _patched_plt_savefig(fname, *args, **kwargs):\n"
            "    if _REPLAY_MODE:\n"
            "        return None\n"
            "    _enforce_single_chart(plt.gcf())\n"
            "    _mark_current_fig_saved()\n"
            "    return _orig_plt_savefig(_normalize_plot_path(fname), *args, **kwargs)\n"
            "plt.savefig = _patched_plt_savefig\n"
            "_orig_fig_savefig = Figure.savefig\n"
            "def _patched_fig_savefig(self, fname, *args, **kwargs):\n"
            "    if _REPLAY_MODE:\n"
            "        return None\n"
            "    _enforce_single_chart(self)\n"
            "    try:\n"
            "        num = getattr(self, 'number', None)\n"
            "        if num is not None:\n"
            "            _SAVED_FIGNUMS.add(int(num))\n"
            "    except Exception:\n"
            "        pass\n"
            "    return _orig_fig_savefig(self, _normalize_plot_path(fname), *args, **kwargs)\n"
            "Figure.savefig = _patched_fig_savefig\n"
            "def _save_current_plot():\n"
            "    global _PLOT_COUNTER\n"
            "    if _REPLAY_MODE:\n"
            "        return None\n"
            "    try:\n"
            "        figs = plt.get_fignums()\n"
            "        if not figs:\n"
            "            return None\n"
            "        fig = plt.gcf()\n"
            "        if not _fig_has_data(fig):\n"
            "            return None\n"
            "        if not _is_single_chart_figure(fig):\n"
            "            print('Skipped saving multi-panel figure. Save one chart per image.')\n"
            "            return None\n"
            "        _PLOT_COUNTER += 1\n"
            "        path = os.path.join(PLOTS_DIR, f\"{PLAN_ID}_{_PLOT_COUNTER}.png\")\n"
            "        fig.savefig(path, dpi=150, bbox_inches='tight')\n"
            "        _mark_current_fig_saved()\n"
            "        return path\n"
            "    except Exception:\n"
            "        return None\n"
            "def _save_all_open_figures():\n"
            "    global _PLOT_COUNTER\n"
            "    paths = []\n"
            "    if _REPLAY_MODE:\n"
            "        return paths\n"
            "    try:\n"
            "        for num in list(plt.get_fignums()):\n"
            "            if num in _SAVED_FIGNUMS:\n"
            "                continue\n"
            "            _PLOT_COUNTER += 1\n"
            "            fig = plt.figure(num)\n"
            "            if not _fig_has_data(fig):\n"
            "                continue\n"
            "            if not _is_single_chart_figure(fig):\n"
            "                print('Skipped saving multi-panel figure. Save one chart per image.')\n"
            "                continue\n"
            "            path = os.path.join(PLOTS_DIR, f\"{PLAN_ID}_{_PLOT_COUNTER}.png\")\n"
            "            fig.savefig(path, dpi=150, bbox_inches='tight')\n"
            "            paths.append(path)\n"
            "        return paths\n"
            "    except Exception:\n"
            "        return paths\n"
            "def _auto_show(*args, **kwargs):\n"
            "    if _REPLAY_MODE:\n"
            "        return None\n"
            "    return _save_current_plot()\n"
            "plt.show = _auto_show\n"
            "def _run_replay_snippet(_source):\n"
            "    global _REPLAY_MODE\n"
            "    _REPLAY_MODE = True\n"
            "    try:\n"
            "        exec(_source, globals(), globals())\n"
            "    finally:\n"
            "        try:\n"
            "            plt.close('all')\n"
            "        except Exception:\n"
            "            pass\n"
            "        _REPLAY_MODE = False\n"
            "df = pd.read_csv(DATASET_PATH)\n\n"
        )
        # Auto-save any remaining open figures even if the code didn't call plt.show()/savefig.
        return backend_setup + code.strip() + "\n\n_save_all_open_figures()\n"

    def _get_existing_plots(self, store: RunStore, plan_id: str) -> dict[str, int]:
        try:
            if not store.plots_dir.exists():
                return {}
            snapshot: dict[str, int] = {}
            for file_path in store.plots_dir.glob(f"{plan_id}_*.png"):
                try:
                    snapshot[file_path.name] = file_path.stat().st_mtime_ns
                except Exception:
                    continue
            return snapshot
        except Exception:
            return {}

    def _collect_new_plots(
        self,
        store: RunStore,
        plan_id: str,
        existing_plots: dict[str, int],
    ) -> List[str]:
        try:
            if not store.plots_dir.exists():
                return []
            fresh: List[tuple[int, str]] = []
            for file_path in store.plots_dir.glob(f"{plan_id}_*.png"):
                name = file_path.name
                mtime_ns = file_path.stat().st_mtime_ns
                previous_mtime_ns = existing_plots.get(name)
                if previous_mtime_ns is not None and mtime_ns <= previous_mtime_ns:
                    continue
                rel_path = file_path.relative_to(store.run_dir).as_posix()
                fresh.append((mtime_ns, rel_path))
            fresh.sort(key=lambda item: (item[0], item[1]))
            return [path for _mtime, path in fresh]
        except Exception:
            return []

