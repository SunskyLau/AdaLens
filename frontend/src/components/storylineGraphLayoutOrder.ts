import { countOrderCrossings } from './storylineThreadRouting';
import {
  clamp,
  GLYPH_MIN_HIT_DIAMETER_PX,
} from './storylineGraphLayoutConstants';

function sortByBarycenter(
  order: number[],
  barycenter: number[],
  currentRank: Map<number, number>
): number[] {
  return [...order].sort((a, b) => {
    const delta = barycenter[a] - barycenter[b];
    if (Math.abs(delta) > 1e-6) return delta;
    return (currentRank.get(a) || 0) - (currentRank.get(b) || 0);
  });
}

function placeInvolvedBlockContiguously(
  sorted: number[],
  involvedMask: boolean[],
  currentRank: Map<number, number>
): number[] {
  const involved = sorted.filter((columnIndex) => involvedMask[columnIndex]);
  if (involved.length <= 1 || involved.length === sorted.length) return sorted;

  const others = sorted.filter((columnIndex) => !involvedMask[columnIndex]);
  const baseRank = new Map<number, number>();
  for (let rank = 0; rank < sorted.length; rank += 1) baseRank.set(sorted[rank], rank);

  let bestOrder = sorted;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let split = 0; split <= others.length; split += 1) {
    const candidate = [...others.slice(0, split), ...involved, ...others.slice(split)];
    let cost = 0;
    for (let rank = 0; rank < candidate.length; rank += 1) {
      const columnIndex = candidate[rank];
      cost += Math.abs(rank - (baseRank.get(columnIndex) || 0));
      cost += 0.08 * Math.abs(rank - (currentRank.get(columnIndex) || 0));
    }
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      bestOrder = candidate;
    }
  }

  return bestOrder;
}

function constrainedSortOrder(
  currentOrder: number[],
  barycenter: number[],
  involvedMask: boolean[]
): number[] {
  const currentRank = new Map<number, number>();
  for (let index = 0; index < currentOrder.length; index += 1) {
    currentRank.set(currentOrder[index], index);
  }

  const sorted = sortByBarycenter(currentOrder, barycenter, currentRank);
  return placeInvolvedBlockContiguously(sorted, involvedMask, currentRank);
}

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function alignGlyphMedianToTarget(
  yValues: number[],
  hitDiameters: number[],
  yTop: number,
  yBottom: number,
  targetMedian?: number
): number[] {
  if (yValues.length === 0) return yValues;

  const lowerBounds: number[] = [];
  const upperBounds: number[] = [];
  for (let index = 0; index < yValues.length; index += 1) {
    const half = (hitDiameters[index] || GLYPH_MIN_HIT_DIAMETER_PX) / 2;
    const minY = yTop + half + 4;
    const maxY = yBottom - half - 16;
    lowerBounds.push(minY);
    upperBounds.push(maxY);
  }

  const minMedian = medianValue(lowerBounds);
  const maxMedian = medianValue(upperBounds);
  const alignedTarget = clamp(targetMedian ?? (yTop + yBottom) / 2, minMedian, maxMedian);

  const evaluateMedian = (delta: number): number => {
    const shifted = yValues.map((value, index) =>
      clamp(value + delta, lowerBounds[index], upperBounds[index])
    );
    return medianValue(shifted);
  };

  let lowDelta = Math.min(...lowerBounds.map((bound, index) => bound - yValues[index])) - 2;
  let highDelta = Math.max(...upperBounds.map((bound, index) => bound - yValues[index])) + 2;

  for (let iter = 0; iter < 42; iter += 1) {
    const mid = (lowDelta + highDelta) / 2;
    const midMedian = evaluateMedian(mid);
    if (midMedian < alignedTarget) {
      lowDelta = mid;
    } else {
      highDelta = mid;
    }
  }

  const appliedDelta = (lowDelta + highDelta) / 2;
  return yValues.map((value, index) =>
    clamp(value + appliedDelta, lowerBounds[index], upperBounds[index])
  );
}

export function createInvolvedMatrix(
  entries: Array<{ columns: string[] }>,
  orderedColumns: string[]
): boolean[][] {
  return entries.map((entry) => {
    const set = new Set(entry.columns);
    return orderedColumns.map((column) => set.has(column));
  });
}

