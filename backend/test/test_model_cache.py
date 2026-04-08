from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cache_normalization import (  # noqa: E402
    CacheNormalizationBindings,
    CacheNormalizationContext,
    build_master_cache_normalization_context,
    build_dataset_identity,
)
from model_cache import (  # noqa: E402
    CacheAwareClient,
    ModelCacheStore,
    RunCallIndexTracker,
    activate_timestamp_binding,
    build_model_cache_run_context,
    build_request_key,
    consume_last_model_cache_binding,
    finalize_timestamp_binding,
    normalize_cache_file_name,
    serialize_payload,
    use_model_cache_normalization_context,
    use_model_cache_run_context,
    use_uncounted_model_cache_calls,
)
from framework.context_builder import ContextBuilder  # noqa: E402
from runtime_clock import now_iso  # noqa: E402
from framework.importance import calculate_atomic_insight_metrics  # noqa: E402
from framework.models import (  # noqa: E402
    AtomicInsight,
    DispatchBatchState,
    Insight,
    InsightEvidence,
    PlanItem,
    RunState,
    RunSettings,
    TimelineEntry,
    Turn,
    UserMessage,
)


TEST_TMP_ROOT = ROOT / ".codex-temp-test-model-cache"


def make_test_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


class _DummyChatCompletions:
    def __init__(self, response: object):
        self.response = response
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _DummyEmbeddings:
    def __init__(self, response: object):
        self.response = response
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _DummyClient:
    def __init__(self, *, chat_response: object | None = None, embedding_response: object | None = None):
        if chat_response is not None:
            self.chat = SimpleNamespace(completions=_DummyChatCompletions(chat_response))
        if embedding_response is not None:
            self.embeddings = _DummyEmbeddings(embedding_response)


def _chat_response(tool_name: str = "create_plans", arguments: dict[str, object] | None = None) -> SimpleNamespace:
    tool_call = SimpleNamespace(
        id="call_1",
        type="function",
        function=SimpleNamespace(
            name=tool_name,
            arguments=json.dumps(arguments or {"plans": [{"text": "Analyze sales"}]}, ensure_ascii=False),
        ),
    )
    message = SimpleNamespace(content="", tool_calls=[tool_call])
    return SimpleNamespace(
        id="resp_1",
        created=1712345678,
        usage={"total_tokens": 42},
        choices=[SimpleNamespace(message=message)],
    )


def _embedding_response(values: list[float] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        data=[SimpleNamespace(embedding=values or [0.1, 0.2, 0.3], index=0)],
        model="text-embedding-3-large",
    )


def _summarizer_chat_response(plot_path: str) -> SimpleNamespace:
    payload = {
        "summary": "Regional sales remain concentrated in the north.",
        "atomic_insights": [
            {
                "text": "North leads total sales.",
                "insight_type": "rank",
                "columns": ["Region", "Sales"],
                "evidence": {"plot_path": plot_path},
            }
        ],
    }
    return SimpleNamespace(
        id="resp_summary",
        created=1712345678,
        usage={"total_tokens": 60},
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, ensure_ascii=False), tool_calls=[]))],
    )


def _importance_metrics_response() -> SimpleNamespace:
    payload = {
        "interest": {"score": 0.63, "notes": "Important regional finding."},
        "significance": {"score_hint": 0.58, "stats": {"n": 1000, "delta": 0.42}},
        "impact": {"score": 0.31, "notes": "Touches a meaningful subset."},
    }
    return SimpleNamespace(
        id="resp_metrics",
        created=1712345678,
        usage={"total_tokens": 44},
        choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(payload, ensure_ascii=False), tool_calls=[]))],
    )


class _FakeImportanceStore:
    def __init__(
        self,
        *,
        run_dir: Path,
        dataset_path: str,
        dataset_info: dict[str, object],
        dataset_schema: str,
    ) -> None:
        self.run_dir = run_dir
        self._state = SimpleNamespace(
            dataset_path=dataset_path,
            dataset_info=dataset_info,
            dataset_schema=dataset_schema,
        )

    def load_state(self):
        return self._state


def _run_context(run_dir: Path):
    run_dir.mkdir(parents=True, exist_ok=True)
    return build_model_cache_run_context(run_dir)


