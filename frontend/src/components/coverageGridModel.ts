import { INSIGHT_TAXONOMY_V1 } from '@/config';
import type { AtomicInsight, RunState, Summary } from '@/types';
import { buildCoverageCellMapKey } from '@/utils/coverageCellSelection';
import { parseDatasetSchemaColumns } from '@/utils/datasetSchema';

export type CoverageGridTaxonomyId = (typeof INSIGHT_TAXONOMY_V1)[number]['id'];

export interface CoverageGridAxisColumn {
  key: string;
  label: string;
}

export interface CoverageGridAtomicEntry {
  atomicKey: string;
  insight: Summary;
  atomic: AtomicInsight;
}

export interface CoverageGridCellDescriptor {
  key: string;
  taxonomyId: CoverageGridTaxonomyId;
  taxonomyLabel: string;
  column: string;
  atomicKeys: string[];
}

export interface CoverageGridModel {
  axisColumns: CoverageGridAxisColumn[];
  rows: typeof INSIGHT_TAXONOMY_V1;
  cellMetaByKey: Map<string, CoverageGridCellDescriptor>;
  columnKeys: Map<string, string[]>;
  rowKeys: Map<CoverageGridTaxonomyId, string[]>;
  entriesByAtomicKey: Map<string, CoverageGridAtomicEntry>;
  maxCount: number;
}

export interface CoverageCellAverageImportanceStats {
  averageByCellKey: Map<string, number>;
  maxAverageImportance: number;
}

function normalizeColumns(cols: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cols) {
    const col = String(raw || '').trim();
    if (!col || seen.has(col)) continue;
    seen.add(col);
    out.push(col);
  }
  return out;
}

export function buildCoverageGridModel(runState: RunState | null): CoverageGridModel {
  const rows = INSIGHT_TAXONOMY_V1;
  const datasetColumns = runState ? parseDatasetSchemaColumns(runState.dataset_schema || '') : [];
  const axisColumns: CoverageGridAxisColumn[] = datasetColumns.map((col) => ({
    key: col,
    label: col,
  }));
  const cellMetaByKey = new Map<string, CoverageGridCellDescriptor>();
  const columnKeys = new Map<string, string[]>();
  const rowKeys = new Map<CoverageGridTaxonomyId, string[]>();
  const entriesByAtomicKey = new Map<string, CoverageGridAtomicEntry>();

  for (const row of rows) {
    const keys: string[] = [];
    for (const axis of axisColumns) {
      const key = buildCoverageCellMapKey(row.id, axis.label);
      const descriptor: CoverageGridCellDescriptor = {
        key,
        taxonomyId: row.id,
        taxonomyLabel: row.label,
        column: axis.label,
        atomicKeys: [],
      };
      cellMetaByKey.set(key, descriptor);
      keys.push(key);
      const existingColumnKeys = columnKeys.get(axis.label) ?? [];
      existingColumnKeys.push(key);
      columnKeys.set(axis.label, existingColumnKeys);
    }
    rowKeys.set(row.id, keys);
  }

  if (!runState) {
    return {
      axisColumns,
      rows,
      cellMetaByKey,
      columnKeys,
      rowKeys,
      entriesByAtomicKey,
      maxCount: 0,
    };
  }

  const datasetSet = new Set(datasetColumns);
  const taxonomyIds = new Set<string>(rows.map((row) => row.id));
  const insightsSorted = [...(runState.insights || [])].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || '')
  );

  for (const insight of insightsSorted) {
    const atomics = insight.atomic_insights || [];
    for (let atomicIdx = 0; atomicIdx < atomics.length; atomicIdx += 1) {
      const atomic = atomics[atomicIdx];
      const rawType = String(atomic.insight_type || '').trim();
      if (!taxonomyIds.has(rawType)) continue;
      const taxonomyId = rawType as CoverageGridTaxonomyId;
      const atomicKey = `${insight.insight_id}::${atomic.atomic_id || atomicIdx}`;
      entriesByAtomicKey.set(atomicKey, {
        atomicKey,
        insight,
        atomic,
      });
      const columns = normalizeColumns((atomic.columns || []).map((value) => String(value))).filter((column) =>
        datasetSet.has(column)
      );
      if (columns.length === 0) continue;
      for (const column of columns) {
        const key = buildCoverageCellMapKey(taxonomyId, column);
        const descriptor = cellMetaByKey.get(key);
        if (!descriptor) continue;
        if (!descriptor.atomicKeys.includes(atomicKey)) {
          descriptor.atomicKeys.push(atomicKey);
        }
      }
    }
  }

  let maxCount = 0;
  for (const cell of cellMetaByKey.values()) {
    maxCount = Math.max(maxCount, cell.atomicKeys.length);
  }

  return {
    axisColumns,
    rows,
    cellMetaByKey,
    columnKeys,
    rowKeys,
    entriesByAtomicKey,
    maxCount,
  };
}

