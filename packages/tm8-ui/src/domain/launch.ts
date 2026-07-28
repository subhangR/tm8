/**
 * THE LAUNCH DATA LAYER (D44) — Run's configuration as registry data.
 *
 * Every task row's Run opens a launch configuration: teammate, model, project,
 * mode. This module owns the DATA and the contract-shaped submit; it renders
 * nothing and imports no seam. The interaction shape is the maestro
 * TaskTile/LaunchConfigDropdown pattern (row Run → inline quick config → full
 * sheet) as a UX reference; the T5-5 canvas is the DESIGN authority for the
 * sheet itself.
 *
 * The whole point of it being data: `buildSpawnInput` produces a verbatim
 * `ExecutionSpawnInput`, so the quick config and the full sheet submit the SAME
 * contract object through `seam.commands.spawn`. Two surfaces, one builder, no
 * chance of them drifting into two different spawn semantics.
 *
 * L6 runs through the whole file: a launch that cannot proceed says WHY, with
 * the mechanism named, and never renders an enabled control over a refusal.
 */
import type { EntityId, ExecutionSpawnInput, ProjectId, SpawnWorkdir } from '@tm8/contract';

// ---------------------------------------------------------------------------
// Agent tools and models
// ---------------------------------------------------------------------------

/**
 * The tool that runs the session. `agentTool` is a free string in the contract
 * (`ExecutionSpawnInput.agentTool?: string | null`), so this list is the UI's
 * offering, not a contract enum — a node may accept tools not named here, and
 * a teammate's recorded tool is honoured even if it is absent from this list.
 */
export interface AgentToolDef {
  id: string;
  label: string;
  models: readonly ModelDef[];
}

export interface ModelDef {
  id: string;
  label: string;
  /** Shown beside the label; the honest note about what picking this costs. */
  note?: string;
}

export const AGENT_TOOLS: readonly AgentToolDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    models: [
      { id: 'claude-fable-5', label: 'Fable 5', note: 'default for coordinators' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'fastest' },
    ],
  },
  { id: 'echo-agent', label: 'Echo agent', models: [{ id: 'echo', label: 'Echo', note: 'no model — replays input' }] },
];

export function agentTool(id: string | null | undefined): AgentToolDef | null {
  return AGENT_TOOLS.find((t) => t.id === id) ?? null;
}

/**
 * The models offered for a tool. A tool this UI does not know returns an EMPTY
 * list rather than a default one — offering a model the tool may not accept is
 * the kind of confident guess that produces a refusal at spawn time.
 */
export function modelsFor(toolId: string | null | undefined): readonly ModelDef[] {
  return agentTool(toolId)?.models ?? [];
}

// ---------------------------------------------------------------------------
// Session mode
// ---------------------------------------------------------------------------

/** `ExecutionSpawnInput['mode']` verbatim — the contract's own union. */
export type LaunchMode = NonNullable<ExecutionSpawnInput['mode']>;

export interface LaunchModeDef {
  id: LaunchMode;
  label: string;
  description: string;
}

export const LAUNCH_MODES: readonly LaunchModeDef[] = [
  { id: 'worker', label: 'Worker', description: 'Works the task alone.' },
  { id: 'coordinator', label: 'Coordinator', description: 'Spawns and directs its own workers.' },
  {
    id: 'coordinated-worker',
    label: 'Coordinated worker',
    description: 'Works under a coordinator that already exists.',
  },
  {
    id: 'coordinated-coordinator',
    label: 'Coordinated coordinator',
    description: 'Coordinates beneath another coordinator.',
  },
];

// ---------------------------------------------------------------------------
// Projects, trust, and the scratch root
// ---------------------------------------------------------------------------

/**
 * T5-5 draws the trust gate as a per-project state with its own copy:
 * "untrusted — can't host sessions · trust it in Node settings ↗". Trust is
 * SERVER truth; this shape carries it plus the honest wording, exactly as
 * `capabilityReasons` does for entity capabilities.
 */
export interface LaunchProjectOption {
  projectId: ProjectId;
  name: string;
  /** Server truth. `false` ⇒ the project cannot host a session at all. */
  trusted: boolean;
  /** Why it cannot, when it cannot. Rendered as the disabled reason (L6). */
  untrustedReason?: string;
}

