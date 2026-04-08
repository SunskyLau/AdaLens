import { User2 } from 'lucide-react';

import SteeringCardTitle from '@/components/SteeringCardTitle';
import type { ConversationEntry, SteeringTargetSnapshot } from '@/types';

export default function SteeringActionEntry({
  entry,
  isHighlighted = false,
  onActivateTarget,
}: {
  entry: ConversationEntry;
  isHighlighted?: boolean;
  onActivateTarget?: (target: SteeringTargetSnapshot, sourceConversationEntryId?: string) => void;
}) {
  const steeringKind =
    entry.steeringKind === 'ignore'
    || entry.steeringKind === 'elaborate'
    || entry.steeringKind === 'create'
      ? entry.steeringKind
      : 'focus';
  const target = entry.target ?? null;
  const isTargetClickable = !!target && typeof onActivateTarget === 'function';
  const previewText = entry.userPrompt ?? entry.generatedPrompt ?? '';
  const bodyText = previewText || entry.displayText || entry.text;

  const content = (
    <>
      <div className="mb-2 flex items-center justify-end gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
        Steering
        <User2 className="h-3 w-3" />
      </div>
      <div className="flex justify-end">
        <div data-steering-entry-title="true">
          <SteeringCardTitle kind={steeringKind} />
        </div>
      </div>
      <div className="mt-2 whitespace-pre-wrap text-left text-sm leading-6 text-slate-700">
        {bodyText}
      </div>
    </>
  );

  return (
    <div
      className="flex justify-end"
      data-steering-entry-id={entry.id}
      data-steering-entry-highlighted={isHighlighted ? 'true' : undefined}
      aria-current={isHighlighted ? 'true' : undefined}
    >
      <div
        className={[
          'max-w-[88%] rounded-xl rounded-tr-sm border bg-white shadow-sm transition',
          isHighlighted
            ? 'border-sky-300 ring-2 ring-sky-200/70'
            : 'border-slate-200',
        ].join(' ')}
      >
        {isTargetClickable ? (
          <button
            type="button"
            data-steering-entry-card-body="true"
            className="block w-full rounded-xl rounded-tr-sm px-4 py-3 text-left transition hover:bg-sky-50/30"
            onClick={() => onActivateTarget?.(target, entry.id)}
          >
            {content}
          </button>
        ) : (
          <div
            data-steering-entry-card-body="true"
            className="px-4 py-3"
          >
            {content}
          </div>
        )}
      </div>
    </div>
  );
}
