from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cache_normalization import build_dataset_identity  # noqa: E402
from framework.language_context import contains_cjk_text  # noqa: E402
from framework.master_agent import MasterAgent  # noqa: E402
from framework.models import (  # noqa: E402
    AtomicInsight,
    DispatchBatchState,
    ExecutionRecord,
    InsightEvidence,
    Insight,
    PlanItem,
    ProvenanceCitation,
    RunSettings,
    RunState,
    SteeringTargetSnapshot,
    SubAgentResult,
    TimelineEntry,
    Turn,
    UserMessage,
)
from framework.store import RunStore  # noqa: E402


TEST_TMP_ROOT = ROOT / ".codex-temp-test"


def make_test_base_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


class FakeSubAgent:
    async def run(self, plan, dataset_info):
        _ = dataset_info
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=True,
            execution_records=[
                ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=True,
                    stdout_path="artifacts/stdout/plan_1.txt",
                    stdout_content="North region leads total sales.",
                    plot_paths=["artifacts/plots/plan_1.png"],
                )
            ],
            insight=Insight.create(
                plan_id=plan.plan_id,
                summary="North region leads total sales.",
                atomic_insights=[
                    AtomicInsight.create(
                        text="North region leads total sales.",
                        insight_type="rank",
                        columns=["Region", "Sales"],
                        evidence=InsightEvidence(plot_path="artifacts/plots/plan_1.png"),
                    )
                ],
            ),
            error=None,
        )


class FailedSubAgent:
    async def run(self, plan, dataset_info):
        _ = dataset_info
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=False,
            execution_records=[
                ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=False,
                    stderr_content="boom",
                    error_message="boom",
                )
            ],
            insight=None,
            error="boom",
        )


class CrashingSubAgent:
    async def run(self, plan, dataset_info):
        _ = plan
        _ = dataset_info
        raise RuntimeError("sub-agent crashed")


class SlowSubAgent:
    async def run(self, plan, dataset_info):
        _ = dataset_info
        await asyncio.sleep(0.1)
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=True,
            execution_records=[
                ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=True,
                    stdout_content="done",
                    plot_paths=["artifacts/plots/plan_1.png"],
                )
            ],
            insight=Insight.create(
                plan_id=plan.plan_id,
                summary="done",
                atomic_insights=[
                    AtomicInsight.create(
                        text="North region leads total sales.",
                        insight_type="rank",
                        columns=["Region", "Sales"],
                        evidence=InsightEvidence(plot_path="artifacts/plots/plan_1.png"),
                    )
                ],
            ),
            error=None,
        )


class ControlAwareSlowSubAgent:
    def __init__(self) -> None:
        self.control_callback = None

    async def run(self, plan, dataset_info, resume_phase=None, user_messages=None):
        _ = dataset_info
        _ = resume_phase
        _ = user_messages
        for _ in range(20):
            callback = self.control_callback
            control_snapshot = callback() if callable(callback) else {}
            control_state = str((control_snapshot or {}).get("control_state") or "").strip()
            if control_state == "terminate_requested":
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[],
                    insight=None,
                    error=None,
                    control_action="terminate",
                    resume_phase="analyzing",
                )
            await asyncio.sleep(0.01)
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=True,
            execution_records=[],
            insight=Insight.create(
                plan_id=plan.plan_id,
                summary="done",
                atomic_insights=[],
            ),
            error=None,
        )


class EchoInsightSubAgent:
    async def run(self, plan, dataset_info):
        _ = dataset_info
        return SubAgentResult(
            plan_id=plan.plan_id,
            success=True,
            execution_records=[
                ExecutionRecord(
                    plan_id=plan.plan_id,
                    success=True,
                    stdout_content=plan.text,
                    plot_paths=["artifacts/plots/plan_1.png"],
                )
            ],
            insight=Insight.create(
                plan_id=plan.plan_id,
                summary=plan.text,
                atomic_insights=[
                    AtomicInsight.create(
                        text=plan.text,
                        insight_type="value",
                        columns=["Region"],
                        evidence=InsightEvidence(plot_path="artifacts/plots/plan_1.png"),
                    )
                ],
            ),
            error=None,
        )


class RecordingStore:
    def __init__(self) -> None:
        self.tool_results: list[tuple[str, dict]] = []
        self.events: list[tuple[str, dict]] = []
        self.status_changes: list[tuple[str, str, str]] = []

    def log_master_agent_tool_result(self, tool_name: str, result: dict) -> None:
        self.tool_results.append((tool_name, result))

    def append_event(self, event_type: str, data: dict) -> None:
        self.events.append((event_type, data))

    def log_run_status_change(self, old_status: str, new_status: str, reason: str) -> None:
        self.status_changes.append((old_status, new_status, reason))

    def log_plan_created(self, _plan: PlanItem) -> None:
        return None

    def log_progress_evaluation(self, _payload: dict) -> None:
        return None

    def save_state(self, _state: RunState) -> None:
        return None


def eager_completion_decider(state, _context):
    pending = [plan for plan in state.plans if plan.status == "pending"]

    if not state.plans:
        return [
            {
                "name": "create_plans",
                "arguments": {
                    "plans": [
                        {
                            "text": "Analyze regional sales performance",
                        }
                    ]
                },
            }
        ]
    if pending:
        return [
            {
                "name": "dispatch_plans",
                "arguments": {"plan_ids": [pending[0].plan_id]},
            }
        ]
    if state.insights and not state.master_agent_state.completed:
        return [
            {
                "name": "mark_complete",
                "arguments": {"summary": "Regional goal satisfied."},
            }
        ]
    return []


def scripted_decider(state, _context):
    pending = [plan for plan in state.plans if plan.status == "pending"]
    running = [plan for plan in state.plans if plan.status in {"analyzing", "summarizing"}]

    if not state.plans:
        return [
            {
                "name": "create_plans",
                "arguments": {
                    "plans": [
                        {
                            "text": "Analyze regional sales performance",
                        }
                    ]
                },
            }
        ]
    if pending:
        return [
            {
                "name": "dispatch_plans",
                "arguments": {"plan_ids": [pending[0].plan_id]},
            }
        ]
    if running:
        return [
            {
                "name": "evaluate_progress",
                "arguments": {"evaluation": "Waiting for the sub-agent result."},
            }
        ]
    if state.insights and not state.master_agent_state.completed:
        return [
            {
                "name": "synthesize_findings",
                "arguments": {"synthesis": "Regional analysis is sufficient."},
            },
            {
                "name": "mark_complete",
                "arguments": {"summary": "Regional goal satisfied."},
            },
        ]
        return []


