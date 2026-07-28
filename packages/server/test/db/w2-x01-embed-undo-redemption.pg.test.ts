import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

// W2.X01 — the embed-placement undo token must be REDEEMABLE.
//
// G03 (018) issues a truthful named `messages.delete` undo token when
// `placements.apply` embeds an entity into a channel. G05 (020) owns the
// registered-inverse allowlist and the redemption RPC — and that allowlist is a
// table CHECK, so it binds at INSERT of the token row, not only at dispatch.
//
// The defect class this suite exists to close is a FIXTURE gap, not a constraint
// bug: no shipped fixture applied 018 and 020 together, so nothing exercised the
// seam between the issuing side and the redeeming side. Applying only the
// migrations under test would reproduce exactly that blind spot, so this suite
// deliberately applies the FULL repository migration chain in official order.
const MIGRATIONS = migrationFiles();

interface Fixture {
  ownerIdentityId: string;
  peerIdentityId: string;
  spaceId: string;
  ownerMemberId: string;
  peerMemberId: string;
  channelId: string;
  taskAId: string;
  taskBId: string;
  taskCId: string;
  taskDId: string;
  taskEId: string;
  taskFId: string;
  taskGId: string;
}

interface PlacementResult {
  entity: { id: string };
  undo: { token: string; label: string; expiresAt: string };
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'x01-owner'::text as "ownerIdentityId",
              'x01-peer'::text as "peerIdentityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "ownerMemberId",
              internal.new_id()::text as "peerMemberId",
              internal.new_id()::text as "channelId",
              internal.new_id()::text as "taskAId",
              internal.new_id()::text as "taskBId",
              internal.new_id()::text as "taskCId",
              internal.new_id()::text as "taskDId",
              internal.new_id()::text as "taskEId",
              internal.new_id()::text as "taskFId",
              internal.new_id()::text as "taskGId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'X01 owner'), ($2, 'X01 peer')`,
      [ids.ownerIdentityId, ids.peerIdentityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'X01 space', $2)`,
      [ids.spaceId, ids.ownerIdentityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
       values ($1, $7, 'member', null, 0, $1),
              ($2, $7, 'member', null, 1, $2),
              ($3, $7, 'channel', null, 0, $1),
              ($4, $7, 'task', null, 0, $1),
              ($5, $7, 'task', null, 1, $1),
              ($6, $7, 'task', null, 2, $1),
              ($8, $7, 'task', null, 3, $1),
              ($9, $7, 'task', null, 4, $1),
              ($10, $7, 'task', null, 5, $1),
              ($11, $7, 'task', null, 6, $1)`,
      [
        ids.ownerMemberId,
        ids.peerMemberId,
        ids.channelId,
        ids.taskAId,
        ids.taskBId,
        ids.taskCId,
        ids.spaceId,
        ids.taskDId,
        ids.taskEId,
        ids.taskFId,
        ids.taskGId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $4, 'owner', 'X01 owner'),
              ($2, $3, $5, 'member', 'X01 peer')`,
      [ids.ownerMemberId, ids.peerMemberId, ids.spaceId, ids.ownerIdentityId, ids.peerIdentityId],
    );
    await client.query(
      `insert into public.tasks(entity_id, title, work_status, priority)
       values ($1, 'Task A', 'open', 'medium'),
              ($2, 'Task B', 'open', 'medium'),
              ($3, 'Task C', 'open', 'medium'),
              ($4, 'Task D', 'open', 'medium'),
              ($5, 'Task E', 'open', 'medium'),
              ($6, 'Task F', 'open', 'medium'),
              ($7, 'Task G', 'open', 'medium')`,
      [
        ids.taskAId,
        ids.taskBId,
        ids.taskCId,
        ids.taskDId,
        ids.taskEId,
        ids.taskFId,
        ids.taskGId,
      ],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name) values ($1, $2, 'x01')`,
      [ids.channelId, ids.spaceId],
    );
    return ids;
  });
}

