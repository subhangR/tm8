// @tm8/execution — SpawnService seam types.
//
// THE DEPENDENCY RULE THIS FILE EXISTS TO ENFORCE:
// packages/execution has no database driver and must never gain one. `pg` lives
// in packages/server alone. So everything the spawn flow needs from the graph
// arrives through `GraphPort` — a narrow port declared HERE and implemented
// over `Db` in packages/server/src/facade/execution-handlers.ts.
//
// Two things fall out of that, both deliberate:
//   1. SpawnService is unit-testable against a fake graph, so the PTY assertions
//      (the ones that actually matter — R17) run with no Postgres at all.
//   2. The SQL stays where the RPCs are reviewed. A handler that hand-rolls an
//      UPDATE against work_sessions would bypass the command ledger, the event
//      capture trigger and the F1/F2 guards; keeping SQL out of this package
//      makes that mistake impossible to make here.

import type {
  ContextBudgets,
  EffectiveSkills,
  SelectionHeader,
  SkillIndexEntry,
  CredentialProviderName,
  SpawnSelection,
  SpawnSelectionDefaultReason,
  SpawnSelectionGroup,
} from '@tm8/contract';
import type { CoordinatorKind, PromptContextIndex, PromptVersion } from '@tm8/prompt';
import type { WorkSessionUsage, WorkSessionUsageSource } from '../transcript/session-usage.js';

export type { CoordinatorKind };

/** Agent execution mode — mirrors work_sessions.mode's CHECK constraint. */
export type AgentMode =
  | 'worker'
  | 'coordinator'
  | 'coordinated-worker'
  | 'coordinated-coordinator'
  | 'dispatcher';

/** work_sessions.status — the five states 001_core_graph.sql:703 allows. */
export type WorkSessionStatus = 'spawning' | 'running' | 'idle' | 'exited' | 'failed';

/**
 * work_sessions.ended_kind — the six classes 171's CHECK allows. Mirrored here
 * rather than imported from the contract, exactly as WorkSessionStatus above
 * is: this package states the database's vocabulary, and the contract states
 * the wire's. They are kept identical deliberately, not by coupling.
 *
 * `out_of_memory` is kernel evidence (the cgroup oom_kill counter), never an
 * inference from a signal number — a SIGKILL from a deploy and a SIGKILL from
 * the OOM killer look identical at the process level, and only one of them is
 * a legitimate death.
 */
export type WorkSessionEndedKind =
  | 'completed'
  | 'stopped_by_operator'
  | 'server_restart'
  | 'out_of_memory'
  | 'crashed'
  | 'unknown';

/**
 * Permission posture handed to the agent. Named for old maestro's vocabulary
 * because the personas carry these exact strings in team_members.permission_mode
 * and an import must not have to translate them.
 *
 * `auto` is the one posture maestro never had, because the CLI it maps to did
 * not have it either: Claude Code's `--permission-mode auto` lets the agent run
 * the actions it judges safe and escalates only the risky ones. It sits between
 * `acceptEdits` (edits free, every command asked) and `bypassPermissions` (ask
 * nothing) and it is tm8's DEFAULT — see `DEFAULT_PERMISSION_MODE`.
 */
export type PermissionMode = 'auto' | 'acceptEdits' | 'interactive' | 'readOnly' | 'bypassPermissions';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AccessMode = 'safe' | 'acceptEdits' | 'auto' | 'plan' | 'fullAccess';

/**
 * Effective command-network posture recorded in every launch manifest.
 *
 * This is deliberately separate from filesystem/approval posture. In
 * particular, Codex plan sessions use a workspace-write sandbox so their
 * commands can reach tm8 through the network proxy, while source edits remain
 * prohibited by the trusted launch authorization.
 */
export interface CommandNetworkPolicy {
  mode: 'loopback-proxy' | 'full-access' | 'provider-default' | 'operator-defined';
  commandNetworkAccess: boolean | null;
  proxyEnabled: boolean;
  allowedHosts: string[];
  /** Codex's current proxy rules are host-based, not port-scoped. */
  portScoped: boolean;
}

/** Working-directory semantics (contract `SpawnWorkdir`). */
export type WorkdirMode = 'project' | 'scratch' | 'worktree';

/**
 * The OPERATIONAL state of a checkout on disk — `worktree_allocations.state`.
 *
 * Deliberately NOT the vocabulary of the worktree ENTITY's status
 * (active/merged/abandoned/deleted). Two state machines, two tables: one
 * records what was decided, the other what has actually happened on disk.
 * Conflating them is how `deleted` comes to mean "we meant to delete it"
 * (worktree design §3.1).
 */
export type WorktreeAllocationState =
  | 'preparing'
  | 'ready'
  | 'cleanup_pending'
  | 'missing'
  | 'failed';

/** One row of `public.node_worktree_allocations` — reconciliation's DB-side source. */
export interface WorktreeAllocationRow {
  worktreeId: string;
  projectId: string | null;
  state: WorktreeAllocationState;
  path: string | null;
  branch: string | null;
  leaseSessionId: string | null;
  attempts: number;
  failureCode: string | null;
  /** False for a reservation whose step-6 transaction never committed. */
  entityExists: boolean;
  worktreeStatus: string | null;
  leaseSessionStatus: string | null;
  /**
   * When the allocation last changed. Reconciliation needs it to leave a
   * reservation that a live spawn is mid-way through ALONE — see the grace
   * period in `worktree-reconcile.ts`.
   */
  updatedAt: string | null;
}

/**
 * Opaque per-request authorization, passed straight through to the graph
 * implementation. SpawnService never inspects it — it only has to CARRY it,
 * including across the async gap to PTY exit (see `SpawnService` docs).
 *
 * Typed as `unknown` on purpose: the concrete shape is the server's `DbClaims`,
 * and importing that here would drag a server type into the execution package
 * for no benefit.
 */
export type GraphAuth = unknown;

/** A decrypted GitHub credential, held only long enough to compose one PTY env. */
export interface GitHubCredential {
  readonly provider: 'github';
  readonly login: string;
  readonly token: string;
}

/**
 * Spawn-side lookup for the calling identity's string-shaped GitHub credential.
 * The server implementation resolves the row under RLS and decrypts in-process;
 * execution never imports a database driver or a node key.
 */
export interface GitHubCredentialPort {
  resolve(auth: GraphAuth): Promise<GitHubCredential | null>;
}

