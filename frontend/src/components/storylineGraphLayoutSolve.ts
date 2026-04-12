import {
  STORYLINE_SOLVER_ALIGN_ORDER_DELTA,
  STORYLINE_SOLVER_D1_MAX_PX,
  STORYLINE_SOLVER_D1_MIN_PX,
  STORYLINE_SOLVER_D2_MAX_PX,
  STORYLINE_SOLVER_D2_MIN_PX,
  STORYLINE_SOLVER_OPT_ITERS,
  STORYLINE_SOLVER_OPT_STEP,
} from '@/config';
import {
  clamp,
  D1_HARD_FLOOR_PX,
  UNINVOLVED_SLOT_ROUTEBOX_CLEARANCE_MIN_PX,
} from './storylineGraphLayoutConstants';
import type {
  StorylineAdaptiveProfile,
  StorylineSlotGeometry,
} from './storylineGraphLayout';

type UninvolvedSide = 'above' | 'below';

interface YInterval {
  low: number;
  high: number;
}

function computeUninvolvedRouteBoxClearance(
  slot: StorylineSlotGeometry,
  d1: number,
  d2: number
): number {
  const shoulder = Math.max(0, slot.connectTopY - slot.routeBoxTopY);
  const preferred = shoulder + d1 * 0.32;
  const ceiling = Math.max(
    UNINVOLVED_SLOT_ROUTEBOX_CLEARANCE_MIN_PX,
    Math.min(d2 * 0.42, d1 * 0.68 + shoulder)
  );
  return clamp(preferred, UNINVOLVED_SLOT_ROUTEBOX_CLEARANCE_MIN_PX, ceiling);
}

function allowedYInterval(
  slot: StorylineSlotGeometry,
  involved: boolean,
  uninvolvedSide: UninvolvedSide | null,
  d1: number,
  d2: number,
  yTopBound: number,
  yBottomBound: number
): YInterval {
  const boundedTop = Math.min(yTopBound, yBottomBound);
  const boundedBottom = Math.max(yTopBound, yBottomBound);
  if (involved) {
    const connectLow = clamp(slot.connectTopY, boundedTop, boundedBottom);
    const connectHigh = clamp(slot.connectBottomY, boundedTop, boundedBottom);
    if (connectLow <= connectHigh) {
      return {
        low: connectLow,
        high: connectHigh,
      };
    }

    const center = clamp(
      (slot.routeBoxTopY + slot.routeBoxBottomY) / 2,
      boundedTop,
      boundedBottom
    );
    return {
      low: center,
      high: center,
    };
  }

  const outsideGap = computeUninvolvedRouteBoxClearance(slot, d1, d2);
  const aboveInterval = (): YInterval | null => {
    const low = boundedTop;
    const high = Math.min(boundedBottom, slot.routeBoxTopY - outsideGap);
    if (low <= high) return { low, high };
    return null;
  };
  const belowInterval = (): YInterval | null => {
    const low = Math.max(boundedTop, slot.routeBoxBottomY + outsideGap);
    const high = boundedBottom;
    if (low <= high) return { low, high };
    return null;
  };

  if (uninvolvedSide === 'above') {
    return aboveInterval() ?? belowInterval() ?? {
      low: slot.routeBoxTopY - outsideGap,
      high: slot.routeBoxTopY - outsideGap,
    };
  }

  return belowInterval() ?? aboveInterval() ?? {
    low: slot.routeBoxBottomY + outsideGap,
    high: slot.routeBoxBottomY + outsideGap,
  };
}

function isUninvolvedPair(
  involvedFlags: boolean[],
  leftColumnIndex: number,
  rightColumnIndex: number
): boolean {
  return !involvedFlags[leftColumnIndex] && !involvedFlags[rightColumnIndex];
}

