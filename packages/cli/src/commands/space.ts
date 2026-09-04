/**
 * `tm8 space …` (§4.2) — the Space noun: the nineteen frozen G01 rows plus the
 * three W0 additive rows A01–A03 (`space menu get|update`,
 * `space default-channel set`).
 *
 * WHAT IS DELIBERATELY NOT HERE: `space interaction-profile set-default` (A20).
 * It belongs beside its symmetric twin `teammate interaction-profile
 * set-default` in the Interaction Profile module, because splitting a symmetric
 * pair across two files is how the two halves drift apart. `registry.ts` throws
 * at IMPORT on a duplicate path, so registering it in both places would not
 * fail one test — it would collapse every slot's suite at once.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 *  1. EVERY PATH COMES FROM THE CATALOG. Not one URL is written here; the
 *     operation NAME is passed to the client and `bindPath` produces the path.
 *     A typo'd literal would be a 404 the closed catalog was designed to make
 *     impossible.
 *
 *  2. AN INVITE CODE IS BEARER AUTHENTICATION MATERIAL, NOT AN IDENTIFIER.
 *     Whoever holds one can join the Space; there is no second factor and no
 *     revocation window before use. Three surfaces here carry codes —
 *     `invite create`, `invite list`, and `settings get`, whose DTO embeds the
 *     invite array. The duty is two-sided and both halves matter:
 *       FAITHFUL RENDER — print exactly what the Server sent. A client that
 *         quietly masks a code hides a server-side disclosure from the gate
 *         whose job is to see it, which is strictly worse than showing it.
 *       ZERO RETENTION — nothing in this file writes a response anywhere. No
 *         cache, no config, no state file, no re-display on a later command.
 *     The stderr note states what the material IS. It is phrased as a fact and
 *     never as an instruction: in a PTY, stderr and stdout land in the same
 *     agent context, so a diagnostic written as a directive becomes one.
 *
 *  3. READS REFUSE `--mutation-id`; MUTATIONS NEVER REGENERATE ONE. A supplied
 *     id goes on the wire verbatim, because a changed id is a different
 *     mutation and silently changing it turns a safe retry into a duplicate
 *     write.
 *
 *  4. TWO ROWS HERE CARRY AN OPTIMISTIC-CONCURRENCY GUARD, BOTH SPELLED
 *     `--expect-revision`, AND THEY BIND DIFFERENT FIELDS:
 *
 *       space menu update          --expect-revision -> expectedRevision
 *       space default-channel set  --expect-revision -> expectedSettingsRevision
 *
 *     That is a RULING, not an oversight: kebab-casing the field is only the
 *     default derivation, and where an authority names a spelling the authority
 *     wins — the dossier §7 "CLI freeze" table names `--expect-revision` for
 *     both, while §4 writes each field correctly. The collision is a real
 *     hazard (it has already been crossed once at coordinator level) but it
 *     fails LOUDLY: both schemas are `.strict()`, so the wrong key is a
 *     `400 invalid_input` on the first real call and cannot ship green. Each
 *     row's field is pinned explicitly in the integration suite rather than
 *     assumed.
 *
 * HISTORY WORTH KEEPING, because the record is the deliverable: before the
 * guard flag existed, `space default-channel set` sent the only body the
 * grammar could express, the Server answered `invalid_input: Required`, and the
 * operation was DEAD. Adding the flag is RESTORATION of a capability the frozen
 * schema always required — not an invented flag, not a fabricated revision, and
 * emphatically not a hidden read-before-write, which would have silently
 * defeated the very concurrency the guard exists for.
 */
import { readJsonSource, readTextSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

// ── shared argument handling ────────────────────────────────────────────────

/**
 * Reject arguments the syntax does not define. Without this an extra token is
 * silently dropped, and `tm8 space get spc_a spc_b` reads one Space while the
 * caller believes they asked about two.
 */
function noExtraArgs(command: string, args: readonly string[], expected: number): void {
  if (args.length > expected) {
    throw new CliError(
      `\`tm8 ${command}\` takes ${expected} argument${expected === 1 ? '' : 's'}; got ${args.length}`,
      EXIT_USAGE,
      { hint: `read its exact syntax with \`tm8 help ${command}\`` },
    );
  }
}

/**
 * The Space for a command whose syntax offers an OPTIONAL positional
 * `[<space-id>]` alongside the global `--space`.
 *
 * The positional wins over injected/configured context — that is what writing
 * it is for. But an EXPLICIT `--space` on the same command line that names a
 * DIFFERENT Space is two contradictory answers to "where does this act?", and
 * for a mutation that is the difference between two databases. It refuses
 * rather than picking one. Session- and config-sourced context does not
 * conflict: overriding those is the ordinary case.
 */
function spaceFromArgOrContext(cmd: CommandContext, positional: string | undefined): string {
  if (positional === undefined) return requireSpace(cmd.ctx);
  const flagged = cmd.ctx.space;
  if (flagged?.source === 'flag' && flagged.value !== positional) {
    throw new CliError(
      `this command names two different Spaces: <space-id> ${positional} and --space ${flagged.value}`,
      EXIT_USAGE,
      { hint: 'pass the Space once — either as the argument or as --space' },
    );
  }
  return positional;
}

/** `--limit <count>` + opaque `--cursor`. The CLI never decodes a cursor (§7.2). */
function pageQuery(cmd: CommandContext): Record<string, string | undefined> {
  const limit = cmd.options.integer('limit');
  return {
    limit: limit === undefined ? undefined : String(limit),
    cursor: cmd.options.value('cursor'),
  };
}

/** The `<value|none>` idiom of §4: the literal `none` CLEARS, it is not a value. */
function noneAsNull(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === 'none' ? null : raw;
}

function requireArg(command: string, raw: string | undefined, label: string): string {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`\`tm8 ${command}\` requires ${label}`, EXIT_USAGE, {
      hint: `read its exact syntax with \`tm8 help ${command}\``,
    });
  }
  return raw;
}

