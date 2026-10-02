/**
 * D6 (owner decision, lane L6): membership and role writes in B are refused
 * through spaceLinks.invoke at HOME, before the stored session is unsealed —
 * even for a member who is admin in B. Membership READS still pass as the
 * member. A human acting in B directly is unaffected (the SQL guard is
 * `require_space_admin`, unchanged; see the D6 cells in
 * test/db/cross-space-token.pg.test.ts).
 *
 * No database: the store is a stub that records audits and counts `use`.
 */
import { describe, expect, it, vi } from 'vitest';
import { CollabError, OPERATIONS, spaceLinkRefusal, type OperationName } from '@tm8/contract';

import type { DbClaims } from '../src/db/types.js';
import type { FacadeDeps } from '../src/facade/deps.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { createSpaceLinkInvokeHandlers } from '../src/facade/handlers/w2/space-link-invoke.js';
import type { DbSpaceLinkStore, SpaceLinkAuditInput, SpaceLinkInvokeRow } from '../src/credentials/space-link-store.js';
import type { RequestContext } from '../src/http/types.js';

const HOME = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const INVITE = '55555555-5555-4555-8555-555555555555';

/** Every catalog membership/role write: what D6 refuses. */
const MEMBERSHIP_WRITES = [
  'spaces.invites.create',
  'spaces.invites.revoke',
  'spaces.invites.redeem',
  'spaces.members.updateRole',
  'spaces.members.remove',
  'spaces.members.spacePassword.reset',
  'spaces.members.spacePassword.lock',
  'spaces.leave',
] as const;

function harness() {
  const audits: SpaceLinkAuditInput[] = [];
  const row: SpaceLinkInvokeRow = {
    linkId: LINK, tokenRowId: 'row-1', memberId: 'member-h', homeSpaceId: HOME, targetSpaceId: TARGET,
    targetServerId: null, status: 'signed_in', allowSpawn: true, spawnBudget: 3,
  };
  const use = vi.fn(async () => { throw new Error('store.use must not be reached for a refused op'); });
  const store = {
    resolveInvoke: async () => row,
    recordAudit: async (_claims: DbClaims, entry: SpaceLinkAuditInput) => { audits.push(entry); return `audit-${audits.length}`; },
    use,
  } as unknown as DbSpaceLinkStore;
  const registry = new HandlerRegistry();
  const handler = vi.fn(async () => ({}));
  const ops: OperationName[] = [...MEMBERSHIP_WRITES, 'spaces.members.list', 'spaces.invites.list'];
  for (const op of ops) registry.register(op, handler);
  const { invoke } = createSpaceLinkInvokeHandlers(
    registry, { config: {} } as unknown as FacadeDeps, store, async () => ({ identityId: 'identity-g' }) as DbClaims,
  );
  const run = (body: unknown) => invoke({
    params: { spaceId: HOME, link: 'b' }, body, headers: {}, query: new URLSearchParams(),
    identity: { kind: 'bearer', workSessionId: 'ws-g' },
  } as unknown as RequestContext) as Promise<unknown>;
  return { run, audits, use, handler };
}

describe('D6 — membership and role writes are refused through a space link', () => {
  it('the list is every membership write in the catalog', () => {
    const writes = OPERATIONS
      .filter((op) => op.kind !== 'read'
        && (/^spaces\.(members|invites)\./.test(op.name) || op.name === 'spaces.leave'))
      .map((op) => op.name)
      .sort();
    expect(writes).toEqual([...MEMBERSHIP_WRITES].sort());
  });

  it.each(MEMBERSHIP_WRITES)('%s — spaceLinkRefusal says membership', (op) => {
    expect(spaceLinkRefusal(op, 'command', {}, true)).toBe('membership');
  });

  it.each([
    ['spaces.invites.create', { spaceId: TARGET }, { maxUses: 1, clientMutationId: 'cm-invite' }],
    ['spaces.members.updateRole', { spaceId: TARGET, memberId: MEMBER }, { role: 'admin', clientMutationId: 'cm-role' }],
    ['spaces.invites.revoke', { spaceId: TARGET, inviteId: INVITE }, { clientMutationId: 'cm-revoke' }],
    ['spaces.members.remove', { spaceId: TARGET, memberId: MEMBER }, { clientMutationId: 'cm-remove' }],
  ] as const)('%s — 403 space_link_refused/membership at home: never unsealed, never run, audited refused', async (op, params, input) => {
    const h = harness();
    const error = await h.run({ op, params, input }).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(CollabError);
    expect(error).toMatchObject({ code: 'forbidden', details: { reason: 'space_link_refused', refusal: 'membership' } });
    expect(h.use).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ op, result: 'refused', reason: 'membership' });
  });

  it.each(['spaces.members.list', 'spaces.invites.list'])('positive — %s (a read) is not refused by D6', (op) => {
    expect(spaceLinkRefusal(op, 'read', {}, true)).toBeNull();
  });

  it('positive — a read gets past the home guards to the session (store.use is reached)', async () => {
    const h = harness();
    await h.run({ op: 'spaces.members.list', params: { spaceId: TARGET } }).catch(() => undefined);
    expect(h.use).toHaveBeenCalledTimes(1);
    expect(h.audits.at(-1)).toMatchObject({ op: 'spaces.members.list', result: 'error' });
  });
});
