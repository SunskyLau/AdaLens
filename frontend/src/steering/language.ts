import type { RunState, UserMessage } from '@/types';

import { normalizeSteeringMessageKind } from './kinds';

export type SteeringPreviewLanguage = 'en' | 'zh';

const USER_AUTHORED_LANGUAGE_KINDS = new Set([
  'chat',
  'focus',
  'ignore',
  'elaborate',
  'create',
]);

export function canonicalUserMessageText(message: UserMessage | null | undefined): string {
  if (!message) {
    return '';
  }
  const candidates = [message.user_prompt, message.generated_prompt, message.content];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

export function latestUserAuthoredMessageText(
  runState: Pick<RunState, 'user_messages'> | null | undefined
): string {
  const messages = runState?.user_messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const kind = normalizeSteeringMessageKind(message?.kind);
    if (!kind || !USER_AUTHORED_LANGUAGE_KINDS.has(kind)) {
      continue;
    }
    const text = canonicalUserMessageText(message);
    if (text) {
      return text;
    }
  }
  return '';
}

export function containsCjkText(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

export function prefersChineseText(text: string): boolean {
  const cjkMatches = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  const latinMatches = text.match(/[A-Za-z]/g) ?? [];
  if (cjkMatches.length === 0) {
    return false;
  }
  if (latinMatches.length === 0) {
    return true;
  }
  return cjkMatches.length >= latinMatches.length;
}

export function resolveSteeringPreviewLanguage(
  runState: Pick<RunState, 'user_messages'> | null | undefined
): SteeringPreviewLanguage {
  return prefersChineseText(latestUserAuthoredMessageText(runState)) ? 'zh' : 'en';
}

export function formatSteeringPreviewList(
  values: readonly string[] | null | undefined,
  language: SteeringPreviewLanguage
): string {
  const normalized = (values ?? [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return normalized.join(language === 'zh' ? '、' : ', ');
}

export function getSteeringBackgroundHeading(language: SteeringPreviewLanguage): string {
  return language === 'zh' ? '\u80cc\u666f\uff1a' : 'Background:';
}

export function getSteeringPreviewPlaceholder(language: SteeringPreviewLanguage): string {
  return language === 'zh'
    ? '\u8bf7\u8865\u5145\u4f60\u5e0c\u671b\u7cfb\u7edf\u6267\u884c\u7684\u5f15\u5bfc\u8bed\u3002'
    : 'Refine the user-visible steering request.';
}
