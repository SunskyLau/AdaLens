import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrackSegments,
  countOrderCrossings,
  type InterspaceTrackGeometry,
  type SlotTrackGeometry,
} from './storylineThreadRouting';

function slot(partial: Partial<SlotTrackGeometry>): SlotTrackGeometry {
  return {
    slotIndex: partial.slotIndex ?? 0,
    left: partial.left ?? 20,
    right: partial.right ?? 80,
    nodeLeft: partial.nodeLeft ?? 40,
    nodeRight: partial.nodeRight ?? 60,
    y: partial.y ?? 120,
    involved: partial.involved ?? false,
  };
}

function interspace(partial: Partial<InterspaceTrackGeometry>): InterspaceTrackGeometry {
  return {
    interspaceIndex: partial.interspaceIndex ?? 0,
    left: partial.left ?? 80,
    right: partial.right ?? 120,
    fromY: partial.fromY ?? 120,
    toY: partial.toY ?? 140,
    aligned: partial.aligned ?? false,
  };
}

test('slot segments are horizontal and interspace segment is cubic bezier', () => {
  const segments = buildTrackSegments({
    column: 'A',
    slots: [
      slot({ slotIndex: 0, left: 20, right: 70, y: 110, involved: false }),
      slot({ slotIndex: 1, left: 120, right: 170, y: 132, involved: false }),
    ],
    interspaces: [
      interspace({ interspaceIndex: 0, left: 70, right: 120, fromY: 110, toY: 132, aligned: false }),
    ],
    extensionLength: 30,
  });

  const slotSegments = segments.filter((segment) => segment.kind === 'slot_horizontal');
  const interspaceSegments = segments.filter((segment) => segment.kind === 'interspace_cubic');
  assert.equal(slotSegments.length, 2);
  assert.equal(interspaceSegments.length, 1);
  for (const segment of slotSegments) {
    assert.ok(Math.abs(segment.startY - segment.endY) < 1e-9);
  }
  assert.ok(interspaceSegments[0].path.includes('C '));
  assert.ok(typeof interspaceSegments[0].c1X === 'number');
  assert.ok(typeof interspaceSegments[0].c2X === 'number');
});

test('involved slot splits into left and right route-box-connected horizontals', () => {
  const segments = buildTrackSegments({
    column: 'B',
    slots: [
      slot({ slotIndex: 0, left: 40, right: 120, nodeLeft: 70, nodeRight: 90, involved: true, y: 150 }),
    ],
    interspaces: [],
    extensionLength: 24,
  });

  const slotSegments = segments.filter((segment) => segment.kind === 'slot_horizontal');
  assert.equal(slotSegments.length, 2);
  assert.deepEqual(
    slotSegments.map((segment) => [segment.startX, segment.endX]).sort((a, b) => a[0] - b[0]),
    [
      [40, 70],
      [90, 120],
    ]
  );
});

test('aligned interspace keeps end y equal to start y (straight alignment)', () => {
  const segments = buildTrackSegments({
    column: 'C',
    slots: [
      slot({ slotIndex: 0, left: 10, right: 50, y: 100 }),
      slot({ slotIndex: 1, left: 90, right: 130, y: 100 }),
    ],
    interspaces: [
      interspace({ interspaceIndex: 0, left: 50, right: 90, fromY: 100, toY: 140, aligned: true }),
    ],
    extensionLength: 20,
  });

  const interspaceSegment = segments.find((segment) => segment.kind === 'interspace_cubic');
  assert.ok(interspaceSegment);
  assert.ok(Math.abs((interspaceSegment?.startY ?? 0) - (interspaceSegment?.endY ?? 1)) < 1e-9);
});

test('countOrderCrossings counts inversion pairs between adjacent slots', () => {
  const noCross = countOrderCrossings([0, 1, 2, 3], [0, 1, 2, 3]);
  const oneCross = countOrderCrossings([0, 1, 2, 3], [0, 2, 1, 3]);
  const manyCross = countOrderCrossings([0, 1, 2, 3], [3, 2, 1, 0]);
  assert.equal(noCross, 0);
  assert.equal(oneCross, 1);
  assert.equal(manyCross, 6);
});
