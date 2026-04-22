import { clamp, type StorylineAdaptiveProfile } from './storylineGraphLayout';

export interface BoundaryLaneState {
  column: string;
  y: number;
  frozenOrder?: boolean;
  introducedForTurnIndex?: number | null;
}

export interface SummaryBoundaryContract {
  summaryId: string;
  leftPortColumnsInOrder: string[];
  leftPortTargetYByColumn?: Record<string, number>;
  leftPortMinGapPx?: number;
  requiredIngressSpanPx?: number;
}

export interface TurnEgressSignature {
  orderedColumns: string[];
  targetYByColumn: Record<string, number>;
  anchorValuesByColumn: Record<string, number[]>;
}

interface IngressSummaryInput {
  summaryId: string;
  columns: string[];
}

interface IngressSummaryPreparedInput extends IngressSummaryInput {
  leftAnchorOffsetYByColumn: Record<string, number>;
}

export interface IngressWindowResult {
  leftLanes: BoundaryLaneState[];
  orderedSummaryIds: string[];
  contractBySummaryId: Map<string, SummaryBoundaryContract>;
  crossingCount: number;
}

export interface EgressSummaryInput {
  summaryId: string;
  top: number;
  rightAnchorYByColumn: Record<string, number>;
}

export interface IngressAlignedSummaryInput {
  summaryId: string;
  top: number;
  leftAnchorYByColumn: Record<string, number>;
}

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function countRankSequenceCrossings(sequence: number[]): number {
  let inversions = 0;
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = i + 1; j < sequence.length; j += 1) {
      if (sequence[i] > sequence[j]) inversions += 1;
    }
  }
  return inversions;
}

