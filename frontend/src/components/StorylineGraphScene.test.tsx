import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import StorylineGraphScene from './StorylineGraphScene.tsx';
import { SELECTED_SUMMARY_STROKE_WIDTH_PX, SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER } from './storylineGraphSelection.ts';

function makeBaseProps() {
  return {
    containerRef: { current: null },
    svgRef: { current: null },
    plotClipId: 'storyline-test-clip',
    viewport: { width: 420, height: 320 },
    view: { zoomX: 1, tx: 0 },
    layout: {
      plotMinY: 0,
      plotMaxY: 160,
      plotMinX: 0,
      plotMaxX: 200,
      plotWidth: 200,
      plotHeight: 160,
      turns: [],
      converges: [],
      summaryAreas: [],
      activePlanAreas: [],
      turnBoundaries: [],
      nodes: [],
      boundaryBranches: [],
      adaptiveProfile: {
        labelScale: 1,
        trackStrokeScale: 1,
      },
    },
    plotTopOffset: 40,
    layoutVerticalOffset: 0,
    isDragging: false,
    isEmptyStoryline: false,
    activeSteeringPen: null,
    hoveredColumn: null,
    hoveredTrack: null,
    hoveredAtomicPreview: null,
    hoveredSummaryPreview: null,
    hoveredPlanPreview: null,
    taxonomyLegendItems: [],
    visibleTrackLabels: [],
    summaryInternalsRenderMode: 'none',
    storylineFilterSnapshot: {
      rowStates: new Map(),
      hasActiveFilter: false,
    },
    selectionHighlightPolicy: {
      preserveSummaryAreaSelection: true,
      preserveGlyphSelection: true,
    },
    selectedSummaryId: null,
    selectedPlanId: null,
    selectedAtomicNodeId: null,
    selectedGlyphColumnHighlightColor: null,
    selectedGlyphConnection: {
      segmentKeys: new Set(),
      reachLeftBoundaryColumns: new Set(),
      reachRightBoundaryColumns: new Set(),
    },
    selectedGlyphBranchHighlightIds: new Set(),
    selectedSummaryConnectivity: {
      summaryIds: new Set(),
      summaryColumnsById: new Map(),
      branchIds: new Set(),
      convergeLaneKeys: new Set(),
    },
    selectedSummarySharedColumnIds: new Set(),
    selectedSummaryExtensionPromotion: {
      branchIds: new Set(),
      convergeLaneKeys: new Set(),
    },
    selectedSummaryConnectivityActive: false,
    isStorylineFilterActive: false,
    convergeLaneModeByKey: new Map(),
    minimapState: {
      width: 180,
      height: 52,
      left: 120,
      top: 8,
      worldMinX: 0,
      worldMaxX: 200,
      worldSpanX: 200,
      worldLeft: 0,
      worldWidth: 200,
      focusX: 12,
      focusY: 8,
      focusWidth: 156,
      focusHeight: 36,
    },
    minimapInnerHeight: 36,
    minimapPoints: [
      {
        id: 's1::a1',
        kind: 'atomic',
        summaryId: 's1',
        planId: null,
        x: 40,
        y: 26,
        r: 4,
        color: '#2563eb',
        insightType: 'trend',
        pulse: false,
      },
      {
        id: 's2::a2',
        kind: 'atomic',
        summaryId: 's2',
        planId: null,
        x: 96,
        y: 26,
        r: 4,
        color: '#ef4444',
        insightType: 'value',
        pulse: false,
      },
    ],
    activePlanAreas: [],
    reorderablePlanIdSet: new Set(),
    draggedPlanId: null,
    planReorderDropTarget: null,
    isSubmittingPlanReorder: false,
    convergeSummaryButtons: [],
    highlightedSummaryEntryId: null,
    planControlPendingById: {},
    editingPlanId: null,
    editingPlanDraft: '',
    onCanvasMouseDown: () => undefined,
    onCanvasClick: () => undefined,
    onCanvasMouseLeave: () => undefined,
    onBackgroundContextMenu: () => undefined,
    onWheel: () => undefined,
    onSummarySelect: () => undefined,
    onAtomicSelect: () => undefined,
    onHoverSummaryTarget: () => undefined,
    onLeaveSummaryTarget: () => undefined,
    onActivePlanSelect: () => undefined,
    onHoverActivePlanArea: () => undefined,
    onLeaveActivePlanArea: () => undefined,
    onPlanControl: () => undefined,
    onPlanModifyStart: () => undefined,
    onPlanModifyDraftChange: () => undefined,
    onPlanModifyCancel: () => undefined,
    onPlanModifySubmit: () => undefined,
    onPlanAreaDragStart: () => undefined,
    onPlanAreaDragOver: () => undefined,
    onPlanAreaDrop: () => undefined,
    onPlanAreaDragEnd: () => undefined,
    onHoverAtomicGlyph: () => undefined,
    onLeaveAtomicGlyph: () => undefined,
    onColumnContextMenu: () => undefined,
    onLegendToggle: () => undefined,
    onColumnPointerDown: () => undefined,
    onColumnClick: () => undefined,
    onHoverColumn: () => undefined,
    onLeaveColumn: () => undefined,
    onMinimapBackgroundMouseDown: () => undefined,
    onMinimapFocusMouseDown: () => undefined,
    isNodeKeptByFilter: () => true,
    isSummaryKeptByFilter: () => true,
    isTrackSegmentKeptByFilter: () => true,
    isBranchKeptByFilter: () => true,
    isConvergeLaneKeptByFilter: () => true,
    getColumnFilterState: () => 'none',
    resolveConvergeColumnEmphasis: () => 'default',
    resolveSummaryColumnEmphasis: () => 'default',
    resolveConvergeLabelTextColor: () => '#111827',
    resolveConvergeLabelVisualState: () => null,
    usesInvolvedConvergeVisual: () => false,
    summarySteeringBadgeKinds: new Map(),
    atomicSteeringBadgeKinds: new Map(),
    columnSteeringBadgeKinds: new Map(),
    columnSteeringBadgeKindsByIndicatorId: new Map(),
    summarySteeringEntryIdsById: new Map(),
    atomicSteeringEntryIdsByKey: new Map(),
    columnSteeringEntryIdsByName: new Map(),
    columnSteeringEntryIdsByIndicatorId: new Map(),
    createOriginPlanIds: new Set(),
    createOriginSummaryIds: new Set(),
    onConversationEntryFocusRequest: () => undefined,
    onConvergeSummaryButtonClick: () => undefined,
  } as unknown as Parameters<typeof StorylineGraphScene>[0];
}

