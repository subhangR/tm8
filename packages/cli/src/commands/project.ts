/**
 * `tm8 project …` — ProjectResources, their Space links, and artifact
 * attribution (§4.9, plus the additive A04 repair row).
 *
 * A ProjectResource is NOT an entity. It is a node-level configuration record
 * (repo + working directory + spawn defaults) that is LINKED into Spaces many
 * to many, and each active link materializes a separate, restricted `project`
 * ENTITY inside that Space. Those are two different identifier domains and this
 * file refuses to blur them:
 *
 *   projectId       — the ProjectResource. Node-level. What every `project`
 *                     command takes as its argument.
 *   projectEntityId — the per-Space projection entity. Space-level. What graph
 *                     commands (`entity get`, edges, `--attach-to`) address.
 *
 * `project link` is the one place both exist at once, so it renders both, names
 * both, and NEVER prints one where the other belongs — including when the node
 * answers without the projection id, where it says exactly that instead of
 * quietly reusing the resource id. Calling a ProjectResource id a "project
 * entity id" sends an operator to `entity get` with an id that will 404, and
 * the reverse silently attributes work to the wrong Space.
 *
 * WHAT THIS FILE VALIDATES LOCALLY, AND WHY EACH CHECK IS NOT INVENTED:
 *  - `--working-dir` must be absolute and free of `..`. That is the shipped
 *    column constraint verbatim (`check (working_dir like '/%' and working_dir
 *    not like '%..%')`), and failing it locally as exit 2 beats a constraint
 *    violation the caller has to decode.
 *  - `--trust` and `--default-mode` are closed sets from the contract's own
 *    unions; an unlisted value is named against the set rather than sent.
 *  - §7.5 destructive confirmation: `project unlink` always needs `--yes`, and
 *    `project update` needs it EXACTLY when `--working-dir` is supplied. Not
 *    for a rename, not for a trust change — §7.5 names working-directory
 *    relocation specifically, and a `--yes` demanded where the doc does not ask
 *    for one trains callers to pass it reflexively.
 *
 * REPORTED, NOT NORMALIZED — two places where the authorities disagree and this
 * file deliberately does not paper over the gap (see the slot report):
 *  - `projects.link` on this Server answers `{spaceId, projectId, patches}`.
 *    Grammar §4.9 requires `projectEntityId` in that result and the frozen
 *    discovery note says the result "carries BOTH identities". It does not yet.
 *    Rendering a fabricated projection id would be worse than saying so.
 *  - `projects.associations.correct` REQUIRES `expectedArtifactVersion` in the
 *    frozen strict DTO, and the dossier's §7 CLI freeze spells the flag
 *    `--expect-version <n>`. The discovery projection's syntax string omits it
 *    and offers a `|none` form the strict DTO cannot express. This file follows
 *    the contract and the dossier — the higher authorities — and refuses `none`
 *    locally rather than sending a body the Server must reject.
 */
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/** The contract's `ProjectTrustLevel`. Trust is an explicit grant, never inferred. */
const TRUST_LEVELS = ['trusted', 'untrusted'] as const;

/** The contract's `ProjectDefaults['mode']`, plus the `|none` clear. */
const SPAWN_MODES = ['worker', 'coordinator', 'coordinated-worker', 'coordinated-coordinator'] as const;

function requireArg(raw: string | undefined, command: string, placeholder: string): string {
  if (raw === undefined || raw === '') {
    throw new CliError(`tm8 ${command} requires ${placeholder}`, EXIT_USAGE, {
      hint: `read its contract with \`tm8 help ${command}\``,
    });
  }
  return raw;
}

/**
 * §7.5. The message names the operation rather than saying "are you sure": a
 * caller who reads it must learn WHAT is destructive, not merely that something
 * is.
 */
function requireConfirmation(cmd: CommandContext, command: string, what: string): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`tm8 ${command} ${what}; pass --yes to confirm`, EXIT_USAGE);
  }
}

/** `<value|none>` — the literal `none` clears the field (§4's `|none` idiom). */
function clearable(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === 'none' ? null : raw;
}