function buildSlotTargetRow(args: {
  columnCount: number;
  order: number[];
  involvedFlags: boolean[];
  uninvolvedSides: Array<UninvolvedSide | null>;
  slot: StorylineSlotGeometry;
  yTopBound: number;
  yBottomBound: number;
  d1: number;
  d2: number;
}): number[] {
  const {
    columnCount,
    order,
    involvedFlags,
    uninvolvedSides,
    slot,
    yTopBound,
    yBottomBound,
    d1,
    d2,
  } = args;
  const row = new Array<number>(columnCount).fill((yTopBound + yBottomBound) / 2);

  const intervals = row.map((_unused, columnIndex) =>
    allowedYInterval(
      slot,
      involvedFlags[columnIndex],
      uninvolvedSides[columnIndex],
      d1,
      d2,
      yTopBound,
      yBottomBound
    )
  );
  const involvedColumns = order.filter((columnIndex) => involvedFlags[columnIndex]);
  if (involvedColumns.length === 0) {
    const fullSpan = Math.max(1, yBottomBound - yTopBound);
    const baseStep = order.length > 1
      ? Math.max(d1, Math.min((d1 + d2) / 2, fullSpan / (order.length - 1)))
      : 0;

    for (let rank = 0; rank < order.length; rank += 1) {
      const columnIndex = order[rank];
      const target = yTopBound + rank * baseStep;
      row[columnIndex] = clamp(target, intervals[columnIndex].low, intervals[columnIndex].high);
    }
    return row;
  }

  for (const columnIndex of order) {
    const interval = intervals[columnIndex];
    row[columnIndex] = clamp((interval.low + interval.high) / 2, interval.low, interval.high);
  }

  {
    const commonLow = Math.max(
      ...involvedColumns.map((columnIndex) => intervals[columnIndex].low)
    );
    const commonHigh = Math.min(
      ...involvedColumns.map((columnIndex) => intervals[columnIndex].high)
    );
    if (commonLow <= commonHigh + 1e-9) {
      if (involvedColumns.length === 1) {
        row[involvedColumns[0]] = clamp(row[involvedColumns[0]], commonLow, commonHigh);
      } else {
        const feasibleD1 = Math.min(
          d1,
          (commonHigh - commonLow) / Math.max(1, involvedColumns.length - 1)
        );
        const center = (commonLow + commonHigh) / 2;
        const halfSpan = (feasibleD1 * (involvedColumns.length - 1)) / 2;
        const start = clamp(
          center - halfSpan,
          commonLow,
          commonHigh - feasibleD1 * (involvedColumns.length - 1)
        );
        for (let rank = 0; rank < involvedColumns.length; rank += 1) {
          row[involvedColumns[rank]] = start + rank * feasibleD1;
        }
      }
    }
  }

  const aboveColumns = order.filter(
    (columnIndex) => !involvedFlags[columnIndex] && uninvolvedSides[columnIndex] === 'above'
  );
  let aboveCursor = Number.POSITIVE_INFINITY;
  for (let rank = aboveColumns.length - 1; rank >= 0; rank -= 1) {
    const columnIndex = aboveColumns[rank];
    const interval = intervals[columnIndex];
    const preferred = Number.isFinite(aboveCursor)
      ? Math.min(interval.high, aboveCursor - d1)
      : interval.high;
    row[columnIndex] = clamp(preferred, interval.low, interval.high);
    aboveCursor = row[columnIndex];
  }

  const belowColumns = order.filter(
    (columnIndex) => !involvedFlags[columnIndex] && uninvolvedSides[columnIndex] === 'below'
  );
  let belowCursor = Number.NEGATIVE_INFINITY;
  for (let rank = 0; rank < belowColumns.length; rank += 1) {
    const columnIndex = belowColumns[rank];
    const interval = intervals[columnIndex];
    const preferred = Number.isFinite(belowCursor)
      ? Math.max(interval.low, belowCursor + d1)
      : interval.low;
    row[columnIndex] = clamp(preferred, interval.low, interval.high);
    belowCursor = row[columnIndex];
  }

  return row;
}

