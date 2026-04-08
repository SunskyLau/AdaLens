import { Gauge } from 'lucide-react';
import NarrativeMarkdown from '@/components/conversation/NarrativeMarkdown';
import type { ConversationEntry, SteeringTargetSnapshot } from '@/types';

export default function EvaluationEntry({
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
      data-conversation-stage-summary-card="true"
      data-conversation-stage-summary-highlighted={isHighlighted ? 'true' : undefined}
      className={[
        'rounded-lg border bg-gradient-to-br from-amber-50 to-orange-50 px-4 py-3 shadow-sm transition',
        isHighlighted
          ? 'border-amber-300 ring-2 ring-amber-200/80'
          : 'border-amber-200',
        isInteractive ? 'cursor-pointer hover:border-amber-300 hover:shadow-md' : '',
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
        <div className="rounded-md bg-amber-100 p-1.5 text-amber-700">
          <Gauge className="h-3.5 w-3.5" />
        </div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-700">
          Stage Summary
        </div>
      </div>
      <div className="mt-2.5 text-sm text-slate-700">
        <NarrativeMarkdown
          markdown={entry.markdownBody ?? entry.text ?? ''}
          citations={entry.citations}
          tone="stage"
          onActivateCitation={onActivateCitation}
        />
      </div>
      <div className="mt-3 border-t border-amber-100 pt-2.5 text-xs text-amber-700/70">
        This stage summary covers the still-unsummarized storyline work since the previous stage or final summary, and it can still evolve with later evidence.
      </div>
    </div>
  );
}