function closedChoice<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (raw === undefined) return undefined;
  const found = allowed.find((a) => a === raw);
  if (!found) {
    throw new CliError(
      `--${flag} expects ${allowed.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

/**
 * The shipped `projects.working_dir` constraint, checked here so the caller
 * gets exit 2 with the rule named instead of a database constraint violation.
 */
function workingDirOf(raw: string): string {
  if (!raw.startsWith('/')) {
    throw new CliError(
      `--working-dir must be an absolute path, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
      { hint: 'a ProjectResource working directory is resolved on the owning node, not relative to your shell' },
    );
  }
  if (raw.includes('..')) {
    throw new CliError(
      `--working-dir must not contain \`..\`, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return raw;
}

/**
 * The three `--default-*` flags collapse into one `ProjectDefaults`. Absent
 * flags are absent from the object — sending `{model: undefined}` would look
 * like a clear to a reader and is not what the caller asked for; `none` IS the
 * clear and becomes an explicit null.
 */
function defaultsOf(cmd: CommandContext): Record<string, string | null> | undefined {
  const model = clearable(cmd.options.value('default-model'));
  const agentTool = clearable(cmd.options.value('default-agent-tool'));
  const rawMode = cmd.options.value('default-mode');
  const mode = rawMode === 'none' ? null : closedChoice(rawMode, SPAWN_MODES, 'default-mode');
  const defaults: Record<string, string | null> = {};
  if (model !== undefined) defaults.model = model;
  if (agentTool !== undefined) defaults.agentTool = agentTool;
  if (mode !== undefined) defaults.mode = mode;
  return Object.keys(defaults).length === 0 ? undefined : defaults;
}

function withActor(cmd: CommandContext, body: Record<string, unknown>): Record<string, unknown> {
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  return body;
}

// ── the commands ───────────────────────────────────────────────────────────

/**
 * `--limit` and `--cursor` appear in this row's PROJECTED syntax string, and
 * they have no binding anywhere in the frozen contract: `projects.list` defines
 * no limit, no cursor and no page type, and answers a bare `ProjectResource[]`.
 *
 * A flag with no wire destination is a promise the CLI cannot keep. An agent
 * that sees `--limit` reasonably concludes the operation pages, and would then
 * treat a full list as a first page — or, worse, believe it had bounded a
 * result it never bounded. Sending it as a query parameter the Server ignores
 * would make that belief invisible, so it is refused here with the conflict
 * named. The projection's syntax string is reported for amendment; this module
 * does not edit it, because that file has one owner.
 */
function refuseUnboundPaging(cmd: CommandContext): void {
  for (const flag of ['limit', 'cursor'] as const) {
    if (cmd.options.has(flag)) {
      throw new CliError(
        `--${flag} has no binding on \`tm8 project list\`: the frozen contract defines no paging for ` +
          'projects.list, which answers the complete ProjectResource list in one response',
        EXIT_USAGE,
        { hint: 'this row is unpaginated by contract; read the whole list' },
      );
    }
  }
}

async function projectList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('project list', cmd.options.value('mutation-id'));
  refuseUnboundPaging(cmd);

  // `projects.list` is authorized against the SERVER, not a Space: it answers
  // for the node. An explicit --space is therefore not a filter here, and
  // silently ignoring one would let a caller believe it was.
  if (cmd.ctx.space?.source === 'flag') {
    cmd.out.note('note: `project list` is node-scoped (authz target: server); --space does not filter it');
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.list');
  cmd.out.data(data, renderProjects);
  return EXIT_OK;
}

async function projectGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('project get', cmd.options.value('mutation-id'));
  const projectId = requireArg(cmd.args[0], 'project get', '<project-resource-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.get', {
    params: { projectId },
  });
  cmd.out.data(data, renderProject);
  return EXIT_OK;
}

/**
 * `tm8 project contention <project-resource-id>` — the read-only contention
 * map: overlapping touched paths across the project's ACTIVE worktree lanes,
 * computed server-side from local git. Two lanes that both touch a file are
 * the "merges cleanly, silently reverts" precondition; this names them while
 * both are still open.
 */
async function projectContention(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('project contention', cmd.options.value('mutation-id'));
  const projectId = requireArg(cmd.args[0], 'project contention', '<project-resource-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.contention', {
    params: { projectId },
  });
  cmd.out.data(data, renderContention);
  return EXIT_OK;
}

interface ContentionLaneView {
  worktreeId?: string;
  branch?: string;
  sessionId?: string | null;
  touchedCount?: number;
  skipped?: string | null;
}
interface ContentionPairView {
  aBranch?: string;
  bBranch?: string;
  overlappingPaths?: string[];
}

