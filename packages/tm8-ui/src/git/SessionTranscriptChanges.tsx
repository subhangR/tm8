import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId, SessionFileChange, SessionTranscriptPage } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DiffView, Pill } from '../kit';
import { useMobileSurface } from '../mobile';
import {
  buildChangeTree,
  commonDir,
  filesUnder,
  keepRepoChanges,
  relativeTo,
  visibleChangeRows,
} from './change-paths';
import { ChangeDirRow, ChangesViewToggle, useCollapsedFolders, type ChangesView } from './ChangesTree';
import { diffTextOf, elidedCount } from './SessionFileChanges';
import './session-changes.css';

/**
 * CHANGES FOR A SESSION GIT CANNOT ANSWER FOR — the files its agent wrote,
 * read from the agent's transcript.
 *
 * WHY THIS EXISTS. The Changes tab used to refuse every session without a
 * tm8 worktree ("spawn with workdir mode worktree"), and on this node that is
 * a third of all sessions: scratch runs, and runs in the shared project
 * checkout. A human asking "which files is this agent changing?" got a remedy
 * for the NEXT session instead of an answer about this one. Gate decision D1
 * (2026-10-07): such a session shows its transcript edits now; the read-only
 * git half arrives with the server work.
 *
 * WHAT IT CAN AND CANNOT CLAIM. The source is the Edit/Write tool calls the
 * harness recorded — attribution git cannot give in a shared checkout — and
 * the surface says so in words, because a reader who takes this for
 * `git diff` will trust it wrong:
 *
 *   · a file the agent changed with a shell command is NOT listed;
 *   · a hunk is what the agent wrote at the time, not what is on disk now —
 *     a later edit by anyone may have replaced it;
 *   · there is no "new file" letter, because a Write over an existing file
 *     and a Write that creates one look the same in a transcript.
 *
 * READ-ONLY. Nothing here stages, commits, discards or checks out: there is
 * no lane to do it in, and in a shared checkout the index belongs to whoever
 * else is working there (D2).
 *
 * "LATEST TURN" IS THE TRANSCRIPT'S OWN FACT (`SessionFileChange.lastTurn`),
 * which is why it may appear here and never on the lane's git list: porcelain
 * cannot tell an agent's last turn from a human's edit, a transcript can.
 * It is shown only when the session has had more than one turn — with one,
 * the latest turn IS the whole session, every file carries it, and a marker
 * on every row says nothing. The words stay "latest turn" while the session
 * runs; only the dot pulses. "Editing now" would claim the turn is still in
 * progress, which a finished tool call cannot tell us.
 *
 * COST. `files: true` makes the server scan the whole transcript, and
 * transcripts here reach 150 MB. So this reads on open, on Refresh, and every
 * 30 s while the session is live — not on the lane's 5 s poll.
 */

export const TRANSCRIPT_POLL_MS = 30_000;

const TRANSCRIPT_UNAVAILABLE: Readonly<Record<NonNullable<SessionTranscriptPage['unavailableReason']>, string>> = {
  no_native_session_id:
    'This session started before tm8 recorded transcript ids, so there is no transcript to read its edits from.',
  unsupported_agent_tool: 'This agent writes no transcript tm8 can read, so its edits cannot be listed.',
  no_transcript_file:
    'The agent has not written a transcript yet — it has edited nothing so far, or the file was cleaned up.',
  unreadable: 'The agent’s transcript exists but could not be read on this node.',
};

type Read =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'unavailable'; reason: string }
  | { phase: 'no-accounting' }
  | {
      phase: 'ready';
      kept: ReturnType<typeof keepRepoChanges>;
      turns: number;
      filesTruncated: boolean;
    };

