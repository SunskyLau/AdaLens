from __future__ import annotations

import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import (  # noqa: E402
    STABLE_LLM_OUTPUT_SEED,
    STABLE_LLM_OUTPUT_TEMPERATURE,
    STABLE_LLM_OUTPUT_TOP_K,
    STABLE_LLM_OUTPUT_TOP_P,
    apply_chat_completion_sampling_controls,
    create_chat_completion_with_sampling_controls,
    set_stable_llm_output_enabled,
)


class _FakeCompletions:
    def __init__(
        self,
        fail_on_seed: bool = False,
        fail_on_top_p: bool = False,
        fail_on_top_k: bool = False,
    ) -> None:
        self.fail_on_seed = fail_on_seed
        self.fail_on_top_p = fail_on_top_p
        self.fail_on_top_k = fail_on_top_k
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(dict(kwargs))
        if self.fail_on_seed and "seed" in kwargs:
            raise ValueError("seed is not supported by this provider")
        if self.fail_on_top_p and "top_p" in kwargs:
            raise ValueError("top_p is not supported by this provider")
        if self.fail_on_top_k and "top_k" in kwargs:
            raise ValueError("top_k is not supported by this provider")
        return {"ok": True, "kwargs": kwargs}


class _FakeClient:
    def __init__(self, completions: _FakeCompletions) -> None:
        self.chat = type("Chat", (), {"completions": completions})()


class TestLlmSamplingControls(unittest.TestCase):
    def tearDown(self) -> None:
        set_stable_llm_output_enabled(False)

    def test_sampling_controls_leave_non_stable_requests_unchanged(self) -> None:
        set_stable_llm_output_enabled(False)

        params = apply_chat_completion_sampling_controls(
            {"model": "demo", "messages": []},
            temperature=0.3,
        )

        self.assertEqual(params["temperature"], 0.3)
        self.assertNotIn("top_p", params)
        self.assertNotIn("top_k", params)
        self.assertNotIn("seed", params)

    def test_sampling_controls_override_sampling_in_stable_mode(self) -> None:
        set_stable_llm_output_enabled(True)

        params = apply_chat_completion_sampling_controls(
            {"model": "demo", "messages": [], "temperature": 0.7},
            temperature=0.3,
        )

        self.assertEqual(params["temperature"], STABLE_LLM_OUTPUT_TEMPERATURE)
        self.assertEqual(params["top_p"], STABLE_LLM_OUTPUT_TOP_P)
        self.assertEqual(params["top_k"], STABLE_LLM_OUTPUT_TOP_K)
        self.assertEqual(params["seed"], STABLE_LLM_OUTPUT_SEED)

    def test_chat_completion_retries_without_seed_when_provider_rejects_it(self) -> None:
        set_stable_llm_output_enabled(True)
        completions = _FakeCompletions(fail_on_seed=True)
        client = _FakeClient(completions)

        result = create_chat_completion_with_sampling_controls(
            client,
            params={"model": "demo", "messages": []},
            temperature=0.2,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(len(completions.calls), 2)
        self.assertIn("seed", completions.calls[0])
        self.assertNotIn("seed", completions.calls[1])
        self.assertIn("top_p", completions.calls[1])
        self.assertIn("top_k", completions.calls[1])

    def test_chat_completion_retries_without_top_p_when_provider_rejects_it(self) -> None:
        set_stable_llm_output_enabled(True)
        completions = _FakeCompletions(fail_on_top_p=True)
        client = _FakeClient(completions)

        result = create_chat_completion_with_sampling_controls(
            client,
            params={"model": "demo", "messages": []},
            temperature=0.2,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(len(completions.calls), 2)
        self.assertIn("top_p", completions.calls[0])
        self.assertNotIn("top_p", completions.calls[1])
        self.assertIn("top_k", completions.calls[1])

    def test_chat_completion_retries_without_top_k_when_provider_rejects_it(self) -> None:
        set_stable_llm_output_enabled(True)
        completions = _FakeCompletions(fail_on_top_k=True)
        client = _FakeClient(completions)

        result = create_chat_completion_with_sampling_controls(
            client,
            params={"model": "demo", "messages": []},
            temperature=0.2,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(len(completions.calls), 2)
        self.assertIn("top_k", completions.calls[0])
        self.assertNotIn("top_k", completions.calls[1])

    def test_chat_completion_can_strip_seed_then_top_p_then_top_k_across_retries(self) -> None:
        set_stable_llm_output_enabled(True)

        class _SequentialFakeCompletions(_FakeCompletions):
            def create(self, **kwargs):
                self.calls.append(dict(kwargs))
                if "seed" in kwargs:
                    raise ValueError("seed is not supported by this provider")
                if "top_p" in kwargs:
                    raise ValueError("top_p is not supported by this provider")
                if "top_k" in kwargs:
                    raise ValueError("top_k is not supported by this provider")
                return {"ok": True, "kwargs": kwargs}

        completions = _SequentialFakeCompletions()
        client = _FakeClient(completions)

        result = create_chat_completion_with_sampling_controls(
            client,
            params={"model": "demo", "messages": []},
            temperature=0.2,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(len(completions.calls), 4)
        self.assertIn("seed", completions.calls[0])
        self.assertNotIn("seed", completions.calls[1])
        self.assertIn("top_p", completions.calls[1])
        self.assertNotIn("top_p", completions.calls[2])
        self.assertIn("top_k", completions.calls[2])
        self.assertNotIn("top_k", completions.calls[3])


if __name__ == "__main__":
    unittest.main()
