/**
 * Team screen barrel (L5). Atlas mounts `teamViews` on `ShellLayout.views`.
 * `profileViews` is an OPTIONAL extra fragment for the shared kind-generic
 * `entity` (Z4) route — wire it only if no other screen claims that route.
 */
import './team.css';
import type { ViewRegistry } from '../../shell';
import { ProfileZ4View } from './ProfileZ4View';
import { TeamScreen } from './TeamScreen';

export { TeamScreen } from './TeamScreen';
export { MemberCard, type MemberCardProps } from './MemberCard';
export { AgentOrgTree, type AgentOrgTreeProps } from './AgentOrgTree';
export { ProfileZ4View } from './ProfileZ4View';
export {
  groupByOwner, orgRows, ownerOf, isWorking, tally,
  type OrgRow, type TeamTally,
} from './model';
export { useMembers, useAgents, useRosterNonce } from './useTeam';

/** ViewRegistry fragment — `{ team }`. */
export const teamViews: ViewRegistry = { team: TeamScreen };

/** Optional fragment — `{ entity }` composed as a profile-capable Z4 route. */
export const profileViews: ViewRegistry = { entity: ProfileZ4View };
