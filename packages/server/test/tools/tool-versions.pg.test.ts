/**
 * 381: every write to a tool stores its own entity_versions row (§1), and a run
 * pins the DEFINITION version, tools.execution_version (§2), so a run's
 * `tool_version` always resolves to the source that ran and never moves on a
 * config, secret or help-only write.
 *
 * Before 381 the `tools` snapshot trigger ran 001's 5-minute same-actor
 * debounce, which RENUMBERS the latest row in place: create + two quick edits
 * left one row, and every earlier run kept a sha256 with no source behind it.
 * Runs also pinned entities.version, which `tm8 tool secret set` advanced. The
 * writes here are by one author, seconds apart: exactly what was folded.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { TOOL_CONTENT_SQL, projectToolView } from '../../src/tools/projection.js';
import { loadTool } from '../../src/tools/views.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase;
let db: Db;
const space = randomUUID(), owner = randomUUID();
// Not 'versions-owner': internal.claim_text (037) btrims E' \t\n\r\f\v', and
// Postgres has no \v escape, so a claim's leading or trailing 'v' is trimmed.
const human: DbClaims = { identityId: 'tool-versions-owner', authKind: 'browser', sessionSpaceId: space };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const definition = (name: string, source: string, help = 'Usage') => ({ name, description: 'Version fixture', help, runtime: 'bash',
  source, tm8Access: 'none', timeoutSeconds: 60, inputs: [{ name: 'value', type: 'string' }, { name: 'token', type: 'secret' }] });

interface StoredVersion {
  version: number; changed_by: string; changed_at: Date; source: string; help: string; execution_version: number;
  snapshot_version: number; content: Record<string, unknown>;
}
/** Every stored row of one tool, oldest first, with the fields a reader resolves. */
async function stored(id: string): Promise<StoredVersion[]> {
  return database.query<StoredVersion>(`select version, changed_by, changed_at, snapshot#>>'{content,definition,source}' as source,
    snapshot#>>'{content,definition,help}' as help, (snapshot#>>'{content,execution_version}')::integer as execution_version,
    (snapshot#>>'{entity,version}')::integer as snapshot_version, snapshot->'content' as content
    from public.entity_versions where entity_id=$1 order by version`, [id]);
}
/**
 * The row-classification rule UI and CLI quote (BRIEF-TOOLS.md): a stored
 * version is a `definition` version when its execution version equals its own
 * number; a `metadata` edit when its definition differs from the previous row
 * but the execution version is unchanged (name, description, help); otherwise a
 * `config` write (config set/unset, secret set/unset), whose definition is
 * identical to the previous row.
 */
function classify(rows: StoredVersion[]): string[] {
  return rows.map((row, index) => {
    if (row.execution_version === row.version) return 'definition';
    const previous = rows[index - 1]!;
    return JSON.stringify(row.content['definition']) === JSON.stringify(previous.content['definition']) ? 'config' : 'metadata';
  });
}
async function version(id: string): Promise<number> {
  return (await database.query<{ version: number }>('select version from public.entities where id=$1', [id]))[0]!.version;
}
async function executionVersion(id: string): Promise<number> {
  return (await database.query<{ execution_version: number }>('select execution_version from public.tools where entity_id=$1', [id]))[0]!.execution_version;
}
async function create(name: string, source: string): Promise<string> {
  return (await db.rpc<{ entity: { id: string } }>(human, 'create_tool_entity', [space, definition(name, source), null, randomUUID()])).entity.id;
}
async function edit(tool: string, next: ReturnType<typeof definition>) {
  await db.rpc(human, 'update_tool_entity', [tool, await version(tool), next, null, randomUUID()]);
}
async function setConfig(tool: string, value: string | null) {
  await db.rpc(human, 'set_tool_config', [tool, await version(tool), 'value', value === null ? null : JSON.stringify(value), value === null, null, randomUUID()]);
}
async function run(tool: string): Promise<string> {
  return (await db.rpc<{ entity: { id: string } }>(human, 'start_tool_session',
    [space, tool, await version(tool), {}, false, 'versions-test', '/tmp', 100, null, randomUUID()])).entity.id;
}
/** The audit read: the run's pin, and the stored row its tool_version names. */
async function pinOf(session: string) {
  const [pin] = await database.query<{ tool_id: string; tool_version: number; tool_source_sha256: string }>(
    'select tool_id, tool_version, tool_source_sha256 from public.work_sessions where entity_id=$1', [session]);
  const [row] = await database.query<{ source: string }>(`select snapshot#>>'{content,definition,source}' as source
    from public.entity_versions where entity_id=$1 and version=$2`, [pin!.tool_id, pin!.tool_version]);
  return { ...pin!, source: row?.source };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('tool_versions');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query("insert into public.user_profiles(identity_id,display_name) values('tool-versions-owner','tool-versions-owner')");
    await c.query("insert into public.accounts(identity_id,username,display_name) values('tool-versions-owner','tool-versions-owner','tool-versions-owner')");
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Tool versions fixture','tool-versions-owner')", [space]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [owner, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,'tool-versions-owner','owner','tool-versions-owner')", [owner, space]);
  });
});
afterAll(async () => { await db?.end(); await database?.destroy(); });