test('StorylineGraphScene no longer renders overview minimap points', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      selectedSummaryId="s2"
      selectedAtomicNodeId="s2::a2"
    />
  );

  assert.doesNotMatch(
    html,
    /data-storyline-minimap-point="/
  );
});


test('StorylineGraphScene uses stronger selected-summary emphasis widths', () => {
  assert.equal(SELECTED_SUMMARY_STROKE_WIDTH_PX, 2.15);
  assert.equal(SUMMARY_CONNECTIVITY_WIDTH_MULTIPLIER, 1.26);

  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      selectedSummaryId="s1"
      layout={{
        ...makeBaseProps().layout,
        summaryAreas: [
          {
            id: 'summary-area:s1',
            summaryId: 's1',
            shortLabel: 'Revenue spike',
            turnIndex: 0,
            left: 20,
            right: 140,
            top: 20,
            bottom: 100,
            width: 120,
            height: 80,
            titleBandHeight: 18,
            tracks: [],
            nodes: [],
            columns: ['Revenue'],
            leftAnchorYByColumn: {},
            rightAnchorYByColumn: {},
          },
        ],
      } as any}
    />
  );

  assert.match(
    html,
    /data-storyline-summary-id="s1"/
  );
  assert.match(
    html,
    /stroke-width="2\.15"/
  );
});
test('StorylineGraphScene renders insight legend in the top overview slot', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      taxonomyLegendItems={[
        { id: 'value', label: 'value', count: 4, color: '#6366f1' },
        { id: 'trend', label: 'trend', count: 8, color: '#22c55e' },
        { id: 'extreme', label: 'extreme', count: 0, color: '#ec4899' },
      ]}
    />
  );

  assert.doesNotMatch(html, /data-storyline-top-rail-card="overview"/);
  assert.match(
    html,
    /data-storyline-top-rail-card="legend"[^>]*style="left:16px;top:8px;width:388px;min-height:52px"/
  );
  assert.match(
    html,
    /data-storyline-top-rail-card="legend"[^>]*class="[^"]*pointer-events-auto[^"]*absolute[^"]*inline-flex[^"]*items-center/
  );
  assert.doesNotMatch(
    html,
    /Insight Types/
  );
  assert.match(
    html,
    /data-storyline-top-rail-card="legend"[\s\S]*?<div class="flex w-full flex-col items-center justify-center gap-y-1">/
  );
  assert.match(
    html,
    /data-storyline-legend-row="1"[^>]*class="flex w-full items-center justify-center gap-x-2\.5"/
  );
  assert.doesNotMatch(
    html,
    /data-storyline-legend-row="2"/
  );
  assert.match(
    html,
    /data-storyline-legend-key="taxonomy:value"[\s\S]*?class="inline-flex items-center gap-1 rounded-md px-1 py-px text-left text-\[12px\] leading-none/
  );
  assert.match(
    html,
    /data-storyline-legend-key="taxonomy:value"[\s\S]*?<svg width="18" height="18" viewBox="-8 -8 16 16" overflow="visible"/
  );
  assert.match(
    html,
    /data-storyline-legend-key="taxonomy:extreme"[\s\S]*?>extreme<[^]*?>\(0\)</
  );
});

