import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, SessionGitDiff, SessionGitFile, SessionGitStatus } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView, Pill } from '../kit';
import { useMobileSurface } from '../mobile';
import { DisabledAction } from '../panels/honesty/DisabledWithReason';
import {
  CHANGE_FILTERS,
  CHANGE_FILTER_LABEL,
  FILTER_SCOPE,
  SCOPE_CAPTION,
  isPartlyStaged,
  isStaged,
  isUnmerged,
  isUnstaged,
  matchesFilter,
  statusTitle,
  type ChangeFilter,
} from './change-state';
import './session-changes.css';

/**
 * THE CHANGES SURFACE — review what this session changed, and choose what goes
 * into the next commit.
 *
 * WHY IT IS NOT PART OF THE GIT RAIL. `SessionGitBody` answers "where is this
 * lane": branch, ahead/behind, and the verbs that move the lane — checkpoint,
 * rollback, merge, cherry-pick, branch, stash. This answers a different
 * question — "what changed, and what am I about to commit" — and it answers it
 * file by file. Folding the two would make one panel with two jobs and a
 * ~900-line body; forking the STATUS READ would be worse still, because then
 * two surfaces would each have their own idea of what "staged" means. So: one
 * read (`gitStatus`), one diff renderer (`DiffView`), one set of git verbs
 * (`execution.git*`), two surfaces over them.
 *
 * SELF-FETCHING, and mounted only while its chip is selected — unmounting is
 * what stops the poll, exactly as the Git, Debug and Graph surfaces work.
 *
 * WHAT THIS SURFACE REFUSES TO DO, on purpose:
 *
 *   · NO CHECKOUT. Nothing here changes which branch the worktree is on. An
 *     agent may be running in this worktree right now; moving its branch
 *     underneath it would break the lane identity every commit is attributed
 *     through. The absence is deliberate and is not a gap to fill later.
 *
 *   · NO "LAST AGENT TURN" ATTRIBUTION. The file list is git's answer, which
 *     means "changed since the lane branched" — NOT "changed by the agent's
 *     most recent turn". Git cannot tell those apart: a shell command the
 *     agent ran, a human editing in the same worktree and the agent's own
 *     edits all land in the same status. The transcript-sourced view
 *     (`SessionFileChanges`) carries its own caption saying it is observed
 *     from the transcript and not from git, and it stays where it is; this
 *     surface makes no claim about authorship at all.
 *
 *   · NO SILENT WIDENING OF A COMMIT. See the `stagedOutside` gate below.
 *
 * WHAT IT DOES OFFER, added after the first cut shipped:
 *
 *   · PART OF A FILE. `git add -p` without the prompt — tick the `@@` lines
 *     you want and stage only those. The client sends INDICES into the diff
 *     the server just computed, never patch text: a patch accepted from a
 *     client and fed to `git apply --cached` is a write primitive for every
 *     path in the repository, and `--cached` means it would not even have to
 *     touch the working tree to reach the next commit. It also echoes the
 *     `hunkDigest` from the read it is choosing against, so an agent that
 *     rewrites the file between render and click gets a refusal rather than a
 *     stage of code nobody looked at.
 *
 *     ONE COMPARISON AT A TIME. Hunks are offered under Staged and Unstaged
 *     and refused under All, because "the session diff" is neither the index
 *     nor the working tree — there is no side for a partial patch to apply
 *     against. The refusal says so by name rather than hiding the control.
 *
 *   · A PHONE ARRANGEMENT — see `oneSurface` below. The first cut refused the
 *     phone outright on the grounds that reviewing means reading a diff and
 *     holding a selection across several files at once. The selection part was
 *     never the problem: a selection is state, and it survives a screen it is
 *     not drawn on. The reading part was, and the answer is to stop trying to
 *     show both at once — the phone gets the list, or one full-width diff with
 *     a way back, and never a 390px column split in two.
 */

const POLL_MS = 5_000;

export interface SessionChangesBodyProps {
  seam: Seam;
  sessionId: EntityId;
  /** The session is running — poll status. Exited ⇒ one read, no poll. */
  live: boolean;
}

type StatusState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; status: SessionGitStatus };

type DiffScope = 'session' | 'staged' | 'unstaged';

/**
 * The open diff is identified by BOTH path and scope. Keying it by path alone
 * would let a slow `unstaged` answer for `a.ts` land on top of the `staged`
 * answer the user asked for a moment later — same path, so a path-only guard
 * waves it through, and the pane then shows the wrong comparison under the
 * right heading. See `ticket` in `loadDiff`.
 */
type DiffState =
  | { phase: 'idle' }
  | { phase: 'loading'; path: string; scope: DiffScope }
  | { phase: 'error'; path: string; scope: DiffScope; message: string }
  | { phase: 'ready'; path: string; scope: DiffScope; diff: SessionGitDiff };

type Verb = 'stage' | 'unstage' | 'commit';

/**
 * The hunk verbs say HUNKS out loud. "Stage" on its own already means the
 * whole-file button in the bar below, and two controls reading the same word
 * over two different scopes is how a reviewer stages a file they meant to
 * take three lines of.
 */
const HUNK_VERB_LABEL: Readonly<Record<'stage' | 'unstage', string>> = {
  stage: 'Stage hunks',
  unstage: 'Unstage hunks',
};

/**
 * The refusal wording is written for THIS surface rather than shared with the
 * Git rail's copy: "the rail cannot show you a branch" and "there are no files
 * to review here" are different facts, and a reader is better served by the
 * one that names what they just clicked on.
 */
const UNAVAILABLE_CAUSE: Record<string, string> = {
  no_worktree:
    'This session has no isolated worktree, so there is no set of changed files to review — it runs in a scratch or shared project directory.',
  worktree_not_active: 'This session’s worktree is no longer active, so its changes cannot be read.',
  worktree_unreadable:
    'This session’s worktree exists but its files are not readable on this node right now.',
};

function shortOid(oid: string | null): string {
  return oid ? oid.slice(0, 10) : '—';
}

/**
 * `git numstat` prints `-` for a binary file's counts, which the contract
 * carries as `null`. `+null` is a bug on screen and `+0` is a lie — it claims
 * git measured no change when git declined to measure at all.
 */
function countText(n: number | null): string {
  return n === null ? '—' : String(n);
}

/**
 * This surface always asks for ONE path, so the per-file row is the honest
 * source for its counts: `stat` sums the files it could count and silently
 * drops the binary ones, which would render a binary file as `+0 −0`. The
 * `stat` fallback covers a server answer with no numstat row at all.
 */
function diffRowCount(d: SessionGitDiff, key: 'additions' | 'deletions'): number | null {
  const row = d.files[0];
  return row === undefined ? d.stat[key] : row[key];
}

function diffRowIsBinary(d: SessionGitDiff): boolean {
  const row = d.files[0];
  return row !== undefined && row.additions === null && row.deletions === null;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

export function SessionChangesBody({ seam, sessionId, live }: SessionChangesBodyProps) {
  /**
   * THE FORK IS `oneSurface`, NOT A WIDTH — the same stance `ReaderSurface`
   * takes and for the same reason: off the phone shell there is no provider,
   * so the phone arrangement is unreachable by construction rather than by a
   * media query that would also fire on a narrowed desktop window.
   */
  const { oneSurface } = useMobileSurface();
  const [status, setStatus] = useState<StatusState>({ phase: 'loading' });
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [diff, setDiff] = useState<DiffState>({ phase: 'idle' });
  /**
   * Ticked hunk indices for the diff that is open RIGHT NOW.
   *
   * Cleared by every diff read, including the re-read a mutation does in its
   * own `finally`. It has to be: an index is 1-based into the hunks of ONE
   * read, and after staging hunk 2 of four, "2" in the next read is a
   * different piece of code. Carrying the set across would leave a tick on
   * screen that points somewhere else — the exact failure the digest exists to
   * catch on the server, arriving from our own side instead.
   */
  const [hunkSel, setHunkSel] = useState<ReadonlySet<number>>(() => new Set());
  const [busy, setBusy] = useState<Verb | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasLoaded = useRef(false);
  /** The row whose diff is open, so a refresh can re-read the same file. */
  const openPath = useRef<string | null>(null);
  /**
   * A monotonic ticket per diff request. Only the newest one may write to the
   * pane: filter chips and row clicks both fire reads, they are not ordered by
   * the network, and a late answer is not merely stale — it is an answer to a
   * DIFFERENT QUESTION (a different scope, or a different file) that would be
   * rendered under the current question's heading.
   */
  const diffTicket = useRef(0);
  /**
   * The same ticket for status, and for the same reason. A live poll every
   * few seconds overlaps every click: a poll can START before Stage, the
   * post-action read can answer, and then the PRE-action poll can land last
   * and redraw the index as it was before the button was pressed — with the
   * commit gate (`stagedOutside`) computed from that stale index, so the
   * button refuses a commit the server would have accepted, or offers one it
   * would not. Only the newest read may write.
   */
  const statusTicket = useRef(0);
  /**
   * The filter as it is RIGHT NOW, not as it was when a mutation started.
   *
   * `runVerb` re-reads the open diff in its `finally`, which can land long
   * after the click. Reading `filter` out of that closure would ask for the
   * scope that was selected when the button was pressed, and because the
   * refresh takes a fresh ticket it would WIN over the chip's own newer read —
   * the pane would show the old comparison under the new chip. So the refresh
   * reads this ref instead.
   *
   * The chip handler writes it SYNCHRONOUSLY, before `setFilter`. An effect
   * alone would not do: it runs after the render React schedules, and an
   * in-flight mutation whose `finally` resolves inside that window would still
   * read the old scope. The effect below is a backstop for any other route
   * that ever changes `filter`, and is a no-op on the chip path.
   */
  const filterRef = useRef<ChangeFilter>('all');
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const loadStatus = useCallback(async () => {
    const ticket = ++statusTicket.current;
    try {
      const next = await seam.gitStatus(sessionId);
      if (ticket !== statusTicket.current) return;
      hasLoaded.current = true;
      setStatus({ phase: 'ready', status: next });
      // A path that is no longer dirty cannot stay selected: it would make
      // "3 selected" a claim about files that are not on screen, and the
      // commit gate below is computed from exactly this set.
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const live = new Set(next.files.map((f) => f.path));
        const kept = new Set([...prev].filter((p) => live.has(p)));
        return kept.size === prev.size ? prev : kept;
      });
    } catch (err) {
      if (ticket !== statusTicket.current) return;
      // A transient poll failure must not blank an already-rendered list.
      if (!hasLoaded.current) {
        setStatus({ phase: 'error', message: messageOf(err, 'Git status read failed') });
      }
    }
  }, [seam, sessionId]);

  const loadDiff = useCallback(
    async (path: string, scope: DiffScope) => {
      openPath.current = path;
      const ticket = ++diffTicket.current;
      setDiff({ phase: 'loading', path, scope });
      setHunkSel(new Set());
      try {
        // PATH-SCOPED ON THE SERVER, not sliced here: the whole-session diff is
        // byte-capped, so a file past the cap is absent from it rather than
        // truncated — the files a reviewer most needs are exactly the ones
        // client-side slicing would fail to find.
        const next = await seam.gitDiff(sessionId, { path, scope });
        if (ticket !== diffTicket.current) return;
        setDiff({ phase: 'ready', path, scope, diff: next });
      } catch (err) {
        if (ticket !== diffTicket.current) return;
        setDiff({ phase: 'error', path, scope, message: messageOf(err, 'Diff read failed') });
      }
    },
    [seam, sessionId],
  );

  /**
   * Back, on the phone. It takes a ticket so an in-flight read cannot land on
   * a pane the reviewer has already left, and drops `openPath` so a mutation's
   * refresh does not quietly reopen the file they just closed.
   */
  const closeDiff = useCallback(() => {
    diffTicket.current += 1;
    openPath.current = null;
    setDiff({ phase: 'idle' });
    setHunkSel(new Set());
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void loadStatus(), POLL_MS);
    return () => clearInterval(timer);
  }, [live, loadStatus]);

  const runVerb = useCallback(
    async (verb: Verb, run: () => Promise<string>) => {
      setBusy(verb);
      setActionError(null);
      try {
        setReceipt(await run());
      } catch (err) {
        setActionError(messageOf(err, `${verb} failed`));
      } finally {
        setBusy(null);
        await loadStatus();
        const path = openPath.current;
        // The open diff is re-read too: staging a file changes which
        // comparison its bytes belong to, and a stale pane would be showing
        // the answer to the previous question.
        if (path !== null) await loadDiff(path, FILTER_SCOPE[filterRef.current]);
      }
    },
    [loadDiff, loadStatus],
  );

  const files: readonly SessionGitFile[] = status.phase === 'ready' ? status.status.files : [];
  /**
   * COUNTED FROM `dirty`, NOT FROM THE ROWS ON SCREEN.
   *
   * The server caps `files`; `dirty` is the whole-worktree tally and is never
   * capped. Counting the rows would make the chips agree with the list and
   * both be wrong together on a big change — "3 untracked" over a truncated
   * list, when there are ninety. The truncation note under the list says the
   * list is short; the chips say how much there actually is.
   *
   * `staged + unstaged` can exceed `all`, deliberately: an `MM` path has a
   * pending change in both halves and appears under both chips.
   */
  const counts = useMemo(() => {
    if (status.phase !== 'ready') return { all: 0, staged: 0, unstaged: 0, untracked: 0 };
    const { dirty } = status.status;
    return { all: dirty.total, staged: dirty.staged, unstaged: dirty.unstaged, untracked: dirty.untracked };
  }, [status]);
  const shown = useMemo(() => files.filter((f) => matchesFilter(f, filter)), [files, filter]);
  const selectedFiles = useMemo(() => files.filter((f) => selected.has(f.path)), [files, selected]);

  /**
   * THE GATE THIS SURFACE EXISTS TO HOLD.
   *
   * `git commit` writes the whole INDEX, not the paths it was handed. So a
   * "Commit selected" that stages the selection and commits would also sweep
   * in any file that was already staged for some other reason — a commit
   * containing work the reviewer never looked at, with nothing on screen
   * saying so. The server refuses that case by name
   * (`staged_outside_selection`); this states it BEFORE the click, names the
   * files, and offers the two honest ways out: unstage them, or select them.
   *
   * COMPUTED FROM THE CAPPED LIST, which is why it is a COURTESY and not the
   * control. When `filesTruncated` is set, a staged file past the cap is not
   * on this screen and this gate cannot see it — so the server does the same
   * check against the whole index and refuses the click. The gate makes the
   * common case visible before the press; the server makes every case safe.
   */
  const stagedOutside = useMemo(
    () => (selected.size === 0 ? [] : files.filter((f) => isStaged(f) && !selected.has(f.path)).map((f) => f.path)),
    [files, selected],
  );
  const partlyStagedSelection = useMemo(() => selectedFiles.filter(isPartlyStaged), [selectedFiles]);

  /**
   * CONFLICTED PATHS — the three verbs on this bar are ALL refused while one
   * exists, so the surface says it once instead of three times.
   *
   * `stage`, `unstage` and `commit` each call `refuseMidMerge` before they
   * touch the index (`git-mutations.ts`), and it asks one question:
   * does `MERGE_HEAD` exist. Not "is this path conflicted" — the whole
   * worktree is refused, so narrowing the selection is not a way out and the
   * bar must not imply it is.
   *
   * INFERRED FROM THE ROWS, BECAUSE THE READ DOES NOT CARRY THE FLAG.
   * `SessionGitStatus` has no `mergeInProgress` field, so this is the closest
   * true thing the client can see, and it is not the same predicate: a merge
   * whose conflicts have all been resolved with `git add` but not yet
   * committed has `MERGE_HEAD` and ZERO `U` rows. That case still reaches the
   * server and is still refused by name — the banner is what makes the common
   * case legible before the click, not what makes it safe. Same shape as
   * `stagedOutside` above, and capped the same way: a conflict past the file
   * cap is not on this screen and the server is the one that catches it.
   */
  const conflicted = useMemo(() => files.filter(isUnmerged).map((f) => f.path), [files]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleHunk = useCallback((index: number) => {
    setHunkSel((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const selectShown = useCallback(() => {
    setSelected(new Set(shown.map((f) => f.path)));
  }, [shown]);

  if (status.phase === 'loading') {
    return (
      <div className="pn-chg" data-testid="session-changes-body">
        <p className="pn-chg__note">Reading changed files…</p>
      </div>
    );
  }
  if (status.phase === 'error') {
    return (
      <div className="pn-chg" data-testid="session-changes-body">
        <p className="pn-chg__error" role="alert">
          Changed files could not be read: {status.message}
        </p>
      </div>
    );
  }

  const s = status.status;

  if (!s.available) {
    const cause =
      UNAVAILABLE_CAUSE[s.unavailableReason ?? ''] ?? 'Changed files are unavailable for this session.';
    return (
      <div className="pn-chg" data-testid="session-changes-body">
        <div className="pn-chg__empty" data-testid="session-changes-unavailable">
          <p className="pn-chg__note">{cause}</p>
          {s.unavailableReason === 'no_worktree' ? (
            <p className="pn-chg__remedy">spawn with workdir mode “worktree” to get a reviewable lane</p>
          ) : null}
        </div>
      </div>
    );
  }

  const scope = FILTER_SCOPE[filter];
  const clean = s.dirty.total === 0;
  const selectionCount = selected.size;
  // A conflict refuses the WORKTREE, not the selection — see `conflicted`.
  const conflictBlocked = conflicted.length > 0;
  const canStage = !conflictBlocked && selectedFiles.some((f) => !isStaged(f) || isUnstaged(f));
  const canUnstage = !conflictBlocked && selectedFiles.some(isStaged);
  const conflictCause = `${conflicted.length} path(s) are unresolved in a merge: ${conflicted
    .slice(0, 3)
    .join(', ')}${conflicted.length > 3 ? '…' : ''}`;
  const conflictRemedy = 'resolve or abort the merge in a terminal — tm8 never finishes a merge for you';
  const selectedPaths = [...selected];

  /*
   * THE PHONE SHOWS ONE PANE, and which one is simply whether a file is open.
   * There is no third state and no animation to get wrong: the list IS the
   * back destination, and `closeDiff` is the only way to it.
   */
  const showList = !oneSurface || diff.phase === 'idle';
  const showDiff = !oneSurface || diff.phase !== 'idle';

  const openDiff = diff.phase === 'ready' ? diff.diff : null;
  const hunkList = openDiff === null || openDiff.hunks === null || openDiff.hunks.length === 0
    ? null
    : openDiff.hunks;
  /*
   * WHICH VERB A TICKED HUNK MEANS, and it is not a choice.
   *
   * The unstaged diff is index → working tree, so a hunk taken out of it goes
   * INTO the index: stage. The staged diff is HEAD → index, so a hunk taken
   * out of it comes back OUT: unstage. Offering both buttons over one scope
   * would offer one that cannot work — the patch simply would not apply — so
   * the surface shows the one the comparison on screen supports.
   */
  const hunkAction: Verb = openDiff !== null && openDiff.scope === 'staged' ? 'unstage' : 'stage';
  /*
   * WHY THERE ARE NO HUNKS, said by name. The server refuses in this order and
   * this mirrors it, so a reviewer reading the two side by side sees the same
   * reason rather than two guesses at it.
   */
  const hunkRefusal =
    openDiff === null || hunkList !== null
      ? null
      : openDiff.scope === 'session'
        ? 'Choosing hunks needs a one-sided comparison. The session diff compares this lane against where it branched, which is neither the index nor the working tree — there is no side for a partial patch to apply to. Pick Staged or Unstaged.'
        : openDiff.diffTruncated
          ? 'The server cut this diff at its byte cap, so these are not all of the file’s hunks. Numbering a choice against a partial list would stage something other than what was ticked.'
          : openDiff.untracked
            ? 'Untracked — git has no index entry to apply a partial patch against, so this file goes in whole or not at all.'
            : diffRowIsBinary(openDiff)
              ? 'Binary — git has no lines here to divide into hunks.'
              : 'This comparison has no hunks to choose from.';

  return (
    <div
      className="pn-chg"
      data-testid="session-changes-body"
      data-arrangement={oneSurface ? 'phone' : 'desktop'}
      data-pane={diff.phase === 'idle' ? 'list' : 'diff'}
    >
      {/* -- header: whose changes these are, and how many ------------------- */}
      <div className="pn-chg__header" data-testid="session-changes-header">
        <span className="pn-chg__branch" title={`branch ${s.branch ?? ''}`}>
          <span aria-hidden className="pn-chg__branch-glyph">⎇</span>
          {s.branch ?? '(detached)'}
        </span>
        <Pill tone={clean ? 'idle' : 'info'}>
          {clean ? 'clean' : `${s.dirty.total} changed`}
        </Pill>
        <span className="pn-chg__base">
          base {s.baseRef ?? shortOid(s.baseOid)} · head {shortOid(s.headOid)}
        </span>
        <button
          type="button"
          className="pn-chg__refresh"
          data-testid="session-changes-refresh"
          onClick={() => void loadStatus()}
        >
          Refresh
        </button>
      </div>

      {/*
        -- the merge banner -------------------------------------------------

        ABOVE THE FILTERS ON PURPOSE. A conflicted row answers none of the
        three filter chips (it is neither staged nor unstaged — git holds it
        at stages 1/2/3, with no stage-0 entry to compare either way), so a
        reviewer narrowed to `staged` would otherwise see an empty list and a
        dead Commit button with nothing on screen saying why. The banner sits
        outside the filtered list and names the paths whatever chip is on.
      */}
      {conflictBlocked ? (
        <div className="pn-chg__conflict" role="alert" data-testid="session-changes-conflict">
          <span className="pn-chg__conflict-title">Merge conflict — staging and committing are refused</span>
          <ul className="pn-chg__conflict-paths">
            {conflicted.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          <span className="pn-chg__conflict-remedy">{conflictRemedy}</span>
        </div>
      ) : null}

      {/*
        -- filters: the four states, each with its count ----------------------

        `group` + `aria-pressed`, NOT `tablist` + `tab`. These look like tabs
        and are not: a tab owns a `tabpanel` it shows and hides, is reached
        with the arrow keys once the strip has focus, and is announced as one
        of N tabs. These four narrow ONE list that is always on screen, they
        own no panel to point `aria-controls` at, and they answer to Tab like
        the ordinary buttons they are. Claiming the tab role would promise a
        screen-reader user keyboard behaviour this strip does not implement
        and a panel relationship that does not exist; `aria-pressed` says the
        true thing — a toggle, and which one is currently on.
      */}
      <div className="pn-chg__filters" role="group" aria-label="Filter changed files">
        {CHANGE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={`pn-chg__filter${filter === f ? ' pn-chg__filter--on' : ''}`}
            data-testid={`session-changes-filter-${f}`}
            onClick={() => {
              // Synchronously first: a mutation refresh that resolves between
              // this click and React's re-render must see the NEW scope.
              filterRef.current = f;
              setFilter(f);
              // The comparison changed, so the open diff is answering the old
              // question until it is re-read.
              const path = openPath.current;
              if (path !== null) void loadDiff(path, FILTER_SCOPE[f]);
            }}
          >
            {CHANGE_FILTER_LABEL[f]}
            <span className="pn-chg__filter-count">{counts[f]}</span>
          </button>
        ))}
      </div>

      <div className="pn-chg__split">
        {/* -- the file list ------------------------------------------------- */}
        {showList ? (
        <div className="pn-chg__list-pane">
          {shown.length === 0 ? (
            <p className="pn-chg__note" data-testid="session-changes-empty">
              {/* `dirty` is porcelain — the working tree and index against
                  HEAD. It is NOT everything this lane has done since it
                  branched, and saying so would tell a reviewer their committed
                  work had vanished. */}
              {clean
                ? 'No uncommitted changes in this worktree.'
                : `No ${CHANGE_FILTER_LABEL[filter].toLowerCase()} files — ${s.dirty.total} changed file(s) are in other states.`}
            </p>
          ) : (
            <>
              <div className="pn-chg__list-head">
                <button
                  type="button"
                  className="pn-chg__link"
                  data-testid="session-changes-select-all"
                  onClick={selectShown}
                >
                  Select all {shown.length}
                </button>
                {selectionCount > 0 ? (
                  <button
                    type="button"
                    className="pn-chg__link"
                    data-testid="session-changes-clear"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear selection
                  </button>
                ) : null}
              </div>
              <ul className="pn-chg__files" data-testid="session-changes-files">
                {shown.map((f) => {
                  const isOpen = diff.phase !== 'idle' && diff.path === f.path;
                  return (
                    <li
                      key={f.path}
                      className={`pn-chg__file${isOpen ? ' pn-chg__file--open' : ''}`}
                      data-testid="session-changes-file"
                      data-path={f.path}
                      data-status={f.status}
                    >
                      <input
                        type="checkbox"
                        className="pn-chg__check"
                        checked={selected.has(f.path)}
                        aria-label={`Select ${f.path}`}
                        data-testid="session-changes-check"
                        data-path={f.path}
                        onChange={() => toggle(f.path)}
                      />
                      <button
                        type="button"
                        className="pn-chg__open"
                        title={statusTitle(f)}
                        data-testid="session-changes-open"
                        data-path={f.path}
                        onClick={() => void loadDiff(f.path, scope)}
                      >
                        <code className="pn-chg__status">{f.status}</code>
                        <span className="pn-chg__path">{f.path}</span>
                        {isPartlyStaged(f) ? (
                          <span className="pn-chg__split-badge" title="staged and unstaged changes in the same file">
                            split
                          </span>
                        ) : null}
                      </button>
                      <span className="pn-chg__row-verbs">
                        {/* Not `disabled` — there is no verb here to disable.
                            `git add` on an unmerged path RESOLVES it, which
                            is a decision about content, not a staging step,
                            and this surface does not make that decision. */}
                        {isUnmerged(f) ? (
                          <span className="pn-chg__row-note" data-testid="session-changes-row-conflict">
                            conflicted
                          </span>
                        ) : null}
                        {isUnmerged(f) || (isStaged(f) && !isUnstaged(f)) ? null : (
                          <button
                            type="button"
                            className="pn-chg__row-verb"
                            disabled={busy !== null}
                            data-testid="session-changes-row-stage"
                            data-path={f.path}
                            onClick={() =>
                              void runVerb('stage', async () => {
                                const r = await seam.commands.gitStage(sessionId, {
                                  action: 'stage',
                                  paths: [f.path],
                                });
                                return `staged ${f.path} — ${r.dirty.staged} file(s) now staged`;
                              })
                            }
                          >
                            Stage
                          </button>
                        )}
                        {isStaged(f) && !isUnmerged(f) ? (
                          <button
                            type="button"
                            className="pn-chg__row-verb"
                            disabled={busy !== null}
                            data-testid="session-changes-row-unstage"
                            data-path={f.path}
                            onClick={() =>
                              void runVerb('unstage', async () => {
                                const r = await seam.commands.gitStage(sessionId, {
                                  action: 'unstage',
                                  paths: [f.path],
                                });
                                return `unstaged ${f.path} — ${r.dirty.staged} file(s) still staged (no working-tree bytes moved)`;
                              })
                            }
                          >
                            Unstage
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {s.filesTruncated ? (
                <p className="pn-chg__note" data-testid="session-changes-truncated">
                  The server capped this list — more files changed than are shown.
                </p>
              ) : null}
            </>
          )}
        </div>
        ) : null}

        {/* -- the diff for one file ----------------------------------------- */}
        {showDiff ? (
        <div className="pn-chg__diff-pane" data-testid="session-changes-diff-pane">
          {/*
            THE PHONE'S ONLY WAY BACK, and it is a real control rather than a
            desktop button hidden by CSS: on the desktop both panes are on
            screen at once and there is nothing to go back to, so the button
            does not exist there at all.
          */}
          {oneSurface ? (
            <button
              type="button"
              className="pn-chg__back"
              data-testid="session-changes-back"
              onClick={closeDiff}
            >
              <span aria-hidden>←</span> All changed files
            </button>
          ) : null}
          {diff.phase === 'idle' ? (
            <p className="pn-chg__note">Choose a file to see what changed in it.</p>
          ) : diff.phase === 'loading' ? (
            <p className="pn-chg__note">Reading {diff.path}…</p>
          ) : diff.phase === 'error' ? (
            <p className="pn-chg__error" role="alert" data-testid="session-changes-diff-error">
              {diff.path}: {diff.message}
            </p>
          ) : (
            <>
              <div className="pn-chg__diff-head" data-testid="session-changes-diff-head">
                <span className="pn-chg__path">{diff.path}</span>
                <span className="pn-chg__scope" data-testid="session-changes-diff-scope" data-scope={diff.diff.scope}>
                  {diff.diff.scope} — {SCOPE_CAPTION[diff.diff.scope]}
                </span>
                {diffRowIsBinary(diff.diff) ? (
                  <span className="pn-chg__binary" data-testid="session-changes-diff-binary">
                    binary — git counts no lines here
                  </span>
                ) : (
                  <span className="pn-chg__counts">
                    <span className="pn-chg__added">+{countText(diffRowCount(diff.diff, 'additions'))}</span>
                    <span className="pn-chg__removed">−{countText(diffRowCount(diff.diff, 'deletions'))}</span>
                  </span>
                )}
              </div>
              {diff.diff.untracked ? (
                <p className="pn-chg__note" data-testid="session-changes-diff-untracked">
                  Untracked — git has nothing to compare this against, so the whole file reads as an addition.
                </p>
              ) : null}
              {diff.diff.diffTruncated ? (
                <p className="pn-chg__note" data-testid="session-changes-diff-truncated">
                  The server cut this diff at its byte cap; the counts above are complete.
                </p>
              ) : null}
              {/* -- choosing part of the file ------------------------------ */}
              {hunkList !== null ? (
                <div className="pn-chg__hunks" data-testid="session-changes-hunk-bar" data-scope={diff.diff.scope}>
                  <span className="pn-chg__hunk-count" data-testid="session-changes-hunk-count">
                    {hunkSel.size === 0
                      ? `${hunkList.length} hunk${hunkList.length === 1 ? '' : 's'} — tick the @@ lines to take only some`
                      : `${hunkSel.size} of ${hunkList.length} hunk${hunkList.length === 1 ? '' : 's'} selected`}
                  </span>
                  <button
                    type="button"
                    className="pn-chg__link"
                    data-testid="session-changes-hunk-all"
                    onClick={() => setHunkSel(new Set(hunkList.map((h) => h.index)))}
                  >
                    Select all {hunkList.length}
                  </button>
                  {hunkSel.size > 0 ? (
                    <button
                      type="button"
                      className="pn-chg__link"
                      data-testid="session-changes-hunk-clear"
                      onClick={() => setHunkSel(new Set())}
                    >
                      Clear hunks
                    </button>
                  ) : null}
                  {hunkSel.size === 0 ? (
                    <DisabledAction
                      reason={{
                        cause: `No hunks are ticked, so there is nothing to ${hunkAction}.`,
                        remedy: 'tick the @@ lines you want, or use Select all',
                      }}
                    >
                      {HUNK_VERB_LABEL[hunkAction]}
                    </DisabledAction>
                  ) : (
                    <button
                      type="button"
                      className="pn-chg__verb"
                      disabled={busy !== null}
                      data-testid="session-changes-hunk-apply"
                      data-action={hunkAction}
                      onClick={() =>
                        void runVerb(hunkAction, async () => {
                          const indices = [...hunkSel].sort((a, b) => a - b);
                          // The digest is echoed back UNCHANGED from the read
                          // these indices were chosen against. It is what makes
                          // an agent writing the file mid-review a refusal
                          // rather than a stage of code nobody read.
                          const digest = diff.diff.hunkDigest;
                          const r = await seam.commands.gitStage(sessionId, {
                            action: hunkAction,
                            hunks: {
                              path: diff.path,
                              indices,
                              ...(digest === null ? {} : { digest }),
                            },
                          });
                          const applied = r.hunkSelection;
                          return applied === undefined
                            ? `${hunkAction}d ${indices.length} hunk(s) in ${diff.path}`
                            : `${hunkAction}d ${applied.applied} of ${applied.total} hunk(s) in ${applied.path}`;
                        })
                      }
                    >
                      {busy === hunkAction
                        ? `${hunkAction === 'stage' ? 'Staging' : 'Unstaging'} ${hunkSel.size}…`
                        : `${HUNK_VERB_LABEL[hunkAction]} (${hunkSel.size})`}
                    </button>
                  )}
                </div>
              ) : hunkRefusal !== null ? (
                <p className="pn-chg__note" data-testid="session-changes-hunk-refusal">
                  {hunkRefusal}
                </p>
              ) : null}

              {diff.diff.diff === '' ? (
                <p className="pn-chg__note" data-testid="session-changes-diff-empty">
                  No changes to this file in the {diff.diff.scope} comparison.
                </p>
              ) : (
                <DiffView
                  diff={diff.diff.diff}
                  selection={hunkList === null ? undefined : { selected: hunkSel, onToggle: toggleHunk, disabled: busy !== null }}
                />
              )}
            </>
          )}
        </div>
        ) : null}
      </div>

      {/* -- the commit bar --------------------------------------------------- */}
      <div className="pn-chg__bar" data-testid="session-changes-bar">
        <span className="pn-chg__selection" data-testid="session-changes-selection-count">
          {selectionCount === 0 ? 'No files selected' : `${selectionCount} selected`}
        </span>

        {canStage ? (
          <button
            type="button"
            className="pn-chg__verb"
            disabled={busy !== null}
            data-testid="session-changes-stage"
            onClick={() =>
              void runVerb('stage', async () => {
                const r = await seam.commands.gitStage(sessionId, { action: 'stage', paths: selectedPaths });
                return `staged ${selectedPaths.length} path(s) — ${r.dirty.staged} file(s) now staged`;
              })
            }
          >
            {busy === 'stage' ? 'Staging…' : 'Stage selected'}
          </button>
        ) : (
          <DisabledAction
            reason={
              conflictBlocked
                ? { cause: conflictCause, remedy: conflictRemedy }
                : {
                    cause:
                      selectionCount === 0
                        ? 'Nothing is selected to stage.'
                        : 'Everything selected is already staged in full.',
                  }
            }
          >
            Stage selected
          </DisabledAction>
        )}

        {canUnstage ? (
          <button
            type="button"
            className="pn-chg__verb"
            disabled={busy !== null}
            data-testid="session-changes-unstage"
            onClick={() =>
              void runVerb('unstage', async () => {
                const r = await seam.commands.gitStage(sessionId, { action: 'unstage', paths: selectedPaths });
                return `unstaged ${selectedPaths.length} path(s) — ${r.dirty.staged} file(s) still staged (no working-tree bytes moved)`;
              })
            }
          >
            {busy === 'unstage' ? 'Unstaging…' : 'Unstage selected'}
          </button>
        ) : (
          <DisabledAction
            reason={
              conflictBlocked
                ? { cause: conflictCause, remedy: conflictRemedy }
                : {
                    cause:
                      selectionCount === 0
                        ? 'Nothing is selected to unstage.'
                        : 'Nothing selected is staged, so there is nothing to take out of the index.',
                    remedy: 'unstage moves the index only — it never changes a file on disk',
                  }
            }
          >
            Unstage selected
          </DisabledAction>
        )}

        <input
          className="pn-chg__message"
          placeholder="commit message"
          value={commitMessage}
          data-testid="session-changes-commit-message"
          onChange={(e) => setCommitMessage(e.target.value)}
        />

        {/* Conflict is tested FIRST: it outranks an empty selection and an
            empty message, because those two are things the reviewer can fix
            on this screen and this one is not. */}
        {conflictBlocked ? (
          <span className="pn-chg__gate" data-testid="session-changes-conflict-gate">
            <DisabledAction reason={{ cause: conflictCause, remedy: conflictRemedy }}>
              Commit selected
            </DisabledAction>
          </span>
        ) : selectionCount === 0 ? (
          <DisabledAction reason={{ cause: 'Select the files this commit should contain.' }}>
            Commit selected
          </DisabledAction>
        ) : commitMessage.trim() === '' ? (
          <DisabledAction reason={{ cause: 'A commit needs a message.' }}>Commit selected</DisabledAction>
        ) : stagedOutside.length > 0 ? (
          <span className="pn-chg__gate" data-testid="session-changes-outside-gate">
            <DisabledAction
              reason={{
                cause: `${stagedOutside.length} staged file(s) are outside this selection: ${stagedOutside
                  .slice(0, 3)
                  .join(', ')}${stagedOutside.length > 3 ? '…' : ''}`,
                remedy: 'git commits the whole index — unstage them, or select them too',
              }}
            >
              Commit selected
            </DisabledAction>
            <button
              type="button"
              className="pn-chg__verb"
              disabled={busy !== null}
              data-testid="session-changes-unstage-outside"
              onClick={() =>
                void runVerb('unstage', async () => {
                  const r = await seam.commands.gitStage(sessionId, {
                    action: 'unstage',
                    paths: stagedOutside,
                  });
                  return `unstaged ${stagedOutside.length} file(s) outside the selection — ${r.dirty.staged} file(s) still staged`;
                })
              }
            >
              Unstage the others
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="pn-chg__verb pn-chg__verb--primary"
            disabled={busy !== null}
            data-testid="session-changes-commit"
            onClick={() =>
              void runVerb('commit', async () => {
                const r = await seam.commands.gitCommit(sessionId, {
                  message: commitMessage.trim(),
                  paths: selectedPaths,
                });
                setCommitMessage('');
                setSelected(new Set());
                return `committed ${shortOid(r.oid)} on ${r.branch} (${r.files.length} file(s))`;
              })
            }
          >
            {busy === 'commit' ? 'Committing…' : 'Commit selected'}
          </button>
        )}
      </div>

      {partlyStagedSelection.length > 0 ? (
        <p className="pn-chg__note" data-testid="session-changes-partial-note">
          {partlyStagedSelection.length} selected file(s) have unstaged changes as well. Commit selected
          commits the file as the INDEX has it, not as the disk has it. Open one under Staged or
          Unstaged to see which half is which, and to move single hunks between them.
        </p>
      ) : null}

      {receipt ? (
        <p className="pn-chg__receipt" data-testid="session-changes-receipt">
          {receipt}
        </p>
      ) : null}
      {actionError ? (
        <p className="pn-chg__error" role="alert" data-testid="session-changes-error">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