it('create plus two same-author edits inside the debounce window store three versions, and each run resolves its source', async () => {
  const sources = ['echo one', 'echo two', 'echo three'];
  const tool = await create('pinned-tool', sources[0]!);
  const runs = [await run(tool)];
  for (const source of sources.slice(1)) {
    await edit(tool, definition('pinned-tool', source));
    runs.push(await run(tool));
  }

  const rows = await stored(tool);
  // The precondition for a fold: one author, every row inside the window.
  expect(new Set(rows.map(row => row.changed_by))).toEqual(new Set([owner]));
  const [window] = await database.query<{ inside: boolean }>(
    'select max(changed_at) - min(changed_at) < internal.version_debounce_window() as inside from public.entity_versions where entity_id=$1', [tool]);
  expect(window!.inside).toBe(true);
  // Three rows, distinct numbers, each with the source it was written with and
  // naming itself as the execution version (every edit here changed the source).
  expect(rows.map(row => [row.version, row.snapshot_version, row.execution_version, row.source]))
    .toEqual([[1, 1, 1, sources[0]], [2, 2, 2, sources[1]], [3, 3, 3, sources[2]]]);
  expect(classify(rows)).toEqual(['definition', 'definition', 'definition']);
  expect(await version(tool)).toBe(3);
  expect(await executionVersion(tool)).toBe(3);

  for (const [index, session] of runs.entries()) {
    const pin = await pinOf(session);
    expect(pin.tool_version).toBe(index + 1);
    expect(pin.source).toBe(sources[index]);
    expect(pin.tool_source_sha256).toBe(sha(pin.source!));
  }
});

