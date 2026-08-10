/**
 * W2.G13 — `030_w2_feed_context.sql` and the feed's scope branches against a
 * REAL PostgreSQL chain.
 *
 * ⚠ SCOPE OF THIS FILE, stated because the distinction cost this wave a
 * confirmed defect: THIS IS AN ISOLATION PROOF, NOT A COVERAGE PROOF. It builds
 * its fixture from `migrationFiles()` — the whole `db/migrations` directory —
 * so it cannot silently narrow the way `w2-edges-placements.pg.test.ts` did
 * when it applied `001–015 + 018` and never `020`, hiding a defect through five
 * gates. But full-chain operational coverage is
 * `test/db/w2-migration-order.pg.test.ts`, which drives the OFFICIAL runner
 * from empty and from the supported 001–015 state. Cite that one, never this,
 * and never `w1-migration-runner.test.ts` (which stops at 015).
 *
 * Two things are proved here that nothing else can prove:
 *
 * 1. **030 is new-objects-only.** An earlier G13 draft added a column and a
 *    BEFORE INSERT trigger to `public.activity` — a shared read model under
 *    `entities.activity` (G02, composed), under `activityAt` on the entity
 *    envelope, and under `collections.query`'s `activityAt_desc` sort (G05,
 *    independently gated). That was withdrawn. The catalog diff below applies
 *    the chain WITH and WITHOUT 030 and asserts the ONLY difference in the
 *    entire `public` + `internal` surface is the two new functions. "Additive"
 *    is the exact word that hid this wave's confirmed defect, so it is checked
 *    rather than asserted in prose.
 *
 * 2. **The scope registry has not drifted.** `FEED_SCOPE_PREDICATES` in the
 *    facade and `internal.w2_feed_scope_predicates()` in 030 are two
 *    independent copies of a security-relevant map. Agreement is checked in
 *    BOTH directions — a scope either side gains alone is the drift that hurts.
 *
 * The branch queries run the LITERAL exported production SQL, not a
 * transcription of it.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FEED_SCOPE_ANCHOR_KINDS,
  FEED_SCOPE_PREDICATES,
  feedLocateSql,
  feedPageSql,
} from '../../src/facade/services/w2/feed-context.js';
import {
  MIGRATIONS_DIR,
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/** Every migration this suite's operations touch, named so a gap is loud. */
const REQUIRED_MIGRATIONS = [
  '001_core_graph.sql',        // entities, messages, edges
  '003_read_model.sql',        // activity, workspace_events
  '008_rls_policies.sql',      // messages_select / activity_select / edges_select
  '015_w1_foundations.sql',    // authored_from + its writer gate, message_batch_id
  '019_w2_messages_handoffs.sql',
  '030_w2_feed_context.sql',   // this group's own migration
] as const;

/**
 * The chain of record when G13 froze: 001–024, 027, 029, 030 = 27 files.
 *
 * A FLOOR, not an equality. The count guard exists so this fixture can never
 * silently NARROW — it must not also fail the moment a sibling wave lands a
 * legitimate new migration (SEC-1's `031` is already announced). The equality
 * that actually matters is asserted below against the directory itself.
 */
const MIGRATION_COUNT_FLOOR = 27;

interface Fixture {
  identityMember: string;
  identityOutsider: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  taskId: string;
  otherTaskId: string;
  sessionId: string;
  rootMessageId: string;
  replyMessageId: string;
  sessionMessageId: string;
  sessionReplyId: string;
  authoredMessageId: string;
  subjectActivityId: string;
  causedActivityId: string;
}

interface CatalogSnapshot {
  columns: string[];
  triggers: string[];
  indexes: string[];
  policies: string[];
  constraints: string[];
  functions: string[];
}

