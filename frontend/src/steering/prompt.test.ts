import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeSteeringPreviewDraft,
  composeEditableUserPrompt,
  deriveSteeringPreviewSuffix,
  normalizeEditableSteeringPreview,
} from './prompt.ts';

test('normalizeEditableSteeringPreview removes blank lines while preserving non-empty lines', () => {
  assert.equal(
    normalizeEditableSteeringPreview('Focus this summary.\n\n\nExplain the key driver.'),
    'Focus this summary.\nExplain the key driver.'
  );
  assert.equal(
    normalizeEditableSteeringPreview('\n  Focus this summary.\n   \nExplain the key driver.\n'),
    'Focus this summary.\nExplain the key driver.'
  );
});

test('composeEditableUserPrompt uses the normalized preview without empty lines', () => {
  assert.equal(
    composeEditableUserPrompt({
      preview: 'Focus this summary.\n\nExplain the key driver.',
      background: 'Revenue spikes in Q4.',
    }),
    'Focus this summary.\nExplain the key driver.\n\nBackground:\nRevenue spikes in Q4.'
  );
});

test('composeEditableUserPrompt omits background when the toggle is unchecked', () => {
  assert.equal(
    composeEditableUserPrompt({
      preview: 'Focus this summary.\n\nExplain the key driver.',
      background: 'Revenue spikes in Q4.',
      includeBackground: false,
    }),
    'Focus this summary.\nExplain the key driver.'
  );
});

test('composeEditableUserPrompt localizes the background heading for Chinese previews', () => {
  assert.equal(
    composeEditableUserPrompt({
      preview: '\u8bf7\u7ee7\u7eed\u5173\u6ce8\u8fd9\u4e2a\u603b\u7ed3\u3002',
      background: 'Revenue spikes in Q4.',
      language: 'zh',
    }),
    '\u8bf7\u7ee7\u7eed\u5173\u6ce8\u8fd9\u4e2a\u603b\u7ed3\u3002\n\n\u80cc\u666f\uff1a\nRevenue spikes in Q4.'
  );
});

test('preview suffix helpers keep the generated prefix fresh while preserving appended user text', () => {
  const generatedBase = 'Focus follow-up analysis on the summary "Revenue spike".';
  const previewDraft = composeSteeringPreviewDraft(
    generatedBase,
    'Please compare Europe and North America next.'
  );

  assert.equal(
    previewDraft,
    'Focus follow-up analysis on the summary "Revenue spike".\nPlease compare Europe and North America next.'
  );
  assert.equal(
    deriveSteeringPreviewSuffix(previewDraft, generatedBase),
    'Please compare Europe and North America next.'
  );
  assert.equal(
    deriveSteeringPreviewSuffix('Custom prefix rewrite\nPlease compare Europe and North America next.', generatedBase),
    null
  );
});
