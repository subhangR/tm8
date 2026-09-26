/**
 * `node.metrics.get` — host metrics for the desktop status strip.
 *
 * Gated like the other node-admin reads (`node.credentials.status`): a human
 * session holding the server-resolved `nodeAdmin` claim. Host load and memory
 * describe the MACHINE, not a space, so a space member who is not the node's
 * admin has no business reading them; and `claimsFor` already clears
 * `nodeAdmin` for a space-pinned session (K6), so that rule is inherited here
 * rather than restated.
 */
import { CollabError } from '@tm8/contract';

import { claimsFor } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { json } from '../http/types.js';
import { HostMetricsSampler } from './host-metrics.js';

const HUMAN_AUTH_KINDS: readonly string[] = ['browser', 'cli'];

export function registerNodeMetricsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  sampler: HostMetricsSampler = new HostMetricsSampler(
    deps.config.dataDir ? { dataDir: deps.config.dataDir } : {},
  ),
): void {
  registry.register('node.metrics.get', async (ctx) => {
    // First, so an anonymous caller is `unauthenticated`, not `forbidden`.
    const claims = claimsFor(await deps.owner(), ctx);
    const kind = ctx.identity.authKind;
    if (kind === undefined || !HUMAN_AUTH_KINDS.includes(kind)) {
      throw new CollabError('forbidden', 'node metrics are available to human sessions only', {
        details: { reason: 'human_session_required' },
      });
    }
    if (claims.nodeAdmin !== true) {
      throw new CollabError('forbidden', 'node metrics are available to node admins only', {
        details: { reason: 'node_admin_required' },
      });
    }
    return json(await sampler.read());
  });
}
