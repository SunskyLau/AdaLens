import type { RunState, SteeringTargetSnapshot, Summary, UserMessage, SoftSteeringKind } from '@/types';
import { normalizeCjkTerminalPunctuation } from '@/utils/textNormalization';

import { normalizeSoftSteeringKind } from './kinds';

export function buildSteeringConversationEntryId(messageId: string): string {
  return `user_message:${messageId}`;
}

function dedupeColumns(columns: string[]): string[] {
  return [...new Set(columns.map((item) => item.trim()).filter(Boolean))];
}

function collectSummaryColumns(summary: Summary): string[] {
  return dedupeColumns(
    summary.atomic_insights.flatMap((atomic) => atomic.columns ?? [])
  );
}

function getLegacyColumnName(target: SteeringTargetSnapshot): string {
  const rawValue = (target as SteeringTargetSnapshot & { column_name?: unknown }).column_name;
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

function normalizeTargetColumnAnchors(
  rawAnchors: unknown,
  allowedColumns: readonly string[]
): Array<{ column: string; converge_index: number }> {
  if (!Array.isArray(rawAnchors)) {
    return [];
  }
  const allowedColumnSet = new Set(allowedColumns);
  const allowAnyColumn = allowedColumnSet.size === 0;
  const normalizedAnchors: Array<{ column: string; converge_index: number }> = [];
  const seenColumns = new Set<string>();
  for (const item of rawAnchors) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const column = typeof (item as { column?: unknown }).column === 'string'
      ? (item as { column: string }).column.trim()
      : '';
    const rawConvergeIndex = (item as { converge_index?: unknown }).converge_index;
    const convergeIndex =
      typeof rawConvergeIndex === 'number' && Number.isFinite(rawConvergeIndex)
        ? Math.trunc(rawConvergeIndex)
        : Number.parseInt(String(rawConvergeIndex ?? ''), 10);
    if (
      !column
      || seenColumns.has(column)
      || (!allowAnyColumn && !allowedColumnSet.has(column))
      || !Number.isFinite(convergeIndex)
      || convergeIndex < 0
    ) {
      continue;
    }
    seenColumns.add(column);
    normalizedAnchors.push({
      column,
      converge_index: convergeIndex,
    });
  }
  return normalizedAnchors;
}

function getTargetColumns(target: SteeringTargetSnapshot): string[] {
  const columns = dedupeColumns(target.columns ?? []);
  if (columns.length > 0) {
    return columns;
  }
  const anchorColumns = normalizeTargetColumnAnchors(
    (target as SteeringTargetSnapshot & { column_anchors?: unknown }).column_anchors,
    []
  ).map((anchor) => anchor.column);
  if (anchorColumns.length > 0) {
    return anchorColumns;
  }
  const legacyColumnName = getLegacyColumnName(target);
  return legacyColumnName ? [legacyColumnName] : [];
}

function getTargetColumnAnchors(target: SteeringTargetSnapshot): Array<{ column: string; converge_index: number }> {
  return normalizeTargetColumnAnchors(
    (target as SteeringTargetSnapshot & { column_anchors?: unknown }).column_anchors,
    getTargetColumns(target)
  );
}

export function buildSteeringColumnIndicatorId(column: string, convergeIndex: number): string {
  return `indicator:converge:${convergeIndex}:${column}`;
}

export function normalizeSteeringTargetSnapshot(
  target: SteeringTargetSnapshot | null | undefined
): SteeringTargetSnapshot | null {
  if (!target) {
    return null;
  }
  const kind = target.kind === 'atomic' || target.kind === 'column' ? target.kind : 'summary';
  const columns = getTargetColumns(target);
  const columnAnchors = getTargetColumnAnchors({
    ...target,
    columns,
  });
  if (kind === 'column') {
    return {
      kind,
      summary_id: target.summary_id ?? '',
      summary_short_label: target.summary_short_label ?? '',
      summary_text: normalizeCjkTerminalPunctuation(target.summary_text),
      columns,
      ...(columnAnchors.length > 0 ? { column_anchors: columnAnchors } : {}),
    };
  }
  return {
    kind,
    summary_id: target.summary_id ?? '',
    summary_short_label: target.summary_short_label ?? '',
    summary_text: normalizeCjkTerminalPunctuation(target.summary_text),
    columns,
    atomic_id: kind === 'atomic' ? target.atomic_id ?? undefined : undefined,
    atomic_text:
      kind === 'atomic' && typeof target.atomic_text === 'string'
        ? normalizeCjkTerminalPunctuation(target.atomic_text)
        : undefined,
    insight_type: kind === 'atomic' ? target.insight_type ?? undefined : undefined,
  };
}

