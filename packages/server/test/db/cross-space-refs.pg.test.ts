/**
 * L3 — cross-space references (migration 279; owner decisions D3, D7). The SQL
 * half: a reference is made only through the caller's OWN signed-in link (D7),
 * it is never an edge (D3), and it resolves live only for a viewer who can
 * read the target; everyone else gets the snapshot.
 *
 * Fixture, in space-links.pg.test.ts's style: spaces A (home) and B (target).
 * H owns A and B and links A → B. H3 is a member of A and B with no link row.
 * H4 is a member of A only. Doc DA lives in A, doc DB in B.
 *
 * Every refusal is paired with a positive.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CrossSpaceRef } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, type SpaceLink } from '../../src/credentials/space-link-store.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string;
  identityH: string; identityH3: string; identityH4: string;
  accountH: string; accountH3: string; accountH4: string;
  memberHA: string; memberHB: string; memberH3A: string; memberH3B: string; memberH4A: string;
  docA: string; docB: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;
let store: DbSpaceLinkStore;

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'l3-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.tx({ identityId, authKind: 'browser', requestId: `l3-${randomUUID()}` } as DbClaims, fn);
}

async function humanClaims(who: 'H' | 'H3' | 'H4'): Promise<DbClaims> {
  const [accountId, identityId] = who === 'H'
    ? [fixture.accountH, fixture.identityH]
    : who === 'H3' ? [fixture.accountH3, fixture.identityH3] : [fixture.accountH4, fixture.identityH4];
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser', new Date(Date.now() + 3_600_000).toISOString(), null, 'l3 browser',
    ]));
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
  const identity = await resolve(
    { authorization: `Bearer ${formatToken(row.id, secret)}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true },
  );
  return claimsFor(NOT_THE_OWNER, { identity, requestId: `l3-${randomUUID()}` } as unknown as RequestContext);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { details?: { sqlstate?: string; reason?: string }; code?: string };
    return [e.details?.sqlstate ?? e.code, e.details?.reason].filter(Boolean).join(':');
  }
}

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(),
    identityH: `l3-h-${randomUUID()}`, identityH3: `l3-h3-${randomUUID()}`, identityH4: `l3-h4-${randomUUID()}`,
    accountH: randomUUID(), accountH3: randomUUID(), accountH4: randomUUID(),
    memberHA: randomUUID(), memberHB: randomUUID(), memberH3A: randomUUID(), memberH3B: randomUUID(),
    memberH4A: randomUUID(),
    docA: randomUUID(), docB: randomUUID(),
  };
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H3'), ($3, 'H4')`,
      [f.identityH, f.identityH3, f.identityH4]);
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'l3-h'), ($3, $4, 'l3-h3'), ($5, $6, 'l3-h4')`,
      [f.accountH, f.identityH, f.accountH3, f.identityH3, f.accountH4, f.identityH4]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'L3 A', $3), ($2, 'L3 B', $3)`,
      [f.spaceA, f.spaceB, f.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [f.memberHA, f.spaceA, f.identityH, 'owner', 'H'],
      [f.memberHB, f.spaceB, f.identityH, 'owner', 'H'],
      [f.memberH3A, f.spaceA, f.identityH3, 'member', 'H3'],
      [f.memberH3B, f.spaceB, f.identityH3, 'member', 'H3'],
      [f.memberH4A, f.spaceA, f.identityH4, 'member', 'H4'],
    ];
    for (const [id, space, identity, role, name] of members) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [id, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [id, space, identity, role, name]);
    }
    for (const [id, space, by, title] of [
      [f.docA, f.spaceA, f.memberHA, 'Plan in A'],
      [f.docB, f.spaceB, f.memberHB, 'Spec in B'],
    ] as const) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'doc', $3, 'space')`,
        [id, space, by]);
      await client.query(`insert into public.documents(entity_id, title, body) values ($1, $2, '')`, [id, title]);
    }
  });
  return f;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('cross_space_refs');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
  store = new DbSpaceLinkStore({ db, dataDir: await mkdtemp(join(tmpdir(), 'tm8-l3-')) });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

const add = (claims: DbClaims, linkId: string, title = 'Spec in B (snapshot)') =>
  db.rpc<CrossSpaceRef>(claims, 'add_cross_space_ref', [fixture.docA, linkId, fixture.docB, 'doc', title]);
const list = (claims: DbClaims) => db.rpc<CrossSpaceRef[]>(claims, 'list_cross_space_refs', [fixture.docA]);

describe('L3 cross-space references', () => {
  let H: DbClaims;
  let H3claims: DbClaims;
  let link: SpaceLink;

  beforeAll(async () => {
    H = await humanClaims('H');
    const added = await store.add(H, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
    link = await store.login(H, added.id);
    H3claims = await humanClaims('H3');
  });

  it('D7: a member with no row on the link is refused; the linking member is not', async () => {
    expect(await outcome(() => add(H3claims, link.id))).toBe('42501:cross_space_ref_no_link');
    expect(await outcome(() => list(H))).toBe('ok');
    expect((await list(H))).toHaveLength(0);
  });

  it('adds a reference through the signed-in link, holding the snapshot; it is not an edge', async () => {
    const ref = await add(H, link.id);
    expect(ref).toMatchObject({
      entityId: fixture.docA, linkId: link.id, spaceId: fixture.spaceA,
      targetSpaceId: fixture.spaceB, targetEntityId: fixture.docB, targetServerId: null,
      kind: 'doc', titleSnapshot: 'Spec in B (snapshot)', createdBy: fixture.memberHA,
    });
    const [edges] = await database.query<{ n: number }>(
      `select count(*)::int as n from public.edges where src_id = $1 and dst_id = $2`, [fixture.docA, fixture.docB]);
    expect(edges?.n).toBe(0);
  });

  it('resolves live for a viewer who can read B, and only the snapshot for one who cannot', async () => {
    const [mine] = await list(H);
    expect(mine?.live).toMatchObject({ kind: 'doc', title: 'Spec in B' });
    const [theirs] = await list(await humanClaims('H4'));
    expect(theirs?.live).toBeNull();
    expect(theirs?.titleSnapshot).toBe('Spec in B (snapshot)');
  });

  it('adding the same target again refreshes the snapshot instead of duplicating', async () => {
    await add(H, link.id, 'Spec in B (refreshed)');
    const refs = await list(H);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.titleSnapshot).toBe('Spec in B (refreshed)');
  });

  it('a reader of A who is not in B lists the reference and may remove it; an unknown id is not found', async () => {
    const H4 = await humanClaims('H4');
    expect(await list(H4)).toHaveLength(1);
    const [ref] = await list(H);
    expect(await outcome(() => db.rpc(H4, 'remove_cross_space_ref', [fixture.docA, randomUUID()]))).toBe('P0002');
    expect(await outcome(() => db.rpc(H4, 'remove_cross_space_ref', [fixture.docA, ref!.id]))).toBe('ok');
    expect(await list(H)).toHaveLength(0);
  });

  it('D7: once the link is signed out, a new reference is refused', async () => {
    await store.logout(H, link.id, `l3-${randomUUID()}`);
    expect(await outcome(() => add(H, link.id))).toBe('42501:cross_space_ref_link_inactive');
    await store.login(H, link.id, { relogin: true, clientMutationId: `l3-${randomUUID()}` });
    expect(await outcome(() => add(H, link.id))).toBe('ok');
  });

  it('an entity the caller cannot read is not found', async () => {
    const H4 = await humanClaims('H4');
    expect(await outcome(() => db.rpc(H4, 'list_cross_space_refs', [fixture.docB]))).toBe('P0002');
  });
});
