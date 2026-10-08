import type { MapType } from '../story/game/map-model';
const kinds = {
  hub: ['story'], taskland: ['task', 'work_session'],
  office: ['member', 'team_member', 'work_session', 'skill'], library: ['doc', 'drawing', 'artifact', 'file'],
  factory: ['project', 'pull_request', 'commit', 'worktree'],
  town: ['story', 'task', 'work_session', 'member', 'team_member', 'skill', 'doc', 'drawing', 'artifact', 'file', 'project', 'pull_request', 'commit', 'worktree'],
} satisfies Record<MapType, readonly string[]>;
/** Same primary-kind admission as the scoped loader; graph limits concern relations only. */
export function admitsMapKind(type: MapType, kind: string): boolean { return kinds[type].includes(kind); }