interface PageRow {
  item_kind: string;
  item_id: string;
  created_at: Date;
  via: string[];
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function catalogOf(target: W1ScratchDatabase): Promise<CatalogSnapshot> {
  const rows = async (sql: string): Promise<string[]> =>
    (await target.query<{ line: string }>(sql)).map((row) => row.line);
  return {
    columns: await rows(
      `select table_name||'.'||column_name||' '||data_type||' null='||is_nullable
              ||' default='||coalesce(column_default,'-') line
         from information_schema.columns where table_schema in ('public','internal')
        order by 1`),
    triggers: await rows(
      `select event_object_table||'.'||trigger_name||' '||action_timing||' '||event_manipulation line
         from information_schema.triggers where trigger_schema in ('public','internal') order by 1`),
    indexes: await rows(
      `select schemaname||'.'||indexname||' = '||indexdef line
         from pg_indexes where schemaname in ('public','internal') order by 1`),
    policies: await rows(
      `select schemaname||'.'||tablename||'.'||policyname||' '||cmd||' '||coalesce(qual,'-') line
         from pg_policies where schemaname in ('public','internal') order by 1`),
    constraints: await rows(
      `select conrelid::regclass::text||'.'||conname||' = '||pg_get_constraintdef(oid) line
         from pg_constraint
        where connamespace in ('public'::regnamespace,'internal'::regnamespace) order by 1`),
    functions: await rows(
      `select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' line
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public','internal') order by 1`),
  };
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'g13-identity-member'::text as "identityMember",
              'g13-identity-outsider'::text as "identityOutsider",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "teammateId",
              internal.new_id()::text as "taskId",
              internal.new_id()::text as "otherTaskId",
              internal.new_id()::text as "sessionId",
              internal.new_id()::text as "rootMessageId",
              internal.new_id()::text as "replyMessageId",
              internal.new_id()::text as "sessionMessageId",
              internal.new_id()::text as "sessionReplyId",
              internal.new_id()::text as "authoredMessageId",
              internal.new_id()::text as "subjectActivityId",
              internal.new_id()::text as "causedActivityId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values ($1,'G13 member'),($2,'G13 outsider')`,
      [ids.identityMember, ids.identityOutsider],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values ($1,'G13',$2)`,
      [ids.spaceId, ids.identityMember],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$4,'member',$1,'space'),
              ($2,$4,'team_member',$1,'space'),
              ($3,$4,'task',$1,'space')`,
      [ids.memberId, ids.teammateId, ids.taskId, ids.spaceId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$3,'task',$4,'space'),($2,$3,'work_session',$4,'space')`,
      [ids.otherTaskId, ids.sessionId, ids.spaceId, ids.memberId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values ($1,$2,$3,'owner','G13 member')`,
      [ids.memberId, ids.spaceId, ids.identityMember],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values ($1,$2,'G13 Agent','worker','g13-agent')`,
      [ids.teammateId, ids.memberId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title) values ($1,'G13 anchor'),($2,'G13 other')`,
      [ids.taskId, ids.otherTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status,share_mode,started_at)
       values ($1,'G13 session','running','space',now())`,
      [ids.sessionId],
    );

    // Message envelopes. A reply's ENVELOPE parent is its parent message, which
    // is what `internal.validate_message` checks the thread root against.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,created_by,visibility)
       values ($1,$6,'message',null,$7,'space'),
              ($2,$6,'message',$1,$7,'space'),
              ($3,$6,'message',null,$7,'space'),
              ($4,$6,'message',$3,$7,'space'),
              ($5,$6,'message',null,$7,'space')`,
      [
        ids.rootMessageId, ids.replyMessageId, ids.sessionMessageId,
        ids.sessionReplyId, ids.authoredMessageId, ids.spaceId, ids.teammateId,
      ],
    );
    await client.query(
      `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
       values ($1,$6,null,$8,'root on the task',      timestamptz '2026-07-26T09:00:00Z'),
              ($2,$6,$1,  $8,'reply on the task',     timestamptz '2026-07-26T09:10:00Z'),
              ($3,$7,null,$8,'root in the session',   timestamptz '2026-07-26T09:20:00Z'),
              ($4,$7,$3,  $8,'reply in the session',  timestamptz '2026-07-26T09:30:00Z'),
              ($5,$9,null,$8,'authored elsewhere',    timestamptz '2026-07-26T09:40:00Z')`,
      [
        ids.rootMessageId, ids.replyMessageId, ids.sessionMessageId, ids.sessionReplyId,
        ids.authoredMessageId, ids.taskId, ids.sessionId, ids.teammateId, ids.otherTaskId,
      ],
    );