def _plan_normalization_context(*, real_plan_id: str, dataset_path: str, dataset_identity: str) -> CacheNormalizationContext:
    stable_plan_id = "cache_plan_0001"
    bindings = CacheNormalizationBindings(
        dataset_identity=dataset_identity,
        id_bindings={
            "plan": [{"stable_id": stable_plan_id, "cached_real_id": real_plan_id}],
            "insight": [],
            "atomic": [],
        },
        artifact_bindings=[],
    )
    return CacheNormalizationContext(
        dataset_identity=dataset_identity,
        request_real_to_stable={real_plan_id: stable_plan_id, dataset_path: dataset_identity},
        response_real_to_stable={real_plan_id: stable_plan_id},
        stable_to_real={stable_plan_id: real_plan_id},
        bindings=bindings,
    )


def _summarizer_normalization_context(
    *,
    real_plan_id: str,
    real_plot_path: str | None,
    dataset_identity: str,
) -> CacheNormalizationContext:
    stable_plan_id = "cache_plan_0001"
    stable_plot_path = real_plot_path.replace(real_plan_id, stable_plan_id) if real_plot_path else ""
    bindings = CacheNormalizationBindings(
        dataset_identity=dataset_identity,
        id_bindings={
            "plan": [{"stable_id": stable_plan_id, "cached_real_id": real_plan_id}],
            "insight": [],
            "atomic": [],
        },
        artifact_bindings=(
            [{"stable_alias": stable_plot_path, "cached_real_path": real_plot_path, "kind": "plot"}]
            if stable_plot_path and real_plot_path
            else []
        ),
    )
    request_real_to_stable = {real_plan_id: stable_plan_id}
    response_real_to_stable = {real_plan_id: stable_plan_id}
    stable_to_real = {stable_plan_id: real_plan_id}
    if stable_plot_path and real_plot_path:
        request_real_to_stable[real_plot_path] = stable_plot_path
        response_real_to_stable[real_plot_path] = stable_plot_path
        stable_to_real[stable_plot_path] = real_plot_path
    return CacheNormalizationContext(
        dataset_identity=dataset_identity,
        request_real_to_stable=request_real_to_stable,
        response_real_to_stable=response_real_to_stable,
        stable_to_real=stable_to_real,
        bindings=bindings,
    )


def _build_master_request_key_for_state(state: RunState) -> str:
    builder = ContextBuilder()
    raw_params = {
        "model": "demo-master",
        "messages": [
            {"role": "system", "content": builder.build_system_context(state)},
            {"role": "user", "content": builder.build_user_prompt(state)},
        ],
        "tools": [{"type": "function"}],
        "tool_choice": "required",
        "temperature": 0.3,
        "timeout": 123,
    }
    normalization_context = build_master_cache_normalization_context(state)
    normalized_params = normalization_context.normalize_request_value(serialize_payload(raw_params))
    return build_request_key(
        client_namespace="openai",
        request_kind="chat_completion",
        params=normalized_params,
    )


