/**
 * `workspace.instances.list`, `workspace.inspect` and `workspace.command`
 * (Spec C §2): the caller side of the Workspace remote bridge.
 *
 * Every handler answers for the CALLER'S OWN windows only. The caller's
 * identity comes from the resolved request (an agent token resolves to its
 * owner's identity), and the bridge is keyed by it; there is no parameter that
 * names whose windows to look at.
 */
import {
  CollabError,
  type WorkspaceCommandInput,
  type WorkspaceDraftPatchInput,
  type WorkspaceRemoteResult,
} from '@tm8/contract';
import { WINDOW_ONLY_COMMANDS, type CommandName } from '@tm8/contract/workspace';

import type { Db, DbClaims } from '../db/types.js';
import { claimsFor } from '../facade/context.js';
import { loadActors } from '../facade/entity-read.js';
import { json, type OperationHandler, type RequestContext } from '../http/types.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import { clampTimeout, type WorkspaceBridge } from './bridge.js';
import type { WorkspaceService } from './service.js';

export interface WorkspaceHandlerDeps {
  readonly db: Db;
  readonly bridge: WorkspaceBridge;
  /** Spec D: the stored workspace. Absent = Spec C behaviour (every command needs a window). */
  readonly service?: WorkspaceService;
  readonly owner?: () => Promise<LoopbackOwner>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Caller {
  claims: DbClaims;
  identityId: string;
  spaceId: string;
  actorClass: 'human' | 'agent';
  actorName?: string;
}

export interface WorkspaceHandlers {
  readonly list: OperationHandler;
  readonly inspect: OperationHandler;
  readonly command: OperationHandler;
  readonly get: OperationHandler;
  readonly patchDraft: OperationHandler;
}

/**
 * The three handlers. They are MOUNTED by `registerEventHandlers` (beside
 * `presence.get`, the other in-memory live-socket read), so the registration
 * stays a literal the conformance inventory can audit.
 */
export function workspaceHandlers(deps: WorkspaceHandlerDeps): WorkspaceHandlers {
  const owner = deps.owner ?? createLoopbackOwnerResolver(deps.db);

  /**
   * Who is calling, checked against the space. The space read is the same RLS
   * probe `events.subscribe` authorizes with, as `tm8_app`; a caller who
   * cannot read the space gets `not_found`, never a list of nothing.
   */
  async function caller(ctx: RequestContext): Promise<Caller> {
    const spaceId = ctx.params['spaceId'] ?? '';
    if (!UUID_RE.test(spaceId)) throw new CollabError('invalid_input', 'spaceId must be a space id (uuid)');
    if (ctx.identity.authKind === 'link') {
      // A link visitor holds no Workspace windows of its own to drive.
      throw new CollabError('forbidden', 'a link session cannot drive Workspace windows', {
        details: { reason: 'link_session' },
      });
    }
    const claims: DbClaims = claimsFor(await owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'authentication is required');

    const { readable, actorName } = await deps.db.tx(claims, async (q) => {
      await q.query('set local role tm8_app');
      const space = await q.query('select 1 from public.spaces where id = $1', [spaceId]);
      // The calling actor's display name (an agent's teammate), for the
      // window's "<name> opened …" notice. Same resolver every byline uses.
      const actorId = claims.actorId;
      const actor = actorId ? (await loadActors(q, [actorId])).get(actorId) : undefined;
      return { readable: space.length > 0, actorName: actor?.displayName };
    });
    if (!readable) throw new CollabError('not_found', `no space ${spaceId}`);

    const agent = ctx.identity.authKind === 'agent' || ctx.identity.authKind === 'agent_runtime';
    return {
      claims,
      identityId: claims.identityId,
      spaceId,
      actorClass: agent ? 'agent' : 'human',
      ...(actorName ? { actorName } : {}),
    };
  }

  const list: OperationHandler = async (ctx) => {
    const who = await caller(ctx);
    return json({ items: deps.bridge.list(who.identityId, who.spaceId) });
  };

  const inspect: OperationHandler = async (ctx) => {
    const who = await caller(ctx);
    const instanceId = ctx.query.get('instanceId') ?? undefined;
    if (instanceId !== undefined && (instanceId === '' || instanceId.length > 128)) {
      throw new CollabError('invalid_input', 'instanceId must be a Workspace instance id');
    }
    // Spec D: with no live window, the stored workspace answers.
    if (deps.service && instanceId === undefined && deps.bridge.list(who.identityId, who.spaceId).length === 0) {
      const stored = await deps.service.inspectStored(who.claims, who.spaceId);
      return json({ ...stored, requestId: `stored-${Date.now()}`, instanceId: '' });
    }
    // A read: never recorded, so every inspect is a fresh snapshot.
    return json(await deps.bridge.run({
      identityId: who.identityId,
      spaceId: who.spaceId,
      command: 'workspace.inspect',
      actorClass: who.actorClass,
      ...(instanceId ? { instanceId } : {}),
      ...(who.actorName ? { actorName: who.actorName } : {}),
    }));
  };

  const command: OperationHandler = async (ctx) => {
    const who = await caller(ctx);
    const input = ctx.body as WorkspaceCommandInput;
    const service = deps.service;
    // Spec D §4: dialogs, the route, focus and the human's answer need a live
    // window; everything else applies to the stored workspace.
    if (!service || WINDOW_ONLY_COMMANDS.has(input.command as CommandName)) {
      return json(await deps.bridge.run({
        identityId: who.identityId,
        spaceId: who.spaceId,
        requestId: input.requestId,
        command: input.command,
        actorClass: who.actorClass,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(who.actorName ? { actorName: who.actorName } : {}),
      }));
    }
    const payload = {
      stored: true,
      spaceId: who.spaceId,
      instanceId: input.instanceId ?? null,
      command: input.command,
      args: input.args ?? null,
      expectedRevision: input.expectedRevision ?? null,
    };
    return json(await deps.bridge.recorded(who.identityId, input.requestId, payload, clampTimeout(input.timeoutMs), async () => {
      const result = await service.apply(who.claims, who.spaceId, {
        env: {
          command: input.command as CommandName,
          args: input.args,
          source: 'remote',
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
        },
        requestId: input.requestId,
        origin: { kind: 'http' },
      });
      const out: WorkspaceRemoteResult = { ...(result as unknown as WorkspaceRemoteResult), requestId: input.requestId, instanceId: '' };
      if (input.command !== 'workspace.tabs.open' || result.status !== 'applied' || !result.tabId) return out;
      if ((input.args as { activate?: unknown } | undefined)?.activate === false) return { ...out, activation: 'not_requested' };
      // The stored workspace has it; a live window ALSO brings it to the front,
      // under the window's own typing rule.
      const target = deps.bridge.targetOf(who.identityId, who.spaceId, input.instanceId);
      if (target === null) return { ...out, activation: 'no_window' };
      try {
        const shown = await deps.bridge.run({
          identityId: who.identityId,
          spaceId: who.spaceId,
          instanceId: target,
          command: 'workspace.tabs.activate',
          args: { tabId: result.tabId },
          actorClass: who.actorClass,
          timeoutMs: 3000,
          ...(who.actorName ? { actorName: who.actorName } : {}),
        });
        const activation = shown.status === 'applied' || shown.status === 'no_op'
          ? 'activated'
          : shown.reason === 'user_typing' ? 'user_typing' : 'no_window';
        return { ...out, instanceId: target, activation };
      } catch {
        return { ...out, activation: 'no_window' };
      }
    }));
  };

  const get: OperationHandler = async (ctx) => {
    const who = await caller(ctx);
    if (!deps.service) throw new CollabError('not_implemented', 'this node keeps no stored workspaces');
    return json(await deps.service.get(who.claims, who.spaceId));
  };

  const patchDraft: OperationHandler = async (ctx) => {
    const who = await caller(ctx);
    if (!deps.service) throw new CollabError('not_implemented', 'this node keeps no stored workspaces');
    const draftId = ctx.params['draftId'] ?? '';
    if (!UUID_RE.test(draftId)) throw new CollabError('invalid_input', 'draftId must be a draft id (uuid)');
    const input = ctx.body as WorkspaceDraftPatchInput;
    if (Object.keys(input.fields).length === 0) throw new CollabError('invalid_input', 'name at least one field');
    return json(await deps.service.patchDraft(who.claims, who.spaceId, draftId, input.fields, { kind: 'http' }));
  };

  return { list, inspect, command, get, patchDraft };
}

/**
 * The caller's ACTIVE member in a space, read as the caller (Spec C §1). The
 * window never names its own member; `workspace.register` takes it from here.
 */
export async function memberForClaims(db: Pick<Db, 'tx'>, claims: DbClaims, spaceId: string): Promise<string | null> {
  if (!claims.identityId) return null;
  const rows = await db.tx(claims, async (q) => {
    await q.query('set local role tm8_app');
    return q.query<{ entity_id: string }>(
      `select entity_id from public.members
        where space_id = $1 and identity_id = $2 and status = 'active'`,
      [spaceId, claims.identityId],
    );
  });
  return rows[0]?.entity_id ?? null;
}