function summarizeColumns(columns: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    const normalized = String(column || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function buildRankByColumn(lanes: BoundaryLaneState[]): Map<string, number> {
  const rankByColumn = new Map<string, number>();
  for (let index = 0; index < lanes.length; index += 1) {
    rankByColumn.set(lanes[index].column, index);
  }
  return rankByColumn;
}

function sortColumnsByLaneRank(columns: string[], lanes: BoundaryLaneState[]): string[] {
  const rankByColumn = buildRankByColumn(lanes);
  return summarizeColumns(columns).sort((a, b) => {
    const aRank = rankByColumn.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankByColumn.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.localeCompare(b);
  });
}

function computeSummaryBarycenter(summary: IngressSummaryInput, lanes: BoundaryLaneState[]): number {
  const rankByColumn = buildRankByColumn(lanes);
  const columns = summarizeColumns(summary.columns);
  const ranks = columns
    .map((column) => rankByColumn.get(column))
    .filter((rank): rank is number => typeof rank === 'number');
  if (ranks.length === 0) return lanes.length / 2;
  return ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length;
}

function computeIngressCrossingCount(
  orderedSummaryIds: string[],
  summariesById: Map<string, IngressSummaryInput>,
  lanes: BoundaryLaneState[]
): number {
  const rankByColumn = buildRankByColumn(lanes);
  const rankSequence: number[] = [];
  for (const summaryId of orderedSummaryIds) {
    const summary = summariesById.get(summaryId);
    if (!summary) continue;
    for (const column of sortColumnsByLaneRank(summary.columns, lanes)) {
      const rank = rankByColumn.get(column);
      if (typeof rank !== 'number') continue;
      rankSequence.push(rank);
    }
  }
  return countRankSequenceCrossings(rankSequence);
}

function improveSummaryOrderByAdjacentSwaps(
  order: string[],
  summariesById: Map<string, IngressSummaryInput>,
  lanes: BoundaryLaneState[]
): string[] {
  let current = [...order];
  let improved = true;
  while (improved) {
    improved = false;
    let bestOrder = current;
    let bestCrossings = computeIngressCrossingCount(current, summariesById, lanes);
    for (let index = 0; index < current.length - 1; index += 1) {
      const candidate = [...current];
      const temp = candidate[index];
      candidate[index] = candidate[index + 1];
      candidate[index + 1] = temp;
      const crossings = computeIngressCrossingCount(candidate, summariesById, lanes);
      if (crossings < bestCrossings) {
        bestCrossings = crossings;
        bestOrder = candidate;
        improved = true;
      }
    }
    current = bestOrder;
  }
  return current;
}

function computeOrderedSummaryIds(
  summaries: IngressSummaryInput[],
  lanes: BoundaryLaneState[]
): string[] {
  const weighted = summaries.map((summary, index) => ({
    summaryId: summary.summaryId,
    barycenter: computeSummaryBarycenter(summary, lanes),
    inputIndex: index,
  }));
  weighted.sort((a, b) => {
    if (Math.abs(a.barycenter - b.barycenter) > 1e-6) return a.barycenter - b.barycenter;
    return a.inputIndex - b.inputIndex;
  });
  const ordered = weighted.map((item) => item.summaryId);
  const summariesById = new Map(summaries.map((summary) => [summary.summaryId, summary]));
  return improveSummaryOrderByAdjacentSwaps(ordered, summariesById, lanes);
}

function estimateSummaryTopFromExistingLaneAnchors(
  summary: IngressSummaryPreparedInput,
  lanes: BoundaryLaneState[],
  excludeColumn: string | null = null
): number | null {
  const laneByColumn = new Map(lanes.map((lane) => [lane.column, lane]));
  const topCandidates = summarizeColumns(summary.columns)
    .map((column) => {
      if (column === excludeColumn) return null;
      const lane = laneByColumn.get(column);
      const anchorOffset = Number(summary.leftAnchorOffsetYByColumn[column]);
      if (!lane || !Number.isFinite(anchorOffset)) return null;
      return lane.y - anchorOffset;
    })
    .filter((value): value is number => Number.isFinite(value));
  if (topCandidates.length === 0) return null;
  return medianValue(topCandidates);
}

function estimateMissingColumnPreferredInsertRank(args: {
  missingColumn: string;
  lanes: BoundaryLaneState[];
  summaries: IngressSummaryInput[];
}): number {
  const rankByColumn = buildRankByColumn(args.lanes);
  const preferredInsertIndexes = args.summaries
    .filter((summary) => summarizeColumns(summary.columns).includes(args.missingColumn))
    .map((summary) => {
      const orderedColumns = summarizeColumns(summary.columns);
      const missingIndex = orderedColumns.indexOf(args.missingColumn);
      if (missingIndex < 0) {
        return null;
      }

      let previousKnownRank: number | null = null;
      for (let index = missingIndex - 1; index >= 0; index -= 1) {
        const rank = rankByColumn.get(orderedColumns[index]!);
        if (typeof rank === 'number') {
          previousKnownRank = rank;
          break;
        }
      }

      let nextKnownRank: number | null = null;
      for (let index = missingIndex + 1; index < orderedColumns.length; index += 1) {
        const rank = rankByColumn.get(orderedColumns[index]!);
        if (typeof rank === 'number') {
          nextKnownRank = rank;
          break;
        }
      }

      if (previousKnownRank != null && nextKnownRank != null) {
        return (previousKnownRank + nextKnownRank + 1) / 2;
      }
      if (previousKnownRank != null) {
        return previousKnownRank + 1;
      }
      if (nextKnownRank != null) {
        return nextKnownRank;
      }
      return args.lanes.length / 2;
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return preferredInsertIndexes.length > 0
    ? medianValue(preferredInsertIndexes)
    : args.lanes.length / 2;
}

function buildMutableSegmentPlaceholderY(args: {
  previousFrozenY: number | null;
  nextFrozenY: number | null;
  count: number;
  minY: number;
  maxY: number;
  d1: number;
}): number[] {
  if (args.count <= 0) {
    return [];
  }

  if (args.previousFrozenY != null && args.nextFrozenY != null) {
    const rawStep = (args.nextFrozenY - args.previousFrozenY) / (args.count + 1);
    const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : args.d1;
    return Array.from({ length: args.count }, (_value, index) => clamp(
      args.previousFrozenY! + step * (index + 1),
      args.minY,
      args.maxY,
    ));
  }

  if (args.previousFrozenY != null) {
    return Array.from({ length: args.count }, (_value, index) => clamp(
      args.previousFrozenY! + args.d1 * (index + 1),
      args.minY,
      args.maxY,
    ));
  }

  if (args.nextFrozenY != null) {
    return Array.from({ length: args.count }, (_value, index) => clamp(
      args.nextFrozenY! - args.d1 * (args.count - index),
      args.minY,
      args.maxY,
    ));
  }

  const centeredStartY = (args.minY + args.maxY) / 2 - args.d1 * (args.count - 1) / 2;
  return Array.from({ length: args.count }, (_value, index) => clamp(
    centeredStartY + args.d1 * index,
    args.minY,
    args.maxY,
  ));
}

function assignOrderedLanePlaceholderY(args: {
  lanes: BoundaryLaneState[];
  minY: number;
  maxY: number;
  d1: number;
}): BoundaryLaneState[] {
  const nextLanes = args.lanes.map((lane) => ({ ...lane }));
  for (let index = 0; index < nextLanes.length; index += 1) {
    const lane = nextLanes[index]!;
    if (lane.frozenOrder !== false) {
      continue;
    }

    const segmentStart = index;
    while (index + 1 < nextLanes.length && nextLanes[index + 1]!.frozenOrder === false) {
      index += 1;
    }
    const segmentEnd = index;
    const previousFrozenLane = segmentStart > 0 ? nextLanes[segmentStart - 1] : null;
    const nextFrozenLane = segmentEnd + 1 < nextLanes.length ? nextLanes[segmentEnd + 1] : null;
    const placeholderYValues = buildMutableSegmentPlaceholderY({
      previousFrozenY: previousFrozenLane?.y ?? null,
      nextFrozenY: nextFrozenLane?.y ?? null,
      count: segmentEnd - segmentStart + 1,
      minY: args.minY,
      maxY: args.maxY,
      d1: args.d1,
    });
    for (let offset = 0; offset < placeholderYValues.length; offset += 1) {
      nextLanes[segmentStart + offset] = {
        ...nextLanes[segmentStart + offset]!,
        y: placeholderYValues[offset]!,
      };
    }
  }
  return nextLanes;
}

function insertMissingColumnsIntoLanes(args: {
  lanes: BoundaryLaneState[];
  summaries: IngressSummaryInput[];
  turnIndex: number;
  d1: number;
  minY: number;
  maxY: number;
}): BoundaryLaneState[] {
  let nextLanes = [...args.lanes];
  const seen = new Set(nextLanes.map((lane) => lane.column));
  const remainingColumns = args.summaries.flatMap((summary) => summarizeColumns(summary.columns))
    .filter((column) => {
      if (seen.has(column)) return false;
      seen.add(column);
      return true;
    });
  const summariesById = new Map(args.summaries.map((summary) => [summary.summaryId, summary]));

  while (remainingColumns.length > 0) {
    const rankedRemainingColumns = remainingColumns
      .map((column) => ({
        column,
        preferredInsertRank: estimateMissingColumnPreferredInsertRank({
          missingColumn: column,
          lanes: nextLanes,
          summaries: args.summaries,
        }),
      }))
      .sort((left, right) => {
        if (Math.abs(left.preferredInsertRank - right.preferredInsertRank) > 1e-6) {
          return left.preferredInsertRank - right.preferredInsertRank;
        }
        return left.column.localeCompare(right.column);
      });
    const nextColumn = rankedRemainingColumns.shift();
    if (!nextColumn) {
      break;
    }
    const { column: missingColumn, preferredInsertRank } = nextColumn;
    let bestCandidate = [...nextLanes, {
      column: missingColumn,
      y: 0,
      frozenOrder: false,
      introducedForTurnIndex: args.turnIndex,
    }];
    let bestCrossings = Number.POSITIVE_INFINITY;
    let bestRankDeviation = Number.POSITIVE_INFINITY;
    for (let insertIndex = 0; insertIndex <= nextLanes.length; insertIndex += 1) {
      const candidateOrder = [...nextLanes];
      candidateOrder.splice(insertIndex, 0, {
        column: missingColumn,
        y: 0,
        frozenOrder: false,
        introducedForTurnIndex: args.turnIndex,
      });
      const orderedSummaryIds = computeOrderedSummaryIds(args.summaries, candidateOrder);
      const crossings = computeIngressCrossingCount(
        orderedSummaryIds,
        summariesById,
        candidateOrder
      );
      const rankDeviation = Math.abs(insertIndex - preferredInsertRank);
      if (
        crossings < bestCrossings ||
        (crossings === bestCrossings && rankDeviation + 1e-6 < bestRankDeviation)
      ) {
        bestCrossings = crossings;
        bestRankDeviation = rankDeviation;
        bestCandidate = candidateOrder;
      }
    }
    nextLanes = bestCandidate;
    const remainingIndex = remainingColumns.indexOf(missingColumn);
    if (remainingIndex >= 0) {
      remainingColumns.splice(remainingIndex, 1);
    }
  }

  return assignOrderedLanePlaceholderY({
    lanes: nextLanes,
    minY: args.minY,
    maxY: args.maxY,
    d1: args.d1,
  });
}

function buildIngressOrderingContracts(args: {
  orderedSummaryIds: string[];
  summaries: IngressSummaryInput[];
  lanes: BoundaryLaneState[];
}): Map<string, SummaryBoundaryContract> {
  const summaryById = new Map(args.summaries.map((summary) => [summary.summaryId, summary]));
  const contractBySummaryId = new Map<string, SummaryBoundaryContract>();

  for (const summaryId of args.orderedSummaryIds) {
    const summary = summaryById.get(summaryId);
    if (!summary) continue;
    const leftPortColumnsInOrder = sortColumnsByLaneRank(summary.columns, args.lanes);
    contractBySummaryId.set(summaryId, {
      summaryId,
      leftPortColumnsInOrder,
    });
  }

  return contractBySummaryId;
}

function estimateMutableLaneFallbackY(args: {
  lanes: BoundaryLaneState[];
  laneIndex: number;
  minY: number;
  maxY: number;
  d1: number;
}): number {
  let segmentStart = args.laneIndex;
  while (segmentStart > 0 && args.lanes[segmentStart - 1]!.frozenOrder === false) {
    segmentStart -= 1;
  }
  let segmentEnd = args.laneIndex;
  while (segmentEnd + 1 < args.lanes.length && args.lanes[segmentEnd + 1]!.frozenOrder === false) {
    segmentEnd += 1;
  }
  const previousFrozenLane = segmentStart > 0 ? args.lanes[segmentStart - 1] : null;
  const nextFrozenLane = segmentEnd + 1 < args.lanes.length ? args.lanes[segmentEnd + 1] : null;
  const placeholderYValues = buildMutableSegmentPlaceholderY({
    previousFrozenY: previousFrozenLane?.y ?? null,
    nextFrozenY: nextFrozenLane?.y ?? null,
    count: segmentEnd - segmentStart + 1,
    minY: args.minY,
    maxY: args.maxY,
    d1: args.d1,
  });
  return placeholderYValues[args.laneIndex - segmentStart] ?? (args.minY + args.maxY) / 2;
}

function buildIngressConvergeTargetYByColumn(args: {
  lanes: BoundaryLaneState[];
  summaries: IngressSummaryPreparedInput[];
  minY: number;
  maxY: number;
  d1: number;
}): Map<string, number> {
  const targetYByColumn = new Map<string, number>();
  const frozenLanes = args.lanes.filter((lane) => lane.frozenOrder !== false);

  for (let laneIndex = 0; laneIndex < args.lanes.length; laneIndex += 1) {
    const lane = args.lanes[laneIndex]!;
    if (lane.frozenOrder !== false) {
      targetYByColumn.set(lane.column, lane.y);
      continue;
    }

    const targetCandidates = args.summaries
      .filter((summary) => summarizeColumns(summary.columns).includes(lane.column))
      .map((summary) => {
        const summaryTop = estimateSummaryTopFromExistingLaneAnchors(
          summary,
          frozenLanes,
          lane.column,
        );
        const offsetY = Number(summary.leftAnchorOffsetYByColumn[lane.column]);
        if (summaryTop == null || !Number.isFinite(offsetY)) {
          return null;
        }
        return summaryTop + offsetY;
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    targetYByColumn.set(
      lane.column,
      targetCandidates.length > 0
        ? medianValue(targetCandidates)
        : estimateMutableLaneFallbackY({
          lanes: args.lanes,
          laneIndex,
          minY: args.minY,
          maxY: args.maxY,
          d1: args.d1,
        })
    );
  }

  return targetYByColumn;
}

function solveGapConstrainedPositions(args: {
  orderedColumns: string[];
  targetYByColumn: Map<string, number>;
  minY: number;
  maxY: number;
  d1: number;
  d2: number;
}): Map<string, number> {
  const { orderedColumns, targetYByColumn, minY, maxY } = args;
  if (orderedColumns.length === 0) return new Map<string, number>();

  const totalSpan = Math.max(1, maxY - minY);
  const maxFeasibleD1 = orderedColumns.length > 1
    ? totalSpan / (orderedColumns.length - 1)
    : totalSpan;
  const d1 = Math.max(1e-3, Math.min(args.d1, maxFeasibleD1));
  const clampedTargetValues = orderedColumns.map((column) =>
    clamp(targetYByColumn.get(column) ?? (minY + maxY) / 2, minY, maxY)
  );
  let targetGapFloor = d1;
  for (let index = 1; index < clampedTargetValues.length; index += 1) {
    targetGapFloor = Math.max(targetGapFloor, clampedTargetValues[index] - clampedTargetValues[index - 1]);
  }
  // If alignment already produced a legal inter-cluster gap, compaction should not squeeze it away.
  const d2 = Math.max(d1 + 1e-3, Math.min(Math.max(args.d2, targetGapFloor), totalSpan));

  const values = [...clampedTargetValues];

  const project = () => {
    for (let index = 1; index < values.length; index += 1) {
      values[index] = Math.max(values[index], values[index - 1] + d1);
    }
    for (let index = values.length - 2; index >= 0; index -= 1) {
      values[index] = Math.min(values[index], values[index + 1] - d1);
    }
    for (let index = 1; index < values.length; index += 1) {
      values[index] = Math.min(values[index], values[index - 1] + d2);
    }
    for (let index = values.length - 2; index >= 0; index -= 1) {
      values[index] = Math.max(values[index], values[index + 1] - d2);
    }
    for (let index = 0; index < values.length; index += 1) {
      values[index] = clamp(values[index], minY, maxY);
    }
  };

  for (let iter = 0; iter < 18; iter += 1) {
    project();
  }

  const solved = new Map<string, number>();
  for (let index = 0; index < orderedColumns.length; index += 1) {
    solved.set(orderedColumns[index], values[index]);
  }
  return solved;
}

function centerSolvedBandPositions(args: {
  orderedColumns: string[];
  solvedY: Map<string, number>;
  minY: number;
  maxY: number;
}): Map<string, number> {
  if (args.orderedColumns.length === 0) {
    return new Map<string, number>();
  }
  const values = args.orderedColumns
    .map((column) => args.solvedY.get(column))
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return new Map(args.solvedY);
  }
  const bandMin = Math.min(...values);
  const bandMax = Math.max(...values);
  const desiredDelta = (args.minY + args.maxY) / 2 - (bandMin + bandMax) / 2;
  const delta = clamp(
    desiredDelta,
    args.minY - bandMin,
    args.maxY - bandMax,
  );
  if (Math.abs(delta) <= 1e-6) {
    return new Map(args.solvedY);
  }
  const centered = new Map<string, number>();
  for (const column of args.orderedColumns) {
    const y = args.solvedY.get(column);
    if (typeof y !== 'number' || !Number.isFinite(y)) continue;
    centered.set(column, clamp(y + delta, args.minY, args.maxY));
  }
  return centered;
}

export function solveGapConstrainedPositionsPreservingFrozenLanes(args: {
  lanes: BoundaryLaneState[];
  targetYByColumn: Map<string, number>;
  minY: number;
  maxY: number;
  d1: number;
  d2: number;
}): Map<string, number> {
  const orderedColumns = args.lanes.map((lane) => lane.column);
  if (orderedColumns.length === 0) {
    return new Map<string, number>();
  }
  const hasMutableLane = args.lanes.some((lane) => lane.frozenOrder === false);
  if (!hasMutableLane) {
    return new Map(args.lanes.map((lane) => [lane.column, lane.y]));
  }

  const solved = new Map<string, number>();
  const currentYByColumn = new Map(args.lanes.map((lane) => [lane.column, lane.y]));

  for (let index = 0; index < args.lanes.length; index += 1) {
    const lane = args.lanes[index];
    if (lane.frozenOrder !== false) {
      solved.set(lane.column, lane.y);
      continue;
    }

    const segmentStart = index;
    while (index + 1 < args.lanes.length && args.lanes[index + 1]!.frozenOrder === false) {
      index += 1;
    }
    const segmentEnd = index;
    const segmentLanes = args.lanes.slice(segmentStart, segmentEnd + 1);
    const previousFrozenLane = segmentStart > 0 ? args.lanes[segmentStart - 1] : null;
    const nextFrozenLane = segmentEnd + 1 < args.lanes.length ? args.lanes[segmentEnd + 1] : null;

    let segmentMinY = previousFrozenLane ? previousFrozenLane.y + args.d1 : args.minY;
    let segmentMaxY = nextFrozenLane ? nextFrozenLane.y - args.d1 : args.maxY;
    if (segmentMinY > segmentMaxY) {
      const fallbackCenter = clamp(
        previousFrozenLane && nextFrozenLane
          ? (previousFrozenLane.y + nextFrozenLane.y) / 2
          : previousFrozenLane
            ? previousFrozenLane.y + args.d1
            : nextFrozenLane
              ? nextFrozenLane.y - args.d1
              : (args.minY + args.maxY) / 2,
        args.minY,
        args.maxY,
      );
      segmentMinY = fallbackCenter;
      segmentMaxY = fallbackCenter;
    }

    const segmentColumns = segmentLanes.map((lane) => lane.column);
    const segmentTargetYByColumn = new Map<string, number>();
    for (const column of segmentColumns) {
      segmentTargetYByColumn.set(
        column,
        args.targetYByColumn.get(column)
          ?? currentYByColumn.get(column)
          ?? (segmentMinY + segmentMaxY) / 2
      );
    }
    const segmentSolved = solveGapConstrainedPositions({
      orderedColumns: segmentColumns,
      targetYByColumn: segmentTargetYByColumn,
      minY: segmentMinY,
      maxY: segmentMaxY,
      d1: args.d1,
      d2: args.d2,
    });
    const solvedValues = segmentColumns.map((column) => (
      segmentSolved.get(column)
      ?? currentYByColumn.get(column)
      ?? (segmentMinY + segmentMaxY) / 2
    ));
    const segmentMinValue = Math.min(...solvedValues);
    const segmentMaxValue = Math.max(...solvedValues);
    const baseDeltaMin = segmentMinY - segmentMinValue;
    const baseDeltaMax = segmentMaxY - segmentMaxValue;
    let preferredDeltaMin = baseDeltaMin;
    let preferredDeltaMax = baseDeltaMax;
    if (previousFrozenLane) {
      preferredDeltaMax = Math.min(
        preferredDeltaMax,
        previousFrozenLane.y + args.d2 - solvedValues[0]!
      );
    }
    if (nextFrozenLane) {
      preferredDeltaMin = Math.max(
        preferredDeltaMin,
        nextFrozenLane.y - args.d2 - solvedValues[solvedValues.length - 1]!
      );
    }
    const preferredShift = medianValue(segmentColumns.map((column, segmentIndex) => {
      const targetY = segmentTargetYByColumn.get(column);
      return (targetY ?? solvedValues[segmentIndex]!) - solvedValues[segmentIndex]!;
    }));
    const shift = preferredDeltaMin <= preferredDeltaMax
      ? clamp(preferredShift, preferredDeltaMin, preferredDeltaMax)
      : clamp(preferredShift, baseDeltaMin, baseDeltaMax);

    for (const [segmentIndex, column] of segmentColumns.entries()) {
      const nextY = clamp(solvedValues[segmentIndex]! + shift, segmentMinY, segmentMaxY);
      solved.set(column, nextY);
    }
  }

  return solved;
}

function computeBoundaryGapProfile(
  baseD1: number,
  baseD2: number
): { d1: number; d2: number } {
  const d1 = Math.max(2.8, baseD1);
  const d2 = Math.max(d1 + 6, baseD2);
  return { d1, d2 };
}

export function solveIngressWindow(args: {
  leftLanes: BoundaryLaneState[];
  summaries: IngressSummaryPreparedInput[];
  turnIndex: number;
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
  baseD1: number;
  baseD2: number;
}): IngressWindowResult {
  const summaries = args.summaries.map((summary) => ({
    summaryId: summary.summaryId,
    columns: summarizeColumns(summary.columns),
  }));
  const gapProfile = computeBoundaryGapProfile(args.baseD1, args.baseD2);
  const orderedLanes = insertMissingColumnsIntoLanes({
    lanes: args.leftLanes,
    summaries,
    turnIndex: args.turnIndex,
    d1: gapProfile.d1,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
  });
  const orderedSummaryIds = computeOrderedSummaryIds(summaries, orderedLanes);
  const contractBySummaryId = buildIngressOrderingContracts({
    orderedSummaryIds,
    summaries,
    lanes: orderedLanes,
  });

  return {
    leftLanes: orderedLanes,
    orderedSummaryIds,
    contractBySummaryId,
    crossingCount: computeIngressCrossingCount(
      orderedSummaryIds,
      new Map(summaries.map((summary) => [summary.summaryId, summary])),
      orderedLanes
    ),
  };
}

export function solveIngressConvergeWindow(args: {
  leftLanes: BoundaryLaneState[];
  summaries: IngressSummaryPreparedInput[];
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
  baseD1: number;
  baseD2: number;
}): BoundaryLaneState[] {
  const orderedColumns = args.leftLanes.map((lane) => lane.column);
  if (orderedColumns.length === 0) {
    return [];
  }

  const gapProfile = computeBoundaryGapProfile(args.baseD1, args.baseD2);
  const targetYByColumn = buildIngressConvergeTargetYByColumn({
    lanes: args.leftLanes,
    summaries: args.summaries,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
    d1: gapProfile.d1,
  });
  const solvedY = solveGapConstrainedPositions({
    orderedColumns,
    targetYByColumn,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
    d1: gapProfile.d1,
    d2: gapProfile.d2,
  });
  return args.leftLanes.map((lane) => ({
    ...lane,
    y: solvedY.get(lane.column) ?? lane.y,
  }));
}

export function solveEgressWindow(args: {
  summaries: EgressSummaryInput[];
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
  baseD1: number;
  baseD2: number;
}): TurnEgressSignature {
  const anchorValuesByColumn = new Map<string, number[]>();
  const firstOccurrenceOrder: string[] = [];
  const seen = new Set<string>();
  const sortedSummaries = [...args.summaries].sort((a, b) => a.top - b.top);

  for (const summary of sortedSummaries) {
    const orderedColumns = Object.entries(summary.rightAnchorYByColumn)
      .sort((a, b) => a[1] - b[1])
      .map(([column]) => column);
    for (const column of orderedColumns) {
      if (!seen.has(column)) {
        seen.add(column);
        firstOccurrenceOrder.push(column);
      }
      const values = anchorValuesByColumn.get(column) ?? [];
      const anchorY = summary.rightAnchorYByColumn[column];
      if (typeof anchorY === 'number') values.push(anchorY);
      anchorValuesByColumn.set(column, values);
    }
  }

  const weighted = firstOccurrenceOrder.map((column, index) => ({
    column,
    medianY: medianValue(anchorValuesByColumn.get(column) ?? []),
    index,
  }));
  weighted.sort((a, b) => {
    if (Math.abs(a.medianY - b.medianY) > 1e-6) return a.medianY - b.medianY;
    return a.index - b.index;
  });
  const orderedColumns = weighted.map((item) => item.column);
  const targetYByColumn = new Map<string, number>();
  for (const column of orderedColumns) {
    targetYByColumn.set(column, medianValue(anchorValuesByColumn.get(column) ?? []));
  }
  const gapProfile = computeBoundaryGapProfile(args.baseD1, args.baseD2);
  const solvedY = solveGapConstrainedPositions({
    orderedColumns,
    targetYByColumn,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
    d1: gapProfile.d1,
    d2: gapProfile.d2,
  });
  const centeredY = centerSolvedBandPositions({
    orderedColumns,
    solvedY,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
  });
  const outputTargetYByColumn: Record<string, number> = {};
  const outputAnchorValuesByColumn: Record<string, number[]> = {};
  for (const column of orderedColumns) {
    outputTargetYByColumn[column] = centeredY.get(column) ?? targetYByColumn.get(column) ?? 0;
    outputAnchorValuesByColumn[column] = anchorValuesByColumn.get(column) ?? [];
  }
  return {
    orderedColumns,
    targetYByColumn: outputTargetYByColumn,
    anchorValuesByColumn: outputAnchorValuesByColumn,
  };
}

export function solveInitialLeftConvergeWindow(args: {
  summaries: EgressSummaryInput[];
  adaptiveProfile: StorylineAdaptiveProfile;
  yTopBound: number;
  yBottomBound: number;
  baseD1: number;
  baseD2: number;
}): TurnEgressSignature {
  const anchorValuesByColumn = new Map<string, number[]>();
  const orderedColumns: string[] = [];
  const seen = new Set<string>();
  const sortedSummaries = [...args.summaries].sort((a, b) => a.top - b.top);

  for (const summary of sortedSummaries) {
    const orderedEntries = Object.entries(summary.rightAnchorYByColumn)
      .sort((a, b) => a[1] - b[1]);
    for (const [column, anchorY] of orderedEntries) {
      if (!seen.has(column)) {
        seen.add(column);
        orderedColumns.push(column);
      }
      const values = anchorValuesByColumn.get(column) ?? [];
      values.push(anchorY);
      anchorValuesByColumn.set(column, values);
    }
  }

  const targetYByColumn = new Map<string, number>();
  for (const column of orderedColumns) {
    targetYByColumn.set(column, medianValue(anchorValuesByColumn.get(column) ?? []));
  }
  const gapProfile = computeBoundaryGapProfile(args.baseD1, args.baseD2);
  const solvedY = solveGapConstrainedPositions({
    orderedColumns,
    targetYByColumn,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
    d1: gapProfile.d1,
    d2: gapProfile.d2,
  });
  const centeredY = centerSolvedBandPositions({
    orderedColumns,
    solvedY,
    minY: args.yTopBound + 8,
    maxY: args.yBottomBound - 8,
  });
  const outputTargetYByColumn: Record<string, number> = {};
  const outputAnchorValuesByColumn: Record<string, number[]> = {};
  for (const column of orderedColumns) {
    outputTargetYByColumn[column] = centeredY.get(column) ?? targetYByColumn.get(column) ?? 0;
    outputAnchorValuesByColumn[column] = anchorValuesByColumn.get(column) ?? [];
  }
  return {
    orderedColumns,
    targetYByColumn: outputTargetYByColumn,
    anchorValuesByColumn: outputAnchorValuesByColumn,
  };
}
