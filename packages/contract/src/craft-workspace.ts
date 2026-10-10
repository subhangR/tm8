/**
 * Craft workspaces (Craft redesign doc 01a1255d §3 "Persistence", §4).
 *
 * A craft is shared by the space; the TABS a person has open on it are theirs.
 * Each (space, identity, craft) has at most one craft workspace: a row of
 * `public.workspaces` scoped to the craft entity (migration 321). It is
 * hidden — never in the Home workspace switcher, never counted against its
 * cap of 20, never the active Home workspace — and private by the same
 * identity-equality rule as every other workspace.
 *
 * Its state is a plain ordered tab list. The first tab is always the craft's
 * own overview: pinned, never closed, never moved. Closing a tab never removes
 * a page from the craft; pages are the craft's shared membership and tabs are
 * the person's open subset: a tab whose page has left the craft (its
 * `contains` edge removed, the entity deleted or unreadable) is dropped on the
 * next read or write. A nested craft is one tab showing its own overview; its
 * pages are not tabs of the parent.
 *
 * The same rows are the person's OPEN-CRAFTS list (the Craft top bar): `open`
 * says whether the craft is in it, `position` orders it. Closing a craft keeps
 * its tabs for the next time it is opened.
 *
 * Who may command a craft workspace (§4): the person themself, or a chat or
 * session that person started ON that craft. An agent token carries its
 * starter's identity, so the row is always the starter's own; the craft check
 * is that the chat is `about` the craft, or the work session has an `about`
 * edge to it, or is a child of a chat about it. Any other agent is refused
 * (`forbidden`, reason `not_craft_session`).
 */
import { z } from 'zod';

/**
 * The craft kind. `design` is its old name: accepted as INPUT until
 * 2027-01-08 (doc §1); output always says `craft`.
 */
export const CRAFT_KIND = 'craft';
export const CRAFT_KIND_ALIASES = ['craft', 'design'] as const;

export function isCraftKind(kind: unknown): kind is (typeof CRAFT_KIND_ALIASES)[number] {
  return typeof kind === 'string' && (CRAFT_KIND_ALIASES as readonly string[]).includes(kind);
}

/** The kinds a craft workspace tab may hold: the kinds a craft page may be. */
export const CRAFT_TAB_KINDS = ['craft', 'graph', 'doc', 'artifact', 'drawing'] as const;
export type CraftTabKind = (typeof CRAFT_TAB_KINDS)[number];

/** A tab kind as sent, with the `design` alias folded into `craft`; null if it is not a tab kind. */
export function craftTabKind(kind: unknown): CraftTabKind | null {
  if (kind === 'design') return 'craft';
  return typeof kind === 'string' && (CRAFT_TAB_KINDS as readonly string[]).includes(kind) ? (kind as CraftTabKind) : null;
}

/** Tabs one craft workspace may hold, the overview included. */
export const CRAFT_WORKSPACE_TAB_CAP = 50;
/** Crafts one person may keep open in a space's Craft top bar. */
export const CRAFT_OPEN_CAP = 30;

export interface CraftTab {
  /** Stable UI id (uuid). The overview tab's id is the craft's own id. */
  id: string;
  kind: CraftTabKind;
  entityId: string;
  /** True only for the overview: first, never closed, never moved. */
  pinned: boolean;
}

export interface CraftWorkspaceState {
  /** In tab-bar order. `tabs[0]` is always the overview `{ id: craftId, kind: 'craft', entityId: craftId, pinned: true }`. */
  tabs: CraftTab[];
  /** The selected tab; the overview when nothing else is. */
  activeTabId: string;
}

/** One person's workspace for one craft. */
export interface CraftWorkspace {
  /** Null until the first write: the default (overview only, closed) is served. */
  workspaceId: string | null;
  craftId: string;
  /** Compare-and-swap revision; 0 before the first write. */
  revision: number;
  /** In the person's open-crafts list (the Craft top bar). */
  open: boolean;
  /** Order among the person's crafts in this space (dense from 0, open and closed alike). */
  position: number;
  state: CraftWorkspaceState;
  updatedAt: string | null;
  /** The last write an agent made, for the UI's "<name> changed your tabs". */
  lastAgentChange: { at: string; actorId: string | null } | null;
}

/** `workspace.crafts.list`: the person's craft workspaces in the space, in `position` order. */
export interface CraftWorkspaceListResult {
  /** Every craft workspace the person has, open or closed; the top bar shows the `open` ones in this order. */
  items: CraftWorkspace[];
  openCap: number;
}

/**
 * The commands, sent to ONE craft's workspace. Tab commands name a tab by
 * `tabId` or by the `entityId` it shows (agents know entity ids).
 *
 *   tabs.open      { kind, entityId, activate? = true, beforeTabId? }  reuses the entity's tab if open;
 *                  only the craft's own direct pages (`not_a_page` otherwise)
 *   tabs.close     { tabId } | { entityId }                            the overview: `pinned`
 *   tabs.move      ({ tabId } | { entityId }) & { beforeTabId: string | null }   null = last; never before the overview
 *   tabs.activate  { tabId } | { entityId }
 *   craft.open     { beforeCraftId?: string | null }                   into the top bar (null/absent = last)
 *   craft.close    {}                                                  out of the top bar; tabs are kept
 *   craft.move     { beforeCraftId: string | null }
 */
export const CRAFT_WORKSPACE_COMMANDS = [
  'tabs.open',
  'tabs.close',
  'tabs.move',
  'tabs.activate',
  'craft.open',
  'craft.close',
  'craft.move',
] as const;
export type CraftWorkspaceCommand = (typeof CRAFT_WORKSPACE_COMMANDS)[number];