async function asApp<T>(
  identityId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'req-x01-pg', true)`,
      [identityId],
    );
    return fn(client);
  });
}

/** Apply an `embed` placement exactly as G03 ships it. */
async function embed(sourceId: string, mutationId: string): Promise<PlacementResult> {
  return asApp(fixture.ownerIdentityId, async (client) => (
    await client.query<{ result: PlacementResult }>(
      `select public.place_entity($1, $2, 'embed', 'Look', null, $3, $4) result`,
      [sourceId, fixture.channelId, fixture.ownerMemberId, mutationId],
    )
  ).rows[0]!.result);
}

type EmbedOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: unknown; readonly messagesAfter: number };

/** Count every message anchored to the fixture channel, tombstoned or not. */
async function channelMessageCount(): Promise<number> {
  return (await database.query<{ count: number }>(
    `select count(*)::integer count from public.messages where anchor_id = $1`,
    [fixture.channelId],
  ))[0]!.count;
}

async function redeem(
  identityId: string,
  token: string,
  actorId: string,
  mutationId: string,
): Promise<Record<string, unknown>> {
  return asApp(identityId, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.undo_command($1, $2, $3) result`,
      [token, actorId, mutationId],
    )
  ).rows[0]!.result);
}

interface MessageState {
  body: string;
  redacted: boolean;
  envelopes: number;
  messages: number;
  deleted_events: number;
}

async function messageState(messageId: string): Promise<MessageState> {
  return (await database.query<MessageState>(
    `select m.body,
            m.redacted_at is not null redacted,
            (select count(*)::integer from public.entities e
              where e.id = $1 and e.kind = 'message') envelopes,
            (select count(*)::integer from public.messages mm where mm.entity_id = $1) messages,
            (select count(*)::integer from public.workspace_events w
              where w.event_type = 'message.deleted'
                and w.payload ->> 'messageId' = $1::text) deleted_events
       from public.messages m where m.entity_id = $1`,
    [messageId],
  ))[0]!;
}

interface TokenState {
  redeemed: boolean;
  redemption_client_mutation_id: string | null;
  ledgers: number;
}

