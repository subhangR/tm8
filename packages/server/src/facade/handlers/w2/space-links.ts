/**
 * `spaceLinks.*` (W6, migrations 250/251) — registration and request
 * adaptation over `DbSpaceLinkStore`.
 *
 * `spaceLinks.list` is open to every home member: it carries no secret, and
 * an agent needs it to know which linked spaces its human has signed in to.
 * The six writes are HUMAN-ONLY, twice: `requireHumanLinkSession` here reads the
 * server-resolved `ctx.identity.authKind`, and every write RPC in 251 calls
 * the strict `internal.require_human_auth_kind()` on the bound claim. A `link`
 * session is refused by both, so a link can never manage links.
 *
 * No handler returns the stored session. `use` (W7) is not an operation.
 */
import {
  CollabError,
  SpaceLinksAddInputSchema,
  SpaceLinksMutationInputSchema,
  SpaceLinksSetSpawnInputSchema,
} from '@tm8/contract';
import type { SpaceLinkView } from '@tm8/contract';

import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import { DbSpaceLinkStore } from '../../../credentials/space-link-store.js';

const HUMAN_AUTH_KINDS: readonly string[] = ['browser', 'cli'];

/** The typed refusal code. Stable, and asserted by test. */
export const SPACE_LINKS_HUMAN_ONLY = 'space_links_human_only';

/** Layer 1 of the human-only rule; fails closed on an absent kind. */
export function requireHumanLinkSession(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    const kind = ctx.identity.authKind;
    if (kind === undefined || !HUMAN_AUTH_KINDS.includes(kind)) {
      throw new CollabError(
        'forbidden',
        'space link management is available to human sessions only',
        { details: { reason: SPACE_LINKS_HUMAN_ONLY } },
      );
    }
    return handler(ctx);
  };
}

export interface SpaceLinkHandlerDeps {
  /** Node data root: the node key that seals stored link sessions. */
  dataDir: string;
  /**
   * Built by the composition root when it wires `onStale` (W7-bound: see
   * `DbSpaceLinkStoreOptions.onStale`); defaults to a plain store.
   */
  store?: DbSpaceLinkStore;
}

function pathParam(ctx: RequestContext, name: 'spaceId' | 'linkId'): string {
  const value = ctx.params[name];
  if (!value) throw new CollabError('invalid_input', `${name} is required`);
  return value;
}

export function registerSpaceLinkHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  links: SpaceLinkHandlerDeps,
): void {
  const store = links.store ?? new DbSpaceLinkStore({ db: deps.db, dataDir: links.dataDir });
  const claimsOf = async (ctx: RequestContext) => {
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'no identity resolved for this request');
    return claims;
  };

  const list: OperationHandler = async (ctx): Promise<SpaceLinkView[]> =>
    store.list(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const add: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { targetSpaceId, alias, clientMutationId } = SpaceLinksAddInputSchema.parse(ctx.body);
    return store.add(await claimsOf(ctx), {
      spaceId: pathParam(ctx, 'spaceId'), targetSpaceId, alias: alias ?? null, clientMutationId,
    });
  };

  const login = (relogin: boolean): OperationHandler => async (ctx): Promise<SpaceLinkView> => {
    const { clientMutationId } = SpaceLinksMutationInputSchema.parse(ctx.body);
    return store.login(await claimsOf(ctx), pathParam(ctx, 'linkId'), { relogin, clientMutationId });
  };

  const logout: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { clientMutationId } = SpaceLinksMutationInputSchema.parse(ctx.body);
    return store.logout(await claimsOf(ctx), pathParam(ctx, 'linkId'), clientMutationId);
  };

  const remove: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { clientMutationId } = SpaceLinksMutationInputSchema.parse(ctx.body);
    return store.remove(await claimsOf(ctx), pathParam(ctx, 'linkId'), clientMutationId);
  };

  const setSpawn: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { allowSpawn, spawnBudget, clientMutationId } = SpaceLinksSetSpawnInputSchema.parse(ctx.body);
    return store.setSpawn(await claimsOf(ctx), {
      linkId: pathParam(ctx, 'linkId'), allowSpawn, spawnBudget: spawnBudget ?? null, clientMutationId,
    });
  };

  // Every write is wrapped; `list` alone is open (no secret, read-only).
  registry.registerAll({
    'spaceLinks.list': list,
    'spaceLinks.add': requireHumanLinkSession(add),
    'spaceLinks.login': requireHumanLinkSession(login(false)),
    'spaceLinks.relogin': requireHumanLinkSession(login(true)),
    'spaceLinks.logout': requireHumanLinkSession(logout),
    'spaceLinks.remove': requireHumanLinkSession(remove),
    'spaceLinks.setSpawn': requireHumanLinkSession(setSpawn),
  });
}
