"""
Shared runtime clock helpers.

This module centralizes backend timestamp generation so model-cache replay can
freeze timestamp-producing code paths without rewriting each caller.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Iterator, Protocol


class TimestampProvider(Protocol):
    def next_timestamp(self) -> str:
        ...


_TIMESTAMP_PROVIDER_STACK: ContextVar[tuple[TimestampProvider, ...]] = ContextVar(
    "_TIMESTAMP_PROVIDER_STACK",
    default=(),
)


def real_now_iso() -> str:
    return datetime.now().isoformat()


def now_iso() -> str:
    providers = _TIMESTAMP_PROVIDER_STACK.get()
    if not providers:
        return real_now_iso()
    return providers[-1].next_timestamp()


@contextmanager
def use_timestamp_provider(provider: TimestampProvider) -> Iterator[None]:
    stack = _TIMESTAMP_PROVIDER_STACK.get()
    token = _TIMESTAMP_PROVIDER_STACK.set(stack + (provider,))
    try:
        yield
    finally:
        _TIMESTAMP_PROVIDER_STACK.reset(token)
