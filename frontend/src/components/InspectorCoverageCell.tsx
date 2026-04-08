import { useMemo } from 'react';
import clsx from 'clsx';
import {
  INSIGHT_TAXONOMY_V1,
} from '@/config';
import { decodeCoverageCellSelectionId } from '@/utils/coverageCellSelection';
import type { AtomicInsight, RunState, Summary } from '@/types';
import InspectorAtomicInsightCard from './InspectorAtomicInsightCard';
import { getInsightTypeColor } from './inspectorShared';

interface CoverageCellInspectorProps {
  runId: string;
  runState: RunState;
  cellId: string | null;
}

export default function CoverageCellInspector({ runId, runState, cellId }: CoverageCellInspectorProps) {
  const decoded = useMemo(() => decodeCoverageCellSelectionId(cellId), [cellId]);
  const taxonomyLabel = useMemo(() => {
    if (!decoded) return '';
    const found = INSIGHT_TAXONOMY_V1.find((taxonomy) => taxonomy.id === decoded.taxonomyId);
    return found?.label || decoded.taxonomyId;
  }, [decoded]);
  const entries = useMemo(() => {
    if (!decoded) return [] as Array<{ insight: Summary; atomic: AtomicInsight }>;
    const insights = [...runState.insights].sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || '')
    );
    const out: Array<{ insight: Summary; atomic: AtomicInsight }> = [];
    for (const insight of insights) {
      for (const atomic of insight.atomic_insights || []) {
        if (atomic.insight_type !== decoded.taxonomyId) continue;
        const columns = (atomic.columns || []).map((column) => String(column).trim()).filter(Boolean);
        if (!columns.includes(decoded.column)) continue;
        out.push({ insight, atomic });
      }
    }
    return out;
  }, [decoded, runState.insights]);

  if (!decoded) {
    return <div className="p-4 text-slate-500">Invalid coverage cell selection</div>;
  }

  return (
    <div className="divide-y divide-slate-100">
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              'whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
              getInsightTypeColor(decoded.taxonomyId)
            )}
          >
            {taxonomyLabel}
          </span>
          <span className="text-xs text-slate-300">&times;</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
            {decoded.column}
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Atomic insights: {entries.length}
        </div>
      </div>

      <div className="p-4">
        {entries.length === 0 ? (
          <div className="text-sm text-slate-500">No atomic insights in this cell.</div>
        ) : (
          <div className="space-y-4">
            {entries.map((entry, index) => (
              <div
                key={`${entry.insight.insight_id}-${entry.atomic.atomic_id || index}-${index}`}
                className="space-y-2"
              >
                <InspectorAtomicInsightCard runId={runId} atomic={entry.atomic} index={index + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