function projectSlotRowWithConstraints(args: {
  row: number[];
  order: number[];
  involvedFlags: boolean[];
  uninvolvedSides: Array<UninvolvedSide | null>;
  slot: StorylineSlotGeometry;
  yTopBound: number;
  yBottomBound: number;
  d1: number;
  d2: number;
}): number[] {
  const {
    row,
    order,
    involvedFlags,
    uninvolvedSides,
    slot,
    yTopBound,
    yBottomBound,
    d1,
    d2,
  } = args;
  const output = [...row];

  const intervals = output.map((_unused, columnIndex) =>
    allowedYInterval(
      slot,
      involvedFlags[columnIndex],
      uninvolvedSides[columnIndex],
      d1,
      d2,
      yTopBound,
      yBottomBound
    )
  );

  for (let columnIndex = 0; columnIndex < output.length; columnIndex += 1) {
    output[columnIndex] = clamp(
      output[columnIndex],
      intervals[columnIndex].low,
      intervals[columnIndex].high
    );
  }

  const involvedColumns = order.filter((columnIndex) => involvedFlags[columnIndex]);
  if (involvedColumns.length > 0) {
    const commonLow = Math.max(
      ...involvedColumns.map((columnIndex) => intervals[columnIndex].low)
    );
    const commonHigh = Math.min(
      ...involvedColumns.map((columnIndex) => intervals[columnIndex].high)
    );
    if (commonLow <= commonHigh + 1e-9) {
      if (involvedColumns.length === 1) {
        const columnIndex = involvedColumns[0];
        output[columnIndex] = clamp(output[columnIndex], commonLow, commonHigh);
      } else {
        const feasibleD1 = Math.min(
          d1,
          (commonHigh - commonLow) / Math.max(1, involvedColumns.length - 1)
        );
        const mean = involvedColumns.reduce(
          (sum, columnIndex) => sum + output[columnIndex],
          0
        ) / involvedColumns.length;
        const halfSpan = (feasibleD1 * (involvedColumns.length - 1)) / 2;
        const start = clamp(
          mean - halfSpan,
          commonLow,
          commonHigh - feasibleD1 * (involvedColumns.length - 1)
        );
        for (let rank = 0; rank < involvedColumns.length; rank += 1) {
          const columnIndex = involvedColumns[rank];
          output[columnIndex] = clamp(start + rank * feasibleD1, commonLow, commonHigh);
        }
      }
    }
  }

  for (let pass = 0; pass < 8; pass += 1) {
    for (let rank = 1; rank < order.length; rank += 1) {
      const prevColumn = order[rank - 1];
      const column = order[rank];
      const minGap = d1;
      const maxGap = isUninvolvedPair(involvedFlags, prevColumn, column)
        ? d2
        : Number.POSITIVE_INFINITY;

      let low = Math.max(intervals[column].low, output[prevColumn] + minGap);
      let high = intervals[column].high;
      if (Number.isFinite(maxGap)) high = Math.min(high, output[prevColumn] + maxGap);

      if (low <= high) {
        output[column] = clamp(output[column], low, high);
      } else {
        output[column] = clamp(low, intervals[column].low, intervals[column].high);
      }
    }

    for (let rank = order.length - 2; rank >= 0; rank -= 1) {
      const column = order[rank];
      const nextColumn = order[rank + 1];
      const minGap = d1;
      const maxGap = isUninvolvedPair(involvedFlags, column, nextColumn)
        ? d2
        : Number.POSITIVE_INFINITY;

      let high = Math.min(intervals[column].high, output[nextColumn] - minGap);
      let low = intervals[column].low;
      if (Number.isFinite(maxGap)) low = Math.max(low, output[nextColumn] - maxGap);

      if (low <= high) {
        output[column] = clamp(output[column], low, high);
      } else {
        output[column] = clamp(high, intervals[column].low, intervals[column].high);
      }
    }
  }

  for (let columnIndex = 0; columnIndex < output.length; columnIndex += 1) {
    output[columnIndex] = clamp(
      output[columnIndex],
      intervals[columnIndex].low,
      intervals[columnIndex].high
    );
  }

  return output;
}

