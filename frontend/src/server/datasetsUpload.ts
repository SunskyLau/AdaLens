import path from 'path';

export const DATASET_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const DATASET_UPLOAD_FIELD_NAME = 'file';
export const DATASET_UPLOAD_SUBDIR = '_uploads';

const CSV_MIME_TYPES = new Set([
  '',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
]);

export function isCsvUploadFilename(filename: string): boolean {
  return path.extname(path.basename(filename)).toLowerCase() === '.csv';
}

export function isAllowedCsvMimeType(mimeType: string | null | undefined): boolean {
  return CSV_MIME_TYPES.has((mimeType ?? '').trim().toLowerCase());
}

export function sanitizeUploadedCsvFilename(filename: string): string {
  const basename = path.basename(filename).replace(/\0/g, '');
  const ext = path.extname(basename).toLowerCase();
  if (ext !== '.csv') {
    throw new Error('Only CSV files are supported');
  }
  const stem = path.basename(basename, path.extname(basename));
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
  return `${safeStem}.csv`;
}

export function buildUploadedDatasetFilename(originalFilename: string, uuid: string): string {
  const safeFilename = sanitizeUploadedCsvFilename(originalFilename);
  return `upload_${uuid}__${safeFilename}`;
}