test('StorylineGraphScene splits full taxonomy legend into centered 6+5 rows', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      taxonomyLegendItems={[
        { id: 'value', label: 'value', count: 1, color: '#6366f1' },
        { id: 'proportion', label: 'proportion', count: 1, color: '#6366f1' },
        { id: 'rank', label: 'rank', count: 1, color: '#6366f1' },
        { id: 'difference', label: 'difference', count: 1, color: '#6366f1' },
        { id: 'trend', label: 'trend', count: 1, color: '#6366f1' },
        { id: 'distribution', label: 'distribution', count: 1, color: '#6366f1' },
        { id: 'association', label: 'association', count: 1, color: '#6366f1' },
        { id: 'outlier', label: 'outlier', count: 1, color: '#6366f1' },
        { id: 'extreme', label: 'extreme', count: 1, color: '#6366f1' },
        { id: 'cluster', label: 'cluster', count: 1, color: '#6366f1' },
        { id: 'data_quality', label: 'data_quality', count: 1, color: '#6366f1' },
      ]}
    />
  );
  const rowMatches = [...html.matchAll(/data-storyline-legend-row="(\d)"[^>]*>([\s\S]*?)<\/div>/g)];
  assert.equal(rowMatches.length, 2);
  const rowOne = rowMatches[0]?.[2] ?? '';
  const rowTwo = rowMatches[1]?.[2] ?? '';
  const rowOneItemCount = (rowOne.match(/data-storyline-legend-key=/g) ?? []).length;
  const rowTwoItemCount = (rowTwo.match(/data-storyline-legend-key=/g) ?? []).length;
  assert.equal(rowOneItemCount, 6);
  assert.equal(rowTwoItemCount, 5);
  assert.match(rowOne, /data-storyline-legend-key="taxonomy:distribution"/);
  assert.match(rowTwo, /data-storyline-legend-key="taxonomy:data_quality"/);
});

test('StorylineGraphScene summary titles avoid horizontal glyph compression attributes', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      layout={{
        ...makeBaseProps().layout,
        summaryAreas: [
          {
            id: 'summary-area:s1',
            summaryId: 's1',
            shortLabel: 'Very long summary title that should grow area width instead of glyph squish',
            turnIndex: 0,
            left: 20,
            right: 140,
            top: 20,
            bottom: 100,
            width: 120,
            height: 80,
            titleBandHeight: 18,
            tracks: [],
            nodes: [],
            columns: ['Revenue'],
            leftAnchorYByColumn: {},
            rightAnchorYByColumn: {},
          },
        ],
      } as any}
    />
  );

  assert.match(
    html,
    /data-storyline-summary-id="s1"/
  );
  assert.doesNotMatch(
    html,
    /lengthAdjust=/
  );
  assert.doesNotMatch(
    html,
    /textLength=/
  );
});

