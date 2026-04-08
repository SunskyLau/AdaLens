import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import type {
  CoverageGridAtomicEntry,
  CoverageGridCellDescriptor,
  CoverageGridModel,
} from './coverageGridModel';
import type { CoverageGridTaxonomyId } from './coverageGridModel';
import type { StorylineColumnTrack, StorylineNodeGeometry } from './storylineGraphLayout';
import type {
  StorylineBoundaryBranch,
  StorylineSummaryArea,
  StorylineTurnConvergeLayout,
} from './storylineTurnConvergeLayout';
import { buildCoverageCellMapKey } from '@/utils/coverageCellSelection';
import type { RunState } from '@/types';

export type StorylineFilterTriState = 'none' | 'partial' | 'all';

export interface StorylineFilterState {
  selectedCellKeys: readonly string[];
}

export interface StorylineInspectorFilterOverride {
  selectedCells: CoverageGridCellDescriptor[];
  entries: CoverageGridAtomicEntry[];
}

export interface StorylineFilterSnapshot {
  selectedCellKeys: readonly string[];
  selectedCellKeySet: ReadonlySet<string>;
  selectedCells: CoverageGridCellDescriptor[];
  entries: CoverageGridAtomicEntry[];
  inspectorOverride: StorylineInspectorFilterOverride | null;
  hasActiveFilter: boolean;
  rowStates: ReadonlyMap<string, StorylineFilterTriState>;
  columnStates: ReadonlyMap<string, StorylineFilterTriState>;
  selectedColumns: readonly string[];
  selectedColumnSet: ReadonlySet<string>;
}

export type StorylineExclusiveColumnSource = 'converge' | 'non_converge' | 'chat_replay';

export interface StorylineFilterActions {
  toggleCell: (taxonomyId: CoverageGridTaxonomyId, column: string) => void;
  toggleRow: (taxonomyId: CoverageGridTaxonomyId) => void;
  toggleColumn: (column: string) => void;
  clearAll: () => void;
  toggleLegendType: (taxonomyId: CoverageGridTaxonomyId) => void;
  toggleExclusiveStorylineColumn: (
    column: string,
    source?: StorylineExclusiveColumnSource
  ) => void;
  replaceStorylineColumns: (
    columns: readonly string[],
    source?: StorylineExclusiveColumnSource
  ) => void;
  toggleStorylineColumn: (column: string) => void;
}

export interface StorylineFilterViewModel {
  snapshot: StorylineFilterSnapshot;
  actions: StorylineFilterActions;
}

export interface StorylineFilterController extends StorylineFilterViewModel {
  state: StorylineFilterState;
}

export interface StorylineFilterCatalog {
  cellMetaByKey: Map<string, CoverageGridCellDescriptor>;
  rowKeys: Map<string, string[]>;
  columnKeys: Map<string, string[]>;
  entriesByAtomicKey: Map<string, CoverageGridAtomicEntry>;
}

export interface StorylineFilterRenderState {
  hasActiveFilter: boolean;
  matchedNodeIds: Set<string>;
  matchedSummaryIds: Set<string>;
  keptTrackSegmentKeys: Set<string>;
  keptBranchIds: Set<string>;
  keptConvergeLaneKeys: Set<string>;
}

export interface DeterministicStorylineFilterGroupToggleResult {
  selectedCellKeys: string[];
  nextShouldSelect: boolean;
}

const EMPTY_SELECTED_CELL_KEYS: readonly string[] = [];
const EMPTY_SELECTED_CELL_KEY_SET = new Set<string>();
const EMPTY_ROW_STATES = new Map<string, StorylineFilterTriState>();
const EMPTY_COLUMN_STATES = new Map<string, StorylineFilterTriState>();
const EMPTY_SELECTED_COLUMNS: readonly string[] = [];
const EMPTY_SELECTED_COLUMN_SET = new Set<string>();

