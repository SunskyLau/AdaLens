from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from utils import execute_python_code_streaming  # noqa: E402


class TestExecutePythonCodeStreaming(unittest.TestCase):
    def test_forces_utf8_stdio_for_child_python(self) -> None:
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []

        with patch.dict(os.environ, {"PYTHONIOENCODING": "gbk"}, clear=False):
            result = execute_python_code_streaming(
                code="print('G3=0 学生群体 failures 分布:')",
                on_stdout=stdout_chunks.append,
                on_stderr=stderr_chunks.append,
                timeout=5,
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["stdout"].strip(), "G3=0 学生群体 failures 分布:")
        self.assertEqual("".join(stdout_chunks).strip(), "G3=0 学生群体 failures 分布:")
        self.assertEqual("".join(stderr_chunks), "")


if __name__ == "__main__":
    unittest.main()