/** Providers a SPACE can hold a credential for (206 `space_credentials.provider`). */
export const SPACE_CREDENTIAL_PROVIDERS = ['anthropic', 'openai', 'github'] as const;
export type SpaceCredentialProvider = (typeof SPACE_CREDENTIAL_PROVIDERS)[number];
export function isSpaceCredentialProvider(value: unknown): value is SpaceCredentialProvider {
  return (SPACE_CREDENTIAL_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * D5 policy as the resolver reads it (design 01a0cfa8 §4). `space[p]` is the
 * space admin's allowed-source list (absent = every source); `node[p] === false`
 * is the node admin forbidding node fallback (absent = allowed).
 *
 * ENFORCED ONLY HERE. Neither 206's spawn reader nor its manifest writer reads
 * a policy (advisory A5), so `SpawnService` is the single choke point, and it
 * applies the policy to a pinned, an inherited and a resumed id alike.
 */
export interface SpaceCredentialPolicies {
  space: Partial<Record<SpaceCredentialProvider, readonly CredentialSource[]>>;
  node: Partial<Record<SpaceCredentialProvider, boolean>>;
}

/** A usable space credential, opened for exactly one spawn or resume. */
export type SpaceCredentialGrant =
  | {
      kind: 'secret';
      credentialId: string;
      provider: SpaceCredentialProvider;
      shape: 'api_key' | 'token';
      label: string;
      displayLogin: string | null;
      /** Never logged, never put in an error, never recorded (I5). */
      secret: string;
    }
  | {
      kind: 'login';
      credentialId: string;
      provider: SpaceCredentialProvider;
      label: string;
      displayLogin: string | null;
      /** The login home, `<dataDir>/credentials/spaces/<space>/<credential>`. */
      homeDir: string;
    };

/** How a launch picked its space credential (doc 13 §6c). */
export type SpaceCredentialPick = 'pinned' | 'my_default' | 'space_default';

/**
 * Why a space credential is not usable. Every one refuses the launch: none of
 * them is a reason to fall back to another source (I3).
 */
export type SpaceCredentialRefusalReason =
  | 'no_default'
  | 'not_found'
  | 'pending'
  | 'stale'
  | 'revoked'
  | 'unreadable'
  /** Another member's private credential: never usable by this launcher (W10a). */
  | 'not_usable';

export type SpaceCredentialRepoint =
  | { ok: true; credentials: ReadonlyArray<{ provider: SpaceCredentialProvider; spaceCredentialId: string }> }
  | { ok: false; reason: 'inactive' | 'not_usable' };

export type SpaceCredentialRead =
  | { ok: true; grant: SpaceCredentialGrant }
  | { ok: false; reason: SpaceCredentialRefusalReason };

/**
 * Server-owned access to SPACE credentials (206). Execution never imports a
 * database driver or the node key. Every call runs under the CALLER's claims —
 * for an agent, its root human launcher's — so membership is the launcher's,
 * never the persona owner's.
 *
 * A thrown error means the question could not be answered (the DB is down,
 * 206 is absent); the spawn path refuses on it rather than guessing.
 */
export interface SpaceCredentialPort {
  readPolicies(auth: GraphAuth, spaceId: string): Promise<SpaceCredentialPolicies>;
  /** `credentialId` null reads the space default. */
  read(
    auth: GraphAuth,
    spaceId: string,
    provider: SpaceCredentialProvider,
    credentialId: string | null,
  ): Promise<SpaceCredentialRead>;
  /**
   * The subset of `credentialIds` that is active, in a space the caller still
   * belongs to, and usable by the caller as launcher (public, space-owned, or
   * the caller's own) now.
   */
  activeIds(auth: GraphAuth, credentialIds: readonly string[]): Promise<ReadonlySet<string>>;
  /**
   * Resume (C3): the resumer becomes the recorded launcher of every space
   * credential the session holds, and the recorded rows come back. `inactive`
   * means one of them is no longer active, `not_usable` that one is now
   * another member's private credential (206 refuses the re-point whole).
   * With `providers` (R13), rows for every provider this resume did not
   * resolve to a space credential are dropped first, in the same transaction.
   */
  repointSession(
    auth: GraphAuth,
    sessionId: string,
    providers?: readonly SpaceCredentialProvider[],
  ): Promise<SpaceCredentialRepoint>;
  /**
   * The launcher's own default for this provider in this space (W10b, §3e),
   * if it is active; null otherwise. Optional: a port without it has no
   * my-default rung.
   */
  myDefaultId?(auth: GraphAuth, spaceId: string, provider: SpaceCredentialProvider): Promise<string | null>;
}

/**
 * Server-owned credential minting. Execution carries opaque claims but never
 * imports a database driver or sees a human bearer token.
 */
export interface AgentCredentialPort {
  mint(
    auth: GraphAuth,
    input: { workSessionId: string; teamMemberId: string },
  ): Promise<{ token: string; authSessionId: string }>;
  revoke(auth: GraphAuth, workSessionId: string): Promise<void>;
}

// --- what the graph must be able to do for us --------------------------------

export interface LoadSpawnContextInput {
  spaceId: string;
  teamMemberId: string;
  projectId?: string | null;
  taskIds?: string[];
  /**
   * The spawning parent, when there is one, so the loader can resolve its KIND
   * for the manifest's coordinator block (176). Absent ⇒ a root spawn, and the
   * loader reads nothing extra.
   */
  parentSessionId?: string | null;
  /**
   * Memory entities explicitly named by the spawn request (D3a). The graph
   * validates them (same space, kind `memory`, live) and folds them into the
   * teammate's injected memory set for this session only.
   */
  memoryIds?: string[];
  /**
   * The EXACT memory, skill and reference sets for this session (design
   * 01a0d348 §5.1). Each group it names replaces that group's defaults (the
   * teammate's working set and the tasks' `remembers` sets; the equipped
   * skills; the tasks' linked references); a group it omits keeps them. A
   * selected entity that is not a default is loaded for this session only
   * (no edge is written), and defaults left out are audited as
   * `not-selected`. Absent, the load is exactly what it was before the field
   * existed.
   */
  selection?: SpawnSelection;
  /**
   * `selection` is a RESUME replaying the launch's recorded selection. An id
   * that no longer resolves is then left out and recorded `unavailable`, not
   * refused: the resumer did not choose it, and one deleted memory must not
   * make a session impossible to resume.
   */
  selectionReplay?: boolean;
}

/**
 * A launch-time credential choice. `'member'` = the spawner's own connected
 * vendor credential, and ONLY their own; `'node'` = the node's machine
 * credential. There is deliberately no value naming another member — whose
 * credential a session may use is not a client-expressible decision.
 * `'space'` = a credential the launch SPACE holds (design 01a0cfa8), usable by
 * every member and re-checked against the caller's membership at spawn and at
 * resume. A client may name a space credential's id, never an account (I1).
 */
export type CredentialSource = 'member' | 'space' | 'node';
/** The contract's complete provider set; an alias cannot drift during rollout. */
export type CredentialProvider = CredentialProviderName;
export type CredentialSources = Partial<Record<CredentialProvider, CredentialSource>>;
export type ResolvedCredentialSources = Record<CredentialProvider, CredentialSource | null>;
export type StoredCredentialSources = Partial<Record<CredentialProvider, CredentialSource | null>>;

/**
 * How an EXISTING session was launched, read back from its recorded manifest.
 *
 * This is the fact a child needs in order to inherit its parent's posture, and
 * the fact a resume needs in order not to silently downgrade its own. Both
 * fields are nullable because the source is a stored JSON document: a session
 * whose manifest row was never written (a spawn that died before step 4), or
 * one written by an older build, answers "I don't know" rather than a wrong
 * default.
 */
export interface SessionLaunchPosture {
  accessMode: AccessMode | null;
  permissionMode: PermissionMode | null;
  /**
   * Deprecated common source written by pre-split manifests. Current readers
   * use it only as a fallback for provider keys that are absent.
   */
  credentialSource?: CredentialSource | null;
  /** Provider-specific posture written by current manifests. */
  credentialSources?: StoredCredentialSources | null;
  /**
   * The exact space credential per provider whose source is `space`. Stored
   * JSON, so read as `unknown` values and validated by the resolver: a `space`
   * source with no usable id here refuses rather than re-resolving (M8a).
   */
  spaceCredentialIds?: Partial<Record<string, unknown>> | null;
  /**
   * `launch.harnessChoice` — the explicit harness pick the session was
   * launched with, if any. Stored JSON, so narrowed by the resolver.
   */
  harnessChoice?: Record<string, unknown> | null;
  /**
   * `launch.selection` / `launch.selectionReasons`, which resume replays.
   * Stored JSON, so they are read as `unknown` and parsed with the contract's
   * own schemas before use. A child session never inherits them.
   */
  selection?: unknown;
  selectionReasons?: unknown;
  /** `launch.contextBudgets`, which resume replays. Stored JSON, parsed before use. */
  contextBudgets?: unknown;
  /**
   * `launch.harness.plugins.allowed` ids the launch turned on for its
   * effective skills (`source: 'effective-skill'`). Resume replays them, so
   * its plugin allow set is the launch's even when the text the skill trim
   * measured has changed since. Absent: nothing recorded (an older manifest,
   * no plugins), and resume computes the set.
   */
  effectivePlugins?: string[] | null;
  /**
   * `launch.harness.skillOverrides`: the skill plan the launch ran with.
   * Resume replays it (`asRecordedSkillPlan`), so a resumed lane lists the
   * skills it launched with even if its equips or config home changed.
   * Stored JSON; absent on a manifest without one, and resume computes.
   */
  skillOverrides?: Record<string, unknown> | null;
  /** `context.index.source`: the launch rendered `<context_index>`; resume renders it too. */
  contextIndex?: 'env' | 'profile' | null;
}

/** A project as the server computed it — `workingDir` is graph truth (S11). */
export interface ProjectContext {
  id: string;
  name: string;
  /** Absolute path, from public.projects.working_dir. NEVER client-supplied. */
  workingDir: string;
  trust: 'trusted' | 'untrusted';
}

/** The persona the session runs as, from public.team_members. */
export interface TeamMemberContext {
  id: string;
  name: string;
  role: string;
  identity: string;
  memories: unknown[];
  /**
   * The memory ENTITIES injected into `memories`, in injection order: the
   * first `memoryIds.length` entries of `memories` are these, and any after
   * them are the legacy jsonb remainder, which has no ids. Absent from
   * contexts that predate it.
   */
  memoryIds?: string[];
  model: string | null;
  agentTool: string | null;
  mode: AgentMode | null;
  permissionMode: string | null;
  avatar: string | null;
  capabilities: Record<string, unknown>;
  commandPermissions: Record<string, unknown>;
}

export interface TaskContext {
  id: string;
  version: number;
  title: string;
  description: string;
  priority: string;
  status: string;
  acceptanceCriteria: unknown[];
  /** File entities attached directly to this task. Identity/metadata only;
   * bytes remain behind the authenticated `tm8 file download` command. */
  attachments?: Array<{
    fileEntityId: string;
    name: string;
    mime: string;
  }>;
  /**
   * Set when the task was derived from a thread message (064/099): the thread
   * root and the channel it is anchored on. Rendered into the assignment
   * envelope's <source>/<thread> elements so the agent can read the LIVE
   * thread (`tm8 message list <channel> --root <root>`) instead of trusting a
   * snapshot in the task body.
   */
  threadRootMessageId?: string | null;
  threadChannelId?: string | null;
  /**
   * Other entities linked to this task, as REFERENCES only: outgoing
   * `relates_to` (teammates, sessions) and incoming non-file `attached_to`
   * (drawings, docs, artifacts), which is what the task attach palette writes.
   * Oldest link first and bounded by the spawn read. `linkedTotal` is the exact
   * count, so the prompt can declare what it left out. `title` is null for a
   * work_session, which is referenced by id alone and never by transcript or
   * title. `remembers` and `equips` are not here, because they reach the
   * session whole: as injected memories and as skill-index entries.
   */
  linked?: Array<{
    entityId: string;
    kind: string;
    link: string;
    title: string | null;
  }>;
  linkedTotal?: number;
}

/**
 * Everything read from the graph BEFORE `execution_spawn` runs.
 *
 * The ordering matters and is easy to get backwards: the RPC persists the
 * resolved model/agentTool/mode onto the work_session row, but resolving them
 * needs the persona's defaults. So the reads come first, precedence resolves
 * in-process, and only then does the session get created — which is why this
 * type has no sessionId.
 */
export interface SpawnContext {
  spaceId: string;
  project: ProjectContext | null;
  teamMember: TeamMemberContext;
  tasks: TaskContext[];
  /**
   * What `SpawnRequest.parentSessionId` actually points at (176).
   *
   * Since a chat became an entity it may parent a work session, so a
   * coordinated worker's return address is no longer always a work_session.
   * The kind is READ FROM THE GRAPH beside the persona rather than asserted by
   * the caller — a spawn's parent is graph state, and a client-supplied kind
   * would be a claim about someone else's row.
   *
   * `null` means "no parent, or a parent this reader could not resolve", and
   * every consumer folds that to `work_session`: the pre-176 meaning, and what
   * a manifest written by an older node says by omission.
   */
  parentKind?: CoordinatorKind | null;
  /**
   * Skills resolved across the team member's ancestor chain, nearest-first, and
   * already de-duplicated — see `resolveSkills` in ./skills.ts. Optional only so
   * that existing SpawnContext producers (the fake graph in tests, and any
   * caller predating row #11) stay valid; absent is read as "none".
   */
  skills?: ManifestSkillContext[];
  skillEquips?: import('./skills.js').ResolvedSkillRow[];
  skillsScannedAt?: string | null;
  skippedSkills?: import('@tm8/contract').SkippedSkill[];
  /**
   * Skills omitted by context selection or serialized index budgeting. Carried through to the
   * manifest so a truncated persona is visible rather than merely smaller.
   */
  droppedSkills?: string[];
  /**
   * What the loader knows about the launch context that the rendered texts do
   * not carry: whether a selection replaced the defaults, how each injected
   * memory entered the set, and every default the selection left out (design
   * 01a0d348 §6). Absent from contexts that predate it.
   */
  contextAudit?: SpawnContextAudit;
  /**
   * The EXACT reference set when the launch selected references
   * (`selection.referenceIds`, design 01a0d348 §5.1), in the selected order:
   * each is a live, same-space doc, artifact, drawing, file or task the caller
   * can read. `via` says whether it is one of the spawn tasks' defaults
   * (`linked` / `attached`, with its edge) or rides this launch only
   * (`selection`). Absent when references were not selected: the defaults are
   * then the tasks' `linked` and `attachments`. Resolved and audited here;
   * rendering it is the context index's job.
   */
  references?: Array<{
    entityId: string;
    kind: string;
    title: string | null;
    via: 'selection' | 'linked' | 'attached';
    link?: string;
  }>;
  /**
   * Selection headers (`GraphPort.loadContextHeaders`, under RLS) for the
   * entries `<context_index>` renders. Only read when the index is on; an
   * entity with no header here renders from the loader's own row (its title,
   * a skill's description).
   */
  headers?: SelectionHeader[];
  /**
   * Jev's scores for the injected memories, from the launch's run, when the
   * run ranked memories (`GraphPort.loadMemoryScores`). `critical` is Jev's
   * own threshold (`CRITICAL_SCORE`), decided server-side so there is one copy
   * of it. Absent: no rank.
   */
  memoryScores?: { entityId: string; score: number; critical: boolean }[];
  /**
   * A dispatcher's roster (`GraphPort.loadDispatcherRoster`, under RLS):
   * the space's teammates other than the dispatcher itself, rendered as the
   * `teammates` group of `<context_index>` (integrated design 01a0d348 §8
   * I8, headers T6). Only read when the index is on and the launch is a
   * dispatcher. `total` counts every readable teammate; the ones past the
   * read are declared, never dropped silently.
   */
  roster?: DispatcherRoster;
}

/** The teammates a dispatcher routes to, as `loadDispatcherRoster` read them. */
export interface DispatcherRoster {
  /** In roster order (name, then id), at most `DISPATCHER_ROSTER_READ_MAX`. */
  members: Array<{ entityId: string; name: string; mode: string | null; model: string | null }>;
  /** Every teammate the read could see, the dispatcher excluded. */
  total: number;
}

export interface SpawnContextAudit {
  /**
   * The selection groups the launch sent as exact sets, replacing that
   * group's edge-driven defaults. A group not listed kept its defaults.
   */
  selectedGroups: ReadonlyArray<SpawnSelectionGroup>;
  /** One per `teamMember.memoryIds` entry, same order. */
  memoryVia: ContextVia[];
  /** Skills that are in the session only because the selection named them. */
  selectionOnlySkillIds?: string[];
  /** Defaults the selection left out, and other loader-side drops. */
  dropped: ContextDrop[];
  /**
   * Legacy `team_members.memories` jsonb entries a selection replaced. They
   * have no entity id, so they are counted here rather than listed.
   */
  legacyMemoriesDropped?: number;
}

export type ManifestSkillContext = SkillIndexEntry;

// --- the launch-context audit (design 01a0d348 §6) ----------------------------

export type ContextGroupName = 'memories' | 'skills' | 'references' | 'teammates';

/**
 * How an entry entered the launch set. `requested` is an id the spawn named
 * directly without a selection (`tm8 session spawn --memory`); `roster` is a
 * dispatcher's teammate, read from the space rather than from an edge.
 */
export type ContextVia = 'selection' | 'teammate' | 'inherited' | 'task' | 'linked' | 'attached' | 'requested' | 'roster';

export interface ContextGroupAudit {
  /**
   * `selected`: the launch sent this group as an exact set. `default`: the
   * edge-driven defaults `loadSpawnContext` computes.
   */
  mode: 'selected' | 'default';
  /**
   * Why the defaults were used. `no-selection`: the launch did not select this
   * group and said nothing more; `not-selectable`: selection cannot name this
   * group; otherwise the client's own `selectionReasons` entry (an enum,
   * validated at the wire, audit-only). `replay-invalid`: a resume found the
   * launch's recorded selection malformed, so it loaded the defaults instead.
   */
  reason?: 'no-selection' | 'not-selectable' | 'replay-invalid' | SpawnSelectionDefaultReason;
  /** Linked rows (a dispatcher's teammates: roster rows) beyond the spawn read; declared as `omitted` in the prompt. */
  unread?: number;
  /** See `SpawnContextAudit.legacyMemoriesDropped`. */
  legacyDropped?: number;
  /**
   * Memories only, when some collapsed into the index (§10 Q1): `jev` when
   * the launch's Jev run ranked them (lowest score first), `none` when it did
   * not, and then `collapseOrder` names the stated order used instead — so a
   * collapse is never read as a Jev judgement.
   */
  rank?: 'jev' | 'none';
  collapseOrder?: 'teammate>task>requested';
}

export interface ContextEntryRecord {
  entityId: string;
  kind: string;
  group: ContextGroupName;
  via: ContextVia;
  /** 1-based position in its group: the selected order, else edge order. */
  rank: number;
  /**
   * Memories are injected whole; everything else is an index line.
   * `summary-dropped`: a `<context_index>` entry that kept its line, name and
   * whenToUse but lost its summary to the byte budget. `header-dropped` is the
   * whole-header drop a launch recorded before the floor rule (task 01a0da5a).
   */
  state: 'expanded' | 'collapsed' | 'summary-dropped' | 'header-dropped';
  /** UTF-8 bytes of the entry as the prompt renders it. */
  bytes: number;
  /** Edge type, for references and teammates. */
  link?: string;
}

export type ContextDropReason =
  | 'not-selected'
  | 'byte-budget'
  | 'task-name-collision'
  | 'native-shadowed'
  | 'count-cap'
  /**
   * Selected and resolved, but this launch's prompt has nothing that renders
   * it: a selected reference that is not one of the tasks' own links, while
   * no context index renders references (design 01a0d348 §2.2).
   */
  | 'not-rendered'
  /**
   * A resume replayed the launch's selection, and this id no longer resolves
   * (deleted, moved, or unreadable to the resumer). The rest of the selection
   * still replays. `kind` is the entity's kind when it is still readable,
   * else `'unknown'`.
   */
  | 'unavailable'
  /** An equipped skill whose file is gone (`effectiveSkills.skipped` `missing`). */
  | 'missing'
  /** An equipped skill the lane's tool has turned off (`effectiveSkills.skipped` `disabled`). */
  | 'disabled';

export interface ContextDrop {
  entityId: string;
  kind: string;
  group: ContextGroupName;
  reason: ContextDropReason;
  /** `summary`: the entry kept its whenToUse; `header` is a pre-floor-rule record. */
  level?: 'body' | 'summary' | 'header' | 'entry';
}

/**
 * `manifest.context`. `memoryIds` keeps its PREFIX RULE (see
 * `Tm8Manifest.context`); the rest is the audit of what the launch carried.
 */
export interface ManifestContext {
  memoryIds?: string[];
  groups?: Record<ContextGroupName, ContextGroupAudit>;
  entries?: ContextEntryRecord[];
  dropped?: ContextDrop[];
  /**
   * Present only when the launch rendered `<context_index>` (design 01a0d348
   * §2): which switch turned it on, and each index group's byte cap and use.
   * Absent: the launch rendered today's `<skills>` block.
   */
  index?: ContextIndexRecord;
  /**
   * Byte budgets in force and their use, when the launch rendered
   * `<context_index>`. `memoryInjection.borrowed` is how far critical
   * memories, which never collapse, ran past the cap into the combined
   * ceiling (§10 Q1 rule 2) — so the sub-cap is never exceeded silently.
   */
  budgets?: ContextBudgetsRecord;
}

/**
 * `manifest.context.budgets` (design 01a0d348 §10 Q1, Q5.4). `memoryInjection`
 * is the memory collapse's cap and use. `launch` is the launch sheet's
 * per-launch override as applied, and `warning` says, when it is present,
 * that the budgets in force promise more than the prompt can hold beside its
 * frame: recorded, never refused, and the launch trim still bounds the prompt.
 */
export interface ContextBudgetsRecord {
  memoryInjection?: { cap: number; used: number; borrowed: number };
  launch?: ContextBudgets;
  warning?: { code: 'context_budgets_over_ceiling'; baseline: number; promised: number; cap: number; over: number };
}

/** `manifest.context.index`. */
export interface ContextIndexRecord {
  /** `env`: `TM8_CONTEXT_INDEX`; `profile`: the pinned profile's `contextIndex`. */
  source: 'env' | 'profile';
  /** Rendered bytes of the whole element plus its joining newline. */
  bytes: number;
  /**
   * The sub-caps in force (`BYTE_BUDGETS.referenceIndex` / `rosterIndex`), by
   * the groups that share each; skills take what remains.
   */
  caps: { groups: string[]; cap: number }[];
  /** `interactionProfile` `contextBudgets` keys that replaced a node default. */
  profileBudgets?: string[];
}

/** `manifest.launch.harness` (design 01a0d348 §3.6). */
export interface LaunchHarnessRecord {
  surface: 'minimal' | 'inherit';
  /**
   * Which link of the precedence chain chose the surface: the launch UI's
   * pick, the node env (`TM8_HARNESS_SURFACE`), a pick inherited from the
   * resumed or parent session, the persona, or the lane default.
   */
  surfaceSource: 'launch' | 'env' | 'inherited' | 'persona' | 'default';
  /** Every installed plugin's fate; absent when the home has no plugins. */
  plugins?: import('./harness-surface.js').HarnessPluginDecisions;
  /** MCP servers the lane runs with (names only; configs are not recorded). */
  mcpServers?: { name: string; source: 'persona' }[];
  /**
   * Every skill the lane's flag-level `skillOverrides` names, with its reason
   * (`laneSkillPlan`). `off` also carries `--no-chrome` as `claude-in-chrome`
   * / `chrome`. `nameOnly` is absent on manifests written before it existed.
   */
  skillOverrides?: {
    off: { name: string; source: import('./harness-surface.js').SkillOverrideSource }[];
    nameOnly?: { name: string; source: 'native-name-only' }[];
    kept?: { name: string; because: 'project-collision' }[];
  };
}

export interface CreateWorkSessionInput {
  spaceId: string;
  teamMemberId: string;
  parentSessionId: string | null;
  taskIds: string[];
  projectId: string | null;
  workdirMode: WorkdirMode;
  /** Server-computed absolute path. The client never supplies this. */
  workdirPath: string;
  baseRef: string | null;
  mode: AgentMode;
  model: string | null;
  agentTool: string | null;
  title: string | null;
  nodeId: string | null;
  confirmUntrusted: boolean;
  clientMutationId: string | null;
}

export interface CreateWorkSessionResult {
  sessionId: string;
  /** The RPC's raw CommandResult, forwarded to the client untouched. */
  commandResult: unknown;
  /** True when the command ledger returned an earlier spawn result. */
  replayed: boolean;
}

// --- vanilla terminals (101) -------------------------------------------------

/**
 * What `SpawnService.startShell` needs, and the shape is the argument.
 *
 * Set this beside {@link SpawnRequest} and read the difference: no
 * `teamMemberId`, no `mode`, no `model`, no `agentTool`, no
 * `interactionProfileId`, no `memoryIds`, no `promptExtra`, no `taskIds`, no
 * `parentSessionId`, no `workdir`. Every one of those is agent configuration,
 * and a vanilla terminal has no agent to configure. They are ABSENT rather than
 * optional-and-ignored, so there is no field for a later edit to start reading.
 */
export interface ShellSessionRequest {
  spaceId: string;
  /** Null ⇒ a projectless terminal in a server-owned scratch directory. */
  projectId: string | null;
  /** Explicit consent for an untrusted project, as spawn's carrier is. */
  confirmUntrusted?: boolean;
  title?: string | null;
  clientMutationId?: string | null;
  cols?: number;
  rows?: number;
}

/**
 * The project read a vanilla terminal needs — and ONLY that.
 *
 * Deliberately not `loadSpawnContext`, which also reads the persona, its
 * ancestor skill chain, and the memory working set across three more queries.
 * None of that exists for a shell session, and calling the big loader with a
 * synthetic team member id to get one field back would be the exact "pretend it
 * is an agent" shape this feature exists to avoid.
 */
export interface ShellSessionContext {
  project: ProjectContext | null;
}

export interface StartShellSessionResult {
  sessionId: string;
  /** The RPC's raw CommandResult, forwarded to the client untouched. */
  commandResult: unknown;
  /** True when the command ledger returned an earlier start result. */
  replayed: boolean;
}

/** What `startShell` answers with once the PTY is live. */
export interface ShellSessionResult {
  sessionId: string;
  /** The resolved login shell. */
  shell: string;
  /** The exact line the PTY ran. */
  command: string;
  cwd: string;
  envVarNames: string[];
  /** True when a live PTY already existed and was reattached to. */
  reused: boolean;
  commandResult: unknown;
}

export interface ResolvedInteractionProfileContext {
  profileId: string | null;
  profileVersion: number | null;
  templateKey: string;
  templateVersion: number;
  source: 'spawn_override' | 'teammate_default' | 'space_default' | 'core_default';
  resolvedHash: string;
  /** Canonical immutable policy snapshot selected by the server resolver. */
  snapshot: Record<string, unknown>;
}

export interface InteractionProfilePinContext extends ResolvedInteractionProfileContext {
  pinRevision: number;
}

export interface TransitionInput {
  sessionId: string;
  status: WorkSessionStatus;
  exitCode?: number | null;
  error?: string | null;
  /**
   * The ending facts (171). Only meaningful with a terminal status; the RPC
   * ignores them otherwise rather than date-stamping an ending that has not
   * happened.
   *
   * `endedReason` is ONE PLAIN-ENGLISH SENTENCE, for a reader who is not a
   * developer. `error` keeps the technical diagnostic — the two are not
   * interchangeable, and the reason must never be a signal name or an exit
   * code.
   */
  endedKind?: WorkSessionEndedKind | null;
  endedReason?: string | null;
}

export interface RecordCommandInput {
  sessionId: string;
  operation: 'execution.prompt' | 'execution.terminate';
  payload: Record<string, unknown>;
  clientMutationId: string | null;
}

/**
 * The stored facts of an existing work_session, as resume needs them. This is
 * what the graph REMEMBERS about the launch — resume re-resolves everything
 * else (persona defaults, project cwd) through the same reads spawn uses, so
 * the two paths cannot drift.
 */
export interface WorkSessionResumeInfo {
  sessionId: string;
  spaceId: string;
  /** Parent work session persisted on the entity hierarchy; the coordinator return path. */
  parentSessionId: string | null;
  /** From the `relates_to` edge; null if the edge is somehow gone. */
  teamMemberId: string | null;
  projectId: string | null;
  taskIds: string[];
  workdirMode: WorkdirMode;
  workdirPath: string | null;
  mode: AgentMode | null;
  model: string | null;
  agentTool: string | null;
  title: string;
  status: WorkSessionStatus;
  /**
   * The PROVIDER-OWNED conversation id — Claude's session uuid (pre-minted at
   * spawn) or Codex's rollout id (captured from ~/.codex/sessions). Null means
   * this session predates capture, or its Codex rollout has not been located
   * yet.
   */
  nativeSessionId: string | null;
  /** Exact CLAUDE_CONFIG_DIR/CODEX_HOME used for the original run. */
  agentConfigDir: string | null;
}

export interface ResumeWorkSessionResult {
  commandResult: unknown;
  replayed: boolean;
}

export interface ResumeRequest {
  sessionId: string;
  clientMutationId?: string | null;
  cols?: number;
  rows?: number;
}

/**
 * The graph, as the spawn flow needs it. Implemented over `Db` in
 * packages/server/src/facade/execution-handlers.ts; faked in tests.
 *
 * Every method takes `auth` explicitly rather than closing over it, because a
 * single GraphPort instance serves every request on the node — a port that
 * captured claims at construction would hand one caller's identity to the next.
 */
/**
 * What a ghost sweep did, and what it could not do — the shape its worktree
 * sibling (`WorktreeReconcileReport`) already has, for the reason that sibling's
 * failures reach the operator at boot and this one's did not.
 */
export interface GhostReconcileReport {
  readonly retired: number;
  /** Empty on a clean sweep. Non-empty means rows were left claiming to be alive. */
  readonly errors: readonly { readonly message: string }[];
}

export interface GraphPort {
  /** Reads. Runs before the session exists. */
  loadSpawnContext(auth: GraphAuth, input: LoadSpawnContextInput): Promise<SpawnContext>;
  /**
   * Whether this launch is link-bound (256, W7p): `auth` is a `link` session
   * or an agent minted under one, OR `agentToken` — the session just minted
   * for the launch — carries a via_link stamp. The second arm is the resume
   * case: a non-link member resuming a work session that ran under a link
   * gets a stamped child in SQL, and the TS policy must follow that stamp,
   * never the resumer's own claims. `GraphAuth` is opaque here, so the graph
   * answers. Such a launch has no member credential rung
   * (`resolveLinkBoundCredentials`). REQUIRED: an optional member would let
   * a graph that forgot it answer "not link-bound" silently, and that answer
   * is the one that opens the member rung.
   */
  isLinkBound(auth: GraphAuth, agentToken: string): Promise<boolean>;
  /**
   * Selection headers for `<context_index>` (design 01a0d348 §2.1), read
   * under the caller's RLS: an id the caller cannot read is simply absent.
   * Optional so a graph without it renders the index from loader rows.
   */
  loadContextHeaders?(auth: GraphAuth, input: { spaceId: string; ids: string[] }): Promise<SelectionHeader[]>;
  /**
   * A dispatcher's roster (integrated design 01a0d348 §8 I8): the space's
   * teammates except `excludeTeamMemberId`, under the caller's RLS, at most
   * `limit` rows with the readable total. Optional: without it a dispatcher's
   * index has no roster and it reads teammates with the CLI, as before.
   */
  loadDispatcherRoster?(
    auth: GraphAuth,
    input: { spaceId: string; excludeTeamMemberId: string; limit: number },
  ): Promise<DispatcherRoster>;
  /**
   * Jev's scores for `memoryIds` from the launch's Ask Jev run
   * (`jev_runs.suggestions.memories`), read under the caller's RLS, with
   * `critical` decided by Jev's own threshold. Empty when the run is
   * unreadable or ranked no memories. Optional: without it, no rank.
   */
  loadMemoryScores?(
    auth: GraphAuth,
    input: { spaceId: string; jevRunId: string; memoryIds: string[] },
  ): Promise<{ entityId: string; score: number; critical: boolean }[]>;
  /** `public.execution_spawn` — work_session row + `working_on` edges, one tx. */
  createWorkSession(auth: GraphAuth, input: CreateWorkSessionInput): Promise<CreateWorkSessionResult>;
  /** The project read behind a vanilla terminal. See {@link ShellSessionContext}. */
  loadShellContext(
    auth: GraphAuth,
    input: { spaceId: string; projectId: string | null },
  ): Promise<ShellSessionContext>;
  /** `public.start_shell_session` (101) — the `session_kind='shell'` row. */
  createShellSession(
    auth: GraphAuth,
    input: ShellSessionRequest & {
      nodeId: string | null;
      /**
       * The project's recorded `working_dir`, already re-validated by the
       * caller. NULL for a projectless terminal, whose directory is named for
       * a session id that does not exist yet — see the migration.
       */
      workdirPath: string | null;
    },
  ): Promise<StartShellSessionResult>;
  /** Resolve the immutable profile selection before launch. */
  resolveInteractionProfile(
    auth: GraphAuth,
    input: { spaceId: string; teamMemberId: string; interactionProfileId?: string | null },
  ): Promise<ResolvedInteractionProfileContext>;
  /** Persist the immutable profile pin against the new work session. */
  recordInteractionProfilePin(
    auth: GraphAuth,
    sessionId: string,
    profile: ResolvedInteractionProfileContext,
  ): Promise<InteractionProfilePinContext>;
  /**
   * Prompt v2 (spec ca8d §2.2): the task's `tm8.entity-context.v2` view, read
   * through the same bounded projection `tm8 entity context <task>` serves and
   * rendered AS THE SPAWNED SESSION'S ACTOR, so `you:true` and every
   * caller-relative field match the agent's own first read. Optional: a graph
   * without it (test fakes, older embedders) degrades the v2 header to "run
   * `tm8 entity context` first" rather than failing the launch.
   */
  loadTaskContextSnapshot?(
    auth: GraphAuth,
    input: { sessionId: string; taskId: string; totalBytes: number },
  ): Promise<Record<string, unknown>>;
  /**
   * The tasks' version and status as they stand NOW, read after
   * `execution_spawn` has started them. `loadSpawnContext` reads before that
   * transition, so its version is one behind for every task the spawn
   * started, and the task turn's `tm8 task tick … --expect-version` then
   * failed the agent's first tick with version_conflict. Optional: a graph
   * without it keeps the pre-spawn values.
   */
  loadTaskVersions?(
    auth: GraphAuth,
    input: { taskIds: string[] },
  ): Promise<Array<{ id: string; version: number; status: string }>>;
  /**
   * R14: retire the agent token of a session whose spawn or resume failed, so
   * `auth_sessions` carries no live token for a session that never ran.
   * Optional: a graph without it leaves the token to its TTL.
   */
  revokeWorkSessionAgentToken?(auth: GraphAuth, sessionId: string): Promise<void>;
  /** Mint a credential bound to this exact work-session/persona pair. */
  issueWorkSessionAgentToken(
    auth: GraphAuth,
    sessionId: string,
    teamMemberId: string,
  ): Promise<string>;
  /**
   * `public.record_session_manifest` — names only, never values (S-redaction).
   *
   * `prompts` carries the two composed launch prompts VERBATIM, because they
   * exist nowhere else once the child process starts: they are appended to its
   * argv and the composer's output is not otherwise retained. Recording them
   * here is what lets a reader later show what the agent was actually told,
   * rather than what re-running today's composer would produce.
   */
  recordManifest(
    auth: GraphAuth,
    sessionId: string,
    manifest: Tm8Manifest,
    envVarNames: string[],
    prompts: { system: string; task: string },
    agentConfigDir: string | null,
  ): Promise<void>;
  /** `public.work_session_transition` — R29's single writer. Never UPDATE directly. */
  transition(auth: GraphAuth, input: TransitionInput): Promise<void>;
  /** Read the stored launch facts of an existing session, for resume. */
  loadWorkSessionForResume(auth: GraphAuth, sessionId: string): Promise<WorkSessionResumeInfo>;
  /**
   * The recorded permission posture of an existing session — the parent half of
   * posture inheritance, and the session's own half on resume.
   *
   * A READ of `session_manifests`, under the caller's claims, because that row
   * is where the resolved posture is already durable; `work_sessions` persists
   * model/mode/agent_tool but has never had a permission column. Resolves
   * `null` when there is no readable manifest — inheritance then simply does
   * not apply, which is the same answer a root session gets.
   */
  loadSessionLaunchPosture(
    auth: GraphAuth,
    sessionId: string,
  ): Promise<SessionLaunchPosture | null>;
  /**
   * `public.execution_resume` — the ONE legal path back from `exited`/`failed`
   * to `spawning`. Enforces persona authorization, the concurrency cap, and
   * clears the previous run's exit evidence, all inside the single-writer guard.
   */
  resumeWorkSession(
    auth: GraphAuth,
    input: { sessionId: string; clientMutationId: string | null; nodeId: string | null },
  ): Promise<ResumeWorkSessionResult>;
  /**
   * `public.record_work_session_usage` (185) — the whole-conversation provider
   * usage read from the agent's own transcript once its process is gone.
   *
   * NOT a transition and never on the transition path: it is written AFTER
   * the ending is recorded, best-effort, by a caller that swallows its own
   * failure. A session whose transcript was already deleted, or lives on
   * another node, simply keeps `usage = NULL` — which the column comment says
   * must render as "never measured", not as zero. Resolves whether a row was
   * written (false = the session row was gone).
   */
  recordWorkSessionUsage(
    auth: GraphAuth,
    sessionId: string,
    usage: WorkSessionUsage,
    source: WorkSessionUsageSource,
  ): Promise<boolean>;
  /**
   * `public.execution_record_native_session` — write-once native-id capture.
   * Resolves `false` when the row already held a DIFFERENT id, which is a
   * capture bug upstream and must be surfaced, never swallowed.
   */
  recordNativeSessionId(
    auth: GraphAuth,
    sessionId: string,
    nativeSessionId: string,
  ): Promise<boolean>;
  /**
   * `public.execution_record_checkout_branch` (107) — the session's lane
   * fact. NOT write-once (a checkout legitimately changes branches; the fact
   * is refreshed opportunistically), and NEVER load-bearing for the launch:
   * callers fire-and-log, because a session that cannot report its branch is
   * degraded, not broken. `null` records a MEASURED absence (no repo,
   * detached HEAD). Resolves whether the stored value actually changed.
   */
  recordCheckoutBranch(
    auth: GraphAuth,
    sessionId: string,
    branch: string | null,
  ): Promise<boolean>;
  /** `public.record_execution_command` — the ledger row for prompt/terminate. */
  recordCommand(auth: GraphAuth, input: RecordCommandInput): Promise<unknown>;
  /**
   * Work sessions THIS node still believes are alive (status not terminal).
   *
   * A read, used only by startup ghost reconciliation. Scoped by `node_id`
   * because a non-terminal session belonging to ANOTHER node may be perfectly
   * alive over there — only the node that owns a PTY can say whether it is gone.
   */
  listNodeActiveSessions(
    auth: GraphAuth,
    nodeId: string,
  ): Promise<Array<{ sessionId: string; status: WorkSessionStatus }>>;

  // --- worktree provisioning (design §4) --------------------------------------
  //
  // Six calls, in saga order. They are separate rather than one `provision()`
  // because each is a distinct crash boundary: the reconciler's whole job is
  // the states you land in when the process dies between two of them, and a
  // port that hid the boundaries would hide the states.
  //
  // NONE of them takes the per-project Git lock. That lock lives in
  // WorktreeManager, OUTSIDE the ledgered transaction, because
  // `internal.ledger_replay` is the first statement of every ledgered door and
  // already holds an advisory lock — nesting beneath it is the documented
  // deadlock (§5.1).

  /**
   * §4.5 step 4 — reserve. Inserts `worktree_allocations` in `preparing` under
   * the caller's pre-generated id. Nothing exists on disk yet; a `preparing`
   * row with no directory is the canonical safe partial (§6.2 row 1).
   */
  reserveWorktreeAllocation(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      nodeId: string;
      path: string;
      branch: string;
      /** §5.2's separate worktree cap. 0 means unbounded. */
      cap: number;
    },
  ): Promise<void>;

  /** The one writer of `worktree_allocations.state`. Saga steps 5-8 and every §6.2 repair. */
  setWorktreeAllocationState(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      state: WorktreeAllocationState;
      failureCode?: string | null;
      failureDetail?: Record<string, unknown> | null;
      /** Bounded-backoff bookkeeping for `cleanup_pending` retries (§5.3). */
      countAttempt?: boolean;
    },
  ): Promise<void>;

  /**
   * §4.7 step 6 — `public.create_worktree`, carrying the node-generated id so
   * the entity and the reservation are the same row's two halves.
   */
  createWorktreeEntity(
    auth: GraphAuth,
    input: {
      worktreeId: string;
      spaceId: string;
      projectId: string;
      path: string;
      branch: string;
      baseRef: string;
      baseCommitOid: string;
      clientMutationId: string | null;
    },
  ): Promise<void>;

  /** §3.4 — one write-capable live session per worktree. Contention is a refusal, never a queue. */
  acquireWorktreeLease(auth: GraphAuth, worktreeId: string, sessionId: string): Promise<void>;
  releaseWorktreeLease(auth: GraphAuth, worktreeId: string): Promise<void>;

  /** The `in_worktree` edge — the mutable association, origin-stamped `system`. */
  linkSessionToWorktree(
    auth: GraphAuth,
    input: { spaceId: string; sessionId: string; worktreeId: string },
  ): Promise<void>;

  /** §6.1 — this node's allocations, with the facts only SQL can answer. */
  listNodeWorktreeAllocations(auth: GraphAuth, nodeId: string): Promise<WorktreeAllocationRow[]>;

  /**
   * `public.projects.working_dir` for one project.
   *
   * Reconciliation needs a repository root to run `git worktree list/remove/
   * prune` against, and an allocation carries only a project id. `null` when
   * the project is gone or unreadable — which narrows the sweep, and must
   * never widen a repair.
   */
  loadProjectWorkingDir(auth: GraphAuth, projectId: string): Promise<string | null>;
}

