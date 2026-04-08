import { Activity } from 'lucide-react';
import type { ConversationEntry } from '@/types';

export default function StatusChangeEntry({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-500">
        <Activity className="h-3 w-3 text-slate-400" />
        <span className="font-medium uppercase tracking-wider">
          {entry.status ?? 'status'}
        </span>
        {entry.reason && (
          <span className="text-slate-400">&middot; {entry.reason}</span>
        )}
      </div>
    </div>
  );
}
