/**
 * THE ORACLE'S OWN STRINGS — named so nobody mistakes them for data.
 *
 * Precedent and reason: `src/auth/specimen.ts`. These are transcriptions from
 * "T2 Settings, Trust & Authoring Hi-Fi.dc.html", used ONLY by the dev review
 * board so the built frames can be diffed against the canvas. Product code
 * never imports this file — the invites panel receives `null` and renders the
 * honest absence, because the seam cannot read an invite and rows like these
 * on a real screen would read as measured facts.
 *
 * I could not extend `src/fixtures/` (this directive's file ownership is
 * absolute — I create only under `src/settings-space/`), and the fixture
 * dataset carries exactly ONE member entity anyway. Stated rather than
 * implied: the members-table specimens below exist for the same reason.
 */
import type { EntityKind, EntitySummary } from '@tm8/contract';
import { defaultInviteRole, memberKindRef, memberRoles, ownerRoleRef } from './port';
import type { SpecimenInvite } from './types';

/** Oracle L108–L118. */
export const SPECIMEN_INVITES: readonly SpecimenInvite[] = [
  {
    code: 'i-7f3c',
    role: defaultInviteRole(),
    used: 0,
    uses: 5,
    createdWhen: '2d ago',
    createdBy: '@ada',
    expiry: 'expires in 5d',
  },
  {
    code: 'i-a201',
    role: 'viewer',
    used: 2,
    uses: 10,
    createdWhen: '1w ago',
    createdBy: '@noa',
    expiry: 'no expiry',
  },
  {
    code: 'i-30bb',
    role: defaultInviteRole(),
    used: 3,
    uses: 5,
    createdWhen: '—',
    createdBy: '@ada',
    expiry: '—',
    revoked: { when: '3d ago', by: '@ada', effect: 'joins via it now fail with “invite revoked”' },
  },
];

/** Oracle L128–L134 — the redeem landing's copy. */
export const SPECIMEN_REDEEM = {
  spaceName: 'atelier',
  invitedBy: '@ada',
  memberCount: 3,
  nodeName: 'dockyard',
  role: defaultInviteRole(),
  inviteCode: 'i-7f3c',
  expiry: 'expires in 5d',
};

/**
 * Oracle L52–L77. Shaped as `EntitySummary` so the board drives the SAME
 * component product does — a board that rendered a simplified shape would
 * prove nothing about the built table.
 */
function member(
  id: string,
  title: string,
  role: string,
  minutesAgo: number,
  now: number,
): EntitySummary {
  // The kind comes from the registry, not typed — §15.2 binds specimens too
  // (a specimen file is source, and this lane's guard walks it).
  const kind = memberKindRef() as EntityKind;
  return {
    id,
    spaceId: 'specimen-space',
    kind,
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: new Date(now - minutesAgo * 60000).toISOString(),
    createdAt: new Date(now - minutesAgo * 60000).toISOString(),
    updatedAt: new Date(now - minutesAgo * 60000).toISOString(),
    deletedAt: null,
    createdBy: { id: 'specimen-actor', kind, displayName: title, isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind, role, score: 0, taskDoneCount: 0 },
    badges: {},
  } as unknown as EntitySummary;
}

/**
 * `now` is a PARAMETER, not `Date.now()` at module scope: the ages the table
 * prints ("now / 2h / 4d") are relative, and a module-scope clock would make
 * the board's output depend on when the module was imported rather than on
 * when it was rendered.
 */
export function specimenMembers(now: number): EntitySummary[] {
  // The three role WORDS come from the registry's own tone table, in its
  // order — see `memberRoles()` for why they are not typed here.
  const [owner, admin, plain] = [ownerRoleRef() ?? memberRoles()[0], memberRoles()[1], defaultInviteRole()];
  return [
    member('m-ada', 'Ada Osei', owner, 0, now),
    member('m-noa', 'Noa Lindqvist', admin, 120, now),
    member('m-kai', 'Kai Tanaka', plain, 60 * 24 * 4, now),
  ];
}
