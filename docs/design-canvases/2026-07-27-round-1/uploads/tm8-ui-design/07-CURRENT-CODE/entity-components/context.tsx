/**
 * Facade context for the entity component system. Whatever mounts collab-v2
 * (app shell, gallery, tests) provides ONE `CollabFacade`; entity components
 * reach it via `useFacade()` — never a module-level singleton, so mock and
 * real backends swap without component changes.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { CollabFacade } from '../facade';

const FacadeContext = createContext<CollabFacade | null>(null);

export function CollabFacadeProvider({ facade, children }: { facade: CollabFacade; children: ReactNode }) {
  return <FacadeContext.Provider value={facade}>{children}</FacadeContext.Provider>;
}

export function useFacade(): CollabFacade {
  const facade = useContext(FacadeContext);
  if (!facade) throw new Error('useFacade must be used inside <CollabFacadeProvider>');
  return facade;
}
