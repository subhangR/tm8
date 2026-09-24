import { ConfigsService } from '../../../configs/service.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';

/**
 * `spaces.configs` — the Settings → Configs read. Node env is gated inside the
 * service (node admin on a human session); everything else is the caller's
 * RLS view of the space.
 */
export function registerW2ConfigsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const service = new ConfigsService(deps.db, env);
  registry.registerAll({
    'spaces.configs': async (ctx) => {
      const spaceId = requireUuidParam(ctx, 'spaceId');
      const claims = claimsFor(await deps.owner(), ctx);
      return service.read({ claims, authKind: ctx.identity.authKind }, spaceId);
    },
  });
}
