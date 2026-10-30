/**
 * Fixture roster for the People tab: the shapes `bridges.participants.list`
 * answers, used by the tab's tests and its browser check until B1b's inbound
 * fills real bridges. Ids are made up; numbers are not real.
 */
import type { ActorSummary, BridgeParticipant, BridgeParticipantListResult } from '@tm8/contract';
import type { BridgeParticipantPatch, BridgePeoplePort } from './port';

export const FIXTURE_BRIDGE_ID = '0bad0000-0000-4000-8000-0000000000b1';
export const FIXTURE_SPACE_ID = '0bad0000-0000-4000-8000-0000000000a1';

const member = (id: string, displayName: string): ActorSummary => ({ id, kind: 'member', displayName } as ActorSummary);
export const FIXTURE_MEMBERS: ActorSummary[] = [
  member('0bad0000-0000-4000-8000-000000000001', 'Subhang'),
  member('0bad0000-0000-4000-8000-000000000002', 'Priya Nair'),
  member('0bad0000-0000-4000-8000-000000000003', 'Rahul Verma'),
];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function row(over: Partial<BridgeParticipant> & Pick<BridgeParticipant, 'externalId' | 'displayName'>): BridgeParticipant {
  return {
    altExternalIds: [], masked: false, avatarRef: null, muted: false,
    firstSeenAt: ago(60 * 24 * 20), lastSeenAt: ago(5), messageCount: 12,
    trust: 'guest', memberId: null, member: null, link: null, you: false,
    ...over,
  };
}

/** The admin's view: ids in full. */
export function fixtureRoster(): BridgeParticipant[] {
  return [
    row({ externalId: '919876500001@s.whatsapp.net', displayName: 'Subhang', trust: 'linked', lastSeenAt: ago(2), messageCount: 214,
      memberId: FIXTURE_MEMBERS[0]!.id, member: FIXTURE_MEMBERS[0]!, link: { method: 'code', verifiedAt: ago(60 * 24 * 2) }, you: true,
      altExternalIds: ['207761234567890@lid'] }),
    row({ externalId: '919811109494@s.whatsapp.net', displayName: 'Rahul', lastSeenAt: ago(19), messageCount: 37 }),
    row({ externalId: '447700900123@s.whatsapp.net', displayName: 'Priya', trust: 'asserted', lastSeenAt: ago(60 * 3), messageCount: 58,
      memberId: FIXTURE_MEMBERS[1]!.id, member: FIXTURE_MEMBERS[1]!, link: { method: 'admin', verifiedAt: ago(60 * 24) } }),
    row({ externalId: '14155550142@s.whatsapp.net', displayName: 'Dana K', lastSeenAt: ago(60 * 26), messageCount: 4, muted: true }),
    row({ externalId: '918888812345@s.whatsapp.net', displayName: null, lastSeenAt: ago(60 * 24 * 6), messageCount: 1 }),
  ];
}

/** What a non-admin member receives for the same roster: masked, alternate ids withheld. */
export function maskedRoster(): BridgeParticipant[] {
  return fixtureRoster().map((p) => {
    const bare = p.externalId.replace(/@.*$/, '');
    return { ...p, externalId: bare.length <= 4 ? '…' : `…${bare.slice(-4)}`, altExternalIds: [], masked: true };
  });
}

/** An in-memory port that behaves like the server for the tab's purposes. */
export function fixturePort(opts: { admin?: boolean; items?: BridgeParticipant[]; delayMs?: number } = {}): BridgePeoplePort {
  const admin = opts.admin ?? true;
  let items = opts.items ?? (admin ? fixtureRoster() : maskedRoster());
  const wait = () => new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
  return {
    participants: async (bridgeId): Promise<BridgeParticipantListResult> => {
      await wait();
      return { bridgeId, spaceId: FIXTURE_SPACE_ID, admin, items };
    },
    members: async () => { await wait(); return FIXTURE_MEMBERS; },
    update: async (_bridgeId, externalId, patch: BridgeParticipantPatch) => {
      await wait();
      const current = items.find((p) => p.externalId === externalId);
      if (!current) throw Object.assign(new Error('participant not found on this bridge'), { code: 'not_found' });
      let next = { ...current };
      if (patch.muted !== undefined) next.muted = patch.muted;
      if (patch.memberId !== undefined) {
        if (current.trust === 'linked') {
          throw Object.assign(new Error('this participant has linked their own number; only they can unlink it'), { code: 'conflict' });
        }
        const m = patch.memberId ? FIXTURE_MEMBERS.find((x) => x.id === patch.memberId) ?? null : null;
        next = m
          ? { ...next, trust: 'asserted', memberId: m.id, member: m, link: { method: 'admin', verifiedAt: new Date().toISOString() } }
          : { ...next, trust: 'guest', memberId: null, member: null, link: null };
      }
      items = items.map((p) => (p.externalId === externalId ? next : p));
      return next;
    },
  };
}
