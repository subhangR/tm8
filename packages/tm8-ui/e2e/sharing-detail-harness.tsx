import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityCapabilities, EntityDetail } from '@tm8/contract';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../src/panels';
import type { SessionSharingPatch } from '../src/panels/controls/EntityControls';
import { FIXTURE_SPACE_ID, fixtureDetails, presenceHollowReason } from '../src/fixtures';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';

/**
 * THE SESSION SHARING PICKER, FROM THE DETAIL PANEL — the same control the
 * row cluster draws (`e2e/sharing-harness.html`), mounted in the panel's bar.
 * The session is re-cast as TEAMMATE-launched with `sharingSetAt: null`, and
 * the handler applies a patch the way the RPC does: the named key only, then
 * `sharingSetAt` stamped. The log prints the exact patch each click sent.
 *
 *   /e2e/sharing-detail-harness.html
 */
const CAPS_SESSION: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: false, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

function seed(): EntityDetail {
  const session = Object.values(fixtureDetails).find((d) => d.kind === 'work_session');
  if (!session) throw new Error('the fixtures must carry a work_session');
  return {
    ...session,
    capabilities: CAPS_SESSION,
    createdBy: { ...session.createdBy, kind: 'team_member' } as EntityDetail['createdBy'],
    state: { ...session.state, shareMode: 'space', driveMode: 'owner', sharingSetAt: null } as EntityDetail['state'],
  };
}

function Harness() {
  const [detail, setDetail] = useState(seed);
  const [log, setLog] = useState<string[]>([]);
  const share = (id: string, patch: SessionSharingPatch) => {
    setLog((prev) => [`${id.slice(0, 10)} ← ${JSON.stringify(patch)}`, ...prev].slice(0, 6));
    setDetail((d) => ({
      ...d,
      state: { ...d.state, ...patch, sharingSetAt: new Date().toISOString() } as EntityDetail['state'],
    }));
  };
  const controls: ControlHost = {
    kind: 'work_session',
    ctx,
    capabilitiesOf: () => CAPS_SESSION,
    livenessOf: () => 'live',
    onShareSession: share,
  };
  return (
    <div className="cv2-root">
      <div className="harness-col">
        <div className="harness-panel">
          <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} controls={controls} liveness="live" />
        </div>
        <pre className="harness-log" data-testid="harness-log">{log.join('\n') || '— no writes yet —'}</pre>
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; padding: 14px; }
  .harness-panel { width: 760px; height: 520px; display: flex; overflow: hidden; border-radius: 8px; }
  .harness-panel > * { flex: 1; min-width: 0; }
  .harness-log { margin: 0; padding: 6px 8px; width: 760px; box-sizing: border-box;
    font: 10px/1.5 ui-monospace, monospace; color: #d8ffd8; background: #1c1c1c; border-radius: 6px;
    white-space: pre-wrap; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
