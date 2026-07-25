/**
 * Entity Z4 route, composed for profiles.
 *
 * `EntityFullView`'s registry-selected `profile` layout already renders the
 * identity header, the kind content (a team_member's identity text, memory
 * count, model/tool and equipped kit) and the children grid. Two things the
 * brief asks for on a profile live *outside* that layout, so they compose
 * around it rather than forking it:
 *   · the wall — the Thread anchored on the person (`discussionSlot`);
 *   · the connections rail — `equips` / `assigned_to` / `completed_by` edges.
 *
 * NOTE for Atlas: this is exported as the OPTIONAL `profileViews` fragment
 * (`{ entity }`), not folded into `teamViews`, because the `entity` route is
 * kind-generic and shared. Wire it only if no other screen claims that route.
 */
import { EntityFullView } from '../../entity';
import { ConnectionsRail } from '../../subsystems/rail';
import { Thread } from '../../subsystems/thread';
import type { ShellViewProps } from '../../shell';

export function ProfileZ4View({ entityId, onOpenEntity, onNavigate }: ShellViewProps) {
  if (!entityId) {
    return (
      <div className="cv2-collection__empty" role="status">
        <div className="cv2-collection__emptyglyph" aria-hidden="true">◇</div>
        <p>No entity selected.</p>
      </div>
    );
  }

  return (
    <div className="cv2-profile" data-testid="profile-z4">
      <EntityFullView
        key={entityId}
        entityId={entityId}
        onCollapse={() => { onNavigate('team'); onOpenEntity(entityId); }}
      />
      <div className="cv2-profile__below">
        <section className="cv2-profile__rail" aria-label="Connections">
          <ConnectionsRail entityId={entityId} onOpenEntity={onOpenEntity} />
        </section>
        <section className="cv2-profile__wall" aria-label="Wall">
          <span className="cv2-eyebrow">Wall</span>
          <Thread anchorId={entityId} variant="comments" defaultExpanded="all" />
        </section>
      </div>
    </div>
  );
}