function requireInteger(cmd: CommandContext, name: string): number {
  const value = cmd.options.integer(name);
  if (value === undefined) throw new CliError(`--${name} is required`, EXIT_USAGE);
  return value;
}

/** `--kind default|manual`, in the contract's exact spelling — no translation. */
function requireAxisKind(cmd: CommandContext): 'default' | 'manual' {
  const raw = cmd.options.value('kind');
  if (raw === undefined) throw new CliError('--kind is required', EXIT_USAGE);
  if (raw !== 'default' && raw !== 'manual') {
    throw new CliError(`--kind expects default|manual, got ${JSON.stringify(raw)}`, EXIT_USAGE);
  }
  return raw;
}

/** §7.5: destructive operations require explicit consent. JSON does not imply it. */
function requireConsent(command: string, cmd: CommandContext): void {
  if (!cmd.options.bool('yes')) {
    throw new CliError(`\`tm8 ${command}\` is destructive and requires --yes`, EXIT_USAGE, {
      hint: 'non-interactive execution never prompts, and --format json is not consent',
    });
  }
}

/**
 * The command envelope every mutation carries: the id that makes a retry safe,
 * plus the author `--as` selected. `--as` SELECTS an author; the Server decides
 * whether this caller may act as them.
 */
function mutationBody(cmd: CommandContext): Record<string, unknown> {
  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;
  return body;
}

/**
 * The envelope for the two W0 additive rows whose DTOs do NOT extend
 * `CommandContext`: `UpdateMenuInput` and `SetDefaultChannelInput` are `.strict()`
 * and declare only `clientMutationId` (plus their own fields). They carry no
 * `actorId`, so adding one would put a body on the wire that the frozen schema
 * rejects — the CLI discovering its own invalid input at the Server.
 *
 * An `--as` that arrived from injected session or local config is simply not
 * applicable here and is dropped. An `--as` typed on THIS command line is a
 * caller who believes they are attributing this write to someone else, and
 * silently ignoring that is worse than refusing it.
 */
function authorlessMutationBody(command: string, cmd: CommandContext): Record<string, unknown> {
  if (cmd.ctx.actor?.source === 'flag') {
    throw new CliError(
      `\`tm8 ${command}\` takes no --as: its frozen DTO declares no author field`,
      EXIT_USAGE,
      { hint: 'the Server attributes this configuration change to the calling identity' },
    );
  }
  return { clientMutationId: resolveMutationId(cmd.options.value('mutation-id')) };
}

// ── credential handling ─────────────────────────────────────────────────────

interface InviteDto {
  id?: unknown;
  code?: unknown;
  maxUses?: unknown;
  uses?: unknown;
  expiresAt?: unknown;
  revoked?: unknown;
}

function invitesIn(dto: unknown): InviteDto[] {
  if (Array.isArray(dto)) return dto as InviteDto[];
  if (dto === null || typeof dto !== 'object') return [];
  const record = dto as { invites?: unknown; items?: unknown; code?: unknown };
  if (Array.isArray(record.invites)) return record.invites as InviteDto[];
  if (Array.isArray(record.items)) return record.items as InviteDto[];
  return typeof record.code === 'string' ? [record as InviteDto] : [];
}

/**
 * Say what the material on stdout IS, once, on stderr, whenever a response
 * actually carried a code.
 *
 * A STATEMENT, NEVER A DIRECTIVE. This line can land inside an agent's context
 * window beside the data, so it describes the world rather than telling the
 * reader what to do. `warn` rather than `note` because `--quiet` silences notes
 * and the nature of a credential is not a detail a caller opted out of.
 */
function noteCredentialDisclosure(cmd: CommandContext, dto: unknown): void {
  const disclosed = invitesIn(dto).filter((i) => typeof i.code === 'string' && i.code.length > 0);
  if (disclosed.length === 0) return;
  cmd.out.warn(
    `tm8: ${disclosed.length === 1 ? 'the invite code above is' : `the ${disclosed.length} invite codes above are`} ` +
      'bearer material: whoever holds one can join this Space. tm8 keeps no copy.',
  );
}

// ── human renderers — one function of the SAME DTO `--format json` emits ────

function fallback(dto: unknown): string {
  return dto === undefined ? '' : JSON.stringify(dto);
}

function rowsOf(dto: unknown, key: string): unknown[] {
  if (Array.isArray(dto)) return dto;
  if (dto === null || typeof dto !== 'object') return [];
  const record = dto as Record<string, unknown>;
  if (Array.isArray(record[key])) return record[key] as unknown[];
  if (Array.isArray(record.items)) return record.items as unknown[];
  return [];
}

function field(row: unknown, name: string): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const value = (row as Record<string, unknown>)[name];
  return value === undefined || value === null ? undefined : String(value);
}

/** A `Page<T>`'s continuation, kept because a follow-up `--cursor` needs it. */
function cursorLine(dto: unknown): string | undefined {
  const next = field(dto, 'nextCursor');
  return next === undefined ? undefined : `next --cursor ${next}`;
}

function joinLines(lines: ReadonlyArray<string | undefined>, empty: string): string {
  const kept = lines.filter((l): l is string => l !== undefined && l !== '');
  return kept.length === 0 ? empty : kept.join('\n');
}

function actorLabel(row: unknown, key = 'actor'): string {
  const actor = row === null || typeof row !== 'object' ? undefined : (row as Record<string, unknown>)[key];
  const id = field(actor, 'id');
  const name = field(actor, 'displayName');
  return [id, name].filter((v) => v !== undefined).join('  ');
}

function renderSpaces(dto: unknown): string {
  const rows = rowsOf(dto, 'spaces');
  return joinLines(
    rows.map((r) => {
      const members = field(r, 'memberCount');
      return `${field(r, 'id') ?? '?'}  ${field(r, 'name') ?? ''}${members ? `  ${members} members` : ''}`.trimEnd();
    }),
    'no Spaces',
  );
}

