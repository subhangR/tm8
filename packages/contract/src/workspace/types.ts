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
  /**
   * ADDITIVE (Spec B §8 "Unknown kinds"): set by persistence when a restored
   * By type selection lost every kind. The scope is held at Mixed while it is
   * set and a banner asks the person to pick kinds or keep Mixed; any
   * `tabScope.set` commit clears it. Never set by a command.
   */
  scopeRepair?: { droppedKinds: KindId[] };
  /**
   * ADDITIVE (Spec D §1). The Workspace icon rail's preferences, per space:
   * pinned kinds (a stored list REPLACES the default), explicit section
   * open/close choices, and the expanded flag. Absent = the defaults.
   */
  rail?: RailPrefs;
};

export interface RailPrefs {
  pins: string[];
  open: Record<string, boolean>;
  expanded: boolean;
  /**
   * ADDITIVE (rail fixes, 2026-10-07): kinds lifted to the top of the kind
   * list, most recently unpinned first. Absent = none (the Home order).
   */
  lifted?: string[];
}

export const LAYOUT_BOUNDS = {
  browserWidth: { min: 280, max: 480, initial: 320 },
  chatWidth: { min: 320, max: 640, initial: 380 },
} as const;

// ---------------------------------------------------------------------------
// Commands (§3, §4)
// ---------------------------------------------------------------------------

/**
 * `remote` (Spec C, doc 01a1111d-589e): a command an agent or the human's CLI
 * sent through the node's Workspace bridge. It runs through the same planners
 * under the remote policy in dispatch.ts; it is never a UI source.
 */
export type Source = 'click' | 'keyboard' | 'palette' | 'deeplink' | 'restore' | 'history' | 'system' | 'remote';
export const LOCAL_SOURCES: readonly Source[] = [
  'click',
  'keyboard',
  'palette',
  'deeplink',
  'restore',
  'history',
  'system',
];
/** Every source dispatch accepts: the local ones plus the bridge's `remote`. */
export const ACCEPTED_SOURCES: readonly Source[] = [...LOCAL_SOURCES, 'remote'];
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
  // ADDITIVE (Spec C): the registered dialogs, and bringing the window to the
  // Workspace route. Neither touches Workspace state; both act through hooks.
  'workspace.dialogs.open',
  'workspace.dialogs.close',
  'workspace.view.set',
  // ADDITIVE (Spec D): the rail preferences, so they persist with the workspace.
  'workspace.rail.set',
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
  /**
   * ADDITIVE (W1-F). The chooser tab this open replaces: a new tab takes the
   * chooser's position; an already-open tab is focused where it is. Either
   * way the chooser is removed. Ignored unless it names a chooser.
   */
  replaceTabId?: TabId;
};
export type TabsActivateArgs = { tabId: TabId };
export type TabsCloseArgs = { tabId: TabId; discard?: boolean };
export type TabsCloseVisibleArgs = { except?: TabId };
export type TabsMoveArgs = { tabId: TabId; beforeTabId?: TabId };
export type TabsSetUiArgs = { tabId: TabId; patch: Partial<TabUi> };
/** ADDITIVE `replaceTabId` (W1-F): as on `TabsOpenArgs`; the draft takes the chooser's position. */
export type DraftsOpenArgs = { kind: KindId; replaceTabId?: TabId };
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
/** The phase-1 dialog registry (Spec C §5); mirrors the contract's WORKSPACE_DIALOG_IDS. */
export const DIALOG_IDS = ['palette', 'prompts', 'agentTools', 'newSpace', 'addServer'] as const;
export type DialogId = (typeof DIALOG_IDS)[number];
export type DialogsOpenArgs = { dialogId: DialogId };
export type DialogsCloseArgs = { dialogId: DialogId };
/** ADDITIVE (Spec D): patch the rail prefs; `open` merges per section. */
export type RailSetArgs = { pins?: string[]; open?: Record<string, boolean>; expanded?: boolean; lifted?: string[] };
/** The Workspace route is the only target (coordinator ruling Q1). */
export type ViewSetArgs = { view: 'tabs' };

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
  'workspace.dialogs.open': DialogsOpenArgs;
  'workspace.dialogs.close': DialogsCloseArgs;
  'workspace.view.set': ViewSetArgs;
  'workspace.rail.set': RailSetArgs;
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
  | 'busy'
  // ADDITIVE (Spec C): remote policy and dialogs.
  | 'user_typing'
  | 'view_unavailable'
  | 'unsupported_dialog'
  | 'dialog_unavailable'
  | 'not_rendered'
  // ADDITIVE (Spec D §7): the node's hard tab limit.
  | 'tab_limit';

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
  /** ADDITIVE (Spec C): `workspace.dialogs.*` only. */
  dialogId?: DialogId;
  dialogState?: 'open' | 'closed';
};

/** What a dialog or view hook answers; the dispatcher adds the revision. */
export type ExternalOutcome = Omit<Result, 'revision'>;

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
  /** Move keyboard focus into a reused draft tab's form (a no-op off the window). */
  focusDraft(tabId: TabId): void;
  /**
   * ADDITIVE (Spec C). Open / dismiss a registered dialog; the app shell owns
   * dialog state. Default: `dialog_unavailable`.
   */
  openDialog(dialogId: DialogId): ExternalOutcome;
  closeDialog(dialogId: DialogId): ExternalOutcome;
  /** ADDITIVE (Spec C). Switch the window's route to the Workspace. */
  showWorkspace(): ExternalOutcome;
  /** ADDITIVE (Spec C). The Workspace view is mounted in this window. */
  viewMounted(): boolean;
  /** ADDITIVE (Spec C). The human typed in an editable field within the last 2 s. */
  userTyping(): boolean;
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
