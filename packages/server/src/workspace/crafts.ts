/**
 * Craft workspaces (Craft redesign doc 01a1255d §3 "Persistence", §4; contract
 * `packages/contract/src/craft-workspace.ts`; migration 315).
 *
 * One hidden row of `public.workspaces` per (space, identity, craft): the tabs
 * a person has open on a craft, and whether the craft is in their Craft top
 * bar. Reads and writes run as the caller (`tm8_app`, identity-equality RLS);
 * the writes go through `craft_workspace_save` / `craft_workspaces_arrange`.
 *
 * A tab shows the craft itself or one of its DIRECT pages (a `contains` edge
 * from the craft). A tab whose page has left the craft is pruned on the next
 * read or write; a read that prunes saves the result and pushes it, so every
 * window of the person drops the tab.
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

class Refused extends Error {
  constructor(readonly reason: CraftWorkspaceResultReason, message: string) {
    super(message);
  }
}

export class CraftWorkspaceService {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: { db: Db; bridge: WorkspaceBridge }) {}

  /** The person's craft workspaces in the space, in `position` order; crafts they can no longer read are left out. */
  list(claims: DbClaims, spaceId: string): Promise<CraftWorkspaceListResult> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const query = q.query.bind(q) as Query;
      const rows = await this.rows(query, spaceId);
      const pages = await this.pagesOf(query, rows.map((r) => r.craft_id));
      return { items: rows.map((r) => this.view(r, pages.get(r.craft_id) ?? new Set()).workspace), openCap: CRAFT_OPEN_CAP };
    });
  }

  /** One craft's workspace (the default when the person has none yet). A read that prunes saves and pushes. */
  get(claims: DbClaims, spaceId: string, craftId: string, actor: CraftActor): Promise<CraftWorkspace> {
    return this.serialize(claims, spaceId, async () => {
      const loaded = await this.load(claims, spaceId, craftId);
      if (!loaded.pruned || loaded.row === null) return loaded.workspace;
      const saved = await this.save(claims, spaceId, craftId, loaded.workspace, loaded.workspace.state, actor);
      if (saved === null) return (await this.load(claims, spaceId, craftId)).workspace;
      this.pushOne(claims, spaceId, saved);
      return saved;
    });
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
      const loaded = await this.load(claims, spaceId, craftId);
      const ws = loaded.workspace;
      const result = (status: CraftWorkspaceCommandResult['status'], workspace: CraftWorkspace, extra: Partial<CraftWorkspaceCommandResult> = {}): CraftWorkspaceCommandResult =>
        ({ requestId: input.requestId, status, ...extra, workspace });
      if (input.expectedRevision !== undefined && input.expectedRevision !== ws.revision) {
        return result('conflict', ws, { reason: 'revision_conflict' });
      }
      const parsed = CRAFT_WORKSPACE_ARG_SCHEMAS[input.command].safeParse(input.args);
      if (!parsed.success) return result('rejected', ws, { reason: 'invalid_arguments' });
      const args = (parsed.data ?? {}) as Record<string, unknown>;

      if (input.command.startsWith('craft.')) {
        try {
          const changed = await this.arrange(claims, spaceId, craftId, loaded, input.command, args, actor);
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
      if (!loaded.pruned && sameState(step.state, ws.state)) return result('no_op', ws, extra);
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
   * §4: may this agent command the caller's workspace for `craftId`? Only a
   * chat about the craft, a work session about it, or a session whose parent
   * is a chat about it. The ids come off the verified bearer, never the body.
   */
  async agentMayCommand(claims: DbClaims, craftId: string, ids: { chatId?: string; workSessionId?: string }): Promise<boolean> {
    const sources = [ids.chatId, ids.workSessionId].filter((x): x is string => typeof x === 'string');
    if (sources.length === 0) return false;
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ ok: boolean }>(
        `select exists (
                  select 1 from public.edges e
                   where e.type = 'about' and e.dst_id = $1 and e.src_id = any($2::uuid[])
                ) or exists (
                  select 1 from public.entities s
                    join public.entities c on c.id = s.parent_id and c.kind = 'chat'
                    join public.edges e on e.src_id = c.id and e.type = 'about' and e.dst_id = $1
                   where s.id = $3::uuid
                ) as ok`,
        [craftId, sources, ids.workSessionId ?? null],
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

  /** craft.open / craft.close / craft.move: the person's list, laid out again. */
  private async arrange(
    claims: DbClaims,
    spaceId: string,
    craftId: string,
    loaded: { row: Row | null; all: Row[]; workspace: CraftWorkspace },
    command: CraftWorkspaceCommand,
    args: Record<string, unknown>,
    actor: CraftActor,
  ): Promise<boolean> {
    let all = loaded.all;
    const ids = all.map((r) => r.craft_id);
    const before = args['beforeCraftId'] as string | null | undefined;
    if (typeof before === 'string' && (before === craftId || !ids.includes(before))) {
      throw new Refused('craft_not_found', `no open craft ${before} to place it before`);
    }
    if (command === 'craft.close' && !(loaded.row?.open ?? false)) return false;
    if (command === 'craft.move' && loaded.row === null) throw new Refused('craft_not_found', 'the craft is not in the list');
    if (command === 'craft.open' && loaded.row?.open && before === undefined) return false;

    const open = new Set(all.filter((r) => r.open).map((r) => r.craft_id));
    if (command === 'craft.open') open.add(craftId);
    if (command === 'craft.close') open.delete(craftId);
    if (open.size > CRAFT_OPEN_CAP) throw new Refused('open_limit', `at most ${CRAFT_OPEN_CAP} crafts may be open`);

    if (loaded.row === null) {
      // The first touch makes the row: closed, last, the overview alone.
      const made = await this.save(claims, spaceId, craftId, loaded.workspace, loaded.workspace.state, actor);
      if (made === null) throw new Refused('revision_conflict', 'the craft workspace changed');
      all = [...all, { craft_id: craftId } as Row];
    }
    let order = all.map((r) => r.craft_id);
    if (command !== 'craft.close' && before !== undefined) {
      order = order.filter((id) => id !== craftId);
      const at = before === null ? -1 : order.indexOf(before);
      if (at < 0) order.push(craftId);
      else order.splice(at, 0, craftId);
    }
    const changed = await this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ changed: boolean }>('select public.craft_workspaces_arrange($1, $2::uuid[], $3::uuid[]) as changed', [
        spaceId,
        order,
        [...open],
      ]);
      return rows[0]!.changed;
    });
    return changed || loaded.row === null;
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
