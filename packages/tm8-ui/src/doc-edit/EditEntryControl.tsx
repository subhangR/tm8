import type { EntityDetail } from '@tm8/contract';
import { DisabledAction, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import type { DocCommands } from './commands';

/**
 * T5-3 FRAME 1a — THE `Edit` PRIMARY, and the surface's first honesty gate.
 *
 * The oracle's annotation 1 is a rule, quoted whole because the copy is part of
 * it: "Edit is the doc's kind primary. Without write permission it renders
 * disabled-with-reason — 'Edit — read-only: your role can't edit docs in
 * atelier' — never hidden. One rule from T1-4, applied."
 *
 * FOUR WAYS IT CANNOT RUN, and each states which one it is, because they are
 * genuinely different facts and a single "unavailable" would flatten them:
 *   · no executor       — this build cannot dispatch anything
 *   · the server refuses — `capabilities.canEdit === false`, with the kind's own
 *                          sentence supplied by the caller as registry DATA
 *   · the doc is deleted — restore it first
 *   · no dispatch wired  — the verb exists, this screen does not route it
 *
 * NO KIND LITERAL. `editRefusal` arrives as data from the registry, which is
 * what lets `panels/no-branching.test.ts`'s law hold one lane over.
 */
export function EditEntryControl({
  detail,
  commands,
  onEnterEdit,
  editRefusal,
  label = 'Edit',
}: {
  detail: EntityDetail;
  commands: DocCommands | null;
  /** Absent ⇒ disabled-with-reason. Never a live control that does nothing. */
  onEnterEdit?: () => void;
  /** The registry's `panel.capabilityReasons.canEdit` sentence. */
  editRefusal?: string;
  label?: string;
}) {
  const reason =
    commands === null
      ? {
          cause: 'Editing is not wired here',
          remedy: 'this surface was mounted without a command executor',
        }
      : detail.capabilities.canEdit === false
        ? {
            cause: 'Read-only',
            remedy: editRefusal ?? 'the server refuses edits to this document',
          }
        : detail.deletedAt !== null
          ? { cause: 'This document is deleted', remedy: 'restore it before editing' }
          : onEnterEdit === undefined
            ? NOT_WIRED_REASON
            : null;

  if (reason) {
    return (
      <DisabledAction reason={reason} label={label}>
        {label}
      </DisabledAction>
    );
  }

  return (
    <button type="button" className="de-btn de-btn--primary" data-testid="doc-edit-entry" onClick={onEnterEdit}>
      {label}
    </button>
  );
}
