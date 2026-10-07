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
 * WHAT THIS HOOK NEVER DOES: re-read the version, merge, or resolve a conflict
 * over text someone else changed. Such a conflict parks and waits for a person.
 *
 * THE ONE RETRY. A conflict whose winning write left every field this save
 * touches as it was when the draft began (someone moved a task's status while
 * you typed its description) is not a conflict over your text. When the node
 * sends its current record and that is provably so, the same edits go out
 * ONCE more against the new version. Anything less certain parks as above.
 *
 * THE CODEC. A kind's read and write ends ride `SaveCodec` (`commands.ts`);
 * the doc codec is the default, and a task or story passes its own.
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
 *
 * AUTOSAVE (New doc UX, Subhang 2026-10-06: "saves itself as you type").
 * Opt-in, so a host that wants the manual flow keeps it. With it on:
 *  - a pause of `autosaveDelayMs` after the last edit saves the draft, and
 *    `flush()` saves at once (leaving the editor, closing the tab — the hook
 *    also flushes when it unmounts);
 *  - every edit is mirrored to the device (`localDraft.ts`) with its base
 *    version, and a mirrored draft is restored when the document opens again;
 *  - a conflict PARKS autosave: typing keeps adding to the draft, nothing is
 *    sent, and the banner still owns the answer.
 * The base-version law above is unchanged. A save that lands moves the base
 * to the version it wrote, and keystrokes typed while it was in flight stay in
 * the draft for the next save instead of being dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResult, EntityDetail, EntityId } from '@tm8/contract';
import { classifyFailure, type ConflictFailure, type RefusedFailure } from '../authoring';
import type { UnavailableReason } from '../panels/honesty/DisabledWithReason';
import { docCodec, savedVersionOf, type DocCommands, type DocEdits, type SaveCodec } from './commands';
import { clearLocalDraft, readLocalDraft, writeLocalDraft } from './localDraft';
import { clearLiveTitle, setLiveTitle } from './liveTitles';

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
  /** The title the editor renders, by the same rule as `body`. */
  title: string;
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
  /** True when this handle saves on its own (see AUTOSAVE above). */
  autosave: boolean;
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
  /** Save what is pending now. A no-op when clean, already saving, or in a conflict. */
  flush(): Promise<void>;
  cancel(): void;
  reload(): void;
  overwrite(): Promise<void>;
  dismiss(): void;
}

export interface DocSaveOptions<C = DocCommands> {
  /** Null is legal: a panel may render before its detail has hydrated. */
  detail: EntityDetail | null;
  /** Null ⇒ no executor is wired, and every control says so. */
  commands: C | null;
  /** The kind's read and write ends. Absent ⇒ the doc codec. Pass a stable (module) value. */
  codec?: SaveCodec<C>;
  onSaved?(result: CommandResult): void;
  /** Handed the server's detail when the viewer chooses "load theirs". */
  onReload?(current: EntityDetail): void;
  /**
   * The honest sentence for a server-refused edit, from the registry's
   * `panel.capabilityReasons.canEdit`. Registry DATA in — this lane never
   * authors a per-kind reason.
   */
  editRefusal?: string;
  /** Save on a pause in typing, flush on unmount, mirror to the device. */
  autosave?: boolean;
  /** The pause, in ms. Defaults to `AUTOSAVE_DELAY_MS`. */
  autosaveDelayMs?: number;
}

export const AUTOSAVE_DELAY_MS = 800;

const NO_EXECUTOR: UnavailableReason = {
  cause: 'Saving is not wired here',
  remedy: 'this surface was mounted without a command executor',
};

const NO_DETAIL: UnavailableReason = {
  cause: 'Nothing to save yet',
  remedy: 'the document has not finished loading',
};

/**
 * What the last save wrote, held until the served detail catches up with it.
 * Without this the editor would snap back to the served (older) text between
 * a save landing and the host's refetch — under autosave, mid-sentence.
 */
interface Echo {
  id: string;
  edits: DocEdits;
  version: number;
}

/** What the draft's fields were when it began: the test for the one retry. */
interface DraftBase {
  title: string;
  body: string;
}

