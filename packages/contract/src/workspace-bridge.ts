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
  revision: number;
  tabId?: string;
  outcome?: 'created' | 'reused' | 'focused';
  reason?: string;
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
  activation?: 'activated' | 'no_window' | 'user_typing' | 'not_requested';
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
}

/** `workspace.drafts.patch` body: per-field values with the revision each was based on. */
export interface WorkspaceDraftPatchInput {
  fields: Record<string, { v?: unknown; base?: number }>;
  clientMutationId?: string;
}

export const WorkspaceDraftPatchInputSchema: z.ZodType<WorkspaceDraftPatchInput> = z
  .object({
    fields: z.record(z.object({ v: z.unknown(), base: z.number().int().nonnegative().optional() }).strict()),
    clientMutationId: z.string().min(1).optional(),
  })
  .strict();

export interface WorkspaceDraftPatchResult {
  draftId: string;
  revision: number;
  fields: Record<string, { v: unknown; r: number }>;
  /** Fields this write overwrote after someone else had changed them (LWW). */
  overwrote: string[];
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
