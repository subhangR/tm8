/**
 * Migration 284 — styles: personal styles, push / pull / remove, prefs and the
 * space default, at the RPC layer under real claims (styles spec 01a0fc22 v8
 * §3, §4, §7, §14 "Server").
 *
 * Three identities: A (owner of space S), B (plain member of S) and C (member
 * of space T only). Every rule is asserted from the side that must be REFUSED
 * as well as the side that must succeed, because a permission test that only
 * proves the happy path proves nothing about the permission.
 *
 * Covers the task's acceptance criteria at the data layer:
 *   a0 — CRUD of personal styles and the space style lifecycle;
 *   a1 — prefs persist per identity, and the per-member events that make other
 *        tabs follow are addressed to that person only;
 *   a2 — an identity with no prefs row reads the space default.
 * And the two snapshot rules accepted with the push-time refresh: a push
 * refreshes the snapshot of viewers still in the space; a remove does not.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError } from '@tm8/contract';
import type {
  PersonalStyleView,
  SpaceStyleDefaultView,
  SpaceStyleView,
  StylePrefsGetResult,
  StylePrefsView,
  StylesListResult,
} from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceS: string;
  spaceT: string;
  identityA: string;
  identityB: string;
  identityC: string;
  memberAS: string;
  memberBS: string;
  memberCT: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;

function as<T>(identityId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.tx({ identityId, authKind: 'browser', requestId: `styles-${randomUUID()}` } as DbClaims, fn);
}

/** The taxonomy code an awaited call failed with, or 'ok'. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof CollabError) return err.code;
    throw err;
  }
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Record<string, string>>(
      `select internal.new_id()::text "spaceS", internal.new_id()::text "spaceT",
              internal.new_id()::text "memberAS", internal.new_id()::text "memberBS",
              internal.new_id()::text "memberCT"`,
    )).rows[0]!;
    const f: Fixture = {
      spaceS: ids.spaceS!, spaceT: ids.spaceT!,
      identityA: 'styles-a', identityB: 'styles-b', identityC: 'styles-c',
      memberAS: ids.memberAS!, memberBS: ids.memberBS!, memberCT: ids.memberCT!,
    };
    for (const [identity, name] of [[f.identityA, 'Ana'], [f.identityB, 'Ben'], [f.identityC, 'Cy']] as const) {
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $2)`, [identity, name]);
    }
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Styles S', $2)`,
      [f.spaceS, f.identityA]);
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Styles T', $2)`,
      [f.spaceT, f.identityC]);
    const members: Array<[string, string, string, string]> = [
      [f.memberAS, f.spaceS, f.identityA, 'owner'],
      [f.memberBS, f.spaceS, f.identityB, 'member'],
      [f.memberCT, f.spaceT, f.identityC, 'owner'],
    ];
    for (const [member, space, identity, role] of members) {
      await client.query(
        `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
         values ($1, $2, 'member', null, 0, $1)`, [member, space]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, $4, $3)`, [member, space, identity, role]);
    }
    return f;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('styles');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

let cmidCounter = 0;
const cmid = (): string => `styles-test-${++cmidCounter}-${randomUUID()}`;

function createPersonal(identity: string, title: string, vars: Record<string, string>): Promise<PersonalStyleView> {
  return as(identity, async (q) => (await q.rpc<{ style: PersonalStyleView }>('create_personal_style', [
    title, 'builtin:atelier-dark', null, JSON.stringify(vars), null, ['test'], 'sha256:test', cmid(),
  ])).style);
}

function updatePersonal(identity: string, style: PersonalStyleView, vars: Record<string, string>, expected = style.version) {
  return as(identity, async (q) => (await q.rpc<{ style: PersonalStyleView }>('update_personal_style', [
    style.id, expected, style.title, style.description, style.doc.foundation,
    JSON.stringify(vars), null, style.tags, 'sha256:test2', cmid(),
  ])).style);
}

function push(identity: string, personalId: string, space: string, target: string | null, expected: number | null) {
  return as(identity, async (q) => (await q.rpc<{ style: SpaceStyleView; created: boolean }>('push_style', [
    personalId, space, target, expected, null, null, null, cmid(),
  ])));
}

function setPrefs(identity: string, current: string, dark: string | null = null) {
  return as(identity, async (q) => (await q.rpc<{ prefs: StylePrefsView }>('set_identity_style_prefs', [
    current, dark, false, [], null, cmid(),
  ])).prefs);
}

function prefsOf(identity: string) {
  return as(identity, (q) => q.rpc<StylePrefsGetResult>('get_identity_style_prefs'));
}

/** Every event of one type, with who it was addressed to (graph-owner read). */
async function eventsOf(type: string): Promise<Array<{ recipient: string | null; payload: Record<string, unknown> }>> {
  return database.query<{ recipient: string | null; payload: Record<string, unknown> }>(
    `select recipient_member_id::text recipient, payload from public.workspace_events
      where event_type = $1 order by space_id, seq`, [type]);
}

