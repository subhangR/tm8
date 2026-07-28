// =============================================================================
// W2.SEC-1 STAGE 1b (migration 032) — the replay RESOURCE binding, plus
//                                     strip-at-rest and rehydrate-after-binding
//                                     at the three invite sites.
//
// WHAT THIS FILE PROVES.
//
//   1. THE BINDING FIRES. A replay is refused when it addresses a different
//      resource than the one it was recorded against, and when it comes from a
//      different principal.
//   2. IT DOES NOT PASS BY REFUSING EVERYONE. Every negative is paired with the
//      POSITIVE it must be able to distinguish: a legitimate same-principal,
//      same-resource replay still returns its stored result.
//   3. THE CREDENTIAL IS NOT AT REST. public.command_ledger no longer stores the
//      live invite code, and the replay path returns a FRESH row rather than the
//      stripped blob.
//
// SAME-PRINCIPAL IS THE POINT, NOT AN AFTERTHOUGHT. The measured W3 invite leak
// is SAME-principal — Phase 1 runs a single loopback auto-owner — so 033's
// principal pin matches, passes, and lets it through. The subject negatives below
// therefore run as the SAME identity that recorded the cmid. A suite that only
// exercised cross-principal replay would go green against a build that fixes
// nothing.
//
// POSITIVE CONTROLS ARE LOAD-BEARING. A guard that compares against a NULL
// operand is silently inert, so before any refusal is believed this file reads
// internal.identity_id() back inside the transaction and asserts it is non-null
// and distinct per identity, and reads the recorded principal back OUT OF
// STORAGE.
//
// FIXTURE: the full official chain from migrationFiles(), plus the 032 candidate
// applied on top from an absolute path outside the repository (the coordinator is
// the sole migration landing point, so 032 is not in db/migrations yet). Set
// SEC1_032_CANDIDATE=none to run against the LANDED chain and capture the red.
// Once 032 lands, migrationFiles() carries it and the candidate application is
// skipped automatically.
// =============================================================================

import { readFileSync } from 'node:fs';

import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const CANDIDATE_ENV = process.env['SEC1_032_CANDIDATE'];
const CANDIDATE_PATH =
  CANDIDATE_ENV ??
  '/private/tmp/claude-503/-Users-subhang-Desktop-Projects-tm8/16c40cc0-0cae-4681-8ecc-1b4425f7c889/scratchpad/sec1-032/032_w2_sec1_stage1b_replay_resource_binding.sql';

const CANDIDATE_IS_LANDED = migrationFiles().some((file) => file.startsWith('032_'));

const OWNER_IDENTITY = 'w2-sec1-032-owner';
const RIVAL_IDENTITY = 'w2-sec1-032-rival';

const PRINCIPAL_MESSAGE = 'clientMutationId belongs to another principal';

interface SpaceFixture {
  readonly spaceId: string;
  readonly channelId: string;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    return { ok: false, code: pgError.code ?? '', message: pgError.message ?? String(error) };
  }
}

/** Renders an outcome so a red run SHOWS the leak rather than just failing. */
function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `RETURNED a value (no error raised): ${JSON.stringify(outcome.value)}`
    : `raised ${outcome.code}: ${outcome.message}`;
}

interface InviteResult {
  readonly invite: { readonly id: string; readonly code?: string; readonly space_id: string };
}

