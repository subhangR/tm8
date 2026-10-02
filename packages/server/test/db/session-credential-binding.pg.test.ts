/**
 * R2 gates 1 and 2 (spec doc 01a0e248 §9) against a REAL PostgreSQL with the
 * session_credential_binding migration applied.
 *
 *   gate 1  every session records its binding: the mint by kind, `pending`
 *           cannot run, resume resets, the pessimistic roll-up (spawn AND
 *           resume writers), the runs_on pairing with session_space_credentials.
 *   gate 2  the sweep reaps `pending` past its grace and reports the rest.
 *   backfill the fenced one-time step, on a SECOND database migrated up to the
 *           migration before session_credential_binding, seeded, then migrated.
 *
 * Each file gets its own databases (createW1ScratchDatabase), so the
 * ACCESS EXCLUSIVE `alter table` in the unknown-kind cell locks nothing any
 * other file uses, and that cell rolls its transaction back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, MIGRATIONS_DIR, migrationFiles, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'scb-owner';
const A = 'scb-a';
const OUT = 'scb-out';

const MIGRATION = /^\d{3}_session_credential_binding\.sql$/;

/** Verbatim, on every activity cell that UPDATEs an edge's type or props. */
const UNREACHABLE =
  'unreachable through the product today; pinned because this function is shared by every edge type ' +
  '(a future type may be retypeable) and a coalesce(new.type, old.type) simplification fails the ' +
  'other->runs_on cell.';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');
const nodeAdmin = (): DbClaims => ({ ...claims(OWN), nodeAdmin: true }) as DbClaims;

