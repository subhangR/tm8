/**
 * Space Settings screen barrel (L5). `settingsViews` is the ViewRegistry
 * fragment Atlas merges into ShellLayout's `views` prop.
 */
import './settings.css';

import type { ViewRegistry } from '../../shell';
import { SettingsScreen } from './SettingsScreen';

export { SettingsScreen } from './SettingsScreen';
export { SpaceProfileSection, type SpaceProfileSectionProps } from './SpaceProfileSection';
export { MembersSection, type MembersSectionProps } from './MembersSection';
export { InvitesSection, type InvitesSectionProps } from './InvitesSection';
export { TaskAxesSection, type TaskAxesSectionProps } from './TaskAxesSection';

/** ViewRegistry fragment: the `settings` center view. */
export const settingsViews: ViewRegistry = { settings: SettingsScreen };
