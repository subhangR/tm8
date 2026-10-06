/**
 * `workspace.instances.list`, `workspace.inspect` and `workspace.command`
 * (Spec C §2): the caller side of the Workspace remote bridge.
 *
 * Every handler answers for the CALLER'S OWN windows only. The caller's
 * identity comes from the resolved request (an agent token resolves to its
 * owner's identity), and the bridge is keyed by it; there is no parameter that
 * names whose windows to look at.
 */
import { CollabError, type WorkspaceCommandInput } from '@tm8/contract';

import type { Db, DbClaims } from '../db/types.js';
import { claimsFor } from '../facade/context.js';
import type { HandlerRegistry } from '../facade/index.js';
import { json, type RequestContext } from '../http/types.js';
import { createLoopbackOwnerResolver, type LoopbackOwner } from '../identity/loopback.js';
import type { WorkspaceBridge } from './bridge.js';

export interface WorkspaceHandlerDeps {
  readonly db: Db;
  readonly bridge: WorkspaceBridge;
  readonly owner?: () => Promise<LoopbackOwner>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Caller {
  identityId: string;
  spaceId: string;
  actorClass: 'human' | 'agent';
  actorName?: string;
}

export function registerWorkspaceHandlers(registry: HandlerRegistry, deps: WorkspaceHandlerDeps): void {
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
      const actorId = claims.actorId;
      const actor = actorId
        ? await q.query<{ title: string | null }>(
            'select title from public.entities where id = $1 and deleted_at is null',
            [actorId],
          )
        : [];
      return { readable: space.length > 0, actorName: actor[0]?.title ?? undefined };
    });
    if (!readable) throw new CollabError('not_found', `no space ${spaceId}`);

    const agent = ctx.identity.authKind === 'agent' || ctx.identity.authKind === 'agent_runtime';
    return {
      identityId: claims.identityId,
      spaceId,
      actorClass: agent ? 'agent' : 'human',
      ...(actorName ? { actorName } : {}),
    };
  }

  registry.register('workspace.instances.list', async (ctx) => {
    const who = await caller(ctx);
    return json({ items: deps.bridge.list(who.identityId, who.spaceId) });
  });

  registry.register('workspace.inspect', async (ctx) => {
    const who = await caller(ctx);
    const instanceId = ctx.query.get('instanceId') ?? undefined;
    if (instanceId !== undefined && (instanceId === '' || instanceId.length > 128)) {
      throw new CollabError('invalid_input', 'instanceId must be a Workspace instance id');
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
  });

  registry.register('workspace.command', async (ctx) => {
    const who = await caller(ctx);
    const input = ctx.body as WorkspaceCommandInput;
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
  });
}
