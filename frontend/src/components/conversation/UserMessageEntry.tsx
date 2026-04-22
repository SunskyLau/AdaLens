import { User2 } from 'lucide-react';
import type { ConversationEntry } from '@/types';

export default function UserMessageEntry({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-xl rounded-tr-sm border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm">
        <div className="mb-1.5 flex items-center justify-end gap-1.5 text-[11px] font-medium uppercase tracking-wider text-sky-500">
          You
          <User2 className="h-3 w-3" />
        </div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
          {entry.text}
        </div>
      </div>
    </div>
  );
}