test('StorylineGraphScene renders independent hit targets for summary, atomic, and column steering badges', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      summaryInternalsRenderMode="all"
      layout={{
        laneMode: 'dataset_columns',
        plotMinY: 0,
        plotMaxY: 160,
        plotMinX: 0,
        plotMaxX: 220,
        plotWidth: 220,
        plotHeight: 160,
        turns: [],
        converges: [],
        summaryAreas: [
          {
            id: 'summary-area:s1',
            summaryId: 's1',
            shortLabel: 'Revenue spike',
            turnIndex: 0,
            left: 20,
            right: 120,
            top: 20,
            bottom: 90,
            width: 100,
            height: 70,
            titleBandHeight: 18,
            tracks: [],
            nodes: [],
            columns: ['Revenue'],
            leftAnchorYByColumn: {},
            rightAnchorYByColumn: {},
          },
        ],
        activePlanAreas: [],
        turnBoundaries: [],
        nodes: [
          {
            id: 's1::a1',
            summaryId: 's1',
            atomicId: 'a1',
            x: 70,
            y: 56,
            width: 18,
            height: 18,
            glyphDiameter: 10,
            hitDiameter: 16,
            columns: ['Revenue'],
            portOffsetByColumn: {},
            insightType: 'trend',
            sizeScale: 1,
            sizeRatio: 0.5,
            timestampMs: 1,
          },
        ],
        boundaryBranches: [],
        adaptiveProfile: {
          labelScale: 1,
          trackStrokeScale: 1,
        } as any,
      }}
      visibleTrackLabels={[
        {
          id: 'indicator:converge:1:Revenue',
          column: 'Revenue',
          x: 140,
          top: 32,
          width: 52,
          maskHeight: 18,
          fontSize: 12,
          connector: null,
          pointCount: 1,
        },
      ] as any}
      resolveConvergeLabelVisualState={() => ({
        mode: 'both',
        filterHighlighted: false,
        forceUninvolvedTextColor: false,
        maskTone: 'default',
        textOpacity: 1,
        connectorOpacity: 1,
        anchor: 'converge',
      })}
      summarySteeringBadgeKinds={new Map([['s1', 'focus']])}
      atomicSteeringBadgeKinds={new Map([['s1::a1', 'ignore']])}
      columnSteeringBadgeKinds={new Map([['Revenue', 'focus']])}
      summarySteeringEntryIdsById={new Map([['s1', 'user_message:msg_summary']])}
      atomicSteeringEntryIdsByKey={new Map([['s1::a1', 'user_message:msg_atomic']])}
      columnSteeringEntryIdsByName={new Map([['Revenue', 'user_message:msg_column']])}
    />
  );

  assert.match(html, /data-storyline-soft-steering-badge-hit-target="summary"/);
  assert.match(html, /data-storyline-soft-steering-badge-hit-target="atomic"/);
  assert.match(html, /data-storyline-soft-steering-badge-hit-target="column"/);
  assert.match(html, /data-storyline-soft-steering-icon="focus"/);
  assert.match(html, /data-storyline-soft-steering-icon="ignore"/);
});

test('StorylineGraphScene only renders a column steering badge on the anchored converge indicator', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      visibleTrackLabels={[
        {
          id: 'indicator:converge:0:Revenue',
          column: 'Revenue',
          x: 80,
          top: 24,
          width: 56,
          maskHeight: 18,
          fontSize: 12,
          connector: null,
          pointCount: 1,
        },
        {
          id: 'indicator:converge:1:Revenue',
          column: 'Revenue',
          x: 156,
          top: 24,
          width: 56,
          maskHeight: 18,
          fontSize: 12,
          connector: null,
          pointCount: 1,
        },
      ] as any}
      resolveConvergeLabelVisualState={() => ({
        mode: 'both',
        filterHighlighted: false,
        forceUninvolvedTextColor: false,
        maskTone: 'default',
        textOpacity: 1,
        connectorOpacity: 1,
        anchor: 'converge',
      })}
      columnSteeringBadgeKinds={new Map()}
      columnSteeringEntryIdsByName={new Map()}
      columnSteeringBadgeKindsByIndicatorId={
        new Map([['indicator:converge:1:Revenue', 'focus']])
      }
      columnSteeringEntryIdsByIndicatorId={
        new Map([['indicator:converge:1:Revenue', 'user_message:msg_column_local']])
      }
    />
  );

  const focusIconMatches = html.match(/data-storyline-soft-steering-icon="focus"/g) ?? [];
  const columnHitTargetMatches = html.match(/data-storyline-soft-steering-badge-hit-target="column"/g) ?? [];

  assert.equal(focusIconMatches.length, 1);
  assert.equal(columnHitTargetMatches.length, 1);
});

test('StorylineGraphScene does not render pen-specific summary or glyph hover markers', () => {
  const sceneProps = makeBaseProps();
  const layout = {
    ...sceneProps.layout,
    summaryAreas: [
      {
        id: 'summary-area:s1',
        summaryId: 's1',
        shortLabel: 'Revenue spike',
        turnIndex: 0,
        left: 20,
        right: 140,
        top: 20,
        bottom: 100,
        width: 120,
        height: 80,
        titleBandHeight: 18,
        tracks: [],
        nodes: [],
        columns: ['Revenue'],
        leftAnchorYByColumn: {},
        rightAnchorYByColumn: {},
      },
    ],
    nodes: [
      {
        id: 's1::a1',
        summaryId: 's1',
        atomicId: 'a1',
        x: 80,
        y: 60,
        width: 18,
        height: 18,
        glyphDiameter: 10,
        hitDiameter: 16,
        columns: ['Revenue'],
        portOffsetByColumn: {},
        insightType: 'trend',
        sizeScale: 1,
        sizeRatio: 0.5,
        timestampMs: 1,
      },
    ],
  } as any;

  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...sceneProps}
      layout={layout}
      summaryInternalsRenderMode="all"
      activeSteeringPen="focus"
    />
  );
  assert.doesNotMatch(html, /data-storyline-summary-pen-hovered="true"/);
  assert.doesNotMatch(html, /data-storyline-glyph-pen-hovered="true"/);
});