function renderSpace(dto: unknown): string {
  const id = field(dto, 'id');
  if (id === undefined) return fallback(dto);
  return `${id}  ${field(dto, 'name') ?? ''}`.trimEnd();
}

/**
 * `spaces.create` answers 201 with the Space AND the two ids the caller needs
 * next: their own new member row, and the `general` channel the Space opened
 * with. Dropping either would leave the caller unable to act in the Space they
 * just made.
 */
function renderCreatedSpace(dto: unknown): string {
  const space = dto === null || typeof dto !== 'object' ? undefined : (dto as Record<string, unknown>).space;
  if (space === undefined) return renderSpace(dto);
  return joinLines(
    [
      renderSpace(space),
      field(dto, 'memberId') === undefined ? undefined : `member ${field(dto, 'memberId')}`,
      field(dto, 'defaultChannelId') === undefined
        ? undefined
        : `default channel ${field(dto, 'defaultChannelId')}`,
    ],
    fallback(dto),
  );
}

function renderNavigation(dto: unknown): string {
  const channels = rowsOf(dto, 'channels');
  const walk = (nodes: readonly unknown[], depth: number): string[] =>
    nodes.flatMap((node) => {
      const entity = node === null || typeof node !== 'object'
        ? undefined
        : (node as Record<string, unknown>).entity;
      const line = `${'  '.repeat(depth)}${field(entity, 'id') ?? '?'}  ${field(entity, 'title') ?? ''}`.trimEnd();
      return [line, ...walk(rowsOf(node, 'children'), depth + 1)];
    });
  return joinLines(
    [
      field(dto, 'spaceId') === undefined ? undefined : `space ${field(dto, 'spaceId')}`,
      actorLabel(dto, 'viewer') === '' ? undefined : `viewer ${actorLabel(dto, 'viewer')}`,
      ...walk(channels, 0),
    ],
    fallback(dto),
  );
}

function renderMembers(dto: unknown): string {
  const rows = rowsOf(dto, 'members');
  return joinLines(
    rows.map((r) => `${actorLabel(r)}  ${field(r, 'role') ?? ''}`.trimEnd()),
    'no Members',
  );
}

/**
 * FAITHFUL: the code is rendered exactly as the Server sent it. It is also the
 * only column that matters to a caller who is about to hand it to someone, so
 * eliding or truncating it would break the command and hide a disclosure at the
 * same time. Nothing here retains it.
 */
function renderInvite(row: unknown): string {
  const uses = field(row, 'uses');
  const maxUses = field(row, 'maxUses');
  return [
    field(row, 'id') ?? '?',
    field(row, 'code') === undefined ? undefined : `code ${field(row, 'code')}`,
    field(row, 'role') === undefined ? undefined : `joins as ${field(row, 'role')}`,
    uses === undefined && maxUses === undefined ? undefined : `uses ${uses ?? '?'}/${maxUses ?? '?'}`,
    `expires ${field(row, 'expiresAt') ?? 'never'}`,
    field(row, 'revoked') === 'true' ? 'REVOKED' : undefined,
  ]
    .filter((p): p is string => p !== undefined)
    .join('  ');
}

/**
 * The preview's shape CHANGES with its status, and the renderer says so rather
 * than printing empty columns: a dead code carries no inviter and no space id
 * by rule (118), so a line reading `invitedBy —` would misreport a deliberate
 * refusal as missing data.
 */
function renderInvitePreview(dto: unknown): string {
  const status = field(dto, 'status') ?? 'unknown';
  if (status === 'unknown') return 'unknown  this code does not resolve to anything on this Server';
  const space = field(dto, 'spaceName');
  if (status !== 'valid') return `${status}  ${space ?? ''}`.trimEnd();
  return [
    'valid',
    space === undefined ? undefined : `space ${space}`,
    `join as ${field(dto, 'role') ?? '?'}`,
    field(dto, 'invitedBy') === undefined ? undefined : `invited by ${field(dto, 'invitedBy')}`,
    `expires ${field(dto, 'expiresAt') ?? 'never'}`,
  ]
    .filter((p): p is string => p !== undefined)
    .join('  ');
}

function renderInvites(dto: unknown): string {
  const rows = rowsOf(dto, 'invites');
  return joinLines(rows.map(renderInvite), 'no invitations');
}

function renderTaskAxis(row: unknown): string {
  const values = row === null || typeof row !== 'object'
    ? []
    : ((row as Record<string, unknown>).axisValues as unknown[] | undefined) ?? [];
  return [
    field(row, 'id') ?? '?',
    field(row, 'name') ?? '',
    field(row, 'kind') ?? '',
    `position ${field(row, 'position') ?? '?'}`,
    Array.isArray(values) && values.length > 0 ? `[${values.map(String).join(' ')}]` : undefined,
  ]
    .filter((p): p is string => p !== undefined && p !== '')
    .join('  ');
}

function renderTaskAxes(dto: unknown): string {
  const rows = rowsOf(dto, 'taskAxes');
  return joinLines(rows.map(renderTaskAxis), 'no task axes');
}

function renderTaskWorkflow(row: unknown): string {
  const statuses = row === null || typeof row !== 'object'
    ? []
    : ((row as Record<string, unknown>).statuses as unknown[] | undefined) ?? [];
  return [
    field(row, 'id') ?? '?',
    `type ${field(row, 'typeValue') ?? '?'}`,
    Array.isArray(statuses) && statuses.length > 0 ? `[${statuses.map(String).join(' ')}]` : undefined,
  ]
    .filter((p): p is string => p !== undefined && p !== '')
    .join('  ');
}

function renderTaskWorkflows(dto: unknown): string {
  const rows = rowsOf(dto, 'taskWorkflows');
  return joinLines(rows.map(renderTaskWorkflow), 'no task workflows');
}

