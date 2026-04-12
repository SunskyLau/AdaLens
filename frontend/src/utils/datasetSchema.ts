export type ColumnKind = 'number' | 'category';

function normalizeName(name: string): string {
  return (name || '').replace(/\s+/g, ' ').trim();
}

function dedupeColumns(columns: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of columns) {
    const col = normalizeName(raw);
    if (!col) continue;
    const key = col.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(col);
  }
  return out;
}

export function parseDatasetSchemaColumns(schemaText: string): string[] {
  if (!schemaText) return [];
  const match = schemaText.match(/Columns:\s*\[([\s\S]*?)\]/i);
  if (!match) return [];
  const inside = match[1] || '';

  // Prefer strict JSON parsing when backend emits `Columns: ["A", "B"]`.
  try {
    const parsed = JSON.parse(`[${inside}]`) as unknown;
    if (Array.isArray(parsed)) {
      return dedupeColumns(parsed.map((col) => normalizeName(String(col))));
    }
  } catch {
    // Fall through to legacy text parsing.
  }

  const cols: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inside)) !== null) {
    const name = normalizeName(m[1] ?? m[2] ?? '');
    if (name) cols.push(name);
  }

  // Last-resort parser for malformed/legacy schema strings.
  if (cols.length === 0) {
    for (const token of inside.split(',')) {
      const stripped = normalizeName(token.replace(/^['"]|['"]$/g, ''));
      if (stripped) cols.push(stripped);
    }
  }

  return dedupeColumns(cols);
}

function inferColumnKindFromDtype(dtypeText: string): ColumnKind {
  const dtype = (dtypeText || '').trim().toLowerCase();
  if (!dtype) return 'category';
  if (
    dtype.includes('int') ||
    dtype.includes('float') ||
    dtype.includes('double') ||
    dtype.includes('decimal') ||
    dtype.includes('numeric') ||
    dtype.includes('number')
  ) {
    return 'number';
  }
  return 'category';
}

export function parseDatasetSchemaColumnKinds(schemaText: string): Map<string, ColumnKind> {
  const columns = parseDatasetSchemaColumns(schemaText);
  const typeMap = new Map<string, ColumnKind>();

  for (const col of columns) {
    typeMap.set(col, 'category');
  }

  if (!schemaText || columns.length === 0) {
    return typeMap;
  }

  const dataTypeMatch = schemaText.match(/Data types:\s*\r?\n([\s\S]*)$/i);
  if (!dataTypeMatch) {
    return typeMap;
  }

  const lines = dataTypeMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sortedColumns = [...columns].sort((a, b) => b.length - a.length);

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\ufeff/, '');
    const matchedColumn = sortedColumns.find((col) => {
      if (!line.startsWith(col)) return false;
      const rest = line.slice(col.length);
      return !!rest && /^\s+/.test(rest);
    });
    if (!matchedColumn) continue;

    const dtypeText = line.slice(matchedColumn.length).trim();
    if (!dtypeText) continue;
    typeMap.set(matchedColumn, inferColumnKindFromDtype(dtypeText));
  }

  return typeMap;
}

export function getColumnKind(columnName: string, typeMap: Map<string, ColumnKind>): ColumnKind {
  const normalized = normalizeName(columnName);
  if (!normalized) return 'category';

  const direct = typeMap.get(normalized);
  if (direct) return direct;

  const lower = normalized.toLowerCase();
  for (const [name, kind] of typeMap.entries()) {
    if (name.toLowerCase() === lower) return kind;
  }

  return 'category';
}
