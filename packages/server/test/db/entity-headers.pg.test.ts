/**
 * Headers T2 (integrated plan I3): `entity_headers`, its two doors, RLS and
 * staleness, against a REAL PostgreSQL as `tm8_app` under the caller's claims.
 *
 *   · `set_entity_header` / `clear_entity_header`: the kind allowlist (the
 *     SQL one and `resolveHeaders`' one agree), text and keyword bounds, the
 *     header's own optimistic version, and that a header write never moves
 *     `entities.version` nor emits an `entity.upsert` (it records an activity);
 *   · RLS: another space, a restricted entity, a deleted one and a non-member
 *     read no header and cannot write one; `tm8_app` has no direct write;
 *   · stale: a body edit after the header was pinned flags it (the text is
 *     still used), re-saving re-pins it, and an artifact/file ref change flags
 *     it with no version bump;
 *   · `resolveHeaders` returns authored ?? native/derived per field, and
 *     never lets a row override a skill's or memory's own header.
 */
import { SELECTION_HEADER_KINDS } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { DbClaims, Db, Querier } from '../../src/db/types.js';
import { resolveHeaders } from '../../src/headers/resolve.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'eh-owner';
const STRANGER = 'eh-stranger';
const NOBODY = 'eh-nobody';

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;
type Row = Record<string, any>;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const ownerSql = (text: string, params: unknown[] = []): Promise<Row[]> => asOwner(async (c) => (await c.query(text, params)).rows);

