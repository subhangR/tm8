/**
 * `servers.*` (W8, migration 991) — registration and request adaptation over
 * `DbServerStore`.
 *
 * `list`, `get` and `probe` are open to every home member: no response carries
 * a secret, and `probe` only records reachability through the SSRF-guarded
 * client. `add`, `adopt` and `remove` are HUMAN-ONLY, twice: the same
 * `requireHumanLinkSession` guard W6 uses, and the strict
 * `internal.require_human_auth_kind()` in every 991 write RPC. Signing in to a
 * server (the sealed gate token) is not an operation yet: it rides the remote
 * sign-in flow that lands with remote invoke.
 */
import {
  CollabError,
  ServersAddInputSchema,
  ServersAdoptInputSchema,
  ServersMutationInputSchema,
} from '@tm8/contract';
import type { ServerProbeView, ServerView } from '@tm8/contract';

import { json, type OperationHandler, type RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import { DbServerStore } from '../../../remote/server-store.js';
import { requireHumanLinkSession } from './space-links.js';

export interface ServerHandlerDeps {
  /** Node data root: the node key that seals a member's gate session. */
  dataDir: string;
  /** Tests: a store with an injected resolver/transport. */
  store?: DbServerStore;
}

function pathParam(ctx: RequestContext, name: 'spaceId' | 'serverId'): string {
  const value = ctx.params[name];
  if (!value) throw new CollabError('invalid_input', `${name} is required`);
  return value;
}

export function registerServerHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  servers: ServerHandlerDeps,
): void {
  const store = servers.store ?? new DbServerStore({ db: deps.db, dataDir: servers.dataDir });
  const claimsOf = async (ctx: RequestContext) => {
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'no identity resolved for this request');
    return claims;
  };

  const list: OperationHandler = async (ctx): Promise<ServerView[]> =>
    store.list(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const get: OperationHandler = async (ctx): Promise<ServerView> =>
    store.get(await claimsOf(ctx), pathParam(ctx, 'serverId'));

  const add: OperationHandler = async (ctx) => {
    const input = ServersAddInputSchema.parse(ctx.body);
    return json(await store.add(await claimsOf(ctx), input), { status: 201 });
  };

  const adopt: OperationHandler = async (ctx): Promise<ServerView> => {
    const input = ServersAdoptInputSchema.parse(ctx.body);
    return store.adopt(await claimsOf(ctx), input);
  };

  const remove: OperationHandler = async (ctx): Promise<ServerView> => {
    const { clientMutationId } = ServersMutationInputSchema.parse(ctx.body);
    return store.remove(await claimsOf(ctx), pathParam(ctx, 'serverId'), clientMutationId);
  };

  const probe: OperationHandler = async (ctx): Promise<ServerProbeView> => {
    ServersMutationInputSchema.parse(ctx.body);
    return store.probe(await claimsOf(ctx), pathParam(ctx, 'serverId'));
  };

  registry.registerAll({
    'servers.list': list,
    'servers.get': get,
    'servers.add': requireHumanLinkSession(add),
    'servers.adopt': requireHumanLinkSession(adopt),
    'servers.remove': requireHumanLinkSession(remove),
    'servers.probe': probe,
  });
}