def _make_evaluate_progress_state(
    *,
    first_plan_first: bool,
    first_plan_ids: tuple[str, str, str] = ("plan_alpha", "insight_alpha", "atomic_alpha"),
    second_plan_ids: tuple[str, str, str] = ("plan_beta", "insight_beta", "atomic_beta"),
) -> RunState:
    state = RunState.create(
        dataset_path=r"C:\uploads\upload_demo__vgsales.csv",
        user_goal="进行一个概要分析",
        settings=RunSettings(),
    )
    state.dataset_info = {
        "dataset_path": state.dataset_path,
        "rows": 2,
        "delimiter": ",",
        "columns": [{"name": "Year"}, {"name": "Global_Sales"}],
        "sample_rows": [{"Year": "2008", "Global_Sales": "10.0"}],
    }
    state.user_messages.append(UserMessage.create(content="进行一个概要分析", kind="chat"))

    first_plan = PlanItem.create(text="分析销售分布。")
    first_plan.plan_id = first_plan_ids[0]
    first_plan.status = "completed"
    second_plan = PlanItem.create(text="分析年度趋势。")
    second_plan.plan_id = second_plan_ids[0]
    second_plan.status = "completed"
    state.plans = [first_plan, second_plan]

    first_atomic = AtomicInsight.create(
        text="销售额呈现长尾分布。",
        insight_type="distribution",
        columns=["Global_Sales"],
    )
    first_atomic.atomic_id = first_plan_ids[2]
    second_atomic = AtomicInsight.create(
        text="2008 年是销量峰值。",
        insight_type="trend",
        columns=["Year", "Global_Sales"],
    )
    second_atomic.atomic_id = second_plan_ids[2]

    first_insight = Insight.create(
        plan_id=first_plan.plan_id,
        summary="全球销售额呈现明显长尾分布。",
        atomic_insights=[first_atomic],
        keywords=["长尾分布"],
        short_label="销售分布",
    )
    first_insight.insight_id = first_plan_ids[1]
    second_insight = Insight.create(
        plan_id=second_plan.plan_id,
        summary="2008 年达到销售峰值，随后回落。",
        atomic_insights=[second_atomic],
        keywords=["年度趋势"],
        short_label="年度趋势",
    )
    second_insight.insight_id = second_plan_ids[1]

    if first_plan_first:
        state.insights = [first_insight, second_insight]
        completed_entries = [
            TimelineEntry(
                entry_type="plans_completed",
                content={
                    "plan_id": first_plan.plan_id,
                    "plan_text": first_plan.text,
                    "insight_summary": first_insight.summary,
                },
            ),
            TimelineEntry(
                entry_type="plans_completed",
                content={
                    "plan_id": second_plan.plan_id,
                    "plan_text": second_plan.text,
                    "insight_summary": second_insight.summary,
                },
            ),
        ]
    else:
        state.insights = [second_insight, first_insight]
        completed_entries = [
            TimelineEntry(
                entry_type="plans_completed",
                content={
                    "plan_id": second_plan.plan_id,
                    "plan_text": second_plan.text,
                    "insight_summary": second_insight.summary,
                },
            ),
            TimelineEntry(
                entry_type="plans_completed",
                content={
                    "plan_id": first_plan.plan_id,
                    "plan_text": first_plan.text,
                    "insight_summary": first_insight.summary,
                },
            ),
        ]

    state.turns = [
        Turn(
            turn_id=0,
            goal="进行一个概要分析",
            timeline=[
                TimelineEntry(entry_type="respond_to_user", content={"message": "开始分析。"}),
                TimelineEntry(
                    entry_type="create_plans",
                    content={"arguments": {"plans": [{"text": first_plan.text}, {"text": second_plan.text}]}},
                ),
                TimelineEntry(
                    entry_type="dispatch_plans",
                    content={
                        "arguments": {"plan_ids": [first_plan.plan_id, second_plan.plan_id]},
                        "result": {
                            "dispatch_turn_index": 0,
                            "plan_ids": [first_plan.plan_id, second_plan.plan_id],
                        },
                    },
                ),
                *completed_entries,
            ],
        )
    ]
    state.master_agent_state.dispatch_batches = [
        DispatchBatchState(
            dispatch_turn_index=0,
            plan_ids=[first_plan.plan_id, second_plan.plan_id],
            status="waiting_for_stage_summary",
        )
    ]
    return state


def test_build_request_key_ignores_timeout_and_normalizes_key_order():
    key_one = build_request_key(
        client_namespace="openai",
        request_kind="chat_completion",
        params={
            "model": "demo",
            "messages": [{"role": "user", "content": "hello"}],
            "timeout": 10,
            "response_format": {"type": "json_object"},
        },
    )
    key_two = build_request_key(
        client_namespace="openai",
        request_kind="chat_completion",
        params={
            "response_format": {"type": "json_object"},
            "messages": [{"content": "hello", "role": "user"}],
            "model": "demo",
            "timeout": 99,
        },
    )
    assert key_one == key_two


def test_normalize_cache_file_name_appends_json_and_rejects_nested_paths():
    assert normalize_cache_file_name("case-study") == "case-study.json"
    assert normalize_cache_file_name("case-study.json") == "case-study.json"
    assert normalize_cache_file_name("") is None
    try:
        normalize_cache_file_name("../escape.json")
    except ValueError as exc:
        assert "backend/.cache" in str(exc)
    else:
        raise AssertionError("Expected nested cache path to be rejected")


