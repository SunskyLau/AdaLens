import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUploadedDatasetFilename,
  DATASET_UPLOAD_MAX_BYTES,
  isAllowedCsvMimeType,
  isCsvUploadFilename,
  sanitizeUploadedCsvFilename,
} from './datasetsUpload.ts';

test('dataset upload helpers accept csv filenames and safe csv mime types', () => {
  assert.equal(isCsvUploadFilename('report.csv'), true);
  assert.equal(isCsvUploadFilename('report.CSV'), true);
  assert.equal(isCsvUploadFilename('report.tsv'), false);

  assert.equal(isAllowedCsvMimeType('text/csv'), true);
  assert.equal(isAllowedCsvMimeType('application/vnd.ms-excel'), true);
  assert.equal(isAllowedCsvMimeType('application/json'), false);
});

test('dataset upload helpers sanitize filenames and preserve csv extension', () => {
  assert.equal(sanitizeUploadedCsvFilename('../Quarterly Sales!.csv'), 'Quarterly_Sales.csv');
  assert.equal(
    buildUploadedDatasetFilename('../Quarterly Sales!.csv', 'abc123'),
    'upload_abc123__Quarterly_Sales.csv'
  );
});

test('dataset upload helpers reject non-csv extensions and keep 64MB limit', () => {
  assert.throws(() => sanitizeUploadedCsvFilename('report.xlsx'), /Only CSV files are supported/);
  assert.equal(DATASET_UPLOAD_MAX_BYTES, 64 * 1024 * 1024);
});
