from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, message_to_dict
from langchain_core.prompts import ChatPromptTemplate

from config import (
    INSIGHT_TAXONOMY_TYPES,
    SUMMARIZER_MAX_ATOMIC_INSIGHTS,
    SUMMARIZER_MODEL_NAME,
    SUMMARIZER_MAX_KEYWORDS,
    SUMMARIZER_TEMPERATURE,
    build_langchain_chat_model,
)
from .language_context import (
    contains_cjk_text,
    latest_user_authored_text,
    strict_language_match_instruction,
)
from .models import (
    PlanItem,
    WorkerFinding,
    WorkerFindingAtomicInsight,
    WorkerFindingEvidence,
    normalize_keyword_list,
)


SUMMARIZER_SYSTEM_PROMPT = """You are the Summarizer Agent of AdaLens.

You convert one completed analysis stream into one structured WorkerFinding object.

Rules:
- output only the required structured object
- produce exactly one summary and one short_label
- produce multiple atomic insights only when they are stably supported
- start the summary directly from a substantive conclusion
- do not open with meta lead-ins such as "The analysis reveals..." or "According to your request..."
- each atomic insight must map to real dataset columns
- each atomic insight must link to concrete code, output, and plot evidence
- use the predefined insight taxonomy
- if a finding cannot be stably classified into the taxonomy, omit it
- if columns or evidence paths cannot be grounded, omit that atomic insight
- keep keywords concise, deduped, and useful for later steering
- keep all user-visible natural language aligned with the latest user-authored language
- keep schema names, field names, and protocol tokens in English
- never fabricate findings or evidence paths
"""

_SUMMARIZER_MAX_IMAGE_ATTACHMENTS = 4
_SUMMARIZER_MIN_SUMMARY_SENTENCES = 2
_SUMMARIZER_MAX_SUMMARY_SENTENCES = 3
_SUMMARIZER_MIN_ATOMIC_INSIGHTS = 1

_SUMMARY_LEAD_PATTERNS_EN = (
    r"^according to (?:your|the) request\b",
    r"^the analysis reveals\b",
    r"^analysis of .+ reveals\b",
    r"^analysis of .+ is complete\b",
    r"^the analysis of .+ is complete\b",
    r"^the analysis has been completed\b",
    r"^analysis completed\b",
    r"^the analysis is complete\b",
)

_FALLBACK_STDOUT_SKIP_MARKERS = (
    "saved",
    "complete",
    "completed",
    "done",
    "finished",
    "generated",
    "plot_paths:",
    "image_path:",
    "file:",
)

_CHINESE_SUMMARY_CONCISE_TAIL = (
    "\u5269\u4f59\u8bc1\u636e\u8f83\u4e3a\u6709\u9650\uff0c"
    "\u56e0\u6b64\u603b\u7ed3\u4fdd\u6301\u7b80\u6d01\u3002"
)
_CHINESE_SUMMARY_UNAVAILABLE = "\u6682\u65e0\u53ef\u7528\u603b\u7ed3\u3002"
_CHINESE_ANALYSIS_FAILED_PREFIX = "\u5206\u6790\u5931\u8d25\uff1a"


def _build_summarizer_implementation_prompt() -> str:
    taxonomy_lines = "\n".join(f"- {item}" for item in INSIGHT_TAXONOMY_TYPES)
    return (
        "Implementation constraints for summarization:\n"
        "- Output only one WorkerFinding-compatible structured object.\n"
        "- Prefer 2-3 sentence summaries and concise, specific short labels.\n"
        "- Never emit legacy keys or alternate schemas.\n"
        "- Every atomic insight must use exact dataset columns from the provided allowlist.\n"
        "- Every atomic insight must use only the provided code/output/plot evidence paths.\n"
        "- Omit any atomic insight that cannot be grounded to allowed columns or evidence.\n"
        "- Avoid template/meta lead-ins in summary text.\n"
        "- Keep natural-language fields aligned with the latest user-authored language.\n"
        "- Use only the predefined taxonomy values below:\n"
        f"{taxonomy_lines}"
    )


def _is_provider_schema_compat_error(exc: Exception) -> bool:
    text = str(exc or "").strip()
    lowered = text.lower()
    markers = (
        "generation_config.response_schema",
        "unknown name \"$defs\"",
        "unknown name \"$ref\"",
        "unknown name \"discriminator\"",
        "response_schema",
    )
    return any(marker.lower() in lowered for marker in markers)


def _summarizer_tool_spec() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "emit_worker_finding",
                "description": "Emit one WorkerFinding object for the completed worker analysis.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "short_label": {"type": "string"},
                        "keywords": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "atomic_insights": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text": {"type": "string"},
                                    "insight_type": {"type": "string"},
                                    "columns": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                    "keywords": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                    "evidence": {
                                        "type": "object",
                                        "properties": {
                                            "code_path": {"type": "string"},
                                            "output_path": {"type": "string"},
                                            "plot_path": {"type": "string"},
                                        },
                                        "required": ["code_path", "output_path", "plot_path"],
                                    },
                                },
                                "required": [
                                    "text",
                                    "insight_type",
                                    "columns",
                                    "keywords",
                                    "evidence",
                                ],
                            },
                        },
                    },
                    "required": ["summary", "short_label", "keywords", "atomic_insights"],
                },
            },
        }
    ]


def _parse_summarizer_tool_message(message: Any) -> tuple[WorkerFinding | None, str | None]:
    if not isinstance(message, AIMessage):
        return None, "structured_output_parsed_finding_missing"
    tool_calls = list(getattr(message, "tool_calls", []) or [])
    if not tool_calls:
        return None, "structured_output_parsed_finding_missing"
    if len(tool_calls) > 1:
        return None, "structured_output_multiple_tool_calls_not_supported"

    tool_call = tool_calls[0]
    tool_name = str(tool_call.get("name", "") or "").strip()
    raw_args = tool_call.get("args", {})
    if tool_name != "emit_worker_finding":
        return None, f"structured_output_unknown_finding_tool: {tool_name or '<empty>'}"
    if not isinstance(raw_args, dict):
        return None, "structured_output_parsing_error: tool arguments must be a dict"
    try:
        return WorkerFinding.model_validate(raw_args), None
    except Exception as exc:
        return None, f"structured_output_parsing_error: {str(exc).strip() or exc.__class__.__name__}"


