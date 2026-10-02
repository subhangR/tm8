/**
 * Credentials R1/S7 (spec doc 01a0e248 §10.4, §11 S7, §8.3 Q1) —
 * `space_credential_readiness(p_space_id)` against a REAL PostgreSQL with every
 * migration applied, called as `tm8_app` under each caller's claims.
 *
 * TWO THRESHOLDS, NEVER ONE TICK: canLaunch (the caller's active my_default or
 * the active space default, per provider) and canPoll (an active, space-owned,
 * public github credential). Every case builds a FRESH space, so no case can
 * pass on another's rows, and every red is paired with a green on the same
 * space once the missing row is added or the bad state is lifted.
 *
 * Cast: A and B are members of every space; OUT is a member of none.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const A = `s7-a-${randomUUID()}`;
const B = `s7-b-${randomUUID()}`;
const OUT = `s7-out-${randomUUID()}`;
const accounts: Record<string, string> = {};
/** Each space's owner member entity: the actor a 239 credential card is created by. */
const actorOf: Record<string, string> = {};

type Provider = 'anthropic' | 'openai' | 'github';
interface ProviderReadiness {
  ready: boolean;
  via: 'my_default' | 'space_default' | null;
  credentialId: string | null;
  myDefaultId: string | null;
  spaceDefaultId: string | null;
  spaceSourceAllowed: boolean;
  activeCredentials: number;
  reason: 'policy_excludes_space' | 'stale' | 'no_credential' | null;
}
interface Readiness {
  spaceId: string;
  canLaunch: { ready: boolean; missing: Provider[]; providers: Record<Provider, ProviderReadiness> };
  canPoll: {
    ready: boolean;
    missing: Provider[];
    credentialId: string | null;
    activeSpaceOwnedCredentials: number;
    reason: 'stale' | 'no_space_owned_credential' | null;
  };
  seeding: Seeding;
}
interface Seeding {
  window: string;
  agentSessions: number;
  sessionsWithoutRecord: number;
  githubProjects: number;
  usedProviders: Provider[];
  providers: Partial<Record<Provider, {
    ready: boolean;
    needs: ('launch' | 'poll')[];
    launchReason: string | null;
    pollReason: string | null;
    reason: string | null;
  }>>;
  missing: Provider[];
  state: 'green' | 'red' | 'idle';
  readyForCut: boolean;
}

let database: W1ScratchDatabase;
let db: Db;

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, authKind, nodeAdmin: false, requestId: `s7-${randomUUID()}` }) as DbClaims;

/**
 * DRIFT GUARD. Readiness MIRRORS the auto ladder's predicates instead of
 * calling the ladder, so it could drift from the spawn silently. Every
 * readiness answer in this file is therefore checked, provider by provider,
 * against what the spawn path's own SQL resolves for the same caller and state:
 * the policy (`read_space_credential_policy`, absent = every source), then
 * `my_space_credential_default_id` read through `read_space_credential_for_spawn`
 * as a pinned id, else `read_space_credential_for_spawn` with a null id — the
 * `resolveSessionCredentials` auto path. If either side changes (R2's S4
 * rewrites the ladder), every case in this file goes red.
 */
async function ladder(identityId: string, spaceId: string, provider: Provider, authKind: string) {
  const who = claims(identityId, authKind);
  const policy = await db.rpc<Record<string, string[]>>(who, 'read_space_credential_policy', [spaceId]);
  const allowed = policy[provider] === undefined || policy[provider]!.includes('space');
  if (!allowed) return { ready: false, via: null, credentialId: null };
  const spawnRead = async (pinned: string | null): Promise<string | null> => {
    try {
      const grant = await db.rpc<{ credentialId: string }>(who, 'read_space_credential_for_spawn', [spaceId, provider, pinned]);
      return grant.credentialId;
    } catch {
      return null;
    }
  };
  const mine = await db.rpc<string | null>(who, 'my_space_credential_default_id', [spaceId, provider]);
  const viaMine = mine ? await spawnRead(mine) : null;
  if (viaMine) return { ready: true, via: 'my_default', credentialId: viaMine };
  const viaDefault = await spawnRead(null);
  if (viaDefault) return { ready: true, via: 'space_default', credentialId: viaDefault };
  return { ready: false, via: null, credentialId: null };
}

