import type { ActionRef } from '../domain';
import { navStore } from '../stores/navStore';

/**
 * THE PROJECT BIRTH VERB'S EXECUTOR. `new-project` opens a page, not a sheet
 * (owner ruling 2026-10-02), so there is no modal state to own — the route is
 * the state, and Back closes it. A constant, like every list dispatcher's
 * `wiredActions`, so `rootBirthDispatch` and the list header agree.
 */
export const NEW_PROJECT_ACTIONS: readonly ActionRef[] = ['new-project'];

export const newProjectPage = {
  onAction: (ref: ActionRef) => {
    if (ref === 'new-project') navStore.getState().navigate({ view: 'newProject' });
  },
  wiredActions: NEW_PROJECT_ACTIONS,
} as const;
