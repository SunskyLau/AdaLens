import { CheckCheck } from 'lucide-react';
import NarrativeMarkdown from '@/components/conversation/NarrativeMarkdown';
import type { ConversationEntry, SteeringTargetSnapshot } from '@/types';

export default function MarkCompleteEntry({
  entry,
  onActivateCitation,
  isHighlighted = false,
  onFocus,
}: {
  entry: ConversationEntry;
  onActivateCitation?: (target: SteeringTargetSnapshot) => void;
  isHighlighted?: boolean;
  onFocus?: () => void;
}) {
  const isInteractive = typeof onFocus === 'function';

  return (
    <div
      data-conversation-final-summary-card="true"
      data-conversation-final-summary-highlighted={isHighlighted ? 'true' : undefined}
      className={[
        'rounded-lg border bg-gradient-to-br from-emerald-50 to-teal-50 px-4 py-3 shadow-sm transition',
        isHighlighted
          ? 'border-emerald-300 ring-2 ring-emerald-200/80'
          : 'border-emerald-200',
        isInteractive ? 'cursor-pointer hover:border-emerald-300 hover:shadow-md' : '',
      ].join(' ')}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={isInteractive ? () => onFocus?.() : undefined}
      onKeyDown={isInteractive ? (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        onFocus?.();
      } : undefined}
    >
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-emerald-100 p-1.5 text-emerald-700">
          <CheckCheck className="h-3.5 w-3.5" />
        </div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
          Run Complete
        </div>
      </div>
      <div className="mt-2.5 text-sm text-slate-700">
        <NarrativeMarkdown
          markdown={entry.markdownBody ?? entry.summary ?? ''}
          citations={entry.citations}
          tone="final"
          onActivateCitation={onActivateCitation}
        />
      </div>
      <div className="mt-3 border-t border-emerald-100 pt-2.5 text-xs text-emerald-600/70">
        You can continue chatting below to explore further or start a new analysis direction.
      </div>
    </div>
  );
}