export function useDocSave(options: DocSaveOptions<DocCommands>): DocSaveHandle;
export function useDocSave<C>(options: DocSaveOptions<C> & { codec: SaveCodec<C> }): DocSaveHandle;
export function useDocSave<C>(options: DocSaveOptions<C>): DocSaveHandle {
  const { detail, commands, onSaved, onReload, editRefusal } = options;
  // The overloads make the default reachable only where `C` is `DocCommands`.
  const codec = (options.codec ?? docCodec) as SaveCodec<C>;
  const autosave = options.autosave === true;
  const delay = options.autosaveDelayMs ?? AUTOSAVE_DELAY_MS;
  const [state, setPhaseState] = useState<DocSavePhase>({ phase: 'clean' });
  const [edits, setEdits] = useState<DocEdits>({});
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [echo, setEcho] = useState<Echo | null>(null);

  /**
   * The draft lives in a ref ALONGSIDE state. React state set in the same tick
   * is not readable by a flush that follows it, so the ref is what the flush
   * reads and the state is what the UI renders. (The task flow needed this for
   * its one-gesture commit; here it keeps `save()` correct when it is called
   * from the same handler as the keystroke that dirtied the draft — ⌘enter.)
   */
  const draft = useRef<DocEdits>({});
  const base = useRef<number | null>(null);
  /** The document the draft was typed into — a flush writes there and nowhere else. */
  const owner = useRef<string | null>(null);
  /** Bumped by every edit, so a landing save knows whether more was typed meanwhile. */
  const seq = useRef(0);
  const inFlight = useRef(false);
  const phase = useRef<DocSavePhase['phase']>('clean');
  const echoRef = useRef<Echo | null>(null);
  const draftBase = useRef<DraftBase | null>(null);

  const setState = useCallback((next: DocSavePhase) => {
    phase.current = next.phase;
    setPhaseState(next);
  }, []);

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

  const echoAhead = (e: Echo | null): DocEdits | null =>
    e && detail && e.id === detail.id && detail.version < e.version ? e.edits : null;
  const shown = echoAhead(echo);
  const served = detail ? codec.bodyOf(detail) : '';
  const body = edits.body ?? shown?.body ?? served;
  const title = edits.title ?? shown?.title ?? detail?.title ?? '';

  const liveBody = useCallback(() => {
    if (draft.current.body !== undefined) return draft.current.body;
    const e = echoRef.current;
    if (e && detail && e.id === detail.id && detail.version < e.version && e.edits.body !== undefined) return e.edits.body;
    return detail ? codec.bodyOf(detail) : '';
  }, [codec, detail]);

  const settle = useCallback(() => {
    if (owner.current !== null) {
      clearLocalDraft(owner.current);
      clearLiveTitle(owner.current);
    }
    draft.current = {};
    base.current = null;
    owner.current = null;
    draftBase.current = null;
    setEdits({});
    setBaseVersion(null);
    setState({ phase: 'clean' });
  }, [setState]);

  /**
   * The version to send the same edits again on, or null to park. Only when
   * the node sent its current record and every field being saved still reads
   * as it did when the draft began: then the winning write was elsewhere.
   */
  const rebaseFor = useCallback(
    (error: unknown, patch: DocEdits): number | null => {
      const failure = classifyFailure(error, 'save');
      const began = draftBase.current;
      if (failure.kind !== 'conflict' || failure.current === null || failure.currentVersion === null || began === null) {
        return null;
      }
      const theirs = failure.current;
      if (patch.title !== undefined && theirs.title !== began.title) return null;
      if (patch.body !== undefined && codec.bodyOf(theirs) !== began.body) return null;
      return failure.currentVersion;
    },
    [codec],
  );

  /** THE one place a patch is sent. Every path above lands here. */
  const flush = useCallback(
    async (expectedVersion: number) => {
      const id = owner.current;
      if (commands === null || id === null || inFlight.current) return;
      const patch = draft.current;
      if (Object.keys(patch).length === 0) return;
      const at = seq.current;
      inFlight.current = true;
      setState({ phase: 'saving' });
      try {
        let result: CommandResult;
        try {
          result = await codec.send(commands, id as EntityId, patch, expectedVersion);
        } catch (error) {
          const rebased = owner.current === id ? rebaseFor(error, patch) : null;
          if (rebased === null) throw error;
          result = await codec.send(commands, id as EntityId, patch, rebased);
        }
        const saved = savedVersionOf(result);
        // A different document took this slot while the save was in flight:
        // its state is not ours to settle.
        if (owner.current !== id) {
          onSaved?.(result);
          return;
        }
        setSavedVersion(saved);
        if (saved !== null) {
          const prior = echoRef.current?.id === id ? echoRef.current.edits : {};
          echoRef.current = { id, edits: { ...prior, ...patch }, version: saved };
          setEcho(echoRef.current);
        }
        if (seq.current === at) {
          settle();
        } else {
          // Typed while the save was in flight: the rest of the draft now sits
          // on the version just written, and goes out with the next save.
          base.current = saved ?? expectedVersion;
          setBaseVersion(base.current);
          const began = draftBase.current;
          if (began) draftBase.current = { title: patch.title ?? began.title, body: patch.body ?? began.body };
          if (autosave) writeLocalDraft(id, { edits: draft.current, baseVersion: base.current });
          setState({ phase: 'dirty' });
        }
        onSaved?.(result);
      } catch (error) {
        if (owner.current !== id) {
          clearLiveTitle(id);
          return;
        }
        const failure = classifyFailure(error, 'save');
        // THE DRAFT SURVIVES BOTH ARMS. "Your draft is still yours" is the
        // oracle's own promise (line 96), and it is the difference between a
        // refusal the user can answer and one that costs them work.
        setState(failure.kind === 'conflict' ? { phase: 'conflict', failure } : { phase: 'refused', failure });
      } finally {
        inFlight.current = false;
      }
    },
    [autosave, codec, commands, onSaved, rebaseFor, setState, settle],
  );

  const edit = useCallback(
    (patch: DocEdits) => {
      if (unavailable || detail === null) return;
      if (owner.current !== null && owner.current !== detail.id) return;
      owner.current = detail.id;
      draft.current = { ...draft.current, ...patch };
      seq.current += 1;
      if (patch.title !== undefined) setLiveTitle(detail.id, patch.title);
      setEdits(draft.current);
      if (base.current === null) {
        const e = echoRef.current;
        const ahead = e && e.id === detail.id && e.version > detail.version ? e : null;
        base.current = ahead ? ahead.version : detail.version;
        draftBase.current = {
          title: ahead?.edits.title ?? detail.title,
          body: ahead?.edits.body ?? codec.bodyOf(detail),
        };
        setBaseVersion(base.current);
      }
      if (autosave) writeLocalDraft(detail.id, { edits: draft.current, baseVersion: base.current });
      // Mid-save, the landing save decides what comes next; in a conflict
      // under autosave the banner does — typing never quietly clears it.
      if (phase.current === 'saving' || (autosave && phase.current === 'conflict')) return;
      setState({ phase: 'dirty' });
    },
    [autosave, codec, detail, setState, unavailable],
  );

  const save = useCallback(async () => {
    if (unavailable || base.current === null) return;
    await flush(base.current);
  }, [flush, unavailable]);

  const flushNow = useCallback(async () => {
    if (phase.current === 'conflict' || phase.current === 'saving') return;
    await save();
  }, [save]);

  const cancel = useCallback(() => settle(), [settle]);

  const dismiss = useCallback(() => {
    setState(Object.keys(draft.current).length > 0 ? { phase: 'dirty' } : { phase: 'clean' });
  }, [setState]);

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
   * A DIFFERENT DOCUMENT IN THE SAME SLOT starts clean. The old draft is not
   * carried onto it: under autosave it is already on the device and comes
   * back when its own document opens; without autosave the host has already
   * left the editor (see `ReaderSurface`).
   */
  const detailId = detail?.id ?? null;
  const lastId = useRef(detailId);
  useEffect(() => {
    if (detailId === lastId.current) return;
    lastId.current = detailId;
    draft.current = {};
    base.current = null;
    owner.current = null;
    draftBase.current = null;
    seq.current += 1;
    setEdits({});
    setBaseVersion(null);
    setSavedVersion(null);
    setState({ phase: 'clean' });
  }, [detailId, setState]);

  /* RESTORE a device copy once per document, when it says something the
     server does not. Same text ⇒ the save landed; the copy is just dropped. */
  const restoredFor = useRef<string | null>(null);
  const editable = unavailable === null;
  useEffect(() => {
    if (!autosave || !editable || detail === null || restoredFor.current === detail.id) return;
    restoredFor.current = detail.id;
    const stored = readLocalDraft(detail.id);
    if (!stored) return;
    const same =
      (stored.edits.body === undefined || stored.edits.body === codec.bodyOf(detail)) &&
      (stored.edits.title === undefined || stored.edits.title === detail.title);
    if (same) {
      clearLocalDraft(detail.id);
      return;
    }
    owner.current = detail.id;
    draft.current = stored.edits;
    base.current = stored.baseVersion;
    seq.current += 1;
    setEdits(stored.edits);
    setBaseVersion(stored.baseVersion);
    setState({ phase: 'dirty' });
  }, [autosave, codec, editable, detail, setState]);

  /* THE PAUSE. Every edit re-arms it; only a dirty draft arms it at all. */
  const latestFlush = useRef(flushNow);
  latestFlush.current = flushNow;
  useEffect(() => {
    if (!autosave || state.phase !== 'dirty') return;
    const timer = setTimeout(() => void latestFlush.current(), delay);
    return () => clearTimeout(timer);
  }, [autosave, delay, state.phase, edits]);

  /* LEAVING saves: the surface unmounting (tab switch, close) and the page
     going away. The device copy covers whatever a dying page cannot send. */
  useEffect(() => {
    if (!autosave) return;
    const onHide = () => void latestFlush.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      void latestFlush.current();
    };
  }, [autosave]);

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
  const currentVersion = shown && echo ? echo.version : detail ? detail.version : null;
  const nextVersion = theirVersion !== null ? theirVersion + 1 : currentVersion !== null ? currentVersion + 1 : null;

  return {
    state,
    body,
    title,
    liveBody,
    dirty: Object.keys(edits).length > 0,
    autosave,
    baseVersion,
    nextVersion,
    savedVersion,
    unavailable,
    theirVersion,
    canReload,
    canOverwrite,
    edit,
    save,
    flush: flushNow,
    cancel,
    reload,
    overwrite,
    dismiss,
  };
}
