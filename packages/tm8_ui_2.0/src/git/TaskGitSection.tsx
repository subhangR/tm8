import { useCallback, useEffect, useState } from 'react';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { LinkedPullRequestChips, pullRequestFactsOf, type LinkedPullRequestFacts } from '../pull-requests';
import './task-git-section.css';

/**
 * THE TASK'S GIT SECTION — what this task tracks (PRs, commits), who produced
 * it (provenance: commit → `created_in` → session), and whether the 082
 * completion gate would let `complete` through RIGHT NOW.
 *
 * CHIP VOCABULARY IS CONSUMED, NOT FORKED: the PR rows render through Lane
 * B's `LinkedPullRequestChips` and `pullRequestFactsOf` — one mapper, one
 * chip language, everywhere (see GIT-UI.md). `ciStatus`/`mergeState` keep
 * their null=no-claim semantics all the way through.
 *
 * SELF-FETCHING over `seam.connections`, the same read the Connections tab
 * uses: `tracks` edges name the PRs and commits; each commit's `created_in`
 * edge names the session that produced it. Read once per mount plus a manual
 * refresh — the header chips already flip live off graph events; this section
 * is the DETAIL reading, not a second live feed.
 *
 * GATE HONESTY: when `completionGate === 'pr_merged'`, the verdict is stated
 * BEFORE anyone clicks Complete — which PR blocks it and why, or that no
 * tracked PR exists at all (also a refusal). The judgement mirrors 082: every
 * tracked PR must be merged and none CI-red. Absent facts are absent claims.
 */

const COMMIT_PROVENANCE_CAP = 20;

export interface TaskGitSectionProps {
  seam: Seam;
  taskId: EntityId;
  /** The task state's projected gate; absent means an older node — say nothing. */
  completionGate?: 'none' | 'pr_merged' | undefined;
  onOpenEntity?: ((id: string) => void) | undefined;
}

interface CommitRow {
  id: string;
  sha: string;
  repository: string;
  message: string;
  /** The session the `created_in` edge names, when one does. */
  session: { id: string; title: string } | null;
}

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; prs: LinkedPullRequestFacts[]; commits: CommitRow[]; sessions: Map<string, string> };

function commitStateOf(row: EntitySummary): { repository: string; sha: string; message: string } | null {
  const state = row.state as unknown as Record<string, unknown>;
  if (state.kind !== 'commit') return null;
  return {
    repository: typeof state.repository === 'string' ? state.repository : '',
    sha: typeof state.sha === 'string' ? state.sha : '',
    message: typeof state.message === 'string' ? state.message : row.title,
  };
}

function peerOf(edge: EdgeView, anchorId: string): EntitySummary {
  return edge.source.id === anchorId ? edge.target : edge.source;
}