/**
 * `Name (kind)  [State:category ...]  +N overrides`. Categories are shown on
 * every state because the category is the only part of a status anything
 * outside the workflow may read — a list that showed names alone would be a
 * list of strings nobody may branch on.
 */
function renderWorkflow(row: unknown): string {
  const states = row === null || typeof row !== 'object'
    ? []
    : ((row as Record<string, unknown>).states as unknown[] | undefined) ?? [];
  const transitions = row === null || typeof row !== 'object'
    ? []
    : ((row as Record<string, unknown>).transitions as unknown[] | undefined) ?? [];
  const rendered = (Array.isArray(states) ? states : []).map((state) => {
    const name = field(state, 'name') ?? '?';
    const category = field(state, 'category') ?? '?';
    const initial = field(state, 'isInitial') === 'true' ? '*' : '';
    return `${name}:${category}${initial}`;
  });
  const overrides = Array.isArray(transitions) ? transitions.length : 0;
  return [
    field(row, 'id') ?? '?',
    field(row, 'name') ?? '?',
    field(row, 'kind') === undefined ? '(any kind)' : `(${field(row, 'kind')})`,
    // A NULL spaceId is THE built-in default. Saying so is the difference
    // between "why can I not delete this one" and a self-explaining list.
    field(row, 'spaceId') === undefined ? '[built-in]' : undefined,
    rendered.length > 0 ? `[${rendered.join(' ')}]` : undefined,
    // Zero is the NORMAL case — the ruled category defaults apply — so it is
    // reported as silence rather than as `+0 overrides`, which would read like
    // a workflow that had been emptied.
    overrides > 0 ? `+${overrides} override${overrides === 1 ? '' : 's'}` : undefined,
  ]
    .filter((p): p is string => p !== undefined && p !== '')
    .join('  ');
}

function renderWorkflows(dto: unknown): string {
  const rows = rowsOf(dto, 'workflows');
  return joinLines(rows.map(renderWorkflow), 'no workflows');
}

function renderSettings(dto: unknown): string {
  const space = dto === null || typeof dto !== 'object' ? undefined : (dto as Record<string, unknown>).space;
  return joinLines(
    [
      space === undefined ? undefined : renderSpace(space),
      field(dto, 'settingsRevision') === undefined
        ? undefined
        : `settings revision ${field(dto, 'settingsRevision')}`,
      `default channel ${field(dto, 'defaultChannelId') ?? 'none'}`,
      `default interaction profile ${field(dto, 'defaultInteractionProfileId') ?? 'none'}`,
      renderMembers(dto),
      renderInvites(dto),
      renderTaskAxes(dto),
    ],
    fallback(dto),
  );
}

function renderLeaderboard(dto: unknown): string {
  const rows = rowsOf(dto, 'items');
  return joinLines(
    [
      ...rows.map((r) => `${field(r, 'rank') ?? '?'}  ${actorLabel(r)}  ${field(r, 'score') ?? '0'}`),
      cursorLine(dto),
    ],
    'no ranked actors',
  );
}

function renderAwards(dto: unknown): string {
  const rows = rowsOf(dto, 'items');
  return joinLines(
    [
      ...rows.map((r) =>
        `${field(r, 'id') ?? '?'}  ${actorLabel(r, 'recipient')}  +${field(r, 'amount') ?? '0'}  ${field(r, 'createdAt') ?? ''}`.trimEnd(),
      ),
      cursorLine(dto),
    ],
    'no awards',
  );
}

function renderMenu(dto: unknown): string {
  const groups = rowsOf(dto, 'groups');
  return joinLines(
    [
      field(dto, 'revision') === undefined ? undefined : `revision ${field(dto, 'revision')}`,
      ...groups.map((g) => {
        const items = rowsOf(g, 'items').map((i) => field(i, 'ref') ?? '?');
        return `${field(g, 'id') ?? '?'}  ${field(g, 'label') ?? ''}  [${items.join(' ')}]`;
      }),
    ],
    fallback(dto),
  );
}

function renderHome(dto: unknown): string {
  const presets = rowsOf(dto, 'presets');
  return joinLines(
    presets.map((p) => `${field(p, 'key') ?? '?'}  ${field(p, 'label') ?? ''}  ${field(p, 'count') ?? ''}`.trimEnd()),
    fallback(dto),
  );
}

/**
 * `spaces.counts` is a bare kind→counters map, not a `{ rows: [...] }`
 * projection, so it renders by walking its own keys rather than through
 * `rowsOf`. Kinds absent from the payload have no entities and are omitted
 * here too — printing a zero row for every unused kind would bury the ones
 * that matter.
 */
function renderCounts(dto: unknown): string {
  if (typeof dto !== 'object' || dto === null) return fallback(dto);
  const lines = Object.entries(dto as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, counters]) => {
      const total = field(counters, 'total') ?? '0';
      const unseen = field(counters, 'unseen') ?? '0';
      // "unseen" is spelled out because a bare second number would read as an
      // unlabelled quantity; the total is the headline and comes first.
      return `${kind.padEnd(20)} ${total.padStart(6)}  ${unseen === '0' ? '' : `${unseen} unseen`}`.trimEnd();
    });
  return joinLines(lines, fallback(dto));
}

// ── the commands ────────────────────────────────────────────────────────────

async function spaceList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space list', cmd.options.value('mutation-id'));
  noExtraArgs('space list', cmd.args, 0);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.list', {
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderSpaces);
  return EXIT_OK;
}