// --- the manifest ------------------------------------------------------------

/**
 * The composed manifest: what the agent reads at boot, and what the graph
 * records alongside it.
 *
 * RE-AUTHORED, not lifted. Old maestro produced this by shelling out to
 * `maestro manifest generate` — a CLI subprocess that re-fetched every entity
 * over HTTP, wrote a file, and handed the path back through a 60s-timeout pipe.
 * tm8 composes it in-process from a single graph read. Same information, one
 * process, no shared-disk handshake, no partial-write window.
 *
 * The FILE is what the agent reads; the ROW (record_session_manifest) is what
 * the graph knows. Both are written, and neither is derived from the other.
 */
export interface Tm8Manifest {
  manifestVersion: '1';
  /**
   * Which prompt frame this launch was booted with — the analytics tag that
   * splits journals and first-read metrics by version (spec ca8d §6.3). Not
   * the document shape; that is `manifestVersion`. The value comes from
   * `@tm8/prompt`'s `prompt-version.ts`, never a literal here.
   */
  promptVersion: PromptVersion;
  sessionId: string;
  spaceId: string;
  /** RFC3339. Stamped by the composer. */
  generatedAt: string;
  mode: AgentMode;
  /** Where the agent reports back to — the loopback tm8-server. */
  baseUrl: string;

