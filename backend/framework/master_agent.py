from __future__ import annotations

from typing import Any, Callable

from config import DEFAULT_MAX_INITIAL_PLANS, set_stable_llm_output_enabled
from .analyzer_agent import AnalyzerAgent
from .models import RunSettings, RunState, UserMessage, generate_run_id
from .orchestrator_agent import OrchestratorAgent
from .persistence import RunStore
from .runtime_graph import RuntimeGraph
from .summarizer_agent import SummarizerAgent
from .worker_runtime import WorkerRuntime


DecisionProvider = Callable[[RunState], Any]


class MasterAgent:
    def __init__(
        self,
        *,
        store: RunStore | None = None,
        settings: RunSettings | None = None,
        max_initial_plans: int = DEFAULT_MAX_INITIAL_PLANS,
        create_plans_replay_enabled: bool | None = None,
        progress_callback: Callable[[str], None] | None = None,
        decision_provider: DecisionProvider | None = None,
        **_: Any,
    ) -> None:
        self.store = store
        self.settings = settings or RunSettings()
        self.max_initial_plans = max_initial_plans
        self.create_plans_replay_enabled = create_plans_replay_enabled
        self.progress_callback = progress_callback
        self.decision_provider = decision_provider

    async def run(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        resume: bool = False,
        resume_message: UserMessage | None = None,
        dataset_info_override: dict[str, Any] | None = None,
    ) -> RunState:
        if self.store is None:
            self.store = RunStore(run_id=generate_run_id())
        self.store.initialize()
        set_stable_llm_output_enabled(self.settings.stable_llm_output)
        orchestrator = OrchestratorAgent(decision_provider=self.decision_provider)
        worker_runtime = WorkerRuntime(
            store=self.store,
            analyzer=AnalyzerAgent(),
            summarizer=SummarizerAgent(),
            progress_callback=self.progress_callback,
        )
        graph = RuntimeGraph(
            store=self.store,
            settings=self.settings,
            orchestrator=orchestrator,
            worker_runtime=worker_runtime,
            max_initial_plans=self.max_initial_plans,
            create_plans_replay_enabled=bool(self.create_plans_replay_enabled),
            progress_callback=self.progress_callback,
        )
        state = await graph.run(
            dataset_path=dataset_path,
            user_goal=user_goal,
            resume=resume,
            resume_message=resume_message,
        )
        if dataset_info_override:
            state.dataset_metadata.update(dataset_info_override)
            state.dataset_schema = graph._dataset_schema_text(state.dataset_metadata)
            self.store.save_state(state)
        if self.progress_callback is not None:
            self.progress_callback(
                f"[runtime run={state.run_id}] finalize status={state.status} "
                f"summaries={state.total_summaries()} atomics={state.total_atomic_insights()}"
            )
        return state
