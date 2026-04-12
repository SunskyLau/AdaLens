import type { Summary } from '@/types';

type SummaryImportanceLike = Pick<Summary, 'atomic_insights'> | {
  atomic_insights?: Array<{ importance?: unknown }>;
};

export function computeSummaryAverageImportance(summary: SummaryImportanceLike): number {
  const values = (summary.atomic_insights ?? [])
    .map((atomic) => Number(atomic.importance))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildSummaryAverageImportanceById(
  summaries: Array<Pick<Summary, 'insight_id' | 'atomic_insights'>>
): Map<string, number> {
  const averages = new Map<string, number>();
  for (const summary of summaries) {
    averages.set(summary.insight_id, computeSummaryAverageImportance(summary));
  }
  return averages;
}
