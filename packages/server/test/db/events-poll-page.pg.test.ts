/**
 * Change feed step 1 — `events.poll` page fields `hasMore` / `examinedThrough`
 * and the server-side `entity` filter, against a real scratch database.
 *
 * The claim: the end of the feed is `hasMore:false` (the examine cap was not
 * hit), never a short page. A page padded with rows the caller cannot read is
 * short AND not the head, and `examinedThrough` must advance past those rows.
 * A filtered page reports both fields over the rows EXAMINED, not returned.
 *
 * Padding is produced the way it happens in production: an entity is
 * hard-deleted (as the superuser — no RPC hard-deletes), so its captured rows
 * can no longer be hydrated and `mapRows` skips them.
 *
 * Reads run as `tm8_app` so RLS is in force; `asOwner` is fixture-only.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/index.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { PgDurableEventLog } from '../../src/events/poll.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface CommandResult {
  entity: { id: string };
}

interface OwnerDb extends Db {
  asOwner<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
}

function openDb(connectionString: string): OwnerDb {
  const pool = new Pool({ connectionString, max: 4 });

  const querier = (client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; fields?: ReadonlyArray<{ name: string }> }>;
  }): Querier => ({
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const res = await client.query(sql, [...params]);
      return res.rows as R[];
    },
    async rpc<T>(fn: string, args: readonly unknown[] = []): Promise<T> {
      const placeholders = args.map((_, i) => `$${String(i + 1)}`).join(', ');
      const qualified = fn.includes('.') ? fn : `public.${fn}`;
      const res = await client.query(`select * from ${qualified}(${placeholders})`, [...args]);
      if (res.rows.length === 1 && res.fields?.length === 1) {
        const field = res.fields[0];
        return (field ? (res.rows[0] as Record<string, unknown>)[field.name] : undefined) as T;
      }
      return res.rows as unknown as T;
    },
  });

  async function run<T>(role: string | null, claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (role !== null) await client.query(`set local role ${role}`);
      const bindings: Array<[string, string]> = [];
      if (claims.identityId !== undefined) bindings.push(['tm8.identity_id', claims.identityId]);
      if (claims.actorId !== undefined) bindings.push(['tm8.actor_id', claims.actorId]);
      if (claims.nodeAdmin !== undefined) bindings.push(['tm8.node_admin', claims.nodeAdmin ? 'true' : 'false']);
      if (claims.requestId !== undefined) bindings.push(['tm8.request_id', claims.requestId]);
      for (const [name, value] of bindings) await client.query('select set_config($1, $2, true)', [name, value]);
      const out = await fn(querier(client));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    tx: (claims, fn) => run('tm8_app', claims, fn),
    rpc: (claims, fn, args = []) => run('tm8_app', claims, (q) => q.rpc(fn, args)),
    query: (claims, sql, params = []) => run('tm8_app', claims, (q) => q.query(sql, params)),
    asOwner: (fn) => run(null, {}, fn),
    end: () => pool.end(),
  };
}

/** The entity id an event is ABOUT, per the filter's subject rules. */
function subjectsOf(event: Record<string, unknown>): string[] {
  const id = (v: unknown): string | undefined =>
    v !== null && typeof v === 'object' ? ((v as { id?: unknown }).id as string | undefined) : undefined;
  const out: Array<string | undefined> = [];
  out.push(id(event['entity']));
  if (typeof event['id'] === 'string' && event['type'] === 'entity.activity_touched') out.push(event['id']);
  const edge = event['edge'] as Record<string, unknown> | undefined;
  if (edge) out.push(id(edge['source']), id(edge['target']));
  const activity = event['activity'] as Record<string, unknown> | undefined;
  if (activity && typeof activity['entityId'] === 'string') out.push(activity['entityId']);
  const message = event['message'] as Record<string, unknown> | undefined;
  if (message) out.push(id(message), message['anchorId'] as string | undefined);
  return out.filter((v): v is string => typeof v === 'string');
}