test('StorylineGraphScene renders an atomic hover preview without metrics or code-output evidence', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      hoveredAtomicPreview={{
        runId: 'run_123',
        index: 1,
        x: 140,
        y: 120,
        atomic: {
          atomic_id: 'atomic_1',
          text: 'North America grows fastest in Q4.',
          insight_type: 'trend',
          columns: ['Revenue', 'Region'],
          evidence: {
            plot_path: 'artifacts/plots/revenue_q4.png',
            code_path: 'artifacts/code/revenue_q4.py',
            output_path: 'artifacts/stdout/revenue_q4.txt',
          },
          interest: 0.91,
          significance: 0.82,
          impact: 0.78,
          importance: 0.85,
        },
      }}
    />
  );

  assert.match(html, /data-storyline-hover-atomic-card="true"/);
  assert.match(html, /w-\[32rem\]/);
  assert.match(html, /North America grows fastest in Q4\./);
  assert.match(html, /artifacts\/plots\/revenue_q4\.png/);
  assert.doesNotMatch(html, /Interest 0\.91/);
  assert.doesNotMatch(html, /Significance 0\.82/);
  assert.doesNotMatch(html, /Impact 0\.78/);
  assert.doesNotMatch(html, /Importance 0\.85/);
  assert.doesNotMatch(html, />Code</);
  assert.doesNotMatch(html, />Output</);
  assert.doesNotMatch(html, /data-storyline-pinned-atomic-card="true"/);
  assert.doesNotMatch(html, />Close</);
  assert.doesNotMatch(html, /title="Click to zoom"/);
});

test('StorylineGraphScene keeps the atomic hover preview card while a steering pen is active', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activeSteeringPen="focus"
      hoveredAtomicPreview={{
        runId: 'run_123',
        index: 1,
        x: 140,
        y: 120,
        atomic: {
          atomic_id: 'atomic_1',
          text: 'North America grows fastest in Q4.',
          insight_type: 'trend',
          columns: ['Revenue', 'Region'],
          evidence: {
            plot_path: 'artifacts/plots/revenue_q4.png',
            code_path: 'artifacts/code/revenue_q4.py',
            output_path: 'artifacts/stdout/revenue_q4.txt',
          },
          interest: 0.91,
          significance: 0.82,
          impact: 0.78,
          importance: 0.85,
        },
      }}
    />
  );

  assert.match(html, /data-storyline-hover-atomic-card="true"/);
  assert.match(html, /North America grows fastest in Q4\./);
});

test('StorylineGraphScene renders the summary hover preview card with source task and summary text', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      hoveredSummaryPreview={{
        summaryId: 's1',
        sourceTask: 'Investigate Q4 concentration by region.',
        summaryText: 'Revenue spikes in Q4 because North America dominates the increase.',
        x: 120,
        y: 90,
      }}
    />
  );

  assert.match(html, /data-storyline-hover-summary-card="true"/);
  assert.match(html, /Source Task/);
  assert.match(html, /Investigate Q4 concentration by region\./);
  assert.match(html, /Revenue spikes in Q4 because North America dominates the increase\./);
});

test('StorylineGraphScene keeps the summary hover preview card while a steering pen is active', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activeSteeringPen="ignore"
      hoveredSummaryPreview={{
        summaryId: 's1',
        sourceTask: 'Investigate Q4 concentration by region.',
        summaryText: 'Revenue spikes in Q4 because North America dominates the increase.',
        x: 120,
        y: 90,
      }}
    />
  );

  assert.match(html, /data-storyline-hover-summary-card="true"/);
  assert.match(html, /Investigate Q4 concentration by region\./);
  assert.match(html, /Revenue spikes in Q4 because North America dominates the increase\./);
});

test('StorylineGraphScene renders the low-zoom plan hover preview card', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      view={{ zoomX: 0.49, tx: 0 }}
      hoveredPlanPreview={{
        planId: 'plan_live',
        text: 'Investigate whether the Q4 spike comes from one region.',
        status: 'analyzing',
        x: 140,
        y: 110,
      }}
    />
  );

  assert.match(html, /data-storyline-hover-plan-card="true"/);
  assert.match(html, /Analysis Plan/);
  assert.match(html, /Investigate whether the Q4 spike comes from one region\./);
});

