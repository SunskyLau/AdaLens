import { existsSync } from 'node:fs';
import path from 'node:path';

function appendCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const resolved = path.resolve(value);
  if (seen.has(resolved)) {
    return;
  }
  seen.add(resolved);
  candidates.push(resolved);
}

export function resolveDatasetPathFromState(rawPath: string, repoRoot: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return '';
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
  appendCandidate(candidates, seen, absolutePath);

  const normalized = trimmed.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const dataIndex = lowerSegments.lastIndexOf('data');
  if (dataIndex >= 0 && dataIndex < segments.length - 1) {
    appendCandidate(candidates, seen, path.join(repoRoot, 'data', ...segments.slice(dataIndex + 1)));
  }

  appendCandidate(candidates, seen, path.join(repoRoot, 'data', path.basename(trimmed)));

  return candidates.find((candidate) => existsSync(candidate)) ?? absolutePath;
}