export const UNTRUSTED_REASON =
  "untrusted — can't host sessions · trust it in Node settings";

/**
 * The projectless option. `ExecutionSpawnInput.projectId` omitted/null means a
 * scratch session in a server-managed temp dir, so scratch is not a special
 * case in the submit — it is the ABSENCE of a project, which is why it needs
 * no separate flag.
 */
export const SCRATCH_OPTION = {
  id: 'scratch' as const,
  label: 'Scratch',
  description: 'No project — a server-managed temporary directory.',
};

export type LaunchTarget = { kind: 'project'; projectId: ProjectId } | { kind: 'scratch' };

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * T5-5 shows the resolved profile rather than a picker alone: the viewer sees
 * WHICH profile will govern the session and WHERE it came from, so an
 * inherited default is never mistaken for an explicit choice.
 */
export interface ProfileResolution {
  profileId: EntityId | null;
  label: string;
  /** How this profile was arrived at — the provenance, not just the value. */
  source: 'explicit' | 'teammate-default' | 'space-default' | 'none';
}

export function describeProfile(resolution: ProfileResolution): string {
  switch (resolution.source) {
    case 'explicit':
      return `${resolution.label} · chosen for this launch`;
    case 'teammate-default':
      return `${resolution.label} · this teammate's default`;
    case 'space-default':
      return `${resolution.label} · the space default`;
    case 'none':
    default:
      // Honest hollow (D7 vocabulary): no profile is a real state, not an error.
      return 'no interaction profile — the node default applies';
  }
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * T5-5's own note: "Capacity before commitment. The footer states slots free
 * BEFORE launch; the refusal card below covers the race where they vanish
 * mid-flight." So capacity is presented twice, for two different truths — a
 * pre-launch statement and a post-refusal explanation — and the second is not
 * a failure of the first.
 */
export interface LaunchCapacity {
  slotsFree: number;
  slotsTotal: number;
}

export function describeCapacity(c: LaunchCapacity): string {
  return `${c.slotsFree} of ${c.slotsTotal} session slots free`;
}

// ---------------------------------------------------------------------------
// Per-teammate launch state (D46 — corrected)
// ---------------------------------------------------------------------------

/**
 * T5-5 draws "● 1 live session already" on a teammate row. The link from a
 * work_session to the persona it runs as is a `relates_to` EDGE written in the
 * spawn transaction — it is NOT on the state arm, and it is NOT `createdBy`.
 *
 * `createdBy` records the INITIATING ACTOR: normally the human member who
 * clicked Run, and under `can_act_as` delegation possibly a DIFFERENT
 * team_member than the persona. So a `createdBy`-based derivation is wrong in
 * both directions — permanently hollow for ordinary sessions, and wrongly
 * attributed for delegated ones (bridge, tree-verified, 2026-07-28).
 *
 * Correct derivation: the relates_to edge join (the domain store's edge index,
 * or `seam.connections()`) INTERSECTED with the liveness verdict. Never a
 * count of records that merely claim to be running.
 */
export interface TeammateLaunchState {
  teamMemberId: EntityId;
  /**
   * Live sessions running AS this persona. `null` means UNKNOWABLE right now —
   * the edges are not hydrated — and renders hollow-with-reason, never as 0.
   * Zero and unknown are different facts and the chip must not merge them.
   */
  liveSessionCount: number | null;
  /** Why the count is absent, when it is. */
  hollowReason?: string;
}

export const EDGES_NOT_HYDRATED_REASON =
  'session-to-teammate links are not loaded yet — the count is unknown, not zero';

export function describeTeammateLoad(state: TeammateLaunchState): string {
  if (state.liveSessionCount === null) return state.hollowReason ?? EDGES_NOT_HYDRATED_REASON;
  if (state.liveSessionCount === 0) return 'no live sessions';
  return `● ${state.liveSessionCount} live session${state.liveSessionCount === 1 ? '' : 's'} already`;
}

// ---------------------------------------------------------------------------
// The configuration, and its refusals
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  teamMemberId: EntityId | null;
  agentToolId: string | null;
  model: string | null;
  mode: LaunchMode;
  target: LaunchTarget;
  /** Set only when the viewer has explicitly consented to an untrusted root. */
  confirmUntrusted?: true;
  interactionProfileId?: EntityId;
  promptExtra?: string | null;
}