test('StorylineGraphScene positions stage buttons above the topmost indicator and final buttons below the lowest visible indicator', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      layout={{
        ...makeBaseProps().layout,
        converges: [{
          index: 1,
          xStart: 24,
          xEnd: 132,
          lanes: [
            {
              id: 'converge:1:Revenue',
              column: 'Revenue',
              y: 80,
              mode: 'right_extension',
              segments: [],
              endpointMarkers: [
                {
                  id: 'converge:1:Revenue:start-marker',
                  kind: 'start',
                  x: 66,
                  y: 80,
                  diameter: 16,
                },
              ],
            },
          ],
        }],
      } as any}
      visibleTrackLabels={[
        {
          id: 'indicator:converge:1:Revenue',
          column: 'Revenue',
          x: 40,
          y: 88,
          top: 88,
          width: 52,
          height: 18,
          maskHeight: 18,
          fontSize: 12,
          paddingX: 7,
          anchorX: 66,
          anchorY: 88,
          connector: null,
          pointCount: 1,
          placement: 'embedded',
        },
      ] as any}
      convergeSummaryButtons={[
        {
          id: 'converge-summary:stage:evaluation_1',
          entryId: 'evaluation_1',
          convergeIndex: 1,
          dispatchTurnIndex: 0,
          kind: 'stage',
        },
        {
          id: 'converge-summary:final:mark_complete_1',
          entryId: 'mark_complete_1',
          convergeIndex: 1,
          dispatchTurnIndex: 0,
          kind: 'final',
        },
      ]}
      highlightedSummaryEntryId="mark_complete_1"
    />
  );

  assert.match(html, /data-storyline-converge-summary-button="evaluation_1"/);
  assert.match(html, /data-storyline-converge-summary-button="mark_complete_1"/);
  assert.match(html, />Stage Summary</);
  assert.match(html, />Final Summary</);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-kind="stage"/);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-anchor-top="72"/);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-kind="stage"[^>]*data-storyline-converge-summary-band-top="32"/);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-kind="final"/);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-anchor-bottom="106"/);
  assert.match(html, /data-storyline-converge-summary-band="1"[^>]*data-storyline-converge-summary-band-kind="final"[^>]*data-storyline-converge-summary-band-top="122"/);
  assert.doesNotMatch(html, /data-storyline-converge-summary-highlighted="true"/);
  assert.match(
    html,
    /data-storyline-converge-summary-button="evaluation_1"[^>]*class="[^"]*hover:bg-amber-200\/95[^"]*active:border-amber-400[^"]*active:bg-amber-200\/95[^"]*active:text-amber-900/
  );
  assert.match(
    html,
    /data-storyline-converge-summary-button="mark_complete_1"[^>]*class="[^"]*hover:bg-emerald-200\/95[^"]*active:border-emerald-400[^"]*active:bg-emerald-200\/95[^"]*active:text-emerald-900/
  );
});

test('StorylineGraphScene keeps low-zoom converge summary buttons above marker anchors and shrinks the icon to fit narrow converges', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      view={{ zoomX: 0.49, tx: 0 }}
      layout={{
        ...makeBaseProps().layout,
        converges: [{
          index: 1,
          xStart: 24,
          xEnd: 35,
          lanes: [
            {
              id: 'converge:1:Revenue',
              column: 'Revenue',
              y: 60,
              mode: 'right_extension',
              segments: [],
              endpointMarkers: [
                {
                  id: 'converge:1:Revenue:start-marker',
                  kind: 'start',
                  x: 30,
                  y: 60,
                  diameter: 16,
                },
              ],
            },
          ],
        }],
      } as any}
      convergeSummaryButtons={[
        {
          id: 'converge-summary:stage:evaluation_1',
          entryId: 'evaluation_1',
          convergeIndex: 1,
          dispatchTurnIndex: 0,
          kind: 'stage',
        },
      ]}
    />
  );

  assert.match(html, /data-storyline-converge-summary-button="evaluation_1"/);
  assert.match(html, /data-storyline-converge-summary-band-anchor-top="52"/);
  assert.match(html, /data-storyline-converge-summary-band-top="24"/);
  assert.match(
    html,
    /data-storyline-converge-summary-button="evaluation_1"[^>]*data-storyline-converge-summary-icon-size="5"/
  );
  assert.doesNotMatch(html, />Stage Summary</);
  assert.doesNotMatch(html, />Final Summary</);
});

