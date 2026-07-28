import { createSavedViewsActionsService } from '../../services/w2/saved-views-actions.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2FeedContextService,
  type W2FeedContextServiceOptions,
} from '../../services/w2/feed-context.js';
import type { RequestContext } from '../../../http/types.js';

/**
 * W2.G13's complete, and only, semantic-catalog registration seam.
 *
 * Exactly two operations, both reads, both previously answering an honest
 * `501 not_implemented`. Registering them here — rather than in the composition
 * root — is what keeps `/health`'s implemented count the truthful answer to
 * "what does this node actually do?".
 */
export function registerW2FeedContextHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2FeedContextServiceOptions = {},
): void {
  const service = new W2FeedContextService(deps, {
    actions: options.actions ?? defaultActions(registry, deps),
  });
  registry.registerAll({
    'entities.feed': service.feed,
    'entities.context': service.context,
  });
}

/**
 * `entities.context`'s `actions` section, served by G09's discoverer.
 *
 * The palette must answer "what may this caller do to this entity?", and G09
 * already owns that judgement for `actions.list`. A second implementation would
 * let the focus view and the palette disagree — the same divergence the single
 * entity assembler exists to prevent, one layer up.
 *
 * The synthesised context carries ONLY the target id: availability is derived
 * from the caller's claims and the stored row, never from anything the feed or
 * focus request said about itself.
 */
function defaultActions(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): NonNullable<W2FeedContextServiceOptions['actions']> {
  return async (ctx, entityId) => {
    const query = new URLSearchParams({ contextEntityId: entityId });
    const discovery = await createSavedViewsActionsService(deps, registry).listActions({
      ...ctx,
      query,
      body: undefined,
    } satisfies RequestContext);
    return discovery.actions;
  };
}

export type { W2FeedContextServiceOptions };
