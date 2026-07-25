/**
 * KindRegistry contract — THE LAW of Layer 1: every per-kind variation in the
 * entity component system is DATA in a `KindEntry`. Components (`entity/`)
 * look up `registryFor(kind)` and render from the entry; an
 * `if (kind === …)` anywhere outside `registry/` is a defect. Adding a kind
 * to the product must equal adding one entry here.
 *
 * Renderers that need React (`SummaryFields`, `Content`) are components so
 * they may use hooks; everything else is plain data or pure functions.
 * Renderers receive a `RegistryCtx` with the entity components injected —
 * the registry never imports from `entity/` (no module cycle).
 */
import type { ComponentType, ReactNode } from 'react';
import type { PillTone } from '../kit';
import type { CollabFacade } from '../facade';
import type {
  CommandResult, EntityDetail, EntityId, EntityKind, EntitySummary, SpaceId,
} from '../types/contract';

/** Z4 layout variant keys (EntityFullView picks its skeleton from this). */
export type FullLayoutVariant = 'reader' | 'hub' | 'subtree' | 'profile' | 'generic';

/**
 * Entity components injected into registry renderers, so kind renderers can
 * compose chips/cards without the registry importing entity/ (cycle-free).
 */
export interface RegistryCtx {
  Chip: ComponentType<{ entity: EntitySummary; variant?: 'chip' | 'ref'; draggable?: boolean; interactive?: boolean }>;
  Card: ComponentType<{ entity: EntitySummary }>;
  /** Chip resolved by id via the facade/graph cache (embeds, mentions). */
  ChipById: ComponentType<{ entityId: EntityId }>;
  /** Card resolved by id via the facade/graph cache (message embeds). */
  CardById: ComponentType<{ entityId: EntityId }>;
}

export interface RegistryStatusOption { value: string; label: string; disabled?: boolean; hint?: string }

/**
 * Header status control, as data: `current` feeds the pill on every surface;
 * kinds with a mutable status also provide `options` + `set`.
 */
export interface RegistryStatus {
  current: (s: EntitySummary) => { label: string; tone: PillTone; pulse?: boolean } | null;
  options?: (d: EntityDetail) => RegistryStatusOption[];
  set?: (facade: CollabFacade, d: EntityDetail, value: string) => Promise<unknown>;
}

export interface ActionDeps {
  facade: CollabFacade;
  detail: EntityDetail;
  /** Navigation affordances the action may use (promote to Z4). */
  nav: { promote: (id: EntityId) => void };
}

export interface PrimaryAction {
  id: string;
  label: string;
  title?: string;
  run: (deps: ActionDeps) => unknown;
}

/**
 * Per-kind behavior capabilities, as data. Consumers ask the registry instead
 * of branching on `kind` — `registryFor(kind).capabilities.x`, or the
 * `kindCan(kind, flag)` / `kindsWhere(flag)` helpers for boolean flags.
 */
export interface KindCapabilities {
  /**
   * The kind's state carries a mutable `WorkStatus` (and axes). Status boards
   * may drag its cards across workStatus/axis columns; kinds without it render
   * read-only cells (DEF-7/DEF-8). Today: task only.
   */
  workStatusBearing: boolean;
  /**
   * Users may re-parent instances by dragging in tree layouts (`moveEntity`)
   * (DEF-9 gating). False for messages (replies live in the thread), members
   * (invite-managed), agents (owner-managed), and PRs/commits (GitHub-tracked).
   */
  treeReparentable: boolean;
  /**
   * `markRead()` is meaningful — the kind anchors an unread scope, so
   * mark-read affordances (palette row, hub button) apply (DEF-11).
   */
  markReadAnchor: boolean;
  /**
   * Presence/actor semantics: this kind acts in threads and presence.
   * 'human' = member, 'agent' = team_member, null = not an actor kind.
   */
  actor: 'human' | 'agent' | null;
}

