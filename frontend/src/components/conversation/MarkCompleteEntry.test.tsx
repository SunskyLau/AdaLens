import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import MarkCompleteEntry from './MarkCompleteEntry.tsx';

test('MarkCompleteEntry renders full markdown and does not interpret raw html', () => {
  const html = renderToStaticMarkup(
    <MarkCompleteEntry
      entry={{
        id: 'entry_1',
        type: 'mark_complete',
        timestamp: '2026-03-08T00:00:00',
        summary: [
          '# Final Summary',
          'Intro paragraph.',
          '',
          '1. **First finding**',
          '2. Second finding',
          '',
          '| Region | Sales |',
          '| --- | ---: |',
          '| NA | 100 |',
          '',
          'Closing line',
          'with preserved newline.',
          '',
          '<span>raw html should not render</span>',
        ].join('\n'),
      }}
    />
  );

  assert.match(html, /<h1[^>]*>Final Summary<\/h1>/);
  assert.match(html, /<p[^>]*>Intro paragraph\.<\/p>/);
  assert.match(html, /<ol[^>]*>/);
  assert.match(html, /<strong>First finding<\/strong>/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /Closing line<br\/>\s*with preserved newline\./);
  assert.doesNotMatch(html, /<span>raw html should not render<\/span>/);
  assert.match(html, /&lt;span&gt;raw html should not render&lt;\/span&gt;/);
});

test('MarkCompleteEntry preserves ordered-list start values after nested bullets', () => {
  const html = renderToStaticMarkup(
    <MarkCompleteEntry
      entry={{
        id: 'entry_2',
        type: 'mark_complete',
        timestamp: '2026-03-08T00:00:00',
        summary: [
          '4. Fourth section',
          'Context before bullets:',
          '',
          '- nested point',
          '',
          '5. Fifth section',
        ].join('\n'),
      }}
    />
  );

  assert.match(html, /<ol[^>]*start="4"[^>]*>/);
  assert.match(html, /<ol[^>]*start="5"[^>]*>/);
});

test('MarkCompleteEntry encourages follow-up conversation after completion', () => {
  const html = renderToStaticMarkup(
    <MarkCompleteEntry
      entry={{
        id: 'entry_3',
        type: 'mark_complete',
        timestamp: '2026-03-08T00:00:00',
        summary: 'Analysis finished.',
      }}
    />
  );

  assert.match(
    html,
    /You can continue chatting below to explore further or start a new analysis direction\./
  );
});
