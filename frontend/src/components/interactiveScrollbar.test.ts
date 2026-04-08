import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeInteractiveScrollbarMetrics,
  resolveThumbOffsetFromTrackPointer,
  resolveScrollOffsetFromThumbOffset,
} from './interactiveScrollbar';

test('computeInteractiveScrollbarMetrics hides the thumb when content does not overflow', () => {
  const metrics = computeInteractiveScrollbarMetrics({
    viewportSizePx: 320,
    contentSizePx: 320,
    scrollOffsetPx: 0,
    trackSizePx: 280,
  });

  assert.equal(metrics.visible, false);
  assert.equal(metrics.thumbSizePx, 280);
  assert.equal(metrics.thumbOffsetPx, 0);
  assert.equal(metrics.maxThumbOffsetPx, 0);
  assert.equal(metrics.maxScrollOffsetPx, 0);
});

test('computeInteractiveScrollbarMetrics derives thumb size and offset from scroll position', () => {
  const metrics = computeInteractiveScrollbarMetrics({
    viewportSizePx: 300,
    contentSizePx: 1200,
    scrollOffsetPx: 450,
    trackSizePx: 240,
    minThumbSizePx: 24,
  });

  assert.equal(metrics.visible, true);
  assert.ok(Math.abs(metrics.thumbSizePx - 60) < 0.01);
  assert.ok(Math.abs(metrics.maxThumbOffsetPx - 180) < 0.01);
  assert.ok(Math.abs(metrics.thumbOffsetPx - 90) < 0.01);
  assert.ok(Math.abs(metrics.maxScrollOffsetPx - 900) < 0.01);
});

test('resolveScrollOffsetFromThumbOffset maps thumb offset back to content offset', () => {
  const scrollOffset = resolveScrollOffsetFromThumbOffset({
    thumbOffsetPx: 45,
    maxThumbOffsetPx: 180,
    maxScrollOffsetPx: 900,
  });

  assert.ok(Math.abs(scrollOffset - 225) < 0.01);
  assert.equal(
    resolveScrollOffsetFromThumbOffset({
      thumbOffsetPx: -20,
      maxThumbOffsetPx: 180,
      maxScrollOffsetPx: 900,
    }),
    0
  );
});

test('resolveThumbOffsetFromTrackPointer centers quick-jump around the click position', () => {
  assert.equal(
    resolveThumbOffsetFromTrackPointer({
      pointerOffsetPx: 120,
      thumbSizePx: 40,
      maxThumbOffsetPx: 180,
    }),
    100
  );
  assert.equal(
    resolveThumbOffsetFromTrackPointer({
      pointerOffsetPx: 4,
      thumbSizePx: 40,
      maxThumbOffsetPx: 180,
    }),
    0
  );
});
