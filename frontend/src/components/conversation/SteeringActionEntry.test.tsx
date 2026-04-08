import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import SteeringActionEntry from './SteeringActionEntry.tsx';
import type { ConversationEntry } from '@/types';

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'entry_steer_1',
    type: 'steering_action',
    timestamp: '2026-03-16T12:00:00.000Z',
    text: 'Revenue spike',
    displayText: 'Revenue spike',
    steeringKind: 'focus',
    targetKind: 'summary',
    targetLabel: 'Revenue spike',
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue', 'Quarter'],
    },
    generatedPrompt: 'Focus on this summary target.',
    userPrompt: 'Focus follow-up analysis on the summary "Revenue spike".',
    systemPrompt: 'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.',
    ...overrides,
  };
}

test('SteeringActionEntry makes the whole preview body clickable for replay', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry()}
      onActivateTarget={() => undefined}
    />
  );

  assert.match(html, /<button[^>]*data-steering-entry-card-body="true"/);
  assert.match(html, /data-steering-entry-title="true"/);
  assert.match(html, /data-steering-card-title-kind="focus"/);
  assert.match(html, /data-steering-card-title-icon="focus"/);
  assert.match(html, /Focus follow-up analysis on the summary &quot;Revenue spike&quot;\./);
  assert.match(html, /text-left/);
  assert.doesNotMatch(html, /text-right/);
  assert.doesNotMatch(html, />Preview</);
  assert.doesNotMatch(html, /data-steering-generated-prompt="true"/);
});

test('SteeringActionEntry falls back to historical display text when preview text is absent', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        displayText: 'Focus Revenue spike',
        text: 'Focus Revenue spike',
        generatedPrompt: undefined,
        userPrompt: undefined,
      })}
    />
  );

  assert.match(html, /Focus Revenue spike/);
});

test('SteeringActionEntry renders create styling without a replay hit target when target is absent', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        steeringKind: 'create',
        text: 'Check whether Q4 growth is concentrated in a single segment',
        displayText: 'Check whether Q4 growth is concentrated in a single segment',
        targetKind: undefined,
        targetLabel: undefined,
        target: null,
        generatedPrompt: '',
        userPrompt: undefined,
      })}
      onActivateTarget={() => undefined}
    />
  );

  assert.match(html, /Create/);
  assert.match(
    html,
    /data-steering-card-title-icon="create"[^>]*border-emerald-200 bg-emerald-100 text-emerald-700/
  );
  assert.doesNotMatch(html, /<button[^>]*data-steering-entry-card-body="true"/);
  assert.match(html, /<div[^>]*data-steering-entry-card-body="true"/);
});

test('SteeringActionEntry prefers userPrompt in the main body and keeps systemPrompt hidden', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        generatedPrompt: 'Legacy generated prompt',
        userPrompt: 'Focus follow-up analysis on the summary "Revenue spike".',
        systemPrompt: 'Do not show this hidden system prompt.',
      })}
    />
  );

  assert.match(html, /Focus follow-up analysis on the summary &quot;Revenue spike&quot;\./);
  assert.doesNotMatch(html, /Legacy generated prompt/);
  assert.doesNotMatch(html, /Do not show this hidden system prompt\./);
  assert.doesNotMatch(html, /data-steering-generated-prompt="true"/);
});

test('SteeringActionEntry renders a persistent highlighted state for the focused steering message', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry()}
      isHighlighted
    />
  );

  assert.match(html, /data-steering-entry-id="entry_steer_1"/);
  assert.match(html, /data-steering-entry-highlighted="true"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /ring-2 ring-sky-200\/70/);
});

test('SteeringActionEntry renders summary steering as direct preview text without keywords or target sections', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        selectedKeywords: ['Revenue', 'Q4'],
        userPrompt: 'Focus on the gender-related participation pattern and keep the explanation tied to this current finding.',
      })}
    />
  );

  assert.match(html, /Focus on the gender-related participation pattern and keep the explanation tied to this current finding\./);
  assert.doesNotMatch(html, /data-steering-entry-keywords="true"/);
  assert.doesNotMatch(html, /data-steering-entry-section-title="target"/);
  assert.doesNotMatch(html, /data-steering-entry-target-lead="true"/);
  assert.doesNotMatch(html, /data-steering-entry-target-text="true"/);
  assert.doesNotMatch(html, />Preview</);
});

test('SteeringActionEntry renders elaborate styling with direct preview text', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        steeringKind: 'elaborate',
        userPrompt: 'Keep digging into this one specific insight and explain why the Q4 spike happens.',
        targetKind: 'atomic',
        targetLabel: 'Revenue spike',
        target: {
          kind: 'atomic',
          summary_id: 's1',
          summary_short_label: 'Revenue spike',
          summary_text: 'Revenue spikes in Q4.',
          columns: ['Revenue', 'Quarter'],
          atomic_id: 'a1',
          atomic_text: 'Revenue spikes specifically in Q4.',
          insight_type: 'trend',
        },
      })}
    />
  );

  assert.match(html, /Elaborate/);
  assert.match(
    html,
    /data-steering-card-title-icon="elaborate"[^>]*border-sky-200 bg-sky-100 text-sky-700/
  );
  assert.match(html, /Keep digging into this one specific insight and explain why the Q4 spike happens\./);
  assert.doesNotMatch(html, /data-steering-entry-section-title="target"/);
  assert.doesNotMatch(html, /data-steering-entry-target-lead="true"/);
  assert.doesNotMatch(html, /data-steering-entry-target-text="true"/);
});

test('SteeringActionEntry renders column steering as direct preview text', () => {
  const html = renderToStaticMarkup(
    <SteeringActionEntry
      entry={makeEntry({
        steeringKind: 'ignore',
        userPrompt: 'Do not spend more time on Revenue and Region for now.',
        targetKind: 'column',
        targetLabel: 'Revenue',
        target: {
          kind: 'column',
          summary_id: '',
          summary_short_label: '',
          summary_text: '',
          columns: ['Revenue', 'Region'],
        },
      })}
    />
  );

  assert.match(html, /Ignore/);
  assert.match(html, /Do not spend more time on Revenue and Region for now\./);
  assert.doesNotMatch(html, /data-steering-entry-section-title="column"/);
  assert.doesNotMatch(html, /data-steering-entry-target-text="true"/);
  assert.doesNotMatch(html, />Target</);
  assert.doesNotMatch(html, />Column</);
});
