import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, History, MessageSquarePlus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { fetchRuns } from '@/api/client';
import type { RunSummary } from '@/types';

function getStatusClasses(status: string) {
  switch (status) {
    case 'running':
      return 'bg-sky-50 text-sky-700';
    case 'idle':
      return 'bg-amber-50 text-amber-700';
    case 'completed':
      return 'bg-emerald-50 text-emerald-700';
    case 'failed':
      return 'bg-rose-50 text-rose-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function buildRunLabel(run: RunSummary): string {
  const fromMessage = (run.first_user_message || '').trim();
  if (fromMessage) return fromMessage;
  return run.dataset_path || run.run_id;
}

export default function ConversationHistory({
  currentRunId,
  onSelectRun,
  onNewConversation,
}: {
  currentRunId?: string;
  onSelectRun: (runId: string) => void;
  onNewConversation: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    fetchRuns()
      .then((items) => {
        if (active) setRuns(items);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const items = useMemo(() => runs.slice(0, 20), [runs]);

  return (
    <div ref={containerRef} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={onNewConversation}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
        title="New conversation"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
        title="Conversation history"
      >
        <History className="h-3.5 w-3.5" />
        History
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-20 w-[20rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Conversations
          </div>
          <div className="max-h-[22rem] overflow-y-auto p-2">
            {loading ? (
              <div className="px-2 py-6 text-center text-sm text-slate-400">
                Loading conversations...
              </div>
            ) : items.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-slate-400">
                No conversations yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {items.map((run) => (
                  <button
                    type="button"
                    key={run.run_id}
                    onClick={() => {
                      setOpen(false);
                      onSelectRun(run.run_id);
                    }}
                    className={`block w-full rounded-lg border px-3 py-2 text-left transition ${
                      run.run_id === currentRunId
                        ? 'border-sky-200 bg-sky-50'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-sm text-slate-700">
                          {buildRunLabel(run)}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-slate-400">
                          {run.dataset_path}
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(run.status)}`}
                      >
                        {run.status}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-400">
                      <Clock3 className="h-3 w-3" />
                      {run.last_activity_at || run.created_at
                        ? formatDistanceToNow(new Date(run.last_activity_at || run.created_at), {
                            addSuffix: true,
                          })
                        : 'unknown'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