def test_build_dataset_identity_ignores_upload_uuid_prefix():
    dataset_info = {
        "rows": 2,
        "delimiter": ",",
        "columns": [{"name": "Region"}, {"name": "Sales"}],
        "sample_rows": [{"Region": "North", "Sales": "10"}],
    }
    identity_one = build_dataset_identity(
        r"C:\repo\backend\runs\_uploads\upload_aaaa1111-bbbb-2222-cccc-3333dddd4444__vgsales.csv",
        dataset_info,
    )
    identity_two = build_dataset_identity(
        r"C:\repo\backend\runs\_uploads\upload_eeee5555-ffff-6666-gggg-7777hhhh8888__vgsales.csv",
        dataset_info,
    )
    assert identity_one == identity_two


def test_master_request_key_for_evaluate_progress_is_stable_across_completion_order():
    first_state = _make_evaluate_progress_state(
        first_plan_first=True,
        first_plan_ids=("plan_alpha_live", "insight_alpha_live", "atomic_alpha_live"),
        second_plan_ids=("plan_beta_live", "insight_beta_live", "atomic_beta_live"),
    )
    second_state = _make_evaluate_progress_state(
        first_plan_first=False,
        first_plan_ids=("plan_alpha_other", "insight_alpha_other", "atomic_alpha_other"),
        second_plan_ids=("plan_beta_other", "insight_beta_other", "atomic_beta_other"),
    )

    first_key = _build_master_request_key_for_state(first_state)
    second_key = _build_master_request_key_for_state(second_state)

    assert first_key == second_key


def test_model_cache_first_write_wins_and_attaches_timestamp_tape():
    temp_dir = make_test_dir("first_write")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    cache_store.write_entry_if_absent(
        call_index=1,
        request_key="req-1",
        request_kind="chat_completion",
        response_payload={"id": "first"},
        timestamp_tape=[],
    )
    cache_store.write_entry_if_absent(
        call_index=1,
        request_key="req-2",
        request_kind="chat_completion",
        response_payload={"id": "second"},
        timestamp_tape=["ignored"],
    )
    cache_store.attach_timestamp_tape(
        call_index=1,
        request_key="req-1",
        request_kind="chat_completion",
        timestamp_tape=["2026-03-26T12:00:00"],
    )
    cached = cache_store.lookup_by_call_index(
        call_index=1,
        request_key="req-1",
        request_kind="chat_completion",
    )
    assert cached is not None
    assert cached["response_payload"]["id"] == "first"
    assert cached["timestamp_tape"] == ["2026-03-26T12:00:00"]


def test_model_cache_can_read_from_one_file_and_write_to_another():
    temp_dir = make_test_dir("separate_read_write")
    read_path = temp_dir / "seed.json"
    write_path = temp_dir / "recorded.json"
    read_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "entries": [
                    {
                        "call_index": 1,
                        "request_key": "req-read",
                        "request_kind": "chat_completion",
                        "response_payload": {"id": "from-read"},
                        "timestamp_tape": ["2026-03-27T00:00:00"],
                    }
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    cache_store = ModelCacheStore(enabled=True, read_path=read_path, write_path=write_path)
    cached = cache_store.lookup_by_call_index(
        call_index=1,
        request_key="req-read",
        request_kind="chat_completion",
    )
    assert cached is not None
    assert cached["response_payload"]["id"] == "from-read"
    cache_store.write_entry_if_absent(
        call_index=2,
        request_key="req-write",
        request_kind="chat_completion",
        response_payload={"id": "from-write"},
        timestamp_tape=[],
    )
    write_data = json.loads(write_path.read_text(encoding="utf-8"))
    assert write_data["entries"][1]["request_key"] == "req-write"
    read_data = json.loads(read_path.read_text(encoding="utf-8"))
    assert read_data["entries"][0]["request_key"] == "req-read"


def test_cached_chat_completion_rebuilds_sdk_shape_and_replays_timestamps():
    raw_client = _DummyClient(chat_response=_chat_response())
    temp_dir = make_test_dir("chat_shape")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)

    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_first")):
        first = client.chat.completions.create(
            model="demo",
            messages=[{"role": "user", "content": "hello"}],
            tools=[{"type": "function"}],
        )
        first_binding = consume_last_model_cache_binding()
        with activate_timestamp_binding(first_binding):
            first_timestamps = [now_iso(), now_iso()]
        finalize_timestamp_binding(first_binding)

    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_second")):
        second = client.chat.completions.create(
            model="demo",
            messages=[{"role": "user", "content": "hello"}],
            tools=[{"type": "function"}],
        )
        second_binding = consume_last_model_cache_binding()
        with activate_timestamp_binding(second_binding):
            second_timestamps = [now_iso(), now_iso()]
        finalize_timestamp_binding(second_binding)

    assert len(raw_client.chat.completions.calls) == 1
    assert first.choices[0].message.tool_calls[0].function.name == "create_plans"
    assert second.choices[0].message.tool_calls[0].function.name == "create_plans"
    assert first_timestamps == second_timestamps


