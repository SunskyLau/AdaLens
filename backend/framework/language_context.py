"""
Helpers for deriving language-matching context from user-authored messages.
"""

from __future__ import annotations

from typing import Iterable

from .models import UserMessage, normalize_steering_message_kind


USER_AUTHORED_LANGUAGE_MESSAGE_KINDS = {
    "chat",
    "focus",
    "ignore",
    "elaborate",
    "create",
}


def canonical_user_message_text(message: UserMessage | None) -> str:
    if message is None:
        return ""
    for candidate in (message.user_prompt, message.generated_prompt, message.content):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def latest_user_authored_message(
    messages: Iterable[UserMessage] | None,
) -> UserMessage | None:
    if messages is None:
        return None
    materialized = list(messages)
    for message in reversed(materialized):
        kind = normalize_steering_message_kind(getattr(message, "kind", None))
        if kind not in USER_AUTHORED_LANGUAGE_MESSAGE_KINDS:
            continue
        if canonical_user_message_text(message):
            return message
    return None


def latest_user_authored_text(messages: Iterable[UserMessage] | None) -> str:
    return canonical_user_message_text(latest_user_authored_message(messages))


def contains_cjk_text(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def prefers_chinese_text(text: str) -> bool:
    cjk_count = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    latin_count = sum(1 for ch in text if ch.isascii() and ch.isalpha())
    if cjk_count <= 0:
        return False
    if latin_count <= 0:
        return True
    return cjk_count >= latin_count


def latest_user_prefers_chinese(messages: Iterable[UserMessage] | None) -> bool:
    return prefers_chinese_text(latest_user_authored_text(messages))


def natural_language_target_label(text: str) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return "same as the latest user-authored message"
    if prefers_chinese_text(normalized):
        return "Chinese"
    return "same as the latest user-authored message"


def strict_language_match_instruction(text: str) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return (
            "Match every natural-language field to the latest user-authored message when available."
        )
    if prefers_chinese_text(normalized):
        return (
            "The latest user-authored message is Chinese. Every natural-language field you produce "
            "MUST be Chinese. Code, paths, column names, JSON keys, and earlier plan text may stay in "
            "English when they are protocol or schema tokens."
        )
    return (
        "Every natural-language field you produce MUST stay in the same language as the latest "
        "user-authored message shown below. Code, paths, column names, JSON keys, and earlier plan "
        "text may stay in English when they are protocol or schema tokens."
    )
