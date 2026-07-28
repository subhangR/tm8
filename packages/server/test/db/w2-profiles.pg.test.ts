import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * Both chains below are DERIVED from `migrationFiles()`, which reads the whole
 * `db/migrations` directory in official order — never from a hand-written list
 * of filenames. A hand-listed slice is how G03's fixture silently omitted 020
 * and hid a confirmed `placements.apply` defect through five gates: the slice
 * cannot narrow when the directory grows, so nobody notices what it stopped
 * covering. The guard test below pins the file count, the sorted order and the
 * presence of every migration these operations depend on, so this fixture
 * cannot narrow silently either.
 *
 * These remain ISOLATION proofs. Full-chain operational coverage is
 * `test/db/w2-migration-order.pg.test.ts`, not this file.
 */
const G12_MIGRATION = '027_w2_entity_kinds_profiles.sql';
const G14_MIGRATION = '029_w2_menu_default_channel.sql';

/** Every repository migration, official order, no filtering. */
function allMigrations(): string[] {
  return migrationFiles();
}

function upTo(prefix: string, files: readonly string[]): string[] {
  const end = files.findIndex((file) => file.startsWith(prefix));
  if (end < 0) throw new Error(`missing migration ${prefix} in the repository chain`);
  return files.slice(0, end + 1);
}

/**
 * G12's dependency floor: the frozen 001–016 foundation plus 027 itself. 027
 * declares it depends on nothing later, and applying exactly that set is what
 * proves the claim rather than assuming it.
 */
function isolationMigrations(): string[] {
  const files = allMigrations();
  const g12 = files.find((file) => file === G12_MIGRATION);
  if (!g12) throw new Error(`missing W2.G12 migration ${G12_MIGRATION}`);
  return [...upTo('016_', files), g12];
}

/**
 * The dependency-safe W2 tranche as it exists on disk: every repository
 * migration in official order except 019, which is not part of this
 * compatibility set. Derived by exclusion so a new migration joins the chain
 * automatically and the guard test notices.
 */
function frozenCompatibilityMigrations(): string[] {
  return allMigrations().filter((file) => !file.startsWith('019_'));
}

const DRAFT = {
  name: 'Core collaboration',
  templateKey: 'tm8.chat.core',
  templateVersion: 1,
  promptPolicy: {
    kernelTemplate: 'tm8.core.v1',
    manifestMaxBytes: 4096,
    kernelMaxBytes: 6144,
    initialContextMaxBytes: 32768,
    rollingControlMaxBytes: 32768,
    allowedInjectionKinds: [],
    untrustedEncoding: 'escaped-xml',
  },
  toolDiscoveryPolicy: {
    rootHelpRef: 'tm8://help',
    preloadNouns: ['entities', 'messages'],
    semanticSearchEnabled: true,
    semanticMaxMatches: 5,
    nounShardMaxBytes: 8192,
    commandShardMaxBytes: 16384,
    entityContextDefaultBytes: 16384,
    providerToolRegistrationAllowlist: ['entities.get', 'messages.post'],
  },
  feedPolicy: { scope: 'session_chat_v1', pageSize: 50, bodyExcerptBytes: 1024 },
  providerCaptureMode: 'explicit-only',
  composerPolicy: {
    schemaRef: 'tm8.composer.v1',
    supportsReply: true,
    supportsAttachments: true,
    allowedAttachmentKinds: ['file'],
    operationBindings: ['messages.post', 'messages.attachments.add'],
  },
};

