/**
 * Space Settings — space profile · members/roles · invites · task axes.
 *
 * One `getSettings` read backs the whole screen (it projects space, roster,
 * invites and axes together); the members list is a CollectionView so the rows
 * are the same Z2 cards as everywhere else, and the axis section writes through
 * the facade's axis commands and re-reads.
 */
import { EntityPanelSkeleton } from '../../entity';
import { useAsyncValue, type ShellViewProps } from '../../shell';
import { InvitesSection } from './InvitesSection';
import { MembersSection } from './MembersSection';
import { ProjectRepoSection } from './ProjectRepoSection';
import { SpaceProfileSection } from './SpaceProfileSection';
import { TaskAxesSection } from './TaskAxesSection';

export function SettingsScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const { value: settings, reload } = useAsyncValue(
    () => facade.getSettings(spaceId),
    [facade, spaceId],
  );

  // `settings.space` absent is treated exactly like `settings` absent. This
  // screen once white-screened the whole app because an adapter returned a
  // different shape and every section dereferenced it unguarded; the shape is
  // fixed at the source now, but a read this screen cannot render should cost
  // the user this screen at worst, never the workspace.
  if (!settings?.space) {
    return (
      <div className="cv2-set cv2-set--loading" data-testid="view-settings">
        <EntityPanelSkeleton />
      </div>
    );
  }

  const gaps = settings.unavailable ?? {};

  return (
    <div className="cv2-set" data-testid="view-settings">
      <SpaceProfileSection space={settings.space} />
      <ProjectRepoSection
        facade={facade}
        spaceId={spaceId}
        connectedRepo={settings.space.githubRepo}
        onChanged={reload}
      />
      <MembersSection
        spaceId={spaceId}
        members={settings.members ?? []}
        unavailable={gaps.members}
        onOpenEntity={onOpenEntity}
      />
      <InvitesSection invites={settings.invites ?? []} unavailable={gaps.invites} />
      <TaskAxesSection
        facade={facade}
        spaceId={spaceId}
        axes={settings.taskAxes ?? []}
        unavailable={gaps.taskAxes}
        onChanged={reload}
      />
    </div>
  );
}
