/**
 * Headers T1 (integrated plan I1): golden byte parity for Ask Jev's candidate
 * text, against a REAL PostgreSQL as `tm8_app` under the caller's claims.
 *
 *   · `loadTeammates` / `loadMemories` / `loadSkills` now build their text as
 *     `jevText(resolveHeaders(ids))`. For every kind, and for the edge cases
 *     each old snippet handled (blank role, whitespace persona, empty skill
 *     description, astral characters on the 600 cut, …), the whole candidate
 *     set — ids, order, titles, text, sources, considered, total — equals the
 *     frozen pre-header loaders (`jev-candidates-legacy.ts`) byte for byte;
 *   · a handful of texts are also pinned as literals, so a change to BOTH
 *     sides still fails;
 *   · `resolveHeaders` reads under RLS: another space's entity, a restricted
 *     one, a deleted one and a kind with no header are all absent;
 *   · derived headers for the reference kinds (doc, task, file, collection,
 *     drawing) and `bytes` / `loadPointer` / `source`.
 */
import type { SelectionHeader } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { DbClaims, Db, Querier } from '../../src/db/types.js';
import { resolveHeaders } from '../../src/headers/resolve.js';
import { loadMemories, loadSkills, loadTeammates } from '../../src/jev/candidates.js';
import { legacyLoadMemories, legacyLoadSkills, legacyLoadTeammates } from './jev-candidates-legacy.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'headers-owner';
const STRANGER = 'headers-stranger';
/** 599 ASCII characters then an astral emoji: the 600th code point is the emoji, the 600th UTF-16 unit is half of it. */
const ASTRAL_EDGE = `${'a'.repeat(599)}😀tail`;
const MULTIBYTE = `Ünïcödé — 日本語 ${'ß'.repeat(700)}`;

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function entity(client: Client, space: string, kind: string, opts: { parent?: string; visibility?: string; updatedAt?: string; deleted?: boolean } = {}): Promise<string> {
  const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(
    `insert into public.entities(id, space_id, kind, parent_id, position, created_by, visibility, updated_at)
     values ($1, $2, $3, $4, 0, $5, $6, coalesce($7::timestamptz, now()))`,
    [id, space, kind, opts.parent ?? null, ids[`member:${space}`] ?? id, opts.visibility ?? 'space', opts.updatedAt ?? null],
  );
  return id;
}

async function edge(client: Client, space: string, src: string, dst: string, type: string): Promise<void> {
  const props = type === 'supersedes' ? { reason: 'measured again' } : {};
  await client.query(
    `insert into public.edges(space_id, src_id, dst_id, type, props, created_by) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [space, src, dst, type, JSON.stringify(props), ids[`member:${space}`]],
  );
}

async function memory(client: Client, space: string, statement: string, opts: { visibility?: string; scope?: string } = {}): Promise<string> {
  const id = await entity(client, space, 'memory', opts);
  await client.query(
    `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish)
     values ($1, $2, 'seed', $3, 'runtime')`,
    [id, statement, opts.scope ?? 'scratch'],
  );
  return id;
}

async function skill(
  client: Client, space: string, name: string,
  opts: { description?: string; whenToUse?: unknown; content?: string; missing?: boolean } = {},
): Promise<string> {
  const id = await entity(client, space, 'skill');
  const frontmatter = opts.whenToUse === undefined ? {} : { when_to_use: opts.whenToUse };
  await client.query(
    `insert into public.skills(entity_id, space_id, name, description, content, source_path, missing, frontmatter)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [id, space, name, opts.description === undefined ? `${name} does a thing` : opts.description, opts.content ?? 'BODY',
      opts.missing ? `/gone/${name}/SKILL.md` : null, opts.missing === true, JSON.stringify(frontmatter)],
  );
  return id;
}

async function teammate(client: Client, space: string, name: string, role: string, persona: string, parent?: string): Promise<string> {
  const id = await entity(client, space, 'team_member', parent ? { parent } : {});
  await client.query(
    `insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, $3, $4, $5)`,
    [id, ids[`member:${space}`], name, role, persona],
  );
  return id;
}