test('StorylineGraphScene renders active plan areas with the shared plan dispatch card chrome and icon controls', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      selectedPlanId="plan_live"
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_live',
          planId: 'plan_live',
          shortLabel: 'Regional outlier scan',
          text: 'Investigate late-stage regional outliers first.',
          status: 'paused',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /data-storyline-active-plan-id="plan_live"/);
  assert.match(html, /data-plan-dispatch-card-id="plan_live"/);
  assert.match(html, /data-plan-dispatch-card-selected="true"/);
  assert.doesNotMatch(html, /data-plan-dispatch-card-running="true"/);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.match(html, /aria-label="Modify"/);
  assert.match(html, /aria-label="Resume"/);
  assert.match(html, /aria-label="Terminate"/);
  assert.match(html, /Investigate late-stage regional outliers first\./);
  assert.doesNotMatch(html, />plan_live</);
  assert.doesNotMatch(html, />Open analysis stream</);
});

test('StorylineGraphScene renders pending active plan areas with Modify, Start, and Terminate controls', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_pending',
          planId: 'plan_pending',
          shortLabel: 'Queued plan',
          text: 'Inspect the pending queue semantics.',
          status: 'pending',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /data-storyline-active-plan-id="plan_pending"/);
  assert.match(html, /aria-label="Modify"/);
  assert.match(html, /aria-label="Start"/);
  assert.match(html, /aria-label="Terminate"/);
  assert.doesNotMatch(html, /aria-label="Resume"/);
  assert.doesNotMatch(html, /aria-label="Pause"/);
  assert.doesNotMatch(html, /draggable="true"/);
});

test('StorylineGraphScene disables pending Start control when plan concurrency is saturated', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      disablePendingPlanStart
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_pending_disabled',
          planId: 'plan_pending_disabled',
          shortLabel: 'Queued plan',
          text: 'Do not allow manual start while seats are full.',
          status: 'pending',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /aria-label="Start"[^>]*disabled/);
  assert.match(html, /aria-label="Terminate"/);
});

test('StorylineGraphScene keeps paused Resume control enabled when plan concurrency is saturated', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_paused_disabled',
          planId: 'plan_paused_disabled',
          shortLabel: 'Paused plan',
          text: 'Do not allow resume while seats are full.',
          status: 'paused',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /aria-label="Modify"/);
  assert.doesNotMatch(html, /aria-label="Modify"[^>]*disabled/);
  assert.match(html, /aria-label="Resume"/);
  assert.doesNotMatch(html, /aria-label="Resume"[^>]*disabled/);
  assert.match(html, /aria-label="Terminate"/);
});

test('StorylineGraphScene keeps modify visible but disabled for terminal active plan areas', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_done',
          planId: 'plan_done',
          shortLabel: 'Completed plan',
          text: 'Render a disabled modify control after completion.',
          status: 'completed',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 124,
          width: 160,
          height: 92,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /aria-label="Modify"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="Resume"/);
  assert.doesNotMatch(html, /aria-label="Pause"/);
  assert.doesNotMatch(html, /aria-label="Terminate"/);
});

test('StorylineGraphScene renders inline editing for the active modify target while keeping the card height fixed', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      editingPlanId="plan_edit"
      editingPlanDraft={'Line one.\nLine two.'}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_edit',
          planId: 'plan_edit',
          shortLabel: 'Editable plan',
          text: 'Old plan text.',
          status: 'paused',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 164,
          width: 160,
          height: 132,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /data-plan-dispatch-card-id="plan_edit"/);
  assert.match(html, /data-plan-dispatch-card-editing="true"/);
  assert.match(html, /aria-label="Confirm"/);
  assert.match(html, /aria-label="Resume"[^>]*disabled/);
  assert.match(html, /aria-label="Terminate"[^>]*disabled/);
  assert.match(html, /aria-label="Edit plan text"/);
  assert.match(
    html,
    /data-storyline-active-plan-id="plan_edit"[^>]*style="left:20px;top:72px;width:160px;height:132px"/
  );
});

test('StorylineGraphScene does not render pending control action helper text on plan cards', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      planControlPendingById={{ plan_pending_action: 'resume' }}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_pending_action',
          planId: 'plan_pending_action',
          shortLabel: 'Paused plan',
          text: 'The card should not show resume helper text.',
          status: 'paused',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.doesNotMatch(html, /resume\.\.\./i);
  assert.doesNotMatch(html, /pause\.\.\./i);
  assert.doesNotMatch(html, /start\.\.\./i);
  assert.doesNotMatch(html, /terminate\.\.\./i);
});

