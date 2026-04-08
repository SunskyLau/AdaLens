import type { InsightTaxonomyId } from '@/config';
import {
  INSIGHT_TAXONOMY_COLORS,
  INSIGHT_TAXONOMY_FALLBACK_COLOR,
  INSIGHT_TAXONOMY_V1,
} from '@/config';
import type { CoverageGridAtomicEntry } from './coverageGridModel';

export type FilterResultsSortOrder = 'importance_desc' | 'importance_asc';

export function sortFilterResultsEntries(
  entries: readonly CoverageGridAtomicEntry[],
  sortOrder: FilterResultsSortOrder
): CoverageGridAtomicEntry[] {
  const direction = sortOrder === 'importance_asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const importanceDelta = (a.atomic.importance ?? 0) - (b.atomic.importance ?? 0);
    if (Math.abs(importanceDelta) > 1e-9) return importanceDelta * direction;
    const timeDelta = (a.insight.created_at || '').localeCompare(b.insight.created_at || '');
    if (timeDelta !== 0) return -timeDelta;
    return a.atomicKey.localeCompare(b.atomicKey);
  });
}

export function getInsightTypeLabel(typeId: string): string {
  const found = INSIGHT_TAXONOMY_V1.find((taxonomy) => taxonomy.id === typeId);
  return found?.label || typeId;
}

export function getInsightTypeColor(typeId: string): string {
  const entry = INSIGHT_TAXONOMY_COLORS[typeId as InsightTaxonomyId];
  return entry?.tw ?? INSIGHT_TAXONOMY_FALLBACK_COLOR.tw;
}
