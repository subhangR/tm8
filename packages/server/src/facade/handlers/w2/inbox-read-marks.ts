import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { W2InboxReadMarksService } from '../../services/w2/inbox-read-marks.js';

/**
 * The G08 registration seam. The wave integrator owns the shared facade call
 * site and schema binding; this module owns only the three frozen operations.
 */
export function registerW2InboxReadMarksHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
): void {
  const service = new W2InboxReadMarksService(deps);
  registry.registerAll({
    'inbox.list': service.list,
    'inbox.markRead': service.markNotificationRead,
    'readMarks.upsert': service.upsertReadMark,
  });
}
