import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCsvPreview, sniffCsvDelimiter } from './csvPreview.ts';

test('sniffCsvDelimiter detects semicolon-delimited CSV content', () => {
  const text = [
    'Region;Revenue;Quarter',
    'NA;120;Q4',
    'EU;90;Q4',
  ].join('\n');

  assert.equal(sniffCsvDelimiter(text), ';');
});

test('buildCsvPreview parses tab-delimited CSV rows with the provided delimiter', () => {
  const text = [
    'Region\tRevenue\tQuarter',
    'NA\t120\tQ4',
    'EU\t90\tQ4',
  ].join('\n');

  const preview = buildCsvPreview(text, 10, 0, '\t');

  assert.equal(preview.delimiter, '\t');
  assert.deepEqual(preview.columns, ['Region', 'Revenue', 'Quarter']);
  assert.deepEqual(preview.rows, [
    ['NA', '120', 'Q4'],
    ['EU', '90', 'Q4'],
  ]);
});
