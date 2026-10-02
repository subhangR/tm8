/**
 * Migration 266 — Attention v2 system signals (slice S6, spec chapter 2).
 *
 * tm8 raises its own requests (origin 'system', keyed by signal_key) and clears
 * them itself (status 'cleared', no resolver, no delivery) when the condition
 * ends. Forms are covered through the real form RPCs in forms-ops.pg.test.ts;
 * this file covers the blocked-dependency signal, the conflict door the CLI
 * calls (public.raise_system_attention / clear_system_attention), and the
 * announce_unblocked hook a completed task now reaches.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  identityId: string;
  strangerIdentityId: string;
  spaceId: string;
  memberId: string;
  agentId: string;
  worktreeId: string;
  sessionId: string;
  linkedTaskId: string;
  unrelatedTaskId: string;
}

interface Row extends Record<string, unknown> {
  status: string;
  origin: string;
  signal_key: string | null;
  level: string;
  action_type: string;
  points: number;
  reason: string;
  resolved_by: string | null;
  note_deliver_after: string | null;
  requested_by: string;
}

describe.sequential('attention v2 system signals (migration 266)', () => {
  let database: W1ScratchDatabase;
  let f: Fixture;

  const q = <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    database.query<R>(sql, params);

  const asOwner = <T>(fn: (c: PoolClient) => Promise<T>) =>
    database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      return fn(c);
    });

  const asMember = <T>(identity: string, fn: (c: PoolClient) => Promise<T>) =>
    database.transaction(async (c) => {
      await c.query('set local role tm8_app');
      await c.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                            set_config('tm8.node_admin', 'false', true)`, [identity]);
      return fn(c);
    });

  const newTask = (title: string) =>
    asOwner(async (c) => {
      const id = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await c.query(`insert into public.entities(id,space_id,kind,parent_id,position,created_by)
                     values($1,$2,'task',null,0,$3)`, [id, f.spaceId, f.memberId]);
      await c.query(`insert into public.tasks(entity_id,title,work_status) values($1,$2,'open')`, [id, title]);
      return id;
    });

  const edge = (src: string, dst: string, type: string, props: Record<string, unknown> = {}) =>
    asOwner(async (c) => (await c.query<{ id: string }>(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by) values($1,$2,$3,$4,$5,$6) returning id::text`,
      [f.spaceId, src, dst, type, JSON.stringify(props), f.memberId],
    )).rows[0]!.id);

  const complete = (taskId: string) =>
    asOwner((c) => c.query(`update public.tasks set work_status = 'done' where entity_id = $1`, [taskId]));

  const requests = (entityId: string) =>
    q<Row>(`select status, origin, signal_key, level, action_type, points, reason, resolved_by::text,
                   note_deliver_after, requested_by::text
              from public.attention_requests where entity_id = $1 order by created_at, id`, [entityId]);

  beforeAll(async () => {
    database = await createW1ScratchDatabase('attention_system_signals');
    database.apply(migrationFiles());
    f = await asOwner(async (c) => {
      const x = (await c.query<Fixture>(
        `select 'signals-owner'::text "identityId", 'signals-stranger'::text "strangerIdentityId",
                internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
                internal.new_id()::text "agentId", internal.new_id()::text "worktreeId",
                internal.new_id()::text "sessionId", internal.new_id()::text "linkedTaskId",
                internal.new_id()::text "unrelatedTaskId"`,
      )).rows[0]!;
      await c.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Owner'),($2,'Stranger')`,
        [x.identityId, x.strangerIdentityId]);
      await c.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Signals',$2)`, [x.spaceId, x.identityId]);
      await c.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
           ($1,$2,'member',null,0,$1), ($3,$2,'team_member',null,1,$1), ($4,$2,'worktree',null,2,$1),
           ($5,$2,'work_session',null,3,$1), ($6,$2,'task',null,4,$1), ($7,$2,'task',null,5,$1)`,
        [x.memberId, x.spaceId, x.agentId, x.worktreeId, x.sessionId, x.linkedTaskId, x.unrelatedTaskId],
      );
      await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name)
                     values($1,$2,$3,'owner','Owner')`, [x.memberId, x.spaceId, x.identityId]);
      await c.query(`insert into public.tasks(entity_id,title,work_status) values($1,'Linked','open'),($2,'Unrelated','open')`,
        [x.linkedTaskId, x.unrelatedTaskId]);
      const project = (await c.query<{ id: string }>(
        `insert into public.projects(id,name,working_dir) values(internal.new_id(),'signals','/tmp/signals-repo') returning id::text`,
      )).rows[0]!.id;
      // W11-repoint: a worktree is keyed on the space's project entity, not the folder.
      await c.query(`insert into public.space_projects(space_id,project_id,linked_by) values($1,$2,$3)`,
        [x.spaceId, project, x.memberId]);
      await c.query(
        `insert into public.worktrees(entity_id,space_id,project_entity_id,path,branch,base_ref,base_commit_oid,status)
         select $1,$2,l.project_entity_id,'/tmp/signals-wt','tm8/signals','main',repeat('a',40),'active'
           from public.project_links l where l.space_id = $2 and l.project_id = $3`, [x.worktreeId, x.spaceId, project]);
      return x;
    });
    // The session lives in the worktree and works on the linked task.
    await edge(f.sessionId, f.worktreeId, 'in_worktree');
    await edge(f.sessionId, f.linkedTaskId, 'working_on');
  }, 240_000);

  afterAll(async () => database?.destroy(), 30_000);

  describe('blocked dependency (R6)', () => {
    it('raises unblock only once work is waiting, and clears when the blocker completes', async () => {
      const blocked = await newTask('Ship refunds');
      const blocker = await newTask('Wire refund webhook');
      const dep = await edge(blocked, blocker, 'depends_on');
      // No assignee and no live session: nothing is waiting, nothing raised.
      expect(await requests(blocked)).toEqual([]);

      await edge(blocked, f.memberId, 'assigned_to');
      const raised = await requests(blocked);
      expect(raised).toEqual([expect.objectContaining({
        status: 'open', origin: 'system', signal_key: `depends_on:${dep}`, level: 'normal',
        action_type: 'unblock', points: 40, reason: 'Blocked by: Wire refund webhook', requested_by: f.memberId,
      })]);
      // A second trigger (another assignee) dedupes on the key.
      await edge(blocked, f.agentId, 'assigned_to');
      expect(await requests(blocked)).toHaveLength(1);

      // The real completion door: tasks.work_status -> the category bridge ->
      // entities_announce_unblocked -> announce_unblocked clears it.
      await complete(blocker);
      expect((await q<{ status_category: string }>('select status_category from public.entities where id = $1', [blocker]))[0])
        .toEqual({ status_category: 'done' });
      expect(await requests(blocked)).toEqual([expect.objectContaining({
        status: 'cleared', signal_key: `depends_on:${dep}`, resolved_by: null, note_deliver_after: null,
      })]);
      // And the unblocked announcement itself now fires for a completed task.
      expect(await q('select 1 from public.activity where entity_id = $1 and verb = $2', [blocked, 'unblocked']))
        .toHaveLength(1);
    });

    it('raises when a live session starts working on the blocked task', async () => {
      const blocked = await newTask('Blocked by session');
      const blocker = await newTask('Blocker for session');
      const dep = await edge(blocked, blocker, 'depends_on');
      const session = await asOwner(async (c) => {
        const id = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
        await c.query(`insert into public.entities(id,space_id,kind,parent_id,position,created_by)
                       values($1,$2,'work_session',null,0,$3)`, [id, f.spaceId, f.memberId]);
        await c.query(`insert into public.work_sessions(entity_id,status,workdir_mode) values($1,'running','scratch')`, [id]);
        return id;
      });
      await edge(session, blocked, 'working_on');
      expect(await requests(blocked)).toEqual([expect.objectContaining({ status: 'open', signal_key: `depends_on:${dep}` })]);
    });

    it('raises one request per unresolved blocker, and each clears on its own', async () => {
      const blocked = await newTask('Two blockers');
      const a = await newTask('Blocker A');
      const b = await newTask('Blocker B');
      await edge(blocked, f.memberId, 'assigned_to');
      const depA = await edge(blocked, a, 'depends_on');
      const depB = await edge(blocked, b, 'depends_on');
      const open = () => requests(blocked).then((rows) => rows.filter((r) => r.status === 'open').map((r) => r.signal_key));
      expect((await open()).sort()).toEqual([`depends_on:${depA}`, `depends_on:${depB}`].sort());
      await complete(a);
      expect(await open()).toEqual([`depends_on:${depB}`]);
    });

    it('does not raise for a resolved blocker or a soft edge, and clears on delete and on soft', async () => {
      const blocked = await newTask('Edge changes');
      await edge(blocked, f.memberId, 'assigned_to');
      const done = await newTask('Already done');
      await complete(done);
      await edge(blocked, done, 'depends_on');
      const soft = await newTask('Soft blocker');
      await edge(blocked, soft, 'depends_on', { hard: false });
      expect(await requests(blocked)).toEqual([]);

      const hardToSoft = await newTask('Becomes soft');
      const hardEdge = await edge(blocked, hardToSoft, 'depends_on');
      const deleted = await newTask('Edge deleted');
      const deletedEdge = await edge(blocked, deleted, 'depends_on');
      expect(await requests(blocked)).toHaveLength(2);

      await asOwner((c) => c.query(`update public.edges set props = '{"hard": false}' where id = $1`, [hardEdge]));
      await asOwner((c) => c.query('delete from public.edges where id = $1', [deletedEdge]));
      expect((await requests(blocked)).map((r) => [r.signal_key, r.status])).toEqual([
        [`depends_on:${hardEdge}`, 'cleared'],
        [`depends_on:${deletedEdge}`, 'cleared'],
      ]);
    });

    it("clears the blocked task's own signals when the blocked task itself completes", async () => {
      const blocked = await newTask('Done anyway');
      const blocker = await newTask('Still open');
      await edge(blocked, f.memberId, 'assigned_to');
      await edge(blocked, blocker, 'depends_on');
      expect((await requests(blocked))[0]!.status).toBe('open');
      await complete(blocked);
      expect((await requests(blocked))[0]!.status).toBe('cleared');
    });
  });

  describe('race: blocker completion vs a concurrent assignment', () => {
    it('an assignment racing a completing blocker waits for it and raises nothing', async () => {
      const blocked = await newTask('Racing waiter');
      const blocker = await newTask('Racing blocker');
      await edge(blocked, blocker, 'depends_on');
      let updated!: () => void;
      const t1Updated = new Promise<void>((r) => { updated = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // T1 completes the blocker and holds its row until the gate opens.
      const t1 = asOwner(async (c) => {
        await c.query(`update public.tasks set work_status = 'done' where entity_id = $1`, [blocker]);
        updated();
        await gate;
      });
      await t1Updated;
      // T2 assigns the waiter while T1 is uncommitted: its raise must wait.
      let t2Done = false;
      const t2 = edge(blocked, f.memberId, 'assigned_to').then(() => { t2Done = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(t2Done).toBe(false);
      release();
      await Promise.all([t1, t2]);
      expect(await requests(blocked)).toEqual([]);
    });
  });

  describe('situations that end unresolved', () => {
    it('a cancelled or soft-deleted blocked task clears its own signals', async () => {
      for (const end of ['cancel', 'delete'] as const) {
        const blocked = await newTask(`Ends by ${end}`);
        await edge(blocked, f.memberId, 'assigned_to');
        await edge(blocked, await newTask(`Blocker for ${end}`), 'depends_on');
        expect((await requests(blocked))[0]!.status).toBe('open');
        await asOwner((c) => c.query(end === 'cancel'
          ? `update public.tasks set work_status = 'cancelled' where entity_id = $1`
          : 'update public.entities set deleted_at = now() where id = $1', [blocked]));
        expect((await requests(blocked))[0]!.status).toBe('cleared');
      }
    });

    it('a soft-deleted worktree clears its conflict signals', async () => {
      const wt = await asOwner(async (c) => {
        const id = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
        await c.query(`insert into public.entities(id,space_id,kind,parent_id,position,created_by)
                       values($1,$2,'worktree',null,0,$3)`, [id, f.spaceId, f.memberId]);
        return id;
      });
      await asMember(f.identityId, (c) => c.query('select public.raise_system_attention($1, $2::jsonb, $3)',
        [wt, JSON.stringify({ kind: 'conflict', worktreeId: wt, flow: 'merge' }), 'merge conflict']));
      expect((await requests(wt))[0]!.status).toBe('open');
      await asOwner((c) => c.query('update public.entities set deleted_at = now() where id = $1', [wt]));
      expect((await requests(wt))[0]!.status).toBe('cleared');
    });
  });

  describe('merge conflict door (CLI; spec-owner ruling on S6)', () => {
    const signal = (flow = 'merge') => JSON.stringify({ kind: 'conflict', worktreeId: f.worktreeId, flow });

    const raise = (identity: string, entityId: string, sig = signal(), reason = 'merge conflict on tm8/x, 2 path(s)') =>
      asMember(identity, async (c) => (await c.query<{ r: Record<string, unknown> }>(
        'select public.raise_system_attention($1, $2::jsonb, $3) r', [entityId, sig, reason])).rows[0]!.r);
    const clear = (identity: string, entityId: string, sig = signal()) =>
      asMember(identity, async (c) => (await c.query<{ r: Record<string, unknown> }>(
        'select public.clear_system_attention($1, $2::jsonb) r', [entityId, sig])).rows[0]!.r);

    it('raises high / review with the server-built key, attributed to the caller, and dedupes', async () => {
      const first = await raise(f.identityId, f.linkedTaskId);
      expect(first).toMatchObject({ entityId: f.linkedTaskId, affectedCount: 1 });
      const again = await raise(f.identityId, f.linkedTaskId, signal(), 'a different reason');
      expect(again).toMatchObject({ attentionRequestId: first['attentionRequestId'], affectedCount: 0 });
      expect(await requests(f.linkedTaskId)).toEqual([expect.objectContaining({
        status: 'open', origin: 'system', signal_key: `conflict:${f.worktreeId}:merge`, level: 'high',
        action_type: 'review', points: 70, reason: 'merge conflict on tm8/x, 2 path(s)', requested_by: f.memberId,
      })]);
    });

    it('clears from the worktree whatever anchor it was raised on; a repeat is a no-op', async () => {
      expect(await clear(f.identityId, f.worktreeId)).toMatchObject({ affectedCount: 1 });
      expect(await requests(f.linkedTaskId)).toEqual([expect.objectContaining({
        status: 'cleared', resolved_by: null, note_deliver_after: null,
      })]);
      expect(await clear(f.identityId, f.worktreeId)).toMatchObject({ affectedCount: 0 });
    });

    it('accepts the worktree, its session and a linked task as the target, and refuses anything else', async () => {
      await raise(f.identityId, f.worktreeId);
      await raise(f.identityId, f.sessionId);
      await expect(raise(f.identityId, f.unrelatedTaskId)).rejects.toThrow(/not linked to that worktree/);
      expect(await clear(f.identityId, f.sessionId)).toMatchObject({ affectedCount: 2 });
    });

    it('takes only the closed vocabulary: no free-form key, no unknown kind, no foreign worktree', async () => {
      await expect(raise(f.identityId, f.worktreeId, JSON.stringify({ kind: 'permission_prompt', worktreeId: f.worktreeId })))
        .rejects.toThrow(/unknown system attention signal kind/);
      await expect(raise(f.identityId, f.worktreeId, JSON.stringify({ signalKey: 'form:x' })))
        .rejects.toThrow(/unknown system attention signal kind/);
      await expect(raise(f.identityId, f.linkedTaskId, JSON.stringify({ kind: 'conflict', worktreeId: f.unrelatedTaskId, flow: 'merge' })))
        .rejects.toThrow(/needs a worktree in this space/);
      await expect(raise(f.identityId, f.worktreeId, JSON.stringify({ kind: 'conflict', worktreeId: 'nope', flow: 'merge' })))
        .rejects.toThrow(/needs a worktree in this space/);
      await expect(raise(f.identityId, f.worktreeId, signal(), '   ')).rejects.toThrow(/between 1 and 500/);
      // Closed at the SQL level, not only by the HTTP schema.
      await expect(raise(f.identityId, f.worktreeId,
        JSON.stringify({ kind: 'conflict', worktreeId: f.worktreeId, flow: 'merge', level: 'urgent' })))
        .rejects.toThrow(/names only kind, worktreeId and flow/);
      for (const flow of [undefined, 'rebase', 'MERGE']) {
        await expect(raise(f.identityId, f.worktreeId, JSON.stringify({ kind: 'conflict', worktreeId: f.worktreeId, flow })))
          .rejects.toThrow(/flow must be merge, cherry_pick or stash_pop/);
      }
    });

    it('a linked anchor means in_worktree (or working_on via a session in it), not any edge', async () => {
      const related = await newTask('Only related');
      await edge(related, f.worktreeId, 'relates_to');
      await expect(raise(f.identityId, related)).rejects.toThrow(/not linked to that worktree/);
      const inWorktree = await newTask('In the worktree');
      await edge(inWorktree, f.worktreeId, 'in_worktree');
      expect(await raise(f.identityId, inWorktree)).toMatchObject({ affectedCount: 1 });
      expect(await clear(f.identityId, f.worktreeId)).toMatchObject({ affectedCount: 1 });
    });

    it('is per flow: a clean stash_pop leaves an open merge conflict open (ch2: the same flow clears)', async () => {
      await raise(f.identityId, f.linkedTaskId, signal('merge'));
      expect(await clear(f.identityId, f.worktreeId, signal('stash_pop'))).toMatchObject({ affectedCount: 0 });
      expect(await clear(f.identityId, f.worktreeId, signal('cherry_pick'))).toMatchObject({ affectedCount: 0 });
      expect((await requests(f.linkedTaskId)).filter((r) => r.status === 'open').map((r) => r.signal_key))
        .toEqual([`conflict:${f.worktreeId}:merge`]);
      expect(await clear(f.identityId, f.worktreeId, signal('merge'))).toMatchObject({ affectedCount: 1 });
    });

    it('a retired worktree clears all three of its conflict keys', async () => {
      await raise(f.identityId, f.linkedTaskId, signal('merge'));
      await raise(f.identityId, f.sessionId, signal('cherry_pick'));
      await raise(f.identityId, f.worktreeId, signal('stash_pop'));
      const open = async () => (await q<{ signal_key: string }>(
        `select signal_key from public.attention_requests
          where space_id = $1 and signal_key like 'conflict:%' and status = 'open' order by signal_key`, [f.spaceId]))
        .map((r) => r.signal_key);
      expect(await open()).toEqual(['cherry_pick', 'merge', 'stash_pop'].map((fl) => `conflict:${f.worktreeId}:${fl}`));
      // The transition door's claim (057's single-writer guard), set the way update_worktree sets it.
      const transition = (to: string) => asOwner(async (c) => {
        await c.query(`select set_config('tm8.worktree_transition', 'on', true)`);
        await c.query('update public.worktrees set status = $2 where entity_id = $1', [f.worktreeId, to]);
      });
      await transition('merged');
      expect(await open()).toEqual([]);
      await transition('active');
    });

    it('refuses a caller who is not a member of the space', async () => {
      await expect(raise(f.strangerIdentityId, f.worktreeId)).rejects.toThrow();
      await expect(clear(f.strangerIdentityId, f.worktreeId)).rejects.toThrow();
    });
  });

  describe('grants', () => {
    it('only the two CLI doors are callable by tm8_app, and nothing new by PUBLIC', async () => {
      const rows = await q<{ fn: string; app: boolean; pub: boolean }>(
        `select p.oid::regprocedure::text fn,
                has_function_privilege('tm8_app', p.oid, 'execute') app,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
                         where grantee = 0 and privilege_type = 'EXECUTE') pub
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where (ns.nspname, p.proname) in (('internal','raise_attention_signal'), ('internal','clear_attention_signal'),
                  ('internal','system_signal_key'), ('internal','raise_blocked_dependencies'),
                  ('internal','edges_blocked_dependency_signal'), ('internal','on_status_category_done'),
                  ('internal','clear_ended_attention_signals'), ('internal','on_entity_ended'),
                  ('internal','on_worktree_retired'),
                  ('public','raise_system_attention'), ('public','clear_system_attention'))
          order by 1`,
      );
      expect(rows).toHaveLength(11);
      expect(rows.filter((r) => r.pub)).toEqual([]);
      expect(rows.filter((r) => r.app).map((r) => r.fn.replace(/\(.*$/, '')).sort())
        .toEqual(['clear_system_attention', 'raise_system_attention']);
    });
  });
});