export type LaunchRefusal = { ok: true } | { ok: false; reason: string };

/** The launch defaults for a teammate — its recorded tool and model win. */
export function defaultConfigFor(teammate: {
  id: EntityId;
  agentTool?: string | null;
  model?: string | null;
}): LaunchConfig {
  const toolId = teammate.agentTool ?? AGENT_TOOLS[0].id;
  return {
    teamMemberId: teammate.id,
    agentToolId: toolId,
    // The teammate's recorded model wins over this UI's first option: the
    // record is what has been running, and overriding it silently would make
    // the quick config change behaviour just by being opened.
    model: teammate.model ?? modelsFor(toolId)[0]?.id ?? null,
    mode: 'worker',
    target: { kind: 'scratch' },
  };
}

/**
 * Whether this configuration may be submitted. Every refusal names the
 * MECHANISM, because "Run is greyed out" with no reason is the failure L6
 * exists to prevent.
 */
export function canLaunch(
  config: LaunchConfig,
  ctx: { projects: readonly LaunchProjectOption[]; capacity?: LaunchCapacity },
): LaunchRefusal {
  if (!config.teamMemberId) {
    return { ok: false, reason: 'Pick a teammate — a session runs as a persona, never anonymously.' };
  }
  const target = config.target;
  if (target.kind === 'project') {
    const project = ctx.projects.find((p) => p.projectId === target.projectId);
    if (!project) {
      return {
        ok: false,
        reason: 'That project is not linked to this space, so it cannot host a session here.',
      };
    }
    if (!project.trusted && !config.confirmUntrusted) {
      return { ok: false, reason: project.untrustedReason ?? UNTRUSTED_REASON };
    }
  }
  if (ctx.capacity && ctx.capacity.slotsFree <= 0) {
    return {
      ok: false,
      reason: `No session slots free (${describeCapacity(ctx.capacity)}). Terminate a session or wait for one to exit.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The submit — contract-shaped, verbatim
// ---------------------------------------------------------------------------

/**
 * Build the `ExecutionSpawnInput` the seam takes. BOTH the inline quick config
 * and the full T5-5 sheet call this, so the two surfaces cannot drift into
 * different spawn semantics.
 *
 * `clientMutationId` is caller-supplied by consensus (§10.1) so the store can
 * journal the optimistic row before the promise settles.
 */
export function buildSpawnInput(args: {
  clientMutationId: string;
  spaceId: string;
  config: LaunchConfig;
  taskIds?: readonly EntityId[];
  title?: string;
}): ExecutionSpawnInput {
  const { config } = args;
  const target = config.target;
  // Scratch is the ABSENCE of a project, per the contract's own comment —
  // omitted/null projectId IS the projectless session. No invented flag.
  // Narrowed on the discriminant rather than a boolean, so the projectId and
  // the workdir mode cannot disagree: they are read from one narrowing.
  const workdir: SpawnWorkdir = target.kind === 'scratch' ? { mode: 'scratch' } : { mode: 'project' };

  const input: ExecutionSpawnInput = {
    clientMutationId: args.clientMutationId,
    spaceId: args.spaceId,
    teamMemberId: config.teamMemberId as EntityId,
    projectId: target.kind === 'scratch' ? null : target.projectId,
    workdir,
    mode: config.mode,
    model: config.model,
    agentTool: config.agentToolId,
  };
  if (args.taskIds?.length) input.taskIds = [...args.taskIds];
  if (args.title) input.title = args.title;
  if (config.interactionProfileId) input.interactionProfileId = config.interactionProfileId;
  if (config.promptExtra) input.promptExtra = config.promptExtra;
  // Only carried when consent was actually given — the contract types it as
  // `true`, so an absent field and a false one are not the same statement.
  if (config.confirmUntrusted) input.confirmUntrusted = true;
  return input;
}