async function asOwner<T>(fn: (client: Client) => Promise<T>, on = database): Promise<T> {
  return on.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** Run `fn` as the table owner in a transaction that is ALWAYS rolled back. */
async function rolledBack(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role tm8_graph_owner');
    await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** The error `fn` raises inside a savepoint, which is then rolled back. */
async function failure(client: Client, fn: () => Promise<unknown>): Promise<{ code?: string; message: string; detail?: string }> {
  await client.query('savepoint probe');
  try {
    await fn();
  } catch (error) {
    await client.query('rollback to savepoint probe');
    return error as { code?: string; message: string; detail?: string };
  }
  await client.query('release savepoint probe');
  throw new Error('expected a failure, and the statement succeeded');
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

type Kind = 'agent' | 'shell' | 'credential' | 'container_exec';

async function insertSession(c: Client, space: string, createdBy: string, kind: string, status = 'spawning'): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`,
    [id, space, createdBy]);
  if (kind === 'container_exec') {
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind, workdir_mode, workdir_path)
                   values ($1, 'fixture', $2, $3, 'container', '/workspace')`, [id, status, kind]);
  } else {
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind, workdir_mode) values ($1, 'fixture', $2, $3, 'scratch')`,
      [id, status, kind]);
  }
  return id;
}

/** A work session in space S created by A's member entity. */
async function session(opts: { status?: string; kind?: Kind } = {}): Promise<string> {
  return asOwner((c) => insertSession(c, ids.S!, ids['member:A']!, opts.kind ?? 'agent', opts.status));
}

async function setStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

async function binding(sessionId: string): Promise<{ credential_binding: string; credential_none_reason: string | null; status: string }> {
  const [row] = await database.query<{ credential_binding: string; credential_none_reason: string | null; status: string }>(
    'select credential_binding, credential_none_reason, status from public.work_sessions where entity_id = $1', [sessionId]);
  return row!;
}

async function runsOn(sessionId: string): Promise<Array<{ dst_id: string; provider: string }>> {
  return database.query(
    `select dst_id::text, props->>'provider' provider from public.edges
      where src_id = $1 and type = 'runs_on' order by props->>'provider'`, [sessionId]);
}

function launch(
  effective: Record<string, string>,
  spaceIds: Record<string, string> = {},
  tool = 'claude-code',
): Record<string, unknown> {
  const credentialSources = { ...effective };
  return { tool, credentialSources, spaceCredentialIds: spaceIds, effectiveCredentialSources: effective };
}

async function recordManifest(sessionId: string, l: Record<string, unknown>, who = agent(A)): Promise<{ credentialBinding: string }> {
  return db.rpc(who, 'record_session_manifest', [sessionId, JSON.stringify({ launch: l })]);
}

async function recordBinding(sessionId: string, l: Record<string, unknown>, who = agent(A)): Promise<{ credentialBinding: string }> {
  return db.rpc(who, 'record_session_credential_binding', [sessionId, JSON.stringify(l)]);
}

async function credential(provider: 'anthropic' | 'openai' | 'github'): Promise<string> {
  const created = await store.create(claims(A), {
    spaceId: ids.S!, provider, shape: provider === 'github' ? 'token' : 'api_key',
    label: `${provider} ${randomUUID()}`, secret: `${provider === 'github' ? 'ghp' : 'sk'}-${randomUUID().replaceAll('-', '')}`,
  });
  return created.id;
}

async function seedCast(on: W1ScratchDatabase, into: Record<string, string>): Promise<void> {
  await asOwner(async (c) => {
    for (const identity of [OWN, A, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      await c.query(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, $2, $2)`, [identity, identity === OWN]);
    }
    into.S = await newId(c);
    into.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $4)`,
      [into.S, into.T, OWN, OUT]);
    for (const [key, space, identity, role] of [
      ['member:OWN', into.S, OWN, 'owner'], ['member:A', into.S, A, 'member'], ['member:OUT', into.T, OUT, 'owner'],
    ] as const) {
      const member = into[key] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`,
        [member, space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role]);
    }
  }, on);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-scb-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('session_credential_binding');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await seedCast(database, ids);
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('gate 1 — the mint records a binding by session kind', () => {
  it('agent -> pending; shell, credential, container_exec -> none with their reasons', async () => {
    expect(await binding(await session())).toMatchObject({ credential_binding: 'pending', credential_none_reason: null });
    expect(await binding(await session({ kind: 'shell' }))).toMatchObject({ credential_binding: 'none', credential_none_reason: 'shell' });
    expect(await binding(await session({ kind: 'credential' })))
      .toMatchObject({ credential_binding: 'none', credential_none_reason: 'credential_login' });
    expect(await binding(await session({ kind: 'container_exec' })))
      .toMatchObject({ credential_binding: 'none', credential_none_reason: 'container_exec' });
  });

  it('a mint cannot choose its own binding', async () => {
    await rolledBack(async (c) => {
      const id = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`,
        [id, ids.S, ids['member:A']]);
      const agentBound = await failure(c, () => c.query(
        `insert into public.work_sessions(entity_id, title, session_kind, credential_binding, workdir_mode) values ($1, 'x', 'agent', 'bound', 'scratch')`, [id]));
      expect(agentBound.code).toBe('23514');
      const shellPending = await failure(c, () => c.query(
        `insert into public.work_sessions(entity_id, title, session_kind, credential_binding, workdir_mode) values ($1, 'x', 'shell', 'pending', 'scratch')`, [id]));
      expect(shellPending.code).toBe('23514');
    });
  });

  it('the three none-kinds can never be pending (work_sessions_credential_pending_kind_check)', async () => {
    const shell = await session({ kind: 'shell' });
    await rolledBack(async (c) => {
      await c.query(`select set_config('tm8.credential_binding_write', 'on', true)`);
      const e = await failure(c, () => c.query(
        `update public.work_sessions set credential_binding = 'pending', credential_none_reason = null where entity_id = $1`, [shell]));
      expect(e.code).toBe('23514');
      expect(e.message).toMatch(/work_sessions_credential_pending_kind_check/);
    });
  });

  it('an UNMAPPED kind falls through to pending, and its move to running is refused naming the kind and the mint trigger', async () => {
    await rolledBack(async (c) => {
      // The session_kind CHECK (177) admits only the four real kinds; widen it
      // INSIDE this rolled-back transaction to stand in for a future kind
      // that lands without an arm in the mint. ACCESS EXCLUSIVE, on this
      // file's own database.
      await c.query('alter table public.work_sessions drop constraint work_sessions_session_kind_check');
      await c.query(`alter table public.work_sessions add constraint work_sessions_session_kind_check
                       check (session_kind in ('agent', 'credential', 'shell', 'container_exec', 'robot_arm'))`);
      const id = await insertSession(c, ids.S!, ids['member:A']!, 'robot_arm');
      const { rows: [row] } = await c.query<{ credential_binding: string; credential_none_reason: string | null }>(
        'select credential_binding, credential_none_reason from public.work_sessions where entity_id = $1', [id]);
      expect(row).toEqual({ credential_binding: 'pending', credential_none_reason: null });

      await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
      for (const status of ['running', 'idle']) {
        const e = await failure(c, () => c.query('update public.work_sessions set status = $2 where entity_id = $1', [id, status]));
        expect(e.code).toBe('23514');
        expect(e.message).toContain('robot_arm');
        expect(e.message).toContain('work_sessions_credential_binding_at_mint');
        expect(JSON.parse(e.detail ?? '{}')).toMatchObject({ reason: 'session_kind_unmapped', sessionKind: 'robot_arm' });
      }
    });
  });
});

describe('gate 1 — pending cannot run, and the binding has one writer', () => {
  it('spawning -> running|idle is refused while pending, with the pending-specific reason', async () => {
    const s = await session();
    for (const status of ['running', 'idle']) {
      const e = await setStatus(s, status).then(() => null, (error: { code?: string; message: string; detail?: string }) => error);
      expect(e?.code).toBe('23514');
      expect(e?.message).toMatch(/cannot run before it records the credential/);
      expect(JSON.parse(e?.detail ?? '{}')).toEqual({ reason: 'credential_binding_pending' });
    }
    // Control: the same session runs once its binding is recorded.
    await recordManifest(s, launch({ anthropic: 'node', github: 'node' }));
    await setStatus(s, 'running');
    expect(await binding(s)).toMatchObject({ status: 'running', credential_binding: 'legacy' });
  });

  it('a direct write of the binding is refused without its writer, and nothing ever writes unrecorded', async () => {
    const s = await session();
    await rolledBack(async (c) => {
      const direct = await failure(c, () => c.query(
        `update public.work_sessions set credential_binding = 'legacy' where entity_id = $1`, [s]));
      expect(direct.code).toBe('42501');
      await c.query(`select set_config('tm8.credential_binding_write', 'on', true)`);
      const unrecorded = await failure(c, () => c.query(
        `update public.work_sessions set credential_binding = 'unrecorded' where entity_id = $1`, [s]));
      expect(unrecorded.code).toBe('23514');
    });
  });

  it('the narrowing: an agent INSERTED running stays pending, and the sweep reports it', async () => {
    const s = await session({ status: 'running' });
    expect(await binding(s)).toMatchObject({ status: 'running', credential_binding: 'pending' });
    const swept = await db.rpc<{ reaped: string[]; violations: Array<Record<string, unknown>> }>(
      nodeAdmin(), 'credential_binding_sweep', ['1 hour', 1000]);
    expect(swept.reaped).not.toContain(s);
    expect(swept.violations).toContainEqual(
      { workSessionId: s, status: 'running', credentialBinding: 'pending', problem: 'pending' });
  });
});

describe('gate 1 — the roll-up, by both writers', () => {
  it('spawn: mixed space + node is legacy, and the space row still projects its runs_on edge', async () => {
    const ant = await credential('anthropic');
    const s = await session();
    const r = await recordManifest(s, launch({ anthropic: 'space', github: 'node' }, { anthropic: ant }));
    expect(r.credentialBinding).toBe('legacy');
    expect(await runsOn(s)).toEqual([{ dst_id: ant, provider: 'anthropic' }]);
  });

  it('spawn: member on any provider is legacy', async () => {
    const s = await session();
    expect((await recordManifest(s, launch({ anthropic: 'member', github: 'node' }))).credentialBinding).toBe('legacy');
  });

  it('spawn: every provider on space, each with its row, is bound (multi-provider)', async () => {
    const [ant, gh] = [await credential('anthropic'), await credential('github')];
    const s = await session();
    const r = await recordManifest(s, launch({ anthropic: 'space', github: 'space' }, { anthropic: ant, github: gh }));
    expect(r.credentialBinding).toBe('bound');
    expect(await runsOn(s)).toEqual([{ dst_id: ant, provider: 'anthropic' }, { dst_id: gh, provider: 'github' }]);
    await setStatus(s, 'running');
  });

  it('codex: openai + github on space is bound (openai is a roll-up key like any other)', async () => {
    const [oai, gh] = [await credential('openai'), await credential('github')];
    const s = await session();
    const r = await recordManifest(s, launch({ openai: 'space', github: 'space' }, { openai: oai, github: gh }, 'codex'));
    expect(r.credentialBinding).toBe('bound');
  });

  it('resume: re-entering spawning resets to pending; the resume writer records bound (multi-provider), then it runs', async () => {
    const [ant, gh] = [await credential('anthropic'), await credential('github')];
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'space' }, { anthropic: ant, github: gh }));
    await setStatus(s, 'running');
    await setStatus(s, 'idle');
    await setStatus(s, 'spawning');
    expect(await binding(s)).toMatchObject({ status: 'spawning', credential_binding: 'pending' });
    await expect(setStatus(s, 'running')).rejects.toMatchObject({ code: '23514' });

    const r = await recordBinding(s, launch({ anthropic: 'space', github: 'space' }, { anthropic: ant, github: gh }));
    expect(r.credentialBinding).toBe('bound');
    await setStatus(s, 'running');
    expect(await binding(s)).toMatchObject({ status: 'running', credential_binding: 'bound' });
  });

  it('resume: a resume on the node rung records legacy, even for a session that ran bound', async () => {
    const [ant, gh] = [await credential('anthropic'), await credential('github')];
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'space' }, { anthropic: ant, github: gh }));
    await setStatus(s, 'running');
    await setStatus(s, 'spawning');
    const r = await recordBinding(s, launch({ anthropic: 'space', github: 'node' }, { anthropic: ant }));
    expect(r.credentialBinding).toBe('legacy');
  });

  it('refusals: an empty map (any tool but echo-agent), a space source without its row, an unknown source', async () => {
    const s = await session();
    await expect(recordBinding(s, launch({}))).rejects.toMatchObject({ code: 'invalid_input', details: { sqlstate: '22023' } });
    await expect(recordBinding(s, launch({ anthropic: 'space' }, { anthropic: randomUUID() }))).rejects.toMatchObject({ code: 'invalid_input', details: { sqlstate: '22023' } });
    await expect(recordBinding(s, launch({ anthropic: 'vault' }))).rejects.toMatchObject({ code: 'invalid_input', details: { sqlstate: '22023' } });
    expect(await binding(s)).toMatchObject({ credential_binding: 'pending' });

    const echo = await session();
    expect((await recordBinding(echo, launch({}, {}, 'echo-agent'))).credentialBinding).toBe('legacy');
    await setStatus(echo, 'running');
    await expect(recordBinding(echo, launch({ anthropic: 'node' }))).rejects.toMatchObject({ code: 'invariant_violation', details: { sqlstate: '23514' } });
    await expect(recordBinding(s, launch({ anthropic: 'node' }), claims(OUT))).rejects.toMatchObject({ code: 'forbidden', details: { sqlstate: '42501' } });
  });

  it('echo-agent is legacy in R1, never none: an empty map records what the resolver chose, not what the process can reach', async () => {
    // S4 flips this to none/'echo-agent' together with the no-reach isolation helper.
    const bySpawn = await session();
    expect((await recordManifest(bySpawn, launch({}, {}, 'echo-agent'))).credentialBinding).toBe('legacy');
    const byResume = await session();
    expect((await recordBinding(byResume, launch({}, {}, 'echo-agent'))).credentialBinding).toBe('legacy');
    for (const s of [bySpawn, byResume]) {
      const row = await binding(s);
      expect(row).toMatchObject({ credential_binding: 'legacy', credential_none_reason: null });
      expect(row.credential_binding).not.toBe('none');
    }
    // github on space: the normal roll-up.
    const gh = await credential('github');
    const onSpace = await session();
    expect((await recordManifest(onSpace, launch({ github: 'space' }, { github: gh }, 'echo-agent'))).credentialBinding).toBe('bound');
    const onNode = await session();
    expect((await recordManifest(onNode, launch({ github: 'node' }, {}, 'echo-agent'))).credentialBinding).toBe('legacy');
  });

  it('a recorder outside spawning, and a non-member, are refused', async () => {
    const s = await session();
    const echo = await session();
    await recordBinding(echo, launch({ github: 'node' }, {}, 'echo-agent'));
    await setStatus(echo, 'running');
    await expect(recordBinding(echo, launch({ anthropic: 'node' }))).rejects.toMatchObject({ code: 'invariant_violation', details: { sqlstate: '23514' } });
    await expect(recordBinding(s, launch({ anthropic: 'node' }), claims(OUT))).rejects.toMatchObject({ code: 'forbidden', details: { sqlstate: '42501' } });
  });

  it('a non-agent session keeps its mint binding through the recorder', async () => {
    const shell = await session({ kind: 'shell' });
    expect((await recordBinding(shell, launch({ anthropic: 'node' }))).credentialBinding).toBe('none');
    expect(await binding(shell)).toMatchObject({ credential_binding: 'none', credential_none_reason: 'shell' });
  });
});

describe('gate 1 — runs_on is the projection of session_space_credentials, and nothing else', () => {
  it('an owner insert straight into the table (no definer) projects the edge; a delete removes it', async () => {
    const ant = await credential('anthropic');
    const s = await session();
    await asOwner((c) => c.query(
      `insert into public.session_space_credentials(work_session_id, provider, space_credential_id, space_id) values ($1, 'anthropic', $2, $3)`,
      [s, ant, ids.S]));
    expect(await runsOn(s)).toEqual([{ dst_id: ant, provider: 'anthropic' }]);
    await asOwner((c) => c.query('delete from public.session_space_credentials where work_session_id = $1', [s]));
    expect(await runsOn(s)).toEqual([]);
  });

  it('a re-point of the credential moves the edge', async () => {
    const [a1, a2] = [await credential('anthropic'), await credential('anthropic')];
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'node' }, { anthropic: a1 }));
    await asOwner((c) => c.query(
      `update public.session_space_credentials set space_credential_id = $2 where work_session_id = $1`, [s, a2]));
    expect(await runsOn(s)).toEqual([{ dst_id: a2, provider: 'anthropic' }]);
  });

  it('no runs_on write outside the projection: insert, update and delete are refused without the GUC', async () => {
    const ant = await credential('anthropic');
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'node' }, { anthropic: ant }));
    await rolledBack(async (c) => {
      const other = await credential('anthropic');
      const insert = await failure(c, () => c.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'runs_on', $2)`, [ids.S, s, other]));
      expect(insert).toMatchObject({ code: '42501', detail: 'runs_on_edge_owned' });
      const update = await failure(c, () => c.query(
        `update public.edges set props = '{"provider":"github"}' where src_id = $1 and type = 'runs_on'`, [s]));
      expect(update.code).toBe('42501');
      const del = await failure(c, () => c.query(`delete from public.edges where src_id = $1 and type = 'runs_on'`, [s]));
      expect(del.code).toBe('42501');
    });
  });

  it('the projection restores the GUC: a later statement in the same transaction cannot write runs_on', async () => {
    const [a1, a2] = [await credential('anthropic'), await credential('anthropic')];
    const s = await session();
    await rolledBack(async (c) => {
      await c.query(
        `insert into public.session_space_credentials(work_session_id, provider, space_credential_id, space_id) values ($1, 'anthropic', $2, $3)`,
        [s, a1, ids.S]);
      const { rows: [guc] } = await c.query<{ v: string | null }>(`select current_setting('tm8.runs_on_write', true) v`);
      expect(guc?.v ?? '').toBe('');
      const e = await failure(c, () => c.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'runs_on', $2)`, [ids.S, s, a2]));
      expect(e.code).toBe('42501');
      // And a caller that had it on keeps it on.
      await c.query(`select set_config('tm8.runs_on_write', 'on', true)`);
      await c.query(`update public.session_space_credentials set space_credential_id = $2 where work_session_id = $1`, [s, a2]);
      const { rows: [after] } = await c.query<{ v: string }>(`select current_setting('tm8.runs_on_write', true) v`);
      expect(after!.v).toBe('on');
    });
  });

  it('the pairing is checked at commit: an edge without its row, and a row without its edge, cannot commit', async () => {
    const [a1, a2] = [await credential('anthropic'), await credential('anthropic')];
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'node' }, { anthropic: a1 }));
    await expect(asOwner(async (c) => {
      await c.query(`select set_config('tm8.runs_on_write', 'on', true)`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'runs_on', $2)`,
        [ids.S, s, a2]);
    })).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/has no session_space_credentials row/) });
    await expect(asOwner(async (c) => {
      await c.query(`select set_config('tm8.runs_on_write', 'on', true)`);
      await c.query(`delete from public.edges where src_id = $1 and dst_id = $2 and type = 'runs_on'`, [s, a1]);
    })).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/without its runs_on edge/) });
    expect(await runsOn(s)).toEqual([{ dst_id: a1, provider: 'anthropic' }]);
  });
});

