/**
 * Coverage-cell selection encoding for cross-panel sync.
 *
 * We keep selection.id as a string in global state, but encode structured
 * payloads to avoid delimiter collisions with arbitrary column names.
 */

export interface CoverageCellSelectionPayload {
  taxonomyId: string;
  column: string;
}

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim();
}

function isValidPayload(value: unknown): value is CoverageCellSelectionPayload {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  const taxonomyId = normalizeToken(raw.taxonomyId);
  const column = normalizeToken(raw.column);
  return Boolean(taxonomyId && column);
}

export function encodeCoverageCellSelectionId(payload: CoverageCellSelectionPayload): string {
  const normalized = {
    taxonomyId: normalizeToken(payload.taxonomyId),
    column: normalizeToken(payload.column),
  };
  return `cov:${encodeURIComponent(JSON.stringify(normalized))}`;
}

function decodeLegacyCoverageCellId(
  legacyId: string
): CoverageCellSelectionPayload | null {
  const parts = legacyId.split('||');
  if (parts.length !== 2) return null;
  const taxonomyId = normalizeToken(parts[0]);
  const axisKey = normalizeToken(parts[1]);
  if (!taxonomyId || !axisKey) return null;

  const column = axisKey.startsWith('single::')
    ? axisKey.slice('single::'.length)
    : axisKey;
  if (!column) return null;

  return { taxonomyId, column };
}

export function decodeCoverageCellSelectionId(
  selectionId: string | null
): CoverageCellSelectionPayload | null {
  if (!selectionId) return null;

  if (selectionId.startsWith('cov:')) {
    try {
      const decoded = decodeURIComponent(selectionId.slice(4));
      const payload = JSON.parse(decoded) as unknown;
      if (!isValidPayload(payload)) return null;
      return {
        taxonomyId: normalizeToken(payload.taxonomyId),
        column: normalizeToken(payload.column),
      };
    } catch {
      return null;
    }
  }

  // Backward compatibility for pre-encoded in-memory selection IDs.
  return decodeLegacyCoverageCellId(selectionId);
}

export function buildCoverageCellMapKey(taxonomyId: string, column: string): string {
  return JSON.stringify([normalizeToken(taxonomyId), normalizeToken(column)]);
}
