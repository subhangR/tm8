/**
 * Craft workspaces (Craft redesign doc 01a1255d §3 "Persistence", §4; contract
 * `packages/contract/src/craft-workspace.ts`; migration 315).
 *
 * One hidden row of `public.workspaces` per (space, identity, craft): the tabs
 * a person has open on a craft, and whether the craft is in their Craft top
 * bar. Reads and writes run as the caller (`tm8_app`, identity-equality RLS);
 * the writes go through `craft_workspace_save` (tab state, compare-and-swap) and
 * `craft_workspace_list_apply` (the open-crafts list, read-modify-written under
 * the database lock).
 *
 * A tab shows the craft itself or one of its DIRECT pages (a `contains` edge
 * from the craft). Removing the edge prunes the tab in the database, for every
 * person, at once (migration 315's trigger). A page soft-deleted instead is
 * pruned on the next read or command, and that prune is SAVED (as no one: it
 * stamps no agent change) and pushed, before the command runs or is refused.
 *
 * Writes are serialized per (space, identity) in this process, like Home
 * workspaces; the revision compare-and-swap catches the rest.
 */
import { randomUUID } from 'node:crypto';

import {
  CollabError,
  CRAFT_OPEN_CAP,
  CRAFT_TAB_KINDS,
  CRAFT_WORKSPACE_ARG_SCHEMAS,
  CRAFT_WORKSPACE_TAB_CAP,
  craftTabKind,
  defaultCraftWorkspaceState,
  sanitizeCraftWorkspaceState,
  type CraftTab,
  type CraftWorkspace,
  type CraftWorkspaceCommand,
  type CraftWorkspaceCommandInput,
  type CraftWorkspaceCommandResult,
  type CraftWorkspaceFrame,
  type CraftWorkspaceListResult,
  type CraftWorkspaceResultReason,
  type CraftWorkspacesFrame,
  type CraftWorkspaceState,
} from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import type { WorkspaceBridge } from './bridge.js';

type Query = <R>(sql: string, params?: unknown[]) => Promise<R[]>;

export interface CraftActor {
  actorClass: 'human' | 'agent';
  actorName?: string;
  actorId?: string;
}

interface Row {
  workspace_id: string;
  craft_id: string;
  state: unknown;
  revision: string | number;
  open: boolean;
  position: number;
  updated_at: Date | string | null;
  last_agent_change_at: Date | string | null;
  last_agent_actor_id: string | null;
}

const ROW_COLUMNS = `w.workspace_id, w.scope_entity_id as craft_id, w.state, w.revision, w.open, w.position,
  w.updated_at, w.last_agent_change_at, w.last_agent_actor_id`;

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** Unscoped craft kinds, until the design→craft rename (L1) lands everywhere. */
const CRAFT_KINDS_SQL = `('craft', 'design')`;

/** Who a prune is saved as: no actor, so it never reads as an agent's change. */
const SYSTEM: CraftActor = { actorClass: 'human' };

class Refused extends Error {
  constructor(readonly reason: CraftWorkspaceResultReason, message: string) {
    super(message);
  }
}

