import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PlanItem, RunState, Summary } from '@/types';
import Inspector, {
  InsightInspector,
  sortFilterResultsEntries,
  type InspectorFilterOverride,
} from './Inspector';
import ExplorationCoverageGrid from './ExplorationCoverageGrid';
import {
  buildCoverageCellAverageImportanceStats,
  buildCoverageGridModel,
  buildFilteredAtomicEntries,
  buildSelectedCoverageCellDescriptors,
  toggleCoverageCellKey,
  toggleCoverageSelectionGroup,
} from './coverageGridModel';
import {
  EMPTY_STORYLINE_FILTER_ACTIONS,
  EMPTY_STORYLINE_FILTER_SNAPSHOT,
} from './storylineFilter';
import { useStore } from '@/store/useStore';

function makeInspectorRunState(params: {
  atomicImportances: number[];
  insightId?: string;
  planId?: string;
}): RunState {
  const insightId = params.insightId ?? 's1';
  const planId = params.planId ?? 'p1';
  return {
    run_id: 'run_inspector',
    dataset_path: 'dataset.csv',
    dataset_info: { rows: 1, columns: [] },
    dataset_schema: 'Columns: ["Revenue"]',
    step: 1,
    failure_count: 0,
    status: 'completed',
    budgets: {
      max_steps: 4,
      max_depth: 2,
      max_children_per_insight: 2,
      max_failures: 1,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 1,
    },
    frontier: [
      {
        plan_id: planId,
        kind: 'analysis',
        text: 'Inspect revenue behavior',
        filters: [],
        status: 'completed',
        parent_insight_id: null,
        short_label: 'Inspect revenue behavior',
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ],
    insights: [
      {
        insight_id: insightId,
        plan_id: planId,
        summary: 'summary text',
        atomic_insights: params.atomicImportances.map((importance, index) => ({
          atomic_id: `a${index + 1}`,
          text: `atomic ${index + 1}`,
          insight_type: 'trend',
          columns: ['Revenue'],
          evidence: { code_path: null, output_path: null, plot_path: null },
          interest: 0.2,
          significance: 0.3,
          impact: 0.4,
          importance,
        })),
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-01T00:00:10.000Z',
      },
    ],
    execution_records: [],
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:10.000Z',
  };
}

function makeCoverageRunState(columnLabels: string[] = ['Revenue', 'Region', 'Category']): RunState {
  const datasetSchema = `Columns: [${columnLabels.map((label) => `"${label}"`).join(', ')}]`;
  return {
    run_id: 'run_coverage_grid',
    dataset_path: 'data/test.csv',
    dataset_info: '{}',
    dataset_schema: datasetSchema,
    step: 2,
    failure_count: 0,
    status: 'running',
    budgets: {
      max_steps: 10,
      max_depth: 3,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 1,
      max_attempts_per_plan: 2,
    },
    frontier: [],
    insights: [
      {
        insight_id: 's1',
        plan_id: 'p1',
        summary: 'summary 1',
        atomic_insights: [
          {
            atomic_id: 'a1',
            text: 'high importance trend',
            insight_type: 'trend',
            columns: ['Revenue', 'Region'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.4,
            significance: 0.5,
            impact: 0.6,
            importance: 0.9,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        insight_id: 's2',
        plan_id: 'p2',
        summary: 'summary 2',
        atomic_insights: [
          {
            atomic_id: 'a2',
            text: 'medium importance trend',
            insight_type: 'trend',
            columns: ['Revenue'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.4,
            significance: 0.5,
            impact: 0.6,
            importance: 0.6,
          },
          {
            atomic_id: 'a3',
            text: 'low importance quality',
            insight_type: 'data_quality',
            columns: ['Category'],
            evidence: { code_path: null, output_path: null, plot_path: null },
            interest: 0.4,
            significance: 0.5,
            impact: 0.6,
            importance: 0.2,
          },
        ],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-02T00:00:00.000Z',
      },
    ],
    execution_records: [],
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-02T00:00:00.000Z',
  };
}

test('Inspector filter override hides source task and renders atomic insights by descending importance', () => {
  useStore.setState({
    runState: null,
    selection: { type: null, id: null },
  });

  const filterOverride: InspectorFilterOverride = {
    selectedCells: [
      {
        key: 'k1',
        taxonomyId: 'trend',
        taxonomyLabel: 'trend',
        column: 'Revenue',
        atomicKeys: ['s1::a1', 's2::a2'],
      },
    ],
    entries: [
      {
        atomicKey: 's1::a1',
        insight: {
          insight_id: 's1',
          plan_id: 'p1',
          summary: 'summary 1',
          atomic_insights: [],
          embedding: null,
          parent_insight_id: null,
          children_insight_ids: [],
          created_at: '2026-03-01T00:00:00.000Z',
        },
        atomic: {
          atomic_id: 'a1',
          text: 'higher importance atomic',
          insight_type: 'trend',
          columns: ['Revenue'],
          evidence: { code_path: null, output_path: null, plot_path: null },
          interest: 0.2,
          significance: 0.3,
          impact: 0.4,
          importance: 0.9,
        },
      },
      {
        atomicKey: 's2::a2',
        insight: {
          insight_id: 's2',
          plan_id: 'p2',
          summary: 'summary 2',
          atomic_insights: [],
          embedding: null,
          parent_insight_id: null,
          children_insight_ids: [],
          created_at: '2026-03-02T00:00:00.000Z',
        },
        atomic: {
          atomic_id: 'a2',
          text: 'lower importance atomic',
          insight_type: 'trend',
          columns: ['Revenue'],
          evidence: { code_path: null, output_path: null, plot_path: null },
          interest: 0.2,
          significance: 0.3,
          impact: 0.4,
          importance: 0.5,
        },
      },
    ],
  };

  const html = renderToStaticMarkup(
    <Inspector
      runId="run_filter"
      storylineFilter={{ inspectorOverride: filterOverride }}
    />
  );

  assert.match(html, /Filtered Atomic Insights/);
  assert.match(html, /2 selected/);
  assert.match(html, /lucide-arrow-down-wide-narrow/);
  assert.doesNotMatch(html, /lucide-arrow-up-narrow-wide/);
  assert.doesNotMatch(html, /role="switch"/);
  assert.doesNotMatch(html, /High to Low/);
  assert.doesNotMatch(html, /Low to High/);
  assert.doesNotMatch(html, /trend x Revenue/);
  assert.doesNotMatch(html, /Source Task/);
  assert.ok(html.indexOf('higher importance atomic') < html.indexOf('lower importance atomic'));
});

test('Inspector filter override sort helper supports both importance directions', () => {
  const entries: InspectorFilterOverride['entries'] = [
    {
      atomicKey: 's1::a1',
      insight: {
        insight_id: 's1',
        plan_id: 'p1',
        summary: 'summary 1',
        atomic_insights: [],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-01T00:00:00.000Z',
      },
      atomic: {
        atomic_id: 'a1',
        text: 'higher',
        insight_type: 'trend',
        columns: ['Revenue'],
        evidence: { code_path: null, output_path: null, plot_path: null },
        interest: 0.2,
        significance: 0.3,
        impact: 0.4,
        importance: 0.9,
      },
    },
    {
      atomicKey: 's2::a2',
      insight: {
        insight_id: 's2',
        plan_id: 'p2',
        summary: 'summary 2',
        atomic_insights: [],
        embedding: null,
        parent_insight_id: null,
        children_insight_ids: [],
        created_at: '2026-03-02T00:00:00.000Z',
      },
      atomic: {
        atomic_id: 'a2',
        text: 'lower',
        insight_type: 'trend',
        columns: ['Revenue'],
        evidence: { code_path: null, output_path: null, plot_path: null },
        interest: 0.2,
        significance: 0.3,
        impact: 0.4,
        importance: 0.5,
      },
    },
  ];

  assert.deepEqual(
    sortFilterResultsEntries(entries, 'importance_desc').map((entry) => entry.atomic.atomic_id),
    ['a1', 'a2']
  );
  assert.deepEqual(
    sortFilterResultsEntries(entries, 'importance_asc').map((entry) => entry.atomic.atomic_id),
    ['a2', 'a1']
  );
});

test('Inspector source task shows average atomic importance with two decimals', () => {
  const runState = makeInspectorRunState({ atomicImportances: [0.8, 0.6] });
  const insight = runState.insights[0] as Summary;
  const plan = runState.frontier[0] as PlanItem;
  useStore.setState({ reports: {} });

  const html = renderToStaticMarkup(
    <InsightInspector
      runId="run_inspector"
      insight={insight}
      plan={plan}
      isBookmarked={false}
      onBookmark={() => {}}
    />
  );

  assert.match(html, /Source Task/);
  assert.match(html, /Avg\. Importance 0\.70/);
});

test('Inspector source task defaults average atomic importance to zero when summary has no atomics', () => {
  const runState = makeInspectorRunState({ atomicImportances: [], insightId: 's-empty', planId: 'p-empty' });
  const insight = runState.insights[0] as Summary;
  const plan = runState.frontier[0] as PlanItem;
  useStore.setState({ reports: {} });

  const html = renderToStaticMarkup(
    <InsightInspector
      runId="run_inspector"
      insight={insight}
      plan={plan}
      isBookmarked={false}
      onBookmark={() => {}}
    />
  );

  assert.match(html, /Avg\. Importance 0\.00/);
});

test('Inspector coverage grid renders transposed headers with real legend endpoint values', () => {
  const html = renderToStaticMarkup(
    <ExplorationCoverageGrid
      model={buildCoverageGridModel(makeCoverageRunState())}
      storylineFilter={{
        snapshot: EMPTY_STORYLINE_FILTER_SNAPSHOT,
        actions: EMPTY_STORYLINE_FILTER_ACTIONS,
      }}
      colorMode="avg_importance"
      onColorModeChange={() => undefined}
    />
  );

  assert.match(html, /Importance/);
  assert.match(html, />0\.00<\/span>/);
  assert.match(html, />0\.90<\/span>/);
  assert.match(html, /Clear All/);
  assert.match(html, /Toggle filter insight type data_quality/);
  assert.match(html, /Toggle filter column Revenue/);
  assert.match(html, /Revenue/);
  assert.match(html, /\(2\)/);
  assert.doesNotMatch(html, />0%<\/span>/);
  assert.doesNotMatch(html, />100%<\/span>/);
});

test('Inspector coverage grid keeps row minimum height and enables vertical scrolling when needed', () => {
  const html = renderToStaticMarkup(
    <ExplorationCoverageGrid
      model={buildCoverageGridModel(makeCoverageRunState())}
      storylineFilter={{
        snapshot: EMPTY_STORYLINE_FILTER_SNAPSHOT,
        actions: EMPTY_STORYLINE_FILTER_ACTIONS,
      }}
      colorMode="count"
      onColorModeChange={() => undefined}
    />
  );

  assert.match(html, /overflow-y-auto/);
  assert.match(html, /grid-template-rows:\d+px repeat\(3,\s*max\(22px,\s*calc\(\(100% - \d+px\) \/ 11\)\)\)/);
  assert.doesNotMatch(html, /grid-template-rows:[^"]*1fr/);
});

test('Inspector coverage grid switches to compact row height when more than ten rows are present', () => {
  const manyColumns = Array.from({ length: 12 }, (_, index) => `Column ${index + 1}`);
  const html = renderToStaticMarkup(
    <ExplorationCoverageGrid
      model={buildCoverageGridModel(makeCoverageRunState(manyColumns))}
      storylineFilter={{
        snapshot: EMPTY_STORYLINE_FILTER_SNAPSHOT,
        actions: EMPTY_STORYLINE_FILTER_ACTIONS,
      }}
      colorMode="count"
      onColorModeChange={() => undefined}
    />
  );

  assert.match(html, /overflow-y-auto/);
  assert.match(html, /grid-template-rows:\d+px repeat\(12,\s*22px\)/);
});

test('Inspector coverage grid caps row-header width for long column labels so cells stay readable', () => {
  const longColumns = [
    'weekly_study_time',
    'past_failures',
    'school_support',
    'family_support',
    'extracurricular_activities',
    'internet_access',
    'romantic_relationship',
    'social_activity_level',
  ];
  const html = renderToStaticMarkup(
    <ExplorationCoverageGrid
      model={buildCoverageGridModel(makeCoverageRunState(longColumns))}
      storylineFilter={{
        snapshot: EMPTY_STORYLINE_FILTER_SNAPSHOT,
        actions: EMPTY_STORYLINE_FILTER_ACTIONS,
      }}
      colorMode="count"
      onColorModeChange={() => undefined}
    />
  );

  assert.match(html, /grid-template-columns:160px repeat\(\d+,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(html, /max-content/);
  assert.match(html, /truncate/);
});

test('Inspector coverage model keeps row and column group toggles deterministic', () => {
  const model = buildCoverageGridModel(makeCoverageRunState());
  const revenueKeys = model.columnKeys.get('Revenue') ?? [];
  const trendKeys = model.rowKeys.get('trend') ?? [];

  const singleSelected = toggleCoverageCellKey([], revenueKeys[0]);
  assert.deepEqual(singleSelected, [revenueKeys[0]]);
  assert.deepEqual(toggleCoverageCellKey(singleSelected, revenueKeys[0]), []);

  const columnSelected = toggleCoverageSelectionGroup([], revenueKeys);
  assert.equal(revenueKeys.every((key) => columnSelected.includes(key)), true);
  assert.deepEqual(toggleCoverageSelectionGroup(columnSelected, revenueKeys), []);

  const rowSelected = toggleCoverageSelectionGroup([], trendKeys);
  assert.equal(trendKeys.every((key) => rowSelected.includes(key)), true);
});

test('Inspector coverage model dedupes filter entries and computes average-importance stats', () => {
  const model = buildCoverageGridModel(makeCoverageRunState());
  const selectedKeys = [
    JSON.stringify(['trend', 'Revenue']),
    JSON.stringify(['trend', 'Region']),
    JSON.stringify(['data_quality', 'Category']),
  ];

  const selectedCells = buildSelectedCoverageCellDescriptors(model, selectedKeys);
  assert.deepEqual(
    selectedCells.map((cell) => `${cell.taxonomyId}:${cell.column}`),
    ['data_quality:Category', 'trend:Region', 'trend:Revenue']
  );

  const entries = buildFilteredAtomicEntries(model, selectedKeys);
  assert.deepEqual(
    entries.map((entry) => entry.atomic.atomic_id),
    ['a1', 'a2', 'a3']
  );
  assert.equal(entries.filter((entry) => entry.atomic.atomic_id === 'a1').length, 1);

  const stats = buildCoverageCellAverageImportanceStats(model);
  assert.equal(stats.averageByCellKey.get(JSON.stringify(['trend', 'Revenue'])), 0.75);
  assert.equal(stats.averageByCellKey.get(JSON.stringify(['trend', 'Region'])), 0.9);
  assert.equal(stats.averageByCellKey.get(JSON.stringify(['data_quality', 'Category'])), 0.2);
  assert.equal(stats.maxAverageImportance, 0.9);
});
