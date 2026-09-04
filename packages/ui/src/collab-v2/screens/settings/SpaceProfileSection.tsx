/**
 * Space profile — name, description, linked repo, roster size.
 *
 * READ-ONLY BY CONTRACT: `CollabFacade` has no space-patch command, so the
 * fields render as facts, not inputs. (Entity titles/content are editable
 * through `patchEntity`; the space itself is not an entity.)
 */
import { Eyebrow, Pill, Timestamp } from '../../kit';
import type { SpaceSummary } from '../../types/contract';

export interface SpaceProfileSectionProps {
  space: SpaceSummary;
}

export function SpaceProfileSection({ space }: SpaceProfileSectionProps) {
  return (
    <section className="cv2-set__section" aria-label="Space profile" data-testid="settings-profile">
      <header className="cv2-set__sectionhead">
        <Eyebrow>space settings</Eyebrow>
        <h1 className="cv2-set__h1">{space.name}</h1>
        {space.description && <p className="cv2-set__blurb">{space.description}</p>}
      </header>
      <div className="cv2-set__facts">
        <Pill tone="neutral" dot={false}>{space.memberCount} members</Pill>
        {space.githubRepo && <span className="t-code">{space.githubRepo}</span>}
        <Timestamp className="t-mono cv2-set__rowvalues" at={space.createdAt} prefix="created" />
        {/* This one DRAWS the number, so null must not become 0: "0 unread" is
            a claim, and an unmeasured count has none to make. No pill. */}
        {space.unreadTotal !== null && space.unreadTotal > 0
          && <Pill tone="brand" dot={false}>{space.unreadTotal} unread</Pill>}
      </div>
    </section>
  );
}
