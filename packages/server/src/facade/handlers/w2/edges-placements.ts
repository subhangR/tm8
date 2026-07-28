import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2EdgesPlacementsService } from '../../services/w2/edges-placements.js';
import { json } from '../../../http/types.js';

/** The integration worker's single registration seam for W2.G03. */
export function registerW2EdgesPlacementsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2EdgesPlacementsService(deps);
  registry.registerAll({
    'edges.list': service.listEdges,
    'edges.create': async (ctx) => json(await service.createEdge(ctx), { status: 201 }),
    'edges.patch': service.patchEdge,
    'edges.delete': service.deleteEdge,
    'edgeTypes.list': service.listEdgeTypes,
    'placements.apply': service.applyPlacement,
  });
}
