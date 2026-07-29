import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2ServerConnectionsService } from '../../services/w2/server-connections.js';

export function registerW2ServerConnectionHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2ServerConnectionsService(deps);
  registry.registerAll({
    'serverConnections.list': service.list,
    'serverConnections.create': async (ctx) => json(await service.create(ctx), { status: 201 }),
    'serverConnections.get': service.get,
    'serverConnections.delete': service.delete,
  });
}
