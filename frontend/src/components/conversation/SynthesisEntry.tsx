import { ScrollText } from 'lucide-react';
import type { ConversationEntry } from '@/types';

export default function SynthesisEntry({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-emerald-100 p-1.5 text-emerald-700">
          <ScrollText className="h-3.5 w-3.5" />
        </div>
        <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-600">
          Synthesis
        </div>
      </div>
      <div className="mt-2.5 whitespace-pre-wrap text-sm leading-6 text-slate-700">
        {entry.text}
      </div>
    </div>
  );
}
