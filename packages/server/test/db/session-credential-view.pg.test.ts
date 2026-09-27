/**
 * GATE 3 (spec doc 01a0e248 §9, R1/S2): the session names its credential on
 * its OWN read, masked by the server for the caller. Real PostgreSQL, the full
 * migration chain, and the real detail assembler (`buildDetail`, the one
 * `entities.get` uses) under each caller's claims.
 *
 *   - the owner of a private card sees its key hint and login;
 *   - another member sees the card's name and nothing else, and neither
 *     secret-adjacent string appears anywhere in their detail payload;
 *   - a non-human caller gets neither field even on its launcher's own card;
 *   - a public card shows the masker's fields to every member;
 *   - a card revoked since launch is still named;
 *   - legacy rungs come from the manifest; none carries its reason;
 *   - who resumed the session is named;
 *   - a card read that fails is contained: that edge reads "not visible", the
 *     transaction stays usable, and the error text never reaches the payload.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionCredentialView } from '@tm8/contract';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { readSessionCredentialView } from '../../src/credentials/session-credential-view.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { buildDetail } from '../../src/facade/handlers/entities.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'scv-owner';
const A = 'scv-a';
const B = 'scv-b';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function session(createdBy: string, kind = 'agent'): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`,
      [id, ids.S, createdBy]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind) values ($1, 'fixture', 'spawning', $2)`,
      [id, kind]);
    return id;
  });
}

async function recordManifest(sessionId: string, effective: Record<string, string>, spaceIds: Record<string, string>, who: DbClaims) {
  const launch = { tool: 'claude-code', credentialSources: effective, spaceCredentialIds: spaceIds, effectiveCredentialSources: effective };
  return db.rpc<{ credentialBinding: string }>(who, 'record_session_manifest', [sessionId, JSON.stringify({ launch })]);
}

async function credential(
  owner: string, provider: 'anthropic' | 'github', visibility: 'private' | 'public', displayLogin: string | null = null,
): Promise<{ id: string; label: string; hint: string }> {
  const secret = `${provider === 'github' ? 'ghp' : 'sk'}-${randomUUID().replaceAll('-', '')}`;
  const label = `${owner} ${provider} ${visibility} ${randomUUID().slice(0, 8)}`;
  const created = await store.create(claims(owner), {
    spaceId: ids.S!, provider, shape: provider === 'github' ? 'token' : 'api_key', label, secret, displayLogin, visibility,
  });
  return { id: created.id, label, hint: secret.slice(-4) };
}

/** The session's own `entities.get` detail, as `viewer`. */
async function detail(sessionId: string, viewer: DbClaims) {
  return db.tx(viewer, (q) => buildDetail(q, sessionId, viewer.identityId!));
}

