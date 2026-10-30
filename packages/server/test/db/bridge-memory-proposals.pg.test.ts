/**
 * Bridges R (migration 403): `/remember` proposals against a real PostgreSQL
 * with every migration applied. D29's last bullet and D61-D63:
 *
 * - propose: the bridges worker only; a guest and a credential value are
 *   refused, the latter stored nowhere; one inbox item per recipient (the
 *   proposer and the group's linked members); a re-run adds none;
 * - accept / drop: human-only, in tm8, by a linked member of that group; a
 *   proposal from an admin-asserted link needs a verified link or an admin;
 *   accept makes the memory, `bridge remembers memory` and D22 provenance;
 * - never from WhatsApp: the bridges worker and agents cannot decide, and a
 *   "YES" or "/remember accept" from the group is only another proposal;
 * - expiry after 14 days, by the node admin's job, and refused before it ran.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID();
const teammate = randomUUID(), chatInfra = randomUUID(), chatOps = randomUUID(), connection = randomUUID();
const ownerAccount = randomUUID();
let infra = '', ops = '';

/** People: role, link method (null = none) and the WhatsApp ids they appear as, per group. */
const people = {
  owner: { role: 'owner', link: null, infra: null, ops: null },
  verified: { role: 'member', link: 'code', infra: '+911111', ops: null },
  asserted: { role: 'member', link: 'admin', infra: '+912222', ops: null },
  asserted2: { role: 'member', link: 'admin', infra: '+913333', ops: null },
  plain: { role: 'member', link: null, infra: null, ops: null },
  elsewhere: { role: 'member', link: 'code', infra: null, ops: '+914444' },
} as const;
type Person = keyof typeof people;
const member = Object.fromEntries(Object.keys(people).map(p => [p, randomUUID()])) as Record<Person, string>;
const identity = Object.fromEntries(Object.keys(people).map(p => [p, `r-${p}-${randomUUID()}`])) as Record<Person, string>;
const GUEST = '+919999';

type Kind = 'browser' | 'cli' | 'agent';
const as = <T>(who: Person, fn: (q: Querier) => Promise<T>, authKind: Kind = 'browser', extra: Partial<DbClaims> = {}) =>
  db.tx({ identityId: identity[who], authKind, requestId: randomUUID(), ...extra }, fn);

/** The bridges worker's claim (398's is_bridges_worker()), bound by hand: this base's client predates it. */
function asWorker<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return scratch.transaction(async c => {
    await c.query('set local role tm8_app');
    await c.query(`select set_config('tm8.background_job', 'bridges.runtime', true), set_config('tm8.request_id', $1, true)`,
      [randomUUID()]);
    return fn(c);
  });
}

interface Proposal {
  id: string; status: string; statement: string; proposedBy: string; proposerTrust: string; proposerName: string;
  mentionsSecret: boolean; memoryId: string | null; canDecide: boolean; created?: boolean; expiresAt: string;
}

async function propose(bridge: string, sender: string, text: string, providerId = `wamid.${randomUUID()}`, messageId: string | null = null) {
  return asWorker(async c => {
    const { rows } = await c.query<{ p: Proposal }>('select public.propose_bridge_memory($1,$2,$3,$4,$5) as p',
      [bridge, sender, text, messageId, providerId]);
    return rows[0]!.p;
  });
}
const resolve = (who: Person, id: string, decision: 'accept' | 'drop', statement: string | null = null, authKind: Kind = 'browser') =>
  as(who, q => q.rpc<Proposal>('resolve_bridge_memory_proposal', [id, decision, statement, null]), authKind);

interface Refusal { code?: string; message?: string; detail?: string; details?: Record<string, unknown> }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error('expected a refusal');
}
/** details.reason through the db layer; the raw detail JSON through a bare pg client. */
const reasonOf = (e: Refusal) => e.details?.['reason'] ?? (e.detail ? JSON.parse(e.detail).reason : undefined);