async function readiness(identityId: string, spaceId: string, authKind = 'browser'): Promise<Readiness> {
  const answer = await db.rpc<Readiness>(claims(identityId, authKind), 'space_credential_readiness', [spaceId]);
  for (const p of ['anthropic', 'openai', 'github'] as const) {
    const { ready, via, credentialId } = answer.canLaunch.providers[p];
    expect({ ready, via, credentialId }, `readiness.canLaunch.${p} agrees with the spawn ladder`)
      .toEqual(await ladder(identityId, spaceId, p, authKind));
  }
  return answer;
}

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function space(): Promise<string> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S7', $2)`, [id, A]);
    for (const [identity, role] of [[A, 'owner'], [B, 'member']] as const) {
      const member = randomUUID();
      if (identity === A) actorOf[id] = member;
      await c.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`,
        [member, id]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, id, identity, role]);
    }
  });
  return id;
}

interface CredentialOpts {
  status?: 'active' | 'stale' | 'revoked';
  isDefault?: boolean;
  owner?: string;
  visibility?: 'public' | 'private';
  myDefaultOf?: string;
}

/** A credential row + its 239 card, written as the graph owner — the state the real doors produce. */
async function credential(spaceId: string, provider: Provider, opts: CredentialOpts = {}): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? 'active';
  const shape = provider === 'github' ? 'token' : 'api_key';
  const sealed = status !== 'revoked';
  await asOwner(async (c) => {
    await c.query('select internal.insert_credential_entity($1, $2, $3)', [id, spaceId, actorOf[spaceId]]);
    await c.query(
      `insert into public.space_credentials(id, space_id, provider, shape, label, status, is_default,
         owner_account_id, visibility, key_hint, secret_ciphertext, secret_nonce)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Qz9x',
               case when $10 then decode(repeat('00', 17), 'hex') end,
               case when $10 then decode(repeat('00', 12), 'hex') end)`,
      [id, spaceId, provider, shape, `${provider} ${id.slice(0, 8)}`, status, opts.isDefault ?? false,
        opts.owner ? accounts[opts.owner] : null, opts.visibility ?? 'public', sealed]);
    if (opts.myDefaultOf) {
      await c.query(
        `insert into public.member_defaults(space_id, account_id, provider, credential_id) values ($1, $2, $3, $4)`,
        [spaceId, accounts[opts.myDefaultOf], provider, id]);
    }
  });
  return id;
}

async function setStatus(id: string, status: 'active' | 'stale' | 'revoked'): Promise<void> {
  await asOwner((c) => c.query(
    `update public.space_credentials
        set status = $2,
            is_default = case when $2 = 'revoked' then false else is_default end,
            secret_ciphertext = case when $2 = 'revoked' then null else secret_ciphertext end,
            secret_nonce = case when $2 = 'revoked' then null else secret_nonce end
      where id = $1`, [id, status]));
}

/** Every provider green on the space default, as a baseline a case then breaks. */
async function greenSpace(): Promise<string> {
  const s = await space();
  for (const p of ['anthropic', 'openai', 'github'] as const) await credential(s, p, { isDefault: true });
  return s;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; details?: { sqlstate?: string }; cause?: { code?: string } };
    return String(e.details?.sqlstate ?? e.cause?.code ?? e.code);
  }
}

beforeAll(async () => {
  expect(migrationFiles().some((f) => /_space_credential_readiness\.sql$/.test(f))).toBe(true);
  database = await createW1ScratchDatabase('space_credential_readiness');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await asOwner(async (c) => {
    for (const identity of [A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username) values ($1, $1) returning id::text`, [identity]);
      accounts[identity] = rows[0]!.id;
    }
  });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('space_credential_readiness — scope', () => {
  it('a non-member is refused (42501); a member of the same space reads it', async () => {
    const s = await greenSpace();
    expect(await outcome(() => readiness(OUT, s))).toBe('42501');
    expect((await readiness(A, s)).canLaunch.ready).toBe(true);
  });

  it('an empty space: both thresholds red, every provider missing, reasons name the threshold state', async () => {
    const s = await space();
    const r = await readiness(A, s);
    expect(r.spaceId).toBe(s);
    expect(r.canLaunch).toMatchObject({ ready: false, missing: ['anthropic', 'openai', 'github'] });
    for (const p of ['anthropic', 'openai', 'github'] as const) {
      expect(r.canLaunch.providers[p]).toMatchObject({
        ready: false, via: null, credentialId: null, activeCredentials: 0, reason: 'no_credential', spaceSourceAllowed: true,
      });
    }
    expect(r.canPoll).toMatchObject({ ready: false, missing: ['github'], credentialId: null, reason: 'no_space_owned_credential' });
  });

  it('returns metadata only: no label, hint, login or secret key anywhere in the answer', async () => {
    const s = await greenSpace();
    const text = JSON.stringify(await readiness(A, s));
    expect(text).not.toMatch(/Qz9x|label|keyHint|displayLogin|secret|ciphertext|nonce/i);
  });

  it('is not human-only in SQL: an agent (its launcher\'s claims) reads the same answer', async () => {
    const s = await greenSpace();
    expect(await readiness(A, s, 'agent')).toEqual(await readiness(A, s));
  });

  /**
   * The identity_id gate's review (tools/ci/identity-id-allowlist.txt): the
   * function reads current_account_id(), so it must not reach a space other
   * than the session's pin (227). A is a member of BOTH spaces; a session
   * pinned to one — a space-entered cli session and a link session alike —
   * is refused on the other, and reads its own pin exactly as unpinned. Called
   * straight through db.rpc: the drift guard's spawn reader refuses link
   * sessions outright (256), which is not what is under test here.
   */
  for (const [kind, extra] of [
    ['cli', {}],
    ['link', { viaLinkId: randomUUID() }],
  ] as const) {
    it(`${kind} session pinned to one space: the other space is refused (42501) though A is a member of both`, async () => {
      const pinned = await greenSpace();
      const other = await greenSpace();
      const as = { ...claims(A, kind), sessionSpaceId: pinned, ...extra } as DbClaims;
      expect(await outcome(() => db.rpc(as, 'space_credential_readiness', [other]))).toBe('42501');
      expect(await db.rpc(as, 'space_credential_readiness', [pinned]))
        .toEqual(await db.rpc(claims(A), 'space_credential_readiness', [pinned]));
      expect((await readiness(A, other)).canLaunch.ready).toBe(true);
    });
  }
});

