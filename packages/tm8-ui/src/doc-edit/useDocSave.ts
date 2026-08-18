/**
 * THE DOC SAVE FLOW — every edit to a doc's text, and the honesty states the
 * seam can put in front of it.
 *
 * THE ONE DECISION EVERYTHING ELSE HANGS OFF — `baseVersion`.
 *
 * `expectedVersion` is captured when the FIRST edit is made and held until the
 * draft is resolved. It is NOT re-read from `detail` at save time:
 *
 *   read at SAVE time  → a write that landed while you were typing bumps
 *                        `detail.version`, your patch matches it, and you
 *                        overwrite the other writer WITHOUT ANY CONFLICT EVER
 *                        FIRING. Silent, and invisible to every test that does
 *                        not move the version mid-draft.
 *   read at EDIT time  → the same race produces a 409, which is a state the
 *                        user can see and answer.
 *
 * So the version conflict is not an error path bolted on afterwards — it is the
 * designed consequence of holding the version the user's edit was based on.
 * `docEdit.test.tsx` asserts the sent number directly, and
 * `docEdit-seam.test.tsx` asserts the real executor enforces it.
 *
 * WHAT THIS HOOK NEVER DOES: retry, re-read the version, merge, or resolve a
 * conflict on its own. A conflict parks and waits for a person.
 *
 * ITS RELATION TO `authoring/useTaskSave`. Same law, different command and
 * different edit vocabulary: that hook rides `patchTask`/`PatchTaskInput`
 * (status, priority, acceptance criteria), this one rides `patchEntity`/
 * `PatchEntityInput` (title, content.body). Routing a doc body through the
 * task hook would mean sending it as `description`, which is a lie about which
 * field is being written. The DUPLICATION IS REAL AND IS NAMED IN THE HANDOVER
 * with a D-entry proposing one generic flow — deliberately not done by editing
 * `authoring/`, which is not this lane's to edit.
 *
 * TWO DIVERGENCES FROM THAT PRECEDENT, both deliberate, both flagged:
 *  1. `reload()` there calls `onReload` only `if (current)` — so a refusal that
 *     carries no document DROPS THE DRAFT and delivers nothing. Here the
 *     affordance is gated on actually holding their document (`canReload`), so
 *     the losing path is unreachable instead of silent. Reported as a suspected
 *     defect in that lane rather than fixed across a boundary.
 *  2. The conflict renders as the oracle's BANNER, not as a refusal card:
 *     T5-3 line 208 states the law for this surface — "the state lives in the
 *     footer, the conflict fact in a banner — no toasts inside an editor".
 */
import { useCallback, useRef, useState } from 'react';
import type { CommandResult, EntityDetail } from '@tm8/contract';
import { classifyFailure, type ConflictFailure, type RefusedFailure } from '../authoring';
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';
import { docBodyOf, docPatchInput, savedVersionOf, type DocCommands, type DocEdits } from './commands';

export type DocSavePhase =
  | { phase: 'clean' }
  | { phase: 'dirty' }
  | { phase: 'saving' }
  | { phase: 'conflict'; failure: ConflictFailure }
  | { phase: 'refused'; failure: RefusedFailure };

export interface DocSaveHandle {
  state: DocSavePhase;
  /** What the editor renders: the draft while dirty, the served body otherwise. */
  body: string;
  /**
   * The same value as `body`, read at CALL time rather than at render time.
   *
   * `body` is derived from React state, so a closure created when a handler ran
   * holds whatever the draft was THEN. An async caller — one that started an
   * upload and comes back seconds later — must not splice into that: every
   * keystroke typed in between lives in `draft.current`, which state has not
   * necessarily flushed. This reads the ref, so it is also correct for two
   * callbacks resolving in the same tick.
   *
   * Render code has no use for this and must keep using `body`.
   */
  liveBody(): string;
  dirty: boolean;
  /** The version the staged edits were made against; null when clean. */
  baseVersion: number | null;
  /** The version a save WOULD publish — the oracle's "Save v4". Null if unknown. */
  nextVersion: number | null;
  /** The version the last successful save produced, read off the result. */
  savedVersion: number | null;
  /** Non-null ⇒ every save affordance renders disabled-with-reason (R7/L6). */
  unavailable: UnavailableReason | null;
  /** The version that won a conflict, when the node said. */
  theirVersion: number | null;
  /** True only when we actually HOLD their document — see divergence 1. */
  canReload: boolean;
  /** True only when we know what an overwrite would be replacing. */
  canOverwrite: boolean;
  edit(edits: DocEdits): void;
  save(): Promise<void>;
  cancel(): void;
  reload(): void;
  overwrite(): Promise<void>;
  dismiss(): void;
}

export interface DocSaveOptions {
  /** Null is legal: a panel may render before its detail has hydrated. */
  detail: EntityDetail | null;
  /** Null ⇒ no executor is wired, and every control says so. */
  commands: DocCommands | null;
  onSaved?(result: CommandResult): void;
  /** Handed the server's detail when the viewer chooses "load theirs". */
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
  remedy: 'the document has not finished loading',
};