class _SummarizerCompatibleStructuredOutputModel:
    def __init__(
        self,
        *,
        bound_model: Any,
        plain_model: Any,
        parser: Callable[[Any], tuple[WorkerFinding | None, str | None]],
    ) -> None:
        self._bound_model = bound_model
        self._plain_model = plain_model
        self._parser = parser

    @staticmethod
    def _build_plain_json_messages(messages: list[Any]) -> list[Any]:
        copied = list(messages)
        if not copied:
            return copied
        last_message = copied[-1]
        if isinstance(last_message, HumanMessage):
            content = str(last_message.content or "")
            if "Return only a WorkerFinding-compatible JSON object." not in content:
                content = content + "\n\nReturn only a WorkerFinding-compatible JSON object."
            copied[-1] = HumanMessage(content=content)
        return copied

    def invoke(self, messages: list[Any]) -> dict[str, Any]:
        try:
            raw_message = self._bound_model.invoke(messages)
            parsed, parsing_error = self._parser(raw_message)
            return {
                "raw": raw_message,
                "parsed": parsed,
                "parsing_error": parsing_error,
                "provider_strategy": "tool_call",
                "schema_compat_error": None,
            }
        except Exception as exc:
            if not _is_provider_schema_compat_error(exc):
                raise
            plain_messages = self._build_plain_json_messages(messages)
            raw_message = self._plain_model.invoke(plain_messages)
            return {
                "raw": raw_message,
                "parsed": None,
                "parsing_error": None,
                "provider_strategy": "text_json_fallback",
                "schema_compat_error": str(exc).strip() or exc.__class__.__name__,
            }


class _SummarizerCompatibleChatModelWrapper:
    def __init__(self, chat_model: Any) -> None:
        self._chat_model = chat_model

    def with_structured_output(self, schema: Any, **kwargs: Any) -> Any:
        if schema is WorkerFinding:
            bound_model = self._chat_model.bind_tools(
                _summarizer_tool_spec(),
                tool_choice="emit_worker_finding",
                parallel_tool_calls=False,
            )
            return _SummarizerCompatibleStructuredOutputModel(
                bound_model=bound_model,
                plain_model=self._chat_model,
                parser=_parse_summarizer_tool_message,
            )
        return self._chat_model.with_structured_output(schema, **kwargs)


