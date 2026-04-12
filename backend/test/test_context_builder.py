from __future__ import annotations

import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cache_normalization import build_dataset_identity  # noqa: E402
from framework.context_builder import ContextBuilder  # noqa: E402
from framework.models import (  # noqa: E402
    AtomicInsight,
    DispatchBatchState,
    Insight,
    InsightEvidence,
    MasterAgentState,
    PlanItem,
    ProvenanceCitation,
    RunState,
    SteeringTargetSnapshot,
    TimelineEntry,
    Turn,
    UserMessage,
)


def _build_state(*, loop_count: int = 0, num_turns: int = 0) -> RunState:
    state = RunState(
        run_id="run_context",
        dataset_path="data/test.csv",
        dataset_info={
            "rows": 100,
            "columns": [
                {"name": "Region", "dtype": "object"},
                {"name": "Sales", "dtype": "float64"},
            ],
            "sample_rows": [{"Region": "North", "Sales": 10.0}],
        },
        master_agent_state=MasterAgentState(
            current_goals=["Analyze sales performance"],
            active_plan_ids=["plan_running"],
            completed_plan_ids=["plan_done"],
            all_insight_ids=["insight_1", "insight_2"],
            dispatch_batches=[
                DispatchBatchState(
                    dispatch_turn_index=0,
                    plan_ids=["plan_done"],
                    status="waiting_for_stage_summary",
                    stage_summary_emitted=False,
                )
            ],
            loop_count=loop_count,
        ),
    )
    state.plans = [
        PlanItem(
            plan_id="plan_running",
            kind="analysis",
            text="Check regional breakdown",
            status="analyzing",
        ),
        PlanItem(
            plan_id="plan_done",
            kind="analysis",
            text="Inspect yearly totals",
            status="completed",
            final_summary="OUTDATED PLAN SUMMARY",
        ),
    ]
    state.insights = [
        Insight(
            insight_id="insight_1",
            plan_id="plan_done",
            summary="North region drives the increase.",
            keywords=["North region", "Increase"],
            atomic_insights=[
                AtomicInsight.create(
                    text="North contributes the highest sales.",
                    insight_type="rank",
                    columns=["Region", "Sales"],
                    keywords=["North", "Sales lead"],
                    evidence=InsightEvidence(plot_path="artifacts/plots/1.png"),
                )
            ],
        ),
        Insight(
            insight_id="insight_2",
            plan_id="plan_done",
            summary="The 2024 jump is concentrated in Q4.",
            keywords=["2024 jump", "Q4"],
            atomic_insights=[
                AtomicInsight.create(
                    text="Q4 dominates the yearly increase.",
                    insight_type="trend",
                    columns=["Quarter", "Sales"],
                    keywords=["Q4", "Yearly increase"],
                    evidence=InsightEvidence(plot_path="artifacts/plots/2.png"),
                )
            ],
        ),
    ]
    state.user_messages = [
        UserMessage(
            message_id="msg_1",
            timestamp="2026-03-07T12:00:00",
            content="Please focus on regions.",
            kind="focus",
            display_text="Focus Regions",
            generated_prompt="Legacy focus prompt for regions",
            user_prompt='Focus follow-up analysis on the summary "Regions", especially around Region, Sales.',
            system_prompt=(
                "Focus steering semantics:\n"
                "- Continue allocating attention around this summary target in subsequent planning."
            ),
            selected_keywords=["Region", "Sales"],
            target=SteeringTargetSnapshot(
                kind="summary",
                summary_id="insight_1",
                summary_short_label="Regions",
                summary_text="North region drives the increase.",
                columns=["Region", "Sales"],
            ),
        )
    ]
    if num_turns > 0:
        turn0 = Turn(
            turn_id=0,
            goal="Analyze sales performance",
            steers=["focus on regions"],
            timeline=[
                TimelineEntry(entry_type="create_plans", content={"plans": ["plan_done"]}),
                TimelineEntry(entry_type="plans_completed", content={
                    "plan_id": "plan_done", "insight_summary": "North region drives the increase.",
                }),
                TimelineEntry(entry_type="mark_complete", content={"summary": "Done."}),
            ],
            status="completed",
            final_summary="Done.",
        )
        state.turns.append(turn0)
    if num_turns > 1:
        turn1 = Turn(
            turn_id=1,
            goal="Deeper analysis",
            steers=["hint_A"],
            timeline=[
                TimelineEntry(entry_type="create_plans", content={"plans": ["plan_running"]}),
            ],
            status="running",
        )
        state.turns.append(turn1)

    return state


