/**
 * The Workspace remote bridge (Spec C, doc 01a1111d-589e): agents and the CLI
 * drive a human's LIVE Workspace window through the same commands its UI
 * dispatches.
 *
 * Three operations ride over HTTP (`workspace.instances.list`,
 * `workspace.inspect`, `workspace.command`); the window side rides the
 * existing events socket (`events.subscribe`) as the `workspace.*` control
 * frames declared beside the others in contract.ts. Nothing here is durable:
 * instances and retry records live in the node's memory and die with it.
 *
 * Authority is IDENTITY EQUALITY: a caller reaches a window only when the
 * window's socket upgraded as the caller's own identity. An agent token
 * carries its owner's full identity, so "the human's own agents" are exactly
 * the sessions minted under that identity — never `can_act_as`, whose shared
 * teammate arm would admit any member of the space.
 */
import { z } from 'zod';

/** Every command a remote caller may NAME. The window decides what it accepts. */
export const WORKSPACE_REMOTE_COMMANDS = [
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
  'workspace.dialogs.open',
  'workspace.dialogs.close',
  'workspace.view.set',
] as const;
export type WorkspaceRemoteCommand = (typeof WORKSPACE_REMOTE_COMMANDS)[number];

/** The phase-1 dialog registry (Spec C §5). Only these ids can be opened. */
export const WORKSPACE_DIALOG_IDS = ['palette', 'prompts', 'agentTools', 'newSpace', 'addServer'] as const;
export type WorkspaceDialogId = (typeof WORKSPACE_DIALOG_IDS)[number];

/**
 * Workspace colours: palette tokens, not free CSS, so they theme in light and
 * dark (API doc 01a115c4 §2, Q10). `null` means no colour. Migration
 * 310_multiple_workspaces.sql hard-codes the same list in its check
 * constraint; stored.pg.test.ts holds the two together.
 */
export const WORKSPACE_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];
export const workspaceColorSchema = z.enum(WORKSPACE_COLORS);

/** Workspaces per (space, identity) (Q9). Migration 310 hard-codes the same number. */
export const WORKSPACES_PER_IDENTITY_CAP = 20;

/** The name of the backfilled and lazily created workspace (Q7). */
export const WORKSPACE_DEFAULT_NAME = 'Main';

/**
 * How a command's target workspace was picked (API doc 01a115c4 §3.2):
 * `window` = a socket write addressed by its frame (R9), `explicit` = the
 * caller named it, `owner` = the workspace holding the named tab or draft,
 * `active` = the identity's active workspace.
 */
export type WorkspaceResolvedBy = 'active' | 'explicit' | 'owner' | 'window';

/** The workspace a result applied to, named on every result (R8). */
export interface WorkspaceRef {
  /** null only for the synthetic "Main" of an identity with no row yet (S12). */
  id: string | null;
  name: string;
  color: WorkspaceColor | null;
  resolvedBy: WorkspaceResolvedBy;
  /** Whether it is the active workspace (after the command). */
  active: boolean;
}

/** One of the caller's workspaces, as lists show it (API doc §2). */
export interface WorkspaceSummary {
  /** null = the synthetic "Main" (no row yet). */
  id: string | null;
  name: string;
  color: WorkspaceColor | null;
  /** List order; ties break by creation (positions are not unique). */
  position: number;
  active: boolean;
  /** The row's state revision (0 = no row). */
  revision: number;
  tabCount: number;
  draftCount: number;
  dirtyDraftCount: number;
  createdAt: string | null;
  createdBy: { actorId: string | null; actorClass: 'human' | 'agent' } | null;
  /** The activity dot: an agent changed it after it was last active. */
  agentChangedSinceActive: boolean;
  lastAgentChange: { at: string; actorName?: string } | null;
}

/** A node-held agent request the human must answer (D8; phase 3). */
export interface WorkspacePrompt {
  promptId: string;
  kind: 'switch' | 'delete';
  workspaceId: string;
  workspaceName: string;
  actorName?: string;
  state: 'open' | 'accepted' | 'declined' | 'expired' | 'superseded';
  createdAt: string;
  resolvedAt?: string;
}