class SummarizerAgent:
    def __init__(
        self,
        *,
        summary_provider: Callable[[str], WorkerFinding] | None = None,
    ) -> None:
        self._summary_provider = summary_provider
        chat_model = build_langchain_chat_model(
            model_name=SUMMARIZER_MODEL_NAME,
            temperature=SUMMARIZER_TEMPERATURE,
        )
        self._prompt = None
        self._structured_model = None
        if chat_model is not None:
            compatible_chat_model = _SummarizerCompatibleChatModelWrapper(chat_model)
            self._prompt = ChatPromptTemplate.from_messages(
                [
                    ("system", SUMMARIZER_SYSTEM_PROMPT),
                    ("system", "{implementation_prompt}"),
                    ("human", "{analysis_stream}"),
                ]
            )
            self._structured_model = compatible_chat_model.with_structured_output(
                WorkerFinding,
                include_raw=True,
            )

    def summarize(
        self,
        *,
        plan: PlanItem,
        analysis_stream: str,
        execution_record: Any,
        store: Any | None = None,
        user_messages: list[Any] | None = None,
    ) -> WorkerFinding:
        context = self._build_runtime_context(
            plan=plan,
            execution_record=execution_record,
            store=store,
            analysis_stream=analysis_stream,
        )
        context["prefer_chinese_output"] = contains_cjk_text(latest_user_authored_text(user_messages))
        summary_input = self._build_summary_input(
            analysis_stream=analysis_stream,
            execution_record=execution_record,
            user_messages=user_messages,
            context=context,
        )
        if self._summary_provider is not None:
            finding = self._coerce_finding(self._summary_provider(summary_input), plan)
            finding = self._sanitize_finding(finding, plan, context)
            finding = self._normalize_finding(finding, plan, context=context)
            self._validate_grounded_finding(finding)
            return finding
        if self._structured_model is not None:
            try:
                result = self._invoke_structured_summary(
                    summary_input=summary_input,
                    context=context,
                    latest_user_text=latest_user_authored_text(user_messages),
                )
                recovered_finding, recovery_source = self._recover_finding_from_result(result)
                if recovered_finding is not None and recovery_source is not None:
                    self._persist_raw_output(
                        store,
                        plan.plan_id,
                        result,
                        parsed_finding=recovered_finding,
                        recovery_source=recovery_source,
                    )
                    finding = self._sanitize_finding(recovered_finding, plan, context)
                    finding = self._normalize_finding(finding, plan, context=context)
                    language_retry = self._retry_for_language_alignment(
                        summary_input=summary_input,
                        latest_user_text=latest_user_authored_text(user_messages),
                        finding=finding,
                        plan=plan,
                        context=context,
                    )
                    if language_retry is not None:
                        retry_result, retry_finding, retry_recovery_source = language_retry
                        self._persist_raw_output(
                            store,
                            plan.plan_id,
                            retry_result,
                            parsed_finding=retry_finding,
                            recovery_source=retry_recovery_source,
                        )
                        finding = self._sanitize_finding(retry_finding, plan, context)
                        finding = self._normalize_finding(finding, plan, context=context)
                    self._validate_grounded_finding(finding)
                    return finding
                self._persist_raw_output(
                    store,
                    plan.plan_id,
                    result,
                    recovery_source="fallback",
                    provider_strategy=(
                        str(result.get("provider_strategy", "")).strip()
                        if isinstance(result, dict)
                        else None
                    ),
                    schema_compat_error=(
                        str(result.get("schema_compat_error", "")).strip() or None
                        if isinstance(result, dict)
                        else None
                    ),
                )
            except Exception as exc:
                self._persist_invocation_error(store, plan.plan_id, exc)
                pass
        finding = self._fallback(plan, analysis_stream, execution_record, context=context)
        finding = self._normalize_finding(finding, plan, context=context)
        self._validate_grounded_finding(finding)
        return finding

    @staticmethod
    def _build_summary_input(
        *,
        analysis_stream: str,
        execution_record: Any,
        user_messages: list[Any] | None,
        context: dict[str, Any],
    ) -> str:
        analysis_stream = str(context.get("analysis_stream", "") or analysis_stream or "").strip()
        latest_user_text = ""
        if user_messages:
            latest_user_text = str(getattr(user_messages[-1], "content", "") or "").strip()
        plot_paths = context.get("allowed_plot_paths", []) or list(getattr(execution_record, "plot_paths", []) or [])
        evidence_lines = [
            f"latest_user_authored_message: {latest_user_text or '<none>'}",
            f"code_path: {str(getattr(execution_record, 'code_path', '') or '<none>')}",
            f"output_path: {str(getattr(execution_record, 'stdout_path', '') or '<none>')}",
            f"stderr_path: {str(getattr(execution_record, 'stderr_path', '') or '<none>')}",
            (
                "plot_paths: " + ", ".join(str(path) for path in plot_paths)
                if plot_paths
                else "plot_paths: <none>"
            ),
            "allowed_dataset_columns: "
            + ", ".join(context.get("dataset_columns", []) or ["<none>"]),
            "allowed_code_paths: "
            + ", ".join(context.get("allowed_code_paths", []) or ["<none>"]),
            "allowed_output_paths: "
            + ", ".join(context.get("allowed_output_paths", []) or ["<none>"]),
            "allowed_plot_paths: "
            + ", ".join(context.get("allowed_plot_paths", []) or ["<none>"]),
            f"latest_substantive_reflection: {context.get('latest_reflection', '<none>') or '<none>'}",
        ]
        return (
            "Summarizer runtime context:\n"
            + "\n".join(evidence_lines)
            + "\n\nCompleted analysis stream:\n"
            + analysis_stream
        )

    def _invoke_structured_summary(
        self,
        *,
        summary_input: str,
        context: dict[str, Any],
        latest_user_text: str,
        retry_instruction: str | None = None,
    ) -> dict[str, Any] | Any:
        assert self._structured_model is not None
        messages = self._build_summary_messages(
            summary_input=summary_input,
            context=context,
            latest_user_text=latest_user_text,
            retry_instruction=retry_instruction,
        )
        return self._structured_model.invoke(messages)

    def _build_summary_messages(
        self,
        *,
        summary_input: str,
        context: dict[str, Any],
        latest_user_text: str,
        retry_instruction: str | None = None,
    ) -> list[Any]:
        implementation_prompt = self._build_runtime_implementation_prompt(
            context=context,
            latest_user_text=latest_user_text,
        )
        if self._prompt is not None:
            analysis_payload = summary_input
            if retry_instruction:
                analysis_payload = summary_input + "\n\n" + retry_instruction
            return self._prompt.format_messages(
                implementation_prompt=implementation_prompt,
                analysis_stream=analysis_payload,
            )
        messages: list[Any] = [
            SystemMessage(content=SUMMARIZER_SYSTEM_PROMPT),
            SystemMessage(content=implementation_prompt),
        ]
        analysis_payload = summary_input
        if retry_instruction:
            analysis_payload = summary_input + "\n\n" + retry_instruction
        messages.append(HumanMessage(content=analysis_payload))
        return messages

    @staticmethod
    def _build_runtime_implementation_prompt(
        *,
        context: dict[str, Any],
        latest_user_text: str,
    ) -> str:
        plot_paths = context.get("allowed_plot_paths", []) or ["<none>"]
        code_paths = context.get("allowed_code_paths", []) or ["<none>"]
        output_paths = context.get("allowed_output_paths", []) or ["<none>"]
        columns = context.get("dataset_columns", []) or ["<none>"]
        return (
            _build_summarizer_implementation_prompt()
            + "\n\nLanguage alignment reminder:\n"
            + strict_language_match_instruction(latest_user_text)
            + "\n\nAllowed dataset columns:\n"
            + ", ".join(str(item) for item in columns)
            + "\nAllowed code paths:\n"
            + ", ".join(str(item) for item in code_paths)
            + "\nAllowed output paths:\n"
            + ", ".join(str(item) for item in output_paths)
            + "\nAllowed plot paths:\n"
            + ", ".join(str(item) for item in plot_paths)
        )

    def _retry_for_language_alignment(
        self,
        *,
        summary_input: str,
        latest_user_text: str,
        finding: WorkerFinding,
        plan: PlanItem,
        context: dict[str, Any],
    ) -> tuple[dict[str, Any] | Any, WorkerFinding, str] | None:
        if not self._response_violates_user_language(finding, latest_user_text=latest_user_text):
            return None
        retry_instruction = (
            "Language correction retry:\n"
            + strict_language_match_instruction(latest_user_text)
            + "\nReissue the full WorkerFinding object with all natural-language values corrected."
        )
        try:
            result = self._invoke_structured_summary(
                summary_input=summary_input,
                context=context,
                latest_user_text=latest_user_text,
                retry_instruction=retry_instruction,
            )
        except Exception:
            return None
        retry_finding, recovery_source = self._recover_finding_from_result(result)
        if retry_finding is None or recovery_source is None:
            return None
        return result, retry_finding, recovery_source

    @staticmethod
    def _build_runtime_context(
        *,
        plan: PlanItem,
        execution_record: Any,
        store: Any | None,
        analysis_stream: str,
    ) -> dict[str, Any]:
        dataset_columns: list[str] = []
        analysis_process: dict[str, Any] | None = None
        if store is not None:
            state = store.load_state()
            if state is not None:
                raw_columns = state.dataset_metadata.get("columns", []) if isinstance(state.dataset_metadata, dict) else []
                for item in raw_columns or []:
                    if isinstance(item, dict):
                        name = str(item.get("name", "") or "").strip()
                        if name and name not in dataset_columns:
                            dataset_columns.append(name)
            analysis_path = str(getattr(execution_record, "analysis_path", "") or "").strip()
            if analysis_path:
                try:
                    analysis_process = json.loads((store.run_dir / analysis_path).read_text(encoding="utf-8"))
                except Exception:
                    analysis_process = None

        execution_records: list[dict[str, Any]] = []
        if isinstance(analysis_process, dict):
            execution_records = [
                item for item in analysis_process.get("execution_records", []) or [] if isinstance(item, dict)
            ]
        if not execution_records and hasattr(execution_record, "to_dict"):
            execution_records = [execution_record.to_dict()]

        raw_evidence_paths: list[str] = []
        for record in execution_records:
            code_path = str(record.get("code_path", "") or "").strip()
            stdout_path = str(record.get("stdout_path", "") or "").strip()
            stderr_path = str(record.get("stderr_path", "") or "").strip()
            plot_paths = [
                str(path or "").strip()
                for path in record.get("plot_paths", []) or []
                if str(path or "").strip()
            ]
            if code_path:
                raw_evidence_paths.append(code_path)
            if stdout_path:
                raw_evidence_paths.append(stdout_path)
            if stderr_path:
                raw_evidence_paths.append(stderr_path)
            raw_evidence_paths.extend(plot_paths)

        filtered_evidence_paths = (
            SummarizerAgent._filter_evidence_paths(store, raw_evidence_paths)
            if store is not None
            else SummarizerAgent._dedupe_paths(raw_evidence_paths)
        )
        filtered_evidence_set = set(filtered_evidence_paths)

        allowed_code_paths = [
            path for path in filtered_evidence_paths if not SummarizerAgent._is_image_path(path) and "/code/" in f"/{path}"
        ]
        allowed_output_paths = [
            path for path in filtered_evidence_paths if not SummarizerAgent._is_image_path(path) and ("/stdout/" in f"/{path}" or "/stderr/" in f"/{path}")
        ]
        allowed_plot_paths = [
            path for path in filtered_evidence_paths if SummarizerAgent._is_image_path(path)
        ]
        evidence_bundles: list[dict[str, str]] = []
        for record in execution_records:
            code_path = str(record.get("code_path", "") or "").strip()
            stdout_path = str(record.get("stdout_path", "") or "").strip()
            stderr_path = str(record.get("stderr_path", "") or "").strip()
            output_path = stdout_path if stdout_path in filtered_evidence_set else stderr_path
            plot_paths = [
                str(path or "").strip()
                for path in record.get("plot_paths", []) or []
                if str(path or "").strip() in filtered_evidence_set
            ]
            if code_path not in filtered_evidence_set:
                continue
            if not output_path:
                continue
            for plot_path in plot_paths:
                evidence_bundles.append(
                    {
                        "code_path": code_path,
                        "output_path": output_path,
                        "plot_path": plot_path,
                    }
                )

        latest_reflection = ""
        if isinstance(analysis_process, dict):
            worker_state = analysis_process.get("worker_state")
            if isinstance(worker_state, dict):
                latest_reflection = str(worker_state.get("latest_reflection", "") or "").strip()
        if not latest_reflection:
            latest_reflection = SummarizerAgent._extract_latest_reflection(analysis_stream)

        rebuilt_analysis_stream = str(analysis_stream or "").strip()
        plot_images: list[tuple[str, bytes]] = []
        if store is not None and isinstance(analysis_process, dict):
            rebuilt_analysis_stream, plot_images = SummarizerAgent._build_analysis_stream(
                store=store,
                analysis_process=analysis_process,
                allowed_paths=filtered_evidence_set,
            )
        if not rebuilt_analysis_stream:
            rebuilt_analysis_stream = SummarizerAgent._build_minimal_stream(
                execution_record,
                allowed_code_paths=allowed_code_paths,
                allowed_output_paths=allowed_output_paths,
                allowed_plot_paths=allowed_plot_paths,
                store=store,
            )

        return {
            "plan_id": plan.plan_id,
            "plan": plan,
            "dataset_columns": dataset_columns,
            "allowed_code_paths": allowed_code_paths,
            "allowed_output_paths": allowed_output_paths,
            "allowed_plot_paths": allowed_plot_paths,
            "evidence_bundles": evidence_bundles,
            "latest_reflection": latest_reflection,
            "analysis_process": analysis_process,
            "execution_records": execution_records,
            "analysis_stream": rebuilt_analysis_stream,
            "plot_images": plot_images,
        }

    @staticmethod
    def _dedupe_paths(paths: list[str]) -> list[str]:
        seen: set[str] = set()
        ordered: list[str] = []
        for path in paths:
            normalized = str(path or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            ordered.append(normalized)
        return ordered

    @staticmethod
    def _is_image_path(path: str) -> bool:
        return bool(re.search(r"\.(png|jpe?g|gif|webp)$", str(path or ""), re.IGNORECASE))

    @classmethod
    def _filter_evidence_paths(cls, store: Any, paths: list[str]) -> list[str]:
        filtered: list[str] = []
        seen: set[str] = set()
        run_dir = Path(store.run_dir)
        for rel in paths:
            normalized = str(rel or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            try:
                abs_path = (run_dir / normalized).resolve()
            except Exception:
                continue
            try:
                abs_path.relative_to(run_dir.resolve())
            except Exception:
                continue
            if not abs_path.exists() or not abs_path.is_file():
                continue
            if cls._is_image_path(normalized):
                try:
                    if abs_path.stat().st_size > 0:
                        filtered.append(abs_path.relative_to(run_dir).as_posix())
                except Exception:
                    continue
                continue
            try:
                content = abs_path.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue
            if content.strip():
                filtered.append(abs_path.relative_to(run_dir).as_posix())
        return filtered

    @staticmethod
    def _load_text_artifact(store: Any, rel_path: str | None) -> str:
        if not rel_path:
            return ""
        try:
            return (Path(store.run_dir) / rel_path).read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""

    @classmethod
    def _build_analysis_stream(
        cls,
        *,
        store: Any,
        analysis_process: dict[str, Any],
        allowed_paths: set[str],
    ) -> tuple[str, list[tuple[str, bytes]]]:
        out_lines: list[str] = []
        images: list[tuple[str, bytes]] = []
        trace_entries = [
            str(item or "").strip()
            for item in analysis_process.get("trace", []) or []
            if str(item or "").strip()
        ]
        if trace_entries:
            out_lines.append("Trace stream:\n" + "\n\n".join(trace_entries) + "\n")

        for record in [
            item for item in analysis_process.get("execution_records", []) or [] if isinstance(item, dict)
        ]:
            code_path = str(record.get("code_path", "") or "").strip()
            stdout_path = str(record.get("stdout_path", "") or "").strip()
            stderr_path = str(record.get("stderr_path", "") or "").strip()
            plot_paths = [
                str(path or "").strip()
                for path in record.get("plot_paths", []) or []
                if str(path or "").strip()
            ]
            out_lines.append("[EXECUTE_CODE]")
            out_lines.append(f"success={bool(record.get('success', False))}")
            if code_path in allowed_paths:
                out_lines.append(f"code_path: {code_path}")
                code_text = cls._load_text_artifact(store, code_path)
                if code_text.strip():
                    out_lines.append("code:\n" + code_text)
            if stdout_path in allowed_paths:
                out_lines.append(f"stdout_path: {stdout_path}")
                stdout_text = cls._load_text_artifact(store, stdout_path)
                if stdout_text.strip():
                    out_lines.append("stdout:\n" + stdout_text)
            if stderr_path in allowed_paths:
                out_lines.append(f"stderr_path: {stderr_path}")
                stderr_text = cls._load_text_artifact(store, stderr_path)
                if stderr_text.strip():
                    out_lines.append("stderr:\n" + stderr_text)
            filtered_plot_paths = [path for path in plot_paths if path in allowed_paths]
            if filtered_plot_paths:
                out_lines.append("plot_paths:\n" + "\n".join(f"- {path}" for path in filtered_plot_paths))
                for path in filtered_plot_paths[:_SUMMARIZER_MAX_IMAGE_ATTACHMENTS]:
                    try:
                        img_bytes = (Path(store.run_dir) / path).read_bytes()
                    except Exception:
                        continue
                    if img_bytes:
                        images.append((path, img_bytes))
            out_lines.append("")

        return "\n".join(line for line in out_lines if line is not None).strip(), images

    @classmethod
    def _build_minimal_stream(
        cls,
        execution_record: Any,
        *,
        allowed_code_paths: list[str],
        allowed_output_paths: list[str],
        allowed_plot_paths: list[str],
        store: Any | None,
    ) -> str:
        out: list[str] = []
        code_path = str(getattr(execution_record, "code_path", "") or "").strip()
        if code_path and code_path in allowed_code_paths:
            out.append(f"[CODE_PATH]\n{code_path}")
            if store is not None:
                code_text = cls._load_text_artifact(store, code_path)
                if code_text.strip():
                    out.append(code_text)
        stdout_path = str(getattr(execution_record, "stdout_path", "") or "").strip()
        if stdout_path and stdout_path in allowed_output_paths:
            out.append(f"[STDOUT_PATH]\n{stdout_path}")
            if store is not None:
                stdout_text = cls._load_text_artifact(store, stdout_path)
                if stdout_text.strip():
                    out.append(stdout_text)
        else:
            stdout_content = str(getattr(execution_record, "stdout_content", "") or "").strip()
            if stdout_content:
                out.append(f"[STDOUT]\n{stdout_content}")
        stderr_path = str(getattr(execution_record, "stderr_path", "") or "").strip()
        if stderr_path and stderr_path in allowed_output_paths:
            out.append(f"[STDERR_PATH]\n{stderr_path}")
            if store is not None:
                stderr_text = cls._load_text_artifact(store, stderr_path)
                if stderr_text.strip():
                    out.append(stderr_text)
        else:
            stderr_content = str(getattr(execution_record, "stderr_content", "") or "").strip()
            if stderr_content:
                out.append(f"[STDERR]\n{stderr_content}")
        if allowed_plot_paths:
            out.append("[PLOTS]\n" + "\n".join(f"- {path}" for path in allowed_plot_paths))
        return "\n\n".join(item for item in out if item).strip()

    @classmethod
    def _coerce_finding(cls, finding: WorkerFinding | dict[str, Any], plan: PlanItem) -> WorkerFinding:
        if isinstance(finding, WorkerFinding):
            return finding
        if isinstance(finding, dict):
            return WorkerFinding.model_validate(finding)
        raise TypeError(
            f"Unable to coerce summarizer output for plan {plan.plan_id}: "
            f"{type(finding).__name__}"
        )

    @staticmethod
    def _strip_code_fences(text: str) -> str:
        stripped = str(text or "").strip()
        if "```" not in stripped:
            return stripped
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
        return stripped.strip()

    @classmethod
    def _extract_json_object(cls, text: str) -> dict[str, Any] | None:
        cleaned = cls._strip_code_fences(text)
        if not cleaned:
            return None
        decoder = json.JSONDecoder()
        cursor = 0
        while cursor < len(cleaned):
            start = cleaned.find("{", cursor)
            if start < 0:
                return None
            try:
                payload, offset = decoder.raw_decode(cleaned[start:])
            except json.JSONDecodeError:
                cursor = start + 1
                continue
            if isinstance(payload, dict):
                return payload
            cursor = start + offset
        return None

    @staticmethod
    def _extract_text_from_content(content: Any) -> str:
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            text_parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text_value = part.get("text")
                    if isinstance(text_value, str) and text_value.strip():
                        text_parts.append(text_value.strip())
                    continue
                text_value = getattr(part, "text", None)
                if isinstance(text_value, str) and text_value.strip():
                    text_parts.append(text_value.strip())
            return "\n".join(text_parts).strip()
        return ""

    @classmethod
    def _extract_message_content_text(cls, message: Any) -> str:
        if isinstance(message, AIMessage):
            text = cls._extract_text_from_content(message.content)
            if text:
                return text
        content = getattr(message, "content", None)
        if content is not None:
            text = cls._extract_text_from_content(content)
            if text:
                return text
        if isinstance(message, str):
            return message.strip()
        return ""

    @staticmethod
    def _try_validate_finding(candidate: Any) -> WorkerFinding | None:
        if isinstance(candidate, WorkerFinding):
            return candidate
        if isinstance(candidate, dict):
            try:
                return WorkerFinding.model_validate(candidate)
            except Exception:
                return None
        return None

    @classmethod
    def _recover_finding_from_raw_message(cls, raw_message: Any) -> WorkerFinding | None:
        text = cls._extract_message_content_text(raw_message)
        if not text:
            return None
        payload = cls._extract_json_object(text)
        if payload is None:
            return None
        return cls._try_validate_finding(payload)

    @classmethod
    def _recover_finding_from_result(
        cls,
        result: Any,
    ) -> tuple[WorkerFinding | None, str | None]:
        direct_finding = cls._try_validate_finding(result)
        if direct_finding is not None:
            return direct_finding, "provider_parsed"
        if isinstance(result, dict):
            parsed_finding = cls._try_validate_finding(result.get("parsed"))
            if parsed_finding is not None:
                return parsed_finding, "provider_parsed"
            raw_finding = cls._recover_finding_from_raw_message(result.get("raw"))
            if raw_finding is not None:
                return raw_finding, "raw_json_recovered"
        raw_finding = cls._recover_finding_from_raw_message(result)
        if raw_finding is not None:
            return raw_finding, "raw_json_recovered"
        return None, None

    @staticmethod
    def _serialize_message(message: Any) -> dict[str, Any]:
        if isinstance(message, AIMessage):
            return message_to_dict(message)
        if hasattr(message, "model_dump"):
            return message.model_dump()
        return {
            "content": str(getattr(message, "content", "") or message or ""),
        }

    @staticmethod
    def _serialize_value(value: Any) -> Any:
        if value is None:
            return None
        if hasattr(value, "model_dump"):
            return value.model_dump()
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return value

    @classmethod
    def _extract_provider_raw_payload(cls, message: Any) -> dict[str, Any] | None:
        if not isinstance(message, AIMessage):
            return None
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

    @classmethod
    def _extract_raw_output_text(cls, message: Any) -> str:
        provider_payload = cls._extract_provider_raw_payload(message)
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
        if isinstance(message, AIMessage):
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
        return str(getattr(message, "content", "") or "").strip()

    def _persist_raw_output(
        self,
        store: Any | None,
        plan_id: str,
        result: Any,
        *,
        parsed_finding: WorkerFinding | None = None,
        recovery_source: str | None = None,
        provider_strategy: str | None = None,
        schema_compat_error: str | None = None,
    ) -> None:
        if store is None or not isinstance(result, dict):
            return
        resolved_provider_strategy = provider_strategy or (
            str(result.get("provider_strategy", "")).strip() or None
        )
        resolved_schema_compat_error = schema_compat_error or (
            str(result.get("schema_compat_error", "")).strip() or None
        )
        store.save_llm_output(
            "summarizer",
            {
                "agent_name": "summarizer",
                "model_name": SUMMARIZER_MODEL_NAME,
                "plan_id": plan_id,
                "raw_output_text": self._extract_raw_output_text(result.get("raw")),
                "provider_raw_payload": self._extract_provider_raw_payload(result.get("raw")),
                "raw_message": self._serialize_message(result.get("raw")),
                "parsed_output": self._serialize_value(
                    parsed_finding if parsed_finding is not None else result.get("parsed")
                ),
                "parsing_error": (
                    str(result.get("parsing_error", "")).strip() or None
                    if result.get("parsing_error") is not None
                    else None
                ),
                "recovery_source": recovery_source,
                "provider_strategy": resolved_provider_strategy,
                "schema_compat_error": resolved_schema_compat_error,
            },
            plan_id=plan_id,
            label="final",
            metadata={
                "model_name": SUMMARIZER_MODEL_NAME,
                "recovery_source": recovery_source,
                "provider_strategy": resolved_provider_strategy,
            },
        )

    def _persist_invocation_error(
        self,
        store: Any | None,
        plan_id: str,
        exc: Exception,
    ) -> None:
        if store is None:
            return
        store.save_llm_output(
            "summarizer",
            {
                "agent_name": "summarizer",
                "model_name": SUMMARIZER_MODEL_NAME,
                "plan_id": plan_id,
                "raw_output_text": "",
                "provider_raw_payload": None,
                "raw_message": None,
                "parsed_output": None,
                "parsing_error": None,
                "invocation_error": str(exc).strip() or exc.__class__.__name__,
            },
            plan_id=plan_id,
            label="final_error",
            metadata={"model_name": SUMMARIZER_MODEL_NAME, "error": True},
        )

    @staticmethod
    def _fallback(
        plan: PlanItem,
        analysis_stream: str,
        execution_record: Any,
        *,
        context: dict[str, Any],
    ) -> WorkerFinding:
        fallback_atomics = SummarizerAgent._build_fallback_atomic_insights(plan, context)
        summary = SummarizerAgent._fallback_summary(
            analysis_stream,
            execution_record,
            context=context,
        )
        return WorkerFinding(
            summary=summary,
            short_label=plan.short_label or "Finding",
            keywords=[],
            atomic_insights=fallback_atomics,
        )

    @staticmethod
    def _fallback_summary(
        analysis_stream: str,
        execution_record: Any,
        *,
        context: dict[str, Any],
    ) -> str:
        latest_reflection = str(context.get("latest_reflection", "") or "").strip()
        if latest_reflection:
            return latest_reflection.splitlines()[0].strip()
        for record in reversed(context.get("execution_records", []) or []):
            stdout = str(record.get("stdout_content", "") or "").strip()
            summary_candidate = SummarizerAgent._select_non_process_stdout(stdout)
            if summary_candidate:
                return summary_candidate
        stdout = str(getattr(execution_record, "stdout_content", "") or "").strip()
        summary_candidate = SummarizerAgent._select_non_process_stdout(stdout)
        if summary_candidate:
            return summary_candidate
        fallback_plain = SummarizerAgent._fallback_plain(
            plan=context.get("plan"),
            execution_record=execution_record,
            context=context,
        )
        if fallback_plain:
            return fallback_plain
        stream = str(analysis_stream or "").strip()
        if stream:
            return stream.splitlines()[0].strip()
        return "No stable finding was extracted from the completed worker stream."

    @classmethod
    def _normalize_finding(
        cls,
        finding: WorkerFinding,
        plan: PlanItem,
        *,
        context: dict[str, Any],
    ) -> WorkerFinding:
        summary = cls._normalize_summary(
            plan=plan,
            summary_text=str(finding.summary or "").strip(),
            atomic_insights=finding.atomic_insights,
            fallback=cls._fallback_plain(plan=plan, execution_record=None, context=context),
            prefer_chinese=bool(context.get("prefer_chinese_output", False)),
        )
        short_label = str(finding.short_label or "").strip() or (plan.short_label or "Finding")
        return WorkerFinding(
            summary=summary,
            short_label=short_label,
            keywords=normalize_keyword_list(list(finding.keywords or []), limit=SUMMARIZER_MAX_KEYWORDS),
            atomic_insights=list(finding.atomic_insights or []),
        )

    @staticmethod
    def _response_violates_user_language(
        finding: WorkerFinding,
        *,
        latest_user_text: str,
    ) -> bool:
        if not contains_cjk_text(latest_user_text):
            return False
        samples = [
            str(finding.summary or "").strip(),
            str(finding.short_label or "").strip(),
            *[
                str(item.text or "").strip()
                for item in list(finding.atomic_insights or [])[:2]
            ],
        ]
        meaningful = [text for text in samples if text]
        if not meaningful:
            return False
        return any(not contains_cjk_text(text) for text in meaningful)

    @staticmethod
    def _split_sentences(text: str) -> list[str]:
        normalized = re.sub(r"\s+", " ", str(text or "").strip())
        if not normalized:
            return []
        normalized = re.sub(r"([。！？])(?=[^\s])", r"\1 ", normalized)
        return [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+", normalized) if part.strip()]

    @staticmethod
    def _is_template_summary_lead_sentence(sentence: str) -> bool:
        normalized = re.sub(r"\s+", " ", str(sentence or "").strip())
        if not normalized:
            return False
        lowered = normalized.casefold()
        return any(re.match(pattern, lowered) for pattern in _SUMMARY_LEAD_PATTERNS_EN)

    @classmethod
    def _strip_template_summary_lead_sentence(cls, text: str) -> str:
        sentences = cls._split_sentences(text)
        if not sentences:
            return str(text or "").strip()
        if not cls._is_template_summary_lead_sentence(sentences[0]):
            return str(text or "").strip()
        return " ".join(sentences[1:]).strip()

    @staticmethod
    def _normalize_source_task_token(text: str) -> str:
        return re.sub(r"\s+", " ", str(text or "").strip()).strip(" \t\r\n\"'`[](){}:;,.!?-")

    @classmethod
    def _strip_leading_source_task_text(cls, text: str, plan: PlanItem | None) -> str:
        working = re.sub(r"\s+", " ", str(text or "").strip())
        if not working or plan is None:
            return working
        plan_text = re.sub(r"\s+", " ", str(plan.text or "").strip())
        if not plan_text:
            return working
        normalized_plan = cls._normalize_source_task_token(plan_text)
        if len(normalized_plan) < 12 and len(normalized_plan.split()) < 2 and ":" not in normalized_plan:
            return working
        candidates = [
            plan_text,
            f"Task: {plan_text}",
            f"Source Task: {plan_text}",
            f"Source task: {plan_text}",
        ]
        for candidate in candidates:
            token = cls._normalize_source_task_token(candidate)
            if not token:
                continue
            pattern = r"\s+".join(re.escape(part) for part in token.split())
            match = re.match(
                rf"^\s*{pattern}\s*(?:[:\uff1a\-.;,!?]+\s*)?(?P<rest>.+?)\s*$",
                working,
                flags=re.IGNORECASE,
            )
            if not match:
                continue
            remainder = match.group("rest").strip()
            if remainder:
                return remainder
        return working

    @staticmethod
    def _fallback_summary_completion_sentence(*, prefer_chinese: bool) -> str:
        if prefer_chinese:
            return _CHINESE_SUMMARY_CONCISE_TAIL
        return "The remaining evidence is limited, so the summary stays concise."

    @classmethod
    def _normalize_summary(
        cls,
        *,
        plan: PlanItem,
        summary_text: str,
        atomic_insights: list[WorkerFindingAtomicInsight],
        fallback: str,
        prefer_chinese: bool,
    ) -> str:
        summary = cls._strip_leading_source_task_text(summary_text, plan)
        summary = cls._strip_template_summary_lead_sentence(summary)
        sentences = cls._split_sentences(summary) if summary and not cls._looks_like_heading(summary) else []

        if len(sentences) < _SUMMARIZER_MIN_SUMMARY_SENTENCES:
            combined: list[str] = []
            for sentence in sentences:
                if sentence and sentence not in combined:
                    combined.append(sentence)
            for atomic in atomic_insights:
                atomic_sentence = cls._strip_leading_source_task_text(str(atomic.text or "").strip(), plan)
                if not atomic_sentence or atomic_sentence in combined:
                    continue
                combined.append(atomic_sentence)
                if len(combined) >= _SUMMARIZER_MAX_SUMMARY_SENTENCES:
                    break
            fallback_sentence = cls._strip_template_summary_lead_sentence(
                cls._strip_leading_source_task_text(fallback, plan)
            )
            if fallback_sentence and fallback_sentence not in combined:
                combined.append(fallback_sentence)
            if combined:
                sentences = combined[:_SUMMARIZER_MAX_SUMMARY_SENTENCES]

        if not sentences:
            sentences = [_CHINESE_SUMMARY_UNAVAILABLE if prefer_chinese else "Summary unavailable."]

        while len(sentences) < _SUMMARIZER_MIN_SUMMARY_SENTENCES:
            sentences.append(
                cls._fallback_summary_completion_sentence(prefer_chinese=prefer_chinese)
            )
        return " ".join(sentences[:_SUMMARIZER_MAX_SUMMARY_SENTENCES]).strip()

    @classmethod
    def _fallback_plain(
        cls,
        *,
        plan: PlanItem | None,
        execution_record: Any,
        context: dict[str, Any],
    ) -> str:
        latest_reflection = str(context.get("latest_reflection", "") or "").strip()
        if latest_reflection:
            return latest_reflection.splitlines()[0].strip()
        for record in reversed(context.get("execution_records", []) or []):
            stdout = str(record.get("stdout_content", "") or "").strip()
            summary_candidate = cls._select_non_process_stdout(stdout)
            if summary_candidate:
                return cls._strip_leading_source_task_text(summary_candidate, plan)
        if execution_record is not None:
            stdout = str(getattr(execution_record, "stdout_content", "") or "").strip()
            summary_candidate = cls._select_non_process_stdout(stdout)
            if summary_candidate:
                return cls._strip_leading_source_task_text(summary_candidate, plan)
            error_message = str(getattr(execution_record, "error_message", "") or "").strip()
            if error_message:
                return (
                    f"{_CHINESE_ANALYSIS_FAILED_PREFIX}{error_message}"
                    if bool(context.get("prefer_chinese_output", False))
                    else f"Analysis failed: {error_message}"
                )
        return ""

    @staticmethod
    def _looks_like_heading(text: str) -> bool:
        t = str(text or "").strip()
        if not t:
            return True
        if t.startswith("===") or t.startswith("#") or t.startswith("---"):
            return True
        letters = [c for c in t if c.isalpha()]
        if letters and all(c.isupper() for c in letters):
            return True
        return False

    @staticmethod
    def _validate_grounded_finding(finding: WorkerFinding) -> None:
        for insight in finding.atomic_insights:
            assert insight.evidence.code_path
            assert insight.evidence.output_path
            assert insight.evidence.plot_path

    @staticmethod
    def _extract_latest_reflection(analysis_stream: str) -> str:
        matches = re.findall(
            r"\[reflection\]\n(.*?)(?=\n\[[a-z_]+\]|\Z)",
            str(analysis_stream or ""),
            flags=re.IGNORECASE | re.DOTALL,
        )
        for match in reversed(matches):
            reflection = str(match or "").strip()
            if reflection:
                return reflection
        return ""

    @staticmethod
    def _select_non_process_stdout(stdout: str) -> str:
        if not stdout.strip():
            return ""
        for line in stdout.splitlines():
            candidate = str(line or "").strip()
            if not candidate:
                continue
            lowered = candidate.casefold()
            if any(marker in lowered for marker in _FALLBACK_STDOUT_SKIP_MARKERS):
                continue
            return candidate
        return ""

    @staticmethod
    def _build_dataset_column_index(columns: list[str]) -> dict[str, str]:
        index: dict[str, str] = {}
        for column in columns:
            normalized = str(column or "").strip()
            if not normalized:
                continue
            key = normalized.casefold()
            if key not in index:
                index[key] = normalized
        return index

    @classmethod
    def _sanitize_finding(
        cls,
        finding: WorkerFinding,
        plan: PlanItem,
        context: dict[str, Any],
    ) -> WorkerFinding:
        column_index = cls._build_dataset_column_index(context.get("dataset_columns", []) or [])
        allowed_code_paths = set(context.get("allowed_code_paths", []) or [])
        allowed_output_paths = set(context.get("allowed_output_paths", []) or [])
        allowed_plot_paths = set(context.get("allowed_plot_paths", []) or [])
        sanitized_atomics: list[WorkerFindingAtomicInsight] = []
        for atomic in list(finding.atomic_insights or [])[:SUMMARIZER_MAX_ATOMIC_INSIGHTS]:
            if str(atomic.insight_type or "").strip() not in INSIGHT_TAXONOMY_TYPES:
                continue
            mapped_columns: list[str] = []
            for raw_column in list(atomic.columns or []):
                normalized = str(raw_column or "").strip()
                if not normalized:
                    continue
                mapped = column_index.get(normalized.casefold())
                if mapped and mapped not in mapped_columns:
                    mapped_columns.append(mapped)
            if not mapped_columns:
                continue
            evidence = atomic.evidence
            if evidence.code_path not in allowed_code_paths:
                continue
            if evidence.output_path not in allowed_output_paths:
                continue
            if evidence.plot_path not in allowed_plot_paths:
                continue
            sanitized_atomics.append(
                WorkerFindingAtomicInsight(
                    text=str(atomic.text or "").strip(),
                    insight_type=str(atomic.insight_type or "").strip(),
                    columns=mapped_columns,
                    keywords=normalize_keyword_list(list(atomic.keywords or []), limit=SUMMARIZER_MAX_KEYWORDS),
                    evidence=WorkerFindingEvidence(
                        code_path=evidence.code_path,
                        output_path=evidence.output_path,
                        plot_path=evidence.plot_path,
                    ),
                )
            )
        if not sanitized_atomics:
            sanitized_atomics = cls._build_fallback_atomic_insights(plan, context)
        summary = str(finding.summary or "").strip()
        if not summary:
            summary = cls._fallback_summary("", None, context=context)
        short_label = str(finding.short_label or "").strip() or (plan.short_label or "Finding")
        return WorkerFinding(
            summary=summary,
            short_label=short_label,
            keywords=normalize_keyword_list(list(finding.keywords or []), limit=SUMMARIZER_MAX_KEYWORDS),
            atomic_insights=sanitized_atomics,
        )

    @classmethod
    def _build_fallback_atomic_insights(
        cls,
        plan: PlanItem,
        context: dict[str, Any],
    ) -> list[WorkerFindingAtomicInsight]:
        bundles = list(context.get("evidence_bundles", []) or [])
        if not bundles:
            return []
        dataset_columns = list(context.get("dataset_columns", []) or [])
        columns = cls._fallback_columns_from_plan(plan, dataset_columns)
        if not columns:
            return []
        latest_reflection = str(context.get("latest_reflection", "") or "").strip()
        text = latest_reflection.splitlines()[0].strip() if latest_reflection else ""
        if not text:
            text = f"Evidence-backed finding related to {', '.join(columns[:2])}."
        atomic = WorkerFindingAtomicInsight(
            text=text,
            insight_type=cls._infer_fallback_insight_type(plan.text),
            columns=columns,
            keywords=normalize_keyword_list(columns, limit=SUMMARIZER_MAX_KEYWORDS),
            evidence=WorkerFindingEvidence(
                code_path=str(bundles[0].get("code_path", "") or ""),
                output_path=str(bundles[0].get("output_path", "") or ""),
                plot_path=str(bundles[0].get("plot_path", "") or ""),
            ),
        )
        return [atomic]

    @staticmethod
    def _fallback_columns_from_plan(plan: PlanItem, dataset_columns: list[str]) -> list[str]:
        plan_text = str(plan.text or "").casefold()
        matches = [column for column in dataset_columns if str(column).casefold() in plan_text]
        if matches:
            return matches[:3]
        return dataset_columns[:2]

    @staticmethod
    def _infer_fallback_insight_type(text: str) -> str:
        lowered = str(text or "").casefold()
        if any(token in lowered for token in ("trend", "year", "time")):
            return "trend"
        if any(token in lowered for token in ("compare", "difference")):
            return "difference"
        if any(token in lowered for token in ("distribution",)):
            return "distribution"
        return "value"
