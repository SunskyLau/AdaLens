const CJK_TERMINAL_PUNCTUATION_WITH_DOT_PATTERN = /([。！？])\s*\.+/g;

/**
 * Normalizes mixed CJK + English terminal punctuation sequences such as `。.`
 * that may exist in historical run data.
 */
export function normalizeCjkTerminalPunctuation(text: string | null | undefined): string {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) {
    return '';
  }
  return raw.replace(CJK_TERMINAL_PUNCTUATION_WITH_DOT_PATTERN, '$1');
}
