import { createLoopbackOwnerResolver } from '../../../identity/loopback.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { createMapsService } from '../../services/w2/maps.js';
import { requireHumanSession } from './credentials.js';

export function registerMapsHandlers(registry: HandlerRegistry, deps: Pick<FacadeDeps,'db'|'config'> & { owner?: FacadeDeps['owner'] }): void {
  const service = createMapsService({ ...deps, owner: deps.owner ?? createLoopbackOwnerResolver(deps.db) });
  registry.registerAll({
    'maps.open': service.open,
    'maps.context': service.context,
    'maps.place': ctx => service.write(ctx, 'place'),
    'maps.move': ctx => service.write(ctx, 'move'),
    'maps.remove': ctx => service.write(ctx, 'remove'),
    'maps.paint': ctx => service.write(ctx, 'paint'),
    'maps.undo': ctx => service.write(ctx, 'undo'),
    'maps.revert': ctx => service.write(ctx, 'revert'),
    'maps.activity.append': ctx => service.write(ctx, 'activity.append'),
    'maps.activity.list': service.activityList,
    'maps.navigation.get': requireHumanSession(service.navigationGet),
    'maps.navigation.save': requireHumanSession(service.navigationSave),
  });
}
