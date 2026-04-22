export type StorylineTrackSegmentKind =
  | 'slot_horizontal'
  | 'interspace_cubic'
  | 'extension_solid'
  | 'extension_dashed';

export type StorylineTrackSegmentTone = 'involved' | 'uninvolved';

export interface StorylineTrackSegment {
  id: string;
  kind: StorylineTrackSegmentKind;
  tone: StorylineTrackSegmentTone;
  path: string;
  dashed: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  c1X?: number;
  c1Y?: number;
  c2X?: number;
  c2Y?: number;
  slotIndex?: number;
  interspaceIndex?: number;
}

export interface SlotTrackGeometry {
  slotIndex: number;
  left: number;
  right: number;
  nodeLeft: number;
  nodeRight: number;
  y: number;
  involved: boolean;
}

export interface InterspaceTrackGeometry {
  interspaceIndex: number;
  left: number;
  right: number;
  fromY: number;
  toY: number;
  aligned: boolean;
}

export interface BuildTrackSegmentsInput {
  column: string;
  slots: SlotTrackGeometry[];
  interspaces: InterspaceTrackGeometry[];
  extensionLength: number;
}

const BEZIER_TENSION = 0.38;

function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

function cubicPath(
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number
): string {
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

function buildInterspaceSegment(
  column: string,
  interspace: InterspaceTrackGeometry,
  fromX: number,
  toX: number,
  tone: StorylineTrackSegmentTone
): StorylineTrackSegment {
  const span = Math.max(0, toX - fromX);
  const controlOffset = Math.max(6, span * BEZIER_TENSION);
  const targetY = interspace.aligned ? interspace.fromY : interspace.toY;
  const c1X = Math.min(toX, fromX + controlOffset);
  const c2X = Math.max(fromX, toX - controlOffset);
  const c1Y = interspace.fromY;
  const c2Y = targetY;
  return {
    id: `${column}:interspace:${interspace.interspaceIndex}`,
    kind: 'interspace_cubic',
    tone,
    path: cubicPath(fromX, interspace.fromY, c1X, c1Y, c2X, c2Y, toX, targetY),
    dashed: false,
    startX: fromX,
    startY: interspace.fromY,
    endX: toX,
    endY: targetY,
    c1X,
    c1Y,
    c2X,
    c2Y,
    interspaceIndex: interspace.interspaceIndex,
  };
}

export function buildTrackSegments(input: BuildTrackSegmentsInput): StorylineTrackSegment[] {
  const { column, slots, interspaces, extensionLength } = input;
  if (slots.length === 0) return [];

  const segments: StorylineTrackSegment[] = [];
  const firstSlot = slots[0];
  const lastSlot = slots[slots.length - 1];
  const leftExtensionTone: StorylineTrackSegmentTone = firstSlot.involved ? 'involved' : 'uninvolved';
  const rightExtensionTone: StorylineTrackSegmentTone = lastSlot.involved ? 'involved' : 'uninvolved';

  const leftDashedStartX = firstSlot.left - extensionLength * 2;
  const leftDashedEndX = firstSlot.left - extensionLength;
  segments.push({
    id: `${column}:ext:left:dashed`,
    kind: 'extension_dashed',
    tone: leftExtensionTone,
    path: linePath(leftDashedStartX, firstSlot.y, leftDashedEndX, firstSlot.y),
    dashed: true,
    startX: leftDashedStartX,
    startY: firstSlot.y,
    endX: leftDashedEndX,
    endY: firstSlot.y,
  });
  segments.push({
    id: `${column}:ext:left:solid`,
    kind: 'extension_solid',
    tone: leftExtensionTone,
    path: linePath(leftDashedEndX, firstSlot.y, firstSlot.left, firstSlot.y),
    dashed: false,
    startX: leftDashedEndX,
    startY: firstSlot.y,
    endX: firstSlot.left,
    endY: firstSlot.y,
  });

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const slot = slots[slotIndex];
    if (slot.involved) {
      segments.push({
        id: `${column}:slot:${slot.slotIndex}:left`,
        kind: 'slot_horizontal',
        tone: 'involved',
        path: linePath(slot.left, slot.y, slot.nodeLeft, slot.y),
        dashed: false,
        startX: slot.left,
        startY: slot.y,
        endX: slot.nodeLeft,
        endY: slot.y,
        slotIndex: slot.slotIndex,
      });
      segments.push({
        id: `${column}:slot:${slot.slotIndex}:right`,
        kind: 'slot_horizontal',
        tone: 'involved',
        path: linePath(slot.nodeRight, slot.y, slot.right, slot.y),
        dashed: false,
        startX: slot.nodeRight,
        startY: slot.y,
        endX: slot.right,
        endY: slot.y,
        slotIndex: slot.slotIndex,
      });
    } else {
      segments.push({
        id: `${column}:slot:${slot.slotIndex}:full`,
        kind: 'slot_horizontal',
        tone: 'uninvolved',
        path: linePath(slot.left, slot.y, slot.right, slot.y),
        dashed: false,
        startX: slot.left,
        startY: slot.y,
        endX: slot.right,
        endY: slot.y,
        slotIndex: slot.slotIndex,
      });
    }

    const interspace = interspaces[slotIndex];
    if (!interspace) continue;
    const nextSlot = slots[slotIndex + 1];
    const interspaceTone: StorylineTrackSegmentTone =
      slot.involved && nextSlot?.involved ? 'involved' : 'uninvolved';
    segments.push(buildInterspaceSegment(column, interspace, interspace.left, interspace.right, interspaceTone));
  }

  const rightSolidStartX = lastSlot.right;
  const rightSolidEndX = rightSolidStartX + extensionLength;
  const rightDashedEndX = rightSolidEndX + extensionLength;

  segments.push({
    id: `${column}:ext:right:solid`,
    kind: 'extension_solid',
    tone: rightExtensionTone,
    path: linePath(rightSolidStartX, lastSlot.y, rightSolidEndX, lastSlot.y),
    dashed: false,
    startX: rightSolidStartX,
    startY: lastSlot.y,
    endX: rightSolidEndX,
    endY: lastSlot.y,
  });
  segments.push({
    id: `${column}:ext:right:dashed`,
    kind: 'extension_dashed',
    tone: rightExtensionTone,
    path: linePath(rightSolidEndX, lastSlot.y, rightDashedEndX, lastSlot.y),
    dashed: true,
    startX: rightSolidEndX,
    startY: lastSlot.y,
    endX: rightDashedEndX,
    endY: lastSlot.y,
  });

  return segments;
}

export function countOrderCrossings(previousOrder: number[], nextOrder: number[]): number {
  if (previousOrder.length !== nextOrder.length) return 0;
  if (previousOrder.length <= 1) return 0;

  const nextRank = new Map<number, number>();
  for (let index = 0; index < nextOrder.length; index += 1) {
    nextRank.set(nextOrder[index], index);
  }

  const sequence: number[] = [];
  for (const value of previousOrder) {
    const rank = nextRank.get(value);
    if (typeof rank === 'number') sequence.push(rank);
  }

  let crossings = 0;
  for (let i = 0; i < sequence.length; i += 1) {
    for (let j = i + 1; j < sequence.length; j += 1) {
      if (sequence[i] > sequence[j]) crossings += 1;
    }
  }
  return crossings;
}
