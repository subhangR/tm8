/**
 * Which of the caller's workspaces a command applies to (API doc 01a115c4
 * §3.2), in ONE place for HTTP and the socket. The service runs it inside the
 * (space, identity) write lock (D4), so what it resolves is what gets written.
 *
 * First match wins:
 *   1. a window frame: its `workspaceId` (R9); an old window that sends none
 *      (S9) writes drafts to their owner and everything else to the active one;
 *   2. explicit: the caller named the workspace (R4);
 *   3. owner: the workspace holding the named tab or draft (R3); not found
 *      anywhere falls through, so the reducer gives today's answer;
 *   4. active (R2). With no row at all it is the synthetic "Main" (id null),
 *      which the first write creates (S12).
 * The pin (step 5) is phase 3.
 *
 * A missing active pointer (its workspace cascaded away) is healed in the
 * read: the first workspace in list order — (position, created_at,
 * workspace_id), as every list here orders — stands in, and the next write
 * repairs the pointer to the same one (workspace_save, migration 310).
 */
import {
  CollabError,
  WORKSPACE_DEFAULT_NAME,
  type WorkspaceColor,
  type WorkspaceRef,
  type WorkspaceResolvedBy,
  type WorkspaceSummary,
} from '@tm8/contract';

import type { Querier } from '../db/types.js';

export interface TargetRequest {
  /** The caller named this workspace (HTTP `workspaceId`). */
  workspaceId?: string;
  /** Set for a window's own write: the frame's `workspaceId` (absent = an old window). */
  frame?: { workspaceId?: string | null };
  /** The command's args name this tab. */
  tabId?: string;
  /** The operation names this draft. */
  draftId?: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  color: WorkspaceColor | null;
  position: number;
  revision: number;
  pointed: boolean;
  hasTab: boolean;
  hasDraft: boolean;
  createdAt: string;
  createdByActorId: string | null;
  createdByClass: 'human' | 'agent' | null;
  lastActiveAt: string | null;
  lastAgentChangeAt: string | null;
  tabCount: number;
  draftCount: number;
  dirtyDraftCount: number;
}

export interface Workspaces {
  rows: WorkspaceRow[];
  /** The active workspace, healed; null = no row yet. */
  activeId: string | null;
  listRevision: number;
}

export interface Resolution {
  /** null: the identity has no workspace in the space yet (S12). */
  workspaceId: string | null;
  ref: WorkspaceRef;
  revision: number;
}

/**
 * A target that answers instead of applying: a window frame for a workspace
 * that is gone or no longer unambiguous, or an explicit target that disagrees
 * with the owner of the named tab or draft.
 */
export class TargetRefused extends Error {
  constructor(
    readonly status: 'rejected' | 'conflict',
    readonly reason: 'workspace_not_found' | 'workspace_switched' | 'workspace_mismatch',
    readonly ref?: WorkspaceRef,
  ) {
    super(reason);
  }
}

/** The caller's workspaces in the space, list order, as the caller (RLS). */
export async function loadWorkspaces(q: Querier, spaceId: string, find: { tabId?: string; draftId?: string } = {}): Promise<Workspaces> {
  const rows = await q.query<{
    workspace_id: string; name: string; color: WorkspaceColor | null; position: number; revision: string | number;
    pointed: boolean; list_revision: string | number | null; has_tab: boolean; has_draft: boolean;
    created_at: Date | string; created_by_actor_id: string | null; created_by_class: 'human' | 'agent' | null;
    last_active_at: Date | string | null; last_agent_change_at: Date | string | null;
    tab_count: string | number; draft_count: string | number; dirty_count: string | number;
  }>(
    `select w.workspace_id, w.name, w.color, w.position, w.revision,
            a.workspace_id is not null as pointed, a.list_revision,
            coalesce((w.state->'tabs') ? $2::text, false) as has_tab,
            $3::text is not null and (
              exists (select 1 from public.workspace_drafts d where d.workspace_id = w.workspace_id and d.draft_id::text = $3::text)
              or exists (select 1 from jsonb_each(w.state->'tabs') t where t.value->>'draftId' = $3::text)
            ) as has_draft,
            w.created_at, w.created_by_actor_id, w.created_by_class, w.last_active_at, w.last_agent_change_at,
            (select count(*) from jsonb_each(w.state->'tabs')) as tab_count,
            (select count(*) from jsonb_each(w.state->'tabs') t where t.value->>'type' = 'draft') as draft_count,
            (select count(*) from jsonb_each(w.state->'tabs') t
              where t.value->>'type' = 'draft' and t.value->>'dirty' = 'true') as dirty_count
       from public.workspaces w
       left join public.workspace_active a
         on a.space_id = w.space_id and a.identity_id = w.identity_id and a.workspace_id = w.workspace_id
      where w.space_id = $1 and w.identity_id = (select internal.identity_id())
      order by w.position, w.created_at, w.workspace_id`,
    [spaceId, find.tabId ?? null, find.draftId ?? null],
  );
  const out = rows.map((r): WorkspaceRow & { listRevision: number | null } => ({
    id: r.workspace_id,
    name: r.name,
    color: r.color,
    position: Number(r.position),
    revision: Number(r.revision),
    pointed: r.pointed,
    listRevision: r.list_revision === null ? null : Number(r.list_revision),
    hasTab: r.has_tab,
    hasDraft: r.has_draft,
    createdAt: iso(r.created_at)!,
    createdByActorId: r.created_by_actor_id,
    createdByClass: r.created_by_class,
    lastActiveAt: iso(r.last_active_at),
    lastAgentChangeAt: iso(r.last_agent_change_at),
    tabCount: Number(r.tab_count),
    draftCount: Number(r.draft_count),
    dirtyDraftCount: Number(r.dirty_count),
  }));
  const pointed = out.find((r) => r.pointed);
  return {
    rows: out,
    activeId: (pointed ?? out[0])?.id ?? null,
    listRevision: pointed?.listRevision ?? (out.length > 0 ? 1 : 0),
  };
}