async function spaceCreate(cmd: CommandContext): Promise<ExitCode> {
  const name = requireArg('space create', cmd.args[0], 'a <name>');
  noExtraArgs('space create', cmd.args, 1);

  const body = mutationBody(cmd);
  body.name = name;
  const description = cmd.options.value('description');
  if (description !== undefined) body.description = await readTextSource(description);
  const visibility = cmd.options.value('visibility');
  if (visibility !== undefined) {
    if (visibility !== 'private' && visibility !== 'public') {
      throw new CliError(
        `--visibility expects private|public, got ${JSON.stringify(visibility)}`,
        EXIT_USAGE,
      );
    }
    body.visibility = visibility;
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.create', { body });
  cmd.out.data(data, renderCreatedSpace);
  return EXIT_OK;
}

async function spaceGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space get', cmd.options.value('mutation-id'));
  noExtraArgs('space get', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.get', { params: { spaceId } });
  cmd.out.data(data, renderSpace);
  return EXIT_OK;
}

async function spaceUpdate(cmd: CommandContext): Promise<ExitCode> {
  noExtraArgs('space update', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);

  const body = mutationBody(cmd);
  const name = cmd.options.value('name');
  const description = cmd.options.value('description');
  // Deprecated in favour of linked ProjectResources, but still reachable while
  // the catalog row is frozen — hiding it from HELP is the projection's job,
  // removing it from the command would be a capability regression.
  const githubRepo = noneAsNull(cmd.options.value('github-repo'));

  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = await readTextSource(description);
  if (githubRepo !== undefined) body.githubRepo = githubRepo;

  if (!['name', 'description', 'githubRepo'].some((k) => k in body)) {
    throw new CliError('tm8 space update needs something to change', EXIT_USAGE, {
      hint: 'pass --name, --description, or --github-repo',
    });
  }

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.update', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderSpace);
  return EXIT_OK;
}

/** The three read-only Space projections, which differ only in row and renderer. */
function spaceProjection(
  command: string,
  operation: 'spaces.navigation' | 'spaces.home' | 'spaces.settings' | 'spaces.counts',
  render: (dto: unknown) => string,
): (cmd: CommandContext) => Promise<ExitCode> {
  return async (cmd) => {
    refuseMutationId(command, cmd.options.value('mutation-id'));
    noExtraArgs(command, cmd.args, 1);
    const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
    const data = await observedInvoke<unknown>(clientFor(cmd.ctx), operation, { params: { spaceId } });
    if (operation === 'spaces.settings') noteCredentialDisclosure(cmd, data);
    cmd.out.data(data, render);
    return EXIT_OK;
  };
}

async function spaceMemberList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space member list', cmd.options.value('mutation-id'));
  noExtraArgs('space member list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.members.list', {
    params: { spaceId },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderMembers);
  return EXIT_OK;
}

/**
 * `space member role <member-id> --role <role>` — the space-role writer (118).
 *
 * The member id is an ARGUMENT and the space comes from context or `--space`,
 * mirroring `invite revoke`, because both address a row INSIDE a space and the
 * server's route carries the pair. Consent is required for the same reason
 * `invite revoke` requires it: this changes what another person may do.
 */
async function spaceMemberRole(cmd: CommandContext): Promise<ExitCode> {
  const memberId = requireArg('space member role', cmd.args[0], 'a <member-id>');
  noExtraArgs('space member role', cmd.args, 1);
  requireConsent('space member role', cmd);
  const spaceId = requireSpace(cmd.ctx);

  // The vocabulary is asserted here as well as on the server, so a typo costs a
  // usage error naming the three words rather than a round trip and a 400.
  const role = cmd.options.value('role');
  if (role !== 'owner' && role !== 'admin' && role !== 'member') {
    throw new CliError(
      `--role expects owner|admin|member, got ${role === undefined ? 'nothing' : JSON.stringify(role)}`,
      EXIT_USAGE,
      { hint: 'only an owner may grant or revoke `owner`, and a Space must keep at least one' },
    );
  }

  const body = mutationBody(cmd);
  body.role = role;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.members.updateRole', {
    params: { spaceId, memberId },
    body,
  });
  cmd.out.data(data, fallback);
  return EXIT_OK;
}

/**
 * `space invite resolve <code>` — what a code lets you join, before you join.
 *
 * Takes NO space: the code resolves to one. It is also the only read in this
 * file that answers without membership, which is why it is useful from a shell
 * that has not authenticated at all.
 *
 * The code rides in the BODY, not a path parameter, because `auth.invite.resolve`
 * is a POST-with-`kind: 'read'` on purpose — a bearer capability in a URL is a
 * bearer capability in an access log.
 */
async function spaceInviteResolve(cmd: CommandContext): Promise<ExitCode> {
  // §7.4 FIRST, argument second. This is a READ, and the mutation-id refusal is
  // a property of the VERB, not of a well-formed invocation — the sweep in
  // `space.test.ts` passes `--mutation-id` with no code at all, and an argument
  // error raised first would hide the refusal it is checking for.
  refuseMutationId('space invite resolve', cmd.options.value('mutation-id'));
  const code = requireArg('space invite resolve', cmd.args[0], 'a <code>');
  noExtraArgs('space invite resolve', cmd.args, 1);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'auth.invite.resolve', {
    body: { code },
  });
  cmd.out.data(data, renderInvitePreview);
  return EXIT_OK;
}

async function spaceInviteList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space invite list', cmd.options.value('mutation-id'));
  noExtraArgs('space invite list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.invites.list', {
    params: { spaceId },
    query: pageQuery(cmd),
  });
  noteCredentialDisclosure(cmd, data);
  cmd.out.data(data, renderInvites);
  return EXIT_OK;
}

async function spaceInviteCreate(cmd: CommandContext): Promise<ExitCode> {
  noExtraArgs('space invite create', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);

  const body = mutationBody(cmd);
  const maxUses = cmd.options.integer('max-uses');
  if (maxUses !== undefined) body.maxUses = maxUses;
  const expiresAt = noneAsNull(cmd.options.value('expires-at'));
  if (expiresAt !== undefined) body.expiresAt = expiresAt;
  // Absent means 'member' — decided by the server, not defaulted here, so the
  // CLI cannot drift from what every pre-114 invite already meant.
  const role = cmd.options.value('role');
  if (role !== undefined) body.role = role;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.invites.create', {
    params: { spaceId },
    body,
  });
  noteCredentialDisclosure(cmd, data);
  cmd.out.data(data, renderInvite);
  return EXIT_OK;
}

