/**
 * Member card — a human plus the agents they own.
 *
 * The human's identity and stats (role, ★ score, ✓ tasks done) come from the
 * Z2 `EntityCard`'s registry summary fields; the card adds only the frame, the
 * SPAWN affordance and the org-tree section around it.
 */
import { EntityCard } from '../../entity';
import { DropSurface, targetRef } from '../../interactions';
import { openPaletteWith } from '../../subsystems/palette';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { EntityId, EntitySummary } from '../../types/contract';
import { AgentOrgTree } from './AgentOrgTree';
import type { OrgRow } from './model';

export interface MemberCardProps {
  member: EntitySummary;
  rows: OrgRow[];
  facade: CollabFacade;
  /** Open a profile (member or agent) as the Z4 route. */
  onOpenProfile: (id: EntityId) => void;
}

export function MemberCard({ member, rows, facade, onOpenProfile }: MemberCardProps) {
  return (
    <article className="cv2-team__card" data-testid="team-member-card" data-member={member.id}>
      <div
        role="button"
        tabIndex={0}
        className="cv2-team__cardhead"
        title={`Open ${member.title}'s profile`}
        onClick={() => onOpenProfile(member.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpenProfile(member.id); }}
      >
        <DropSurface target={targetRef(member, 'actor')}>
          <EntityCard entity={member} />
        </DropSurface>
      </div>

      <div className="cv2-team__agents">
        <div className="cv2-team__agenthead">
          <span className="cv2-eyebrow">Agent team · {rows.length}</span>
          <span className="cv2-team__agentspace" />
          <button
            type="button"
            className="cv2-actionbtn"
            title={`Spawn a new agent for ${member.title}`}
            onClick={() => openPaletteWith(member.id)}
          >
            + Spawn
          </button>
        </div>
        <AgentOrgTree rows={rows} facade={facade} onOpen={onOpenProfile} />
      </div>
    </article>
  );
}
