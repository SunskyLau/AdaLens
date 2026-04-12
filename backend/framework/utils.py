"""
Framework-local re-export for shared backend utilities.

The analyzer still imports the backend-root `utils.py` for backward
compatibility, while the new v0.1 layout exposes the same helper under
`framework/utils.py` to match the plan structure.
"""

from __future__ import annotations

from utils import execute_python_code_streaming

__all__ = ["execute_python_code_streaming"]
