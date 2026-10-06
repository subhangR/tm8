/**
 * Workspace runtime types — the single source of names (Spec B §2–§4).
 *
 * Every Workspace worker codes against these. Additions beyond Spec B are
 * marked ADDITIVE and never change the meaning of a Spec B field.
 */

/** A CoreEntityKind restricted to the D7 allow-list (`WORKSPACE_KINDS`). */
export type KindId = string;
/** Stable UI id (uuid), never the entity id. */
export type TabId = string;

/**
 * The D7 allow-list: the kinds the Workspace browser offers and a tab may
 * hold. The space may support fewer; the browser filters at render time.
 */
export const WORKSPACE_KINDS = [
  'task',
  'team_member',
  'work_session',
  'chat',
  'doc',
  'artifact',
  'drawing',
  'collection',
  'story',
  'form',
  'file',
  'pull_request',
  'project',
  'skill',
  'channel',
] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export function isWorkspaceKind(kind: unknown): kind is WorkspaceKind {
  return typeof kind === 'string' && (WORKSPACE_KINDS as readonly string[]).includes(kind);
}

export type TabScope =
  | { mode: 'mixed'; lastByTypeIds: KindId[] }
  | { mode: 'byType'; selectedTypeIds: KindId[] }; // nonempty, unique, sorted

export type TabSubview = 'entity' | 'connections' | 'messages';
export const TAB_SUBVIEWS: readonly TabSubview[] = ['entity', 'connections', 'messages'];

export interface TrailCrumb {
  entityId: string;
  kind: KindId;
  title: string;
}

/** Captured on deactivate, restored on activate. */
export type TabUi = {
  subview: TabSubview;
  scrollTop?: number;
  trail?: TrailCrumb[];
  chat?: { open: boolean; width?: number; threadId?: string | 'new' };
};

export type EntityTabRecord = { id: TabId; type: 'entity'; kind: KindId; entityId: string; ui: TabUi };
export type DraftTabRecord = {
  id: TabId;
  type: 'draft';
  kind: KindId;
  draftId: string;
  dirty: boolean;
  submitting: boolean;
  /** 1 reads "New task", 2 reads "New task 2". */
  ordinal: number;
};
export type ChooserTabRecord = { id: TabId; type: 'chooser'; query: string };
export type TabRecord = EntityTabRecord | DraftTabRecord | ChooserTabRecord;

export interface BrowserKindState {
  query: string;
  filters: unknown;
  scrollTop: number;
}

export type BrowserState = {
  kind: KindId;
  perKind: Record<KindId, BrowserKindState>;
};

export type InteractionChoice = 'addType' | 'useMixed' | 'cancel' | 'discard' | 'keep';
export type InteractionReason = 'scope_choice_required' | 'unsaved_changes';

export type PendingInteraction = {
  id: string;
  reason: InteractionReason;
  /** The original request, replayed once on resolve. */
  command: CommandEnvelope;
  choices: InteractionChoice[];
  targetKind?: KindId;
  /** unsaved_changes: the DIRTY tabs the prompt lists. */
  tabIds?: TabId[];
  revisionAtRequest: number;
  /**
   * ADDITIVE. unsaved_changes: every tab the close would remove (the dirty
   * ones plus, for closeVisible, the clean ones captured with them).
   */
  closeTabIds?: TabId[];
  /**
   * ADDITIVE. unsaved_changes: each listed draft's value revision
   * (`draftStore.revisionOf`) at prompt time. A newer keystroke cancels the
   * discard for that tab (§5.6 step 5).
   */
  draftRevisions?: Record<TabId, number>;
};

export type Presentation = { surface: 'start' } | { surface: 'tab'; tabId: TabId };

export interface WorkspaceLayout {
  expanded: boolean;
  browserWidth: number;
  chatWidth: number;
}

