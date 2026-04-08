import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import AgentResponseEntry from './AgentResponseEntry.tsx';

test('AgentResponseEntry renders inline citations through NarrativeMarkdown', () => {
  const html = renderToStaticMarkup(
    <AgentResponseEntry
      entry={{
        id: 'agent_response_1',
        type: 'agent_response',
        timestamp: '2026-03-22T12:00:00.000Z',
        text: 'Checkpoint is justified by the latest summary [[1]].',
        markdownBody: 'Checkpoint is justified by the latest summary [[1]].',
        citations: [
          {
            marker: 1,
            label: 'Revenue spike',
            target: {
              kind: 'summary',
              summary_id: 'summary_1',
              summary_short_label: 'Revenue spike',
              summary_text: 'Revenue spikes in Q4.',
              columns: ['Revenue', 'Quarter'],
            },
          },
        ],
      }}
      onActivateCitation={() => undefined}
    />
  );

  assert.match(html, /data-provenance-marker="1"/);
  assert.match(html, /<button[^>]*title="Revenue spike"/);
  assert.match(html, /Checkpoint is justified by the latest summary/);
});