// ---------------------------------------------------------------------------

describe('284 personal styles (a0): owner-only CRUD', () => {
  it('the owner creates, reads and lists; another identity gets not_found, never the row', async () => {
    const mine = await createPersonal(fixture.identityA, 'Midnight (draft)', { '--pn-brand': '#4F7DF3' });
    expect(mine.ref).toBe(`personal:${mine.id}`);
    expect(mine.version).toBe(1);
    expect(mine.doc).toEqual({ schemaVersion: 1, foundation: 'builtin:atelier-dark', vars: { '--pn-brand': '#4F7DF3' }, css: null });

    const listA = await as(fixture.identityA, (q) => q.rpc<{ items: Array<{ id: string }> }>('list_personal_styles'));
    expect(listA.items.map((i) => i.id)).toContain(mine.id);

    expect(await outcome(() => as(fixture.identityB, (q) => q.rpc('get_personal_style', [mine.id])))).toBe('not_found');
    const listB = await as(fixture.identityB, (q) => q.rpc<{ items: Array<{ id: string }> }>('list_personal_styles'));
    expect(listB.items.map((i) => i.id)).not.toContain(mine.id);
    // RLS on the table itself, not only the doors: B's direct select sees nothing.
    const direct = await as(fixture.identityB, (q) => q.query<{ id: string }>(
      'select id::text from public.personal_styles where id = $1', [mine.id]));
    expect(direct).toEqual([]);
  });

  it('update needs the current version: a stale one is version_conflict with currentVersion', async () => {
    const style = await createPersonal(fixture.identityA, 'Versioned', { '--pn-brand': '#111111' });
    const v2 = await updatePersonal(fixture.identityA, style, { '--pn-brand': '#222222' });
    expect(v2.version).toBe(2);
    let details: Record<string, unknown> | undefined;
    try {
      await updatePersonal(fixture.identityA, style, { '--pn-brand': '#333333' }, 1);
    } catch (err) {
      expect(err).toBeInstanceOf(CollabError);
      expect((err as CollabError).code).toBe('version_conflict');
      details = (err as CollabError).details as Record<string, unknown>;
    }
    expect(details?.currentVersion).toBe(2);
    // Another identity cannot update or delete it either — not found, not forbidden.
    expect(await outcome(() => updatePersonal(fixture.identityB, v2, {}))).toBe('not_found');
    expect(await outcome(() => as(fixture.identityB, (q) => q.rpc('delete_personal_style', [style.id, null, cmid()]))))
      .toBe('not_found');
  });

  it('the storage layer refuses a variable that is not a --pn-* string', async () => {
    expect(await outcome(() => createPersonal(fixture.identityA, 'Bad key', { color: 'red' }))).toBe('invalid_input');
  });

  it('caps an identity at 100 personal styles', async () => {
    const identity = 'styles-capped';
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Cap')`, [identity]);
      await client.query(
        `insert into public.personal_styles(owner_identity_id, title, foundation)
         select $1, 'Style ' || n, 'builtin:atelier-light' from generate_series(1, 100) n`, [identity]);
    });
    expect(await outcome(() => createPersonal(identity, 'One too many', {}))).toBe('limit_exceeded');
  });

  it('personal_style.updated reaches the owner\'s memberships only', async () => {
    const style = await createPersonal(fixture.identityA, 'Evented', {});
    const rows = (await eventsOf('personal_style.updated')).filter((r) => r.payload.id === style.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.recipient).toBe(fixture.memberAS);
    expect(rows[0]!.payload).toMatchObject({ type: 'personal_style.updated', id: style.id, version: 1, deleted: false });

    await as(fixture.identityA, (q) => q.rpc('delete_personal_style', [style.id, 1, cmid()]));
    const deleted = (await eventsOf('personal_style.updated'))
      .filter((r) => r.payload.id === style.id && r.payload.deleted === true);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.payload.doc).toBeNull();
    expect(deleted[0]!.recipient).toBe(fixture.memberAS);
  });
});

