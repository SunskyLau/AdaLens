from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.models import PlanItem  # noqa: E402
from framework.language_context import latest_user_authored_text  # noqa: E402
from framework.store import RunStore  # noqa: E402
from framework.sub_agent import SubAgent  # noqa: E402


class FakeAnalyzer:
    def __init__(self, record):
        self.record = record
        self.calls = []

    def analyze(self, plan, state, store, checkpoint_path=None, resume_phase=None):
        self.calls.append(
            {
                "plan_id": plan.plan_id,
                "dataset_schema": state.dataset_schema,
                "latest_user_text": latest_user_authored_text(state.user_messages),
                "user_messages_count": len(state.user_messages),
            }
        )
        _ = plan
        _ = state
        _ = store
        _ = checkpoint_path
        _ = resume_phase
        return self.record


class FakeSummarizer:
    def __init__(self, insight):
        self.insight = insight
        self.calls = []

    def summarize(self, *, plan, record, store, dataset_schema, user_messages=None):
        self.calls.append(
            {
                "plan_id": plan.plan_id,
                "record_plan_id": record.plan_id,
                "dataset_schema": dataset_schema,
                "latest_user_text": latest_user_authored_text(user_messages),
            }
        )
        return self.insight


class SlowSummarizer(FakeSummarizer):
    def __init__(self, insight, delay_seconds: float):
        super().__init__(insight)
        self.delay_seconds = delay_seconds

    def summarize(self, *, plan, record, store, dataset_schema, user_messages=None):
        time.sleep(self.delay_seconds)
        return super().summarize(
            plan=plan,
            record=record,
            store=store,
            dataset_schema=dataset_schema,
            user_messages=user_messages,
        )


