/**
 * The one RegistryCtx instance — entity components injected into registry
 * renderers. This is how kind renderers compose chips/cards without the
 * registry importing entity/ (keeps the dependency graph acyclic at module
 * top-level; the components here are hoisted function declarations, so the
 * import cycle entity → ctx → entity is initialization-safe).
 */
import type { RegistryCtx } from '../registry';
import { EntityCard } from './EntityCard';
import { EntityChip } from './EntityChip';
import { CardById, ChipById } from './EntityById';

export const REGISTRY_CTX: RegistryCtx = {
  Chip: EntityChip,
  Card: EntityCard,
  ChipById,
  CardById,
};