export type CraftTabRef = { tabId: string; entityId?: never } | { entityId: string; tabId?: never };
export type CraftTabsOpenArgs = { kind: string; entityId: string; activate?: boolean; beforeTabId?: string | null };
export type CraftTabsMoveArgs = CraftTabRef & { beforeTabId: string | null };
export type CraftOpenArgs = { beforeCraftId?: string | null };
export type CraftMoveArgs = { beforeCraftId: string | null };

export interface CraftWorkspaceCommandArgsMap {
  'tabs.open': CraftTabsOpenArgs;
  'tabs.close': CraftTabRef;
  'tabs.move': CraftTabsMoveArgs;
  'tabs.activate': CraftTabRef;
  'craft.open': CraftOpenArgs | undefined;
  'craft.close': Record<string, never> | undefined;
  'craft.move': CraftMoveArgs;
}

/** `workspace.crafts.command` body; the space and the craft come from the path. */
export interface CraftWorkspaceCommandInput {
  /** Idempotency key: the same id and payload returns the recorded result. */
  requestId: string;
  command: CraftWorkspaceCommand;
  args?: unknown;
  /** Refuse with `revision_conflict` unless the workspace is at this revision. */
  expectedRevision?: number;
  clientMutationId?: string;
}

export type CraftWorkspaceResultReason =
  | 'invalid_arguments'
  | 'unsupported_kind'
  | 'entity_unavailable'
  /** tabs.open: the entity is neither the craft nor one of its direct pages. */
  | 'not_a_page'
  | 'tab_not_found'
  | 'pinned'
  | 'tab_limit'
  | 'open_limit'
  | 'craft_not_found'
  | 'revision_conflict';

export interface CraftWorkspaceCommandResult {
  requestId: string;
  status: 'applied' | 'no_op' | 'rejected' | 'conflict';
  reason?: CraftWorkspaceResultReason;
  /** tabs.*: the tab acted on. */
  tabId?: string;
  /** tabs.open: whether the tab was made or an open one reused. */
  outcome?: 'created' | 'reused';
  /** The workspace after the command (as it was, when nothing applied). */
  workspace: CraftWorkspace;
}

/** node → the person's own windows, after any commit to one of their craft workspaces. */
export interface CraftWorkspaceFrame {
  type: 'craft.workspace';
  spaceId: string;
  workspace: CraftWorkspace;
  cause?: { requestId: string; command: CraftWorkspaceCommand; actorClass: 'human' | 'agent'; actorName?: string };
}

/** node → the person's own windows, after `craft.open` / `craft.close` / `craft.move`: the whole list. */
export interface CraftWorkspacesFrame {
  type: 'craft.workspaces';
  spaceId: string;
  items: CraftWorkspace[];
}

const Id = z.string().uuid();
const RequestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const TabId = z.string().min(1).max(128);

export const CraftWorkspaceCommandInputSchema: z.ZodType<CraftWorkspaceCommandInput> = z
  .object({
    requestId: RequestId,
    command: z.enum(CRAFT_WORKSPACE_COMMANDS),
    args: z.unknown().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict();

const TabRef = z.union([z.object({ tabId: TabId }).strict(), z.object({ entityId: Id }).strict()]);

/** The args each command takes; the node checks them before it touches the row. */
export const CRAFT_WORKSPACE_ARG_SCHEMAS: { readonly [K in CraftWorkspaceCommand]: z.ZodType<unknown> } = {
  'tabs.open': z
    .object({ kind: z.string().min(1).max(64), entityId: Id, activate: z.boolean().optional(), beforeTabId: TabId.nullable().optional() })
    .strict(),
  'tabs.close': TabRef,
  'tabs.move': z.union([
    z.object({ tabId: TabId, beforeTabId: TabId.nullable() }).strict(),
    z.object({ entityId: Id, beforeTabId: TabId.nullable() }).strict(),
  ]),
  'tabs.activate': TabRef,
  'craft.open': z.object({ beforeCraftId: Id.nullable().optional() }).strict().optional(),
  'craft.close': z.object({}).strict().optional(),
  'craft.move': z.object({ beforeCraftId: Id.nullable() }).strict(),
};

/** A craft's default workspace state: the overview, alone and selected. */
export function defaultCraftWorkspaceState(craftId: string): CraftWorkspaceState {
  return { tabs: [{ id: craftId, kind: 'craft', entityId: craftId, pinned: true }], activeTabId: craftId };
}

/**
 * A stored state made sound for `craftId`: unknown kinds and duplicate tabs
 * dropped, the overview put back first, at most the tab cap, and a selection
 * that names a tab. A stored row is trusted shape-wise but re-sanitized, as
 * Home workspaces are: it may predate a change.
 */
export function sanitizeCraftWorkspaceState(raw: unknown, craftId: string): CraftWorkspaceState {
  const base = defaultCraftWorkspaceState(craftId);
  const tabs: CraftTab[] = [base.tabs[0]!];
  const seenIds = new Set([craftId]);
  const seenEntities = new Set([craftId]);
  const list = (raw as { tabs?: unknown } | null)?.tabs;
  if (Array.isArray(list)) {
    for (const t of list) {
      if (tabs.length >= CRAFT_WORKSPACE_TAB_CAP) break;
      if (typeof t !== 'object' || t === null) continue;
      const { id, kind, entityId } = t as Record<string, unknown>;
      const k = craftTabKind(kind);
      if (k === null || typeof id !== 'string' || typeof entityId !== 'string') continue;
      if (seenIds.has(id) || seenEntities.has(entityId)) continue;
      seenIds.add(id);
      seenEntities.add(entityId);
      tabs.push({ id, kind: k, entityId, pinned: false });
    }
  }
  const active = (raw as { activeTabId?: unknown } | null)?.activeTabId;
  return { tabs, activeTabId: typeof active === 'string' && seenIds.has(active) ? active : craftId };
}