export type WorkspaceState = {
  revision: number;
  spaceId: string;
  viewerId: string;
  windowId: string;
  orderedTabIds: TabId[];
  tabs: Record<TabId, TabRecord>;
  presentation: Presentation;
  scope: TabScope;
  /** Most recent first. */
  recency: TabId[];
  rememberedActive: Record<string /* scopeKey */, TabId>;
  layout: WorkspaceLayout;
  browsers: { main: BrowserState };
  /** At most one blocking interaction. */
  pending?: PendingInteraction;
};

export const LAYOUT_BOUNDS = {
  browserWidth: { min: 280, max: 480, initial: 320 },
  chatWidth: { min: 320, max: 640, initial: 380 },
} as const;

// ---------------------------------------------------------------------------
// Commands (§3, §4)
// ---------------------------------------------------------------------------

export type Source = 'click' | 'keyboard' | 'palette' | 'deeplink' | 'restore' | 'history' | 'system';
export const LOCAL_SOURCES: readonly Source[] = [
  'click',
  'keyboard',
  'palette',
  'deeplink',
  'restore',
  'history',
  'system',
];
/** Sources a person is directly behind — the only ones that may resolve or discard. */
export const UI_SOURCES: readonly Source[] = ['click', 'keyboard'];

export const COMMAND_NAMES = [
  'workspace.inspect',
  'workspace.browser.set',
  'workspace.tabScope.set',
  'workspace.tabs.open',
  'workspace.tabs.activate',
  'workspace.tabs.close',
  'workspace.tabs.closeVisible',
  'workspace.tabs.move',
  'workspace.tabs.setUi',
  'workspace.drafts.open',
  'workspace.drafts.markDirty',
  'workspace.drafts.bind',
  'workspace.chooser.open',
  'workspace.layout.set',
  'workspace.interactions.resolve',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export type InspectArgs = Record<string, never> | undefined;
export type BrowserSetArgs = {
  browserId: 'main';
  kind?: KindId;
  query?: string;
  filters?: unknown;
  scrollTop?: number;
};
export type TabScopeSetArgs = { mode: 'mixed' } | { mode: 'byType'; selectedTypeIds?: KindId[] };
export type TabsOpenArgs = {
  kind: KindId;
  entityId: string;
  /** Default true. */
  activate?: boolean;
  trail?: TrailCrumb[];
  subview?: TabSubview;
};
export type TabsActivateArgs = { tabId: TabId };
export type TabsCloseArgs = { tabId: TabId; discard?: boolean };
export type TabsCloseVisibleArgs = { except?: TabId };
export type TabsMoveArgs = { tabId: TabId; beforeTabId?: TabId };
export type TabsSetUiArgs = { tabId: TabId; patch: Partial<TabUi> };
export type DraftsOpenArgs = { kind: KindId };
/**
 * ADDITIVE `submitting`: §5.5 has the draft host set `submitting`, and
 * dispatch is the only writer, so the flag rides on this command.
 */
export type DraftsMarkDirtyArgs = { tabId: TabId; dirty?: boolean; submitting?: boolean };
/**
 * ADDITIVE `kind` / `title`: used only when the draft tab was closed before
 * the create finished, for the "Created <title>" toast and its Open action.
 */
export type DraftsBindArgs = { tabId: TabId; entityId: string; kind?: KindId; title?: string };
export type ChooserOpenArgs = Record<string, never> | undefined;
export type LayoutSetArgs = { expanded?: boolean; browserWidth?: number; chatWidth?: number };
export type InteractionsResolveArgs = { interactionId: string; choice: InteractionChoice };

export interface CommandArgsMap {
  'workspace.inspect': InspectArgs;
  'workspace.browser.set': BrowserSetArgs;
  'workspace.tabScope.set': TabScopeSetArgs;
  'workspace.tabs.open': TabsOpenArgs;
  'workspace.tabs.activate': TabsActivateArgs;
  'workspace.tabs.close': TabsCloseArgs;
  'workspace.tabs.closeVisible': TabsCloseVisibleArgs;
  'workspace.tabs.move': TabsMoveArgs;
  'workspace.tabs.setUi': TabsSetUiArgs;
  'workspace.drafts.open': DraftsOpenArgs;
  'workspace.drafts.markDirty': DraftsMarkDirtyArgs;
  'workspace.drafts.bind': DraftsBindArgs;
  'workspace.chooser.open': ChooserOpenArgs;
  'workspace.layout.set': LayoutSetArgs;
  'workspace.interactions.resolve': InteractionsResolveArgs;
}

export type CommandEnvelope = {
  command: CommandName;
  args: unknown;
  source: Source;
  expectedRevision?: number;
};

/** A typed envelope, for callers that want the args checked at compile time. */
export type TypedCommand<N extends CommandName = CommandName> = {
  [K in N]: { command: K; args: CommandArgsMap[K]; source: Source; expectedRevision?: number };
}[N];

export type ResultStatus = 'applied' | 'no_op' | 'requires_user_choice' | 'rejected' | 'conflict';
export type ResultReason =
  | 'invalid_arguments'
  | 'unsupported_kind'
  | 'permission_denied'
  | 'scope_choice_required'
  | 'unsaved_changes'
  | 'revision_conflict'
  | 'entity_unavailable'
  | 'busy';

export type Result = {
  status: ResultStatus;
  revision: number;
  tabId?: TabId;
  outcome?: 'created' | 'reused' | 'focused';
  reason?: ResultReason;
  pendingInteractionId?: string;
  choices?: PendingInteraction['choices'];
  /** ADDITIVE: present only on `workspace.inspect`. */
  inspection?: WorkspaceInspection;
};

/** The `workspace.inspect` row (§4): no draft or chat content. */
export interface WorkspaceInspection {
  revision: number;
  presentation: Presentation;
  visibleTabIds: TabId[];
  orderedTabIds: {
    id: TabId;
    type: TabRecord['type'];
    kind?: KindId;
    entityId?: string;
    dirty?: boolean;
  }[];
  scope: TabScope;
  browserKind: KindId;
  layout: WorkspaceLayout;
  pending?: { id: string; reason: InteractionReason; choices: InteractionChoice[]; targetKind?: KindId; tabIds?: TabId[] };
}

// ---------------------------------------------------------------------------
// Runtime seams: hooks (things outside the store) and effects (after commit)
// ---------------------------------------------------------------------------

export interface WorkspaceToast {
  text: string;
  action?: { label: string; run: () => void };
}

/**
 * Things the dispatcher needs from outside the store. Injected per runtime
 * (`runtime.setHooks`); every member has a safe default.
 */
export interface WorkspaceHooks {
  /** Delete a draft's stored values (bind, discard). */
  deleteDraft(draftId: string): void;
  /** Monotonic value revision of a draft (bumped on every stored write). */
  draftRevision(draftId: string): number;
  /** Non-blocking toast ("Created <title>", soft cap). */
  toast(toast: WorkspaceToast): void;
  /** The mounted adapter's live ui (scroll etc.) for a tab being deactivated. */
  captureUi(tabId: TabId): Partial<TabUi> | undefined;
  /** Whether a kind may start a draft (adapter registry `creatable === true`). */
  canCreate(kind: KindId): boolean;
  /** New uuid. */
  newId(): string;
  /** Open an entity as a tab on a person's behalf (the toast's Open action). */
  openEntity(kind: KindId, entityId: string): void;
}

export interface EffectEvent {
  env: CommandEnvelope;
  result: Result;
  prev: WorkspaceState;
  next: WorkspaceState;
  /** True when the commit bumped `revision` (false for scroll-only commits). */
  significant: boolean;
  viewerId: string;
  spaceId: string;
}
export type WorkspaceEffect = (event: EffectEvent) => void;