async function view(sessionId: string, viewer: DbClaims): Promise<SessionCredentialView> {
  const d = await detail(sessionId, viewer);
  if (d.content.kind !== 'work_session') throw new Error(`expected a work_session, got ${d.content.kind}`);
  return d.content.credential!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-scv-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('session_credential_view');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, A, B]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(`insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
                     values ($1, $1, $1, $2, $2)`, [identity, identity === OWN]);
    }
    ids.S = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    for (const [key, identity, role] of [['member:OWN', OWN, 'owner'], ['member:A', A, 'member'], ['member:B', B, 'member']] as const) {
      const member = ids[key] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`,
        [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [member, ids.S, identity, role, `${identity} display`]);
    }
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe("gate 3 — a private card is masked for everyone but its owner", () => {
  let s: string;
  let ant: { id: string; label: string; hint: string };
  let gh: { id: string; label: string; hint: string };

  beforeAll(async () => {
    ant = await credential(B, 'anthropic', 'private');
    gh = await credential(B, 'github', 'private', 'b-secret-login');
    s = await session(ids['member:B']!);
    expect((await recordManifest(s, { anthropic: 'space', github: 'space' }, { anthropic: ant.id, github: gh.id }, agent(B)))
      .credentialBinding).toBe('bound');
  });

  it('the owner sees their own hint and login, as "you"', async () => {
    const v = await view(s, claims(B));
    expect(v).toMatchObject({ binding: 'bound', noneReason: null, launchedByViewer: true, resumedBy: null });
    expect(v.providers.map((p) => p.provider)).toEqual(['anthropic', 'github']);
    expect(v.providers[0]!.credential).toMatchObject({
      id: ant.id, label: ant.label, owner: 'you', visibility: 'private', keyHint: ant.hint, detailHidden: false, ownerName: null,
    });
    expect(v.providers[1]!.credential).toMatchObject({ id: gh.id, owner: 'you', displayLogin: 'b-secret-login', detailHidden: false });
  });

  it('another member sees the name only: no key hint, no vendor login, anywhere in the payload', async () => {
    const d = await detail(s, claims(A));
    if (d.content.kind !== 'work_session') throw new Error('not a session');
    const v = d.content.credential!;
    expect(v.launchedByViewer).toBe(false);
    for (const p of v.providers) {
      expect(p.rung).toBe('space');
      expect(p.credential).toMatchObject({ owner: 'other', visibility: 'private', keyHint: null, displayLogin: null, detailHidden: true });
    }
    expect(v.providers[0]!.credential!.label).toBe(ant.label);
    const payload = JSON.stringify(d);
    expect(payload).not.toContain('b-secret-login');
    expect(payload).not.toContain(ant.hint);
    expect(payload).not.toContain(gh.hint);
  });

  it('a non-human caller gets neither field, even on its own launcher\'s card', async () => {
    const d = await detail(s, agent(B));
    if (d.content.kind !== 'work_session') throw new Error('not a session');
    for (const p of d.content.credential!.providers) {
      expect(p.credential).toMatchObject({ owner: 'you', keyHint: null, displayLogin: null, detailHidden: true });
    }
    const payload = JSON.stringify(d);
    expect(payload).not.toContain('b-secret-login');
    expect(payload).not.toContain(ant.hint);
  });
});

describe('gate 3 — the other shapes of the block', () => {
  it("a public card shows the masker's fields to every member, and ownership is still someone else's", async () => {
    const gh = await credential(B, 'github', 'public', 'b-public-login');
    const ant = await credential(B, 'anthropic', 'public');
    const s = await session(ids['member:B']!);
    await recordManifest(s, { anthropic: 'space', github: 'space' }, { anthropic: ant.id, github: gh.id }, agent(B));
    const v = await view(s, claims(A));
    expect(v.providers[0]!.credential).toMatchObject({ owner: 'other', visibility: 'public', keyHint: ant.hint, detailHidden: false });
    expect(v.providers[1]!.credential).toMatchObject({ owner: 'other', displayLogin: 'b-public-login', detailHidden: false });
  });

  it('a card revoked since launch is still named, as revoked', async () => {
    const ant = await credential(A, 'anthropic', 'private');
    const s = await session(ids['member:A']!);
    await recordManifest(s, { anthropic: 'space' }, { anthropic: ant.id }, agent(A));
    await store.revoke(claims(A), ant.id);
    const v = await view(s, claims(A));
    expect(v.binding).toBe('bound');
    expect(v.providers[0]!.credential).toMatchObject({ id: ant.id, label: ant.label, status: 'revoked' });
  });

  it('legacy: the rungs release 2 removes are read from the manifest, with a space card alongside', async () => {
    const ant = await credential(A, 'anthropic', 'private');
    const s = await session(ids['member:A']!);
    expect((await recordManifest(s, { anthropic: 'space', github: 'node' }, { anthropic: ant.id }, agent(A))).credentialBinding)
      .toBe('legacy');
    const v = await view(s, claims(A));
    expect(v.binding).toBe('legacy');
    expect(v.providers.map((p) => [p.provider, p.rung])).toEqual([['anthropic', 'space'], ['github', 'node']]);
    expect(v.providers[1]!.credential).toBeNull();

    const m = await session(ids['member:A']!);
    await recordManifest(m, { anthropic: 'member' }, {}, agent(A));
    expect((await view(m, claims(A))).providers).toEqual([{ provider: 'anthropic', rung: 'member', credential: null }]);
  });

  it('none carries its reason and no providers', async () => {
    const s = await session(ids['member:A']!, 'shell');
    expect(await view(s, claims(A))).toEqual({
      binding: 'none', noneReason: 'shell', providers: [], launchedByViewer: true, resumedBy: null,
    });
  });

  it('pending before the binding is recorded', async () => {
    const s = await session(ids['member:A']!);
    expect((await view(s, claims(A))).binding).toBe('pending');
  });

  it('a resumed session names who resumed it (the latest resume)', async () => {
    const ant = await credential(A, 'anthropic', 'private');
    const s = await session(ids['member:A']!);
    await recordManifest(s, { anthropic: 'space' }, { anthropic: ant.id }, agent(A));
    await asOwner(async (c) => {
      for (const actor of [ids['member:B'], ids['member:OWN']]) {
        await c.query(`insert into public.activity(space_id, entity_id, actor_id, verb, summary, created_at)
                       values ($1, $2, $3, 'restored', '{"kind":"work_session","action":"resumed"}', clock_timestamp())`,
          [ids.S, s, actor]);
      }
    });
    expect((await view(s, claims(A))).resumedBy).toBe(`${OWN} display`);
  });

  it('a failing card read is contained: that edge is "not visible", the transaction survives, no error text leaks', async () => {
    const ant = await credential(A, 'anthropic', 'private');
    const gh = await credential(A, 'github', 'private', 'a-login');
    const s = await session(ids['member:A']!);
    await recordManifest(s, { anthropic: 'space', github: 'space' }, { anthropic: ant.id, github: gh.id }, agent(A));
    const viewer = claims(A);
    const result = await db.tx(viewer, async (q) => {
      // Stand in for a masker that raises (#935 condition ii) on ONE card.
      const failing: Querier = {
        query: ((sql: string, params?: unknown[]) =>
          sql.includes('read_space_credential') && params?.[0] === ant.id
            ? q.query(`select public.read_space_credential($1::uuid) as card, (1/0) as boom`, params)
            : q.query(sql, params)) as Querier['query'],
      } as Querier;
      const v = await readSessionCredentialView(failing, s, ids['member:A']!, A);
      const [after] = await q.query<{ ok: number }>('select 1 as ok');
      return { v, after };
    });
    expect(result.after).toEqual({ ok: 1 });
    expect(result.v!.providers.map((p) => [p.provider, p.credential?.id ?? null]))
      .toEqual([['anthropic', null], ['github', gh.id]]);
    expect(JSON.stringify(result.v)).not.toMatch(/division|22012/);
  });
});
