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

function buildIgnoreDisplayTarget(target: SteeringTargetSnapshot): string {
  if (target.kind === 'column') {
    return target.columns.join(', ');
  }
  return getSteeringTargetLabel(target);
}

export function buildIgnoreUserPromptPreview(
  target: SteeringTargetSnapshot,
  options?: { selectedKeywords?: string[]; language?: SteeringPreviewLanguage }
): string {
  const language = options?.language ?? 'en';
  if (target.kind === 'column') {
    const columns = formatSteeringPreviewList(target.columns, language) || formatTargetColumns(target);
    if (language === 'zh') {
      return `\u8bf7\u964d\u4f4e\u540e\u7eed\u5bf9\u6570\u636e\u5217 ${columns} \u7684\u5206\u6790\u4f18\u5148\u7ea7\u3002`;
    }
    return target.columns.length > 1
      ? `Deprioritize future analysis on the dataset columns ${formatTargetColumns(target)}.`
      : `Deprioritize future analysis on the dataset column ${target.columns[0] ?? 'this column'}.`;
  }
  const selectedKeywords = normalizeSteeringKeywords(options?.selectedKeywords);
  if (selectedKeywords.length === 0) {
    return '';
  }
  const keywordText = formatSteeringPreviewList(selectedKeywords, language);
  const keywordClause = selectedKeywords.join(', ');
  if (target.kind === 'atomic') {
    if (language === 'zh') {
      return `\u8bf7\u5728\u540e\u7eed\u5206\u6790\u4e2d\u91cd\u70b9\u56de\u907f${keywordText}\u3002`;
    }
    return `In follow-up analysis, deprioritize ${keywordClause} for this atomic insight.`;
  }
  if (language === 'zh') {
    return `\u8bf7\u5728\u540e\u7eed\u5206\u6790\u4e2d\u91cd\u70b9\u56de\u907f${keywordText}\u3002`;
  }
  return `In follow-up analysis, deprioritize ${keywordClause} for this summary.`;
}

export function buildIgnoreSystemPrompt(
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
      'Ignore steering semantics:',
      isMultiColumn
        ? '- Stop pursuing future planning centered on this dataset column group.'
        : '- Stop pursuing future planning centered on this dataset column.',
      '- Avoid expansion, comparison, validation, and explanation along this direction unless the user explicitly reopens it or there is no viable alternative path to answer the main goal.',
      '- Do not cancel or rewrite sub-agents that are already running.',
      `Target kind: ${target.kind}`,
      `Columns: ${formatTargetColumns(target)}`,
      'Current run summaries touching these columns:',
      buildColumnSummaryOverview(runState, target.columns),
    ].join('\n');
  }
  return [
    'Ignore steering semantics:',
    `- Stop pursuing this ${target.kind} direction in future planning.`,
    '- Treat the selected keywords as the main suppression handles when they are provided.',
    '- Avoid future expansion, comparison, validation, and explanation along this direction unless the user explicitly reopens it or it becomes strictly necessary to answer the main goal.',
    '- Treat the user-authored background as contextual disambiguation only.',
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

export function buildIgnoreDisplayText(target: SteeringTargetSnapshot): string {
  return buildIgnoreDisplayTarget(target);
}

export const buildIgnorePrompt = buildIgnoreSystemPrompt;

export function buildIgnoreStructuredDisplayText(
  target: SteeringTargetSnapshot,
  options?: {
    selectedKeywords?: string[];
    backgroundText?: string | null;
  }
): string {
  if (target.kind === 'column') {
    return buildIgnoreDisplayTarget(target);
  }
  return buildKeywordPriorityDisplayText(target, options?.selectedKeywords, options?.backgroundText);
}

export function createIgnoreSteerRequest(
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
    options?.userPromptPreview ?? buildIgnoreUserPromptPreview(target, { selectedKeywords, language })
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
  const systemPrompt = buildIgnoreSystemPrompt(runState, target, { selectedKeywords });
  const displayText = buildIgnoreStructuredDisplayText(target, {
    selectedKeywords,
    backgroundText,
  });
  return {
    content: userPrompt,
    kind: 'ignore',
    display_text: displayText,
    user_prompt: userPrompt,
    system_prompt: systemPrompt,
    selected_keywords: target.kind === 'column' ? undefined : selectedKeywords,
    target,
  };
}