export const EMPTY_STORYLINE_FILTER_SNAPSHOT: StorylineFilterSnapshot = {
  selectedCellKeys: EMPTY_SELECTED_CELL_KEYS,
  selectedCellKeySet: EMPTY_SELECTED_CELL_KEY_SET,
  selectedCells: [],
  entries: [],
  inspectorOverride: null,
  hasActiveFilter: false,
  rowStates: EMPTY_ROW_STATES,
  columnStates: EMPTY_COLUMN_STATES,
  selectedColumns: EMPTY_SELECTED_COLUMNS,
  selectedColumnSet: EMPTY_SELECTED_COLUMN_SET,
};

export const EMPTY_STORYLINE_FILTER_ACTIONS: StorylineFilterActions = {
  toggleCell: () => undefined,
  toggleRow: () => undefined,
  toggleColumn: () => undefined,
  clearAll: () => undefined,
  toggleLegendType: () => undefined,
  toggleExclusiveStorylineColumn: () => undefined,
  replaceStorylineColumns: () => undefined,
  toggleStorylineColumn: () => undefined,
};

export const EMPTY_STORYLINE_FILTER_VIEW_MODEL: StorylineFilterViewModel = {
  snapshot: EMPTY_STORYLINE_FILTER_SNAPSHOT,
  actions: EMPTY_STORYLINE_FILTER_ACTIONS,
};

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeColumns(columns: readonly unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of columns) {
    const column = normalizeToken(raw);
    if (!column || seen.has(column)) continue;
    seen.add(column);
    normalized.push(column);
  }
  return normalized;
}

export function deriveStorylineFilterTriState(
  selectedCellKeySet: ReadonlySet<string>,
  groupKeys: readonly string[]
): StorylineFilterTriState {
  const normalizedKeys = [...new Set(groupKeys)].filter(Boolean);
  if (normalizedKeys.length === 0) return 'none';
  let selectedCount = 0;
  for (const key of normalizedKeys) {
    if (selectedCellKeySet.has(key)) {
      selectedCount += 1;
    }
  }
  if (selectedCount === 0) return 'none';
  if (selectedCount === normalizedKeys.length) return 'all';
  return 'partial';
}

export function toggleStorylineFilterCellKey(
  selectedCellKeys: readonly string[],
  key: string
): string[] {
  const normalizedKey = normalizeToken(key);
  if (!normalizedKey) return [...selectedCellKeys];
  const next = new Set(selectedCellKeys);
  if (next.has(normalizedKey)) {
    next.delete(normalizedKey);
  } else {
    next.add(normalizedKey);
  }
  return [...next].sort();
}

export function applyStorylineFilterGroupToggle(
  selectedCellKeys: readonly string[],
  groupKeys: readonly string[],
  shouldSelect: boolean
): string[] {
  const normalizedKeys = [...new Set(groupKeys)].filter(Boolean);
  if (normalizedKeys.length === 0) return [...selectedCellKeys];

  const next = new Set(selectedCellKeys);
  for (const key of normalizedKeys) {
    if (shouldSelect) {
      next.add(key);
    } else {
      next.delete(key);
    }
  }
  return [...next].sort();
}

export function applyDeterministicStorylineFilterGroupToggle(args: {
  selectedCellKeys: readonly string[];
  groupKeys: readonly string[];
  shouldSelect: boolean;
}): DeterministicStorylineFilterGroupToggleResult {
  const { selectedCellKeys, groupKeys, shouldSelect } = args;
  return {
    selectedCellKeys: applyStorylineFilterGroupToggle(selectedCellKeys, groupKeys, shouldSelect),
    nextShouldSelect: !shouldSelect,
  };
}

export function applyExclusiveStorylineColumnToggle(args: {
  selectedCellKeys: readonly string[];
  columnKeys: readonly string[];
}): string[] {
  const { selectedCellKeys, columnKeys } = args;
  const columnState = deriveStorylineFilterTriState(new Set(selectedCellKeys), columnKeys);
  if (columnState === 'none') {
    return [...new Set(columnKeys)].filter(Boolean).sort();
  }
  return applyStorylineFilterGroupToggle(selectedCellKeys, columnKeys, false);
}

