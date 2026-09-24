/**
 * `tm8 kind list|create|update` — the custom entity-kind registry (§4.14),
 * projecting `entityKinds.list`, `entityKinds.create`, and `entityKinds.update`.
 *
 * Three rules this file exists to keep:
 *
 *  - CUSTOM KINDS ONLY. `entityKinds.create` is bound to `CustomEntityKind`,
 *    the `c:`-prefixed namespace. `tm8 kind create task` is refused HERE, with
 *    the namespace named, rather than sent for the Server to reject: the caller
 *    is trying to redefine a core kind and needs to be told that is not a
 *    permission problem but a category error.
 *  - A READ TAKES NO MUTATION ID. `kind list --mutation-id` is a caller who
 *    believes their read is idempotently retryable in a way it is not.
 *  - AN EMPTY UPDATE IS A USAGE ERROR. `kind update c:recipe` with nothing to
 *    change would send a request that either no-ops or bumps a version for no
 *    reason; neither is what the caller meant.
 *
 * There is deliberately NO `kind delete`: §4.14 does not define one, and a
 * custom kind with live rows cannot be removed without a story for those rows.
 */
import { CORE_KIND_INFO, coreKindInfo, KIND_GROUPS } from '@tm8/contract';

import { readJsonSource } from '../args.js';
import { requireSpace } from '../context.js';
import { CliError, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit.js';
import { refuseMutationId, resolveMutationId } from '../mutation.js';
import { clientFor, observedInvoke } from '../discovery/observe.js';
import type { CommandContext, CommandModule } from '../run.js';

/** `<c:name>` — the literal `c:` namespace, per §3's `custom-kind` production. */
function requireCustomKind(raw: string | undefined): string {
  if (raw === undefined) {
    throw new CliError('tm8 kind create/update requires a <c:name>', EXIT_USAGE, {
      hint: 'custom kinds live in the `c:` namespace, e.g. `c:recipe`',
    });
  }
  if (!raw.startsWith('c:') || raw.length <= 2) {
    throw new CliError(
      `${JSON.stringify(raw)} is not a custom kind: custom kinds are written \`c:<name>\``,
      EXIT_USAGE,
      {
        hint:
          raw.includes(':')
            ? 'only the `c:` namespace is caller-definable'
            : `core kinds cannot be redefined; did you mean \`c:${raw}\`?`,
      },
    );
  }
  return raw;
}

/**
 * `--schema <json-source>` carries `fieldSchema`, which the contract types as
 * an ARRAY of field definitions. A caller who passes a JSON Schema object here
 * has misread the flag, and finding that out locally beats a 400 that names a
 * field they did not know existed.
 */
async function readFieldSchema(raw: string): Promise<unknown[]> {
  const parsed = await readJsonSource(raw);
  if (!Array.isArray(parsed)) {
    throw new CliError(
      '--schema expects an ARRAY of custom field definitions, not a single object',
      EXIT_USAGE,
      { hint: '--schema \'[{"name":"servings","type":"number"}]\'' },
    );
  }
  return parsed;
}

async function readCapabilities(raw: string): Promise<Record<string, boolean>> {
  const parsed = await readJsonSource(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--capabilities expects a JSON object of boolean flags', EXIT_USAGE);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'boolean') {
      throw new CliError(`--capabilities.${key} must be a boolean, got ${typeof value}`, EXIT_USAGE);
    }
  }
  return parsed as Record<string, boolean>;
}

/** `--icon <value|none>`; the literal `none` clears it, per §4's `|none` idiom. */
function iconOf(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === 'none' ? null : raw;
}

async function kindList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('kind list', cmd.options.value('mutation-id'));
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entityKinds.list', {
    params: { spaceId },
  });
  cmd.out.data(describeKinds(data), renderKinds);
  return EXIT_OK;
}

async function kindCreate(cmd: CommandContext): Promise<ExitCode> {
  const kind = requireCustomKind(cmd.args[0]);
  const spaceId = requireSpace(cmd.ctx);
  const schemaSource = cmd.options.value('schema');
  if (schemaSource === undefined) {
    throw new CliError('tm8 kind create requires --schema <json-source>', EXIT_USAGE);
  }
  const capabilitiesSource = cmd.options.value('capabilities');

  const body: Record<string, unknown> = {
    kind,
    fieldSchema: await readFieldSchema(schemaSource),
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const icon = iconOf(cmd.options.value('icon'));
  if (icon !== undefined) body.icon = icon;
  if (capabilitiesSource !== undefined) body.capabilities = await readCapabilities(capabilitiesSource);
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entityKinds.create', {
    params: { spaceId },
    body,
  });
  cmd.out.data(data, renderKind);
  return EXIT_OK;
}

