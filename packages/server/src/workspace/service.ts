/**
 * Server-side Workspaces (Spec D, doc 01a11171-3aba).
 *
 * One stored workspace per (space, IDENTITY) in `public.workspaces`, draft
 * values in `public.workspace_drafts` (migration 305). Every write runs the
 * SAME `reduce` the window runs (`@tm8/contract/workspace`), then
 * compare-and-swaps the row and pushes the new state to that identity's live
 * windows — and only to them (`WorkspaceBridge.push`).
 *
 * Writes for one (space, identity) are serialized in process: the node is the
 * only writer, so a promise chain per key gives every caller the latest row
 * and keeps a window's commands in the order it sent them. The row's CAS is
 * the backstop.
 */
import { randomUUID } from 'node:crypto';

import { CollabError, type WorkspaceGetResult, type WorkspaceRemoteResult } from '@tm8/contract';
import {
  defaultWorkspaceState,
  inspect as inspectState,
  isWorkspaceKind,
  reduce,
  sanitizeWorkspaceState,
  toStoredState,
  WORKSPACE_TAB_HARD_CAP,
  type CommandEnvelope,
  type Result,
  type WorkspaceHooks,
  type WorkspaceState,
} from '@tm8/contract/workspace';

import type { Db, DbClaims, Querier } from '../db/types.js';
import type { WorkspaceBridge } from './bridge.js';

type DraftFields = Record<string, { v: unknown; r: number }>;

interface DraftRow {
  draftId: string;
  kind: string;
  fields: DraftFields;
  revision: number;
}

interface Loaded {
  revision: number;
  state: WorkspaceState;
  exists: boolean;
  drafts: Map<string, DraftRow>;
}

export interface ApplyOrigin {
  /** `window`: a human's own window sent it over its socket. `http`: an agent or the CLI. */
  kind: 'window' | 'http';
  instanceId?: string;
}

export interface ApplyInput {
  env: CommandEnvelope;
  /** Ids the window's reducer minted, in order (window origin only). */
  ids?: string[];
  requestId: string;
  origin: ApplyOrigin;
}

