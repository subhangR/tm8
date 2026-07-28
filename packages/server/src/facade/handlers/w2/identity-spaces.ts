import { CollabError } from '@tm8/contract';

import type { OperationHandler } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { identityGet } from '../identity.js';
import {
  spacesCreate,
  spacesGet,
  spacesHome,
  spacesList,
  spacesNavigation,
} from '../spaces.js';
import { W2IdentitySpacesService } from '../../services/w2/identity-spaces.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireMutationId(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    const body = ctx.body;
    const clientMutationId =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).clientMutationId
        : undefined;
    if (typeof clientMutationId !== 'string' || clientMutationId.trim().length === 0) {
      throw new CollabError('invalid_input', 'clientMutationId is required');
    }
    const actorId = (body as Record<string, unknown>).actorId;
    if (actorId !== undefined && (typeof actorId !== 'string' || !UUID_RE.test(actorId))) {
      throw new CollabError('invalid_input', 'actorId must be a uuid');
    }
    return handler(ctx);
  };
}

/**
 * W2.G01's complete integration seam.
 *
 * The shared W2 integration worker calls this instead of registering the six
 * legacy identity/Space handlers separately. Keeping one seam makes the
 * registry's implemented-operation report agree with the complete group.
 */
export function registerW2IdentitySpacesHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2IdentitySpacesService(deps);
  registry.registerAll({
    'identity.get': identityGet(deps),
    'spaces.list': spacesList(deps),
    'spaces.create': requireMutationId(spacesCreate(deps)),
    'spaces.get': spacesGet(deps),
    'spaces.update': service.spacesUpdate,
    'spaces.navigation': spacesNavigation(deps),
    'spaces.home': spacesHome(deps),
    'spaces.settings': service.spacesSettings,
    'spaces.members.list': service.spacesMembersList,
    'spaces.invites.list': service.spacesInvitesList,
    'spaces.invites.create': service.spacesInvitesCreate,
    'spaces.invites.revoke': service.spacesInvitesRevoke,
    'spaces.invites.redeem': service.spacesInvitesRedeem,
    'spaces.taskAxes.list': service.spacesTaskAxesList,
    'spaces.taskAxes.create': service.spacesTaskAxesCreate,
    'spaces.taskAxes.update': service.spacesTaskAxesUpdate,
    'spaces.taskAxes.delete': service.spacesTaskAxesDelete,
    'spaces.leaderboard': service.spacesLeaderboard,
    'spaces.awards': service.spacesAwards,
  });
}
