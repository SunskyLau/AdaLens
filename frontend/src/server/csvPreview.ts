const CSV_DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;
const CSV_DELIMITER_FALLBACK = ',';

export type CsvDelimiter = (typeof CSV_DELIMITER_CANDIDATES)[number];

function isSupportedCsvDelimiter(value: string): value is CsvDelimiter {
  return (CSV_DELIMITER_CANDIDATES as readonly string[]).includes(value);
}

function countDelimitersOutsideQuotes(text: string, delimiter: CsvDelimiter): number[] {
  const counts: number[] = [];
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      count += 1;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (count > 0) {
        counts.push(count);
      }
      count = 0;
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
    }
  }
  if (count > 0) {
    counts.push(count);
  }
  return counts;
}

export function normalizeCsvDelimiter(value: unknown): CsvDelimiter | null {
  return typeof value === 'string' && isSupportedCsvDelimiter(value) ? value : null;
}

export function sniffCsvDelimiter(text: string): CsvDelimiter {
  const sample = text.slice(0, 16_384);
  if (!sample.trim()) {
    return CSV_DELIMITER_FALLBACK;
  }

  let bestDelimiter: CsvDelimiter = CSV_DELIMITER_FALLBACK;
  let bestScore: [number, number, number] = [-1, -1, -1];

  for (const delimiter of CSV_DELIMITER_CANDIDATES) {
    const counts = countDelimitersOutsideQuotes(sample, delimiter);
    if (counts.length === 0) {
      continue;
    }
    const histogram = new Map<number, number>();
    for (const count of counts) {
      histogram.set(count, (histogram.get(count) ?? 0) + 1);
    }
    let dominantCount = 0;
    for (const frequency of histogram.values()) {
      if (frequency > dominantCount) {
        dominantCount = frequency;
      }
    }
    const score: [number, number, number] = [
      dominantCount,
      counts.length,
      counts.reduce((sum, count) => sum + count, 0),
    ];
    if (
      score[0] > bestScore[0]
      || (score[0] === bestScore[0] && score[1] > bestScore[1])
      || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] > bestScore[2])
    ) {
      bestDelimiter = delimiter;
      bestScore = score;
    }
  }

  return bestDelimiter;
}

function parseCsvRecords(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      pushField();
      pushRow();
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') {
      rows.pop();
      continue;
    }
    break;
  }

  return rows;
}

export function buildCsvPreview(
  text: string,
  rowLimit: number,
  rowOffset: number,
  delimiter: CsvDelimiter
) {
  const records = parseCsvRecords(text, delimiter);
  if (records.length === 0) {
    return {
      delimiter,
      columns: [] as string[],
      rows: [] as string[][],
      row_count: 0,
      offset: 0,
      returned_rows: 0,
      has_more: false,
    };
  }

  const header = records[0];
  const dataRows = records.slice(1);
  const maxCols = dataRows.reduce((acc, r) => Math.max(acc, r.length), header.length);
  const columnCount = Math.max(1, maxCols);

  const columns = Array.from({ length: columnCount }, (_v, idx) => {
    const raw = header[idx];
    const normalized = typeof raw === 'string' && idx === 0 ? raw.replace(/^\ufeff/, '') : raw;
    if (typeof normalized === 'string' && normalized.trim()) {
      return normalized;
    }
    return `col_${idx + 1}`;
  });

  const normalizedRows = dataRows.map((r) =>
    Array.from({ length: columnCount }, (_v, idx) => (idx < r.length ? r[idx] : ''))
  );

  const safeOffset = Math.min(Math.max(rowOffset, 0), normalizedRows.length);
  const rows = normalizedRows.slice(safeOffset, safeOffset + rowLimit);
  return {
    delimiter,
    columns,
    rows,
    row_count: normalizedRows.length,
    offset: safeOffset,
    returned_rows: rows.length,
    has_more: safeOffset + rows.length < normalizedRows.length,
  };
}
