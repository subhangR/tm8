/**
 * Fixture harness for the `events.changes` PG suites: a scratch database with
 * the whole migration chain, one space, and helpers that mutate ONLY through
 * `public.*` RPCs — so every event under test is one the capture trigger wrote.
 *
 * Reads run as `tm8_app` (RLS in force). `asOwner` is fixture-only: a few RPCs
 * (`post_message`) are revoked from `tm8_app` and are called with the caller's
 * claims but the connection role, as the server's own pool would.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

export interface OwnerDb extends Db {
  /** Superuser, with claims bound — for RPCs revoked from tm8_app, and fixture-only SQL. */
  asOwner<T>(fn: (q: Querier) => Promise<T>, claims?: DbClaims): Promise<T>;
}

export function openDb(connectionString: string): OwnerDb {
  const pool = new Pool({ connectionString, max: 6 });

  const querier = (client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; fields?: ReadonlyArray<{ name: string }> }>;
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
    asOwner: (fn, claims = {}) => run(null, claims, fn),
    end: () => pool.end(),
  };
}

interface CommandResult {
  entity: { id: string; version?: number };
}

const cmid = (): string => `cmid_${randomUUID()}`;

/** One space, one owner, and RPC helpers. */
export class ChangesFixture {
  scratch!: W1ScratchDatabase;
  db!: OwnerDb;
  identityId = `identity_${randomUUID()}`;
  spaceId!: string;
  memberId!: string;
  displayName = 'Changes Owner';

  claims = (): DbClaims => ({ identityId: this.identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` });

  async open(name: string): Promise<void> {
    this.scratch = await createW1ScratchDatabase(name);
    this.scratch.apply(migrationFiles());
    this.db = openDb(this.scratch.url);
    await this.db.rpc(this.claims(), 'public.upsert_user_profile', [this.displayName, null, null]);
    const created = await this.db.rpc<{ space: { id: string } }>(this.claims(), 'public.create_space', [
      'Changes space', 'change feed proof', 'private', null, null,
    ]);
    this.spaceId = created.space.id;
    this.memberId = (await this.db.query<{ entity_id: string }>(
      this.claims(),
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [this.spaceId, this.identityId],
    ))[0]!.entity_id;
  }

  async close(): Promise<void> {
    await this.db?.end().catch(() => undefined);
    await this.scratch?.destroy().catch(() => undefined);
  }

  async head(): Promise<number> {
    const rows = await this.db.asOwner((q) =>
      q.query<{ m: string | null }>('select max(seq)::text m from public.workspace_events where space_id = $1', [this.spaceId]));
    return Number(rows[0]?.m ?? 0);
  }

  async createTask(title: string, parentId: string | null = null): Promise<string> {
    const r = await this.db.rpc<CommandResult>(this.claims(), 'public.create_task', [
      this.spaceId, title, this.memberId, '', '{}', parentId,
      null, 'medium', '[]', null, null, null, null, 'attached_to', cmid(),
    ]);
    return r.entity.id;
  }

  async version(id: string): Promise<number> {
    const rows = await this.db.asOwner((q) =>
      q.query<{ version: number }>('select version from public.entities where id = $1', [id]));
    return rows[0]!.version;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.db.rpc(this.claims(), 'public.update_task_content', [
      id, await this.version(id), this.memberId, title, null, null, null, null, null, null, null, false, null, false,
    ]);
  }

  async setStatus(id: string, status: string): Promise<void> {
    await this.db.rpc(this.claims(), 'public.update_task_content', [
      id, await this.version(id), this.memberId, null, null, null, status, null, null, null, null, false, null, false,
    ]);
  }

  /** `done` is not a work_status edit — completion goes through `complete_task`. */
  async complete(id: string): Promise<void> {
    await this.db.rpc(this.claims(), 'public.complete_task', [id, await this.version(id), '{}', this.memberId, cmid()]);
  }

  async post(anchorId: string, body: string, mentions: unknown[] = []): Promise<string> {
    const r = await this.db.asOwner((q) => q.rpc<CommandResult>('public.post_message', [
      anchorId, body, this.memberId, null, JSON.stringify(mentions), '[]', cmid(),
    ]), this.claims());
    return r.entity.id;
  }

  async edge(src: string, dst: string, type: string): Promise<string> {
    const r = await this.db.rpc<{ edge?: { id: string }; entity?: { id: string } } & Record<string, unknown>>(
      this.claims(), 'public.write_edge', [src, dst, type, '{}', this.memberId, cmid()],
    );
    const id = (r.edge?.id ?? (r as { id?: string }).id) as string | undefined;
    if (id !== undefined) return id;
    const rows = await this.db.asOwner((q) => q.query<{ id: string }>(
      'select id from public.edges where src_id = $1 and dst_id = $2 and type = $3', [src, dst, type]));
    return rows[0]!.id;
  }

  async linkPr(taskId: string, n: number): Promise<string> {
    await this.db.rpc(this.claims(), 'public.link_pull_request', [
      taskId, `https://github.com/acme/repo/pull/${String(n)}`, 'github', 'acme/repo', n, null, this.memberId, cmid(),
    ]);
    const rows = await this.db.asOwner((q) => q.query<{ id: string }>(
      `select ed.dst_id::text id from public.edges ed join public.entities d on d.id = ed.dst_id
        where ed.src_id = $1 and ed.type = 'tracks' and d.kind = 'pull_request'`, [taskId]));
    return rows[0]!.id;
  }

  /** A work session as the product makes one: envelope, then a `spawning` detail row (owner SQL). */
  async createSession(title: string): Promise<string> {
    return this.db.asOwner(async (q) => {
      const rows = await q.query<{ id: string }>(
        `insert into public.entities(space_id,kind,parent_id,position,created_by)
         values($1,'work_session',null,0,$2) returning id::text id`,
        [this.spaceId, this.memberId],
      );
      const id = rows[0]!.id;
      await q.query(`insert into public.work_sessions(entity_id,title,status,workdir_mode) values($1,$2,'spawning','scratch')`, [id, title]);
      return id;
    });
  }

  async transition(sessionId: string, status: string, endedKind: string | null = null, reason: string | null = null): Promise<void> {
    await this.db.tx(this.claims(), (q) =>
      q.query('select public.work_session_transition($1,$2,null,null,null,$3,$4,$5)', [
        sessionId, status, cmid(), endedKind, reason,
      ]));
  }

  async channelId(): Promise<string> {
    const rows = await this.db.asOwner((q) => q.query<{ id: string }>(
      `select id::text id from public.entities where space_id = $1 and kind = 'channel' order by created_at limit 1`,
      [this.spaceId]));
    return rows[0]!.id;
  }

  /** Hard delete, as the superuser — no RPC hard-deletes. */
  async hardDelete(id: string): Promise<void> {
    await this.db.asOwner((q) => q.query('delete from public.entities where id = $1', [id]));
  }
}