function enforceExactAlignment(args: {
  yMatrix: number[][];
  M_align: number[][];
  slots: StorylineSlotGeometry[];
  involvedMatrix: boolean[][];
  uninvolvedSideMatrix: Array<Array<UninvolvedSide | null>>;
  d1BySlot: number[];
  d2BySlot: number[];
  yTopBound: number;
  yBottomBound: number;
}): void {
  const {
    yMatrix,
    M_align,
    slots,
    involvedMatrix,
    uninvolvedSideMatrix,
    d1BySlot,
    d2BySlot,
    yTopBound,
    yBottomBound,
  } = args;
  const slotCount = yMatrix.length;
  const columnCount = yMatrix[0]?.length || 0;

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    let chainStart = 0;

    while (chainStart < slotCount) {
      let chainEnd = chainStart;
      while (chainEnd + 1 < slotCount && M_align[chainEnd + 1][columnIndex] === 1) {
        chainEnd += 1;
      }

      if (chainEnd > chainStart) {
        let low = Number.NEGATIVE_INFINITY;
        let high = Number.POSITIVE_INFINITY;
        let sum = 0;
        let count = 0;
        for (let slotIndex = chainStart; slotIndex <= chainEnd; slotIndex += 1) {
          const range = allowedYInterval(
            slots[slotIndex],
            involvedMatrix[slotIndex][columnIndex],
            uninvolvedSideMatrix[slotIndex][columnIndex],
            d1BySlot[slotIndex],
            d2BySlot[slotIndex],
            yTopBound,
            yBottomBound
          );
          low = Math.max(low, range.low);
          high = Math.min(high, range.high);
          sum += yMatrix[slotIndex][columnIndex];
          count += 1;
        }

        if (low <= high) {
          const value = clamp(sum / Math.max(1, count), low, high);
          for (let slotIndex = chainStart; slotIndex <= chainEnd; slotIndex += 1) {
            yMatrix[slotIndex][columnIndex] = value;
          }
        } else {
          for (let slotIndex = chainStart + 1; slotIndex <= chainEnd; slotIndex += 1) {
            M_align[slotIndex][columnIndex] = 0;
          }
        }
      }

      chainStart = chainEnd + 1;
    }
  }
}

function effectiveGapsForSlot(args: {
  involvedFlags: boolean[];
  slot: StorylineSlotGeometry;
  yTopBound: number;
  yBottomBound: number;
  profile: StorylineAdaptiveProfile;
}): { d1: number; d2: number } {
  const { involvedFlags, slot, yTopBound, yBottomBound, profile } = args;
  const columnCount = involvedFlags.length;
  const involvedCount = involvedFlags.filter(Boolean).length;
  const uninvolvedCount = Math.max(0, columnCount - involvedCount);
  const density = involvedCount / Math.max(1, columnCount);

  const d1MinBound = STORYLINE_SOLVER_D1_MIN_PX * profile.d1Scale;
  const d1MaxBound = STORYLINE_SOLVER_D1_MAX_PX * profile.d1Scale;
  const d2MinBound = STORYLINE_SOLVER_D2_MIN_PX * profile.d2Scale;
  const d2MaxBound = STORYLINE_SOLVER_D2_MAX_PX * profile.d2Scale;
  const d1HardFloor = D1_HARD_FLOOR_PX * profile.d1Scale;

  const totalSpan = Math.max(1, yBottomBound - yTopBound);
  const globalGapCeiling = columnCount > 1 ? totalSpan / (columnCount - 1) : d1MaxBound;
  const connectSpan = Math.max(0, slot.connectBottomY - slot.connectTopY);
  const involvedGapCeiling = involvedCount > 1
    ? connectSpan / (involvedCount - 1)
    : Number.POSITIVE_INFINITY;
  const d1Ceiling = Math.max(
    1.25,
    Math.min(d1MaxBound, globalGapCeiling, involvedGapCeiling)
  );
  const d1Floor = Math.min(Math.max(d1MinBound, d1HardFloor), d1Ceiling);
  const d1Base =
    d1MinBound * 1.12 +
    1.42 * profile.adaptive +
    involvedCount * 0.36 +
    density * 2.32;
  const d1 = clamp(d1Base, d1Floor, d1Ceiling);

  const d2Floor = Math.max(d1 + 0.5, Math.min(d2MinBound, d2MaxBound));
  const d2Ceiling = Math.max(d2Floor, Math.min(d2MaxBound, totalSpan));
  const d2Base =
    d2MaxBound * 1.08 -
    involvedCount * 0.34 -
    density * 2.56 -
    Math.max(0, uninvolvedCount - 1) * 0.12;
  const d2 = clamp(d2Base, d2Floor, d2Ceiling);

  return { d1, d2 };
}

