import { Bot } from 'lucide-react';
import NarrativeMarkdown from '@/components/conversation/NarrativeMarkdown';
import type { ConversationEntry, SteeringTargetSnapshot } from '@/types';

export default function AgentResponseEntry({
  entry,
  onActivateCitation,
}: {
  entry: ConversationEntry;
  onActivateCitation?: (target: SteeringTargetSnapshot) => void;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
          <Bot className="h-3 w-3" />
          Agent
        </div>
        <div className="text-sm leading-6 text-slate-700">
          <NarrativeMarkdown
            markdown={entry.markdownBody ?? entry.text ?? ''}
            citations={entry.citations}
            tone="final"
            onActivateCitation={onActivateCitation}
          />
        </div>
      </div>
    </div>
  );
}
