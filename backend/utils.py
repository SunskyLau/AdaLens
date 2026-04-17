"""
Shared backend utilities.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, TextIO


def execute_python_code_streaming(
    code: str,
    on_stdout: Callable[[str], None],
    on_stderr: Callable[[str], None],
    timeout: int = 30,
    cwd: str | Path | None = None,
    stop_requested: Callable[[], str | None] | None = None,
) -> dict[str, Any]:
    """
    Execute Python code in a subprocess with streaming output.

    Returns a dict with `success`, `stdout`, `stderr`, and optional `error`.
    """
    temp_path: Path | None = None
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".py",
            delete=False,
            encoding="utf-8",
        ) as f:
            f.write(code)
            temp_path = Path(f.name)

        # Run in an explicit working directory when provided (Analyzer uses run_dir
        # to prevent generated files from polluting repo root).
        run_cwd = Path(cwd).resolve() if cwd is not None else Path(__file__).resolve().parent.parent
        child_env = {
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            # Keep child Python stdio aligned with the parent's pipe decoder.
            "PYTHONIOENCODING": "utf-8",
        }

        process = subprocess.Popen(
            [sys.executable, "-u", str(temp_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=run_cwd,
            encoding="utf-8",
            errors="replace",
            env=child_env,
        )

        def read_stream(stream: TextIO, content: list[str], callback: Callable[[str], None]) -> None:
            try:
                while True:
                    chunk = stream.read(4096)
                    if not chunk:
                        break
                    content.append(chunk)
                    callback(chunk)
            except Exception:
                return
            finally:
                try:
                    stream.close()
                except Exception:
                    pass

        if process.stdout is None or process.stderr is None:
            raise RuntimeError("Subprocess streams were not captured.")

        stdout_thread = threading.Thread(
            target=read_stream,
            args=(process.stdout, stdout_chunks, on_stdout),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=read_stream,
            args=(process.stderr, stderr_chunks, on_stderr),
            daemon=True,
        )

        stdout_thread.start()
        stderr_thread.start()

        wait_started = time.monotonic()
        while True:
            # Safe-boundary controls are handled by the worker loop after the
            # current execute_code step returns, rather than by killing the
            # subprocess mid-step here.
            if stop_requested is not None:
                stop_requested()
            if process.poll() is not None:
                break
            if time.monotonic() - wait_started >= timeout:
                process.kill()
                try:
                    process.wait(timeout=2)
                except Exception:
                    pass
                stdout_thread.join(timeout=2)
                stderr_thread.join(timeout=2)
                return {
                    "success": False,
                    "stdout": "".join(stdout_chunks),
                    "stderr": "".join(stderr_chunks),
                    "error": f"Execution timeout after {timeout} seconds",
                }
            time.sleep(0.05)

        stdout_thread.join()
        stderr_thread.join()

        stdout_str = "".join(stdout_chunks)
        stderr_str = "".join(stderr_chunks)

        error = None
        if process.returncode != 0:
            # Prefer stderr tail for debugging; fall back to stdout tail when stderr is empty.
            tail_src = stderr_str.strip() or stdout_str.strip()
            if tail_src:
                tail_lines = tail_src.splitlines()[-20:]
                error = f"Exit code: {process.returncode}\n" + "\n".join(tail_lines)
            else:
                error = f"Exit code: {process.returncode}"

        return {
            "success": process.returncode == 0,
            "stdout": stdout_str,
            "stderr": stderr_str,
            "error": error,
        }

    except Exception as e:
        return {
            "success": False,
            "stdout": "".join(stdout_chunks),
            "stderr": "".join(stderr_chunks),
            "error": str(e),
        }
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass
