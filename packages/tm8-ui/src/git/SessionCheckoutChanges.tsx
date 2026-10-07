import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, SessionCheckout, SessionCheckoutDiff, SessionCheckoutFile } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView, Pill } from '../kit';
import { useMobileSurface } from '../mobile';
import { relTime } from '../kit/time';
import { buildChangeTree, visibleChangeRows } from './change-paths';
import { ChangeDirRow, ChangesViewToggle, useCollapsedFolders, type ChangesView } from './ChangesTree';
import { SessionTranscriptChanges } from './SessionTranscriptChanges';
import './session-changes.css';

/**
 * CHANGES FOR A SESSION WITHOUT A WORKTREE — read from the git checkouts in
 * its own working directory.
 *
 * WHY THIS EXISTS. Measured on prod 2026-10-07: 8 of 13 live sessions had no
 * worktree. Their agents clone into their scratch dir, edit with shell
 * commands and commit to a branch; the transcript's Edit/Write calls found
 * 0–1 files for each of them. `execution.gitCheckouts` reads those clones
 * (read-only, D2/D8) and this draws them: one section per checkout with its
 * branch, commits ahead of the remote's default branch, and every file that
 * differs — committed or not.
 *
 * TWO SOURCES, NAMED. Git answers "what is different on disk"; the transcript
 * answers "what did the agent write with its edit tools", including outside a
 * checkout. Both stay reachable through a toggle, and each says which it is.
 *
 * OLDER NODES. A server without the op answers 404; so does a session whose
 * directory holds no checkout. Either way the transcript list is the answer,
 * exactly as before this existed.
 *
 * LIVE. Polled every 5 s while the session runs (the lane rail's cadence).
 * A file whose counts moved since the previous read is tagged "just changed"
 * for 20 s — the Cursor-style "the agent is in this file now" signal, derived
 * from git rather than claimed.
 */

export const CHECKOUT_POLL_MS = 5_000;
export const CHECKOUT_JUST_CHANGED_MS = 20_000;

const CHANGE_WORD: Readonly<Record<SessionCheckoutFile['change'], string>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  '?': 'new, not yet committed',
};

type Read =
  | { phase: 'loading' }
  /** No checkout to show — the transcript answers instead. */
  | { phase: 'none' }
  | { phase: 'ready'; checkouts: SessionCheckout[]; truncated: boolean; checkedAt: string };

type DiffRead =
  | { phase: 'idle' }
  | { phase: 'loading'; key: string }
  | { phase: 'error'; key: string; message: string }
  | { phase: 'ready'; key: string; diff: SessionCheckoutDiff };

export interface SessionCheckoutChangesProps {
  seam: Seam;
  sessionId: EntityId;
  live: boolean;
  /** Why the lane rail cannot answer — handed through to the transcript list. */
  cause: string;
  noWorktree: boolean;
}

const keyOf = (checkout: string, path: string) => `${checkout}\u0000${path}`;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function countsSig(f: SessionCheckoutFile): string {
  return `${f.change}:${f.additions ?? 'b'}:${f.deletions ?? 'b'}:${f.uncommitted ? 1 : 0}`;
}

function lastCommitLabel(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const rel = relTime(iso, now.getTime());
  return rel === '' ? null : rel;
}