function renderContention(data: unknown): string {
  const report = (data ?? {}) as {
    lanes?: ContentionLaneView[];
    pairs?: ContentionPairView[];
  };
  const lanes = report.lanes ?? [];
  const pairs = report.pairs ?? [];
  const lines: string[] = [];
  lines.push(`${String(lanes.length)} active lane(s), ${String(pairs.length)} contended pair(s)`);
  for (const lane of lanes) {
    const skipped = lane.skipped ? `  [skipped: ${lane.skipped}]` : '';
    lines.push(
      `  ${lane.branch ?? '?'}  touched=${String(lane.touchedCount ?? 0)}` +
        `${lane.sessionId ? `  session=${lane.sessionId}` : ''}${skipped}`,
    );
  }
  for (const pair of pairs) {
    lines.push(`  CONTENTION ${pair.aBranch ?? '?'} <-> ${pair.bBranch ?? '?'}:`);
    for (const path of pair.overlappingPaths ?? []) lines.push(`    ${path}`);
  }
  return lines.join('\n');
}

/**
 * `project branches` — what exists in the working directory, and how far each
 * branch has drifted from the trunk. A READ: it runs git argv-only and checks
 * nothing out, so it is safe against a directory someone is actively editing.
 */
async function projectBranches(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('project branches', cmd.options.value('mutation-id'));
  const projectId = requireArg(cmd.args[0], 'project branches', '<project-resource-id>');
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.branches.list', {
    params: { projectId },
    query: {
      staleAfterDays: cmd.options.value('stale-after-days'),
      limit: cmd.options.value('limit'),
    },
  });
  cmd.out.data(data, renderBranches);
  return EXIT_OK;
}

async function projectCreate(cmd: CommandContext): Promise<ExitCode> {
  const name = requireArg(cmd.args[0], 'project create', '<name>');
  const workingDir = workingDirOf(cmd.options.require('working-dir'));
  const body: Record<string, unknown> = {
    name,
    workingDir,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.options.bool('ensure-working-dir')) body.ensureWorkingDir = true;
  const repoUrl = clearable(cmd.options.value('repo-url'));
  const trust = closedChoice(cmd.options.value('trust'), TRUST_LEVELS, 'trust');
  const defaults = defaultsOf(cmd);
  if (repoUrl !== undefined) body.repoUrl = repoUrl;
  if (trust !== undefined) body.trust = trust;
  if (defaults !== undefined) body.defaults = defaults;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.create', {
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderProject);
  return EXIT_OK;
}

