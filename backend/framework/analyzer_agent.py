from __future__ import annotations

import ast
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
import textwrap
from typing import Any, Callable

from langchain_core.messages import AIMessage, SystemMessage, ToolMessage, message_to_dict, messages_from_dict
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool

from config import (
    ANALYZER_MAX_TURNS,
    ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE,
    ANALYZER_MODEL_NAME,
    ANALYZER_TEMPERATURE,
    DEFAULT_EXECUTION_TIMEOUT,
    build_langchain_chat_model,
)
from utils import execute_python_code_streaming
from .models import ExecutionRecord, PlanItem, RunState, WorkerSessionState


ANALYZER_SYSTEM_PROMPT = """You are the Analyzer Agent for one plan thread in AdaLens.

You are given:
- one plan text
- dataset schema and runtime variables
- prior relevant findings

You are a tool-driven local analyst.
You must use only the provided function-calling tools.
Each assistant response may contain exactly one tool call.

You work in a local ReAct-style analysis loop:
1. first call reflect_on_results with a short visible plan for the next step
2. then call execute_code with one self-contained code step
3. inspect stdout / stderr / plots
4. call reflect_on_results again to state what you observed and what you will do next
5. continue until the local plan objective is answered as fully as possible with concrete evidence
6. call complete_analysis only when further materially useful local analysis is no longer needed

Rules:
- every execute_code call must be self-contained
- use the injected df variable by default
- if raw reloading is required, use DATASET_PATH only
- never paste literal local paths, Windows paths, or upload paths into code
- prefer evidence-rich analysis over early stopping
- before complete_analysis, perform multiple successful execute_code iterations; use later iterations to validate or deepen the conclusion
- do not fabricate findings
- if any key uncertainty remains, continue analysis instead of stopping
- if a syntax error is reported, fix syntax first and run execute_code again
- generate plots only when they are meaningful and supported by sufficient valid data
- save plots to PLOTS_DIR as PNG files whose names start with PLAN_ID
- do not call plt.show()
- do not generate multi-panel or subplot figures; each saved image must contain exactly one chart
- print concise numeric evidence to stdout for each key finding
- if a meaningful plot is not feasible, explain that limitation in stdout
- do not terminate the analysis before each atomic insight can be grounded in code, output, and plot evidence
- keep user-facing reflections concise and language-matched
- keep tool names, JSON keys, schema fields, and Python code in English
"""

_PLOT_LIMITATION_MARKER = "PLOT_LIMITATION_NOT_FEASIBLE"


@dataclass
class AnalyzerExecutionResult:
    analysis_stream: str = ""
    execution_records: list[ExecutionRecord] = field(default_factory=list)
    control_action: str | None = None
    checkpoint_path: str | None = None
    resume_phase: str | None = None
    error: str | None = None


@dataclass
class PreparedExecutionCode:
    original_code: str
    sanitized_code: str
    notes: list[str] = field(default_factory=list)
    syntax_error: str | None = None


def _sanitize_indentation(code: str) -> str:
    if not code:
        return code
    normalized = code.replace("\t", "    ")
    return textwrap.dedent(normalized)


def _count_unescaped_quote(text: str, quote: str) -> int:
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


def _merge_unterminated_string_lines(code: str, *, max_line_merge: int = 3) -> tuple[str, bool]:
    lines = code.splitlines()
    updated: list[str] = []
    changed = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if "'''" in line or '"""' in line:
            updated.append(line)
            index += 1
            continue
        merged = False
        for quote in ('"', "'"):
            if _count_unescaped_quote(line, quote) % 2 != 1:
                continue
            candidate = line
            for lookahead in range(1, max_line_merge + 1):
                next_index = index + lookahead
                if next_index >= len(lines):
                    break
                candidate = candidate + "\\n" + lines[next_index].lstrip()
                if _count_unescaped_quote(candidate, quote) % 2 == 0:
                    updated.append(candidate)
                    index = next_index + 1
                    changed = True
                    merged = True
                    break
            if merged:
                break
        if merged:
            continue
        updated.append(line)
        index += 1
    return "\n".join(updated), changed


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


