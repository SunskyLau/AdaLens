from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cli  # noqa: E402
from framework.models import RunState, UserMessage  # noqa: E402


TEST_TMP_ROOT = ROOT / ".codex-temp-test-cli"


def make_test_dir(name: str) -> Path:
    target = TEST_TMP_ROOT / name
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    return target


class FakeMasterAgent:
    def __init__(self, *args, **kwargs):
        self.progress_callback = kwargs.get("progress_callback")
        self.settings = kwargs.get("settings")
        self.calls: list[dict[str, object]] = []

    async def run(
        self,
        *,
        dataset_path: str,
        user_goal: str,
        resume: bool = False,
        resume_message=None,
    ):
        self.calls.append(
            {
                "dataset_path": dataset_path,
                "user_goal": user_goal,
                "resume": resume,
                "resume_message": resume_message,
            }
        )
        if self.progress_callback:
            prefix = "Run resumed" if resume else "Run initialized"
            self.progress_callback(f"{prefix} for {Path(dataset_path).name}")
            if user_goal:
                self.progress_callback(f"Goal: {user_goal}")
        state = RunState.create(dataset_path=dataset_path, user_goal=user_goal)
        state.status = "completed"
        return state


class TestCliProgress(unittest.TestCase):
    def test_cli_prints_progress_messages_before_final_summary(self) -> None:
        temp_dir = make_test_dir("prints_progress")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")
        stdout = io.StringIO()

        with patch("cli.MasterAgent", FakeMasterAgent), patch("sys.stdout", stdout):
            exit_code = cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--user-goal",
                    "Analyze sample data",
                ]
            )

        output = stdout.getvalue()
        self.assertEqual(exit_code, 0)
        self.assertIn("Run initialized for sample.csv", output)
        self.assertIn("Goal: Analyze sample data", output)
        self.assertIn("Run finished:", output)

    def test_cli_goal_alias_still_maps_to_user_goal(self) -> None:
        temp_dir = make_test_dir("goal_alias")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")
        stdout = io.StringIO()

        with patch("cli.MasterAgent", FakeMasterAgent), patch("sys.stdout", stdout):
            exit_code = cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--goal",
                    "Analyze sample data",
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIn("Goal: Analyze sample data", stdout.getvalue())

    def test_cli_allows_resume_without_new_user_goal(self) -> None:
        temp_dir = make_test_dir("resume_without_goal")
        run_dir = temp_dir / "run_resume"
        run_dir.mkdir()
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")
        stdout = io.StringIO()

        with patch("cli.MasterAgent", FakeMasterAgent), patch("sys.stdout", stdout):
            exit_code = cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--run-dir",
                    str(run_dir),
                    "--resume",
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIn("Run resumed for sample.csv", stdout.getvalue())

    def test_cli_rejects_removed_legacy_budget_flags(self) -> None:
        temp_dir = make_test_dir("rejects_legacy_budget")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            cli.main(["--dataset", str(dataset_path), "--user-goal", "Analyze", "--max-steps", "5"])

    def test_cli_rejects_removed_max_attempts_flag(self) -> None:
        temp_dir = make_test_dir("rejects_max_attempts")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            cli.main(["--dataset", str(dataset_path), "--user-goal", "Analyze", "--max-attempts", "5"])

    def test_cli_rejects_removed_initial_inform_flag(self) -> None:
        temp_dir = make_test_dir("rejects_initial_inform")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--user-goal",
                    "Analyze sample data",
                    "--initial-inform",
                    "Prefer business impact first",
                ]
            )

    def test_cli_parses_resume_message_json(self) -> None:
        temp_dir = make_test_dir("resume_message_json")
        run_dir = temp_dir / "run_resume"
        run_dir.mkdir()
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")
        captured_agent: FakeMasterAgent | None = None

        def build_agent(*args, **kwargs):
            nonlocal captured_agent
            captured_agent = FakeMasterAgent(*args, **kwargs)
            return captured_agent

        payload = {
            "message_id": "msg_structured",
            "timestamp": "2026-03-15T10:00:00.000Z",
            "content": "Legacy dive-into prompt",
            "kind": "dive_into",
            "display_text": "Focus Revenue spike",
        }

        with patch("cli.MasterAgent", build_agent):
            exit_code = cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--run-dir",
                    str(run_dir),
                    "--resume",
                    "--resume-message-json",
                    cli.json.dumps(payload),
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(captured_agent)
        resume_message = captured_agent.calls[0]["resume_message"]
        self.assertIsInstance(resume_message, UserMessage)
        self.assertEqual(resume_message.message_id, "msg_structured")
        self.assertEqual(resume_message.kind, "focus")

    def test_cli_enables_stable_output_mode_in_settings(self) -> None:
        temp_dir = make_test_dir("stable_llm_output")
        dataset_path = temp_dir / "sample.csv"
        dataset_path.write_text("a,b\n1,2\n", encoding="utf-8")
        captured_agent: FakeMasterAgent | None = None

        def build_agent(*args, **kwargs):
            nonlocal captured_agent
            captured_agent = FakeMasterAgent(*args, **kwargs)
            return captured_agent

        with patch("cli.MasterAgent", build_agent):
            exit_code = cli.main(
                [
                    "--dataset",
                    str(dataset_path),
                    "--user-goal",
                    "Analyze sample data",
                    "--stable",
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(captured_agent)
        assert captured_agent is not None
        self.assertTrue(captured_agent.settings.stable_llm_output)


if __name__ == "__main__":
    unittest.main()
