/**
 * Invites — link/code invitations from the `SpaceSettings` read.
 *
 * READ-ONLY BY CONTRACT: the facade seam exposes no invite command
 * (no create/revoke/rotate in `CollabFacade`), so this section renders exactly
 * what the read projects and offers copy-to-clipboard only. When the invite
 * commands land, the affordances drop in here — nothing is faked in the
 * meantime.
 */
import { Pill } from '../../kit';
import { relTime } from '../../registry';
import type { SpaceSettings } from '../../types/contract';

export interface InvitesSectionProps {
  invites: SpaceSettings['invites'];
}

export function InvitesSection({ invites }: InvitesSectionProps) {
  const copy = (code: string): void => {
    void navigator.clipboard?.writeText(code).catch(() => {});
  };

  return (
    <section className="cv2-set__section" aria-label="Invites">
      <header className="cv2-set__sectionhead">
        <h2 className="cv2-set__h2">Invites</h2>
        <p className="cv2-set__note">
          Read-only until the invite commands land on the facade seam.
        </p>
      </header>
      <div className="cv2-set__rows" data-testid="settings-invites">
        {invites.map((invite) => (
          <div key={invite.id} className="cv2-set__row" data-invite={invite.id}>
            <button
              type="button"
              className="cv2-set__rowname t-code cv2-set__copy"
              title="Copy invite code"
              onClick={() => copy(invite.code)}
            >
              {invite.code}
            </button>
            <span className="cv2-set__rowvalues t-mono">
              {invite.uses}/{invite.maxUses} used
            </span>
            <span className="cv2-set__rowvalues t-mono">
              {invite.expiresAt ? `expires ${relTime(invite.expiresAt)}` : 'no expiry'}
            </span>
            <span className="cv2-set__rowspace" />
            {invite.revoked
              ? <Pill tone="blocked" dot={false}>revoked</Pill>
              : <Pill tone="done" dot={false}>active</Pill>}
          </div>
        ))}
        {invites.length === 0 && <p className="cv2-empty-line">No invites yet.</p>}
      </div>
    </section>
  );
}
