// 224 — an Interaction Profile draft can carry the four OPTIONAL keys the
// contract declares (initialContentSurface, contextIndex, contextBudgets,
// contextFloors). 027's SQL validator admitted exactly 8 keys, so every one of
// these was refused at propose / updateDraft even though the zod schema took
// it: the handler tests never reach the SQL door. These go THROUGH the real
// RPCs, on the full official chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const DRAFT = {
  name: 'Context keys profile',
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

const KEYS = {
  initialContentSurface: 'terminal',
  contextIndex: true,
  contextBudgets: { memories: 8192, skills: 4096, references: 12_288, teammates: 0 },
  contextFloors: { memories: 1.5, skills: 0, references: 3, teammates: 2 },
} as const;

interface Fixture {
  identity: string;
  spaceId: string;
  ownerId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'ctxkeys-owner'::text "identity", internal.new_id()::text "spaceId", internal.new_id()::text "ownerId"`,
    )).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Ctx Owner')`, [ids.identity]);
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'ctxkeys-owner', 'Ctx Owner', true, true)`,
      [ids.identity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Ctx keys', $2)`,
      [ids.spaceId, ids.identity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`,
      [ids.ownerId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Ctx Owner')`,
      [ids.ownerId, ids.spaceId, ids.identity],
    );
    return ids;
  });
}

async function asApp<R extends QueryResultRow = QueryResultRow>(
  database: W1ScratchDatabase,
  identityId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    await client.query(`select set_config('tm8.actor_id', '', true)`);
    return (await client.query<R>(sql, [...params])).rows;
  });
}

describe('224 — profile drafts carry the contract\'s optional keys through the real RPCs', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;
  let mutation = 0;

  const propose = (draft: unknown) => asApp<{ value: Record<string, unknown> }>(
    database, fixture.identity,
    `select public.propose_interaction_profile($1, $2::jsonb, null, $3) value`,
    [fixture.spaceId, JSON.stringify(draft), `ctxkeys-propose-${++mutation}`],
  ).then((rows) => rows[0]!.value);

  beforeAll(async () => {
    database = await createW1ScratchDatabase('profile_draft_context_keys');
    database.apply(migrationFiles());
    fixture = await seed(database);
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('runs on a chain that includes 224', () => {
    const files = migrationFiles();
    expect(files).toContain('224_profile_draft_context_keys.sql');
  });

  it('proposes a draft carrying each key alone, and all four together; the view and the pinned snapshot keep them', async () => {
    for (const [key, value] of Object.entries(KEYS)) {
      const view = await propose({ ...DRAFT, name: `Ctx ${key}`, [key]: value });
      expect((view.draft as Record<string, unknown>)[key]).toEqual(value);
    }
    const all = await propose({ ...DRAFT, name: 'Ctx all four', ...KEYS });
    expect(all.draft).toMatchObject(KEYS);
    // Validation accepts them, and what spawn reads — the pinned snapshot of
    // a validated version — carries `draft` whole.
    const validated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.identity,
      `select public.validate_interaction_profile($1, 1, 'ctxkeys-validate') value`,
      [all.profileId],
    );
    expect(validated[0]!.value).toMatchObject({ status: 'valid', issues: [] });
    const snapshot = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ draft: Record<string, unknown> }>(
        `select internal.w2g12_profile_snapshot($1, 1, 'test') -> 'draft' draft`,
        [all.profileId],
      )).rows[0]!.draft;
    });
    expect(snapshot).toMatchObject(KEYS);
  });

  it('updates a draft to carry the keys, and to change them', async () => {
    const created = await propose({ ...DRAFT, name: 'Ctx update' });
    const updated = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.identity,
      `select public.update_interaction_profile_draft($1, 1, $2::jsonb, null, 'ctxkeys-update-1') value`,
      [created.profileId, JSON.stringify({ ...DRAFT, name: 'Ctx update', ...KEYS })],
    );
    expect(updated[0]!.value).toMatchObject({ currentDraftVersion: 2, draft: KEYS });
    const changed = await asApp<{ value: Record<string, unknown> }>(
      database, fixture.identity,
      `select public.update_interaction_profile_draft($1, 2, $2::jsonb, null, 'ctxkeys-update-2') value`,
      [created.profileId, JSON.stringify({ ...DRAFT, name: 'Ctx update', contextIndex: false, contextBudgets: { memories: 0 } })],
    );
    expect(changed[0]!.value).toMatchObject({ currentDraftVersion: 3, draft: { contextIndex: false, contextBudgets: { memories: 0 } } });
  });

  it('still refuses a malformed value for each key, and an unknown top-level key (224 widens nothing else)', async () => {
    const bad: Array<[string, Record<string, unknown>, string]> = [
      ['surface', { initialContentSurface: 'web' }, 'invalid Interaction Profile draft shape'],
      ['index', { contextIndex: 'yes' }, 'invalid Interaction Profile draft shape'],
      ['budget range', { contextBudgets: { memories: 40_000 } }, 'invalid Interaction Profile context budgets'],
      ['budget fraction', { contextBudgets: { skills: 1.5 } }, 'invalid Interaction Profile context budgets'],
      ['budget key', { contextBudgets: { bogus: 1 } }, 'invalid Interaction Profile context budgets'],
      ['budget shape', { contextBudgets: [1] }, 'invalid Interaction Profile context budgets'],
      ['floor range', { contextFloors: { skills: 4 } }, 'invalid Interaction Profile context floors'],
      ['floor type', { contextFloors: { memories: '1' } }, 'invalid Interaction Profile context floors'],
      ['unknown key', { somethingElse: true }, 'invalid Interaction Profile draft shape'],
    ];
    for (const [label, extra, message] of bad) {
      await expect(propose({ ...DRAFT, name: `Ctx bad ${label}`, ...extra }), label)
        .rejects.toMatchObject({ code: '22023', message });
    }
  });
});
