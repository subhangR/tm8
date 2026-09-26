/**
 * W10a — space credentials as entities, against a REAL PostgreSQL with every
 * migration applied, running as `tm8_app` under each caller's claims. The
 * service is the real `SpaceCredentialCatalogService` over the real
 * `DbSpaceCredentialStore`; only the vendor probe and the PTY host are fakes.
 *
 * Names carry the matrix cell (T34-T44) and the brief's N-test they evidence.
 * Every refusal is paired with a positive on the same credential, so no row
 * can pass merely because everything is refused.
 *
 * Owned and private rows: W10a keeps new rows space-owned and public (W10b's
 * create takes a visibility). A fixture therefore sets `owner_account_id` as
 * tm8_graph_owner — the state W10b's create will produce — and every switch
 * after that goes through the real `set_space_credential_visibility`.
 *
 * Cast: spaces S and T. OWN owns S, A and B are members of S, ADM is an
 * admin of S, OUT is a member of T only. TB is a teammate owned by B.
 * Every secret, login and hint here is an obviously fake canary.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import type { SpaceCredentialProbe } from '../../src/credentials/space-credential-probe.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { ENTITY_COLUMNS, ENTITY_FROM, contentOf, loadEntitySummariesByIds, type EntityRow } from '../../src/facade/entity-read.js';
import { MIGRATIONS_DIR, createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'w10a-owner';
const ADM = 'w10a-admin';
const A = 'w10a-a';
const B = 'w10a-b';
const OUT = 'w10a-outsider';

/** Every leak assertion greps for strings built from THIS stem. */
const CANARY = 'W10aFakeCanary5c2e';
/** The fake vendor login a probe reports — must never reach an entity. */
const LOGIN_CANARY = `octo-${CANARY}-login`;

const MIGRATION = migrationFiles().find((f) => /_credential_entities\.sql$/.test(f));

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let service: SpaceCredentialCatalogService;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
const logged: unknown[] = [];
const contained: Array<{ id: string; cause: string }> = [];
let probeVerdict: Awaited<ReturnType<SpaceCredentialProbe>> = { ok: true, displayLogin: LOGIN_CANARY };

const claims = (identityId: string, authKind = 'browser', nodeAdmin = false): DbClaims =>
  ({ identityId, nodeAdmin, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

let seq = 0;
const label = (stem: string): string => `${stem} ${String(++seq)}`;
/** Ends in a distinctive four-char tail, so the stored hint is greppable too. */
const secretFor = (stem: string): string =>
  `sk-${CANARY}-${stem}-${randomUUID().replaceAll('-', '')}Qz${String(seq % 10)}x`;

/** The SQLSTATE and reason a refused call raised, or `'ok'`. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; details?: { sqlstate?: string; reason?: string }; cause?: { code?: string } };
    const code = e.details?.sqlstate ?? e.cause?.code ?? e.code;
    return e.details?.reason ? `${String(code)}:${e.details.reason}` : String(code);
  }
}

/** The entity as the product read model hands it to `who`: content and summary. */
async function readAs(who: DbClaims, id: string) {
  return db.tx(who, async (q) => {
    const [row] = await q.query<EntityRow>(`select ${ENTITY_COLUMNS} ${ENTITY_FROM} where e.id = $1`, [id]);
    const summaries = await loadEntitySummariesByIds(q, [id], who.identityId!);
    return { content: row ? contentOf(row) : null, summaries };
  });
}

async function session(createdBy: string, status = 'spawning'): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, createdBy]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, session_kind, agent_tool) values ($1, 'fixture', $2, 'agent', 'claude-code')`,
      [id, status],
    );
    return id;
  });
}

async function setStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

function record(who: DbClaims, sessionId: string, credentialId: string, provider = 'anthropic'): Promise<unknown> {
  return db.rpc(who, 'record_session_manifest', [
    sessionId,
    JSON.stringify({ launch: { credentialSources: { [provider]: 'space' }, spaceCredentialIds: { [provider]: credentialId } } }),
  ]);
}

/** A space-owned public credential `who` created through the real door. */
async function create(who: string, secret = secretFor(who)) {
  const view = await service.create(claims(who), ids.S!, {
    provider: 'anthropic', shape: 'api_key', label: label(`${who} key`), secret,
  });
  return { id: view.id, secret };
}

/** A credential `owner` OWNS — the state W10b's create produces — then `visibility`. */
async function owned(owner: string, visibility: 'public' | 'private' = 'public') {
  const made = await create(owner);
  await asOwner((c) => c.query(
    'update public.space_credentials set owner_account_id = $2, is_default = false where id = $1', [made.id, accounts[owner]]));
  if (visibility === 'private') await store.setVisibility(claims(owner), made.id, 'private');
  return made;
}

beforeAll(async () => {
  expect(MIGRATION, 'the W10a migration is in the migration list').toBeDefined();
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-w10a-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('credential_entities');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({
    db,
    dataDir,
    logger: { warn: (message, fields) => { logged.push({ level: 'warn', message, fields }); } },
  });
  service = new SpaceCredentialCatalogService({
    db,
    store,
    probe: async () => probeVerdict,
    terminals: { terminate: () => 'killed', hasLiveTerminal: () => false },
    agentSessions: {
      containCredentialSession: async (id, cause) => {
        contained.push({ id, cause });
        return { outcome: 'killed', recorded: true };
      },
    },
    removeLoginHome: async () => undefined,
    env: {},
  });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, $2, $3) returning id::text`,
        [identity, identity === OWN, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2), ($3, 'T', $4)`, [ids.S, OWN, ids.T, OUT]);
    for (const [space, identity, role] of [
      ['S', OWN, 'owner'], ['S', ADM, 'admin'], ['S', A, 'member'], ['S', B, 'member'], ['T', OUT, 'owner'],
    ] as const) {
      const member = ids[`member:${space}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids[space]]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids[space], identity, role],
      );
    }
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids[`member:S:${B}`],
    ]);
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

