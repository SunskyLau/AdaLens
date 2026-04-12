"""
Embedding helper for Agentic EDA.

Uses a configurable OpenAI-compatible backend (online API or Ollama)
to compute text embeddings.
"""

from __future__ import annotations

from typing import List, Optional

try:
    from .path_bootstrap import ensure_backend_on_path
except ImportError:  # pragma: no cover
    # Allow running as a script: `python backend/framework/embedder.py`
    from path_bootstrap import ensure_backend_on_path  # type: ignore[no-redef]

ensure_backend_on_path()

from model_cache import consume_last_model_cache_binding, use_uncounted_model_cache_calls  # noqa: E402

from config import (
    OLLAMA_CLIENT,
    EMBEDDING_CLIENT,
    EMBEDDING_BACKEND,
    EMBEDDING_MODEL_NAME,
    EMBEDDING_ENABLED,
    EMBEDDING_REQUIRED,
    EMBEDDING_MAX_TEXT_CHARS,
    EMBEDDING_TIMEOUT_SECS,
    OPENAI_API_KEY,
)


class Embedder:
    def __init__(self) -> None:
        self._warned = False

    def _resolve_backend(self) -> str:
        backend = (EMBEDDING_BACKEND or "").strip().lower()
        if backend in ("openai", "ollama"):
            return backend
        raise RuntimeError(f"Unsupported embedding backend: {EMBEDDING_BACKEND!r}")

    def _resolve_client(self) -> tuple[str, Optional[object]]:
        backend = self._resolve_backend()
        if backend == "openai" and not OPENAI_API_KEY:
            return backend, None
        if backend == "ollama":
            return backend, OLLAMA_CLIENT
        return backend, EMBEDDING_CLIENT

    def assert_ready(self) -> None:
        if not EMBEDDING_ENABLED:
            if EMBEDDING_REQUIRED:
                raise RuntimeError("Embeddings are disabled but EMBEDDING_REQUIRED=True.")
            self._warn_once("Embeddings are disabled; continuing without embeddings.")
            return
        backend, client = self._resolve_client()
        if client is None:
            if EMBEDDING_REQUIRED:
                raise RuntimeError(f"Embedding client is unavailable (backend={backend}).")
            self._warn_once(f"Embedding client is unavailable (backend={backend}); continuing without embeddings.")
            return
        try:
            with use_uncounted_model_cache_calls():
                consume_last_model_cache_binding()
                resp = client.embeddings.create(
                    model=EMBEDDING_MODEL_NAME,
                    input=["embedding_preflight"],
                    timeout=EMBEDDING_TIMEOUT_SECS,
                )
                consume_last_model_cache_binding()
            data = resp.data or []
            if not data:
                raise RuntimeError("Embedding preflight returned no data.")
            emb = getattr(data[0], "embedding", None)
            if not emb or len(emb) == 0:
                raise RuntimeError("Embedding preflight returned empty vector.")
        except Exception as exc:
            if EMBEDDING_REQUIRED:
                raise RuntimeError(f"Embedding preflight failed (backend={backend}): {exc}") from exc
            self._warn_once(f"Embedding preflight failed (backend={backend}); continuing without embeddings: {exc}")
            return

    def embed_text(self, text: str) -> Optional[List[float]]:
        res = self.embed_texts([text])
        return res[0] if res else None

    def embed_texts(self, texts: List[str]) -> List[Optional[List[float]]]:
        if not EMBEDDING_ENABLED:
            if EMBEDDING_REQUIRED:
                raise RuntimeError("Embeddings are disabled but EMBEDDING_REQUIRED=True.")
            return [None for _ in texts]
        backend, client = self._resolve_client()
        if client is None:
            if EMBEDDING_REQUIRED:
                raise RuntimeError(f"Embedding client is unavailable (backend={backend}).")
            self._warn_once(
                f"Embedding client is not available (backend={backend}); embeddings disabled."
            )
            return [None for _ in texts]
        if not texts:
            return []

        cleaned = [self._truncate(t) for t in texts]
        try:
            consume_last_model_cache_binding()
            resp = client.embeddings.create(
                model=EMBEDDING_MODEL_NAME,
                input=cleaned,
                timeout=EMBEDDING_TIMEOUT_SECS,
            )
            consume_last_model_cache_binding()
            data = resp.data or []
            embeddings: List[Optional[List[float]]] = [None for _ in cleaned]
            for i, item in enumerate(data):
                try:
                    embeddings[i] = list(item.embedding)
                except Exception:
                    embeddings[i] = None
            if len(embeddings) < len(cleaned):
                embeddings.extend([None] * (len(cleaned) - len(embeddings)))
            if EMBEDDING_REQUIRED and any((not emb or len(emb) == 0) for emb in embeddings):
                raise RuntimeError("Embedding generation returned empty vector(s).")
            return embeddings
        except Exception as exc:
            if EMBEDDING_REQUIRED:
                raise RuntimeError(f"Embedding failed (backend={backend}): {exc}") from exc
            self._warn_once(f"Embedding failed (backend={backend}): {exc}")
            return [None for _ in texts]

    def _truncate(self, text: str) -> str:
        if not text:
            return ""
        if EMBEDDING_MAX_TEXT_CHARS and len(text) > EMBEDDING_MAX_TEXT_CHARS:
            return text[:EMBEDDING_MAX_TEXT_CHARS]
        return text

    def _warn_once(self, message: str) -> None:
        if self._warned:
            return
        self._warned = True
        print(f"[EMBEDDING WARNING] {message}")
