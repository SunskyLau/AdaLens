import type {
  LegacySoftSteeringKind,
  SteeringActionKind,
  SoftSteeringKind,
  SteeringMessageKind,
  SteeringMessageKindInput,
} from '@/types';

const LEGACY_SOFT_STEERING_KIND_MAP: Record<LegacySoftSteeringKind, SoftSteeringKind> = {
  dive_into: 'focus',
  cut_off: 'ignore',
  suppress: 'ignore',
};

export function normalizeSoftSteeringKind(
  kind: SteeringMessageKindInput | string | null | undefined
): SoftSteeringKind | null {
  if (kind === 'focus' || kind === 'ignore' || kind === 'elaborate') {
    return kind;
  }
  if (kind === 'dive_into' || kind === 'cut_off' || kind === 'suppress') {
    return LEGACY_SOFT_STEERING_KIND_MAP[kind];
  }
  return null;
}

export function isSoftSteeringKind(
  kind: SteeringMessageKindInput | string | null | undefined
): kind is SoftSteeringKind {
  return normalizeSoftSteeringKind(kind) !== null;
}

export function normalizeSteeringActionKind(
  kind: SteeringMessageKindInput | string | null | undefined
): SteeringActionKind | null {
  const normalizedSoftKind = normalizeSoftSteeringKind(kind);
  if (normalizedSoftKind) {
    return normalizedSoftKind;
  }
  if (kind === 'create') {
    return kind;
  }
  return null;
}

export function normalizeSteeringMessageKind(
  kind: SteeringMessageKindInput | string | null | undefined
): SteeringMessageKind | undefined {
  const normalizedActionKind = normalizeSteeringActionKind(kind);
  if (normalizedActionKind) {
    return normalizedActionKind;
  }
  if (kind === 'chat') {
    return kind;
  }
  return undefined;
}

export function getSoftSteeringDisplayLabel(
  kind: SoftSteeringKind
): 'Focus' | 'Ignore' | 'Elaborate' {
  if (kind === 'ignore') {
    return 'Ignore';
  }
  if (kind === 'elaborate') {
    return 'Elaborate';
  }
  return 'Focus';
}

export function getSteeringActionDisplayLabel(
  kind: SteeringActionKind
): 'Focus' | 'Ignore' | 'Elaborate' | 'Create' {
  if (kind === 'create') {
    return 'Create';
  }
  return getSoftSteeringDisplayLabel(kind);
}