async function spaceInviteRevoke(cmd: CommandContext): Promise<ExitCode> {
  const inviteId = requireArg('space invite revoke', cmd.args[0], 'an <invite-id>');
  noExtraArgs('space invite revoke', cmd.args, 1);
  requireConsent('space invite revoke', cmd);
  const spaceId = requireSpace(cmd.ctx);

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.invites.revoke', {
    params: { spaceId, inviteId },
    body: mutationBody(cmd),
  });
  cmd.out.data(data, renderInvite);
  return EXIT_OK;
}

async function spaceInviteRedeem(cmd: CommandContext): Promise<ExitCode> {
  const code = requireArg('space invite redeem', cmd.args[0], 'a <code>');
  noExtraArgs('space invite redeem', cmd.args, 1);

  const body = mutationBody(cmd);
  body.code = code;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.invites.redeem', { body });
  cmd.out.data(data, fallback);
  return EXIT_OK;
}

async function spaceTaskAxisList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space task-axis list', cmd.options.value('mutation-id'));
  noExtraArgs('space task-axis list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskAxes.list', {
    params: { spaceId },
  });
  cmd.out.data(data, renderTaskAxes);
  return EXIT_OK;
}

/**
 * `TaskAxisInput` is a WHOLE-AXIS shape, not a patch, which is why create and
 * update take the same required set: an update that omitted `--value` would
 * silently redefine the axis with no values.
 */
function taskAxisBody(cmd: CommandContext, name: string): Record<string, unknown> {
  const values = cmd.options.values('value');
  if (values.length === 0) {
    throw new CliError('--value is required (repeat it once per axis value)', EXIT_USAGE);
  }
  const body = mutationBody(cmd);
  body.name = name;
  body.axisValues = values;
  body.kind = requireAxisKind(cmd);
  body.position = requireInteger(cmd, 'position');
  return body;
}

async function spaceTaskAxisCreate(cmd: CommandContext): Promise<ExitCode> {
  const name = requireArg('space task-axis create', cmd.args[0], 'a <name>');
  noExtraArgs('space task-axis create', cmd.args, 1);
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskAxes.create', {
    params: { spaceId },
    body: taskAxisBody(cmd, name),
  });
  cmd.out.data(data, renderTaskAxis);
  return EXIT_OK;
}

async function spaceTaskAxisUpdate(cmd: CommandContext): Promise<ExitCode> {
  const axisId = requireArg('space task-axis update', cmd.args[0], 'an <axis-id>');
  noExtraArgs('space task-axis update', cmd.args, 1);
  const spaceId = requireSpace(cmd.ctx);
  const name = cmd.options.value('name');
  if (name === undefined) throw new CliError('--name is required', EXIT_USAGE);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskAxes.update', {
    params: { spaceId, axisId },
    body: taskAxisBody(cmd, name),
  });
  cmd.out.data(data, renderTaskAxis);
  return EXIT_OK;
}

async function spaceTaskAxisDelete(cmd: CommandContext): Promise<ExitCode> {
  const axisId = requireArg('space task-axis delete', cmd.args[0], 'an <axis-id>');
  noExtraArgs('space task-axis delete', cmd.args, 1);
  requireConsent('space task-axis delete', cmd);
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskAxes.delete', {
    params: { spaceId, axisId },
    body: mutationBody(cmd),
  });
  cmd.out.data(data, (dto) => field(dto, 'axisId') ?? fallback(dto));
  return EXIT_OK;
}

async function spaceTaskWorkflowList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space task-workflow list', cmd.options.value('mutation-id'));
  noExtraArgs('space task-workflow list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskWorkflows.list', {
    params: { spaceId },
  });
  cmd.out.data(data, renderTaskWorkflows);
  return EXIT_OK;
}

/**
 * `TaskWorkflowInput` states the WHOLE vocabulary each time (upsert on the
 * (space, type value) natural key) — same whole-shape reasoning as
 * `taskAxisBody` above. The structural {open, working, done} rule is the
 * DATABASE's constraint; refusing locally would be a second copy free to
 * drift, so an incomplete set is forwarded and the server's refusal rendered.
 */
async function spaceTaskWorkflowSet(cmd: CommandContext): Promise<ExitCode> {
  const typeValue = requireArg('space task-workflow set', cmd.args[0], 'a <type-value>');
  noExtraArgs('space task-workflow set', cmd.args, 1);
  const spaceId = requireSpace(cmd.ctx);
  const statuses = cmd.options.values('status');
  if (statuses.length === 0) {
    throw new CliError('--status is required (repeat it once per allowed status)', EXIT_USAGE, {
      hint: 'open, working, and done are always required members',
    });
  }
  const body = mutationBody(cmd);
  body.typeValue = typeValue;
  body.statuses = statuses;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskWorkflows.upsert', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderTaskWorkflow);
  return EXIT_OK;
}

async function spaceTaskWorkflowDelete(cmd: CommandContext): Promise<ExitCode> {
  const workflowId = requireArg('space task-workflow delete', cmd.args[0], 'a <workflow-id>');
  noExtraArgs('space task-workflow delete', cmd.args, 1);
  requireConsent('space task-workflow delete', cmd);
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.taskWorkflows.delete', {
    params: { spaceId, workflowId },
    body: mutationBody(cmd),
  });
  cmd.out.data(data, (dto) => field(dto, 'workflowId') ?? fallback(dto));
  return EXIT_OK;
}

async function spaceWorkflowList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space workflow list', cmd.options.value('mutation-id'));
  noExtraArgs('space workflow list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.workflows.list', {
    params: { spaceId },
  });
  cmd.out.data(data, renderWorkflows);
  return EXIT_OK;
}