/** §3.2 steps 1, 2, 3 and 4 over the caller's workspaces. */
export function resolveTarget(ws: Workspaces, req: TargetRequest): Resolution {
  const byId = (id: string | null) => ws.rows.find((r) => r.id === id);
  const pick = (row: WorkspaceRow | undefined, resolvedBy: WorkspaceResolvedBy): Resolution => ({
    workspaceId: row?.id ?? null,
    ref: refOf(row, resolvedBy, ws.activeId),
    revision: row?.revision ?? 0,
  });
  const active = () => pick(byId(ws.activeId), 'active');
  const owner = () =>
    (req.draftId !== undefined ? ws.rows.find((r) => r.hasDraft) : undefined)
    ?? (req.tabId !== undefined ? ws.rows.find((r) => r.hasTab) : undefined);

  // 1. A window's own write.
  if (req.frame) {
    const named = req.frame.workspaceId;
    if (typeof named === 'string') {
      const row = byId(named);
      if (!row) throw new TargetRefused('rejected', 'workspace_not_found');
      return pick(row, 'window');
    }
    if (named === null) {
      // The synthetic "Main" the window saw: still unambiguous only while
      // the identity has at most one workspace.
      if (ws.rows.length <= 1) return pick(ws.rows[0], 'window');
      throw new TargetRefused('rejected', 'workspace_switched');
    }
    // An old window (S9): drafts by owner (their ids are uuids), else active.
    const found = req.draftId !== undefined ? ws.rows.find((r) => r.hasDraft) : undefined;
    return found ? pick(found, 'owner') : active();
  }

  // 2. Explicit. Never silently loses to the owner of the named id.
  if (req.workspaceId !== undefined) {
    const row = byId(req.workspaceId);
    if (!row) {
      throw new CollabError('not_found', `no workspace ${req.workspaceId}`, { details: { reason: 'workspace_not_found' } });
    }
    const holder = owner();
    if (holder && holder.id !== row.id) throw new TargetRefused('conflict', 'workspace_mismatch', refOf(row, 'explicit', ws.activeId));
    return pick(row, 'explicit');
  }

  // 3. Owner, else 4. active.
  const holder = owner();
  return holder ? pick(holder, 'owner') : active();
}

/** Every workspace as lists show it; the synthetic "Main" when there is no row. */
export function summaries(ws: Workspaces): WorkspaceSummary[] {
  if (ws.rows.length === 0) {
    return [{
      id: null, name: WORKSPACE_DEFAULT_NAME, color: null, position: 0, active: true, revision: 0,
      tabCount: 0, draftCount: 0, dirtyDraftCount: 0, createdAt: null, createdBy: null,
      agentChangedSinceActive: false, lastAgentChange: null,
    }];
  }
  return ws.rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    active: r.id === ws.activeId,
    revision: r.revision,
    tabCount: r.tabCount,
    draftCount: r.draftCount,
    dirtyDraftCount: r.dirtyDraftCount,
    createdAt: r.createdAt,
    createdBy: r.createdByClass ? { actorId: r.createdByActorId, actorClass: r.createdByClass } : null,
    agentChangedSinceActive: r.lastAgentChangeAt !== null && (r.lastActiveAt === null || r.lastAgentChangeAt > r.lastActiveAt),
    lastAgentChange: r.lastAgentChangeAt ? { at: r.lastAgentChangeAt } : null,
  }));
}

function refOf(row: WorkspaceRow | undefined, resolvedBy: WorkspaceResolvedBy, activeId: string | null): WorkspaceRef {
  return {
    id: row?.id ?? null,
    name: row?.name ?? WORKSPACE_DEFAULT_NAME,
    color: row?.color ?? null,
    resolvedBy,
    active: row === undefined || row.id === activeId,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