async function projectUpdate(cmd: CommandContext): Promise<ExitCode> {
  const projectId = requireArg(cmd.args[0], 'project update', '<project-resource-id>');
  const rawWorkingDir = cmd.options.value('working-dir');
  const workingDir = rawWorkingDir === undefined ? undefined : workingDirOf(rawWorkingDir);
  if (workingDir !== undefined) {
    // §7.5 names Project working-directory relocation exactly. It moves where
    // every future session for this Project executes.
    requireConfirmation(cmd, 'project update --working-dir', 'relocates where sessions for this Project execute');
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const name = cmd.options.value('name');
  const repoUrl = clearable(cmd.options.value('repo-url'));
  const trust = closedChoice(cmd.options.value('trust'), TRUST_LEVELS, 'trust');
  const defaults = defaultsOf(cmd);
  if (name !== undefined) body.name = name;
  if (workingDir !== undefined) body.workingDir = workingDir;
  if (repoUrl !== undefined) body.repoUrl = repoUrl;
  if (trust !== undefined) body.trust = trust;
  if (defaults !== undefined) body.defaults = defaults;

  if (['name', 'workingDir', 'repoUrl', 'trust', 'defaults'].every((k) => !(k in body))) {
    throw new CliError('tm8 project update needs something to change', EXIT_USAGE, {
      hint: 'pass --name, --working-dir, --repo-url, --trust, or a --default-* flag',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.update', {
    params: { projectId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderProject);
  return EXIT_OK;
}

async function projectLink(cmd: CommandContext): Promise<ExitCode> {
  const projectId = requireArg(cmd.args[0], 'project link', '<project-resource-id>');
  const spaceId = requireSpace(cmd.ctx);
  const body: Record<string, unknown> = {
    projectId,
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.link', {
    params: { spaceId },
    body: withActor(cmd, body),
  });

  if (projectionIdOf(data) === undefined) {
    // A FACT ABOUT THE CONTRACT, not a complaint about the node: `projects.link`
    // carries no `projectEntityId` in the frozen schemas, so this result is
    // complete as specified. Said out loud because the two ids are distinct
    // domains and a caller looking for the projection entity must not conclude
    // that `projectId` is it.
    cmd.out.note(
      'note: the frozen projects.link result carries the ProjectResource id and the Space id only. ' +
        'The per-Space projection entity id is a separate identifier domain and is not part of this response.',
    );
  }
  cmd.out.data(data, renderLink);
  return EXIT_OK;
}

async function projectUnlink(cmd: CommandContext): Promise<ExitCode> {
  const projectId = requireArg(cmd.args[0], 'project unlink', '<project-resource-id>');
  const spaceId = requireSpace(cmd.ctx);
  requireConfirmation(
    cmd,
    'project unlink',
    'removes this Space link and soft-deletes its project projection entity',
  );
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.unlink', {
    params: { spaceId, projectId },
    body: withActor(cmd, body),
  });
  cmd.out.data(data, renderLink);
  return EXIT_OK;
}

async function projectAssociationCorrect(cmd: CommandContext): Promise<ExitCode> {
  const artifactId = requireArg(cmd.args[0], 'project association correct', '<artifact-entity-id>');
  const projectId = cmd.options.require('project');
  if (projectId === 'none') {
    throw new CliError(
      '`--project none` has no binding: CorrectProjectAssociationInput requires a `projectId`, ' +
        'and this repair is scoped to one ProjectResource association rather than a generic edge delete',
      EXIT_USAGE,
      { hint: 'pass the ProjectResource id whose association is being corrected' },
    );
  }
  const expectedArtifactVersion = cmd.options.integer('expect-version');
  if (expectedArtifactVersion === undefined) {
    throw new CliError(
      'tm8 project association correct requires --expect-version <n>',
      EXIT_USAGE,
      { hint: 'the artifact version this correction is written against; read it with `tm8 entity get <artifact-entity-id>`' },
    );
  }
  if (expectedArtifactVersion <= 0) {
    throw new CliError(
      `--expect-version expects a positive version, got ${expectedArtifactVersion}`,
      EXIT_USAGE,
    );
  }

  // CorrectProjectAssociationInput is `.strict()` and carries exactly these
  // three members — no actorId. Adding the ambient actor here would be refused.
  const body = { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')), projectId, expectedArtifactVersion };
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'projects.associations.correct', {
    params: { artifactId },
    body,
  });
  cmd.out.data(data, renderCorrection);
  return EXIT_OK;
}

// ── human renderings of the SAME DTO `--format json` emits ──────────────────

interface ProjectRow {
  id?: unknown;
  name?: unknown;
  trust?: unknown;
  workingDir?: unknown;
  repoUrl?: unknown;
  linkFrozen?: unknown;
  activeLinkCount?: unknown;
  defaults?: Record<string, unknown> | null;
}

function rowsOf(dto: unknown): ProjectRow[] {
  if (Array.isArray(dto)) return dto as ProjectRow[];
  const items = (dto as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as ProjectRow[]) : [];
}

/** IDs a follow-up command needs are NEVER omitted from human output (§7.1). */
function renderProjects(dto: unknown): string {
  const rows = rowsOf(dto);
  if (rows.length === 0) return 'no ProjectResources';
  return rows
    .map((r) => `${String(r.id)}  ${String(r.name)}  ${String(r.trust)}  ${String(r.workingDir)}`)
    .join('\n');
}

function renderProject(dto: unknown): string {
  const r = (dto ?? {}) as ProjectRow;
  if (r.id === undefined) return JSON.stringify(dto);
  const lines = [
    `projectId (ProjectResource): ${String(r.id)}`,
    `name: ${String(r.name)}`,
    `workingDir: ${String(r.workingDir)}`,
    `trust: ${String(r.trust)}`,
  ];
  if (r.repoUrl !== undefined) lines.push(`repoUrl: ${r.repoUrl === null ? 'none' : String(r.repoUrl)}`);
  if (r.defaults && Object.keys(r.defaults).length > 0) {
    lines.push(
      `defaults: ${Object.entries(r.defaults)
        .map(([k, v]) => `${k}=${v === null ? 'none' : String(v)}`)
        .join(' ')}`,
    );
  }
  if (r.activeLinkCount !== undefined) lines.push(`activeLinkCount: ${String(r.activeLinkCount)}`);
  if (r.linkFrozen === true) lines.push('linkFrozen: true');
  return lines.join('\n');
}

interface BranchRow {
  name?: unknown;
  ahead?: unknown;
  behind?: unknown;
  isDefault?: unknown;
  isCurrent?: unknown;
  merged?: unknown;
  stale?: unknown;
  lastCommitAt?: unknown;
  subject?: unknown;
}

function renderBranches(dto: unknown): string {
  const t = (dto ?? {}) as {
    defaultBranch?: unknown;
    defaultBranchSource?: unknown;
    branches?: unknown;
    truncated?: unknown;
    staleAfterDays?: unknown;
  };
  const branches = Array.isArray(t.branches) ? (t.branches as BranchRow[]) : [];
  // The SOURCE is printed beside the trunk on purpose: `main` is a convention,
  // and "12 behind main" is a different claim when the trunk was guessed from
  // whatever happened to be checked out than when the remote said so.
  const lines = [
    `default: ${String(t.defaultBranch)} (source: ${String(t.defaultBranchSource)})`,
    `stale after: ${String(t.staleAfterDays)} days`,
  ];
  if (branches.length === 0) {
    lines.push('no branches');
    return lines.join('\n');
  }
  lines.push('');
  for (const b of branches) {
    const flags = [
      b.isCurrent === true ? 'current' : null,
      b.isDefault === true ? 'default' : null,
      b.merged === true ? 'merged' : null,
      b.stale === true ? 'stale' : null,
    ].filter((f): f is string => f !== null);
    // Signs, not colour: `+3/-1` reads the same in a pipe, a log and a CI job.
    lines.push(
      [
        `+${String(b.ahead)}/-${String(b.behind)}`.padEnd(10),
        String(b.name),
        flags.length > 0 ? `[${flags.join(' ')}]` : '',
        String(b.lastCommitAt ?? ''),
      ]
        .filter((part) => part !== '')
        .join('  '),
    );
  }
  if (t.truncated === true) {
    lines.push('', 'truncated: more branches exist than --limit allowed');
  }
  return lines.join('\n');
}

function projectionIdOf(dto: unknown): string | undefined {
  const raw = (dto as { projectEntityId?: unknown } | null | undefined)?.projectEntityId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Both identities, each labelled with the domain it belongs to. When the node
 * did not return the projection id, the line SAYS so — it never falls back to
 * the ProjectResource id, which is the substitution this whole file exists to
 * prevent.
 */
function renderLink(dto: unknown): string {
  const d = (dto ?? {}) as { projectId?: unknown; spaceId?: unknown };
  const projection = projectionIdOf(dto);
  return [
    `projectId (ProjectResource): ${String(d.projectId)}`,
    `spaceId: ${String(d.spaceId)}`,
    `projectEntityId (per-Space projection entity): ${
      projection ?? 'not part of the frozen projects.link result'
    }`,
  ].join('\n');
}

function renderCorrection(dto: unknown): string {
  const d = (dto ?? {}) as { artifactId?: unknown; projectId?: unknown; outcome?: unknown; edge?: { id?: unknown } | null };
  const lines = [
    `outcome: ${String(d.outcome)}`,
    `artifactId: ${String(d.artifactId)}`,
    `projectId (ProjectResource): ${String(d.projectId)}`,
  ];
  if (d.edge && d.edge.id !== undefined) lines.push(`edgeId: ${String(d.edge.id)}`);
  return lines.join('\n');
}

/**
 * The array `commands/registry.ts` imports and spreads. This slot owns this
 * module; the registry owns the one import line.
 */
export const PROJECT_COMMANDS: CommandModule[] = [
  { path: ['project', 'list'], run: projectList },
  { path: ['project', 'create'], run: projectCreate },
  { path: ['project', 'get'], run: projectGet },
  { path: ['project', 'contention'], run: projectContention },
  { path: ['project', 'branches'], run: projectBranches },
  { path: ['project', 'update'], run: projectUpdate },
  { path: ['project', 'link'], run: projectLink },
  { path: ['project', 'unlink'], run: projectUnlink },
  { path: ['project', 'association', 'correct'], run: projectAssociationCorrect },
];
