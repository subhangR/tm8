/**
 * The in-full channel (launch card v3, contract decision 1 and its amendment):
 * entities the launch title row sends WHOLE, each in its own untrusted,
 * read-only section of the system half.
 *
 * Budget order, inside `combinedInitialInjection`:
 *   1. `<task>`, the subject. Past `inFullInjection` on its own it switches to
 *      reference mode (never a refusal).
 *   2. These sections. The subject (when inline) plus these, past
 *      `inFullInjection`, refuses the launch (`BudgetExceededError`
 *      `inFullInjection`, wired as `payload_too_large` / `in_full_budget`).
 *   3. Notes (`promptExtra`), then 4. the context index, which the manifest
 *      fits to what is left.
 *
 * Why the system half: resume re-reads these entities and re-inlines them,
 * and resume re-sends the system half only (the task turn is already in the
 * transcript).
 */
import { BudgetExceededError, BYTE_BUDGETS, utf8Bytes } from './budgets.js';
import { untrustedData } from './escape.js';

export interface PromptInFullEntity {
  entityId: string;
  kind: string;
  title?: string | null | undefined;
  version?: number | undefined;
  body: string;
}

/** One in-full section exactly as rendered. */
export function serializeInFullEntity(entity: PromptInFullEntity): string {
  return untrustedData({
    type: 'in-full',
    extraAttrs: {
      entity_id: entity.entityId,
      kind: entity.kind,
      ...(entity.version === undefined ? {} : { version: String(entity.version) }),
      access: 'read-only',
    },
    body: entity.title ? `Title: ${entity.title}\n\n${entity.body}` : entity.body,
  });
}

/**
 * Where each prompt section's bytes went, measured on the rendered text. It
 * is what `launch.preview` reports, so it is filled by the composer itself
 * rather than re-derived elsewhere.
 */
export interface PromptLayout {
  /** The task turn as sent (inline or reference), in UTF-8 bytes. */
  taskBytes: number;
  taskDelivery: 'inline' | 'reference' | 'none';
  inFull: Array<{ entityId: string; kind: string; title: string; bytes: number }>;
  /** Subject (when inline) plus the in-full sections, against `inFullInjection`. */
  inFullBytes: number;
  notesBytes: number;
  indexBytes: number;
}

/**
 * The in-full budget rule. `subjectBytes` counts only when the subject went
 * inline; a subject in reference mode leaves the extras alone against the
 * budget. Throws only when there ARE extras: a subject alone never refuses.
 */
export function inFullBytesWithin(subjectBytes: number, subjectInline: boolean, sections: readonly string[]): number {
  const extras = sections.reduce((sum, section) => sum + utf8Bytes(section) + 1, 0);
  const bytes = (subjectInline ? subjectBytes : 0) + extras;
  if (sections.length > 0 && bytes > BYTE_BUDGETS.inFullInjection) {
    throw new BudgetExceededError('inFullInjection', bytes, BYTE_BUDGETS.inFullInjection);
  }
  return bytes;
}
