"""
Local import bootstrap for backend/framework/* modules.

This project keeps `config.py` and `utils.py` at the backend root, while most
runtime code lives under `backend/framework/`.

When these framework modules are executed directly (or imported in unusual
contexts), `backend/` may not be on `sys.path`. Centralize the "add backend to
sys.path" workaround here to avoid duplicating it across modules.
"""

from __future__ import annotations

import sys
from pathlib import Path


def ensure_backend_on_path() -> Path:
    backend_dir = Path(__file__).resolve().parents[1]
    backend_str = str(backend_dir)
    if backend_str not in sys.path:
        sys.path.insert(0, backend_str)
    return backend_dir

