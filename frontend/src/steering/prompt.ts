import type { SteeringTargetSnapshot } from '@/types';

import {
  getSteeringBackgroundHeading,
  type SteeringPreviewLanguage,
} from './language';
import { formatTargetColumns } from './target';

const STEERING_KEYWORD_LIMIT = 10;
const STEERING_PREVIEW_LABEL_MAX_CHARS = 72;

function truncateSteeringPreviewText(text: string, maxChars = STEERING_PREVIEW_LABEL_MAX_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function normalizeSteeringKeywords(
  keywords: readonly string[] | null | undefined,
  limit = STEERING_KEYWORD_LIMIT
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawKeyword of keywords ?? []) {
    const keyword = String(rawKeyword ?? '').trim();
    if (!keyword) {
      continue;
    }
    const lookupKey = keyword.toLocaleLowerCase();
    if (seen.has(lookupKey)) {
      continue;
    }
    seen.add(lookupKey);
    normalized.push(keyword);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

export function normalizeEditableSteeringPreview(preview: string): string {
  return preview
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

export function buildSteeringTargetPreviewLabel(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return formatTargetColumns(target);
  }
  if (target.kind === 'atomic') {
    const atomicText = target.atomic_text?.trim();
    if (atomicText) {
      return truncateSteeringPreviewText(atomicText);
    }
    const atomicId = target.atomic_id?.trim();
    if (atomicId) {
      return atomicId;
    }
  }
  return buildSteeringParentSummaryPreviewLabel(target);
}

export function buildSteeringParentSummaryPreviewLabel(target: SteeringTargetSnapshot): string {
  const summaryLabel = target.summary_short_label.trim();
  if (summaryLabel) {
    return summaryLabel;
  }
  return target.summary_id || 'this summary';
}

export function getEditableSteeringBackgroundText(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return '';
  }
  if (target.kind === 'atomic') {
    return target.atomic_text?.trim() || target.summary_text.trim();
  }
  return target.summary_text.trim();
}

export function composeSteeringPreviewDraft(
  generatedPreviewBase: string,
  appendedPreviewText?: string | null
): string {
  const base = normalizeEditableSteeringPreview(generatedPreviewBase);
  const suffix = normalizeEditableSteeringPreview(appendedPreviewText ?? '');
  if (!base) {
    return suffix;
  }
  if (!suffix) {
    return base;
  }
  return `${base}\n${suffix}`;
}

export function deriveSteeringPreviewSuffix(
  previewDraft: string,
  generatedPreviewBase: string
): string | null {
  const normalizedDraft = normalizeEditableSteeringPreview(previewDraft);
  const normalizedBase = normalizeEditableSteeringPreview(generatedPreviewBase);
  if (!normalizedDraft) {
    return '';
  }
  if (!normalizedBase) {
    return normalizedDraft;
  }
  if (normalizedDraft === normalizedBase) {
    return '';
  }
  if (!normalizedDraft.startsWith(normalizedBase)) {
    return null;
  }
  const remainder = normalizedDraft.slice(normalizedBase.length).replace(/^\n+/, '');
  return normalizeEditableSteeringPreview(remainder);
}

export function composeEditableUserPrompt(args: {
  preview: string;
  background?: string | null;
  includeBackground?: boolean;
  language?: SteeringPreviewLanguage;
}): string {
  const preview = normalizeEditableSteeringPreview(args.preview);
  if (args.includeBackground === false) {
    return preview;
  }
  const background = (args.background ?? '').trim();
  const backgroundHeading = getSteeringBackgroundHeading(args.language ?? 'en');
  if (!background) {
    return preview;
  }
  if (!preview) {
    return `${backgroundHeading}\n${background}`;
  }
  return `${preview}\n\n${backgroundHeading}\n${background}`;
}

export function buildKeywordPriorityDisplayText(
  target: SteeringTargetSnapshot,
  selectedKeywords: readonly string[] | null | undefined,
  backgroundText?: string | null
): string {
  const keywords = normalizeSteeringKeywords(selectedKeywords);
  const background = (backgroundText ?? getEditableSteeringBackgroundText(target)).trim();
  return [
    keywords.length > 0 ? keywords.join(', ') : '',
    background,
  ].filter(Boolean).join('\n\n');
}