export function buildUninvolvedSideMatrix(
  orderBySlot: number[][],
  involvedMatrix: boolean[][]
): Array<Array<UninvolvedSide | null>> {
  const slotCount = orderBySlot.length;
  if (slotCount === 0) return [];
  const columnCount = orderBySlot[0]?.length || 0;
  const sideMatrix = Array.from({ length: slotCount }, () =>
    new Array<UninvolvedSide | null>(columnCount).fill(null)
  );

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const order = orderBySlot[slotIndex];
    const involvedFlags = involvedMatrix[slotIndex];
    const involvedRanks = order
      .map((columnIndex, rank) => (involvedFlags[columnIndex] ? rank : -1))
      .filter((rank) => rank >= 0);

    const hasInvolved = involvedRanks.length > 0;
    const minInvolvedRank = hasInvolved
      ? Math.min(...involvedRanks)
      : Number.POSITIVE_INFINITY;
    const maxInvolvedRank = hasInvolved
      ? Math.max(...involvedRanks)
      : Number.NEGATIVE_INFINITY;
    const midpoint = (order.length - 1) / 2;

    for (let rank = 0; rank < order.length; rank += 1) {
      const columnIndex = order[rank];
      if (involvedFlags[columnIndex]) continue;

      if (!hasInvolved) {
        sideMatrix[slotIndex][columnIndex] = rank <= midpoint ? 'above' : 'below';
      } else if (rank < minInvolvedRank) {
        sideMatrix[slotIndex][columnIndex] = 'above';
      } else if (rank > maxInvolvedRank) {
        sideMatrix[slotIndex][columnIndex] = 'below';
      } else {
        sideMatrix[slotIndex][columnIndex] = rank <= (minInvolvedRank + maxInvolvedRank) / 2
          ? 'above'
          : 'below';
      }
    }
  }

  return sideMatrix;
}

