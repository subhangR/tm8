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
import type {
  EntityId,
  ExecutionSpawnInput,
  InteractionProfileStatus,
  ProjectId,
  SpawnWorkdir,
} from '@tm8/contract';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

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
    models: LAUNCH_MODEL_CATALOG
      .filter((entry) => entry.agentTool === 'claude-code')
      .map((entry) => ({ id: entry.model, label: entry.label, note: entry.note })),
  },
  {
    id: 'codex',
    label: 'Codex',
    models: LAUNCH_MODEL_CATALOG
      .filter((entry) => entry.agentTool === 'codex')
      .map((entry) => ({ id: entry.model, label: entry.label, note: entry.note })),
  },
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

export const ADDITIONAL_PROJECTS_UNAVAILABLE_REASON =
  'Extra project associations are not wired yet: they are in_project edges, and the facade seam has no edge-creating command. The first project is the launch root and DOES take effect.';

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

/** Keep target construction in the launch domain so rendering code never branches on entity vocabulary. */
export function defaultLaunchTarget(projectId: ProjectId | null | undefined): LaunchTarget {
  return projectId ? { kind: 'project', projectId } : { kind: 'scratch' };
}

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

/**
 * A profile the launch may pin (D51.3 / T2-4 status honesty).
 *
 * Only `active` profiles are SELECTABLE. `draft` and `retired` still RENDER,
 * disabled-with-reason — a profile that exists and cannot be used is a fact the
 * viewer needs, and hiding it makes the list silently disagree with the
 * Interaction Profiles view where the same rows are visible.
 */
export interface LaunchProfileOption {
  profileId: EntityId;
  label: string;
  status: InteractionProfileStatus;
  /** The version that would be pinned, shown because pinning is immutable. */
  version?: number | null;
  /** Why it cannot be picked, when it cannot. */
  unavailableReason?: string;
}

export const PROFILE_STATUS_REASON: Readonly<Record<InteractionProfileStatus, string | null>> = {
  active: null,
  draft: 'draft — not activated yet, so it cannot govern a session',
  retired: 'retired — kept for the sessions that already pinned it, not available for new ones',
};

/** Only `active` may be pinned. The other two are visible and refused. */
export function profileSelectable(option: LaunchProfileOption): boolean {
  return option.status === 'active';
}

export function profileRefusal(option: LaunchProfileOption): string | null {
  return option.unavailableReason ?? PROFILE_STATUS_REASON[option.status];
}

/**
 * T2-4's immutability law, rendered BEFORE commit rather than discovered after.
 * A profile pinned at launch governs the session for its whole life even if the
 * profile is edited or retired later — which is exactly the kind of consequence
 * that must be visible at the moment it binds, not in a changelog.
 */
export const PROFILE_PINNED_CAPTION =
  'Pinned at launch: this session keeps this profile version for its whole life, even if the profile is edited or retired later.';

/**
 * One step of the resolution chain. D51.3 requires the CHAIN to be shown, not
 * just its winner — an inherited default and a deliberate pick look identical
 * once resolved, and only the chain distinguishes them.
 */
export interface ProfileChainStep {
  source: Exclude<ProfileResolution['source'], 'none'>;
  profileId: EntityId | null;
  label: string;
}

/**
 * Resolve space → teammate → explicit, later steps winning. Returns the whole
 * chain alongside the outcome so a surface can render both; `effectiveIndex` is
 * -1 when nothing in the chain supplied a profile.
 */
export function resolveProfileChain(chain: readonly ProfileChainStep[]): {
  resolution: ProfileResolution;
  chain: readonly ProfileChainStep[];
  effectiveIndex: number;
} {
  let index = -1;
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].profileId !== null) index = i;
  }
  const winner = index === -1 ? null : chain[index];
  return {
    chain,
    effectiveIndex: index,
    resolution: winner
      ? { profileId: winner.profileId, label: winner.label, source: winner.source }
      : { profileId: null, label: '', source: 'none' },
  };
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

/** Launch resource view models hydrated from the active seam. */
export interface LaunchTeammate {
  id: string;
  name: string;
  initial: string;
  model: string;
  agentTool: string;
  owner: string;
  defaultProfileId?: string;
  liveSessions?: number | null;
}

