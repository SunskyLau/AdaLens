from __future__ import annotations

import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.models import (  # noqa: E402
    AtomicInsight,
    DispatchBatchState,
    ExecutionRecord,
    Insight,
    InsightEvidence,
    MasterAgentState,
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


class TestModels(unittest.TestCase):
    def test_run_state_round_trip_preserves_master_agent_fields(self) -> None:
        state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
            settings=RunSettings(max_concurrency=2),
        )
        state.dataset_info = {
            "rows": 12,
            "columns": [
                {"name": "Region", "dtype": "object"},
                {"name": "Sales", "dtype": "float64"},
            ],
            "sample_rows": [{"Region": "North", "Sales": 12.5}],
        }
        plan = PlanItem.create(
            text="Compare sales by region",
            parent_insight_id="insight_root",
        )
        plan.assigned_sub_agent_id = "sub_001"
        plan.status = "analyzing"
        state.plans.append(plan)
        state.master_agent_state.active_plan_ids.append(plan.plan_id)

        state.user_messages.append(UserMessage.create(content="Focus more on regions"))

        state.execution_records.append(
            ExecutionRecord(
                plan_id=plan.plan_id,
                success=True,
                stdout_content="north > south",
                plot_paths=["artifacts/plots/example.png"],
            )
        )
        state.insights.append(
            Insight.create(
                plan_id=plan.plan_id,
                summary="North leads South.",
                atomic_insights=[
                    AtomicInsight.create(
                        text="North sales exceed South sales.",
                        insight_type="difference",
                        columns=["Region", "Sales"],
                        evidence=InsightEvidence(plot_path="artifacts/plots/example.png"),
                    )
                ],
                parent_insight_id="insight_root",
            )
        )
        state.master_agent_state.all_insight_ids = [
            insight.insight_id for insight in state.insights
        ]
        serialized = state.to_dict()

        restored = RunState.from_dict(serialized)

        self.assertEqual(restored.dataset_info["rows"], 12)
        self.assertEqual(restored.settings.max_concurrency, 2)
        self.assertEqual(restored.plans[0].assigned_sub_agent_id, "sub_001")
        self.assertNotIn("priority_hint", serialized["plans"][0])
        self.assertNotIn("priority_params", serialized["plans"][0])
        self.assertNotIn("priority", serialized["plans"][0])
        self.assertEqual(
            restored.master_agent_state.current_goals,
            ["Analyze regional sales trends"],
        )
        self.assertEqual(
            restored.insights[0].atomic_insights[0].columns,
            ["Region", "Sales"],
        )
        self.assertIn("pending_user_response_message_ids", serialized["master_agent_state"])
        self.assertEqual(restored.master_agent_state.pending_user_response_message_ids, [])
        self.assertNotIn("pending_user_message_ids", serialized["master_agent_state"])
        self.assertNotIn("processed", serialized["user_messages"][0])
        self.assertNotIn("budgets", serialized)
        self.assertNotIn("frontier", serialized)
        self.assertNotIn("children_insight_ids", serialized["insights"][0])

    def test_master_agent_state_round_trip_preserves_pending_user_response_queue(self) -> None:
        state = MasterAgentState(
            current_goals=["Analyze regional sales trends"],
            pending_direct_user_create_dispatch_plan_ids=["plan_create_1"],
            pending_user_response_message_ids=["msg_1", "msg_2"],
        )

        restored = MasterAgentState.from_dict(state.to_dict())

        self.assertEqual(
            restored.pending_direct_user_create_dispatch_plan_ids,
            ["plan_create_1"],
        )
        self.assertEqual(
            restored.pending_user_response_message_ids,
            ["msg_1", "msg_2"],
        )

    def test_plan_item_create_adds_identifiers_and_defaults(self) -> None:
        plan = PlanItem.create(text="Inspect missing values")

        self.assertTrue(plan.plan_id.startswith("plan_"))
        self.assertEqual(plan.status, "pending")
        self.assertEqual(plan.kind, "analysis")
        self.assertNotIn("priority_hint", plan.to_dict())
        self.assertNotIn("priority_params", plan.to_dict())
        self.assertNotIn("priority", plan.to_dict())

    def test_run_settings_serialization_contains_only_active_runtime_fields(self) -> None:
        settings = RunSettings(max_concurrency=2, stable_llm_output=True)

        serialized = settings.to_dict()

        self.assertEqual(
            set(serialized.keys()),
            {"default_sub_agents_num", "stable_llm_output", "poll_interval_seconds"},
        )
        self.assertEqual(serialized["default_sub_agents_num"], 2)
        self.assertTrue(serialized["stable_llm_output"])

    def test_run_settings_clamps_max_concurrency_into_supported_range(self) -> None:
        self.assertEqual(RunSettings(max_concurrency=0).default_sub_agents_num, 1)
        self.assertEqual(RunSettings(max_concurrency=99).default_sub_agents_num, 6)
        self.assertEqual(
            RunSettings.from_dict({"max_concurrency": 10}).default_sub_agents_num,
            6,
        )
        self.assertEqual(
            RunSettings.from_dict({"default_sub_agents_num": 5}).default_sub_agents_num,
            5,
        )
        self.assertTrue(
            RunSettings.from_dict({"stable_llm_output": True}).stable_llm_output
        )

    def test_run_state_round_trip_preserves_idle_status(self) -> None:
        state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Analyze regional sales trends",
        )
        state.status = "idle"

        restored = RunState.from_dict(state.to_dict())

        self.assertEqual(restored.status, "idle")

    def test_sub_agent_result_serializes_insight_instead_of_final_summary(self) -> None:
        insight = Insight.create(plan_id="plan_1", summary="North leads.")
        result = SubAgentResult(
            plan_id="plan_1",
            success=True,
            execution_records=[],
            insight=insight,
        )

        serialized = result.to_dict()

        self.assertIn("insight", serialized)
        self.assertNotIn("final_summary", serialized)
        self.assertEqual(serialized["insight"]["summary"], "North leads.")

    # ------------------------------------------------------------------
    # New Turn / TimelineEntry tests
    # ------------------------------------------------------------------

    def test_timeline_entry_round_trip(self) -> None:
        entry = TimelineEntry(
            entry_type="create_plans",
            content={"plans": [{"text": "Analyze X"}], "result": {"created_plan_ids": ["plan_1"]}},
        )
        restored = TimelineEntry.from_dict(entry.to_dict())
        self.assertEqual(restored.entry_type, "create_plans")
        self.assertEqual(restored.content["result"]["created_plan_ids"], ["plan_1"])
        self.assertEqual(restored.timestamp, entry.timestamp)

    def test_turn_round_trip(self) -> None:
        turn = Turn(
            turn_id=0,
            goal="Analyze sales",
            steers=["focus on Q4"],
            timeline=[
                TimelineEntry(entry_type="create_plans", content={"plans": []}),
                TimelineEntry(entry_type="user_steer", content={"content": "focus on Q4"}),
            ],
            status="completed",
            final_summary="Analysis done.",
        )
        restored = Turn.from_dict(turn.to_dict())
        self.assertEqual(restored.turn_id, 0)
        self.assertEqual(restored.goal, "Analyze sales")
        self.assertEqual(restored.steers, ["focus on Q4"])
        self.assertEqual(len(restored.timeline), 2)
        self.assertEqual(restored.timeline[0].entry_type, "create_plans")
        self.assertEqual(restored.timeline[1].entry_type, "user_steer")
        self.assertEqual(restored.status, "completed")
        self.assertEqual(restored.final_summary, "Analysis done.")

    def test_run_state_with_turns_round_trip(self) -> None:
        state = RunState.create(
            dataset_path="data/sample.csv",
            user_goal="Goal A",
        )
        turn0 = Turn(turn_id=0, goal="Goal A", status="completed", final_summary="Done A")
        turn0.timeline.append(TimelineEntry(entry_type="mark_complete", content={"summary": "Done A"}))
        turn1 = Turn(turn_id=1, goal="Goal B", steers=["hint"])
        turn1.timeline.append(TimelineEntry(entry_type="create_plans", content={}))
        state.turns = [turn0, turn1]

        restored = RunState.from_dict(state.to_dict())
        self.assertEqual(len(restored.turns), 2)
        self.assertEqual(restored.turns[0].status, "completed")
        self.assertEqual(restored.turns[0].final_summary, "Done A")
        self.assertEqual(restored.turns[1].goal, "Goal B")
        self.assertEqual(restored.turns[1].steers, ["hint"])
        self.assertEqual(len(restored.turns[1].timeline), 1)

    def test_run_state_from_dict_without_turns(self) -> None:
        """Old state.json without turns field -> turns defaults to empty list."""
        data = RunState.create(dataset_path="d.csv", user_goal="g").to_dict()
        del data["turns"]
        restored = RunState.from_dict(data)
        self.assertEqual(restored.turns, [])

    def test_current_turn_helper(self) -> None:
        state = RunState.create(dataset_path="d.csv", user_goal="g")
        self.assertIsNone(state.current_turn())

        state.turns.append(Turn(turn_id=0, goal="A", status="completed"))
        self.assertIsNone(state.current_turn())

        state.turns.append(Turn(turn_id=1, goal="B", status="running"))
        current = state.current_turn()
        self.assertIsNotNone(current)
        self.assertEqual(current.turn_id, 1)
        self.assertEqual(current.goal, "B")

    def test_user_message_serialization_excludes_processed(self) -> None:
        message = UserMessage.create("Dive into Europe")

        serialized = message.to_dict()
        restored = UserMessage.from_dict(serialized)

        self.assertNotIn("processed", serialized)
        self.assertEqual(restored.content, "Dive into Europe")

    def test_structured_user_message_round_trip(self) -> None:
        message = UserMessage.create(
            "Focus prompt",
            kind="focus",
            display_text="Focus Revenue spike",
            generated_prompt="Legacy focus prompt",
            user_prompt='Focus follow-up analysis on the summary "Revenue spike".',
            system_prompt=(
                "Focus steering semantics:\n"
                "- Continue allocating attention around this summary target in subsequent planning."
            ),
            target=SteeringTargetSnapshot(
                kind="summary",
                summary_id="s1",
                summary_short_label="Revenue spike",
                summary_text="Revenue spikes in Q4.",
                columns=["Revenue", "Quarter"],
            ),
        )

        restored = UserMessage.from_dict(message.to_dict())

        self.assertEqual(restored.kind, "focus")
        self.assertEqual(restored.display_text, "Focus Revenue spike")
        self.assertEqual(restored.generated_prompt, "Legacy focus prompt")
        self.assertEqual(
            restored.user_prompt,
            'Focus follow-up analysis on the summary "Revenue spike".',
        )
        self.assertEqual(
            restored.system_prompt,
            "Focus steering semantics:\n"
            "- Continue allocating attention around this summary target in subsequent planning.",
        )
        self.assertIsNotNone(restored.target)
        self.assertEqual(restored.target.summary_id, "s1")
        self.assertEqual(restored.target.columns, ["Revenue", "Quarter"])

    def test_summary_and_atomic_keywords_round_trip(self) -> None:
        insight = Insight.create(
            plan_id="plan_keywords",
            summary="Revenue spikes in Q4.",
            keywords=[
                "Revenue spike",
                "q4",
                "Revenue spike",
                "  ",
                "North America",
            ],
            atomic_insights=[
                AtomicInsight.create(
                    text="North America drives the Q4 spike.",
                    insight_type="trend",
                    columns=["Revenue", "Region"],
                    keywords=[
                        "North America",
                        "Q4 spike",
                        "north america",
                        "",
                    ],
                    evidence=InsightEvidence(plot_path="artifacts/plots/q4.png"),
                )
            ],
        )

        restored = Insight.from_dict(insight.to_dict())

        self.assertEqual(restored.keywords, ["Revenue spike", "q4", "North America"])
        self.assertEqual(
            restored.atomic_insights[0].keywords,
            ["North America", "Q4 spike"],
        )

    def test_user_message_round_trip_preserves_selected_keywords(self) -> None:
        message = UserMessage.create(
            "Focus prompt",
            kind="focus",
            display_text="Revenue spike",
            generated_prompt="Focus prompt",
            selected_keywords=[
                "Revenue",
                "Q4",
                "revenue",
                "",
            ],
            target=SteeringTargetSnapshot(
                kind="summary",
                summary_id="s1",
                summary_short_label="Revenue spike",
                summary_text="Revenue spikes in Q4.",
                columns=["Revenue", "Quarter"],
            ),
        )

        restored = UserMessage.from_dict(message.to_dict())

        self.assertEqual(restored.selected_keywords, ["Revenue", "Q4"])

    def test_elaborate_user_message_round_trip_preserves_target(self) -> None:
        message = UserMessage.create(
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
                summary_id="s1",
                summary_short_label="Revenue spike",
                summary_text="Revenue spikes in Q4.",
                columns=["Revenue", "Quarter"],
            ),
        )

        restored = UserMessage.from_dict(message.to_dict())

        self.assertEqual(restored.kind, "elaborate")
        self.assertEqual(restored.generated_prompt, "Legacy elaborate prompt")
        self.assertEqual(
            restored.user_prompt,
            'Elaborate on the summary "Revenue spike" by explaining what it means, '
            "what drives it, and why it happens.",
        )
        self.assertEqual(
            restored.system_prompt,
            "Elaborate steering semantics:\n"
            "- Keep investigating the explanation, mechanism, and root causes of this specific insight.",
        )
        self.assertEqual(restored.target.summary_id, "s1")

    def test_legacy_soft_steering_aliases_normalize_on_read(self) -> None:
        restored_focus = UserMessage.from_dict(
            {
                "message_id": "msg_legacy",
                "timestamp": "2026-03-15T10:00:00.000Z",
                "content": "Legacy dive-into prompt",
                "kind": "dive_into",
            }
        )
        restored_ignore = UserMessage.from_dict(
            {
                "message_id": "msg_legacy_ignore",
                "timestamp": "2026-03-15T10:00:00.000Z",
                "content": "Legacy suppress prompt",
                "kind": "suppress",
            }
        )

        self.assertEqual(restored_focus.kind, "focus")
        self.assertEqual(restored_focus.to_dict()["kind"], "focus")
        self.assertEqual(restored_ignore.kind, "ignore")
        self.assertEqual(restored_ignore.to_dict()["kind"], "ignore")

    def test_column_target_round_trip_passively_reads_legacy_column_name(self) -> None:
        restored = SteeringTargetSnapshot.from_dict(
            {
                "kind": "column",
                "summary_id": "",
                "summary_short_label": "",
                "summary_text": "",
                "columns": ["Quarter", "Profit"],
                "column_name": "Revenue",
            }
        )

        self.assertIsNotNone(restored)
        self.assertEqual(restored.kind, "column")
        self.assertEqual(restored.columns, ["Revenue", "Quarter", "Profit"])
        self.assertNotIn("column_name", restored.to_dict())

    def test_column_target_round_trip_preserves_column_anchors(self) -> None:
        restored = SteeringTargetSnapshot.from_dict(
            {
                "kind": "column",
                "summary_id": "",
                "summary_short_label": "",
                "summary_text": "",
                "columns": ["Revenue", "Region"],
                "column_anchors": [
                    {"column": "Revenue", "converge_index": 1},
                    {"column": "Region", "converge_index": 3},
                ],
            }
        )

        self.assertIsNotNone(restored)
        self.assertEqual(restored.kind, "column")
        self.assertEqual(
            restored.to_dict().get("column_anchors"),
            [
                {"column": "Revenue", "converge_index": 1},
                {"column": "Region", "converge_index": 3},
            ],
        )

    def test_create_user_message_round_trip_preserves_empty_generated_prompt_and_null_target(self) -> None:
        message = UserMessage.create(
            "Check whether Q4 growth is concentrated in a single segment",
            kind="create",
            display_text="Check whether Q4 growth is concentrated in a single segment",
            generated_prompt="",
            target=None,
        )

        restored = UserMessage.from_dict(message.to_dict())

        self.assertEqual(restored.kind, "create")
        self.assertEqual(
            restored.display_text,
            "Check whether Q4 growth is concentrated in a single segment",
        )
        self.assertEqual(restored.generated_prompt, "")
        self.assertIsNone(restored.target)

    def test_master_agent_state_round_trip_preserves_dispatch_batches_and_citations(self) -> None:
        state = RunState.create(dataset_path="data/sample.csv", user_goal="Analyze")
        state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=["plan_a", "plan_b"],
                status="stage_summarized",
                stage_summary_emitted=True,
                stage_summary_markdown="Stage summary [[1]]",
                stage_summary_citations=[
                    ProvenanceCitation(
                        marker=1,
                        target=SteeringTargetSnapshot(
                            kind="summary",
                            summary_id="summary_1",
                            summary_short_label="Revenue spike",
                            summary_text="Revenue spikes in Q4.",
                            columns=["Revenue", "Quarter"],
                        ),
                        label="Revenue spike summary",
                    )
                ],
            )
        ]

        restored = RunState.from_dict(state.to_dict())

        self.assertEqual(len(restored.master_agent_state.dispatch_batches), 1)
        batch = restored.master_agent_state.dispatch_batches[0]
        self.assertEqual(batch.dispatch_turn_index, 0)
        self.assertEqual(batch.plan_ids, ["plan_a", "plan_b"])
        self.assertEqual(batch.status, "stage_summarized")
        self.assertTrue(batch.stage_summary_emitted)
        self.assertEqual(batch.stage_summary_markdown, "Stage summary [[1]]")
        self.assertEqual(len(batch.stage_summary_citations), 1)
        self.assertEqual(batch.stage_summary_citations[0].marker, 1)
        self.assertEqual(batch.stage_summary_citations[0].target.kind, "summary")
        self.assertEqual(batch.stage_summary_citations[0].target.summary_id, "summary_1")


if __name__ == "__main__":
    unittest.main()
