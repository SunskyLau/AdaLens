"""
Master-agent tool schema definitions.
"""

from __future__ import annotations


def _steering_target_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["summary", "atomic"],
                "description": "Citation targets may reference only summary or atomic insight nodes.",
            },
            "summary_id": {
                "type": "string",
                "description": "Stable summary id (insight_id). Required for both summary and atomic citations.",
            },
            "summary_short_label": {
                "type": "string",
                "description": "Human-readable summary label when available.",
            },
            "summary_text": {
                "type": "string",
                "description": "Summary text for the referenced summary node.",
            },
            "columns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Columns associated with the cited summary or atomic insight.",
            },
            "atomic_id": {
                "type": "string",
                "description": "Stable atomic insight id. Required when kind='atomic'.",
            },
            "atomic_text": {
                "type": "string",
                "description": "Atomic insight text when kind='atomic'.",
            },
            "insight_type": {
                "type": "string",
                "description": "Atomic insight taxonomy label when kind='atomic'.",
            },
        },
        "required": ["kind", "summary_id", "columns"],
    }


def _provenance_citation_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "marker": {
                "type": "integer",
                "description": "Numeric citation marker matching inline placeholders like [[1]].",
            },
            "target": _steering_target_schema(),
            "label": {
                "type": "string",
                "description": "Readable citation label for tooltips, debugging, and tests.",
            },
        },
        "required": ["marker", "target", "label"],
    }


def build_master_tool_specs() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": "create_plans",
                "description": (
                    "Create one or more concrete analysis plans to be executed by sub-agents. "
                    "Each plan should target a specific analytical objective (e.g., distribution analysis, "
                    "correlation test, trend detection, group comparison) and reference actual column names "
                    "from the dataset. Create multiple complementary plans to cover different aspects of "
                    "the user's goal. The natural-language plan text must match the latest user-authored "
                    "message's language."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plans": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text": {
                                        "type": "string",
                                        "description": (
                                            "A clear, specific, actionable description of what the "
                                            "sub-agent should analyze. Reference actual column names. "
                                            "This user-visible sentence must use the latest user-authored "
                                            "message's language. Example style: "
                                            "'Analyze the distribution of Sales across different Regions "
                                            "using histograms and summary statistics.'"
                                        ),
                                    },
                                },
                                "required": ["text"],
                            },
                        }
                    },
                    "required": ["plans"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "dispatch_plans",
                "description": (
                    "Dispatch one or more pending plans to sub-agents for execution. Each sub-agent will "
                    "independently write and run Python code to carry out the analysis described in the "
                    "plan. You can dispatch multiple plans in parallel. "
                    "Only dispatch plans that are currently in 'pending' status. "
                    "Typically call this immediately after create_plans."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plan_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "List of plan_id strings to dispatch.",
                        }
                    },
                    "required": ["plan_ids"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "evaluate_progress",
                "description": (
                    "Write a stage summary for a recently completed dispatch batch "
                    "(storyline turn). This is the recommended tool when you want to summarize "
                    "current analytical progress in a near-final-summary style without ending the run. "
                    "Produce a stage-summary card that reads similarly to a final summary, "
                    "but limited to the evidence accumulated so far. "
                    "Assess: (1) which aspects of the goal now have concrete evidence, "
                    "(2) which aspects remain unaddressed, (3) whether any finding warrants "
                    "deeper investigation, (4) whether the analysis is diverse enough. "
                    "All natural-language fields here must match the latest user-authored "
                    "message's language. "
                    "When citations are available, embed inline markers like [[1]] in the markdown body "
                    "and return matching structured citation metadata. "
                    "Immediately after this tool, you must call respond_to_user to explain "
                    "why this checkpoint is justified and what follow-up analysis goals remain."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "evaluation": {
                            "type": "string",
                            "description": (
                                "Backward-compatible plain-text alias for the stage summary. "
                                "Prefer using the same content as stage_summary_markdown, in the "
                                "latest user-authored message's language."
                            ),
                        },
                        "stage_summary_markdown": {
                            "type": "string",
                            "description": (
                                "Markdown stage summary for this completed dispatch batch. "
                                "Write it in the latest user-authored message's language. "
                                "Use inline citation placeholders like [[1]] where relevant."
                            ),
                        },
                        "citations": {
                            "type": "array",
                            "items": _provenance_citation_schema(),
                            "description": (
                                "Structured provenance for inline citation markers used in "
                                "stage_summary_markdown."
                            ),
                        },
                    },
                    "required": ["stage_summary_markdown"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "synthesize_findings",
                "description": (
                    "Write an intermediate synthesis that combines all insights discovered so far "
                    "into a coherent narrative. This is NOT the final summary — it captures the "
                    "current understanding and can be updated as more evidence arrives. "
                    "Use this to consolidate findings before creating follow-up plans or "
                    "before marking complete. The synthesis text should match the latest "
                    "user-authored message's language."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "synthesis": {
                            "type": "string",
                            "description": (
                                "A coherent narrative combining all insights gathered so far, in the "
                                "latest user-authored message's language."
                            ),
                        }
                    },
                    "required": ["synthesis"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "respond_to_user",
                "description": (
                    "Send a message to the user immediately after evaluate_progress or "
                    "mark_complete. Runtime-generated acknowledgements for new user-authored "
                    "chat, focus, ignore, elaborate, and create inputs are handled "
                    "automatically by the backend, so do not emit extra respond_to_user calls "
                    "for those messages or for standalone progress updates. Keep post-summary "
                    "replies concise (roughly 1-3 sentences): briefly explain why the "
                    "checkpoint/final summary is justified now and what follow-up analysis "
                    "goals remain. The message should match the latest user-authored message's "
                    "language. When you cite summary or atomic evidence, reuse inline "
                    "markers like [[1]] and return matching structured citation metadata."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": (
                                "The message to send to the user, in the latest user-authored "
                                "message's language."
                            ),
                        },
                        "citations": {
                            "type": "array",
                            "items": _provenance_citation_schema(),
                            "description": (
                                "Structured provenance for inline citation markers used inside "
                                "message."
                            ),
                        },
                    },
                    "required": ["message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "mark_complete",
                "description": (
                    "Mark the entire analysis run as complete. Call this ONLY when you judge "
                    "that the user's goal has been thoroughly addressed with concrete evidence "
                    "from multiple analyses. Do NOT call this prematurely — ensure that key "
                    "aspects of the goal have been explored and meaningful insights have been "
                    "extracted. Also call this when the user explicitly asks to stop. "
                    "After this call the run remains open in completed state so the user can "
                    "continue the same conversation with follow-up goals. Provide a comprehensive "
                    "final summary covering all key findings. The final summary should match the "
                    "latest user-authored message's language. "
                    "When possible, include inline citation placeholders like [[1]] in the "
                    "summary and return matching structured citations. "
                    "Immediately after this tool, you must call respond_to_user to explain "
                    "why the run is complete and what optional follow-up goals could still be explored."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": (
                                "A comprehensive final summary of all key findings and "
                                "conclusions from the entire analysis, in the latest user-authored "
                                "message's language."
                            ),
                        },
                        "citations": {
                            "type": "array",
                            "items": _provenance_citation_schema(),
                            "description": (
                                "Structured provenance for inline citation markers used in the final summary."
                            ),
                        }
                    },
                    "required": ["summary"],
                },
            },
        },
    ]
