import { useLayoutEffect } from 'react';
import { useStore } from 'zustand';
import { embeddedTab, type EntityTabRecord, type WorkspaceRuntime } from '../tab-workspace/embed';

/** The private runtime's record for one entity, seeded after render. */
export function useEmbeddedTab(runtime: WorkspaceRuntime, entityId: string | null, kind: string | null): EntityTabRecord | null {
  const record = useStore(runtime.store, (s) => (entityId ? s.tabs[entityId] : undefined));
  useLayoutEffect(() => {
    if (entityId && kind) embeddedTab(runtime, entityId, kind);
  }, [runtime, entityId, kind]);
  return record?.type === 'entity' && record.kind === kind ? record : null;
}