describe.sequential('W2.SEC-1 032 replay resource binding', () => {
  let database: W1ScratchDatabase;
  let spaceOwner: SpaceFixture;
  let spaceOwnerSecond: SpaceFixture;
  let spaceRival: SpaceFixture;

  async function asApplication<T>(
    identityId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'w2-sec1-032-pg', true)`,
        [identityId],
      );
      return fn(client);
    });
  }

  async function appValue<T>(
    identityId: string,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T> {
    return asApplication(identityId, async (client) => {
      const result = await client.query<{ value: T }>(sql, [...params]);
      return result.rows[0]!.value;
    });
  }

  async function ownerRows<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const result = await client.query<R>(sql, [...params]);
      return result.rows;
    });
  }

  async function recordedIdentity(cmid: string): Promise<string | null | undefined> {
    const rows = await ownerRows<{ identity_id: string | null }>(
      `select identity_id from public.command_ledger where client_mutation_id = $1`,
      [cmid],
    );
    return rows[0]?.identity_id;
  }

  /** The stored projection for a cmid, straight out of the ledger. */
  async function storedResult(cmid: string): Promise<Record<string, unknown> | undefined> {
    const rows = await ownerRows<{ result: Record<string, unknown> | null }>(
      `select result from public.command_ledger where client_mutation_id = $1`,
      [cmid],
    );
    return rows[0]?.result ?? undefined;
  }

  function createInviteSql(): string {
    return `select public.create_invite($1, 1, null, null, $2) value`;
  }

  async function makeSpace(identityId: string, name: string, cmid: string): Promise<SpaceFixture> {
    const created = await appValue<{ space: { id: string }; defaultChannelId: string }>(
      identityId,
      `select public.create_space($1, '', 'private', null, $2) value`,
      [name, cmid],
    );
    return { spaceId: created.space.id, channelId: created.defaultChannelId };
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_sec1_032');
    database.apply(migrationFiles());

    if (!CANDIDATE_IS_LANDED && CANDIDATE_ENV !== 'none') {
      await database.query(readFileSync(CANDIDATE_PATH, 'utf8'));
    }

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      for (const identityId of [OWNER_IDENTITY, RIVAL_IDENTITY]) {
        await client.query(
          `insert into public.user_profiles(identity_id, display_name) values ($1, $2)`,
          [identityId, identityId],
        );
        await client.query(
          `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
           values ($1, $2, $3, false, false)`,
          [identityId, identityId, identityId],
        );
      }
    });

    spaceOwner = await makeSpace(OWNER_IDENTITY, '032 owner space A', 'sec1-032-space-a');
    spaceOwnerSecond = await makeSpace(OWNER_IDENTITY, '032 owner space B', 'sec1-032-space-b');
    spaceRival = await makeSpace(RIVAL_IDENTITY, '032 rival space', 'sec1-032-space-r');
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 0. CONTROLS. Nothing below is believable until these pass.
  // ---------------------------------------------------------------------------
  describe('controls', () => {
    it('binds a genuinely non-null, genuinely distinct identity per transaction', async () => {
      const bound = async (identityId: string): Promise<string | null> =>
        asApplication(identityId, async (client) => {
          const result = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          return result.rows[0]!.bound;
        });
      const owner = await bound(OWNER_IDENTITY);
      const rival = await bound(RIVAL_IDENTITY);
      expect(owner, 'harness bound no identity — every negative here would be vacuous').toBe(
        OWNER_IDENTITY,
      );
      expect(rival).toBe(RIVAL_IDENTITY);
      expect(owner).not.toBe(rival);
    });

    it('the owner really holds two DISTINCT spaces, so the subject negative is real', () => {
      expect(spaceOwner.spaceId).toBeTruthy();
      expect(spaceOwnerSecond.spaceId).toBeTruthy();
      expect(spaceOwner.spaceId).not.toBe(spaceOwnerSecond.spaceId);
    });
  });

  // ---------------------------------------------------------------------------
  // 1. create_invite — THE INVITE-CODE LEAK.
  // ---------------------------------------------------------------------------
  describe('create_invite', () => {
    const cmid = 'sec1-032-invite-create';
    let firstCode: string;
    let inviteId: string;

    it('POSITIVE: records under a non-null principal and returns a usable code', async () => {
      const first = await appValue<InviteResult>(OWNER_IDENTITY, createInviteSql(), [
        spaceOwner.spaceId,
        cmid,
      ]);
      expect(first.invite.id).toBeTruthy();
      expect(first.invite.code, 'the creator did not receive a code — endpoint is broken').toBeTruthy();
      firstCode = first.invite.code!;
      inviteId = first.invite.id;

      // Control: the comparison below has a real operand on the stored side.
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);
    });

    it('STRIP AT REST: the ledger stores the projection WITHOUT the live code', async () => {
      const stored = (await storedResult(cmid)) as { invite?: Record<string, unknown> } | undefined;
      expect(stored, 'nothing was recorded — this assertion would be vacuous').toBeDefined();
      expect(stored!.invite, 'the stored projection has no invite object at all').toBeDefined();
      expect(
        Object.keys(stored!.invite!),
        'the LIVE INVITE CODE is still at rest in public.command_ledger',
      ).not.toContain('code');
      // ...and the identifying fields the replay branch needs ARE still there.
      expect(stored!.invite!['id']).toBe(inviteId);
      expect(stored!.invite!['space_id']).toBe(spaceOwner.spaceId);
    });

    it('POSITIVE: a same-principal same-resource replay still returns the code', async () => {
      const replay = await appValue<InviteResult>(OWNER_IDENTITY, createInviteSql(), [
        spaceOwner.spaceId,
        cmid,
      ]);
      expect(replay.invite.id, 'idempotency was traded away, not preserved').toBe(inviteId);
      expect(
        replay.invite.code,
        'the replay returned no code — the stripped blob was served instead of a fresh row',
      ).toBe(firstCode);
    });

    it('REHYDRATION IS FRESH, not the frozen blob: a revoke is visible on replay', async () => {
      await appValue(RIVAL_IDENTITY, `select 1 value`); // no-op, keeps the helper honest
      await ownerRows(`update public.space_invites set revoked_at = now() where id = $1`, [
        inviteId,
      ]);
      const replay = await appValue<{ invite: { revoked_at: string | null } }>(
        OWNER_IDENTITY,
        createInviteSql(),
        [spaceOwner.spaceId, cmid],
      );
      expect(
        replay.invite.revoked_at,
        'the replay served a STALE snapshot — rehydration is not happening',
      ).not.toBeNull();
      await ownerRows(`update public.space_invites set revoked_at = null where id = $1`, [inviteId]);
    });

    // THE ONE THAT MATTERS. Same principal, different Space — which is the shape
    // of the measured W3 leak and the shape 033's principal pin cannot see.
    it('NEGATIVE (subject): the SAME principal addressing a DIFFERENT Space is refused', async () => {
      const outcome = await attempt(() =>
        appValue<InviteResult>(OWNER_IDENTITY, createInviteSql(), [
          spaceOwnerSecond.spaceId,
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `SEC-1: a same-principal cross-RESOURCE replay of create_invite ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another space');
    });

    it('NEGATIVE (principal): a different principal is refused', async () => {
      const outcome = await attempt(() =>
        appValue<InviteResult>(RIVAL_IDENTITY, createInviteSql(), [spaceRival.spaceId, cmid]),
      );
      expect(
        outcome.ok,
        `SEC-1: a cross-PRINCIPAL replay of create_invite ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. w2_revoke_invite — the ROUTED revoke RPC, two subject axes.
  // ---------------------------------------------------------------------------
  describe('w2_revoke_invite', () => {
    const cmid = 'sec1-032-invite-revoke';
    let inviteA: string;
    let inviteB: string;

    beforeAll(async () => {
      const a = await appValue<InviteResult>(OWNER_IDENTITY, createInviteSql(), [
        spaceOwner.spaceId,
        'sec1-032-revoke-seed-a',
      ]);
      const b = await appValue<InviteResult>(OWNER_IDENTITY, createInviteSql(), [
        spaceOwner.spaceId,
        'sec1-032-revoke-seed-b',
      ]);
      inviteA = a.invite.id;
      inviteB = b.invite.id;
      expect(inviteA).not.toBe(inviteB);
    });

    it('POSITIVE: revokes, and a same-principal same-invite replay returns the result', async () => {
      const first = await appValue<InviteResult>(
        OWNER_IDENTITY,
        `select public.w2_revoke_invite($1, $2, $3) value`,
        [spaceOwner.spaceId, inviteA, cmid],
      );
      expect(first.invite.id).toBe(inviteA);
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const replay = await appValue<InviteResult>(
        OWNER_IDENTITY,
        `select public.w2_revoke_invite($1, $2, $3) value`,
        [spaceOwner.spaceId, inviteA, cmid],
      );
      expect(replay.invite.id, 'idempotency was traded away').toBe(inviteA);
    });

    it('STRIP AT REST: the revoke projection carries no code either', async () => {
      const stored = (await storedResult(cmid)) as { invite?: Record<string, unknown> } | undefined;
      expect(stored!.invite).toBeDefined();
      expect(Object.keys(stored!.invite!)).not.toContain('code');
    });

    it('NEGATIVE (subject): the SAME principal addressing a DIFFERENT invite is refused', async () => {
      const outcome = await attempt(() =>
        appValue(OWNER_IDENTITY, `select public.w2_revoke_invite($1, $2, $3) value`, [
          spaceOwner.spaceId,
          inviteB,
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `SEC-1: a same-principal cross-INVITE replay ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another invite');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. w2_edit_message — a binding-only site, to show the pattern is not
  //    invite-specific.
  // ---------------------------------------------------------------------------
  describe('w2_edit_message', () => {
    const cmid = 'sec1-032-message-edit';
    let messageA: string;
    let messageB: string;

    beforeAll(async () => {
      const post = async (body: string, postCmid: string): Promise<string> => {
        const value = await appValue<{ messageIds: string[] }>(
          OWNER_IDENTITY,
          `select public.w2_post_message_batch(array[$1]::uuid[], $2, null, '{}'::uuid[],
                                               '{}'::uuid[], null, null, $3) value`,
          [spaceOwner.channelId, body, postCmid],
        );
        return value.messageIds[0]!;
      };
      messageA = await post('message A under the binding', 'sec1-032-post-a');
      messageB = await post('message B under the binding', 'sec1-032-post-b');
      expect(messageA).not.toBe(messageB);
    });

    it('POSITIVE: edits, and a same-principal same-message replay returns the result', async () => {
      const first = await appValue<{ messageId: string }>(
        OWNER_IDENTITY,
        `select public.w2_edit_message($1, $2, '{}'::uuid[], null, null, $3) value`,
        [messageA, 'edited body', cmid],
      );
      expect(first.messageId).toBe(messageA);
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const replay = await appValue<{ messageId: string }>(
        OWNER_IDENTITY,
        `select public.w2_edit_message($1, $2, '{}'::uuid[], null, null, $3) value`,
        [messageA, 'edited body', cmid],
      );
      expect(replay.messageId, 'idempotency was traded away').toBe(messageA);
    });

    it('NEGATIVE (subject): the SAME principal addressing a DIFFERENT message is refused', async () => {
      const outcome = await attempt(() =>
        appValue(OWNER_IDENTITY, `select public.w2_edit_message($1, $2, '{}'::uuid[], null, null, $3) value`, [
          messageB,
          'edited body',
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `SEC-1: a same-principal cross-MESSAGE replay ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another message');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. THE SECOND DOOR — public.post_message shares the 'messages.post' operation
  //    label with public.w2_post_message_batch, so a row recorded by the
  //    hash-guarded 019 function is resolvable through the unguarded 007 one.
  //
  // RUN AS tm8_graph_owner, NOT tm8_app, AND THAT IS THE HONEST FRAMING. 019:1321
  // revokes EXECUTE on post_message from tm8_app, so the application role cannot
  // open this door today; measured ACL is tm8_graph_owner=X only. These tests
  // therefore prove the guard FIRES, not that a live exploit path exists. The
  // identity claim is still bound so that the PRINCIPAL half passes and what is
  // being observed is genuinely the subject/door binding.
  // ---------------------------------------------------------------------------
  describe('post_message: the second door onto messages.post', () => {
    async function asOwnerRole<T>(identityId: string, sql: string, params: readonly unknown[]): Promise<T> {
      return database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-sec1-032-door', true)`,
          [identityId],
        );
        const result = await client.query<{ value: T }>(sql, [...params]);
        return result.rows[0]!.value;
      });
    }

    const postSql = `select public.post_message($1, $2, null, null, '[]'::jsonb, '[]'::jsonb, $3) value`;

    it('control: tm8_app genuinely cannot execute post_message', async () => {
      const rows = await ownerRows<{ allowed: boolean }>(
        `select has_function_privilege('tm8_app',
                 'public.post_message(uuid,text,uuid,uuid,jsonb,jsonb,text)', 'EXECUTE') allowed`,
      );
      expect(
        rows[0]!.allowed,
        'post_message IS executable by tm8_app — the reachability note in 032 is now wrong',
      ).toBe(false);
    });

    it('POSITIVE: post_message replays its OWN row for the same anchor', async () => {
      const cmid = 'sec1-032-door-own';
      const first = await asOwnerRole<{ entity: { id: string } }>(OWNER_IDENTITY, postSql, [
        spaceOwner.channelId,
        'posted through the 007 door',
        cmid,
      ]);
      expect(first.entity.id).toBeTruthy();
      const replay = await asOwnerRole<{ entity: { id: string } }>(OWNER_IDENTITY, postSql, [
        spaceOwner.channelId,
        'posted through the 007 door',
        cmid,
      ]);
      expect(replay.entity.id, 'idempotency was traded away at the 007 door').toBe(first.entity.id);
    });

    // THE CROSS-DOOR CASE. Same principal, same operation label, row recorded by
    // the 019 function — which has no 'patches' key, so the binding refuses it.
    it('NEGATIVE: a row recorded by w2_post_message_batch is NOT served through post_message', async () => {
      const cmid = 'sec1-032-door-cross';
      const batch = await appValue<{ messageIds: string[] }>(
        OWNER_IDENTITY,
        `select public.w2_post_message_batch(array[$1]::uuid[], $2, null, '{}'::uuid[],
                                             '{}'::uuid[], null, null, $3) value`,
        [spaceOwner.channelId, 'recorded through the 019 door', cmid],
      );
      expect(batch.messageIds[0], 'the 019 row was not recorded — this negative is vacuous').toBeTruthy();
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const outcome = await attempt(() =>
        asOwnerRole(OWNER_IDENTITY, postSql, [
          spaceOwner.channelId,
          'riding the batch cmid through the other door',
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `SEC-1 SECOND DOOR: a 019-recorded row replayed through post_message ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another anchor');
    });
  });
});