async function kindUpdate(cmd: CommandContext): Promise<ExitCode> {
  const kind = requireCustomKind(cmd.args[0]);
  const spaceId = requireSpace(cmd.ctx);

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const schemaSource = cmd.options.value('schema');
  const capabilitiesSource = cmd.options.value('capabilities');
  const icon = iconOf(cmd.options.value('icon'));

  if (schemaSource !== undefined) body.fieldSchema = await readFieldSchema(schemaSource);
  if (capabilitiesSource !== undefined) body.capabilities = await readCapabilities(capabilitiesSource);
  if (icon !== undefined) body.icon = icon;
  if (cmd.options.bool('allow-tightening')) body.allowTightening = true;

  const changes = ['fieldSchema', 'capabilities', 'icon'].filter((k) => k in body);
  if (changes.length === 0) {
    throw new CliError('tm8 kind update needs something to change', EXIT_USAGE, {
      hint: 'pass --schema, --capabilities, or --icon; a tightening change also needs --allow-tightening',
    });
  }
  if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value;

  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entityKinds.update', {
    params: { spaceId, kind },
    body,
  });
  cmd.out.data(data, renderKind);
  return EXIT_OK;
}

interface KindRow {
  kind?: unknown;
  origin?: unknown;
  fieldSchema?: unknown;
  group?: unknown;
  summary?: unknown;
  createWith?: unknown;
}

function rowsOf(dto: unknown): KindRow[] {
  return Array.isArray((dto as { kinds?: unknown })?.kinds)
    ? (dto as { kinds: KindRow[] }).kinds
    : Array.isArray(dto)
      ? (dto as KindRow[])
      : [];
}

/**
 * The registry row plus what the kind is FOR: a group, one line of purpose and
 * the command that creates one. Core kinds read it from `CORE_KIND_INFO`; a
 * custom kind's purpose is its fields, and it is always made by `entity create`.
 * Added to the json rows too, so `--format json` readers get the same answers.
 */
function describe(row: KindRow): KindRow {
  const kind = String(row.kind);
  const info = coreKindInfo(kind);
  if (info) return { ...row, group: info.group, summary: info.summary, createWith: info.createWith };
  const custom = kind.startsWith('c:');
  return {
    ...row,
    group: custom ? 'custom' : 'other',
    summary: custom ? fieldsSummary(row.fieldSchema) : 'no description yet',
    createWith: [`entity create ${kind}`],
  };
}

function fieldsSummary(schema: unknown): string {
  const fields = Array.isArray(schema) ? (schema as Array<{ name?: unknown; type?: unknown }>) : [];
  if (fields.length === 0) return 'a custom kind with no fields';
  const list = fields.map((f) => `${String(f.name)} (${String(f.type)})`).join(', ');
  return `custom kind, ${fields.length} field${fields.length === 1 ? '' : 's'}: ${list}`;
}

function describeKinds(dto: unknown): unknown {
  if (Array.isArray(dto)) return (dto as KindRow[]).map(describe);
  const kinds = (dto as { kinds?: unknown })?.kinds;
  return Array.isArray(kinds) ? { ...(dto as object), kinds: (kinds as KindRow[]).map(describe) } : dto;
}

/** Within a group, the catalog's own order (task before loop), then by name. */
const CATALOG_ORDER = Object.keys(CORE_KIND_INFO);
function catalogRank(kind: string): number {
  const i = CATALOG_ORDER.indexOf(kind);
  return i === -1 ? CATALOG_ORDER.length : i;
}

const EXTRA_GROUPS = [
  { group: 'custom', title: 'Custom' },
  { group: 'other', title: 'Other' },
];

/**
 * The human view renders from the SAME DTO json emits, grouped, one kind per
 * line with its purpose and the command that creates it. The kind name leads
 * every line: it is the value `--kind` and `kind update` take.
 */
function renderKinds(dto: unknown): string {
  const rows = rowsOf(dto);
  if (rows.length === 0) return 'no entity kinds';
  const custom = rows.filter((r) => String(r.kind).startsWith('c:')).length;
  const width = Math.max(...rows.map((r) => String(r.kind).length)) + 2;
  const out = [
    `${rows.length} entity kinds in this space (${rows.length - custom} core, ${custom} custom).`,
    'Every entity has an id, a kind, a title, a version, a parent of its own kind and typed edges.',
  ];
  for (const { group, title } of [...KIND_GROUPS, ...EXTRA_GROUPS]) {
    const members = rows
      .filter((r) => r.group === group)
      .sort((a, b) => catalogRank(String(a.kind)) - catalogRank(String(b.kind)) || String(a.kind).localeCompare(String(b.kind)));
    if (members.length === 0) continue;
    out.push('', title);
    for (const r of members) {
      const make = Array.isArray(r.createWith) ? r.createWith.map((c) => `tm8 ${String(c)}`).join(' | ') : '';
      out.push(`  ${String(r.kind).padEnd(width)}${String(r.summary)}${make ? `  → ${make}` : ''}`);
    }
  }
  out.push(
    '',
    'Find entities of a kind: tm8 entity query --kind <kind>. Read one: tm8 entity context <id>.',
  );
  return out.join('\n');
}

function renderKind(dto: unknown): string {
  const kind = (dto as { kind?: unknown })?.kind;
  return kind === undefined ? JSON.stringify(dto) : String(kind);
}

export const KIND_COMMANDS: CommandModule[] = [
  { path: ['kind', 'list'], run: kindList },
  { path: ['kind', 'create'], run: kindCreate },
  { path: ['kind', 'update'], run: kindUpdate },
];
