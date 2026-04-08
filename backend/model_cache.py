"""
Project-level model cache with timestamp-tape replay support.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, Iterator

from cache_normalization import CacheNormalizationBindings, CacheNormalizationContext
from runtime_clock import real_now_iso, use_timestamp_provider


CACHE_DIR = (Path(__file__).resolve().parent / ".cache").resolve()
LLM_CACHE_READ_FILE_ENV = "AGENTIC_EDA_LLM_CACHE_READ_FILE"
LLM_CACHE_WRITE_FILE_ENV = "AGENTIC_EDA_LLM_CACHE_WRITE_FILE"
LOCK_POLL_SECONDS = 0.05
LOCK_TIMEOUT_SECONDS = 10.0
MODEL_CACHE_SCHEMA_VERSION = 2
RUN_MODEL_CACHE_STATE_SCHEMA_VERSION = 1
RUN_MODEL_CACHE_STATE_FILE_NAME = ".model_cache_state.json"
_INVALID_CACHE_FILE_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_LAST_BINDING: dict[int, "TimestampTapeBinding | None"] = {}
_LAST_BINDING_LOCK = RLock()
_ACTIVE_NORMALIZATION_CONTEXT: dict[int, CacheNormalizationContext | None] = {}
_ACTIVE_NORMALIZATION_CONTEXT_LOCK = RLock()
_ACTIVE_RUN_CONTEXT: dict[int, "RunModelCacheContext | None"] = {}
_ACTIVE_RUN_CONTEXT_LOCK = RLock()
_UNCOUNTED_CALLS_ACTIVE: dict[int, bool] = {}
_UNCOUNTED_CALLS_ACTIVE_LOCK = RLock()
_RUN_TRACKERS: dict[str, "RunCallIndexTracker"] = {}
_RUN_TRACKERS_LOCK = RLock()


def normalize_cache_file_name(raw_name: Any) -> str | None:
    value = str(raw_name or "").strip()
    if not value:
        return None
    if value in {".", ".."}:
        raise ValueError(f"Invalid cache file name: {value}")
    if "/" in value or "\\" in value:
        raise ValueError(f"Cache file name must stay within backend/.cache: {value}")
    if _INVALID_CACHE_FILE_CHARS_RE.search(value):
        raise ValueError(f"Invalid cache file name: {value}")
    return value if value.lower().endswith(".json") else f"{value}.json"


def resolve_cache_file_path(raw_name: Any) -> Path | None:
    normalized_name = normalize_cache_file_name(raw_name)
    if normalized_name is None:
        return None
    return (CACHE_DIR / normalized_name).resolve()


def cache_config_enabled(*, read_file_name: Any = None, write_file_name: Any = None) -> bool:
    return (
        normalize_cache_file_name(read_file_name) is not None
        or normalize_cache_file_name(write_file_name) is not None
    )


def resolve_model_cache_state_path(run_dir: str | Path | None) -> Path | None:
    if run_dir is None:
        return None
    return (Path(run_dir).resolve() / RUN_MODEL_CACHE_STATE_FILE_NAME).resolve()


def _thread_key() -> int:
    try:
        import threading

        return threading.get_ident()
    except Exception:
        return 0


def _set_last_binding(binding: "TimestampTapeBinding | None") -> None:
    with _LAST_BINDING_LOCK:
        _LAST_BINDING[_thread_key()] = binding


def get_active_model_cache_normalization_context() -> CacheNormalizationContext | None:
    with _ACTIVE_NORMALIZATION_CONTEXT_LOCK:
        return _ACTIVE_NORMALIZATION_CONTEXT.get(_thread_key())


@contextmanager
def use_model_cache_normalization_context(
    context: CacheNormalizationContext | None,
) -> Iterator[None]:
    key = _thread_key()
    with _ACTIVE_NORMALIZATION_CONTEXT_LOCK:
        previous = _ACTIVE_NORMALIZATION_CONTEXT.get(key)
        _ACTIVE_NORMALIZATION_CONTEXT[key] = context
    try:
        yield
    finally:
        with _ACTIVE_NORMALIZATION_CONTEXT_LOCK:
            if previous is None:
                _ACTIVE_NORMALIZATION_CONTEXT.pop(key, None)
            else:
                _ACTIVE_NORMALIZATION_CONTEXT[key] = previous


def consume_last_model_cache_binding() -> "TimestampTapeBinding | None":
    with _LAST_BINDING_LOCK:
        key = _thread_key()
        binding = _LAST_BINDING.get(key)
        _LAST_BINDING[key] = None
        return binding


@contextmanager
def activate_timestamp_binding(binding: "TimestampTapeBinding | None") -> Iterator[None]:
    if binding is None:
        yield
        return
    with binding.activate():
        yield


def finalize_timestamp_binding(binding: "TimestampTapeBinding | None") -> None:
    if binding is not None:
        binding.finalize()


class _FileLock:
    def __init__(self, target: Path) -> None:
        self._lock_path = target.with_suffix(target.suffix + ".lock")
        self._fd: int | None = None

    def __enter__(self) -> "_FileLock":
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                self._fd = os.open(str(self._lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for cache lock: {self._lock_path}")
                time.sleep(LOCK_POLL_SECONDS)

    def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
        try:
            self._lock_path.unlink()
        except FileNotFoundError:
            pass


@dataclass(frozen=True)
class RunModelCacheContext:
    run_dir: Path
    tracker: "RunCallIndexTracker"

    def allocate_call_index(self) -> int:
        return self.tracker.allocate_call_index()


class RunCallIndexTracker:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir.resolve()
        self.state_path = (self.run_dir / RUN_MODEL_CACHE_STATE_FILE_NAME).resolve()
        self._thread_lock = RLock()

    def allocate_call_index(self) -> int:
        with self._thread_lock:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            with _FileLock(self.state_path):
                state = self._read_state_data()
                call_index = int(state.get("next_call_index", 1) or 1)
                if call_index < 1:
                    call_index = 1
                state["schema_version"] = RUN_MODEL_CACHE_STATE_SCHEMA_VERSION
                state["next_call_index"] = call_index + 1
                self._write_state_data(state)
                return call_index

    def read_state(self) -> dict[str, Any]:
        with self._thread_lock:
            return self._read_state_data()

    def _read_state_data(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return self._default_state_data()
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return self._default_state_data()
        if not isinstance(raw, dict):
            return self._default_state_data()
        try:
            next_call_index = int(raw.get("next_call_index", 1) or 1)
        except (TypeError, ValueError):
            next_call_index = 1
        return {
            "schema_version": RUN_MODEL_CACHE_STATE_SCHEMA_VERSION,
            "next_call_index": max(1, next_call_index),
        }

    def _write_state_data(self, state: dict[str, Any]) -> None:
        payload = {
            "schema_version": RUN_MODEL_CACHE_STATE_SCHEMA_VERSION,
            "next_call_index": max(1, int(state.get("next_call_index", 1) or 1)),
        }
        tmp_path = self.state_path.with_suffix(self.state_path.suffix + f".{uuid.uuid4().hex}.tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, self.state_path)

    @staticmethod
    def _default_state_data() -> dict[str, Any]:
        return {"schema_version": RUN_MODEL_CACHE_STATE_SCHEMA_VERSION, "next_call_index": 1}


def build_model_cache_run_context(run_dir: str | Path | None) -> RunModelCacheContext | None:
    resolved_state_path = resolve_model_cache_state_path(run_dir)
    if resolved_state_path is None:
        return None
    run_dir_path = resolved_state_path.parent
    registry_key = str(run_dir_path)
    with _RUN_TRACKERS_LOCK:
        tracker = _RUN_TRACKERS.get(registry_key)
        if tracker is None:
            tracker = RunCallIndexTracker(run_dir_path)
            _RUN_TRACKERS[registry_key] = tracker
    return RunModelCacheContext(run_dir=run_dir_path, tracker=tracker)


def get_active_model_cache_run_context() -> RunModelCacheContext | None:
    with _ACTIVE_RUN_CONTEXT_LOCK:
        return _ACTIVE_RUN_CONTEXT.get(_thread_key())


@contextmanager
def use_model_cache_run_context(context: RunModelCacheContext | None) -> Iterator[None]:
    key = _thread_key()
    with _ACTIVE_RUN_CONTEXT_LOCK:
        previous = _ACTIVE_RUN_CONTEXT.get(key)
        _ACTIVE_RUN_CONTEXT[key] = context
    try:
        yield
    finally:
        with _ACTIVE_RUN_CONTEXT_LOCK:
            if previous is None:
                _ACTIVE_RUN_CONTEXT.pop(key, None)
            else:
                _ACTIVE_RUN_CONTEXT[key] = previous


def _counted_model_cache_calls_enabled() -> bool:
    with _UNCOUNTED_CALLS_ACTIVE_LOCK:
        return not _UNCOUNTED_CALLS_ACTIVE.get(_thread_key(), False)


@contextmanager
def use_uncounted_model_cache_calls() -> Iterator[None]:
    key = _thread_key()
    with _UNCOUNTED_CALLS_ACTIVE_LOCK:
        previous = _UNCOUNTED_CALLS_ACTIVE.get(key, False)
        _UNCOUNTED_CALLS_ACTIVE[key] = True
    try:
        yield
    finally:
        with _UNCOUNTED_CALLS_ACTIVE_LOCK:
            if previous:
                _UNCOUNTED_CALLS_ACTIVE[key] = previous
            else:
                _UNCOUNTED_CALLS_ACTIVE.pop(key, None)


class CachePayloadObject:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        for key, value in payload.items():
            setattr(self, key, payload_to_sdk_object(value))

    def model_dump(self, **_kwargs: Any) -> dict[str, Any]:
        return _deep_copy_json_value(self._payload)

    def dict(self, **_kwargs: Any) -> dict[str, Any]:
        return self.model_dump()


def payload_to_sdk_object(value: Any) -> Any:
    if isinstance(value, dict):
        return CachePayloadObject(value)
    if isinstance(value, list):
        return [payload_to_sdk_object(item) for item in value]
    return value


def serialize_payload(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        try:
            return serialize_payload(value.model_dump(exclude_none=True, exclude_unset=True))
        except TypeError:
            return serialize_payload(value.model_dump())
    if hasattr(value, "dict"):
        try:
            return serialize_payload(value.dict(exclude_none=True, exclude_unset=True))
        except TypeError:
            return serialize_payload(value.dict())
    if isinstance(value, dict):
        return {str(key): serialize_payload(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize_payload(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "__dict__"):
        raw = {key: item for key, item in vars(value).items() if not key.startswith("_")}
        if raw:
            return serialize_payload(raw)
    return str(value)


def _normalize_for_request_key(value: Any) -> Any:
    serialized = serialize_payload(value)
    if isinstance(serialized, dict):
        normalized: dict[str, Any] = {}
        for key in sorted(serialized.keys()):
            if key == "timeout":
                continue
            normalized[key] = _normalize_for_request_key(serialized[key])
        return normalized
    if isinstance(serialized, list):
        return [_normalize_for_request_key(item) for item in serialized]
    return serialized


def build_request_key(*, client_namespace: str, request_kind: str, params: dict[str, Any]) -> str:
    payload = {
        "client_namespace": client_namespace,
        "request_kind": request_kind,
        "params": _normalize_for_request_key(params),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _deep_copy_json_value(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _normalize_request_params_for_cache(
    params: dict[str, Any],
    context: CacheNormalizationContext | None,
) -> dict[str, Any]:
    serialized = serialize_payload(params)
    if not isinstance(serialized, dict):
        serialized = {"value": serialized}
    if context is not None:
        serialized = context.normalize_request_value(serialized)
    return serialized


def _normalize_response_payload_for_cache(
    payload: dict[str, Any],
    context: CacheNormalizationContext | None,
) -> dict[str, Any]:
    normalized = _deep_copy_json_value(payload)
    if context is not None:
        normalized = context.normalize_response_value(normalized)
    return normalized


def _rehydrate_cached_payload_for_runtime(
    payload: dict[str, Any],
    *,
    context: CacheNormalizationContext | None,
    normalization_bindings: CacheNormalizationBindings,
) -> dict[str, Any] | None:
    runtime_payload = _deep_copy_json_value(payload)
    if not normalization_bindings.stable_tokens():
        return runtime_payload
    if context is None:
        return None
    rehydrated = context.rehydrate_cached_value(runtime_payload, normalization_bindings)
    if not isinstance(rehydrated, dict):
        return None
    return rehydrated


class ModelCacheStore:
    def __init__(
        self,
        *,
        enabled: bool | None = None,
        cache_path: Path | None = None,
        read_path: Path | None = None,
        write_path: Path | None = None,
    ) -> None:
        default_read_path = read_path
        default_write_path = write_path
        if cache_path is not None and default_read_path is None and default_write_path is None:
            resolved_cache_path = cache_path.resolve()
            default_read_path = resolved_cache_path
            default_write_path = resolved_cache_path
        if enabled is None:
            default_read_path = (
                resolve_cache_file_path(os.environ.get(LLM_CACHE_READ_FILE_ENV))
                if default_read_path is None
                else default_read_path.resolve()
            )
            default_write_path = (
                resolve_cache_file_path(os.environ.get(LLM_CACHE_WRITE_FILE_ENV))
                if default_write_path is None
                else default_write_path.resolve()
            )
            self.enabled = default_read_path is not None or default_write_path is not None
        else:
            self.enabled = bool(enabled)
            default_read_path = default_read_path.resolve() if default_read_path is not None else None
            default_write_path = default_write_path.resolve() if default_write_path is not None else None
        self.read_path = default_read_path
        self.write_path = default_write_path
        self._thread_lock = RLock()

    def lookup_by_call_index(
        self,
        *,
        call_index: int,
        request_key: str,
        request_kind: str,
    ) -> dict[str, Any] | None:
        if not self.enabled or call_index < 1:
            return None
        for cache_path in self._lookup_paths():
            data = self._read_cache_data(cache_path)
            entry = self._entry_at_call_index(data, call_index)
            if not self._entry_matches(entry, request_key=request_key, request_kind=request_kind):
                continue
            return _deep_copy_json_value(entry)
        return None

    def write_entry_if_absent(
        self,
        *,
        call_index: int,
        request_key: str,
        request_kind: str,
        response_payload: dict[str, Any],
        timestamp_tape: list[str] | None = None,
        normalization_bindings: dict[str, Any] | None = None,
    ) -> None:
        if not self.enabled or self.write_path is None or call_index < 1:
            return
        timestamp_tape = [str(item) for item in (timestamp_tape or [])]
        serialized_bindings = (
            CacheNormalizationBindings.from_dict(normalization_bindings).to_dict()
            if normalization_bindings
            else None
        )
        with self._write_locked_cache_data(self.write_path) as data:
            entries = self._ensure_entry_capacity(data, call_index)
            existing = entries[call_index - 1]
            if isinstance(existing, dict):
                if (
                    self._entry_matches(existing, request_key=request_key, request_kind=request_kind)
                    and serialized_bindings
                    and not isinstance(existing.get("normalization_bindings"), dict)
                ):
                    existing["normalization_bindings"] = serialized_bindings
                return
            entry: dict[str, Any] = {
                "call_index": call_index,
                "request_key": request_key,
                "request_kind": request_kind,
                "response_payload": _deep_copy_json_value(response_payload),
                "timestamp_tape": timestamp_tape,
            }
            if serialized_bindings:
                entry["normalization_bindings"] = serialized_bindings
            entries[call_index - 1] = entry

    def attach_timestamp_tape(
        self,
        *,
        call_index: int,
        request_key: str,
        request_kind: str,
        timestamp_tape: list[str],
    ) -> None:
        if not self.enabled or self.write_path is None or call_index < 1:
            return
        with self._write_locked_cache_data(self.write_path) as data:
            entry = self._entry_at_call_index(data, call_index)
            if not self._entry_matches(entry, request_key=request_key, request_kind=request_kind):
                return
            current_tape = entry.get("timestamp_tape")
            if isinstance(current_tape, list) and current_tape:
                return
            entry["timestamp_tape"] = [str(item) for item in timestamp_tape]

    def _entry_matches(
        self,
        entry: dict[str, Any] | None,
        *,
        request_key: str,
        request_kind: str,
    ) -> bool:
        if not isinstance(entry, dict):
            return False
        return (
            entry.get("request_key") == request_key
            and entry.get("request_kind") == request_kind
        )

    def _entry_at_call_index(self, data: dict[str, Any], call_index: int) -> dict[str, Any] | None:
        entries = data.get("entries", [])
        if not isinstance(entries, list):
            return None
        slot = call_index - 1
        if slot < 0 or slot >= len(entries):
            return None
        entry = entries[slot]
        return entry if isinstance(entry, dict) else None

    def _ensure_entry_capacity(self, data: dict[str, Any], call_index: int) -> list[Any]:
        entries = data.get("entries")
        if not isinstance(entries, list):
            entries = []
            data["entries"] = entries
        while len(entries) < call_index:
            entries.append(None)
        return entries

    def _lookup_paths(self) -> list[Path]:
        paths: list[Path] = []
        if self.read_path is not None:
            paths.append(self.read_path)
        if self.write_path is not None and self.write_path not in paths:
            paths.append(self.write_path)
        return paths

    def _read_cache_data(self, cache_path: Path) -> dict[str, Any]:
        with self._thread_lock:
            if not cache_path.exists():
                return self._default_cache_data()
            try:
                raw = json.loads(cache_path.read_text(encoding="utf-8"))
            except Exception:
                return self._default_cache_data()
        return self._normalize_cache_data(raw)

    def _normalize_cache_data(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            return self._default_cache_data()
        if raw.get("schema_version") != MODEL_CACHE_SCHEMA_VERSION:
            return self._default_cache_data()
        entries = raw.get("entries")
        if not isinstance(entries, list):
            return self._default_cache_data()
        normalized_entries: list[Any] = []
        for index, entry in enumerate(entries, start=1):
            if not isinstance(entry, dict):
                normalized_entries.append(None)
                continue
            normalized_entry = dict(entry)
            normalized_entry["call_index"] = index
            normalized_entries.append(normalized_entry)
        return {"schema_version": MODEL_CACHE_SCHEMA_VERSION, "entries": normalized_entries}

    @contextmanager
    def _write_locked_cache_data(self, cache_path: Path) -> Iterator[dict[str, Any]]:
        with self._thread_lock:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with _FileLock(cache_path):
                data = self._read_cache_data(cache_path)
                yield data
                tmp_path = cache_path.with_suffix(cache_path.suffix + f".{uuid.uuid4().hex}.tmp")
                tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(tmp_path, cache_path)

    @staticmethod
    def _default_cache_data() -> dict[str, Any]:
        return {"schema_version": MODEL_CACHE_SCHEMA_VERSION, "entries": []}


class TimestampTapeBinding:
    def __init__(
        self,
        *,
        cache_store: ModelCacheStore,
        call_index: int,
        request_key: str,
        request_kind: str,
        hit: bool,
        timestamp_tape: list[str] | None = None,
    ) -> None:
        self._cache_store = cache_store
        self.call_index = call_index
        self.request_key = request_key
        self.request_kind = request_kind
        self.hit = hit
        self._timestamp_tape = [str(item) for item in (timestamp_tape or [])]
        self._cursor = 0
        self._finalized = False

    def next_timestamp(self) -> str:
        if self.hit:
            if self._cursor < len(self._timestamp_tape):
                value = self._timestamp_tape[self._cursor]
                self._cursor += 1
                return value
            return real_now_iso()
        value = real_now_iso()
        self._timestamp_tape.append(value)
        self._cursor += 1
        return value

    @contextmanager
    def activate(self) -> Iterator["TimestampTapeBinding"]:
        with use_timestamp_provider(self):
            yield self

    def finalize(self) -> None:
        if self.hit or self._finalized:
            return
        self._cache_store.attach_timestamp_tape(
            call_index=self.call_index,
            request_key=self.request_key,
            request_kind=self.request_kind,
            timestamp_tape=self._timestamp_tape,
        )
        self._finalized = True


class CacheAwareChatCompletions:
    def __init__(self, *, client_namespace: str, completions: Any, cache_store: ModelCacheStore) -> None:
        self._client_namespace = client_namespace
        self._completions = completions
        self._cache_store = cache_store

    def create(self, **kwargs: Any) -> Any:
        normalization_context = get_active_model_cache_normalization_context()
        normalized_params = _normalize_request_params_for_cache(kwargs, normalization_context)
        if not self._cache_store.enabled or not _counted_model_cache_calls_enabled():
            _set_last_binding(None)
            return self._completions.create(**kwargs)
        run_context = get_active_model_cache_run_context()
        if run_context is None:
            _set_last_binding(None)
            return self._completions.create(**kwargs)

        call_index = run_context.allocate_call_index()
        request_key = build_request_key(
            client_namespace=self._client_namespace,
            request_kind="chat_completion",
            params=normalized_params,
        )
        cached = self._cache_store.lookup_by_call_index(
            call_index=call_index,
            request_key=request_key,
            request_kind="chat_completion",
        )
        if cached is not None:
            normalization_bindings = CacheNormalizationBindings.from_dict(
                cached.get("normalization_bindings")
            )
            runtime_payload = _rehydrate_cached_payload_for_runtime(
                cached["response_payload"],
                context=normalization_context,
                normalization_bindings=normalization_bindings,
            )
            if runtime_payload is not None:
                _set_last_binding(
                    TimestampTapeBinding(
                        cache_store=self._cache_store,
                        call_index=call_index,
                        request_key=request_key,
                        request_kind="chat_completion",
                        hit=True,
                        timestamp_tape=cached.get("timestamp_tape") or [],
                    )
                )
                return payload_to_sdk_object(runtime_payload)

        response = self._completions.create(**kwargs)
        response_payload = serialize_payload(response)
        if not isinstance(response_payload, dict):
            response_payload = {"value": response_payload}
        normalized_response_payload = _normalize_response_payload_for_cache(
            response_payload,
            normalization_context,
        )
        self._cache_store.write_entry_if_absent(
            call_index=call_index,
            request_key=request_key,
            request_kind="chat_completion",
            response_payload=normalized_response_payload,
            timestamp_tape=[],
            normalization_bindings=(
                normalization_context.bindings.to_dict()
                if normalization_context is not None
                else None
            ),
        )
        _set_last_binding(
            TimestampTapeBinding(
                cache_store=self._cache_store,
                call_index=call_index,
                request_key=request_key,
                request_kind="chat_completion",
                hit=False,
            )
        )
        return response


class CacheAwareEmbeddings:
    def __init__(self, *, client_namespace: str, embeddings: Any, cache_store: ModelCacheStore) -> None:
        self._client_namespace = client_namespace
        self._embeddings = embeddings
        self._cache_store = cache_store

    def create(self, **kwargs: Any) -> Any:
        normalization_context = get_active_model_cache_normalization_context()
        normalized_params = _normalize_request_params_for_cache(kwargs, normalization_context)
        if not self._cache_store.enabled or not _counted_model_cache_calls_enabled():
            _set_last_binding(None)
            return self._embeddings.create(**kwargs)
        run_context = get_active_model_cache_run_context()
        if run_context is None:
            _set_last_binding(None)
            return self._embeddings.create(**kwargs)

        call_index = run_context.allocate_call_index()
        request_key = build_request_key(
            client_namespace=self._client_namespace,
            request_kind="embedding",
            params=normalized_params,
        )
        cached = self._cache_store.lookup_by_call_index(
            call_index=call_index,
            request_key=request_key,
            request_kind="embedding",
        )
        if cached is not None:
            normalization_bindings = CacheNormalizationBindings.from_dict(
                cached.get("normalization_bindings")
            )
            runtime_payload = _rehydrate_cached_payload_for_runtime(
                cached["response_payload"],
                context=normalization_context,
                normalization_bindings=normalization_bindings,
            )
            if runtime_payload is not None:
                _set_last_binding(
                    TimestampTapeBinding(
                        cache_store=self._cache_store,
                        call_index=call_index,
                        request_key=request_key,
                        request_kind="embedding",
                        hit=True,
                        timestamp_tape=cached.get("timestamp_tape") or [],
                    )
                )
                return payload_to_sdk_object(runtime_payload)

        response = self._embeddings.create(**kwargs)
        response_payload = serialize_payload(response)
        if not isinstance(response_payload, dict):
            response_payload = {"value": response_payload}
        normalized_response_payload = _normalize_response_payload_for_cache(
            response_payload,
            normalization_context,
        )
        self._cache_store.write_entry_if_absent(
            call_index=call_index,
            request_key=request_key,
            request_kind="embedding",
            response_payload=normalized_response_payload,
            timestamp_tape=[],
            normalization_bindings=(
                normalization_context.bindings.to_dict()
                if normalization_context is not None
                else None
            ),
        )
        _set_last_binding(
            TimestampTapeBinding(
                cache_store=self._cache_store,
                call_index=call_index,
                request_key=request_key,
                request_kind="embedding",
                hit=False,
            )
        )
        return response


class CacheAwareChat:
    def __init__(self, *, client_namespace: str, chat: Any, cache_store: ModelCacheStore) -> None:
        self._chat = chat
        self.completions = CacheAwareChatCompletions(
            client_namespace=client_namespace,
            completions=chat.completions,
            cache_store=cache_store,
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._chat, name)


class CacheAwareClient:
    def __init__(self, *, client_namespace: str, client: Any, cache_store: ModelCacheStore) -> None:
        self._client = client
        self._cache_store = cache_store
        if hasattr(client, "chat") and getattr(client.chat, "completions", None) is not None:
            self.chat = CacheAwareChat(
                client_namespace=client_namespace,
                chat=client.chat,
                cache_store=cache_store,
            )
        if hasattr(client, "embeddings") and getattr(client, "embeddings", None) is not None:
            self.embeddings = CacheAwareEmbeddings(
                client_namespace=client_namespace,
                embeddings=client.embeddings,
                cache_store=cache_store,
            )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


GLOBAL_MODEL_CACHE = ModelCacheStore()


def runtime_requires_serial_sub_agent_execution() -> bool:
    return GLOBAL_MODEL_CACHE.enabled


def wrap_client_with_cache(client_namespace: str, client: Any) -> Any:
    if client is None or not GLOBAL_MODEL_CACHE.enabled:
        return client
    return CacheAwareClient(
        client_namespace=client_namespace,
        client=client,
        cache_store=GLOBAL_MODEL_CACHE,
    )
