/**
 * Members & roles — the space roster.
 *
 * The list is a CollectionView over member entities, so every row is the same
 * Z2 EntityCard the rest of the workspace uses (role, score, done count all
 * come from the kind registry's summary fields) and clicking one peeks the
 * member's Z3 panel. The role tally beside the heading comes from the
 * `SpaceSettings` read — the authoritative roster projection.
 */
import { CollectionView } from '../../collections';
import { Pill } from '../../kit';
import type { CollectionQuery, EntityId, SpaceId, SpaceSettings } from '../../types/contract';

export interface MembersSectionProps {
  spaceId: SpaceId;
  members: SpaceSettings['members'];
  /**
   * The node cannot serve the roster projection. The member LIST below still
   * works (it is a collection query over member entities); only the role tally
   * is unknown — so it is omitted rather than rendered as an empty tally, which
   * would read as "this space has no owner".
   */
  unavailable?: boolean;
  onOpenEntity: (id: EntityId) => void;
}

export function MembersSection({ spaceId, members, unavailable = false, onOpenEntity }: MembersSectionProps) {
  const query: CollectionQuery = { spaceId, kinds: ['member'], sort: 'createdAt_desc' };

  const byRole = new Map<string, number>();
  for (const m of members) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);

  return (
    <section className="cv2-set__section" aria-label="Members">
      <header className="cv2-set__sectionhead">
        <h2 className="cv2-set__h2">Members</h2>
        <div className="cv2-set__tally" data-testid="settings-role-tally">
          {unavailable
            ? <span className="cv2-set__note">roles not available on this node</span>
            : [...byRole.entries()].map(([role, count]) => (
              <Pill key={role} tone={role === 'owner' ? 'brand' : 'neutral'} dot={false}>
                {count} {role}
              </Pill>
            ))}
        </div>
      </header>
      <div data-testid="settings-members">
        <CollectionView query={query} layout="list" showControls={false} onOpenEntity={onOpenEntity} />
      </div>
    </section>
  );
}