describe('space_credential_readiness — canLaunch', () => {
  it('space-owned public defaults: green on space_default for every provider, and canPoll green too', async () => {
    const s = await greenSpace();
    const r = await readiness(B, s);
    expect(r.canLaunch).toMatchObject({ ready: true, missing: [] });
    for (const p of ['anthropic', 'openai', 'github'] as const) {
      expect(r.canLaunch.providers[p]).toMatchObject({ ready: true, via: 'space_default', reason: null, activeCredentials: 1 });
      expect(r.canLaunch.providers[p].credentialId).toBe(r.canLaunch.providers[p].spaceDefaultId);
    }
    expect(r.canPoll).toMatchObject({ ready: true, missing: [], reason: null, activeSpaceOwnedCredentials: 1 });
    expect(r.canPoll.credentialId).toBe(r.canLaunch.providers.github.spaceDefaultId);
  });

  it('stale does NOT count: a stale default is red with reason stale; re-activated it is green', async () => {
    const s = await space();
    const id = await credential(s, 'anthropic', { isDefault: true, status: 'stale' });
    const red = (await readiness(A, s)).canLaunch.providers.anthropic;
    expect(red).toMatchObject({ ready: false, reason: 'stale', spaceDefaultId: null, activeCredentials: 0 });
    await setStatus(id, 'active');
    expect((await readiness(A, s)).canLaunch.providers.anthropic).toMatchObject({ ready: true, via: 'space_default', credentialId: id });
  });

  it('stale does NOT count for my_default either', async () => {
    const s = await space();
    const id = await credential(s, 'openai', { owner: A, visibility: 'private', status: 'stale', myDefaultOf: A });
    expect((await readiness(A, s)).canLaunch.providers.openai).toMatchObject({ ready: false, reason: 'stale', myDefaultId: null });
    await setStatus(id, 'active');
    expect((await readiness(A, s)).canLaunch.providers.openai).toMatchObject({ ready: true, via: 'my_default', myDefaultId: id });
  });

  it('revoked does NOT count: the green default, once revoked, turns red and leaves Q1\'s count', async () => {
    const s = await greenSpace();
    const before = await readiness(A, s);
    const id = before.canLaunch.providers.anthropic.spaceDefaultId!;
    expect(before.canLaunch.providers.anthropic.ready).toBe(true);
    await setStatus(id, 'revoked');
    const after = await readiness(A, s);
    expect(after.canLaunch.providers.anthropic).toMatchObject({ ready: false, reason: 'no_credential', activeCredentials: 0 });
    expect(after.canLaunch.missing).toEqual(['anthropic']);
  });

  it('a revoked space-owned github turns canPoll red', async () => {
    const s = await greenSpace();
    const gh = (await readiness(A, s)).canPoll.credentialId!;
    await setStatus(gh, 'revoked');
    expect((await readiness(A, s)).canPoll).toMatchObject({ ready: false, reason: 'no_space_owned_credential' });
  });

  it('another member\'s PRIVATE credential (their my_default) is red for me, green for them', async () => {
    const s = await space();
    const id = await credential(s, 'anthropic', { owner: B, visibility: 'private', myDefaultOf: B });
    const mine = (await readiness(A, s)).canLaunch.providers.anthropic;
    expect(mine).toMatchObject({ ready: false, via: null, credentialId: null, myDefaultId: null, reason: 'no_credential' });
    // Q1 counts it (it is active in the space), so the reconciliation number sees it.
    expect(mine.activeCredentials).toBe(1);
    expect((await readiness(B, s)).canLaunch.providers.anthropic).toMatchObject({ ready: true, via: 'my_default', credentialId: id });
  });

  it('a PUBLIC member-owned credential that is not a default does not count either (the auto ladder never picks it)', async () => {
    const s = await space();
    await credential(s, 'openai', { owner: B, visibility: 'public' });
    expect((await readiness(A, s)).canLaunch.providers.openai).toMatchObject({ ready: false, activeCredentials: 1 });
  });

  it('my_default outranks the space default, like the ladder', async () => {
    const s = await greenSpace();
    const mine = await credential(s, 'anthropic', { owner: A, visibility: 'private', myDefaultOf: A });
    expect((await readiness(A, s)).canLaunch.providers.anthropic).toMatchObject({ via: 'my_default', credentialId: mine });
    expect((await readiness(B, s)).canLaunch.providers.anthropic.via).toBe('space_default');
  });

  it('a space policy without `space` is red with reason policy_excludes_space even with a default', async () => {
    const s = await greenSpace();
    await asOwner((c) => c.query(
      `insert into public.space_credential_policies(space_id, provider, allowed_sources) values ($1, 'openai', array['member'])`, [s]));
    expect((await readiness(A, s)).canLaunch.providers.openai).toMatchObject({
      ready: false, via: null, credentialId: null, spaceSourceAllowed: false, reason: 'policy_excludes_space',
    });
    await asOwner((c) => c.query(
      `update public.space_credential_policies set allowed_sources = array['space'] where space_id = $1`, [s]));
    expect((await readiness(A, s)).canLaunch.providers.openai.ready).toBe(true);
  });
});

