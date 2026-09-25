/**
 * Renderings of a resolved `SelectionHeader` (headers design 01a0d31e §7).
 *
 * `jevText` is the ONE place Ask Jev's candidate text is built. For teammates
 * and skills with no authored header it is byte-identical to the text
 * `candidates.ts` built by hand before the header module existed (golden
 * tests: `test/db/headers-jev-parity.pg.test.ts`). Headers T4 (integrated
 * design 01a0d348 §8 I7) changed two things on purpose: a memory's text
 * carries its `subject_scope`, and an authored header's keywords join the
 * text of the kinds that can have one.
 *
 * Only headers are rendered; a body never is.
 */
import type { SelectionHeader } from '@tm8/contract';
import { redactSecretTokens } from '@tm8/execution';

import { clip as cut, HEADER_TEXT_LIMIT } from './derive.js';

/**
 * Jev's per-field cut, REDACTED FIRST: this text leaves the server for the
 * Jev model, and a cut through a credential would leave a prefix no pattern
 * matches. (`resolveHeaders` already redacts what it reads; this makes the
 * rule local to the one function that ships text off the server, whatever
 * header it is handed.)
 */
const clip = (text: string | null | undefined, limit?: number): string =>
  cut(text == null ? text : redactSecretTokens(text), limit);

export interface JevTextOptions {
  /** Per-field character cut (Jev §9). */
  limit?: number;
  /** A teammate's equipped skill names, its ancestors' included. Loader data, not header data. */
  equippedSkills?: readonly string[];
}

/** ` Keywords: a, b.` for an authored header that has any, each cut and redacted like every other field. */
function keywordsPart(header: SelectionHeader, limit: number): string | null {
  const words = header.keywords.map((word) => clip(word, limit)).filter((word) => word.trim().length > 0);
  return words.length > 0 ? `Keywords: ${words.join(', ')}.` : null;
}

/** What Jev is shown for one candidate. */
export function jevText(header: SelectionHeader, options: JevTextOptions = {}): string {
  // Names, a teammate's uncut role and equipped-skill names are not cut, but
  // they still leave the server: the whole candidate text is redacted.
  return redactSecretTokens(renderJevText(header, options));
}

function renderJevText(header: SelectionHeader, options: JevTextOptions): string {
  const limit = options.limit ?? HEADER_TEXT_LIMIT;
  switch (header.kind) {
    case 'team_member': {
      // "name — role. Equipped with: a, b. persona(600)"
      const parts = [header.whenToUse ? `${header.name} — ${header.whenToUse}.` : `${header.name}.`];
      const equipped = options.equippedSkills ?? [];
      if (equipped.length > 0) parts.push(`Equipped with: ${equipped.join(', ')}.`);
      if (header.summary) parts.push(clip(header.summary, limit));
      const keywords = keywordsPart(header, limit);
      if (keywords) parts.push(keywords);
      return parts.join(' ');
    }
    case 'memory': {
      // The statement, cut, then what it is about (headers T4): a true claim
      // about the wrong subject is how an irrelevant memory ranks high.
      // The scope is the memory's whenToUse, so it is shown whole (task
      // 01a0da5a); jevText redacts the whole text before it leaves.
      const statement = clip(header.summary, limit);
      const scope = header.whenToUse ?? '';
      return scope.trim() ? `${statement} (scope: ${scope})` : statement;
    }
    case 'skill': {
      // "name: description", else "name: when_to_use" (whole: a whenToUse is
      // never cut, task 01a0da5a), else the bare name.
      const text = header.summary ? clip(header.summary, limit) : redactSecretTokens(header.whenToUse ?? '');
      return text ? `${header.name}: ${text}` : header.name;
    }
    default: {
      // References (doc, artifact, drawing, file, task, collection): name,
      // then when (whole: a whenToUse is never cut, task 01a0da5a), then what
      // (cut), then an authored header's keywords. The body is never sent
      // (headers design 01a0d31e §7.1).
      const parts = [header.whenToUse, header.summary ? clip(header.summary, limit) : null].filter((part): part is string => !!part);
      const keywords = keywordsPart(header, limit);
      if (keywords) parts.push(keywords);
      return parts.length > 0 ? `${header.name}: ${parts.join(' ')}` : header.name;
    }
  }
}