class TestSubAgent(unittest.TestCase):
    def test_sub_agent_result_contains_no_insight_without_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = RunStore(run_id="run_sub_agent", base_dir=temp_dir)
            store.initialize()
            sub_agent = SubAgent(store=store)
            plan = PlanItem.create(text="Inspect the dataset quickly")

            with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", ""), patch(
                "framework.sub_agent.OPENAI_API_KEY", ""
            ):
                result = asyncio.run(
                    sub_agent.run(
                        plan,
                        {
                            "dataset_path": "",
                            "rows": 5,
                            "columns": [{"name": "Region"}, {"name": "Sales"}],
                        },
                    )
                )

        self.assertFalse(result.success)
        self.assertEqual(result.plan_id, plan.plan_id)
        self.assertEqual(len(result.execution_records), 0)
        self.assertIn("credentials", result.error or "")
        self.assertIsNone(result.insight)

    def test_sub_agent_runs_summarizer_and_returns_insight(self) -> None:
        from framework.models import ExecutionRecord, Insight

        with tempfile.TemporaryDirectory() as temp_dir:
            store = RunStore(run_id="run_sub_agent_success", base_dir=temp_dir)
            store.initialize()
            plan = PlanItem.create(text="Inspect the dataset quickly")
            record = ExecutionRecord(
                plan_id=plan.plan_id,
                success=True,
                stdout_content="Some analysis output",
                plot_paths=["artifacts/plots/example.png"],
            )
            insight = Insight.create(
                plan_id=plan.plan_id,
                summary="The dataset shows a clear regional skew.",
            )
            summarizer = FakeSummarizer(insight)
            sub_agent = SubAgent(
                store=store,
                analyzer=FakeAnalyzer(record),
                summarizer=summarizer,
            )

            with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", "analyzer-key"), patch(
                "framework.sub_agent.OPENAI_API_KEY", "summarizer-key"
            ):
                result = asyncio.run(
                    sub_agent.run(
                        plan,
                        {
                            "dataset_path": "",
                            "dataset_schema": "Columns: ['Region', 'Sales']",
                            "rows": 5,
                            "columns": [{"name": "Region"}, {"name": "Sales"}],
                        },
                    )
                )

        self.assertTrue(result.success)
        self.assertEqual(result.plan_id, plan.plan_id)
        self.assertEqual(len(result.execution_records), 1)
        self.assertEqual(result.insight, insight)
        self.assertEqual(len(summarizer.calls), 1)
        self.assertEqual(summarizer.calls[0]["dataset_schema"], "Columns: ['Region', 'Sales']")

    def test_sub_agent_propagates_latest_user_language_context(self) -> None:
        from framework.models import ExecutionRecord, Insight, UserMessage

        with tempfile.TemporaryDirectory() as temp_dir:
            store = RunStore(run_id="run_sub_agent_language", base_dir=temp_dir)
            store.initialize()
            plan = PlanItem.create(text="Analyze correlation between study time and grades")
            record = ExecutionRecord(
                plan_id=plan.plan_id,
                success=True,
                stdout_content="Some analysis output",
                plot_paths=["artifacts/plots/example.png"],
            )
            insight = Insight.create(plan_id=plan.plan_id, summary="总结。")
            analyzer = FakeAnalyzer(record)
            summarizer = FakeSummarizer(insight)
            sub_agent = SubAgent(
                store=store,
                analyzer=analyzer,
                summarizer=summarizer,
            )
            user_message = UserMessage.create(
                content="Focus on the study-time cluster.",
                kind="focus",
                user_prompt="请继续用中文解释学习时间和成绩的关系。",
            )

            with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", "analyzer-key"), patch(
                "framework.sub_agent.OPENAI_API_KEY", "summarizer-key"
            ):
                result = asyncio.run(
                    sub_agent.run(
                        plan,
                        {
                            "dataset_path": "",
                            "dataset_schema": "Columns: ['studytime', 'G3']",
                            "rows": 5,
                            "columns": [{"name": "studytime"}, {"name": "G3"}],
                        },
                        user_messages=[user_message],
                    )
                )

        self.assertTrue(result.success)
        self.assertEqual(analyzer.calls[0]["latest_user_text"], user_message.user_prompt)
        self.assertEqual(analyzer.calls[0]["user_messages_count"], 1)
        self.assertEqual(summarizer.calls[0]["latest_user_text"], user_message.user_prompt)

    def test_sub_agent_emits_summarizing_phase_before_running_summarizer(self) -> None:
        from framework.models import ExecutionRecord, Insight

        with tempfile.TemporaryDirectory() as temp_dir:
            store = RunStore(run_id="run_sub_agent_phase", base_dir=temp_dir)
            store.initialize()
            plan = PlanItem.create(text="Inspect the dataset quickly")
            record = ExecutionRecord(
                plan_id=plan.plan_id,
                success=True,
                stdout_content="Some analysis output",
                plot_paths=["artifacts/plots/example.png"],
            )
            insight = Insight.create(plan_id=plan.plan_id, summary="Summary.")
            summarizer = FakeSummarizer(insight)
            phases: list[str] = []
            sub_agent = SubAgent(
                store=store,
                analyzer=FakeAnalyzer(record),
                summarizer=summarizer,
                phase_callback=lambda _plan_id, status: phases.append(status),
            )

            with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", "analyzer-key"), patch(
                "framework.sub_agent.OPENAI_API_KEY", "summarizer-key"
            ):
                asyncio.run(
                    sub_agent.run(
                        plan,
                        {
                            "dataset_path": "",
                            "dataset_schema": "Columns: ['Region', 'Sales']",
                            "rows": 5,
                            "columns": [{"name": "Region"}, {"name": "Sales"}],
                        },
                    )
                )

        self.assertEqual(phases, ["summarizing"])

    def test_sub_agents_summarize_in_parallel_across_tasks(self) -> None:
        from framework.models import ExecutionRecord, Insight

        async def run_pair() -> tuple[float, list]:
            with tempfile.TemporaryDirectory() as temp_dir:
                store = RunStore(run_id="run_sub_agent_parallel", base_dir=temp_dir)
                store.initialize()

                plan_a = PlanItem.create(text="Analyze A")
                plan_b = PlanItem.create(text="Analyze B")
                record_a = ExecutionRecord(
                    plan_id=plan_a.plan_id,
                    success=True,
                    stdout_content="A output",
                    plot_paths=["artifacts/plots/a.png"],
                )
                record_b = ExecutionRecord(
                    plan_id=plan_b.plan_id,
                    success=True,
                    stdout_content="B output",
                    plot_paths=["artifacts/plots/b.png"],
                )
                insight_a = Insight.create(plan_id=plan_a.plan_id, summary="Summary A.")
                insight_b = Insight.create(plan_id=plan_b.plan_id, summary="Summary B.")
                sub_agent_a = SubAgent(
                    store=store,
                    analyzer=FakeAnalyzer(record_a),
                    summarizer=SlowSummarizer(insight_a, delay_seconds=0.3),
                )
                sub_agent_b = SubAgent(
                    store=store,
                    analyzer=FakeAnalyzer(record_b),
                    summarizer=SlowSummarizer(insight_b, delay_seconds=0.3),
                )
                dataset_info = {
                    "dataset_path": "",
                    "dataset_schema": "Columns: ['Region', 'Sales']",
                    "rows": 5,
                    "columns": [{"name": "Region"}, {"name": "Sales"}],
                }

                start = time.perf_counter()
                with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", "analyzer-key"), patch(
                    "framework.sub_agent.OPENAI_API_KEY", "summarizer-key"
                ):
                    results = await asyncio.gather(
                        sub_agent_a.run(plan_a, dataset_info),
                        sub_agent_b.run(plan_b, dataset_info),
                    )
                elapsed = time.perf_counter() - start
                return elapsed, results

        elapsed, results = asyncio.run(run_pair())

        self.assertTrue(all(result.success for result in results))
        self.assertLess(
            elapsed,
            0.45,
            f"expected sub-agent summarization to overlap across tasks, got elapsed={elapsed:.3f}s",
        )

    def test_sub_agent_honors_terminate_requested_during_summarizing(self) -> None:
        from framework.models import ExecutionRecord, Insight

        async def exercise() -> tuple[float, object]:
            with tempfile.TemporaryDirectory() as temp_dir:
                store = RunStore(run_id="run_sub_agent_terminate_summary", base_dir=temp_dir)
                store.initialize()
                plan = PlanItem.create(text="Inspect the dataset quickly")
                record = ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=True,
                    stdout_content="Some analysis output",
                    plot_paths=["artifacts/plots/example.png"],
                )
                insight = Insight.create(plan_id=plan.plan_id, summary="Summary.")
                started_at = time.perf_counter()
                summarizer = SlowSummarizer(insight, delay_seconds=0.2)
                sub_agent = SubAgent(
                    store=store,
                    analyzer=FakeAnalyzer(record),
                    summarizer=summarizer,
                    control_callback=lambda: {
                        "control_state": (
                            "terminate_requested"
                            if time.perf_counter() - started_at >= 0.05
                            else "none"
                        )
                    },
                )

                with patch("framework.sub_agent.ANALYZER_OPENAI_API_KEY", "analyzer-key"), patch(
                    "framework.sub_agent.OPENAI_API_KEY", "summarizer-key"
                ):
                    begin = time.perf_counter()
                    result = await sub_agent.run(
                        plan,
                        {
                            "dataset_path": "",
                            "dataset_schema": "Columns: ['Region', 'Sales']",
                            "rows": 5,
                            "columns": [{"name": "Region"}, {"name": "Sales"}],
                        },
                    )
                    elapsed = time.perf_counter() - begin
                    await asyncio.sleep(0.25)
                    return elapsed, result

        elapsed, result = asyncio.run(exercise())

        self.assertFalse(result.success)
        self.assertEqual(result.control_action, "terminate")
        self.assertEqual(result.resume_phase, "summarizing")
        self.assertEqual(len(result.execution_records), 1)
        self.assertLess(
            elapsed,
            0.18,
            f"expected terminate during summarizing to return promptly, got elapsed={elapsed:.3f}s",
        )


if __name__ == "__main__":
    unittest.main()
