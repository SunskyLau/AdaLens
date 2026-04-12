import type { RunState, SteerRunRequest, SteeringTargetSnapshot } from '@/types';

import {
  resolveSteeringPreviewLanguage,
  type SteeringPreviewLanguage,
} from './language';
import { formatTargetColumns, getSteeringTargetLabel } from './target';
import {
  buildSteeringParentSummaryPreviewLabel,
  buildSteeringTargetPreviewLabel,
  getEditableSteeringBackgroundText,
  normalizeEditableSteeringPreview,
} from './prompt';

function getElaborateCoreText(target: SteeringTargetSnapshot): string {
  return getEditableSteeringBackgroundText(target);
}

export function buildElaborateUserPromptPreview(
  target: SteeringTargetSnapshot,
  options?: { language?: SteeringPreviewLanguage }
): string {
  const language = options?.language ?? 'en';
  const summaryLabel = buildSteeringParentSummaryPreviewLabel(target);
  if (target.kind === 'atomic') {
    const atomicLabel = buildSteeringTargetPreviewLabel(target);
    if (language === 'zh') {
      return `\u8bf7\u8fdb\u4e00\u6b65\u5c55\u5f00\u603b\u7ed3\u201c${summaryLabel}\u201d\u4e2d\u7684\u539f\u5b50\u6d1e\u5bdf\u201c${atomicLabel}\u201d\uff0c\u8bf4\u660e\u5b83\u7531\u4ec0\u4e48\u9a71\u52a8\u4ee5\u53ca\u4e3a\u4ec0\u4e48\u4f1a\u53d1\u751f\u3002`;
    }
    return `Elaborate on the atomic insight "${atomicLabel}" from the summary "${summaryLabel}" by explaining what drives it and why it happens.`;
  }
  if (language === 'zh') {
    return `\u8bf7\u8fdb\u4e00\u6b65\u5c55\u5f00\u603b\u7ed3\u201c${summaryLabel}\u201d\uff0c\u8bf4\u660e\u5b83\u610f\u5473\u7740\u4ec0\u4e48\u3001\u7531\u4ec0\u4e48\u9a71\u52a8\uff0c\u4ee5\u53ca\u4e3a\u4ec0\u4e48\u4f1a\u53d1\u751f\u3002`;
  }
  return `Elaborate on the summary "${summaryLabel}" by explaining what it means, what drives it, and why it happens.`;
}

export function buildElaborateSystemPrompt(target: SteeringTargetSnapshot): string {
  const coreText = getElaborateCoreText(target);
  return [
    'Elaborate steering semantics:',
    '- Keep investigating the explanation, mechanism, and root causes of this specific insight.',
    '- Stay tightly scoped to this one insight and avoid broad branching into multiple unrelated new plans.',
    '- Do not cancel or rewrite sub-agents that are already running.',
    `Target kind: ${target.kind}`,
    `Target label: ${getSteeringTargetLabel(target)}`,
    `Core background text: ${coreText || '(none provided)'}`,
    `Related columns: ${formatTargetColumns(target)}`,
  ].join('\n');
}

export function createElaborateSteerRequest(
  target: SteeringTargetSnapshot,
  options?: { userPromptPreview?: string; runState?: RunState | null }
): SteerRunRequest {
  const coreText = getElaborateCoreText(target);
  const language = resolveSteeringPreviewLanguage(options?.runState);
  const userPrompt = normalizeEditableSteeringPreview(
    options?.userPromptPreview ?? buildElaborateUserPromptPreview(target, { language })
  );
  return {
    content: userPrompt,
    kind: 'elaborate',
    user_prompt: userPrompt,
    system_prompt: buildElaborateSystemPrompt(target),
    display_text: coreText || getSteeringTargetLabel(target),
    target,
  };
}
