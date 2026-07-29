/**
 * DEV-ONLY review surface — every frame this module builds, light and dark,
 * side by side. NEVER product.
 *
 * Precedent: `src/auth/AuthBoard.tsx` and `src/gallery/GalleryPage.tsx`. The
 * `[data-theme]` attribute here is a dev tool on a dev page; D1 keeps a theme
 * toggle out of product shell chrome, and this is not shell chrome.
 *
 * It drives the SAME components product does, with the oracle's own strings
 * supplied as specimens. That is the point: a board rendering simplified
 * stand-ins would prove nothing about what ships.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { resolveMenu } from '../shell/menu-resolve';
import { InvitesPanel, RedeemLanding } from './InviteFrames';
import { MembersSection } from './MembersSection';
import { MenuEditor } from './MenuEditor';
import { SPECIMEN_INVITES, SPECIMEN_REDEEM, specimenMembers } from './specimen';
import type { IdentityView } from '../data/seam';

const SPECIMEN_IDENTITY: IdentityView = {
  identityId: 'id-ada',
  accountId: 'acc-ada',
  username: 'ada',
  displayName: 'Ada Osei',
  avatar: null,
  email: null,
  isNodeAdmin: false,
  isOwner: true,
  status: 'active',
  actingAs: null,
  memberships: [{ spaceId: 'specimen-space', memberId: 'm-ada', role: 'owner' }],
};

function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="set-board__pane">
      <span className="set-board__label">{label}</span>
      <div className="set-board__frame">{children}</div>
    </div>
  );
}

function Both({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div className="cv2-root" data-theme="light">
        <Pane label={`${label} · light`}>{children}</Pane>
      </div>
      <div className="cv2-root" data-theme="dark">
        <Pane label={`${label} · dark`}>{children}</Pane>
      </div>
    </div>
  );
}

export function SettingsBoard({ now = 0 }: { now?: number }) {
  // `now` is injected so the board is deterministic under a screenshot; the
  // default of 0 makes every age read as a large, obviously-synthetic number
  // rather than pretending to be live.
  const clock = now || Date.parse('2026-07-29T04:00:00.000Z');
  const members = useMemo(() => specimenMembers(clock), [clock]);
  const menu = useMemo(() => resolveMenu(null), []);
  const [name, setName] = useState('');

  return (
    <div className="set-board">
      <Both label="T2-1b · Members & roles">
        <div className="set-panel">
          <MembersSection members={members} identity={SPECIMEN_IDENTITY} onInvite={() => {}} />
        </div>
      </Both>

      <Both label="T2-1c · Invites (product — no capability)">
        <div className="set-panel" style={{ width: 262 }}>
          <InvitesPanel />
        </div>
      </Both>

      <Both label="T2-1c · Invites (oracle rows, specimen only)">
        <div className="set-panel" style={{ width: 262 }}>
          <InvitesPanel specimen={SPECIMEN_INVITES} />
        </div>
      </Both>

      <Both label="T2-1d · Redeem — valid">
        <div style={{ width: 298 }}>
          <RedeemLanding {...SPECIMEN_REDEEM} name={name} onNameChange={setName} />
        </div>
      </Both>

      <Both label="T2-1d · Redeem — expired / revoked / used-up">
        <div style={{ display: 'flex', gap: 12 }}>
          <RedeemLanding {...SPECIMEN_REDEEM} state="expired" />
          <RedeemLanding {...SPECIMEN_REDEEM} state="revoked" />
          <RedeemLanding {...SPECIMEN_REDEEM} state="used-up" />
        </div>
      </Both>

      <Both label="T2-3 · Menu editor + preview">
        <MenuEditor menu={menu} spaceName="atelier" />
      </Both>

      <Both label="T2-3 · Menu editor — conflict + version lock">
        <MenuEditor
          menu={menu}
          spaceName="atelier"
          conflictRevision={menu.config.revision + 1}
          conflictBy="@noa"
          versionLocked
        />
      </Both>
    </div>
  );
}
