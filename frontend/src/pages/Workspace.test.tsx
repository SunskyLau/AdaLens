import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import App from '../App';
import Workspace, {
  buildDataTableModalWidth,
  isStartedRunTransition,
  recoverRunAfterStreamError,
  shouldKeepRunLive,
} from './Workspace';
import { useStore } from '@/store/useStore';
import type { RunState } from '@/types';

function resetWorkspaceStore() {
  useStore.setState({
    currentRunId: null,
    runState: null,
    events: [],
    timelineEvents: [],
    eventsLoading: false,
    selection: { type: null, id: null },
    conversationEntries: [],
    planInsights: new Map(),
  });
}

function makeWorkspaceRunState(status: RunState['status'] = 'running'): RunState {
  return {
    run_id: 'run_workspace',
    dataset_path: 'data/vgsales.csv',
    dataset_info: { rows: 10, columns: [], sample_rows: [] },
    dataset_schema: 'Columns: ["Revenue", "Region", "Category"]',
    step: 1,
    failure_count: 0,
    status,
    budgets: {
      max_steps: 10,
      max_depth: 2,
      max_children_per_insight: 3,
      max_failures: 2,
    },
    settings: {
      default_sub_agents_num: 2,
      max_attempts_per_plan: 2,
    },
    frontier: [
      {
        plan_id: 'plan_123',
        kind: 'analysis',
        text: 'Analyze regional sales performance',
        filters: [],
        status: 'analyzing',
        parent_insight_id: null,
        short_label: 'Analyze regional sales performance',
        created_at: '2026-03-08T00:00:00.000Z',
      },
    ],
    insights: [],
    execution_records: [],
    created_at: '2026-03-08T00:00:00.000Z',
    updated_at: '2026-03-08T00:00:00.000Z',
  };
}

function renderWorkspace(route = '/', workspace = <Workspace />): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/" element={workspace} />
        <Route path="/c/:runId" element={workspace} />
      </Routes>
    </MemoryRouter>
  );
}

test('Workspace preserves the root app entry chain to the workspace shell', () => {
  resetWorkspaceStore();

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>
  );

  assert.match(html, /CHAT/);
  assert.match(html, /Storyline/);
  assert.doesNotMatch(html, /Exploration Runs/);
});

test('Workspace right rail renders separate Filter and Inspector sections', () => {
  resetWorkspaceStore();

  const html = renderWorkspace('/');

  assert.match(html, /Inspector/);
  assert.match(html, /Filter is empty/);
  assert.match(html, /Inspector details will appear here after the first run starts and insights are selected\./);
});

test('Workspace shell keeps the right-rail coverage toggle chrome in the main layout', () => {
  resetWorkspaceStore();
  const html = renderWorkspace('/');

  assert.match(html, /Storyline/);
  assert.match(html, /Inspector/);
  assert.match(html, /role="switch"/);
  assert.match(html, /Toggle coverage grid color mode/);
  assert.match(html, />Count</);
  assert.match(html, />Importance</);
});

test('Workspace places storyline pens in the storyline header right side', () => {
  const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-storyline-panel-header="true"/);
  assert.match(source, /data-storyline-header-pen-group="true"/);
  assert.match(source, /StorylinePenToolbar/);
  assert.match(source, /placement="inline"/);
  assert.match(source, /justify-between gap-3/);
  assert.match(source, /flex flex-wrap items-center gap-1/);
  assert.ok(source.indexOf('StorylinePenToolbar') > source.indexOf('Storyline'));
});

test('Workspace requires an uploaded dataset before starting a new conversation', () => {
  const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

  assert.match(source, /uploadedDataset\?\.dataset_path\.trim\(\) \?\? ''/);
  assert.match(source, /Upload a dataset to start the conversation/);
  assert.doesNotMatch(source, /Enter a dataset path/);
});

test('Workspace live-state helpers keep only resumable statuses active', () => {
  assert.equal(shouldKeepRunLive('running'), true);
  assert.equal(shouldKeepRunLive('idle'), true);
  assert.equal(shouldKeepRunLive('completed'), true);
  assert.equal(shouldKeepRunLive('failed'), false);
  assert.equal(shouldKeepRunLive('stopped'), false);
  assert.equal(shouldKeepRunLive(null), false);
});

test('Workspace stream recovery refreshes run status and reuses the same run-live gating', async () => {
  const completed = await recoverRunAfterStreamError('run_workspace', async () => ({
    ...makeWorkspaceRunState('completed'),
    run_id: 'run_workspace',
  }));
  const failed = await recoverRunAfterStreamError('run_workspace', async () => ({
    ...makeWorkspaceRunState('failed'),
    run_id: 'run_workspace',
  }));
  const missing = await recoverRunAfterStreamError('run_workspace', async () => null);

  assert.deepEqual(completed, {
    status: 'completed',
    shouldKeepLive: true,
  });
  assert.deepEqual(failed, {
    status: 'failed',
    shouldKeepLive: false,
  });
  assert.equal(missing, null);
});

test('Workspace detects the started-run transition that should avoid a visible refresh', () => {
  assert.equal(isStartedRunTransition(undefined, 'run_workspace'), false);
  assert.equal(isStartedRunTransition('run_workspace', null), false);
  assert.equal(isStartedRunTransition('run_other', 'run_workspace'), false);
  assert.equal(isStartedRunTransition('run_workspace', 'run_workspace'), true);
});

test('Workspace data-table modal width clamps from the visible column count', () => {
  assert.equal(buildDataTableModalWidth(0), 'min(95vw, 560px)');
  assert.equal(buildDataTableModalWidth(3), 'min(95vw, 560px)');
  assert.equal(buildDataTableModalWidth(12), 'min(95vw, 1000px)');
  assert.equal(buildDataTableModalWidth(Number.NaN), 'min(95vw, 560px)');
});

test('Workspace renders the default sub-agents controls before the status pill', () => {
  const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

  assert.match(source, /workspaceLogo/);
  assert.match(source, /src=\{workspaceLogo\}/);
  assert.match(source, /bg-\[#7F929E\]/);
  assert.match(source, /Default sub-agents/);
  assert.match(source, /aria-label="Default sub-agent count"/);
  assert.match(source, /aria-label="Decrease default sub-agent count"/);
  assert.match(source, /aria-label="Increase default sub-agent count"/);
  assert.match(source, /visibleDefaultSubAgentsNum <= 1/);
  assert.match(source, /visibleDefaultSubAgentsNum >= 6/);
  assert.match(source, /runState\?\.settings\.default_sub_agents_num \?\? 2/);
  assert.match(source, /runState\.insights\.length\} summaries/);
  assert.doesNotMatch(source, /getStatusColor\(runState\.status\)/);
  assert.doesNotMatch(source, /RefreshCw/);
  assert.doesNotMatch(source, /Step \{runState\.step\}/);
  assert.doesNotMatch(source, />\s*\{runState\?\.run_id\}\s*</);
  assert.doesNotMatch(source, />\s*\{runState\?\.dataset_path\}\s*</);
  assert.doesNotMatch(source, /type="range"/);
  assert.doesNotMatch(source, /type="number"/);
});
