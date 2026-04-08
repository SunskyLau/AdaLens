from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cache_normalization import build_dataset_identity  # noqa: E402
from framework.analyzer import Analyzer, AnalyzerRunResult  # noqa: E402
from framework.models import ExecutionRecord, PlanItem, RunState, UserMessage  # noqa: E402
from framework.store import RunStore  # noqa: E402
from framework.summarizer import Summarizer  # noqa: E402


TEST_TMP_ROOT = ROOT / ".codex-temp-test-analyzer"


def make_test_base_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


def _assistant_tool_call(call_id: str, name: str, arguments: dict[str, object]) -> SimpleNamespace:
    return SimpleNamespace(
        content="",
        tool_calls=[
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
            }
        ],
    )


def _assistant_tool_calls(*calls: tuple[str, str, dict[str, object]]) -> SimpleNamespace:
    return SimpleNamespace(
        content="",
        tool_calls=[
            {
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
            }
            for call_id, name, arguments in calls
        ],
    )


class FakeCompletions:
    def __init__(self, responses: list[SimpleNamespace]):
        self._responses = list(responses)
        self.calls = 0
        self.requests: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        if self.calls >= len(self._responses):
            raise AssertionError("FakeCompletions received more calls than expected.")
        response = self._responses[self.calls]
        self.calls += 1
        return SimpleNamespace(choices=[SimpleNamespace(message=response)])


class FakeClient:
    def __init__(self, responses: list[SimpleNamespace]):
        self.chat = SimpleNamespace(completions=FakeCompletions(responses))


class SlowFakeCompletions(FakeCompletions):
    def __init__(self, responses: list[SimpleNamespace], delay_seconds: float):
        super().__init__(responses)
        self.delay_seconds = delay_seconds

    def create(self, **kwargs):
        time.sleep(self.delay_seconds)
        return super().create(**kwargs)


class SlowFakeClient:
    def __init__(self, responses: list[SimpleNamespace], delay_seconds: float):
        self.chat = SimpleNamespace(
            completions=SlowFakeCompletions(responses, delay_seconds)
        )


class PauseAfterCreateCalls:
    def __init__(self, completions: FakeCompletions, threshold: int):
        self.completions = completions
        self.threshold = threshold

    def __call__(self) -> dict[str, str]:
        if self.completions.calls >= self.threshold:
            return {"control_state": "pause_requested"}
        return {"control_state": "none"}


