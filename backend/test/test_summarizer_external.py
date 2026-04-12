from __future__ import annotations

import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.models import (  # noqa: E402
    AtomicInsight,
    ExecutionRecord,
    Insight,
    InsightEvidence,
    PlanItem,
    UserMessage,
)
from framework.summarizer import Summarizer  # noqa: E402


class StubSummarizer(Summarizer):
    def summarize(self, plan, record, store=None, dataset_schema="", user_messages=None):
        _ = plan
        _ = record
        _ = store
        _ = dataset_schema
        _ = user_messages
        return Insight.create(
            plan_id="plan_demo",
            summary="North region leads total sales.",
            atomic_insights=[
                AtomicInsight.create(
                    text="North region leads total sales.",
                    insight_type="rank",
                    columns=["Region", "Sales"],
                    evidence=InsightEvidence(plot_path="artifacts/plots/plot.png"),
                )
            ],
        )


class KeywordResponseSummarizer(Summarizer):
    def __init__(self, response_text: str):
        self.response_text = response_text
        self.last_system_prompt = ""
        self.last_user_prompt = ""

    def _call_openai(self, system_prompt, user_prompt, images):  # type: ignore[override]
        self.last_system_prompt = system_prompt
        self.last_user_prompt = user_prompt
        _ = images
        return self.response_text