/** `workspace.list`: the caller's workspaces in the space. Never empty. */
export interface WorkspaceListResult {
  items: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  /** 0 when the identity has no row yet. */
  listRevision: number;
  cap: number;
  prompts: WorkspacePrompt[];
}

/**
 * The result of every management operation (API doc 01a115c4 §2): create,
 * update, reorder, delete, switch. `conflict` is F2: a switch whose
 * `expectedActiveWorkspaceId` is no longer active.
 */
export interface WorkspaceManageResult {
  requestId: string;
  status: 'applied' | 'no_op' | 'requires_user_choice' | 'rejected' | 'conflict';
  reason?: string;
  /** The workspace acted on; for a delete, its last summary. */
  workspace: WorkspaceSummary;
  /** The active workspace after the operation. */
  activeWorkspaceId: string;
  listRevision: number;
  /** requires_user_choice only (phase 3). */
  prompt?: WorkspacePrompt;
  choices?: string[];
  promptDelivered?: number;
  /** A delete refused with `unsaved_changes`. */
  dirtyDraftIds?: string[];
  /** F2, with reason `workspace_switched`: what the caller expected, and what is active. */
  expectedWorkspaceId?: string;
}

/** How long an open prompt waits for the human, and how long its outcome stays listed (D8). */
export const WORKSPACE_PROMPT_TTL_MS = 10 * 60_000;

/** Prompts kept per (identity, space); at the cap the oldest open delete prompt expires (Q5). */
export const WORKSPACE_PROMPTS_CAP = 8;

/**
 * `workspace.prompts.resolve` (§5.12, F1): the human's answer. `accept` is
 * Switch / Delete, `decline` is Stay / Keep. `discard` is for a delete prompt
 * whose workspace has unsaved drafts.
 */
export interface WorkspacePromptsResolveInput {
  requestId: string;
  choice: 'accept' | 'decline';
  discard?: boolean;
  clientMutationId?: string;
}

/** Why the workspace list changed, on a `workspace.summary` frame (§7.3). */
export type WorkspaceSummaryCauseKind = 'created' | 'renamed' | 'recolored' | 'reordered' | 'deleted' | 'switched' | 'agent_change';

/** `workspace.create` (§5.7). Creating never switches. */
export interface WorkspaceCreateInput {
  requestId: string;
  /** Omitted: "Workspace N", the lowest N ≥ 2 not taken. */
  name?: string;
  color?: WorkspaceColor | null;
  /** Omitted or null: last. */
  beforeWorkspaceId?: string | null;
  /** Reserved: answers not_implemented in v1 (Q8). */
  copyFrom?: string;
  clientMutationId?: string;
}

/** `workspace.update` (§5.8): rename and/or recolour. */
export interface WorkspaceUpdateInput {
  requestId: string;
  name?: string;
  color?: WorkspaceColor | null;
  clientMutationId?: string;
}

/** `workspace.reorder` (§5.9): null = to the end. */
export interface WorkspaceReorderInput {
  requestId: string;
  beforeWorkspaceId: string | null;
  clientMutationId?: string;
}

/** `workspace.switch` (§5.11). */
export interface WorkspaceSwitchInput {
  requestId: string;
  /** Guard against a double switch from two devices: a mismatch is `conflict` / `workspace_switched`. */
  expectedActiveWorkspaceId?: string;
  clientMutationId?: string;
}

/** The window capabilities `workspace.register` may announce (S9). */
export const WORKSPACE_WINDOW_CAPS = ['multiWorkspace'] as const;
export type WorkspaceWindowCap = (typeof WORKSPACE_WINDOW_CAPS)[number];

/** How long the node waits for a window's answer, in ms. */
export const WORKSPACE_COMMAND_TIMEOUT = { default: 10_000, min: 500, max: 30_000 } as const;

