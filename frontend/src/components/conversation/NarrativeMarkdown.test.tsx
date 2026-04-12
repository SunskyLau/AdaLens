import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import NarrativeMarkdown from './NarrativeMarkdown.tsx';

test('NarrativeMarkdown renders inline citation markers as clickable superscripts when metadata exists', () => {
  const html = renderToStaticMarkup(
    <NarrativeMarkdown
      markdown="Revenue spikes in Q4 [[1]]."
      citations={[
        {
          marker: 1,
          label: 'Revenue spike summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
      ]}
      onActivateCitation={() => undefined}
    />
  );

  assert.match(html, /data-provenance-marker="1"/);
  assert.match(html, /<button[^>]*title="Revenue spike summary"/);
});

test('NarrativeMarkdown degrades missing citation metadata to plain superscript text', () => {
  const html = renderToStaticMarkup(
    <NarrativeMarkdown markdown="Revenue spikes in Q4 [[2]]." citations={[]} />
  );

  assert.match(html, /<sup[^>]*data-provenance-marker="2"[^>]*>2<\/sup>/);
  assert.doesNotMatch(html, /<button[^>]*data-provenance-marker="2"/);
});

test('NarrativeMarkdown renders grouped inline citations as one superscript cluster with individually clickable markers', () => {
  const html = renderToStaticMarkup(
    <NarrativeMarkdown
      markdown="Revenue spikes in Q4 [[1,3]]."
      citations={[
        {
          marker: 1,
          label: 'Revenue spike summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
        {
          marker: 3,
          label: 'North America atomic insight',
          target: {
            kind: 'atomic',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Region'],
            atomic_id: 'atomic_3',
            atomic_text: 'North America grows fastest in Q4.',
            insight_type: 'trend',
          },
        },
      ]}
      onActivateCitation={() => undefined}
    />
  );

  assert.match(html, /data-provenance-markers="1,3"/);
  assert.match(html, /data-provenance-marker="1"/);
  assert.match(html, /data-provenance-marker="3"/);
  assert.match(html, /North America atomic insight/);
  assert.doesNotMatch(html, /\[\[1,3\]\]/);
});

test('NarrativeMarkdown preserves adjacent citation groups like [[1]],[[2,7]]', () => {
  const html = renderToStaticMarkup(
    <NarrativeMarkdown
      markdown="Revenue spikes in Q4 [[1]],[[2,7]]."
      citations={[
        {
          marker: 1,
          label: 'Revenue spike summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
        {
          marker: 2,
          label: 'Regional split summary',
          target: {
            kind: 'summary',
            summary_id: 'summary_2',
            summary_short_label: 'Regional split',
            summary_text: 'Regions diverge in Q4.',
            columns: ['Revenue', 'Region'],
          },
        },
        {
          marker: 7,
          label: 'North America atomic insight',
          target: {
            kind: 'atomic',
            summary_id: 'summary_2',
            summary_short_label: 'Regional split',
            summary_text: 'Regions diverge in Q4.',
            columns: ['Revenue', 'Region'],
            atomic_id: 'atomic_7',
            atomic_text: 'North America grows fastest in Q4.',
            insight_type: 'trend',
          },
        },
      ]}
      onActivateCitation={() => undefined}
    />
  );

  assert.match(html, /data-provenance-marker="1"/);
  assert.match(html, /data-provenance-markers="2,7"/);
  assert.match(html, /<\/sup>,<sup/);
  assert.doesNotMatch(html, /\[\[1\]\],\[\[2,7\]\]/);
});

test('NarrativeMarkdown keeps punctuation while degrading unmatched grouped citations to plain superscripts', () => {
  const html = renderToStaticMarkup(
    <NarrativeMarkdown markdown="Revenue spikes in Q4 [[1]],[[2,7]]." citations={[]} />
  );

  assert.match(html, /<sup[^>]*data-provenance-marker="1"[^>]*>1<\/sup>,<sup[^>]*data-provenance-markers="2,7"/);
  assert.match(html, /data-provenance-marker="2"/);
  assert.match(html, /data-provenance-marker="7"/);
  assert.doesNotMatch(html, /<button[^>]*data-provenance-marker="1"/);
});
