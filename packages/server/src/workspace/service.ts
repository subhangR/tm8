/**
 * Server-side Workspaces (Spec D, doc 01a11171-3aba).
 *
 * Stored workspaces live in `public.workspaces`, keyed by `workspace_id`
 * since migration 310: an identity may hold several per space, and
 * `public.workspace_active` points at the one it is using. Draft values live in
 * `public.workspace_drafts`, per workspace. Every write runs the SAME `reduce`
 * the window runs (`@tm8/contract/workspace`), then compare-and-swaps the row
 * and pushes the new state to that identity's live windows — and only to them
 * (`WorkspaceBridge.push`).
 *
 * Every read and write first resolves its target workspace (`resolveTarget`,
 * API doc 01a115c4 §3.2) and names it on its result (R8). A write resolves
 * INSIDE the lock below, so the workspace it resolved is the one it writes.
 * A workspace that is not active pushes its frames to capable windows only;
 * an old window only ever sees the active one (S9).
 *
 * Writes for one (space, identity) — all of its workspaces, so a switch and
 * the commands around it stay in order (API D4) — are serialized in process: the node is the
 * only writer, so a promise chain per key gives every caller the latest row
 * and keeps a window's commands in the order it sent them. The row's CAS is
 * the backstop.
 */
import { randomUUID } from 'node:crypto';

import {
  CollabError,
  WORKSPACES_PER_IDENTITY_CAP,
  type WorkspaceColor,
  type WorkspaceGetResult,
  type WorkspaceListResult,
  type WorkspaceManageResult,
  type WorkspaceRef,
  type WorkspaceRemoteResult,
  type WorkspaceSummary,
  type WorkspaceSummaryCauseKind,
} from '@tm8/contract';
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
import { isCapable, type WorkspaceBridge } from './bridge.js';
import { WorkspacePromptStore } from './prompts.js';
import { loadWorkspaces, resolveTarget, summaries, TargetRefused, type Resolution, type TargetRequest, type Workspaces } from './resolve.js';

type DraftFields = Record<string, { v: unknown; r: number }>;

interface DraftRow {
  draftId: string;
  kind: string;
  fields: DraftFields;
  revision: number;
}

interface Loaded {
  /** null: the identity has no workspace in this space yet; the first write creates "Main" (S12). */
  workspaceId: string | null;
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
  /** What picks the workspace (§3.2); absent = the active one. */
  target?: TargetRequest;
  /** Who sent an HTTP write: named on its push (`cause.actor`), and an agent's stamps the workspace. */
  actor?: ManageActor;
}

/** A command's result, naming the workspace it applied to (R8). */
export type AppliedResult = Result & { workspace?: WorkspaceRef } & Partial<Pick<WorkspaceRemoteResult,
  'tabIds' | 'outcomes' | 'unavailableEntityIds' | 'expectedWorkspaceId' | 'activeWorkspaceId'>>;

/** The workspace a command resolved to, whether it is the one on screen, and how many the identity has. */
export type ResolvedTarget = Resolution & { activeWorkspaceId: string | null; count: number };

/** Who asked for a management op; named on the `workspace.summary` cause. */
export interface ManageActor {
  actorClass: 'human' | 'agent';
  actorName?: string;
  /** The calling actor: D6's "the same actor created it". Never pushed. */
  actorId?: string;
}