class TestSummarizerExternal(unittest.TestCase):
    def test_extract_insights_is_external_entrypoint(self) -> None:
        summarizer = StubSummarizer()
        plan = PlanItem.create(text="Analyze regional sales")
        records = [
            ExecutionRecord(
                plan_id=plan.plan_id,
                success=True,
                stdout_content="North region leads total sales.",
            )
        ]

        atomics = summarizer.extract_insights(
            plan=plan,
            execution_records=records,
            final_summary="North region leads total sales.",
        )

        self.assertEqual(len(atomics), 1)
        self.assertEqual(atomics[0].columns, ["Region", "Sales"])

    def test_summarize_normalizes_summary_and_atomic_keywords(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "North America drives the Q4 spike.",
              "short_label": "North America Q4 Spike",
              "keywords": ["North America", "Q4", "north america", "", "Revenue spike"],
              "atomic_insights": [
                {
                  "text": "North America drives the Q4 spike.",
                  "insight_type": "trend",
                  "columns": ["Region", "Revenue"],
                  "keywords": ["North America", "Q4", "q4", "", "Region"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze regional sales")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            stdout_content="North America drives the Q4 spike.",
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
          plan=plan,
          record=record,
          dataset_schema="Columns: ['Region', 'Revenue']",
        )

        self.assertIsNotNone(insight)
        self.assertEqual(insight.keywords, ["North America", "Q4", "Revenue spike"])
        self.assertEqual(
            insight.atomic_insights[0].keywords,
            ["North America", "Q4", "Region"],
        )

    def test_summarize_uses_empty_keywords_when_model_omits_them(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "North America drives the Q4 spike.",
              "short_label": "North America Q4 Spike",
              "atomic_insights": [
                {
                  "text": "North America drives the Q4 spike.",
                  "insight_type": "trend",
                  "columns": ["Region", "Revenue"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze regional sales")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            stdout_content="North America drives the Q4 spike.",
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['Region', 'Revenue']",
        )

        self.assertIsNotNone(insight)
        self.assertEqual(insight.keywords, [])
        self.assertEqual(insight.atomic_insights[0].keywords, [])

    def test_summarize_includes_latest_user_message_for_language_matching(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "学习时间和成绩存在正相关。",
              "short_label": "学习时间成绩关联",
              "keywords": ["学习时间", "成绩"],
              "atomic_insights": [
                {
                  "text": "学习时间更高的学生成绩通常更高。",
                  "insight_type": "association",
                  "columns": ["studytime", "G3"],
                  "keywords": ["学习时间", "成绩"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze study time and grades")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            stdout_content="Positive association between studytime and G3.",
            plot_paths=["artifacts/plots/plot.png"],
        )
        user_message = UserMessage.create(
            content="Focus on studytime.",
            kind="focus",
            user_prompt="请继续用中文总结学习时间和成绩的关系。",
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['studytime', 'G3']",
            user_messages=[user_message],
        )

        self.assertIsNotNone(insight)
        self.assertIn("Latest user-authored message for language matching", summarizer.last_user_prompt)
        self.assertIn(user_message.user_prompt or "", summarizer.last_user_prompt)

    def test_summarize_fallback_stays_in_user_language_when_model_output_is_invalid(self) -> None:
        summarizer = KeywordResponseSummarizer("not a json object")
        plan = PlanItem.create(text="Analyze study time and grades")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            plot_paths=["artifacts/plots/plot.png"],
        )
        user_message = UserMessage.create(
            content="Focus on studytime.",
            kind="focus",
            user_prompt="请继续用中文总结学习时间和成绩的关系。",
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['studytime', 'G3']",
            user_messages=[user_message],
        )

        self.assertIsNotNone(insight)
        self.assertIn("分析已完成", insight.summary)
        self.assertNotIn("Analysis completed", insight.summary)
        self.assertTrue(insight.atomic_insights)
        self.assertIn("与当前任务相关的发现", insight.atomic_insights[0].text)
    def test_summarize_strips_leading_source_task_prefix_from_summary(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "Comparison for sex: Female students score slightly higher overall. The gap stays modest across grade bands.",
              "short_label": "Sex Comparison",
              "atomic_insights": [
                {
                  "text": "Female students score slightly higher overall.",
                  "insight_type": "difference",
                  "columns": ["sex", "G3"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Comparison for sex")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['sex', 'G3']",
        )

        self.assertIsNotNone(insight)
        self.assertFalse(insight.summary.startswith("Comparison for sex"))
        self.assertIn("Female students score slightly higher overall.", insight.summary)

    def test_summarize_fallback_does_not_echo_source_task_prefix(self) -> None:
        summarizer = KeywordResponseSummarizer("not a json object")
        plan = PlanItem.create(text="Feature: studytime")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            stdout_content="Feature: studytime\nStudents with more study time tend to score higher.",
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['studytime', 'G3']",
        )

        self.assertIsNotNone(insight)
        self.assertNotIn("Feature: studytime", insight.summary)
        self.assertNotIn("Feature: studytime", insight.atomic_insights[0].text)
        self.assertIn("current task", insight.atomic_insights[0].text)

    def test_summarize_strips_template_lead_sentence_from_model_summary(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "The analysis reveals that North America leads total revenue. The gap widens further in Q4.",
              "short_label": "North America Revenue Lead",
              "atomic_insights": [
                {
                  "text": "North America leads total revenue.",
                  "insight_type": "rank",
                  "columns": ["Region", "Revenue"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze regional revenue")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            stdout_content="North America leads total revenue.",
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['Region', 'Revenue']",
        )

        self.assertIsNotNone(insight)
        self.assertFalse(insight.summary.startswith("The analysis reveals"))
        self.assertIn("The gap widens further in Q4.", insight.summary)

    def test_summarize_does_not_reintroduce_removed_template_as_fallback(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "Analysis of regional revenue reveals that North America leads.",
              "short_label": "North America Revenue Lead",
              "atomic_insights": [
                {
                  "text": "North America leads total revenue.",
                  "insight_type": "rank",
                  "columns": ["Region", "Revenue"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze regional revenue")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            plot_paths=["artifacts/plots/plot.png"],
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['Region', 'Revenue']",
        )

        self.assertIsNotNone(insight)
        self.assertNotIn("Analysis of regional revenue reveals", insight.summary)
        self.assertNotIn(
            "The summary is synthesized from executed analysis outputs and validated findings.",
            insight.summary,
        )
        self.assertIn("North America leads total revenue.", insight.summary)

    def test_summarize_avoids_mixed_cjk_terminal_punctuation(self) -> None:
        summarizer = KeywordResponseSummarizer(
            """
            {
              "summary": "",
              "short_label": "CJK punctuation normalization",
              "atomic_insights": [
                {
                  "text": "\\u5317\\u7f8e\\u5e02\\u573a\\u8d21\\u732e\\u6700\\u9ad8\\u3002",
                  "insight_type": "proportion",
                  "columns": ["Region", "Global_Sales"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot_1.png"
                  }
                },
                {
                  "text": "\\u89d2\\u8272\\u626e\\u6f14\\u7c7b\\u5728\\u65e5\\u672c\\u8868\\u73b0\\u66f4\\u5f3a",
                  "insight_type": "difference",
                  "columns": ["Genre", "JP_Sales"],
                  "evidence": {
                    "plot_path": "artifacts/plots/plot_2.png"
                  }
                }
              ]
            }
            """
        )
        plan = PlanItem.create(text="Analyze regional genre performance")
        record = ExecutionRecord(
            plan_id=plan.plan_id,
            success=True,
            plot_paths=["artifacts/plots/plot_1.png", "artifacts/plots/plot_2.png"],
        )
        user_message = UserMessage.create(
            content="Continue in Chinese.",
            kind="focus",
            user_prompt="\u8bf7\u7528\u4e2d\u6587\u7ee7\u7eed\u603b\u7ed3",
        )

        insight = summarizer.summarize(
            plan=plan,
            record=record,
            dataset_schema="Columns: ['Region', 'Global_Sales', 'Genre', 'JP_Sales']",
            user_messages=[user_message],
        )

        self.assertIsNotNone(insight)
        assert insight is not None
        self.assertEqual(
            insight.atomic_insights[0].text,
            "\u5317\u7f8e\u5e02\u573a\u8d21\u732e\u6700\u9ad8\u3002",
        )
        self.assertEqual(
            insight.atomic_insights[1].text,
            "\u89d2\u8272\u626e\u6f14\u7c7b\u5728\u65e5\u672c\u8868\u73b0\u66f4\u5f3a\u3002",
        )
        self.assertNotIn("\u3002.", insight.summary)
        self.assertNotIn("\uff01.", insight.summary)
        self.assertNotIn("\uff1f.", insight.summary)
        self.assertNotIn("\u3002.", insight.atomic_insights[0].text)
        self.assertNotIn("\u3002.", insight.atomic_insights[1].text)


if __name__ == "__main__":
    unittest.main()