export function findSummaryTarget(runState: RunState, summaryId: string): SteeringTargetSnapshot | null {
  const summary = runState.insights.find((item) => item.insight_id === summaryId);
  if (!summary) {
    return null;
  }
  return {
    kind: 'summary',
    summary_id: summary.insight_id,
    summary_short_label: summary.short_label ?? '',
    summary_text: normalizeCjkTerminalPunctuation(summary.summary),
    columns: collectSummaryColumns(summary),
  };
}

export function findAtomicTarget(
  runState: RunState,
  summaryId: string,
  atomicId: string
): SteeringTargetSnapshot | null {
  const summary = runState.insights.find((item) => item.insight_id === summaryId);
  const atomic = summary?.atomic_insights.find((item) => item.atomic_id === atomicId);
  if (!summary || !atomic) {
    return null;
  }
  return {
    kind: 'atomic',
    summary_id: summary.insight_id,
    summary_short_label: summary.short_label ?? '',
    summary_text: normalizeCjkTerminalPunctuation(summary.summary),
    columns: dedupeColumns(atomic.columns ?? []),
    atomic_id: atomic.atomic_id,
    atomic_text: normalizeCjkTerminalPunctuation(atomic.text),
    insight_type: atomic.insight_type,
  };
}

export function buildColumnTarget(args: {
  runState: RunState;
  columns: readonly string[];
  columnAnchors?: readonly { column: string; converge_index: number }[];
}): SteeringTargetSnapshot | null {
  const normalizedColumns = dedupeColumns(args.columns.map((column) => String(column ?? '')));
  const normalizedColumnAnchors = normalizeTargetColumnAnchors(args.columnAnchors, normalizedColumns);
  if (normalizedColumns.length === 0) {
    return null;
  }
  const hasMatchingSummary = args.runState.insights.some((summary) => {
    const summaryColumns = collectSummaryColumns(summary);
    return normalizedColumns.some((column) => summaryColumns.includes(column));
  });
  if (!hasMatchingSummary) {
    return null;
  }
  return {
    kind: 'column',
    summary_id: '',
    summary_short_label: '',
    summary_text: '',
    columns: normalizedColumns,
    ...(normalizedColumnAnchors.length > 0
      ? { column_anchors: normalizedColumnAnchors }
      : {}),
  };
}

export function findColumnTarget(runState: RunState, columnName: string): SteeringTargetSnapshot | null {
  return buildColumnTarget({
    runState,
    columns: [columnName],
  });
}

export function doesSteeringTargetExist(runState: RunState, target: SteeringTargetSnapshot | null): boolean {
  if (!target) {
    return false;
  }
  if (target.kind === 'summary') {
    return findSummaryTarget(runState, target.summary_id) !== null;
  }
  if (target.kind === 'atomic') {
    return findAtomicTarget(runState, target.summary_id, target.atomic_id ?? '') !== null;
  }
  return buildColumnTarget({
    runState,
    columns: getTargetColumns(target),
  }) !== null;
}

export function getSteeringTargetLabel(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return getTargetColumns(target).join(', ');
  }
  if (target.kind === 'atomic') {
    return target.atomic_text || target.atomic_id || target.summary_short_label || target.summary_id;
  }
  return target.summary_short_label || target.summary_text || target.summary_id;
}

export function formatTargetColumns(target: SteeringTargetSnapshot): string {
  return target.columns.length > 0 ? target.columns.join(', ') : 'none';
}

export function buildColumnSummaryOverview(
  runState: RunState,
  columnsOrColumnName: readonly string[] | string
): string {
  const normalizedColumns =
    typeof columnsOrColumnName === 'string'
      ? dedupeColumns([columnsOrColumnName])
      : dedupeColumns(columnsOrColumnName.map((column) => String(column ?? '')));
  if (normalizedColumns.length === 0) {
    return '(no matching summaries)';
  }
  const matches = runState.insights
    .map((summary) => {
      const summaryColumns = collectSummaryColumns(summary);
      const matchedColumns = normalizedColumns.filter((column) => summaryColumns.includes(column));
      if (matchedColumns.length === 0) {
        return null;
      }
      const label = summary.short_label?.trim() || summary.summary.trim() || summary.insight_id;
      return `[${summary.insight_id}] ${label} (columns: ${matchedColumns.join(', ')})`;
    })
    .filter((summary): summary is string => summary !== null);
  return matches.length > 0 ? matches.join('\n') : '(no matching summaries)';
}

