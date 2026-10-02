import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { PathGrantsService } from '../../services/w2/path-grants.js';

/** Filesystem path grants (migration 282, design doc 01a0fb62 §4). */
export function registerPathGrantHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const service = new PathGrantsService(deps);
  registry.registerAll({
    'node.pathGrants.list': service.list,
    'node.pathGrants.create': async (ctx) => json(await service.create(ctx), { status: 201 }),
    'node.pathGrants.revoke': service.revoke,
    'node.accounts.list': service.accounts,
    'identity.pathGrants.list': service.mine,
  });
}