/** One live window, as discovery shows it: no tab titles, ids or content. */
export interface WorkspaceInstanceView {
  instanceId: string;
  windowId: string;
  spaceId: string;
  viewerMemberId: string;
  /** The window has keyboard focus. */
  focused: boolean;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** The window's current route view (`tabs` is the Workspace). */
  view: string;
  /** The Workspace view is mounted, so tab/scope/layout commands can apply. */
  mounted: boolean;
  /** The runtime revision the window last reported. */
  revision: number;
  connectedAt: string;
  lastSeen: string;
  /** When the window last gained focus; null if never this page load. */
  lastFocusedAt: string | null;
  /** The workspace the window shows (= active under R7); null = synthetic Main or not known yet. */
  workspaceId: string | null;
  /** From `workspace.register`; a window without `multiWorkspace` sees only the active workspace (S9). */
  caps: WorkspaceWindowCap[];
}

export interface WorkspaceInstancesListResult {
  /** Most recently focused first. */
  items: WorkspaceInstanceView[];
}

/** The runtime Result (Spec B §3) plus the bridge's addressing. */
export interface WorkspaceRemoteResult {
  requestId: string;
  instanceId: string;
  status: 'applied' | 'no_op' | 'requires_user_choice' | 'rejected' | 'conflict';
  /** The TARGET workspace's revision. */
  revision: number;
  /**
   * The workspace it applied to (R8). Always set by a node that keeps stored
   * workspaces; absent only from a Spec C node or a refused window frame.
   */
  workspace?: WorkspaceRef;
  tabId?: string;
  /** A batch `tabs.open`: one per entity, in input order (`tabId` is the first). */
  tabIds?: string[];
  outcome?: 'created' | 'reused' | 'focused';
  outcomes?: ('created' | 'reused' | 'focused')[];
  reason?: string;
  /** With reason `workspace_switched` / `workspace_mismatch`: the pin, and what is active. */
  expectedWorkspaceId?: string;
  activeWorkspaceId?: string | null;
  /** A batch `tabs.open` refused with `entity_unavailable`: the entities the caller cannot read. */
  unavailableEntityIds?: string[];
  pendingInteractionId?: string;
  choices?: string[];
  /** `workspace.inspect` only: ids and kinds, never draft or chat content. */
  inspection?: Record<string, unknown>;
  dialogId?: string;
  dialogState?: 'open' | 'closed';
  /**
   * Spec D §4: an agent `tabs.open` applies to the stored workspace; this says
   * whether a live window also brought it to the front.
   */
  activation?: 'activated' | 'no_window' | 'user_typing' | 'not_requested' | 'not_active';
}

/** `workspace.get` (Spec D §2): the caller's stored workspace. */
export interface WorkspaceGetResult {
  /** 0 when the caller has no workspace row in this space yet. */
  revision: number;
  /** The shared state; tabs whose entity the caller can no longer read carry `unavailable: true`. */
  state: Record<string, unknown>;
  drafts: { draftId: string; kind: string; revision: number; fields: Record<string, { v: unknown; r: number }> }[];
  /** Live windows of this identity in the space. */
  windows: number;
  /** The workspace this answer reads (explicit, else active). */
  workspace: WorkspaceRef;
  /** null = the synthetic "Main" (no row yet). */
  activeWorkspaceId: string | null;
  /** All of the caller's workspaces in the space, list order. */
  workspaces: WorkspaceSummary[];
}

/** `workspace.drafts.patch` body: per-field values with the revision each was based on. */
export interface WorkspaceDraftPatchInput {
  fields: Record<string, { v?: unknown; base?: number }>;
  clientMutationId?: string;
  /** Explicit target (R4); must own the draft. */
  workspaceId?: string;
  /** Pin (R5). Accepted from phase 1, checked from phase 3. */
  expectedWorkspaceId?: string;
}

export const WorkspaceDraftPatchInputSchema: z.ZodType<WorkspaceDraftPatchInput> = z
  .object({
    fields: z.record(z.object({ v: z.unknown(), base: z.number().int().nonnegative().optional() }).strict()),
    clientMutationId: z.string().min(1).optional(),
    workspaceId: z.string().uuid().optional(),
    expectedWorkspaceId: z.string().uuid().optional(),
  })
  .strict();