def test_cached_embedding_response_rebuilds_sdk_shape():
    raw_client = _DummyClient(embedding_response=_embedding_response())
    temp_dir = make_test_dir("embedding_shape")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(
        client_namespace="embedding_openai",
        client=raw_client,
        cache_store=cache_store,
    )
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_first")):
        first = client.embeddings.create(model="embed", input=["hello"])
        consume_last_model_cache_binding()
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_second")):
        second = client.embeddings.create(model="embed", input=["hello"])
        consume_last_model_cache_binding()
    assert len(raw_client.embeddings.calls) == 1
    assert list(first.data[0].embedding) == [0.1, 0.2, 0.3]
    assert list(second.data[0].embedding) == [0.1, 0.2, 0.3]


def test_slot_key_mismatch_falls_back_and_next_call_advances():
    temp_dir = make_test_dir("slot_mismatch")
    read_path = temp_dir / "seed.json"
    first_key = build_request_key(
        client_namespace="openai",
        request_kind="chat_completion",
        params={"model": "demo", "messages": [{"role": "user", "content": "first"}]},
    )
    second_key = build_request_key(
        client_namespace="openai",
        request_kind="chat_completion",
        params={"model": "demo", "messages": [{"role": "user", "content": "second"}]},
    )
    read_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "entries": [
                    {
                        "call_index": 1,
                        "request_key": "some-other-key",
                        "request_kind": "chat_completion",
                        "response_payload": serialize_payload(_chat_response()),
                        "timestamp_tape": [],
                    },
                    {
                        "call_index": 2,
                        "request_key": second_key,
                        "request_kind": "chat_completion",
                        "response_payload": serialize_payload(_chat_response("dispatch_plans", {"plan_ids": ["plan_2"]})),
                        "timestamp_tape": [],
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    raw_client = _DummyClient(chat_response=_chat_response("dispatch_plans", {"plan_ids": ["live_plan"]}))
    cache_store = ModelCacheStore(enabled=True, read_path=read_path)
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_slot_mismatch")):
        first = client.chat.completions.create(
            model="demo",
            messages=[{"role": "user", "content": "first"}],
        )
        consume_last_model_cache_binding()
        second = client.chat.completions.create(
            model="demo",
            messages=[{"role": "user", "content": "second"}],
        )
        consume_last_model_cache_binding()
    assert len(raw_client.chat.completions.calls) == 1
    assert json.loads(first.choices[0].message.tool_calls[0].function.arguments) == {"plan_ids": ["live_plan"]}
    assert json.loads(second.choices[0].message.tool_calls[0].function.arguments) == {"plan_ids": ["plan_2"]}


def test_resume_tracker_continues_call_index_from_sidecar():
    temp_dir = make_test_dir("resume_sidecar")
    run_dir = temp_dir / "runs" / "run_resume"
    tracker = RunCallIndexTracker(run_dir)
    assert tracker.allocate_call_index() == 1
    restarted_tracker = RunCallIndexTracker(run_dir)
    assert restarted_tracker.allocate_call_index() == 2


def test_uncounted_calls_do_not_consume_formal_call_index():
    temp_dir = make_test_dir("uncounted_preflight")
    read_path = temp_dir / "seed.json"
    request_key = build_request_key(
        client_namespace="embedding_openai",
        request_kind="embedding",
        params={"model": "embed", "input": ["hello"]},
    )
    read_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "entries": [
                    {
                        "call_index": 1,
                        "request_key": request_key,
                        "request_kind": "embedding",
                        "response_payload": serialize_payload(_embedding_response([0.9, 0.8, 0.7])),
                        "timestamp_tape": [],
                    }
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    raw_client = _DummyClient(embedding_response=_embedding_response([1.0, 1.0, 1.0]))
    cache_store = ModelCacheStore(enabled=True, read_path=read_path)
    client = CacheAwareClient(client_namespace="embedding_openai", client=raw_client, cache_store=cache_store)
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_preflight")):
        with use_uncounted_model_cache_calls():
            preflight = client.embeddings.create(model="embed", input=["embedding_preflight"])
            assert list(preflight.data[0].embedding) == [1.0, 1.0, 1.0]
            assert consume_last_model_cache_binding() is None
        counted = client.embeddings.create(model="embed", input=["hello"])
        consume_last_model_cache_binding()
    assert len(raw_client.embeddings.calls) == 1
    assert list(counted.data[0].embedding) == [0.9, 0.8, 0.7]


def test_cached_chat_rehydrates_stable_plan_ids_for_current_run():
    raw_client = _DummyClient(chat_response=_chat_response("dispatch_plans", {"plan_ids": ["plan_alpha"]}))
    temp_dir = make_test_dir("rehydrate_plan_ids")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)
    dataset_identity = "ds_demo__vgsales.csv"
    first_context = _plan_normalization_context(
        real_plan_id="plan_alpha",
        dataset_path=r"C:\uploads\upload_first__vgsales.csv",
        dataset_identity=dataset_identity,
    )
    second_context = _plan_normalization_context(
        real_plan_id="plan_beta",
        dataset_path=r"C:\uploads\upload_second__vgsales.csv",
        dataset_identity=dataset_identity,
    )
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_first")):
        with use_model_cache_normalization_context(first_context):
            first = client.chat.completions.create(
                model="demo",
                messages=[{"role": "user", "content": "Dataset path: C:\\uploads\\upload_first__vgsales.csv\nDispatch plan_alpha now."}],
            )
        consume_last_model_cache_binding()
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_second")):
        with use_model_cache_normalization_context(second_context):
            second = client.chat.completions.create(
                model="demo",
                messages=[{"role": "user", "content": "Dataset path: C:\\uploads\\upload_second__vgsales.csv\nDispatch plan_beta now."}],
            )
        consume_last_model_cache_binding()
    assert len(raw_client.chat.completions.calls) == 1
    assert json.loads(first.choices[0].message.tool_calls[0].function.arguments) == {"plan_ids": ["plan_alpha"]}
    assert json.loads(second.choices[0].message.tool_calls[0].function.arguments) == {"plan_ids": ["plan_beta"]}


def test_cached_chat_rehydrates_stable_artifact_aliases_for_current_run():
    raw_client = _DummyClient(chat_response=_summarizer_chat_response("artifacts/plots/plan_alpha_sales.png"))
    temp_dir = make_test_dir("rehydrate_artifact_aliases")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)
    first_context = _summarizer_normalization_context(
        real_plan_id="plan_alpha",
        real_plot_path="artifacts/plots/plan_alpha_sales.png",
        dataset_identity="ds_demo__vgsales.csv",
    )
    second_context = _summarizer_normalization_context(
        real_plan_id="plan_beta",
        real_plot_path="artifacts/plots/plan_beta_sales.png",
        dataset_identity="ds_demo__vgsales.csv",
    )
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_first")):
        with use_model_cache_normalization_context(first_context):
            client.chat.completions.create(model="demo", messages=[{"role": "user", "content": "Summarize this run."}])
        consume_last_model_cache_binding()
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_second")):
        with use_model_cache_normalization_context(second_context):
            second = client.chat.completions.create(model="demo", messages=[{"role": "user", "content": "Summarize this run."}])
        consume_last_model_cache_binding()
    content = json.loads(second.choices[0].message.content)
    assert len(raw_client.chat.completions.calls) == 1
    assert content["atomic_insights"][0]["evidence"]["plot_path"] == "artifacts/plots/plan_beta_sales.png"


def test_cached_chat_misses_when_artifact_alias_cannot_be_rehydrated_for_current_run():
    raw_client = _DummyClient(chat_response=_summarizer_chat_response("artifacts/plots/plan_alpha_sales.png"))
    temp_dir = make_test_dir("artifact_alias_miss")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)
    first_context = _summarizer_normalization_context(
        real_plan_id="plan_alpha",
        real_plot_path="artifacts/plots/plan_alpha_sales.png",
        dataset_identity="ds_demo__vgsales.csv",
    )
    missing_alias_context = _summarizer_normalization_context(
        real_plan_id="plan_beta",
        real_plot_path=None,
        dataset_identity="ds_demo__vgsales.csv",
    )
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_first")):
        with use_model_cache_normalization_context(first_context):
            client.chat.completions.create(model="demo", messages=[{"role": "user", "content": "Summarize this run."}])
        consume_last_model_cache_binding()
    with use_model_cache_run_context(_run_context(temp_dir / "runs" / "run_second")):
        with use_model_cache_normalization_context(missing_alias_context):
            client.chat.completions.create(model="demo", messages=[{"role": "user", "content": "Summarize this run."}])
        consume_last_model_cache_binding()
    assert len(raw_client.chat.completions.calls) == 2