describe('space_credential_readiness — canPoll is its own threshold', () => {
  it('member-owned github only: canLaunch.github GREEN, canPoll RED; a space-owned one turns canPoll green', async () => {
    const s = await space();
    await credential(s, 'anthropic', { isDefault: true });
    await credential(s, 'openai', { isDefault: true });
    await credential(s, 'github', { owner: A, visibility: 'public', myDefaultOf: A });
    const r = await readiness(A, s);
    expect(r.canLaunch).toMatchObject({ ready: true, missing: [] });
    expect(r.canLaunch.providers.github.via).toBe('my_default');
    expect(r.canPoll).toMatchObject({ ready: false, missing: ['github'], activeSpaceOwnedCredentials: 0, reason: 'no_space_owned_credential' });
    const spaceOwned = await credential(s, 'github');
    expect((await readiness(A, s)).canPoll).toMatchObject({ ready: true, credentialId: spaceOwned, reason: null });
  });

  it('a member-owned github that the owner allowed as the SPACE DEFAULT still does not make canPoll green', async () => {
    const s = await space();
    await asOwner(async (c) => {
      const id = randomUUID();
      await c.query('select internal.insert_credential_entity($1, $2, $3)', [id, s, actorOf[s]]);
      await c.query(
        `insert into public.space_credentials(id, space_id, provider, shape, label, is_default, owner_account_id,
           visibility, may_be_space_default, key_hint, secret_ciphertext, secret_nonce)
         values ($1, $2, 'github', 'token', 'owned default', true, $3, 'public', true, 'Qz9x',
                 decode(repeat('00', 17), 'hex'), decode(repeat('00', 12), 'hex'))`, [id, s, accounts[B]]);
    });
    const r = await readiness(A, s);
    expect(r.canLaunch.providers.github).toMatchObject({ ready: true, via: 'space_default' });
    expect(r.canPoll.ready).toBe(false);
  });

  it('a stale space-owned github: canPoll red with reason stale', async () => {
    const s = await space();
    const id = await credential(s, 'github', { status: 'stale' });
    expect((await readiness(A, s)).canPoll).toMatchObject({ ready: false, reason: 'stale' });
    await setStatus(id, 'active');
    expect((await readiness(A, s)).canPoll).toMatchObject({ ready: true, credentialId: id });
  });

  it('canPoll prefers the space default among several space-owned github credentials', async () => {
    const s = await space();
    await credential(s, 'github');
    const def = await credential(s, 'github', { isDefault: true });
    expect((await readiness(A, s)).canPoll).toMatchObject({ credentialId: def, activeSpaceOwnedCredentials: 2 });
  });
});

