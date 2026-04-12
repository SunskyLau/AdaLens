import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from 'lucide-react';
import type {
  CoverageGridAtomicEntry,
  CoverageGridCellDescriptor,
} from './coverageGridModel';
import InspectorAtomicInsightCard from './InspectorAtomicInsightCard';
import {
  sortFilterResultsEntries,
  type FilterResultsSortOrder,
} from './inspectorShared';

interface FilterResultsInspectorProps {
  runId: string;
  selectedCells: CoverageGridCellDescriptor[];
  entries: CoverageGridAtomicEntry[];
}

export default function FilterResultsInspector({
  runId,
  selectedCells,
  entries,
}: FilterResultsInspectorProps) {
  void selectedCells;
  const [sortOrder, setSortOrder] = useState<FilterResultsSortOrder>('importance_desc');
  const isAscending = sortOrder === 'importance_asc';
  const sortedEntries = useMemo(
    () => sortFilterResultsEntries(entries, sortOrder),
    [entries, sortOrder]
  );

  return (
    <div className="divide-y divide-slate-100">
      <div className="px-4 pb-2 pt-3">
        <div className="flex items-center gap-3">
          <h3 className="font-medium text-slate-800">Filtered Atomic Insights</h3>
          <button
            type="button"
            onClick={() => {
              setSortOrder((current) => (
                current === 'importance_desc'
                  ? 'importance_asc'
                  : 'importance_desc'
              ));
            }}
            aria-label="Toggle filtered atomic insight importance sort order"
            title={isAscending ? 'Importance low to high' : 'Importance high to low'}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          >
            {isAscending ? (
              <ArrowUpNarrowWide className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownWideNarrow className="h-3.5 w-3.5" />
            )}
          </button>
          <span className="text-[11px] font-medium text-slate-500">
            {entries.length} selected
          </span>
        </div>
      </div>

      <div className="px-4 pb-3 pt-2">
        {sortedEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
            No atomic insights match the current filter selection.
          </div>
        ) : (
          <div className="space-y-4">
            {sortedEntries.map((entry, index) => (
              <InspectorAtomicInsightCard
                key={entry.atomicKey}
                runId={runId}
                atomic={entry.atomic}
                index={index + 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