class TestContextBuilder(unittest.TestCase):
    def test_build_system_context_always_full(self) -> None:
        """Regardless of loop_count, system context always includes full columns + sample_rows."""
        builder = ContextBuilder()
        for lc in [0, 1, 5, 100]:
            state = _build_state(loop_count=lc)
            ctx = builder.build_system_context(state)
            self.assertIn("Dataset Overview", ctx)
            self.assertIn(
                f"dataset_identity: {build_dataset_identity(state.dataset_path, state.dataset_info)}",
                ctx,
            )
            self.assertIn("sample_rows", ctx)
            self.assertIn('"Region"', ctx)
            self.assertIn('"Sales"', ctx)
            self.assertNotIn("dataset_path:", ctx)
            self.assertNotIn("Active Global Inform Constraints", ctx)
            self.assertNotIn("Prefer business impact first.", ctx)

    def test_build_user_prompt_completed_turns(self) -> None:
        builder = ContextBuilder()
        prompt = builder.build_user_prompt(_build_state(num_turns=2))

        self.assertIn("== TURN 0 (COMPLETED) ==", prompt)
        self.assertIn("Analyze sales performance", prompt)
        self.assertIn("[create_plans]", prompt)
        self.assertIn("[plans_completed]", prompt)
        self.assertIn("[mark_complete]", prompt)
        self.assertIn("Final summary: 'Done.'", prompt)

    def test_build_user_prompt_current_turn(self) -> None:
        builder = ContextBuilder()
        prompt = builder.build_user_prompt(_build_state(num_turns=2))

        self.assertIn("== TURN 1 (RUNNING) ==", prompt)
        self.assertIn("Deeper analysis", prompt)
        self.assertIn("hint_A", prompt)

    def test_no_truncation_plans(self) -> None:
        """More than 15 completed plans should all appear (no truncation)."""
        state = _build_state()
        state.plans = []
        for i in range(20):
            p = PlanItem(
                plan_id=f"plan_{i:03d}",
                kind="analysis",
                text=f"Plan number {i}",
                status="completed",
                final_summary=f"Summary {i}",
            )
            state.plans.append(p)

        builder = ContextBuilder()
        prompt = builder.build_user_prompt(state)

        for i in range(20):
            self.assertIn(f"plan_{i:03d}", prompt, f"plan_{i:03d} missing from prompt")

    def test_no_truncation_insights(self) -> None:
        """More than 20 insights should all appear, with all atomic insights."""
        state = _build_state()
        state.insights = []
        for i in range(25):
            atomics = [
                AtomicInsight.create(
                    text=f"Atomic {i}-{j}",
                    insight_type="value",
                ) for j in range(5)
            ]
            state.insights.append(
                Insight(
                    insight_id=f"insight_{i:03d}",
                    plan_id=f"plan_{i:03d}",
                    summary=f"Insight summary {i}",
                    atomic_insights=atomics,
                )
            )

        builder = ContextBuilder()
        prompt = builder.build_user_prompt(state)

        for i in range(25):
            self.assertIn(f"Insight summary {i}", prompt)
            for j in range(5):
                self.assertIn(f"Atomic {i}-{j}", prompt)

    def test_no_budget_section(self) -> None:
        """Budget section was removed — ensure it does not appear."""
        builder = ContextBuilder()
        prompt = builder.build_user_prompt(_build_state())

        self.assertNotIn("### Budget Status", prompt)

    def test_prompt_uses_turn_goal_and_steers_without_pending_section(self) -> None:
        builder = ContextBuilder()
        state = _build_state(num_turns=2)
        state.turns[1].steers.append("Please focus on regions.")
        prompt = builder.build_user_prompt(state)

        self.assertIn("Please focus on regions.", prompt)
        self.assertNotIn("### Pending User Messages", prompt)
        self.assertIn("== STEERING HISTORY ==", prompt)
        self.assertIn("FOCUS", prompt)
        self.assertIn("latest action", prompt)
        self.assertIn("selected_keywords: ['Region', 'Sales']", prompt)
        self.assertIn(
            'user_prompt: Focus follow-up analysis on the summary "Regions", especially around Region, Sales.',
            prompt,
        )
        self.assertIn("system_prompt: Focus steering semantics:", prompt)
        self.assertNotIn("2026-03-07T12:00:00", prompt)
        self.assertNotIn("[2026-03-07T12:00:00]", prompt)
        self.assertNotIn("message_id", prompt)

    def test_prompt_surfaces_open_steering_follow_ups(self) -> None:
        builder = ContextBuilder()
        state = _build_state(num_turns=2)
        message = state.user_messages[0]
        state.turns[1].timeline.append(
            TimelineEntry(
                entry_type="user_steer",
                content={
                    "message_id": message.message_id,
                    "kind": "focus",
                    "content": message.content,
                    "display_text": message.display_text,
                    "user_prompt": message.user_prompt,
                    "generated_prompt": message.generated_prompt,
                    "selected_keywords": list(message.selected_keywords),
                    "target": message.target.to_dict(),
                    "follow_up_plan_create_recorded": False,
                    "follow_up_created_plan_ids": [],
                    "follow_up_create_recorded_at": None,
                },
            )
        )

        prompt = builder.build_user_prompt(state)

        self.assertTrue(builder.has_open_steering_follow_up(state))
        self.assertIn("== OPEN STEERING FOLLOW-UPS ==", prompt)
        self.assertIn(
            "You may emit evaluate_progress before handling these if a stage summary is justified now",
            prompt,
        )
        self.assertIn(
            "do not mark_complete until each open steering below has been addressed by a later create_plans call.",
            prompt,
        )
        self.assertIn("TURN 1 FOCUS", prompt)
        self.assertIn(
            'user_prompt: Focus follow-up analysis on the summary "Regions", especially around Region, Sales.',
            prompt,
        )

    def test_prompt_surfaces_recorded_steering_follow_up_status(self) -> None:
        builder = ContextBuilder()
        state = _build_state(num_turns=2)
        message = state.user_messages[0]
        state.turns[1].timeline.append(
            TimelineEntry(
                entry_type="user_steer",
                content={
                    "message_id": message.message_id,
                    "kind": "focus",
                    "content": message.content,
                    "display_text": message.display_text,
                    "user_prompt": message.user_prompt,
                    "generated_prompt": message.generated_prompt,
                    "selected_keywords": list(message.selected_keywords),
                    "target": message.target.to_dict(),
                    "follow_up_plan_create_recorded": True,
                    "follow_up_created_plan_ids": ["plan_new_1", "plan_new_2"],
                    "follow_up_create_recorded_at": "2026-03-07T12:08:00",
                },
            )
        )

        prompt = builder.build_user_prompt(state)

        self.assertFalse(builder.has_open_steering_follow_up(state))
        self.assertIn("follow_up_plan_create_recorded: True", prompt)
        self.assertIn("follow_up_created_plan_ids: ['plan_new_1', 'plan_new_2']", prompt)
        self.assertIn("== OPEN STEERING FOLLOW-UPS ==\n- <none>", prompt)

    def test_prompt_surfaces_latest_user_message_for_language_matching(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.user_messages.append(
            UserMessage(
                message_id="msg_latest_focus",
                timestamp="2026-03-07T12:11:00",
                content="Legacy content",
                kind="focus",
                generated_prompt="Legacy generated prompt",
                user_prompt="\u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u603b\u7ed3\u540e\u7eed\u5206\u6790\u3002",
            )
        )
        prompt = builder.build_user_prompt(state)

        self.assertIn("== LATEST USER MESSAGE FOR LANGUAGE MATCHING ==", prompt)
        self.assertIn("kind: focus", prompt)
        self.assertIn(
            "text: \u8bf7\u7ee7\u7eed\u7528\u4e2d\u6587\u603b\u7ed3\u540e\u7eed\u5206\u6790\u3002",
            prompt,
        )
        self.assertNotIn("timestamp:", prompt)
        self.assertNotIn("2026-03-07T12:11:00", prompt)

    def test_column_steering_history_uses_column_target_format(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.user_messages.append(
            UserMessage(
                message_id="msg_column",
                timestamp="2026-03-07T12:05:00",
                content="Ignore Revenue",
                kind="ignore",
                display_text="Ignore Revenue",
                generated_prompt="Ignore Revenue",
                target=SteeringTargetSnapshot(
                    kind="column",
                    summary_id="",
                    summary_short_label="",
                    summary_text="",
                    columns=["Revenue"],
                ),
            )
        )

        prompt = builder.build_user_prompt(state)

        self.assertIn("IGNORE", prompt)
        self.assertIn("target=column columns=['Revenue']", prompt)

    def test_elaborate_steering_history_is_rendered_with_target_context(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.user_messages.append(
            UserMessage(
                message_id="msg_elaborate",
                timestamp="2026-03-07T12:07:00",
                content="Explain the Q4 spike in more detail",
                kind="elaborate",
                display_text="The 2024 jump is concentrated in Q4.",
                generated_prompt="Legacy elaborate prompt",
                user_prompt=(
                    'Elaborate on the summary "Q4 jump" by explaining what it means, '
                    "what drives it, and why it happens."
                ),
                system_prompt=(
                    "Elaborate steering semantics:\n"
                    "- Keep investigating the explanation, mechanism, and root causes of this specific insight."
                ),
                target=SteeringTargetSnapshot(
                    kind="summary",
                    summary_id="insight_2",
                    summary_short_label="Q4 jump",
                    summary_text="The 2024 jump is concentrated in Q4.",
                    columns=["Quarter", "Sales"],
                ),
            )
        )

        prompt = builder.build_user_prompt(state)

        self.assertIn("ELABORATE", prompt)
        self.assertIn("target=summary summary='Q4 jump' columns=['Quarter', 'Sales']", prompt)
        self.assertIn(
            'user_prompt: Elaborate on the summary "Q4 jump" by explaining what it means, what drives it, and why it happens.',
            prompt,
        )
        self.assertIn("system_prompt: Elaborate steering semantics:", prompt)

    def test_create_steering_history_uses_targetless_format(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.user_messages.append(
            UserMessage(
                message_id="msg_create",
                timestamp="2026-03-07T12:06:00",
                content="Check whether Q4 growth is concentrated in a single segment",
                kind="create",
                display_text="Check whether Q4 growth is concentrated in a single segment",
                generated_prompt="",
                target=None,
            )
        )

        prompt = builder.build_user_prompt(state)

        self.assertIn("CREATE", prompt)
        self.assertIn("<no target>", prompt)
        self.assertIn("Check whether Q4 growth is concentrated in a single segment", prompt)

    def test_steering_history_falls_back_to_legacy_generated_prompt_when_user_prompt_is_missing(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.user_messages = [
            UserMessage(
                message_id="msg_legacy",
                timestamp="2026-03-07T12:09:00",
                content="Legacy prompt content",
                kind="ignore",
                display_text="Ignore Revenue",
                generated_prompt="Legacy generated prompt",
                target=SteeringTargetSnapshot(
                    kind="column",
                    summary_id="",
                    summary_short_label="",
                    summary_text="",
                    columns=["Revenue"],
                ),
            )
        ]

        prompt = builder.build_user_prompt(state)

        self.assertIn("user_prompt: Legacy generated prompt", prompt)
        self.assertNotIn("system_prompt:", prompt)

    def test_prompt_includes_dispatch_batch_state_and_stable_summary_atomic_ids(self) -> None:
        builder = ContextBuilder()
        state = _build_state()
        state.master_agent_state.dispatch_batches[0].stage_summary_markdown = "Stage summary [[1]]"
        state.master_agent_state.dispatch_batches[0].stage_summary_citations = [
            ProvenanceCitation(
                marker=1,
                target=SteeringTargetSnapshot(
                    kind="summary",
                    summary_id="insight_1",
                    summary_short_label="Regions",
                    summary_text="North region drives the increase.",
                    columns=["Region", "Sales"],
                ),
                label="Regions",
            )
        ]

        prompt = builder.build_user_prompt(state)

        self.assertIn("### Dispatch Batches", prompt)
        self.assertIn("dispatch_turn_index=0", prompt)
        self.assertIn("status=waiting_for_stage_summary", prompt)
        self.assertIn("[summary_id=insight_1]", prompt)
        self.assertIn("[atomic_id=", prompt)
        self.assertIn("stage_summary_citations", prompt)

    def test_prompt_includes_unsummarized_stage_summary_window_since_latest_boundary(self) -> None:
        builder = ContextBuilder()
        state = _build_state(num_turns=2)

        third_plan = PlanItem(
            plan_id="plan_done_2",
            kind="analysis",
            text="Inspect post-summary follow-up",
            status="completed",
        )
        state.plans.append(third_plan)
        state.insights.append(
            Insight(
                insight_id="insight_3",
                plan_id=third_plan.plan_id,
                summary="South region rebounds after the earlier checkpoint.",
                atomic_insights=[
                    AtomicInsight.create(
                        text="South rebounds in the latest batch.",
                        insight_type="trend",
                        columns=["Region", "Sales"],
                    )
                ],
            )
        )
        state.master_agent_state.dispatch_batches = [
            DispatchBatchState(
                dispatch_turn_index=0,
                plan_ids=["plan_done"],
                status="stage_summarized",
                stage_summary_emitted=True,
                stage_summary_markdown="Earlier checkpoint.",
            ),
            DispatchBatchState(
                dispatch_turn_index=1,
                plan_ids=["plan_done_2"],
                status="waiting_for_stage_summary",
                stage_summary_emitted=False,
            ),
        ]

        prompt = builder.build_user_prompt(state)

        self.assertIn("== CURRENT STAGE SUMMARY WINDOW ==", prompt)
        self.assertIn("summary_boundary_dispatch_turn_index: 0", prompt)
        self.assertIn("unsummarized_dispatch_turn_indexes: [1]", prompt)
        self.assertIn("dispatch_turn_index=1 plan_ids=['plan_done_2']", prompt)
        self.assertIn("South region rebounds after the earlier checkpoint.", prompt)

    def test_prompt_includes_summary_and_atomic_keywords(self) -> None:
        builder = ContextBuilder()
        prompt = builder.build_user_prompt(_build_state())

        self.assertIn("keywords=['North region', 'Increase']", prompt)
        self.assertIn("keywords=['North', 'Sales lead']", prompt)

    def test_steering_timeline_prompt_is_stable_across_message_ids(self) -> None:
        builder = ContextBuilder()
        first_state = _build_state(num_turns=1)
        second_state = _build_state(num_turns=1)
        first_state.insights = []
        second_state.insights = []

        first_message = UserMessage(
            message_id="msg_first_random",
            timestamp="2026-03-07T12:20:00",
            content="请在后续分析中重点关注DS平台、PS2平台、平台分布",
            kind="focus",
            user_prompt="请在后续分析中重点关注DS平台、PS2平台、平台分布",
            target=SteeringTargetSnapshot(
                kind="summary",
                summary_id="insight_1",
                summary_short_label="平台分布",
                summary_text="DS 和 PS2 平台最值得关注。",
                columns=["Platform"],
            ),
        )
        second_message = UserMessage(
            message_id="msg_second_random",
            timestamp="2026-03-07T12:21:00",
            content="请在后续分析中重点关注DS平台、PS2平台、平台分布",
            kind="focus",
            user_prompt="请在后续分析中重点关注DS平台、PS2平台、平台分布",
            target=SteeringTargetSnapshot(
                kind="summary",
                summary_id="insight_1",
                summary_short_label="平台分布",
                summary_text="DS 和 PS2 平台最值得关注。",
                columns=["Platform"],
            ),
        )

        first_state.user_messages = [first_message]
        second_state.user_messages = [second_message]
        first_state.turns[0].timeline = [
            TimelineEntry(
                entry_type="user_steer",
                content={
                    "message_id": first_message.message_id,
                    "kind": "focus",
                    "content": first_message.content,
                    "user_prompt": first_message.user_prompt,
                    "target": first_message.target.to_dict(),
                },
            )
        ]
        second_state.turns[0].timeline = [
            TimelineEntry(
                entry_type="user_steer",
                content={
                    "message_id": second_message.message_id,
                    "kind": "focus",
                    "content": second_message.content,
                    "user_prompt": second_message.user_prompt,
                    "target": second_message.target.to_dict(),
                },
            )
        ]

        first_prompt = builder.build_user_prompt(first_state)
        second_prompt = builder.build_user_prompt(second_state)

        self.assertEqual(first_prompt, second_prompt)
        self.assertNotIn("msg_first_random", first_prompt)
        self.assertNotIn("msg_second_random", second_prompt)
        self.assertNotIn("message_id", first_prompt)


if __name__ == "__main__":
    unittest.main()