  /**
   * The PERSONA. Named `agent` and shaped to match Phoenix's CLI reader
   * (packages/cli/src/manifest.ts) field-for-field — `teamMemberId` doubles as
   * his default completerIds on task completion.
   *
   * Everything in here is graph-authored free text, which means it is
   * attacker-authorable the moment a space has a second member. The composer
   * therefore emits DATA and never pre-formats a prompt fragment: the CLI's
   * prompt composer escapes it at interpolation time, and formatting it here
   * would slip text past that escaping.
   */
  agent: {
    teamMemberId: string;
    name: string;
    avatar: string | null;
    role: string;
    identity: string;
    memory: unknown[];
    capabilities: Record<string, unknown>;
    commandPermissions: Record<string, unknown>;
  };

  /**
   * The LAUNCH POSTURE — how this session was started, as resolved by the
   * precedence chain. Deliberately NOT called `agent`: that key belongs to the
   * persona above, and the two carrying the same name in different halves of
   * the system is exactly how an agent boots with an empty identity.
   */
  launch: {
    tool: string;
    model: string | null;
    permissionMode: PermissionMode;
    accessMode: AccessMode;
    reasoningEffort: ReasoningEffort | null;
    /**
     * Deprecated common source. Null when providers differ or run in auto.
     */
    credentialSource: CredentialSource | null;
    /** Provider-specific choices, recorded for debug, child inheritance and resume. */
    credentialSources: ResolvedCredentialSources;
    /**
     * The exact space credential for every provider whose source is `space`,
     * and for no other (206's `record_session_manifest` checks both ways and
     * records `session_space_credentials` from it). Absent when there are none.
     */
    spaceCredentialIds?: Partial<Record<SpaceCredentialProvider, string>>;
    /**
     * What each provider this launch authenticates actually ran on (D9): the
     * auto choice resolved, so a node-key launch is visible as one.
     */
    effectiveCredentialSources?: Partial<Record<SpaceCredentialProvider, CredentialSource>>;
    /** §6c: how each space credential was picked (W10b); absent when none. */
    spaceCredentialPicks?: Partial<Record<SpaceCredentialProvider, SpaceCredentialPick>>;
    /** Effective shell-command networking, independent of filesystem posture. */
    commandNetwork: CommandNetworkPolicy;
    /**
     * Set when `permissionMode` asked for OS-level confinement and the node
     * could not provide it, so the agent was launched UNCONFINED. Holds the
     * one-sentence reason; null when the posture was honoured as written.
     *
     * It exists because the manifest is otherwise a liar in exactly this case:
     * `permissionMode` records what was ASKED FOR, and on a node whose sandbox
     * cannot start that is not what happened. Reading the two fields together
     * is the only way to tell a confined codex session from an unconfined one,
     * and before this there was no way at all — the deployed node had codex
     * agents running with no filesystem confinement and no approval gate, and
     * nothing in the graph, the manifest or the session row said so.
     */
    sandboxDegraded?: string | null;
    /** The exact shell command line the PTY runs. Reproducibility, not decoration. */
    command: string;
    /** The Ask Jev run this launch came from, when it came from one. Absent otherwise — never null. */
    jevRunId?: string;
    /**
     * The launch's `selection` and `selectionReasons`, exactly as requested.
     * Absent when the launch sent none. Resume replays them, so a resumed
     * session carries the same sets and the same audit as its launch.
     */
    selection?: SpawnSelection;
    selectionReasons?: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>>;
    /**
     * This launch's override of the profile's `contextBudgets`, exactly as
     * requested (`ExecutionSpawnInput.contextBudgets`). Absent when none was
     * sent. Resume replays it.
     */
    contextBudgets?: ContextBudgets;
    /**
     * The launch UI's harness pick (or the one a resume replays), when there
     * was one; claude-code lanes only. See `ResolvedLaunchConfig.harnessChoice`.
     */
    harnessChoice?: { surface?: 'minimal' | 'inherit'; plugins?: string[] };
    /**
     * What the lane's harness actually turned on and off, and why (design
     * 01a0d348 §3.6). Written for every claude-code lane; absent for other
     * tools, whose surface is not managed.
     */
    harness?: LaunchHarnessRecord;
    /**
     * Set by the workspace-trust watchdog when this lane booted into Claude
     * Code's trust dialog despite the seeded entry and tm8 answered it through
     * the PTY. Absent otherwise — never false. Written to the manifest FILE
     * only; the recorded manifest row is the immutable launch record.
     */
    trustRecovered?: true;
  };

