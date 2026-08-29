/**
 * THE `editFields` DIALOG'S DRAFT — staged, cancellable, version-guarded.
 *
 * WHY THIS IS NOT `useTaskSave`. That hook is the INLINE flow: the title
 * editor and the status picker call `commitNow` and each gesture is its own
 * save, so the draft it holds is whatever has not flushed yet and its patch is
 * built by `taskPatchInput` from a closed list of task members. A dialog is the
 * other shape — a whole form, Cancel and Save, one patch at the end — and its
 * payload is whatever the registry declared, which `taskPatchInput` would
 * discard (see `AuthoringCommands.patchEntity`). Two shapes, two hooks, ONE
 * failure vocabulary: `classifyFailure` is shared, so a conflict here reads
 * exactly as a conflict there.
 *
 * THE VERSION IS CAPTURED WHEN THE DIALOG OPENS, and that is the same decision
 * `useTaskSave` documents at length, for the same reason. Re-reading
 * `detail.version` at Save time would mean a write that landed while the dialog
 * sat open is silently overwritten and NO CONFLICT EVER FIRES. Captured at
 * open, that race is a 409 the user can see and answer. The dialog is the worse
 * case of the two, because a form stays open far longer than a keystroke.
 *
 * NOTHING HERE RETRIES, MERGES OR RE-READS. A conflict parks with the draft
 * intact so the text is not lost, and the person decides.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import {
  classifyFailure,
  entityPatchInput,
  type AuthoringCommands,
  type ConflictFailure,
  type EntityEdits,
  type RefusedFailure,
} from './commands';

export type EntityEditPhase =
  | { phase: 'closed' }
  | { phase: 'open' }
  | { phase: 'saving' }
  | { phase: 'conflict'; failure: ConflictFailure }
  | { phase: 'refused'; failure: RefusedFailure };

export interface UnavailableReason {
  cause: string;
  remedy: string;
}

export interface EntityEditHandle {
  state: EntityEditPhase;
  open: boolean;
  /** The staged draft, keyed by `EditFieldSpec` identity (see `fieldKey`). */
  values: Readonly<Record<string, string>>;
  /** The values captured when this dialog opened, for changed-field semantics. */
  initialValues: Readonly<Record<string, string>>;
  dirty: boolean;
  /** Non-null ⇒ every save affordance renders disabled-with-reason (R7/L6). */
  unavailable: UnavailableReason | null;
  /** Open the dialog, seeding the draft from the entity as it stands now. */
  begin(seed: Record<string, string>): void;
  /** Stage one field. */
  set(key: string, value: string): void;
  /** Flush the whole draft in ONE patch. */
  save(edits: EntityEdits): Promise<void>;
  /** Close, dropping the draft. Sends nothing. */
  cancel(): void;
  /** Leave a conflict or refusal card without closing the dialog. */
  dismiss(): void;
}

export interface EntityEditOptions {
  detail: EntityDetail | null | undefined;
  /** Null ⇒ no executor is wired, and the dialog says so instead of lying. */
  commands: AuthoringCommands | null;
  /** The seam refuses edits here (a capability the server turned off). */
  editRefusal?: string | null;
  onSaved?(result: CommandResult): void;
}

const NO_EXECUTOR: UnavailableReason = {
  cause: 'Editing is not wired here',
  remedy: 'this surface was mounted without a command executor',
};

const NO_ENTITY: UnavailableReason = {
  cause: 'There is nothing to edit',
  remedy: 'no entity is loaded in this panel',
};

export function useEntityEdit(options: EntityEditOptions): EntityEditHandle {
  const { detail, commands, editRefusal, onSaved } = options;
  const [state, setState] = useState<EntityEditPhase>({ phase: 'closed' });
  const [values, setValues] = useState<Record<string, string>>({});
  const seed = useRef<Record<string, string>>({});
  /**
   * The version the draft was made against. A ref rather than state because it
   * must not participate in a re-render race: `begin` and `save` can land in
   * the same tick when Enter submits a freshly opened dialog.
   */
  const baseVersion = useRef<number | null>(null);

  /**
   * A DIALOG LEFT OPEN OVER A CHANGED SUBJECT IS CLOSED, not silently repointed.
   *
   * The panel can be re-pointed at a different entity while this is open (the
   * peek stack does exactly that). Keeping the draft would apply one entity's
   * text to another one's id at the next Save — a data-loss bug that no test
   * of the happy path can see. Keyed on the id, so an ordinary version bump on
   * the SAME entity does not throw the user's typing away; that case is the
   * conflict, and the conflict is the thing they get to answer.
   */
  const subjectId = detail?.id ?? null;
  useEffect(() => {
    setState({ phase: 'closed' });
    setValues({});
    seed.current = {};
    baseVersion.current = null;
  }, [subjectId]);

  const unavailable =
    commands === null
      ? NO_EXECUTOR
      : !detail
        ? NO_ENTITY
        : detail.capabilities?.canEdit === false
          ? { cause: 'You cannot edit this', remedy: editRefusal ?? 'the server refuses edits here' }
          : null;

  const begin = useCallback(
    (next: Record<string, string>) => {
      seed.current = next;
      setValues(next);
      baseVersion.current = detail?.version ?? null;
      setState({ phase: 'open' });
    },
    [detail?.version],
  );

  const set = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(
    async (edits: EntityEdits) => {
      if (commands === null || !detail) return;
      const expectedVersion = baseVersion.current;
      if (expectedVersion === null) return;
      setState({ phase: 'saving' });
      try {
        const result = await commands.patchEntity(detail.id, entityPatchInput(edits, expectedVersion));
        setState({ phase: 'closed' });
        setValues({});
        seed.current = {};
        baseVersion.current = null;
        onSaved?.(result);
      } catch (error) {
        const failure = classifyFailure(error, 'save');
        setState(
          failure.kind === 'conflict'
            ? { phase: 'conflict', failure }
            : { phase: 'refused', failure },
        );
      }
    },
    [commands, detail, onSaved],
  );

  const cancel = useCallback(() => {
    setState({ phase: 'closed' });
    setValues({});
    seed.current = {};
    baseVersion.current = null;
  }, []);

  /** Back to the form with the draft intact — the whole point of parking. */
  const dismiss = useCallback(() => setState({ phase: 'open' }), []);

  const dirty = Object.keys(values).some((key) => values[key] !== seed.current[key]);

  return {
    state,
    open: state.phase !== 'closed',
    values,
    initialValues: seed.current,
    dirty,
    unavailable,
    begin,
    set,
    save,
    cancel,
    dismiss,
  };
}
