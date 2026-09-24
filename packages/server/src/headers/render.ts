/**
 * Renderings of a resolved `SelectionHeader` (headers design 01a0d31e §7).
 *
 * `jevText` is the ONE place Ask Jev's candidate text is built. For teammates,
 * memories and skills with no authored header it is byte-identical to the
 * text `candidates.ts` built by hand before the header module existed
 * (golden tests: `test/db/headers-jev-parity.pg.test.ts`).
 *
 * Only headers are rendered; a body never is.
 */
import type { SelectionHeader } from '@tm8/contract';

import { clip, HEADER_TEXT_LIMIT } from './derive.js';

export interface JevTextOptions {
  /** Per-field character cut (Jev §9). */
  limit?: number;
  /** A teammate's equipped skill names, its ancestors' included. Loader data, not header data. */
  equippedSkills?: readonly string[];
}

/** What Jev is shown for one candidate. */
export function jevText(header: SelectionHeader, options: JevTextOptions = {}): string {
  const limit = options.limit ?? HEADER_TEXT_LIMIT;
  switch (header.kind) {
    case 'team_member': {
      // "name — role. Equipped with: a, b. persona(600)"
      const parts = [header.whenToUse ? `${header.name} — ${header.whenToUse}.` : `${header.name}.`];
      const equipped = options.equippedSkills ?? [];
      if (equipped.length > 0) parts.push(`Equipped with: ${equipped.join(', ')}.`);
      if (header.summary) parts.push(clip(header.summary, limit));
      return parts.join(' ');
    }
    case 'memory':
      // The statement, cut. (`subject_scope` joins it in headers T4, not here.)
      return clip(header.summary, limit);
    case 'skill': {
      // "name: description", else "name: when_to_use", else the bare name.
      const text = clip(header.summary ?? header.whenToUse, limit);
      return text ? `${header.name}: ${text}` : header.name;
    }
    default: {
      // References (doc, artifact, drawing, file, task, collection): name,
      // then when, then what. Not yet shown to Jev (headers T7).
      const parts = [header.whenToUse, header.summary].filter((part): part is string => !!part).map((part) => clip(part, limit));
      return parts.length > 0 ? `${header.name}: ${parts.join(' ')}` : header.name;
    }
  }
}
