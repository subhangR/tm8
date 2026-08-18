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
 *  - A BASE IS SET AT CREATION. `--extends task` belongs to `kind create` only;
 *    `kind update --extends` is refused HERE, naming the reason, because
 *    re-basing would change which detail table the kind's EXISTING rows are
 *    supposed to have — a data migration wearing an update's clothes.
 *  - AN EMPTY UPDATE IS A USAGE ERROR. `kind update c:recipe` with nothing to
 *    change would send a request that either no-ops or bumps a version for no
 *    reason; neither is what the caller meant.
 *
 * There is deliberately NO `kind delete`: §4.14 does not define one, and a
 * custom kind with live rows cannot be removed without a story for those rows.
 */
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

/** `--label <text|none>` / `--label-plural <text|none>`, same `|none` idiom. */
function labelOf(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw === 'none' ? null : raw;
}

/**
 * `--extends <task>`. The set of bases is CLOSED by the contract, not by a
 * database constraint, and `task` is the only one whose create door exists —
 * so a caller who writes `--extends doc` is refused here, naming the closed
 * set, rather than sent for a 400 that reads like a permissions problem.
 */
function baseKindOf(raw: string | undefined): 'task' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'task') {
    throw new CliError(`--extends ${JSON.stringify(raw)} is not a servable base kind`, EXIT_USAGE, {
      hint: '`task` is the only base a kind may extend today',
    });
  }
  return raw;
}

async function kindList(cmd: CommandContext): Promise<ExitCode> {
  refuseMutationId('kind list', cmd.options.value('mutation-id'));
  const spaceId = requireSpace(cmd.ctx);
  const data = await observedInvoke<unknown>(clientFor(cmd.ctx), 'entityKinds.list', {
    params: { spaceId },
  });
  cmd.out.data(data, renderKinds);
  return EXIT_OK;
}

async function kindCreate(cmd: CommandContext): Promise<ExitCode> {
  const kind = requireCustomKind(cmd.args[0]);
  const spaceId = requireSpace(cmd.ctx);
  const baseKind = baseKindOf(cmd.options.value('extends'));
  const schemaSource = cmd.options.value('schema');
  // A kind that extends `task` carries a task detail row and NO custom-fields
  // row, so it may not declare a field schema — the flag is optional there and
  // the required empty array is supplied here rather than typed by the caller.
  if (schemaSource === undefined && baseKind === undefined) {
    throw new CliError('tm8 kind create requires --schema <json-source>', EXIT_USAGE);
  }
  const capabilitiesSource = cmd.options.value('capabilities');

  const body: Record<string, unknown> = {
    kind,
    fieldSchema: schemaSource === undefined ? [] : await readFieldSchema(schemaSource),
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  if (baseKind !== undefined) body.baseKind = baseKind;
  const icon = iconOf(cmd.options.value('icon'));
  if (icon !== undefined) body.icon = icon;
  const label = labelOf(cmd.options.value('label'));
  if (label !== undefined) body.label = label;
  const labelPlural = labelOf(cmd.options.value('label-plural'));
  if (labelPlural !== undefined) body.labelPlural = labelPlural;
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
  // `extends` is set at creation and never patched: re-basing a kind changes
  // which detail table its EXISTING rows are supposed to have, which is a data
  // migration wearing an update's clothes. The server refuses it, and so does
  // this — with the reason, which a 400 would not carry.
  if (cmd.options.value('extends') !== undefined) {
    throw new CliError('tm8 kind update cannot change --extends', EXIT_USAGE, {
      hint: 'a base is set at creation: re-basing would change which detail rows existing entities are supposed to have',
    });
  }

  const body: Record<string, unknown> = {
    clientMutationId: resolveMutationId(cmd.options.value('mutation-id')),
  };
  const schemaSource = cmd.options.value('schema');
  const capabilitiesSource = cmd.options.value('capabilities');
  const icon = iconOf(cmd.options.value('icon'));
  const label = labelOf(cmd.options.value('label'));
  const labelPlural = labelOf(cmd.options.value('label-plural'));

  if (schemaSource !== undefined) body.fieldSchema = await readFieldSchema(schemaSource);
  if (capabilitiesSource !== undefined) body.capabilities = await readCapabilities(capabilitiesSource);
  if (icon !== undefined) body.icon = icon;
  if (label !== undefined) body.label = label;
  if (labelPlural !== undefined) body.labelPlural = labelPlural;
  if (cmd.options.bool('allow-tightening')) body.allowTightening = true;

  const changes = ['fieldSchema', 'capabilities', 'icon', 'label', 'labelPlural'].filter((k) => k in body);
  if (changes.length === 0) {
    throw new CliError('tm8 kind update needs something to change', EXIT_USAGE, {
      hint: 'pass --schema, --capabilities, --icon, --label, or --label-plural; a tightening change also needs --allow-tightening',
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
  baseKind?: unknown;
  label?: unknown;
}

/**
 * The human view renders from the SAME DTO json emits, and always keeps the
 * kind name — that is the id a follow-up `tm8 kind update` needs.
 *
 * The base and the label are shown because they are what distinguishes two
 * custom kinds that otherwise read identically: `extends task` says which
 * irreducible code runs for the kind's entities, and the label is what every
 * client renders instead of the `c:` name.
 */
function renderKinds(dto: unknown): string {
  const rows = Array.isArray((dto as { kinds?: unknown })?.kinds)
    ? ((dto as { kinds: KindRow[] }).kinds)
    : Array.isArray(dto)
      ? (dto as KindRow[])
      : [];
  if (rows.length === 0) return 'no entity kinds';
  return rows
    .map((r) => {
      const fields = Array.isArray(r.fieldSchema) ? r.fieldSchema.length : 0;
      return [
        String(r.kind),
        r.origin === undefined || r.origin === null ? undefined : String(r.origin),
        typeof r.baseKind === 'string' ? `extends ${r.baseKind}` : undefined,
        typeof r.label === 'string' ? r.label : undefined,
        `${fields} field${fields === 1 ? '' : 's'}`,
      ]
        .filter((p): p is string => p !== undefined && p !== '')
        .join('  ');
    })
    .join('\n');
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