export function buildOrderMatrix(
  involvedMatrix: boolean[][],
  columnCount: number,
  initialOrder: number[],
  options: {
    fixedOrderBySlotIndex?: Map<number, number[]>;
  } = {}
): { orderBySlot: number[][]; M_order: number[][]; crossingCount: number } {
  const slotCount = involvedMatrix.length;
  if (slotCount === 0) return { orderBySlot: [], M_order: [], crossingCount: 0 };
  const fixedOrderBySlotIndex = options.fixedOrderBySlotIndex ?? new Map<number, number[]>();

  const seedBarycenter = new Array<number>(columnCount).fill(0);
  for (let index = 0; index < initialOrder.length; index += 1) {
    seedBarycenter[initialOrder[index]] = index;
  }

  const normalizeFixedOrder = (order: number[] | undefined): number[] | null => {
    if (!order || order.length === 0) return null;
    const deduped: number[] = [];
    const seen = new Set<number>();
    for (const columnIndex of order) {
      if (columnIndex < 0 || columnIndex >= columnCount || seen.has(columnIndex)) continue;
      seen.add(columnIndex);
      deduped.push(columnIndex);
    }
    for (const columnIndex of initialOrder) {
      if (seen.has(columnIndex)) continue;
      seen.add(columnIndex);
      deduped.push(columnIndex);
    }
    return deduped.length === columnCount ? deduped : null;
  };

  const orderBySlot = Array.from({ length: slotCount }, (_unused, slotIndex) => {
    const fixedOrder = normalizeFixedOrder(fixedOrderBySlotIndex.get(slotIndex));
    return fixedOrder ?? [...initialOrder];
  });
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    if (fixedOrderBySlotIndex.has(slotIndex)) continue;
    orderBySlot[slotIndex] = constrainedSortOrder(
      orderBySlot[slotIndex],
      seedBarycenter,
      involvedMatrix[slotIndex]
    );
  }

  for (let iter = 0; iter < 12; iter += 1) {
    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      if (fixedOrderBySlotIndex.has(slotIndex)) continue;
      const barycenter = new Array<number>(columnCount).fill(0);
      for (let rank = 0; rank < orderBySlot[slotIndex - 1].length; rank += 1) {
        barycenter[orderBySlot[slotIndex - 1][rank]] = rank;
      }
      orderBySlot[slotIndex] = constrainedSortOrder(
        orderBySlot[slotIndex],
        barycenter,
        involvedMatrix[slotIndex]
      );
    }

    for (let slotIndex = slotCount - 2; slotIndex >= 0; slotIndex -= 1) {
      if (fixedOrderBySlotIndex.has(slotIndex)) continue;
      const barycenter = new Array<number>(columnCount).fill(0);
      for (let rank = 0; rank < orderBySlot[slotIndex + 1].length; rank += 1) {
        barycenter[orderBySlot[slotIndex + 1][rank]] = rank;
      }
      orderBySlot[slotIndex] = constrainedSortOrder(
        orderBySlot[slotIndex],
        barycenter,
        involvedMatrix[slotIndex]
      );
    }
  }

  const M_order = orderBySlot.map((order) => {
    const row = new Array<number>(columnCount).fill(0);
    for (let rank = 0; rank < order.length; rank += 1) row[order[rank]] = rank;
    return row;
  });

  let crossingCount = 0;
  for (let slotIndex = 1; slotIndex < orderBySlot.length; slotIndex += 1) {
    crossingCount += countOrderCrossings(orderBySlot[slotIndex - 1], orderBySlot[slotIndex]);
  }

  return { orderBySlot, M_order, crossingCount };
}

export function computeGlyphYFromStructuralFlow(args: {
  orderBySlot: number[][];
  involvedMatrix: boolean[][];
  hitDiameters: number[];
  yTop: number;
  yBottom: number;
  yMedianTarget?: number;
}): number[] {
  const { orderBySlot, involvedMatrix, hitDiameters, yTop, yBottom, yMedianTarget } = args;
  const slotCount = involvedMatrix.length;
  if (slotCount === 0) return [];

  const y: number[] = new Array<number>(slotCount).fill((yTop + yBottom) / 2);
  const crossings = new Array<number>(slotCount).fill(0);
  for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
    crossings[slotIndex] = countOrderCrossings(
      orderBySlot[slotIndex - 1],
      orderBySlot[slotIndex]
    );
  }
  const maxCrossing = Math.max(1, ...crossings);

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const order = orderBySlot[slotIndex];
    const involvedFlags = involvedMatrix[slotIndex];
    const involvedRanks = order
      .map((columnIndex, rank) => (involvedFlags[columnIndex] ? rank : -1))
      .filter((rank) => rank >= 0);

    const meanRank = involvedRanks.length > 0
      ? involvedRanks.reduce((sum, value) => sum + value, 0) / involvedRanks.length
      : order.length / 2;
    const rankNorm = order.length > 1 ? meanRank / (order.length - 1) : 0.5;

    const spreadNorm = involvedRanks.length > 1
      ? (Math.max(...involvedRanks) - Math.min(...involvedRanks)) / Math.max(1, order.length - 1)
      : 0;

    const crossNorm = crossings[slotIndex] / maxCrossing;
    const targetNorm = clamp(
      0.14 + rankNorm * 0.28 + spreadNorm * 0.1 + crossNorm * 0.24,
      0.08,
      0.72
    );
    const targetY = yTop + targetNorm * (yBottom - yTop);

    const half = (hitDiameters[slotIndex] || GLYPH_MIN_HIT_DIAMETER_PX) / 2;
    const minY = yTop + half + 4;
    const maxY = yBottom - half - 16;

    if (slotIndex === 0) {
      y[slotIndex] = clamp(targetY, minY, maxY);
    } else {
      const smoothed = y[slotIndex - 1] * 0.64 + targetY * 0.36;
      y[slotIndex] = clamp(smoothed, minY, maxY);
    }
  }

  return alignGlyphMedianToTarget(y, hitDiameters, yTop, yBottom, yMedianTarget);
}
