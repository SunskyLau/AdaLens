from __future__ import annotations

import asyncio
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.master_agent import MasterAgent  # noqa: E402
from framework.models import (  # noqa: E402
    AtomicInsight,
    ExecutionRecord,
    Insight,
    InsightEvidence,
    PlanItem,
    RunSettings,
    SubAgentResult,
)
from framework.store import RunStore  # noqa: E402


TEST_TMP_ROOT = ROOT / ".codex-temp-test"


def make_test_base_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


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
    def __init__(self):
        self.control_callback = None

    async def run(self, plan, dataset_info, resume_phase=None, user_messages=None):
        _ = dataset_info
        _ = resume_phase
        _ = user_messages
        for _ in range(20):
            callback = self.control_callback
            control_snapshot = callback() if callable(callback) else {}
            control_state = str((control_snapshot or {}).get("control_state") or "").strip()
            if control_state == "pause_requested":
                return SubAgentResult(
                    plan_id=plan.plan_id,
                    success=False,
                    execution_records=[],
                    insight=None,
                    error=None,
                    control_action="pause",
                    resume_phase="analyzing",
                )
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


class TestPlanControlRuntime(unittest.TestCase):
    def test_master_pauses_when_all_nonterminal_plans_are_paused_or_pending(self) -> None:
        run_store = RunStore(
            run_id="run_plan_control_master_paused_pending",
            base_dir=make_test_base_dir("run_plan_control_master_paused_pending"),
        )
        run_store.initialize()
        agent = MasterAgent(
            store=run_store,
            settings=RunSettings(max_concurrency=2, poll_interval_seconds=0.01),
            sub_agent_factory=lambda: SlowSubAgent(),
        )
        agent._initialize(
            dataset_path="data/example.csv",
            user_goal="Inspect paused and pending synchronization",
            dataset_info_override={"rows": 1, "columns": []},
        )

        paused_plan = PlanItem.create(text="Paused plan")
        paused_plan.status = "paused"
        pending_plan = PlanItem.create(text="Pending plan")
        completed_plan = PlanItem.create(text="Completed plan")
        completed_plan.status = "completed"
        agent.state.plans.extend([paused_plan, pending_plan, completed_plan])
        agent._register_dispatch_batch([paused_plan.plan_id, pending_plan.plan_id, completed_plan.plan_id])

        agent._refresh_run_status_from_plans()
        self.assertEqual(agent.state.status, "paused")

        pending_plan.status = "analyzing"
        agent._refresh_run_status_from_plans()
        self.assertEqual(agent.state.status, "running")

    def test_pause_request_is_deferred_until_sub_agent_safe_point_without_backfill(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_pause_deferred",
                base_dir=make_test_base_dir("run_plan_control_pause_deferred"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: ControlAwareSlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Running plan")
            waiting_plan = PlanItem.create(text="Waiting plan")
            agent.state.plans.extend([running_plan, waiting_plan])
            await agent._tool_dispatch_plans({"plan_ids": [running_plan.plan_id, waiting_plan.plan_id]})

            run_store.append_plan_control({"plan_id": running_plan.plan_id, "action": "pause"})
            changed = await agent._process_plan_controls()

            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")
            self.assertEqual(
                agent.state.get_plan_by_id(running_plan.plan_id).control_state,
                "pause_requested",
            )

            await asyncio.wait_for(agent._active_tasks[running_plan.plan_id], timeout=0.5)
            await agent._collect_finished_sub_agents()

            self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "paused")
            self.assertEqual(agent.state.get_plan_by_id(waiting_plan.plan_id).status, "pending")
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [running_plan.plan_id, waiting_plan.plan_id],
            )

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_resume_moves_paused_plan_to_pending_when_execution_seats_are_full(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_resume_full",
                base_dir=make_test_base_dir("run_plan_control_resume_full"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
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
            await agent._tool_dispatch_plans({"plan_ids": [plan_one.plan_id, plan_two.plan_id]})

            run_store.append_plan_control({"plan_id": plan_two.plan_id, "action": "pause"})
            await agent._process_plan_controls()
            self.assertEqual(agent.state.get_plan_by_id(plan_two.plan_id).status, "paused")

            run_store.append_plan_control({"plan_id": plan_two.plan_id, "action": "resume"})
            changed = await agent._process_plan_controls()

            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(plan_two.plan_id).status, "pending")
            self.assertEqual(agent.state.get_plan_by_id(plan_one.plan_id).status, "analyzing")

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_resume_running_plan_clears_pause_request_without_resetting_status(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_resume_running",
                base_dir=make_test_base_dir("run_plan_control_resume_running"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan = PlanItem.create(text="Plan one")
            agent.state.plans.append(plan)
            await agent._tool_dispatch_plans({"plan_ids": [plan.plan_id]})

            run_store.append_plan_control({"plan_id": plan.plan_id, "action": "pause"})
            await agent._process_plan_controls()
            self.assertEqual(agent.state.get_plan_by_id(plan.plan_id).control_state, "pause_requested")
            self.assertEqual(agent.state.get_plan_by_id(plan.plan_id).status, "analyzing")

            run_store.append_plan_control({"plan_id": plan.plan_id, "action": "resume"})
            changed = await agent._process_plan_controls()

            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(plan.plan_id).control_state, "none")
            self.assertEqual(agent.state.get_plan_by_id(plan.plan_id).status, "analyzing")

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_terminal_release_triggers_pending_backfill_while_skipping_paused(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_terminal_backfill",
                base_dir=make_test_base_dir("run_plan_control_terminal_backfill"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plan_one = PlanItem.create(text="Plan one")
            plan_two = PlanItem.create(text="Plan two")
            plan_three = PlanItem.create(text="Plan three")
            agent.state.plans.extend([plan_one, plan_two, plan_three])
            await agent._tool_dispatch_plans({"plan_ids": [plan_one.plan_id, plan_two.plan_id, plan_three.plan_id]})

            run_store.append_plan_control({"plan_id": plan_three.plan_id, "action": "pause"})
            changed = await agent._process_plan_controls()
            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(plan_three.plan_id).status, "paused")

            await asyncio.wait_for(agent._active_tasks[plan_one.plan_id], timeout=0.5)
            await agent._collect_finished_sub_agents()

            self.assertEqual(agent.state.get_plan_by_id(plan_one.plan_id).status, "completed")
            self.assertEqual(agent.state.get_plan_by_id(plan_two.plan_id).status, "analyzing")
            self.assertEqual(agent.state.get_plan_by_id(plan_three.plan_id).status, "paused")
            self.assertTrue(changed)
            self.assertEqual(
                agent.state.master_agent_state.dispatch_batches[0].plan_ids,
                [plan_one.plan_id, plan_two.plan_id, plan_three.plan_id],
            )

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_paused_plan_is_not_auto_launched_by_batch_rebalance(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_paused_not_auto_launch",
                base_dir=make_test_base_dir("run_plan_control_paused_not_auto_launch"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            paused_plan = PlanItem.create(text="Paused plan")
            pending_plan = PlanItem.create(text="Pending plan")
            paused_plan.status = "paused"
            agent.state.plans.extend([paused_plan, pending_plan])
            batch = agent._register_dispatch_batch([paused_plan.plan_id, pending_plan.plan_id])
            assert batch is not None

            changed = await agent._rebalance_dispatch_batch_execution(batch)

            self.assertFalse(changed)
            self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "paused")
            self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "pending")

        asyncio.run(exercise())

    def test_terminate_on_paused_plan_triggers_pending_backfill_without_reordering_batch(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_terminate_paused_backfill",
                base_dir=make_test_base_dir("run_plan_control_terminate_paused_backfill"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            paused_plan = PlanItem.create(text="Paused plan")
            pending_plan = PlanItem.create(text="Pending plan")
            paused_plan.status = "paused"
            agent.state.plans.extend([paused_plan, pending_plan])
            batch = agent._register_dispatch_batch([paused_plan.plan_id, pending_plan.plan_id])
            assert batch is not None

            run_store.append_plan_control({"plan_id": paused_plan.plan_id, "action": "terminate"})
            changed = await agent._process_plan_controls()

            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "terminated")
            self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "analyzing")
            self.assertEqual(batch.plan_ids, [paused_plan.plan_id, pending_plan.plan_id])

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_terminate_on_nonrunning_plan_respects_existing_concurrency_before_backfill(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_terminate_nonrunning_respects_capacity",
                base_dir=make_test_base_dir("run_plan_control_terminate_nonrunning_respects_capacity"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            running_plan = PlanItem.create(text="Running plan")
            paused_plan = PlanItem.create(text="Paused plan")
            pending_plan = PlanItem.create(text="Pending plan")
            paused_plan.status = "paused"
            agent.state.plans.extend([running_plan, paused_plan, pending_plan])
            batch = agent._register_dispatch_batch([running_plan.plan_id, paused_plan.plan_id, pending_plan.plan_id])
            assert batch is not None
            launched = await agent._launch_plan(running_plan)
            self.assertTrue(launched)

            run_store.append_plan_control({"plan_id": paused_plan.plan_id, "action": "terminate"})
            changed = await agent._process_plan_controls()

            self.assertTrue(changed)
            self.assertEqual(agent.state.get_plan_by_id(running_plan.plan_id).status, "analyzing")
            self.assertEqual(agent.state.get_plan_by_id(paused_plan.plan_id).status, "terminated")
            self.assertEqual(agent.state.get_plan_by_id(pending_plan.plan_id).status, "pending")
            self.assertEqual(batch.plan_ids, [running_plan.plan_id, paused_plan.plan_id, pending_plan.plan_id])

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())

    def test_pending_seat_fill_prioritizes_midway_resume_candidates(self) -> None:
        async def exercise() -> None:
            run_store = RunStore(
                run_id="run_plan_control_pending_priority",
                base_dir=make_test_base_dir("run_plan_control_pending_priority"),
            )
            run_store.initialize()
            agent = MasterAgent(
                store=run_store,
                settings=RunSettings(max_concurrency=1, poll_interval_seconds=0.01),
                sub_agent_factory=lambda: SlowSubAgent(),
            )
            agent._initialize(
                dataset_path="data/example.csv",
                user_goal="Inspect regional performance",
                dataset_info_override={"rows": 1, "columns": []},
            )

            plain_pending = PlanItem.create(text="Plain pending")
            midway_pending = PlanItem.create(text="Midway pending")
            midway_pending.resume_phase = "summarizing"
            agent.state.plans.extend([plain_pending, midway_pending])

            batch = agent._register_dispatch_batch([plain_pending.plan_id, midway_pending.plan_id])
            assert batch is not None
            launched = await agent._launch_pending_plans_for_batch(batch)

            self.assertEqual(launched, [midway_pending.plan_id])
            self.assertEqual(agent.state.get_plan_by_id(midway_pending.plan_id).status, "analyzing")
            self.assertEqual(agent.state.get_plan_by_id(plain_pending.plan_id).status, "pending")

            tasks = [*agent._active_tasks.values(), *agent._detached_tasks]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