export function toggleCoverageCellKey(
  selectedKeys: readonly string[],
  key: string
): string[] {
  const next = new Set(selectedKeys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return [...next].sort();
}

export function toggleCoverageSelectionGroup(
  selectedKeys: readonly string[],
  groupKeys: readonly string[]
): string[] {
  const normalizedKeys = [...new Set(groupKeys)].filter(Boolean);
  if (normalizedKeys.length === 0) return [...selectedKeys];

  const next = new Set(selectedKeys);
  const allSelected = normalizedKeys.every((key) => next.has(key));
  for (const key of normalizedKeys) {
    if (allSelected) {
      next.delete(key);
    } else {
      next.add(key);
    }
  }
  return [...next].sort();
}

export function buildSelectedCoverageCellDescriptors(
  model: CoverageGridModel,
  selectedKeys: readonly string[]
): CoverageGridCellDescriptor[] {
  return [...selectedKeys]
    .map((key) => model.cellMetaByKey.get(key) ?? null)
    .filter((item): item is CoverageGridCellDescriptor => item !== null)
    .sort((a, b) => {
      if (a.taxonomyLabel !== b.taxonomyLabel) {
        return a.taxonomyLabel.localeCompare(b.taxonomyLabel);
      }
      return a.column.localeCompare(b.column);
    });
}

export function buildFilteredAtomicEntries(
  model: CoverageGridModel,
  selectedKeys: readonly string[]
): CoverageGridAtomicEntry[] {
  const matched = new Map<string, CoverageGridAtomicEntry>();
  for (const key of selectedKeys) {
    const cell = model.cellMetaByKey.get(key);
    if (!cell) continue;
    for (const atomicKey of cell.atomicKeys) {
      const entry = model.entriesByAtomicKey.get(atomicKey);
      if (!entry) continue;
      matched.set(atomicKey, entry);
    }
  }

  return [...matched.values()].sort((a, b) => {
    const importanceDelta = (b.atomic.importance ?? 0) - (a.atomic.importance ?? 0);
    if (Math.abs(importanceDelta) > 1e-9) return importanceDelta;
    const timeDelta = (b.insight.created_at || '').localeCompare(a.insight.created_at || '');
    if (timeDelta !== 0) return timeDelta;
    return a.atomicKey.localeCompare(b.atomicKey);
  });
}

export function buildCoverageCellAverageImportanceStats(
  model: CoverageGridModel
): CoverageCellAverageImportanceStats {
  const averageByCellKey = new Map<string, number>();
  let maxAverageImportance = 0;

  for (const [cellKey, cell] of model.cellMetaByKey.entries()) {
    const values = cell.atomicKeys
      .map((atomicKey) => Number(model.entriesByAtomicKey.get(atomicKey)?.atomic.importance))
      .filter((value) => Number.isFinite(value));
    const averageImportance = values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
    averageByCellKey.set(cellKey, averageImportance);
    maxAverageImportance = Math.max(maxAverageImportance, averageImportance);
  }

  return {
    averageByCellKey,
    maxAverageImportance,
  };
}
