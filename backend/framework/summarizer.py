"""
Summarizer for the Agentic EDA Framework

MVP design (see docs/Framework/Agent Architecture.md):
- Produces one summary node containing multiple atomic insights.
- Each atomic insight is taxonomy-typed and linked to code/output/plot evidence.
"""

from __future__ import annotations

import ast
import base64
import json
import re
from typing import Optional, Dict, Any, List, Tuple

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    # Allow running as a script: `python backend/framework/summarizer.py`
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from cache_normalization import build_summarizer_cache_normalization_context  # noqa: E402
from model_cache import (  # noqa: E402
    activate_timestamp_binding,
    build_model_cache_run_context,
    consume_last_model_cache_binding,
    use_model_cache_normalization_context,
    use_model_cache_run_context,
)

from config import (
    create_chat_completion_with_sampling_controls,
    OPENAI_CLIENT,
    OPENAI_API_KEY,
    SUMMARIZER_MODEL_NAME,
    SUMMARIZER_MAX_IMAGE_ATTACHMENTS,
    SUMMARIZER_TEMPERATURE,
    SUMMARIZER_MAX_ATOMIC_INSIGHTS,
    SUMMARIZER_MIN_ATOMIC_INSIGHTS,
    SUMMARIZER_MIN_SUMMARY_SENTENCES,
    SUMMARIZER_MAX_SUMMARY_SENTENCES,
    SUMMARIZER_MAX_KEYWORDS,
    INSIGHT_TAXONOMY_TYPES,
    INSIGHT_TAXONOMY_DISPLAY_NAMES,
    INSIGHT_TAXONOMY_PROMPT_HINTS,
    LLM_MAX_TOKENS,
    LLM_TIMEOUT_SECS,
)
from .language_context import (
    contains_cjk_text,
    latest_user_authored_text,
    natural_language_target_label,
    prefers_chinese_text,
    strict_language_match_instruction,
)
from .store import RunStore
from .models import (
    PlanItem,
    ExecutionRecord,
    Insight,
    AtomicInsight,
    InsightEvidence,
    normalize_keyword_list,
)
from .importance import (
    calculate_atomic_insight_metrics,
)


def _strip_code_fences(text: str) -> str:
    if "```" not in text:
        return text.strip()
    cleaned = text.replace("```json", "").replace("```", "")
    return cleaned.strip()


def _extract_json_object(text: str) -> Optional[dict]:
    cleaned = _strip_code_fences(text)
    decoder = json.JSONDecoder()
    i = 0
    while i < len(cleaned):
        j = cleaned.find("{", i)
        if j == -1:
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