export interface LaunchProject {
  id: string;
  name: string;
  trusted: boolean;
  detail: string;
  reason?: string;
  scratch?: boolean;
  selectedByDefault?: boolean;
}

export interface LaunchProfile {
  id: string;
  name: string;
  version: number;
  status: InteractionProfileStatus;
  isSpaceDefault?: boolean;
  isServerDefault?: boolean;
  /** Safe launch-time presentation; profiles never grant these operations. */
  templateKey: string;
  contentSurfaces: readonly ['terminal', 'chat'];
  initialContentSurface: 'terminal' | 'chat';
}

/**
 * The only static interaction template shipped by the current node. Active
 * profiles are validated against this closed registry before launch, so these
 * are safe presentation facts rather than inferred permissions.
 */
export const CORE_CHAT_LAUNCH_PRESENTATION = Object.freeze({
  templateKey: 'tm8.chat.core',
  contentSurfaces: Object.freeze(['terminal', 'chat']) as readonly ['terminal', 'chat'],
  initialContentSurface: 'chat' as const,
});

/**
 * `TM8_SESSION_CAP=unlimited` reports its total as int4's maximum, because the
 * `execution.spawn` RPC takes an `integer` cap and has no way to say "no limit".
 * Rendered literally that reads "2147483647 of 2147483647 session slots free",
 * which looks like a bug rather than a configuration. Show the live count and
 * name the state instead — the number that still carries information is `used`.
 *
 * The threshold is a large FLOOR rather than an equality test on int4-max: the
 * operator may equally have written `TM8_SESSION_CAP=100000`, which is the same
 * intent expressed with a number, and should read the same way.
 */
const EFFECTIVELY_UNLIMITED_SLOTS = 100_000;

export function describeCapacity(c: LaunchCapacity): string {
  if (c.slotsTotal >= EFFECTIVELY_UNLIMITED_SLOTS) {
    const used = c.slotsTotal - c.slotsFree;
    return `${used} live · no session limit`;
  }
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
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  accessMode: 'safe' | 'acceptEdits' | 'auto' | 'plan' | 'fullAccess' | null;
  mode: LaunchMode;
  target: LaunchTarget;
  /**
   * D51.4 — additional project associations beyond the launch root.
   *
   * ADDITIVE on purpose: `target` remains the first pick / launch root / initial
   * cwd, which spawn genuinely performs via `projectId`. These extras are
   * `in_project` EDGES, and the stamped seam has no edge-creating command — so
   * they are collected, rendered, and REFUSED with the reason, never silently
   * accepted as if they would take effect. §10.7 register class.
   */
  additionalProjectIds?: readonly ProjectId[];
  /** Set only when the viewer has explicitly consented to an untrusted root. */
  confirmUntrusted?: true;
  interactionProfileId?: EntityId;
  promptExtra?: string | null;
}

export type LaunchRefusal = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Access mode — the quick cycle
// ---------------------------------------------------------------------------

export type LaunchAccessMode = NonNullable<LaunchConfig['accessMode']>;

/**
 * The cycle behind the quick access toggle, in escalating order.
 *
 * `null` is the FIRST step and a real one: it means "whatever the teammate and
 * the node already decided", which is not the same statement as any of the
 * five explicit postures — even `auto`, which is where an un-pinned launch
 * currently LANDS but not what it SAYS. Dropping it would make merely clicking
 * twice pin a posture the viewer never chose — the same silent-override failure
 * `defaultConfigFor` avoids by seeding `accessMode: null`.
 */
export const ACCESS_MODE_CYCLE: readonly (LaunchAccessMode | null)[] = [
  null,
  'plan',
  'safe',
  'acceptEdits',
  'auto',
  'fullAccess',
];

const ACCESS_MODE_LABELS: Record<LaunchAccessMode, { short: string; full: string }> = {
  safe: { short: 'Safe', full: 'Safe · ask for untrusted actions' },
  acceptEdits: { short: 'Accept edits', full: 'Accept edits · workspace write' },
  auto: { short: 'Auto', full: 'Auto · run what is safe, escalate the rest' },
  plan: { short: 'Plan', full: 'Plan · read only' },
  fullAccess: { short: 'Bypass', full: 'Full access · bypass safeguards' },
};

