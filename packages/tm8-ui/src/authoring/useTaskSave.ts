/**
 * THE SAVE FLOW — every edit to an existing task, and the honesty states the
 * seam can put in front of it.
 *
 * TWO ENTRY POINTS, ONE BUILDER (the D45 §5 rule, applied here):
 *   · `commitNow(patch)` — the oracle's "enter commits". The title editor and
 *     the status picker use it: one gesture, one save, immediately.
 *   · `edit(patch)` then `save()` — the T5-6 teammate frame's staged form,
 *     where an "editing" pill and a Cancel/Save pair sit over a dirty set.
 * Both go through `flush()`, so they cannot fork into two save semantics. Two
 * callers of one builder, never two builders agreeing by care.
 *
 * THE ONE DECISION EVERYTHING ELSE HANGS OFF — `baseVersion`.
 *
 * `expectedVersion` is captured when the FIRST edit is made and held until the
 * draft is resolved. It is NOT re-read from `detail` at save time. That looks
 * like a detail and it is the whole point of the mechanism:
 *
 *   read at SAVE time  → a write that landed while you were typing bumps
 *                        `detail.version`, your patch matches it, and you
 *                        overwrite the other writer WITHOUT ANY CONFLICT EVER
 *                        FIRING. Silent, and invisible to every test that does
 *                        not move the version mid-draft.
 *   read at EDIT time  → the same race produces a 409, which is a state the
 *                        user can see and answer.
 *
 * So the version conflict is not an error path bolted on afterwards — it is
 * the designed consequence of holding the version the user's edit was actually
 * based on. `authoring.test.tsx` asserts it by re-rendering with a bumped
 * version mid-draft, and `authoring-seam.test.tsx` asserts the executor really
 * enforces it (D57: a declaration is a promise, an implementation is the fact).
 *
 * WHAT THIS HOOK NEVER DOES: retry, re-read the version, merge, or resolve a
 * conflict on its own. A conflict parks and waits for a person to choose
 * reload (take theirs) or overwrite (keep mine, at their version, explicitly).
 */