// ---------------------------------------------------------------------------

describe('T34 / R7 / N7 — no secret, hint or login outside the side row', () => {
  it('greps entities, entity_content, entity_versions, command_ledger, every other table, the read path and the logs — success and failing create', async () => {
    const consoleSeen: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleSeen.push(args.map(String).join(' ')); }));
    try {
      probeVerdict = { ok: true, displayLogin: LOGIN_CANARY };
      const good = await create(A);
      // The failing-create paths: a probe refusal (never reaches SQL) and a
      // SQL refusal after sealing (label over 80 chars, 206's check).
      probeVerdict = { ok: false, reason: 'rejected', detail: 'HTTP 401' };
      const refusedSecret = secretFor('refused');
      const probeError = await service.create(claims(A), ids.S!, {
        provider: 'anthropic', shape: 'api_key', label: label('refused'), secret: refusedSecret,
      }).then(() => null, (e: unknown) => e);
      expect(probeError).not.toBeNull();
      probeVerdict = { ok: true, displayLogin: LOGIN_CANARY };
      const sqlSecret = secretFor('sqlfail');
      const sqlError = await service.create(claims(A), ids.S!, {
        provider: 'anthropic', shape: 'api_key', label: 'x'.repeat(81), secret: sqlSecret,
      }).then(() => null, (e: unknown) => e);
      expect(sqlError).not.toBeNull();

      const stored = await asOwner(async (c) =>
        (await c.query<{ key_hint: string; display_login: string }>('select key_hint, display_login from public.space_credentials where id = $1', [good.id])).rows[0]!);
      expect(stored.display_login).toBe(LOGIN_CANARY);
      const needles = [good.secret, refusedSecret, sqlSecret, CANARY, LOGIN_CANARY];
      // The 4-char hint is too short to grep a whole database for; it is
      // asserted absent from the entity surfaces by name below.
      const hint = stored.key_hint;

      // The five named surfaces, as tm8_graph_owner (RLS off, every column).
      const named = await asOwner(async (c) => {
        const q = async (sql: string, p: unknown[]) => JSON.stringify((await c.query(sql, p)).rows);
        return {
          entity: await q('select e.* from public.entities e where e.id = $1', [good.id]),
          content: await q('select internal.entity_content($1) c', [good.id]),
          versions: await q('select v.* from public.entity_versions v where v.entity_id = $1', [good.id]),
          ledger: await q('select l.* from public.command_ledger l', []),
          activity: await q('select a.* from public.activity a', []),
        };
      });
      for (const [surface, text] of Object.entries(named)) {
        for (const needle of needles) expect(text, `${surface} holds ${needle}`).not.toContain(needle);
      }
      for (const surface of ['entity', 'content', 'versions'] as const) {
        expect(named[surface], `${surface} holds the hint`).not.toContain(`"${hint}"`);
      }

      // Every other table in public and internal, as text. space_credentials
      // is the side row itself and is the one place these may live.
      const leaks = await asOwner(async (c) => {
        const { rows: tables } = await c.query<{ s: string; t: string }>(
          `select table_schema s, table_name t from information_schema.tables
            where table_schema in ('public', 'internal') and table_type = 'BASE TABLE'
              and table_name <> 'space_credentials'`,
        );
        const hits: string[] = [];
        for (const { s, t } of tables) {
          for (const needle of needles) {
            const { rows } = await c.query<{ n: number }>(
              `select count(*)::int n from ${s}.${t} x where x::text like '%' || $1 || '%'`, [needle],
            );
            if (rows[0]!.n > 0) hits.push(`${s}.${t}:${needle.slice(0, 12)}`);
          }
        }
        return hits;
      });
      expect(leaks).toEqual([]);

      // The read path: the entity read models, as the member who can see it.
      const read = await readAs(claims(B), good.id);
      expect(read.summaries).toHaveLength(1);
      for (const needle of [...needles, `"${hint}"`]) expect(JSON.stringify(read), `read model holds ${needle}`).not.toContain(needle);
      expect(read.content).toMatchObject({ kind: 'credential', provider: 'anthropic', shape: 'api_key', visibility: 'public', ownerAccountId: null });

      // Errors and logs.
      for (const surface of [
        JSON.stringify(probeError, Object.getOwnPropertyNames(probeError as object)),
        JSON.stringify(sqlError, Object.getOwnPropertyNames(sqlError as object)),
        JSON.stringify(logged),
        consoleSeen.join('\n'),
      ]) {
        for (const needle of [good.secret, refusedSecret, sqlSecret]) expect(surface).not.toContain(needle);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      probeVerdict = { ok: true, displayLogin: LOGIN_CANARY };
    }
  });

  it('every create leaves a same-id entity of kind credential in the same space (the link)', async () => {
    const { id } = await create(A);
    const [row] = await asOwner(async (c) => (await c.query<{ kind: string; space_id: string }>(
      'select kind, space_id::text from public.entities where id = $1', [id])).rows);
    expect(row).toEqual({ kind: 'credential', space_id: ids.S });
  });
});

