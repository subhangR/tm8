/**
 * Presence store — viewers/typing/working per entity, fed by presence.changed
 * and typing.changed events from the facade's client-synthesized
 * `subscribePresence` channel (DEV-4) — never from the durable stream.
 */
import { create } from 'zustand';
import type { EntityId, PresenceSnapshot, WorkspaceEvent } from '../types/contract';

export interface PresenceState {
  byEntity: Record<EntityId, PresenceSnapshot>;
  typingByAnchor: Record<EntityId, EntityId[]>;

  setSnapshot: (entityId: EntityId, snapshot: PresenceSnapshot) => void;
  applyEvent: (event: WorkspaceEvent) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  byEntity: {},
  typingByAnchor: {},

  setSnapshot: (entityId, snapshot) => set((s) => ({
    byEntity: { ...s.byEntity, [entityId]: snapshot },
    typingByAnchor: { ...s.typingByAnchor, [entityId]: snapshot.typingActorIds },
  })),

  applyEvent: (event) => set((s) => {
    if (event.type === 'presence.changed') {
      return {
        byEntity: { ...s.byEntity, [event.entityId]: event.presence },
        typingByAnchor: { ...s.typingByAnchor, [event.entityId]: event.presence.typingActorIds },
      };
    }
    if (event.type === 'typing.changed') {
      return { typingByAnchor: { ...s.typingByAnchor, [event.anchorId]: event.typingActorIds } };
    }
    return {};
  }),

  reset: () => set({ byEntity: {}, typingByAnchor: {} }),
}));

// --- narrow selectors -----------------------------------------------------------
export const selectPresence = (id: EntityId) => (s: PresenceState): PresenceSnapshot | undefined => s.byEntity[id];
export const selectTyping = (anchorId: EntityId) => (s: PresenceState): EntityId[] => s.typingByAnchor[anchorId] ?? [];
