import type { RunState, SteerRunRequest, SteeringTargetSnapshot } from '@/types';

import {
  formatSteeringPreviewList,
  resolveSteeringPreviewLanguage,
  type SteeringPreviewLanguage,
} from './language';
import { buildColumnSummaryOverview, formatTargetColumns, getSteeringTargetLabel } from './target';
import {
  buildKeywordPriorityDisplayText,
  composeEditableUserPrompt,
  getEditableSteeringBackgroundText,
  normalizeEditableSteeringPreview,
  normalizeSteeringKeywords,
} from './prompt';

function buildFocusDisplayTarget(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return target.columns.join(', ');
  }
  return getSteeringTargetLabel(target);
}

export function buildFocusUserPromptPreview(
  target: SteeringTargetSnapshot,
  options?: { selectedKeywords?: string[]; language?: SteeringPreviewLanguage }
): string {
  const language = options?.language ?? 'en';
  if (target.kind === 'column') {
    const columns = formatSteeringPreviewList(target.columns, language) || formatTargetColumns(target);
    if (language === 'zh') {
      return `\u8bf7\u7ee7\u7eed\u56f4\u7ed5\u6570\u636e\u5217 ${columns} \u5f00\u5c55\u540e\u7eed\u5206\u6790\u3002`;
    }
    return target.columns.length > 1
      ? `Focus follow-up analysis on the dataset columns ${formatTargetColumns(target)}.`
      : `Focus follow-up analysis on the dataset column ${target.columns[0] ?? 'this column'}.`;
  }
  const selectedKeywords = normalizeSteeringKeywords(options?.selectedKeywords);
  if (selectedKeywords.length === 0) {
    return '';
  }
  const keywordText = formatSteeringPreviewList(selectedKeywords, language);
  const keywordClause = selectedKeywords.join(', ');
  if (target.kind === 'atomic') {
    if (language === 'zh') {
      return `\u8bf7\u5728\u540e\u7eed\u5206\u6790\u4e2d\u91cd\u70b9\u5173\u6ce8${keywordText}\u3002`;
    }
    return `In follow-up analysis, prioritize ${keywordClause} for this atomic insight.`;
  }
  if (language === 'zh') {
    return `\u8bf7\u5728\u540e\u7eed\u5206\u6790\u4e2d\u91cd\u70b9\u5173\u6ce8${keywordText}\u3002`;
  }
  return `In follow-up analysis, prioritize ${keywordClause} for this summary.`;
}

export function buildFocusSystemPrompt(
  runState: RunState,
  target: SteeringTargetSnapshot,
  options?: { selectedKeywords?: string[] }
): string {
  const label = getSteeringTargetLabel(target);
  const summaryLabel = target.summary_short_label || target.summary_id || '(none provided)';
  const selectedKeywords = normalizeSteeringKeywords(options?.selectedKeywords);
  const coreText = getEditableSteeringBackgroundText(target) || '(none provided)';
  if (target.kind === 'column') {
    const isMultiColumn = target.columns.length > 1;
    return [
      'Focus steering semantics:',
      isMultiColumn
        ? '- Continue allocating attention around this dataset column group in future planning.'
        : '- Continue allocating attention around this dataset column in future planning.',
      '- Prefer deeper validation, comparison, explanation, and expansion around findings that involve these columns.',
      '- Do not cancel or rewrite sub-agents that are already running.',
      `Target kind: ${target.kind}`,
      `Columns: ${formatTargetColumns(target)}`,
      'Current run summaries touching these columns:',
      buildColumnSummaryOverview(runState, target.columns),
    ].join('\n');
  }
  return [
    'Focus steering semantics:',
    `- Continue allocating attention around this ${target.kind} target in subsequent planning.`,
    '- Prioritize drill down, validation, comparison, explanation, and expansion around the selected keywords when they are provided.',
    '- Treat the user-authored background as contextual evidence for interpretation, not as a request to branch broadly.',
    '- Do not cancel or rewrite sub-agents that are already running.',
    `Target kind: ${target.kind}`,
    `Target label: ${label}`,
    `Target summary label: ${summaryLabel}`,
    `Selected keywords: ${
      selectedKeywords.length > 0 ? selectedKeywords.join(', ') : '(none provided)'
    }`,
    `Core background text: ${coreText}`,
    `Related columns: ${formatTargetColumns(target)}`,
  ].join('\n');
}

export function buildFocusDisplayText(target: SteeringTargetSnapshot): string {
  return buildFocusDisplayTarget(target);
}

export const buildFocusPrompt = buildFocusSystemPrompt;

export function buildFocusStructuredDisplayText(
  target: SteeringTargetSnapshot,
  options?: {
    selectedKeywords?: string[];
    backgroundText?: string | null;
  }
): string {
  if (target.kind === 'column') {
    return buildFocusDisplayTarget(target);
  }
  return buildKeywordPriorityDisplayText(target, options?.selectedKeywords, options?.backgroundText);
}

export function createFocusSteerRequest(
  runState: RunState,
  target: SteeringTargetSnapshot,
  options?: {
    selectedKeywords?: string[];
    userPromptPreview?: string;
    backgroundText?: string | null;
    includeBackground?: boolean;
  }
): SteerRunRequest {
  const selectedKeywords = normalizeSteeringKeywords(options?.selectedKeywords);
  const language = resolveSteeringPreviewLanguage(runState);
  const userPromptPreview = normalizeEditableSteeringPreview(
    options?.userPromptPreview ?? buildFocusUserPromptPreview(target, { selectedKeywords, language })
  );
  const backgroundText = target.kind === 'column'
    ? undefined
    : (options?.backgroundText ?? getEditableSteeringBackgroundText(target));
  const userPrompt = target.kind === 'column'
      ? userPromptPreview
      : composeEditableUserPrompt({
        preview: userPromptPreview,
        background: backgroundText,
        includeBackground: options?.includeBackground,
        language,
      });
  const systemPrompt = buildFocusSystemPrompt(runState, target, { selectedKeywords });
  const displayText = buildFocusStructuredDisplayText(target, {
    selectedKeywords,
    backgroundText,
  });
  return {
    content: userPrompt,
    kind: 'focus',
    display_text: displayText,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    selected_keywords: target.kind === 'column' ? undefined : selectedKeywords,
    target,
  };
}
