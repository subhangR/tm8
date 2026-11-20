/** Automatic labels only. Explicit names and the original instructions bypass this. */
export const INTENT_TITLE_MAX_WORDS = 6;
export const INTENT_TITLE_MAX_CHARS = 56;

const REQUEST_PREFIX = /^(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:want|need|would\s+like)\s+(?:(?:you|someone)\s+)?to\s+|(?:i|we)['’]d\s+like\s+(?:you\s+)?to\s+|help\s+(?:me|us)\s+(?:to\s+)?|let['’]s\s+|(?:hey|hi|hello)[,!]?\s+)/iu;
const DANGLING_WORD = /^(?:a|an|the|to|for|with|and|or|in|on|at|from|into|of|that|which|before|after|my|our|your|their|its|this|these|those)$/iu;

/**
 * A small, deterministic extract of the first intent, without a model call or
 * a later rename that could race a person's edit. This is a label, never work
 * content. Keep identifiers such as `upload.ts` intact at sentence boundaries.
 */
export function shortIntentTitle(intent: string, fallback = 'Work session'): string {
  let text = intent.trim()
    .replace(/^(?:#{1,6}|[-*>]|\d+[.)])\s+/u, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/(\*\*|__|~~)(.*?)\1/gu, '$2')
    .replace(/`/gu, '')
    .replace(/^[.!?]+\s*/u, '');

  // Prefixes can nest: "Hi, could you please help me …". Each pass must
  // consume input, so this remains bounded by the original prompt's length.
  while (REQUEST_PREFIX.test(text)) text = text.replace(REQUEST_PREFIX, '').trimStart();
  text = text.split(/\n|[.!?](?=\s|$)/u, 1)[0]!.trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return fallback;

  const allWords = text.split(/\s+/u);
  const words = allWords.slice(0, INTENT_TITLE_MAX_WORDS);
  while (words.length > 1 && Array.from(words.join(' ')).length > INTENT_TITLE_MAX_CHARS) words.pop();
  if (words.length < allWords.length) {
    while (words.length > 1 && DANGLING_WORD.test(words.at(-1)!)) words.pop();
  }
  const title = words.join(' ').replace(/[,;:\s]+$/u, '');
  const characters = Array.from(title);
  return characters.length > INTENT_TITLE_MAX_CHARS
    ? `${characters.slice(0, INTENT_TITLE_MAX_CHARS - 1).join('')}…`
    : title || fallback;
}
