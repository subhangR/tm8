import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import {
  commandsComplete,
  commandsGate,
  commandsWork,
  entitiesPointsAdd,
} from '../commands.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2EntitiesCommandsTrackingService } from '../../services/w2/entities-commands-tracking.js';
import { W2TrackingWriteService } from '../../services/w2/tracking-write.js';

/** The integration worker's single registration seam for W2.G02. */
export function registerW2EntitiesCommandsTrackingHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2EntitiesCommandsTrackingService(deps);
  registry.registerAll({
    'entities.get': service.getEntity,
    'entities.create': async (ctx) => json(await service.createEntity(ctx), { status: 201 }),
    'entities.patch': service.patchEntity,
    'attentionRequests.list': service.listAttentionRequests,
    'attentionRequests.create': async (ctx) => json(await service.createAttentionRequest(ctx), { status: 201 }),
    'attentionRequests.update': service.updateAttentionRequest,
    'attentionRequests.resolveEntity': service.resolveEntityAttention,
    'entities.move': service.moveEntity,
    'entities.delete': service.deleteEntity,
    'entities.restore': service.restoreEntity,
    'entities.children': service.listChildren,
    'entities.hierarchy': service.getHierarchy,
    'entities.connections': service.listConnections,
    'entities.versions': service.listVersions,
    'entities.activity': service.listActivity,
    'entities.react': service.react,
    'entities.points.add': entitiesPointsAdd(deps),
    'entities.commands.complete': commandsComplete(deps),
    'entities.commands.work': commandsWork(deps),
    'entities.commands.gate': commandsGate(deps),
    'entities.commands.pull': service.pull,
    'entities.commands.linkPr': service.linkPr,
    'entities.commands.linkCommit': service.linkCommit,
    'tracking.refresh': async (ctx) => json(await service.refreshTracking(ctx), { status: 202 }),
    // The forge write door — guards + member credential live in the service.
    'tracking.pr.merge': new W2TrackingWriteService(deps).mergePr,
  });
}