describe('284 space styles (a0): push, pull, remove', () => {
  let spaceStyleId: string;

  it('a first push creates a read-only style entity carrying the document', async () => {
    const personal = await createPersonal(fixture.identityA, 'Midnight', { '--pn-paper': '#0F1320' });
    const first = await push(fixture.identityA, personal.id, fixture.spaceS, null, null);
    expect(first.created).toBe(true);
    spaceStyleId = first.style.id;
    expect(first.style).toMatchObject({
      ref: `space:${spaceStyleId}`, spaceId: fixture.spaceS, version: 1, title: 'Midnight',
      pushedBy: fixture.memberAS, sourceOwnerIdentityId: fixture.identityA,
    });
    expect(first.style.doc.vars).toEqual({ '--pn-paper': '#0F1320' });

    const [envelope] = await database.query<{ kind: string; visibility: string }>(
      'select kind, visibility from public.entities where id = $1', [spaceStyleId]);
    expect(envelope).toEqual({ kind: 'style', visibility: 'space' });
    const [content] = await database.query<{ content: Record<string, unknown> }>(
      'select internal.entity_content($1) content', [spaceStyleId]);
    expect(content!.content).toMatchObject({ title: 'Midnight', foundation: 'builtin:atelier-dark', vars: { '--pn-paper': '#0F1320' } });

    const mine = await as(fixture.identityA, (q) => q.rpc<PersonalStyleView>('get_personal_style', [personal.id]));
    expect(mine.publishedAs).toBe(spaceStyleId);
    // The entity row's own capture trigger announced it to the space.
    const upserts = await database.query<{ n: string }>(
      `select count(*)::text n from public.workspace_events
        where event_type = 'entity.upsert' and payload ->> 'id' = $1`, [spaceStyleId]);
    expect(Number(upserts[0]!.n)).toBeGreaterThan(0);
  });

  it('any ACTIVE MEMBER may push a new version (pull, edit, push --to); pushed_by and history record it', async () => {
    const pulled = await as(fixture.identityB, async (q) =>
      (await q.rpc<{ style: PersonalStyleView }>('pull_style', [spaceStyleId, 'Midnight (Ben)', cmid()])).style);
    expect(pulled.pulledFrom).toEqual({ id: spaceStyleId, version: 1, upstreamVersion: 1 });
    expect(pulled.doc.vars).toEqual({ '--pn-paper': '#0F1320' });

    const edited = await updatePersonal(fixture.identityB, pulled, { '--pn-paper': '#101010' });
    const second = await push(fixture.identityB, edited.id, fixture.spaceS, spaceStyleId, 1);
    expect(second.created).toBe(false);
    expect(second.style.version).toBe(2);
    expect(second.style.pushedBy).toBe(fixture.memberBS);
    expect(second.style.doc.vars).toEqual({ '--pn-paper': '#101010' });
    // The FIRST source survives a push from someone else's copy.
    expect(second.style.sourceOwnerIdentityId).toBe(fixture.identityA);

    const history = await database.query<{ version: number; changed_by: string }>(
      'select version, changed_by::text from public.entity_versions where entity_id = $1 order by version', [spaceStyleId]);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history[1]!.changed_by).toBe(fixture.memberBS);
  });

  it('a stale expectedVersion on push is version_conflict', async () => {
    const personal = await createPersonal(fixture.identityB, 'Racer', {});
    expect(await outcome(() => push(fixture.identityB, personal.id, fixture.spaceS, spaceStyleId, 1))).toBe('version_conflict');
  });

  it('a non-member cannot push, pull or read it', async () => {
    const outsider = await createPersonal(fixture.identityC, 'Outsider', {});
    expect(await outcome(() => push(fixture.identityC, outsider.id, fixture.spaceS, null, null))).toBe('forbidden');
    expect(await outcome(() => push(fixture.identityC, outsider.id, fixture.spaceS, spaceStyleId, null))).toBe('forbidden');
    expect(await outcome(() => as(fixture.identityC, (q) => q.rpc('pull_style', [spaceStyleId, null, cmid()]))))
      .toBe('forbidden');
    expect(await outcome(() => as(fixture.identityC, (q) => q.rpc('get_space_style', [spaceStyleId])))).toBe('not_found');
  });

  it('nobody pushes someone else\'s personal style', async () => {
    const anas = await createPersonal(fixture.identityA, 'Ana only', {});
    expect(await outcome(() => push(fixture.identityB, anas.id, fixture.spaceS, null, null))).toBe('not_found');
  });

  it('the generic delete door refuses a style', async () => {
    expect(await outcome(() => as(fixture.identityA, (q) => q.rpc('delete_entity', [spaceStyleId, null, cmid()]))))
      .toBe('forbidden');
  });

  it('styles.list shows it to members with isDefault / inUseByMe / canPush', async () => {
    const listed = await as(fixture.identityB, (q) => q.rpc<StylesListResult>('list_space_styles', [fixture.spaceS]));
    const row = listed.items.find((i) => i.id === spaceStyleId);
    expect(row).toMatchObject({ origin: 'space', ref: `space:${spaceStyleId}`, canPush: true, isDefault: false });
    expect(listed.defaultStyle).toBe('builtin:atelier-light');
    expect(await outcome(() => as(fixture.identityC, (q) => q.rpc('list_space_styles', [fixture.spaceS]))))
      .toBe('forbidden');
  });
});