const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceService {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** An agent's Switch/Stay and Delete/Keep prompts (D8), in this node's memory. */
  readonly prompts: WorkspacePromptStore;

  constructor(private readonly deps: { db: Pick<Db, 'tx'>; bridge: WorkspaceBridge; prompts?: WorkspacePromptStore }) {
    this.prompts = deps.prompts ?? new WorkspacePromptStore();
    // Every state change reaches the capable windows (§7.3), expiry included.
    this.prompts.onChange = (identityId, spaceId, prompt) => {
      deps.bridge.push(identityId, spaceId, { type: 'workspace.prompt', spaceId, prompt }, { capableOnly: true });
    };
  }

  // -- reads -----------------------------------------------------------------

  /** `workspace.get`: one of the caller's stored workspaces; unreadable tabs marked, never titled. */
  async get(claims: DbClaims, spaceId: string, req: Pick<TargetRequest, 'workspaceId' | 'expectedWorkspaceId'> = {}): Promise<WorkspaceGetResult> {
    const { ws, target, loaded } = await this.read(claims, spaceId, req);
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
      workspace: target.ref,
      activeWorkspaceId: ws.activeId,
      workspaces: summaries(ws),
    };
  }

  /** `workspace.list`: the caller's workspaces in the space, never empty (synthetic "Main"). */
  async list(claims: DbClaims, spaceId: string): Promise<WorkspaceListResult> {
    const ws = await this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      await requireSpace(q, spaceId);
      return loadWorkspaces(q, spaceId);
    });
    return {
      items: summaries(ws),
      activeWorkspaceId: ws.activeId,
      listRevision: ws.listRevision,
      cap: WORKSPACES_PER_IDENTITY_CAP,
      prompts: claims.identityId ? this.prompts.list(claims.identityId, spaceId) : [],
    };
  }

  /**
   * Resolve a target without writing, after every write queued before it
   * (D4): what a window-only command forwards to. The lock is released before
   * the caller forwards; the window's own write takes it again.
   */
  resolve(claims: DbClaims, spaceId: string, req: TargetRequest): Promise<ResolvedTarget> {
    return this.serialize(claims, spaceId, () => this.target(claims, spaceId, req));
  }

  /** `workspace.inspect` answered from the stored state, presentation = last active. */
  async inspectStored(claims: DbClaims, spaceId: string, req: Pick<TargetRequest, 'workspaceId' | 'expectedWorkspaceId'> = {}): Promise<Omit<WorkspaceRemoteResult, 'requestId' | 'instanceId'>> {
    const { target, loaded } = await this.read(claims, spaceId, req);
    return {
      status: 'no_op',
      revision: loaded.revision,
      workspace: target.ref,
      inspection: inspectState(loaded.state) as unknown as Record<string, unknown>,
    };
  }

  /**
   * What a window gets right after it registers (§7.4): a capable window the
   * list first, then every window the ACTIVE workspace's state and its
   * drafts, then a capable window the open prompts. Returns that workspace's id.
   */
  async snapshot(claims: DbClaims, spaceId: string, capable: boolean, send: (frame: object) => void): Promise<string | null> {
    const { ws, loaded } = await this.read(claims, spaceId);
    const workspaceId = loaded.workspaceId;
    if (capable) {
      send({ type: 'workspace.summary', spaceId, listRevision: ws.listRevision, activeWorkspaceId: ws.activeId, items: summaries(ws) });
    }
    send({
      type: 'workspace.state',
      spaceId,
      workspaceId,
      active: true,
      revision: loaded.revision,
      state: loaded.exists ? (toStoredState(loaded.state) as unknown as Record<string, unknown>) : null,
    });
    for (const draft of loaded.drafts.values()) {
      send({ type: 'workspace.draft', spaceId, workspaceId, draftId: draft.draftId, kind: draft.kind, revision: draft.revision, fields: draft.fields });
    }
    if (capable && claims.identityId) {
      for (const prompt of this.prompts.list(claims.identityId, spaceId)) {
        if (prompt.state === 'open') send({ type: 'workspace.prompt', spaceId, prompt });
      }
    }
    return workspaceId;
  }

  // -- writes ----------------------------------------------------------------

  /**
   * Resolve the target, apply one command to it and push the result to the
   * identity's windows, all in one turn of the lock. A target that refuses
   * (§3.2) is an answer, not an error, so a retry gets the same one.
   */
  apply(claims: DbClaims, spaceId: string, input: ApplyInput): Promise<AppliedResult> {
    return this.serialize(claims, spaceId, async () => {
      let target: ResolvedTarget;
      try {
        target = await this.target(claims, spaceId, input.target ?? {});
      } catch (error) {
        if (!(error instanceof TargetRefused)) throw error;
        return this.answer(input, spaceId, claims, null, { status: error.status, revision: 0, ...error.fields } as AppliedResult);
      }
      // D7: emptying "the" workspace is ambiguous once there are two, so an
      // agent must name the one it means. A human, or one workspace, needs no pin.
      if (
        input.env.command === 'workspace.tabs.closeVisible' && input.origin.kind === 'http' && input.actor?.actorClass === 'agent'
        && input.target?.expectedWorkspaceId === undefined && target.count >= 2
      ) {
        return { status: 'rejected', revision: target.revision, reason: 'workspace_pin_required', workspace: target.ref };
      }
      return this.applyNow(claims, spaceId, input, target);
    });
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
      if ((await this.read(claims, spaceId)).ws.rows.length > 0) return false;
      // Sanitized: unknown kinds dropped, titles dropped, no pending prompt
      // (it belonged to another session), at most the hard tab limit.
      const stored = { ...toStoredState(sanitizeWorkspaceState(raw, spaceId) ?? defaultWorkspaceState(spaceId)), revision: 1 };
      const workspaceId = await this.save(claims, spaceId, null, 0, 1, stored);
      this.pushState(claims, spaceId, workspaceId, true, 1, stored);
      const kept = new Map(Object.values(stored.tabs).flatMap((t) => (t.type === 'draft' ? [[t.draftId, t.kind] as const] : [])));
      for (const draft of drafts.slice(0, 30)) {
        const kind = kept.get(draft.draftId);
        if (!kind) continue;
        const fields: DraftFields = {};
        for (const [name, v] of Object.entries(draft.values)) fields[name] = { v, r: 1 };
        const revision = await this.saveDraft(claims, workspaceId, draft.draftId, kind, 0, fields).catch(() => 0);
        if (revision > 0) this.deps.bridge.push(claims.identityId!, spaceId, { type: 'workspace.draft', spaceId, workspaceId, draftId: draft.draftId, kind, revision, fields });
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
    target: Omit<TargetRequest, 'draftId'> = {},
  ): Promise<{ draftId: string; revision: number; fields: DraftFields; overwrote: string[]; workspace: WorkspaceRef }> {
    return this.serialize(claims, spaceId, async () => {
      let resolved: ResolvedTarget;
      try {
        resolved = await this.target(claims, spaceId, { ...target, draftId });
      } catch (error) {
        // This op has no result status to carry a refusal (§5.5): a pin or
        // owner disagreement is a 409, a window's vanished workspace a 404.
        if (!(error instanceof TargetRefused)) throw error;
        throw new CollabError(error.status === 'conflict' ? 'conflict' : 'not_found', `the draft's workspace: ${error.reason}`, {
          details: { reason: error.reason, ...(error.pin ?? {}) },
        });
      }
      const loaded = await this.load(claims, spaceId, resolved.workspaceId);
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
      // A draft tab is only ever found in a stored row, so the workspace id is set.
      const revision = await this.saveDraft(claims, loaded.workspaceId!, draftId, tab.kind, row?.revision ?? 0, fields);
      this.deps.bridge.push(claims.identityId!, spaceId, {
        type: 'workspace.draft',
        spaceId,
        workspaceId: loaded.workspaceId,
        draftId,
        kind: tab.kind,
        revision,
        fields,
        ...(origin.instanceId ? { sourceInstanceId: origin.instanceId } : {}),
      }, { capableOnly: !resolved.ref.active });
      // Someone else's write makes the draft dirty: a later close must ask.
      if (origin.kind === 'http' && !tab.dirty && Object.keys(patch).length > 0) {
        await this.applyNow(claims, spaceId, {
          env: { command: 'workspace.drafts.markDirty', args: { tabId: tab.id, dirty: true }, source: 'system' },
          requestId: randomUUID(),
          origin,
        }, resolved);
      }
      return { draftId, revision, fields, overwrote, workspace: resolved.ref };
    });
  }

  // -- managing the list (§5.7–§5.11) ----------------------------------------
  //
  // Each op checks the caller-facing refusals inside the lock first, so it can
  // answer with a reason; the database functions (311) are the backstop. A
  // list change always reaches capable windows as one `workspace.summary`.

  /** §5.7: never switches. An identity with no row gets "Main", active, first (S12). */
  create(
    claims: DbClaims,
    spaceId: string,
    input: { requestId: string; name?: string; color?: WorkspaceColor | null; beforeWorkspaceId?: string | null; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, async () => {
      const { id, ws } = await this.manageTx(claims, spaceId, async (q, before) => {
        if (before.rows.length >= WORKSPACES_PER_IDENTITY_CAP) throw manageError('conflict', 'workspace_cap', `at most ${WORKSPACES_PER_IDENTITY_CAP} workspaces per space`);
        if (input.name !== undefined && nameTaken(before, input.name)) throw nameTakenError(input.name);
        const placed = input.beforeWorkspaceId ?? null;
        if (placed !== null && !before.rows.some((r) => r.id === placed)) throw workspaceNotFound(placed);
        const state = JSON.stringify(toStoredState(defaultWorkspaceState(spaceId)));
        if (before.rows.length === 0) {
          await q.query('select public.workspace_save($1, null, 0, 1, $2)', [spaceId, state]);
        }
        const rows = await q.query<{ id: string }>(
          'select public.workspace_create($1, $2, $3, $4, $5, $6) as id',
          [spaceId, input.name ?? null, input.color ?? null, placed, state, input.actor.actorClass === 'agent'],
        );
        return rows[0]!.id;
      });
      this.pushSummary(claims, spaceId, ws, { kind: 'created', workspaceId: id, ...who(input.actor) });
      return manageResult(input.requestId, 'applied', ws, id);
    });
  }

  /** §5.8: rename and/or recolour; `no_op` when nothing changes. No CAS: last writer wins. */
  update(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; name?: string; color?: WorkspaceColor | null; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, async () => {
      let renamed = false;
      const { id: changed, ws } = await this.manageTx(claims, spaceId, async (q, before) => {
        const row = before.rows.find((r) => r.id === workspaceId);
        if (!row) throw workspaceNotFound(workspaceId);
        if (input.name !== undefined && nameTaken(before, input.name, workspaceId)) throw nameTakenError(input.name);
        renamed = input.name !== undefined && input.name !== row.name;
        const rows = await q.query<{ changed: boolean }>(
          'select public.workspace_update($1, $2, $3, $4) as changed',
          [workspaceId, input.name ?? null, input.color !== undefined, input.color ?? null],
        );
        return rows[0]!.changed;
      });
      if (!changed) return manageResult(input.requestId, 'no_op', ws, workspaceId);
      this.pushSummary(claims, spaceId, ws, { kind: renamed ? 'renamed' : 'recolored', workspaceId, ...who(input.actor) });
      return manageResult(input.requestId, 'applied', ws, workspaceId);
    });
  }

  /** §5.9: move before another workspace, or last. The handler keeps agents out (D6). */
  reorder(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; beforeWorkspaceId: string | null; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, async () => {
      const { id: changed, ws } = await this.manageTx(claims, spaceId, async (q, before) => {
        for (const id of [workspaceId, input.beforeWorkspaceId]) {
          if (id !== null && !before.rows.some((r) => r.id === id)) throw workspaceNotFound(id);
        }
        const rows = await q.query<{ changed: boolean }>('select public.workspace_reorder($1, $2) as changed', [workspaceId, input.beforeWorkspaceId]);
        return rows[0]!.changed;
      });
      if (!changed) return manageResult(input.requestId, 'no_op', ws, workspaceId);
      this.pushSummary(claims, spaceId, ws, { kind: 'reordered', workspaceId, ...who(input.actor) });
      return manageResult(input.requestId, 'applied', ws, workspaceId);
    });
  }

  /**
   * §5.11: make a workspace the active one. A stale `expectedActiveWorkspaceId`
   * is `conflict` / `workspace_switched` (F2) and changes nothing. An agent
   * never switches: it raises a Switch/Stay prompt for the human (D8).
   */
  switch(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; expectedActiveWorkspaceId?: string; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, () => this.switchNow(claims, spaceId, workspaceId, input));
  }

  /**
   * §5.10: delete a workspace and its drafts. Deleting the active one moves
   * the pointer first (next in list order, else the previous) in the same
   * transaction, with the same frames as a switch. Dirty drafts need `discard`.
   * An agent deletes only what D6 lets it clean up; anything else is a
   * Delete/Keep prompt, and its `discard` is ignored (F3).
   */
  remove(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; discard: boolean; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, () => this.removeNow(claims, spaceId, workspaceId, input));
  }

  /**
   * §5.12: the human answers an agent's prompt. `accept` runs the switch or
   * the delete as the human; a delete with dirty drafts and no `discard` is
   * refused with `unsaved_changes` and the prompt stays open (F1).
   */
  resolvePrompt(
    claims: DbClaims,
    spaceId: string,
    promptId: string,
    input: { requestId: string; choice: 'accept' | 'decline'; discard: boolean; actor: ManageActor },
  ): Promise<WorkspaceManageResult> {
    return this.serialize(claims, spaceId, async () => {
      const identityId = claims.identityId!;
      const prompt = this.prompts.get(identityId, spaceId, promptId);
      if (!prompt) throw manageError('not_found', 'prompt_not_found', `no prompt ${promptId}`);
      if (prompt.state !== 'open') throw manageError('conflict', 'prompt_resolved', `prompt ${promptId} is already ${prompt.state}`);
      const ws = await this.deps.db.tx(claims, async (q) => {
        await q.query('set local role tm8_app');
        await requireSpace(q, spaceId);
        return loadWorkspaces(q, spaceId);
      });
      if (!ws.rows.some((r) => r.id === prompt.workspaceId)) {
        this.prompts.resolve(identityId, spaceId, promptId, 'expired');
        throw workspaceNotFound(prompt.workspaceId);
      }
      const answered = (result: WorkspaceManageResult): WorkspaceManageResult => ({
        ...result,
        prompt: this.prompts.get(identityId, spaceId, promptId) ?? prompt,
      });
      if (input.choice === 'decline') {
        this.prompts.resolve(identityId, spaceId, promptId, 'declined');
        return answered(manageResult(input.requestId, 'applied', ws, prompt.workspaceId));
      }
      const human = { ...input.actor, actorClass: 'human' as const };
      return answered(prompt.kind === 'switch'
        ? await this.switchNow(claims, spaceId, prompt.workspaceId, { requestId: input.requestId, actor: human }, promptId)
        : await this.removeNow(claims, spaceId, prompt.workspaceId, { requestId: input.requestId, discard: input.discard, actor: human }, promptId));
    });
  }

  /** `switch`, inside the lock. `accepting`: the prompt this answers, closed before the others. */
  private async switchNow(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; expectedActiveWorkspaceId?: string; actor: ManageActor },
    accepting?: string,
  ): Promise<WorkspaceManageResult> {
    const agent = input.actor.actorClass === 'agent';
    let refused: WorkspaceManageResult | undefined;
    const { id: previous, ws } = await this.manageTx(claims, spaceId, async (q, before) => {
      if (!before.rows.some((r) => r.id === workspaceId)) throw workspaceNotFound(workspaceId);
      const expected = input.expectedActiveWorkspaceId;
      if (expected !== undefined && expected !== before.activeId) {
        refused = {
          ...manageResult(input.requestId, 'conflict', before, workspaceId),
          reason: 'workspace_switched',
          expectedWorkspaceId: expected,
        };
        return null;
      }
      // An agent only asks; already active needs no asking.
      if (agent) return before.activeId;
      const rows = await q.query<{ previous: string }>('select public.workspace_switch($1) as previous', [workspaceId]);
      return rows[0]!.previous;
    });
    if (refused) return refused;
    if (previous === workspaceId) {
      if (accepting) this.prompts.resolve(claims.identityId!, spaceId, accepting, 'accepted');
      return manageResult(input.requestId, 'no_op', ws, workspaceId);
    }
    if (agent) return this.ask(claims, spaceId, ws, workspaceId, 'switch', input);
    if (accepting) this.prompts.resolve(claims.identityId!, spaceId, accepting, 'accepted');
    // The human chose: any Switch/Stay still open is moot.
    this.prompts.supersedeSwitches(claims.identityId!, spaceId);
    await this.pushSwitch(claims, spaceId, ws, previous, { kind: 'switched', workspaceId, ...who(input.actor) });
    return manageResult(input.requestId, 'applied', ws, workspaceId);
  }

  /** `remove`, inside the lock. `accepting`: the prompt this answers. */
  private async removeNow(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    input: { requestId: string; discard: boolean; actor: ManageActor },
    accepting?: string,
  ): Promise<WorkspaceManageResult> {
    const agent = input.actor.actorClass === 'agent';
    const loaded = await this.load(claims, spaceId, workspaceId).catch((error: unknown) => {
      throw error instanceof CollabError && error.code === 'not_found' ? workspaceNotFound(workspaceId) : error;
    });
    let last: WorkspaceSummary | undefined;
    let refused: WorkspaceManageResult | undefined;
    let ask = false;
    let wasActive = false;
    const { id: active, ws } = await this.manageTx(claims, spaceId, async (q, before) => {
      const row = before.rows.find((r) => r.id === workspaceId);
      if (!row) throw workspaceNotFound(workspaceId);
      if (before.rows.length <= 1) throw manageError('conflict', 'last_workspace', 'a space keeps at least one workspace');
      last = summaries(before).find((s) => s.id === workspaceId);
      wasActive = before.activeId === workspaceId;
      const dirty = Object.values(loaded.state.tabs).flatMap((t) => (t.type === 'draft' && t.dirty ? [t.draftId] : []));
      // D6: an agent cleans up only its own, off-screen, clean workspace.
      if (agent && !(row.createdByActorId !== null && row.createdByActorId === input.actor.actorId && !wasActive && dirty.length === 0)) {
        ask = true;
        return null;
      }
      if (dirty.length > 0 && !(input.discard && !agent)) {
        refused = { ...manageResult(input.requestId, 'rejected', before, workspaceId), reason: 'unsaved_changes', dirtyDraftIds: dirty };
        return null;
      }
      const rows = await q.query<{ active: string }>('select public.workspace_delete($1) as active', [workspaceId]);
      return rows[0]!.active;
    });
    if (ask) return this.ask(claims, spaceId, ws, workspaceId, 'delete', input);
    if (refused) return refused;
    if (accepting) this.prompts.resolve(claims.identityId!, spaceId, accepting, 'accepted');
    this.prompts.expireFor(claims.identityId!, spaceId, workspaceId);
    const cause = { kind: 'deleted' as const, workspaceId, ...who(input.actor) };
    if (wasActive) await this.pushSwitch(claims, spaceId, ws, workspaceId, cause);
    else this.pushSummary(claims, spaceId, ws, cause);
    return { requestId: input.requestId, status: 'applied', workspace: { ...last!, active: false }, activeWorkspaceId: active!, listRevision: ws.listRevision };
  }

  /** An agent's switch or delete the human must answer: raise the prompt (it pushes itself). */
  private ask(
    claims: DbClaims,
    spaceId: string,
    ws: Workspaces,
    workspaceId: string,
    kind: 'switch' | 'delete',
    input: { requestId: string; actor: ManageActor },
  ): WorkspaceManageResult {
    const identityId = claims.identityId!;
    const row = ws.rows.find((r) => r.id === workspaceId)!;
    const prompt = this.prompts.open(identityId, spaceId, {
      kind,
      workspaceId,
      workspaceName: row.name,
      ...(input.actor.actorName ? { actorName: input.actor.actorName } : {}),
    });
    return {
      ...manageResult(input.requestId, 'requires_user_choice', ws, workspaceId),
      reason: kind === 'switch' ? 'agent_switch' : 'agent_delete',
      prompt,
      choices: kind === 'switch' ? ['switch', 'stay'] : ['delete', 'keep'],
      promptDelivered: this.deps.bridge.list(identityId, spaceId).filter(isCapable).length,
    };
  }

  // -- internals -------------------------------------------------------------

  private async applyNow(claims: DbClaims, spaceId: string, input: ApplyInput, target: ResolvedTarget): Promise<AppliedResult> {
    const loaded = await this.load(claims, spaceId, target.workspaceId);
    const workspace = target.ref;
    const state = loaded.state;
    const { env } = input;

    // A batch open (§5.4, D10): every entity or none, on the stored path only.
    const batch = env.command === 'workspace.tabs.open' ? batchOf(env.args) : undefined;
    if (batch === null || (batch && input.origin.kind !== 'http')) {
      return this.answer(input, spaceId, claims, loaded.workspaceId, { status: 'rejected', revision: loaded.revision, reason: 'invalid_arguments', workspace });
    }

    // An agent may not open what it cannot read; the answer is the same as
    // "does not exist", so nothing leaks.
    if (input.origin.kind === 'http' && env.command === 'workspace.tabs.open') {
      const wanted = batch ? batch.map((e) => e.entityId) : [(env.args as { entityId?: unknown } | null)?.entityId];
      const ids = wanted.filter((id): id is string => typeof id === 'string' && ENTITY_ID.test(id));
      const readable = await this.readable(claims, ids);
      const unavailable = [...new Set(wanted.filter((id) => typeof id !== 'string' || !readable.has(id)))];
      if (unavailable.length > 0) {
        return this.answer(input, spaceId, claims, loaded.workspaceId, {
          status: 'rejected',
          revision: loaded.revision,
          reason: 'entity_unavailable',
          workspace,
          ...(batch ? { unavailableEntityIds: unavailable.map(String) } : {}),
        });
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
    // A batch reduces each entity in order on one state, then commits ONCE.
    // Only the first may take focus; any step that would not apply fails the
    // whole batch, before anything is written.
    const steps = batch ? batch.map((e, i) => stepOf(env, e, i)) : [env];
    let current: WorkspaceState = { ...state, revision: loaded.revision };
    const results: Result[] = [];
    let significant = false;
    for (const step of steps) {
      const reduction = reduce(current, step, hooks);
      // Post-commit steps run here too; on the node every hook is inert except
      // `deleteDraft`, which queues the draft rows to drop with this commit.
      for (const commit of reduction.commits) for (const after of commit.after) after();
      if (batch && reduction.result.status !== 'applied' && reduction.result.status !== 'no_op') {
        return this.answer(input, spaceId, claims, loaded.workspaceId, { ...reduction.result, revision: loaded.revision, workspace });
      }
      significant ||= reduction.commits.some((c) => c.significant);
      current = reduction.state;
      results.push(reduction.result);
    }
    // One commit is one revision, however many entities it opened.
    if (batch && significant) current = { ...current, revision: loaded.revision + 1 };
    const reduction = { state: current, result: { ...batchResult(results, batch !== undefined), ...(batch ? { revision: current.revision } : {}) } };
    if (!significant) {
      return this.answer(input, spaceId, claims, loaded.workspaceId, { ...reduction.result, revision: loaded.revision, workspace });
    }
    if (
      reduction.state.orderedTabIds.length > WORKSPACE_TAB_HARD_CAP &&
      reduction.state.orderedTabIds.length > state.orderedTabIds.length
    ) {
      return this.answer(input, spaceId, claims, loaded.workspaceId, { status: 'rejected', revision: loaded.revision, reason: 'tab_limit', workspace });
    }
    const next = toStoredState(reduction.state);
    // An agent's write marks the workspace for the switcher's activity dot.
    const agent = input.origin.kind === 'http' && input.actor?.actorClass === 'agent' ? claims.actorId ?? null : null;
    const workspaceId = await this.save(claims, spaceId, loaded.workspaceId, loaded.exists ? loaded.revision : 0, reduction.state.revision, next, agent);
    for (const draftId of deletedDrafts) {
      await this.saveDraft(claims, workspaceId, draftId, 'task', 0, null).catch(() => 0);
      this.deps.bridge.push(claims.identityId!, spaceId, { type: 'workspace.draft', spaceId, workspaceId, draftId, revision: 0, deleted: true }, {
        capableOnly: !workspace.active,
      });
    }
    // The first write of an identity creates "Main" (S12): name the row it made.
    const result: AppliedResult = { ...reduction.result, workspace: workspace.id === null ? { ...workspace, id: workspaceId } : workspace };
    const actor = input.origin.kind === 'http' && input.actor ? { actor: who(input.actor) } : {};
    this.pushState(claims, spaceId, workspaceId, workspace.active, reduction.state.revision, next, input.origin.instanceId || input.actor
      ? { ...(input.origin.instanceId ? { instanceId: input.origin.instanceId } : {}), requestId: input.requestId, result: result as unknown as Record<string, unknown>, ...actor }
      : undefined);
    // A change the human can't see: the list's activity dot says so (§7.3).
    if (agent && !workspace.active) {
      const ws = await this.deps.db.tx(claims, async (q) => {
        await q.query('set local role tm8_app');
        return loadWorkspaces(q, spaceId);
      });
      this.pushSummary(claims, spaceId, ws, { kind: 'agent_change', workspaceId, ...who(input.actor!) });
    }
    return result;
  }

  /**
   * One management transaction, as the caller: the list before (for the
   * refusals), the op, then the list after. A refusal the database raises
   * anyway (a race the node's checks cannot see) keeps its reason.
   */
  private async manageTx<T>(
    claims: DbClaims,
    spaceId: string,
    run: (q: Querier, before: Workspaces) => Promise<T>,
  ): Promise<{ id: T; ws: Workspaces }> {
    try {
      return await this.deps.db.tx(claims, async (q) => {
        await q.query('set local role tm8_app');
        await requireSpace(q, spaceId);
        const id = await run(q, await loadWorkspaces(q, spaceId));
        return { id, ws: await loadWorkspaces(q, spaceId) };
      });
    } catch (error) {
      throw manageFailure(error);
    }
  }

  /** The list, to capable windows only: an old window cannot read the frame (§7.3). */
  private pushSummary(
    claims: DbClaims,
    spaceId: string,
    ws: Workspaces,
    cause: { kind: WorkspaceSummaryCauseKind; workspaceId: string } & ManageActor,
  ): void {
    if (!claims.identityId) return;
    this.deps.bridge.push(claims.identityId, spaceId, {
      type: 'workspace.summary',
      spaceId,
      listRevision: ws.listRevision,
      activeWorkspaceId: ws.activeId,
      items: summaries(ws),
      cause,
    }, { capableOnly: true });
  }

  /**
   * The switch sequence (§7.5), inside the lock: capable windows get
   * `workspace.switched`, then every window the new active state and its
   * drafts, then capable windows the list. To an old window this is an
   * ordinary remote change of the one workspace it knows.
   */
  private async pushSwitch(
    claims: DbClaims,
    spaceId: string,
    ws: Workspaces,
    previous: string | null,
    cause: { kind: WorkspaceSummaryCauseKind; workspaceId: string } & ManageActor,
  ): Promise<void> {
    const identityId = claims.identityId;
    const workspaceId = ws.activeId;
    if (!identityId || workspaceId === null) return;
    const loaded = await this.load(claims, spaceId, workspaceId);
    this.deps.bridge.push(identityId, spaceId, {
      type: 'workspace.switched',
      spaceId,
      workspaceId,
      previousWorkspaceId: previous,
      listRevision: ws.listRevision,
      at: new Date().toISOString(),
    }, { capableOnly: true });
    this.pushState(claims, spaceId, workspaceId, true, loaded.revision, toStoredState(loaded.state));
    for (const draft of loaded.drafts.values()) {
      this.deps.bridge.push(identityId, spaceId, {
        type: 'workspace.draft', spaceId, workspaceId, draftId: draft.draftId, kind: draft.kind, revision: draft.revision, fields: draft.fields,
      });
    }
    this.pushSummary(claims, spaceId, ws, cause);
  }

  /** A command that did not commit: the sending window still needs its answer. */
  private answer(input: ApplyInput, spaceId: string, claims: DbClaims, workspaceId: string | null, result: AppliedResult): AppliedResult {
    if (input.origin.kind === 'window' && input.origin.instanceId && claims.identityId) {
      this.deps.bridge.push(claims.identityId, spaceId, {
        type: 'workspace.applied',
        spaceId,
        workspaceId: result.workspace?.id ?? workspaceId,
        requestId: input.requestId,
        result,
      }, { only: input.origin.instanceId });
    }
    return result;
  }

  /** Every capable window gets every workspace's state; an old window only the active one's (S9). */
  private pushState(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string,
    active: boolean,
    revision: number,
    state: WorkspaceState,
    cause?: { instanceId?: string; requestId: string; result: Record<string, unknown>; actor?: ManageActor },
  ): void {
    if (!claims.identityId) return;
    this.deps.bridge.push(claims.identityId, spaceId, {
      type: 'workspace.state',
      spaceId,
      workspaceId,
      active,
      revision,
      state: state as unknown as Record<string, unknown>,
      ...(cause ? { cause } : {}),
    }, active ? { shows: workspaceId } : { capableOnly: true });
  }

  /** §3.2 over the caller's workspaces, as the caller. */
  private async target(claims: DbClaims, spaceId: string, req: TargetRequest): Promise<ResolvedTarget> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      await requireSpace(q, spaceId);
      const ws = await loadWorkspaces(q, spaceId, req);
      return { ...resolveTarget(ws, req), activeWorkspaceId: ws.activeId, count: ws.rows.length };
    });
  }

  /** A read: explicit, else active (§3.3). A pin that doesn't hold is a 409. */
  private async read(claims: DbClaims, spaceId: string, req: Pick<TargetRequest, 'workspaceId' | 'expectedWorkspaceId'> = {}) {
    const ws = await this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      await requireSpace(q, spaceId);
      return loadWorkspaces(q, spaceId);
    });
    let target: Resolution;
    try {
      target = resolveTarget(ws, req);
    } catch (error) {
      if (!(error instanceof TargetRefused)) throw error;
      throw new CollabError('conflict', `the workspace: ${error.reason}`, { details: { reason: error.reason, ...(error.pin ?? {}) } });
    }
    return { ws, target, loaded: await this.load(claims, spaceId, target.workspaceId) };
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

  /**
   * One of the caller's workspaces, as resolved. `null` is the synthetic
   * "Main" of an identity with no row yet: the default state at revision 0.
   */
  private async load(claims: DbClaims, spaceId: string, workspaceId: string | null): Promise<Loaded> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = workspaceId === null
        ? []
        : await q.query<{ workspace_id: string; state: unknown; revision: string | number }>(
            `select workspace_id, state, revision from public.workspaces
              where space_id = $1 and identity_id = (select internal.identity_id()) and workspace_id = $2`,
            [spaceId, workspaceId],
          );
      const row = rows[0];
      if (!row && workspaceId !== null) throw new CollabError('not_found', `no workspace ${workspaceId}`, { details: { reason: 'workspace_not_found' } });
      const drafts = row
        ? await q.query<{ draft_id: string; kind: string; fields: DraftFields; revision: string | number }>(
            'select draft_id, kind, fields, revision from public.workspace_drafts where workspace_id = $1',
            [row.workspace_id],
          )
        : [];
      const revision = row ? Number(row.revision) : 0;
      const state = row ? (sanitizeStored(row.state, spaceId) ?? defaultWorkspaceState(spaceId)) : defaultWorkspaceState(spaceId);
      return {
        workspaceId: row?.workspace_id ?? null,
        revision,
        exists: row !== undefined,
        state: { ...state, revision },
        drafts: new Map(drafts.map((d) => [d.draft_id, { draftId: d.draft_id, kind: d.kind, fields: d.fields, revision: Number(d.revision) }])),
      };
    });
  }

  /**
   * Compare-and-swap one workspace row; returns its id. `workspaceId` null is
   * the identity's first write in the space: the database creates "Main" and
   * the active pointer in the same transaction (S12).
   */
  private async save(
    claims: DbClaims,
    spaceId: string,
    workspaceId: string | null,
    expected: number,
    next: number,
    state: WorkspaceState,
    agentActorId: string | null = null,
  ): Promise<string> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ workspace_id: string }>(
        'select public.workspace_save($1, $2, $3, $4, $5, $6) as workspace_id',
        [spaceId, workspaceId, expected, next, JSON.stringify(state), agentActorId],
      );
      return rows[0]!.workspace_id;
    });
  }

  private async saveDraft(
    claims: DbClaims,
    workspaceId: string,
    draftId: string,
    kind: string,
    expected: number,
    fields: DraftFields | null,
  ): Promise<number> {
    return this.deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const rows = await q.query<{ revision: string | number }>(
        'select public.workspace_draft_write($1, $2, $3, $4, $5) as revision',
        [workspaceId, draftId, kind, expected, fields === null ? null : JSON.stringify(fields)],
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

async function requireSpace(q: Querier, spaceId: string): Promise<void> {
  const space = await q.query('select 1 from public.spaces where id = $1', [spaceId]);
  if (space.length === 0) throw new CollabError('not_found', `no space ${spaceId}`);
}

/** A stored row is trusted shape-wise but re-sanitized: it may predate a change. */
function sanitizeStored(raw: unknown, spaceId: string): WorkspaceState | null {
  const clean = sanitizeWorkspaceState(raw, spaceId);
  if (!clean) return null;
  // A pending interaction survives a reload of the row (it is shared state).
  const pending = (raw as { pending?: unknown }).pending;
  return pending && typeof pending === 'object' ? { ...clean, pending: pending as WorkspaceState['pending'] } : clean;
}

/** The actor as frames name it: class and display name, never the id. */
function who(actor: ManageActor): { actorClass: 'human' | 'agent'; actorName?: string } {
  return { actorClass: actor.actorClass, ...(actor.actorName ? { actorName: actor.actorName } : {}) };
}

/**
 * `args.entities` of a batch open: undefined for a single open, null when
 * malformed (1–50 `{kind, entityId}`, and never beside `kind`/`entityId`).
 */
function batchOf(args: unknown): { kind: string; entityId: string }[] | null | undefined {
  if (typeof args !== 'object' || args === null || !('entities' in args)) return undefined;
  const { entities, kind, entityId } = args as { entities: unknown; kind?: unknown; entityId?: unknown };
  if (kind !== undefined || entityId !== undefined || !Array.isArray(entities)) return null;
  if (entities.length < 1 || entities.length > WORKSPACE_TAB_HARD_CAP) return null;
  const ok = entities.every((e) => typeof e === 'object' && e !== null && typeof e.kind === 'string' && typeof e.entityId === 'string'
    && Object.keys(e).every((k) => k === 'kind' || k === 'entityId'));
  return ok ? (entities as { kind: string; entityId: string }[]) : null;
}

/** One entity of a batch as a single open: the first keeps the caller's `activate` and revision guard. */
function stepOf(env: CommandEnvelope, entity: { kind: string; entityId: string }, index: number): CommandEnvelope {
  const { entities: _all, expectedRevision: _guard, ...rest } = env.args as Record<string, unknown>;
  const args = { ...rest, kind: entity.kind, entityId: entity.entityId, ...(index > 0 ? { activate: false } : {}) };
  const { expectedRevision, ...base } = env;
  return { ...base, args, ...(index === 0 && expectedRevision !== undefined ? { expectedRevision } : {}) } as CommandEnvelope;
}

/** A batch answers as its first entity, plus every tab id and outcome in order. */
function batchResult(results: Result[], batch: boolean): AppliedResult {
  const last = results[results.length - 1]!;
  const first = results[0]!;
  if (!batch) return last;
  return {
    ...first,
    status: results.some((r) => r.status === 'applied') ? 'applied' : 'no_op',
    revision: last.revision,
    tabIds: results.map((r) => r.tabId ?? ''),
    outcomes: results.map((r) => r.outcome ?? 'reused'),
  } as AppliedResult;
}

/** A management result naming `workspaceId` as it is in `ws`. */
function manageResult(
  requestId: string,
  status: WorkspaceManageResult['status'],
  ws: Workspaces,
  workspaceId: string,
): WorkspaceManageResult {
  const workspace = summaries(ws).find((s) => s.id === workspaceId)!;
  return { requestId, status, workspace, activeWorkspaceId: ws.activeId!, listRevision: ws.listRevision };
}

function nameTaken(ws: Workspaces, name: string, except?: string): boolean {
  const wanted = name.toLowerCase();
  return ws.rows.some((r) => r.id !== except && r.name.toLowerCase() === wanted);
}

function manageError(code: 'conflict' | 'not_found' | 'invalid_input', reason: string, message: string): CollabError {
  return new CollabError(code, message, { details: { reason } });
}

function workspaceNotFound(workspaceId: string): CollabError {
  return manageError('not_found', 'workspace_not_found', `no workspace ${workspaceId}`);
}

function nameTakenError(name: string): CollabError {
  return manageError('conflict', 'workspace_name_taken', `you already have a workspace named ${JSON.stringify(name)}`);
}

/** The database's backstop refusals (311), with the reason the node would have given. */
function manageFailure(error: unknown): unknown {
  if (error instanceof CollabError) return error;
  switch ((error as { code?: unknown } | null)?.code) {
    case '23505': return manageError('conflict', 'workspace_name_taken', 'you already have a workspace with that name');
    case '53400': return manageError('conflict', 'workspace_cap', `at most ${WORKSPACES_PER_IDENTITY_CAP} workspaces per space`);
    case '55000': return manageError('conflict', 'last_workspace', 'a space keeps at least one workspace');
    case 'P0002': return manageError('not_found', 'workspace_not_found', 'no such workspace');
    case '22023': return manageError('invalid_input', 'invalid_name', 'invalid workspace name');
    default: return error;
  }
}
