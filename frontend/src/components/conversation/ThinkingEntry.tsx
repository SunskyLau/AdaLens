import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { ConversationEntry } from '@/types';

function normalizeToolNames(toolNames: readonly string[] | null | undefined): string[] {
  return [...new Set((toolNames ?? []).map((toolName) => toolName.trim()).filter(Boolean))];
}

function parseMachineOnlyToolPayload(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { tool_names?: unknown; [key: string]: unknown };
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'tool_names' || !Array.isArray(parsed.tool_names)) {
      return null;
    }
    return normalizeToolNames(parsed.tool_names.map((toolName) => String(toolName ?? '')));
  } catch {
    return null;
  }
}

export function resolveThinkingEntryDisplay(entry: Pick<ConversationEntry, 'text' | 'toolNames'>): {
  toolNames: string[];
  humanText: string;
  machineOnly: boolean;
} {
  const machineOnlyToolNames = parseMachineOnlyToolPayload(entry.text ?? '');
  const toolNames = normalizeToolNames(
    entry.toolNames && entry.toolNames.length > 0
      ? entry.toolNames
      : machineOnlyToolNames ?? []
  );
  return {
    toolNames,
    humanText: machineOnlyToolNames ? '' : (entry.text ?? '').trim(),
    machineOnly: machineOnlyToolNames !== null,
  };
}

export default function ThinkingEntry({
  entry,
  initialExpanded = false,
}: {
  entry: ConversationEntry;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const display = resolveThinkingEntryDisplay(entry);
  const toolInvocationCount = display.toolNames.length;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-sky-50 p-1.5 text-sky-600">
            <Sparkles className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="whitespace-nowrap text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Loop #{entry.loopCount ?? '?'}
            </div>
            <div
              data-thinking-entry-tool-summary="true"
              className="mt-0.5 text-xs text-slate-500"
            >
              {toolInvocationCount} tool(s) invoked
            </div>
          </div>
        </div>
        <div className="shrink-0 pt-0.5 text-slate-400">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {expanded && display.toolNames.length > 0 ? (
        <div data-thinking-entry-tool-chips="true" className="mt-3 flex flex-wrap gap-1.5">
          {display.toolNames.map((toolName) => (
            <span
              key={toolName}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500"
            >
              {toolName}
            </span>
          ))}
        </div>
      ) : null}
      {expanded && display.humanText ? (
        <div
          data-thinking-entry-human-text="true"
          className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600"
        >
          <pre className="whitespace-pre-wrap font-sans">{display.humanText}</pre>
        </div>
      ) : null}
      {expanded && display.machineOnly && !display.humanText ? (
        <div data-thinking-entry-machine-only="true" className="sr-only">
          Machine-only reasoning metadata
        </div>
      ) : null}
    </div>
  );
}
