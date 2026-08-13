import { useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { createDomainStore } from '../src/data/project/domain-store';
import type { ActionContext } from '../src/domain';
import { fixtureDetails, taskUuidTitle, FIXTURE_SPACE_ID } from '../src/fixtures';
import { EntityDetailPanel, EntityListPanel, type DetailReasons } from '../src/panels';
import { indexLinkedPullRequests } from '../src/pull-requests';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * Browser proof over the shipping panels and normalized domain store.
 *
 * The tracking edge deliberately keeps its original endpoint snapshot while
 * the simulated observer updates only the entity table. That is the real event
 * shape: an entity fact changes without rewriting every edge that points at
 * it. If the task chips accidentally read the edge snapshot, this harness
 * stays draft forever and the Playwright flip assertion fails.
 */

const PR_ID = '00000000-0000-4000-8000-000000000042' as EntityId;
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const task: EntitySummary = {
  ...taskUuidTitle,
  state: { ...taskUuidTitle.state, workStatus: 'working' } as EntitySummary['state'],
};
const detail = {
  ...fixtureDetails[taskUuidTitle.id]!,
  state: task.state,
};

const REASONS: DetailReasons = {
  presenceHollow: 'Presence is not measured in this harness.',
  versionHistory: 'Version history is not needed here.',
  provenanceHollow: 'Provenance is not needed here.',
  shareUnavailable: 'Sharing is not needed here.',
  withdrawUnavailable: 'Withdrawing is not needed here.',
};

type StoredFacts = {
  lifecycle: 'open' | 'draft' | 'merged' | 'closed';
  ciStatus: 'passing' | 'failing' | 'pending' | null;
  mergeState: 'clean' | 'conflicted' | 'unknown' | null;
};

function pullRequest(facts: StoredFacts, version: number): EntitySummary {
  return {
    ...task,
    id: PR_ID,
    kind: 'pull_request',
    title: 'PR chips closed loop',
    version,
    state: {
      kind: 'pull_request',
      repository: 'acme/tm8',
      number: 42,
      state: facts.lifecycle,
      url: 'https://github.com/acme/tm8/pull/42',
      fetchedAt: '2026-08-09T00:00:00.000Z',
      stale: false,
      ciStatus: facts.ciStatus,
      mergeState: facts.mergeState,
    } as EntitySummary['state'],
  };
}

const initialPullRequest = pullRequest(
  { lifecycle: 'draft', ciStatus: 'passing', mergeState: 'clean' },
  1,
);

const trackingEdge: EdgeView = {
  id: '00000000-0000-4000-8000-000000000043',
  type: 'tracks',
  source: task,
  target: initialPullRequest,
  props: {},
  createdBy: task.createdBy,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

function Harness() {
  const domain = useMemo(() => {
    const handle = createDomainStore();
    handle.store.getState().ingestSummaries([task, initialPullRequest]);
    handle.store.getState().ingestEdges([trackingEdge]);
    return handle;
  }, []);
  const entities = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().entities,
  );
  const edges = useSyncExternalStore(
    domain.store.subscribe,
    () => domain.store.getState().edges,
  );
  const linked = useMemo(
    () => indexLinkedPullRequests(Object.values(entities), Object.values(edges)),
    [entities, edges],
  );
  const linkedPullRequestsOf = (id: string) => linked.get(id) ?? [];
  const store = (facts: StoredFacts, version: number) => {
    domain.store.getState().ingestSummaries([pullRequest(facts, version)]);
  };

  return (
    <main className="cv2-root" style={{ minHeight: '100vh', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          data-testid="store-conflict"
          onClick={() => store({ lifecycle: 'open', ciStatus: 'failing', mergeState: 'conflicted' }, 2)}
        >
          Store conflict facts
        </button>
        <button
          type="button"
          data-testid="store-closed"
          onClick={() => store({ lifecycle: 'closed', ciStatus: null, mergeState: 'unknown' }, 3)}
        >
          Store closed facts
        </button>
        <button
          type="button"
          data-testid="store-merged"
          onClick={() => store({ lifecycle: 'merged', ciStatus: 'passing', mergeState: 'clean' }, 4)}
        >
          Store merged facts
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 520px 520px', gap: 14, alignItems: 'start' }}>
        <section data-testid="surface-list" style={{ minWidth: 0 }}>
          <EntityListPanel
            kind="task"
            mode="list"
            rowsFor={() => [task]}
            ctx={ctx}
            linkedPullRequestsOf={linkedPullRequestsOf}
          />
        </section>

        <section data-testid="surface-board" style={{ minWidth: 0 }}>
          <EntityListPanel
            kind="task"
            mode="board"
            rowsFor={() => [task]}
            boardFor={() => ({
              groups: [{ key: 'working', label: 'Working', items: [task], total: 1 }],
              nextCursor: null,
              limit: 1,
            })}
            ctx={ctx}
            linkedPullRequestsOf={linkedPullRequestsOf}
          />
        </section>

        <section data-testid="surface-detail" style={{ minWidth: 0 }}>
          <EntityDetailPanel
            detail={detail}
            reasons={REASONS}
            ctx={ctx}
            linkedPullRequests={linkedPullRequestsOf(task.id)}
          />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
