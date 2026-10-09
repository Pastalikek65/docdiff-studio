import { diffWords, diffWordsWithSpace } from 'diff';
import type { CompareOptions, TextChange } from './types';

export function textChanges(beforeText: string, afterText: string, options: CompareOptions): TextChange[] {
  const before = omitSelectedLines(beforeText, options.ignoreHeaderLines, options.ignoreFooterLines);
  const after = omitSelectedLines(afterText, options.ignoreHeaderLines, options.ignoreFooterLines);
  const parts = options.ignoreWhitespace
    ? diffWords(before, after)
    : diffWordsWithSpace(before, after);

  const changes: TextChange[] = [];
  for (const part of parts) {
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'equal';
    if (!part.value) continue;
    const previous = changes.at(-1);
    if (previous?.kind === kind) previous.text += part.value;
    else changes.push({ kind, text: part.value });
  }
  return changes;
}

export function omitSelectedLines(text: string, headerCount: number, footerCount: number): string {
  const lines = text.split('\n');
  const from = Math.min(headerCount, lines.length);
  const to = Math.max(from, lines.length - footerCount);
  return lines.slice(from, to).join('\n');
}

export function singleTextChange(text: string, kind: 'added' | 'removed'): TextChange[] {
  return text ? [{ kind, text }] : [];
}
