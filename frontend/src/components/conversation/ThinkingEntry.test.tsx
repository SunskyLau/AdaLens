import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ThinkingEntry, { resolveThinkingEntryDisplay } from './ThinkingEntry.tsx';
import type { ConversationEntry } from '@/types';

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'thinking_1',
    type: 'thinking',
    timestamp: '2026-03-21T10:00:00.000Z',
    text: '{"tool_names":["respond_to_user","create_plans"]}',
    loopCount: 3,
    toolNames: [],
    ...overrides,
  };
}

test('resolveThinkingEntryDisplay normalizes machine-only tool metadata and preserves human-readable reasoning', () => {
  const machineOnlyDisplay = resolveThinkingEntryDisplay(
    makeEntry({
      text: '{"tool_names":["respond_to_user","create_plans","respond_to_user"]}',
    })
  );
  const humanReadableDisplay = resolveThinkingEntryDisplay(
    makeEntry({
      text: 'I can summarize now because the regional and platform loops have converged.',
      toolNames: ['respond_to_user'],
    })
  );

  assert.deepEqual(machineOnlyDisplay.toolNames, ['respond_to_user', 'create_plans']);
  assert.equal(machineOnlyDisplay.humanText, '');
  assert.equal(machineOnlyDisplay.machineOnly, true);
  assert.deepEqual(humanReadableDisplay.toolNames, ['respond_to_user']);
  assert.equal(
    humanReadableDisplay.humanText,
    'I can summarize now because the regional and platform loops have converged.'
  );
  assert.equal(humanReadableDisplay.machineOnly, false);
});

test('ThinkingEntry keeps the loop header stable and shows tool summary/chips only when expanded', () => {
  const collapsedHtml = renderToStaticMarkup(<ThinkingEntry entry={makeEntry()} />);
  const expandedHtml = renderToStaticMarkup(<ThinkingEntry entry={makeEntry()} initialExpanded />);

  assert.match(collapsedHtml, /Loop #3/);
  assert.doesNotMatch(collapsedHtml, /tool_names/);
  assert.match(collapsedHtml, /data-thinking-entry-tool-summary="true"/);
  assert.match(collapsedHtml, /2 tool\(s\) invoked/);
  assert.doesNotMatch(collapsedHtml, /data-thinking-entry-tool-chips="true"/);
  assert.match(expandedHtml, /Loop #3/);
  assert.match(expandedHtml, /data-thinking-entry-tool-summary="true"/);
  assert.match(expandedHtml, /2 tool\(s\) invoked/);
  assert.match(expandedHtml, /respond_to_user/);
  assert.match(expandedHtml, /create_plans/);
  assert.match(expandedHtml, /whitespace-nowrap/);
});
