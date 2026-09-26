import { json } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { AttentionService } from './attention-service.js';

export { AttentionService, sourceSessionOf } from './attention-service.js';
export {
  ATTENTION_DELIVERY_JOB_NAME,
  createAttentionDeliveryJob,
  runAttentionDeliveryTick,
  type AttentionDeliveryJobOptions,
} from './delivery-sweep.js';

/**
 * Attention v2 (spec chapter 5): every `attentionRequests.*` operation is
 * registered here and nowhere else. They used to live on the W2 G02 seam
 * (`services/w2/entities-commands-tracking.ts`).
 */
export function registerAttentionHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const service = new AttentionService(deps);
  registry.registerAll({
    'attentionRequests.list': service.list,
    'attentionRequests.create': async (ctx) => json(await service.create(ctx), { status: 201 }),
    'attentionRequests.update': service.update,
    'attentionRequests.resolveEntity': service.resolveEntity,
    'attentionRequests.markSeen': service.markSeen,
    'attentionRequests.unresolve': service.unresolve,
    'attentionRequests.withdraw': service.withdraw,
  });
}