    // `authored_from` is writer-gated to `message_recorder` (015:618). That gate
    // is exactly why the feed may READ this edge as provenance and may never
    // accept it as input.
    await client.query(`select internal.w1_set_writer('message_recorder')`);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by)
       values ($1,$2,$4,'authored_from',$5),($1,$3,$4,'authored_from',$5)`,
      [ids.spaceId, ids.authoredMessageId, ids.sessionMessageId, ids.sessionId, ids.teammateId],
    );
    await client.query(`select internal.w1_set_writer('')`);

    await client.query(
      `insert into public.activity(id,space_id,entity_id,actor_id,verb,created_at,work_session_id)
       values ($1,$3,$4,$6,'work.changed',timestamptz '2026-07-26T09:05:00Z',null),
              ($2,$3,$5,$6,'updated',     timestamptz '2026-07-26T09:35:00Z',$7)`,
      [
        ids.subjectActivityId, ids.causedActivityId, ids.spaceId,
        ids.taskId, ids.otherTaskId, ids.memberId, ids.sessionId,
      ],
    );
    return ids;
  });
}

/** One read as `tm8_app` with a bound identity — the claim-bound RLS path. */
async function asApp<T>(
  identityId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    return fn(client);
  });
}

async function page(
  identityId: string,
  anchorId: string,
  scope: keyof typeof FEED_SCOPE_PREDICATES,
  options: { direction?: 'asc' | 'desc'; from?: [string, string] } = {},
): Promise<PageRow[]> {
  const direction = options.direction ?? 'desc';
  const sql = feedPageSql(FEED_SCOPE_PREDICATES[scope], {
    comparator: direction === 'desc' ? '<' : '>',
    direction,
    limit: 50,
    keyed: options.from !== undefined,
  });
  return asApp(identityId, async (client) => (
    await client.query<PageRow>(sql, options.from ? [anchorId, ...options.from] : [anchorId])
  ).rows);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w2_g13');
  database.apply(migrationFiles());
  fixture = await seed();
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('W2.G13 migration 030 and the versioned feed scope', () => {
  it('builds its fixture from the WHOLE migrations directory, in official order', () => {
    const files = migrationFiles();

    // THE guard: the fixture applies every `.sql` file on disk. Equality with
    // the directory — not a hard-coded number — is what makes a silent
    // narrowing impossible, and it does not race a sibling wave's new
    // migration the way `toHaveLength(27)` would.
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual(onDisk);

    expect(files).toEqual([...files].sort());
    expect(new Set(files.map((file) => file.slice(0, 3))).size).toBe(files.length);
    expect(files.length).toBeGreaterThanOrEqual(MIGRATION_COUNT_FLOOR);
    for (const required of REQUIRED_MIGRATIONS) expect(files).toContain(required);

    // The gaps stay gaps: the runner sorts lexically, so a backfilled 025 would
    // sort BEFORE the already-shipped 027/029 and become an out-of-order insert
    // against any ledger that has applied them.
    for (const gap of ['025', '026', '028']) {
      expect(files.some((file) => file.startsWith(gap))).toBe(false);
    }
    // 030 sorts after everything that shipped before it — the whole reason it
    // is numbered 030 and not backfilled into a gap.
    for (const earlier of ['027_w2_entity_kinds_profiles.sql', '029_w2_menu_default_channel.sql']) {
      expect(files.indexOf('030_w2_feed_context.sql')).toBeGreaterThan(files.indexOf(earlier));
    }
  });

  it('adds NOTHING to the shared schema but its own two functions', async () => {
    const without = await createW1ScratchDatabase('w2_g13_no030');
    try {
      // 097 is the SECOND writer of these same two functions — it restates them
      // whole with `create or replace` to add `channel_threads_v1` to both
      // lookup tables. So proving "030 contributes exactly two functions and no
      // shared-schema change" means withholding every migration that defines
      // them, not just 030; leaving 097 in would recreate both and make `gained`
      // empty for a reason that has nothing to do with what this test asserts.
      const SCOPE_REGISTRY_MIGRATIONS = [
        '030_w2_feed_context.sql',
        '097_channel_threads_feed_scope.sql',
      ];
      without.apply(migrationFiles().filter((file) => !SCOPE_REGISTRY_MIGRATIONS.includes(file)));
      const before = await catalogOf(without);
      const after = await catalogOf(database);

      // The shared read model behind three composed operations, byte-identical.
      expect(after.columns).toEqual(before.columns);
      expect(after.triggers).toEqual(before.triggers);
      expect(after.indexes).toEqual(before.indexes);
      expect(after.policies).toEqual(before.policies);
      expect(after.constraints).toEqual(before.constraints);

      const gained = after.functions.filter((line) => !before.functions.includes(line));
      const lost = before.functions.filter((line) => !after.functions.includes(line));
      expect(gained).toEqual([
        'internal.w2_feed_scope_applicable(p_scope text, p_anchor_kind text)',
        'internal.w2_feed_scope_predicates(p_scope text)',
      ]);
      expect(lost).toEqual([]);

      // And specifically, the column and trigger the withdrawn draft would have
      // added to `public.activity` are absent.
      expect(after.columns.filter((line) => line.startsWith('activity.'))).toEqual(
        before.columns.filter((line) => line.startsWith('activity.')),
      );
      expect(after.columns.some((line) => line.includes('logical_operation_id'))).toBe(false);
    } finally {
      await without.destroy();
    }
  }, 240_000);

  it('mirrors the facade scope registry in BOTH directions', async () => {
    const rows = await database.query<{ scope: string; predicates: string[] }>(
      `select s.scope, internal.w2_feed_scope_predicates(s.scope) predicates
         from unnest($1::text[]) s(scope)`,
      [Object.keys(FEED_SCOPE_PREDICATES)],
    );
    // Every facade scope exists in the database with the identical canonical
    // (deduped + sorted) predicate list.
    for (const row of rows) {
      const facade = FEED_SCOPE_PREDICATES[row.scope as keyof typeof FEED_SCOPE_PREDICATES];
      expect(row.predicates, row.scope).toEqual([...facade]);
      expect([...facade], row.scope).toEqual([...new Set(facade)].sort());
    }
    // …and the database knows no scope the facade lacks. A NEW UNMIRRORED SCOPE
    // is the drift that would actually hurt, so it is checked explicitly rather
    // than implied by the loop above.
    const strays = await database.query<{ scope: string }>(
      `select s.scope from unnest($1::text[]) s(scope)
        where internal.w2_feed_scope_predicates(s.scope) is not null`,
      [['default', 'direct', 'direct_v2', 'session_chat', 'raw', '', 'all']],
    );
    expect(strays).toEqual([]);
  });

  it('refuses an unknown scope and confines session_chat_v1 to a work_session anchor', async () => {
    const rows = await database.query<{ scope: string; kind: string; ok: boolean }>(
      `select c.scope, c.kind, internal.w2_feed_scope_applicable(c.scope, c.kind) ok
         from (values ('direct_v1','task'),('direct_v1','work_session'),('direct_v1','channel'),
                      ('session_chat_v1','work_session'),('session_chat_v1','task'),
                      ('session_chat_v1','channel'),('direct_v2','task'),('raw','task'),
                      ('channel_threads_v1','channel'),('channel_threads_v1','task'),
                      ('channel_threads_v1','work_session'))
              c(scope, kind)`,
    );
    expect(rows.map((row) => [row.scope, row.kind, row.ok])).toEqual([
      ['direct_v1', 'task', true],
      ['direct_v1', 'work_session', true],
      ['direct_v1', 'channel', true],
      ['session_chat_v1', 'work_session', true],
      ['session_chat_v1', 'task', false],
      ['session_chat_v1', 'channel', false],
      ['direct_v2', 'task', false],
      ['raw', 'task', false],
      // Narrow on purpose: a roots-only reading is a CHANNEL's reading. Asking
      // for it elsewhere is a caller naming something that does not exist, and
      // the frozen answer is `feed_scope_not_applicable` rather than an empty
      // feed that lets a broken query ship.
      ['channel_threads_v1', 'channel', true],
      ['channel_threads_v1', 'task', false],
      ['channel_threads_v1', 'work_session', false],
    ]);
    // The facade's own applicability table says exactly the same thing.
    expect(FEED_SCOPE_ANCHOR_KINDS.direct_v1).toBe('any');
    expect(FEED_SCOPE_ANCHOR_KINDS.session_chat_v1).toEqual(['work_session']);
    expect(FEED_SCOPE_ANCHOR_KINDS.channel_threads_v1).toEqual(['channel']);
  });
});

describe.sequential('W2.G13 feed scope branches on the full chain', () => {
  it('direct_v1 selects anchored, replies and subject — and nothing else', async () => {
    const rows = await page(fixture.identityMember, fixture.taskId, 'direct_v1');
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      [fixture.replyMessageId, ['replies']],
      [fixture.subjectActivityId, ['subject']],
      [fixture.rootMessageId, ['anchored']],
    ]);
    // `authored` and `caused` belong to the other scope: the message authored
    // from the session and the activity the session caused must NOT appear.
    const ids = rows.map((row) => row.item_id);
    expect(ids).not.toContain(fixture.authoredMessageId);
    expect(ids).not.toContain(fixture.causedActivityId);
  });

  it('session_chat_v1 selects anchored, authored, caused and replies, folding multi-via items', async () => {
    const rows = await page(fixture.identityMember, fixture.sessionId, 'session_chat_v1');
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      [fixture.authoredMessageId, ['authored']],
      [fixture.causedActivityId, ['caused']],
      [fixture.sessionReplyId, ['replies']],
      // Anchored in the session AND authored from it: ONE item, two predicates,
      // sorted — not two rows the client has to deduplicate.
      [fixture.sessionMessageId, ['anchored', 'authored']],
    ]);
  });

  it('channel_threads_v1 is direct_v1 minus replies — the root survives, the reply does not', async () => {
    const rows = await page(fixture.identityMember, fixture.taskId, 'channel_threads_v1');

    // Same anchor, same fixture, one predicate fewer. THIS IS THE WHOLE
    // FEATURE: a reply stops being drawn as a peer of the message it answers.
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      [fixture.subjectActivityId, ['subject']],
      [fixture.rootMessageId, ['anchored']],
    ]);

    // Stated as its own assertion because "the reply is gone" is the claim a
    // future reader will want to see refuted directly, not inferred from a
    // deep-equal above.
    expect(rows.map((row) => row.item_id)).not.toContain(fixture.replyMessageId);

    // NOT HIDDEN, ONLY UNFLATTENED: `direct_v1` over the identical anchor and
    // the identical viewer still returns it. Nothing was deleted, and no RLS
    // decision changed — the reply is one `messages.list?rootMessageId=` away.
    const flat = await page(fixture.identityMember, fixture.taskId, 'direct_v1');
    expect(flat.map((row) => row.item_id)).toContain(fixture.replyMessageId);
  });

  it('direct_v1 on a work_session anchor is a different, narrower feed', async () => {
    const rows = await page(fixture.identityMember, fixture.sessionId, 'direct_v1');
    expect(rows.map((row) => row.item_id)).toEqual([
      fixture.sessionReplyId,
      fixture.sessionMessageId,
    ]);
  });

  it('reverses cleanly for order=oldest and pages on the keyset in both directions', async () => {
    const newest = await page(fixture.identityMember, fixture.taskId, 'direct_v1');
    const oldest = await page(fixture.identityMember, fixture.taskId, 'direct_v1', {
      direction: 'asc',
    });
    expect(oldest.map((row) => row.item_id)).toEqual(
      [...newest].reverse().map((row) => row.item_id),
    );

    const first = newest[0]!;
    const after = await page(fixture.identityMember, fixture.taskId, 'direct_v1', {
      from: [first.created_at.toISOString(), first.item_id],
    });
    expect(after.map((row) => row.item_id)).toEqual(
      newest.slice(1).map((row) => row.item_id),
    );

    const last = oldest[0]!;
    const afterOldest = await page(fixture.identityMember, fixture.taskId, 'direct_v1', {
      direction: 'asc',
      from: [last.created_at.toISOString(), last.item_id],
    });
    expect(afterOldest.map((row) => row.item_id)).toEqual(
      oldest.slice(1).map((row) => row.item_id),
    );
  });

  it('separates "outside the scope" from "not visible" in ONE statement', async () => {
    const locate = feedLocateSql(FEED_SCOPE_PREDICATES.direct_v1);
    const inScope = await asApp(fixture.identityMember, async (client) => (
      await client.query<{ in_scope: boolean }>(locate, [
        fixture.taskId, fixture.rootMessageId, 'message',
      ])).rows);
    // `cursor_created_at` is the microsecond TEXT the `around=` anchor and the
    // page cursor both key on. It is a STRING, not a Date, on purpose: a
    // `timestamptz` returned as a JS Date keeps only milliseconds, and this
    // feed's default order is DESC, where a truncated key silently SKIPS every
    // item sharing the lost millisecond rather than looping.
    expect(inScope).toEqual([{
      item_id: fixture.rootMessageId,
      created_at: expect.any(Date),
      cursor_created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
      in_scope: true,
    }]);

    // Visible to this member, but not part of the task's direct_v1 feed.
    const outOfScope = await asApp(fixture.identityMember, async (client) => (
      await client.query<{ in_scope: boolean }>(locate, [
        fixture.taskId, fixture.authoredMessageId, 'message',
      ])).rows);
    expect(outOfScope.map((row) => row.in_scope)).toEqual([false]);

    // Right id, wrong kind — `activity:<a message id>` resolves to no row at
    // all, which is `not_found` rather than a scope error.
    const wrongKind = await asApp(fixture.identityMember, async (client) => (
      await client.query(locate, [fixture.taskId, fixture.rootMessageId, 'activity'])).rows);
    expect(wrongKind).toEqual([]);

    const absent = await asApp(fixture.identityMember, async (client) => (
      await client.query(locate, [fixture.taskId, randomUUID(), 'message'])).rows);
    expect(absent).toEqual([]);
  });

  it('is claim-bound: an identity outside the Space sees an empty feed, not an error', async () => {
    for (const scope of ['direct_v1', 'session_chat_v1'] as const) {
      const anchor = scope === 'direct_v1' ? fixture.taskId : fixture.sessionId;
      expect(await page(fixture.identityOutsider, anchor, scope), scope).toEqual([]);
    }
    // The same statement, same parameters, as the member — so the difference is
    // RLS and nothing else.
    expect(await page(fixture.identityMember, fixture.taskId, 'direct_v1')).not.toEqual([]);
  });
});