const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: { db: Pick<Db, 'tx'>; bridge: WorkspaceBridge }) {}

  // -- reads -----------------------------------------------------------------

  /** `workspace.get`: the caller's stored workspace; unreadable tabs marked, never titled. */
  async get(claims: DbClaims, spaceId: string): Promise<WorkspaceGetResult> {
    const loaded = await this.load(claims, spaceId);
    const state = toStoredState(loaded.state) as unknown as Record<string, unknown>;
    const entityIds = Object.values(loaded.state.tabs).flatMap((t) => (t.type === 'entity' && ENTITY_ID.test(t.entityId) ? [t.entityId] : []));
    const readable = await this.readable(claims, entityIds);
    const tabs = state['tabs'] as Record<string, Record<string, unknown>>;
    for (const tab of Object.values(tabs)) {
      if (tab['type'] === 'entity' && !readable.has(String(tab['entityId']))) tab['unavailable'] = true;
    }
    return {
      revision: loaded.revision,
      state,
      drafts: [...loaded.drafts.values()].map((d) => ({ draftId: d.draftId, kind: d.kind, revision: d.revision, fields: d.fields })),
      windows: claims.identityId ? this.deps.bridge.list(claims.identityId, spaceId).length : 0,
    };
  }

  /** `workspace.inspect` with no live window: the stored state, presentation = last active. */
  async inspectStored(claims: DbClaims, spaceId: string): Promise<Omit<WorkspaceRemoteResult, 'requestId' | 'instanceId'>> {
    const loaded = await this.load(claims, spaceId);
    return { status: 'no_op', revision: loaded.revision, inspection: inspectState(loaded.state) as unknown as Record<string, unknown> };
  }

  /** What a window gets right after it registers: the state, then each draft. */
  async snapshot(claims: DbClaims, spaceId: string, send: (frame: object) => void): Promise<void> {
    const loaded = await this.load(claims, spaceId);
    send({
      type: 'workspace.state',
      spaceId,
      revision: loaded.revision,
      state: loaded.exists ? (toStoredState(loaded.state) as unknown as Record<string, unknown>) : null,
    });
    for (const draft of loaded.drafts.values()) {
      send({ type: 'workspace.draft', spaceId, draftId: draft.draftId, kind: draft.kind, revision: draft.revision, fields: draft.fields });
    }
  }

  // -- writes ----------------------------------------------------------------

  /** Apply one command to the stored workspace; push the result to the identity's windows. */
  apply(claims: DbClaims, spaceId: string, input: ApplyInput): Promise<Result> {
    return this.serialize(claims, spaceId, () => this.applyNow(claims, spaceId, input));
  }

  /**
   * The one-time import of a browser's legacy state (Spec D §6). Accepted only
   * while the identity has no row in the space; otherwise a no-op.
   */
  importLegacy(
    claims: DbClaims,
    spaceId: string,
    raw: unknown,
    drafts: { draftId: string; kind: string; values: Record<string, unknown> }[],
  ): Promise<boolean> {
    return this.serialize(claims, spaceId, async () => {
      if ((await this.load(claims, spaceId)).exists) return false;
      // Sanitized: unknown kinds dropped, titles dropped, no pending prompt
      // (it belonged to another session), at most the hard tab limit.
      const stored = { ...toStoredState(sanitizeWorkspaceState(raw, spaceId) ?? defaultWorkspaceState(spaceId)), revision: 1 };
      await this.save(claims, spaceId, 0, 1, stored);
      this.pushState(claims, spaceId, 1, stored);
      const kept = new Map(Object.values(stored.tabs).flatMap((t) => (t.type === 'draft' ? [[t.draftId, t.kind] as const] : [])));
      for (const draft of drafts.slice(0, 30)) {
        const kind = kept.get(draft.draftId);
        if (!kind) continue;
        const fields: DraftFields = {};
        for (const [name, v] of Object.entries(draft.values)) fields[name] = { v, r: 1 };
        const revision = await this.saveDraft(claims, spaceId, draft.draftId, kind, 0, fields).catch(() => 0);
        if (revision > 0) this.deps.bridge.push(claims.identityId!, spaceId, { type: 'workspace.draft', spaceId, draftId: draft.draftId, kind, revision, fields });
      }
      return true;
    });
  }

  /**
   * One draft write: per-field, last writer wins (Spec D §3). `base` is the
   * field revision the writer last saw; a stale base still wins, and is
   * reported in `overwrote` so the writer's UI can say so.
   */
  patchDraft(
    claims: DbClaims,
    spaceId: string,
    draftId: string,
    patch: Record<string, { v?: unknown; base?: number }>,
    origin: ApplyOrigin,
  ): Promise<{ draftId: string; revision: number; fields: DraftFields; overwrote: string[] }> {
    return this.serialize(claims, spaceId, async () => {
      const loaded = await this.load(claims, spaceId);
      const tab = Object.values(loaded.state.tabs).find((t) => t.type === 'draft' && t.draftId === draftId);
      if (!tab || tab.type !== 'draft') throw new CollabError('not_found', `no draft ${draftId} in this workspace`);
      const row = loaded.drafts.get(draftId);
      const fields: DraftFields = { ...(row?.fields ?? {}) };
      const overwrote: string[] = [];
      for (const [name, change] of Object.entries(patch)) {
        if (name.length === 0 || name.length > 100) throw new CollabError('invalid_input', 'draft field names are 1–100 characters');
        const current = fields[name] ?? { v: undefined, r: 0 };
        if (change.base !== undefined && change.base < current.r) overwrote.push(name);
        fields[name] = { v: change.v ?? null, r: current.r + 1 };
      }
      const revision = await this.saveDraft(claims, spaceId, draftId, tab.kind, row?.revision ?? 0, fields);
      this.deps.bridge.push(claims.identityId!, spaceId, {
        type: 'workspace.draft',
        spaceId,
        draftId,
        kind: tab.kind,
        revision,
        fields,
        ...(origin.instanceId ? { sourceInstanceId: origin.instanceId } : {}),
      });
      // Someone else's write makes the draft dirty: a later close must ask.
      if (origin.kind === 'http' && !tab.dirty && Object.keys(patch).length > 0) {
        await this.applyNow(claims, spaceId, {
          env: { command: 'workspace.drafts.markDirty', args: { tabId: tab.id, dirty: true }, source: 'system' },
          requestId: randomUUID(),
          origin,
        });
      }
      return { draftId, revision, fields, overwrote };
    });
  }

  // -- internals -------------------------------------------------------------

  private async applyNow(claims: DbClaims, spaceId: string, input: ApplyInput): Promise<Result> {
    const loaded = await this.load(claims, spaceId);
    const state = loaded.state;
    const { env } = input;

    // An agent may not open what it cannot read; the answer is the same as
    // "does not exist", so nothing leaks.
    if (input.origin.kind === 'http' && env.command === 'workspace.tabs.open') {
      const entityId = (env.args as { entityId?: unknown } | null)?.entityId;
      if (typeof entityId !== 'string' || !ENTITY_ID.test(entityId) || !(await this.readable(claims, [entityId])).has(entityId)) {
        return this.answer(input, spaceId, claims, { status: 'rejected', revision: loaded.revision, reason: 'entity_unavailable' });
      }
    }

    const ids = [...(input.ids ?? [])];
    const deletedDrafts: string[] = [];
    const hooks: WorkspaceHooks = {
      deleteDraft: (draftId) => void deletedDrafts.push(draftId),
      draftRevision: (draftId) => loaded.drafts.get(draftId)?.revision ?? 0,
      toast: () => {},
      captureUi: () => undefined,
      canCreate: (kind) => isWorkspaceKind(kind),
      newId: () => ids.shift() ?? randomUUID(),
      openEntity: () => {},
      focusDraft: () => {},
      openDialog: () => ({ status: 'rejected', reason: 'view_unavailable' }),
      closeDialog: () => ({ status: 'rejected', reason: 'view_unavailable' }),
      showWorkspace: () => ({ status: 'rejected', reason: 'view_unavailable' }),
      // On the node the stored workspace is always "mounted", and nobody types.
      viewMounted: () => true,
      userTyping: () => false,
    };
    const reduction = reduce({ ...state, revision: loaded.revision }, env, hooks);
    // Post-commit steps run here too; on the node every hook is inert except
    // `deleteDraft`, which queues the draft rows to drop with this commit.
    for (const commit of reduction.commits) for (const step of commit.after) step();
    const significant = reduction.commits.some((c) => c.significant);
    if (!significant) {
      return this.answer(input, spaceId, claims, { ...reduction.result, revision: loaded.revision });
    }
    if (
      reduction.state.orderedTabIds.length > WORKSPACE_TAB_HARD_CAP &&
      reduction.state.orderedTabIds.length > state.orderedTabIds.length
    ) {
      return this.answer(input, spaceId, claims, { status: 'rejected', revision: loaded.revision, reason: 'tab_limit' });
    }
    const next = toStoredState(reduction.state);
    await this.save(claims, spaceId, loaded.exists ? loaded.revision : 0, reduction.state.revision, next);
    for (const draftId of deletedDrafts) {
      await this.saveDraft(claims, spaceId, draftId, 'task', 0, null).catch(() => 0);
      this.deps.bridge.push(claims.identityId!, spaceId, { type: 'workspace.draft', spaceId, draftId, revision: 0, deleted: true });
    }
    const result = reduction.result;
    this.pushState(claims, spaceId, reduction.state.revision, next, input.origin.instanceId
      ? { instanceId: input.origin.instanceId, requestId: input.requestId, result: result as unknown as Record<string, unknown> }
      : undefined);
    return result;
  }

  /** A command that did not commit: the sending window still needs its answer. */
  private answer(input: ApplyInput, spaceId: string, claims: DbClaims, result: Result): Result {
    if (input.origin.kind === 'window' && input.origin.instanceId && claims.identityId) {
      this.deps.bridge.push(claims.identityId, spaceId, {
        type: 'workspace.applied',
        spaceId,
        requestId: input.requestId,
        result,
      }, input.origin.instanceId);
    }
    return result;
  }

  private pushState(
    claims: DbClaims,
    spaceId: string,
    revision: number,
    state: WorkspaceState,
    cause?: { instanceId: string; requestId: string; result: Record<string, unknown> },
  ): void {
    if (!claims.identityId) return;
    this.deps.bridge.push(claims.identityId, spaceId, {
      type: 'workspace.state',
      spaceId,
      revision,
      state: state as unknown as Record<string, unknown>,
      ...(cause ? { cause } : {}),
    });
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

  private async load(claims: DbClaims, spaceId: string): Promise<Loaded> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const space = await q.query('select 1 from public.spaces where id = $1', [spaceId]);
      if (space.length === 0) throw new CollabError('not_found', `no space ${spaceId}`);
      const rows = await q.query<{ state: unknown; revision: string | number }>(
        `select state, revision from public.workspaces
          where space_id = $1 and identity_id = (select internal.identity_id())`,
        [spaceId],
      );
      const drafts = await q.query<{ draft_id: string; kind: string; fields: DraftFields; revision: string | number }>(
        `select draft_id, kind, fields, revision from public.workspace_drafts
          where space_id = $1 and identity_id = (select internal.identity_id())`,
        [spaceId],
      );
      const row = rows[0];
      const revision = row ? Number(row.revision) : 0;
      const state = row ? (sanitizeStored(row.state, spaceId) ?? defaultWorkspaceState(spaceId)) : defaultWorkspaceState(spaceId);
      return {
        revision,
        exists: row !== undefined,
        state: { ...state, revision },
        drafts: new Map(drafts.map((d) => [d.draft_id, { draftId: d.draft_id, kind: d.kind, fields: d.fields, revision: Number(d.revision) }])),
      };
    });
  }

  private async save(claims: DbClaims, spaceId: string, expected: number, next: number, state: WorkspaceState): Promise<void> {
    await this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      await q.query('select public.workspace_save($1, $2, $3, $4)', [spaceId, expected, next, JSON.stringify(state)]);
    });
  }

  private async saveDraft(
    claims: DbClaims,
    spaceId: string,
    draftId: string,
    kind: string,
    expected: number,
    fields: DraftFields | null,
  ): Promise<number> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ revision: string | number }>(
        'select public.workspace_draft_save($1, $2, $3, $4, $5) as revision',
        [spaceId, draftId, kind, expected, fields === null ? null : JSON.stringify(fields)],
      );
      return Number(rows[0]?.revision ?? 0);
    });
  }

  /** The subset of these entity ids the caller can read (`entity_readable`, through RLS). */
  private async readable(claims: DbClaims, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    return this.deps.db.tx(claims, async (q: Querier) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ id: string }>(
        'select id from public.entities where id = any($1::uuid[]) and deleted_at is null',
        [ids],
      );
      return new Set(rows.map((r) => r.id));
    });
  }
}

/** A stored row is trusted shape-wise but re-sanitized: it may predate a change. */
function sanitizeStored(raw: unknown, spaceId: string): WorkspaceState | null {
  const clean = sanitizeWorkspaceState(raw, spaceId);
  if (!clean) return null;
  // A pending interaction survives a reload of the row (it is shared state).
  const pending = (raw as { pending?: unknown }).pending;
  return pending && typeof pending === 'object' ? { ...clean, pending: pending as WorkspaceState['pending'] } : clean;
}