/**
 * R1/S7b (task 01a0e75e, spec §8.3 / S9): the R2 seeding gate is per provider
 * the space USES. Used providers are derived from agent sessions in the window
 * (their manifests' effectiveCredentialSources) plus github-repo projects; the
 * verdict is the space's (active space default, policy allowing; github
 * projects also need a space-owned public github), never the caller's.
 */
async function session(
  spaceId: string,
  sources: Record<string, string | null> | null,
  opts: { daysAgo?: number; kind?: 'agent' | 'shell'; agentTool?: string; noManifest?: boolean } = {},
): Promise<void> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
      [id, spaceId, actorOf[spaceId]]);
    await c.query(
      `insert into public.work_sessions(entity_id, session_kind, agent_tool, created_at)
       values ($1, $2, $3, now() - make_interval(days => $4))`,
      [id, opts.kind ?? 'agent', opts.agentTool ?? null, opts.daysAgo ?? 1]);
    if (opts.noManifest) return;
    const launch = sources === null ? {} : { effectiveCredentialSources: sources };
    await c.query(`insert into public.session_manifests(work_session_id, manifest) values ($1, $2)`,
      [id, JSON.stringify({ launch })]);
  });
}

async function project(spaceId: string, repoUrl: string | null): Promise<void> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(`insert into public.projects(id, name, repo_url, working_dir) values ($1, 'S7b', $2, $3)`,
      [id, repoUrl, `/tmp/s7b-${id}`]);
    await c.query(`insert into public.space_projects(space_id, project_id) values ($1, $2)`, [spaceId, id]);
  });
}

interface GateRow {
  space_id: string;
  state: 'green' | 'red' | 'idle';
  used_providers: string[];
  missing: string[];
  agent_sessions: number;
  sessions_without_record: number;
  github_projects: number;
}

async function gate(window = '30 days'): Promise<Map<string, GateRow>> {
  const rows = await asOwner(async (c) =>
    (await c.query<GateRow>('select * from internal.credential_seeding_gate($1::interval)', [window])).rows);
  return new Map(rows.map((r) => [r.space_id, r]));
}

/** A space whose sessions launched claude with git: anthropic + github used, openai never. */
async function claudeSpace(): Promise<string> {
  const s = await space();
  await session(s, { anthropic: 'member', github: 'member' });
  await session(s, { anthropic: 'space', github: 'node' }, { daysAgo: 12 });
  return s;
}