export function SessionCheckoutChanges({ seam, sessionId, live, cause, noWorktree }: SessionCheckoutChangesProps) {
  const { oneSurface } = useMobileSurface();
  const [read, setRead] = useState<Read>({ phase: 'loading' });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [source, setSource] = useState<'git' | 'transcript'>('git');
  const [view, setView] = useState<ChangesView>(oneSurface ? 'list' : 'tree');
  const { collapsed, toggle } = useCollapsedFolders();
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const [movedAt, setMovedAt] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const [diff, setDiff] = useState<DiffRead>({ phase: 'idle' });
  // A node without the op fails every read the same way; stop asking it.
  const [unsupported, setUnsupported] = useState(false);
  const ticket = useRef(0);
  const diffTicket = useRef(0);
  const prevSigs = useRef<Map<string, string> | null>(null);
  const openRef = useRef<{ checkout: string; path: string } | null>(null);

  const loadDiff = useCallback(
    async (checkout: string, path: string, quiet = false) => {
      const mine = ++diffTicket.current;
      const key = keyOf(checkout, path);
      openRef.current = { checkout, path };
      if (!quiet) setDiff({ phase: 'loading', key });
      try {
        const d = await seam.gitCheckoutDiff(sessionId, checkout, path);
        if (mine !== diffTicket.current) return;
        setDiff({ phase: 'ready', key, diff: d });
      } catch (e) {
        if (mine !== diffTicket.current) return;
        setDiff({ phase: 'error', key, message: messageOf(e) });
      }
    },
    [seam, sessionId],
  );

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const res = await seam.gitCheckouts(sessionId);
      if (mine !== ticket.current) return;
      setRefreshError(null);
      const checkouts = res.available ? res.checkouts.filter((c) => c.readable) : [];
      if (checkouts.length === 0) {
        setRead({ phase: 'none' });
        return;
      }
      // "Just changed": the first read is a baseline; later reads tag every
      // file whose letter, counts or committed-ness moved.
      const sigs = new Map<string, string>();
      for (const c of checkouts) for (const f of c.files) sigs.set(keyOf(c.name, f.path), countsSig(f));
      const prev = prevSigs.current;
      prevSigs.current = sigs;
      const t = Date.now();
      setNow(t);
      if (prev !== null) {
        const moved: string[] = [];
        for (const [k, sig] of sigs) if (prev.get(k) !== sig) moved.push(k);
        if (moved.length > 0) {
          setMovedAt((m) => {
            const next = new Map(m);
            for (const k of moved) next.set(k, t);
            return next;
          });
          const open = openRef.current;
          if (open !== null && moved.includes(keyOf(open.checkout, open.path))) {
            void loadDiff(open.checkout, open.path, true);
          }
        }
      }
      setRead({ phase: 'ready', checkouts, truncated: res.checkoutsTruncated, checkedAt: res.checkedAt });
    } catch (e) {
      if (mine !== ticket.current) return;
      // A node without the op (404) or a failed first read: the transcript
      // answers. A failed REFRESH keeps what it drew and says it is stale.
      setRead((prev) => {
        if (prev.phase === 'ready') return prev;
        setUnsupported(true);
        return { phase: 'none' };
      });
      setRefreshError(messageOf(e));
    }
  }, [seam, sessionId, loadDiff]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live || unsupported) return undefined;
    const timer = setInterval(() => void load(), CHECKOUT_POLL_MS);
    return () => clearInterval(timer);
  }, [live, unsupported, load]);

  const transcript = (
    <SessionTranscriptChanges seam={seam} sessionId={sessionId} live={live} cause={cause} noWorktree={noWorktree} />
  );

  if (read.phase === 'loading') {
    return (
      <div className="pn-chg" data-testid="session-changes-body" data-source="checkouts">
        <p className="pn-chg__note" data-testid="session-changes-checkouts-loading">
          Looking for the git checkouts this session works in…
        </p>
      </div>
    );
  }
  if (read.phase === 'none') return transcript;

  const sourceToggle = (
    <div className="pn-chg__view" role="group" aria-label="Where the changes are read from">
      <button
        type="button"
        className="pn-chg__view-btn"
        aria-pressed={source === 'git'}
        data-testid="session-changes-source-git"
        onClick={() => setSource('git')}
      >
        In git
      </button>
      <button
        type="button"
        className="pn-chg__view-btn"
        aria-pressed={source === 'transcript'}
        data-testid="session-changes-source-transcript"
        onClick={() => setSource('transcript')}
      >
        Agent edits
      </button>
    </div>
  );

  if (source === 'transcript') {
    return (
      <div className="pn-chg__sources" data-testid="session-changes-sources">
        <div className="pn-chg__source-bar">{sourceToggle}</div>
        {transcript}
      </div>
    );
  }

  const { checkouts } = read;
  const nowDate = new Date(now);
  const total = checkouts.reduce(
    (acc, c) => ({
      files: acc.files + c.stat.filesChanged,
      add: acc.add + c.stat.additions,
      del: acc.del + c.stat.deletions,
    }),
    { files: 0, add: 0, del: 0 },
  );
  const openKey = diff.phase === 'idle' ? null : diff.key;
  const showList = !oneSurface || openKey === null;
  const showDiff = !oneSurface || openKey !== null;
  const justChanged = (k: string) => {
    const at = movedAt.get(k);
    return at !== undefined && now - at < CHECKOUT_JUST_CHANGED_MS;
  };

  const fileRow = (c: SessionCheckout, f: SessionCheckoutFile, label: string, depth: number) => {
    const k = keyOf(c.name, f.path);
    const fresh = justChanged(k);
    return (
      <li
        key={k}
        className={`pn-chg__file${openKey === k ? ' pn-chg__file--open' : ''}`}
        data-testid="session-changes-file"
        data-path={f.path}
        data-checkout={c.name}
        data-just-changed={fresh ? 'true' : undefined}
        style={{ '--pn-chg-depth': depth } as never}
      >
        <code className="pn-chg__status" data-change={f.change === '?' ? 'U' : f.change} title={CHANGE_WORD[f.change]}>
          {f.change === '?' ? 'U' : f.change}
        </code>
        <button
          type="button"
          className="pn-chg__open"
          title={`${f.path} — ${CHANGE_WORD[f.change]}${f.uncommitted && f.change !== '?' ? ', edited since the last commit' : ''}`}
          data-testid="session-changes-open"
          data-path={f.path}
          onClick={() => void loadDiff(c.name, f.path)}
        >
          <span className="pn-chg__path">{label}</span>
        </button>
        {fresh ? (
          <span
            className={`pn-chg__turn${live ? ' pn-chg__turn--live' : ''}`}
            data-testid="session-changes-just-changed"
            title="Changed on disk since the previous read a few seconds earlier"
          >
            <span aria-hidden className="pn-chg__turn-dot" />
            just changed
          </span>
        ) : f.uncommitted && f.change !== '?' ? (
          <span className="pn-chg__uncommitted" data-testid="session-changes-uncommitted" title="Edited since the last commit">
            ●
          </span>
        ) : null}
        {f.additions === null || f.deletions === null ? (
          <span className="pn-chg__row-counts pn-chg__binary">bin</span>
        ) : (
          <span className="pn-chg__row-counts" data-testid="session-changes-row-counts">
            <span className="pn-chg__added">+{f.additions}</span>
            <span className="pn-chg__removed">−{f.deletions}</span>
          </span>
        )}
      </li>
    );
  };

  const section = (c: SessionCheckout) => {
    const isShut = shut.has(c.name);
    const tree = buildChangeTree(c.files.map((f) => ({ rel: f.path, item: f })));
    // Folder paths repeat across checkouts; the collapsed set is keyed per checkout.
    const prefix = `${c.name}\u0000`;
    const mineShut = new Set([...collapsed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
    const lastCommit = lastCommitLabel(c.lastCommitAt, nowDate);
    const anyFresh = c.files.some((f) => justChanged(keyOf(c.name, f.path)));
    return (
      <section key={c.name} className="pn-chg__checkout" data-testid="session-changes-checkout" data-checkout={c.name}>
        <button
          type="button"
          className="pn-chg__checkout-head"
          aria-expanded={!isShut}
          data-testid="session-changes-checkout-toggle"
          onClick={() =>
            setShut((s) => {
              const next = new Set(s);
              if (next.has(c.name)) next.delete(c.name);
              else next.add(c.name);
              return next;
            })
          }
        >
          <span aria-hidden className="pn-chg__twisty">
            {isShut ? '▸' : '▾'}
          </span>
          <code className="pn-chg__checkout-name" title={c.remote ?? undefined}>
            {c.name === '.' ? 'working directory' : c.name}
          </code>
          {c.branch !== null ? <span className="pn-chg__branch">{c.branch}</span> : <span className="pn-chg__branch">detached</span>}
          {anyFresh && isShut ? <span aria-hidden className="pn-chg__turn-dot pn-chg__turn--live" /> : null}
          <span className="pn-chg__counts">
            <span className="pn-chg__added">+{c.stat.additions}</span>
            <span className="pn-chg__removed">−{c.stat.deletions}</span>
          </span>
        </button>
        <p className="pn-chg__checkout-facts" data-testid="session-changes-checkout-facts">
          {c.baseRef !== null && c.ahead !== null
            ? `${c.ahead} commit${c.ahead === 1 ? '' : 's'} ahead of ${c.baseRef}`
            : 'no upstream — showing uncommitted edits only'}
          {` · ${c.uncommitted} uncommitted`}
          {lastCommit !== null ? ` · last commit ${lastCommit}` : ''}
          {c.shared ? ' · shared directory: other sessions’ changes show here too' : ''}
        </p>
        {isShut ? null : c.files.length === 0 ? (
          <p className="pn-chg__note">No changes against {c.baseRef ?? 'HEAD'}.</p>
        ) : (
          <ul className="pn-chg__files" data-testid="session-changes-files" data-view={view}>
            {view === 'list'
              ? c.files.map((f) => fileRow(c, f, f.path, 0))
              : visibleChangeRows(tree, mineShut).map(({ node, depth }) =>
                  node.kind === 'dir' ? (
                    <ChangeDirRow
                      key={`dir:${c.name}:${node.path}`}
                      dir={node}
                      depth={depth}
                      open={!mineShut.has(node.path)}
                      onToggle={() => toggle(prefix + node.path)}
                    />
                  ) : (
                    fileRow(c, node.item, node.name, depth)
                  ),
                )}
          </ul>
        )}
        {c.filesTruncated ? (
          <p className="pn-chg__note" data-testid="session-changes-truncated">
            Showing the first {c.files.length} of {c.stat.filesChanged} changed files.
          </p>
        ) : null}
      </section>
    );
  };

  return (
    <div
      className="pn-chg"
      data-testid="session-changes-body"
      data-source="checkouts"
      data-arrangement={oneSurface ? 'phone' : 'desktop'}
      data-pane={openKey === null ? 'list' : 'diff'}
    >
      <div className="pn-chg__header" data-testid="session-changes-header">
        {live ? <span aria-hidden className="pn-chg__live-dot" title="Updating every few seconds" /> : null}
        <span className="pn-chg__source">Changed in git</span>
        <Pill tone={total.files === 0 ? 'idle' : 'info'}>
          {total.files === 0 ? 'no changes' : `${total.files} file${total.files === 1 ? '' : 's'}`}
        </Pill>
        <span className="pn-chg__counts" data-testid="session-changes-totals">
          <span className="pn-chg__added">+{total.add}</span>
          <span className="pn-chg__removed">−{total.del}</span>
        </span>
        <button type="button" className="pn-chg__refresh" data-testid="session-changes-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="pn-chg__list-head">
        {sourceToggle}
        <ChangesViewToggle view={view} onChange={setView} />
      </div>

      <p className="pn-chg__note" data-testid="session-changes-provenance">
        Read from the git checkout{checkouts.length === 1 ? '' : 's'} in this session’s working directory — committed and
        uncommitted work against the remote’s default branch. Read-only.
      </p>

      {refreshError !== null ? (
        <p className="pn-chg__error" role="alert" data-testid="session-changes-refresh-error">
          Could not refresh — showing the last read. {refreshError}
        </p>
      ) : null}

      <div className="pn-chg__split">
        {showList ? (
          <div className="pn-chg__list-pane">
            {checkouts.map(section)}
            {read.truncated ? (
              <p className="pn-chg__note">More checkouts exist in this directory than are shown.</p>
            ) : null}
          </div>
        ) : null}
        {showDiff ? (
          <div className="pn-chg__diff-pane" data-testid="session-changes-diff-pane">
            {oneSurface ? (
              <button
                type="button"
                className="pn-chg__back"
                data-testid="session-changes-back"
                onClick={() => {
                  openRef.current = null;
                  setDiff({ phase: 'idle' });
                }}
              >
                <span aria-hidden>←</span> All changed files
              </button>
            ) : null}
            {diff.phase === 'idle' ? (
              <p className="pn-chg__note">Choose a file to see its diff.</p>
            ) : diff.phase === 'loading' ? (
              <p className="pn-chg__note">Reading the diff…</p>
            ) : diff.phase === 'error' ? (
              <p className="pn-chg__error" role="alert" data-testid="session-changes-diff-error">
                Could not read this diff: {diff.message}
              </p>
            ) : (
              <>
                <div className="pn-chg__diff-head" data-testid="session-changes-diff-head">
                  <span className="pn-chg__path" title={diff.diff.path}>
                    {diff.diff.path}
                  </span>
                  <span className="pn-chg__scope">
                    {CHANGE_WORD[diff.diff.change]} · vs {diff.diff.baseRef ?? 'HEAD'}
                  </span>
                </div>
                {diff.diff.diff === '' ? (
                  <p className="pn-chg__note">No text diff (binary, or nothing left to show).</p>
                ) : (
                  <DiffView diff={diff.diff.diff} />
                )}
                {diff.diff.diffTruncated ? (
                  <p className="pn-chg__note" data-testid="session-changes-diff-truncated">
                    The diff is cut at the byte cap — the counts are exact.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