  session: {
    title: string;
    /** Absolute, server-computed, graph-sourced. */
    workingDirectory: string;
    workdirMode: WorkdirMode;
  };

  project: { id: string; name: string; workingDir: string; trust: string } | null;

  /** Immutable interaction-profile provenance resolved and pinned at launch. */
  interactionProfile: InteractionProfilePinContext;

  tasks: TaskContext[];

  /** Equipped skill metadata and explicit load pointers, never bodies. */
  skills: ManifestSkillContext[];
  /**
   * The rendered `<context_index>` (design 01a0d348 §2), after the byte-budget
   * trim, when the launch's context-index switch was on. It replaces the
   * `<skills>` block in both prompt frames; `skills` still lists the kept
   * skills for every other reader. Absent: switch off.
   */
  contextIndex?: PromptContextIndex;
  effectiveSkills?: EffectiveSkills;
  /** Names omitted by relevance selection or the serialized index byte budget. */
  droppedSkills?: string[];

  /**
   * The launch-context audit (design 01a0d348 §6). Only `memoryIds` so far:
   * the memory entities injected into `agent.memory`, in injection order.
   *
   * PREFIX RULE, which readers rely on: the first `memoryIds.length` entries of
   * `agent.memory` are these memories, in this order; any entries after them
   * are the legacy jsonb remainder and have no id. An extension that breaks
   * this (e.g. recording an id whose text was dropped) must record the
   * pairing explicitly instead. `[]` means recorded and none injected; absent
   * means the manifest predates this field.
   */
  context?: ManifestContext;