/** Short chip text. Inherit says so rather than naming a posture it is not. */
export function accessModeLabel(mode: LaunchAccessMode | null): string {
  return mode ? ACCESS_MODE_LABELS[mode].short : 'Default';
}

/** The sentence, for a title/aria description. */
export function describeAccessMode(mode: LaunchAccessMode | null): string {
  return mode
    ? ACCESS_MODE_LABELS[mode].full
    : 'Default · the teammate and node decide';
}

/** Next step in the cycle. Unknown values restart it rather than sticking. */
export function nextAccessMode(mode: LaunchAccessMode | null): LaunchAccessMode | null {
  const at = ACCESS_MODE_CYCLE.indexOf(mode ?? null);
  return ACCESS_MODE_CYCLE[(at + 1) % ACCESS_MODE_CYCLE.length] ?? null;
}

/** The launch defaults for a teammate — its recorded tool and model win. */
export function defaultConfigFor(teammate: {
  id: EntityId;
  agentTool?: string | null;
  model?: string | null;
}, defaultProjectId?: ProjectId | null): LaunchConfig {
  const toolId = teammate.agentTool ?? null;
  return {
    teamMemberId: teammate.id,
    agentToolId: toolId,
    // The teammate's recorded model wins over this UI's first option: the
    // record is what has been running, and overriding it silently would make
    // the quick config change behaviour just by being opened.
    model: teammate.model ?? null,
    // Quick launch does not expose these advanced controls, so null preserves
    // the teammate/node defaults instead of silently overriding them.
    reasoningEffort: null,
    accessMode: null,
    mode: 'worker',
    target: defaultLaunchTarget(defaultProjectId),
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
  if (!config.agentToolId) {
    return { ok: false, reason: 'This teammate has no persisted agent tool, so the node cannot build its launch command.' };
  }
  const tool = agentTool(config.agentToolId);
  if (!tool) {
    return { ok: false, reason: `This node does not support the persisted agent tool “${config.agentToolId}”.` };
  }
  if (!config.model) {
    return { ok: false, reason: `This teammate has no persisted model for ${tool.label}.` };
  }
  if (!tool.models.some((model) => model.id === config.model)) {
    return {
      ok: false,
      reason: `Model “${config.model}” is not a truthful ${tool.label} launch option on this node.`,
    };
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
  if (!config.teamMemberId) {
    throw new Error('cannot build execution.spawn input without a teammate');
  }
  const target = config.target;
  // Scratch is the ABSENCE of a project, per the contract's own comment —
  // omitted/null projectId IS the projectless session. No invented flag.
  // Narrowed on the discriminant rather than a boolean, so the projectId and
  // the workdir mode cannot disagree: they are read from one narrowing.
  const workdir: SpawnWorkdir = target.kind === 'scratch' ? { mode: 'scratch' } : { mode: 'project' };

  const input: ExecutionSpawnInput = {
    clientMutationId: args.clientMutationId,
    spaceId: args.spaceId,
    teamMemberId: config.teamMemberId,
    projectId: target.kind === 'scratch' ? null : target.projectId,
    workdir,
    mode: config.mode,
    model: config.model,
    agentTool: config.agentToolId,
  };
  if (config.reasoningEffort) input.reasoningEffort = config.reasoningEffort;
  if (config.accessMode) input.accessMode = config.accessMode;
  if (args.taskIds?.length) input.taskIds = [...args.taskIds];
  if (args.title) input.title = args.title;
  if (config.interactionProfileId) input.interactionProfileId = config.interactionProfileId;
  if (config.promptExtra) input.promptExtra = config.promptExtra;
  // Only carried when consent was actually given — the contract types it as
  // `true`, so an absent field and a false one are not the same statement.
  if (config.confirmUntrusted) input.confirmUntrusted = true;
  return input;
}

let launchMutationSequence = 0;

/** Fresh per deliberate submit; callers keep the returned value only when
 * retrying the same transport attempt. */
export function newLaunchMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `launch:${crypto.randomUUID()}`;
  }
  launchMutationSequence += 1;
  return `launch:${Date.now().toString(36)}:${launchMutationSequence.toString(36)}`;
}
