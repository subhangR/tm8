/**
 * Shell contracts — the seams later waves plug into.
 *
 * The shell owns layout and navigation only. It knows nothing about entity
 * kinds: center views arrive through a `ViewRegistry` (W3 screens) and panel
 * bodies through a `PanelSlot` (W1a EntityPanel, wired by Atlas).
 */
import type { ReactNode } from 'react';
import type { CollabFacade } from '../facade/CollabFacade';
import type { PanelTab, ViewName } from '../stores/nav';
import type { EntityId, SpaceId } from '../types/contract';

/** Props every center view receives. Screens (L5) implement this signature. */
export interface ShellViewProps {
  facade: CollabFacade;
  spaceId: SpaceId;
  view: ViewName;
  /** Set for the `entity` / `channel` routes (the Z4 full view). */
  entityId: EntityId | null;
  /** Open an entity as a Z3 panel (peek, or stack when a panel is already open). */
  onOpenEntity: (entityId: EntityId, opts?: { replace?: boolean }) => void;
  /** Navigate the center view (a primary view, or an entity Z4 route). */
  onNavigate: (view: ViewName, entityId?: EntityId | null) => void;
}

/** W3 plugs screens in here; anything missing falls back to a placeholder. */
export type ViewComponent = (props: ShellViewProps) => ReactNode;
export type ViewRegistry = Partial<Record<ViewName, ViewComponent>>;

/**
 * Props a panel body receives. The shell renders the Z3 frame (breadcrumb +
 * pin/promote/close chrome); the slot renders everything below it.
 */
export interface PanelSlotProps {
  entityId: EntityId;
  /** Active panel tab, when the URL/stack carries one. */
  tab: PanelTab | undefined;
  /** `stacked` = the peeking Z3 stack; `pinned` = a docked persistent split. */
  mode: 'stacked' | 'pinned';
  /** 0-based position in the stack (pinned panels report their split index). */
  depth: number;
  facade: CollabFacade;
  /** Chip clicked *inside* this panel → stacks another panel on top. */
  onOpenEntity: (entityId: EntityId, opts?: { replace?: boolean }) => void;
  onClose: () => void;
  /** 📌 dock as a persistent split. Returns false when the split cap is hit. */
  onPin: () => boolean;
  onUnpin: () => void;
  /** ⤢ promote to the Z4 route; the current center view becomes the back target. */
  onPromote: () => void;
  onTabChange: (tab: PanelTab) => void;
  /** False when `MAX_PINNED` splits are already docked. */
  canPin: boolean;
  isPinned: boolean;
}

export type PanelSlot = (props: PanelSlotProps) => ReactNode;

/** Left-rail section — conceptually a saved collection view pointed at a kind. */
export interface RailSection {
  view: ViewName;
  label: string;
  icon: string;
  /** Rendered right-aligned in mono; omit/0 renders nothing. */
  badge?: number | null;
}