describe('gate 1 — runs_on moves no activity_at (internal.touch_edge_activity)', () => {
  const OLD = '2000-01-01T00:00:00Z';

  /** In a rolled-back transaction: age both ends, run `op`, and report whether each end moved. */
  async function moved(op: (c: Client, s: string, cred: string) => Promise<void>, seedRunsOn: boolean): Promise<[boolean, boolean]> {
    const cred = await credential('anthropic');
    const s = await session();
    let result: [boolean, boolean] = [false, false];
    await rolledBack(async (c) => {
      if (seedRunsOn) {
        await c.query(
          `insert into public.session_space_credentials(work_session_id, provider, space_credential_id, space_id) values ($1, 'anthropic', $2, $3)`,
          [s, cred, ids.S]);
      }
      await c.query('update public.entities set activity_at = $2 where id = any($1::uuid[])', [[s, cred], OLD]);
      await c.query(`select set_config('tm8.runs_on_write', 'on', true)`);
      await op(c, s, cred);
      const { rows } = await c.query<{ id: string; moved: boolean }>(
        `select id::text, activity_at > $2::timestamptz moved from public.entities where id = any($1::uuid[])`, [[s, cred], OLD]);
      const by = Object.fromEntries(rows.map((r) => [r.id, r.moved]));
      result = [by[s]!, by[cred]!];
    });
    return result;
  }

  it('control: a relates_to insert moves both ends', async () => {
    expect(await moved(async (c, s, cred) => {
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'relates_to', $2)`,
        [ids.S, s, cred]);
    }, false)).toEqual([true, true]);
  });

  it('INSERT runs_on moves neither end', async () => {
    expect(await moved(async (c, s, cred) => {
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'runs_on', $2)`,
        [ids.S, s, cred]);
    }, false)).toEqual([false, false]);
  });

  it('DELETE runs_on moves neither end', async () => {
    expect(await moved(async (c, s) => {
      await c.query(`delete from public.edges where src_id = $1 and type = 'runs_on'`, [s]);
    }, true)).toEqual([false, false]);
  });

  it(`UPDATE runs_on -> runs_on moves neither end — ${UNREACHABLE}`, async () => {
    expect(await moved(async (c, s) => {
      await c.query(`update public.edges set props = '{"provider":"anthropic"}' where src_id = $1 and type = 'runs_on'`, [s]);
    }, true)).toEqual([false, false]);
  });

  it(`UPDATE other -> runs_on (a retype) moves both ends — ${UNREACHABLE}`, async () => {
    expect(await moved(async (c, s, cred) => {
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'relates_to', $2)`,
        [ids.S, s, cred]);
      await c.query('update public.entities set activity_at = $2 where id = any($1::uuid[])', [[s, cred], OLD]);
      await c.query(`update public.edges set type = 'runs_on', props = '{"provider":"anthropic"}'
                      where src_id = $1 and dst_id = $2 and type = 'relates_to'`, [s, cred]);
    }, false)).toEqual([true, true]);
  });

  it(`UPDATE runs_on -> other (a retype) moves both ends — ${UNREACHABLE}`, async () => {
    expect(await moved(async (c, s) => {
      await c.query(`update public.edges set type = 'relates_to', props = '{}' where src_id = $1 and type = 'runs_on'`, [s]);
    }, true)).toEqual([true, true]);
  });
});

describe('gate 2 — the sweep', () => {
  it('reaps an agent pending past its grace as failed, and leaves one inside its grace', async () => {
    const stale = await session();
    const fresh = await session();
    await asOwner(async (c) => {
      await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
      await c.query(`update public.work_sessions set status_changed_at = now() - interval '2 hours' where entity_id = $1`, [stale]);
    });
    const swept = await db.rpc<{ reaped: string[] }>(nodeAdmin(), 'credential_binding_sweep', ['1 hour', 1000]);
    expect(swept.reaped).toContain(stale);
    expect(swept.reaped).not.toContain(fresh);
    const [row] = await database.query<{ status: string; ended_kind: string; credential_binding: string }>(
      'select status, ended_kind, credential_binding from public.work_sessions where entity_id = $1', [stale]);
    expect(row).toEqual({ status: 'failed', ended_kind: 'unknown', credential_binding: 'pending' });
    expect((await binding(fresh)).status).toBe('spawning');
  });

  it('reports bound-without-row and row-without-edge, and kills neither', async () => {
    const [ant, gh] = [await credential('anthropic'), await credential('github')];
    const s = await session();
    await recordManifest(s, launch({ anthropic: 'space', github: 'space' }, { anthropic: ant, github: gh }));
    await setStatus(s, 'running');
    // Break it the only way the table owner can: remove a row AND its edge in one commit.
    await asOwner(async (c) => {
      await c.query(`delete from public.session_space_credentials where work_session_id = $1 and provider = 'github'`, [s]);
    });
    const swept = await db.rpc<{ reaped: string[]; violations: Array<Record<string, unknown>> }>(
      nodeAdmin(), 'credential_binding_sweep', ['1 hour', 1000]);
    expect(swept.violations).toContainEqual(expect.objectContaining({ workSessionId: s, problem: 'bound_without_row', provider: 'github' }));
    expect((await binding(s)).status).toBe('running');
  });

  it('is node admin only', async () => {
    await expect(db.rpc(claims(OWN), 'credential_binding_sweep', ['1 hour', 10])).rejects.toMatchObject({ code: 'forbidden', details: { sqlstate: '42501' } });
  });
});

describe('the fenced backfill (one-time data step)', () => {
  let before: W1ScratchDatabase | undefined;
  afterAll(async () => { await before?.destroy(); });

  it('member/node manifests become legacy; empty, missing, all-space and unknown maps stay unrecorded; existing rows get edges', async () => {
    const files = migrationFiles();
    const at = files.findIndex((f) => MIGRATION.test(f));
    expect(at).toBeGreaterThan(0);
    before = await createW1ScratchDatabase('scb_backfill');
    before.apply(files.slice(0, at));
    const seeded: Record<string, string> = {};
    await seedCast(before, seeded);
    const backfillDb = createDb(before.url);
    const backfillStore = new DbSpaceCredentialStore({ db: backfillDb, dataDir });
    try {
      const cred = (await backfillStore.create(claims(A), {
        spaceId: seeded.S!, provider: 'anthropic', shape: 'api_key', label: 'pre', secret: `sk-${randomUUID().replaceAll('-', '')}`,
      })).id;
      const manifests: Record<string, unknown> = {
        spaceAndNode: { launch: { effectiveCredentialSources: { anthropic: 'space', github: 'node' } } },
        member: { launch: { effectiveCredentialSources: { anthropic: 'member', github: 'member' } } },
        emptyMap: { launch: { effectiveCredentialSources: {} } },
        noMap: { launch: { credentialSources: { anthropic: 'node' } } },
        allSpace: { launch: { effectiveCredentialSources: { anthropic: 'space', github: 'space' } } },
        unknownSource: { launch: { effectiveCredentialSources: { anthropic: 'vault' } } },
        notAnObject: { launch: { effectiveCredentialSources: ['node'] } },
      };
      const sessions: Record<string, string> = {};
      await asOwner(async (c) => {
        for (const [name, m] of Object.entries(manifests)) {
          sessions[name] = await insertSession(c, seeded.S!, seeded['member:A']!, 'agent', 'exited');
          await c.query('insert into public.session_manifests(work_session_id, manifest) values ($1, $2)', [sessions[name], JSON.stringify(m)]);
        }
        sessions.noManifest = await insertSession(c, seeded.S!, seeded['member:A']!, 'agent', 'running');
        sessions.shell = await insertSession(c, seeded.S!, seeded['member:A']!, 'shell', 'running');
        await c.query(
          `insert into public.session_space_credentials(work_session_id, provider, space_credential_id, space_id) values ($1, 'anthropic', $2, $3)`,
          [sessions.allSpace, cred, seeded.S]);
      }, before);

      before.apply([files[at]!]);

      const rows = await before.query<{ id: string; credential_binding: string }>(
        'select entity_id::text id, credential_binding from public.work_sessions where entity_id = any($1::uuid[])', [Object.values(sessions)]);
      const got = Object.fromEntries(Object.entries(sessions).map(([n, id]) => [n, rows.find((r) => r.id === id)!.credential_binding]));
      expect(got).toEqual({
        spaceAndNode: 'legacy', member: 'legacy',
        emptyMap: 'unrecorded', noMap: 'unrecorded', allSpace: 'unrecorded', unknownSource: 'unrecorded', notAnObject: 'unrecorded',
        // `legacy` is never a fallback: no manifest, no record, whatever kind.
        noManifest: 'unrecorded', shell: 'unrecorded',
      });
      const edges = await before.query<{ dst_id: string }>(
        `select dst_id::text from public.edges where src_id = $1 and type = 'runs_on'`, [sessions.allSpace]);
      expect(edges).toEqual([{ dst_id: cred }]);
      const [def] = await before.query<{ d: string | null }>(
        `select column_default d from information_schema.columns where table_schema = 'public' and table_name = 'work_sessions' and column_name = 'credential_binding'`);
      expect(def!.d).toBeNull();
    } finally {
      await backfillDb.end();
    }
  });

  it("the backfill predicate is the dry-run report's, byte for byte", () => {
    const migration = readdirSync(MIGRATIONS_DIR).find((f) => MIGRATION.test(f));
    const reportsDir = join(REPO_ROOT, 'db', 'reports');
    const report = readdirSync(reportsDir).find((f) => /_backfill_dry_run\.sql$/.test(f)
      && readFileSync(join(reportsDir, f), 'utf8').includes('BEGIN SESSION_CREDENTIAL_BINDING BACKFILL PREDICATE'));
    expect(migration).toBeDefined();
    expect(report).toBeDefined();
    const between = (text: string): string => {
      const m = /-- BEGIN SESSION_CREDENTIAL_BINDING BACKFILL PREDICATE\n([\s\S]*?)-- END SESSION_CREDENTIAL_BINDING BACKFILL PREDICATE/.exec(text);
      expect(m).not.toBeNull();
      return m![1]!;
    };
    const a = between(readFileSync(join(MIGRATIONS_DIR, migration!), 'utf8'));
    const b = between(readFileSync(join(reportsDir, report!), 'utf8'));
    expect(a.length).toBeGreaterThan(200);
    expect(b).toBe(a);
  });
});
