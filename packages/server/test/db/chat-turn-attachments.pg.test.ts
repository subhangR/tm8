/**
 * 133 — `claim_next_chat_turn` carries the message's attachments.
 *
 * The defect this pins was invisible at every layer above SQL: the file was
 * validated, stored on `public.messages.attachments`, returned by the API and
 * drawn as a chip in Chat — and the one read that turns that message into a
 * prompt for the teammate selected the row into a local and then built its
 * result from `body` alone. A unit test cannot catch that; the drop is in the
 * projection, so the test has to be against a real database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityA: string;
  spaceId: string;
  memberA: string;
  teammateId: string;
  anchorId: string;
  fileA: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;
let chatId: string;
let openingMessageId: string;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identityA: 'chat-attach-a',
    spaceId: randomUUID(),
    memberA: randomUUID(),
    teammateId: randomUUID(),
    anchorId: randomUUID(),
    fileA: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Chat A')`,
      [values.identityA],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Chat Attach', $2)`,
      [values.spaceId, values.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by, visibility)
       values ($1,$5,'member',0,$1,'space'), ($2,$5,'team_member',1,$1,'space'),
              ($3,$5,'channel',2,$1,'space'), ($4,$5,'file',3,$1,'space')`,
      [values.memberA, values.teammateId, values.anchorId, values.fileA, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Chat A')`,
      [values.memberA, values.spaceId, values.identityA],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','gpt-5.6-sol','codex')`,
      [values.teammateId, values.memberA],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1,$2,'chat-attach','')`,
      [values.anchorId, values.spaceId],
    );
    // Finalized (checksum present) and space-visible, or
    // `w2_validate_attachment_files` refuses the post outright.
    await client.query(
      `insert into public.files(entity_id,name,mime_type,size_bytes,storage_path,checksum_sha256)
       values ($1,'spec.pdf','application/pdf',11,$2,$3)`,
      [values.fileA, `spaces/${values.spaceId}/spec`, 'a'.repeat(64)],
    );
  });
  return values;
}

async function asIdentity<T extends QueryResultRow>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

/** A turn: anchored ON THE CHAT, flat, carrying whatever files were staged. */
async function post(body: string, fileIds: string[]): Promise<string> {
  return asIdentity(fixture.identityA, async (client) => {
    const row = (await client.query<{ result: { messageIds: string[] } }>(
      `select public.w2_post_message_batch(
         $1::uuid[], $2, null, '{}'::uuid[], $3::uuid[], null, null, $4, null, null
       ) result`,
      [[chatId], body, fileIds, `chat-attach-${randomUUID()}`],
    )).rows[0]!;
    return row.result.messageIds[0]!;
  });
}

async function claim(): Promise<Record<string, unknown> | null> {
  const row = await asIdentity(fixture.identityA, async (client) => (
    await client.query<{ result: Record<string, unknown> | null }>(
      `select public.claim_next_chat_turn($1) result`,
      [chatId],
    )
  ).rows[0]!);
  return row.result;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_attach');
  database.apply(migrationFiles());
  fixture = await seed(database);
  chatId = randomUUID();
  const started = await asIdentity(fixture.identityA, async (client) => (
    await client.query<{ result: { messageId: string } }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        chatId, fixture.spaceId, fixture.teammateId, 'gpt-5.6-sol', 'openai', 'codex',
        'ask', 'scratch', null, randomUUID(), `/tmp/tm8-chat-${chatId}`, null,
        'root prompt, no files', [], null, `chat-attach-config-${randomUUID()}`,
      ],
    )
  ).rows[0]!);
  openingMessageId = started.result.messageId;
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('claim_next_chat_turn and message attachments', () => {
  it('answers an empty list for a turn whose message has no files', async () => {
    const claimed = await claim();
    expect(claimed).toMatchObject({ userMessageId: openingMessageId, attachments: [] });
  });

  it('carries the file the human attached, with the id the teammate can fetch', async () => {
    await post('here is the spec', [fixture.fileA]);
    const claimed = await claim();
    expect(claimed).toMatchObject({
      attachments: [
        { fileEntityId: fixture.fileA, name: 'spec.pdf', mime: 'application/pdf' },
      ],
    });
  });
});