async function newId(client: Client): Promise<string> {
  return (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
}

async function entity(client: Client, space: string, kind: string, opts: { visibility?: string } = {}): Promise<string> {
  const id = await newId(client);
  await client.query(
    `insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility)
     values ($1, $2, $3, null, 0, $4, $5)`,
    [id, space, kind, ids[`member:${space}`] ?? id, opts.visibility ?? 'space'],
  );
  return id;
}

async function doc(client: Client, space: string, title: string, opts: { visibility?: string } = {}): Promise<string> {
  const id = await entity(client, space, 'doc', opts);
  await client.query(`insert into public.documents(entity_id, title, body) values ($1, $2, $3)`, [id, title, `# ${title}\n\nFirst paragraph.\n`]);
  return id;
}

async function space(client: Client, key: string, identity: string): Promise<string> {
  const id = await newId(client);
  await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, key, identity]);
  const member = await newId(client);
  await client.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`,
    [member, id, identity],
  );
  ids[`member:${id}`] = member;
  return id;
}

const claims = (identityId: string): DbClaims => ({ identityId, nodeAdmin: false, requestId: 'entity-headers' });
const asCaller = <T>(fn: (q: Querier) => Promise<T>, identityId = OWNER): Promise<T> => db.tx(claims(identityId), fn);

interface SetArgs {
  expected?: number | null;
  whenToUse?: string | null;
  summary?: string | null;
  keywords?: string[];
  cmid?: string | null;
}

async function setHeader(entityId: string, args: SetArgs, identity = OWNER): Promise<Row> {
  return asCaller(async (q) => (await q.query<{ r: Row }>(
    `select public.set_entity_header($1, $2, null, $3, $4, $5::text[], $6) r`,
    [entityId, args.expected ?? null, args.whenToUse ?? null, args.summary ?? null, args.keywords ?? [], args.cmid ?? null],
  ))[0]!.r, identity);
}

async function clearHeader(entityId: string, expected: number | null, identity = OWNER): Promise<Row> {
  return asCaller(async (q) => (await q.query<{ r: Row }>(
    `select public.clear_entity_header($1, $2, null, null) r`, [entityId, expected],
  ))[0]!.r, identity);
}

/** The taxonomy code the db layer maps each SQLSTATE to (src/db/errors.ts). */
const TAXONOMY: Record<string, string> = { '40001': 'version_conflict', '22023': 'invalid_input', '42501': 'forbidden', P0002: 'not_found' };

/** Assert a promise fails with this SQLSTATE, as the db layer reports it. */
async function refused(p: Promise<unknown>, sqlState: keyof typeof TAXONOMY): Promise<any> {
  const error = await p.then(() => null, (e: unknown) => e as any);
  expect(error, `expected SQLSTATE ${sqlState}`).not.toBeNull();
  expect(error.code, error.message).toBe(TAXONOMY[sqlState]);
  expect(error.details?.sqlstate, error.message).toBe(sqlState);
  return error;
}

const entityVersion = async (id: string): Promise<number> =>
  (await ownerSql(`select version from public.entities where id = $1`, [id]))[0]!.version as number;

const resolve = (wanted: string[], identity = OWNER, spaceId = ids.space!) =>
  asCaller((q) => resolveHeaders(q, spaceId, wanted), identity);

beforeAll(async () => {
  database = await createW1ScratchDatabase('entity_headers');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await asOwner(async (c) => {
    await c.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger'), ($3, 'Nobody')`,
      [OWNER, STRANGER, NOBODY],
    );
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'eh-owner', 'Owner', false, true), ($2, 'eh-stranger', 'Stranger', false, false),
              ($3, 'eh-nobody', 'Nobody', false, false)`,
      [OWNER, STRANGER, NOBODY],
    );
    const s = ids.space = await space(c, 'Headers', OWNER);
    const other = ids.otherSpace = await space(c, 'Elsewhere', STRANGER);

    ids.doc = await doc(c, s, 'Design');
    ids.staleDoc = await doc(c, s, 'Living doc');
    ids.clearDoc = await doc(c, s, 'Clearable');
    ids.restricted = await doc(c, s, 'Restricted', { visibility: 'restricted' });
    ids.deleted = await doc(c, s, 'Deleted');
    ids.otherDoc = await doc(c, other, 'Other space');

    ids.teammate = await entity(c, s, 'team_member');
    await c.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, 'Draco', 'PTY engineer', 'Persona text.')`,
      [ids.teammate, ids[`member:${s}`]],
    );
    ids.file = await entity(c, s, 'file');
    await c.query(
      `insert into public.files(entity_id, name, mime_type, size_bytes, storage_path, checksum_sha256) values ($1, 'r.pdf', 'application/pdf', 10, $2, $3)`,
      [ids.file, `spaces/${s}/r-pdf`, 'a'.repeat(64)],
    );
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'SSO lands on 404')`, [ids.task]);

    ids.skill = await entity(c, s, 'skill');
    await c.query(
      `insert into public.skills(entity_id, space_id, name, description, content) values ($1, $2, 'deploy', 'Deploys things', 'BODY')`,
      [ids.skill, s],
    );
    ids.memory = await entity(c, s, 'memory');
    await c.query(
      `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish) values ($1, 'a claim', 'seed', 'scope', 'runtime')`,
      [ids.memory],
    );
    ids.session = await entity(c, s, 'work_session');
    ids.message = await entity(c, s, 'message');
    ids.member = ids[`member:${s}`]!;

    // Rows the doors would refuse to write, planted as the owner to prove the
    // READ side hides them: a restricted entity's, a deleted entity's, and
    // one on a skill (whose own header must win).
    for (const target of [ids.restricted, ids.deleted, ids.skill]) {
      await c.query(
        `insert into public.entity_headers(entity_id, space_id, when_to_use, summary, pinned_version, author_id)
         select id, space_id, 'PLANTED when', 'PLANTED summary', version, $2 from public.entities where id = $1`,
        [target, ids.member],
      );
    }
    await c.query(`update public.entities set deleted_at = now() where id = $1`, [ids.deleted]);
    await c.query(
      `insert into public.entity_headers(entity_id, space_id, summary, pinned_version, author_id)
       select id, space_id, 'OTHER summary', version, $2 from public.entities where id = $1`,
      [ids.otherDoc, ids[`member:${other}`]],
    );
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('set_entity_header / clear_entity_header', () => {
  it('writes a header without touching the entity version, and records an activity instead of an entity.upsert', async () => {
    const before = await entityVersion(ids.doc!);
    const seqBefore = (await ownerSql(`select coalesce(max(seq), 0)::bigint s from public.workspace_events where space_id = $1`, [ids.space]))[0]!.s;
    const result = await setHeader(ids.doc!, {
      expected: 0, whenToUse: '  Pick when designing headers  ', summary: 'The design.', keywords: [' design ', 'headers', 'design'],
    });
    expect(result.entity.id).toBe(ids.doc);
    expect(result.activity).toEqual(expect.any(String));
    expect(result.header).toMatchObject({
      entityId: ids.doc, whenToUse: 'Pick when designing headers', summary: 'The design.',
      keywords: ['design', 'headers'], version: 1, pinnedVersion: before, pinnedRef: null, authorId: ids.member,
    });
    expect(await entityVersion(ids.doc!)).toBe(before);

    const events = await ownerSql(
      `select event_type, payload from public.workspace_events where space_id = $1 and seq > $2 order by seq`, [ids.space, seqBefore],
    );
    expect(events.map((e) => e.event_type)).not.toContain('entity.upsert');
    expect(events.some((e) => e.event_type === 'activity.created')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Pick when designing headers');
    const activity = (await ownerSql(`select verb, summary from public.activity where id = $1`, [result.activity]))[0]!;
    expect(activity).toEqual({ verb: 'updated', summary: { kind: 'doc', fields: ['header'], header: 'set' } });

    // A second write bumps the header's own version only.
    const again = await setHeader(ids.doc!, { expected: 1, whenToUse: 'Pick when designing headers', summary: 'The design, v2.' });
    expect(again.header).toMatchObject({ version: 2, summary: 'The design, v2.', keywords: [] });
    expect(await entityVersion(ids.doc!)).toBe(before);
  });

  it('checks the header version, not the entity version', async () => {
    const conflict = await refused(setHeader(ids.doc!, { expected: 1, summary: 'x' }), '40001');
    expect(conflict.details).toMatchObject({ entityId: ids.doc, currentVersion: 2, subject: 'header' });
    await refused(setHeader(ids.task!, { expected: 3, summary: 'x' }), '40001');
    // Null skips the check, as assert_version does.
    expect((await setHeader(ids.task!, { summary: 'Authored task summary' })).header.version).toBe(1);
  });

  it('bounds text and keywords, and refuses an empty header', async () => {
    await refused(setHeader(ids.task!, { whenToUse: 'w'.repeat(401) }), '22023');
    await refused(setHeader(ids.task!, { summary: 's'.repeat(601) }), '22023');
    await refused(setHeader(ids.task!, { summary: '   ' }), '22023');
    await refused(setHeader(ids.task!, {}), '22023');
    await refused(setHeader(ids.task!, { summary: 'ok', keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) }), '22023');
    await refused(setHeader(ids.task!, { summary: 'ok', keywords: ['k'.repeat(41)] }), '22023');
    await refused(setHeader(ids.task!, { summary: 'ok', keywords: [' '] }), '22023');
    // Exactly at the bounds is fine; astral characters count once.
    const edge = await setHeader(ids.task!, {
      whenToUse: '😀'.repeat(400), summary: 's'.repeat(600), keywords: Array.from({ length: 12 }, (_, i) => `${'k'.repeat(38)}${i}`),
    });
    expect(edge.header.keywords).toHaveLength(12);
  });

  it('allows exactly the kinds resolveHeaders lets an authored row override', async () => {
    const allowed = await ownerSql(
      `select k, internal.header_kind_allowed(k) ok from unnest($1::text[]) k`, [[...SELECTION_HEADER_KINDS]],
    );
    for (const { k, ok } of allowed) expect(ok, k).toBe(k !== 'skill' && k !== 'memory');
    for (const refusedKind of [ids.skill!, ids.memory!, ids.session!, ids.message!, ids.member!]) {
      await refused(setHeader(refusedKind, { summary: 'nope' }), '22023');
    }
  });

  it('clears with the expected version, and only then', async () => {
    await refused(clearHeader(ids.clearDoc!, null), '22023');
    await refused(clearHeader(ids.clearDoc!, 1), 'P0002');
    await setHeader(ids.clearDoc!, { summary: 'Soon gone' });
    await refused(clearHeader(ids.clearDoc!, 2), '40001');
    const result = await clearHeader(ids.clearDoc!, 1);
    expect(result.entity.id).toBe(ids.clearDoc);
    expect((await ownerSql(`select 1 from public.entity_headers where entity_id = $1`, [ids.clearDoc])).length).toBe(0);
    expect((await resolve([ids.clearDoc!])).get(ids.clearDoc!)).toMatchObject({ source: 'derived', summary: 'First paragraph. Sections: Clearable' });
    // A fresh header after a clear starts again at version 1.
    expect((await setHeader(ids.clearDoc!, { expected: 0, summary: 'Back' })).header.version).toBe(1);
  });

  it('replays an idempotent write from the ledger', async () => {
    const first = await setHeader(ids.file!, { summary: 'Replayed', cmid: 'eh-replay-1' });
    const second = await setHeader(ids.file!, { summary: 'Replayed', cmid: 'eh-replay-1' });
    expect(second).toEqual(first);
    expect((await ownerSql(`select version from public.entity_headers where entity_id = $1`, [ids.file]))[0]!.version).toBe(1);
  });
});

describe('RLS', () => {
  it('another space, a restricted entity, a deleted one and a non-member see no header', async () => {
    const visible = async (identity: string) => asCaller(async (q) =>
      (await q.query<{ id: string }>(`select entity_id::text id from public.entity_headers`)).map((row) => row.id), identity);
    const mine = await visible(OWNER);
    expect(mine).toContain(ids.doc);
    for (const hidden of [ids.restricted, ids.deleted, ids.otherDoc]) expect(mine).not.toContain(hidden);
    expect(await visible(STRANGER)).toEqual([ids.otherDoc]);
    expect(await visible(NOBODY)).toEqual([]);

    const got = await resolve([ids.doc!, ids.restricted!, ids.deleted!, ids.otherDoc!]);
    expect([...got.keys()]).toEqual([ids.doc]);
    expect((await resolve([ids.otherDoc!], OWNER, ids.otherSpace!)).size).toBe(0);
    expect((await resolve([ids.doc!], NOBODY)).size).toBe(0);
  });

  it('refuses writers who cannot patch the entity', async () => {
    await refused(setHeader(ids.doc!, { summary: 'stranger' }, STRANGER), '42501');
    await refused(setHeader(ids.doc!, { summary: 'nobody' }, NOBODY), '42501');
    await refused(clearHeader(ids.doc!, 2, STRANGER), '42501');
    await refused(setHeader(ids.restricted!, { summary: 'restricted' }), 'P0002');
    await refused(setHeader(ids.deleted!, { summary: 'deleted' }), 'P0002');
  });

  it('tm8_app has no direct write', async () => {
    for (const statement of [
      `insert into public.entity_headers(entity_id, space_id, summary, pinned_version, author_id) values ('${ids.task}', '${ids.space}', 'x', 1, '${ids.member}')`,
      `update public.entity_headers set summary = 'x'`,
      `delete from public.entity_headers`,
    ]) {
      await refused(asCaller((q) => q.query(statement)), '42501');
    }
  });
});

describe('resolveHeaders: authored ?? derived, with stale', () => {
  it('prefers the authored fields, per field, and marks the source', async () => {
    await setHeader(ids.teammate!, { whenToUse: 'Pick me for PTY work', keywords: ['pty'] });
    const got = await resolve([ids.doc!, ids.teammate!, ids.task!]);
    expect(got.get(ids.doc!)).toMatchObject({
      kind: 'doc', name: 'Design', whenToUse: 'Pick when designing headers', summary: 'The design, v2.', source: 'authored', stale: false,
    });
    // An authored whenToUse with no summary still gets the derived summary.
    expect(got.get(ids.teammate!)).toMatchObject({
      whenToUse: 'Pick me for PTY work', summary: 'Persona text.', keywords: ['pty'], source: 'authored', stale: false,
    });
    expect(got.get(ids.task!)).toMatchObject({ source: 'authored', stale: false });
  });

  it('never lets a row override a skill or a memory', async () => {
    const got = await resolve([ids.skill!, ids.memory!]);
    expect(got.get(ids.skill!)).toMatchObject({ whenToUse: 'Deploys things', summary: 'Deploys things', source: 'native', stale: false });
    expect(got.get(ids.memory!)).toMatchObject({ whenToUse: 'scope', summary: 'a claim', source: 'native' });
  });

  it('flags a header stale after a body edit, still uses its text, and re-pins on re-save', async () => {
    await setHeader(ids.staleDoc!, { summary: 'Written for v1' });
    expect((await resolve([ids.staleDoc!])).get(ids.staleDoc!)).toMatchObject({ source: 'authored', stale: false });

    const version = await entityVersion(ids.staleDoc!);
    await asCaller((q) => q.query(`select public.update_document($1, $2, null, null, $3, null, null)`, [ids.staleDoc, version, '# Living doc\n\nRewritten.\n']));
    expect(await entityVersion(ids.staleDoc!)).toBeGreaterThan(version);
    expect((await resolve([ids.staleDoc!])).get(ids.staleDoc!)).toMatchObject({ summary: 'Written for v1', source: 'authored', stale: true });

    // "Mark current": the same text, re-saved, re-pins.
    await setHeader(ids.staleDoc!, { expected: 1, summary: 'Written for v1' });
    expect((await resolve([ids.staleDoc!])).get(ids.staleDoc!)).toMatchObject({ stale: false });
  });

  it('flags a file header stale when its checksum changes, even with no version bump', async () => {
    expect((await resolve([ids.file!])).get(ids.file!)).toMatchObject({ summary: 'Replayed', stale: false });
    await asOwner(async (c) => {
      await c.query(`update public.files set checksum_sha256 = $2 where entity_id = $1`, [ids.file, 'b'.repeat(64)]);
      // Isolate the ref: line the pinned version up with whatever the update did to the entity.
      await c.query(`update public.entity_headers h set pinned_version = e.version from public.entities e where e.id = h.entity_id and h.entity_id = $1`, [ids.file]);
    });
    expect((await resolve([ids.file!])).get(ids.file!)).toMatchObject({ source: 'authored', stale: true });
  });
});