/**
 * `--state <name>:<category>[:initial][:default]`.
 *
 * The flags are parsed here because a shell cannot express nested objects, but
 * nothing is VALIDATED here beyond the shape the parser needs: exactly-one-
 * initial, the closed four categories and unique positions are the DATABASE's
 * constraints, and a second copy in the CLI would be free to drift from the
 * rule that decides. A colon-separated triple is forwarded as-is and the
 * server's refusal is rendered — the same posture `space task-workflow set`
 * takes towards the structural {open, working, done} rule.
 *
 * A state's POSITION is its order on the command line. That is the whole
 * reason the flag is repeatable rather than comma-joined: position decides
 * which state is a category's default, so it must come from something the
 * caller ordered deliberately.
 */
function workflowStatesFrom(cmd: CommandContext): Array<Record<string, unknown>> {
  const raw = cmd.options.values('state');
  if (raw.length === 0) {
    throw new CliError('--state is required (repeat it once per state)', EXIT_USAGE, {
      hint: '--state <name>:<category>[:initial][:default], e.g. --state Draft:to_do:initial',
    });
  }
  return raw.map((spec, index) => {
    const parts = spec.split(':');
    const name = parts[0]?.trim();
    const category = parts[1]?.trim();
    if (name === undefined || name === '' || category === undefined || category === '') {
      throw new CliError(`--state ${spec} is not <name>:<category>`, EXIT_USAGE, {
        hint: 'categories are to_do, in_progress, done, cancelled',
      });
    }
    const flags = parts.slice(2).map((f) => f.trim());
    const state: Record<string, unknown> = { name, category, position: index + 1 };
    if (flags.includes('initial')) state.isInitial = true;
    if (flags.includes('default')) state.isDefault = true;
    return state;
  });
}

/** `--transition "From->To"`, or `"->To"` for the ANY arm. */
function workflowTransitionsFrom(cmd: CommandContext): Array<Record<string, unknown>> {
  return cmd.options.values('transition').map((spec) => {
    const [from, to] = spec.split('->');
    const target = to?.trim();
    if (target === undefined || target === '') {
      throw new CliError(`--transition ${spec} is not [<from>]-><to>`, EXIT_USAGE, {
        hint: 'omit the left side to mean ANY source state, e.g. --transition "->Shipped"',
      });
    }
    const source = from?.trim();
    return source === undefined || source === ''
      ? { to: target }
      : { from: source, to: target };
  });
}

async function spaceWorkflowSet(cmd: CommandContext): Promise<ExitCode> {
  const name = requireArg('space workflow set', cmd.args[0], 'a <name>');
  noExtraArgs('space workflow set', cmd.args, 1);
  const spaceId = requireSpace(cmd.ctx);
  const kind = cmd.options.value('kind');
  const body = mutationBody(cmd);
  body.name = name;
  // Explicitly null rather than omitted: `kind` is a REQUIRED field that is
  // nullable, and the strict schema would refuse the key's absence. Null here
  // means "governs any kind", which the server then refuses for a space-scoped
  // workflow — the built-in default is the only kindless row and it is seeded
  // by migration, never authored.
  body.kind = kind === undefined ? null : kind;
  body.states = workflowStatesFrom(cmd);
  const transitions = workflowTransitionsFrom(cmd);
  if (transitions.length > 0) body.transitions = transitions;
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.workflows.upsert', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderWorkflow);
  return EXIT_OK;
}

async function spaceWorkflowDelete(cmd: CommandContext): Promise<ExitCode> {
  const workflowId = requireArg('space workflow delete', cmd.args[0], 'a <workflow-id>');
  noExtraArgs('space workflow delete', cmd.args, 1);
  requireConsent('space workflow delete', cmd);
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.workflows.delete', {
    params: { spaceId, workflowId },
    body: mutationBody(cmd),
  });
  cmd.out.data(data, (dto) => field(dto, 'workflowId') ?? fallback(dto));
  return EXIT_OK;
}

async function spaceLeaderboard(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space leaderboard get', cmd.options.value('mutation-id'));
  noExtraArgs('space leaderboard get', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.leaderboard', {
    params: { spaceId },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderLeaderboard);
  return EXIT_OK;
}

async function spaceAwardList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space award list', cmd.options.value('mutation-id'));
  noExtraArgs('space award list', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.awards', {
    params: { spaceId },
    query: pageQuery(cmd),
  });
  cmd.out.data(data, renderAwards);
  return EXIT_OK;
}

async function spaceMenuGet(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('space menu get', cmd.options.value('mutation-id'));
  noExtraArgs('space menu get', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.menu.get', {
    params: { spaceId },
  });
  cmd.out.data(data, renderMenu);
  return EXIT_OK;
}

/**
 * A02. `--data` carries the menu PAYLOAD and `--expect-revision` the guard,
 * which is the only reading that makes the frozen syntax coherent: if `--data`
 * were the whole `UpdateMenuInput`, the required `--expect-revision` beside it
 * would have nothing to bind to. §7.5 names `--expect-revision` as the guard
 * for a revisioned configuration row, which is exactly what a menu is.
 */
async function spaceMenuUpdate(cmd: CommandContext): Promise<ExitCode> {
  noExtraArgs('space menu update', cmd.args, 1);
  const spaceId = spaceFromArgOrContext(cmd, cmd.args[0]);
  const expectedRevision = requireInteger(cmd, 'expect-revision');
  const source = cmd.options.value('data');
  if (source === undefined) {
    throw new CliError('tm8 space menu update requires --data <json-source>', EXIT_USAGE);
  }
  const payload = await readJsonSource(source);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CliError('--data expects a menu configuration OBJECT', EXIT_USAGE, {
      hint: '--data \'{"schemaVersion":1,"groups":[…]}\'',
    });
  }

  const body = authorlessMutationBody('space menu update', cmd);
  body.expectedRevision = expectedRevision;
  body.payload = payload;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.menu.update', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderMenu);
  return EXIT_OK;
}