export interface WorkspaceDraftPatchResult {
  draftId: string;
  revision: number;
  fields: Record<string, { v: unknown; r: number }>;
  /** Fields this write overwrote after someone else had changed them (LWW). */
  overwrote: string[];
  /** The workspace that owns the draft (R8). */
  workspace: WorkspaceRef;
}

/** The `workspace.command` body; the space comes from the path. */
export interface WorkspaceCommandInput {
  /** Idempotency key: the same id and payload returns the recorded result. */
  requestId: string;
  command: WorkspaceRemoteCommand;
  args?: unknown;
  /** Omitted: the node picks the only live window, or the only focused one. */
  instanceId?: string;
  expectedRevision?: number;
  timeoutMs?: number;
  clientMutationId?: string;
  /** Explicit target (R4): one of the caller's workspaces. Never switches. */
  workspaceId?: string;
  /** Pin (R5). Accepted from phase 1, checked from phase 3. */
  expectedWorkspaceId?: string;
}

const Id = z.string().uuid();
/** Request ids are caller-chosen; uuid by default, but any short token works. */
const RequestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const WorkspaceCommandInputSchema: z.ZodType<WorkspaceCommandInput> = z
  .object({
    requestId: RequestId,
    command: z.enum(WORKSPACE_REMOTE_COMMANDS),
    args: z.unknown().optional(),
    instanceId: Id.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().positive().optional(),
    clientMutationId: z.string().min(1).optional(),
    workspaceId: Id.optional(),
    expectedWorkspaceId: Id.optional(),
  })
  .strict();

/** What a window sends back. Loose on purpose: the window owns the vocabulary. */
export const WorkspaceRemoteResultBodySchema = z
  .object({
    status: z.enum(['applied', 'no_op', 'requires_user_choice', 'rejected', 'conflict']),
    revision: z.number().int().nonnegative(),
    tabId: z.string().max(128).optional(),
    outcome: z.enum(['created', 'reused', 'focused']).optional(),
    reason: z.string().max(64).optional(),
    pendingInteractionId: z.string().max(128).optional(),
    choices: z.array(z.string().max(32)).max(8).optional(),
    inspection: z.record(z.unknown()).optional(),
    dialogId: z.string().max(64).optional(),
    dialogState: z.enum(['open', 'closed']).optional(),
  })
  .strip();

/**
 * Names are checked by the handler, not here, so a bad one answers
 * `invalid_input` with reason `invalid_name` (§4); the bound only stops a
 * runaway body. Colours are the shared token list (Q10).
 */
const ManageName = z.string().max(256);
const ManageColor = z.string().max(64).nullable();

export const WorkspaceCreateInputSchema: z.ZodType<WorkspaceCreateInput> = z
  .object({
    requestId: RequestId,
    name: ManageName.optional(),
    color: ManageColor.optional(),
    beforeWorkspaceId: Id.nullable().optional(),
    copyFrom: Id.optional(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict() as z.ZodType<WorkspaceCreateInput>;

export const WorkspaceUpdateInputSchema: z.ZodType<WorkspaceUpdateInput> = z
  .object({
    requestId: RequestId,
    name: ManageName.optional(),
    color: ManageColor.optional(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict() as z.ZodType<WorkspaceUpdateInput>;

export const WorkspaceReorderInputSchema: z.ZodType<WorkspaceReorderInput> = z
  .object({
    requestId: RequestId,
    beforeWorkspaceId: Id.nullable(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict();

export const WorkspaceSwitchInputSchema: z.ZodType<WorkspaceSwitchInput> = z
  .object({
    requestId: RequestId,
    expectedActiveWorkspaceId: Id.optional(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict();

export const WorkspacePromptsResolveInputSchema: z.ZodType<WorkspacePromptsResolveInput> = z
  .object({
    requestId: RequestId,
    choice: z.enum(['accept', 'decline']),
    discard: z.boolean().optional(),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict();

/** A workspace name as stored: trimmed, 1–64 characters, no control characters (§4 `invalid_name`). */
export function isWorkspaceName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name === name.trim() && name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name);
}

export function isWorkspaceColor(color: string): color is WorkspaceColor {
  return (WORKSPACE_COLORS as readonly string[]).includes(color);
}