interface Fixture {
  ownerIdentity: string;
  memberIdentity: string;
  outsiderIdentity: string;
  spaceA: string;
  spaceB: string;
  ownerA: string;
  ownerB: string;
  memberA: string;
  outsiderB: string;
  agentA: string;
  sessionA: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'g12-owner'::text "ownerIdentity",
              'g12-member'::text "memberIdentity",
              'g12-outsider'::text "outsiderIdentity",
              internal.new_id()::text "spaceA",
              internal.new_id()::text "spaceB",
              internal.new_id()::text "ownerA",
              internal.new_id()::text "ownerB",
              internal.new_id()::text "memberA",
              internal.new_id()::text "outsiderB",
              internal.new_id()::text "agentA",
              internal.new_id()::text "sessionA"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G12 Owner'), ($2, 'G12 Member'), ($3, 'G12 Outsider')`,
      [ids.ownerIdentity, ids.memberIdentity, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'g12-owner', 'G12 Owner', true, true),
              ($2, 'g12-member', 'G12 Member', false, false),
              ($3, 'g12-outsider', 'G12 Outsider', false, false)`,
      [ids.ownerIdentity, ids.memberIdentity, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G12 A', $3), ($2, 'G12 B', $3)`,
      [ids.spaceA, ids.spaceB, ids.ownerIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $5, 'member', 0, $1), ($2, $6, 'member', 0, $2),
              ($3, $5, 'member', 1, $3), ($4, $5, 'team_member', 2, $1),
              ($7, $5, 'work_session', 3, $1), ($8, $6, 'member', 1, $8)`,
      [ids.ownerA, ids.ownerB, ids.memberA, ids.agentA, ids.spaceA, ids.spaceB, ids.sessionA,
        ids.outsiderB],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'G12 Owner A'),
              ($2, $5, $6, 'owner', 'G12 Owner B'),
              ($3, $4, $7, 'member', 'G12 Member A'),
              ($8, $5, $9, 'member', 'G12 Outsider B')`,
      [ids.ownerA, ids.ownerB, ids.memberA, ids.spaceA, ids.spaceB,
        ids.ownerIdentity, ids.memberIdentity, ids.outsiderB, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name)
       values ($1, $2, 'G12 Agent')`,
      [ids.agentA, ids.ownerA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status)
       values ($1, 'G12 pin test', 'spawning')`,
      [ids.sessionA],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'relates_to', $4)`,
      [ids.spaceA, ids.sessionA, ids.agentA, ids.ownerA],
    );
    return ids;
  });
}

async function asApp<R extends QueryResultRow = QueryResultRow>(
  database: W1ScratchDatabase,
  identityId: string,
  actorId: string | null,
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    await client.query(`select set_config('tm8.actor_id', $1, true)`, [actorId ?? '']);
    return (await client.query<R>(sql, [...params])).rows;
  });
}

async function asAppClient(
  client: PoolClient,
  identityId: string,
  sql: string,
  params: readonly unknown[],
): Promise<unknown> {
  await client.query('begin');
  try {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    await client.query(`select set_config('tm8.actor_id', '', true)`);
    const result = await client.query(sql, [...params]);
    await client.query('commit');
    return result.rows[0]?.value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

// Pins what these fixtures apply, so a chain cannot narrow in silence — the
// failure mode that hid a confirmed defect for five gates. The property that
// actually catches it is STRUCTURAL: a chain must equal a set derived from
// `migrationFiles()`, which a hand-listed slice can never satisfy. The chain
// length is asserted only as a LOWER BOUND: an exact count would turn this
// guard into a tripwire that fires every time any sibling lands a migration,
// which is routine in an active wave and detects nothing a hand-listed slice
// would not already fail. Needs no database.
const MIGRATION_FLOOR = 26;

describe('W2.G12 fixture chains are derived, ordered and complete', () => {
  it('derives the repository chain from migrationFiles in official order', () => {
    const files = allMigrations();
    expect(files).toEqual(migrationFiles());
    expect(files).toEqual([...files].sort());
    expect(files.length).toBeGreaterThanOrEqual(MIGRATION_FLOOR);
    expect(files[0]).toBe('001_core_graph.sql');
    expect(files).toContain(G12_MIGRATION);
    expect(files).toContain(G14_MIGRATION);
    // 027 must keep applying before G14's 029 in the official order.
    expect(files.indexOf(G12_MIGRATION)).toBeLessThan(files.indexOf(G14_MIGRATION));
  });

  it('applies the frozen 001-016 foundation plus 027 and nothing later', () => {
    const chain = isolationMigrations();
    const files = allMigrations();
    expect(chain).toEqual([...chain].sort());
    expect(chain.at(-1)).toBe(G12_MIGRATION);
    // It is exactly the official chain truncated at 016, plus 027 — derived,
    // so it cannot be a hand-listed slice.
    expect(chain.slice(0, -1)).toEqual(files.filter((file) => file < '017'));
    expect(chain.filter((file) => file.startsWith('016_'))).toHaveLength(1);
    // 027 claims to depend on nothing after 016. Stated as a range rather than
    // a list of prefixes, so a migration landing later is excluded
    // automatically instead of silently slipping past a stale enumeration.
    const between = chain.filter((file) => file > '017' && file !== G12_MIGRATION);
    expect(between).toEqual([]);
  });

  it('applies the dependency-safe W2 tranche plus 027 and G14 029 for compatibility', () => {
    const chain = frozenCompatibilityMigrations();
    expect(chain).toEqual([...chain].sort());
    expect(chain).toContain(G12_MIGRATION);
    expect(chain).toContain(G14_MIGRATION);
    expect(chain.indexOf(G12_MIGRATION)).toBeLessThan(chain.indexOf(G14_MIGRATION));
    // Every repository migration except the one deliberately excluded.
    expect(chain).toEqual(allMigrations().filter((file) => !file.startsWith('019_')));
    expect(chain.some((file) => file.startsWith('019_'))).toBe(false);
    for (const required of ['015_', '016_', '018_', '020_', '021_', '024_']) {
      expect(chain.some((file) => file.startsWith(required))).toBe(true);
    }
  });
});

describe('W2.G12 entity kinds and Interaction Profiles PostgreSQL authority', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_profiles');
    database.apply(isolationMigrations());
    fixture = await seed(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('admits only Space-scoped c:* kinds, evolves schemas explicitly, and denies app DML', async () => {
    const created = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.w2_create_entity_kind($1, 'c:incident', 'siren',
         '[{"name":"severity","type":"enum","values":["low","high"]}]'::jsonb,
         '{"canEdit":true}'::jsonb, null, 'g12-kind-create') value`,
      [fixture.spaceA],
    );
    expect(created[0]!.value).toMatchObject({ kind: 'c:incident', origin: 'custom', spaceId: fixture.spaceA });

    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.w2_update_entity_kind($1, 'c:incident',
         '{"fieldSchema":[{"name":"severity","type":"enum","values":["high"]}]}'::jsonb,
         null, 'g12-kind-tighten')`,
      [fixture.spaceA],
    )).rejects.toMatchObject({ code: '23514' });

    const updated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.w2_update_entity_kind($1, 'c:incident',
         '{"fieldSchema":[{"name":"severity","type":"enum","values":["high"]}],"allowTightening":true}'::jsonb,
         null, 'g12-kind-tighten-confirmed') value`,
      [fixture.spaceA],
    );
    expect(updated[0]!.value).toMatchObject({ kind: 'c:incident' });

    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `update public.entity_kinds set icon = 'unsafe' where kind = 'c:incident'`,
    )).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.w2_create_entity_kind($1, 'interaction_profile', null, '[]', '{}', null, 'g12-core-kind')`,
      [fixture.spaceA],
    )).rejects.toMatchObject({ code: '22023' });
  });

  it('serializes concurrent first attempts through the command ledger', async () => {
    const first = await database.pool.connect();
    const second = await database.pool.connect();
    try {
      const sql = `select public.w2_create_entity_kind($1, 'c:race_kind', null, '[]', '{}', null,
                     'g12-kind-race') value`;
      const [a, b] = await Promise.all([
        asAppClient(first, fixture.ownerIdentity, sql, [fixture.spaceA]),
        asAppClient(second, fixture.ownerIdentity, sql, [fixture.spaceA]),
      ]);
      expect(a).toEqual(b);
      const rows = await database.query<{ count: string }>(
        `select count(*)::text count from public.entity_kinds
          where space_id = $1 and kind = 'c:race_kind'`,
        [fixture.spaceA],
      );
      expect(rows[0]!.count).toBe('1');
    } finally {
      first.release();
      second.release();
    }
  });

  it('enforces static validation, exact hash activation, preview non-mutation, and human principal authority', async () => {
    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-profile-propose') value`,
      [fixture.spaceA, JSON.stringify(DRAFT)],
    );
    const profileId = proposed[0]!.value.profileId as string;
    expect(proposed[0]!.value).toMatchObject({
      profileId, status: 'draft', currentDraftVersion: 1,
      generatedByTeamMemberId: fixture.agentA,
    });
    const replayed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-profile-propose') value`,
      [fixture.spaceA, JSON.stringify(DRAFT)],
    );
    expect(replayed[0]!.value).toEqual(proposed[0]!.value);

    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-capture-reserved')`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, providerCaptureMode: 'structured' })],
    )).rejects.toMatchObject({ code: '22023', detail: 'profile_capture_mode_reserved' });
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.delete_entity($1, null, 'g12-generic-delete')`,
      [profileId],
    )).rejects.toMatchObject({ code: '42501' });

    const invalidDraft = {
      ...DRAFT,
      templateKey: 'tm8.chat.unknown',
      toolDiscoveryPolicy: {
        ...DRAFT.toolDiscoveryPolicy,
        providerToolRegistrationAllowlist: ['search.query'],
      },
    };
    const invalid = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-invalid-propose') value`,
      [fixture.spaceA, JSON.stringify(invalidDraft)],
    );
    const invalidId = invalid[0]!.value.profileId as string;
    const invalidValidation = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.validate_interaction_profile($1, 1, 'g12-invalid-validate') value`,
      [invalidId],
    );
    expect(invalidValidation[0]!.value).toMatchObject({ status: 'invalid', validatedHash: null });
    expect(invalidValidation[0]!.value.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_static_template' }),
      expect.objectContaining({ code: 'unknown_operation_request' }),
    ]));

    const beforePreview = await database.query<{ count: string }>(
      `select count(*)::text count from public.command_ledger`,
    );
    const preview = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.preview_interaction_profile($1, 1) value`,
      [profileId],
    );
    expect(preview[0]!.value).not.toHaveProperty('promptPolicy');
    expect(preview[0]!.value).not.toHaveProperty('toolDiscoveryPolicy');
    expect(preview[0]!.value).not.toHaveProperty('providerCaptureMode');
    const afterPreview = await database.query<{ count: string }>(
      `select count(*)::text count from public.command_ledger`,
    );
    expect(afterPreview[0]!.count).toBe(beforePreview[0]!.count);

    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.validate_interaction_profile($1, 1, 'g12-profile-validate') value`,
      [profileId],
    );
    const hash = validated[0]!.value.validatedHash as string;
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-agent-activate')`,
      [profileId, hash],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, 'sha256:wrong', true, 'g12-wrong-hash')`,
      [profileId],
    )).rejects.toMatchObject({ code: '23514', detail: 'profile_not_validated' });

    const activated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-profile-activate') value`,
      [profileId, hash],
    );
    expect(activated[0]!.value).toMatchObject({ status: 'active', activeVersion: 1, activeHash: hash });
    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.set_teammate_profile_default($1, $2, 1, 'g12-agent-default')`,
      [fixture.agentA, profileId],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, $2, 1, false, 'g12-unconfirmed-agent-default')`,
      [fixture.spaceA, profileId],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    const validationEvidence = await database.query<{ validation_json: Record<string, unknown> }>(
      `select validation_json from public.interaction_profile_versions
        where profile_id = $1 and version = 1`,
      [profileId],
    );
    expect(validationEvidence[0]!.validation_json).toMatchObject({
      schemaVersion: 1,
      template: { key: 'tm8.chat.core', version: 1 },
      provenance: { generatedByTeamMemberId: fixture.agentA },
      structuredDiff: { baseline: 'initial activation — no prior baseline' },
    });
  });

  it('guards defaults, blocks retirement until references clear, and preserves frozen error reasons', async () => {
    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-default-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Defaults profile' })],
    );
    const profileId = proposed[0]!.value.profileId as string;
    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-default-validate') value`,
      [profileId],
    );
    const hash = validated[0]!.value.validatedHash as string;
    const activated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-default-activate') value`,
      [profileId, hash],
    );
    const profileVersion = activated[0]!.value.version as number;

    const teammate = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, $2, 1, 'g12-tm-default') value`,
      [fixture.agentA, profileId],
    );
    expect(teammate[0]!.value).toMatchObject({
      teamMemberId: fixture.agentA,
      defaultInteractionProfileId: profileId,
      version: 2,
    });
    const space = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, $2, 1, false, 'g12-space-default') value`,
      [fixture.spaceA, profileId],
    );
    expect(space[0]!.value).toMatchObject({
      spaceId: fixture.spaceA,
      defaultInteractionProfileId: profileId,
      settingsRevision: 2,
    });

    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.retire_interaction_profile($1, $2, true, 'g12-retire-blocked')`,
      [profileId, profileVersion],
    )).rejects.toMatchObject({ code: '23514', detail: 'profile_referenced_default' });

    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, null, 2, 'g12-tm-clear')`, [fixture.agentA]);
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, null, 2, false, 'g12-space-clear')`, [fixture.spaceA]);
    const retired = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.retire_interaction_profile($1, $2, true, 'g12-retire') value`,
      [profileId, profileVersion],
    );
    expect(retired[0]!.value).toMatchObject({ status: 'retired' });
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select internal.w2_resolve_interaction_profile_for_launch($1, $2, $3)`,
      [fixture.spaceA, fixture.agentA, profileId],
    )).rejects.toMatchObject({ code: '23514', detail: 'profile_retired' });
  });

  it('resolves override/default/core order and records an immutable pin plus selected_profile projection', async () => {
    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-pin-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Pinned profile' })],
    );
    const profileId = proposed[0]!.value.profileId as string;
    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-pin-validate') value`, [profileId],
    );
    const hash = validated[0]!.value.validatedHash as string;
    await asApp(database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-pin-activate')`, [profileId, hash]);
    const teammateVersion = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [fixture.agentA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, $2, $3, 'g12-pin-default')`,
      [fixture.agentA, profileId, teammateVersion[0]!.version]);

    const resolved = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select internal.w2_resolve_interaction_profile_for_launch($1, $2, null) value`,
      [fixture.spaceA, fixture.agentA],
    );
    expect(resolved[0]!.value).toMatchObject({ profileId, source: 'teammate_default' });
    const resolvedHash = resolved[0]!.value.resolvedHash as string;
    const pin = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select internal.w2_record_interaction_profile_pin($1, $2, 1,
         'teammate_default', $3) value`,
      [fixture.sessionA, profileId, resolvedHash],
    );
    expect(pin[0]!.value).toMatchObject({
      workSessionId: fixture.sessionA,
      pinRevision: 2,
      profileId,
      source: 'teammate_default',
    });
    const projection = await database.query<{ count: string }>(
      `select count(*)::text count from public.edges
        where src_id = $1 and dst_id = $2 and type = 'selected_profile'`,
      [fixture.sessionA, profileId],
    );
    expect(projection[0]!.count).toBe('1');

    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `select internal.w2_resolve_interaction_profile_for_launch($1, $2, $3)`,
      [fixture.spaceA, fixture.agentA, profileId],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `update public.work_session_interaction_pins set resolved_hash = 'unsafe'
        where work_session_id = $1`,
      [fixture.sessionA],
    )).rejects.toMatchObject({ code: '42501' });

    const currentTeammate = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [fixture.agentA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, null, $2, 'g12-pin-default-clear')`,
      [fixture.agentA, currentTeammate[0]!.version]);
    const currentProfile = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [profileId],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.retire_interaction_profile($1, $2, true, 'g12-pin-retire')`,
      [profileId, currentProfile[0]!.version]);
    const preservedPin = await database.query<{ resolved_hash: string }>(
      `select resolved_hash from public.work_session_interaction_pins
        where work_session_id = $1 and pin_revision = 2`,
      [fixture.sessionA],
    );
    expect(preservedPin).toEqual([{ resolved_hash: resolvedHash }]);
  });

  // A14 had no PostgreSQL-level coverage at all, and its optimistic version
  // check runs BEFORE its authorization. internal.assert_version raises 40001
  // carrying `currentVersion` and runs SECURITY DEFINER, so an unauthorized
  // caller learns a foreign profile exists and what version it is on. The
  // frozen sibling 021 authorizes before it touches the row; so must these.
  it('authorizes the draft lifecycle before its optimistic version check', async () => {
    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-draft-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Draft lifecycle profile' })],
    );
    const profileId = proposed[0]!.value.profileId as string;

    // The property under test is that no unauthorized caller reaches the
    // version check — whichever refusal fires first, it must not be the
    // version conflict and must not carry a version number.
    const probes: Array<[string, readonly unknown[]]> = [
      [`select public.update_interaction_profile_draft($1, 99, $2::jsonb, null, 'g12-draft-probe')`,
        [profileId, JSON.stringify(DRAFT)]],
      [`select public.validate_interaction_profile($1, 99, 'g12-validate-probe')`, [profileId]],
      [`select public.retire_interaction_profile($1, 99, true, 'g12-retire-probe')`, [profileId]],
    ];
    for (const [sql, params] of probes) {
      const error = await asApp(database, fixture.outsiderIdentity, null, sql, params).then(
        () => { throw new Error(`expected refusal for ${sql}`); },
        (thrown: { code?: string; detail?: string }) => thrown,
      );
      expect(error.code).not.toBe('40001');
      expect(error.detail ?? '').not.toContain('currentVersion');
    }

    // The authorized paths still work: the proposing Teammate may advance its
    // own draft, and a Teammate may not touch a profile it did not propose.
    const ownerProposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-draft-owner-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Owner proposed profile' })],
    );
    await expect(asApp(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.update_interaction_profile_draft($1, 1, $2::jsonb, null, 'g12-draft-foreign')`,
      [ownerProposed[0]!.value.profileId as string, JSON.stringify(DRAFT)],
    )).rejects.toMatchObject({ code: '42501' });

    const advanced = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, fixture.agentA,
      `select public.update_interaction_profile_draft($1, 1, $2::jsonb, null, 'g12-draft-advance') value`,
      [profileId, JSON.stringify({ ...DRAFT, name: 'Draft lifecycle profile v2' })],
    );
    expect(advanced[0]!.value).toMatchObject({ currentDraftVersion: 2, version: 2 });
    const versions = await database.query<{ count: string }>(
      `select count(*)::text count from public.interaction_profile_versions where profile_id = $1`,
      [profileId],
    );
    expect(versions[0]!.count).toBe('2');
  });

  // Matrix §2 carries `ui_template` as a NEGATIVE sentinel: static UI templates
  // are versioned registry assets with no entity id, table, route, migration
  // row or CLI noun, so nothing may let one enter the entity registry.
  it('keeps static Chat templates registry assets that can never become entities', async () => {
    const shape = await database.query<{
      registry: string | null; asset_table: string | null; internal_table: string | null;
      template_kinds: string; unknown_version: unknown;
    }>(
      `select to_regprocedure('internal.w2g12_static_chat_template(text,integer)')::text registry,
              to_regclass('public.ui_templates')::text asset_table,
              to_regclass('internal.static_chat_templates')::text internal_table,
              (select count(*)::text from public.entity_kinds
                where kind in ('ui_template','static_chat_template','template')) template_kinds,
              internal.w2g12_static_chat_template('tm8.chat.core', 2) unknown_version`,
    );
    expect(shape[0]!.registry).toBe('internal.w2g12_static_chat_template(text,integer)');
    expect(shape[0]!.asset_table).toBeNull();
    expect(shape[0]!.internal_table).toBeNull();
    expect(shape[0]!.template_kinds).toBe('0');
    expect(shape[0]!.unknown_version).toBeNull();

    // The rendered asset carries version identity only — never an entity id.
    const asset = await database.query<{ keys: string[] }>(
      `select array(select jsonb_object_keys(internal.w2g12_static_chat_template('tm8.chat.core', 1))
                     order by 1) keys`,
    );
    expect(asset[0]!.keys).toEqual([
      'allowedOperationBindings', 'composerSchemaRef', 'key', 'schemaVersion', 'version',
    ]);

    // And the one registry-facing command refuses the name outright.
    await expect(asApp(
      database, fixture.ownerIdentity, null,
      `select public.w2_create_entity_kind($1, 'ui_template', null, '[]', '{}', null,
         'g12-template-kind')`,
      [fixture.spaceA],
    )).rejects.toMatchObject({ code: '22023' });
  });

  // Dossier §6.4: authorized human spawn override -> Teammate default -> Space
  // default -> built-in core. Only the Teammate step and the override refusal
  // were exercised; the Space and core steps, and the precedence BETWEEN them,
  // were not covered at all.
  it('resolves the whole override/Teammate/Space/core order in that precedence', async () => {
    const startRevision = await database.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`, [fixture.spaceA],
    );
    const startTeammate = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [fixture.agentA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, null, $2, false, 'g12-order-space-clear')`,
      [fixture.spaceA, startRevision[0]!.settings_revision]);
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, null, $2, 'g12-order-tm-clear')`,
      [fixture.agentA, startTeammate[0]!.version]);

    const resolve = async (teamMemberId: string | null, override: string | null) => (
      await asApp<{ value: Record<string, unknown> }>(
        database, fixture.ownerIdentity, null,
        `select internal.w2_resolve_interaction_profile_for_launch($1, $2, $3) value`,
        [fixture.spaceA, teamMemberId, override],
      ))[0]!.value;

    // 4. Nothing configured anywhere resolves to the built-in core registry
    //    definition, with no entity profile behind it.
    const core = await resolve(fixture.agentA, null);
    expect(core).toMatchObject({
      source: 'core_default', profileId: null, profileVersion: null,
      templateKey: 'tm8.chat.core', templateVersion: 1,
    });

    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-order-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Order profile' })],
    );
    const spaceProfile = proposed[0]!.value.profileId as string;
    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-order-validate') value`,
      [spaceProfile],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-order-activate')`,
      [spaceProfile, validated[0]!.value.validatedHash as string]);

    // 3. Space default, once nothing nearer is configured.
    const spaceRevision = await database.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`, [fixture.spaceA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, $2, $3, false, 'g12-order-space-set')`,
      [fixture.spaceA, spaceProfile, spaceRevision[0]!.settings_revision]);
    expect(await resolve(null, null)).toMatchObject({
      source: 'space_default', profileId: spaceProfile,
    });
    expect(await resolve(fixture.agentA, null)).toMatchObject({
      source: 'space_default', profileId: spaceProfile,
    });

    // 2. A Teammate default outranks the Space default.
    const teammateProposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-order-tm-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Teammate order profile' })],
    );
    const teammateProfile = teammateProposed[0]!.value.profileId as string;
    const teammateValidated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-order-tm-validate') value`,
      [teammateProfile],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-order-tm-activate')`,
      [teammateProfile, teammateValidated[0]!.value.validatedHash as string]);
    const teammateVersion = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [fixture.agentA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, $2, $3, 'g12-order-tm-set')`,
      [fixture.agentA, teammateProfile, teammateVersion[0]!.version]);
    expect(await resolve(fixture.agentA, null)).toMatchObject({
      source: 'teammate_default', profileId: teammateProfile,
    });
    expect(await resolve(null, null)).toMatchObject({
      source: 'space_default', profileId: spaceProfile,
    });

    // 1. An authorized human spawn override outranks both.
    expect(await resolve(fixture.agentA, spaceProfile)).toMatchObject({
      source: 'spawn_override', profileId: spaceProfile,
    });

    // Leave the Space as this test found it.
    const endRevision = await database.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`, [fixture.spaceA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, null, $2, false, 'g12-order-space-restore')`,
      [fixture.spaceA, endRevision[0]!.settings_revision]);
    const endTeammate = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [fixture.agentA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_teammate_profile_default($1, null, $2, 'g12-order-tm-restore')`,
      [fixture.agentA, endTeammate[0]!.version]);
  });

  // A replayed clientMutationId is a read of somebody else's stored command
  // result. internal.ledger_replay is keyed on the caller-supplied mutation id
  // alone — not on identity, Space or input — so the replay branch must
  // re-authorize the STORED result before returning it, exactly as the frozen
  // savedViews commands (024) do. Returning it unauthorized hands the full
  // InteractionProfileView, prompt and tool-discovery policy included, to a
  // caller with no membership of the profile's Space.
  it('re-authorizes every replayed command result against its own Space', async () => {
    const kindCreated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.w2_create_entity_kind($1, 'c:replay_probe', null, '[]', '{}', null,
         'g12-replay-kind') value`,
      [fixture.spaceA],
    );
    expect(kindCreated[0]!.value).toMatchObject({ kind: 'c:replay_probe', spaceId: fixture.spaceA });

    const proposed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-replay-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Replay probe profile' })],
    );
    const profileId = proposed[0]!.value.profileId as string;
    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-replay-validate') value`, [profileId],
    );
    const hash = validated[0]!.value.validatedHash as string;
    await asApp(database, fixture.ownerIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-replay-activate')`,
      [profileId, hash]);
    const spaceDefault = await database.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`, [fixture.spaceA],
    );
    await asApp(database, fixture.ownerIdentity, null,
      `select public.set_space_profile_default($1, $2, $3, false, 'g12-replay-space-default')`,
      [fixture.spaceA, profileId, spaceDefault[0]!.settings_revision]);

    // An identity with no membership of Space A replays each stored mutation id
    // while naming its OWN Space on the route. Every one must be refused.
    await expect(asApp(
      database, fixture.outsiderIdentity, null,
      `select public.w2_create_entity_kind($1, 'c:replay_probe', null, '[]', '{}', null,
         'g12-replay-kind')`,
      [fixture.spaceB],
    )).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(
      database, fixture.outsiderIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-replay-propose')`,
      [fixture.spaceB, JSON.stringify({ ...DRAFT, name: 'Outsider draft' })],
    )).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(
      database, fixture.outsiderIdentity, null,
      `select public.validate_interaction_profile($1, 1, 'g12-replay-validate')`,
      [profileId],
    )).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(
      database, fixture.outsiderIdentity, null,
      `select public.set_space_profile_default($1, null, 1, false, 'g12-replay-space-default')`,
      [fixture.spaceB],
    )).rejects.toMatchObject({ code: '42501' });

    // Membership alone is not the bar either: activation and Space defaults
    // require a human owner/admin, so an ordinary Space A member replaying them
    // must be refused with the frozen principal reason.
    await expect(asApp(
      database, fixture.memberIdentity, null,
      `select public.activate_interaction_profile($1, 1, $2, true, 'g12-replay-activate')`,
      [profileId, hash],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    await expect(asApp(
      database, fixture.memberIdentity, null,
      `select public.set_space_profile_default($1, $2, 1, false, 'g12-replay-space-default')`,
      [fixture.spaceA, profileId],
    )).rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });

    // The refusals must not have consumed or rewritten the stored results.
    const ledger = await database.query<{ client_mutation_id: string }>(
      `select client_mutation_id from public.command_ledger
        where client_mutation_id like 'g12-replay-%' order by client_mutation_id`,
    );
    expect(ledger.map((row) => row.client_mutation_id)).toEqual([
      'g12-replay-activate', 'g12-replay-kind', 'g12-replay-propose',
      'g12-replay-space-default', 'g12-replay-validate',
    ]);
    const stillOwned = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.ownerIdentity, null,
      `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-replay-propose') value`,
      [fixture.spaceA, JSON.stringify({ ...DRAFT, name: 'Replay probe profile' })],
    );
    expect(stillOwned[0]!.value).toMatchObject({ profileId, spaceId: fixture.spaceA });
  });

  it('applies after the frozen dependency-safe W2 tranche and before G14 migration 029', async () => {
    const integrated = await createW1ScratchDatabase('w2_profiles_compat');
    try {
      integrated.apply(frozenCompatibilityMigrations());
      const seams = await integrated.query<{ name: string | null }>(
        `select to_regprocedure('public.propose_interaction_profile(uuid,jsonb,uuid,text)')::text name
         union all
         select to_regprocedure('internal.w2_record_interaction_profile_pin(uuid,uuid,integer,text,text)')::text
         union all
         select to_regprocedure('public.set_space_default_channel(uuid,uuid,integer,text)')::text`,
      );
      expect(seams.map((row) => row.name).every(Boolean)).toBe(true);

      // Dossier §8.1 gives the Space ONE `settings_revision`, and A20 here and
      // G14's A03 are both writers of it. That coupling is real and had no test
      // on this side: each must observe the other's increment and refuse a
      // revision the other has already moved past.
      const seeded = await integrated.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        const ids = (await client.query<{
          spaceId: string; ownerEntity: string; channelEntity: string;
        }>(
          `select internal.new_id()::text "spaceId",
                  internal.new_id()::text "ownerEntity",
                  internal.new_id()::text "channelEntity"`,
        )).rows[0]!;
        await client.query(
          `insert into public.user_profiles(identity_id, display_name)
           values ('g12-coupling', 'G12 Coupling')`,
        );
        await client.query(
          `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
           values ('g12-coupling', 'g12-coupling', 'G12 Coupling', true, true)`,
        );
        await client.query(
          `insert into public.spaces(id, name, created_by_identity)
           values ($1, 'G12 Coupling', 'g12-coupling')`,
          [ids.spaceId],
        );
        await client.query(
          `insert into public.entities(id, space_id, kind, position, created_by)
           values ($2, $1, 'member', 0, $2), ($3, $1, 'channel', 1, $2)`,
          [ids.spaceId, ids.ownerEntity, ids.channelEntity],
        );
        await client.query(
          `insert into public.members(entity_id, space_id, identity_id, role, display_name)
           values ($1, $2, 'g12-coupling', 'owner', 'G12 Coupling Owner')`,
          [ids.ownerEntity, ids.spaceId],
        );
        await client.query(
          `insert into public.channels(entity_id, space_id, name)
           values ($1, $2, 'general')`,
          [ids.channelEntity, ids.spaceId],
        );
        return ids;
      });

      const asCoupling = async <R extends QueryResultRow = QueryResultRow>(
        sql: string, params: readonly unknown[] = [],
      ): Promise<R[]> => integrated.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', 'g12-coupling', true)`);
        await client.query(`select set_config('tm8.actor_id', '', true)`);
        return (await client.query<R>(sql, [...params])).rows;
      });

      const revision = async (): Promise<number> => (await integrated.query<{
        settings_revision: number;
      }>(`select settings_revision from public.spaces where id = $1`, [seeded.spaceId]))[0]!
        .settings_revision;

      const r0 = await revision();

      // A03 moves the shared column.
      await asCoupling(
        `select public.set_space_default_channel($1, $2, $3, 'g12-coupling-a03')`,
        [seeded.spaceId, seeded.channelEntity, r0],
      );
      expect(await revision()).toBe(r0 + 1);

      // A20 must now refuse the revision A03 consumed, and say what it is.
      const stale = await asCoupling(
        `select public.set_space_profile_default($1, null, $2, false, 'g12-coupling-stale-a20')`,
        [seeded.spaceId, r0],
      ).then(() => { throw new Error('expected A20 to refuse the consumed revision'); },
        (error: { code?: string; detail?: string }) => error);
      expect(stale.code).toBe('40001');
      expect(JSON.parse(stale.detail ?? '{}')).toEqual({ currentRevision: r0 + 1 });

      // A no-change A20 checks the revision, records its result, and — per
      // §8.2 — performs no row change and no increment.
      const unchanged = await asCoupling<{ value: Record<string, unknown> }>(
        `select public.set_space_profile_default($1, null, $2, false, 'g12-coupling-noop-a20') value`,
        [seeded.spaceId, r0 + 1],
      );
      expect(unchanged[0]!.value).toMatchObject({ settingsRevision: r0 + 1 });
      expect(await revision()).toBe(r0 + 1);

      // A genuine A20 change increments the same column A03 reads.
      const proposed = await asCoupling<{ value: Record<string, unknown> }>(
        `select public.propose_interaction_profile($1, $2::jsonb, null, 'g12-coupling-propose') value`,
        [seeded.spaceId, JSON.stringify({ ...DRAFT, name: 'Coupling profile' })],
      );
      const profileId = proposed[0]!.value.profileId as string;
      const validated = await asCoupling<{ value: Record<string, unknown> }>(
        `select public.validate_interaction_profile($1, 1, 'g12-coupling-validate') value`,
        [profileId],
      );
      await asCoupling(
        `select public.activate_interaction_profile($1, 1, $2, true, 'g12-coupling-activate')`,
        [profileId, validated[0]!.value.validatedHash as string],
      );
      const applied = await asCoupling<{ value: Record<string, unknown> }>(
        `select public.set_space_profile_default($1, $2, $3, false, 'g12-coupling-a20') value`,
        [seeded.spaceId, profileId, r0 + 1],
      );
      expect(applied[0]!.value).toMatchObject({ settingsRevision: r0 + 2 });
      expect(await revision()).toBe(r0 + 2);

      // ...and A03 must in turn refuse the revision A20 consumed.
      await expect(asCoupling(
        `select public.set_space_default_channel($1, null, $2, 'g12-coupling-stale-a03')`,
        [seeded.spaceId, r0 + 1],
      )).rejects.toMatchObject({ code: '40001' });
    } finally {
      await integrated.destroy();
    }
  }, 120_000);
});
