import type { Db } from '../../../db/types.js';
import type { ServerConfig } from '../../../http/config.js';
import { json } from '../../../http/types.js';
import { createLoopbackOwnerResolver } from '../../../identity/loopback.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { createSavedViewsActionsService } from '../../services/w2/saved-views-actions.js';

/**
 * Register the five G09 operations without reaching into the shared facade
 * composition. The wave integrator owns the one call site in facade/index.ts.
 */
export function registerW2SavedViewsActionsHandlers(
  registry: HandlerRegistry,
  deps: { readonly db: Db; readonly config: ServerConfig; readonly owner?: FacadeDeps['owner'] },
): void {
  const facade: FacadeDeps = {
    db: deps.db,
    config: deps.config,
    // The composition root's owner when one is injected, as every other W2
    // seam does (facade/index.ts); otherwise `actions.list` answered for a
    // different caller than `entities.context`'s own palette.
    owner: deps.owner ?? createLoopbackOwnerResolver(deps.db),
  };
  const service = createSavedViewsActionsService(facade, registry);

  registry.registerAll({
    'savedViews.list': (ctx) => service.listSavedViews(ctx),
    'savedViews.create': async (ctx) => json(await service.createSavedView(ctx), { status: 201 }),
    'savedViews.update': (ctx) => service.updateSavedView(ctx),
    'savedViews.delete': (ctx) => service.deleteSavedView(ctx),
    'actions.list': (ctx) => service.listActions(ctx),
  });
}
