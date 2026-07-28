import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from './source-inventory.js';

export const W1_MIGRATION_SOURCE = 'db/migrations/015_w1_foundations.sql' as const;
export const W1_MIGRATION_SHA256 =
  '9f3258054fb1a0a3cbc80928edcea87760715f2402671534bd32a232773b5ee7' as const;

export interface W1MigrationObjectInventory {
  readonly tables: readonly string[];
  readonly entityKindSeeds: readonly string[];
  readonly edgeTypeSeeds: readonly string[];
  readonly indexes: number;
  readonly triggers: number;
  readonly rlsTables: readonly string[];
  readonly policies: number;
  readonly publicAppRpcs: readonly string[];
  readonly deliveryRpcs: readonly string[];
  readonly replacedRpcs: readonly string[];
}

export interface W1MigrationInventory {
  readonly source: typeof W1_MIGRATION_SOURCE;
  readonly sha256: typeof W1_MIGRATION_SHA256;
  readonly objects: W1MigrationObjectInventory;
}

function captures(source: string, expression: RegExp, context: string): string[] {
  if (!expression.global) throw new Error(`${context} inventory expression must be global`);
  const values = [...source.matchAll(expression)].map((match) => match[1]);
  if (values.some((value) => !value)) throw new Error(`${context} inventory contains an empty capture`);
  const unique = new Set(values);
  if (unique.size !== values.length) throw new Error(`${context} inventory contains duplicate objects`);
  return values as string[];
}

function insertSeeds(source: string, registry: 'entity_kinds' | 'edge_types'): string[] {
  const block = source.match(new RegExp(
    `^insert into public\\.${registry}\\([^;]+?^on conflict [^;]+;`,
    'm',
  ));
  if (!block) throw new Error(`015 is missing the ${registry} seed statement`);
  return captures(block[0], /^\s*\('([^']+)'/gm, `${registry} seeds`);
}

function executeFunctionBlocks(
  source: string,
  verb: 'grant' | 'revoke',
): ReadonlyMap<string, readonly string[]> {
  const expression = new RegExp(
    `^${verb} execute on function\\s*\\n([\\s\\S]*?)^(?:to|from) ([a-z0-9_]+);$`,
    'gm',
  );
  const blocks = new Map<string, readonly string[]>();
  for (const match of source.matchAll(expression)) {
    const body = match[1];
    const role = match[2];
    if (!body || !role) throw new Error(`015 has an unreadable ${verb} execute block`);
    if (blocks.has(role)) throw new Error(`015 has duplicate ${verb} execute blocks for ${role}`);
    const functions = captures(body, /public\.([a-z0-9_]+)\(/g, `${verb} execute ${role}`);
    blocks.set(role, functions);
  }
  return blocks;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Reads the frozen migration as one SQL document. The parser only inventories
 * top-level DDL/grant statements; it does not split dollar-quoted DO or
 * PL/pgSQL bodies and therefore cannot accidentally claim executable coverage.
 */
export async function readW1MigrationInventory(): Promise<W1MigrationInventory> {
  const source = await readFile(join(repositoryRoot, W1_MIGRATION_SOURCE), 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== W1_MIGRATION_SHA256) {
    throw new Error(
      `frozen 015 digest drift: expected ${W1_MIGRATION_SHA256}, got ${sha256}`,
    );
  }

  const tables = captures(source, /^create table public\.([a-z0-9_]+) \(/gm, '015 tables');
  const indexes = captures(
    source,
    /^create (?:unique )?index ([a-z0-9_]+)(?:\s|$)/gm,
    '015 indexes',
  );
  const triggers = captures(source, /^create trigger ([a-z0-9_]+)(?:\s|$)/gm, '015 triggers');
  const rlsTables = captures(
    source,
    /^alter table public\.([a-z0-9_]+) enable row level security;$/gm,
    '015 RLS tables',
  );
  const policies = captures(source, /^create policy ([a-z0-9_]+)(?:\s|$)/gm, '015 policies');
  const publicFunctions = captures(
    source,
    /^create (?:or replace )?function public\.([a-z0-9_]+)\(/gm,
    '015 public functions',
  );
  const grants = executeFunctionBlocks(source, 'grant');
  const revokes = executeFunctionBlocks(source, 'revoke');
  assertEqual([...grants.keys()], ['tm8_app', 'tm8_delivery_worker'], '015 execute-grant roles');
  assertEqual([...revokes.keys()], ['public', 'tm8_app'], '015 explicit execute-revoke roles');

  const publicAppRpcs = grants.get('tm8_app');
  const deliveryRpcs = grants.get('tm8_delivery_worker');
  if (!publicAppRpcs || !deliveryRpcs) throw new Error('015 is missing an exact execute allowlist');
  assertEqual(revokes.get('public'), deliveryRpcs, 'delivery RPC PUBLIC revocation');
  assertEqual(revokes.get('tm8_app'), deliveryRpcs, 'delivery RPC tm8_app revocation');

  const classified = new Set([...publicAppRpcs, ...deliveryRpcs]);
  const replacedRpcSet = publicFunctions.filter((name) => !classified.has(name));
  const replacedRpcs = ['create_space', 'mark_read', 'mark_notification_read'].filter(
    (name) => replacedRpcSet.includes(name),
  );
  assertEqual(
    publicFunctions.length,
    publicAppRpcs.length + deliveryRpcs.length + replacedRpcs.length,
    '015 public function classification',
  );

  const objects: W1MigrationObjectInventory = {
    tables,
    entityKindSeeds: insertSeeds(source, 'entity_kinds'),
    edgeTypeSeeds: insertSeeds(source, 'edge_types'),
    indexes: indexes.length,
    triggers: triggers.length,
    rlsTables,
    policies: policies.length,
    publicAppRpcs,
    deliveryRpcs,
    replacedRpcs,
  };

  assertEqual(objects.tables.length, 10, '015 table count');
  assertEqual(objects.entityKindSeeds, ['project', 'interaction_profile'], '015 kind seeds');
  assertEqual(objects.edgeTypeSeeds, [
    'in_project',
    'shared_into',
    'participates_in',
    'authored_from',
    'defaults_to_profile',
    'selected_profile',
  ], '015 edge seeds');
  assertEqual(objects.indexes, 24, '015 index count');
  assertEqual(objects.triggers, 27, '015 trigger count');
  assertEqual(objects.rlsTables, objects.tables, '015 RLS coverage');
  assertEqual(objects.policies, 11, '015 policy count including notifications replacement');
  assertEqual(objects.publicAppRpcs, [
    'set_space_default_channel',
    'set_space_profile_default',
    'set_space_menu_config',
    'reset_session_wake_budget_for_member_reply',
    'set_teammate_profile_default',
    'inspect_owned_teammate_inbox',
    'repair_w1_foundations',
    'compensate_w1_foundations',
  ], '015 tm8_app RPC allowlist');
  assertEqual(objects.deliveryRpcs, [
    'reserve_session_message_delivery',
    'claim_session_message_delivery',
    'settle_session_message_delivery',
  ], '015 delivery RPC allowlist');
  assertEqual(
    [...replacedRpcSet].sort(),
    ['create_space', 'mark_notification_read', 'mark_read'],
    '015 replaced public RPC set',
  );

  return { source: W1_MIGRATION_SOURCE, sha256: W1_MIGRATION_SHA256, objects };
}