export function buildStorylineFilterCatalog(args: {
  coverageGridModel: CoverageGridModel;
  runState: RunState | null;
}): StorylineFilterCatalog {
  const { coverageGridModel, runState } = args;
  const rows = coverageGridModel.rows;
  const datasetColumns = coverageGridModel.axisColumns.map((axis) => normalizeToken(axis.label)).filter(Boolean);
  const datasetColumnSet = new Set(datasetColumns);
  const taxonomyIds = new Set<CoverageGridTaxonomyId>(rows.map((row) => row.id));
  const extraColumns = new Set<string>();
  const entriesByAtomicKey = new Map<string, CoverageGridAtomicEntry>();
  const atomicAssignments: Array<{
    atomicKey: string;
    taxonomyId: CoverageGridTaxonomyId;
    columns: string[];
  }> = [];

  const insightsSorted = [...(runState?.insights || [])].sort((a, b) =>
    normalizeToken(a.created_at).localeCompare(normalizeToken(b.created_at))
  );

  for (const insight of insightsSorted) {
    const atomics = insight.atomic_insights || [];
    for (let atomicIndex = 0; atomicIndex < atomics.length; atomicIndex += 1) {
      const atomic = atomics[atomicIndex];
      const taxonomyId = normalizeToken(atomic.insight_type) as CoverageGridTaxonomyId;
      if (!taxonomyIds.has(taxonomyId)) continue;
      const atomicKey = `${insight.insight_id}::${normalizeToken(atomic.atomic_id) || atomicIndex}`;
      const normalizedColumns = normalizeColumns(atomic.columns || []);
      for (const column of normalizedColumns) {
        if (!datasetColumnSet.has(column)) {
          extraColumns.add(column);
        }
      }
      entriesByAtomicKey.set(atomicKey, {
        atomicKey,
        insight,
        atomic,
      });
      atomicAssignments.push({
        atomicKey,
        taxonomyId,
        columns: normalizedColumns,
      });
    }
  }

  const orderedColumns = [...datasetColumns, ...[...extraColumns].sort((a, b) => a.localeCompare(b))];
  const cellMetaByKey = new Map<string, CoverageGridCellDescriptor>();
  const rowKeys = new Map<string, string[]>();
  const columnKeys = new Map<string, string[]>();

  for (const row of rows) {
    const keys: string[] = [];
    for (const column of orderedColumns) {
      const key = buildCoverageCellMapKey(row.id, column);
      const descriptor: CoverageGridCellDescriptor = {
        key,
        taxonomyId: row.id,
        taxonomyLabel: row.label,
        column,
        atomicKeys: [],
      };
      cellMetaByKey.set(key, descriptor);
      keys.push(key);
      const existingColumnKeys = columnKeys.get(column) ?? [];
      existingColumnKeys.push(key);
      columnKeys.set(column, existingColumnKeys);
    }
    rowKeys.set(row.id, keys);
  }

  for (const assignment of atomicAssignments) {
    for (const column of assignment.columns) {
      const key = buildCoverageCellMapKey(assignment.taxonomyId, column);
      const descriptor = cellMetaByKey.get(key);
      if (!descriptor) continue;
      if (!descriptor.atomicKeys.includes(assignment.atomicKey)) {
        descriptor.atomicKeys.push(assignment.atomicKey);
      }
    }
  }

  return {
    cellMetaByKey,
    rowKeys,
    columnKeys,
    entriesByAtomicKey,
  };
}

