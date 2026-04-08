import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers3 } from 'lucide-react';
import type { ConversationEntry } from '@/types';

export default function PlansCreatedEntry({ entry }: { entry: ConversationEntry }) {
  const [expanded, setExpanded] = useState(false);
  const planCount = entry.plans?.length ?? 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-violet-50 p-1.5 text-violet-600">
            <Layers3 className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Plans Created
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {planCount} analysis plan(s)
            </div>
          </div>
        </div>
        <div className="text-slate-400">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
      </button>

      {expanded ? (
        <div data-plans-created-expanded="true" className="mt-3 space-y-2">
          {(entry.plans ?? []).map((plan) => (
            <div
              key={plan.plan_id}
              className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2"
            >
              <div className="text-sm text-slate-700">{plan.text}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
