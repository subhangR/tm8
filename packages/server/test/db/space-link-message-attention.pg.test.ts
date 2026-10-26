/**
 * messages.post and attentionRequests.create through `spaceLinks.invoke`.
 *
 * An agent G in A (on H's persona, in a work session in A) posts a message on
 * an entity in B and raises attention there, through H's link A → B. Both run
 * as H's link session in B, attributed to H's member in B, and the link audit
 * in A records them with their remote ids. The handlers, the executor, the
 * link store and every SQL hop are the production ones.
 *
 * Both carry what the CLI stamps from an agent session: its home actor
 * (`actorId`) and, on `message send`, its home work session
 * (`workSessionId`). B refused the first in `resolve_actor` and the second in
 * `w2_post_message_batch` ("authored_from provenance does not match the
 * resolved author session"), so neither op ever succeeded through a link.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { claimsFor, commandEnvelope } from '../../src/facade/context.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import type { RequestContext } from '../../src/http/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createSpaceLinkInvokeHandlers } from '../../src/facade/handlers/w2/space-link-invoke.js';
import { registerW2MessagesHandoffsHandlers } from '../../src/facade/handlers/w2/messages-handoffs.js';
import { registerAttentionHandlers } from '../../src/facade/services/attention/index.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, type SpaceLink } from '../../src/credentials/space-link-store.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'slma-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

let database: W1ScratchDatabase;
let db: Db;
let store: DbSpaceLinkStore;

const f = {
  spaceA: randomUUID(), spaceB: randomUUID(),
  identityH: `slma-h-${randomUUID()}`, accountH: randomUUID(),
  memberHA: randomUUID(), memberHB: randomUUID(),
  personaA: randomUUID(), docB: randomUUID(),
};

let link: SpaceLink;
let human: DbClaims;
let sourceSession: string;
let gIdentity: RequestContext['identity'];

const resolver = () => createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });

async function seed(): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [f.identityH]);
    await client.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'slma-h')`, [f.accountH, f.identityH]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'SLMA A', $3), ($2, 'SLMA B', $3)`,
      [f.spaceA, f.spaceB, f.identityH]);
    for (const [id, space] of [[f.memberHA, f.spaceA], [f.memberHB, f.spaceB]] as const) {
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [id, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', 'H')`,
        [id, space, f.identityH]);
    }
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'team_member', $3, 'space')`,
      [f.personaA, f.spaceA, f.memberHA]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'SLMA PA', 'worker', 'persona')`,
      [f.personaA, f.memberHA]);
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'doc', $3, 'space')`,
      [f.docB, f.spaceB, f.memberHB]);
    // G's work session in A, H's persona participating.
    sourceSession = randomUUID();
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
      [sourceSession, f.spaceA, f.memberHA]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1, 'G', 'running', 'none', now())`,
      [sourceSession]);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2), ($1, $3, $2, 'relates_to', $2)`,
      [f.spaceA, f.personaA, sourceSession]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_link_message_attention');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await seed();
  store = new DbSpaceLinkStore({ db, dataDir: await mkdtemp(join(tmpdir(), 'tm8-slma-')) });

  const secret = generateSecret();
  const humanRow = await db.tx({ identityId: f.identityH, authKind: 'browser', requestId: `slma-${randomUUID()}` } as DbClaims, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      f.accountH, hashToken(secret), 'browser', new Date(Date.now() + 3_600_000).toISOString(), null, 'slma browser',
    ]));
  const humanIdentity = await resolver()({ authorization: `Bearer ${formatToken(humanRow.id, secret)}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true });
  human = claimsFor(NOT_THE_OWNER, { identity: humanIdentity, requestId: 'slma-h' } as unknown as RequestContext);
  const added = await store.add(human, { spaceId: f.spaceA, targetSpaceId: f.spaceB });
  link = await store.login(human, added.id);

  // G: H's agent in A, on its work session in A — the caller.
  const gSecret = generateSecret();
  const row = await db.rpc<{ id: string }>(human, 'issue_agent_auth_session', [
    sourceSession, f.personaA, hashToken(gSecret), new Date(Date.now() + 3_600_000).toISOString(), 'slma G',
  ]);
  gIdentity = await resolver()({ authorization: `Bearer ${formatToken(row.id, gSecret)}` },
    { remoteAddress: '203.0.113.9', disableAutoOwner: true });
  expect(gIdentity).toMatchObject({ authKind: 'agent', sessionSpaceId: f.spaceA, workSessionId: sourceSession });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

function invoker() {
  const registry = new HandlerRegistry();
  const deps = { db, config: {}, owner: async () => NOT_THE_OWNER } as unknown as FacadeDeps;
  // main.ts's resolver: the bearer's pinned work session, else the envelope's.
  registerW2MessagesHandoffsHandlers(registry, deps, {
    resolveAuthoredFromWorkSessionId: async (ctx) =>
      (ctx.identity.kind === 'bearer' ? ctx.identity.workSessionId ?? null : null) ?? commandEnvelope(ctx).workSessionId ?? null,
  });
  registerAttentionHandlers(registry, deps);
  const { invoke } = createSpaceLinkInvokeHandlers(registry, deps, store, async (ctx) => claimsFor(NOT_THE_OWNER, ctx));
  return (op: string, input: Record<string, unknown>, params?: Record<string, string>) => invoke({
    params: { spaceId: f.spaceA, link: link.id }, query: new URLSearchParams(), headers: {},
    body: { op, input, ...(params ? { params } : {}) },
    identity: gIdentity, requestId: `slma-${randomUUID()}`,
  } as unknown as RequestContext) as Promise<{ linkId: string; auditId: string; result: Record<string, unknown> }>;
}

const audits = async () => store.listAudit(human, link.id, { limit: 50 });

describe.sequential('spaceLinks.invoke — talk and raise attention in the linked space', () => {
  it('messages.post on an entity in B succeeds as H\'s member in B, audited ok in A', async () => {
    const out = await invoker()('messages.post', {
      anchorIds: [f.docB], body: 'hello from A', clientMutationId: `slma-m-${randomUUID()}`, actorId: f.personaA, workSessionId: sourceSession,
    });
    const messages = (out.result as { messages: Array<{ id: string }> }).messages;
    expect(messages).toHaveLength(1);
    const [row] = await database.query<{ space_id: string; created_by: string }>(
      `select space_id::text, created_by::text from public.entities where id = $1`, [messages[0]!.id]);
    expect(row).toEqual({ space_id: f.spaceB, created_by: f.memberHB });
    // The source session stays in A, on the audit; B records no authored_from to a session it cannot see.
    expect((await audits())[0]).toMatchObject({
      op: 'messages.post', result: 'ok', linkId: link.id, workSessionId: sourceSession, remoteId: messages[0]!.id,
    });
    expect(await database.query(`select 1 from public.edges where src_id = $1 and type = 'authored_from'`, [messages[0]!.id])).toEqual([]);
  });

  it('attentionRequests.create on an entity in B succeeds as H\'s member in B, audited ok in A', async () => {
    const out = await invoker()('attentionRequests.create', {
      reason: 'look at this from A', points: 10, clientMutationId: `slma-a-${randomUUID()}`, actorId: f.personaA,
    }, { entityId: f.docB });
    expect(out.result).toBeTruthy();
    const [row] = await database.query<{ id: string; space_id: string; requested_by: string; source_session_id: string | null }>(
      `select id::text, space_id::text, requested_by::text, source_session_id::text from public.attention_requests where entity_id = $1`, [f.docB]);
    expect(row).toMatchObject({ space_id: f.spaceB, requested_by: f.memberHB, source_session_id: null });
    expect((await audits())[0]).toMatchObject({
      op: 'attentionRequests.create', result: 'ok', linkId: link.id, workSessionId: sourceSession, remoteId: row!.id,
    });
  });
});
