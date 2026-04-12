"""
Focus steering helpers.
"""

from __future__ import annotations

from .models import TimelineEntry, Turn, UserMessage


def canonical_focus_prompt(message: UserMessage) -> str:
    return (message.user_prompt or message.generated_prompt or message.content or "").strip()


def append_focus_to_turn(turn: Turn, message: UserMessage) -> None:
    prompt = canonical_focus_prompt(message)
    if prompt:
        turn.steers.append(prompt)
    turn.timeline.append(
        TimelineEntry(
            entry_type="user_steer",
            content={
                "message_id": message.message_id,
                "kind": "focus",
                "content": message.content,
                "display_text": message.display_text,
                "user_prompt": (
                    message.user_prompt
                    if message.user_prompt is not None
                    else (
                        message.generated_prompt
                        if message.generated_prompt is not None
                        else message.content
                    )
                ),
                "system_prompt": message.system_prompt,
                "generated_prompt": (
                    message.generated_prompt
                    if message.generated_prompt is not None
                    else message.content
                ),
                "selected_keywords": list(message.selected_keywords),
                "target": message.target.to_dict() if message.target is not None else None,
            },
        )
    )
