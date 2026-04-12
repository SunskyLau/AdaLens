import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  resolveActiveSteeringPenAfterSuccessfulSubmit,
  resolveSelectionAfterConvergeSummaryButtonClick,
  StorylinePenToolbar,
  togglePendingColumnPenSelection,
} from './StorylineGraph.tsx';

test('togglePendingColumnPenSelection starts a staged column set on first click', () => {
  assert.deepEqual(
    togglePendingColumnPenSelection({
      current: null,
      penKind: 'focus',
      column: 'Revenue',
      x: 120,
      y: 80,
    }),
    {
      kind: 'focus',
      columns: ['Revenue'],
      columnAnchors: [],
      x: 120,
      y: 80,
    }
  );
});

test('togglePendingColumnPenSelection preserves click order and toggles columns off when clicked again', () => {
  const first = togglePendingColumnPenSelection({
    current: null,
    penKind: 'ignore',
    column: 'Revenue',
    x: 120,
    y: 80,
  });
  const second = togglePendingColumnPenSelection({
    current: first,
    penKind: 'ignore',
    column: 'Region',
    x: 180,
    y: 90,
  });
  const third = togglePendingColumnPenSelection({
    current: second,
    penKind: 'ignore',
    column: 'Revenue',
    x: 200,
    y: 100,
  });
  const fourth = togglePendingColumnPenSelection({
    current: third,
    penKind: 'ignore',
    column: 'Region',
    x: 220,
    y: 110,
  });

  assert.deepEqual(second, {
    kind: 'ignore',
    columns: ['Revenue', 'Region'],
    columnAnchors: [],
    x: 120,
    y: 80,
  });
  assert.deepEqual(third, {
    kind: 'ignore',
    columns: ['Region'],
    columnAnchors: [],
    x: 120,
    y: 80,
  });
  assert.equal(fourth, null);
});

test('togglePendingColumnPenSelection resets the staged set when the steering pen changes', () => {
  const current = {
    kind: 'focus' as const,
    columns: ['Revenue', 'Region'],
    columnAnchors: [],
    x: 120,
    y: 80,
  };

  assert.deepEqual(
    togglePendingColumnPenSelection({
      current,
      penKind: 'ignore',
      column: 'Quarter',
      x: 200,
      y: 140,
    }),
    {
      kind: 'ignore',
      columns: ['Quarter'],
      columnAnchors: [],
      x: 200,
      y: 140,
    }
  );
});

test('togglePendingColumnPenSelection keeps per-column converge anchors for staged column steering', () => {
  const first = togglePendingColumnPenSelection({
    current: null,
    penKind: 'focus',
    column: 'Revenue',
    convergeIndex: 1,
    x: 120,
    y: 80,
  });
  const second = togglePendingColumnPenSelection({
    current: first,
    penKind: 'focus',
    column: 'Region',
    convergeIndex: 3,
    x: 180,
    y: 90,
  });

  assert.deepEqual(second, {
    kind: 'focus',
    columns: ['Revenue', 'Region'],
    columnAnchors: [
      { column: 'Revenue', converge_index: 1 },
      { column: 'Region', converge_index: 3 },
    ],
    x: 120,
    y: 80,
  });
});

test('resolveActiveSteeringPenAfterSuccessfulSubmit clears the active pen after a confirmed submit', () => {
  assert.equal(resolveActiveSteeringPenAfterSuccessfulSubmit('focus'), null);
  assert.equal(resolveActiveSteeringPenAfterSuccessfulSubmit('ignore'), null);
  assert.equal(resolveActiveSteeringPenAfterSuccessfulSubmit('elaborate'), null);
  assert.equal(resolveActiveSteeringPenAfterSuccessfulSubmit(null), null);
});

test('resolveSelectionAfterConvergeSummaryButtonClick clears any current storyline selection', () => {
  assert.deepEqual(resolveSelectionAfterConvergeSummaryButtonClick(), { type: null, id: null });
});

test('StorylinePenToolbar keeps all pen buttons the same compact width in a label-free top-rail card', () => {
  const html = renderToStaticMarkup(
    createElement(StorylinePenToolbar, {
      activeSteeringPen: null,
      pendingColumnPenSelection: null,
      steeringActionError: null,
      topPx: 8,
      heightPx: 52,
      onTogglePen: () => undefined,
    })
  );

  assert.match(
    html,
    /data-storyline-pen="focus"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-pen="ignore"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-pen="elaborate"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-top-rail-card="pens"/
  );
  assert.match(
    html,
    /data-storyline-pen-toolbar="true"[^>]*style="top:8px;min-height:52px"/
  );
  assert.match(
    html,
    /data-storyline-pen="focus"[\s\S]*?<div class="grid w-full grid-cols-\[1fr_auto_1fr\] items-center gap-1">/
  );
  assert.match(
    html,
    /data-storyline-pen-toolbar="true"[^>]*class="[^"]*absolute[^"]*inline-flex[^"]*items-center/
  );
  assert.doesNotMatch(
    html,
    /Storyline Pens/
  );
  assert.match(
    html,
    /data-storyline-pen-toolbar="true"[\s\S]*?<div class="flex flex-wrap items-center gap-1">/
  );
});

test('StorylinePenToolbar inline renders only compact pen buttons without the toolbar shell', () => {
  const html = renderToStaticMarkup(
    createElement(StorylinePenToolbar, {
      placement: 'inline',
      activeSteeringPen: null,
      pendingColumnPenSelection: null,
      steeringActionError: null,
      onTogglePen: () => undefined,
    })
  );

  assert.match(
    html,
    /data-storyline-pen="focus"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-pen="ignore"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-pen="elaborate"[^>]*style="width:96px"/
  );
  assert.doesNotMatch(
    html,
    /data-storyline-top-rail-card="pens"/
  );
  assert.doesNotMatch(
    html,
    /data-storyline-pen-toolbar="true"/
  );
});

test('StorylinePenToolbar keeps pending multi-column counts separate from the centered label lane', () => {
  const html = renderToStaticMarkup(
    createElement(StorylinePenToolbar, {
      activeSteeringPen: 'focus',
      pendingColumnPenSelection: {
        kind: 'focus',
        columns: ['Revenue', 'Region', 'Quarter', 'Channel', 'Segment', 'Country', 'Category', 'Year', 'Month'],
        columnAnchors: [],
        x: 120,
        y: 80,
      },
      steeringActionError: null,
      topPx: 8,
      heightPx: 52,
      onTogglePen: () => undefined,
    })
  );

  assert.match(
    html,
    /data-storyline-pen="focus"[^>]*style="width:96px"/
  );
  assert.match(
    html,
    /data-storyline-pen="focus"[\s\S]*?grid w-full grid-cols-\[1fr_auto_1fr\] items-center gap-1[\s\S]*?>9<\/span>/
  );
  assert.match(
    html,
    /data-storyline-pen="focus"[\s\S]*?inline-flex items-center justify-center gap-1 text-\[12px\] font-semibold leading-none/
  );
  assert.match(
    html,
    /data-storyline-pen="focus"[\s\S]*?rounded-full bg-white\/80 px-1\.5 py-px text-\[9px\] font-semibold leading-none text-slate-700/
  );
});