export function buildStorylineFilterSnapshot(args: {
  catalog: StorylineFilterCatalog;
  selectedCellKeys: readonly string[];
}): StorylineFilterSnapshot {
  const { catalog, selectedCellKeys } = args;
  const normalizedSelectedCellKeys = [...new Set(selectedCellKeys)]
    .filter((key) => catalog.cellMetaByKey.has(key))
    .sort();
  const selectedCellKeySet = new Set(normalizedSelectedCellKeys);
  const selectedCells = normalizedSelectedCellKeys
    .map((key) => catalog.cellMetaByKey.get(key) ?? null)
    .filter((cell): cell is CoverageGridCellDescriptor => cell !== null)
    .sort((a, b) => {
      if (a.taxonomyLabel !== b.taxonomyLabel) {
        return a.taxonomyLabel.localeCompare(b.taxonomyLabel);
      }
      return a.column.localeCompare(b.column);
    });

  const matchedEntries = new Map<string, CoverageGridAtomicEntry>();
  for (const cell of selectedCells) {
    for (const atomicKey of cell.atomicKeys) {
      const entry = catalog.entriesByAtomicKey.get(atomicKey);
      if (!entry) continue;
      matchedEntries.set(atomicKey, entry);
    }
  }
  const entries = [...matchedEntries.values()].sort((a, b) => {
    const importanceDelta = (b.atomic.importance ?? 0) - (a.atomic.importance ?? 0);
    if (Math.abs(importanceDelta) > 1e-9) return importanceDelta;
    const timeDelta = normalizeToken(b.insight.created_at).localeCompare(normalizeToken(a.insight.created_at));
    if (timeDelta !== 0) return timeDelta;
    return a.atomicKey.localeCompare(b.atomicKey);
  });

  const rowStates = new Map<string, StorylineFilterTriState>();
  for (const [taxonomyId, rowKeys] of catalog.rowKeys.entries()) {
    rowStates.set(taxonomyId, deriveStorylineFilterTriState(selectedCellKeySet, rowKeys));
  }

  const columnStates = new Map<string, StorylineFilterTriState>();
  const selectedColumns: string[] = [];
  const selectedColumnSet = new Set<string>();
  for (const [column, columnKeys] of catalog.columnKeys.entries()) {
    const triState = deriveStorylineFilterTriState(selectedCellKeySet, columnKeys);
    columnStates.set(column, triState);
    if (triState !== 'none') {
      selectedColumns.push(column);
      selectedColumnSet.add(column);
    }
  }

  return {
    selectedCellKeys: normalizedSelectedCellKeys,
    selectedCellKeySet,
    selectedCells,
    entries,
    inspectorOverride:
      selectedCells.length > 0
        ? {
          selectedCells,
          entries,
        }
        : null,
    hasActiveFilter: normalizedSelectedCellKeys.length > 0,
    rowStates,
    columnStates,
    selectedColumns,
    selectedColumnSet,
  };
}

function buildSelectedCellKeysForColumns(args: {
  catalog: StorylineFilterCatalog;
  columns: readonly string[];
}): string[] {
  const { catalog, columns } = args;
  const selectedCellKeys = new Set<string>();
  for (const column of normalizeColumns(columns)) {
    for (const key of catalog.columnKeys.get(column) ?? []) {
      selectedCellKeys.add(key);
    }
  }
  return [...selectedCellKeys].sort();
}

function matchesStorylineFilterNode(
  selectedCellKeySet: ReadonlySet<string>,
  node: Pick<StorylineNodeGeometry, 'insightType' | 'columns'>
): boolean {
  if (selectedCellKeySet.size === 0) return true;
  return node.columns.some((column) =>
    selectedCellKeySet.has(buildCoverageCellMapKey(node.insightType, column))
  );
}

function createEmptySelectedGlyphConnectionHighlight(): SelectedGlyphConnectionHighlight {
  return {
    segmentKeys: new Set<string>(),
    columns: new Set<string>(),
    reachLeftBoundaryColumns: new Set<string>(),
    reachRightBoundaryColumns: new Set<string>(),
  };
}

export interface SelectedGlyphConnectionHighlight {
  segmentKeys: Set<string>;
  columns: Set<string>;
  reachLeftBoundaryColumns: Set<string>;
  reachRightBoundaryColumns: Set<string>;
}