  /**
   * Present for coordinated modes — the concrete return path, and since 176
   * WHAT it is. `kind` is always written (never inferred from presence), so a
   * reader can tell "a work session" from "a manifest that predates the field".
   */
  coordinator: { sessionId: string; kind: CoordinatorKind; displayName?: string } | null;

  /** Coordinator directive delivery is post-G1A; always null in this wave. */
  directive: { subject: string; message: string; fromSessionId: string } | null;

  /** Extra prompt context from `ExecutionSpawnInput.promptExtra`. */
  promptExtra: string | null;
}

// --- SpawnService inputs/outputs ---------------------------------------------

/** `ExecutionSpawnInput` plus the things only the server knows. */
export interface SpawnRequest {
  spaceId: string;
  teamMemberId: string;
  /** Session that invoked this spawn; null/absent means a human-launched root. */
  parentSessionId?: string | null;
  taskIds?: string[];
  projectId?: string | null;
  workdir?: { mode?: WorkdirMode; baseRef?: string | null };
  interactionProfileId?: string | null;
  mode?: AgentMode | null;
  model?: string | null;
  agentTool?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  accessMode?: AccessMode | null;
  /** Deprecated global compatibility carrier; provider keys below win. */
  credentialSource?: CredentialSource | null;
  /**
   * Independent provider choices; an absent key means auto/inherit. A member
   * source can only resolve the CALLER'S OWN RLS-scoped credential.
   */
  credentialSources?: CredentialSources | null;
  /**
   * A pinned space credential per provider. Valid ONLY for a provider this
   * same request sets to `space`; with any other source it is refused.
   */
  spaceCredentialIds?: Partial<Record<SpaceCredentialProvider, string>> | null;
  title?: string | null;
  promptExtra?: string | null;
  /** Spawn-time memory hand-off (D3a); see `LoadSpawnContextInput.memoryIds`. */
  memoryIds?: string[];
  /** The exact memory, skill and reference sets; see `LoadSpawnContextInput.selection`. */
  selection?: SpawnSelection;
  /** Why unselected groups kept their defaults; audit-only (`ExecutionSpawnInput.selectionReasons`). */
  selectionReasons?: Partial<Record<SpawnSelectionGroup, SpawnSelectionDefaultReason>>;
  /** This launch's `contextBudgets` override (`ExecutionSpawnInput.contextBudgets`). */
  contextBudgets?: ContextBudgets;
  /**
   * Set by resume only, never from the wire: the recorded selection could not
   * be parsed, so every group loaded its defaults. Audited as `replay-invalid`.
   */
  selectionReplayInvalid?: true;
  /**
   * The Ask Jev run this launch came from. Written to the manifest as
   * `launch.jevRunId` and otherwise never interpreted by execution.
   */
  jevRunId?: string;
  /**
   * The launch UI's harness pick for a claude-code lane (`ExecutionSpawnInput`
   * carries the contract). Outranks the node env and the persona; recorded as
   * `launch.harnessChoice`. Absent means no pick.
   */
  harnessSurface?: 'minimal' | 'inherit';
  /** The launch UI's plugin pick: REPLACES the persona's list for this launch. */
  plugins?: string[];
  /** S12: untrusted projects require per-spawn consent. */
  confirmUntrusted?: boolean;
  /**
   * The recorded launch posture to inherit, INSTEAD of reading the parent's.
   * A server-side spawn on another session's behalf (Forms W2 spawn_new) must
   * never exceed THAT session's access mode or credentials, and its parent may
   * have launched wider. `undefined` keeps the parent inheritance; `null`
   * inherits nothing.
   */
  inheritPosture?: SessionLaunchPosture | null;
  /**
   * Text appended to the composed first user turn, after the task assignment
   * (Forms W2: the form_response envelope a spawned session starts with).
   * Called once the session id exists, with the bytes the turn has left under
   * the combinedInitialInjection budget; the result must fit them.
   */
  firstTurnAppendix?: (sessionId: string, maxBytes: number) => string;
  clientMutationId?: string | null;
  /** Terminal geometry from the browser, so the agent's TUI boots at the right width. */
  cols?: number;
  rows?: number;
}

export interface SpawnResult {
  sessionId: string;
  manifestPath: string;
  manifest: Tm8Manifest;
  command: string;
  cwd: string;
  /** Names only — values are never returned, logged or recorded. */
  envVarNames: string[];
  reused: boolean;
  commandResult: unknown;
}

/** Raised for every spawn-flow failure that has a contract error code. */
export class SpawnError extends Error {
  constructor(
    message: string,
    /** Maps to the contract error taxonomy in the handler layer. */
    readonly code:
      | 'invalid_input'
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'not_implemented'
      | 'internal',
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SpawnError';
  }
}