describe('N3 / R3 — the hint and login are masked in SQL, as tm8_app', () => {
  it('tm8_app has no column grant on key_hint or display_login', async () => {
    expect(await outcome(() => db.query(claims(A), 'select key_hint from public.space_credentials'))).toBe('42501');
    expect(await outcome(() => db.query(claims(A), 'select display_login from public.space_credentials'))).toBe('42501');
    // Positive: the granted columns still read.
    expect(await outcome(() => db.query(claims(A), 'select id, label, visibility from public.space_credentials'))).toBe('ok');
  });

  it('a private credential shows its login and hint to its owner only; a public one to every member', async () => {
    const priv = await owned(A, 'private');
    const pub = await owned(A, 'public');
    const rowOf = async (who: string, id: string) =>
      (await store.list(claims(who), ids.S!)).find((c) => c.id === id);
    expect(await rowOf(B, priv.id)).toMatchObject({ displayLogin: null, keyHint: null, visibility: 'private' });
    expect(await rowOf(ADM, priv.id)).toMatchObject({ displayLogin: null, keyHint: null });
    expect(await rowOf(A, priv.id)).toMatchObject({ displayLogin: LOGIN_CANARY, keyHint: expect.any(String) });
    expect(await rowOf(B, pub.id)).toMatchObject({ displayLogin: LOGIN_CANARY, keyHint: expect.any(String) });
  });
});