def test_importance_metrics_cache_normalizes_artifact_paths_across_runs():
    raw_client = _DummyClient(chat_response=_importance_metrics_response())
    temp_dir = make_test_dir("importance_metrics_paths")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    client = CacheAwareClient(client_namespace="openai", client=raw_client, cache_store=cache_store)
    dataset_info = {
        "rows": 2,
        "delimiter": ",",
        "columns": [{"name": "Region"}, {"name": "Sales"}],
        "sample_rows": [{"Region": "North", "Sales": "10"}],
    }
    dataset_schema = "Shape: 2 rows, 2 columns\nColumns: Region, Sales"

    def build_case(plan_id: str, upload_name: str) -> tuple[AtomicInsight, PlanItem, _FakeImportanceStore]:
        run_dir = temp_dir / "runs" / f"run_{plan_id}"
        (run_dir / "artifacts" / "code").mkdir(parents=True, exist_ok=True)
        (run_dir / "artifacts" / "stdout").mkdir(parents=True, exist_ok=True)
        code_path = f"artifacts/code/{plan_id}_effective.py"
        output_path = f"artifacts/stdout/{plan_id}_attempt1.txt"
        (run_dir / code_path).write_text(
            "df.groupby('Region')['Sales'].sum()",
            encoding="utf-8",
        )
        (run_dir / output_path).write_text(
            "North total sales = 120\nSouth total sales = 80",
            encoding="utf-8",
        )
        atomic = AtomicInsight.create(
            text="North leads total sales.",
            insight_type="rank",
            columns=["Region", "Sales"],
            evidence=InsightEvidence(
                code_path=code_path,
                output_path=output_path,
                plot_path=f"artifacts/plots/{plan_id}_sales.png",
            ),
        )
        plan = PlanItem.create(text="Analyze regional sales totals.")
        plan.plan_id = plan_id
        store = _FakeImportanceStore(
            run_dir=run_dir,
            dataset_path=rf"C:\uploads\{upload_name}",
            dataset_info=dataset_info,
            dataset_schema=dataset_schema,
        )
        return atomic, plan, store

    atomic_first, plan_first, store_first = build_case(
        "plan_alpha",
        "upload_first__vgsales.csv",
    )
    atomic_second, plan_second, store_second = build_case(
        "plan_beta",
        "upload_second__vgsales.csv",
    )

    with patch("framework.importance.OPENAI_CLIENT", client), patch(
        "framework.importance.OPENAI_API_KEY",
        "test-key",
    ):
        calculate_atomic_insight_metrics(atomic_first, plan_first, store_first)
        calculate_atomic_insight_metrics(atomic_second, plan_second, store_second)

    assert len(raw_client.chat.completions.calls) == 1
    assert atomic_first.interest == atomic_second.interest == 0.63
    assert atomic_first.impact == atomic_second.impact == 0.31