const attentionOf = (proposalId: string) => scratch.query<{ assignee_id: string; status: string; action_type: string; origin: string; reason: string }>(
  `select assignee_id::text, status, action_type, origin, reason from public.attention_requests
    where signal_key like $1 order by assignee_id`, [`bridge_memory_proposal:${proposalId}:%`]);

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('bridges_r_remember');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const p of Object.keys(people) as Person[]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,$2)`, [identity[p], p]);
    }
    await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'r-owner',true)`, [ownerAccount, identity.owner]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Lane R',$2)`, [spaceId, identity.owner]);
    for (const p of Object.keys(people) as Person[]) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [member[p], spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,$4,$5)`,
        [member[p], spaceId, identity[p], people[p].role, p]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, member.owner]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
      values ($1,$2,'Infra teammate','worker','persona')`, [teammate, member.owner]);
    for (const [id, title] of [[chatInfra, 'Infra main'], [chatOps, 'Ops main']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, member.owner]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/r', gen_random_uuid(), $5, $6, $7)`,
        [id, spaceId, title, teammate, identity.owner, member.owner, `r-${randomUUID()}`]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, ownerAccount]);
  });
  const create = (externalId: string, title: string, target: string) => db.tx(
    { identityId: identity.owner, authKind: 'browser', requestId: randomUUID() },
    q => q.rpc<{ entity: { id: string } }>('create_bridge', [
      spaceId, connection, externalId, JSON.stringify({ kind: 'group', title, memberCount: 7 }), target, '{}', teammate,
      null, null, true, null, null, randomUUID()]));
  infra = (await create('120363-infra@g.us', 'Infra', chatInfra)).entity.id;
  ops = (await create('120363-ops@g.us', 'Ops', chatOps)).entity.id;
  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    const seen = async (bridge: string, external: string, name: string) => c.query(
      `insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at)
       values ($1,$2,$3,now(),now())`, [bridge, external, name]);
    for (const p of Object.keys(people) as Person[]) {
      const { link, infra: inInfra, ops: inOps } = people[p];
      if (inInfra) await seen(infra, inInfra, p);
      if (inOps) await seen(ops, inOps, p);
      const external = inInfra ?? inOps;
      if (link && external) {
        await c.query(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, space_id, asserted_by_member_id, verified_at)
          values ('whatsapp',$1,$2,$3,$4,$5,now())`,
          [external, identity[p], link, link === 'admin' ? spaceId : null, link === 'admin' ? member.owner : null]);
      }
    }
    await seen(infra, GUEST, 'Stranger');
  });
});
afterAll(async () => { await db?.end(); await scratch?.destroy(); });

describe('propose (/remember, the bridges worker)', () => {
  it('records a proposal, never a memory, and sends one inbox item to the proposer and each linked member of the group', async () => {
    const memoriesBefore = await scratch.query<{ n: number }>(`select count(*)::int n from public.memories`);
    const p = await propose(infra, people.verified.infra, 'Deploy windows are Tue/Thu 14:00-16:00 IST');
    expect(p).toMatchObject({ status: 'pending', proposedBy: member.verified, proposerTrust: 'linked', created: true, memoryId: null });
    expect(new Date(p.expiresAt).getTime() - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
    expect((await scratch.query<{ n: number }>(`select count(*)::int n from public.memories`))[0]!.n).toBe(memoriesBefore[0]!.n);
    const items = await attentionOf(p.id);
    // verified, asserted, asserted2: the group's linked members (the proposer is one). Not
    // the owner (not in the group), not `elsewhere` (linked, but in Ops), not the guest.
    expect(items.map(i => i.assignee_id).sort()).toEqual([member.verified, member.asserted, member.asserted2].sort());
    expect(items.every(i => i.status === 'open' && i.action_type === 'decide' && i.origin === 'system')).toBe(true);
    expect(items[0]!.reason).toMatch(/^verified proposed a memory for Infra: "Deploy windows/);
  });

  it('answers the same proposal when the executor re-runs the command', async () => {
    const id = `wamid.${randomUUID()}`;
    const first = await propose(infra, people.asserted.infra, 'Rahul owns billing', id);
    const again = await propose(infra, people.asserted.infra, 'Rahul owns billing', id);
    expect(again).toMatchObject({ id: first.id, created: false });
    expect(await attentionOf(first.id)).toHaveLength(3);
  });

  it('refuses a guest, and any caller that is not the bridges worker', async () => {
    expect(reasonOf(await refusal(propose(infra, GUEST, 'I am the boss now')))).toBe('remember_needs_link');
    for (const authKind of ['browser', 'agent'] as const) {
      const e = await refusal(as('verified', q => q.rpc('propose_bridge_memory',
        [infra, people.verified.infra, 'sneaky', null, `wamid.${randomUUID()}`]), authKind));
      expect(reasonOf(e)).toBe('bridges_worker_only');
    }
  });

  it('refuses a credential value and stores it nowhere; a word naming a secret only warns', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const providerId = `wamid.${randomUUID()}`;
    expect(reasonOf(await refusal(propose(infra, people.verified.infra, `the deploy token is ${token}`, providerId))))
      .toBe('proposal_holds_secret');
    const stored = await scratch.query(
      `select 1 from public.bridge_memory_proposals where provider_message_id = $1 or statement like $2
       union all select 1 from public.attention_requests where reason like $2`, [providerId, `%${token}%`]);
    expect(stored).toHaveLength(0);

    const warned = await propose(infra, people.verified.infra, 'the staging db password rotates on Mondays');
    expect(warned.mentionsSecret).toBe(true);
    expect((await attentionOf(warned.id))[0]!.reason).toMatch(/mentions a secret/);
  });

  it('caps a group at 20 waiting proposals', async () => {
    const [{ n }] = await scratch.query<{ n: number }>(
      `select count(*)::int n from public.bridge_memory_proposals where bridge_id = $1 and status = 'pending'`, [ops]);
    for (let i = n; i < 20; i++) await propose(ops, people.elsewhere.ops, `ops fact ${i}`);
    expect(reasonOf(await refusal(propose(ops, people.elsewhere.ops, 'one too many')))).toBe('too_many_proposals');
    await scratch.query(`delete from public.bridge_memory_proposals where bridge_id = $1`, [ops]);
  });
});

describe('accept and drop (in tm8, human-only, D62)', () => {
  it('a linked member of the group accepts: the memory, `remembers` and D22 provenance; every inbox item resolves', async () => {
    const message = randomUUID();
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [message, spaceId, member.verified]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'/remember …')`,
        [message, infra, member.verified]);
    });
    const p = await propose(infra, people.verified.infra, 'Reply in Hinglish when asked in Hinglish', 'wamid.accept-1', message);
    // An asserted member may accept a VERIFIED member's proposal: D29 asks for a linked member.
    const accepted = await resolve('asserted', p.id, 'accept');
    expect(accepted).toMatchObject({ status: 'accepted', canDecide: false });
    const memory = accepted.memoryId!;
    const [mem] = await scratch.query<{ statement: string; created_by: string }>(
      `select m.statement, e.created_by from public.memories m join public.entities e on e.id = m.entity_id where m.entity_id = $1`, [memory]);
    expect(mem).toEqual({ statement: 'Reply in Hinglish when asked in Hinglish', created_by: member.asserted });
    const remembers = await scratch.query(`select 1 from public.edges where src_id = $1 and dst_id = $2 and type = 'remembers'`, [infra, memory]);
    expect(remembers).toHaveLength(1);
    const prov = await scratch.query<{ dst_id: string; props: { bridgeId: string; origins: Array<Record<string, unknown>> } }>(
      `select dst_id::text, props from public.edges where src_id = $1 and type = 'authored_from' and props ? 'bridgeId' order by dst_id`, [memory]);
    expect(prov.map(e => e.dst_id).sort()).toEqual([infra, message].sort());
    expect(prov.find(e => e.dst_id === infra)!.props.origins).toEqual([expect.objectContaining({
      bridgeId: infra, providerMessageId: 'wamid.accept-1', messageId: message, command: '/remember',
      inherited: false, depth: 0, sender: { memberId: member.verified, participant: 'verified' } })]);
    expect((await attentionOf(p.id)).every(i => i.status === 'resolved')).toBe(true);

    // A retried accept answers the same; a drop after it is refused.
    expect(await resolve('asserted', p.id, 'accept')).toMatchObject({ status: 'accepted', memoryId: memory });
    expect(reasonOf(await refusal(resolve('verified', p.id, 'drop')))).toBe('proposal_decided');
  });

  it('refuses agents, the bridges worker, members outside the group, and an admin outside it for a verified proposal', async () => {
    const p = await propose(infra, people.verified.infra, 'Standups are at 10');
    const agent = await refusal(resolve('verified', p.id, 'accept', null, 'agent'));
    expect(agent.code).toBe('forbidden');
    const worker = await refusal(asWorker(c => c.query(`select public.resolve_bridge_memory_proposal($1, 'accept')`, [p.id])));
    expect(worker.code).not.toBeUndefined();
    expect(reasonOf(await refusal(resolve('plain', p.id, 'accept')))).toBe('proposal_not_decider');
    expect(reasonOf(await refusal(resolve('elsewhere', p.id, 'accept')))).toBe('proposal_not_decider');
    // D62 as D29 reads: the admin path is only for an asserted proposer's proposal.
    expect(reasonOf(await refusal(resolve('owner', p.id, 'accept')))).toBe('proposal_not_decider');
    const [row] = await scratch.query<{ status: string }>(`select status from public.bridge_memory_proposals where id = $1`, [p.id]);
    expect(row!.status).toBe('pending');
  });

  it('an asserted proposer\'s proposal needs a verified link or an admin', async () => {
    const p = await propose(infra, people.asserted.infra, 'Prod deploys need two approvals');
    expect(reasonOf(await refusal(resolve('asserted2', p.id, 'accept')))).toBe('proposal_not_decider');
    expect(reasonOf(await refusal(resolve('asserted', p.id, 'accept')))).toBe('proposal_not_decider');
    const lists = await as('owner', q => q.rpc<Proposal[]>('list_bridge_memory_proposals', [infra, 'pending', 50]));
    expect(lists.find(x => x.id === p.id)!.canDecide).toBe(true);
    // The admin corrects the text and accepts it.
    const done = await resolve('owner', p.id, 'accept', 'Prod deploys need two approvals from on-call');
    const [mem] = await scratch.query<{ statement: string }>(`select statement from public.memories where entity_id = $1`, [done.memoryId]);
    expect(mem!.statement).toBe('Prod deploys need two approvals from on-call');

    const q2 = await propose(infra, people.asserted2.infra, 'Friday is no-deploy day');
    expect(await resolve('verified', q2.id, 'accept')).toMatchObject({ status: 'accepted' });
  });

  it('drops, and refuses an accepted edit that holds a credential', async () => {
    const p = await propose(infra, people.verified.infra, 'The VPN config lives in the wiki');
    expect(reasonOf(await refusal(resolve('verified', p.id, 'accept', 'use sk-abcdefghijklmnop0123456789')))).toBe('proposal_holds_secret');
    expect(await resolve('verified', p.id, 'drop')).toMatchObject({ status: 'dropped', memoryId: null });
    expect((await attentionOf(p.id)).every(i => i.status === 'resolved')).toBe(true);
    expect(reasonOf(await refusal(resolve('verified', p.id, 'accept')))).toBe('proposal_decided');
  });

  it('a "YES" or "/remember accept" from the group is only another proposal: nothing from WhatsApp decides', async () => {
    const p = await propose(infra, people.asserted.infra, 'Hotfix branches start with hf/');
    const yes = await propose(infra, people.verified.infra, 'YES');
    const accept = await propose(infra, people.verified.infra, `accept ${p.id}`);
    expect([yes.status, accept.status]).toEqual(['pending', 'pending']);
    const [row] = await scratch.query<{ status: string }>(`select status from public.bridge_memory_proposals where id = $1`, [p.id]);
    expect(row!.status).toBe('pending');
    // The worker claim cannot reach the decision door with any decision.
    for (const decision of ['accept', 'drop']) {
      await refusal(asWorker(c => c.query(`select public.resolve_bridge_memory_proposal($1, $2)`, [p.id, decision])));
    }
  });
});