export function useDocSave(options: DocSaveOptions): DocSaveHandle {
  const { detail, commands, onSaved, onReload, editRefusal } = options;
  const [state, setState] = useState<DocSavePhase>({ phase: 'clean' });
  const [edits, setEdits] = useState<DocEdits>({});
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  /**
   * The draft lives in a ref ALONGSIDE state. React state set in the same tick
   * is not readable by a flush that follows it, so the ref is what the flush
   * reads and the state is what the UI renders. (The task flow needed this for
   * its one-gesture commit; here it keeps `save()` correct when it is called
   * from the same handler as the keystroke that dirtied the draft — ⌘enter.)
   */
  const draft = useRef<DocEdits>({});
  const base = useRef<number | null>(null);

  const unavailable =
    commands === null
      ? NO_EXECUTOR
      : detail === null
        ? NO_DETAIL
        : detail.capabilities.canEdit === false
          ? { cause: 'You cannot edit this', remedy: editRefusal ?? 'the server refuses edits here' }
          : detail.deletedAt !== null
            ? { cause: 'This is deleted', remedy: 'restore it before editing' }
            : null;

  const served = detail ? docBodyOf(detail) : '';
  const body = edits.body !== undefined ? edits.body : served;

  const liveBody = useCallback(
    () => (draft.current.body !== undefined ? draft.current.body : detail ? docBodyOf(detail) : ''),
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
        const result = await commands.patchEntity(detail.id, docPatchInput(patch, expectedVersion));
        setSavedVersion(savedVersionOf(result));
        settle();
        onSaved?.(result);
      } catch (error) {
        const failure = classifyFailure(error, 'save');
        // THE DRAFT SURVIVES BOTH ARMS. "Your draft is still yours" is the
        // oracle's own promise (line 96), and it is the difference between a
        // refusal the user can answer and one that costs them work.
        setState(failure.kind === 'conflict' ? { phase: 'conflict', failure } : { phase: 'refused', failure });
      }
    },
    [commands, detail, onSaved, settle],
  );

  const edit = useCallback(
    (patch: DocEdits) => {
      if (unavailable) return;
      draft.current = { ...draft.current, ...patch };
      setEdits(draft.current);
      if (base.current === null && detail) {
        base.current = detail.version;
        setBaseVersion(detail.version);
      }
      setState({ phase: 'dirty' });
    },
    [detail, unavailable],
  );

  const save = useCallback(async () => {
    if (unavailable || base.current === null) return;
    await flush(base.current);
  }, [flush, unavailable]);

  const cancel = useCallback(() => settle(), [settle]);

  const dismiss = useCallback(() => {
    setState(Object.keys(draft.current).length > 0 ? { phase: 'dirty' } : { phase: 'clean' });
  }, []);

  const conflict = state.phase === 'conflict' ? state.failure : null;
  const theirVersion = conflict ? conflict.currentVersion : null;
  const canReload = conflict?.current != null;
  const canOverwrite = theirVersion !== null;

  const reload = useCallback(() => {
    if (state.phase !== 'conflict') return;
    const current = state.failure.current;
    // GATED, not best-effort: without their document there is nothing to load,
    // and settling anyway would drop the draft and show the user nothing.
    if (!current) return;
    settle();
    onReload?.(current);
  }, [onReload, settle, state]);

  const overwrite = useCallback(async () => {
    if (state.phase !== 'conflict') return;
    const version = state.failure.currentVersion;
    /*
     * NULL-GUARDED, and the guard is the honesty. Without a version we do not
     * know what we would be overwriting; sending the base version again would
     * just re-conflict, and re-reading `detail.version` would be the silent
     * overwrite this whole file exists to prevent. The affordance renders
     * disabled-with-reason in that case rather than being offered and failing.
     */
    if (version === null) return;
    await flush(version);
  }, [flush, state]);

  /*
   * WHAT A SAVE WOULD PUBLISH. In a conflict it is one past THEIR version,
   * which is the number the oracle's banner promises ("Saving publishes v5
   * over their text", line 96) — not one past ours, which would name a version
   * that already exists.
   *
   * This is the one place a `+1` is legitimate: it labels an INTENTION about a
   * write that has not happened, not a fact about one that has. The fact —
   * `savedVersion` — is read off the result.
   */
  const nextVersion =
    theirVersion !== null ? theirVersion + 1 : detail ? detail.version + 1 : null;

  return {
    state,
    body,
    liveBody,
    dirty: Object.keys(edits).length > 0,
    baseVersion,
    nextVersion,
    savedVersion,
    unavailable,
    theirVersion,
    canReload,
    canOverwrite,
    edit,
    save,
    cancel,
    reload,
    overwrite,
    dismiss,
  };
}
