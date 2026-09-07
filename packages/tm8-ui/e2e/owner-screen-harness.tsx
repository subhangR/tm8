import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ActorSummary,
  Connections,
  EntityDetail,
  EntityId,
  EntitySummary,
} from '@tm8/contract';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../src/panels';
import {
  FIXTURE_SPACE_ID,
  collectionInbox,
  collectionEmpty,
  fixtureDetails,
  taskUuidTitle,
} from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * THE OWNER'S OWN SCREEN, as a harness.
 *
 * The previous capture drove the DEFAULT fixture task, whose metadata grid
 * reads `Channel # design / Area ui / ID task-queued` — three cells the owner
 * does not have. His task carries no parent, no axes, no priority, no dates
 * and no assignees, so `MetaGrid` draws exactly two cells: `ID <uuid>` and
 * `Completion Gate none`. Everything below strips the fixture down to that
 * shape; nothing under `src/` is touched.
 *
 *   /e2e/owner-screen-harness.html?w=560
 */
const REASONS: DetailReasons = {
  presenceHollow: 'Presence is not measured yet.',
  versionHistory: 'Version history is deferred.',
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const ROSTER: readonly ActorSummary[] = [
  { id: 'm-ada' as EntityId, kind: 'member', displayName: 'Ada', avatar: null, isAgent: false },
  { id: 'm-lin' as EntityId, kind: 'member', displayName: 'Lin', avatar: null, isAgent: false },
  { id: 't-opus' as EntityId, kind: 'team_member', displayName: 'Opus 5', avatar: null, isAgent: true },
];

const SETS: readonly EntitySummary[] = [collectionInbox, collectionEmpty];

const NO_CONNECTIONS: Connections = {
  outgoing: [],
  incoming: [],
  unresolvedHardDependencyCount: 0,
};

const OWNER_ID = '01a07c39-e9d5-7cbf-acea-e10b46633e2e';

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const width = Number(params.get('w') ?? '560');
  const id = params.get('id') ?? OWNER_ID;
  const status = params.get('status') ?? 'open';
  const gate = params.get('gate') ?? 'none';
  const title = params.get('title') ?? 'Untitled task';

  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((l) => [...l, line]);

  const detail: EntityDetail = useMemo(() => {
    const base = fixtureDetails[taskUuidTitle.id]!;
    return {
      ...base,
      id: id as EntityDetail['id'],
      title,
      excerpt: null,
      parentId: null,
      category: 'to_do',
      badges: {},
      /* THE WHOLE POINT: a task state with nothing on it but the pill's own
         scalar and the gate. Every other member the fixture carried
         (priority, dueDate, axes, assignees, acceptance) is a cell in the
         grid, and the owner's task has none of them. */
      state: { kind: 'task', status, completionGate: gate } as EntityDetail['state'],
      /* `pointsEstimate` is a grid cell too, and the acceptance criteria draw
         their own region — his task has neither. */
      content: { kind: 'task', description: '' } as EntityDetail['content'],
      hierarchy: { parent: null, children: { items: [], nextCursor: null, total: 0 }, path: [] },
      connections: NO_CONNECTIONS,
      deletedAt: null,
    };
  }, [id, title, status, gate]);

  const controls: ControlHost = {
    kind: 'task',
    ctx,
    capabilitiesOf: () => detail.capabilities,
    connectionsOf: () => NO_CONNECTIONS,
    membershipSets: SETS,
    onMembership: (entityId, setId, member) => say(`membership ${setId} ${member}`),
    onSetState: (_id, next, via) => say(`setState ${next} via ${via}`),
    onSetValue: (_id, source, next) => say(`setValue ${source}=${next}`),
    onAssign: (_id, actorId, edgeType, assigned) =>
      say(`${assigned ? 'assign' : 'unassign'} ${actorId} (${edgeType})`),
    onArchive: (ref) => say(`archive verb: ${ref}`),
    assignableActors: ROSTER,
  };

  return (
    <div
      className="cv2-root"
      data-testid="harness-ready"
      style={{ padding: 40, display: 'flex', gap: 24, alignItems: 'flex-start' }}
    >
      <div style={{ width, minWidth: width, maxWidth: width }} data-testid="harness-panel">
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={ctx}
          controls={controls}
          /* A command executor, so SaveControls self-gates to null while the
             edit is clean — the owner's header carries no Save refusal. */
          commands={{ patchTask: async () => detail } as never}
          /* Run is wired, Edit is not — which is what puts the brass outlined
             Run beside a greyed pencil Edit in the owner's header. */
          onAction={(ref) => say(`action ${ref}`)}
          wiredActions={['run']}
          onPromote={() => say('promote')}
          onClose={() => say('close')}
        />
      </div>
      <pre
        data-testid="harness-log"
        style={{ font: '12px ui-monospace, monospace', color: '#9fe', minWidth: 200 }}
      >
        {log.join('\n') || '(no writes yet)'}
      </pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