describe('T35 / R6 / N6 — the recorder and the repoint gate', () => {
  it('B cannot record A\'s private credential; A can; B can record a public owned one and a space-owned one', async () => {
    const priv = await owned(A, 'private');
    const pub = await owned(A, 'public');
    const space = await create(A);
    const s1 = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), s1, priv.id))).toBe('42501:not_usable');
    const s2 = await session(ids[`member:S:${A}`]!);
    expect(await outcome(() => record(claims(A), s2, priv.id))).toBe('ok');
    const s3 = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), s3, pub.id))).toBe('ok');
    const s4 = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), s4, space.id))).toBe('ok');
  });

  it('R6: a re-record of the SAME row after the switch to private is refused, not returned idempotently', async () => {
    const cred = await owned(A, 'public');
    const s = await session(ids[`member:S:${B}`]!);
    expect(await outcome(() => record(claims(B), s, cred.id))).toBe('ok');
    await store.setVisibility(claims(A), cred.id, 'private');
    expect(await outcome(() => record(claims(B), s, cred.id))).toBe('42501:not_usable');
  });

  it('race: a record waiting on the switch\'s row lock is refused once the switch commits', async () => {
    const cred = await owned(A, 'public');
    const s = await session(ids[`member:S:${B}`]!);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let switched!: () => void;
    const locked = new Promise<void>((resolve) => { switched = resolve; });
    const switching = db.tx(claims(A), async (q) => {
      await q.rpc('set_space_credential_visibility', [cred.id, 'private']);
      switched();
      await gate;
    });
    await locked;
    const recording = outcome(() => record(claims(B), s, cred.id));
    // Wait until the recorder is actually blocked on the row lock.
    for (let i = 0; i < 100; i++) {
      const waiting = await asOwner(async (c) => (await c.query<{ n: number }>(
        `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rows[0]!.n);
      if (waiting > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await switching;
    expect(await recording).toBe('42501:not_usable');
  });

  it('N6: after the switch, a non-owner repoint is refused not_usable; the owner\'s repoint succeeds', async () => {
    const cred = await owned(A, 'public');
    const s = await session(ids[`member:S:${B}`]!);
    await record(claims(B), s, cred.id);
    await setStatus(s, 'exited');
    await store.setVisibility(claims(A), cred.id, 'private');
    expect(await outcome(() => db.rpc(claims(B), 'repoint_session_space_credentials', [s]))).toBe('42501:not_usable');
    expect(await outcome(() => db.rpc(claims(A), 'repoint_session_space_credentials', [s]))).toBe('ok');
  });

  it('the spawn reader and usable_space_credential_ids give the same answer', async () => {
    const priv = await owned(A, 'private');
    const pub = await owned(A, 'public');
    expect(await outcome(() => db.rpc(claims(B), 'read_space_credential_for_spawn', [ids.S, 'anthropic', priv.id]))).toBe('42501:not_usable');
    expect(await outcome(() => db.rpc(claims(A), 'read_space_credential_for_spawn', [ids.S, 'anthropic', priv.id]))).toBe('ok');
    const forB = await db.rpc<string[]>(claims(B), 'usable_space_credential_ids', [[priv.id, pub.id]]);
    expect(forB).toEqual([pub.id]);
    const forA = await db.rpc<string[]>(claims(A), 'usable_space_credential_ids', [[priv.id, pub.id]]);
    expect(new Set(forA)).toEqual(new Set([priv.id, pub.id]));
  });
});

describe('T36 — a teammate B launched never unlocks A\'s private credential', () => {
  it('agent claims resolve to B as launcher: refused on A\'s private, allowed on A\'s public', async () => {
    const priv = await owned(A, 'private');
    const pub = await owned(A, 'public');
    // A session B's teammate TB runs, launched under B's agent claims.
    const s1 = await session(ids.TB!);
    expect(await outcome(() => record(agent(B), s1, priv.id))).toBe('42501:not_usable');
    expect(await db.rpc<string[]>(agent(B), 'usable_space_credential_ids', [[priv.id]])).toEqual([]);
    expect(await outcome(() => db.rpc(agent(B), 'read_space_credential_for_spawn', [ids.S, 'anthropic', priv.id]))).toBe('42501:not_usable');
    // Positive: the same teammate session, A's public credential.
    const s2 = await session(ids.TB!);
    expect(await outcome(() => record(agent(B), s2, pub.id))).toBe('ok');
    // And A's own agent reaches A's private one.
    const s3 = await session(ids.TB!);
    expect(await outcome(() => record(agent(A), s3, priv.id))).toBe('ok');
  });

  it('agents cannot switch visibility (human-only), even the owner\'s own agent', async () => {
    const cred = await owned(A, 'public');
    expect(await outcome(() => db.rpc(agent(A), 'set_space_credential_visibility', [cred.id, 'private']))).toBe('42501');
    expect(await outcome(() => db.rpc(claims(A), 'set_space_credential_visibility', [cred.id, 'private']))).toBe('ok');
  });
});

describe('T39 / T44 / N4a / N4b / N5 — the entity is written only by the credential writers', () => {
  it('N4a: tm8_app has no INSERT on entities, with or without the flag', async () => {
    const insert = (flag: boolean) => db.tx(claims(OWN, 'browser', true), async (q) => {
      if (flag) await q.query(`select set_config('tm8.credential_write', 'on', true)`);
      await q.query(`insert into public.entities(id, space_id, kind, position, created_by) values (internal.new_id(), $1, 'credential', 0, $2)`, [ids.S, ids[`member:S:${OWN}`]]);
    });
    expect(await outcome(() => insert(false))).toBe('42501');
    expect(await outcome(() => insert(true))).toBe('42501');
  });

  it('T39: a raw credential insert without the flag is refused even for the graph owner; with it, the link still needs a side row', async () => {
    const raw = (flag: boolean) => asOwner(async (c) => {
      if (flag) await c.query(`select set_config('tm8.credential_write', 'on', true)`);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values (internal.new_id(), $1, 'credential', 0, $2)`, [ids.S, ids[`member:S:${OWN}`]]);
    });
    const code = async (run: () => Promise<unknown>) => run().then(() => 'ok', (e: { code?: string }) => String(e.code));
    expect(await code(() => raw(false))).toBe('42501');
    // With the flag but no side row, the deferred link refuses at commit.
    expect(await code(() => raw(true))).toBe('23503');
    // Positive: the same flag, through the writer, with its side row.
    expect(await outcome(() => create(OWN))).toBe('ok');
  });

  it('N4b: the flag is off again after the writer returns and after it throws', async () => {
    // The SQL writer and the check in ONE transaction as tm8_app: the flag is
    // transaction-local, so only a same-transaction read can see a leak.
    const after = await db.tx(claims(A), async (q) => {
      await q.rpc('create_space_credential', [
        randomUUID(), ids.S, 'anthropic', 'api_key', label('n4b'), 'Fk9x',
        Buffer.alloc(17, 1), Buffer.alloc(12, 2),
      ]);
      return (await q.query<{ v: string | null }>(`select current_setting('tm8.credential_write', true) v`))[0]!.v;
    });
    expect(after ?? '').not.toBe('on');
    // Same transaction as the writer: the writer's own call, then a check.
    const sameTx = await asOwner(async (c) => {
      await c.query(`select internal.insert_credential_entity(internal.new_id(), $1, $2)`, [ids.S, ids[`member:S:${OWN}`]])
        .catch(() => undefined);
      return (await c.query<{ v: string | null }>(`select current_setting('tm8.credential_write', true) v`)).rows[0]!.v;
    }).catch(() => 'rolled-back');
    expect(sameTx).not.toBe('on');
    // The exception path: an unknown space makes the insert fail inside the writer.
    const afterThrow = await asOwner(async (c) => {
      await c.query('savepoint s');
      await c.query(`select internal.insert_credential_entity(internal.new_id(), internal.new_id(), $1)`, [ids[`member:S:${OWN}`]])
        .catch(() => c.query('rollback to savepoint s'));
      return (await c.query<{ v: string | null }>(`select current_setting('tm8.credential_write', true) v`)).rows[0]!.v;
    });
    expect(afterThrow ?? '').not.toBe('on');
  });

  it('N5 / T44: move, delete and restore RPCs refuse a credential — for a member, the space owner and a node admin', async () => {
    const { id } = await create(A);
    const version = await asOwner(async (c) => (await c.query<{ version: number }>('select version from public.entities where id = $1', [id])).rows[0]!.version);
    for (const who of [claims(A), claims(OWN), claims(OWN, 'browser', true)]) {
      expect(await outcome(() => db.rpc(who, 'delete_entity', [id]))).toBe('42501');
      expect(await outcome(() => db.rpc(who, 'move_entity', [id, null, 1, version]))).toBe('42501');
      expect(await outcome(() => db.rpc(who, 'restore_entity', [id]))).toBe('42501');
    }
    // Positive: the same doors work for a doc in the same space.
    const doc = await asOwner(async (c) => {
      const docId = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'doc', 0, $3)`, [docId, ids.S, ids[`member:S:${A}`]]);
      await c.query(`insert into public.documents(entity_id, title, body) values ($1, 'd', '')`, [docId]);
      return docId;
    });
    const docVersion = await asOwner(async (c) => (await c.query<{ version: number }>('select version from public.entities where id = $1', [doc])).rows[0]!.version);
    expect(await outcome(() => db.rpc(claims(A), 'move_entity', [doc, null, 1, docVersion]))).toBe('ok');
    expect(await outcome(() => db.rpc(claims(A), 'delete_entity', [doc]))).toBe('ok');
    expect(await outcome(() => db.rpc(claims(A), 'restore_entity', [doc]))).toBe('ok');
  });

  it('T44: the envelope guard refuses a raw re-parent or soft-delete of a credential even as the graph owner', async () => {
    const { id } = await create(A);
    const code = (sql: string) => asOwner((c) => c.query(sql, [id])).then(() => 'ok', (e: { code?: string }) => String(e.code));
    expect(await code(`update public.entities set deleted_at = now() where id = $1`)).toBe('42501');
    expect(await code(`update public.entities set position = position + 1 where id = $1`)).toBe('42501');
    expect(await code(`update public.entities set kind = 'doc' where id = $1`)).toBe('42501');
  });
});

describe('T41a — revoke and switch-to-private contain; RESTRICT and the backstops hold', () => {
  it('switch to private kills every live session another launcher holds (spawning included, N1); the owner\'s lives', async () => {
    const cred = await owned(A, 'public');
    const byB = await session(ids[`member:S:${B}`]!);
    await record(claims(B), byB, cred.id);
    await setStatus(byB, 'running');
    // N1: a session still spawning, recorded before the switch.
    const spawningByB = await session(ids.TB!);
    await record(agent(B), spawningByB, cred.id);
    const byA = await session(ids[`member:S:${A}`]!);
    await record(claims(A), byA, cred.id);
    await setStatus(byA, 'running');
    contained.length = 0;
    const result = await service.setVisibility(claims(A), cred.id, 'private');
    expect(new Set(result.terminatedAgentSessionIds)).toEqual(new Set([byB, spawningByB]));
    expect(contained.every((c) => c.cause === 'space_credential_made_private')).toBe(true);
    expect(result.credential).toMatchObject({ id: cred.id });
    expect(result.failures).toEqual([]);
  });

  it('switch to private clears the default in the same statement', async () => {
    const cred = await owned(A, 'public');
    await asOwner((c) => c.query('update public.space_credentials set may_be_space_default = true where id = $1', [cred.id]));
    await store.setDefault(claims(A), cred.id).catch(() => undefined);
    await store.setVisibility(claims(A), cred.id, 'private');
    const [row] = await asOwner(async (c) => (await c.query<{ is_default: boolean; may_be_space_default: boolean }>(
      'select is_default, may_be_space_default from public.space_credentials where id = $1', [cred.id])).rows);
    expect(row).toEqual({ is_default: false, may_be_space_default: false });
  });

  it('only the owner switches; a space-owned credential cannot be made private', async () => {
    const cred = await owned(A, 'public');
    expect(await outcome(() => store.setVisibility(claims(B), cred.id, 'private'))).toBe('42501');
    expect(await outcome(() => store.setVisibility(claims(OWN), cred.id, 'private'))).toBe('42501');
    const space = await create(A);
    expect(await outcome(() => store.setVisibility(claims(A), space.id, 'private'))).toBe('22023');
    expect(await outcome(() => store.setVisibility(claims(A), cred.id, 'private'))).toBe('ok');
  });

  it('revoke kills every launcher and keeps the entity, now reading revoked', async () => {
    const cred = await owned(A, 'public');
    const byB = await session(ids[`member:S:${B}`]!);
    await record(claims(B), byB, cred.id);
    await setStatus(byB, 'running');
    contained.length = 0;
    const result = await service.delete(claims(A), cred.id);
    expect(result.terminatedAgentSessionIds).toEqual([byB]);
    const { content } = await readAs(claims(B), cred.id);
    expect(content).toMatchObject({ kind: 'credential', status: 'revoked' });
  });

  it('account disable revokes owned credentials in the same statement; a space-owned one is untouched', async () => {
    const identity = `w10a-disable-${randomUUID()}`;
    const acct = await asOwner(async (c) => {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id::text`, [identity]);
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`, [member, ids.S, identity]);
      return rows[0]!.id;
    });
    const ownedByD = await service.create(claims(identity), ids.S!, { provider: 'anthropic', shape: 'api_key', label: label('d'), secret: secretFor('d') });
    const spaceOwned = await service.create(claims(identity), ids.S!, { provider: 'anthropic', shape: 'api_key', label: label('d2'), secret: secretFor('d2') });
    await asOwner((c) => c.query('update public.space_credentials set owner_account_id = $2 where id = $1', [ownedByD.id, acct]));
    await asOwner((c) => c.query(`update public.accounts set status = 'disabled', disabled_at = now() where id = $1`, [acct]));
    const rows = await asOwner(async (c) => (await c.query<{ id: string; status: string; secret: boolean }>(
      'select id::text, status, secret_ciphertext is not null secret from public.space_credentials where id = any($1::uuid[])',
      [[ownedByD.id, spaceOwned.id]])).rows);
    expect(rows.find((r) => r.id === ownedByD.id)).toMatchObject({ status: 'revoked', secret: false });
    expect(rows.find((r) => r.id === spaceOwned.id)).toMatchObject({ status: 'active', secret: true });
  });

  it('RESTRICT: an account that owns a credential cannot be hard-deleted; the members backstop refuses its member row', async () => {
    const cred = await owned(B, 'public');
    const code = (sql: string, p: unknown[]) => asOwner((c) => c.query(sql, p)).then(() => 'ok', (e: { code?: string }) => String(e.code));
    expect(await code('delete from public.accounts where id = $1', [accounts[B]])).toBe('23503');
    expect(await code('delete from public.members where entity_id = $1', [ids[`member:S:${B}`]])).toBe('23503');
    // Positive: once revoked, the member row may go (rolled back here).
    await service.delete(claims(B), cred.id);
    const stillOwnsLive = await asOwner(async (c) => (await c.query<{ n: number }>(
      `select count(*)::int n from public.space_credentials where owner_account_id = $1 and status <> 'revoked' and space_id = $2`,
      [accounts[B], ids.S])).rows[0]!.n);
    if (stillOwnsLive === 0) {
      expect(await asOwner(async (c) => {
        await c.query('savepoint s');
        const r = await c.query('delete from public.members where entity_id = $1', [ids[`member:S:${B}`]])
          .then(() => 'ok', (e: { code?: string }) => String(e.code));
        await c.query('rollback to savepoint s');
        return r;
      })).toBe('ok');
    }
  });

});

// ---------------------------------------------------------------------------
// T41b — G6 (232, #841). Each case takes a FRESH member D, so ending a
// membership never disturbs the shared cast. The kill lists are asserted in
// the SQL result the handlers act on (membership/handlers.ts); the handler
// step itself is test/membership/membership-credentials.test.ts.
// ---------------------------------------------------------------------------
describe('T41b — a membership that ends takes the credentials its member owns (G6, #841)', () => {
  type Joiner = { identity: string; account: string; member: string };
  type EndResult = {
    stoppedSessionIds: string[];
    credentialSessionIds: string[];
    credentialHomes: Array<{ spaceId: string; credentialId: string; provider: string }>;
  };

  async function joiner(stem: string): Promise<Joiner> {
    const identity = `w10a-${stem}-${randomUUID()}`;
    return asOwner(async (c) => {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id::text`, [identity]);
      const member = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'member', $3)`, [member, ids.S, identity]);
      return { identity, account: rows[0]!.id, member };
    });
  }

  /** A credential D owns in S; `login` re-shapes it as a login row (no sealed bytes). */
  async function ownedBy(d: Joiner, opts: { login?: boolean; default?: boolean } = {}): Promise<string> {
    const view = await service.create(claims(d.identity), ids.S!, {
      provider: 'anthropic', shape: 'api_key', label: label('d owned'), secret: secretFor('d'),
    });
    await asOwner(async (c) => {
      await c.query('update public.space_credentials set owner_account_id = $2, is_default = false where id = $1', [view.id, d.account]);
      if (opts.login) {
        await c.query(`update public.space_credentials
                          set shape = 'login', secret_ciphertext = null, secret_nonce = null, key_hint = null
                        where id = $1`, [view.id]);
      }
      if (opts.default) {
        await c.query(`insert into public.member_defaults(space_id, account_id, provider, credential_id) values ($1, $2, 'anthropic', $3)`,
          [ids.S, d.account, view.id]);
      }
    });
    return view.id;
  }

  async function running(createdBy: string, who: DbClaims, credentialId: string): Promise<string> {
    const id = await session(createdBy);
    await record(who, id, credentialId);
    await setStatus(id, 'running');
    return id;
  }

  const rows = (credentialIds: string[]) => asOwner(async (c) => (await c.query<{ id: string; status: string; sealed: boolean; version: number }>(
    `select sc.id::text, sc.status, sc.secret_ciphertext is not null sealed, e.version
       from public.space_credentials sc join public.entities e on e.id = sc.id
      where sc.id = any($1::uuid[]) order by sc.id`, [credentialIds])).rows);
  const byId = <T extends { id: string }>(list: T[], id: string): T => list.find((r) => r.id === id)!;
  const defaultsOf = (account: string) => asOwner(async (c) => (await c.query<{ n: number }>(
    'select count(*)::int n from public.member_defaults where account_id = $1', [account])).rows[0]!.n);

  it('member_defaults: own rows only, and under a pinned session only the pinned space\'s (227 conjunct)', async () => {
    const d = await joiner('pinned');
    await ownedBy(d, { default: true });
    const seen = (who: DbClaims) => db.tx(who, async (q) =>
      (await q.query<{ n: number }>('select count(*)::int n from public.member_defaults'))[0]!.n);
    expect(await seen(claims(d.identity))).toBe(1);
    expect(await seen({ ...claims(d.identity), sessionSpaceId: ids.S })).toBe(1);
    expect(await seen({ ...claims(d.identity), sessionSpaceId: randomUUID() })).toBe(0);
  });

  it('remove: D\'s owned credentials are revoked with the tombstone; B\'s session on them is listed for containment; D\'s own is 232\'s', async () => {
    const d = await joiner('removed');
    const pub = await ownedBy(d, { default: true });
    const priv = await ownedBy(d);
    await store.setVisibility(claims(d.identity), priv, 'private');
    const home = await ownedBy(d, { login: true });
    const spaceOwned = await create(B);
    const bOwned = await owned(B, 'public');

    const bOnD = await running(ids[`member:S:${B}`]!, claims(B), pub);
    const dOnD = await running(d.member, claims(d.identity), priv);
    const bOnSpace = await running(ids[`member:S:${B}`]!, claims(B), spaceOwned.id);
    const before = await rows([pub, priv, home, spaceOwned.id, bOwned.id]);
    expect(await defaultsOf(d.account)).toBe(1);

    const result = await db.rpc<EndResult>(claims(OWN), 'remove_space_member', [ids.S, d.member, randomUUID()]);

    expect(result.credentialSessionIds).toEqual([bOnD]);
    expect(result.stoppedSessionIds).toEqual([dOnD]);
    expect(result.credentialHomes).toEqual([{ spaceId: ids.S, credentialId: home, provider: 'anthropic' }]);
    const after = await rows([pub, priv, home, spaceOwned.id, bOwned.id]);
    for (const id of [pub, priv, home]) {
      expect(byId(after, id)).toMatchObject({ status: 'revoked', sealed: false });
      // One revoke, one card bump: nothing fires twice.
      expect(byId(after, id).version).toBe(byId(before, id).version + 1);
    }
    expect(await defaultsOf(d.account)).toBe(0);
    // Paired positives: the space-owned and B's own credential are untouched,
    // and B's session on the space-owned one is in neither list.
    for (const id of [spaceOwned.id, bOwned.id]) expect(byId(after, id)).toEqual(byId(before, id));
    expect([...result.credentialSessionIds, ...result.stoppedSessionIds]).not.toContain(bOnSpace);
    const { content } = await readAs(claims(B), pub);
    expect(content).toMatchObject({ kind: 'credential', status: 'revoked' });
  });

  it('leave: the same revoke, and a replay of the same mutation returns the same lists', async () => {
    const d = await joiner('leaver');
    const pub = await ownedBy(d);
    const bOnD = await running(ids[`member:S:${B}`]!, claims(B), pub);
    const mutation = randomUUID();
    const first = await db.rpc<EndResult>(claims(d.identity), 'leave_space', [ids.S, mutation]);
    expect(first.credentialSessionIds).toEqual([bOnD]);
    expect(byId(await rows([pub]), pub)).toMatchObject({ status: 'revoked', sealed: false });
    const replay = await db.rpc<EndResult>(claims(d.identity), 'leave_space', [ids.S, mutation]);
    expect(replay.credentialSessionIds).toEqual([bOnD]);
  });

  it('a member who owns nothing leaves with empty lists and every credential untouched', async () => {
    const d = await joiner('owns-nothing');
    const spaceOwned = await create(B);
    const before = await rows([spaceOwned.id]);
    const result = await db.rpc<EndResult>(claims(d.identity), 'leave_space', [ids.S, randomUUID()]);
    expect(result).toMatchObject({ credentialSessionIds: [], credentialHomes: [] });
    expect(await rows([spaceOwned.id])).toEqual(before);
  });

  it('a refused end revokes nothing: an agent cannot take its launcher out, and D\'s credential stays live', async () => {
    const d = await joiner('agent-refused');
    const pub = await ownedBy(d);
    expect(await outcome(() => db.rpc(agent(d.identity), 'leave_space', [ids.S, randomUUID()]))).not.toBe('ok');
    expect(await outcome(() => db.rpc(claims(B), 'remove_space_member', [ids.S, d.member, randomUUID()]))).not.toBe('ok');
    expect(byId(await rows([pub]), pub)).toMatchObject({ status: 'active', sealed: true });
  });

  it('backstop: a raw tombstone of a member who owns a live credential is refused, even as the graph owner; once revoked it passes', async () => {
    const d = await joiner('raw-tombstone');
    const pub = await ownedBy(d);
    const tombstone = () => asOwner(async (c) => {
      await c.query('savepoint s');
      const r = await c.query(`update public.members set status = 'left', left_at = now() where entity_id = $1`, [d.member])
        .then(() => 'ok', (e: { code?: string }) => String(e.code));
      await c.query('rollback to savepoint s');
      return r;
    });
    expect(await tombstone()).toBe('23503');
    await service.delete(claims(d.identity), pub);
    expect(await tombstone()).toBe('ok');
  });

  it('account disable: the trigger revokes once, the wrapper lists B\'s session and the login home; the core is not callable by tm8_app', async () => {
    const d = await joiner('disabled');
    const pub = await ownedBy(d);
    const home = await ownedBy(d, { login: true });
    const bOnD = await running(ids[`member:S:${B}`]!, claims(B), pub);
    const before = await rows([pub, home]);
    const admin = claims(OWN, 'browser', true);
    const mutation = randomUUID();
    const result = await db.rpc<EndResult & { status: string }>(admin, 'disable_account', [d.account, mutation]);
    expect(result.status).toBe('disabled');
    expect(result.credentialSessionIds).toEqual([bOnD]);
    expect(result.credentialHomes).toEqual([{ spaceId: ids.S, credentialId: home, provider: 'anthropic' }]);
    const after = await rows([pub, home]);
    for (const id of [pub, home]) {
      expect(byId(after, id)).toMatchObject({ status: 'revoked', sealed: false });
      expect(byId(after, id).version).toBe(byId(before, id).version + 1);
    }
    // A replay re-reads the lists and bumps nothing again.
    const replay = await db.rpc<EndResult>(admin, 'disable_account', [d.account, mutation]);
    expect(replay.credentialSessionIds).toEqual([bOnD]);
    expect(await rows([pub, home])).toEqual(after);
    expect(await outcome(() => db.tx(admin, (q) => q.query('select internal.disable_account_core($1, null)', [d.account]))))
      .toBe('42501');
  });
});

describe('T42 / N11 — the backfill: a same-id entity per 206 row, idempotent', () => {
  let scratch: W1ScratchDatabase;
  afterAll(async () => { await scratch?.destroy(); });

  it('backfills legacy rows (null creator included) as space-owned public, and a second run changes nothing', async () => {
    scratch = await createW1ScratchDatabase('credential_entities_backfill');
    const all = migrationFiles();
    const at = all.indexOf(MIGRATION!);
    scratch.apply(all.slice(0, at));
    const legacy = await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      const id = async () => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ('bf-owner', 'bf-owner')`);
      const acct = (await c.query<{ id: string }>(`insert into public.accounts(identity_id, username, display_name) values ('bf-owner', 'bf-owner', 'bf-owner') returning id::text`)).rows[0]!.id;
      const space = await id();
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'BF', 'bf-owner')`, [space]);
      const member = await id();
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, 'bf-owner', 'owner', 'bf-owner')`, [member, space]);
      const withCreator = await id();
      const nullCreator = await id();
      const pending = await id();
      await c.query(
        `insert into public.space_credentials(id, space_id, provider, shape, label, created_by_account_id, key_hint, secret_ciphertext, secret_nonce)
         values ($1, $3, 'anthropic', 'api_key', 'legacy', $4, 'Fk3x', '\\x00112233445566778899aabbccddeeff00'::bytea, '\\x000102030405060708090a0b'::bytea),
                ($2, $3, 'openai', 'api_key', 'legacy-null', null, 'Fk4x', '\\x00112233445566778899aabbccddeeff00'::bytea, '\\x000102030405060708090a0b'::bytea)`,
        [withCreator, nullCreator, space, acct],
      );
      await c.query(
        `insert into public.space_credentials(id, space_id, provider, shape, label, status, pending_expires_at)
         values ($1, $2, 'anthropic', 'login', 'legacy-pending', 'pending', now() + interval '1 hour')`, [pending, space]);
      return { space, member, withCreator, nullCreator, pending };
    }).catch((error: unknown) => { throw error; });

    scratch.apply([MIGRATION!]);
    const count = () => scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      const { rows } = await c.query<{ side: number; cards: number; residue: number }>(
        `select (select count(*)::int from public.space_credentials) side,
                (select count(*)::int from public.entities where kind = 'credential') cards,
                (select count(*)::int from public.space_credentials sc
                  where not exists (select 1 from public.entities e where e.id = sc.id and e.kind = 'credential' and e.space_id = sc.space_id)) residue`);
      return rows[0]!;
    });
    const first = await count();
    expect(first).toEqual({ side: 3, cards: 3, residue: 0 });
    const rows = await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      return (await c.query<{ id: string; owner: string | null; visibility: string; created_by: string }>(
        `select sc.id::text, sc.owner_account_id::text owner, sc.visibility, e.created_by::text
           from public.space_credentials sc join public.entities e on e.id = sc.id`)).rows;
    });
    for (const row of rows) expect(row).toMatchObject({ owner: null, visibility: 'public', created_by: legacy.member });

    // Re-run the data step exactly as the migration wrote it.
    const text = await readFile(join(MIGRATIONS_DIR, MIGRATION!), 'utf8');
    const block = /\n(do \$\$\ndeclare\n  r record;[\s\S]*?\n\$\$;)\n/.exec(text)?.[1];
    expect(block, 'the backfill block is extractable').toBeDefined();
    await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(block!);
    });
    expect(await count()).toEqual(first);
  });
  it('refuses the migration when a pre-existing entity of another kind shares a 206 row\'s id', async () => {
    // The loop skips a row whose id already names an entity, and the FK checks
    // only that some entity has the id — so without the post-backfill
    // assertion this collision would migrate green with no card.
    const collide = await createW1ScratchDatabase('credential_entities_collision');
    try {
      const all = migrationFiles();
      collide.apply(all.slice(0, all.indexOf(MIGRATION!)));
      await collide.transaction(async (c) => {
        await c.query('set local role tm8_graph_owner');
        const id = async () => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
        await c.query(`insert into public.user_profiles(identity_id, display_name) values ('cx-owner', 'cx-owner')`);
        const space = await id();
        await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'CX', 'cx-owner')`, [space]);
        const member = await id();
        await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
        await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, 'cx-owner', 'owner', 'cx-owner')`, [member, space]);
        // The collision: a credential row whose id is ALREADY a member entity's.
        await c.query(
          `insert into public.space_credentials(id, space_id, provider, shape, label, key_hint, secret_ciphertext, secret_nonce)
           values ($1, $2, 'anthropic', 'api_key', 'collides', 'Fk5x', '\\x00112233445566778899aabbccddeeff00'::bytea, '\\x000102030405060708090a0b'::bytea)`,
          [member, space],
        );
      });
      expect(() => collide.apply([MIGRATION!])).toThrow(/lack a credential card in their own space/);
      // Positive, same DB: the refused migration left nothing behind (-1).
      const [row] = await collide.query<{ applied: boolean }>(
        `select to_regclass('public.member_defaults') is not null applied`);
      expect(row).toEqual({ applied: false });
    } finally {
      await collide.destroy();
    }
  });
});