export function buildAlignmentMatrix(args: {
  orderMatrix: number[][];
  involvedMatrix: boolean[][];
  uninvolvedSideMatrix: Array<Array<UninvolvedSide | null>>;
  slots: StorylineSlotGeometry[];
  d1BySlot: number[];
  d2BySlot: number[];
  yTopBound: number;
  yBottomBound: number;
}): number[][] {
  const {
    orderMatrix,
    involvedMatrix,
    uninvolvedSideMatrix,
    slots,
    d1BySlot,
    d2BySlot,
    yTopBound,
    yBottomBound,
  } = args;
  const slotCount = orderMatrix.length;
  if (slotCount === 0) return [];

  const columnCount = orderMatrix[0]?.length || 0;
  const M_align = Array.from({ length: slotCount }, () =>
    new Array<number>(columnCount).fill(0)
  );

  const isFeasible = (slotIndex: number, columnIndex: number): boolean => {
    const orderDelta = Math.abs(
      orderMatrix[slotIndex][columnIndex] - orderMatrix[slotIndex - 1][columnIndex]
    );
    if (orderDelta > STORYLINE_SOLVER_ALIGN_ORDER_DELTA) return false;

    const prevRange = allowedYInterval(
      slots[slotIndex - 1],
      involvedMatrix[slotIndex - 1][columnIndex],
      uninvolvedSideMatrix[slotIndex - 1][columnIndex],
      d1BySlot[slotIndex - 1],
      d2BySlot[slotIndex - 1],
      yTopBound,
      yBottomBound
    );
    const currRange = allowedYInterval(
      slots[slotIndex],
      involvedMatrix[slotIndex][columnIndex],
      uninvolvedSideMatrix[slotIndex][columnIndex],
      d1BySlot[slotIndex],
      d2BySlot[slotIndex],
      yTopBound,
      yBottomBound
    );
    return Math.max(prevRange.low, currRange.low) <= Math.min(prevRange.high, currRange.high) + 1e-9;
  };

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const dp0 = new Array<number>(slotCount).fill(Number.NEGATIVE_INFINITY);
    const dp1 = new Array<number>(slotCount).fill(Number.NEGATIVE_INFINITY);
    const prev0 = new Array<number>(slotCount).fill(0);
    const prev1 = new Array<number>(slotCount).fill(0);

    dp1[0] = 0;

    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      const orderDelta = Math.abs(
        orderMatrix[slotIndex][columnIndex] - orderMatrix[slotIndex - 1][columnIndex]
      );
      const involvedSwitch =
        involvedMatrix[slotIndex][columnIndex] !== involvedMatrix[slotIndex - 1][columnIndex]
          ? 1
          : 0;
      const feasibleAlign = isFeasible(slotIndex, columnIndex);

      for (let prevState = 0; prevState <= 1; prevState += 1) {
        const prevScore = prevState === 1 ? dp1[slotIndex - 1] : dp0[slotIndex - 1];
        if (!Number.isFinite(prevScore)) continue;

        const bendPenalty = 0.02 + (prevState === 1 ? 0.02 : 0);
        const stay0 = prevScore - bendPenalty;
        if (stay0 > dp0[slotIndex]) {
          dp0[slotIndex] = stay0;
          prev0[slotIndex] = prevState;
        }

        if (!feasibleAlign) continue;
        const alignReward = 1 - 0.12 * orderDelta - 0.15 * involvedSwitch;
        const switchPenalty = prevState === 1 ? 0 : 0.04;
        const stay1 = prevScore + alignReward - switchPenalty;
        if (stay1 > dp1[slotIndex]) {
          dp1[slotIndex] = stay1;
          prev1[slotIndex] = prevState;
        }
      }
    }

    let state = dp1[slotCount - 1] >= dp0[slotCount - 1] ? 1 : 0;
    for (let slotIndex = slotCount - 1; slotIndex >= 0; slotIndex -= 1) {
      M_align[slotIndex][columnIndex] = state;
      state = state === 1 ? prev1[slotIndex] : prev0[slotIndex];
    }
    M_align[0][columnIndex] = 1;

    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      if (M_align[slotIndex][columnIndex] !== 1) continue;
      if (!isFeasible(slotIndex, columnIndex)) {
        M_align[slotIndex][columnIndex] = 0;
      }
    }

    let initialRange = allowedYInterval(
      slots[0],
      involvedMatrix[0][columnIndex],
      uninvolvedSideMatrix[0][columnIndex],
      d1BySlot[0],
      d2BySlot[0],
      yTopBound,
      yBottomBound
    );
    let chainLow = initialRange.low;
    let chainHigh = initialRange.high;
    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      if (M_align[slotIndex][columnIndex] !== 1) {
        initialRange = allowedYInterval(
          slots[slotIndex],
          involvedMatrix[slotIndex][columnIndex],
          uninvolvedSideMatrix[slotIndex][columnIndex],
          d1BySlot[slotIndex],
          d2BySlot[slotIndex],
          yTopBound,
          yBottomBound
        );
        chainLow = initialRange.low;
        chainHigh = initialRange.high;
        continue;
      }

      const current = allowedYInterval(
        slots[slotIndex],
        involvedMatrix[slotIndex][columnIndex],
        uninvolvedSideMatrix[slotIndex][columnIndex],
        d1BySlot[slotIndex],
        d2BySlot[slotIndex],
        yTopBound,
        yBottomBound
      );
      const nextLow = Math.max(chainLow, current.low);
      const nextHigh = Math.min(chainHigh, current.high);
      if (nextLow > nextHigh) {
        M_align[slotIndex][columnIndex] = 0;
        chainLow = current.low;
        chainHigh = current.high;
      } else {
        chainLow = nextLow;
        chainHigh = nextHigh;
      }
    }
  }

  return M_align;
}

export function computeSlotGapArrays(args: {
  slots: StorylineSlotGeometry[];
  involvedMatrix: boolean[][];
  yTopBound: number;
  yBottomBound: number;
  profile: StorylineAdaptiveProfile;
}): { d1BySlot: number[]; d2BySlot: number[] } {
  const { slots, involvedMatrix, yTopBound, yBottomBound, profile } = args;
  const d1BySlot: number[] = [];
  const d2BySlot: number[] = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const gaps = effectiveGapsForSlot({
      involvedFlags: involvedMatrix[slotIndex],
      slot: slots[slotIndex],
      yTopBound,
      yBottomBound,
      profile,
    });
    d1BySlot.push(gaps.d1);
    d2BySlot.push(gaps.d2);
  }
  return { d1BySlot, d2BySlot };
}

