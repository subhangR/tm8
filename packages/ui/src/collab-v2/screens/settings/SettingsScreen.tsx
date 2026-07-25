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
import { SpaceProfileSection } from './SpaceProfileSection';
import { TaskAxesSection } from './TaskAxesSection';

export function SettingsScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const { value: settings, reload } = useAsyncValue(
    () => facade.getSettings(spaceId),
    [facade, spaceId],
  );

  if (!settings) {
    return (
      <div className="cv2-set cv2-set--loading" data-testid="view-settings">
        <EntityPanelSkeleton />
      </div>
    );
  }

  return (
    <div className="cv2-set" data-testid="view-settings">
      <SpaceProfileSection space={settings.space} />
      <MembersSection spaceId={spaceId} members={settings.members} onOpenEntity={onOpenEntity} />
      <InvitesSection invites={settings.invites} />
      <TaskAxesSection
        facade={facade}
        spaceId={spaceId}
        axes={settings.taskAxes}
        onChanged={reload}
      />
    </div>
  );
}