describe('space_credential_readiness — seeding per used provider (R1/S7b)', () => {
  it('a claude-only space with an active anthropic + github credential is GREEN; openai, never used, does not block', async () => {
    const s = await claudeSpace();
    await credential(s, 'anthropic', { isDefault: true });
    await credential(s, 'github', { isDefault: true });
    const r = await readiness(A, s);
    expect(r.seeding).toMatchObject({
      state: 'green', readyForCut: true, usedProviders: ['anthropic', 'github'], missing: [],
      agentSessions: 2, sessionsWithoutRecord: 0, githubProjects: 0, window: '30 days',
    });
    expect(r.seeding.providers.openai).toBeUndefined();
    expect(r.seeding.providers.anthropic).toMatchObject({ ready: true, needs: ['launch'], reason: null });
    // Existing fields keep their meaning: canLaunch is still all three providers, per caller.
    expect(r.canLaunch).toMatchObject({ ready: false, missing: ['openai'] });
    expect((await gate()).get(s)).toMatchObject({ state: 'green', used_providers: ['anthropic', 'github'], missing: [] });
  });

  it('red names only the used providers that are missing; seeding the missing one turns it green', async () => {
    const s = await claudeSpace();
    await credential(s, 'anthropic', { isDefault: true });
    const red = (await readiness(B, s)).seeding;
    expect(red).toMatchObject({ state: 'red', readyForCut: false, missing: ['github'] });
    expect(red.providers.github).toMatchObject({ ready: false, launchReason: 'no_credential', reason: 'no_credential' });
    expect((await gate()).get(s)).toMatchObject({ state: 'red', missing: ['github'] });
    await credential(s, 'github', { isDefault: true });
    expect((await readiness(B, s)).seeding).toMatchObject({ state: 'green', missing: [] });
  });

  it('an IDLE space (no agent session in the window) is idle, not red, even with nothing seeded and a github project', async () => {
    const s = await space();
    await project(s, 'https://github.com/acme/app.git');
    await session(s, { anthropic: 'member' }, { daysAgo: 45 });
    await session(s, null, { kind: 'shell' });
    const r = (await readiness(A, s)).seeding;
    expect(r).toMatchObject({ state: 'idle', readyForCut: true, agentSessions: 0, githubProjects: 1 });
    expect((await gate()).get(s)).toMatchObject({ state: 'idle', agent_sessions: 0 });
    // The window is the operator's parameter: over 60 days the 45-day-old session counts.
    expect((await gate('60 days')).get(s)).toMatchObject({ state: 'red', used_providers: ['anthropic', 'github'] });
  });

  it('the verdict is the space\'s: a member\'s private my_default does not seed it (reason no_default)', async () => {
    const s = await claudeSpace();
    await credential(s, 'github', { isDefault: true });
    await credential(s, 'anthropic', { owner: A, visibility: 'private', myDefaultOf: A });
    const r = await readiness(A, s);
    expect(r.canLaunch.providers.anthropic.ready).toBe(true); // A can launch...
    expect(r.seeding.providers.anthropic).toMatchObject({ ready: false, reason: 'no_default' }); // ...B could not.
    expect(r.seeding.state).toBe('red');
  });

  it('stale and policy_excludes_space are red with their reason', async () => {
    const s = await claudeSpace();
    const id = await credential(s, 'anthropic', { isDefault: true, status: 'stale' });
    await credential(s, 'github', { isDefault: true });
    expect((await readiness(A, s)).seeding.providers.anthropic).toMatchObject({ ready: false, reason: 'stale' });
    await setStatus(id, 'active');
    expect((await readiness(A, s)).seeding.state).toBe('green');
    await asOwner((c) => c.query(
      `insert into public.space_credential_policies(space_id, provider, allowed_sources) values ($1, 'github', array['member'])`, [s]));
    expect((await readiness(A, s)).seeding.providers.github).toMatchObject({ ready: false, reason: 'policy_excludes_space' });
  });

  it('a github-repo project makes github used for POLLING: a member-owned github default is not enough', async () => {
    const s = await space();
    await session(s, { anthropic: 'space' });
    await project(s, 'git@github.com:acme/app.git');
    await project(s, 'https://gitlab.com/acme/other.git');
    await credential(s, 'anthropic', { isDefault: true });
    await credential(s, 'github', { owner: A, visibility: 'public', myDefaultOf: A });
    const red = (await readiness(A, s)).seeding;
    expect(red).toMatchObject({ state: 'red', usedProviders: ['anthropic', 'github'], missing: ['github'], githubProjects: 1 });
    expect(red.providers.github).toMatchObject({ needs: ['poll'], launchReason: null, pollReason: 'no_space_owned_credential' });
    await credential(s, 'github');
    expect((await readiness(A, s)).seeding).toMatchObject({ state: 'green', missing: [] });
  });

  it('ruling (A): a session with a manifest but NO map infers anthropic/openai from agent_tool; github never', async () => {
    const s = await space();
    await session(s, null, { agentTool: 'claude-code' });
    await session(s, {}, { agentTool: 'codex' });
    await session(s, null, { agentTool: 'gemini' });
    const r = (await readiness(A, s)).seeding;
    // Not a false green: the pre-map launches still name the providers they used.
    expect(r).toMatchObject({
      state: 'red', usedProviders: ['anthropic', 'openai'], missing: ['anthropic', 'openai'], agentSessions: 3, sessionsWithoutRecord: 3,
    });
    await credential(s, 'anthropic', { isDefault: true });
    await credential(s, 'openai', { isDefault: true });
    expect((await readiness(A, s)).seeding).toMatchObject({ state: 'green', missing: [] });
  });

  it('ruling (A): a map, when present, wins over agent_tool; a session with NO manifest infers nothing but is counted', async () => {
    const s = await space();
    await session(s, { anthropic: 'member' }, { agentTool: 'codex' });
    await session(s, null, { agentTool: 'codex', noManifest: true });
    await session(s, null, { agentTool: 'claude', noManifest: true });
    expect((await readiness(A, s)).seeding).toMatchObject({
      usedProviders: ['anthropic'], agentSessions: 3, sessionsWithoutRecord: 2,
    });
  });

  it('sessions with no effective map and no known tool are counted, not guessed at; a null source names no provider', async () => {
    const s = await space();
    await session(s, null);
    await session(s, { openai: null, anthropic: 'member' });
    await credential(s, 'anthropic', { isDefault: true });
    expect((await readiness(A, s)).seeding).toMatchObject({
      state: 'green', agentSessions: 2, sessionsWithoutRecord: 1, usedProviders: ['anthropic'],
    });
  });

  it('the node-wide gate lists EVERY space, agrees with readiness.seeding, and is not callable by the app role', async () => {
    const spaces = [await claudeSpace(), await space(), await greenSpace()];
    const rows = await gate();
    for (const s of spaces) {
      const seeding = (await readiness(A, s)).seeding;
      expect(rows.get(s), `gate row for ${s}`).toMatchObject({
        state: seeding.state, used_providers: seeding.usedProviders, missing: seeding.missing,
      });
    }
    const [spacesTotal] = await asOwner(async (c) => (await c.query<{ n: number }>('select count(*)::int as n from public.spaces')).rows);
    expect(rows.size).toBe(spacesTotal!.n);
    // The operator's standalone report (db/reports/credential_seeding_gate.sql) is the same verdict as a
    // plain query, for a node that has not applied the migration yet: held equal here, space by space.
    const text = readFileSync(join(REPO_ROOT, 'db', 'reports', 'credential_seeding_gate.sql'), 'utf8');
    const query = text.slice(text.indexOf('begin read only;') + 'begin read only;'.length, text.lastIndexOf('rollback;'))
      .replace('(:window)::interval', '($1)::interval').trim().replace(/;$/, '');
    for (const window of ['30 days', '60 days']) {
      const report = await asOwner(async (c) => (await c.query<GateRow>(query, [window])).rows);
      expect(report).toEqual([...(await gate(window)).values()]);
    }
    const denied = await database.transaction(async (c) => {
      await c.query('set local role tm8_app');
      return c.query('select * from internal.credential_seeding_gate()').then(() => 'ok', (e: { code?: string }) => e.code);
    });
    expect(denied).toBe('42501');
  });
});