/** The boolean-valued capability flags (what `kindsWhere`/`kindCan` accept). */
export type BooleanCapability = {
  [K in keyof KindCapabilities]: KindCapabilities[K] extends boolean ? K : never
}[keyof KindCapabilities];

/**
 * Input for `KindEntry.createVia` — the kind-agnostic create call shape.
 * `content` carries values collected by the kind's `CreationSchema` fields.
 */
export interface KindCreateInput {
  spaceId: SpaceId;
  title: string;
  attachTo?: { entityId: EntityId; edgeType: 'attached_to' | 'relates_to' };
  content?: Record<string, unknown>;
}

export type CreationFieldType = 'text' | 'textarea' | 'select' | 'number' | 'date';
export interface CreationField {
  name: string;
  label: string;
  type: CreationFieldType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
}
/** Declarative creation form; `null` = kind is not user-creatable (with why). */
export interface CreationSchema { titleLabel: string; fields: CreationField[] }

export interface RendererProps<T> { entity: T; ctx: RegistryCtx }

export interface KindEntry {
  kind: EntityKind;
  /** Singular human label ('Task') — also the mono eyebrow on cards. */
  label: string;
  labelPlural: string;
  /** Registry-owned icon glyph (no icon-font dependency at L1). */
  glyph: string;
  /** State tint (CSS color expression) for the Z1 icon / accents. */
  tint: (s: EntitySummary) => string;
  /** Z1 chip text. */
  chipLabel: (s: EntitySummary) => string;
  /** Optional mono meta suffix on the chip (doc version, PR state, sha). */
  chipMeta: (s: EntitySummary) => string | null;
  /** Live pulse on the chip (agents at work, working tasks). */
  chipPulse: (s: EntitySummary) => boolean;
  /** Z2: the 2–4 kind-specific summary field rows. */
  SummaryFields: ComponentType<{ entity: EntitySummary; ctx: RegistryCtx }>;
  /** Z3: the Content tab body. */
  Content: ComponentType<{ detail: EntityDetail; ctx: RegistryCtx }>;
  /** Z4 layout variant key. */
  fullLayout: FullLayoutVariant;
  /** Header status control (pill everywhere; select where mutable). */
  status: RegistryStatus;
  /** Inline title edit commit; null = title not editable for this kind. */
  patchTitle: ((facade: CollabFacade, d: EntityDetail, title: string) => Promise<unknown>) | null;
  /** Kind-specific primary actions for the Z3 action bar. */
  primaryActions: (d: EntityDetail) => PrimaryAction[];
  /** Declarative creation form schema; null = not user-creatable. */
  creation: CreationSchema | null;
  /** Why creation is unavailable (shown by creation UIs) when creation=null. */
  creationDisabledReason?: string;
  /** Behavior capabilities as data (board drag, tree reparent, mark-read, actor). */
  capabilities: KindCapabilities;
  /**
   * Canonical create dispatch for this kind — creation UIs call
   * `entry.createVia(facade, input)` instead of branching per kind (DEF-10).
   * Always the generic `createEntity` seam (DEV-1). Non-null iff `creation`
   * is non-null.
   */
  createVia: ((facade: CollabFacade, input: KindCreateInput) => Promise<CommandResult>) | null;
  /**
   * Command-palette quick-create row descriptor; null = no palette root row
   * (kind may still be creatable via its full `creation` form — e.g. agents
   * and PRs have required fields a title-only quick create can't satisfy).
   */
  paletteCreate: { keywords: string } | null;
  /**
   * Teaching copy for an empty collection scoped to this kind
   * (EmptyState). null = use the generic fallback line.
   */
  collectionEmptyHint: string | null;
}

/** Tombstone presentation contract (deleted entities keep history shape). */
export interface TombstoneSpec {
  glyph: string;
  /** e.g. 'deleted task' */
  label: (kind: EntityKind) => string;
}

export function assertNever(x: never): never {
  throw new Error(`unreachable kind: ${String(x)}`);
}

export type { PillTone, ReactNode };
