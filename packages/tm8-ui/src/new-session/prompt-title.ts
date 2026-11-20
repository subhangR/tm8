import { shortIntentTitle } from '@tm8/contract';

/** Existing explicit-name input limit; automatic labels use the shorter policy. */
export const TITLE_MAX = 80;

export function canDeriveTitle(prompt: string): boolean {
  return prompt.trim().length > 0;
}

export function deriveTitle(prompt: string): string {
  return canDeriveTitle(prompt) ? shortIntentTitle(prompt) : '';
}

/** Preserve the complete instructions, including internal whitespace. */
export function promptBody(prompt: string): string {
  return prompt.trim();
}