class AnalyzerAgent:
    def __init__(
        self,
        *,
        timeout: int = DEFAULT_EXECUTION_TIMEOUT,
        max_turns: int = ANALYZER_MAX_TURNS,
        llm_provider: Callable[[list[Any]], AIMessage] | None = None,
    ) -> None:
        self.timeout = timeout
        self.max_turns = max_turns
        self._llm_provider = llm_provider
        self._prompt = ChatPromptTemplate.from_messages(
            [
                ("system", ANALYZER_SYSTEM_PROMPT),
                ("human", "{plan_text}\n\n{runtime_context}\n\n{prior_findings}"),
            ]
        )
        model = build_langchain_chat_model(
            model_name=ANALYZER_MODEL_NAME,
            temperature=ANALYZER_TEMPERATURE,
        )
        self._model = None
        if model is not None:
            self._model = model.bind_tools(
                [
                    self._execute_code_tool(),
                    self._reflect_tool(),
                    self._complete_tool(),
                ]
            )

    @staticmethod
    def _format_syntax_error(exc: SyntaxError) -> str:
        line = str(exc.text or "").rstrip()
        parts = [f"{exc.__class__.__name__}: {str(exc.msg or '').strip() or 'syntax error'}"]
        if line:
            parts.append(line)
            if getattr(exc, "offset", None):
                parts.append(" " * max(int(exc.offset or 1) - 1, 0) + "^")
        return "\n".join(parts).strip()

    @staticmethod
    def _normalize_dataset_path_literals(code: str, dataset_path: str) -> tuple[str, list[str]]:
        normalized_dataset_path = str(dataset_path or "").strip()
        if not normalized_dataset_path:
            return code, []

        notes: list[str] = []
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
            string_literal_pattern = re.compile(r"(?P<prefix>[rR]?)(?P<quote>['\"])(?P<body>[\s\S]*?)(?P=quote)")

            def _replace_dataset_literal(match: re.Match[str]) -> str:
                body = str(match.group("body") or "")
                body_norm = body.replace("\\", "/").lower()
                if dataset_name.lower() not in body_norm:
                    return match.group(0)
                if not any(token in body_norm for token in ("/", "\\", ":", "_uploads", ".csv")):
                    return match.group(0)
                return "DATASET_PATH"

            working = string_literal_pattern.sub(_replace_dataset_literal, working)
            working = re.sub(
                r"pd\.read_csv\(\s*[rR]?['\"][\s\S]*?" + re.escape(dataset_name) + r"[\s\S]*?['\"]\s*\)",
                "pd.read_csv(DATASET_PATH)",
                working,
                flags=re.IGNORECASE,
            )

        if working != code:
            notes.append("Auto-replaced literal dataset path with DATASET_PATH.")
        return working, notes

    @staticmethod
    def _normalize_plot_dir_literals(code: str, plots_dir: Path) -> tuple[str, list[str]]:
        plots_dir_str = str(plots_dir.as_posix()).strip()
        if not plots_dir_str:
            return code, []
        notes: list[str] = []
        working = code
        literal_variants = {
            plots_dir_str,
            plots_dir_str.replace("/", "\\"),
            "artifacts/plots",
            ".\\artifacts\\plots",
            "./artifacts/plots",
            "plots_dir",
        }
        for candidate in sorted(literal_variants, key=len, reverse=True):
            for literal in (
                f"r'{candidate}'",
                f'r"{candidate}"',
                f"R'{candidate}'",
                f'R"{candidate}"',
                f"'{candidate}'",
                f'"{candidate}"',
            ):
                working = working.replace(literal, "PLOTS_DIR")

        if working != code:
            notes.append("Auto-rewrote plot output path to PLOTS_DIR.")
        return working, notes

    def _prepare_code_for_execution(
        self,
        *,
        code: str,
        state: RunState,
        plots_dir: Path,
    ) -> PreparedExecutionCode:
        original_code = str(code or "")
        working = original_code
        notes: list[str] = []

        indented = _sanitize_indentation(working)
        if indented != working:
            working = indented
            notes.append("Auto-normalized indentation.")

        working, dataset_notes = self._normalize_dataset_path_literals(working, state.dataset_path)
        notes.extend(note for note in dataset_notes if note not in notes)

        working, plot_notes = self._normalize_plot_dir_literals(working, plots_dir)
        notes.extend(note for note in plot_notes if note not in notes)

        syntax_error: str | None = None
        for _pass in range(2):
            try:
                compile(working, "<analyzer_preflight>", "exec")
                syntax_error = None
                break
            except SyntaxError as exc:
                lowered_msg = str(exc.msg or "").lower()
                fixed = False
                if "unterminated string literal" in lowered_msg or "eol while scanning string literal" in lowered_msg:
                    merged, changed = _merge_unterminated_string_lines(working)
                    if changed and merged != working:
                        working = merged
                        fixed = True
                        note = "Auto-fixed unterminated string literal by replacing raw line break(s) inside a quoted string with '\\n'."
                        if note not in notes:
                            notes.append(note)
                        continue
                if "indent" in lowered_msg:
                    normalized = _sanitize_indentation(working)
                    if normalized != working:
                        working = normalized
                        fixed = True
                        note = "Auto-normalized indentation after syntax preflight."
                        if note not in notes:
                            notes.append(note)
                        continue
                if not fixed:
                    syntax_error = self._format_syntax_error(exc)
                    break

        return PreparedExecutionCode(
            original_code=original_code,
            sanitized_code=working,
            notes=notes,
            syntax_error=syntax_error,
        )

    @staticmethod
    def _stdout_has_meaningful_evidence(stdout_text: str) -> bool:
        stripped = str(stdout_text or "").strip()
        if not stripped:
            return False
        non_empty_lines = [line for line in stripped.splitlines() if line.strip()]
        return len(non_empty_lines) >= 1 or len(stripped) >= 24

    @staticmethod
    def _normalize_existing_plot_path(
        candidate: str,
        *,
        store: Any,
        plan_id: str,
    ) -> str | None:
        raw = str(candidate or "").strip().strip("\"'")
        if not raw:
            return None
        normalized = raw.replace("\\", "/")
        basename = os.path.basename(normalized)
        if not basename.lower().endswith(".png"):
            return None

        candidates: list[Path] = []
        direct_path = Path(normalized)
        if direct_path.is_absolute():
            candidates.append(direct_path)
        else:
            candidates.append(store.run_dir / normalized.lstrip("./"))
            candidates.append(Path(store.plots_dir) / basename)
            candidates.append(store.run_dir / basename)

        for path in candidates:
            try:
                resolved = path.resolve()
            except Exception:
                continue
            if not resolved.exists() or not resolved.is_file():
                continue
            try:
                rel = resolved.relative_to(store.run_dir.resolve()).as_posix()
            except Exception:
                continue
            rel_name = Path(rel).name
            if not rel_name.startswith(f"{plan_id}_"):
                continue
            if not rel.lower().endswith(".png"):
                continue
            return rel
        return None

    @classmethod
    def _extract_plot_paths_from_text(
        cls,
        text: str,
        *,
        store: Any,
        plan_id: str,
    ) -> list[str]:
        candidates: list[str] = []
        raw_text = str(text or "")
        if not raw_text.strip():
            return []

        for line in raw_text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            lowered = stripped.casefold()
            if lowered.startswith("plot_paths:"):
                payload = stripped.split(":", 1)[1].strip()
                try:
                    parsed = ast.literal_eval(payload)
                except Exception:
                    parsed = None
                if isinstance(parsed, (list, tuple)):
                    candidates.extend(str(item) for item in parsed if str(item).strip())
                elif isinstance(parsed, str) and parsed.strip():
                    candidates.append(parsed)
                continue
            for prefix in ("plot_path:", "plot_path=", "image_path:", "image_path=", "file:", "file="):
                if lowered.startswith(prefix):
                    candidates.append(stripped.split(stripped[: len(prefix)], 1)[1].strip())
                    break
            else:
                for match in re.findall(r"([A-Za-z0-9_./\\\\:-]*" + re.escape(plan_id) + r"[A-Za-z0-9_./\\\\:-]*\.png)", stripped):
                    candidates.append(match)

        normalized = [
            cls._normalize_existing_plot_path(candidate, store=store, plan_id=plan_id)
            for candidate in candidates
        ]
        return _dedupe_preserve_order([item for item in normalized if item])

    @classmethod
    def _reuse_historical_evidence(
        cls,
        *,
        store: Any,
        plan: PlanItem,
        records: list[ExecutionRecord],
    ) -> tuple[int, int, int]:
        successful_execute_count = 0
        successful_execute_with_evidence_count = 0
        successful_execute_with_plot_count = 0

        for record in records:
            reused_plot_paths = _dedupe_preserve_order(
                list(record.plot_paths)
                + cls._extract_plot_paths_from_text(
                    record.stdout_content,
                    store=store,
                    plan_id=plan.plan_id,
                )
                + cls._extract_plot_paths_from_text(
                    record.stderr_content,
                    store=store,
                    plan_id=plan.plan_id,
                )
            )
            if reused_plot_paths and reused_plot_paths != list(record.plot_paths):
                record.plot_paths = reused_plot_paths

            if record.success:
                successful_execute_count += 1
                if cls._stdout_has_meaningful_evidence(record.stdout_content) or record.plot_paths:
                    successful_execute_with_evidence_count += 1
                if record.plot_paths:
                    successful_execute_with_plot_count += 1

        return (
            successful_execute_count,
            successful_execute_with_evidence_count,
            successful_execute_with_plot_count,
        )

    def analyze(
        self,
        *,
        plan: PlanItem,
        state: RunState,
        store: Any,
        worker_state: WorkerSessionState | None = None,
        prior_findings: list[Any] | None = None,
        control_callback: Callable[[], dict[str, Any]] | None = None,
        checkpoint_path: str | None = None,
    ) -> AnalyzerExecutionResult:
        control_callback = control_callback or (lambda: {})
        session = self._load_or_create_session(store, checkpoint_path)
        base_messages = self._deserialize_messages(session.get("messages", []))
        trace: list[str] = list(session.get("trace", []))
        records = [
            ExecutionRecord.from_dict(item)
            for item in session.get("execution_records", []) or []
            if isinstance(item, dict)
        ]
        protocol_state = self._load_protocol_state(session.get("protocol_state"))
        initial_reflection_done = bool(protocol_state.get("initial_reflection_done", False))
        must_reflect_next = bool(protocol_state.get("must_reflect_next", False))
        did_execute_code = bool(protocol_state.get("did_execute_code", False))
        successful_execute_count = int(protocol_state.get("successful_execute_count", 0) or 0)
        successful_execute_with_evidence_count = int(
            protocol_state.get("successful_execute_with_evidence_count", 0) or 0
        )
        successful_execute_with_plot_count = int(
            protocol_state.get("successful_execute_with_plot_count", 0) or 0
        )
        log_seq = int(protocol_state.get("log_seq", 0) or 0)
        current_stream_attempt = int(protocol_state.get("current_stream_attempt", 1) or 1)
        if current_stream_attempt < 1:
            current_stream_attempt = 1
        started_attempts: set[int] = set()
        for raw_attempt in protocol_state.get("started_attempts", []) or []:
            try:
                normalized_attempt = int(raw_attempt)
            except (TypeError, ValueError):
                continue
            if normalized_attempt >= 1:
                started_attempts.add(normalized_attempt)

        def ensure_attempt_started(attempt: int) -> None:
            nonlocal current_stream_attempt
            normalized_attempt = max(1, int(attempt or 1))
            current_stream_attempt = normalized_attempt
            if normalized_attempt in started_attempts:
                return
            started_attempts.add(normalized_attempt)
            try:
                store.log_plan_attempt_started(plan.plan_id, normalized_attempt)
            except Exception:
                return

        def emit_plan_log(
            channel: str,
            delta: str,
            *,
            attempt: int | None = None,
        ) -> None:
            nonlocal log_seq
            text = str(delta or "")
            if not text:
                return
            effective_attempt = max(1, int(attempt or current_stream_attempt or 1))
            ensure_attempt_started(effective_attempt)
            log_seq += 1
            try:
                store.log_plan_log_delta(
                    plan.plan_id,
                    channel,
                    text,
                    log_seq,
                    effective_attempt,
                )
            except Exception:
                return

        if worker_state is not None and isinstance(session.get("worker_state"), dict):
            restored_worker_state = session["worker_state"]
            worker_state.analysis_phase = str(restored_worker_state.get("analysis_phase", "analyzing") or "analyzing")
            worker_state.tool_history = list(restored_worker_state.get("tool_history", []) or [])
            worker_state.artifact_refs = list(restored_worker_state.get("artifact_refs", []) or [])
            worker_state.checkpoint_ref = str(restored_worker_state.get("checkpoint_ref", "")).strip() or None
            worker_state.latest_reflection = str(restored_worker_state.get("latest_reflection", "")).strip() or None

        historical_success_count, historical_evidence_count, historical_plot_count = self._reuse_historical_evidence(
            store=store,
            plan=plan,
            records=records,
        )
        successful_execute_count = max(successful_execute_count, historical_success_count)
        successful_execute_with_evidence_count = max(
            successful_execute_with_evidence_count,
            historical_evidence_count,
        )
        successful_execute_with_plot_count = max(
            successful_execute_with_plot_count,
            historical_plot_count,
        )

        if not base_messages:
            prior_findings_text = self._summarize_prior_findings(prior_findings or state.findings)
            runtime_context = json.dumps(
                {
                    "df": "injected dataframe handle",
                    "DATASET_PATH": state.dataset_path,
                    "PLOTS_DIR": str(store.plots_dir),
                    "PLAN_ID": plan.plan_id,
                    "DATASET_SCHEMA": state.dataset_schema,
                },
                ensure_ascii=False,
                indent=2,
            )
            base_messages = self._prompt.format_messages(
                plan_text=plan.text,
                runtime_context=runtime_context,
                prior_findings=prior_findings_text,
            )

        for turn in range(1, self.max_turns + 1):
            pending_control = self._pending_control_action(control_callback)
            if pending_control is not None:
                if worker_state is not None:
                    worker_state.analysis_phase = "paused"
                checkpoint = self._save_checkpoint(
                    store,
                    plan.plan_id,
                    base_messages,
                    trace,
                    turn,
                    records=records,
                    protocol_state=self._build_protocol_state(
                        initial_reflection_done=initial_reflection_done,
                        must_reflect_next=must_reflect_next,
                        did_execute_code=did_execute_code,
                        successful_execute_count=successful_execute_count,
                        successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                        successful_execute_with_plot_count=successful_execute_with_plot_count,
                        log_seq=log_seq,
                        current_stream_attempt=current_stream_attempt,
                        started_attempts=sorted(started_attempts),
                    ),
                    worker_state=worker_state,
                )
                if worker_state is not None:
                    worker_state.checkpoint_ref = checkpoint
                return AnalyzerExecutionResult(
                    analysis_stream="\n".join(trace),
                    execution_records=records,
                    control_action=pending_control,
                    checkpoint_path=checkpoint,
                    resume_phase="analyzing",
                )

            ai_message = self._invoke_model(
                base_messages,
                store=store,
                plan_id=plan.plan_id,
                turn=turn,
            )
            if ai_message is None:
                return AnalyzerExecutionResult(
                    analysis_stream="\n".join(trace),
                    execution_records=records,
                    error="Analyzer model is unavailable.",
                )
            base_messages.append(ai_message)

            tool_calls = list(getattr(ai_message, "tool_calls", []) or [])
            if not tool_calls:
                return AnalyzerExecutionResult(
                    analysis_stream="\n".join(trace),
                    execution_records=records,
                    error="Analyzer response did not contain a tool call.",
                )
            if len(tool_calls) > 1:
                feedback = (
                    f"Ignored {len(tool_calls) - 1} extra tool call(s). "
                    "Each assistant response may contain exactly one tool call."
                )
                trace.append(f"[system_note]\n{feedback}")
                emit_plan_log("system", f"[SYSTEM NOTE]\n{feedback}\n")
                base_messages.append(SystemMessage(content=feedback))
                if worker_state is not None:
                    worker_state.tool_history.append({"tool": "system_feedback", "message": feedback})

            tool_call = tool_calls[0]
            tool_name = str(tool_call.get("name", "") or "")
            tool_args = dict(tool_call.get("args", {}) or {})
            tool_call_id = str(tool_call.get("id", "") or f"tool_{turn}")

            if must_reflect_next and tool_name != "reflect_on_results":
                next_action = (
                    "Your next assistant response must only call reflect_on_results "
                    "before any further execute_code or complete_analysis."
                )
                self._append_protocol_feedback(
                    base_messages=base_messages,
                    trace=trace,
                    tool_call_id=tool_call_id,
                    message="After execute_code, call reflect_on_results first.",
                    next_action=next_action,
                    worker_state=worker_state,
                )
                emit_plan_log("system", "[SYSTEM ERROR]\nAfter execute_code, call reflect_on_results first.\n")
                emit_plan_log("system", f"[SYSTEM NOTE]\n{next_action}\n")
                continue

            if not initial_reflection_done and tool_name != "reflect_on_results":
                next_action = (
                    "Your next assistant response must begin with reflect_on_results "
                    "before any execute_code or complete_analysis."
                )
                self._append_protocol_feedback(
                    base_messages=base_messages,
                    trace=trace,
                    tool_call_id=tool_call_id,
                    message="Call reflect_on_results with a brief next-step plan before execute_code.",
                    next_action=next_action,
                    worker_state=worker_state,
                )
                emit_plan_log(
                    "system",
                    "[SYSTEM ERROR]\nCall reflect_on_results with a brief next-step plan before execute_code.\n",
                )
                emit_plan_log("system", f"[SYSTEM NOTE]\n{next_action}\n")
                continue

            if tool_name == "reflect_on_results":
                reflection = str(tool_args.get("message", "") or "").strip()
                if not reflection:
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message="reflect_on_results requires a non-empty message.",
                        next_action="Call reflect_on_results again with 1-3 short user-facing sentences.",
                        worker_state=worker_state,
                    )
                    emit_plan_log("system", "[SYSTEM ERROR]\nreflect_on_results requires a non-empty message.\n")
                    emit_plan_log(
                        "system",
                        "[SYSTEM NOTE]\nCall reflect_on_results again with 1-3 short user-facing sentences.\n",
                    )
                    continue
                trace.append(f"[reflection]\n{reflection}")
                emit_plan_log("system", f"[REFLECTION]\n{reflection}\n")
                if worker_state is not None:
                    worker_state.latest_reflection = reflection
                    worker_state.tool_history.append({"tool": "reflect_on_results", "message": reflection})
                initial_reflection_done = True
                must_reflect_next = False
                base_messages.append(
                    ToolMessage(
                        content=json.dumps({"ok": True}),
                        tool_call_id=tool_call_id,
                    )
                )
                continue

            if tool_name == "execute_code":
                code = str(tool_args.get("code", "") or "")
                if not code.strip():
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message="execute_code requires a non-empty code string.",
                        next_action="Call execute_code again with one self-contained Python step.",
                        worker_state=worker_state,
                    )
                    emit_plan_log("system", "[SYSTEM ERROR]\nexecute_code requires a non-empty code string.\n")
                    emit_plan_log(
                        "system",
                        "[SYSTEM NOTE]\nCall execute_code again with one self-contained Python step.\n",
                    )
                    continue
                execute_attempt = len(records) + 1
                current_stream_attempt = execute_attempt
                ensure_attempt_started(execute_attempt)
                prepared_code = self._prepare_code_for_execution(
                    code=code,
                    state=state,
                    plots_dir=Path(store.plots_dir),
                )
                emit_plan_log("system", "[TOOL] execute_code\n", attempt=execute_attempt)
                for note in prepared_code.notes:
                    trace.append(f"[system_note]\n{note}")
                    emit_plan_log("system", f"[SYSTEM NOTE]\n{note}\n", attempt=execute_attempt)
                emit_plan_log(
                    "system",
                    f"[CODE]\n{prepared_code.sanitized_code.rstrip()}\n",
                    attempt=execute_attempt,
                )
                record = self._execute_code(
                    plan=plan,
                    state=state,
                    store=store,
                    code=prepared_code.original_code,
                    prepared_code=prepared_code,
                    control_callback=control_callback,
                    attempt=len(records) + 1,
                    log_event=emit_plan_log,
                )
                records.append(record)
                if not record.success and record.error_message:
                    try:
                        store.log_plan_attempt_failed(
                            plan.plan_id,
                            execute_attempt,
                            record.error_message,
                        )
                    except Exception:
                        pass
                if worker_state is not None:
                    worker_state.tool_history.append(
                        {
                            "tool": "execute_code",
                            "attempt": len(records),
                            "success": record.success,
                            "code_path": record.code_path,
                            "stdout_path": record.stdout_path,
                            "stderr_path": record.stderr_path,
                            "plot_paths": list(record.plot_paths),
                        }
                    )
                    worker_state.artifact_refs.extend(
                        [
                            path
                            for path in [record.code_path, record.stdout_path, record.stderr_path, *record.plot_paths]
                            if path
                        ]
                    )
                trace.append(
                    "\n".join(
                        [
                            "[execute_code]",
                            code,
                            "[stdout]",
                            record.stdout_content,
                            "[stderr]",
                            record.stderr_content,
                        ]
                    )
                )
                historical_success_count, historical_evidence_count, historical_plot_count = self._reuse_historical_evidence(
                    store=store,
                    plan=plan,
                    records=records,
                )
                did_execute_code = True
                successful_execute_count = max(successful_execute_count, historical_success_count)
                successful_execute_with_evidence_count = max(
                    successful_execute_with_evidence_count,
                    historical_evidence_count,
                )
                successful_execute_with_plot_count = max(
                    successful_execute_with_plot_count,
                    historical_plot_count,
                )
                must_reflect_next = True
                base_messages.append(
                    ToolMessage(
                        content=json.dumps(
                            {
                                "success": record.success,
                                "stdout": record.stdout_content,
                                "stderr": record.stderr_content,
                                "plot_paths": record.plot_paths,
                                "error": record.error_message,
                            },
                            ensure_ascii=False,
                        ),
                        tool_call_id=tool_call_id,
                    )
                )
                continue

            if tool_name == "complete_analysis":
                if not did_execute_code:
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message="You must execute code at least once before complete_analysis.",
                        next_action="Run execute_code to produce concrete evidence, then reflect on the result.",
                        worker_state=worker_state,
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM ERROR]\nYou must execute code at least once before complete_analysis.\n",
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM NOTE]\nRun execute_code to produce concrete evidence, then reflect on the result.\n",
                    )
                    continue
                if successful_execute_count < ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE:
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message=(
                            "Insufficient analysis depth before complete_analysis. "
                            f"Run at least {ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE} successful execute_code iterations."
                        ),
                        next_action="Continue with another execute_code step, then reflect on what you observed.",
                        worker_state=worker_state,
                    )
                    emit_plan_log(
                        "system",
                        (
                            "[SYSTEM ERROR]\nInsufficient analysis depth before complete_analysis. "
                            f"Run at least {ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE} successful execute_code iterations.\n"
                        ),
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM NOTE]\nContinue with another execute_code step, then reflect on what you observed.\n",
                    )
                    continue
                if successful_execute_with_evidence_count <= 0:
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message="No meaningful retained evidence is available yet for complete_analysis.",
                        next_action="Produce non-empty stdout or plot evidence with execute_code, then reflect on it.",
                        worker_state=worker_state,
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM ERROR]\nNo meaningful retained evidence is available yet for complete_analysis.\n",
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM NOTE]\nProduce non-empty stdout or plot evidence with execute_code, then reflect on it.\n",
                    )
                    continue
                if (
                    successful_execute_with_plot_count <= 0
                    and not self._has_plot_limitation_evidence(records)
                ):
                    self._append_protocol_feedback(
                        base_messages=base_messages,
                        trace=trace,
                        tool_call_id=tool_call_id,
                        message="No plot evidence or explicit plot limitation has been recorded yet.",
                        next_action=(
                            "Generate a meaningful plot, or print the exact token "
                            f"{_PLOT_LIMITATION_MARKER} in stdout and briefly explain why a meaningful plot is not feasible, "
                            "then reflect before attempting complete_analysis again."
                        ),
                        worker_state=worker_state,
                    )
                    emit_plan_log(
                        "system",
                        "[SYSTEM ERROR]\nNo plot evidence or explicit plot limitation has been recorded yet.\n",
                    )
                    emit_plan_log(
                        "system",
                        (
                            "[SYSTEM NOTE]\nGenerate a meaningful plot, or print the exact token "
                            f"{_PLOT_LIMITATION_MARKER} in stdout and briefly explain why a meaningful plot is not feasible, "
                            "then reflect before attempting complete_analysis again.\n"
                        ),
                    )
                    continue
                emit_plan_log("system", "[TOOL] complete_analysis\n")
                trace.append("[complete_analysis]")
                if worker_state is not None:
                    worker_state.analysis_phase = "completed"
                    worker_state.tool_history.append({"tool": "complete_analysis"})
                analysis_path = store.save_analysis_process(
                    plan.plan_id,
                    {
                        "messages": self._serialize_messages(base_messages),
                        "trace": list(trace),
                        "execution_records": [record.to_dict() for record in records],
                        "protocol_state": self._build_protocol_state(
                            initial_reflection_done=initial_reflection_done,
                            must_reflect_next=must_reflect_next,
                            did_execute_code=did_execute_code,
                            successful_execute_count=successful_execute_count,
                            successful_execute_with_evidence_count=successful_execute_with_evidence_count,
                            successful_execute_with_plot_count=successful_execute_with_plot_count,
                            log_seq=log_seq,
                            current_stream_attempt=current_stream_attempt,
                            started_attempts=sorted(started_attempts),
                        ),
                        "worker_state": worker_state.to_dict() if worker_state is not None else None,
                    },
                )
                if records:
                    records[-1].analysis_path = analysis_path
                return AnalyzerExecutionResult(
                    analysis_stream="\n\n".join(trace),
                    execution_records=records,
                )

            base_messages.append(
                ToolMessage(
                    content=json.dumps({"error": f"unsupported tool: {tool_name}"}),
                    tool_call_id=tool_call_id,
                )
            )
            trace.append(f"[system_error]\nunsupported tool: {tool_name}")
            emit_plan_log("system", f"[SYSTEM ERROR]\nunsupported tool: {tool_name}\n")

        return AnalyzerExecutionResult(
            analysis_stream="\n\n".join(trace),
            execution_records=records,
            error=f"Analyzer did not complete within max_turns={self.max_turns}",
        )

    def _invoke_model(
        self,
        messages: list[Any],
        *,
        store: Any | None = None,
        plan_id: str | None = None,
        turn: int | None = None,
    ) -> AIMessage | None:
        if self._llm_provider is not None:
            response = self._llm_provider(messages)
        elif self._model is None:
            return None
        else:
            response = self._model.invoke(messages)
        if isinstance(response, AIMessage):
            ai_message = response
        else:
            ai_message = AIMessage(content=str(getattr(response, "content", "") or ""))
        if store is not None and plan_id:
            store.save_llm_output(
                "analyzer",
                {
                    "agent_name": "analyzer",
                    "model_name": ANALYZER_MODEL_NAME,
                    "plan_id": plan_id,
                    "turn": turn,
                    "raw_output_text": self._extract_raw_output_text(ai_message),
                    "provider_raw_payload": self._extract_provider_raw_payload(ai_message),
                    "raw_message": self._serialize_messages([ai_message])[0],
                },
                plan_id=plan_id,
                label=f"turn{int(turn or 0):03d}",
                metadata={
                    "model_name": ANALYZER_MODEL_NAME,
                    "turn": turn,
                },
            )
        return ai_message

    @staticmethod
    def _extract_provider_raw_payload(message: AIMessage) -> dict[str, Any] | None:
        payload: dict[str, Any] = {}
        content = message.content
        if isinstance(content, str):
            payload["content"] = content
        elif content not in (None, []):
            payload["content"] = content
        additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
        if additional_kwargs:
            payload["additional_kwargs"] = additional_kwargs
        response_metadata = dict(getattr(message, "response_metadata", {}) or {})
        if response_metadata:
            payload["response_metadata"] = response_metadata
        return payload or None

    @staticmethod
    def _extract_raw_output_text(message: AIMessage) -> str:
        provider_payload = AnalyzerAgent._extract_provider_raw_payload(message)
        if provider_payload is not None:
            additional_kwargs = provider_payload.get("additional_kwargs")
            if isinstance(additional_kwargs, dict):
                raw_tool_calls = additional_kwargs.get("tool_calls")
                if raw_tool_calls:
                    return json.dumps(
                        {"tool_calls": raw_tool_calls},
                        ensure_ascii=False,
                        indent=2,
                        default=str,
                    )
            content = provider_payload.get("content")
            if isinstance(content, str) and content.strip():
                return content
            if content not in (None, [], ""):
                return json.dumps(content, ensure_ascii=False, indent=2, default=str)
        tool_calls = list(getattr(message, "tool_calls", []) or [])
        invalid_tool_calls = list(getattr(message, "invalid_tool_calls", []) or [])
        if tool_calls or invalid_tool_calls:
            return json.dumps(
                {
                    "tool_calls_normalized": tool_calls,
                    "invalid_tool_calls_normalized": invalid_tool_calls,
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            )
        return ""

    def _execute_code(
        self,
        *,
        plan: PlanItem,
        state: RunState,
        store: Any,
        code: str,
        prepared_code: PreparedExecutionCode,
        control_callback: Callable[[], dict[str, Any]],
        attempt: int,
        log_event: Callable[..., None] | None = None,
    ) -> ExecutionRecord:
        plots_dir = Path(store.plots_dir)
        plots_dir.mkdir(parents=True, exist_ok=True)
        before_plots = {item.name for item in plots_dir.glob(f"{plan.plan_id}*.png")}
        code_path = store.save_code(plan.plan_id, code, attempt)
        effective_code = self._build_effective_code(state, plan, prepared_code.sanitized_code, plots_dir)
        effective_code_path = store.save_effective_code(plan.plan_id, effective_code, attempt)

        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []

        def emit_log(channel: str, delta: str) -> None:
            if log_event is None:
                return
            try:
                log_event(channel, delta, attempt=attempt)
            except TypeError:
                log_event(channel, delta)

        def on_stdout(chunk: str) -> None:
            stdout_chunks.append(chunk)
            emit_log("exec_stdout", chunk)

        def on_stderr(chunk: str) -> None:
            stderr_chunks.append(chunk)
            emit_log("exec_stderr", chunk)

        if prepared_code.syntax_error is not None:
            stderr_text = prepared_code.syntax_error
            stdout_text = ""
            stderr_path = store.save_stderr(plan.plan_id, stderr_text, attempt)
            emit_log("system", f"[EXECUTION ERROR]\n{stderr_text}\n")
            return ExecutionRecord(
                plan_id=plan.plan_id,
                success=False,
                code_path=effective_code_path or code_path,
                stdout_path=None,
                stderr_path=stderr_path,
                plot_paths=[],
                stdout_content=stdout_text,
                stderr_content=stderr_text,
                error_message=stderr_text,
                execution_time_ms=0,
            )

        result = execute_python_code_streaming(
            effective_code,
            on_stdout=on_stdout,
            on_stderr=on_stderr,
            timeout=self.timeout,
            cwd=store.run_dir,
            stop_requested=lambda: self._stop_requested_state(control_callback),
        )
        after_plots = {item.name for item in plots_dir.glob(f"{plan.plan_id}*.png")}
        new_plots = sorted(after_plots - before_plots)
        plot_paths = [(plots_dir / name).relative_to(store.run_dir).as_posix() for name in new_plots]
        stdout_text = "".join(stdout_chunks) or str(result.get("stdout", "") or "")
        stderr_text = "".join(stderr_chunks) or str(result.get("stderr", "") or "")
        if not stdout_chunks and stdout_text:
            emit_log("exec_stdout", stdout_text)
        if not stderr_chunks and stderr_text:
            emit_log("exec_stderr", stderr_text)
        for plot_path in plot_paths:
            emit_log("exec_plot", f"{plot_path}\n")
        stdout_path = store.save_stdout(plan.plan_id, stdout_text, attempt)
        stderr_path = store.save_stderr(plan.plan_id, stderr_text, attempt)
        raw_error = result.get("error")
        error_message: str | None
        if raw_error is None:
            error_message = None
        else:
            normalized_error = str(raw_error).strip()
            error_message = (
                None
                if not normalized_error or normalized_error.casefold() in {"none", "null", "undefined"}
                else normalized_error
            )
        if error_message:
            emit_log("system", f"[EXECUTION ERROR]\n{error_message}\n")
        return ExecutionRecord(
            plan_id=plan.plan_id,
            success=bool(result.get("success", False)),
            code_path=effective_code_path or code_path,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            plot_paths=plot_paths,
            stdout_content=stdout_text,
            stderr_content=stderr_text,
            error_message=error_message,
            execution_time_ms=0,
        )

    @staticmethod
    def _build_effective_code(
        state: RunState,
        plan: PlanItem,
        code: str,
        plots_dir: Path,
    ) -> str:
        delimiter = (
            state.dataset_metadata.get("delimiter", ",")
            if isinstance(state.dataset_metadata, dict)
            else ","
        )
        backend_setup = textwrap.dedent(
            """
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            from matplotlib.figure import Figure
            import pandas as pd
            import os
            import pathlib
            from pathlib import Path

            DATASET_PATH = r'''__DATASET_PATH__'''
            PLOTS_DIR = r'''__PLOTS_DIR__'''
            PLAN_ID = r'''__PLAN_ID__'''
            DATASET_DELIMITER = __DATASET_DELIMITER__
            Path(PLOTS_DIR).mkdir(parents=True, exist_ok=True)

            def _coerce_path_string(_p):
                try:
                    raw = os.fspath(_p)
                except Exception:
                    raw = str(_p)
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode()
                    except Exception:
                        return None
                return str(raw or "")

            def _is_same_dataset_path(_p):
                s = _coerce_path_string(_p)
                if not s:
                    return False
                try:
                    return os.path.normcase(os.path.abspath(s)) == os.path.normcase(os.path.abspath(DATASET_PATH))
                except Exception:
                    return False

            def _looks_like_dataset_alias_path(_p):
                s = _coerce_path_string(_p)
                if not s:
                    return False
                s_norm = s.replace('\\\\', '/').lower()
                dataset_name = os.path.basename(DATASET_PATH).lower()
                if dataset_name and dataset_name in s_norm and any(token in s_norm for token in ('/_uploads/', '/runs/', '/backend/', '.csv')):
                    return True
                return False

            _orig_pd_read_csv = pd.read_csv
            def _patched_pd_read_csv(filepath_or_buffer, *args, **kwargs):
                rewritten = filepath_or_buffer
                if _is_same_dataset_path(filepath_or_buffer) or _looks_like_dataset_alias_path(filepath_or_buffer):
                    rewritten = DATASET_PATH
                read_kwargs = dict(kwargs)
                if DATASET_DELIMITER and 'sep' not in read_kwargs and 'delimiter' not in read_kwargs and _is_same_dataset_path(rewritten):
                    read_kwargs['sep'] = DATASET_DELIMITER
                return _orig_pd_read_csv(rewritten, *args, **read_kwargs)
            pd.read_csv = _patched_pd_read_csv

            def _rewrite_plot_dir(_p):
                s = _coerce_path_string(_p)
                if s is None:
                    return _p
                normalized = s.replace('\\\\', '/').rstrip('/')
                lower = normalized.lower()
                cwd = os.getcwd().replace('\\\\', '/').rstrip('/')
                cwd_lower = cwd.lower()
                if lower in {'plots_dir', 'artifacts/plots', PLOTS_DIR.replace('\\\\', '/').rstrip('/').lower(), f'{cwd_lower}/artifacts/plots'}:
                    return PLOTS_DIR
                if lower.startswith('plots_dir/'):
                    return os.path.join(PLOTS_DIR, normalized[len('plots_dir/'):])
                if lower.startswith('artifacts/plots/'):
                    return os.path.join(PLOTS_DIR, normalized[len('artifacts/plots/'):])
                if lower.startswith(f'{cwd_lower}/artifacts/plots/'):
                    return os.path.join(PLOTS_DIR, normalized[len(cwd) + len('/artifacts/plots/'):])
                return _p

            _orig_os_mkdir = os.mkdir
            _orig_os_makedirs = os.makedirs
            def _patched_mkdir(path, *args, **kwargs):
                return _orig_os_mkdir(_rewrite_plot_dir(path), *args, **kwargs)
            def _patched_makedirs(name, *args, **kwargs):
                return _orig_os_makedirs(_rewrite_plot_dir(name), *args, **kwargs)
            os.mkdir = _patched_mkdir
            os.makedirs = _patched_makedirs

            _orig_path_mkdir = pathlib.Path.mkdir
            def _patched_path_mkdir(self, *args, **kwargs):
                rewritten = _rewrite_plot_dir(self)
                if rewritten is self:
                    return _orig_path_mkdir(self, *args, **kwargs)
                return _orig_path_mkdir(pathlib.Path(rewritten), *args, **kwargs)
            pathlib.Path.mkdir = _patched_path_mkdir

            _SAVED_FIGNUMS = set()
            _PLOT_COUNTER = 0

            def _normalize_plot_path(fname):
                raw = _coerce_path_string(fname) or ''
                base = os.path.basename(raw)
                stem, ext = os.path.splitext(base)
                if not ext:
                    ext = '.png'
                if ext.lower() != '.png':
                    ext = '.png'
                if not stem:
                    stem = 'plot'
                if not stem.startswith(f'{PLAN_ID}_'):
                    stem = f'{PLAN_ID}_{stem}'
                return os.path.join(PLOTS_DIR, f'{stem}{ext}')

            def _fig_has_data(fig):
                try:
                    return any(ax.has_data() for ax in getattr(fig, 'axes', []) or [])
                except Exception:
                    return False

            def _is_single_chart_figure(fig):
                try:
                    axes = [ax for ax in getattr(fig, 'axes', []) or [] if ax.has_data()]
                except Exception:
                    axes = []
                return len(axes) <= 1

            def _enforce_single_chart(fig):
                if not _is_single_chart_figure(fig):
                    raise ValueError('Multi-panel figures are not allowed. Save one chart per image.')

            _orig_plt_savefig = plt.savefig
            def _patched_plt_savefig(fname, *args, **kwargs):
                fig = plt.gcf()
                if _fig_has_data(fig):
                    _enforce_single_chart(fig)
                _SAVED_FIGNUMS.add(int(fig.number))
                return _orig_plt_savefig(_normalize_plot_path(fname), *args, **kwargs)
            plt.savefig = _patched_plt_savefig

            _orig_fig_savefig = Figure.savefig
            def _patched_fig_savefig(self, fname, *args, **kwargs):
                if _fig_has_data(self):
                    _enforce_single_chart(self)
                try:
                    _SAVED_FIGNUMS.add(int(self.number))
                except Exception:
                    pass
                return _orig_fig_savefig(self, _normalize_plot_path(fname), *args, **kwargs)
            Figure.savefig = _patched_fig_savefig

            def _save_current_plot():
                global _PLOT_COUNTER
                figs = plt.get_fignums()
                if not figs:
                    return None
                fig = plt.gcf()
                if not _fig_has_data(fig):
                    return None
                _enforce_single_chart(fig)
                _PLOT_COUNTER += 1
                path = os.path.join(PLOTS_DIR, f'{PLAN_ID}_{_PLOT_COUNTER}.png')
                fig.savefig(path, dpi=150, bbox_inches='tight')
                return path

            def _save_all_open_figures():
                global _PLOT_COUNTER
                for num in list(plt.get_fignums()):
                    if num in _SAVED_FIGNUMS:
                        continue
                    fig = plt.figure(num)
                    if not _fig_has_data(fig):
                        continue
                    _enforce_single_chart(fig)
                    _PLOT_COUNTER += 1
                    path = os.path.join(PLOTS_DIR, f'{PLAN_ID}_{_PLOT_COUNTER}.png')
                    fig.savefig(path, dpi=150, bbox_inches='tight')

            def _auto_show(*args, **kwargs):
                return _save_current_plot()
            plt.show = _auto_show

            df = pd.read_csv(DATASET_PATH)
            """
        ).strip()
        backend_setup = (
            backend_setup
            .replace("__DATASET_PATH__", state.dataset_path)
            .replace("__PLOTS_DIR__", plots_dir.as_posix())
            .replace("__PLAN_ID__", plan.plan_id)
            .replace("__DATASET_DELIMITER__", repr(delimiter))
        )
        return backend_setup + "\n\n" + code.strip() + "\n\n_save_all_open_figures()\n"

    @staticmethod
    def _pending_control_action(control_callback: Callable[[], dict[str, Any]]) -> str | None:
        snapshot = control_callback() or {}
        state = str(snapshot.get("control_state", "") or "")
        if state == "pause_requested":
            return "pause"
        if state == "terminate_requested":
            return "terminate"
        return None

    @staticmethod
    def _stop_requested_state(control_callback: Callable[[], dict[str, Any]]) -> str | None:
        snapshot = control_callback() or {}
        return str(snapshot.get("control_state", "") or "")

    @staticmethod
    def _load_or_create_session(store: Any, checkpoint_path: str | None) -> dict[str, Any]:
        if checkpoint_path:
            loaded = store.load_analysis_checkpoint(checkpoint_path)
            if isinstance(loaded, dict):
                return loaded
        return {"messages": [], "trace": []}

    @staticmethod
    def _save_checkpoint(
        store: Any,
        plan_id: str,
        messages: list[Any],
        trace: list[str],
        turn: int,
        records: list[ExecutionRecord],
        protocol_state: dict[str, Any],
        worker_state: WorkerSessionState | None = None,
    ) -> str:
        serializable_messages = AnalyzerAgent._serialize_messages(messages)
        return store.save_analysis_checkpoint(
            plan_id,
            {
                "messages": serializable_messages,
                "trace": list(trace),
                "turn": turn,
                "execution_records": [record.to_dict() for record in records],
                "protocol_state": dict(protocol_state),
                "worker_state": worker_state.to_dict() if worker_state is not None else None,
            },
        )

    @staticmethod
    def _build_protocol_state(
        *,
        initial_reflection_done: bool,
        must_reflect_next: bool,
        did_execute_code: bool,
        successful_execute_count: int,
        successful_execute_with_evidence_count: int,
        successful_execute_with_plot_count: int,
        log_seq: int,
        current_stream_attempt: int,
        started_attempts: list[int],
    ) -> dict[str, Any]:
        return {
            "initial_reflection_done": bool(initial_reflection_done),
            "must_reflect_next": bool(must_reflect_next),
            "did_execute_code": bool(did_execute_code),
            "successful_execute_count": int(successful_execute_count),
            "successful_execute_with_evidence_count": int(successful_execute_with_evidence_count),
            "successful_execute_with_plot_count": int(successful_execute_with_plot_count),
            "log_seq": int(log_seq),
            "current_stream_attempt": int(current_stream_attempt),
            "started_attempts": [int(item) for item in started_attempts if int(item) >= 1],
        }

    @staticmethod
    def _load_protocol_state(raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return {}
        started_attempts: list[int] = []
        for raw_attempt in raw.get("started_attempts", []) or []:
            try:
                normalized_attempt = int(raw_attempt)
            except (TypeError, ValueError):
                continue
            if normalized_attempt >= 1:
                started_attempts.append(normalized_attempt)
        return {
            "initial_reflection_done": bool(raw.get("initial_reflection_done", False)),
            "must_reflect_next": bool(raw.get("must_reflect_next", False)),
            "did_execute_code": bool(raw.get("did_execute_code", False)),
            "successful_execute_count": int(raw.get("successful_execute_count", 0) or 0),
            "successful_execute_with_evidence_count": int(
                raw.get("successful_execute_with_evidence_count", 0) or 0
            ),
            "successful_execute_with_plot_count": int(
                raw.get("successful_execute_with_plot_count", 0) or 0
            ),
            "log_seq": int(raw.get("log_seq", 0) or 0),
            "current_stream_attempt": int(raw.get("current_stream_attempt", 1) or 1),
            "started_attempts": started_attempts,
        }

    @staticmethod
    def _append_protocol_feedback(
        *,
        base_messages: list[Any],
        trace: list[str],
        tool_call_id: str,
        message: str,
        next_action: str,
        worker_state: WorkerSessionState | None,
    ) -> None:
        feedback_payload = {"ok": False, "error": message, "next_action": next_action}
        base_messages.append(
            ToolMessage(
                content=json.dumps(feedback_payload, ensure_ascii=False),
                tool_call_id=tool_call_id,
            )
        )
        base_messages.append(SystemMessage(content=next_action))
        trace.append(f"[system_error]\n{message}")
        trace.append(f"[system_note]\n{next_action}")
        if worker_state is not None:
            worker_state.tool_history.append(
                {
                    "tool": "system_feedback",
                    "message": message,
                    "next_action": next_action,
                }
            )

    @staticmethod
    def _has_plot_limitation_evidence(records: list[ExecutionRecord]) -> bool:
        limitation_markers = (
            _PLOT_LIMITATION_MARKER.casefold(),
            "plot is not feasible",
            "meaningful plot is not feasible",
            "meaningful plot is not possible",
            "cannot create a meaningful plot",
            "unable to produce a meaningful plot",
        )
        for record in records:
            stdout = str(record.stdout_content or "").casefold()
            if any(marker in stdout for marker in limitation_markers):
                return True
        return False

    @staticmethod
    def _serialize_messages(messages: list[Any]) -> list[dict[str, Any]]:
        serializable_messages: list[dict[str, Any]] = []
        for message in messages:
            if isinstance(message, dict):
                serializable_messages.append(message)
                continue
            try:
                serializable_messages.append(message_to_dict(message))
            except Exception:
                if hasattr(message, "model_dump"):
                    serializable_messages.append(message.model_dump())
                else:
                    serializable_messages.append({"content": str(getattr(message, "content", ""))})
        return serializable_messages

    @staticmethod
    def _deserialize_messages(raw_messages: Any) -> list[Any]:
        if not isinstance(raw_messages, list) or not raw_messages:
            return []
        try:
            return list(messages_from_dict(raw_messages))
        except Exception:
            return [
                message
                for message in raw_messages
                if not isinstance(message, dict)
            ]

    @staticmethod
    def _summarize_prior_findings(prior_findings: list[Any]) -> str:
        if not prior_findings:
            return "<none>"
        lines: list[str] = []
        for item in prior_findings[:8]:
            summary = str(getattr(item, "summary", "") or "").strip()
            short_label = str(getattr(item, "short_label", "") or "").strip()
            plan_id = str(getattr(item, "plan_id", "") or "").strip()
            columns: list[str] = []
            for atomic in getattr(item, "atomic_insights", []) or []:
                for column in getattr(atomic, "columns", []) or []:
                    column_text = str(column or "").strip()
                    if column_text and column_text not in columns:
                        columns.append(column_text)
            lines.append(
                f"- plan_id={plan_id or '<unknown>'} short_label={short_label or '<none>'} "
                f"columns={columns} summary={summary or '<none>'}"
            )
        return "\n".join(lines)

    @staticmethod
    def _execute_code_tool():
        @tool
        def execute_code(code: str) -> str:
            """Execute one self-contained Python analysis step."""
            return code

        return execute_code

    @staticmethod
    def _reflect_tool():
        @tool
        def reflect_on_results(message: str) -> str:
            """State the next local step or evidence interpretation."""
            return message

        return reflect_on_results

    @staticmethod
    def _complete_tool():
        @tool
        def complete_analysis(message: str = "complete") -> str:
            """Declare local analysis complete."""
            return message

        return complete_analysis
