from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

# Add project root to sys.path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from framework import importance  # noqa: E402
from framework.models import AtomicInsight, InsightEvidence, PlanItem, UserMessage  # noqa: E402


class _DummyCompletions:
    def __init__(self, payload=None, raises: Optional[Exception] = None):
        self.payload = payload
        self.raises = raises
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        message = SimpleNamespace(content=self.payload)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class _DummyClient:
    def __init__(self, payload=None, raises: Optional[Exception] = None):
        self.completions = _DummyCompletions(payload=payload, raises=raises)
        self.chat = SimpleNamespace(completions=self.completions)


def _build_atomic(output_path: str | None = "artifacts/stdout/out.txt", insight_type: str = "difference"):
    return AtomicInsight.create(
        text="A focused atomic insight for metric tests.",
        insight_type=insight_type,  # type: ignore[arg-type]
        columns=["sales"],
        evidence=InsightEvidence(
            code_path="artifacts/code/code.py",
            output_path=output_path,
            plot_path="artifacts/plots/plot.png",
        ),
    )


def _build_plan() -> PlanItem:
    return PlanItem.create(text="Analyze sales behavior.")


def _build_store(tmp_path: Path, dataset_schema: str = "Shape: 100 rows, 4 columns"):
    class _Store:
        def __init__(self):
            self.run_dir = tmp_path

        def load_state(self):
            return SimpleNamespace(dataset_schema=dataset_schema, dataset_info="")

    return _Store()


def test_llm_call_exception_falls_back_to_defaults(monkeypatch, tmp_path):
    client = _DummyClient(raises=RuntimeError("boom"))
    monkeypatch.setattr(importance, "OPENAI_CLIENT", client)
    monkeypatch.setattr(importance, "OPENAI_API_KEY", "test-key")

    atomic = _build_atomic()
    store = _build_store(tmp_path, dataset_schema="Shape: 100 rows, 4 columns")

    importance.calculate_atomic_insight_metrics(atomic=atomic, plan=_build_plan(), store=store)

    assert len(client.completions.calls) == 1
    assert atomic.interest == importance.DEFAULT_INTEREST_FALLBACK_SCORE
    assert atomic.significance == importance.SIGNIFICANCE_MISSING_OUTPUT_FALLBACK_SCORE
    assert atomic.impact == importance.DEFAULT_IMPACT_FALLBACK_SCORE
    expected = importance.calculate_importance_from_components(
        atomic.interest,
        atomic.significance,
        atomic.impact,
    )
    assert abs(atomic.importance - expected) < 1e-9


def test_non_json_llm_response_falls_back_to_defaults(monkeypatch, tmp_path):
    client = _DummyClient(payload="not a json object")
    monkeypatch.setattr(importance, "OPENAI_CLIENT", client)
    monkeypatch.setattr(importance, "OPENAI_API_KEY", "test-key")

    atomic = _build_atomic()
    store = _build_store(tmp_path, dataset_schema="")

    importance.calculate_atomic_insight_metrics(atomic=atomic, plan=_build_plan(), store=store)

    assert len(client.completions.calls) == 1
    assert atomic.interest == importance.DEFAULT_INTEREST_FALLBACK_SCORE
    assert atomic.significance == importance.SIGNIFICANCE_MISSING_OUTPUT_FALLBACK_SCORE
    assert atomic.impact == importance.IMPACT_EMPTY_CONTEXT_FALLBACK_SCORE


def test_partial_json_payload_uses_defaults_for_missing_fields(monkeypatch, tmp_path):
    payload = json.dumps(
        {
            "interest": {"score": 0.91},
            "impact": {"rows_ratio": 0.5, "columns_ratio": 0.4},
        }
    )
    client = _DummyClient(payload=payload)
    monkeypatch.setattr(importance, "OPENAI_CLIENT", client)
    monkeypatch.setattr(importance, "OPENAI_API_KEY", "test-key")

    out_file = tmp_path / "artifacts/stdout/out.txt"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text("delta=0.4, p=0.03, n=120", encoding="utf-8")

    atomic = _build_atomic(output_path="artifacts/stdout/out.txt", insight_type="difference")
    store = _build_store(tmp_path, dataset_schema="Shape: 100 rows, 4 columns")

    importance.calculate_atomic_insight_metrics(atomic=atomic, plan=_build_plan(), store=store)

    assert atomic.interest == 0.91
    assert 0 <= atomic.significance <= 1
    assert atomic.impact == 0.2


def test_valid_json_keeps_importance_formula(monkeypatch, tmp_path):
    payload = json.dumps(
        {
            "interest": {"score": 0.8},
            "significance": {"score_hint": 0.7, "stats": {"p": 0.01, "delta": 0.5, "n": 150}},
            "impact": {"score": 0.25},
        }
    )
    client = _DummyClient(payload=payload)
    monkeypatch.setattr(importance, "OPENAI_CLIENT", client)
    monkeypatch.setattr(importance, "OPENAI_API_KEY", "test-key")

    out_file = tmp_path / "artifacts/stdout/out.txt"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text("delta=0.5, p=0.01, n=150", encoding="utf-8")

    atomic = _build_atomic(output_path="artifacts/stdout/out.txt", insight_type="difference")
    store = _build_store(tmp_path, dataset_schema="Shape: 100 rows, 4 columns")

    importance.calculate_atomic_insight_metrics(atomic=atomic, plan=_build_plan(), store=store)

    expected = importance.calculate_importance_from_components(
        atomic.interest,
        atomic.significance,
        atomic.impact,
    )
    assert abs(atomic.importance - expected) < 1e-9


def test_metrics_prompt_uses_latest_user_authored_message_for_language_matching(monkeypatch, tmp_path):
    payload = json.dumps(
        {
            "interest": {"score": 0.8},
            "significance": {"score_hint": 0.7, "stats": {}},
            "impact": {"score": 0.25},
        }
    )
    client = _DummyClient(payload=payload)
    monkeypatch.setattr(importance, "OPENAI_CLIENT", client)
    monkeypatch.setattr(importance, "OPENAI_API_KEY", "test-key")

    out_file = tmp_path / "artifacts/stdout/out.txt"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text("delta=0.5, p=0.01, n=150", encoding="utf-8")

    atomic = _build_atomic(output_path="artifacts/stdout/out.txt", insight_type="difference")
    store = _build_store(tmp_path, dataset_schema="Shape: 100 rows, 4 columns")
    user_messages = [
        UserMessage.create(content="Use English first.", kind="chat"),
        UserMessage.create(
            content="Legacy focus content",
            kind="focus",
            user_prompt="\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u63cf\u8ff0\u53d1\u73b0\u3002",
        ),
        UserMessage.create(content="Prefer bullets.", kind="chat"),
    ]

    importance.calculate_atomic_insight_metrics(
        atomic=atomic,
        plan=_build_plan(),
        store=store,
        user_messages=user_messages,
    )

    assert len(client.completions.calls) == 1
    prompt = client.completions.calls[0]["messages"][1]["content"][0]["text"]
    assert "Latest user-authored message for language matching" in prompt
    assert "\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u63cf\u8ff0\u53d1\u73b0\u3002" in prompt
    assert "Prefer bullets." not in prompt
