import { useEffect, useMemo, useState } from 'react';
import { Bookmark, FileText, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { fetchArtifact, generateReport } from '@/api/client';
import { SHOW_INSPECTOR_REPORT_UI } from '@/config';
import { useStore } from '@/store/useStore';
import type { AtomicInsight, PlanItem, Summary } from '@/types';
import { computeSummaryAverageImportance } from './storylineImportance';
import InspectorAtomicInsightCard from './InspectorAtomicInsightCard';

interface InsightInspectorProps {
  runId: string;
  insight: Summary;
  plan: PlanItem | undefined;
  selectedAtomicId?: string;
  isBookmarked: boolean;
  onBookmark: () => void;
}

export default function InsightInspector({
  runId,
  insight,
  plan,
  selectedAtomicId,
  isBookmarked,
  onBookmark,
}: InsightInspectorProps) {
  if (!insight) return null;
  const reportMeta = useStore((state) => state.getReportByInsightId(insight.insight_id));
  const upsertReport = useStore((state) => state.upsertReport);
  const summaryText = insight.summary || '';
  const [reportContent, setReportContent] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const hasAtomicInsights = insight.atomic_insights && insight.atomic_insights.length > 0;
  const focusedAtomicEntries = useMemo(() => {
    const atomics = insight.atomic_insights || [];
    if (!selectedAtomicId) return [] as Array<{ atomic: AtomicInsight; index: number }>;
    const target = String(selectedAtomicId || '').trim();
    const selectedIndex = atomics.findIndex((atomic) => String(atomic.atomic_id || '').trim() === target);
    if (selectedIndex < 0) return [] as Array<{ atomic: AtomicInsight; index: number }>;
    return [{ atomic: atomics[selectedIndex], index: selectedIndex + 1 }];
  }, [insight.atomic_insights, selectedAtomicId]);
  const allAtomicEntries = useMemo(
    () => (insight.atomic_insights || []).map((atomic, index) => ({ atomic, index: index + 1 })),
    [insight.atomic_insights]
  );
  const atomicEntries = focusedAtomicEntries.length > 0 ? focusedAtomicEntries : allAtomicEntries;
  const isAtomicFocus = !!selectedAtomicId && focusedAtomicEntries.length > 0;
  const selectedAtomicMissing = !!selectedAtomicId && focusedAtomicEntries.length === 0;
  const averageImportance = useMemo(() => computeSummaryAverageImportance(insight), [insight]);

  useEffect(() => {
    if (!SHOW_INSPECTOR_REPORT_UI || !reportMeta?.report_path) return;
    let active = true;
    setReportLoading(true);
    setReportError(null);
    fetchArtifact(runId, reportMeta.report_path)
      .then((data) => {
        if (active) setReportContent(data);
      })
      .catch((error) => {
        if (active) setReportError(error?.message || 'Failed to load report');
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportMeta?.created_at, reportMeta?.report_path, runId]);

  return (
    <div className="divide-y divide-slate-100">
      <div className="px-4 pb-2 pt-3">
        {plan ? (
          <div className="mb-2">
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Source Task</h4>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-sm text-slate-700">{plan.text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="capitalize">{plan.kind}</span>
                <span className="text-slate-300" aria-hidden="true">|</span>
                <span className="capitalize">{plan.status}</span>
                <span className="text-slate-300" aria-hidden="true">|</span>
                <span>{`Avg. Importance ${averageImportance.toFixed(2)}`}</span>
              </div>
            </div>
          </div>
        ) : null}

        <div className={clsx('mb-2 flex items-center', isAtomicFocus ? 'justify-end' : 'justify-between')}>
          {!isAtomicFocus ? (
            <h3 className="font-medium text-slate-800">
              {hasAtomicInsights ? 'Summary' : 'Insight'}
            </h3>
          ) : null}
          <div className="flex items-center gap-2">
            {SHOW_INSPECTOR_REPORT_UI ? (
              <button
                type="button"
                onClick={() => {
                  setReportError(null);
                  setReportLoading(true);
                  generateReport(runId, { insight_id: insight.insight_id })
                    .then((response) => {
                      const reportPath = response.report_path;
                      if (!reportPath) {
                        setReportLoading(false);
                        return;
                      }
                      upsertReport({
                        insight_id: response.insight_id ?? insight.insight_id,
                        report_path: reportPath,
                        report_pack_path: response.report_pack_path || reportMeta?.report_pack_path || '',
                        chain_insight_ids: response.chain_insight_ids || reportMeta?.chain_insight_ids || [],
                        created_at: response.created_at || new Date().toISOString(),
                        model: response.model || reportMeta?.model || '',
                        language: response.language || reportMeta?.language || 'en',
                        mode: response.mode || reportMeta?.mode || '',
                        segment_count: response.segment_count ?? reportMeta?.segment_count ?? 0,
                        errors: response.errors || reportMeta?.errors || [],
                        preview: response.preview || reportMeta?.preview || '',
                      });
                      setReportContent('');
                    })
                    .catch((error) => {
                      setReportError(error?.message || 'Failed to generate report');
                      setReportLoading(false);
                    });
                }}
                className={clsx(
                  'rounded-lg p-1.5 transition-colors',
                  reportLoading ? 'bg-slate-100 text-slate-400' : 'text-slate-500 hover:bg-slate-100'
                )}
                title={reportLoading ? 'Generating report' : reportMeta?.report_path ? 'Regenerate report' : 'Generate report'}
                disabled={reportLoading}
              >
                {reportLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              </button>
            ) : null}

            {!isAtomicFocus ? (
              <button
                type="button"
                onClick={onBookmark}
                className={clsx(
                  'rounded-lg p-1.5 transition-colors',
                  isBookmarked ? 'bg-yellow-100 text-yellow-600' : 'text-slate-400 hover:bg-slate-100'
                )}
                title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
              >
                <Bookmark className="h-4 w-4" fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>
            ) : null}
          </div>
        </div>

        {!isAtomicFocus ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {summaryText}
          </p>
        ) : null}

        {selectedAtomicMissing ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Atomic insight `{selectedAtomicId}` was not found in this summary. Showing all atomic insights.
          </div>
        ) : null}
      </div>

      {hasAtomicInsights ? (
        <div className="px-4 pb-4 pt-3">
          <h4 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
            {isAtomicFocus ? 'Atomic Insight (Focused)' : `Atomic Insights (${insight.atomic_insights.length})`}
          </h4>
          <div className="space-y-3">
            {atomicEntries.map(({ atomic, index }) => (
              <InspectorAtomicInsightCard
                key={atomic.atomic_id || `atomic-${index}`}
                runId={runId}
                atomic={atomic}
                index={index}
              />
            ))}
          </div>
        </div>
      ) : null}

      {SHOW_INSPECTOR_REPORT_UI ? (
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Report</h4>
            {reportMeta?.mode ? (
              <span className="text-[10px] text-slate-400">mode: {reportMeta.mode}</span>
            ) : null}
          </div>

          {reportError ? (
            <div className="rounded-md border border-red-100 bg-red-50 p-2 text-xs text-red-600">
              {reportError}
            </div>
          ) : null}

          {!reportMeta?.report_path && !reportLoading && !reportContent ? (
            <div className="text-xs text-slate-400">No report yet. Click the report icon to generate.</div>
          ) : null}

          {reportLoading ? (
            <div className="text-xs text-slate-400">Generating / loading report...</div>
          ) : null}

          {reportContent ? (
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                {reportContent}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