export function buildSteeringAtomicTargetKey(target: SteeringTargetSnapshot): string | null {
  if (target.kind !== 'atomic' || !target.atomic_id) {
    return null;
  }
  return `${target.summary_id}::${target.atomic_id}`;
}

interface LatestSteeringTargetState {
  kind: SoftSteeringKind;
  conversationEntryId: string;
  indicatorId?: string;
}

export function buildLatestSoftSteeringByTarget(messages: readonly UserMessage[] | undefined): {
  summaryKindsById: Map<string, SoftSteeringKind>;
  atomicKindsByKey: Map<string, SoftSteeringKind>;
  columnKindsByName: Map<string, SoftSteeringKind>;
  columnKindsByIndicatorId: Map<string, SoftSteeringKind>;
  summaryEntryIdsById: Map<string, string>;
  atomicEntryIdsByKey: Map<string, string>;
  columnEntryIdsByName: Map<string, string>;
  columnEntryIdsByIndicatorId: Map<string, string>;
} {
  const summaryStateById = new Map<string, LatestSteeringTargetState>();
  const atomicStateByKey = new Map<string, LatestSteeringTargetState>();
  const columnStateByName = new Map<string, LatestSteeringTargetState>();

  for (const message of messages ?? []) {
    const steeringKind = normalizeSoftSteeringKind(message.kind);
    const target = normalizeSteeringTargetSnapshot(message.target);
    if (!steeringKind || !target) {
      continue;
    }
    const conversationEntryId = buildSteeringConversationEntryId(message.message_id);
    if (target.kind === 'summary') {
      if (target.summary_id) {
        summaryStateById.set(target.summary_id, {
          kind: steeringKind,
          conversationEntryId,
        });
      }
      continue;
    }
    if (target.kind === 'atomic') {
      const atomicKey = buildSteeringAtomicTargetKey(target);
      if (atomicKey) {
        atomicStateByKey.set(atomicKey, {
          kind: steeringKind,
          conversationEntryId,
        });
      }
      continue;
    }
    if (steeringKind === 'elaborate') {
      continue;
    }
    const columnAnchorByName = new Map(
      getTargetColumnAnchors(target).map((anchor) => [anchor.column, anchor.converge_index])
    );
    for (const columnName of getTargetColumns(target)) {
      const anchoredConvergeIndex = columnAnchorByName.get(columnName);
      columnStateByName.set(columnName, {
        kind: steeringKind,
        conversationEntryId,
        indicatorId:
          typeof anchoredConvergeIndex === 'number'
            ? buildSteeringColumnIndicatorId(columnName, anchoredConvergeIndex)
            : undefined,
      });
    }
  }

  const summaryKindsById = new Map<string, SoftSteeringKind>();
  const atomicKindsByKey = new Map<string, SoftSteeringKind>();
  const columnKindsByName = new Map<string, SoftSteeringKind>();
  const columnKindsByIndicatorId = new Map<string, SoftSteeringKind>();
  const summaryEntryIdsById = new Map<string, string>();
  const atomicEntryIdsByKey = new Map<string, string>();
  const columnEntryIdsByName = new Map<string, string>();
  const columnEntryIdsByIndicatorId = new Map<string, string>();

  for (const [summaryId, state] of summaryStateById.entries()) {
    summaryKindsById.set(summaryId, state.kind);
    summaryEntryIdsById.set(summaryId, state.conversationEntryId);
  }
  for (const [atomicKey, state] of atomicStateByKey.entries()) {
    atomicKindsByKey.set(atomicKey, state.kind);
    atomicEntryIdsByKey.set(atomicKey, state.conversationEntryId);
  }
  for (const [columnName, state] of columnStateByName.entries()) {
    if (state.indicatorId) {
      columnKindsByIndicatorId.set(state.indicatorId, state.kind);
      columnEntryIdsByIndicatorId.set(state.indicatorId, state.conversationEntryId);
    } else {
      columnKindsByName.set(columnName, state.kind);
      columnEntryIdsByName.set(columnName, state.conversationEntryId);
    }
  }

  return {
    summaryKindsById,
    atomicKindsByKey,
    columnKindsByName,
    columnKindsByIndicatorId,
    summaryEntryIdsById,
    atomicEntryIdsByKey,
    columnEntryIdsByName,
    columnEntryIdsByIndicatorId,
  };
}