class Summarizer:
    def __init__(self) -> None:
        self._last_timestamp_binding: Any | None = None

    def consume_timestamp_binding(self) -> Any | None:
        binding = self._last_timestamp_binding
        self._last_timestamp_binding = None
        return binding
    _TERMINAL_PUNCTUATION = ".!?。！？"

    @staticmethod
    def _strip_cjk_punctuation_trailing_dots(text: str) -> str:
        if not text:
            return ""
        return re.sub(r"([。！？])\.+", r"\1", text)

    def extract_insights(
        self,
        plan: PlanItem,
        execution_records: List[ExecutionRecord],
        final_summary: str,
        store: Optional[RunStore] = None,
        dataset_schema: str = "",
        user_messages: List[Any] | None = None,
    ) -> List[AtomicInsight]:
        """
        External summarizer entrypoint for v0.1.

        Observe finished execution records from outside the agent loop and
        return only the extracted atomic insights.
        """
        if not execution_records:
            return []

        record = next(
            (item for item in reversed(execution_records) if item.success),
            execution_records[-1],
        )
        insight = self.summarize(
            plan=plan,
            record=record,
            store=store,
            dataset_schema=dataset_schema,
            user_messages=user_messages,
        )
        if insight is None:
            return []
        if final_summary and not insight.summary:
            insight.summary = final_summary
        return insight.atomic_insights

    def summarize(
        self,
        plan: PlanItem,
        record: ExecutionRecord,
        store: Optional[RunStore] = None,
        dataset_schema: str = "",
        user_messages: List[Any] | None = None,
    ) -> Optional[Insight]:
        """
        Summarize the analysis output into an Insight containing multiple atomic insights.

        Each atomic insight is:
        - A single sentence describing one finding
        - Classified by insight_type from the taxonomy
        - Associated with relevant columns
        - Linked to evidence (code, output, plot)

        Returns an Insight even for failed executions when possible.
        """
        evidence_paths: List[str] = []
        analysis_process: Optional[Dict[str, Any]] = None
        if store and record.analysis_path:
            try:
                analysis_path = store.run_dir / record.analysis_path
                analysis_process = json.loads(analysis_path.read_text(encoding="utf-8"))
            except Exception:
                analysis_process = None

        if analysis_process:
            evidence_paths = self._collect_evidence_paths(analysis_process)
        else:
            if record.code_path:
                evidence_paths.append(record.code_path)
            if record.stdout_path:
                evidence_paths.append(record.stdout_path)
            if record.stderr_path:
                evidence_paths.append(record.stderr_path)
            if record.plot_paths:
                evidence_paths.extend(record.plot_paths)
        if store:
            evidence_paths = self._filter_evidence_paths(store, evidence_paths)
        evidence_paths = self._dedupe_paths(evidence_paths)
        code_paths, output_paths, plot_paths = self._partition_evidence_paths(evidence_paths)
        bundles = self._build_evidence_bundles(
            analysis_process=analysis_process,
            record=record,
            code_paths=code_paths,
            output_paths=output_paths,
            plot_paths=plot_paths,
        )
        dataset_columns = self._extract_dataset_columns(dataset_schema)
        dataset_column_index = self._build_dataset_column_index(dataset_columns)
        latest_user_text = latest_user_authored_text(user_messages)
        prefer_chinese_output = prefers_chinese_text(latest_user_text)
        dataset_path = ""
        dataset_info: dict[str, Any] | None = None
        if store is not None:
            state = store.load_state()
            if state is not None:
                dataset_path = str(getattr(state, "dataset_path", "") or "")
                raw_info = getattr(state, "dataset_info", None)
                if isinstance(raw_info, dict):
                    dataset_info = raw_info
        run_context = build_model_cache_run_context(getattr(store, "run_dir", None))

        # If there's no evidence at all, still surface explicit errors so the user isn't confused.
        if not evidence_paths and not record.stdout_content:
            if record.error_message:
                plain = self._fallback_plain(plan, record, prefer_chinese=prefer_chinese_output)
                return Insight.create(
                    plan_id=plan.plan_id,
                    summary=plain,
                    atomic_insights=[],
                    parent_insight_id=plan.parent_insight_id,
                )
            return None

        taxonomy_list = ", ".join(INSIGHT_TAXONOMY_TYPES)
        taxonomy_def_lines: List[str] = []
        for taxonomy_id in INSIGHT_TAXONOMY_TYPES:
            display_name = INSIGHT_TAXONOMY_DISPLAY_NAMES.get(taxonomy_id, taxonomy_id)
            prompt_hint = INSIGHT_TAXONOMY_PROMPT_HINTS.get(taxonomy_id, "")
            taxonomy_def_lines.append(f"- {taxonomy_id} ({display_name}): {prompt_hint}\n")
        taxonomy_definitions = "".join(taxonomy_def_lines)
        min_atomic = 1
        if bundles:
            min_atomic = min(SUMMARIZER_MIN_ATOMIC_INSIGHTS, len(bundles))
        system_prompt = (
            "You are a Summarizer that extracts multiple atomic insights from analysis results.\n"
            "Match all natural-language text values you generate to the user's language.\n"
            + strict_language_match_instruction(latest_user_text) + "\n"
            "Keep JSON keys and schema fields in English.\n\n"
            "Output ONLY a JSON object with these keys:\n"
            f'- "atomic_insights": array of {min_atomic}-{SUMMARIZER_MAX_ATOMIC_INSIGHTS} atomic insight objects\n'
            '- "summary": 2-3 sentences summarizing all insights (no evidence markers)\n'
            '- "short_label": a 5-7 word label summarizing the key finding. Must precisely convey the topic. Combine the analysis dimension (from the task) with the conclusion. Maximize distinctiveness from sibling nodes. Example: "2002 Peak: Action & Sports Recovery"\n\n'
            f'- "keywords": array of 1-{SUMMARIZER_MAX_KEYWORDS} concise keywords or short phrases capturing the summary focus\n\n'
            "Each atomic insight object must have:\n"
            '- "text": one sentence describing the finding (may contain commas)\n'
            f'- "insight_type": one of [{taxonomy_list}]\n'
            '- "columns": array of column names involved in this insight\n'
            f'- "keywords": array of 1-{SUMMARIZER_MAX_KEYWORDS} concise keywords or short phrases capturing the atomic focus\n'
            '- "evidence": object with REQUIRED key "plot_path" and OPTIONAL keys "code_path", "output_path"\n\n'
            'Do NOT output legacy keys such as "insight", "insight_plain", or "insight_with_evidence".\n\n'
            "Insight type definitions:\n"
            + taxonomy_definitions
            + "- If a finding cannot be stably classified into the taxonomy, do not output it as an atomic insight.\n\n"
            "Rules:\n"
            "- Each atomic insight should be ONE clear finding, not multiple combined.\n"
            "- Use ONLY the provided evidence paths. Do NOT invent paths.\n"
            "- Every atomic insight must include exactly one plot_path.\n"
            "- code_path and output_path should be provided whenever available and relevant.\n"
            "- code_path must come from provided code paths; output_path from provided output paths; plot_path from provided plot paths.\n"
            "- Reuse paths only when necessary; prefer diverse path assignment across atomic insights.\n"
            "- Extract column names that are directly involved in the insight.\n"
            "- columns entries must be exact values from the provided dataset columns list.\n"
            "- keywords should be useful user-facing focus handles, not full sentences.\n"
            "- keywords may be short noun phrases; dedupe near-duplicates and keep them concrete.\n"
            "- If an insight cannot be grounded to dataset columns, do not include that atomic insight.\n"
            "- Be concrete and specific, avoid generic statements.\n"
            "- Do not open the summary with meta lead-ins such as 'The analysis reveals', "
            "'Analysis of ... reveals', 'According to your request', "
            "'根据您的要求', '分析显示', or '关于...的分析已经完成'. "
            "Start directly with the substantive conclusion.\n"
        )

        images: List[Tuple[str, bytes]] = []
        if store and analysis_process:
            allowed = set(evidence_paths)
            analysis_stream, images = self._build_analysis_stream(store, analysis_process, allowed)
        else:
            analysis_stream = self._build_minimal_stream(record)

        user_prompt = (
            f"Task: {plan.text}\n"
            + f"Target natural-language output language: {natural_language_target_label(latest_user_text)}\n"
            + "Latest user-authored message for language matching:\n"
            + f"{latest_user_text or '<none provided>'}\n"
            f"Execution success: {record.success}\n"
            + (f"Execution error: {record.error_message}\n" if record.error_message else "")
            + f"Dataset columns (only allowed values for atomic_insights[].columns):\n{dataset_columns or ['<none>']}\n"
            + f"Available code paths:\n{code_paths or ['<none>']}\n"
            + f"Available output paths:\n{output_paths or ['<none>']}\n"
            + f"Available plot paths:\n{plot_paths or ['<none>']}\n"
            + f"All available evidence paths:\n{evidence_paths}\n\n"
            + "Analysis stream (chronological):\n"
            + analysis_stream
            + "\nReturn ONLY the JSON object."
        )
        normalization_context = build_summarizer_cache_normalization_context(
            plan_id=plan.plan_id,
            dataset_path=dataset_path,
            dataset_info=dataset_info,
            artifact_paths=evidence_paths,
        )

        data: Optional[Dict[str, Any]] = None
        active_timestamp_binding = None
        try:
            with use_model_cache_run_context(run_context):
                with use_model_cache_normalization_context(normalization_context):
                    consume_last_model_cache_binding()
                    text = self._call_openai(system_prompt, user_prompt, images)
                    active_timestamp_binding = consume_last_model_cache_binding()
            data = _extract_json_object(text or "")
            if data and self._response_violates_user_language(data, prefer_chinese=prefer_chinese_output):
                retry_prompt = (
                    user_prompt
                    + "\n\nLanguage correction retry:\n"
                    + strict_language_match_instruction(latest_user_text)
                    + "\nReissue the full JSON object with all natural-language values corrected."
                )
                with use_model_cache_run_context(run_context):
                    with use_model_cache_normalization_context(normalization_context):
                        consume_last_model_cache_binding()
                        retry_text = self._call_openai(system_prompt, retry_prompt, images)
                        retry_timestamp_binding = consume_last_model_cache_binding()
                retried = _extract_json_object(retry_text or "")
                if retried:
                    data = retried
                    active_timestamp_binding = retry_timestamp_binding
        except Exception:
            data = None

        with activate_timestamp_binding(active_timestamp_binding):
            if not data:
                fallback_atomics = self._build_fallback_atomic_insights(
                    plan,
                    bundles,
                    dataset_columns,
                    dataset_column_index,
                    prefer_chinese=prefer_chinese_output,
                )
                atomic_insights = fallback_atomics
                summary = self._normalize_summary(
                    plan=plan,
                    summary_text="",
                    atomic_insights=atomic_insights,
                    fallback=self._fallback_plain(plan, record, prefer_chinese=prefer_chinese_output),
                    prefer_chinese=prefer_chinese_output,
                )
                insight = Insight.create(
                    plan_id=plan.plan_id,
                    summary=summary,
                    atomic_insights=atomic_insights,
                    keywords=[],
                    parent_insight_id=plan.parent_insight_id,
                )
                with use_model_cache_run_context(run_context):
                    for atomic in insight.atomic_insights:
                        calculate_atomic_insight_metrics(
                            atomic=atomic,
                            plan=plan,
                            store=store,
                            user_messages=user_messages,
                        )
                self._last_timestamp_binding = active_timestamp_binding
                return insight

            # Parse atomic insights
            atomic_insights: List[AtomicInsight] = []
            raw_atomics = data.get("atomic_insights", [])
            if isinstance(raw_atomics, list):
                for idx, raw in enumerate(raw_atomics[:SUMMARIZER_MAX_ATOMIC_INSIGHTS]):
                    if not isinstance(raw, dict):
                        continue
                    text = self._normalize_atomic_sentence(str(raw.get("text", "")).strip())
                    if not text or self._looks_like_heading(text):
                        continue
                    insight_type = str(raw.get("insight_type", "")).strip().lower()
                    if insight_type not in INSIGHT_TAXONOMY_TYPES:
                        insight_type = self._infer_fallback_insight_type(text or plan.text)
                    columns = self._normalize_columns(
                        raw.get("columns"),
                        plan,
                        dataset_columns,
                        dataset_column_index,
                    )
                    if not columns:
                        # Drop atomic insights that cannot be mapped to dataset columns.
                        continue
                    evidence_raw = raw.get("evidence", {})
                    if not isinstance(evidence_raw, dict):
                        evidence_raw = {}
                    bundle = bundles[idx % len(bundles)] if bundles else None
                    # Validate evidence paths
                    evidence = InsightEvidence(
                        code_path=self._resolve_required_path(
                            preferred=evidence_raw.get("code_path"),
                            pool=code_paths,
                            fallback=(bundle or {}).get("code_path"),
                            index=idx,
                        ),
                        output_path=self._resolve_required_path(
                            preferred=evidence_raw.get("output_path"),
                            pool=output_paths,
                            fallback=(bundle or {}).get("output_path"),
                            index=idx,
                        ),
                        plot_path=self._resolve_required_path(
                            preferred=evidence_raw.get("plot_path"),
                            pool=plot_paths,
                            fallback=(bundle or {}).get("plot_path"),
                            index=idx,
                        ),
                    )
                    # Data contract requires plot-linked evidence for every atomic insight.
                    if not evidence.plot_path:
                        continue
                    atomic_insights.append(AtomicInsight.create(
                        text=text,
                        insight_type=insight_type,  # type: ignore[arg-type]
                        columns=columns,
                        keywords=normalize_keyword_list(raw.get("keywords"), limit=SUMMARIZER_MAX_KEYWORDS),
                        evidence=evidence,
                    ))

            if not atomic_insights:
                fallback_atomics = self._build_fallback_atomic_insights(
                    plan,
                    bundles,
                    dataset_columns,
                    dataset_column_index,
                    prefer_chinese=prefer_chinese_output,
                )
                atomic_insights = fallback_atomics

            summary = self._normalize_summary(
                plan=plan,
                summary_text=str(data.get("summary", "")).strip(),
                atomic_insights=atomic_insights,
                fallback=self._fallback_plain(plan, record, prefer_chinese=prefer_chinese_output),
                prefer_chinese=prefer_chinese_output,
            )

            short_label_raw = data.get("short_label")
            short_label = short_label_raw.strip() if isinstance(short_label_raw, str) else ""
            summary_keywords = normalize_keyword_list(
                data.get("keywords"),
                limit=SUMMARIZER_MAX_KEYWORDS,
            )

            insight = Insight.create(
                plan_id=plan.plan_id,
                summary=summary,
                atomic_insights=atomic_insights,
                keywords=summary_keywords,
                parent_insight_id=plan.parent_insight_id,
                short_label=short_label,
            )

            with use_model_cache_run_context(run_context):
                for atomic in insight.atomic_insights:
                    calculate_atomic_insight_metrics(
                        atomic=atomic,
                        plan=plan,
                        store=store,
                        user_messages=user_messages,
                    )

            self._last_timestamp_binding = active_timestamp_binding
            return insight

    def _validate_path(self, path: Any, allowed_paths: List[str]) -> Optional[str]:
        """Validate that a path is in the allowed list."""
        if not path:
            return None
        path_str = str(path).strip()
        if path_str in allowed_paths:
            return path_str
        return None

    def _is_code_path(self, path: str) -> bool:
        lower = (path or "").lower()
        return "/code/" in lower or lower.endswith(".py")

    def _preferred_execute_code_path(self, entry: Dict[str, Any]) -> Optional[str]:
        effective = entry.get("effective_code_path")
        if isinstance(effective, str) and effective.strip():
            return effective
        visible = entry.get("code_path")
        if isinstance(visible, str) and visible.strip():
            return visible
        return None

    def _partition_evidence_paths(self, paths: List[str]) -> Tuple[List[str], List[str], List[str]]:
        code_paths: List[str] = []
        output_paths: List[str] = []
        plot_paths: List[str] = []
        for path in paths:
            p = (path or "").strip()
            if not p:
                continue
            if self._is_image_path(p):
                plot_paths.append(p)
                continue
            if self._is_code_path(p):
                code_paths.append(p)
                continue
            output_paths.append(p)
        return (
            self._dedupe_paths(code_paths),
            self._dedupe_paths(output_paths),
            self._dedupe_paths(plot_paths),
        )

    def _build_evidence_bundles(
        self,
        analysis_process: Optional[Dict[str, Any]],
        record: ExecutionRecord,
        code_paths: List[str],
        output_paths: List[str],
        plot_paths: List[str],
    ) -> List[Dict[str, Optional[str]]]:
        bundles: List[Dict[str, Optional[str]]] = []

        if analysis_process:
            tools = analysis_process.get("tools_used", [])
            if isinstance(tools, list):
                for entry in tools:
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("tool") != "execute_code":
                        continue
                    code_path = self._validate_path(self._preferred_execute_code_path(entry), code_paths)
                    stdout_path = self._validate_path(entry.get("stdout_path"), output_paths)
                    stderr_path = self._validate_path(entry.get("stderr_path"), output_paths)
                    output_path = stdout_path or stderr_path
                    raw_plots = entry.get("plot_paths") or []
                    if not isinstance(raw_plots, list):
                        raw_plots = []
                    valid_plots = [
                        p for p in (self._validate_path(path, plot_paths) for path in raw_plots) if p
                    ]
                    if not valid_plots:
                        continue
                    for plot_path in valid_plots:
                        bundles.append(
                            {
                                "code_path": code_path,
                                "output_path": output_path,
                                "plot_path": plot_path,
                            }
                        )

        if not bundles and plot_paths:
            total = len(plot_paths)
            for idx in range(total):
                bundles.append(
                    {
                        "code_path": code_paths[idx % len(code_paths)] if code_paths else None,
                        "output_path": output_paths[idx % len(output_paths)] if output_paths else None,
                        "plot_path": plot_paths[idx % len(plot_paths)],
                    }
                )

        unique: List[Dict[str, Optional[str]]] = []
        seen = set()
        for bundle in bundles:
            key = (bundle["code_path"], bundle["output_path"], bundle["plot_path"])
            if key in seen:
                continue
            seen.add(key)
            unique.append(bundle)
        return unique

    def _resolve_required_path(
        self,
        preferred: Any,
        pool: List[str],
        fallback: Optional[str],
        index: int,
    ) -> Optional[str]:
        direct = self._validate_path(preferred, pool)
        if direct:
            return direct
        fallback_checked = self._validate_path(fallback, pool)
        if fallback_checked:
            return fallback_checked
        if not pool:
            return None
        return pool[index % len(pool)]

    def _normalize_atomic_sentence(self, text: str) -> str:
        normalized = re.sub(r"\s+", " ", (text or "").strip())
        if not normalized:
            return ""
        head = self._split_sentences(normalized)
        sentence = (head[0] if head else normalized).strip()
        sentence = self._strip_cjk_punctuation_trailing_dots(sentence)
        if sentence and sentence[-1] not in self._TERMINAL_PUNCTUATION:
            sentence += "。" if contains_cjk_text(sentence) else "."
        return sentence

    def _normalize_column_token(self, raw: Any) -> str:
        col = str(raw or "").strip()
        if not col:
            return ""
        col = col.strip().strip("`").strip('"').strip("'").strip("[]")
        col = re.sub(r"\s+", " ", col).strip()
        return col

    def _column_lookup_key(self, column: str) -> str:
        return re.sub(r"\s+", " ", (column or "").strip()).lower()

    def _dedupe_columns(self, columns: List[str]) -> List[str]:
        out: List[str] = []
        seen = set()
        for raw in columns:
            col = self._normalize_column_token(raw)
            if not col:
                continue
            key = self._column_lookup_key(col)
            if key in seen:
                continue
            seen.add(key)
            out.append(col)
        return out

    def _extract_dataset_columns(self, dataset_schema: str) -> List[str]:
        if not dataset_schema:
            return []
        match = re.search(r"Columns:\s*(\[[\s\S]*?\])", dataset_schema)
        if not match:
            return []
        inside = match.group(1)

        try:
            parsed = ast.literal_eval(inside)
            if isinstance(parsed, list):
                return self._dedupe_columns([str(x) for x in parsed])
        except Exception:
            pass

        cols: List[str] = []
        for left, right in re.findall(r"'([^']*)'|\"([^\"]*)\"", inside):
            col = self._normalize_column_token(left or right)
            if col:
                cols.append(col)
        return self._dedupe_columns(cols)

    def _build_dataset_column_index(self, dataset_columns: List[str]) -> Dict[str, str]:
        index: Dict[str, str] = {}
        for raw in dataset_columns:
            col = self._normalize_column_token(raw)
            if not col:
                continue
            key = self._column_lookup_key(col)
            if key not in index:
                index[key] = col
        return index

    def _match_dataset_column(self, raw: Any, dataset_column_index: Dict[str, str]) -> Optional[str]:
        col = self._normalize_column_token(raw)
        if not col:
            return None
        key = self._column_lookup_key(col)
        mapped = dataset_column_index.get(key)
        if mapped:
            return mapped
        if "." in col:
            suffix = col.rsplit(".", 1)[-1]
            mapped = dataset_column_index.get(self._column_lookup_key(suffix))
            if mapped:
                return mapped
        return None

    def _fallback_columns_from_plan(
        self,
        plan: PlanItem,
        dataset_columns: List[str],
        dataset_column_index: Dict[str, str],
    ) -> List[str]:
        cols: List[str] = []
        seen = set()
        for raw in plan.filters or []:
            if not isinstance(raw, dict):
                continue
            mapped = self._match_dataset_column(raw.get("col"), dataset_column_index)
            if not mapped:
                continue
            key = self._column_lookup_key(mapped)
            if key in seen:
                continue
            seen.add(key)
            cols.append(mapped)

        plan_text = (plan.text or "").strip().lower()
        if plan_text:
            for col in dataset_columns:
                if not col:
                    continue
                col_l = col.lower()
                if len(col_l) < 3:
                    continue
                if not re.search(rf"(?<!\w){re.escape(col_l)}(?!\w)", plan_text):
                    continue
                key = self._column_lookup_key(col)
                if key in seen:
                    continue
                seen.add(key)
                cols.append(col)
        if cols:
            return cols[:6]
        return [col for col in dataset_columns[:2] if col]

    def _infer_fallback_insight_type(self, text: str) -> str:
        lowered = (text or "").strip().lower()
        if not lowered:
            return "value"
        if any(k in lowered for k in ("missing", "null", "duplicate", "quality", "invalid")):
            return "data_quality"
        if any(k in lowered for k in ("trend", "over time", "time series", "year", "month", "quarter")):
            return "trend"
        if any(k in lowered for k in ("distribution", "spread", "variance", "histogram")):
            return "distribution"
        if any(k in lowered for k in ("difference", "compare", "comparison", "versus", "vs", "gap")):
            return "difference"
        if any(k in lowered for k in ("top", "bottom", "rank", "ranking", "highest", "lowest")):
            return "rank"
        if any(k in lowered for k in ("outlier", "anomaly", "abnormal")):
            return "outlier"
        if any(k in lowered for k in ("correlation", "association", "relationship")):
            return "association"
        if any(k in lowered for k in ("cluster", "segment", "grouping")):
            return "cluster"
        if any(k in lowered for k in ("peak", "trough", "max", "min", "extreme")):
            return "extreme"
        if any(k in lowered for k in ("share", "ratio", "proportion", "percentage")):
            return "proportion"
        return "value"

    def _normalize_columns(
        self,
        raw_columns: Any,
        plan: PlanItem,
        dataset_columns: List[str],
        dataset_column_index: Dict[str, str],
    ) -> List[str]:
        cols: List[str] = []
        seen = set()
        if isinstance(raw_columns, list):
            for raw in raw_columns:
                mapped = self._match_dataset_column(raw, dataset_column_index)
                if not mapped:
                    continue
                key = self._column_lookup_key(mapped)
                if key in seen:
                    continue
                seen.add(key)
                cols.append(mapped)
        if cols:
            return cols[:6]
        return self._fallback_columns_from_plan(plan, dataset_columns, dataset_column_index)

    def _split_sentences(self, text: str) -> List[str]:
        normalized = re.sub(r"\s+", " ", (text or "").strip())
        if not normalized:
            return []
        normalized = re.sub(r"([。！？])(?=[^\s])", r"\1 ", normalized)
        parts = re.split(r"(?<=[.!?。！？])\s+", normalized)
        return [p.strip() for p in parts if p.strip()]

    def _is_template_summary_lead_sentence(self, sentence: str) -> bool:
        normalized = re.sub(r"\s+", " ", (sentence or "").strip())
        if not normalized:
            return False
        lowered = normalized.lower()
        english_patterns = (
            r"^according to (?:your|the) request\b",
            r"^the analysis reveals\b",
            r"^analysis of .+ reveals\b",
            r"^analysis of .+ is complete\b",
            r"^the analysis of .+ is complete\b",
            r"^the analysis has been completed\b",
            r"^analysis completed\b",
            r"^the analysis is complete\b",
        )
        if any(re.match(pattern, lowered) for pattern in english_patterns):
            return True
        chinese_patterns = (
            r"^根据(?:您|你的|用户的)?要求",
            r"^分析显示",
            r"^关于.+的分析(?:已经)?完成",
            r"^对.+的分析(?:已经)?完成",
            r"^本次分析(?:已经)?完成",
            r"^该分析(?:已经)?完成",
        )
        return any(re.match(pattern, normalized) for pattern in chinese_patterns)

    def _strip_template_summary_lead_sentence(self, text: str) -> str:
        sentences = self._split_sentences(text)
        if not sentences:
            return text.strip()
        if not self._is_template_summary_lead_sentence(sentences[0]):
            return text.strip()
        return " ".join(sentences[1:]).strip()

    def _fallback_summary_completion_sentence(self, *, prefer_chinese: bool) -> str:
        if prefer_chinese:
            return "\u5269\u4f59\u8bc1\u636e\u8f83\u4e3a\u6709\u9650\uff0c\u56e0\u6b64\u603b\u7ed3\u4fdd\u6301\u7b80\u6d01\u3002"
        return "The remaining evidence is limited, so the summary stays concise."

    @staticmethod
    def _normalize_source_task_token(text: str) -> str:
        return re.sub(r"\s+", " ", (text or "").strip()).strip(" \t\r\n\"'`[](){}:;,.!?-")

    def _strip_leading_source_task_text(self, text: str, plan: PlanItem) -> str:
        working = re.sub(r"\s+", " ", (text or "").strip())
        if not working:
            return ""
        plan_text = re.sub(r"\s+", " ", (plan.text or "").strip())
        if not plan_text:
            return working
        normalized_plan = self._normalize_source_task_token(plan_text)
        if len(normalized_plan) < 12 and len(normalized_plan.split()) < 2 and ":" not in normalized_plan:
            return working
        candidates = [
            plan_text,
            f"Task: {plan_text}",
            f"Source Task: {plan_text}",
            f"Source task: {plan_text}",
        ]
        for candidate in candidates:
            token = self._normalize_source_task_token(candidate)
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

    def _response_violates_user_language(
        self,
        data: Dict[str, Any],
        *,
        prefer_chinese: bool,
    ) -> bool:
        if not prefer_chinese:
            return False
        summary = str(data.get("summary", "") or "").strip()
        short_label = str(data.get("short_label", "") or "").strip()
        atomic_texts = [
            str(item.get("text", "") or "").strip()
            for item in data.get("atomic_insights", []) or []
            if isinstance(item, dict)
        ]
        samples = [summary, short_label, *atomic_texts[:2]]
        meaningful = [text for text in samples if text]
        if not meaningful:
            return False
        return any(not contains_cjk_text(text) for text in meaningful)

    def _normalize_summary(
        self,
        plan: PlanItem,
        summary_text: str,
        atomic_insights: List[AtomicInsight],
        fallback: str,
        *,
        prefer_chinese: bool,
    ) -> str:
        summary = self._strip_leading_source_task_text(summary_text, plan)
        summary = self._strip_template_summary_lead_sentence(summary)
        sentences = self._split_sentences(summary) if summary and not self._looks_like_heading(summary) else []

        if len(sentences) < SUMMARIZER_MIN_SUMMARY_SENTENCES:
            combined: List[str] = []
            for sentence in sentences:
                if sentence and sentence not in combined:
                    combined.append(sentence)
            atomic_sentences = [
                self._strip_leading_source_task_text(
                    self._normalize_atomic_sentence(ai.text),
                    plan,
                )
                for ai in atomic_insights
                if ai.text.strip()
            ]
            for sentence in atomic_sentences:
                if not sentence or sentence in combined:
                    continue
                combined.append(sentence)
                if len(combined) >= SUMMARIZER_MAX_SUMMARY_SENTENCES:
                    break
            fallback_sentence = self._strip_template_summary_lead_sentence(
                self._strip_leading_source_task_text(
                    self._normalize_atomic_sentence(fallback),
                    plan,
                )
            )
            if fallback_sentence and fallback_sentence not in combined:
                combined.append(fallback_sentence)
            if combined:
                sentences = combined[:SUMMARIZER_MAX_SUMMARY_SENTENCES]

        if not sentences:
            sentences = [
                "\u6682\u65e0\u53ef\u7528\u603b\u7ed3\u3002"
                if prefer_chinese else
                "Summary unavailable."
            ]

        while len(sentences) < SUMMARIZER_MIN_SUMMARY_SENTENCES:
            sentences.append(
                self._fallback_summary_completion_sentence(prefer_chinese=prefer_chinese)
            )

        return self._strip_cjk_punctuation_trailing_dots(
            " ".join(sentences[:SUMMARIZER_MAX_SUMMARY_SENTENCES])
        )

        if not sentences:
            sentences = [
                "暂无可用总结。"
                if prefer_chinese else
                "Summary unavailable."
            ]

        while len(sentences) < SUMMARIZER_MIN_SUMMARY_SENTENCES:
            sentences.append(
                "该总结基于已执行分析的输出和已验证发现整理而成。"
                if prefer_chinese else
                "The summary is synthesized from executed analysis outputs and validated findings."
            )

        return " ".join(sentences[:SUMMARIZER_MAX_SUMMARY_SENTENCES])

    def _build_fallback_atomic_insights(
        self,
        plan: PlanItem,
        bundles: List[Dict[str, Optional[str]]],
        dataset_columns: List[str],
        dataset_column_index: Dict[str, str],
        *,
        prefer_chinese: bool,
    ) -> List[AtomicInsight]:
        if not bundles:
            return []
        bundles = [b for b in bundles if b.get("plot_path")]
        if not bundles:
            return []
        target = min(max(1, SUMMARIZER_MIN_ATOMIC_INSIGHTS), len(bundles), SUMMARIZER_MAX_ATOMIC_INSIGHTS)
        cols = self._fallback_columns_from_plan(plan, dataset_columns, dataset_column_index)
        if not cols:
            return []
        if prefer_chinese:
            text = "\u4e0e\u5f53\u524d\u4efb\u52a1\u76f8\u5173\u7684\u53d1\u73b0\u3002"
        else:
            text = "Finding related to the current task."
        if False:
            base = self._normalize_atomic_sentence(plan.text) if contains_cjk_text(plan.text) else ""
            text = f"与当前任务相关的发现：{base}" if base else "与当前任务相关的发现。"
        elif False:
            base = self._normalize_atomic_sentence(plan.text) or "Finding extracted from this task."
            text = f"Finding related to the task: {base}"
        inferred_type = self._infer_fallback_insight_type(plan.text)

        out: List[AtomicInsight] = []
        for idx in range(target):
            b = bundles[idx]
            out.append(
                AtomicInsight.create(
                    text=text,
                    insight_type=inferred_type,  # type: ignore[arg-type]
                    columns=cols,
                    evidence=InsightEvidence(
                        code_path=b.get("code_path"),
                        output_path=b.get("output_path"),
                        plot_path=b.get("plot_path"),
                    ),
                )
            )
        return out

    def _call_openai(self, system_prompt: str, user_prompt: str, images: List[Tuple[str, bytes]]) -> str:
        if OPENAI_CLIENT is None:
            raise RuntimeError("OpenAI client is not configured for summarization.")
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set for summarization.")
        user_content = self._build_user_content(user_prompt, images)
        params: Dict[str, Any] = {
            "model": SUMMARIZER_MODEL_NAME,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        }
        if LLM_MAX_TOKENS:
            params["max_tokens"] = LLM_MAX_TOKENS
        if LLM_TIMEOUT_SECS:
            params["timeout"] = LLM_TIMEOUT_SECS
        resp = create_chat_completion_with_sampling_controls(
            OPENAI_CLIENT,
            params=params,
            temperature=SUMMARIZER_TEMPERATURE,
        )
        return resp.choices[0].message.content or ""

    def _is_image_path(self, path: str) -> bool:
        return bool(re.search(r"\.(png|jpe?g|gif|webp)$", path, re.IGNORECASE))

    def _filter_evidence_paths(self, store: RunStore, paths: List[str]) -> List[str]:
        filtered: List[str] = []
        for rel in paths:
            if not rel:
                continue
            try:
                abs_path = store.run_dir / rel
                if not abs_path.exists():
                    continue
                if self._is_image_path(rel):
                    if abs_path.stat().st_size > 0:
                        filtered.append(rel)
                    continue
                content = abs_path.read_text(encoding="utf-8", errors="replace")
                if content.strip():
                    filtered.append(rel)
            except Exception:
                continue
        return filtered

    def _load_text_artifact(self, store: RunStore, rel_path: Optional[str]) -> str:
        if not rel_path:
            return ""
        try:
            return (store.run_dir / rel_path).read_text(encoding="utf-8", errors="replace")
        except Exception:
            return ""

    def _build_user_content(self, text: str, images: List[Tuple[str, bytes]]) -> List[Dict[str, Any]]:
        """Build multimodal message content for OpenAI-compatible APIs."""
        parts: List[Dict[str, Any]] = [{"type": "text", "text": text}]
        count = 0
        for path, content in images:
            if count >= SUMMARIZER_MAX_IMAGE_ATTACHMENTS:
                break
            mime = "image/png"
            lower = path.lower()
            if lower.endswith(".jpg") or lower.endswith(".jpeg"):
                mime = "image/jpeg"
            elif lower.endswith(".webp"):
                mime = "image/webp"
            elif lower.endswith(".gif"):
                mime = "image/gif"
            b64 = base64.b64encode(content).decode("ascii")
            parts.append({"type": "text", "text": f"Image evidence path: {path}"})
            parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
            count += 1
        return parts

    def _build_analysis_stream(
        self, store: RunStore, analysis_process: Dict[str, Any], allowed_paths: set[str]
    ) -> Tuple[str, List[Tuple[str, bytes]]]:
        tools = analysis_process.get("tools_used", [])
        out_lines: List[str] = []
        images: List[Tuple[str, bytes]] = []

        for entry in tools:
            if not isinstance(entry, dict):
                continue
            tool = entry.get("tool")
            if tool == "reflect_on_results":
                reflection = str(entry.get("reflection", "")).strip()
                if reflection:
                    out_lines.append("\n[REFLECTION]\n" + reflection + "\n")
                continue
            if tool == "query_data_schema":
                out_lines.append("\n[TOOL] query_data_schema\n")
                continue
            if tool != "execute_code":
                continue

            success = entry.get("success")
            err = entry.get("error")
            stdout_path = entry.get("stdout_path")
            stderr_path = entry.get("stderr_path")
            code_path = self._preferred_execute_code_path(entry)
            plot_paths = entry.get("plot_paths") or []

            out_lines.append("\n[EXECUTE_CODE]\n" + f"success={success} error={err}\n")
            if code_path and code_path in allowed_paths:
                out_lines.append(f"code_path: {code_path}\n")
                code_text = self._load_text_artifact(store, code_path)
                if code_text.strip():
                    out_lines.append("code:\n" + code_text + "\n")
            if stdout_path and stdout_path in allowed_paths:
                out_lines.append(f"stdout_path: {stdout_path}\n")
                stdout_text = self._load_text_artifact(store, stdout_path)
                if stdout_text.strip():
                    out_lines.append("stdout:\n" + stdout_text + "\n")
            if stderr_path and stderr_path in allowed_paths:
                out_lines.append(f"stderr_path: {stderr_path}\n")
                stderr_text = self._load_text_artifact(store, stderr_path)
                if stderr_text.strip():
                    out_lines.append("stderr:\n" + stderr_text + "\n")
            if isinstance(plot_paths, list):
                allowed_plots = [p for p in plot_paths if p and p in allowed_paths]
            else:
                allowed_plots = []
            if allowed_plots:
                out_lines.append("plot_paths:\n" + "\n".join([f"- {p}" for p in allowed_plots]) + "\n")
                for p in allowed_plots:
                    if not p or not self._is_image_path(str(p)):
                        continue
                    try:
                        img_bytes = (store.run_dir / p).read_bytes()
                        if img_bytes:
                            images.append((str(p), img_bytes))
                    except Exception:
                        continue

        return "".join(out_lines), images

    def _build_minimal_stream(self, record: ExecutionRecord) -> str:
        out: List[str] = []
        if record.code_path:
            out.append("\n[CODE_PATH]\n" + record.code_path + "\n")
        if record.stdout_content:
            out.append("\n[STDOUT]\n" + record.stdout_content + "\n")
        if record.stderr_content:
            out.append("\n[STDERR]\n" + record.stderr_content + "\n")
        if record.plot_paths:
            out.append("\n[PLOTS]\n" + "\n".join([f"- {p}" for p in record.plot_paths]) + "\n")
        return "".join(out)

    def _fallback_plain(
        self,
        plan: PlanItem,
        record: ExecutionRecord,
        *,
        prefer_chinese: bool,
    ) -> str:
        if record.stdout_content:
            lines = [l.strip() for l in record.stdout_content.splitlines() if l.strip()]
            for line in lines:
                cleaned = self._strip_leading_source_task_text(line, plan)
                if cleaned and not self._looks_like_heading(cleaned):
                    return cleaned[:300]
        if record.success:
            if prefer_chinese:
                return (
                    "\u5206\u6790\u5df2\u5b8c\u6210\uff0c"
                    "\u5df2\u83b7\u5f97\u4e0e\u5f53\u524d\u4efb\u52a1\u76f4\u63a5\u76f8\u5173\u7684\u7ed3\u679c\u3002"
                )
            return "The findings are directly relevant to the current task."
        if prefer_chinese:
            return f"分析失败：{record.error_message or '未知错误'}"
        return f"Analysis failed: {record.error_message or 'Unknown error'}"

    def _looks_like_heading(self, text: str) -> bool:
        t = (text or "").strip()
        if not t:
            return True
        if t.startswith("===") or t.startswith("#") or t.startswith("---"):
            return True
        # Single-line ALL-CAPS "banner" outputs are usually not an insight.
        letters = [c for c in t if c.isalpha()]
        if letters and all(c.isupper() for c in letters):
            return True
        return False

    def _collect_evidence_paths(self, analysis_process: Dict[str, Any]) -> List[str]:
        evidence: List[str] = []
        tools = analysis_process.get("tools_used", [])
        for entry in tools:
            if not isinstance(entry, dict):
                continue
            if entry.get("tool") != "execute_code":
                continue
            code_path = self._preferred_execute_code_path(entry)
            stdout_path = entry.get("stdout_path")
            stderr_path = entry.get("stderr_path")
            if code_path:
                evidence.append(code_path)
            if stdout_path:
                evidence.append(stdout_path)
            if stderr_path:
                evidence.append(stderr_path)
            plot_paths = entry.get("plot_paths") or []
            if isinstance(plot_paths, list):
                evidence.extend([p for p in plot_paths if p])
        return evidence

    def _dedupe_paths(self, paths: List[str]) -> List[str]:
        seen = set()
        ordered: List[str] = []
        for path in paths:
            if path in seen:
                continue
            seen.add(path)
            ordered.append(path)
        return ordered
