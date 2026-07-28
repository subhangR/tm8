import type { FacadeDeps } from '../../deps.js';
import { messagesList } from '../messages.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2MessagesHandoffsService,
  type W2MessagesHandoffsServiceOptions,
} from '../../services/w2/messages-handoffs.js';

/** W2.G04's complete, and only, semantic-catalog registration seam. */
export function registerW2MessagesHandoffsHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2MessagesHandoffsServiceOptions = {},
): void {
  const service = new W2MessagesHandoffsService(deps, options);
  registry.registerAll({
    'messages.list': messagesList(deps),
    'messages.post': service.post,
    'messages.edit': service.edit,
    'messages.delete': service.delete,
    'messages.attachments.add': service.attachmentsAdd,
    'messages.attachments.remove': service.attachmentsRemove,
    'messages.delivery.get': service.deliveryGet,
    'handoffs.send': service.handoffSend,
    'handoffs.list': service.handoffList,
    'handoffs.withdraw': service.handoffWithdraw,
  });
}

export type { W2MessagesHandoffsServiceOptions };