test('StorylineGraphScene renders requested control states as paused or terminated labels', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_pause_requested',
          planId: 'plan_pause_requested',
          shortLabel: 'Pause requested plan',
          text: 'Pause requested plan text.',
          status: 'analyzing',
          controlState: 'pause_requested',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
        {
          id: 'active-plan-area:plan_terminate_requested',
          planId: 'plan_terminate_requested',
          shortLabel: 'Terminate requested plan',
          text: 'Terminate requested plan text.',
          status: 'summarizing',
          controlState: 'terminate_requested',
          turnIndex: 0,
          left: 200,
          right: 360,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, />paused</);
  assert.match(html, />terminated</);
  assert.doesNotMatch(html, /pause requested/);
  assert.doesNotMatch(html, /terminate requested/);
});

test('StorylineGraphScene marks create-origin summaries and active plans with the create accent and running pulse', () => {
  const activePlanAreas = [
    {
      id: 'active-plan-area:plan_create',
      planId: 'plan_create',
      shortLabel: 'Created plan',
      text: 'Investigate the create-origin thread.',
      status: 'analyzing' as const,
      controlState: 'none' as const,
      turnIndex: 0,
      left: 20,
      right: 180,
      top: 104,
      bottom: 196,
      width: 160,
      height: 92,
      titleBandHeight: 22,
    },
  ];
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      layout={{
        ...makeBaseProps().layout,
        summaryAreas: [
          {
            id: 'summary-area:s_create',
            summaryId: 's_create',
            shortLabel: 'Created summary',
            turnIndex: 0,
            left: 20,
            right: 160,
            top: 20,
            bottom: 96,
            width: 140,
            height: 76,
            titleBandHeight: 18,
            tracks: [],
            nodes: [],
            columns: ['Revenue'],
            leftAnchorYByColumn: {},
            rightAnchorYByColumn: {},
          },
        ],
        activePlanAreas,
      }}
      activePlanAreas={activePlanAreas as any}
      createOriginPlanIds={new Set(['plan_create'])}
      createOriginSummaryIds={new Set(['s_create'])}
    />
  );

  assert.match(html, /data-storyline-summary-id="s_create"[^>]*data-storyline-summary-create-origin="true"/);
  assert.match(html, /data-storyline-active-plan-id="plan_create"/);
  assert.match(html, /data-storyline-active-plan-create-origin="true"/);
  assert.match(html, /data-plan-dispatch-card-accent="create"/);
  assert.match(html, /data-plan-dispatch-card-running="true"/);
  assert.match(html, /storyline-plan-card-running/);
  assert.match(html, /<text[^>]*fill="#0f172a"[^>]*>Created summary<\/text>/);
  assert.doesNotMatch(html, /<text[^>]*fill="#065f46"[^>]*>Created summary<\/text>/);
});

test('StorylineGraphScene hides active plan text below 50% zoom while keeping controls visible', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      view={{ zoomX: 0.49, tx: 0 }}
      activePlanAreas={[
        {
          id: 'active-plan-area:plan_live',
          planId: 'plan_live',
          shortLabel: 'Regional outlier scan',
          text: 'Investigate late-stage regional outliers first.',
          status: 'paused',
          controlState: 'none',
          turnIndex: 0,
          left: 20,
          right: 180,
          top: 32,
          bottom: 148,
          width: 160,
          height: 116,
          titleBandHeight: 22,
        },
      ] as any}
    />
  );

  assert.match(html, /data-storyline-active-plan-id="plan_live"/);
  assert.match(html, /aria-label="Modify"/);
  assert.match(html, /aria-label="Resume"/);
  assert.match(html, /aria-label="Terminate"/);
  assert.doesNotMatch(html, /Regional outlier scan/);
  assert.doesNotMatch(html, /Investigate late-stage regional outliers first\./);
});

test('StorylineGraphScene does not render minimap plan points after overview removal', () => {
  const html = renderToStaticMarkup(
    <StorylineGraphScene
      {...makeBaseProps()}
      minimapPoints={[
        {
          id: 'plan:plan_live',
          kind: 'plan',
          summaryId: null,
          planId: 'plan_live',
          x: 80,
          y: 26,
          r: 4,
          color: '#38bdf8',
          pulse: true,
        },
      ] as any}
      selectedPlanId="plan_live"
    />
  );

  assert.doesNotMatch(html, /data-storyline-minimap-point-kind="plan"/);
  assert.doesNotMatch(html, /data-storyline-minimap-plan-id="plan_live"/);
  assert.doesNotMatch(html, /data-storyline-minimap-point-selected="true"/);
  assert.doesNotMatch(html, /storyline-minimap-plan-point-running/);
});