class TestMasterAgent(unittest.TestCase):
    def test_build_pending_user_response_tool_calls_preserves_arrival_order(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )

        summary_target = SteeringTargetSnapshot(
            kind="summary",
            summary_id="summary_1",
            summary_short_label="Revenue spike",
            summary_text="Revenue spikes in Q4.",
            columns=["Revenue", "Quarter"],
        )
        chat_message = UserMessage.create(content="Focus on the revenue driver.", kind="chat")
        focus_message = UserMessage.create(
            content="Focus Revenue spike",
            kind="focus",
            target=summary_target,
        )
        create_message = UserMessage.create(
            content="Add a plan for pricing sensitivity.",
            kind="create",
        )
        agent.state.user_messages.extend(
            [chat_message, focus_message, create_message]
        )

        self.assertTrue(agent._enqueue_pending_user_response(chat_message))
        self.assertTrue(agent._enqueue_pending_user_response(focus_message))
        self.assertTrue(agent._enqueue_pending_user_response(create_message))

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(
            [tool_call["name"] for tool_call in tool_calls],
            ["respond_to_user", "respond_to_user", "respond_to_user"],
        )
        self.assertEqual(
            [tool_call["_pending_user_response_message_id"] for tool_call in tool_calls],
            [chat_message.message_id, focus_message.message_id, create_message.message_id],
        )

    def test_execute_pending_user_response_tool_calls_clears_pending_queue(self) -> None:
        store = RecordingStore()
        agent = MasterAgent(store=store)
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )

        message = UserMessage.create(content="Focus on regional differences.", kind="chat")
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()
        tool_calls = agent._ensure_post_summary_user_responses(tool_calls)
        tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(tool_calls)

        asyncio.run(agent._execute_tool_calls(tool_calls))

        self.assertEqual(agent.state.master_agent_state.pending_user_response_message_ids, [])
        self.assertEqual([name for name, _ in store.tool_results], ["respond_to_user"])
        self.assertEqual(store.events[0][0], "user_response")
        self.assertTrue(store.events[0][1]["message"].strip())

    def test_leading_user_response_for_chat_references_specific_request_text(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(
            content="Please compare Europe and North America next, especially the revenue gap.",
            kind="chat",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertIn("Europe and North America", tool_calls[0]["arguments"]["message"])
        self.assertIn("revenue gap", tool_calls[0]["arguments"]["message"])

    def test_leading_user_response_for_create_references_new_plan_text(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(
            content="Check pricing sensitivity by region and product category.",
            kind="create",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertIn("pricing sensitivity", tool_calls[0]["arguments"]["message"])
        self.assertIn("product category", tool_calls[0]["arguments"]["message"])

    def test_leading_user_response_for_focus_mentions_selected_keywords(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        target = SteeringTargetSnapshot(
            kind="summary",
            summary_id="summary_1",
            summary_short_label="Revenue spike",
            summary_text="Revenue spikes in Q4.",
            columns=["Revenue", "Quarter"],
        )
        message = UserMessage.create(
            content="Focus Revenue spike",
            kind="focus",
            target=target,
            selected_keywords=["Revenue", "North America"],
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertIn("Revenue", tool_calls[0]["arguments"]["message"])
        self.assertIn("North America", tool_calls[0]["arguments"]["message"])

    def test_leading_user_response_uses_llm_when_available(self) -> None:
        class FakeAckResponse:
            def __init__(self, content: str) -> None:
                self.choices = [
                    type(
                        "Choice",
                        (),
                        {"message": type("Message", (), {"content": content})()},
                    )
                ]

        class FakeAckClient:
            def __init__(self, content: str) -> None:
                self.requests: list[dict[str, Any]] = []
                self._content = content

                class _Completions:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self._outer = outer

                    def create(self, **kwargs):
                        self._outer.requests.append(kwargs)
                        return FakeAckResponse(self._outer._content)

                class _Chat:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self.completions = _Completions(outer)

                self.chat = _Chat(self)

        fake_client = FakeAckClient(
            "Understood. I'll compare Europe and North America next and focus on the revenue gap."
        )
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(
            content="Please compare Europe and North America next, especially the revenue gap.",
            kind="chat",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", fake_client
        ):
            tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(
            tool_calls[0]["arguments"]["message"],
            "Understood. I'll compare Europe and North America next and focus on the revenue gap.",
        )
        self.assertEqual(len(fake_client.requests), 1)
        self.assertIn(
            "avoid canned openings or fixed sentence patterns",
            fake_client.requests[0]["messages"][0]["content"],
        )
        self.assertIn(
            "Please compare Europe and North America next",
            fake_client.requests[0]["messages"][1]["content"],
        )
        self.assertIn(
            "Write only the acknowledgement text.",
            fake_client.requests[0]["messages"][1]["content"],
        )

    def test_leading_user_response_strips_model_added_reply_label(self) -> None:
        class FakeAckResponse:
            def __init__(self, content: str) -> None:
                self.choices = [
                    type(
                        "Choice",
                        (),
                        {"message": type("Message", (), {"content": content})()},
                    )
                ]

        class FakeAckClient:
            def __init__(self, content: str) -> None:
                class _Completions:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self._outer = outer

                    def create(self, **kwargs):
                        return FakeAckResponse(self._outer._content)

                class _Chat:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self.completions = _Completions(outer)

                self._content = content
                self.chat = _Chat(self)

        fake_client = FakeAckClient(
            'Reply: "I\'ll start with the Europe versus North America revenue gap next."'
        )
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(
            content="Please compare Europe and North America next, especially the revenue gap.",
            kind="chat",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", fake_client
        ):
            tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(
            tool_calls[0]["arguments"]["message"],
            "I'll start with the Europe versus North America revenue gap next.",
        )

    def test_leading_user_response_uses_canonical_latest_user_text_for_language(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )

        message = UserMessage.create(
            content="Focus Revenue spike",
            kind="focus",
            user_prompt="请继续用中文分析这个 summary。",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertIn("我会", tool_calls[0]["arguments"]["message"])

    def test_stop_intent_detection_covers_explicit_examples_and_false_positive_guards(self) -> None:
        positives = [
            "please stop all analysis, thanks",
            "finish the run",
            "that's enough",
            "end further analysis",
            "terminate all plans",
            "go idle now",
            "disable future analysis",
            "turn off future analysis",
            "turn down further analysis",
            "shut off follow-up work",
            "shut down follow-up work",
            "analysis is over",
            "don't need more analysis",
            "needn't more follow-up",
            "停止所有分析",
            "结束所有后续分析",
            "终止后续分析",
            "到这里就行",
            "可以了不用继续",
            "别再分析了",
        ]
        negatives = [
            "disable this feature",
            "turn down the threshold",
            "idle users",
            "overfitting is severe",
            "we have enough samples",
        ]

        for text in positives:
            self.assertTrue(MasterAgent._is_stop_intent_text(text), text)
        for text in negatives:
            self.assertFalse(MasterAgent._is_stop_intent_text(text), text)

    def test_leading_user_response_for_stop_intent_is_stop_aware(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(
            content="Stop all analysis, please.",
            kind="chat",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        response = tool_calls[0]["arguments"]["message"]
        self.assertIn("stop the current and follow-up analysis", response)
        self.assertNotIn("already", response.casefold())

    def test_filter_disallowed_respond_to_user_tool_calls_drops_standalone_progress_reply(self) -> None:
        agent = MasterAgent()

        filtered = agent._filter_disallowed_respond_to_user_tool_calls(
            [
                {
                    "name": "respond_to_user",
                    "arguments": {"message": "Standalone progress update."},
                },
                {
                    "name": "dispatch_plans",
                    "arguments": {"plan_ids": ["plan_1"]},
                },
            ]
        )

        self.assertEqual(
            [tool_call["name"] for tool_call in filtered],
            ["dispatch_plans"],
        )

    def test_ensure_post_summary_user_response_reorders_existing_follow_up_after_evaluate_progress(self) -> None:
        agent = MasterAgent()

        normalized = agent._filter_disallowed_respond_to_user_tool_calls(
            agent._ensure_post_summary_user_responses(
                [
                    {
                        "name": "evaluate_progress",
                        "arguments": {"evaluation": "Enough evidence for a checkpoint."},
                    },
                    {
                        "name": "synthesize_findings",
                        "arguments": {"synthesis": "Intermediate synthesis."},
                    },
                    {
                        "name": "respond_to_user",
                        "arguments": {"message": "I can summarize this stage now."},
                    },
                ]
            )
        )

        self.assertEqual(
            [tool_call["name"] for tool_call in normalized],
            ["evaluate_progress", "respond_to_user", "synthesize_findings"],
        )
        self.assertEqual(
            normalized[1]["arguments"]["message"],
            "I can summarize this stage now.",
        )

    def test_ensure_post_summary_user_response_injects_non_empty_fallback_after_mark_complete(self) -> None:
        agent = MasterAgent()

        normalized = agent._filter_disallowed_respond_to_user_tool_calls(
            agent._ensure_post_summary_user_responses(
                [
                    {
                        "name": "mark_complete",
                        "arguments": {"summary": "Final answer."},
                    },
                    {
                        "name": "respond_to_user",
                        "arguments": {"message": "   "},
                    },
                ]
            )
        )

        self.assertEqual(
            [tool_call["name"] for tool_call in normalized],
            ["mark_complete", "respond_to_user"],
        )
        self.assertTrue(normalized[1]["arguments"]["message"].strip())
        self.assertIn("I marked the run complete because", normalized[1]["arguments"]["message"])
        self.assertNotIn("Current summary basis", normalized[1]["arguments"]["message"])

    def test_post_summary_fallback_reuses_citations_without_appending_full_summary_basis(self) -> None:
        agent = MasterAgent()

        normalized = agent._filter_disallowed_respond_to_user_tool_calls(
            agent._ensure_post_summary_user_responses(
                [
                    {
                        "name": "evaluate_progress",
                        "arguments": {
                            "stage_summary_markdown": "Revenue spikes in Q4 [[1]].",
                            "citations": [
                                {
                                    "marker": 1,
                                    "target": {
                                        "kind": "summary",
                                        "summary_id": "summary_1",
                                        "summary_short_label": "Revenue spike",
                                        "summary_text": "Revenue spikes in Q4.",
                                        "columns": ["Revenue", "Quarter"],
                                    },
                                    "label": "Revenue spike",
                                }
                            ],
                        },
                    }
                ]
            )
        )

        follow_up = normalized[1]["arguments"]
        self.assertIn("[[1]]", follow_up["message"])
        self.assertEqual(follow_up["citations"][0]["marker"], 1)
        self.assertNotIn("Current summary basis", follow_up["message"])

    def test_post_summary_fallback_uses_latest_user_language_when_user_is_chinese(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        agent.state.user_messages.append(
            UserMessage.create(
                content="Focus Revenue spike",
                kind="focus",
                user_prompt="请继续用中文总结当前阶段结果。",
            )
        )

        follow_up = agent._build_post_summary_user_response(
            "mark_complete",
            {"summary": "Final answer."},
        )

        self.assertIn("我将这次 run 标记为完成", follow_up["arguments"]["message"])

    def test_post_summary_user_response_replaces_wrong_language_after_chinese_user_input(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        agent.state.user_messages.append(
            UserMessage.create(
                content="Focus Revenue spike",
                kind="focus",
                user_prompt="\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u56de\u590d\u3002",
            )
        )

        normalized = agent._filter_disallowed_respond_to_user_tool_calls(
            agent._ensure_post_summary_user_responses(
                [
                    {
                        "name": "mark_complete",
                        "arguments": {"summary": "Final answer."},
                    },
                    {
                        "name": "respond_to_user",
                        "arguments": {
                            "message": "I marked the run complete because the evidence is sufficient."
                        },
                    },
                ]
            )
        )

        self.assertEqual(
            [tool_call["name"] for tool_call in normalized],
            ["mark_complete", "respond_to_user"],
        )
        self.assertTrue(contains_cjk_text(normalized[1]["arguments"]["message"]))
        self.assertNotEqual(
            normalized[1]["arguments"]["message"],
            "I marked the run complete because the evidence is sufficient.",
        )

    def test_runtime_acknowledgement_blocks_later_standalone_respond_to_user_for_same_input(self) -> None:
        store = RecordingStore()
        agent = MasterAgent(store=store)
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )

        message = UserMessage.create(content="Focus on regional differences.", kind="chat")
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        initial_tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(
            agent._ensure_post_summary_user_responses(
                agent._build_pending_user_response_tool_calls()
            )
        )
        asyncio.run(agent._execute_tool_calls(initial_tool_calls))

        later_tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(
            [
                {
                    "name": "respond_to_user",
                    "arguments": {"message": "Extra standalone progress update."},
                }
            ]
        )
        asyncio.run(agent._execute_tool_calls(later_tool_calls))

        self.assertEqual(agent.state.master_agent_state.pending_user_response_message_ids, [])
        self.assertEqual([event_type for event_type, _data in store.events], ["user_response"])
        self.assertEqual([name for name, _result in store.tool_results], ["respond_to_user"])

    def test_tool_respond_to_user_persists_citations(self) -> None:
        store = RecordingStore()
        agent = MasterAgent(store=store)

        result = agent._tool_respond_to_user(
            {
                "message": "Checkpoint is justified by the latest summary [[1]].",
                "citations": [
                    {
                        "marker": 1,
                        "target": {
                            "kind": "summary",
                            "summary_id": "summary_1",
                            "summary_short_label": "Revenue spike",
                            "summary_text": "Revenue spikes in Q4.",
                            "columns": ["Revenue", "Quarter"],
                        },
                        "label": "Revenue spike",
                    }
                ],
            }
        )

        self.assertEqual(result["citations"][0]["marker"], 1)
        self.assertEqual(store.events[-1][0], "user_response")
        self.assertEqual(store.events[-1][1]["citations"][0]["marker"], 1)

    def test_load_dataset_info_detects_semicolon_delimiter(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_path = Path(temp_dir) / "sample.csv"
            dataset_path.write_text(
                "Region;Revenue;Quarter\nNA;120;Q4\nEU;90;Q4\n",
                encoding="utf-8",
            )

            agent = MasterAgent()
            info = agent._load_dataset_info(str(dataset_path))

            self.assertEqual(info["delimiter"], ";")
            self.assertEqual(info["rows"], 2)
            self.assertEqual(
                [column["name"] for column in info["columns"]],
                ["Region", "Revenue", "Quarter"],
            )
            self.assertEqual(info["sample_rows"][0]["Region"], "NA")

    def test_master_agent_executes_plan_lifecycle_and_persists_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_test_master", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: FakeSubAgent(),
                idle_timeout_seconds=0.0,
            )

            state = asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Understand regional sales differences",
                    dataset_info_override={
                        "rows": 10,
                        "columns": [
                            {"name": "Region", "dtype": "object"},
                            {"name": "Sales", "dtype": "float64"},
                        ],
                        "sample_rows": [{"Region": "North", "Sales": 10.0}],
                    },
                )
            )

            self.assertEqual(state.status, "completed")
            self.assertEqual(len(state.plans), 1)
            self.assertEqual(state.plans[0].status, "completed")
            self.assertNotIn("priority_hint", state.plans[0].to_dict())
            self.assertNotIn("priority_params", state.plans[0].to_dict())
            self.assertNotIn("priority", state.plans[0].to_dict())
            self.assertTrue(state.master_agent_state.completed)
            self.assertEqual(state.final_summary, "Regional goal satisfied.")
            self.assertEqual(
                state.insights[0].summary,
                "North region leads total sales.",
            )
            self.assertEqual(
                state.insights[0].atomic_insights[0].text,
                "North region leads total sales.",
            )
            # Turn assertions
            self.assertTrue(len(state.turns) >= 1)
            last_turn = state.turns[-1]
            self.assertEqual(last_turn.status, "completed")
            self.assertTrue(run_store.state_path.exists())
            self.assertTrue(run_store.events_path.exists())
            event_lines = run_store.events_path.read_text(encoding="utf-8")
            event_payloads = [
                json.loads(line)
                for line in event_lines.splitlines()
                if line.strip()
            ]
            master_tool_events = [
                payload
                for payload in event_payloads
                if payload.get("event_type") == "master_agent_tool_result"
            ]
            self.assertGreaterEqual(len(master_tool_events), 1)
            self.assertEqual(
                master_tool_events[0]["data"]["tool_name"],
                "respond_to_user",
            )
            self.assertIn('"event_type": "plan_started"', event_lines)
            self.assertIn('"status": "analyzing"', event_lines)
            self.assertIn('"event_type": "plan_completed"', event_lines)

    def test_failed_sub_agent_does_not_create_insight(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_failed", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: FailedSubAgent(),
                idle_timeout_seconds=0.0,
            )

            state = asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Understand regional sales differences",
                    dataset_info_override={"rows": 10, "columns": []},
                )
            )

            self.assertEqual(state.status, "failed")
            self.assertEqual(state.failure_count, 1)
            self.assertEqual(state.plans[0].status, "failed")
            self.assertEqual(len(state.insights), 0)

    def test_sub_agent_exception_is_captured_as_failed_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_exception", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: CrashingSubAgent(),
                idle_timeout_seconds=0.0,
            )

            state = asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Understand regional sales differences",
                    dataset_info_override={"rows": 10, "columns": []},
                )
            )

            self.assertEqual(state.status, "failed")
            self.assertEqual(state.plans[0].status, "failed")
            self.assertIn("crashed", state.plans[0].error_message or "")

    def test_waiting_for_active_task_still_allows_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_slow", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: SlowSubAgent(),
                idle_timeout_seconds=0.0,
            )

            state = asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Understand regional sales differences",
                    dataset_info_override={"rows": 10, "columns": []},
                )
            )

            self.assertEqual(state.status, "completed")
            self.assertEqual(state.final_summary, "Regional goal satisfied.")

    def test_stop_completion_hook_marks_complete_after_running_plan_terminates(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_stop_completion_hook",
                base_dir=make_test_base_dir("run_stop_completion_hook"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: ControlAwareSlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Running plan")
            agent.state.plans.append(running_plan)
            await agent._tool_dispatch_plans({"plan_ids": [running_plan.plan_id]})

            agent.user_steer_queue.push("Stop all analysis.", kind="chat")
            self.assertTrue(agent._process_user_steer())
            self.assertEqual(
                agent.state.get_plan_by_id(running_plan.plan_id).control_state,
                "terminate_requested",
            )

            await asyncio.wait_for(agent._active_tasks[running_plan.plan_id], timeout=0.5)
            await agent._collect_finished_sub_agents()

            self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "terminated")
            stop_completion_tool_call = agent._build_stop_completion_tool_call()
            self.assertIsNotNone(stop_completion_tool_call)
            self.assertEqual(stop_completion_tool_call["name"], "mark_complete")
            self.assertTrue(stop_completion_tool_call["arguments"]["summary"].strip())

            tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(
                agent._ensure_post_summary_user_responses([stop_completion_tool_call])
            )
            await agent._execute_tool_calls(tool_calls)

            self.assertTrue(agent.state.master_agent_state.completed)
            self.assertEqual(agent.state.status, "completed")
            self.assertTrue(agent.state.final_summary.strip())

        asyncio.run(exercise())

    def test_stop_completion_fallback_skips_stage_summary_batches(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
        agent.state.user_messages.append(
            UserMessage.create(content="Stop all analysis.", kind="chat")
        )
        completed_plan = PlanItem.create(text="Completed analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.insights.append(
            Insight.create(
                plan_id=completed_plan.plan_id,
                summary="Revenue spikes in Q4.",
                atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
            )
        )
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[completed_plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        stop_completion_tool_call = agent._build_stop_completion_tool_call()

        self.assertIsNotNone(stop_completion_tool_call)
        self.assertEqual(stop_completion_tool_call["name"], "mark_complete")
        self.assertIn(
            "Revenue spikes in Q4.",
            stop_completion_tool_call["arguments"]["summary"],
        )

    def test_stop_completion_filter_drops_stage_summary_and_keeps_mark_complete(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
        agent.state.user_messages.append(
            UserMessage.create(content="Stop all analysis.", kind="chat")
        )
        completed_plan = PlanItem.create(text="Completed analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)

        filtered = agent._enforce_stop_completion_tool_calls(
            [
                {"name": "evaluate_progress", "arguments": {"stage_summary_markdown": "Checkpoint."}},
                {"name": "mark_complete", "arguments": {"summary": "Final answer."}},
            ]
        )

        self.assertEqual(
            filtered,
            [{"name": "mark_complete", "arguments": {"summary": "Final answer."}}],
        )

    def test_stop_completion_llm_hook_requests_mark_complete_without_stage_summary(self) -> None:
        async def exercise() -> None:
            class FakeClient:
                def __init__(self) -> None:
                    self.requests: list[dict] = []

                    class _Completions:
                        def __init__(self, outer: "FakeClient") -> None:
                            self._outer = outer

                        def create(self, **kwargs):
                            self._outer.requests.append(kwargs)
                            tool_call = SimpleNamespace(
                                function=SimpleNamespace(
                                    name="mark_complete",
                                    arguments=json.dumps(
                                        {"summary": "Comprehensive final summary of the run."},
                                        ensure_ascii=False,
                                    ),
                                )
                            )
                            message = SimpleNamespace(content="", tool_calls=[tool_call])
                            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

                    self.chat = SimpleNamespace(completions=_Completions(self))

            agent = MasterAgent(store=RecordingStore())
            agent.state = RunState.create(
                dataset_path="data/example.csv",
                user_goal="Base goal",
            )
            agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
            agent.state.user_messages.append(
                UserMessage.create(content="Stop all analysis.", kind="chat")
            )
            completed_plan = PlanItem.create(text="Completed analysis")
            completed_plan.status = "completed"
            agent.state.plans.append(completed_plan)
            agent.state.insights.append(
                Insight.create(
                    plan_id=completed_plan.plan_id,
                    summary="Revenue spikes in Q4.",
                    atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
                )
            )
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[completed_plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            fake_client = FakeClient()
            with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
                "framework.master_agent.OPENAI_CLIENT", fake_client
            ):
                stop_completion_tool_call, timestamp_binding = await agent._build_stop_completion_tool_call_via_llm()

            self.assertIsNotNone(stop_completion_tool_call)
            self.assertEqual(stop_completion_tool_call["name"], "mark_complete")
            self.assertEqual(
                stop_completion_tool_call["arguments"]["summary"],
                "Comprehensive final summary of the run.",
            )
            self.assertIsNone(timestamp_binding)
            self.assertEqual(len(fake_client.requests), 1)
            self.assertIn(
                "Do not call evaluate_progress",
                fake_client.requests[0]["messages"][-1]["content"],
            )

            completion_tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(
                agent._ensure_post_summary_user_responses([stop_completion_tool_call])
            )
            self.assertEqual(
                [tool_call["name"] for tool_call in completion_tool_calls],
                ["mark_complete", "respond_to_user"],
            )
            self.assertIn(
                "ended the run here as you requested",
                completion_tool_calls[1]["arguments"]["message"],
            )

            await agent._execute_tool_calls(completion_tool_calls)

            self.assertEqual(
                agent.state.final_summary,
                "Comprehensive final summary of the run.",
            )

        asyncio.run(exercise())

    def test_user_steer_remains_visible_until_after_decision_turn(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_steer", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            agent.user_steer_queue.push("Focus on Q4")
            has_pending = agent._process_user_steer()
            prompt_before = agent.context_builder.build_user_prompt(agent.state)

        self.assertTrue(has_pending)
        self.assertEqual(agent.state.master_agent_state.current_goals, ["Base goal"])
        # Steer should appear in the running turn steers and stay visible.
        self.assertIn("Focus on Q4", prompt_before)
        self.assertNotIn("### Pending User Messages", prompt_before)

    def test_process_user_steer_stop_intent_terminates_nonrunning_and_requests_running_termination(self) -> None:
        run_store = RunStore(
            run_id="run_stop_intent_controls",
            base_dir=make_test_base_dir("run_stop_intent_controls"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        pending_plan = PlanItem.create(text="Pending plan")
        paused_plan = PlanItem.create(text="Paused plan")
        paused_plan.status = "paused"
        running_plan = PlanItem.create(text="Running plan")
        running_plan.status = "analyzing"
        running_plan.assigned_sub_agent_id = "sub_001"
        agent.state.plans.extend([pending_plan, paused_plan, running_plan])
        agent.state.master_agent_state.active_plan_ids = [running_plan.plan_id]

        agent.user_steer_queue.push("Stop all analysis.", kind="chat")
        handled = agent._process_user_steer()

        self.assertTrue(handled)
        self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "terminated")
        self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "terminated")
        self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")
        self.assertEqual(
            agent.state.get_plan_by_id(running_plan.plan_id).control_state,
            "terminate_requested",
        )
        self.assertTrue(
            any(
                entry.entry_type == "user_stop_request"
                for entry in agent.state.current_turn().timeline
            )
        )

    def test_build_llm_messages_highlights_latest_user_language_context(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        agent.state.user_messages.extend(
            [
                UserMessage.create(content="Use English first.", kind="chat"),
                UserMessage.create(
                    content="Legacy focus content",
                    kind="focus",
                    user_prompt="\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u8fd9\u4e2a\u95ee\u9898\u3002",
                ),
            ]
        )

        messages = agent._build_llm_messages()

        self.assertEqual(len(messages), 2)
        self.assertIn("Language-match priority:", messages[0]["content"])
        self.assertIn(
            "\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u8fd9\u4e2a\u95ee\u9898\u3002",
            messages[0]["content"],
        )
        self.assertIn("== LATEST USER MESSAGE FOR LANGUAGE MATCHING ==", messages[1]["content"])
        self.assertIn("kind: focus", messages[1]["content"])
        self.assertIn(
            "\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u5206\u6790\u8fd9\u4e2a\u95ee\u9898\u3002",
            messages[1]["content"],
        )
        self.assertNotIn("Prefer bullets.", messages[1]["content"])

    def test_build_llm_messages_surfaces_open_steering_follow_up_rule(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        turn = Turn(turn_id=0, goal="Analyze regional sales trends")
        agent.state.turns.append(turn)
        message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(message)
        agent._append_steering_message_to_turn(turn, message)

        messages = agent._build_llm_messages()

        self.assertIn("Open steering follow-up rule:", messages[0]["content"])
        self.assertIn(
            "You may still call evaluate_progress before handling those steering follow-ups",
            messages[0]["content"],
        )
        self.assertIn(
            "Do not call mark_complete while any open steering follow-up remains unresolved.",
            messages[0]["content"],
        )
        self.assertIn("== OPEN STEERING FOLLOW-UPS ==", messages[1]["content"])
        self.assertIn("TURN 0 FOCUS", messages[1]["content"])
        self.assertIn(
            "Focus the next follow-up on explaining the Q4 revenue spike.",
            messages[1]["content"],
        )

    def test_focus_steer_enters_current_turn_with_user_prompt_and_timeline_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_focus_structured", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            agent.user_steer_queue.push(
                "Focus prompt",
                kind="focus",
                display_text="Focus Revenue spike",
                generated_prompt="Legacy focus prompt",
                user_prompt='Focus follow-up analysis on the summary "Revenue spike".',
                system_prompt=(
                    "Focus steering semantics:\n"
                    "- Continue allocating attention around this summary target in subsequent planning."
                ),
                selected_keywords=["Revenue", "Q4"],
            )
            agent._process_user_steer()

            current_turn = agent.state.current_turn()
            self.assertIsNotNone(current_turn)
            self.assertEqual(
                current_turn.steers[-1],
                'Focus follow-up analysis on the summary "Revenue spike".',
            )
            self.assertEqual(current_turn.timeline[-1].entry_type, "user_steer")
            self.assertEqual(current_turn.timeline[-1].content["kind"], "focus")
            self.assertEqual(
                current_turn.timeline[-1].content["display_text"],
                "Focus Revenue spike",
            )
            self.assertEqual(
                current_turn.timeline[-1].content["user_prompt"],
                'Focus follow-up analysis on the summary "Revenue spike".',
            )
            self.assertEqual(
                current_turn.timeline[-1].content["system_prompt"],
                "Focus steering semantics:\n"
                "- Continue allocating attention around this summary target in subsequent planning.",
            )
            self.assertEqual(
                current_turn.timeline[-1].content["selected_keywords"],
                ["Revenue", "Q4"],
            )

    def test_elaborate_steer_enters_current_turn_with_user_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_elaborate_structured", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            agent.user_steer_queue.push(
                "Explain the root cause of the Q4 spike",
                kind="elaborate",
                display_text="Revenue spikes in Q4.",
                generated_prompt="Legacy elaborate prompt",
                user_prompt=(
                    'Elaborate on the summary "Revenue spike" by explaining what it means, '
                    "what drives it, and why it happens."
                ),
                system_prompt=(
                    "Elaborate steering semantics:\n"
                    "- Keep investigating the explanation, mechanism, and root causes of this specific insight."
                ),
                target=SteeringTargetSnapshot(
                    kind="summary",
                    summary_id="insight_q4",
                    summary_short_label="Revenue spike",
                    summary_text="Revenue spikes in Q4.",
                    columns=["Revenue", "Quarter"],
                ),
            )
            agent._process_user_steer()

            current_turn = agent.state.current_turn()
            self.assertIsNotNone(current_turn)
            self.assertEqual(
                current_turn.steers[-1],
                'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
            )
            self.assertEqual(current_turn.timeline[-1].entry_type, "user_steer")
            self.assertEqual(current_turn.timeline[-1].content["kind"], "elaborate")
            self.assertEqual(
                current_turn.timeline[-1].content["user_prompt"],
                'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
            )
            self.assertEqual(
                current_turn.timeline[-1].content["system_prompt"],
                "Elaborate steering semantics:\n"
                "- Keep investigating the explanation, mechanism, and root causes of this specific insight.",
            )
            self.assertEqual(
                current_turn.timeline[-1].content["target"]["summary_id"],
                "insight_q4",
            )

    def test_legacy_dive_into_alias_reopens_completed_run_as_focus(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_focus_resume", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            agent.state.status = "completed"
            agent.state.master_agent_state.completed = True
            current_turn = agent.state.current_turn()
            if current_turn is not None:
                current_turn.status = "completed"

            agent.user_steer_queue.push(
                "Legacy dive-into prompt",
                kind="dive_into",
                display_text="Focus Revenue spike",
                generated_prompt="Focus prompt",
            )
            agent._process_user_steer()

            resumed_turn = agent.state.current_turn()
            self.assertEqual(agent.state.status, "running")
            self.assertFalse(agent.state.master_agent_state.completed)
            self.assertIsNotNone(resumed_turn)
            self.assertEqual(resumed_turn.goal, "Focus prompt")
            self.assertEqual(resumed_turn.steers, ["Focus prompt"])
            self.assertEqual(resumed_turn.timeline[-1].entry_type, "user_steer")
            self.assertEqual(resumed_turn.timeline[-1].content["kind"], "focus")
            self.assertEqual(
                resumed_turn.timeline[-1].content["display_text"],
                "Focus Revenue spike",
            )

    def test_legacy_suppress_alias_records_ignore_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_ignore_structured", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            agent.user_steer_queue.push(
                "Legacy suppress prompt",
                kind="suppress",
                display_text="Ignore Revenue spike",
                generated_prompt="Ignore prompt",
            )
            agent._process_user_steer()

            current_turn = agent.state.current_turn()
            self.assertIsNotNone(current_turn)
            self.assertEqual(current_turn.steers[-1], "Ignore prompt")
            self.assertEqual(current_turn.timeline[-1].content["kind"], "ignore")
            self.assertEqual(
                current_turn.timeline[-1].content["display_text"],
                "Ignore Revenue spike",
            )

    def test_tool_create_plans_keeps_original_text_without_replay(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_plans_no_replay",
                base_dir=make_test_base_dir("run_create_plans_no_replay"),
            )
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            await agent._execute_tool_calls(
                [
                    {
                        "name": "create_plans",
                        "arguments": {
                            "plans": [
                                {"text": "Original first plan"},
                                {"text": "Original second plan"},
                            ]
                        },
                    }
                ]
            )

            self.assertEqual(
                [plan.text for plan in agent.state.plans],
                ["Original first plan", "Original second plan"],
            )

        asyncio.run(exercise())

    def test_tool_create_plans_replay_uses_cache_by_call_index(self) -> None:
        async def exercise() -> None:
            base_dir = make_test_base_dir("run_create_plans_replay")
            cache_path = base_dir / "cache.json"
            cache_path.write_text(
                json.dumps(
                    {
                        "1": ["Replay first plan", "Replay second plan"],
                        "2": ["Replay third plan"],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            run_store = RunStore(run_id="run_create_plans_replay", base_dir=base_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            with patch.dict("os.environ", {"AGENTIC_EDA_CREATE_PLANS_REPLAY": "1"}):
                with patch.object(
                    MasterAgent,
                    "_create_plans_replay_cache_path",
                    return_value=cache_path,
                ):
                    await agent._execute_tool_calls(
                        [
                            {
                                "name": "create_plans",
                                "arguments": {
                                    "plans": [
                                        {
                                            "text": "Original first plan",
                                            "source": "steer_follow_up",
                                            "message_id": "msg_first",
                                        }
                                    ]
                                },
                            }
                        ]
                    )
                    await agent._execute_tool_calls(
                        [
                            {
                                "name": "create_plans",
                                "arguments": {
                                    "plans": [
                                        {
                                            "text": "Original second plan",
                                            "source": "steer_follow_up",
                                            "message_id": "msg_second",
                                        }
                                    ]
                                },
                            }
                        ]
                    )

            self.assertEqual(
                [plan.text for plan in agent.state.plans],
                [
                    "Replay first plan",
                    "Replay second plan",
                    "Replay third plan",
                ],
            )
            current_turn = agent.state.current_turn()
            self.assertIsNotNone(current_turn)
            plan_created_entries = [
                entry
                for entry in current_turn.timeline
                if entry.entry_type == "plan_created"
            ]
            self.assertEqual(plan_created_entries[0].content["source"], "steer_follow_up")
            self.assertEqual(plan_created_entries[0].content["message_id"], "msg_first")
            self.assertEqual(plan_created_entries[-1].content["message_id"], "msg_second")

        asyncio.run(exercise())

    def test_tool_create_plans_replay_call_index_resumes_from_saved_timeline(self) -> None:
        async def exercise() -> None:
            base_dir = make_test_base_dir("run_create_plans_resume")
            cache_path = base_dir / "cache.json"
            cache_path.write_text(
                json.dumps(
                    {
                        "1": ["Replay first plan"],
                        "2": ["Replay second plan after resume"],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            run_store = RunStore(run_id="run_create_plans_resume", base_dir=base_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            with patch.dict("os.environ", {"AGENTIC_EDA_CREATE_PLANS_REPLAY": "1"}):
                with patch.object(
                    MasterAgent,
                    "_create_plans_replay_cache_path",
                    return_value=cache_path,
                ):
                    await agent._execute_tool_calls(
                        [
                            {
                                "name": "create_plans",
                                "arguments": {"plans": [{"text": "Original first plan"}]},
                            }
                        ]
                    )
                    run_store.save_state(agent.state)

                    resumed_agent = MasterAgent(store=run_store)
                    resumed_agent._initialize(
                        dataset_path="data/example.csv",
                        user_goal="Base goal",
                        dataset_info_override={"rows": 1, "columns": []},
                        resume=True,
                    )
                    await resumed_agent._execute_tool_calls(
                        [
                            {
                                "name": "create_plans",
                                "arguments": {"plans": [{"text": "Original second plan"}]},
                            }
                        ]
                    )

            self.assertEqual(
                [plan.text for plan in resumed_agent.state.plans],
                ["Replay first plan", "Replay second plan after resume"],
            )

        asyncio.run(exercise())

    def test_tool_create_plans_replay_falls_back_when_cache_missing_or_invalid(self) -> None:
        async def run_case(cache_path: Path, raw_cache: str | None) -> None:
            if raw_cache is not None:
                cache_path.write_text(raw_cache, encoding="utf-8")
            run_store = RunStore(
                run_id=f"run_create_plans_fallback_{cache_path.stem}",
                base_dir=make_test_base_dir(f"run_create_plans_fallback_{cache_path.stem}"),
            )
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            with patch.dict("os.environ", {"AGENTIC_EDA_CREATE_PLANS_REPLAY": "1"}):
                with patch.object(
                    MasterAgent,
                    "_create_plans_replay_cache_path",
                    return_value=cache_path,
                ):
                    await agent._execute_tool_calls(
                        [
                            {
                                "name": "create_plans",
                                "arguments": {"plans": [{"text": "Original fallback plan"}]},
                            }
                        ]
                    )

            self.assertEqual([plan.text for plan in agent.state.plans], ["Original fallback plan"])

        async def exercise() -> None:
            base_dir = make_test_base_dir("run_create_plans_fallback_cases")
            await run_case(base_dir / "missing-cache.json", None)
            await run_case(
                base_dir / "invalid-cache.json",
                json.dumps({"1": ["", 2]}, ensure_ascii=False, indent=2),
            )

        asyncio.run(exercise())

    def test_tool_create_plans_rejects_reused_goal_user_message_and_plan_texts(self) -> None:
        run_store = RunStore(
            run_id="run_create_plans_rejects_reused_text",
            base_dir=make_test_base_dir("run_create_plans_rejects_reused_text"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Comprehensively and deeply explore this dataset.",
            dataset_info_override={"rows": 1, "columns": []},
        )

        first_result = agent._tool_create_plans({
            "plans": [{"text": "Analyze shot distribution by team."}]
        })
        self.assertEqual(len(first_result["created_plan_ids"]), 1)

        focus_message = UserMessage.create(
            content="In follow-up analysis, prioritize shooting efficiency for this summary.",
            kind="focus",
            generated_prompt="In follow-up analysis, prioritize shooting efficiency for this summary.",
        )
        agent.state.user_messages.append(focus_message)
        current_turn = agent.state.current_turn()
        self.assertIsNotNone(current_turn)
        agent._append_steering_message_to_turn(current_turn, focus_message)

        result = agent._tool_create_plans(
            {
                "plans": [
                    {"text": "Comprehensively and deeply explore this dataset."},
                    {"text": "In follow-up analysis, prioritize shooting efficiency for this summary."},
                    {"text": "Analyze shot distribution by team."},
                    {"text": "Validate the shooting efficiency gap by shot type and team."},
                ]
            }
        )

        self.assertEqual(
            [plan.text for plan in agent.state.plans],
            [
                "Analyze shot distribution by team.",
                "Validate the shooting efficiency gap by shot type and team.",
            ],
        )
        self.assertEqual(
            [item["reason"] for item in result["rejected_plans"]],
            [
                "duplicate_turn_goal",
                "duplicate_user_message",
                "duplicate_existing_plan",
            ],
        )

    def test_create_steer_queues_pending_dispatch_when_no_unresolved_batch_exists(self) -> None:
        run_store = RunStore(
            run_id="run_create_running_turn",
            base_dir=make_test_base_dir("run_create_running_turn"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        plan_text = "Check whether Q4 growth is concentrated in a single segment"
        agent.user_steer_queue.push(
            plan_text,
            kind="create",
            display_text=plan_text,
            generated_prompt="",
        )
        agent._process_user_steer()

        current_turn = agent.state.current_turn()
        self.assertIsNotNone(current_turn)
        self.assertEqual(current_turn.steers[-1], plan_text)
        self.assertEqual(current_turn.timeline[-2].entry_type, "user_steer")
        self.assertEqual(current_turn.timeline[-2].content["kind"], "create")
        self.assertEqual(current_turn.timeline[-2].content["generated_prompt"], "")
        self.assertEqual(current_turn.timeline[-1].entry_type, "plan_created")
        self.assertEqual(current_turn.timeline[-1].content["plan_text"], plan_text)
        self.assertEqual(len(agent.state.plans), 1)
        self.assertEqual(agent.state.plans[0].text, plan_text)
        self.assertEqual(
            agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
            [agent.state.plans[0].plan_id],
        )
        self.assertEqual(len(agent.state.master_agent_state.dispatch_batches), 0)
        event_lines = run_store.events_path.read_text(encoding="utf-8")
        self.assertIn('"event_type": "plan_created"', event_lines)

    def test_create_steer_reopens_completed_run_and_creates_single_goal_plan(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_create_resume", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            agent.state.status = "completed"
            agent.state.master_agent_state.completed = True
            current_turn = agent.state.current_turn()
            if current_turn is not None:
                current_turn.status = "completed"

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            resumed_turn = agent.state.current_turn()
            self.assertEqual(agent.state.status, "running")
            self.assertFalse(agent.state.master_agent_state.completed)
            self.assertIsNotNone(resumed_turn)
            self.assertEqual(resumed_turn.goal, plan_text)
            self.assertEqual(resumed_turn.steers, [plan_text])
            self.assertEqual(len(agent.state.plans), 1)
            self.assertEqual(agent.state.plans[0].text, plan_text)

    def test_create_turn_goal_uses_runtime_pending_dispatch_queue_instead_of_fallback(self) -> None:
        run_store = RunStore(
            run_id="run_create_no_duplicate_fallback",
            base_dir=make_test_base_dir("run_create_no_duplicate_fallback"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )
        agent.state.status = "completed"
        agent.state.master_agent_state.completed = True
        current_turn = agent.state.current_turn()
        if current_turn is not None:
            current_turn.status = "completed"

        plan_text = "Check whether Q4 growth is concentrated in a single segment"
        agent.user_steer_queue.push(
            plan_text,
            kind="create",
            display_text=plan_text,
            generated_prompt="",
        )
        agent._process_user_steer()

        self.assertEqual(agent._fallback_decision(), [])
        self.assertEqual(
            agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
            [agent.state.plans[0].plan_id],
        )

    def test_user_created_pending_plan_unblocks_paused_batch_wait(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_create_unblocks_paused_batch", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            paused_plan = PlanItem.create(text="Paused investigation")
            paused_plan.status = "paused"
            agent.state.plans.append(paused_plan)
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[paused_plan.plan_id],
                    status="dispatched",
                )
            ]

            self.assertTrue(agent._should_wait_for_paused_batch())

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            self.assertFalse(agent._should_wait_for_paused_batch())

    def test_fallback_decision_does_not_auto_dispatch_pending_from_blocked_batch(self) -> None:
        run_store = RunStore(
            run_id="run_blocked_batch_no_fallback_dispatch",
            base_dir=make_test_base_dir("run_blocked_batch_no_fallback_dispatch"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        paused_plan = PlanItem.create(text="Paused investigation")
        paused_plan.status = "paused"
        pending_plan = PlanItem.create(text="Pending investigation")
        agent.state.plans.extend([paused_plan, pending_plan])
        current_turn = agent.state.current_turn()
        if current_turn is not None:
            current_turn.goal = pending_plan.text
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[paused_plan.plan_id, pending_plan.plan_id],
                status="dispatched",
            )
        ]

        self.assertTrue(agent._should_wait_for_paused_batch())
        self.assertEqual(agent._fallback_decision(), [])

    def test_pending_direct_user_create_dispatch_queue_takes_priority_over_fallback_dispatch(self) -> None:
        run_store = RunStore(
            run_id="run_create_dispatch_priority",
            base_dir=make_test_base_dir("run_create_dispatch_priority"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store, settings=RunSettings(max_concurrency=3))
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        older_pending = PlanItem.create(text="Older pending plan")
        second_pending = PlanItem.create(text="Another pending plan")
        agent.state.plans.extend([older_pending, second_pending])

        plan_text = "Check whether Q4 growth is concentrated in a single segment"
        agent.user_steer_queue.push(
            plan_text,
            kind="create",
            display_text=plan_text,
            generated_prompt="",
        )
        agent._process_user_steer()

        latest_plan = agent.state.plans[-1]
        self.assertEqual(agent._fallback_decision(), [])
        self.assertEqual(
            agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
            [latest_plan.plan_id],
        )

    def test_dispatch_plans_can_dispatch_the_new_user_create_batch_without_attaching_unrelated_pending_plans(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_single_dispatch",
                base_dir=make_test_base_dir("run_create_single_dispatch"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=3),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            older_pending = PlanItem.create(text="Older pending plan")
            second_pending = PlanItem.create(text="Another pending plan")
            agent.state.plans.extend([older_pending, second_pending])

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            latest_plan = agent.state.plans[-1]
            result = await agent._tool_dispatch_plans({"plan_ids": [latest_plan.plan_id]})

            self.assertEqual(result["dispatched_plan_ids"], [latest_plan.plan_id])
            self.assertEqual(result["dispatch_turn_index"], 0)
            self.assertEqual(latest_plan.status, "analyzing")
            self.assertEqual(older_pending.status, "pending")
            self.assertEqual(second_pending.status, "pending")
            self.assertEqual(len(agent.state.master_agent_state.dispatch_batches), 1)
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [latest_plan.plan_id],
            )
            self.assertEqual(
                agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
                [],
            )

        asyncio.run(exercise())

    def test_create_steer_directly_launches_new_plan_inside_running_batch_when_capacity_is_available(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_join_running_dispatch",
                base_dir=make_test_base_dir("run_create_join_running_dispatch"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=2),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Already running plan")
            agent.state.plans.append(running_plan)
            first_dispatch = await agent._tool_dispatch_plans({"plan_ids": [running_plan.plan_id]})

            self.assertEqual(first_dispatch["dispatched_plan_ids"], [running_plan.plan_id])
            self.assertEqual(first_dispatch["dispatch_turn_index"], 0)
            self.assertEqual(len(agent.state.master_agent_state.dispatch_batches), 1)

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            latest_plan = agent.state.plans[-1]
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [running_plan.plan_id, latest_plan.plan_id],
            )

            await agent._process_pending_direct_user_create_launches()

            self.assertEqual(running_plan.status, "analyzing")
            self.assertEqual(latest_plan.status, "analyzing")
            self.assertEqual(len(agent.state.master_agent_state.dispatch_batches), 1)
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [running_plan.plan_id, latest_plan.plan_id],
            )

        asyncio.run(exercise())

    def test_create_steer_direct_launch_only_starts_the_new_plan_when_existing_batch_is_pending_or_paused(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_launches_without_disturbing_blocked_batch",
                base_dir=make_test_base_dir("run_create_launches_without_disturbing_blocked_batch"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            paused_plan = PlanItem.create(text="Paused investigation")
            paused_plan.status = "paused"
            older_pending = PlanItem.create(text="Older pending investigation")
            older_pending.status = "pending"
            agent.state.plans.extend([paused_plan, older_pending])
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[paused_plan.plan_id, older_pending.plan_id],
                    status="dispatched",
                )
            ]

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            latest_plan = agent.state.plans[-1]
            await agent._process_pending_direct_user_create_launches()

            self.assertEqual(paused_plan.status, "paused")
            self.assertEqual(older_pending.status, "pending")
            self.assertEqual(latest_plan.status, "analyzing")
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [paused_plan.plan_id, older_pending.plan_id, latest_plan.plan_id],
            )
            self.assertEqual(sorted(agent._active_tasks.keys()), [latest_plan.plan_id])

        asyncio.run(exercise())

    def test_create_steer_keeps_new_plan_pending_when_current_batch_is_at_concurrency_limit(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_waits_for_capacity",
                base_dir=make_test_base_dir("run_create_waits_for_capacity"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Already running plan")
            agent.state.plans.append(running_plan)
            await agent._tool_dispatch_plans({"plan_ids": [running_plan.plan_id]})

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            latest_plan = agent.state.plans[-1]
            self.assertEqual(latest_plan.status, "pending")
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [running_plan.plan_id, latest_plan.plan_id],
            )

        asyncio.run(exercise())

    def test_create_steer_launches_from_terminal_release_seat_fill_after_waiting_for_capacity(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_seat_fill_after_terminal_release",
                base_dir=make_test_base_dir("run_create_seat_fill_after_terminal_release"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Already running plan")
            agent.state.plans.append(running_plan)
            await agent._tool_dispatch_plans({"plan_ids": [running_plan.plan_id]})

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            latest_plan = agent.state.plans[-1]
            self.assertEqual(latest_plan.status, "pending")

            await asyncio.sleep(0.12)
            self.assertTrue(await agent._collect_finished_sub_agents())

            self.assertEqual(latest_plan.status, "analyzing")
            self.assertEqual(sorted(agent._active_tasks.keys()), [latest_plan.plan_id])

        asyncio.run(exercise())

    def test_create_steer_waits_in_pending_dispatch_queue_when_all_existing_batches_are_terminal(self) -> None:
        run_store = RunStore(
            run_id="run_create_opens_new_batch",
            base_dir=make_test_base_dir("run_create_opens_new_batch"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        completed_plan = PlanItem.create(text="Finished analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[completed_plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        plan_text = "Check whether Q4 growth is concentrated in a single segment"
        agent.user_steer_queue.push(
            plan_text,
            kind="create",
            display_text=plan_text,
            generated_prompt="",
        )
        agent._process_user_steer()

        latest_plan = agent.state.plans[-1]
        self.assertEqual(len(agent.state.master_agent_state.dispatch_batches), 1)
        self.assertEqual(
            agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
            [latest_plan.plan_id],
        )
        self.assertIsNone(agent._build_next_pending_direct_user_create_dispatch_tool_call())

    def test_create_acknowledgement_stays_ahead_of_pending_direct_user_create_dispatch(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_ack_then_dispatch",
                base_dir=make_test_base_dir("run_create_ack_then_dispatch"),
            )
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            agent.state.master_agent_state.pending_user_response_message_ids = []

            completed_plan = PlanItem.create(text="Finished analysis")
            completed_plan.status = "completed"
            agent.state.plans.append(completed_plan)
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[completed_plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            self.assertIsNone(agent._build_next_pending_direct_user_create_dispatch_tool_call())
            acknowledgement = agent._build_next_pending_user_response_tool_call()
            self.assertIsNotNone(acknowledgement)
            self.assertEqual(acknowledgement["name"], "respond_to_user")
            await agent._execute_tool_calls([acknowledgement])

            self.assertEqual(agent.state.master_agent_state.pending_user_response_message_ids, [])
            dispatch_call = agent._build_next_pending_direct_user_create_dispatch_tool_call()
            self.assertIsNotNone(dispatch_call)
            self.assertEqual(dispatch_call["name"], "dispatch_plans")

        asyncio.run(exercise())

    def test_stop_acknowledgement_clears_pending_direct_user_create_dispatch_queue(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_stop_clears_pending_create_dispatch",
                base_dir=make_test_base_dir("run_stop_clears_pending_create_dispatch"),
            )
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            agent.state.master_agent_state.pending_user_response_message_ids = []

            completed_plan = PlanItem.create(text="Finished analysis")
            completed_plan.status = "completed"
            agent.state.plans.append(completed_plan)
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[completed_plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            queued_plan_id = agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids[0]
            create_acknowledgement = agent._build_next_pending_user_response_tool_call()
            self.assertIsNotNone(create_acknowledgement)
            await agent._execute_tool_calls([create_acknowledgement])

            agent.user_steer_queue.push("Stop all analysis.", kind="chat")
            self.assertTrue(agent._process_user_steer())
            stop_message = agent.state.user_messages[-1]
            await agent._execute_tool_calls(
                [
                    {
                        "name": "respond_to_user",
                        "arguments": {
                            "message": "I will let the current work finish and then wrap up the run."
                        },
                        "_pending_user_response_message_id": stop_message.message_id,
                        "_probable_stop": True,
                    }
                ]
            )

            self.assertEqual(
                agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
                [],
            )
            self.assertEqual(agent.state.get_plan_by_id(queued_plan_id).status, "terminated")
            self.assertIsNone(agent._build_next_pending_direct_user_create_dispatch_tool_call())

        asyncio.run(exercise())

    def test_resume_restores_pending_direct_user_create_dispatch_queue_and_dispatches_once(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_create_resume_dispatch_queue",
                base_dir=make_test_base_dir("run_create_resume_dispatch_queue"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            agent.state.master_agent_state.pending_user_response_message_ids = []

            completed_plan = PlanItem.create(text="Finished analysis")
            completed_plan.status = "completed"
            agent.state.plans.append(completed_plan)
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[completed_plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            plan_text = "Check whether Q4 growth is concentrated in a single segment"
            agent.user_steer_queue.push(
                plan_text,
                kind="create",
                display_text=plan_text,
                generated_prompt="",
            )
            agent._process_user_steer()

            create_message = agent.state.user_messages[-1]
            queued_plan_id = agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids[0]
            agent._acknowledge_pending_user_response(create_message.message_id)
            run_store.save_state(agent.state)

            resumed_agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            resumed_agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
                resume=True,
            )

            dispatch_call = resumed_agent._build_next_pending_direct_user_create_dispatch_tool_call()
            self.assertEqual(
                dispatch_call,
                {
                    "name": "dispatch_plans",
                    "arguments": {"plan_ids": [queued_plan_id]},
                    "_runtime_internal_pending_direct_user_create_dispatch": True,
                },
            )

            result = await resumed_agent._tool_dispatch_plans({"plan_ids": [queued_plan_id]})
            self.assertEqual(result["dispatch_turn_index"], 1)
            self.assertEqual(result["plan_ids"], [queued_plan_id])
            self.assertEqual(
                resumed_agent.state.master_agent_state.pending_direct_user_create_dispatch_plan_ids,
                [],
            )
            run_store.save_state(resumed_agent.state)

            reloaded_agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            reloaded_agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
                resume=True,
            )

            self.assertIsNone(
                reloaded_agent._build_next_pending_direct_user_create_dispatch_tool_call()
            )
            self.assertEqual(
                reloaded_agent.state.master_agent_state.dispatch_batches[-1].plan_ids,
                [queued_plan_id],
            )

        asyncio.run(exercise())

    def test_post_steer_guard_no_longer_drops_summary_or_completion_after_steering(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)
        message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(message)
        agent._append_steering_message_to_turn(turn, message)

        guarded = agent._ensure_post_steer_follow_up_planning(
            [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {
                                "text": "Investigate the Q4 revenue spike by testing pricing, mix shift, and seasonality explanations."
                            }
                        ]
                    },
                },
                {
                    "name": "mark_complete",
                    "arguments": {"summary": "Should not complete yet."},
                },
                {
                    "name": "respond_to_user",
                    "arguments": {"message": "Should not emit the completion reply yet."},
                },
            ]
        )

        self.assertEqual(
            guarded,
            [
                {
                    "name": "create_plans",
                    "arguments": {
                        "plans": [
                            {
                                "text": "Investigate the Q4 revenue spike by testing pricing, mix shift, and seasonality explanations."
                            }
                        ]
                    },
                },
                {
                    "name": "mark_complete",
                    "arguments": {"summary": "Should not complete yet."},
                },
                {
                    "name": "respond_to_user",
                    "arguments": {"message": "Should not emit the completion reply yet."},
                },
            ],
        )

    def test_fallback_decision_no_longer_waits_for_post_steer_create_before_completion(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)
        message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(message)
        agent._append_steering_message_to_turn(turn, message)

        completed_plan = PlanItem.create(text="Existing completed work")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.insights.append(
            Insight.create(
                plan_id=completed_plan.plan_id,
                summary="Q4 revenue increased sharply.",
            )
        )

        decision = agent._fallback_decision()

        self.assertEqual(
            [item["name"] for item in decision],
            [
                "synthesize_findings",
                "mark_complete",
            ],
        )

    def test_tool_create_plans_records_recent_steering_follow_up_status(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)
        message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(message)
        agent._append_steering_message_to_turn(turn, message)

        result = agent._tool_create_plans(
            {
                "plans": [
                    {
                        "text": "Investigate the Q4 revenue spike by testing pricing, mix shift, and seasonality explanations."
                    }
                ]
            }
        )

        self.assertEqual(result["recorded_steering_message_ids"], [message.message_id])
        self.assertEqual(len(result["created_plan_ids"]), 1)
        self.assertTrue(turn.timeline[-1].content["follow_up_plan_create_recorded"])
        self.assertEqual(
            turn.timeline[-1].content["follow_up_created_plan_ids"],
            result["created_plan_ids"],
        )

    def test_latest_post_steer_follow_up_state_ignores_latest_stop_intent_chat(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)

        focus_message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(focus_message)
        agent._append_steering_message_to_turn(turn, focus_message)

        stop_message = UserMessage.create(
            content="Stop all analysis.",
            kind="chat",
        )
        agent.state.user_messages.append(stop_message)

        self.assertIsNone(agent._latest_post_steer_follow_up_state())

    def test_fallback_decision_allows_generic_goal_fallback_for_latest_non_stop_chat(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)

        completed_plan = PlanItem.create(text="Existing completed work")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)

        chat_message = UserMessage.create(
            content="Please keep going from here.",
            kind="chat",
        )
        agent.state.user_messages.append(chat_message)
        agent._append_steering_message_to_turn(turn, chat_message)

        decision = agent._fallback_decision()

        self.assertEqual([item["name"] for item in decision], ["create_plans"])
        self.assertEqual(
            decision[0]["arguments"]["plans"][0]["source"],
            "current_goal_fallback",
        )
        result = agent._tool_create_plans(decision[0]["arguments"])
        self.assertEqual(len(result["created_plan_ids"]), 1)
        self.assertEqual(result["rejected_plans"], [])

    def test_batch_finished_user_response_is_stop_aware(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        agent.state.user_messages.append(
            UserMessage.create(content="Stop all analysis.", kind="chat")
        )
        completed_plan = PlanItem.create(text="Finished analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[completed_plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        tool_call = agent._build_next_batch_finished_user_response_tool_call()

        self.assertIsNotNone(tool_call)
        self.assertIn("won't open more plans", tool_call["arguments"]["message"])
        self.assertNotIn("more plans are still needed", tool_call["arguments"]["message"])

    def test_summary_tools_are_blocked_until_all_plans_are_terminal(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        agent.state.plans.append(PlanItem.create(text="Pending work"))

        filtered = agent._filter_summary_tool_calls_until_all_plans_terminal(
            [
                {"name": "evaluate_progress", "arguments": {"stage_summary_markdown": "Checkpoint."}},
                {"name": "synthesize_findings", "arguments": {"synthesis": "Done."}},
                {"name": "mark_complete", "arguments": {"summary": "Done."}},
            ]
        )

        self.assertEqual(filtered, [])

    def test_batch_finished_user_response_emits_once_per_terminal_batch(self) -> None:
        async def exercise() -> None:
            store = RecordingStore()
            agent = MasterAgent(store=store)
            agent.state = RunState.create(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                settings=RunSettings(max_concurrency=1),
            )
            agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
            completed_plan = PlanItem.create(text="Finished analysis")
            completed_plan.status = "completed"
            agent.state.plans.append(completed_plan)
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[completed_plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            first_tool_call = agent._build_next_batch_finished_user_response_tool_call()
            self.assertIsNotNone(first_tool_call)
            await agent._execute_tool_calls([first_tool_call])

            self.assertEqual(
                [tool_name for tool_name, _result in store.tool_results[-1:]],
                ["respond_to_user"],
            )
            self.assertEqual(store.events[-1][0], "user_response")
            self.assertTrue(
                agent.state.master_agent_state.dispatch_batches[0].batch_finished_user_response_emitted
            )
            self.assertIsNone(agent._build_next_batch_finished_user_response_tool_call())

        asyncio.run(exercise())

    def test_call_llm_includes_non_system_message_for_gemini_compatible_backends(self) -> None:
        class FakeResponse:
            def __init__(self) -> None:
                self.choices = [type("Choice", (), {"message": type("Message", (), {"tool_calls": []})()})]

        class FakeClient:
            class _Chat:
                class _Completions:
                    @staticmethod
                    def create(**kwargs):
                        messages = kwargs["messages"]
                        non_system = [message for message in messages if message.get("role") != "system"]
                        if not non_system:
                            raise AssertionError("expected at least one non-system message")
                        return FakeResponse()

                completions = _Completions()

            chat = _Chat()

        run_store = RunStore(
            run_id="run_llm_payload",
            base_dir=make_test_base_dir("run_llm_payload"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", FakeClient()
        ):
            asyncio.run(agent._call_llm())

    def test_call_llm_without_language_retry_does_not_crash(self) -> None:
        class FakeResponse:
            def __init__(self) -> None:
                self.choices = [type("Choice", (), {"message": type("Message", (), {"tool_calls": []})()})]

        class FakeClient:
            def __init__(self) -> None:
                self.requests: list[dict] = []

                class _Completions:
                    def __init__(self, outer: "FakeClient") -> None:
                        self._outer = outer

                    def create(self, **kwargs):
                        self._outer.requests.append(kwargs)
                        return FakeResponse()

                class _Chat:
                    def __init__(self, outer: "FakeClient") -> None:
                        self.completions = _Completions(outer)

                self.chat = _Chat(self)

        run_store = RunStore(
            run_id="run_llm_no_retry",
            base_dir=make_test_base_dir("run_llm_no_retry"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        fake_client = FakeClient()
        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", fake_client
        ):
            tool_calls, timestamp_binding = asyncio.run(agent._call_llm())

        self.assertEqual(tool_calls, [])
        self.assertIsNone(timestamp_binding)
        self.assertEqual(len(fake_client.requests), 1)

    def test_master_agent_emits_progress_messages(self) -> None:
        messages: list[str] = []
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_progress", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: FakeSubAgent(),
                idle_timeout_seconds=0.0,
                progress_callback=messages.append,
            )

            asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Understand regional sales differences",
                    dataset_info_override={"rows": 10, "columns": []},
                )
            )

        self.assertTrue(any("Run initialized" in message for message in messages))
        self.assertTrue(any("Loop" in message for message in messages))
        self.assertTrue(any("Plan" in message for message in messages))

    def test_initialize_records_initial_goal_as_user_message_and_event(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_initial_goal", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Understand regional sales differences",
                dataset_info_override={"rows": 10, "columns": []},
            )

            self.assertEqual(len(agent.state.user_messages), 1)
            self.assertEqual(
                agent.state.user_messages[0].content,
                "Understand regional sales differences",
            )
            event_lines = run_store.events_path.read_text(encoding="utf-8")
            self.assertIn('"event_type": "user_steer_received"', event_lines)
            # Verify turn 0 was created with correct goal
            self.assertEqual(len(agent.state.turns), 1)
            self.assertEqual(agent.state.turns[0].goal, "Understand regional sales differences")

    def test_completed_run_resumes_when_follow_up_goal_arrives(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_idle_resume", base_dir=temp_dir)
                run_store.initialize()
                agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.05,
                )

                task = asyncio.create_task(
                    agent.run(
                        dataset_path="data/example.csv",
                        user_goal="Initial goal",
                        dataset_info_override={"rows": 10, "columns": [{"name": "Region"}]},
                    )
                )

                for _ in range(200):
                    await asyncio.sleep(0.01)
                    if agent.state is not None and agent.state.status == "completed":
                        break
                else:
                    self.fail("agent never entered completed waiting state")

                agent.user_steer_queue.push("Follow-up goal")
                state = await task

                self.assertEqual(state.status, "completed")
                self.assertEqual(len(state.user_messages), 2)
                self.assertTrue(any(plan.text == "Initial goal" for plan in state.plans))
                self.assertTrue(any(plan.text == "Follow-up goal" for plan in state.plans))
                self.assertTrue(any(insight.summary == "Follow-up goal" for insight in state.insights))

        asyncio.run(exercise())

    def test_completed_run_uses_first_new_message_as_goal_and_later_messages_as_steers(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_followup_batch", base_dir=temp_dir)
                run_store.initialize()
                agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.05,
                )

                task = asyncio.create_task(
                    agent.run(
                        dataset_path="data/example.csv",
                        user_goal="Initial goal",
                        dataset_info_override={"rows": 10, "columns": [{"name": "Region"}]},
                    )
                )

                for _ in range(200):
                    await asyncio.sleep(0.01)
                    if agent.state is not None and agent.state.status == "completed":
                        break
                else:
                    self.fail("agent never entered completed waiting state")

                agent.user_steer_queue.push("Next goal")
                agent.user_steer_queue.push("Please compare Europe too")
                state = await task

                latest_turn = state.turns[-1]
                self.assertEqual(latest_turn.goal, "Next goal")
                self.assertEqual(latest_turn.steers, ["Please compare Europe too"])
                self.assertTrue(any(plan.text == "Next goal" for plan in state.plans))

        asyncio.run(exercise())

    def test_run_can_resume_from_persisted_state_after_process_restart(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_restart_resume", base_dir=temp_dir)
                run_store.initialize()

                initial_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=2, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                first_state = await initial_agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Initial goal",
                    dataset_info_override={"rows": 10, "columns": [{"name": "Region"}]},
                )
                self.assertEqual(first_state.status, "completed")

                run_store.append_steer_message(UserMessage.create("Follow-up after restart"))

                resumed_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.5),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.05,
                )
                resumed_state = await resumed_agent.run(
                    dataset_path="data/example.csv",
                    user_goal="",
                    resume=True,
                )

                self.assertEqual(resumed_state.run_id, first_state.run_id)
                self.assertEqual(resumed_state.status, "completed")
                self.assertEqual(resumed_agent.settings.max_concurrency, 2)
                self.assertEqual(resumed_agent.settings.poll_interval_seconds, 0.01)
                self.assertEqual(len(resumed_state.user_messages), 2)
                self.assertTrue(any(plan.text == "Initial goal" for plan in resumed_state.plans))
                self.assertTrue(any(plan.text == "Follow-up after restart" for plan in resumed_state.plans))
                self.assertTrue(
                    any(
                        insight.summary == "Follow-up after restart"
                        for insight in resumed_state.insights
                    )
                )

        asyncio.run(exercise())

    def test_resume_requeues_orphaned_work_and_clears_stale_stop_file(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_resume_requeue", base_dir=temp_dir)
                run_store.initialize()

                state = RunState.create(
                    dataset_path="data/example.csv",
                    user_goal="Initial goal",
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                )
                state.run_id = run_store.run_id
                orphan_plan = PlanItem.create(text="Recovered pending work")
                orphan_plan.status = "analyzing"
                orphan_plan.assigned_sub_agent_id = "sub_001"
                state.plans.append(orphan_plan)
                state.status = "completed"
                state.master_agent_state.completed = True
                state.master_agent_state.active_plan_ids = [orphan_plan.plan_id]
                run_store.save_state(state)
                (run_store.run_dir / "STOP").write_text("stop requested\n", encoding="utf-8")

                resumed_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.5),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                resumed_state = await resumed_agent.run(
                    dataset_path="data/example.csv",
                    user_goal="",
                    resume=True,
                )

                self.assertFalse((run_store.run_dir / "STOP").exists())
                self.assertEqual(resumed_state.status, "completed")
                self.assertFalse(resumed_state.master_agent_state.active_plan_ids)
                self.assertTrue(resumed_state.master_agent_state.completed)
                self.assertTrue(any(plan.text == "Recovered pending work" and plan.status == "completed" for plan in resumed_state.plans))
                self.assertTrue(any(insight.summary == "Recovered pending work" for insight in resumed_state.insights))

        asyncio.run(exercise())

    def test_resume_uses_provided_message_identity(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_resume_identity", base_dir=temp_dir)
                run_store.initialize()

                initial_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                await initial_agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Initial goal",
                    dataset_info_override={"rows": 10, "columns": [{"name": "Region"}]},
                )

                resume_message = UserMessage(
                    message_id="msg_gateway_resume",
                    timestamp="2026-03-08T13:14:15.988Z",
                    content="Resume with same identity",
                )
                resumed_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                resumed_state = await resumed_agent.run(
                    dataset_path="data/example.csv",
                    user_goal="",
                    resume=True,
                    resume_message=resume_message,
                )

                self.assertTrue(
                    any(
                        message.message_id == resume_message.message_id
                        and message.timestamp == resume_message.timestamp
                        and message.content == resume_message.content
                        for message in resumed_state.user_messages
                    )
                )

        asyncio.run(exercise())

    def test_timeline_entries_created_during_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_timeline", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                decision_provider=scripted_decider,
                sub_agent_factory=lambda: FakeSubAgent(),
                idle_timeout_seconds=0.0,
            )

            state = asyncio.run(
                agent.run(
                    dataset_path="data/example.csv",
                    user_goal="Analyze stuff",
                    dataset_info_override={
                        "rows": 10,
                        "columns": [{"name": "Region", "dtype": "object"}],
                        "sample_rows": [{"Region": "North"}],
                    },
                )
            )

            self.assertTrue(len(state.turns) >= 1)
            turn = state.turns[0]
            entry_types = [e.entry_type for e in turn.timeline]
            self.assertIn("create_plans", entry_types)
            self.assertIn("dispatch_plans", entry_types)
            self.assertIn("plans_completed", entry_types)
            self.assertIn("mark_complete", entry_types)

    def test_resume_from_old_state_without_turns(self) -> None:
        """Resuming from an old state.json that lacks the 'turns' key bootstraps a Turn."""
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                run_store = RunStore(run_id="run_old_state", base_dir=temp_dir)
                run_store.initialize()

                # Simulate old state.json without turns
                state = RunState.create(
                    dataset_path="data/example.csv",
                    user_goal="Old goal",
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                )
                state.run_id = run_store.run_id
                state.status = "completed"
                state.master_agent_state.completed = True
                state.master_agent_state.current_goals = ["Old goal"]
                # Explicitly empty turns (simulates old format)
                state.turns = []
                run_store.save_state(state)
                # Remove turns from serialized json to simulate old format
                import json
                state_dict = json.loads(run_store.state_path.read_text(encoding="utf-8"))
                state_dict.pop("turns", None)
                run_store.state_path.write_text(json.dumps(state_dict), encoding="utf-8")

                run_store.append_steer_message(UserMessage.create("New goal"))
                agent = MasterAgent(
                    store=run_store,
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                resumed_state = await agent.run(
                    dataset_path="data/example.csv",
                    user_goal="",
                    resume=True,
                )

                # Should have bootstrapped at least one Turn
                self.assertTrue(len(resumed_state.turns) >= 1)
                self.assertEqual(resumed_state.turns[0].goal, "Old goal")

        asyncio.run(exercise())
    def test_resume_updates_dataset_path_when_gateway_supplies_a_relocated_dataset(self) -> None:
        async def exercise() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                stale_dataset_path = str(Path(temp_dir) / 'legacy-repo' / 'data' / 'example.csv')
                current_dataset_path = Path(temp_dir) / 'current-repo' / 'data' / 'example.csv'
                current_dataset_path.parent.mkdir(parents=True, exist_ok=True)
                current_dataset_path.write_text('Region,Sales\nNorth,10\n', encoding='utf-8')

                run_store = RunStore(run_id='run_relocated_dataset', base_dir=temp_dir)
                run_store.initialize()
                initial_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                first_state = await initial_agent.run(
                    dataset_path=stale_dataset_path,
                    user_goal='Initial goal',
                    dataset_info_override={'rows': 10, 'columns': [{'name': 'Region'}]},
                )
                self.assertEqual(first_state.dataset_path, stale_dataset_path)

                run_store.append_steer_message(UserMessage.create('Continue with relocated dataset'))
                resumed_agent = MasterAgent(
                    store=run_store,
                    settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                    sub_agent_factory=lambda: EchoInsightSubAgent(),
                    idle_timeout_seconds=0.0,
                )
                resumed_state = await resumed_agent.run(
                    dataset_path=str(current_dataset_path),
                    user_goal='',
                    resume=True,
                )

                self.assertEqual(resumed_state.dataset_path, str(current_dataset_path))
                self.assertEqual(resumed_state.dataset_info.get('dataset_path'), str(current_dataset_path))
                self.assertIn(
                    build_dataset_identity(str(current_dataset_path), resumed_state.dataset_info),
                    resumed_state.dataset_schema,
                )
                self.assertNotIn(str(current_dataset_path), resumed_state.dataset_schema)

        asyncio.run(exercise())

    def test_dispatch_batch_no_longer_forces_stage_summary_before_mark_complete(self) -> None:
        run_store = RunStore(
            run_id="run_stage_summary_first",
            base_dir=make_test_base_dir("run_stage_summary_first"),
        )
        run_store.initialize()
        agent = MasterAgent(
            store=run_store,
            settings=RunSettings(max_concurrency=1),
            decision_provider=eager_completion_decider,
            sub_agent_factory=lambda: FakeSubAgent(),
            idle_timeout_seconds=0.0,
        )

        state = asyncio.run(
            agent.run(
                dataset_path="data/example.csv",
                user_goal="Understand regional sales differences",
                dataset_info_override={"rows": 10, "columns": []},
            )
        )

        event_payloads = [
            json.loads(line)
            for line in run_store.events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        event_types = [payload["event_type"] for payload in event_payloads]
        self.assertNotIn("progress_evaluation", event_types)
        self.assertIn(
            "mark_complete",
            [
                payload["data"].get("tool_name")
                for payload in event_payloads
                if payload["event_type"] == "master_agent_tool_result"
            ],
        )
        self.assertFalse(state.master_agent_state.dispatch_batches[0].stage_summary_emitted)
        self.assertEqual(
            state.master_agent_state.dispatch_batches[0].status,
            "waiting_for_stage_summary",
        )

    def test_dispatch_batch_waits_for_all_plans_before_stage_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_stage_summary_waits", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan_done = PlanItem.create(text="Finished plan")
            plan_done.status = "completed"
            plan_running = PlanItem.create(text="Still running plan")
            plan_running.status = "analyzing"
            agent.state.plans.extend([plan_done, plan_running])
            agent.state.insights.append(
                Insight.create(
                    plan_id=plan_done.plan_id,
                    summary="Finished summary.",
                    atomic_insights=[AtomicInsight.create(text="Finished atomic", insight_type="value")],
                )
            )
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[plan_done.plan_id, plan_running.plan_id],
                )
            ]

            agent._sync_dispatch_batches()

            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].status,
                "dispatched",
            )
            self.assertIsNone(agent._pending_stage_summary_batch())

    def test_evaluate_progress_persists_structured_stage_summary_payload(self) -> None:
        run_store = RunStore(
            run_id="run_stage_summary_payload",
            base_dir=make_test_base_dir("run_stage_summary_payload"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        plan = PlanItem.create(text="Analyze revenue spike")
        plan.status = "completed"
        agent.state.plans.append(plan)
        insight = Insight.create(
            plan_id=plan.plan_id,
            summary="Revenue spikes in Q4.",
            atomic_insights=[
                AtomicInsight.create(
                    text="Q4 revenue is the peak.",
                    insight_type="trend",
                    columns=["Quarter", "Revenue"],
                )
            ],
            short_label="Revenue spike",
        )
        agent.state.insights.append(insight)
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        result = agent._tool_evaluate_progress(
            {
                "stage_summary_markdown": "Revenue spikes in Q4 [[1]].",
                "citations": [
                    {
                        "marker": 1,
                        "target": {
                            "kind": "summary",
                            "summary_id": insight.insight_id,
                            "summary_short_label": "Revenue spike",
                            "summary_text": insight.summary,
                            "columns": ["Quarter", "Revenue"],
                        },
                        "label": "Revenue spike summary",
                    }
                ],
            }
        )

        self.assertEqual(result["dispatch_turn_index"], 0)
        self.assertEqual(result["plan_ids"], [plan.plan_id])
        self.assertEqual(result["covered_dispatch_turn_indexes"], [0])
        self.assertEqual(result["covered_plan_ids"], [plan.plan_id])
        self.assertEqual(result["stage_summary_markdown"], "Revenue spikes in Q4 [[1]].")
        self.assertEqual(len(result["citations"]), 1)

        event_payloads = [
            json.loads(line)
            for line in run_store.events_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        progress_event = next(payload for payload in event_payloads if payload["event_type"] == "progress_evaluation")
        self.assertEqual(progress_event["data"]["dispatch_turn_index"], 0)
        self.assertEqual(progress_event["data"]["plan_ids"], [plan.plan_id])
        self.assertEqual(progress_event["data"]["covered_dispatch_turn_indexes"], [0])
        self.assertEqual(progress_event["data"]["covered_plan_ids"], [plan.plan_id])
        self.assertEqual(progress_event["data"]["stage_summary_markdown"], "Revenue spikes in Q4 [[1]].")
        self.assertEqual(progress_event["data"]["citations"][0]["marker"], 1)

    def test_evaluate_progress_targets_latest_pending_stage_summary_batch(self) -> None:
        run_store = RunStore(
            run_id="run_stage_summary_latest_pending",
            base_dir=make_test_base_dir("run_stage_summary_latest_pending"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        first_plan = PlanItem.create(text="Analyze first batch")
        first_plan.status = "completed"
        second_plan = PlanItem.create(text="Analyze second batch")
        second_plan.status = "completed"
        agent.state.plans.extend([first_plan, second_plan])
        agent.state.insights.extend(
            [
                Insight.create(
                    plan_id=first_plan.plan_id,
                    summary="First batch summary.",
                    atomic_insights=[AtomicInsight.create(text="First batch atomic", insight_type="value")],
                ),
                Insight.create(
                    plan_id=second_plan.plan_id,
                    summary="Second batch summary.",
                    atomic_insights=[AtomicInsight.create(text="Second batch atomic", insight_type="trend")],
                ),
            ]
        )
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[first_plan.plan_id],
                status="waiting_for_stage_summary",
            ),
            DispatchBatchState(
                dispatch_turn_index=1,
                plan_ids=[second_plan.plan_id],
                status="waiting_for_stage_summary",
            ),
        ]

        result = agent._tool_evaluate_progress(
            {
                "stage_summary_markdown": "Second batch checkpoint.",
            }
        )

        self.assertEqual(result["dispatch_turn_index"], 1)
        self.assertEqual(result["plan_ids"], [second_plan.plan_id])
        self.assertEqual(result["covered_dispatch_turn_indexes"], [0, 1])
        self.assertEqual(result["covered_plan_ids"], [first_plan.plan_id, second_plan.plan_id])
        self.assertTrue(agent.state.master_agent_state.dispatch_batches[0].stage_summary_emitted)
        self.assertEqual(
            agent.state.master_agent_state.dispatch_batches[0].status,
            "stage_summarized",
        )
        self.assertEqual(
            agent.state.master_agent_state.dispatch_batches[0].stage_summary_markdown,
            "",
        )
        self.assertTrue(agent.state.master_agent_state.dispatch_batches[1].stage_summary_emitted)
        self.assertEqual(
            agent.state.master_agent_state.dispatch_batches[1].stage_summary_markdown,
            "Second batch checkpoint.",
        )

    def test_pending_stage_summary_batch_ignores_batches_before_latest_final_summary_boundary(self) -> None:
        run_store = RunStore(
            run_id="run_stage_summary_after_final_boundary",
            base_dir=make_test_base_dir("run_stage_summary_after_final_boundary"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        plan_before_final = PlanItem.create(text="Analyze pre-final batch")
        plan_before_final.status = "completed"
        plan_after_final = PlanItem.create(text="Analyze post-final batch")
        plan_after_final.status = "completed"
        agent.state.plans.extend([plan_before_final, plan_after_final])
        agent.state.insights.extend(
            [
                Insight.create(
                    plan_id=plan_before_final.plan_id,
                    summary="Pre-final summary.",
                    atomic_insights=[AtomicInsight.create(text="Pre-final atomic", insight_type="value")],
                ),
                Insight.create(
                    plan_id=plan_after_final.plan_id,
                    summary="Post-final summary.",
                    atomic_insights=[AtomicInsight.create(text="Post-final atomic", insight_type="trend")],
                ),
            ]
        )
        agent.state.turns = [
            Turn(
                turn_id=0,
                goal="Base goal",
                status="completed",
                final_summary="Final summary already covered the earlier batch.",
                timeline=[
                    TimelineEntry(
                        entry_type="mark_complete",
                        content={
                            "arguments": {"summary": "Final summary already covered the earlier batch."},
                            "result": {"summary": "Final summary already covered the earlier batch.", "dispatch_turn_index": 0},
                        },
                    )
                ],
            ),
            Turn(turn_id=1, goal="Follow-up goal", status="running"),
        ]
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[plan_before_final.plan_id],
                status="waiting_for_stage_summary",
            ),
            DispatchBatchState(
                dispatch_turn_index=1,
                plan_ids=[plan_after_final.plan_id],
                status="waiting_for_stage_summary",
            ),
        ]

        pending_batch = agent._pending_stage_summary_batch()

        self.assertIsNotNone(pending_batch)
        self.assertEqual(pending_batch.dispatch_turn_index, 1)
        self.assertEqual(
            [batch.dispatch_turn_index for batch in agent._current_stage_summary_scope_batches(pending_batch)],
            [1],
        )

    def test_fallback_decision_does_not_auto_inject_stage_summary_when_batch_is_pending(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_stage_summary_fallback", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Analyze revenue spike",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan = PlanItem.create(text="Analyze revenue spike")
            plan.status = "completed"
            agent.state.plans.append(plan)
            agent.state.insights.append(
                Insight.create(
                    plan_id=plan.plan_id,
                    summary="Revenue spikes in Q4.",
                    atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
                )
            )
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            decision = agent._fallback_decision()

            self.assertEqual(
                [item.get("name") for item in decision],
                ["synthesize_findings", "mark_complete"],
            )

    def test_mark_complete_allows_pending_stage_summary_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            run_store = RunStore(run_id="run_mark_complete_blocked", base_dir=temp_dir)
            run_store.initialize()
            agent = MasterAgent(store=run_store)
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )
            plan = PlanItem.create(text="Analyze revenue spike")
            plan.status = "completed"
            agent.state.plans.append(plan)
            agent.state.insights.append(
                Insight.create(
                    plan_id=plan.plan_id,
                    summary="Revenue spikes in Q4.",
                    atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
                )
            )
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            result = agent._tool_mark_complete({"summary": "Done."})

            self.assertEqual(result.get("summary"), "Done.")
            self.assertEqual(result.get("dispatch_turn_index"), 0)
            self.assertTrue(agent.state.master_agent_state.completed)
            self.assertEqual(agent.state.final_summary, "Done.")

    def test_mark_complete_logs_dispatch_turn_index_and_follow_up_user_response(self) -> None:
        async def exercise() -> None:
            store = RecordingStore()
            agent = MasterAgent(store=store)
            agent.state = RunState.create(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                settings=RunSettings(max_concurrency=1),
            )
            agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
            plan = PlanItem.create(text="Analyze revenue spike")
            plan.status = "completed"
            agent.state.plans.append(plan)
            agent.state.insights.append(
                Insight.create(
                    plan_id=plan.plan_id,
                    summary="Revenue spikes in Q4.",
                    atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
                )
            )
            agent.state.master_agent_state.dispatch_batches = [
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=[plan.plan_id],
                    status="waiting_for_stage_summary",
                )
            ]

            await agent._execute_tool_calls(
                agent._ensure_post_summary_user_responses(
                    [{"name": "mark_complete", "arguments": {"summary": "Done."}}]
                )
            )

            self.assertEqual(
                [tool_name for tool_name, _result in store.tool_results[-2:]],
                ["mark_complete", "respond_to_user"],
            )
            self.assertEqual(store.tool_results[-2][1]["dispatch_turn_index"], 0)
            self.assertEqual(store.events[-1][0], "user_response")
            self.assertTrue(store.events[-1][1]["message"].strip())

        asyncio.run(exercise())

    def test_leading_user_response_uses_full_request_text_and_fast_model(self) -> None:
        class FakeAckResponse:
            def __init__(self, content: str) -> None:
                self.choices = [
                    type(
                        "Choice",
                        (),
                        {"message": type("Message", (), {"content": content})()},
                    )
                ]

        class FakeAckClient:
            def __init__(self, content: str) -> None:
                self.requests = []
                self._content = content

                class _Completions:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self._outer = outer

                    def create(self, **kwargs):
                        self._outer.requests.append(kwargs)
                        return FakeAckResponse(self._outer._content)

                class _Chat:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self.completions = _Completions(outer)

                self.chat = _Chat(self)

        fake_client = FakeAckClient("I'll keep the next analysis centered on the revenue gap and promotion timing.")
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        long_request = (
            "Please compare Europe and North America after the holiday campaigns, "
            "check the revenue gap against baseline pricing, and keep an eye on late-spring carryover effects "
            "that still matter after the ninety-six character mark."
        )
        message = UserMessage.create(
            content=long_request,
            kind="chat",
        )
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", fake_client
        ):
            tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(tool_calls[0]["arguments"]["message"], fake_client._content)
        self.assertEqual(len(fake_client.requests), 1)
        self.assertEqual(
            fake_client.requests[0]["model"],
            "gemini-3.1-flash-lite-preview",
        )
        self.assertIn(long_request, fake_client.requests[0]["messages"][1]["content"])
        self.assertIn("ninety-six character mark", fake_client.requests[0]["messages"][1]["content"])
        self.assertNotIn("request excerpt", fake_client.requests[0]["messages"][1]["content"])

    def test_dispatch_plans_returns_full_batch_order_and_started_subset(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_dispatch_subset",
                base_dir=make_test_base_dir("run_dispatch_subset"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan_one = PlanItem.create(text="Plan one")
            plan_two = PlanItem.create(text="Plan two")
            agent.state.plans.extend([plan_one, plan_two])

            result = await agent._tool_dispatch_plans(
                {"plan_ids": [plan_one.plan_id, plan_two.plan_id]}
            )

            self.assertEqual(result["plan_ids"], [plan_one.plan_id, plan_two.plan_id])
            self.assertEqual(result["dispatched_plan_ids"], [plan_one.plan_id])
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [plan_one.plan_id, plan_two.plan_id],
            )
            self.assertEqual(agent.state.get_plan_by_id(plan_two.plan_id).status, "pending")

        asyncio.run(exercise())

    def test_dispatch_plans_serializes_execution_when_model_cache_is_enabled(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_dispatch_cache_serialized",
                base_dir=make_test_base_dir("run_dispatch_cache_serialized"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=2),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan_one = PlanItem.create(text="Plan one")
            plan_two = PlanItem.create(text="Plan two")
            agent.state.plans.extend([plan_one, plan_two])

            with patch(
                "framework.master_agent.runtime_requires_serial_sub_agent_execution",
                return_value=True,
            ):
                result = await agent._tool_dispatch_plans(
                    {"plan_ids": [plan_one.plan_id, plan_two.plan_id]}
                )

            self.assertEqual(result["plan_ids"], [plan_one.plan_id, plan_two.plan_id])
            self.assertEqual(result["dispatched_plan_ids"], [plan_one.plan_id])
            self.assertEqual(agent.state.get_plan_by_id(plan_two.plan_id).status, "pending")

        asyncio.run(exercise())

    def test_stop_intent_detection_covers_explicit_examples_and_false_positive_guards(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(content="Stop all analysis, please.", kind="chat")
        agent.state.user_messages.append(message)

        self.assertFalse(agent._is_stop_intent_message(message))
        self.assertIsNone(agent._latest_stop_intent_chat_message())
        agent._mark_pending_stop_completion(message.message_id)
        self.assertEqual(agent._latest_stop_intent_chat_message(), message)

    def test_leading_user_response_for_stop_intent_is_stop_aware(self) -> None:
        class FakeAckResponse:
            def __init__(self, content: str) -> None:
                self.choices = [SimpleNamespace(message=SimpleNamespace(content=content))]

        class FakeAckClient:
            def __init__(self, content: str) -> None:
                class _Completions:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self._outer = outer

                    def create(self, **kwargs):
                        return FakeAckResponse(self._outer._content)

                class _Chat:
                    def __init__(self, outer: "FakeAckClient") -> None:
                        self.completions = _Completions(outer)

                self._content = content
                self.chat = _Chat(self)

        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        message = UserMessage.create(content="Stop all analysis, please.", kind="chat")
        agent.state.user_messages.append(message)
        agent._enqueue_pending_user_response(message)

        fake_client = FakeAckClient(
            '{"message":"I will let the current work finish and then wrap up the run.","probable_stop":true}'
        )
        with patch("framework.master_agent.OPENAI_API_KEY", "test-key"), patch(
            "framework.master_agent.OPENAI_CLIENT", fake_client
        ):
            tool_calls = agent._build_pending_user_response_tool_calls()

        self.assertEqual(len(tool_calls), 1)
        self.assertEqual(
            tool_calls[0]["arguments"]["message"],
            "I will let the current work finish and then wrap up the run.",
        )
        self.assertTrue(tool_calls[0]["_probable_stop"])

    def test_stop_completion_hook_marks_complete_after_running_plan_terminates(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_stop_completion_hook_v2",
                base_dir=make_test_base_dir("run_stop_completion_hook_v2"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Base goal",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Running plan")
            pending_plan = PlanItem.create(text="Pending sibling")
            agent.state.plans.extend([running_plan, pending_plan])
            await agent._tool_dispatch_plans(
                {"plan_ids": [running_plan.plan_id, pending_plan.plan_id]}
            )

            stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
            agent.state.user_messages.append(stop_message)
            agent._enqueue_pending_user_response(stop_message)
            await agent._execute_tool_calls(
                [
                    {
                        "name": "respond_to_user",
                        "arguments": {
                            "message": "I will let the current work finish and then wrap up the run."
                        },
                        "_pending_user_response_message_id": stop_message.message_id,
                        "_probable_stop": True,
                    }
                ]
            )

            self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "terminated")
            self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")
            self.assertEqual(
                agent.state.master_agent_state.pending_stop_completion_message_id,
                stop_message.message_id,
            )

            await asyncio.wait_for(agent._active_tasks[running_plan.plan_id], timeout=0.5)
            await agent._collect_finished_sub_agents()

            batch_reply = agent._build_next_batch_finished_user_response_tool_call()
            self.assertIsNotNone(batch_reply)
            await agent._execute_tool_calls([batch_reply])

            decision = agent._fallback_decision()
            self.assertEqual([tool_call["name"] for tool_call in decision], ["mark_complete"])
            completion_tool_calls = agent._filter_disallowed_respond_to_user_tool_calls(
                agent._ensure_post_summary_user_responses(decision)
            )
            await agent._execute_tool_calls(completion_tool_calls)

            self.assertTrue(agent.state.master_agent_state.completed)
            self.assertEqual(agent.state.status, "completed")
            self.assertTrue(agent.state.final_summary.strip())
            self.assertIsNone(agent.state.master_agent_state.pending_stop_completion_message_id)

        asyncio.run(exercise())

    def test_stop_completion_fallback_skips_stage_summary_batches(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        agent.state.turns.append(Turn(turn_id=0, goal="Base goal"))
        stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
        agent.state.user_messages.append(stop_message)
        agent._mark_pending_stop_completion(stop_message.message_id)
        completed_plan = PlanItem.create(text="Completed analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.insights.append(
            Insight.create(
                plan_id=completed_plan.plan_id,
                summary="Revenue spikes in Q4.",
                atomic_insights=[AtomicInsight.create(text="Q4 peak", insight_type="trend")],
            )
        )
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[completed_plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        decision = agent._fallback_decision()

        self.assertEqual([tool_call["name"] for tool_call in decision], ["mark_complete"])
        self.assertIn("Revenue spikes in Q4.", decision[0]["arguments"]["summary"])

    def test_stop_completion_filter_drops_stage_summary_and_keeps_mark_complete(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
        agent.state.user_messages.append(stop_message)
        agent._mark_pending_stop_completion(stop_message.message_id)
        completed_plan = PlanItem.create(text="Completed analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)

        filtered = agent._filter_summary_tool_calls_until_all_plans_terminal(
            [
                {"name": "evaluate_progress", "arguments": {"stage_summary_markdown": "Checkpoint."}},
                {"name": "synthesize_findings", "arguments": {"synthesis": "Interim summary."}},
                {"name": "mark_complete", "arguments": {"summary": "Final answer."}},
            ]
        )

        self.assertEqual(
            filtered,
            [{"name": "mark_complete", "arguments": {"summary": "Final answer."}}],
        )

    def test_stop_completion_llm_hook_requests_mark_complete_without_stage_summary(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
        agent.state.user_messages.append(stop_message)
        agent._mark_pending_stop_completion(stop_message.message_id)

        messages = agent._build_llm_messages()

        self.assertIn("Stop-completion context:", messages[0]["content"])
        self.assertIn("Do not create new plans", messages[0]["content"])
        self.assertIn("return mark_complete", messages[0]["content"])
        self.assertNotIn("evaluate_progress", messages[1]["content"])

    def test_process_user_steer_stop_intent_terminates_nonrunning_and_requests_running_termination(self) -> None:
        run_store = RunStore(
            run_id="run_stop_intent_controls_v2",
            base_dir=make_test_base_dir("run_stop_intent_controls_v2"),
        )
        run_store.initialize()
        agent = MasterAgent(store=run_store)
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Base goal",
            dataset_info_override={"rows": 1, "columns": []},
        )

        pending_plan = PlanItem.create(text="Pending plan")
        paused_plan = PlanItem.create(text="Paused plan")
        paused_plan.status = "paused"
        running_plan = PlanItem.create(text="Running plan")
        running_plan.status = "analyzing"
        running_plan.assigned_sub_agent_id = "sub_001"
        agent.state.plans.extend([pending_plan, paused_plan, running_plan])
        agent.state.master_agent_state.active_plan_ids = [running_plan.plan_id]

        agent.user_steer_queue.push("Stop all analysis.", kind="chat")
        self.assertTrue(agent._process_user_steer())

        stop_message = agent.state.user_messages[-1]
        self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "pending")
        self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "paused")
        self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")

        asyncio.run(
            agent._execute_tool_calls(
                [
                    {
                        "name": "respond_to_user",
                        "arguments": {"message": "I will let the current work finish and then wrap up the run."},
                        "_pending_user_response_message_id": stop_message.message_id,
                        "_probable_stop": True,
                    }
                ]
            )
        )

        self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "terminated")
        self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "terminated")
        self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")
        self.assertEqual(
            agent.state.master_agent_state.pending_stop_completion_message_id,
            stop_message.message_id,
        )

    def test_latest_post_steer_follow_up_state_ignores_latest_stop_intent_chat(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        turn = Turn(turn_id=0, goal="Base goal")
        agent.state.turns.append(turn)

        focus_message = UserMessage.create(
            content="Focus the next follow-up on explaining the Q4 revenue spike.",
            kind="focus",
            generated_prompt="Focus the next follow-up on explaining the Q4 revenue spike.",
        )
        agent.state.user_messages.append(focus_message)
        agent._append_steering_message_to_turn(turn, focus_message)

        stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
        agent.state.user_messages.append(stop_message)
        agent._mark_pending_stop_completion(stop_message.message_id)

        self.assertIsNone(agent._latest_post_steer_follow_up_state())

    def test_batch_finished_user_response_is_stop_aware(self) -> None:
        agent = MasterAgent(store=RecordingStore())
        agent.state = RunState.create(
            dataset_path="data/example.csv",
            user_goal="Base goal",
        )
        stop_message = UserMessage.create(content="Stop all analysis.", kind="chat")
        agent.state.user_messages.append(stop_message)
        agent._mark_pending_stop_completion(stop_message.message_id)
        completed_plan = PlanItem.create(text="Finished analysis")
        completed_plan.status = "completed"
        agent.state.plans.append(completed_plan)
        agent.state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=[completed_plan.plan_id],
                status="waiting_for_stage_summary",
            )
        ]

        tool_call = agent._build_next_batch_finished_user_response_tool_call()

        self.assertIsNotNone(tool_call)
        self.assertIn("won't open more plans", tool_call["arguments"]["message"])
        self.assertNotIn("more plans are still needed", tool_call["arguments"]["message"])

if __name__ == "__main__":
    unittest.main()