async function space(client: Client, key: string, identity: string): Promise<string> {
  const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, key, identity]);
  const member = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
  await client.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`,
    [member, id, identity],
  );
  ids[`member:${id}`] = member;
  return id;
}

const claims = (identityId = OWNER): DbClaims => ({ identityId, nodeAdmin: false, requestId: 'headers-parity' });
const asCaller = <T>(fn: (q: Querier) => Promise<T>, identityId = OWNER): Promise<T> => db.tx(claims(identityId), fn);

beforeAll(async () => {
  database = await createW1ScratchDatabase('headers_parity');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await asOwner(async (c) => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`, [OWNER, STRANGER]);
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'headers-owner', 'Owner', false, true), ($2, 'headers-stranger', 'Stranger', false, false)`,
      [OWNER, STRANGER],
    );
    const s = ids.space = await space(c, 'Headers', OWNER);
    const other = ids.otherSpace = await space(c, 'Elsewhere', STRANGER);

    // Teammates: every branch of "name — role. Equipped with: … persona(600)".
    ids.lead = await teammate(c, s, 'Lead', 'Architect', 'Parent persona.');
    ids.draco = await teammate(c, s, 'Draco', '  PTY engineer  ', `  You own the terminal seam. ${'p'.repeat(1000)}`, ids.lead);
    ids.noRole = await teammate(c, s, 'Nora', '', 'Persona with no role.');
    ids.blankRole = await teammate(c, s, 'Blanca', '   ', '');
    ids.blankPersona = await teammate(c, s, 'Wes', 'Reviewer', ' \n\t ');
    ids.astral = await teammate(c, s, 'Astra', 'Emoji edge', ASTRAL_EDGE);
    ids.multibyte = await teammate(c, s, 'Mübyte', `Rôle ${'r'.repeat(900)}`, MULTIBYTE);

    // Memories: long, astral cut, whitespace-heavy title, superseded, restricted.
    ids.task = await entity(c, s, 'task');
    await c.query(`insert into public.tasks(entity_id, title, description) values ($1, 'Fix login', 'SSO lands on 404')`, [ids.task]);
    ids.mWorking = await memory(c, s, `working set: ${'x'.repeat(1000)}`);
    await edge(c, s, ids.draco, ids.mWorking, 'remembers');
    ids.mTask = await memory(c, s, 'task memory');
    await edge(c, s, ids.task, ids.mTask, 'remembers');
    ids.mAstral = await memory(c, s, ASTRAL_EDGE);
    ids.mSpaces = await memory(c, s, `   leading\n\n  and   inner\twhitespace ${'w '.repeat(400)}`);
    ids.mMulti = await memory(c, s, MULTIBYTE);
    ids.mOld = await memory(c, s, 'stale claim');
    ids.mNew = await memory(c, s, 'current claim');
    await edge(c, s, ids.mNew, ids.mOld, 'supersedes');
    ids.mHidden = await memory(c, s, 'HIDDEN restricted memory', { visibility: 'restricted' });

    // Skills: description, empty description → when_to_use, neither, whitespace, long, missing.
    ids.sEquipped = await skill(c, s, 'deploy-runbook');
    await edge(c, s, ids.draco, ids.sEquipped, 'equips');
    ids.sInherited = await skill(c, s, 'design-review', { whenToUse: 'ignored: description wins' });
    await edge(c, s, ids.lead, ids.sInherited, 'equips');
    ids.sWhen = await skill(c, s, 'when-only', { description: '', whenToUse: `Use when ${'q'.repeat(700)}` });
    ids.sBare = await skill(c, s, 'bare', { description: '' });
    ids.sEmptyWhen = await skill(c, s, 'empty-when', { description: '', whenToUse: '' });
    ids.sSpace = await skill(c, s, 'spacey', { description: ' ' });
    ids.sNumeric = await skill(c, s, 'numeric-when', { description: '', whenToUse: 42 });
    ids.sLong = await skill(c, s, 'long', { description: ASTRAL_EDGE, content: 'X'.repeat(5000) });
    ids.sMissing = await skill(c, s, 'vanished', { missing: true, content: '' });

    // Reference kinds, for the derived headers.
    ids.doc = await entity(c, s, 'doc');
    await c.query(
      `insert into public.documents(entity_id, title, body) values ($1, 'Design', $2)`,
      [ids.doc, '# Design\n\nThe first   paragraph\nwraps here.\n\nSecond paragraph.\n\n## Goals\n\ntext\n\n### Non-goals  \n'],
    );
    ids.file = await entity(c, s, 'file');
    await c.query(
      `insert into public.files(entity_id, name, mime_type, size_bytes, storage_path) values ($1, 'report.pdf', 'application/pdf', 2048, $2)`,
      [ids.file, `spaces/${s}/report-pdf`],
    );
    ids.collection = await entity(c, s, 'collection');
    await c.query(`insert into public.collections(entity_id, name, description) values ($1, 'Runbooks', 'Pick when operating prod')`, [ids.collection]);
    await edge(c, s, ids.collection, ids.doc, 'contains');
    await edge(c, s, ids.collection, ids.file, 'contains');
    await edge(c, s, ids.collection, ids.task, 'contains');
    ids.drawing = await entity(c, s, 'drawing');
    await c.query(
      `insert into public.drawings(entity_id, title, elements) values ($1, 'Flow', $2::jsonb)`,
      [ids.drawing, JSON.stringify([
        { type: 'text', text: 'Client' }, { type: 'rectangle' }, { type: 'text', text: 'gone', isDeleted: true }, { type: 'text', text: 'Server\nside' },
      ])],
    );

    // Absent from any resolve: another space, deleted, a kind with no header.
    ids.otherMemory = await memory(c, other, 'another space');
    ids.deletedMemory = await memory(c, s, 'deleted memory');
    await c.query(`update public.entities set deleted_at = now() where id = $1`, [ids.deletedMemory]);
    ids.session = await entity(c, s, 'work_session');
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('golden: Jev candidate text is byte-identical to the pre-header loaders', () => {
  it('teammates', async () => {
    const [now, before] = await asCaller(async (q) => [await loadTeammates(q, ids.space!), await legacyLoadTeammates(q, ids.space!)]);
    expect(now.items.length).toBeGreaterThanOrEqual(7);
    expect(now).toEqual(before);
    for (let i = 0; i < now.items.length; i += 1) expect(Buffer.from(now.items[i]!.text)).toEqual(Buffer.from(before.items[i]!.text));
  });

  it('memories', async () => {
    const [now, before] = await asCaller(async (q) => [
      await loadMemories(q, ids.space!, ids.draco!, ids.task!),
      await legacyLoadMemories(q, ids.space!, ids.draco!, ids.task!),
    ]);
    expect(now.items.length).toBeGreaterThanOrEqual(6);
    expect(now).toEqual(before);
    for (let i = 0; i < now.items.length; i += 1) {
      expect(Buffer.from(now.items[i]!.text)).toEqual(Buffer.from(before.items[i]!.text));
      expect(Buffer.from(now.items[i]!.title)).toEqual(Buffer.from(before.items[i]!.title));
    }
  });

  it('memories with no task', async () => {
    const [now, before] = await asCaller(async (q) => [
      await loadMemories(q, ids.space!, ids.draco!, null),
      await legacyLoadMemories(q, ids.space!, ids.draco!, null),
    ]);
    expect(now).toEqual(before);
  });

  it('skills', async () => {
    for (const teammate of [ids.draco!, ids.noRole!]) {
      const [now, before] = await asCaller(async (q) => [await loadSkills(q, ids.space!, teammate), await legacyLoadSkills(q, ids.space!, teammate)]);
      expect(now.items.length).toBeGreaterThanOrEqual(8);
      expect(now).toEqual(before);
      for (let i = 0; i < now.items.length; i += 1) expect(Buffer.from(now.items[i]!.text)).toEqual(Buffer.from(before.items[i]!.text));
    }
  });

  it('pinned literals', async () => {
    const [teammates, memories, skills] = await asCaller(async (q) => [
      await loadTeammates(q, ids.space!),
      await loadMemories(q, ids.space!, ids.draco!, ids.task!),
      await loadSkills(q, ids.space!, ids.draco!),
    ]);
    const text = (set: { items: Array<{ entityId: string; text: string }> }, id: string) => set.items.find((item) => item.entityId === id)?.text;
    expect(text(teammates, ids.draco!)).toBe(
      `Draco — PTY engineer. Equipped with: deploy-runbook, design-review. ${`  You own the terminal seam. ${'p'.repeat(1000)}`.slice(0, 600)}`,
    );
    expect(text(teammates, ids.noRole!)).toBe('Nora. Persona with no role.');
    expect(text(teammates, ids.blankRole!)).toBe('Blanca.');
    expect(text(teammates, ids.blankPersona!)).toBe('Wes — Reviewer.');
    expect(text(teammates, ids.astral!)).toBe(`Astra — Emoji edge. ${'a'.repeat(599)}😀`);
    expect(text(memories, ids.mTask!)).toBe('task memory');
    expect(text(memories, ids.mAstral!)).toBe(`${'a'.repeat(599)}😀`);
    expect(text(skills, ids.sEquipped!)).toBe('deploy-runbook: deploy-runbook does a thing');
    expect(text(skills, ids.sInherited!)).toBe('design-review: design-review does a thing');
    expect(text(skills, ids.sWhen!)).toBe(`when-only: ${`Use when ${'q'.repeat(700)}`.slice(0, 600)}`);
    expect(text(skills, ids.sBare!)).toBe('bare');
    expect(text(skills, ids.sEmptyWhen!)).toBe('empty-when');
    expect(text(skills, ids.sSpace!)).toBe('spacey:  ');
    expect(text(skills, ids.sNumeric!)).toBe('numeric-when: 42');
    expect(skills.items.some((item) => item.entityId === ids.sMissing)).toBe(false);
    expect(memories.items.some((item) => item.entityId === ids.mOld || item.entityId === ids.mHidden)).toBe(false);
  });
});

describe('resolveHeaders', () => {
  const resolve = (wanted: string[], identity = OWNER, spaceId = ids.space!) =>
    asCaller((q) => resolveHeaders(q, spaceId, wanted), identity);

  it('reads under RLS: other space, restricted, deleted, superseded-agnostic, and header-less kinds', async () => {
    const got = await resolve([ids.mTask!, ids.mHidden!, ids.otherMemory!, ids.deletedMemory!, ids.session!, ids.mOld!]);
    expect([...got.keys()].sort()).toEqual([ids.mTask!, ids.mOld!].sort());
    // A caller with no membership reads nothing at all.
    expect((await resolve([ids.mTask!, ids.draco!, ids.doc!], STRANGER)).size).toBe(0);
    expect((await resolve([])).size).toBe(0);
  });

  it('native headers: skills and memories', async () => {
    const got = await resolve([ids.sInherited!, ids.sWhen!, ids.sBare!, ids.sLong!, ids.mTask!]);
    expect(got.get(ids.sInherited!)).toEqual<SelectionHeader>({
      entityId: ids.sInherited!, kind: 'skill', name: 'design-review',
      whenToUse: 'ignored: description wins', summary: 'design-review does a thing', keywords: [],
      source: 'native', stale: false, bytes: 4, loadPointer: `tm8 entity context ${ids.sInherited}`,
    });
    expect(got.get(ids.sWhen!)).toMatchObject({ summary: null, source: 'native' });
    expect([...got.get(ids.sWhen!)!.whenToUse!]).toHaveLength(600);
    expect(got.get(ids.sBare!)).toMatchObject({ whenToUse: null, summary: null, source: 'derived' });
    expect(got.get(ids.sLong!)).toMatchObject({ bytes: 5000 });
    expect(got.get(ids.mTask!)).toMatchObject({
      kind: 'memory', name: 'task memory', whenToUse: 'scratch', summary: 'task memory', source: 'native', bytes: 11,
    });
  });

  it('derived headers: teammates and the reference kinds', async () => {
    const got = await resolve([ids.draco!, ids.blankRole!, ids.doc!, ids.task!, ids.file!, ids.collection!, ids.drawing!]);
    expect(got.get(ids.draco!)).toMatchObject({ kind: 'team_member', name: 'Draco', whenToUse: 'PTY engineer', source: 'derived' });
    expect([...got.get(ids.draco!)!.summary!]).toHaveLength(600);
    expect(got.get(ids.draco!)!.bytes).toBe(Buffer.byteLength(`  You own the terminal seam. ${'p'.repeat(1000)}`));
    expect(got.get(ids.blankRole!)).toMatchObject({ whenToUse: null, summary: null });
    expect(got.get(ids.doc!)).toMatchObject({
      kind: 'doc', name: 'Design', whenToUse: null,
      summary: 'The first paragraph wraps here. Sections: Design · Goals · Non-goals', source: 'derived',
    });
    expect(got.get(ids.task!)).toMatchObject({ kind: 'task', name: 'Fix login', summary: 'SSO lands on 404', bytes: 16 });
    expect(got.get(ids.file!)).toMatchObject({ kind: 'file', name: 'report.pdf', summary: 'report.pdf · application/pdf · 2.0 KiB', bytes: 2048 });
    expect(got.get(ids.collection!)).toMatchObject({
      kind: 'collection', name: 'Runbooks', whenToUse: 'Pick when operating prod', summary: 'Contains 1 doc, 1 file, 1 task', bytes: null,
    });
    expect(got.get(ids.drawing!)).toMatchObject({ kind: 'drawing', name: 'Flow', summary: 'Client Server side' });
    for (const header of got.values()) {
      expect(header.loadPointer).toBe(`tm8 entity context ${header.entityId}`);
      expect(header.stale).toBe(false);
      expect(header.keywords).toEqual([]);
    }
  });
});
