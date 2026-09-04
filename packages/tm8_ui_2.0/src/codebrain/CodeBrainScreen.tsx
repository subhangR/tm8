/**
 * CodeBrain — the delivery pipeline's own screen.
 *
 * WHAT IT IS FOR. A CodeBrain run is currently watched across three places:
 * the Teammates list (which phases exist), the task (what they decided) and
 * the sessions list (which are alive). Nobody can see the RUN. This screen is
 * that one place — the phase spine, in order, each phase carrying its state.
 *
 * WHY A VIEW AND NOT A RAIL KIND. A run spans `team_member`, `task` and
 * `work_session` at once. R4 keeps the rail entities-only, and §15.2 makes a
 * kind literal outside `domain/` a build failure — so this is a named view,
 * exactly like `graph` and `craft`, whose screens are likewise reads ACROSS
 * kinds rather than a list of one.
 *
 * The ordering and state rules live in `spine.ts` as pure functions, pinned by
 * `spine.test.ts`. This file is the render and the fetch, nothing more.
 */
import { useEffect, useMemo, useState } from 'react';

import type { EntitySummary, SpaceId } from '@tm8/contract';

import type { Seam } from '../data/seam.js';

import { deriveSpine, phaseState, runProgress, type CodeBrainPhase } from './spine.js';

import './codebrain.css';

/**
 * The roster root is found BY NAME, not by a pinned id: the same pipeline is
 * rebuilt per space (identity is space-scoped), so an id baked in here would
 * resolve in exactly one space and render an empty screen in every other.
 */
const ROOT_NAME = /^codebrain\b/i;

export interface CodeBrainScreenProps {
  readonly seam: Seam;
  readonly spaceId: SpaceId;
  readonly onOpenEntity?: (id: string) => void;
}

interface Loaded {
  readonly root: EntitySummary | null;
  readonly spine: readonly CodeBrainPhase[];
}

export function CodeBrainScreen({ seam, spaceId, onOpenEntity }: CodeBrainScreenProps) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: Loaded }>({
    loading: true,
    error: null,
    data: { root: null, spine: [] },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const members = await seam.query({ spaceId, kinds: ['team_member'] });
        const rows = members.page.items;
        const root = rows.find((r) => ROOT_NAME.test(r.title ?? '')) ?? null;
        if (!root) {
          if (!cancelled) {
            setState({ loading: false, error: null, data: { root: null, spine: [] } });
          }
          return;
        }
        const children = rows.filter((r) => r.parentId === root.id);

        /*
         * LIVE SESSIONS, joined through `state.teammate.id`.
         *
         * That field is the ONLY link from a session back to its phase: a
         * session is not a child of the member (its `parentId` is null) and
         * carries no edge to it, so the obvious hierarchy join returns nothing
         * and would have left every phase permanently idle — a state that could
         * never be wrong because it could never be computed. Verified against
         * live rows before this was written.
         *
         * The status filter is what makes the count mean "live": an exited
         * session still names its teammate, so counting all of them would mark
         * every phase that has EVER run as running, forever.
         */
        const sessions = await seam.query({
          spaceId,
          kinds: ['work_session'],
          filters: { sessionStatus: ['spawning', 'running', 'idle'] },
        });
        const live = new Map<string, number>();
        for (const s of sessions.page.items) {
          if (s.state.kind !== 'work_session') continue;
          const owner = s.state.teammate?.id;
          if (owner) live.set(owner, (live.get(owner) ?? 0) + 1);
        }
        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            data: { root, spine: deriveSpine(children, live, new Set()) },
          });
        }
      } catch (e) {
        if (!cancelled) {
          setState({
            loading: false,
            error: e instanceof Error ? e.message : String(e),
            data: { root: null, spine: [] },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seam, spaceId]);

  const progress = useMemo(() => runProgress(state.data.spine), [state.data.spine]);

  if (state.loading) {
    return (
      <div className="codebrain" data-testid="codebrain-screen">
        <p className="codebrain__note">Loading the pipeline…</p>
      </div>
    );
  }

  if (state.error) {
    /* The error is SHOWN, not swallowed into an empty state: an empty spine and
       an unreachable graph look identical, and telling them apart is the whole
       difference between "no run yet" and "this screen is broken". */
    return (
      <div className="codebrain" data-testid="codebrain-screen">
        <h1 className="codebrain__title">CodeBrain</h1>
        <p className="codebrain__error" role="alert">
          Could not read the roster: {state.error}
        </p>
      </div>
    );
  }

  if (!state.data.root) {
    return (
      <div className="codebrain" data-testid="codebrain-screen">
        <h1 className="codebrain__title">CodeBrain</h1>
        <p className="codebrain__note">
          No CodeBrain roster in this space yet. The pipeline is a{' '}
          <strong>team_member</strong> named “CodeBrain” whose children are its phases — create
          one and they appear here in position order.
        </p>
      </div>
    );
  }

  return (
    <div className="codebrain" data-testid="codebrain-screen">
      <header className="codebrain__head">
        <h1 className="codebrain__title">CodeBrain</h1>
        <p className="codebrain__progress" data-testid="codebrain-progress">
          {progress.done} of {progress.total} phases reported
          {progress.running > 0 ? ` · ${progress.running} running` : ''}
        </p>
      </header>

      <ol className="codebrain__spine" data-testid="codebrain-spine">
        {state.data.spine.map((p, i) => {
          const s = phaseState(p);
          return (
            <li key={p.id} className="codebrain__phase" data-state={s} data-testid="codebrain-phase">
              <span className="codebrain__ordinal">{i + 1}</span>
              <button
                type="button"
                className="codebrain__name"
                onClick={onOpenEntity ? () => onOpenEntity(p.id) : undefined}
                disabled={!onOpenEntity}
              >
                {p.name}
              </button>
              <span className="codebrain__state" data-state={s}>
                {s === 'reported' ? 'reported' : s === 'running' ? `running · ${p.live}` : 'idle'}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