export class CraftWorkspaceService {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: { db: Db; bridge: WorkspaceBridge }) {}

  /** The person's craft workspaces in the space, in `position` order; crafts they can no longer read are left out. */
  async list(claims: DbClaims, spaceId: string): Promise<CraftWorkspaceListResult> {
    const views = await this.views(claims, spaceId);
    if (views.some((v) => v.pruned)) {
      return this.serialize(claims, spaceId, async () => {
        const items: CraftWorkspace[] = [];
        for (const v of await this.views(claims, spaceId)) {
          items.push(v.pruned ? await this.persistPrune(claims, spaceId, v.workspace) : v.workspace);
        }
        return { items, openCap: CRAFT_OPEN_CAP };
      });
    }
    return { items: views.map((v) => v.workspace), openCap: CRAFT_OPEN_CAP };
  }

  /** One craft's workspace (the default when the person has none yet). A read that prunes saves and pushes. */
  get(claims: DbClaims, spaceId: string, craftId: string): Promise<CraftWorkspace> {
    return this.serialize(claims, spaceId, async () => (await this.loadPersisted(claims, spaceId, craftId)).workspace);
  }

  /** One command on one craft's workspace (contract `workspace.crafts.command`). */
  command(
    claims: DbClaims,
    spaceId: string,
    craftId: string,
    input: CraftWorkspaceCommandInput,
    actor: CraftActor,
  ): Promise<CraftWorkspaceCommandResult> {
    return this.serialize(claims, spaceId, async () => {
      const stored = await this.load(claims, spaceId, craftId);
      const loaded = stored.pruned ? await this.loadPersisted(claims, spaceId, craftId) : stored;
      const ws = loaded.workspace;
      const result = (status: CraftWorkspaceCommandResult['status'], workspace: CraftWorkspace, extra: Partial<CraftWorkspaceCommandResult> = {}): CraftWorkspaceCommandResult =>
        ({ requestId: input.requestId, status, ...extra, workspace });
      // The revision the caller saw is the stored one, from before any prune made here.
      if (input.expectedRevision !== undefined && input.expectedRevision !== stored.workspace.revision) {
        return result('conflict', ws, { reason: 'revision_conflict' });
      }
      const parsed = CRAFT_WORKSPACE_ARG_SCHEMAS[input.command].safeParse(input.args);
      if (!parsed.success) return result('rejected', ws, { reason: 'invalid_arguments' });
      const args = (parsed.data ?? {}) as Record<string, unknown>;

      if (input.command.startsWith('craft.')) {
        try {
          const changed = await this.arrange(claims, spaceId, craftId, loaded.workspace, input.command, args, actor);
          const after = (await this.load(claims, spaceId, craftId)).workspace;
          if (!changed) return result('no_op', after);
          await this.pushList(claims, spaceId);
          return result('applied', after);
        } catch (error) {
          if (error instanceof Refused) return result('rejected', ws, { reason: error.reason });
          throw error;
        }
      }

      let step: { state: CraftWorkspaceState; tabId?: string; outcome?: 'created' | 'reused' };
      try {
        step = await this.reduce(claims, spaceId, craftId, ws.state, input.command, args);
      } catch (error) {
        if (error instanceof Refused) return result('rejected', ws, { reason: error.reason });
        throw error;
      }
      const extra = { ...(step.tabId ? { tabId: step.tabId } : {}), ...(step.outcome ? { outcome: step.outcome } : {}) };
      if (sameState(step.state, ws.state)) return result('no_op', ws, extra);
      const saved = await this.save(claims, spaceId, craftId, ws, step.state, actor);
      if (saved === null) {
        return result('conflict', (await this.load(claims, spaceId, craftId)).workspace, { reason: 'revision_conflict' });
      }
      this.pushOne(claims, spaceId, saved, {
        requestId: input.requestId,
        command: input.command,
        actorClass: actor.actorClass,
        ...(actor.actorName ? { actorName: actor.actorName } : {}),
      });
      return result('applied', saved, extra);
    });
  }

  /**
   * §4: may this agent command the caller's workspace for `craftId`? The ids
   * come off the verified bearer, never the body, and the binding to the craft
   * must be one the agent could not have made itself:
   *  - a chat the caller started (`configured_by_identity_id`) whose `about`
   *    edge to the craft was written in the transaction that created the chat
   *    (start_chat; same `created_at`), or
   *  - a work session whose `about` edge to the craft was written in the
   *    transaction that created it (execution.spawn `aboutEntityId`, which only
   *    a person, or a chat runtime for its own sessions, may set: 315
   *    work_session_about), and that the caller started: its creator is the
   *    caller's member, or its parent is a chat the caller started.
   * An `about` edge an agent adds later (edges.create) binds nothing, and nor
   * does merely being spawned under the craft's chat: any session token may
   * name a parent.
   */
  async agentMayCommand(claims: DbClaims, craftId: string, ids: { chatId?: string; workSessionId?: string }): Promise<boolean> {
    if (ids.chatId === undefined && ids.workSessionId === undefined) return false;
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ ok: boolean }>(
        `with chat_ok as (
           select c.id
             from public.entities c
             join public.chats ch on ch.entity_id = c.id
             join public.edges e on e.src_id = c.id and e.type = 'about' and e.dst_id = $1
                                and e.created_at = c.created_at
            where c.kind = 'chat' and c.deleted_at is null
              and ch.configured_by_identity_id = (select internal.identity_id())
         )
         select exists (select 1 from chat_ok where id = $2::uuid)
             or exists (
                  select 1 from public.entities s
                   where s.id = $3::uuid and s.kind = 'work_session' and s.deleted_at is null
                     and exists (
                       select 1 from public.edges e
                        where e.src_id = s.id and e.type = 'about' and e.dst_id = $1 and e.created_at = s.created_at
                     )
                     and (
                       exists (
                         select 1 from public.members m
                          where m.entity_id = s.created_by and m.identity_id = (select internal.identity_id())
                       )
                       or exists (
                         select 1 from public.chats ch
                          where ch.entity_id = s.parent_id and ch.configured_by_identity_id = (select internal.identity_id())
                       )
                     )
                ) as ok`,
        [craftId, ids.chatId ?? null, ids.workSessionId ?? null],
      );
      return rows[0]?.ok === true;
    });
  }

  // ---------------------------------------------------------------------------

  private async rows(q: Query, spaceId: string, craftId?: string): Promise<Row[]> {
    return q<Row>(
      `select ${ROW_COLUMNS}
         from public.workspaces w
         join public.entities c on c.id = w.scope_entity_id and c.deleted_at is null
        where w.space_id = $1 and w.identity_id = (select internal.identity_id())
          and w.scope_entity_id is not null
          and ($2::uuid is null or w.scope_entity_id = $2::uuid)
        order by w.position, w.created_at, w.workspace_id`,
      [spaceId, craftId ?? null],
    );
  }

  /** For each craft: the ids its tabs may show (itself and its readable direct pages). */
  private async pagesOf(q: Query, craftIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>(craftIds.map((id) => [id, new Set([id])]));
    if (craftIds.length === 0) return out;
    const rows = await q<{ src_id: string; dst_id: string }>(
      `select e.src_id, e.dst_id
         from public.edges e
         join public.entities p on p.id = e.dst_id and p.deleted_at is null
        where e.type = 'contains' and e.src_id = any($1::uuid[])`,
      [craftIds],
    );
    for (const r of rows) out.get(r.src_id)?.add(r.dst_id);
    return out;
  }

  private view(row: Row | null, pages: Set<string>, craftId?: string, position = 0): { workspace: CraftWorkspace; pruned: boolean } {
    const id = row?.craft_id ?? craftId!;
    const clean = row ? sanitizeCraftWorkspaceState(row.state, id) : defaultCraftWorkspaceState(id);
    const tabs = clean.tabs.filter((t) => t.pinned || pages.has(t.entityId));
    const pruned = tabs.length !== clean.tabs.length;
    const state: CraftWorkspaceState = { tabs, activeTabId: tabs.some((t) => t.id === clean.activeTabId) ? clean.activeTabId : id };
    return {
      pruned,
      workspace: {
        workspaceId: row?.workspace_id ?? null,
        craftId: id,
        revision: row ? Number(row.revision) : 0,
        open: row?.open ?? false,
        position: row ? Number(row.position) : position,
        state,
        updatedAt: row ? iso(row.updated_at) : null,
        lastAgentChange: row?.last_agent_change_at
          ? { at: iso(row.last_agent_change_at)!, actorId: row.last_agent_actor_id }
          : null,
      },
    };
  }

  /** Every workspace in the list, pruned in view, and whether the prune is unsaved. */
  private views(claims: DbClaims, spaceId: string): Promise<Array<{ workspace: CraftWorkspace; pruned: boolean }>> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const query = q.query.bind(q) as Query;
      const rows = await this.rows(query, spaceId);
      const pages = await this.pagesOf(query, rows.map((r) => r.craft_id));
      return rows.map((r) => this.view(r, pages.get(r.craft_id) ?? new Set()));
    });
  }

  /** Save a prune seen on read, as no one, and push it; on a lost race, whatever is stored now. Call serialized. */
  private async persistPrune(claims: DbClaims, spaceId: string, ws: CraftWorkspace): Promise<CraftWorkspace> {
    const saved = await this.save(claims, spaceId, ws.craftId, ws, ws.state, SYSTEM);
    if (saved === null) return (await this.load(claims, spaceId, ws.craftId)).workspace;
    this.pushOne(claims, spaceId, saved);
    return saved;
  }

  /** load(), with an unsaved prune saved first. Call serialized. */
  private async loadPersisted(claims: DbClaims, spaceId: string, craftId: string): Promise<Awaited<ReturnType<CraftWorkspaceService['load']>>> {
    const loaded = await this.load(claims, spaceId, craftId);
    if (!loaded.pruned || loaded.row === null) return loaded;
    await this.persistPrune(claims, spaceId, loaded.workspace);
    return this.load(claims, spaceId, craftId);
  }

  /** The craft's workspace as stored (or the default), pruned; `craft_not_found` (404) when the caller cannot read the craft. */
  private load(claims: DbClaims, spaceId: string, craftId: string): Promise<{ row: Row | null; workspace: CraftWorkspace; pruned: boolean; all: Row[] }> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const query = q.query.bind(q) as Query;
      const craft = await query(
        `select 1 from public.entities where id = $1 and space_id = $2 and kind in ${CRAFT_KINDS_SQL} and deleted_at is null`,
        [craftId, spaceId],
      );
      if (craft.length === 0) {
        throw new CollabError('not_found', `no craft ${craftId}`, { details: { reason: 'craft_not_found' } });
      }
      const all = await this.rows(query, spaceId);
      const row = all.find((r) => r.craft_id === craftId) ?? null;
      const pages = await this.pagesOf(query, [craftId]);
      const next = all.length === 0 ? 0 : Math.max(...all.map((r) => Number(r.position))) + 1;
      return { row, all, ...this.view(row, pages.get(craftId)!, craftId, next) };
    });
  }

  /** CAS write; null when the revision moved underneath (another node). */
  private async save(
    claims: DbClaims,
    spaceId: string,
    craftId: string,
    ws: CraftWorkspace,
    state: CraftWorkspaceState,
    actor: CraftActor,
  ): Promise<CraftWorkspace | null> {
    try {
      await this.deps.db.tx(claims, async (q) => {
        await q.query('set local role tm8_app');
        await q.query('select public.craft_workspace_save($1, $2, $3, $4, $5::jsonb, $6, $7)', [
          spaceId,
          craftId,
          ws.revision,
          ws.revision + 1,
          JSON.stringify(state),
          actor.actorClass === 'agent' ? (actor.actorId ?? null) : null,
          actor.actorClass === 'agent',
        ]);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '40001') return null;
      throw error;
    }
    return (await this.load(claims, spaceId, craftId)).workspace;
  }

  /**
   * craft.open / craft.close / craft.move: one call that reads and writes the
   * person's list under the database lock, so concurrent commands (any node)
   * cannot overwrite each other. Only this craft's `open` flag changes.
   */
  private async arrange(
    claims: DbClaims,
    spaceId: string,
    craftId: string,
    ws: CraftWorkspace,
    command: CraftWorkspaceCommand,
    args: Record<string, unknown>,
    actor: CraftActor,
  ): Promise<boolean> {
    const before = args['beforeCraftId'] as string | null | undefined;
    try {
      return await this.deps.db.tx(claims, async (q) => {
        await q.query('set local role tm8_app');
        const rows = await q.query<{ changed: boolean }>(
          'select public.craft_workspace_list_apply($1, $2, $3, $4, $5, $6::jsonb, $7, $8) as changed',
          [
            spaceId,
            craftId,
            command,
            before !== undefined,
            before ?? null,
            JSON.stringify(ws.state),
            actor.actorClass === 'agent' ? (actor.actorId ?? null) : null,
            actor.actorClass === 'agent',
          ],
        );
        return rows[0]!.changed;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P0002') throw new Refused('craft_not_found', (error as Error).message);
      if (code === '53400') throw new Refused('open_limit', `at most ${CRAFT_OPEN_CAP} crafts may be open`);
      throw error;
    }
  }

  /** The tab commands, on a pruned state. */
  private async reduce(
    claims: DbClaims,
    spaceId: string,
    craftId: string,
    state: CraftWorkspaceState,
    command: CraftWorkspaceCommand,
    args: Record<string, unknown>,
  ): Promise<{ state: CraftWorkspaceState; tabId?: string; outcome?: 'created' | 'reused' }> {
    const tabs = [...state.tabs];
    const find = (): CraftTab => {
      const tab = typeof args['tabId'] === 'string'
        ? tabs.find((t) => t.id === args['tabId'])
        : tabs.find((t) => t.entityId === args['entityId']);
      if (!tab) throw new Refused('tab_not_found', 'no such tab');
      return tab;
    };
    const indexBefore = (beforeTabId: unknown): number => {
      if (beforeTabId === null || beforeTabId === undefined) return tabs.length;
      const at = tabs.findIndex((t) => t.id === beforeTabId);
      if (at < 0) throw new Refused('tab_not_found', `no tab ${String(beforeTabId)}`);
      if (at === 0) throw new Refused('pinned', 'nothing goes before the overview');
      return at;
    };

    switch (command) {
      case 'tabs.open': {
        const kind = craftTabKind(args['kind']);
        if (kind === null) throw new Refused('unsupported_kind', `a craft tab is one of ${CRAFT_TAB_KINDS.join(', ')}`);
        const entityId = args['entityId'] as string;
        const activate = args['activate'] !== false;
        const existing = tabs.find((t) => t.entityId === entityId);
        if (existing) {
          if (existing.kind !== kind) throw new Refused('invalid_arguments', `${entityId} is a ${existing.kind}, not a ${kind}`);
          let next = tabs;
          if (args['beforeTabId'] !== undefined && !existing.pinned) {
            const rest = tabs.filter((t) => t !== existing);
            const probe = [...rest];
            const at = args['beforeTabId'] === null ? probe.length : probe.findIndex((t) => t.id === args['beforeTabId']);
            if (at < 0) throw new Refused('tab_not_found', `no tab ${String(args['beforeTabId'])}`);
            if (at === 0) throw new Refused('pinned', 'nothing goes before the overview');
            probe.splice(at, 0, existing);
            next = probe;
          }
          return { state: { tabs: next, activeTabId: activate ? existing.id : state.activeTabId }, tabId: existing.id, outcome: 'reused' };
        }
        const entity = await this.pageKind(claims, spaceId, craftId, entityId);
        if (entity.kind === null) throw new Refused('entity_unavailable', `no entity ${entityId}`);
        if (!entity.page) throw new Refused('not_a_page', `${entityId} is not a page of this craft — add it to the craft first`);
        const actual = craftTabKind(entity.kind);
        if (actual === null) throw new Refused('unsupported_kind', `a ${entity.kind} cannot be a craft tab`);
        if (actual !== kind) throw new Refused('invalid_arguments', `${entityId} is a ${actual}, not a ${kind}`);
        if (tabs.length >= CRAFT_WORKSPACE_TAB_CAP) throw new Refused('tab_limit', `at most ${CRAFT_WORKSPACE_TAB_CAP} tabs`);
        const tab: CraftTab = { id: randomUUID(), kind, entityId, pinned: false };
        tabs.splice(indexBefore(args['beforeTabId']), 0, tab);
        return { state: { tabs, activeTabId: activate ? tab.id : state.activeTabId }, tabId: tab.id, outcome: 'created' };
      }
      case 'tabs.close': {
        const tab = find();
        if (tab.pinned) throw new Refused('pinned', 'the overview tab cannot be closed');
        const at = tabs.indexOf(tab);
        tabs.splice(at, 1);
        const activeTabId = state.activeTabId === tab.id ? (tabs[at] ?? tabs[at - 1])!.id : state.activeTabId;
        return { state: { tabs, activeTabId }, tabId: tab.id };
      }
      case 'tabs.move': {
        const tab = find();
        if (tab.pinned) throw new Refused('pinned', 'the overview tab does not move');
        if (args['beforeTabId'] === tab.id) return { state, tabId: tab.id };
        const rest = tabs.filter((t) => t !== tab);
        tabs.length = 0;
        tabs.push(...rest);
        tabs.splice(indexBefore(args['beforeTabId']), 0, tab);
        return { state: { tabs, activeTabId: state.activeTabId }, tabId: tab.id };
      }
      case 'tabs.activate': {
        const tab = find();
        return { state: { tabs, activeTabId: tab.id }, tabId: tab.id };
      }
      default:
        throw new Refused('invalid_arguments', `unknown command ${command}`);
    }
  }

  /** The entity's kind as the caller reads it (null: unreadable), and whether it is the craft or a direct page of it. */
  private pageKind(claims: DbClaims, spaceId: string, craftId: string, entityId: string): Promise<{ kind: string | null; page: boolean }> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ kind: string; page: boolean }>(
        `select x.kind,
                (x.id = $2 or exists (
                  select 1 from public.edges e where e.type = 'contains' and e.src_id = $2 and e.dst_id = x.id
                )) as page
           from public.entities x
          where x.id = $1 and x.space_id = $3 and x.deleted_at is null`,
        [entityId, craftId, spaceId],
      );
      const row = rows[0];
      return row ? { kind: row.kind, page: row.page } : { kind: null, page: false };
    });
  }

  private pushOne(claims: DbClaims, spaceId: string, workspace: CraftWorkspace, cause?: CraftWorkspaceFrame['cause']): void {
    const frame: CraftWorkspaceFrame = { type: 'craft.workspace', spaceId, workspace, ...(cause ? { cause } : {}) };
    this.deps.bridge.push(claims.identityId!, spaceId, frame);
  }

  private async pushList(claims: DbClaims, spaceId: string): Promise<void> {
    const { items } = await this.list(claims, spaceId);
    const frame: CraftWorkspacesFrame = { type: 'craft.workspaces', spaceId, items };
    this.deps.bridge.push(claims.identityId!, spaceId, frame);
  }

  private serialize<T>(claims: DbClaims, spaceId: string, run: () => Promise<T>): Promise<T> {
    const key = `${spaceId}\u0000${claims.identityId ?? ''}`;
    const before = this.chains.get(key) ?? Promise.resolve();
    const mine = before.then(run, run);
    const settled = mine.then(() => undefined, () => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return mine;
  }
}

function sameState(a: CraftWorkspaceState, b: CraftWorkspaceState): boolean {
  return a.activeTabId === b.activeTabId
    && a.tabs.length === b.tabs.length
    && a.tabs.every((t, i) => t.id === b.tabs[i]!.id);
}
