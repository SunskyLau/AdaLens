#!/usr/bin/env python3
"""
CLI entrypoint for agentic-eda-v0.1.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path

from config import DEFAULT_MAX_CONCURRENCY, DEFAULT_MAX_INITIAL_PLANS
from framework import MasterAgent, RunSettings, RunStore, UserMessage

REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_dataset_path(raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return (REPO_ROOT / path).resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agentic EDA v0.1")
    parser.add_argument("--dataset", required=True, help="Path to a CSV dataset")
    parser.add_argument("--goal", help="User analysis goal (deprecated alias for --user-goal)")
    parser.add_argument("--user-goal", dest="user_goal", help="Initial analysis goal")
    parser.add_argument("--run-dir", help="Optional run output directory")
    parser.add_argument("--resume", action="store_true", help="Resume an existing run from --run-dir")
    parser.add_argument("--user-message-id", help="Optional stable message id for resume-time user input")
    parser.add_argument("--user-message-timestamp", help="Optional stable timestamp for resume-time user input")
    parser.add_argument(
        "--resume-message-json",
        help="Optional structured resume-time user message JSON payload",
    )
    parser.add_argument(
        "--default-sub-agents-num", dest="max_concurrent", type=int
    )
    parser.add_argument("--max-concurrent", type=int, default=DEFAULT_MAX_CONCURRENCY)
    parser.add_argument("--max-concurrency", dest="max_concurrent", type=int)
    parser.add_argument("--max-initial-plans", type=int, default=DEFAULT_MAX_INITIAL_PLANS)
    parser.add_argument(
        "--stable",
        dest="stable_output",
        action="store_true",
        help="Bias model calls toward repeatable outputs by forcing stable sampling controls.",
    )
    return parser


def _build_store(run_dir: str | None) -> RunStore | None:
    if not run_dir:
        return None
    path = Path(run_dir).resolve()
    return RunStore(run_id=path.name, base_dir=path.parent)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    user_goal = args.user_goal or args.goal
    if not user_goal and not args.resume:
        parser.error("one of --user-goal or --goal is required")
    if args.resume and not args.run_dir:
        parser.error("--resume requires --run-dir")
    if bool(args.user_message_id) != bool(args.user_message_timestamp):
        parser.error("--user-message-id and --user-message-timestamp must be provided together")
    if args.resume_message_json and (args.user_message_id or args.user_message_timestamp):
        parser.error("--resume-message-json cannot be combined with --user-message-id/--user-message-timestamp")

    dataset_path = _resolve_dataset_path(args.dataset)
    if not dataset_path.exists():
        parser.error(f"Dataset not found: {dataset_path}")

    settings = RunSettings(
        max_concurrency=args.max_concurrent,
        stable_llm_output=args.stable_output,
    )
    store = _build_store(args.run_dir)
    resume_message = None
    if args.resume_message_json:
        try:
            resume_payload = json.loads(args.resume_message_json)
        except json.JSONDecodeError as exc:
            parser.error(f"--resume-message-json must be valid JSON: {exc}")
        if not isinstance(resume_payload, dict):
            parser.error("--resume-message-json must decode to an object")
        resume_message = UserMessage.from_dict(resume_payload)
    elif args.user_message_id and args.user_message_timestamp:
        resume_message = UserMessage(
            message_id=args.user_message_id,
            timestamp=args.user_message_timestamp,
            content=user_goal or "",
        )
    def _print_progress(message: str) -> None:
        print(message, flush=True)

    agent = MasterAgent(
        store=store,
        settings=settings,
        max_initial_plans=args.max_initial_plans,
        progress_callback=_print_progress,
    )

    def _handle_signal(_signum, _frame) -> None:
        if agent.store is None:
            return
        stop_path = agent.store.run_dir / "STOP"
        stop_path.write_text("stop requested\n", encoding="utf-8")

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    if args.resume:
        print(f"Resuming run for dataset: {dataset_path}", flush=True)
    else:
        print(f"Starting run for dataset: {dataset_path}", flush=True)
    if user_goal:
        print(f"Goal: {user_goal}", flush=True)

    try:
        state = asyncio.run(
            agent.run(
                dataset_path=str(dataset_path),
                user_goal=user_goal or "",
                resume=args.resume,
                resume_message=resume_message,
            )
        )
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"Run failed: {exc}", file=sys.stderr)
        return 1

    print(f"Run finished: {state.run_id}")
    print(f"Status: {state.status}")
    print(f"Summary count: {state.total_summaries()}")
    print(f"Atomic insight count: {state.total_atomic_insights()}")
    if state.status == "failed":
        return 1
    if state.status == "stopped":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