describe('expiry after 14 days (D63)', () => {
  it('refuses a decision past expiry, and the node admin\'s sweep expires it and clears its inbox items', async () => {
    const p = await propose(infra, people.verified.infra, 'Old news');
    await scratch.query(`update public.bridge_memory_proposals set expires_at = now() - interval '1 minute' where id = $1`, [p.id]);
    expect(reasonOf(await refusal(resolve('verified', p.id, 'accept')))).toBe('proposal_expired');
    expect((await refusal(as('verified', q => q.rpc('expire_bridge_memory_proposals', [500])))).code).toBe('forbidden');
    const n = await as('owner', q => q.rpc<number>('expire_bridge_memory_proposals', [500]), 'browser', { nodeAdmin: true });
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    const [row] = await scratch.query<{ status: string }>(`select status from public.bridge_memory_proposals where id = $1`, [p.id]);
    expect(row!.status).toBe('expired');
    expect((await attentionOf(p.id)).every(i => i.status === 'cleared')).toBe(true);
    expect(reasonOf(await refusal(resolve('verified', p.id, 'accept')))).toBe('proposal_decided');
  });
});

describe('reads', () => {
  it('lists a bridge\'s proposals with canDecide for the caller and no provider ids', async () => {
    const p = await propose(infra, people.verified.infra, 'Readable fact');
    const mine = await as('verified', q => q.rpc<Proposal[]>('list_bridge_memory_proposals', [infra, 'pending', 50]));
    expect(mine.find(x => x.id === p.id)!.canDecide).toBe(true);
    const plain = await as('plain', q => q.rpc<Proposal[]>('list_bridge_memory_proposals', [infra, null, 200]));
    expect(plain.find(x => x.id === p.id)!.canDecide).toBe(false);
    expect(JSON.stringify(plain)).not.toMatch(/\+91|wamid/);
  });
});