export function solveYByProjectedLeastSquares(args: {
  slots: StorylineSlotGeometry[];
  orderBySlot: number[][];
  M_align: number[][];
  involvedMatrix: boolean[][];
  uninvolvedSideMatrix: Array<Array<UninvolvedSide | null>>;
  d1BySlot: number[];
  d2BySlot: number[];
  yTopBound: number;
  yBottomBound: number;
  targetYOverridesBySlotIndex?: Map<number, Map<number, number>>;
}): { yMatrix: number[][]; d1BySlot: number[]; d2BySlot: number[] } {
  const {
    slots,
    orderBySlot,
    M_align,
    involvedMatrix,
    uninvolvedSideMatrix,
    d1BySlot: inputD1BySlot,
    d2BySlot: inputD2BySlot,
    yTopBound,
    yBottomBound,
    targetYOverridesBySlotIndex,
  } = args;
  const slotCount = slots.length;
  const columnCount = orderBySlot[0]?.length || 0;
  if (slotCount === 0 || columnCount === 0) {
    return { yMatrix: [], d1BySlot: [], d2BySlot: [] };
  }

  const d1BySlot = [...inputD1BySlot];
  const d2BySlot = [...inputD2BySlot];
  const targetMatrix = Array.from({ length: slotCount }, () =>
    new Array<number>(columnCount).fill(0)
  );
  const yMatrix = Array.from({ length: slotCount }, () =>
    new Array<number>(columnCount).fill(0)
  );
  const lockedRowBySlotIndex = new Map<number, number[]>();

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    targetMatrix[slotIndex] = buildSlotTargetRow({
      columnCount,
      order: orderBySlot[slotIndex],
      involvedFlags: involvedMatrix[slotIndex],
      uninvolvedSides: uninvolvedSideMatrix[slotIndex],
      slot: slots[slotIndex],
      yTopBound,
      yBottomBound,
      d1: d1BySlot[slotIndex],
      d2: d2BySlot[slotIndex],
    });
    const targetOverrides = targetYOverridesBySlotIndex?.get(slotIndex);
    if (targetOverrides) {
      for (const [columnIndex, targetY] of targetOverrides.entries()) {
        if (columnIndex < 0 || columnIndex >= columnCount || !Number.isFinite(targetY)) continue;
        targetMatrix[slotIndex][columnIndex] = targetY;
      }
    }

    yMatrix[slotIndex] = projectSlotRowWithConstraints({
      row: targetMatrix[slotIndex],
      order: orderBySlot[slotIndex],
      involvedFlags: involvedMatrix[slotIndex],
      uninvolvedSides: uninvolvedSideMatrix[slotIndex],
      slot: slots[slotIndex],
      yTopBound,
      yBottomBound,
      d1: d1BySlot[slotIndex],
      d2: d2BySlot[slotIndex],
    });
    if (targetYOverridesBySlotIndex?.has(slotIndex)) {
      lockedRowBySlotIndex.set(slotIndex, [...yMatrix[slotIndex]]);
    }
  }

  const restoreLockedRows = () => {
    for (const [slotIndex, lockedRow] of lockedRowBySlotIndex.entries()) {
      yMatrix[slotIndex] = [...lockedRow];
    }
  };

  for (let iter = 0; iter < STORYLINE_SOLVER_OPT_ITERS; iter += 1) {
    const gradient = Array.from({ length: slotCount }, () =>
      new Array<number>(columnCount).fill(0)
    );

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const order = orderBySlot[slotIndex];
      const involvedFlags = involvedMatrix[slotIndex];

      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const residual = yMatrix[slotIndex][columnIndex] - targetMatrix[slotIndex][columnIndex];
        gradient[slotIndex][columnIndex] += 2 * 0.72 * residual;
      }

      for (let rank = 1; rank < order.length; rank += 1) {
        const prevColumn = order[rank - 1];
        const column = order[rank];
        const bothUninvolved = !involvedFlags[prevColumn] && !involvedFlags[column];
        const desiredGap = bothUninvolved
          ? (d1BySlot[slotIndex] + d2BySlot[slotIndex]) / 2
          : d1BySlot[slotIndex];
        const weight = bothUninvolved ? 0.48 : 0.92;
        const residual =
          yMatrix[slotIndex][column] - yMatrix[slotIndex][prevColumn] - desiredGap;
        gradient[slotIndex][column] += 2 * weight * residual;
        gradient[slotIndex][prevColumn] -= 2 * weight * residual;
      }
    }

    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const diff = yMatrix[slotIndex][columnIndex] - yMatrix[slotIndex - 1][columnIndex];
        const alignWeight = M_align[slotIndex][columnIndex] === 1 ? 2.2 : 0.38;
        gradient[slotIndex][columnIndex] += 2 * alignWeight * diff;
        gradient[slotIndex - 1][columnIndex] -= 2 * alignWeight * diff;
      }
    }

    let maxDelta = 0;
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      if (lockedRowBySlotIndex.has(slotIndex)) continue;
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const delta = STORYLINE_SOLVER_OPT_STEP * gradient[slotIndex][columnIndex];
        yMatrix[slotIndex][columnIndex] -= delta;
        maxDelta = Math.max(maxDelta, Math.abs(delta));
      }
    }

    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      if (lockedRowBySlotIndex.has(slotIndex)) {
        yMatrix[slotIndex] = [...lockedRowBySlotIndex.get(slotIndex)!];
        continue;
      }
      yMatrix[slotIndex] = projectSlotRowWithConstraints({
        row: yMatrix[slotIndex],
        order: orderBySlot[slotIndex],
        involvedFlags: involvedMatrix[slotIndex],
        uninvolvedSides: uninvolvedSideMatrix[slotIndex],
        slot: slots[slotIndex],
        yTopBound,
        yBottomBound,
        d1: d1BySlot[slotIndex],
        d2: d2BySlot[slotIndex],
      });
    }

    enforceExactAlignment({
      yMatrix,
      M_align,
      slots,
      involvedMatrix,
      uninvolvedSideMatrix,
      d1BySlot,
      d2BySlot,
      yTopBound,
      yBottomBound,
    });
    restoreLockedRows();

    if (maxDelta < 0.015) break;
  }

  for (let pass = 0; pass < 5; pass += 1) {
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      if (lockedRowBySlotIndex.has(slotIndex)) {
        yMatrix[slotIndex] = [...lockedRowBySlotIndex.get(slotIndex)!];
        continue;
      }
      yMatrix[slotIndex] = projectSlotRowWithConstraints({
        row: yMatrix[slotIndex],
        order: orderBySlot[slotIndex],
        involvedFlags: involvedMatrix[slotIndex],
        uninvolvedSides: uninvolvedSideMatrix[slotIndex],
        slot: slots[slotIndex],
        yTopBound,
        yBottomBound,
        d1: d1BySlot[slotIndex],
        d2: d2BySlot[slotIndex],
      });
    }

    enforceExactAlignment({
      yMatrix,
      M_align,
      slots,
      involvedMatrix,
      uninvolvedSideMatrix,
      d1BySlot,
      d2BySlot,
      yTopBound,
      yBottomBound,
    });
    restoreLockedRows();
  }

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    if (lockedRowBySlotIndex.has(slotIndex)) {
      yMatrix[slotIndex] = [...lockedRowBySlotIndex.get(slotIndex)!];
      continue;
    }
    yMatrix[slotIndex] = projectSlotRowWithConstraints({
      row: yMatrix[slotIndex],
      order: orderBySlot[slotIndex],
      involvedFlags: involvedMatrix[slotIndex],
      uninvolvedSides: uninvolvedSideMatrix[slotIndex],
      slot: slots[slotIndex],
      yTopBound,
      yBottomBound,
      d1: d1BySlot[slotIndex],
      d2: d2BySlot[slotIndex],
    });
  }
  restoreLockedRows();

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    M_align[0][columnIndex] = 1;
    for (let slotIndex = 1; slotIndex < slotCount; slotIndex += 1) {
      if (M_align[slotIndex][columnIndex] !== 1) continue;
      const delta = Math.abs(
        yMatrix[slotIndex][columnIndex] - yMatrix[slotIndex - 1][columnIndex]
      );
      if (delta > 1e-6) M_align[slotIndex][columnIndex] = 0;
    }
  }

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const order = orderBySlot[slotIndex];
    const involvedFlags = involvedMatrix[slotIndex];
    let requiredD2 = d2BySlot[slotIndex];
    for (let rank = 1; rank < order.length; rank += 1) {
      const prevColumn = order[rank - 1];
      const column = order[rank];
      if (!isUninvolvedPair(involvedFlags, prevColumn, column)) continue;
      requiredD2 = Math.max(
        requiredD2,
        yMatrix[slotIndex][column] - yMatrix[slotIndex][prevColumn]
      );
    }
    d2BySlot[slotIndex] = requiredD2;
  }

  return { yMatrix, d1BySlot, d2BySlot };
}
