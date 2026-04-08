"""
User steering queue with optional file-backed ingestion.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .models import RunState, UserMessage
from .store import RunStore


class UserSteerQueue:
    def __init__(
        self,
        *,
        state: RunState | None = None,
        store: RunStore | None = None,
        steer_path: Path | None = None,
    ):
        self._lock = threading.RLock()
        self._messages: list[UserMessage] = []
        self._next_unhandled_index = 0
        self._state = state
        self._store = store
        self._steer_path = steer_path
        self._file_position = 0

    def attach(self, *, state: RunState, store: RunStore | None = None) -> None:
        with self._lock:
            self._state = state
            self._store = store
            self._messages = list(state.user_messages)
            self._next_unhandled_index = len(self._messages)
            if store is not None and self._steer_path is None:
                self._steer_path = store.steer_path

    def push(self, content: str, **kwargs: object) -> UserMessage:
        message = UserMessage.create(content=content, **kwargs)
        self._append_message(message, persist=True)
        return message

    def enqueue(self, message: UserMessage, *, persist: bool) -> UserMessage:
        self._append_message(message, persist=persist)
        return message

    def drain_new_messages(self) -> list[UserMessage]:
        with self._lock:
            new_messages = self._messages[self._next_unhandled_index :]
            self._next_unhandled_index = len(self._messages)
            return list(new_messages)

    def poll_file(self) -> list[UserMessage]:
        path = self._steer_path
        if path is None or not path.exists():
            return []

        new_messages: list[UserMessage] = []
        with self._lock:
            with path.open("r", encoding="utf-8") as handle:
                handle.seek(self._file_position)
                chunk = handle.read()
                self._file_position = handle.tell()

            if not chunk.strip():
                return []

            for raw_line in chunk.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    data = {"content": line}
                message = UserMessage.from_dict(data)
                if any(existing.message_id == message.message_id for existing in self._messages):
                    continue
                self._append_message(message, persist=False)
                new_messages.append(message)
        return new_messages

    def _append_message(self, message: UserMessage, *, persist: bool) -> None:
        with self._lock:
            self._messages.append(message)
            if self._state is not None:
                self._state.user_messages.append(message)
            if self._store is not None:
                self._store.log_user_steer_received(message)
                if persist:
                    self._store.append_steer_message(message)