export function buildTrackSegmentKey(trackId: string, segmentId: string): string {
  return `${trackId}::${segmentId}`;
}

export function computeSelectedGlyphConnectedTrackSegments(args: {
  nodes: Array<Pick<StorylineNodeGeometry, 'id' | 'x' | 'columns'>>;
  tracks: StorylineColumnTrack[];
  selectedNodeId: string | null;
}): SelectedGlyphConnectionHighlight {
  const { nodes, tracks, selectedNodeId } = args;
  if (!selectedNodeId || nodes.length === 0 || tracks.length === 0) {
    return createEmptySelectedGlyphConnectionHighlight();
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  if (!selectedNode) return createEmptySelectedGlyphConnectionHighlight();

  const orderedNodes = [...nodes].sort((a, b) => a.x - b.x);
  const selectedSlotIndex = orderedNodes.findIndex((node) => node.id === selectedNodeId);
  if (selectedSlotIndex < 0) return createEmptySelectedGlyphConnectionHighlight();

  const selectedColumns = new Set(
    (selectedNode.columns || []).map((column) => normalizeToken(column)).filter(Boolean)
  );
  if (selectedColumns.size === 0) return createEmptySelectedGlyphConnectionHighlight();

  const segmentKeys = new Set<string>();
  const reachLeftBoundaryColumns = new Set<string>();
  const reachRightBoundaryColumns = new Set<string>();

  for (const track of tracks) {
    if (!selectedColumns.has(track.column)) continue;

    const involvedSlotIndexes = [...new Set(
      track.segments
        .filter((segment) =>
          segment.kind === 'slot_horizontal'
          && segment.tone === 'involved'
          && typeof segment.slotIndex === 'number'
        )
        .map((segment) => segment.slotIndex as number)
    )].sort((a, b) => a - b);

    const leftStopSlot = [...involvedSlotIndexes]
      .reverse()
      .find((slotIndex) => slotIndex < selectedSlotIndex);
    const rightStopSlot = involvedSlotIndexes.find((slotIndex) => slotIndex > selectedSlotIndex);

    if (typeof leftStopSlot !== 'number') {
      reachLeftBoundaryColumns.add(track.column);
    }
    if (typeof rightStopSlot !== 'number') {
      reachRightBoundaryColumns.add(track.column);
    }

    for (const segment of track.segments) {
      let shouldKeep = false;

      if (segment.kind === 'slot_horizontal' && typeof segment.slotIndex === 'number') {
        const slotIndex = segment.slotIndex;
        if (slotIndex === selectedSlotIndex) {
          shouldKeep = true;
        } else if (slotIndex < selectedSlotIndex) {
          if (typeof leftStopSlot !== 'number') {
            shouldKeep = true;
          } else if (slotIndex > leftStopSlot) {
            shouldKeep = true;
          } else if (slotIndex === leftStopSlot && segment.id.endsWith(':right')) {
            shouldKeep = true;
          }
        } else if (slotIndex > selectedSlotIndex) {
          if (typeof rightStopSlot !== 'number') {
            shouldKeep = true;
          } else if (slotIndex < rightStopSlot) {
            shouldKeep = true;
          } else if (slotIndex === rightStopSlot && segment.id.endsWith(':left')) {
            shouldKeep = true;
          }
        }
      } else if (segment.kind === 'interspace_cubic' && typeof segment.interspaceIndex === 'number') {
        const interspaceIndex = segment.interspaceIndex;
        if (interspaceIndex < selectedSlotIndex) {
          if (typeof leftStopSlot !== 'number') {
            shouldKeep = true;
          } else if (interspaceIndex >= leftStopSlot) {
            shouldKeep = true;
          }
        } else if (typeof rightStopSlot !== 'number') {
          shouldKeep = true;
        } else if (interspaceIndex < rightStopSlot) {
          shouldKeep = true;
        }
      } else if (segment.kind === 'extension_solid') {
        if (segment.id.endsWith(':left-boundary') && typeof leftStopSlot !== 'number') {
          shouldKeep = true;
        }
        if (segment.id.endsWith(':right-boundary') && typeof rightStopSlot !== 'number') {
          shouldKeep = true;
        }
      }

      if (shouldKeep) {
        segmentKeys.add(buildTrackSegmentKey(track.id, segment.id));
      }
    }
  }

  return {
    segmentKeys,
    columns: selectedColumns,
    reachLeftBoundaryColumns,
    reachRightBoundaryColumns,
  };
}

function buildConvergeLaneKey(convergeIndex: number, column: string): string {
  return `${convergeIndex}::${column}`;
}

export function deriveStorylineFilterRenderState(args: {
  layout: Pick<StorylineTurnConvergeLayout, 'nodes' | 'summaryAreas' | 'boundaryBranches'>;
  selectedCellKeySet: ReadonlySet<string>;
}): StorylineFilterRenderState {
  const { layout, selectedCellKeySet } = args;
  if (selectedCellKeySet.size === 0) {
    return {
      hasActiveFilter: false,
      matchedNodeIds: new Set<string>(),
      matchedSummaryIds: new Set<string>(),
      keptTrackSegmentKeys: new Set<string>(),
      keptBranchIds: new Set<string>(),
      keptConvergeLaneKeys: new Set<string>(),
    };
  }

  const matchedNodeIds = new Set<string>();
  const matchedSummaryIds = new Set<string>();
  const keptTrackSegmentKeys = new Set<string>();
  const keptBranchIds = new Set<string>();
  const keptConvergeLaneKeys = new Set<string>();
  const summaryAreaById = new Map<string, StorylineSummaryArea>(
    layout.summaryAreas.map((area) => [area.summaryId, area])
  );
  const branchesBySummaryId = new Map<string, StorylineBoundaryBranch[]>();

  for (const branch of layout.boundaryBranches) {
    const group = branchesBySummaryId.get(branch.summaryId) ?? [];
    group.push(branch);
    branchesBySummaryId.set(branch.summaryId, group);
  }

  for (const node of layout.nodes) {
    if (!matchesStorylineFilterNode(selectedCellKeySet, node)) continue;
    matchedNodeIds.add(node.id);
    matchedSummaryIds.add(node.summaryId);
    const area = summaryAreaById.get(node.summaryId);
    if (!area) continue;
    const connectedState = computeSelectedGlyphConnectedTrackSegments({
      nodes: area.nodes,
      tracks: area.tracks,
      selectedNodeId: node.id,
    });
    for (const segmentKey of connectedState.segmentKeys) {
      keptTrackSegmentKeys.add(segmentKey);
    }
    for (const branch of branchesBySummaryId.get(node.summaryId) ?? []) {
      if (branch.side === 'left' && connectedState.reachLeftBoundaryColumns.has(branch.column)) {
        keptBranchIds.add(branch.id);
        keptConvergeLaneKeys.add(buildConvergeLaneKey(branch.turnIndex, branch.column));
      }
      if (branch.side === 'right' && connectedState.reachRightBoundaryColumns.has(branch.column)) {
        keptBranchIds.add(branch.id);
        keptConvergeLaneKeys.add(buildConvergeLaneKey(branch.turnIndex + 1, branch.column));
      }
    }
  }

  return {
    hasActiveFilter: true,
    matchedNodeIds,
    matchedSummaryIds,
    keptTrackSegmentKeys,
    keptBranchIds,
    keptConvergeLaneKeys,
  };
}

export function useStorylineFilterController(args: {
  coverageGridModel: CoverageGridModel;
  runState: RunState | null;
}): StorylineFilterController {
  const { coverageGridModel, runState } = args;
  const [selectedCellKeys, setSelectedCellKeys] = useState<string[]>([]);
  const columnSelectionToggleRef = useRef(new Map<string, boolean>());
  const rowSelectionToggleRef = useRef(new Map<string, boolean>());

  useEffect(() => {
    setSelectedCellKeys([]);
    columnSelectionToggleRef.current.clear();
    rowSelectionToggleRef.current.clear();
  }, [runState?.run_id]);

  const catalog = useMemo(
    () => buildStorylineFilterCatalog({ coverageGridModel, runState }),
    [coverageGridModel, runState]
  );

  useEffect(() => {
    setSelectedCellKeys((current) => {
      const next = current.filter((key) => catalog.cellMetaByKey.has(key));
      if (next.length === current.length && next.every((key, index) => key === current[index])) {
        return current;
      }
      return next;
    });
  }, [catalog]);

  const toggleGroup = useCallback((groupId: string, groupKeys: readonly string[], memoryRef: MutableRefObject<Map<string, boolean>>) => {
    const shouldSelect = memoryRef.current.get(groupId) ?? true;
    setSelectedCellKeys((current) => {
      const result = applyDeterministicStorylineFilterGroupToggle({
        selectedCellKeys: current,
        groupKeys,
        shouldSelect,
      });
      memoryRef.current.set(groupId, result.nextShouldSelect);
      return result.selectedCellKeys;
    });
  }, []);

  const actions = useMemo<StorylineFilterActions>(() => ({
    toggleCell: (taxonomyId, column) => {
      const key = buildCoverageCellMapKey(taxonomyId, column);
      setSelectedCellKeys((current) => toggleStorylineFilterCellKey(current, key));
    },
    toggleRow: (taxonomyId) => {
      toggleGroup(`row:${taxonomyId}`, catalog.rowKeys.get(taxonomyId) ?? [], rowSelectionToggleRef);
    },
    toggleColumn: (column) => {
      toggleGroup(`column:${column}`, catalog.columnKeys.get(column) ?? [], columnSelectionToggleRef);
    },
    clearAll: () => {
      columnSelectionToggleRef.current.clear();
      rowSelectionToggleRef.current.clear();
      setSelectedCellKeys([]);
    },
    toggleLegendType: (taxonomyId) => {
      toggleGroup(`row:${taxonomyId}`, catalog.rowKeys.get(taxonomyId) ?? [], rowSelectionToggleRef);
    },
    toggleExclusiveStorylineColumn: (column, _source = 'non_converge') => {
      const columnKeys = catalog.columnKeys.get(column) ?? [];
      setSelectedCellKeys((current) => {
        const nextSelectedCellKeys = applyExclusiveStorylineColumnToggle({
          selectedCellKeys: current,
          columnKeys,
        });
        const nextShouldSelect = deriveStorylineFilterTriState(new Set(nextSelectedCellKeys), columnKeys) === 'none';
        columnSelectionToggleRef.current.set(`column:${column}`, nextShouldSelect);
        return nextSelectedCellKeys;
      });
    },
    replaceStorylineColumns: (columns, _source = 'chat_replay') => {
      columnSelectionToggleRef.current.clear();
      rowSelectionToggleRef.current.clear();
      setSelectedCellKeys(buildSelectedCellKeysForColumns({ catalog, columns }));
    },
    toggleStorylineColumn: (column) => {
      toggleGroup(`column:${column}`, catalog.columnKeys.get(column) ?? [], columnSelectionToggleRef);
    },
  }), [catalog.columnKeys, catalog.rowKeys, toggleGroup]);

  const snapshot = useMemo(
    () => buildStorylineFilterSnapshot({ catalog, selectedCellKeys }),
    [catalog, selectedCellKeys]
  );

  const state = useMemo<StorylineFilterState>(
    () => ({
      selectedCellKeys: snapshot.selectedCellKeys,
    }),
    [snapshot.selectedCellKeys]
  );

  return useMemo(
    () => ({
      state,
      snapshot,
      actions,
    }),
    [actions, snapshot, state]
  );
}