export interface SessionTranscriptChangesProps {
  seam: Seam;
  sessionId: EntityId;
  /** Poll only a session that can still write files. */
  live: boolean;
  /** Why git cannot answer for this session — said once, above the list. */
  cause: string;
  /** The session has no worktree at all, so the remedy is a spawn mode. */
  noWorktree: boolean;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function LatestTurnMark({ live }: { live: boolean }) {
  return (
    <span
      className={`pn-chg__turn${live ? ' pn-chg__turn--live' : ''}`}
      data-testid="session-changes-latest-turn"
      title="The agent’s most recent turn wrote this file (read from its transcript)"
    >
      <span aria-hidden className="pn-chg__turn-dot" />
      latest turn
    </span>
  );
}

export function SessionTranscriptChanges({ seam, sessionId, live, cause, noWorktree }: SessionTranscriptChangesProps) {
  const { oneSurface } = useMobileSurface();
  const [read, setRead] = useState<Read>({ phase: 'loading' });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Tree on the desktop, where there is room to indent; the phone's one
  // narrow column reads a flat list better (A18).
  const [view, setView] = useState<ChangesView>(oneSurface ? 'list' : 'tree');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const { collapsed, toggle } = useCollapsedFolders();
  // Reads are not ordered by the network. Only the newest one may draw.
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const page = await seam.transcript(sessionId, { last: 1, files: true });
      if (mine !== ticket.current) return;
      setRefreshError(null);
      if (!page.available) {
        setRead({
          phase: 'unavailable',
          reason: TRANSCRIPT_UNAVAILABLE[page.unavailableReason ?? 'unreadable'],
        });
        return;
      }
      const changes = page.fileChanges ?? null;
      if (changes === null) {
        setRead({ phase: 'no-accounting' });
        return;
      }
      setRead({
        phase: 'ready',
        kept: keepRepoChanges(changes),
        turns: changes.turns,
        filesTruncated: changes.filesTruncated,
      });
    } catch (e) {
      if (mine !== ticket.current) return;
      // A failed REFRESH keeps the list it already drew and says it is stale;
      // only a first read with nothing to show becomes the error state.
      setRead((prev) => (prev.phase === 'ready' ? prev : { phase: 'error', message: messageOf(e) }));
      setRefreshError(messageOf(e));
    }
  }, [seam, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => void load(), TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const files = useMemo(
    () =>
      read.phase === 'ready'
        ? [...read.kept.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        : [],
    [read],
  );
  const root = useMemo(() => commonDir(files.map((f) => f.path)), [files]);
  const tree = useMemo(
    () => buildChangeTree(files.map((f) => ({ rel: relativeTo(root, f.path), item: f }))),
    [files, root],
  );

  const remedy = noWorktree ? (
    <p className="pn-chg__remedy" data-testid="session-changes-readonly">
      Read-only. Staging and committing need a tm8 worktree lane — spawn with workdir mode “worktree”.
    </p>
  ) : null;

  if (read.phase !== 'ready') {
    const note =
      read.phase === 'loading'
        ? 'Reading the files this session’s agent wrote…'
        : read.phase === 'error'
          ? `Could not read this session’s transcript: ${read.message}`
          : read.phase === 'unavailable'
            ? read.reason
            : // Codex records patches in an envelope the server does not parse
              // yet; it says null rather than guess, and so does this.
              'This agent’s transcript format does not record file edits tm8 can read yet, so its changed files cannot be listed.';
    return (
      <div className="pn-chg" data-testid="session-changes-body" data-source="transcript">
        <div className="pn-chg__empty" data-testid="session-changes-unavailable">
          <p className="pn-chg__note">{cause}</p>
          <p
            className={read.phase === 'error' ? 'pn-chg__error' : 'pn-chg__note'}
            role={read.phase === 'error' ? 'alert' : undefined}
            data-testid="session-changes-transcript-state"
            data-phase={read.phase}
          >
            {note}
          </p>
          {read.phase === 'error' ? (
            <button
              type="button"
              className="pn-chg__refresh"
              data-testid="session-changes-refresh"
              onClick={() => void load()}
            >
              Retry
            </button>
          ) : null}
          {remedy}
        </div>
      </div>
    );
  }

  const { kept, turns, filesTruncated } = read;
  const showsTurn = turns > 1;
  const open: SessionFileChange | null = files.find((f) => f.path === openPath) ?? null;
  const showList = !oneSurface || open === null;
  const showDiff = !oneSurface || open !== null;
  const openDiff = open === null ? null : diffTextOf(open);
  const openElided = open === null ? 0 : elidedCount(open);

  const fileRow = (f: SessionFileChange, label: string, depth: number) => {
    const isOpen = open?.path === f.path;
    const marked = showsTurn && f.lastTurn;
    return (
      <li
        key={f.path}
        className={`pn-chg__file${isOpen ? ' pn-chg__file--open' : ''}`}
        data-testid="session-changes-file"
        data-path={f.path}
        data-latest-turn={marked ? 'true' : undefined}
        style={{ '--pn-chg-depth': depth } as never}
      >
        <button
          type="button"
          className="pn-chg__open"
          title={f.path}
          data-testid="session-changes-open"
          data-path={f.path}
          onClick={() => setOpenPath(f.path)}
        >
          <span className="pn-chg__path">{label}</span>
        </button>
        {marked ? <LatestTurnMark live={live} /> : null}
        <span className="pn-chg__counts">
          <span className="pn-chg__added">+{f.linesAdded}</span>
          <span className="pn-chg__removed">−{f.linesRemoved}</span>
        </span>
      </li>
    );
  };

  return (
    <div
      className="pn-chg"
      data-testid="session-changes-body"
      data-source="transcript"
      data-arrangement={oneSurface ? 'phone' : 'desktop'}
      data-pane={open === null ? 'list' : 'diff'}
    >
      <div className="pn-chg__header" data-testid="session-changes-header">
        <span className="pn-chg__source">Files the agent wrote</span>
        <Pill tone={files.length === 0 ? 'idle' : 'info'}>
          {files.length === 0 ? 'none yet' : `${files.length} file${files.length === 1 ? '' : 's'}`}
        </Pill>
        <span className="pn-chg__counts" data-testid="session-changes-totals">
          <span className="pn-chg__added">+{kept.totalAdded}</span>
          <span className="pn-chg__removed">−{kept.totalRemoved}</span>
        </span>
        <button
          type="button"
          className="pn-chg__refresh"
          data-testid="session-changes-refresh"
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      <p className="pn-chg__note" data-testid="session-changes-provenance">
        {cause} Listed here: the files its agent wrote, read from the agent’s transcript (its Edit and Write
        tool calls), not from git — files changed by shell commands are not listed.
      </p>

      {refreshError !== null ? (
        <p className="pn-chg__error" role="alert" data-testid="session-changes-refresh-error">
          Could not refresh — showing the last read. {refreshError}
        </p>
      ) : null}

      <div className="pn-chg__split">
        {showList ? (
          <div className="pn-chg__list-pane">
            {files.length === 0 ? (
              <p className="pn-chg__note" data-testid="session-changes-empty">
                This session’s agent has not written any files in a repository yet.
              </p>
            ) : (
              <>
                <div className="pn-chg__list-head">
                  {root !== '' ? (
                    <span className="pn-chg__root" data-testid="session-changes-root" title={root}>
                      in <code>{root}</code>
                    </span>
                  ) : null}
                  <ChangesViewToggle view={view} onChange={setView} />
                </div>
                <ul className="pn-chg__files" data-testid="session-changes-files" data-view={view}>
                  {view === 'list'
                    ? files.map((f) => fileRow(f, relativeTo(root, f.path), 0))
                    : visibleChangeRows(tree, collapsed).map(({ node, depth }) =>
                        node.kind === 'dir' ? (
                          <ChangeDirRow
                            key={`dir:${node.path}`}
                            dir={node}
                            depth={depth}
                            open={!collapsed.has(node.path)}
                            onToggle={() => toggle(node.path)}
                            // A shut folder still says the latest turn is in
                            // it; an open one leaves that to its rows.
                            extra={
                              showsTurn &&
                              collapsed.has(node.path) &&
                              filesUnder(node).some((f) => f.lastTurn) ? (
                                <LatestTurnMark live={live} />
                              ) : null
                            }
                          />
                        ) : (
                          fileRow(node.item, node.name, depth)
                        ),
                      )}
                </ul>
              </>
            )}
            {filesTruncated ? (
              <p className="pn-chg__note" data-testid="session-changes-truncated">
                The transcript accounting is capped — more files were edited than are shown.
              </p>
            ) : null}
            {kept.hidden > 0 ? (
              <p className="pn-chg__note" data-testid="session-changes-hidden">
                {kept.hidden} edited file{kept.hidden === 1 ? '' : 's'} outside any repository (temp or
                agent-private) {kept.hidden === 1 ? 'is' : 'are'} not listed.
              </p>
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
                onClick={() => setOpenPath(null)}
              >
                <span aria-hidden>←</span> All changed files
              </button>
            ) : null}
            {open === null ? (
              <p className="pn-chg__note">Choose a file to see what the agent wrote in it.</p>
            ) : (
              <>
                <div className="pn-chg__diff-head" data-testid="session-changes-diff-head">
                  <span className="pn-chg__path" title={open.path}>
                    {relativeTo(root, open.path)}
                  </span>
                  <span className="pn-chg__scope">
                    {open.edits} edit{open.edits === 1 ? '' : 's'} — as written, from the transcript
                  </span>
                  <span className="pn-chg__counts">
                    <span className="pn-chg__added">+{open.linesAdded}</span>
                    <span className="pn-chg__removed">−{open.linesRemoved}</span>
                  </span>
                </div>
                {openDiff !== null ? <DiffView diff={openDiff} /> : null}
                {openElided > 0 || open.hunksTruncated ? (
                  <p className="pn-chg__note" data-testid="session-changes-diff-elided">
                    {openElided > 0
                      ? `${String(openElided)} edit(s) too large to carry their text — the ± counts above are exact. `
                      : ''}
                    {open.hunksTruncated ? 'Further edits beyond the cap were counted but not carried.' : ''}
                  </p>
                ) : openDiff === null ? (
                  <p className="pn-chg__note" data-testid="session-changes-diff-elided">
                    No edit text was carried for this file — the ± counts above are exact.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      {remedy}
    </div>
  );
}