/**
 * A03, with its guard. RESTORATION, NOT INVENTION — and the distinction is the
 * whole justification for adding a flag no document names.
 *
 * `SetDefaultChannelInput` has ALWAYS required `expectedSettingsRevision`. The
 * capability is frozen and adopted; the CLI never had a choice about sending
 * it, because omitting it means every call 400s and the operation is simply
 * DEAD. What was unspecified is only the FLAG NAME, and the flag surface is
 * this wave's own — not contract territory.
 *
 * The FIELD is read by RUNTIME INTROSPECTION of the frozen schema, never by
 * grepping for a name someone already thought of:
 *
 *     SetDefaultChannelInputSchema
 *       clientMutationId          ZodString            REQUIRED
 *       expectedSettingsRevision  ZodNumber            REQUIRED
 *       channelId                 ZodNullable | null   REQUIRED
 *
 * ⚠ THE FLAG IS `--expect-revision`; THE FIELD IS `expectedSettingsRevision`.
 * THEY DELIBERATELY DIFFER, AND THIS IS A RULING, NOT AN OVERSIGHT.
 * Kebab-casing the field would give `--expect-settings-revision`, but the
 * derivation is only the DEFAULT: where an authority names a spelling, the
 * authority wins, and the dossier §7 table titled "CLI freeze" names
 * `--expect-revision` for this row at :325 while writing the field correctly as
 * `expectedSettingsRevision` in §4 at :119. It knew the field and chose a
 * shorter flag.
 *
 * ⚠ THE HAZARD, NAMED SO THE NEXT READER DOES NOT WALK INTO IT: `space menu
 * update` ALSO takes `--expect-revision`, on the same noun, in this same file —
 * but its field is `expectedRevision`, NOT `expectedSettingsRevision`. Two
 * adjacent rows, one flag spelling, two different fields. Crossing them is a
 * live mistake that has already been made once at coordinator level. It fails
 * LOUDLY rather than silently — both schemas are `.strict()`, so the wrong key
 * is a `400 invalid_input` on the first real call and cannot ship green — but
 * the integration suite pins each row's field explicitly so the wire shape is
 * asserted rather than assumed.
 *
 * The revision is NOT read-before-write here. Fetching it silently would defeat
 * the optimistic concurrency the field exists for: the caller must state the
 * revision they believe they are updating, which is the entire point of a guard.
 */
async function spaceDefaultChannelSet(cmd: CommandContext): Promise<ExitCode> {
  const channel = requireArg('space default-channel set', cmd.args[0], 'a <channel-id|none>');
  noExtraArgs('space default-channel set', cmd.args, 1);
  const spaceId = requireSpace(cmd.ctx);
  const expectedSettingsRevision = requireInteger(cmd, 'expect-revision');

  const body = authorlessMutationBody('space default-channel set', cmd);
  body.expectedSettingsRevision = expectedSettingsRevision;
  body.channelId = noneAsNull(channel) ?? null;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'spaces.defaultChannel.set', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, (dto) => field(dto, 'defaultChannelId') ?? fallback(dto));
  return EXIT_OK;
}

export const SPACE_COMMANDS: CommandModule[] = [
  { path: ['space', 'list'], run: spaceList },
  { path: ['space', 'create'], run: spaceCreate },
  { path: ['space', 'get'], run: spaceGet },
  { path: ['space', 'update'], run: spaceUpdate },
  {
    path: ['space', 'navigation', 'get'],
    run: spaceProjection('space navigation get', 'spaces.navigation', renderNavigation),
  },
  { path: ['space', 'home', 'get'], run: spaceProjection('space home get', 'spaces.home', renderHome) },
  { path: ['space', 'counts', 'get'], run: spaceProjection('space counts get', 'spaces.counts', renderCounts) },
  {
    path: ['space', 'settings', 'get'],
    run: spaceProjection('space settings get', 'spaces.settings', renderSettings),
  },
  { path: ['space', 'member', 'list'], run: spaceMemberList },
  { path: ['space', 'member', 'role'], run: spaceMemberRole },
  { path: ['space', 'invite', 'list'], run: spaceInviteList },
  { path: ['space', 'invite', 'resolve'], run: spaceInviteResolve },
  { path: ['space', 'invite', 'create'], run: spaceInviteCreate },
  { path: ['space', 'invite', 'revoke'], run: spaceInviteRevoke },
  { path: ['space', 'invite', 'redeem'], run: spaceInviteRedeem },
  { path: ['space', 'task-axis', 'list'], run: spaceTaskAxisList },
  { path: ['space', 'task-axis', 'create'], run: spaceTaskAxisCreate },
  { path: ['space', 'task-axis', 'update'], run: spaceTaskAxisUpdate },
  { path: ['space', 'task-axis', 'delete'], run: spaceTaskAxisDelete },
  { path: ['space', 'task-workflow', 'list'], run: spaceTaskWorkflowList },
  { path: ['space', 'task-workflow', 'set'], run: spaceTaskWorkflowSet },
  { path: ['space', 'task-workflow', 'delete'], run: spaceTaskWorkflowDelete },
  { path: ['space', 'workflow', 'list'], run: spaceWorkflowList },
  { path: ['space', 'workflow', 'set'], run: spaceWorkflowSet },
  { path: ['space', 'workflow', 'delete'], run: spaceWorkflowDelete },
  { path: ['space', 'leaderboard', 'get'], run: spaceLeaderboard },
  { path: ['space', 'award', 'list'], run: spaceAwardList },
  { path: ['space', 'menu', 'get'], run: spaceMenuGet },
  { path: ['space', 'menu', 'update'], run: spaceMenuUpdate },
  { path: ['space', 'default-channel', 'set'], run: spaceDefaultChannelSet },
];