describe('284 prefs (a1) and the snapshot rules', () => {
  let styleId: string;
  let personalId: string;

  it('set prefs verifies readability, writes the snapshot, and is isolated per identity', async () => {
    const personal = await createPersonal(fixture.identityA, 'Shared', { '--pn-brand': '#AA0000' });
    personalId = personal.id;
    styleId = (await push(fixture.identityA, personal.id, fixture.spaceS, null, null)).style.id;

    const prefs = await setPrefs(fixture.identityB, `space:${styleId}`, 'builtin:atelier-dark');
    expect(prefs.currentStyle).toBe(`space:${styleId}`);
    expect(prefs.revision).toBe(1);
    expect(prefs.snapshot.current?.vars).toEqual({ '--pn-brand': '#AA0000' });
    expect(prefs.snapshot.currentTitle).toBe('Shared');
    expect(prefs.snapshot.dark?.foundation).toBe('builtin:atelier-dark');

    // Persisted, and only B's: A's prefs are untouched by B's choice.
    expect((await prefsOf(fixture.identityB)).prefs?.currentStyle).toBe(`space:${styleId}`);
    expect((await prefsOf(fixture.identityA)).prefs?.currentStyle ?? null).not.toBe(`space:${styleId}`);

    // C cannot read S's style, and cannot use another identity's personal style.
    expect(await outcome(() => setPrefs(fixture.identityC, `space:${styleId}`))).toBe('forbidden');
    expect(await outcome(() => setPrefs(fixture.identityB, `personal:${personalId}`))).toBe('forbidden');
  });

  it('identity.style_prefs.updated is addressed to the chooser\'s memberships only', async () => {
    const rows = (await eventsOf('identity.style_prefs.updated'))
      .filter((r) => r.payload.currentStyle === `space:${styleId}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.recipient).toBe(fixture.memberBS);
  });

  it('a stale expectedRevision is a version_conflict', async () => {
    expect(await outcome(() => as(fixture.identityB, (q) => q.rpc('set_identity_style_prefs', [
      'builtin:atelier-light', null, false, [], 0, cmid(),
    ])))).toBe('version_conflict');
  });

  it('a push refreshes the snapshot of viewers still in the space (one set-based update)', async () => {
    const personal = await as(fixture.identityA, (q) => q.rpc<PersonalStyleView>('get_personal_style', [personalId]));
    const edited = await updatePersonal(fixture.identityA, personal, { '--pn-brand': '#00AA00' });
    await push(fixture.identityA, edited.id, fixture.spaceS, styleId, null);
    const after = (await prefsOf(fixture.identityB)).prefs!;
    expect(after.snapshot.current?.vars).toEqual({ '--pn-brand': '#00AA00' });
    // The refresh is not a selection: no revision bump, no prefs event.
    expect(after.revision).toBe(1);
  });

  it('a remove does NOT touch snapshots: viewers keep the last pushed version', async () => {
    expect(await outcome(() => as(fixture.identityB, (q) => q.rpc('remove_style', [styleId, null, null, cmid()]))))
      .toBe('forbidden');
    await as(fixture.identityA, (q) => q.rpc('remove_style', [styleId, null, null, cmid()]));
    const [row] = await database.query<{ deleted: boolean }>(
      'select deleted_at is not null deleted from public.entities where id = $1', [styleId]);
    expect(row!.deleted).toBe(true);
    const deleted = await database.query<{ n: string }>(
      `select count(*)::text n from public.workspace_events
        where event_type = 'entity.deleted' and payload ->> 'id' = $1`, [styleId]);
    expect(Number(deleted[0]!.n)).toBeGreaterThan(0);

    const after = (await prefsOf(fixture.identityB)).prefs!;
    expect(after.currentStyle).toBe(`space:${styleId}`);
    expect(after.snapshot.current?.vars).toEqual({ '--pn-brand': '#00AA00' });

    // The next push from the same personal style makes a fresh space style.
    const again = await push(fixture.identityA, personalId, fixture.spaceS, null, null);
    expect(again.created).toBe(true);
    expect(again.style.id).not.toBe(styleId);
  });
});

describe('284 space default (a2)', () => {
  it('no row reads as builtin:atelier-light at revision 0', async () => {
    const d = await as(fixture.identityB, (q) => q.rpc<SpaceStyleDefaultView>('get_space_style_default', [fixture.spaceS]));
    expect(d).toMatchObject({ spaceId: fixture.spaceS, defaultStyle: 'builtin:atelier-light', revision: 0, setBy: null });
  });

  it('only a human space admin sets it, never to a personal style, and the space hears it', async () => {
    const personal = await createPersonal(fixture.identityA, 'Default me', {});
    const style = (await push(fixture.identityA, personal.id, fixture.spaceS, null, null)).style;

    expect(await outcome(() => as(fixture.identityB, (q) => q.rpc('set_space_style_default', [
      fixture.spaceS, `space:${style.id}`, null, cmid(),
    ])))).toBe('forbidden');
    expect(await outcome(() => as(fixture.identityA, (q) => q.rpc('set_space_style_default', [
      fixture.spaceS, `personal:${personal.id}`, null, cmid(),
    ])))).toBe('invalid_input');

    const set = await as(fixture.identityA, (q) => q.rpc<SpaceStyleDefaultView>('set_space_style_default', [
      fixture.spaceS, `space:${style.id}`, 0, cmid(),
    ]));
    expect(set).toMatchObject({ defaultStyle: `space:${style.id}`, revision: 1, setBy: fixture.memberAS });

    const events = (await eventsOf('space.style_default.updated')).filter((r) => r.payload.defaultStyle === `space:${style.id}`);
    expect(events).toHaveLength(1);
    expect(events[0]!.recipient).toBeNull();
  });

  it('a new member with no prefs row gets the space default', async () => {
    const newcomer = 'styles-newcomer';
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const member = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'New')`, [newcomer]);
      await client.query(
        `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
         values ($1, $2, 'member', null, 0, $1)`, [member, fixture.spaceS]);
      await client.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name)
         values ($1, $2, $3, 'member', 'New')`, [member, fixture.spaceS, newcomer]);
    });
    expect((await prefsOf(newcomer)).prefs).toBeNull();
    const d = await as(newcomer, (q) => q.rpc<SpaceStyleDefaultView>('get_space_style_default', [fixture.spaceS]));
    expect(d.defaultStyle).toMatch(/^space:/);
    // …and that default is readable to them, so the client can render it.
    const id = d.defaultStyle.slice('space:'.length);
    const style = await as(newcomer, (q) => q.rpc<SpaceStyleView>('get_space_style', [id]));
    expect(style.id).toBe(id);
  });
});