async function tokenState(token: string, mutationId: string): Promise<TokenState> {
  return (await database.query<TokenState>(
    `select t.redeemed_at is not null redeemed,
            t.redemption_client_mutation_id,
            (select count(*)::integer from public.command_ledger l
              where l.operation = 'commands.undo' and l.client_mutation_id = $2) ledgers
       from public.undo_tokens t where t.token = $1`,
    [token, mutationId],
  ))[0]!;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w2_x01');
  database.apply(MIGRATIONS);
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe.sequential('W2.X01 embed-placement undo token redeems through the registered message inverse', () => {
  it('applies the full repository migration chain, so 018 and 020 are exercised together', () => {
    // The gap that hid this defect was a fixture that omitted one side of the
    // seam. Guard the breadth structurally rather than by a magic count: this
    // suite must apply whatever the repository currently ships, in official
    // order, so a sibling adding a migration never has to touch this test and
    // nobody can quietly swap in a hand-listed slice.
    expect(MIGRATIONS).toEqual(migrationFiles());
    expect(MIGRATIONS).toEqual([...MIGRATIONS].sort());
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(26);
    for (const required of [
      '018_w2_edges_placements.sql',
      '019_w2_messages_handoffs.sql',
      '020_w2_collections_graph_undo.sql',
    ]) {
      expect(MIGRATIONS).toContain(required);
    }
  });

  it('commits the embedded message and its undo token in one transaction', async () => {
    // The discriminator. The allowlist is a table CHECK on undo_tokens, and
    // issue_undo_token INSERTs inside place_entity's transaction alongside
    // post_message. If `messages.delete` is not a registered inverse, the
    // placement does not merely yield an unredeemable token — the INSERT raises
    // 23514 and takes the posted message down with it. Asserting on the message
    // row, not just on the error code, is what makes the blast radius explicit:
    // a lost message, not only a lost undo affordance.
    const before = await channelMessageCount();
    let outcome: EmbedOutcome;
    try {
      await embed(fixture.taskDId, 'x01-embed-atomicity');
      outcome = { ok: true };
    } catch (error) {
      outcome = {
        ok: false,
        code: (error as { code?: unknown }).code,
        messagesAfter: await channelMessageCount(),
      };
    }
    expect(outcome).toEqual({ ok: true });
    expect(await channelMessageCount()).toBe(before + 1);
  });

  it('issues and then redeems the embed token, tombstoning the message while preserving thread history', async () => {
    const placed = await embed(fixture.taskAId, 'x01-embed-create');
    const messageId = placed.entity.id;
    expect(placed.undo.token).toMatch(/^undo_/);

    const registered = (await database.query<{ operation: string; arguments: { messageId: string } }>(
      `select operation, arguments from public.undo_tokens where token = $1`,
      [placed.undo.token],
    ))[0]!;
    expect(registered.operation).toBe('messages.delete');
    expect(registered.arguments.messageId).toBe(messageId);

    const before = await messageState(messageId);
    expect(before).toMatchObject({ redacted: false, envelopes: 1, messages: 1, deleted_events: 0 });
    expect(before.body).toBe(`Look {{embed:${fixture.taskAId}}}`);

    const result = await redeem(
      fixture.ownerIdentityId,
      placed.undo.token,
      fixture.ownerMemberId,
      'x01-embed-undo',
    );
    expect(result).toMatchObject({ messageId });

    // A tombstone is a state transition, not a destructive delete: the envelope
    // and the message row both survive so thread history stays intact.
    const after = await messageState(messageId);
    expect(after).toEqual({
      body: '[redacted]',
      redacted: true,
      envelopes: 1,
      messages: 1,
      deleted_events: 1,
    });
    expect(await tokenState(placed.undo.token, 'x01-embed-undo')).toEqual({
      redeemed: true,
      redemption_client_mutation_id: 'x01-embed-undo',
      ledgers: 1,
    });
  });

  it('refuses redemption by an actor other than the original one and leaves the token live', async () => {
    const placed = await embed(fixture.taskBId, 'x01-embed-actor');
    await expect(redeem(
      fixture.peerIdentityId,
      placed.undo.token,
      fixture.peerMemberId,
      'x01-embed-stolen',
    )).rejects.toMatchObject({ code: '42501' });

    expect(await tokenState(placed.undo.token, 'x01-embed-stolen')).toEqual({
      redeemed: false,
      redemption_client_mutation_id: null,
      ledgers: 0,
    });
    const untouched = await messageState(placed.entity.id);
    expect(untouched).toMatchObject({ redacted: false, deleted_events: 0 });
  });

  it('gives one token exactly one effect: same mutation id replays, a different one is refused', async () => {
    const placed = await embed(fixture.taskCId, 'x01-embed-replay');
    const first = await redeem(
      fixture.ownerIdentityId,
      placed.undo.token,
      fixture.ownerMemberId,
      'x01-embed-replay-undo',
    );
    const replay = await redeem(
      fixture.ownerIdentityId,
      placed.undo.token,
      fixture.ownerMemberId,
      'x01-embed-replay-undo',
    );
    expect(replay).toEqual(first);

    // The replay is the stored ledger result, not a second tombstone.
    expect(await tokenState(placed.undo.token, 'x01-embed-replay-undo')).toEqual({
      redeemed: true,
      redemption_client_mutation_id: 'x01-embed-replay-undo',
      ledgers: 1,
    });
    expect(await messageState(placed.entity.id)).toMatchObject({
      redacted: true,
      deleted_events: 1,
    });

    await expect(redeem(
      fixture.ownerIdentityId,
      placed.undo.token,
      fixture.ownerMemberId,
      'x01-embed-second-mutation',
    )).rejects.toMatchObject({ code: '23514' });
    expect(await tokenState(placed.undo.token, 'x01-embed-second-mutation')).toEqual({
      redeemed: true,
      redemption_client_mutation_id: 'x01-embed-replay-undo',
      ledgers: 0,
    });
  });

  it('redeems as a no-op when the embedded message was already tombstoned by its author', async () => {
    // Branch: `w2_tombstone_message` skips its whole mutation when redacted_at
    // is already set. Reachable in the real world — the author deletes the
    // embedded message, then hits undo on the placement. The inverse must stay
    // idempotent: still redeem, still ledger, but emit no SECOND deletion.
    const placed = await embed(fixture.taskEId, 'x01-embed-pre-tombstoned');
    const messageId = placed.entity.id;
    await asApp(fixture.ownerIdentityId, async (client) => client.query(
      `select public.w2_tombstone_message($1, null, $2, $3)`,
      [messageId, fixture.ownerMemberId, 'x01-author-delete'],
    ));
    const afterAuthorDelete = await messageState(messageId);
    expect(afterAuthorDelete).toMatchObject({ redacted: true, deleted_events: 1 });

    const result = await redeem(
      fixture.ownerIdentityId,
      placed.undo.token,
      fixture.ownerMemberId,
      'x01-pre-tombstoned-undo',
    );
    expect(result).toMatchObject({ messageId });
    expect(await messageState(messageId)).toEqual({
      body: '[redacted]',
      redacted: true,
      envelopes: 1,
      messages: 1,
      deleted_events: 1,
    });
    expect(await tokenState(placed.undo.token, 'x01-pre-tombstoned-undo')).toEqual({
      redeemed: true,
      redemption_client_mutation_id: 'x01-pre-tombstoned-undo',
      ledgers: 1,
    });
  });

  it('refuses a mutation id already bound to a different token, leaving the second token live', async () => {
    // Branch: undo_command's `replay is not null` arm with a redemption-cmid
    // mismatch (020:79-84). Distinct from the already-redeemed arm — this one
    // is the guard that stops one recorded commands.undo mutation id from being
    // replayed to spoof redemption of a DIFFERENT token.
    const first = await embed(fixture.taskFId, 'x01-embed-cmid-a');
    const second = await embed(fixture.taskGId, 'x01-embed-cmid-b');
    await redeem(fixture.ownerIdentityId, first.undo.token, fixture.ownerMemberId, 'x01-shared-cmid');

    await expect(redeem(
      fixture.ownerIdentityId,
      second.undo.token,
      fixture.ownerMemberId,
      'x01-shared-cmid',
    )).rejects.toMatchObject({ code: '23514' });

    // The second token is untouched: not redeemed, and its message intact.
    expect(await tokenState(second.undo.token, 'x01-shared-cmid')).toEqual({
      redeemed: false,
      redemption_client_mutation_id: null,
      ledgers: 1,
    });
    expect(await messageState(second.entity.id)).toMatchObject({
      redacted: false,
      deleted_events: 0,
    });
  });

  it('rolls the redemption mark and the ledger back atomically when the message inverse itself fails', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.undo_tokens(
           token, space_id, actor_id, label, operation, arguments, expires_at)
         values (
           'x01-missing-message', $1, $2, 'Undo embed', 'messages.delete',
           jsonb_build_object('messageId', internal.new_id()), now() + interval '5 minutes')`,
        [fixture.spaceId, fixture.ownerMemberId],
      );
    });

    await expect(redeem(
      fixture.ownerIdentityId,
      'x01-missing-message',
      fixture.ownerMemberId,
      'x01-broken-inverse',
    )).rejects.toMatchObject({ code: 'P0002' });

    expect(await tokenState('x01-missing-message', 'x01-broken-inverse')).toEqual({
      redeemed: false,
      redemption_client_mutation_id: null,
      ledgers: 0,
    });
  });

  it('keeps the registered-inverse allowlist an explicit enumeration that excludes irreversible facts', async () => {
    const registered = (await database.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) definition
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'undo_tokens'
          and c.conname = 'undo_tokens_registered_inverse_check'`,
    ))[0]!.definition;
    // An explicit IN-list, not an open-ended or data-driven membership test.
    expect(registered).toContain('operation = ANY');
    expect(registered).not.toMatch(/select|exists|::regproc/i);
    for (const allowed of ['edges.delete', 'entities.move', 'entities.restore', 'messages.delete']) {
      expect(registered).toContain(`'${allowed}'`);
    }

    // Row-8 delivery and handoff facts are irreversible history, never inverses.
    for (const forbidden of [
      'handoffs.withdraw',
      'handoffs.accept',
      'handoffs.record',
      'messages.deliver',
      'deliveries.settle',
    ]) {
      await expect(database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `insert into public.undo_tokens(
             token, space_id, actor_id, label, operation, arguments, expires_at)
           values ($3, $1, $2, 'Forbidden undo', $4, '{}', now() + interval '5 minutes')`,
          [fixture.spaceId, fixture.ownerMemberId, `x01-forbidden-${forbidden}`, forbidden],
        );
      })).rejects.toMatchObject({ code: '23514' });
    }
  });
});
