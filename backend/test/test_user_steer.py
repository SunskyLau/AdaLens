from __future__ import annotations

import sys
import tempfile
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from framework.user_steer import UserSteerQueue  # noqa: E402


class TestUserSteerQueue(unittest.TestCase):
    def test_user_steer_queue_drains_new_messages_in_arrival_order(self) -> None:
        queue = UserSteerQueue()

        first = queue.push("Focus on regional differences")
        second = queue.push("Compare 2024 with 2025")

        pending = queue.drain_new_messages()
        self.assertEqual(
            [message.message_id for message in pending],
            [first.message_id, second.message_id],
        )
        self.assertEqual(queue.drain_new_messages(), [])

    def test_user_steer_queue_polls_messages_from_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            steer_path = Path(temp_dir) / "steer.jsonl"
            steer_path.write_text('{"message_id":"msg_file","timestamp":"2026-03-07T00:00:00","content":"Focus on Q4"}\n', encoding="utf-8")
            queue = UserSteerQueue(steer_path=steer_path)

            messages = queue.poll_file()

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].message_id, "msg_file")
        self.assertEqual(queue.drain_new_messages()[0].content, "Focus on Q4")

    def test_user_steer_queue_preserves_structured_message_fields(self) -> None:
        queue = UserSteerQueue()

        message = queue.push(
            "Legacy dive-into prompt",
            kind="dive_into",
            display_text="Focus Revenue spike",
            generated_prompt="Legacy focus prompt",
            user_prompt='Focus follow-up analysis on the summary "Revenue spike".',
            system_prompt=(
                "Focus steering semantics:\n"
                "- Continue allocating attention around this summary target in subsequent planning."
            ),
        )

        drained = queue.drain_new_messages()
        self.assertEqual(len(drained), 1)
        self.assertEqual(drained[0].message_id, message.message_id)
        self.assertEqual(drained[0].kind, "focus")
        self.assertEqual(drained[0].display_text, "Focus Revenue spike")
        self.assertEqual(
            drained[0].user_prompt,
            'Focus follow-up analysis on the summary "Revenue spike".',
        )
        self.assertEqual(
            drained[0].system_prompt,
            "Focus steering semantics:\n"
            "- Continue allocating attention around this summary target in subsequent planning.",
        )


if __name__ == "__main__":
    unittest.main()
