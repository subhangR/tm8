import type { EntityDetail } from '@tm8/contract';
import type { WorkspaceEffect } from '../tab-workspace/runtime/types';

/** Close live keep-open shells only when their last tab was explicitly closed. */
export function toolTabCloseEffect({ detailOf, terminate, onError }: { detailOf(id: string): EntityDetail | null | undefined; terminate(id: string): Promise<unknown>; onError(error: unknown): void }): WorkspaceEffect {
  return ({ env, prev, next }) => {
    if (!['click', 'keyboard', 'palette'].includes(env.source)) return;
    const removed = Object.values(prev.tabs).filter(tab => tab.type === 'entity' && !next.tabs[tab.id]);
    const handled = new Set<string>();
    for (const tab of removed) {
      if (tab.type !== 'entity' || handled.has(tab.entityId)) continue;
      handled.add(tab.entityId);
      if (Object.values(next.tabs).some(remaining => remaining.type === 'entity' && remaining.entityId === tab.entityId)) continue;
      const detail = detailOf(tab.entityId);
      const state = detail?.state;
      if (!state || !('toolRun' in state) || !state.toolRun?.keepOpen || !('status' in state) || !['running', 'spawning'].includes(state.status)) continue;
      void terminate(tab.entityId).catch(onError);
    }
  };
}
