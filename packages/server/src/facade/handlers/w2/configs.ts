import { NodeSettingSetInputSchema } from '@tm8/contract';

import { ConfigsService } from '../../../configs/service.js';
import { claimsFor, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { requireHumanSession } from './credentials.js';

/**
 * `spaces.configs` — the Settings → Configs read. Node env is gated inside the
 * service (node admin on a human session); everything else is the caller's
 * RLS view of the space.
 *
 * `node.settings.set` — Node admin → Configuration's write: one curated node
 * setting, stored for the next restart (configs/node-settings.ts).
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
    'node.settings.set': requireHumanSession(async (ctx) => {
      const name = ctx.params['name'] ?? '';
      const { value } = NodeSettingSetInputSchema.parse(ctx.body);
      const claims = claimsFor(await deps.owner(), ctx);
      return service.setNodeSetting(
        { claims, authKind: ctx.identity.authKind, viaAutoOwner: ctx.identity.kind === 'auto-owner' },
        name,
        value,
      );
    }),
  });
}