class TestAnalyzerReplayExecution(unittest.TestCase):
    def _install_matplotlib_stub(self, store: RunStore) -> None:
        pkg_dir = store.run_dir / "matplotlib"
        pkg_dir.mkdir(parents=True, exist_ok=True)
        (pkg_dir / "__init__.py").write_text(
            "\n".join(
                [
                    "from . import pyplot",
                    "",
                    "def use(_backend):",
                    "    return None",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        (pkg_dir / "figure.py").write_text(
            "\n".join(
                [
                    "from pathlib import Path",
                    "",
                    "class _Bounds:",
                    "    def __init__(self, bounds=(0.0, 0.0, 1.0, 1.0)):",
                    "        self.bounds = tuple(bounds)",
                    "",
                    "class _Axis:",
                    "    def __init__(self, bounds=(0.0, 0.0, 1.0, 1.0), has_data=False):",
                    "        self._has_data = has_data",
                    "        self._bounds = _Bounds(bounds)",
                    "",
                    "    def has_data(self):",
                    "        return self._has_data",
                    "",
                    "    def get_position(self):",
                    "        return self._bounds",
                    "",
                    "class Figure:",
                    "    def __init__(self, number):",
                    "        self.number = number",
                    "        self.axes = []",
                    "",
                    "    def _ensure_axis(self):",
                    "        if not self.axes:",
                    "            self.axes.append(_Axis(has_data=False))",
                    "        return self.axes[0]",
                    "",
                    "    def add_axis(self, bounds=(0.0, 0.0, 1.0, 1.0), has_data=True):",
                    "        axis = _Axis(bounds=bounds, has_data=has_data)",
                    "        self.axes.append(axis)",
                    "        return axis",
                    "",
                    "    def savefig(self, fname, *args, **kwargs):",
                    "        _ = args",
                    "        _ = kwargs",
                    "        target = Path(fname)",
                    "        target.parent.mkdir(parents=True, exist_ok=True)",
                    "        target.write_bytes(b'fake-png')",
                    "        return str(target)",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        (pkg_dir / "pyplot.py").write_text(
            "\n".join(
                [
                    "from .figure import Figure",
                    "",
                    "_figures = {}",
                    "_current = None",
                    "",
                    "def figure(num=None):",
                    "    global _current",
                    "    if num is None:",
                    "        num = max(_figures.keys(), default=0) + 1",
                    "    if num not in _figures:",
                    "        _figures[num] = Figure(num)",
                    "    _current = _figures[num]",
                    "    return _current",
                    "",
                    "def gcf():",
                    "    if _current is None:",
                    "        return figure()",
                    "    return _current",
                    "",
                    "def get_fignums():",
                    "    return sorted(_figures.keys())",
                    "",
                    "def plot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return []",
                    "",
                    "def bar(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return []",
                    "",
                    "def savefig(fname, *args, **kwargs):",
                    "    return gcf().savefig(fname, *args, **kwargs)",
                    "",
                    "def close(target=None):",
                    "    global _current",
                    "    if target == 'all':",
                    "        _figures.clear()",
                    "        _current = None",
                    "        return None",
                    "    if target is None:",
                    "        if _current is not None:",
                    "            _figures.pop(_current.number, None)",
                    "            _current = None",
                    "        return None",
                    "    number = getattr(target, 'number', target)",
                    "    _figures.pop(number, None)",
                    "    if _current is not None and getattr(_current, 'number', None) == number:",
                    "        _current = None",
                    "    return None",
                    "",
                    "def subplots(nrows=1, ncols=1, *args, **kwargs):",
                    "    _ = nrows",
                    "    _ = ncols",
                    "    _ = args",
                    "    _ = kwargs",
                    "    fig = figure()",
                    "    axis = fig._ensure_axis()",
                    "    return fig, axis",
                    "",
                    "def subplot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    return gcf()._ensure_axis()",
                    "",
                    "def tight_layout(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    return None",
                    "",
                    "def show(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    return None",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

    def _create_store_and_state(self, temp_dir: str, *, run_id: str) -> tuple[RunStore, RunState]:
        store = RunStore(run_id=run_id, base_dir=temp_dir)
        store.initialize()
        self._install_matplotlib_stub(store)
        dataset_path = Path(temp_dir) / f"{run_id}.csv"
        dataset_path.write_text("value;other\n1;10\n2;20\n", encoding="utf-8")
        state = RunState.create(dataset_path=str(dataset_path), user_goal="Analyze the dataset")
        state.dataset_info = {
            "dataset_path": str(dataset_path),
            "delimiter": ";",
        }
        state.dataset_schema = "Columns: ['value', 'other']"
        return store, state

    def test_analyzer_prompt_explicitly_references_latest_user_language_context(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_language_prompt")
            state.user_messages = [
                UserMessage.create(
                    content="Focus on value.",
                    kind="focus",
                    user_prompt="请继续用中文解释这个分析计划。",
                )
            ]
            plan = PlanItem.create(text="Analyze correlation between value and other")
            client = FakeClient(
                [
                    _assistant_tool_call(
                        "call_1",
                        "reflect_on_results",
                        {"reflection": "先说明下一步。"},
                    )
                ]
            )
            analyzer = Analyzer(max_turns=1)

            with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", client), patch(
                "framework.analyzer.ANALYZER_OPENAI_API_KEY", "analyzer-key"
            ):
                analyzer.analyze(plan, state, store)

            first_request = client.chat.completions.requests[0]
            messages = first_request["messages"]
            self.assertIn("请继续用中文解释这个分析计划。", messages[0]["content"])
            self.assertIn("Target natural-language output language: Chinese", messages[1]["content"])
            self.assertIn("Latest user-authored message for language matching", messages[1]["content"])
            self.assertIn(
                f"Dataset identity: {build_dataset_identity(state.dataset_path, state.dataset_info)}",
                messages[1]["content"],
            )
            self.assertNotIn(state.dataset_path, messages[1]["content"])

    def test_reflection_must_match_latest_user_language_when_user_is_chinese(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_language_violation")
            state.user_messages = [
                UserMessage.create(
                    content="Focus on value.",
                    kind="focus",
                    user_prompt="请继续用中文总结分析过程。",
                )
            ]
            plan = PlanItem.create(text="Analyze correlation between value and other")
            client = FakeClient(
                [
                    _assistant_tool_call(
                        "call_1",
                        "reflect_on_results",
                        {"reflection": "I will inspect the relationship first."},
                    )
                ]
            )
            analyzer = Analyzer(max_turns=1)

            with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", client), patch(
                "framework.analyzer.ANALYZER_OPENAI_API_KEY", "analyzer-key"
            ):
                result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertFalse(result.record.success)
            self.assertIn("Please rewrite the reflection in Chinese", result.record.error_message or "")

    def _install_seaborn_heatmap_stub(self, store: RunStore) -> None:
        (store.run_dir / "seaborn.py").write_text(
            "\n".join(
                [
                    "from matplotlib import pyplot as plt",
                    "",
                    "def heatmap(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    fig = plt.gcf()",
                    "    fig.axes = []",
                    "    main = fig.add_axis(bounds=(0.10, 0.10, 0.70, 0.80), has_data=True)",
                    "    fig.add_axis(bounds=(0.84, 0.10, 0.04, 0.80), has_data=True)",
                    "    return main",
                    "",
                    "def boxplot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = plt.gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return axis",
                    "",
                    "def barplot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = plt.gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return axis",
                    "",
                    "def scatterplot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = plt.gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return axis",
                    "",
                    "def countplot(*args, **kwargs):",
                    "    _ = args",
                    "    _ = kwargs",
                    "    axis = plt.gcf()._ensure_axis()",
                    "    axis._has_data = True",
                    "    return axis",
                ]
            )
            + "\n",
            encoding="utf-8",
        )

    def _load_json(self, store: RunStore, rel_path: str) -> dict[str, object]:
        return json.loads((store.run_dir / rel_path).read_text(encoding="utf-8"))

    def _load_text(self, store: RunStore, rel_path: str) -> str:
        return (store.run_dir / rel_path).read_text(encoding="utf-8")

    def _tool_payloads(self, store: RunStore, checkpoint_path: str) -> list[dict[str, object]]:
        checkpoint = self._load_json(store, checkpoint_path)
        payloads: list[dict[str, object]] = []
        for message in checkpoint.get("messages", []):
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            content = message.get("content")
            if not isinstance(content, str):
                continue
            payload = json.loads(content)
            if isinstance(payload, dict):
                payloads.append(payload)
        return payloads

    def _execute_entries(self, analysis_process: dict[str, object]) -> list[dict[str, object]]:
        tools = analysis_process.get("tools_used", [])
        if not isinstance(tools, list):
            return []
        return [
            entry
            for entry in tools
            if isinstance(entry, dict) and entry.get("tool") == "execute_code"
        ]

    def test_replay_restores_state_without_repeating_stdout_or_plots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_replay_success")
            plan = PlanItem.create(text="Reuse a value across execute_code calls")
            first_code = "\n".join(
                [
                    "x = 3",
                    "print('seed output')",
                    "plt.figure()",
                    "plt.plot([1, 2], [3, 4])",
                ]
            )
            second_code = "print(x + 4)"
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先建立变量，再验证能否复用。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": first_code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "变量和图都准备好了，接着直接引用变量。"}),
                    _assistant_tool_call("call_4", "execute_code", {"code": second_code}),
                    _assistant_tool_call("call_5", "reflect_on_results", {"reflection": "回放恢复了变量，结果只输出了当前轮内容。"}),
                    _assistant_tool_call("call_6", "complete_analysis", {"note": "enough evidence"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=6, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 2
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.record)
            record = result.record
            assert record is not None
            self.assertTrue(record.success)
            self.assertEqual(record.stdout_content.strip(), "7")
            self.assertEqual(record.plot_paths, [])

            analysis_process = self._load_json(store, record.analysis_path or "")
            execute_entries = self._execute_entries(analysis_process)
            self.assertEqual(len(execute_entries), 2)
            self.assertTrue(execute_entries[0]["plot_paths"])
            self.assertEqual(execute_entries[1]["plot_paths"], [])

            second_entry = execute_entries[1]
            visible_code = self._load_text(store, str(second_entry["code_path"]))
            effective_code = self._load_text(store, str(second_entry["effective_code_path"]))
            self.assertEqual(visible_code.strip(), second_code)
            self.assertIn("x = 3", effective_code)
            self.assertIn(second_code, effective_code)
            self.assertNotIn("_run_replay_snippet", effective_code)

    def test_failed_snippets_do_not_enter_replay_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_replay_failure_filter")
            plan = PlanItem.create(text="Ensure failed code is not replayed later")
            first_code = "\n".join(
                [
                    "x = 1",
                    "print('seed output')",
                    "plt.figure()",
                    "plt.plot([1, 2], [3, 4])",
                ]
            )
            failing_code = "\n".join(
                [
                    "print('bad replay candidate')",
                    "missing_name",
                ]
            )
            third_code = "print(x)"
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先建立基础状态。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": first_code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "接着故意触发一个失败步骤。"}),
                    _assistant_tool_call("call_4", "execute_code", {"code": failing_code}),
                    _assistant_tool_call("call_5", "reflect_on_results", {"reflection": "失败片段不该进入回放历史，现在只复用成功状态。"}),
                    _assistant_tool_call("call_6", "execute_code", {"code": third_code}),
                    _assistant_tool_call("call_7", "reflect_on_results", {"reflection": "最后一轮只应输出当前值。"}),
                    _assistant_tool_call("call_8", "complete_analysis", {"note": "enough evidence"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=8, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 2
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.record)
            record = result.record
            assert record is not None
            self.assertTrue(record.success)
            self.assertEqual(record.stdout_content.strip(), "1")

            checkpoint = self._load_json(store, result.checkpoint_path or "")
            replay_history = checkpoint.get("replay_history", [])
            self.assertIsInstance(replay_history, list)
            self.assertNotIn(failing_code, replay_history)

            analysis_process = self._load_json(store, record.analysis_path or "")
            execute_entries = self._execute_entries(analysis_process)
            self.assertEqual(len(execute_entries), 3)
            third_effective_code = self._load_text(store, str(execute_entries[2]["effective_code_path"]))
            self.assertIn("x = 1", third_effective_code)
            self.assertIn(third_code, third_effective_code)
            self.assertNotIn("bad replay candidate", third_effective_code)

    def test_replay_history_persists_across_checkpoint_resume(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_replay_resume")
            plan = PlanItem.create(text="Resume analyzer with replay history intact")
            first_code = "\n".join(
                [
                    "x = 5",
                    "print('seed output')",
                    "plt.figure()",
                    "plt.plot([1, 2], [4, 8])",
                ]
            )
            second_code = "print(x)"

            pause_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先完成第一轮成功执行。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": first_code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "第一轮完成后暂停。"}),
                ]
            )
            pause_control = PauseAfterCreateCalls(pause_client.chat.completions, threshold=3)
            analyzer = Analyzer(timeout=20, max_turns=8, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", pause_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 2
                ):
                    paused = analyzer.analyze(
                        plan,
                        state,
                        store,
                        control_callback=pause_control,
                    )

            self.assertIsInstance(paused, AnalyzerRunResult)
            self.assertEqual(paused.control_action, "pause")
            self.assertIsNone(paused.record)
            self.assertIsNotNone(paused.checkpoint_path)

            resume_client = FakeClient(
                [
                    _assistant_tool_call("call_4", "reflect_on_results", {"reflection": "恢复后先继续说明下一步，再执行代码。"}),
                    _assistant_tool_call("call_5", "execute_code", {"code": second_code}),
                    _assistant_tool_call("call_6", "reflect_on_results", {"reflection": "恢复后变量仍然可用。"}),
                    _assistant_tool_call("call_7", "complete_analysis", {"note": "enough evidence"}),
                ]
            )

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", resume_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 2
                ):
                    resumed = analyzer.analyze(
                        plan,
                        state,
                        store,
                        checkpoint_path=paused.checkpoint_path,
                    )

            self.assertIsInstance(resumed, AnalyzerRunResult)
            self.assertIsNotNone(resumed.record)
            record = resumed.record
            assert record is not None
            self.assertTrue(record.success)
            self.assertEqual(record.stdout_content.strip(), "5")

            checkpoint = self._load_json(store, resumed.checkpoint_path or "")
            replay_history = checkpoint.get("replay_history", [])
            self.assertEqual(replay_history, [first_code, second_code])

    def test_pause_during_blocking_llm_call_returns_promptly_and_can_resume(self) -> None:
        temp_dir = make_test_base_dir("run_pause_during_llm")
        store, state = self._create_store_and_state(str(temp_dir), run_id="run_pause_during_llm")
        plan = PlanItem.create(text="Pause during a blocking analyzer model call")
        blocking_client = SlowFakeClient(
            [
                _assistant_tool_call(
                    "call_blocked",
                    "reflect_on_results",
                    {"reflection": "This response should be abandoned after pause."},
                ),
            ],
            delay_seconds=0.25,
        )
        started_at = time.perf_counter()
        analyzer = Analyzer(timeout=20, max_turns=4, enable_streaming=False)

        def pause_during_llm() -> dict[str, str]:
            if time.perf_counter() - started_at >= 0.05:
                return {"control_state": "pause_requested"}
            return {"control_state": "none"}

        with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", blocking_client), patch(
            "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
        ):
            begin = time.perf_counter()
            paused = analyzer.analyze(
                plan,
                state,
                store,
                control_callback=pause_during_llm,
            )
            paused_elapsed = time.perf_counter() - begin

        self.assertIsInstance(paused, AnalyzerRunResult)
        self.assertEqual(paused.control_action, "pause")
        self.assertIsNone(paused.record)
        self.assertIsNotNone(paused.checkpoint_path)
        self.assertLess(
            paused_elapsed,
            0.18,
            f"expected pause during blocking LLM call to return promptly, got elapsed={paused_elapsed:.3f}s",
        )

        resume_client = FakeClient(
            [
                _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "Resume after pause."}),
                _assistant_tool_call(
                    "call_2",
                    "execute_code",
                    {
                        "code": "\n".join(
                            [
                                "print('resumed')",
                                "plt.figure()",
                                "plt.plot([1, 2], [3, 4])",
                            ]
                        )
                    },
                ),
                _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "Execution completed."}),
                _assistant_tool_call("call_4", "complete_analysis", {"note": "enough evidence"}),
            ]
        )

        def fake_execute_python_code_streaming(
            code: str,
            *,
            on_stdout,
            on_stderr,
            timeout,
            cwd,
            stop_requested,
        ) -> dict[str, object]:
            _ = code
            _ = timeout
            _ = stop_requested
            on_stdout("resumed\n")
            Path(cwd, "artifacts", "plots", f"{plan.plan_id}_resume.png").write_bytes(b"fake-png")
            return {"success": True}

        with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
            with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", resume_client), patch(
                "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
            ), patch(
                "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 1
            ), patch(
                "framework.analyzer.execute_python_code_streaming",
                fake_execute_python_code_streaming,
            ):
                resumed = analyzer.analyze(
                    plan,
                    state,
                    store,
                    checkpoint_path=paused.checkpoint_path,
                )

        self.assertIsInstance(resumed, AnalyzerRunResult)
        self.assertIsNotNone(resumed.record)
        assert resumed.record is not None
        self.assertTrue(resumed.record.success)
        self.assertIn("resumed", resumed.record.stdout_content)

    def test_name_error_feedback_mentions_self_contained_code(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_name_error_feedback")
            plan = PlanItem.create(text="Trigger a NameError")
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "直接运行会触发 NameError。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": "print(missing_value)"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=2, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.checkpoint_path)
            checkpoint = self._load_json(store, result.checkpoint_path or "")
            tool_payloads = []
            for message in checkpoint.get("messages", []):
                if not isinstance(message, dict) or message.get("role") != "tool":
                    continue
                content = message.get("content")
                if not isinstance(content, str):
                    continue
                tool_payloads.append(json.loads(content))

            self.assertTrue(tool_payloads)
            last_payload = tool_payloads[-1]
            next_action = str(last_payload.get("next_action", ""))
            self.assertIn("self-contained", next_action)
            self.assertIn("Do not assume temporary variables", next_action)

    def test_runtime_bad_dataset_alias_path_falls_back_to_dataset_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_dataset_path_alias")
            plan = PlanItem.create(text="Load the dataset through an alias path")
            dataset_name = Path(state.dataset_path).name
            code = "\n".join(
                [
                    "bad_root = 'C:/Users/fake/backend/runs/_uploads'",
                    f"file_path = bad_root + '/{dataset_name}'",
                    "df = pd.read_csv(file_path)",
                    "print(int(df['value'].sum()))",
                    "plt.figure()",
                    "plt.plot([1, 2], [3, 4])",
                ]
            )
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先验证路径别名能否自动回退。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "路径已经自动回退到真实数据集。"}),
                    _assistant_tool_call("call_4", "complete_analysis", {"note": "enough evidence"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=4, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 1
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.record)
            record = result.record
            assert record is not None
            self.assertTrue(record.success)
            self.assertEqual(record.stdout_content.strip(), "3")
            self.assertTrue(record.plot_paths)

    def test_path_related_failure_feedback_points_back_to_dataset_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_path_feedback")
            plan = PlanItem.create(text="Trigger a dataset path failure")
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先故意使用错误路径。"}),
                    _assistant_tool_call(
                        "call_2",
                        "execute_code",
                        {"code": "df = pd.read_csv('C:/Users/fake/other_dataset.csv')"},
                    ),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=2, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.checkpoint_path)
            payloads = self._tool_payloads(store, result.checkpoint_path or "")
            self.assertTrue(payloads)
            next_action = str(payloads[-1].get("next_action", ""))
            self.assertIn("DATASET_PATH", next_action)
            self.assertIn("df", next_action)

    def test_multiple_tool_calls_only_execute_first_legal_call(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_multi_tool_call")
            plan = PlanItem.create(text="Ignore extra tool calls in one assistant turn")
            code = "\n".join(
                [
                    "print(int(df['value'].sum()))",
                    "plt.figure()",
                    "plt.plot([1, 2], [3, 4])",
                ]
            )
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先执行一次分析代码。"}),
                    _assistant_tool_calls(
                        ("call_2", "execute_code", {"code": code}),
                        ("call_3", "complete_analysis", {"note": "too early in same response"}),
                    ),
                    _assistant_tool_call("call_4", "reflect_on_results", {"reflection": "先看结果，再决定是否完成。"}),
                    _assistant_tool_call("call_5", "complete_analysis", {"note": "enough evidence"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=4, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 1
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.record)
            record = result.record
            assert record is not None
            self.assertTrue(record.success)
            analysis_process = self._load_json(store, record.analysis_path or "")
            execute_entries = self._execute_entries(analysis_process)
            self.assertEqual(len(execute_entries), 1)
            payloads = self._tool_payloads(store, result.checkpoint_path or "")
            ignored_errors = [
                str(payload.get("error", ""))
                for payload in payloads
                if "Only one tool call is allowed" in str(payload.get("error", ""))
            ]
            self.assertTrue(ignored_errors)

    def test_heatmap_with_colorbar_is_allowed_as_single_chart(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_heatmap_colorbar")
            self._install_seaborn_heatmap_stub(store)
            plan = PlanItem.create(text="Allow a single heatmap with colorbar")
            code = "\n".join(
                [
                    "import seaborn as sns",
                    "corr = df[['value', 'other']].corr()",
                    "plt.figure()",
                    "sns.heatmap(corr, annot=True)",
                    "plt.savefig('heatmap.png')",
                    "print('heatmap ok')",
                ]
            )
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先画一个热力图。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "热力图保存成功。"}),
                    _assistant_tool_call("call_4", "complete_analysis", {"note": "enough evidence"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=4, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 1
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.record)
            record = result.record
            assert record is not None
            self.assertTrue(record.success)
            self.assertEqual(record.stdout_content.strip(), "heatmap ok")
            self.assertTrue(record.plot_paths)

    def test_true_multi_panel_subplot_is_still_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_multi_panel_rejected")
            plan = PlanItem.create(text="Reject true multi-panel subplots")
            code = "fig, axes = plt.subplots(1, 3, figsize=(18, 6))"
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先故意创建一个多面板子图。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": code}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=2, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.checkpoint_path)
            payloads = self._tool_payloads(store, result.checkpoint_path or "")
            self.assertTrue(payloads)
            self.assertIn(
                "Multi-panel subplots are disabled",
                str(payloads[-1].get("error", "")),
            )

    def test_premature_complete_feedback_reports_remaining_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store, state = self._create_store_and_state(temp_dir, run_id="run_premature_complete")
            plan = PlanItem.create(text="Report why complete_analysis is still premature")
            code = "\n".join(
                [
                    "print(int(df['value'].sum()))",
                    "plt.figure()",
                    "plt.plot([1, 2], [3, 4])",
                ]
            )
            fake_client = FakeClient(
                [
                    _assistant_tool_call("call_1", "reflect_on_results", {"reflection": "先跑第一轮分析。"}),
                    _assistant_tool_call("call_2", "execute_code", {"code": code}),
                    _assistant_tool_call("call_3", "reflect_on_results", {"reflection": "结果有了，但先测试过早完成。"}),
                    _assistant_tool_call("call_4", "complete_analysis", {"note": "too early"}),
                ]
            )
            analyzer = Analyzer(timeout=20, max_turns=4, enable_streaming=False)

            with patch.dict(os.environ, {"PYTHONPATH": str(store.run_dir)}, clear=False):
                with patch("framework.analyzer.ANALYZER_OPENAI_CLIENT", fake_client), patch(
                    "framework.analyzer.ANALYZER_OPENAI_API_KEY", "test-key"
                ), patch(
                    "framework.analyzer.ANALYZER_MIN_SUCCESSFUL_EXECUTIONS_BEFORE_COMPLETE", 2
                ):
                    result = analyzer.analyze(plan, state, store)

            self.assertIsInstance(result, AnalyzerRunResult)
            self.assertIsNotNone(result.checkpoint_path)
            payloads = self._tool_payloads(store, result.checkpoint_path or "")
            self.assertTrue(payloads)
            next_action = str(payloads[-1].get("next_action", ""))
            self.assertIn("run at least 1 more successful execute_code iteration", next_action)
            self.assertIn("reflect_on_results", next_action)

    def test_summarizer_prefers_effective_code_path_with_legacy_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RunStore(run_id="run_summarizer_effective_code", base_dir=temp_dir)
            store.initialize()
            summarizer = Summarizer()

            visible_code_path = store.save_code("plan_demo", "print('visible snippet')", attempt=1)
            effective_code_path = store.save_effective_code("plan_demo", "x = 1\n\nprint(x)\n", attempt=1)
            stdout_path = store.save_stdout("plan_demo", "1\n", attempt=1)
            plot_file = store.plots_dir / "plan_demo_1.png"
            plot_file.write_bytes(
                bytes.fromhex(
                    "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
                    "0000000D49444154789C6360000002000100FFFF03000006000557BFAB00000000"
                    "49454E44AE426082"
                )
            )
            plot_path = plot_file.relative_to(store.run_dir).as_posix()

            analysis_process = {
                "tools_used": [
                    {
                        "tool": "execute_code",
                        "code_path": visible_code_path,
                        "effective_code_path": effective_code_path,
                        "stdout_path": stdout_path,
                        "plot_paths": [plot_path],
                        "success": True,
                    }
                ]
            }

            evidence_paths = summarizer._collect_evidence_paths(analysis_process)
            self.assertIn(effective_code_path, evidence_paths)
            self.assertNotIn(visible_code_path, evidence_paths)

            code_paths, output_paths, plot_paths = summarizer._partition_evidence_paths(evidence_paths)
            bundles = summarizer._build_evidence_bundles(
                analysis_process=analysis_process,
                record=ExecutionRecord(plan_id="plan_demo", success=True),
                code_paths=code_paths,
                output_paths=output_paths,
                plot_paths=plot_paths,
            )
            self.assertEqual(bundles[0]["code_path"], effective_code_path)

            stream, images = summarizer._build_analysis_stream(store, analysis_process, set(evidence_paths))
            self.assertIn(f"code_path: {effective_code_path}", stream)
            self.assertIn("x = 1", stream)
            self.assertNotIn("visible snippet", stream)
            self.assertEqual(len(images), 1)

            legacy_process = {
                "tools_used": [
                    {
                        "tool": "execute_code",
                        "code_path": visible_code_path,
                        "stdout_path": stdout_path,
                        "plot_paths": [plot_path],
                        "success": True,
                    }
                ]
            }
            legacy_paths = summarizer._collect_evidence_paths(legacy_process)
            self.assertIn(visible_code_path, legacy_paths)


if __name__ == "__main__":
    unittest.main()