describe.sequential('events.poll hasMore / examinedThrough / entity filter (real Postgres)', () => {
  let scratch: W1ScratchDatabase;
  let db: OwnerDb;
  let log: PgDurableEventLog;
  let identityId: string;
  let spaceId: string;
  let memberId: string;

  /** seq before the fixture tasks; the window under test is everything after it. */
  let base: number;
  let keptId: string;
  let deletedId: string;

  const claims = (): DbClaims => ({ identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` });

  async function createTask(title: string): Promise<string> {
    const result = await db.rpc<CommandResult>(claims(), 'public.create_task', [
      spaceId, title, memberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    return result.entity.id;
  }

  /** Every row after `since`, as the superuser — the un-filtered truth. */
  async function storedSeqs(since: number): Promise<number[]> {
    const rows = await db.asOwner((q) =>
      q.query<{ seq: string }>(
        'select seq from public.workspace_events where space_id = $1 and seq > $2 order by seq asc',
        [spaceId, since],
      ),
    );
    return rows.map((r) => Number(r.seq));
  }

  const testOwner = (): Promise<LoopbackOwner> =>
    Promise.resolve({
      identityId,
      accountId: '00000000-0000-0000-0000-000000000000',
      username: 'owner',
      isNodeAdmin: false,
      isOwner: true,
    });

  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('poll_page');
    scratch.apply(migrationFiles());
    db = openDb(scratch.url);
    log = new PgDurableEventLog(db);

    identityId = `identity_${randomUUID()}`;
    await db.rpc(claims(), 'public.upsert_user_profile', ['Poll Page Owner', null, null]);
    const created = await db.rpc<{ space: { id: string } }>(claims(), 'public.create_space', [
      'Poll page space', 'hasMore proof', 'private', null, null,
    ]);
    spaceId = created.space.id;
    const members = await db.query<{ entity_id: string }>(
      claims(),
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [spaceId, identityId],
    );
    memberId = members[0]!.entity_id;

    base = (await storedSeqs(0)).at(-1) ?? 0;
    // KEPT first, DELETED last, so the unreadable rows sit at the END of the
    // window — the case where "last returned seq" and "last examined seq" differ.
    keptId = await createTask('kept task');
    deletedId = await createTask('hard-deleted task');
    await db.asOwner((q) => q.query('delete from public.entities where id = $1', [deletedId]));
  }, 180_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await scratch?.destroy().catch(() => undefined);
  }, 60_000);

  it('hasMore is false below the cap, and examinedThrough equals nextCursor', async () => {
    const all = await storedSeqs(base);
    const page = await log.since(spaceId, base, all.length + 1, claims());
    expect(page.hasMore).toBe(false);
    expect(page.examinedThrough).toBe(all.at(-1));
    expect(page.nextCursor).toBe(String(page.examinedThrough));
  });

  it('hasMore is true exactly at the cap, and the page after the head is empty with hasMore false', async () => {
    const all = await storedSeqs(base);
    const full = await log.since(spaceId, base, all.length, claims());
    expect(full.hasMore).toBe(true);
    expect(full.examinedThrough).toBe(all.at(-1));

    const after = await log.since(spaceId, full.examinedThrough!, all.length, claims());
    expect(after.items).toEqual([]);
    expect(after.hasMore).toBe(false);
    // An empty page echoes the caller's position, never null.
    expect(after.examinedThrough).toBe(full.examinedThrough);
    expect(after.nextCursor).toBe(String(full.examinedThrough));
  });

  it('a padded page is short, still hasMore, and examinedThrough advances past the unreadable rows', async () => {
    const all = await storedSeqs(base);
    const page = await log.since(spaceId, base, all.length, claims());

    // The deleted task's rows were examined and skipped.
    const returned = page.items.map((e) => e.seq);
    expect(page.items.length).toBeLessThan(all.length);
    expect(page.hasMore).toBe(true);
    expect(page.examinedThrough).toBe(all.at(-1));
    expect(page.examinedThrough!).toBeGreaterThan(Math.max(...returned));
    // Its entity rows cannot be hydrated, so none is served. (Its activity row
    // hydrates only the actor and may still be delivered — that is not padding.)
    expect(
      page.items.some((e) => e.type.startsWith('entity.') && subjectsOf(e as never).includes(deletedId)),
    ).toBe(false);
  });

  it('the entity filter returns only events about that entity, over the same examined window', async () => {
    const all = await storedSeqs(base);
    const unfiltered = await log.since(spaceId, base, all.length, claims());
    const filtered = await log.since(spaceId, base, all.length, claims(), { entityId: keptId });

    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.length).toBeLessThan(unfiltered.items.length);
    for (const event of filtered.items) {
      expect(subjectsOf(event as never), `seq ${String(event.seq)} ${event.type}`).toContain(keptId);
    }
    expect(filtered.items.map((e) => e.type)).toContain('entity.upsert');
    // Oracle: the unfiltered page narrowed client-side by the same rule.
    expect(filtered.items.map((e) => e.seq)).toEqual(
      unfiltered.items.filter((e) => subjectsOf(e as never).includes(keptId)).map((e) => e.seq),
    );
    // Both fields describe rows EXAMINED, not rows returned.
    expect(filtered.hasMore).toBe(unfiltered.hasMore);
    expect(filtered.examinedThrough).toBe(unfiltered.examinedThrough);
    expect(filtered.nextCursor).toBe(unfiltered.nextCursor);
  });

  it('a filtered window with no match is empty but still advances and reports hasMore', async () => {
    const all = await storedSeqs(base);
    const page = await log.since(spaceId, base, all.length, claims(), { entityId: randomUUID() });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(true);
    expect(page.examinedThrough).toBe(all.at(-1));
  });

  it('the handler passes ?entity= through and refuses a malformed id', async () => {
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, { db, config: {} as never, owner: testOwner });
    const handler = registry.get('events.poll')!;
    const ctx = (query: Record<string, string>): never =>
      ({
        params: { spaceId },
        query: new URLSearchParams(query),
        requestId: `req_${randomUUID()}`,
        identity: { kind: 'auto-owner', identityId, actorId: memberId },
      }) as never;

    const result = (await handler(ctx({ since: String(base), entity: keptId }))) as {
      data: { items: Array<Record<string, unknown>>; hasMore: boolean; examinedThrough: number };
    };
    expect(result.data.items.length).toBeGreaterThan(0);
    for (const event of result.data.items) expect(subjectsOf(event)).toContain(keptId);
    expect(result.data.hasMore).toBe(false);
    expect(typeof result.data.examinedThrough).toBe('number');

    await expect(handler(ctx({ since: '0', entity: 'not-an-id' }))).rejects.toThrow(/entity must be an entity id/);
  });
});
