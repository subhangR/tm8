/**
 * Palette types — the item/mode vocabulary the overlay renders and the action
 * registry produces. Every palette row is a `PaletteItem` with a `run()`, so
 * the component stays dumb: keyboard activation and mouse click take the
 * IDENTICAL path (the parity law lives in this shape).
 */
import type { ReactNode } from 'react';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { NavState, ViewName } from '../../stores/nav';
import type {
  EntityId, EntityKind, EntitySummary, SpaceId, WorkStatus,
} from '../../types/contract';

/** Palette step machine. Every step is reachable and exitable by keyboard. */
export type PaletteMode =
  | { kind: 'root' }
  | { kind: 'goto' }
  /**
   * Title is typed into the palette input; Enter creates. Which kinds are
   * offered is registry data (`paletteCreatableKinds()`) — not a literal
   * union duplicated here (DEF-10).
   */
  | { kind: 'create'; entityKind: EntityKind; parentId?: EntityId | null }
  /** Step 1 of link A→B: pick B. */
  | { kind: 'link-target'; sourceId: EntityId }
  /** Step 2 of link A→B: pick the edge type. */
  | { kind: 'link-type'; sourceId: EntityId; targetId: EntityId }
  | { kind: 'status'; targetId: EntityId };

export type PaletteGroup = 'action' | 'entity' | 'choice';

export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned meta (kind label, shortcut hint, edge direction…). */
  hint?: string;
  group: PaletteGroup;
  /** Section heading this row sorts under. */
  section: string;
  /** Rendered as an EntityChip inside the row when present. */
  entity?: EntitySummary;
  /** Leading glyph for non-entity rows. */
  glyph?: ReactNode;
  /** Extra needle text matched against the query (kind names, aliases). */
  keywords?: string;
  /** The one execution path — click and Enter both call this. */
  run: () => void | Promise<void>;
}

/** What actually happened, surfaced to hosts (tests, toasts, telemetry). */
export interface PaletteExecution {
  /** Item id that ran. */
  itemId: string;
  /** Coarse category for assertions/telemetry. */
  category: 'navigate' | 'create' | 'link' | 'pull' | 'status' | 'open' | 'panel' | 'read' | 'step';
  entityId?: EntityId;
  detail?: Record<string, unknown>;
}

/** Nav actions the palette drives (injectable so tests can spy). */
export interface PaletteNav {
  setView: NavState['setView'];
  pushPanel: NavState['pushPanel'];
  pinPanel: NavState['pinPanel'];
  promotePanel: NavState['promotePanel'];
  closePalette: NavState['closePalette'];
}

export interface PaletteNotice {
  kind: 'info' | 'error' | 'success';
  message: string;
}

/** Everything the action registry needs. Pure data in, `run()`s out. */
export interface PaletteDeps {
  facade: CollabFacade;
  spaceId: SpaceId | null;
  nav: PaletteNav;
  contextEntity: EntitySummary | null;
  /** Entities the palette knows about (recent + graph store + props). */
  known: EntitySummary[];
  setMode: (mode: PaletteMode) => void;
  /** Clears the query; used when a step change should start a fresh filter. */
  resetQuery: () => void;
  close: () => void;
  notify: (notice: PaletteNotice) => void;
  onExecuted?: (execution: PaletteExecution) => void;
  /** Current query text — create/link-type steps read it as a value. */
  query: string;
}

export interface ViewChoice { view: ViewName; label: string; keywords?: string }

export interface EdgeTypeChoice {
  type: string;
  label: string;
  /** Human phrasing shown as the row hint, e.g. "task → member". */
  hint: string;
}

export interface StatusChoice { status: WorkStatus; label: string }
