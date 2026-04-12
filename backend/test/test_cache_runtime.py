from __future__ import annotations

import asyncio
import json
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.master_agent import MasterAgent  # noqa: E402
from framework.models import RunState, UserMessage  # noqa: E402
from framework.store import RunStore  # noqa: E402
from model_cache import (  # noqa: E402
    CacheAwareClient,
    ModelCacheStore,
    activate_timestamp_binding,
    finalize_timestamp_binding,
)


TEST_TMP_ROOT = ROOT / ".codex-temp-test-cache-runtime"


def make_test_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


class _AckClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

        class _Completions:
            def __init__(self, outer: "_AckClient") -> None:
                self._outer = outer

            def create(self, **kwargs):
                self._outer.calls.append(kwargs)
                return SimpleNamespace(
                    id="resp_ack",
                    created=1712345678,
                    choices=[
                        SimpleNamespace(
                            message=SimpleNamespace(
                                content="I'll keep the next analysis centered on the revenue gap."
                            )
                        )
                    ],
                )

        self.chat = SimpleNamespace(completions=_Completions(self))


def _read_last_user_response_timestamp(store: RunStore) -> str:
    lines = store.events_path.read_text(encoding="utf-8").splitlines()
    payload = json.loads(lines[-1])
    return str(payload["timestamp"])


def test_cached_master_agent_ack_replays_user_response_event_timestamp():
    temp_dir = make_test_dir("ack_runtime")
    cache_store = ModelCacheStore(enabled=True, cache_path=temp_dir / "model_cache.json")
    raw_client = _AckClient()
    cached_client = CacheAwareClient(
        client_namespace="openai",
        client=raw_client,
        cache_store=cache_store,
    )
    timestamps: list[str] = []

    with patch("framework.master_agent.OPENAI_CLIENT", cached_client), patch(
        "framework.master_agent.OPENAI_API_KEY",
        "test-key",
    ):
        for index in range(2):
            run_store = RunStore(run_id=f"run_ack_cache_{index}", base_dir=temp_dir / "runs")
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent.state = RunState.create(
                dataset_path="data/sample.csv",
                user_goal="Analyze sample data",
            )
            message = UserMessage.create(
                content="Please compare the revenue gap after the holiday campaign.",
                kind="chat",
            )
            agent.state.user_messages.append(message)
            agent._enqueue_pending_user_response(message)

            tool_call = agent._build_next_pending_user_response_tool_call()
            assert tool_call is not None
            binding = tool_call.get("_timestamp_binding")
            with activate_timestamp_binding(binding):
                asyncio.run(agent._execute_tool_calls([tool_call]))
                run_store.save_state(agent.state)
            finalize_timestamp_binding(binding)
            timestamps.append(_read_last_user_response_timestamp(run_store))

    assert len(raw_client.calls) == 1
    assert timestamps[0] == timestamps[1]


def test_resume_runtime_continues_call_index_for_same_run():
    temp_dir = make_test_dir("resume_runtime")
    cache_path = temp_dir / "model_cache.json"
    cache_store = ModelCacheStore(enabled=True, cache_path=cache_path)
    raw_client = _AckClient()
    cached_client = CacheAwareClient(
        client_namespace="openai",
        client=raw_client,
        cache_store=cache_store,
    )
    run_id = "run_resume_cache"

    def _run_ack_once(message_text: str) -> None:
        run_store = RunStore(run_id=run_id, base_dir=temp_dir / "runs")
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze sample data",
        )
        message = UserMessage.create(content=message_text, kind="chat")
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)
        tool_call = agent._build_next_pending_user_response_tool_call()
        assert tool_call is not None
        binding = tool_call.get("_timestamp_binding")
        with activate_timestamp_binding(binding):
            asyncio.run(agent._execute_tool_calls([tool_call]))
            run_store.save_state(agent.state)
        finalize_timestamp_binding(binding)

    with patch("framework.master_agent.OPENAI_CLIENT", cached_client), patch(
        "framework.master_agent.OPENAI_API_KEY",
        "test-key",
    ):
        _run_ack_once("Please compare the revenue gap after the holiday campaign.")
        _run_ack_once("Please compare the revenue gap after the holiday campaign.")

    cache_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    entries = cache_payload.get("entries", [])
    assert len(raw_client.calls) == 2
    assert isinstance(entries[0], dict)
    assert isinstance(entries[1], dict)