export function TaskGitSection({ seam, taskId, completionGate, onOpenEntity }: TaskGitSectionProps) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    try {
      const page = await seam.connections(taskId, { types: ['tracks'], limit: 100 });
      const prs: LinkedPullRequestFacts[] = [];
      const commits: CommitRow[] = [];
      for (const edge of page.items) {
        const peer = peerOf(edge, taskId);
        const prFacts = pullRequestFactsOf(peer);
        if (prFacts !== null) {
          prs.push(prFacts);
          continue;
        }
        const commit = commitStateOf(peer);
        if (commit !== null) {
          commits.push({ id: peer.id, ...commit, session: null });
        }
      }
      // Provenance: each commit's `created_in` edge names its session. Capped
      // — this is a trail, not a ledger dump.
      const sessions = new Map<string, string>();
      await Promise.all(
        commits.slice(0, COMMIT_PROVENANCE_CAP).map(async (row) => {
          try {
            const links = await seam.connections(row.id as EntityId, { types: ['created_in'], limit: 5 });
            const edge = links.items[0];
            if (edge) {
              const session = peerOf(edge, row.id);
              row.session = { id: session.id, title: session.title };
              sessions.set(session.id, session.title);
            }
          } catch {
            // A commit whose provenance read fails still lists — with no
            // session claim, not a wrong one.
          }
        }),
      );
      setState({ phase: 'ready', prs, commits, sessions });
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Git links read failed' });
    }
  }, [seam, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === 'loading') {
    return <section className="pn-task-git" data-testid="task-git-section"><p className="pn-task-git__note">Reading git links…</p></section>;
  }
  if (state.phase === 'error') {
    return (
      <section className="pn-task-git" data-testid="task-git-section">
        <p className="pn-task-git__error" role="alert">Git links failed: {state.message}</p>
      </section>
    );
  }

  const { prs, commits, sessions } = state;
  const nothingTracked = prs.length === 0 && commits.length === 0;

  // The 082 judgement, mirrored: refuse while any tracked PR is unmerged or
  // CI-red — and refuse when nothing is tracked at all.
  const blockers =
    completionGate === 'pr_merged'
      ? prs.filter((pr) => pr.lifecycle !== 'merged' || pr.ciStatus === 'failing')
      : [];
  const gateBlocked = completionGate === 'pr_merged' && (prs.length === 0 || blockers.length > 0);

  return (
    <section className="pn-task-git" data-testid="task-git-section" aria-label="Git">
      <h3 className="pn-task-git__heading">Git</h3>

      {completionGate === 'pr_merged' ? (
        <p
          className={gateBlocked ? 'pn-task-git__gate pn-task-git__gate--blocked' : 'pn-task-git__gate'}
          data-testid="task-git-gate"
          role={gateBlocked ? 'alert' : undefined}
        >
          {gateBlocked
            ? prs.length === 0
              ? 'Completion gate pr_merged: complete will REFUSE — no tracked pull request exists yet.'
              : `Completion gate pr_merged: complete will REFUSE — ${blockers
                  .map((pr) => `PR #${pr.number} is ${pr.lifecycle}${pr.ciStatus === 'failing' ? ' with CI red' : ''}`)
                  .join('; ')}.`
            : 'Completion gate pr_merged: satisfied — every tracked pull request is merged and none is CI-red.'}
        </p>
      ) : null}

      {nothingTracked ? (
        <p className="pn-task-git__note" data-testid="task-git-empty">
          No linked pull requests or commits — link one with `tm8 task link-pr` / `link-commit`, or let the
          session observer record them.
        </p>
      ) : (
        <>
          {prs.length > 0 ? (
            <div className="pn-task-git__prs" data-testid="task-git-prs">
              <LinkedPullRequestChips pullRequests={prs} placement="detail" />
            </div>
          ) : null}

          {commits.length > 0 ? (
            <ul className="pn-task-git__commits" data-testid="task-git-commits">
              {commits.map((c) => {
                const session = c.session;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="pn-task-git__link"
                      onClick={onOpenEntity ? () => onOpenEntity(c.id) : undefined}
                      disabled={!onOpenEntity}
                    >
                      <code>{c.sha.slice(0, 10)}</code>
                    </button>
                    <span className="pn-task-git__commit-msg">{c.message}</span>
                    {session ? (
                      <button
                        type="button"
                        className="pn-task-git__link pn-task-git__session"
                        title={`produced by ${session.title}`}
                        onClick={onOpenEntity ? () => onOpenEntity(session.id) : undefined}
                        disabled={!onOpenEntity}
                      >
                        ← {session.title}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {sessions.size > 0 ? (
            <p className="pn-task-git__note" data-testid="task-git-sessions">
              Worked by:{' '}
              {[...sessions].map(([id, title], i) => (
                <span key={id}>
                  {i > 0 ? ', ' : ''}
                  <button
                    type="button"
                    className="pn-task-git__link"
                    onClick={onOpenEntity ? () => onOpenEntity(id) : undefined}
                    disabled={!onOpenEntity}
                  >
                    {title}
                  </button>
                </span>
              ))}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
