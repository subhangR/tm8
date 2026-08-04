import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActorSummary, EntityDetail, EntityId } from '@tm8/contract';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../src/panels';
import { FIXTURE_SPACE_ID, fixtureDetails, taskUuidTitle } from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';

/**
 * A REAL-BROWSER harness for the task panel's control strip.
 *
 * jsdom has no layout, so the unit suites can prove the controls DISPATCH but
 * not that they are visible, sized, or reachable — and the defect this fixes
 * was precisely a control that existed and could not be used. The same gap is
 * why D67's chip metrics were measured in Chrome rather than asserted in
 * jsdom.
 *
 * FIXTURES, NOT A NODE. Nothing here writes: the point is to see the strip
 * render and to click it, and a real server would mean creating real rows in
 * somebody's space to look at a `<select>`.
 *
 *   /e2e/task-controls-harness.html?status=done
 *   /e2e/task-controls-harness.html?archived=1
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

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status') ?? 'working';
  const archived = params.get('archived') === '1';

  const base = fixtureDetails[taskUuidTitle.id]!;
  const [log, setLog] = useState<string[]>([]);
  const say = (line: string) => setLog((l) => [...l, line]);

  const detail: EntityDetail = {
    ...base,
    state: { ...base.state, workStatus: status } as EntityDetail['state'],
    deletedAt: archived ? '2026-08-04T00:00:00.000Z' : null,
  };

  const controls: ControlHost = {
    kind: 'task',
    ctx,
    capabilitiesOf: () => detail.capabilities,
    onSetState: (id, next, via) => say(`setState ${next} via ${via}`),
    onSetValue: (id, source, next) => say(`setValue ${source}=${next}`),
    onAssign: (id, actorId, edgeType, assigned) =>
      say(`${assigned ? 'assign' : 'unassign'} ${actorId} (${edgeType})`),
    onArchive: (ref) => say(`archive verb: ${ref}`),
    assignableActors: ROSTER,
  };

  return (
    <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start' }}>
      <div style={{ width: 560 }} data-testid="harness-panel">
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={ctx}
          controls={controls}
          onRestore={() => say('restore')}
        />
      </div>
      <pre
        data-testid="harness-log"
        style={{ font: '12px ui-monospace, monospace', color: '#9fe', minWidth: 260 }}
      >
        {log.join('\n') || '(no writes yet)'}
      </pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
