import { getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { W2MessagesHandoffsService } from '../../src/facade/services/w2/messages-handoffs.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * W2 messages.edit — ABSENT MENTIONS MUST BE PRESERVED, EMPTY MUST CLEAR.
 *
 * THE DEFECT, and it is one layer above the one the migration fixed.
 * `w2_edit_message` was changed so that a NULL `p_mention_ids` means "the
 * caller said nothing about mentions, leave them alone", while an EMPTY array
 * means "the caller said: none". Two different inputs, two different outcomes.
 *
 * The service then made the NULL branch UNREACHABLE:
 *
 *     uniqueIds((input.mentions ?? []).map((m) => m.entityId), 'mentions')
 *
 * `?? []` converts ABSENT into EMPTY before the RPC is ever called, so an edit
 * that never mentioned mentions arrives as an explicit clear and the stored
 * mentions are wiped — silently, at 200.
 *
 * WHY THIS FILE ASSERTS BOTH DIRECTIONS AND NOT JUST THE FIX. The whole point
 * of the migration was to make absent and empty DISTINGUISHABLE. A "fix" that
 * preserved unconditionally would satisfy the preserve case and destroy the
 * clear case, and nothing else in the suite would notice. So:
 *
 *   PRESERVE  — mentions absent      -> stored mentions unchanged   (RED before)
 *   CLEAR     — mentions: []         -> stored mentions emptied     (GREEN before)
 *   REPLACE   — mentions: [b]        -> stored mentions become [b]  (GREEN before)
 *
 * Only the first moves. The other two are the controls that stop the fix from
 * being "always preserve", and they must stay green in BOTH states.
 *
 * This is the third instance today of a change that is correct at the layer it
 * touched and inert at the wire: `to_char` in SQL undone by `iso()` downstream,
 * and now NULL-means-absent undone by `?? []` upstream. Both produce a clean,
 * reviewable, correct-looking diff and leave the defect live — which is why the
 * assertions below read the STORED ROW after driving the real handler, rather
 * than inspecting what the service passed.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  otherMemberId: string;
  channelId: string;
  messageId: string;
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'msgedit-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "otherMemberId",
              internal.new_id()::text "channelId", internal.new_id()::text "messageId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Edit owner'),('msgedit-other','Other member')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Edit Space',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$5,'member',null,0,$1),($2,$5,'member',null,1,$2),
       ($3,$5,'channel',null,10,$1),($4,$5,'message',null,20,$1)`,
      [f.memberId, f.otherMemberId, f.channelId, f.messageId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$3,$4,'owner','Edit owner'),($2,$3,'msgedit-other','member','Other member')`,
      [f.memberId, f.otherMemberId, f.spaceId, f.identityId],
    );
    await client.query(`insert into public.channels(entity_id,space_id,name) values($1,$2,'edits')`,
      [f.channelId, f.spaceId]);
    // Stored in the shape internal.w2_resolve_mentions produces, so the
    // preserve assertion compares against a realistic value rather than a
    // placeholder the resolver would never emit.
    await client.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body,mentions)
       values($1,$2,$3,'original body',
              jsonb_build_array(jsonb_build_object(
                'entityId',$4::uuid,'kind','member','display','Other member')))`,
      [f.messageId, f.channelId, f.memberId, f.otherMemberId],
    );
    await client.query(`select internal.record_initial_version($1,$2)`, [f.messageId, f.memberId]);
    return f;
  });
}

function editContext(fixture: Fixture, body: Record<string, unknown>): RequestContext {
  const opName: OperationName = 'messages.edit';
  const op = getOperation(opName);
  return {
    op, opName,
    params: { id: fixture.messageId },
    query: new URLSearchParams(),
    body,
    requestId: 'req-msgedit',
    identity: { kind: 'auto-owner', identityId: fixture.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

describe.sequential('W2 messages.edit absent-vs-empty mentions', () => {
  let database: W1ScratchDatabase;
  let facadeDb: PgDb;
  let fixture: Fixture;
  let service: W2MessagesHandoffsService;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_msgedit');
    database.apply(migrationFiles());
    fixture = await seed(database);
    facadeDb = new PgDb({ databaseUrl: database.url, max: 4 });
    service = new W2MessagesHandoffsService({
      db: facadeDb,
      config: {} as never,
      owner: async () => ({
        identityId: fixture.identityId,
        accountId: '00000000-0000-7000-8000-000000000666',
        username: 'msgedit-owner', isNodeAdmin: false, isOwner: true,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await facadeDb?.end();
    await database?.destroy();
  });

  /** The stored row, which is the only thing that settles this. */
  async function storedMentions(): Promise<Array<{ entityId: string }>> {
    const rows = await database.query<{ mentions: Array<{ entityId: string }> }>(
      `select mentions from public.messages where entity_id=$1`, [fixture.messageId]);
    return rows[0]!.mentions;
  }

  async function version(): Promise<number> {
    const rows = await database.query<{ version: number }>(
      `select version from public.entities where id=$1`, [fixture.messageId]);
    return rows[0]!.version;
  }

  it('GUARD: the fixture stored a non-empty mention', async () => {
    // Without this, "mentions preserved" would pass on an empty-to-empty
    // comparison and prove nothing.
    expect(await storedMentions()).toHaveLength(1);
  });

  it('PRESERVE: an edit that omits mentions leaves the stored mentions alone', async () => {
    const before = await storedMentions();
    await service.edit(editContext(fixture, {
      clientMutationId: 'msgedit-absent',
      expectedVersion: await version(),
      body: 'edited body, mentions untouched',
      // `mentions` DELIBERATELY ABSENT — this is the whole case.
    }));
    expect(await storedMentions(), 'mentions were WIPED by an edit that never mentioned them')
      .toEqual(before);
  });

  it('CLEAR: an edit sending an explicit empty array does clear them', async () => {
    // The control. A fix that preserved unconditionally would break this and
    // nothing else in the suite would notice.
    await service.edit(editContext(fixture, {
      clientMutationId: 'msgedit-clear',
      expectedVersion: await version(),
      body: 'edited body, mentions cleared',
      mentions: [],
    }));
    expect(await storedMentions(), 'an explicit empty array must CLEAR').toEqual([]);
  });

  it('REPLACE: an edit sending mentions replaces them', async () => {
    await service.edit(editContext(fixture, {
      clientMutationId: 'msgedit-replace',
      expectedVersion: await version(),
      body: 'edited body, mentions replaced',
      mentions: [{ kind: 'member', entityId: fixture.otherMemberId, display: 'Other member' }],
    }));
    const after = await storedMentions();
    expect(after).toHaveLength(1);
    expect(after[0]!.entityId).toBe(fixture.otherMemberId);
  });

  it('PRESERVE again, now that a non-empty value was set by the API itself', async () => {
    // The first preserve case ran against a fixture-seeded value. This one runs
    // against a value the API just wrote, so the round trip is closed:
    // replace-then-omit must not undo the replace.
    const before = await storedMentions();
    expect(before, 'REPLACE must have left something to preserve').toHaveLength(1);
    await service.edit(editContext(fixture, {
      clientMutationId: 'msgedit-absent-2',
      expectedVersion: await version(),
      body: 'edited again, mentions still untouched',
    }));
    expect(await storedMentions()).toEqual(before);
  });
});