it('config, secret and help-only writes store their own rows and never move the version a run pins', async () => {
  const tool = await create('config-tool', 'echo first');
  await edit(tool, definition('config-tool', 'echo second'));
  const pinned = await run(tool);

  await setConfig(tool, 'configured');
  const credential = randomUUID();
  await db.rpc(human, 'create_tool_credential', [credential, space, tool, 'token', 'Fixture token', 'hint', Buffer.alloc(32, 7), Buffer.alloc(12, 8), await version(tool), null, randomUUID()]);
  await db.rpc(human, 'bind_tool_secret', [tool, await version(tool), 'token', null, true, null, randomUUID()]);
  await setConfig(tool, null);
  // A definition edit that changes nothing the program runs with.
  await edit(tool, definition('config-tool', 'echo second', 'Usage, revised'));
  const afterConfig = await run(tool);

  const rows = await stored(tool);
  // One row per write, as before 381 (only the folding is gone). The definition
  // source is unchanged from row 2 on, and every row names row 2 as the
  // execution version; only the help edit changes the definition at all.
  expect(rows.map(row => [row.version, row.execution_version, row.source, row.help])).toEqual([
    [1, 1, 'echo first', 'Usage'], [2, 2, 'echo second', 'Usage'], [3, 2, 'echo second', 'Usage'], [4, 2, 'echo second', 'Usage'],
    [5, 2, 'echo second', 'Usage'], [6, 2, 'echo second', 'Usage'], [7, 2, 'echo second', 'Usage, revised']]);
  expect(rows.map(row => [row.content['config'], (row.content['secretBindings'] as unknown[]).length])).toEqual([[{}, 0], [{}, 0],
    [{ value: 'configured' }, 0], [{ value: 'configured' }, 1], [{ value: 'configured' }, 0], [{}, 0], [{}, 0]]);
  // The three row classes: a definition edit opens a new execution version; a
  // config or secret write keeps the definition identical; a help-only edit
  // changes the definition without moving the execution version.
  expect(classify(rows)).toEqual(['definition', 'definition', 'config', 'config', 'config', 'config', 'metadata']);
  expect(rows[6]!.content['definition']).not.toEqual(rows[5]!.content['definition']);
  expect(rows[5]!.content['definition']).toEqual(rows[1]!.content['definition']);
  // The concurrency token advanced on every write; the definition version did not.
  expect(await version(tool)).toBe(7);
  expect(await executionVersion(tool)).toBe(2);

  // Both runs pin the definition version, before and after the six writes.
  expect(await pinOf(pinned)).toMatchObject({ tool_version: 2, source: 'echo second', tool_source_sha256: sha('echo second') });
  expect(await pinOf(afterConfig)).toMatchObject({ tool_version: 2, source: 'echo second', tool_source_sha256: sha('echo second') });
  // The stale check still speaks entities.version: a client that loaded v7 runs,
  // one that loaded v1 (before the source changed) is refused.
  await expect(db.rpc(human, 'start_tool_session', [space, tool, 1, {}, false, 'versions-test', '/tmp', 100, null, randomUUID()]))
    .rejects.toThrow('source changed');
});

it('the tool view and the entity projection still read the latest definition', async () => {
  const tool = await create('latest-tool', 'echo old');
  await run(tool);
  await edit(tool, definition('latest-tool', 'echo new'));
  const [edited] = await stored(tool).then(rows => rows.filter(row => row.version === 2));
  await setConfig(tool, 'later');

  const view = await db.tx(human, q => loadTool(q, tool));
  expect(view).toMatchObject({ version: 3, executionVersion: 2, sourceSha256: sha('echo new'), config: { value: 'later' } });
  expect(view.definition.source).toBe('echo new');
  // The edit is the first row carrying the new source, not the config write after it.
  expect(view.sourceChangedSinceViewerLastRun).toMatchObject({ fromSha: sha('echo old'), toSha: sha('echo new'), at: edited!.changed_at.toISOString() });

  const [row] = await db.query<{ id: string; space_id: string; version: number; tool_content: unknown }>(human,
    `select e.id, e.space_id, e.version, ${TOOL_CONTENT_SQL} as tool_content from public.entities e where e.id=$1`, [tool]);
  const projected = projectToolView(row!, new Map());
  expect(projected).toMatchObject({ version: 3, executionVersion: 2, sourceSha256: sha('echo new'), config: { value: 'later' } });
  expect(projected.definition.source).toBe('echo new');
});

it('kinds whose trigger takes no argument still fold a same-author edit', async () => {
  const task = (await db.rpc<{ entity: { id: string } }>(human, 'create_task', [space, 'v1 title', null, 'body'])).entity.id;
  expect(await database.query('select version from public.entity_versions where entity_id=$1', [task])).toEqual([{ version: 1 }]);
  await db.rpc(human, 'update_task_content', [task, 1, null, 'v2 title']);
  const rows = await database.query<{ version: number; title: string }>(`select version, snapshot#>>'{content,title}' as title
    from public.entity_versions where entity_id=$1 order by version`, [task]);
  expect(rows.map(row => [row.version, row.title])).toEqual([[2, 'v2 title']]);
});

it('refuses an unknown trigger argument instead of silently keeping the debounce', async () => {
  await expect(database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('create temp table snapshot_argument_probe(entity_id uuid, value integer) on commit drop');
    await c.query("create trigger probe_snapshot after update on snapshot_argument_probe for each row execute function internal.snapshot_entity_version('undebounce')");
    await c.query('insert into snapshot_argument_probe values ($1, 1)', [randomUUID()]);
    await c.query('update snapshot_argument_probe set value = 2');
  })).rejects.toThrow('unknown trigger arguments');
});
