import type { ActorSummary } from '@tm8/contract';

/**
 * Fixture actors. Provenance matters everywhere in the UI (avatar shape,
 * chips, roster) so the set always carries both humans and agents.
 */

export const ada: ActorSummary = {
  id: 'act-ada',
  kind: 'member',
  displayName: 'Ada',
  avatar: null,
  role: 'owner',
  isAgent: false,
};

export const noor: ActorSummary = {
  id: 'act-noor',
  kind: 'member',
  displayName: 'Noor',
  avatar: null,
  role: 'member',
  isAgent: false,
};

export const forge: ActorSummary = {
  id: 'act-forge',
  kind: 'team_member',
  displayName: 'forge',
  avatar: null,
  role: null,
  ownerMemberId: 'act-ada',
  isAgent: true,
};

export const scout: ActorSummary = {
  id: 'act-scout',
  kind: 'team_member',
  displayName: 'scout',
  avatar: null,
  role: null,
  ownerMemberId: 'act-noor',
  isAgent: true,
};

export const fixtureActors: ActorSummary[] = [ada, noor, forge, scout];