import { useCallback, useRef, useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import {
  classifyFailure,
  entityPatchInput,
  taskPatchInput,
  type AuthoringCommands,
  type ConflictFailure,
  type RefusedFailure,
  type TaskEdits,
} from './commands';

export type SavePhase =
  | { phase: 'clean' }
  | { phase: 'dirty' }
  | { phase: 'saving' }
  | { phase: 'conflict'; failure: ConflictFailure }
  | { phase: 'refused'; failure: RefusedFailure };

export interface UnavailableReason {
  cause: string;
  remedy: string;
}

export interface TaskSaveHandle {
  state: SavePhase;
  /** The staged, unsaved edits. Preserved across a refusal AND a conflict. */
  edits: TaskEdits;
  dirty: boolean;
  /** The version the staged edits were made against; null when clean. */
  baseVersion: number | null;
  /** Non-null ⇒ every save affordance renders disabled-with-reason (R7/L6). */
  unavailable: UnavailableReason | null;
  /** Stage an edit. Captures `baseVersion` on the first one. */
  edit(patch: TaskEdits): void;
  /** Stage and flush in one gesture — the oracle's "enter commits". */
  commitNow(patch: TaskEdits): Promise<void>;
  /** Flush the whole dirty set in ONE patch. */
  save(): Promise<void>;
  /** Drop the draft. Sends nothing. */
  cancel(): void;
  /** Conflict resolution — TAKE THEIRS. */
  reload(): void;
  /** Conflict resolution — KEEP MINE, at their version. Null-guarded. */
  overwrite(): Promise<void>;
  /** Leave a refusal without dropping the draft. */
  dismiss(): void;
}

export interface TaskSaveOptions {
  /** Null is legal: a panel may render before its detail has hydrated. */
  detail: EntityDetail | null;
  /** Null ⇒ no executor is wired, and every control says so. */
  commands: AuthoringCommands | null;
  /** Registry-selected command family. Task content needs its typed RPC;
   * plain entity titles use the universal patch command. */
  editCommand?: 'typed' | 'entity';
  onSaved?(result: CommandResult): void;
  /** Handed the server's detail when the viewer chooses reload. */
  onReload?(current: EntityDetail): void;
  /**
   * The honest sentence for a server-refused edit, from the registry's
   * `panel.capabilityReasons.canEdit`. Registry DATA in — this lane never
   * authors a per-kind reason.
   */
  editRefusal?: string;
}

const NO_EXECUTOR: UnavailableReason = {
  cause: 'Saving is not wired here',
  remedy: 'this surface was mounted without a command executor',
};

const NO_DETAIL: UnavailableReason = {
  cause: 'Nothing to save yet',
  remedy: 'the entity has not finished loading',
};

export function useTaskSave(options: TaskSaveOptions): TaskSaveHandle {
  const { detail, commands, editCommand = 'typed', onSaved, onReload, editRefusal } = options;
  const [state, setState] = useState<SavePhase>({ phase: 'clean' });
  const [edits, setEdits] = useState<TaskEdits>({});
  const [baseVersion, setBaseVersion] = useState<number | null>(null);

  /**
   * The draft lives in a ref ALONGSIDE state, and this is not redundancy.
   * `commitNow` stages and flushes in one call, and React state set in the
   * same tick is not readable by the flush that follows it — reading `edits`
   * there would send the PREVIOUS draft and drop the character the user just
   * typed. The ref is what the flush reads; the state is what the UI renders.
   */
  const draft = useRef<TaskEdits>({});
  const base = useRef<number | null>(null);

  const unavailable =
    commands === null
      ? NO_EXECUTOR
      : editCommand === 'entity' && commands.patchEntity === undefined
        ? NO_EXECUTOR
      : detail === null
        ? NO_DETAIL
        : detail.capabilities.canEdit === false
          ? { cause: 'You cannot edit this', remedy: editRefusal ?? 'the server refuses edits here' }
          : detail.deletedAt !== null
            ? { cause: 'This is deleted', remedy: 'restore it before editing' }
            : null;

  const stage = useCallback(
    (patch: TaskEdits) => {
      draft.current = { ...draft.current, ...patch };
      setEdits(draft.current);
      if (base.current === null && detail) {
        base.current = detail.version;
        setBaseVersion(detail.version);
      }
    },
    [detail],
  );

  const settle = useCallback(() => {
    draft.current = {};
    base.current = null;
    setEdits({});
    setBaseVersion(null);
    setState({ phase: 'clean' });
  }, []);

  /** THE one place a patch is sent. Every path above lands here. */
  const flush = useCallback(
    async (expectedVersion: number) => {
      if (commands === null || detail === null) return;
      const patch = draft.current;
      if (Object.keys(patch).length === 0) return;
      setState({ phase: 'saving' });
      try {
        const result = editCommand === 'entity'
          ? await commands.patchEntity!(detail.id, entityPatchInput(patch, expectedVersion))
          : await commands.patchTask(detail.id, taskPatchInput(patch, expectedVersion));
        settle();
        onSaved?.(result);
      } catch (error) {
        const failure = classifyFailure(error, 'save');
        // THE DRAFT SURVIVES BOTH ARMS. "your text is kept right here" is the
        // oracle's own promise (T5-5's refusal card), and it is the difference
        // between a refusal the user can answer and one that costs them work.
        setState(
          failure.kind === 'conflict'
            ? { phase: 'conflict', failure }
            : { phase: 'refused', failure },
        );
      }
    },
    [commands, detail, editCommand, onSaved, settle],
  );

  const edit = useCallback(
    (patch: TaskEdits) => {
      if (unavailable) return;
      stage(patch);
      setState({ phase: 'dirty' });
    },
    [stage, unavailable],
  );

  const save = useCallback(async () => {
    if (unavailable || base.current === null) return;
    await flush(base.current);
  }, [flush, unavailable]);

  const commitNow = useCallback(
    async (patch: TaskEdits) => {
      if (unavailable || detail === null) return;
      stage(patch);
      // `base.current` is set by `stage` on the first edit, so this is the
      // version of the FIRST staged change even when commitNow lands on top of
      // an existing draft — the same rule, not an exception to it.
      await flush(base.current ?? detail.version);
    },
    [detail, flush, stage, unavailable],
  );

  const cancel = useCallback(() => settle(), [settle]);
  const dismiss = useCallback(() => {
    setState(Object.keys(draft.current).length > 0 ? { phase: 'dirty' } : { phase: 'clean' });
  }, []);

  const reload = useCallback(() => {
    if (state.phase !== 'conflict') return;
    const current = state.failure.current;
    settle();
    if (current) onReload?.(current);
  }, [onReload, settle, state]);

  const overwrite = useCallback(async () => {
    if (state.phase !== 'conflict') return;
    const version = state.failure.currentVersion;
    /**
     * NULL-GUARDED, and the guard is the honesty. Without a version we do not
     * know what we would be overwriting; sending the base version again would
     * just re-conflict, and re-reading `detail.version` would be the silent
     * overwrite this whole file exists to prevent. The affordance renders
     * disabled-with-reason in that case rather than being offered and failing.
     */
    if (version === null) return;
    await flush(version);
  }, [flush, state]);

  return {
    state,
    edits,
    dirty: Object.keys(edits).length > 0,
    baseVersion,
    unavailable,
    edit,
    commitNow,
    save,
    cancel,
    reload,
    overwrite,
    dismiss,
  };
}
