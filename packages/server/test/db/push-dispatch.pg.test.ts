/**
 * 393 (TM8 Mobile S6) against a real Postgres, through the real claim binding
 * (PgDb → BIND_CLAIMS_SQL), the real inbox assembler and the fake relay.
 *
 * ## The join with S1
 *
 * `public.devices` is 392's (S1). Until 392 is on this branch the table below is
 * a FIXTURE: S1's `create table` copied verbatim from 392_devices.sql at
 * effa34fd5. With 392 applied, `if not exists` makes it a no-op and every test
 * here runs against the real table instead. Tokens are sealed with the stub in
 * ../push/fixtures.ts; the composition root opens them with S1's
 * openDeviceToken.
 *
 * ## What must hold
 *
 *   * only the push worker opens the four doors and the two device functions:
 *     a node admin over HTTP, a pinned session, a member forging the job name
 *     and another job's claim all get 42501, and tm8_app can neither execute
 *     the device functions nor read the queue or the tickets (security pass);
 *   * a notification for a member with a live device is queued once and becomes
 *     one PushPayloadV1 per device, in that device's previews (ac1, ac2);
 *   * a revoked or expired sign-in's device gets nothing;
 *   * a dead token the relay reports is deleted, a rotated one is not (ac3);
 *   * the only relay is FakePushRelay (ac4).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PushPayloadV1Schema } from '@tm8/contract';

import { PgDb } from '../../src/db/client.js';
import type { DbClaims } from '../../src/db/types.js';
import { PushDispatcher, PushReceiptChecker } from '../../src/push/dispatcher.js';
import { PgPushStore } from '../../src/push/store.js';
import { FakePushRelay } from '../push/fake-relay.js';
import { ORIGIN, expoToken, sha256, stubOpen, stubSeal } from '../push/fixtures.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const OWNER = 's6-node-owner';
const ALICE = 's6-alice';
const BOB = 's6-bob';

/** 392_devices.sql (S1, effa34fd5), `create table` verbatim. */
const DEVICES_FIXTURE = `
create table if not exists public.devices (
  id               uuid primary key default internal.new_id(),
  identity_id      text not null references public.accounts(identity_id) on delete cascade,
  auth_session_id  uuid not null references public.auth_sessions(id) on delete cascade,
  platform         text not null,
  relay            text not null,
  token_hash       text not null,
  token_ciphertext bytea not null,
  token_nonce      bytea not null,
  app_version      text not null,
  locale           text not null,
  previews         text not null default 'sender',
  label            text not null,
  quiet_until      timestamptz,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint devices_platform_check check (platform in ('ios', 'android')),
  constraint devices_relay_check check (relay in ('expo')),
  constraint devices_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint devices_token_ciphertext_check check (octet_length(token_ciphertext) between 17 and 4096),
  constraint devices_token_nonce_check check (octet_length(token_nonce) = 12),
  constraint devices_app_version_check check (char_length(btrim(app_version)) between 1 and 64),
  constraint devices_locale_check check (locale ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,6}$'),
  constraint devices_previews_check check (previews in ('full', 'sender', 'none')),
  constraint devices_label_check check (char_length(btrim(label)) between 1 and 200),
  constraint devices_version_check check (version > 0),
  constraint devices_one_per_sign_in unique (auth_session_id),
  constraint devices_one_per_token unique (identity_id, token_hash)
)`;

interface Ids {
  space: string;
  ownerMember: string;
  aliceMember: string;
  bobMember: string;
  agent: string;
  channel: string;
  task: string;
  aliceAccount: string;
  bobAccount: string;
}

let database: W1ScratchDatabase;
let db: PgDb;
let ids: Ids;

const worker = (): DbClaims => ({
  identityId: OWNER, nodeAdmin: true, requestId: 's6-test-worker', backgroundJob: 'push.dispatch',
});

async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query(sql, params)).rows as T[];
  });
}

async function newId(): Promise<string> {
  const [row] = await asOwner<{ id: string }>('select internal.new_id()::text id');
  return row!.id;
}

async function sqlstateOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    const e = error as { details?: { sqlstate?: string }; code?: string };
    return e.details?.sqlstate ?? e.code ?? String(error);
  }
}

interface SeededDevice {
  id: string;
  token: string;
  sessionId: string;
}

let tokenCounter = 0;

/** A device of `identity` on its own sign-in: live unless told otherwise. */
async function seedDevice(identity: string, account: string, options: {
  previews?: 'full' | 'sender' | 'none';
  revoked?: boolean;
  expired?: boolean;
  quietUntil?: string;
} = {}): Promise<SeededDevice> {
  tokenCounter += 1;
  const token = expoToken(1000 + tokenCounter);
  const sessionId = await newId();
  await asOwner(
    `insert into public.auth_sessions(id, account_id, kind, token_hash, expires_at, revoked_at)
     values ($1, $2, 'cli', $3, now() + ($4 || ' days')::interval, $5)`,
    [sessionId, account, sha256(`session-${tokenCounter}`), options.expired ? '-1' : '90',
      options.revoked ? new Date().toISOString() : null],
  );
  const sealed = stubSeal(identity, token);
  const [row] = await asOwner<{ id: string }>(
    `insert into public.devices(identity_id, auth_session_id, platform, relay, token_hash, token_ciphertext,
                                token_nonce, app_version, locale, previews, label, quiet_until)
     values ($1, $2, 'ios', 'expo', $3, $4, $5, '1.0.0', 'en-GB', $6, 'Test phone', $7)
     returning id::text`,
    [identity, sessionId, sealed.tokenHash, sealed.ciphertext, sealed.nonce, options.previews ?? 'sender',
      options.quietUntil ?? null],
  );
  return { id: row!.id, token, sessionId };
}

async function notify(options: {
  recipientMember: string;
  kind?: string;
  target?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
  teamMember?: string | null;
  createdAgo?: string;
  read?: boolean;
}): Promise<string> {
  const [row] = await asOwner<{ id: string }>(
    `insert into public.notifications(space_id, recipient_member_id, recipient_team_member_id, target_entity_id,
                                      actor_id, kind, payload, read_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now() - $9::interval)
     returning id::text`,
    [ids.space, options.recipientMember, options.teamMember ?? null, options.target === undefined ? ids.task : options.target,
      options.actor === undefined ? ids.bobMember : options.actor, options.kind ?? 'assignment',
      JSON.stringify(options.payload ?? {}), options.read ? new Date().toISOString() : null, options.createdAgo ?? '0 seconds'],
  );
  return row!.id;
}

async function devicesLeft(): Promise<string[]> {
  return (await asOwner<{ id: string }>('select id::text from public.devices order by created_at, id')).map((r) => r.id);
}

async function outbox(notificationId: string) {
  const [row] = await asOwner<{
    attempts: number; claimed_at: Date | null; processed_at: Date | null; dead_lettered_at: Date | null;
    last_error: string | null; available_at: Date;
  }>(
    `select attempts, claimed_at, processed_at, dead_lettered_at, last_error, available_at
       from public.notification_outbox where notification_id = $1 and channel = 'push'`,
    [notificationId],
  );
  return row;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('s6_push');
  database.apply(migrationFiles());
  await asOwner(DEVICES_FIXTURE);

  ids = {
    space: await newId(), ownerMember: await newId(), aliceMember: await newId(), bobMember: await newId(),
    agent: await newId(), channel: await newId(), task: await newId(), aliceAccount: '', bobAccount: '',
  };
  await asOwner(
    `insert into public.user_profiles(identity_id, display_name) values ($1, 'Node owner'), ($2, 'Alice'), ($3, 'Bob')`,
    [OWNER, ALICE, BOB]);
  const accounts = await asOwner<{ id: string; identity_id: string }>(
    `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
     values ($1, $1, 'Node owner', true, true), ($2, $2, 'Alice', false, false), ($3, $3, 'Bob', false, false)
     returning id::text, identity_id`,
    [OWNER, ALICE, BOB]);
  ids.aliceAccount = accounts.find((a) => a.identity_id === ALICE)!.id;
  ids.bobAccount = accounts.find((a) => a.identity_id === BOB)!.id;
  await asOwner(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S6 push', $2)`, [ids.space, OWNER]);
  await asOwner(
    `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $5, 'member', 0, $1), ($2, $5, 'member', 1, $1), ($3, $5, 'member', 2, $1), ($4, $5, 'team_member', 3, $2)`,
    [ids.ownerMember, ids.aliceMember, ids.bobMember, ids.agent, ids.space]);
  await asOwner(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $4, $5, 'owner', 'Node owner'), ($2, $4, $6, 'member', 'Alice'), ($3, $4, $7, 'member', 'Bob')`,
    [ids.ownerMember, ids.aliceMember, ids.bobMember, ids.space, OWNER, ALICE, BOB]);
  await asOwner(
    `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
     values ($1, $2, 'Worker', 'worker', 'test agent')`, [ids.agent, ids.aliceMember]);
  await asOwner(
    `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $3, 'channel', 10, $4), ($2, $3, 'task', 11, $4)`,
    [ids.channel, ids.task, ids.space, ids.bobMember]);
  await asOwner(`insert into public.channels(entity_id, space_id, name) values ($1, $2, 'mobile')`, [ids.channel, ids.space]);
  await asOwner(
    `insert into public.tasks(entity_id, title, work_status, priority) values ($1, 'Ship the tablet layout', 'open', 'medium')`,
    [ids.task]);

  db = new PgDb({ databaseUrl: database.url, max: 4 });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

beforeEach(async () => {
  await asOwner('delete from public.push_tickets');
  await asOwner(`delete from public.notification_outbox where channel = 'push'`);
  await asOwner('delete from public.notifications');
  await asOwner('delete from public.devices');
});

function store(): PgPushStore {
  return new PgPushStore({ db, claims: async () => worker() });
}

describe('393 §1 and §5: only the push worker gets in (security pass)', () => {
  const doors: Array<[string, unknown[]]> = [
    ['public.claim_push_dispatch', [25, 120, 900, 3600]],
    ['public.settle_push_dispatch', ['00000000-0000-7000-8000-000000000000', 'sent', null, '[]', '[]', null]],
    ['public.claim_push_receipts', [10, 0, 60]],
    ['public.settle_push_receipts', [[], []]],
  ];

  it('a node admin over HTTP is refused by every door', async () => {
    const http: DbClaims = { identityId: OWNER, nodeAdmin: true, requestId: 's6-http', authKind: 'cli' };
    for (const [fn, args] of doors) expect(await sqlstateOf(db.rpc(http, fn, args)), fn).toBe('42501');
  });

  it('so is a pinned session, a member forging the job name, and another job\'s claim', async () => {
    const pinned: DbClaims = { ...worker(), sessionSpaceId: ids.space };
    const forged: DbClaims = { identityId: ALICE, requestId: 's6-forged', backgroundJob: 'push.dispatch' };
    const loops: DbClaims = { ...worker(), backgroundJob: 'loops.execute-due' };
    for (const claims of [pinned, forged, loops]) {
      for (const [fn, args] of doors) expect(await sqlstateOf(db.rpc(claims, fn, args)), fn).toBe('42501');
    }
  });

  it('tm8_app cannot execute the two device functions, even with the worker\'s claims', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    expect(await sqlstateOf(db.query(worker(), 'select * from internal.push_devices_for($1)', [ALICE]))).toBe('42501');
    expect(await sqlstateOf(db.query(worker(), 'select internal.delete_push_device($1::uuid, $2)',
      ['00000000-0000-7000-8000-000000000000', sha256('x')]))).toBe('42501');
    expect(await sqlstateOf(db.query(worker(), 'select internal.is_push_worker()'))).toBe('42501');
  });

  it('tm8_app reads neither the queue nor the tickets', async () => {
    expect(await sqlstateOf(db.query(worker(), 'select * from public.push_tickets'))).toBe('42501');
    expect(await sqlstateOf(db.query(worker(), 'select * from public.notification_outbox'))).toBe('42501');
  });

  it('the push worker itself gets in', async () => {
    expect(await db.rpc(worker(), 'public.claim_push_dispatch', [25, 120, 900, 3600])).toMatchObject({ items: [] });
  });
});

describe('393 §4 claim: who is queued, and with which devices', () => {
  it('queues an unread notification of a member with a live device, once, with only the live devices', async () => {
    const full = await seedDevice(ALICE, ids.aliceAccount, { previews: 'full' });
    const sender = await seedDevice(ALICE, ids.aliceAccount, { previews: 'sender' });
    await seedDevice(ALICE, ids.aliceAccount, { revoked: true });
    await seedDevice(ALICE, ids.aliceAccount, { expired: true });
    const n = await notify({ recipientMember: ids.aliceMember });

    const batch = await store().claim(25);

    expect(batch.enqueued).toBe(1);
    expect(batch.items).toHaveLength(1);
    const [item] = batch.items;
    expect(item).toMatchObject({ notificationId: n, spaceId: ids.space, recipientIdentityId: ALICE, attempt: 1 });
    expect(item!.devices.map((d) => d.deviceId).sort()).toEqual([full.id, sender.id].sort());
    const opened = item!.devices.map((d) => stubOpen(d.identityId, d.sealed)).sort();
    expect(opened).toEqual([full.token, sender.token].sort());
    expect(item!.devices.find((d) => d.deviceId === full.id)!.previews).toBe('full');

    // Leased: the next claim does not hand it out again.
    expect((await store().claim(25)).items).toHaveLength(0);
  });

  it('does not queue what the default inbox would not show, nor the past', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    await notify({ recipientMember: ids.bobMember });                              // Bob has no phone
    await notify({ recipientMember: ids.aliceMember, teamMember: ids.agent });      // her teammate's inbox
    await notify({ recipientMember: ids.aliceMember, read: true });                 // already read
    await notify({ recipientMember: ids.aliceMember, createdAgo: '20 minutes' });   // before the window
    const batch = await store().claim(25);
    expect(batch.enqueued).toBe(0);
    expect(batch.items).toHaveLength(0);
  });

  it('a sent notification is never queued again', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember });
    const [item] = (await store().claim(25)).items;
    await store().settle(item!.outboxId, { outcome: 'sent', tickets: [], dead: [], error: null });
    await asOwner(`update public.notification_outbox set claimed_at = null where notification_id = $1`, [n]);
    const again = await store().claim(25);
    expect(again.enqueued).toBe(0);
    expect(again.items).toHaveLength(0);
    expect((await outbox(n))?.processed_at).not.toBeNull();
  });
});

describe('end to end: the inbox assembler under the recipient\'s claims, and the fake relay (ac1, ac2)', () => {
  it('an assignment reaches each device in its own previews', async () => {
    const full = await seedDevice(ALICE, ids.aliceAccount, { previews: 'full' });
    const sender = await seedDevice(ALICE, ids.aliceAccount, { previews: 'sender' });
    const none = await seedDevice(ALICE, ids.aliceAccount, { previews: 'none' });
    const n = await notify({ recipientMember: ids.aliceMember, kind: 'assignment', target: ids.task });
    const relay = new FakePushRelay();
    const dispatcher = new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN });

    const result = await dispatcher.tick();

    expect(result).toMatchObject({ claimed: 1, accepted: 3, failed: 0, retried: 0 });
    const byToken = new Map(relay.messages.map((m) => [m.to, m.payload]));
    expect(byToken.get(full.token)).toMatchObject({ title: 'Bob assigned you', body: 'Ship the tablet layout', categoryId: 'tm8.task' });
    expect(byToken.get(sender.token)).toMatchObject({ title: 'Bob assigned you', body: '' });
    expect(byToken.get(none.token)).toMatchObject({ title: '', body: 'New notification' });
    for (const payload of byToken.values()) {
      expect(PushPayloadV1Schema.safeParse(payload).success).toBe(true);
      expect(payload.data).toEqual({
        v: 1, o: ORIGIN, sp: ids.space, n, e: ids.task, k: 'assignment',
        h: `${ORIGIN}/#/s/${ids.space}/e/${ids.task}`,
      });
    }

    const row = await outbox(n);
    expect(row).toMatchObject({ attempts: 1, last_error: null, dead_lettered_at: null });
    expect(row!.processed_at).not.toBeNull();
    const tickets = await asOwner<Record<string, unknown>>('select * from public.push_tickets order by ticket_id');
    expect(tickets.map((t) => t['device_id']).sort()).toEqual([full.id, sender.id, none.id].sort());
    expect(tickets.every((t) => t['notification_id'] === n)).toBe(true);
    // The ledger holds hashes, never a token.
    expect(JSON.stringify(tickets)).not.toContain('ExponentPushToken');
  });

  it('a mention quotes the message and opens the channel at it', async () => {
    const full = await seedDevice(ALICE, ids.aliceAccount, { previews: 'full' });
    const message = await newId();
    await asOwner(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'message', 0, $3)`,
      [message, ids.space, ids.bobMember]);
    await asOwner(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1, $2, $3, $4)`,
      [message, ids.channel, ids.bobMember, '@alice can you look at the **tablet** overflow?']);
    await notify({
      recipientMember: ids.aliceMember, kind: 'mention', target: ids.channel,
      payload: { messageId: message, anchorId: ids.channel },
    });
    const relay = new FakePushRelay();
    await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();

    const [sent] = relay.messages;
    expect(sent!.to).toBe(full.token);
    expect(sent!.payload.title).toBe('Bob mentioned you in #mobile');
    expect(sent!.payload.body).toBe('@alice can you look at the tablet overflow?');
    expect(sent!.payload.data.h).toBe(`${ORIGIN}/#/s/${ids.space}/channel/${ids.channel}?msg=${message}`);
    expect(sent!.route).toEqual({ categoryId: 'tm8.reply', androidChannelId: 'mentions', interruptionLevel: 'active' });
  });

  it('a device inside its quiet window gets the push passively', async () => {
    const quiet = await seedDevice(ALICE, ids.aliceAccount, { quietUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();
    expect(relay.messages[0]!.to).toBe(quiet.token);
    expect(relay.messages[0]!.route).toMatchObject({ androidChannelId: 'quiet', interruptionLevel: 'passive' });
  });
});

describe('ac3: dead tokens the relay reports are deleted', () => {
  it('a DeviceNotRegistered ticket deletes that device row, and only that one', async () => {
    const gone = await seedDevice(ALICE, ids.aliceAccount);
    const kept = await seedDevice(ALICE, ids.aliceAccount);
    await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    relay.dead.add(gone.token);

    const result = await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();

    expect(result).toMatchObject({ devicesDeleted: 1, accepted: 1, refused: { DeviceNotRegistered: 1 } });
    expect(await devicesLeft()).toEqual([kept.id]);
  });

  it('a device whose token was rotated since the push went out survives the stale report', async () => {
    const phone = await seedDevice(ALICE, ids.aliceAccount);
    await notify({ recipientMember: ids.aliceMember });
    const [item] = (await store().claim(25)).items;
    const sentHash = item!.devices[0]!.sealed.tokenHash;
    // devices.update rotated the token meanwhile.
    await asOwner(`update public.devices set token_hash = $2 where id = $1`, [phone.id, sha256(expoToken(999_999))]);
    const settled = await store().settle(item!.outboxId, {
      outcome: 'sent', tickets: [], dead: [{ deviceId: phone.id, tokenHash: sentHash }], error: 'DeviceNotRegistered×1',
    });
    expect(settled.devicesDeleted).toBe(0);
    expect(await devicesLeft()).toEqual([phone.id]);
  });

  it('a DeviceNotRegistered receipt deletes the device its ticket went to; answered tickets are forgotten', async () => {
    const gone = await seedDevice(ALICE, ids.aliceAccount);
    const fine = await seedDevice(ALICE, ids.aliceAccount);
    const waiting = await seedDevice(ALICE, ids.aliceAccount);
    await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();
    const ticketFor = (token: string) => [...relay.ticketTokens].find(([, t]) => t === token)![0];
    relay.receiptAnswers.set(ticketFor(gone.token), { status: 'error', error: 'DeviceNotRegistered' });
    relay.receiptAnswers.set(ticketFor(fine.token), { status: 'ok' });
    // Receipts are asked for 15 minutes after the send; and one ticket is past Expo's 24 hours.
    await asOwner(`update public.push_tickets set created_at = now() - interval '20 minutes'`);
    await asOwner(
      `insert into public.push_tickets(ticket_id, device_id, token_hash, created_at)
       values ('ancient', $1, $2, now() - interval '25 hours')`, [fine.id, sha256(fine.token)]);

    const result = await new PushReceiptChecker({ store: store(), relay }).tick();

    expect(result).toMatchObject({ checked: 3, answered: 2, pending: 1, devicesDeleted: 1, expired: 1 });
    expect((await devicesLeft()).sort()).toEqual([fine.id, waiting.id].sort());
    const left = await asOwner<{ ticket_id: string }>('select ticket_id from public.push_tickets');
    expect(left.map((t) => t.ticket_id)).toEqual([ticketFor(waiting.token)]);
  });

  it('a ticket younger than 15 minutes is not asked about yet', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();
    const result = await new PushReceiptChecker({ store: store(), relay }).tick();
    expect(result.checked).toBe(0);
    expect(relay.receiptCalls).toHaveLength(0);
  });
});

describe('retry, read first, and expiry', () => {
  it('a retry waits out its backoff, then comes back as the next attempt', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    relay.failNext('unavailable');
    const dispatcher = new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN });
    expect(await dispatcher.tick()).toMatchObject({ retried: 1 });
    expect(await outbox(n)).toMatchObject({ attempts: 1, claimed_at: null, processed_at: null });
    expect((await outbox(n))!.last_error).toContain('fake relay unavailable');

    expect((await store().claim(25)).items).toHaveLength(0);
    await asOwner(`update public.notification_outbox set available_at = now() - interval '1 second' where notification_id = $1`, [n]);
    expect(await dispatcher.tick()).toMatchObject({ claimed: 1, accepted: 1 });
    expect(await outbox(n)).toMatchObject({ attempts: 2 });
  });

  it('a refused request dead-letters the row', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember });
    const relay = new FakePushRelay();
    relay.failNext('rejected');
    await new PushDispatcher({ store: store(), relay, openToken: stubOpen, origin: ORIGIN }).tick();
    const row = await outbox(n);
    expect(row!.dead_lettered_at).not.toBeNull();
    expect(row!.processed_at).toBeNull();
  });

  it('a row read before its turn is settled without a push', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember });
    const [item] = (await store().claim(25)).items;
    await store().settle(item!.outboxId, { outcome: 'retry', error: 'test', retryAfterSeconds: 1 });
    await asOwner(`update public.notifications set read_at = now() where id = $1`, [n]);
    const batch = await store().claim(25);
    expect(batch).toMatchObject({ skippedRead: 1, items: [] });
    expect(await outbox(n)).toMatchObject({ last_error: 'skipped: read before dispatch' });
  });

  it('a queued push still unsent an hour after it happened is dead-lettered, not sent', async () => {
    await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember, createdAgo: '10 minutes' });
    const [item] = (await store().claim(25)).items;
    await store().settle(item!.outboxId, { outcome: 'retry', error: 'relay down', retryAfterSeconds: 1 });
    await asOwner(`update public.notifications set created_at = now() - interval '2 hours' where id = $1`, [n]);
    const batch = await store().claim(25);
    expect(batch).toMatchObject({ expired: 1, items: [] });
    const row = await outbox(n);
    expect(row!.dead_lettered_at).not.toBeNull();
    expect(row!.last_error).toBe('expired: relay down');
  });

  it('a device signed out after the push was queued gets nothing', async () => {
    const phone = await seedDevice(ALICE, ids.aliceAccount);
    const n = await notify({ recipientMember: ids.aliceMember });
    const [item] = (await store().claim(25)).items;
    await store().settle(item!.outboxId, { outcome: 'retry', error: 'test', retryAfterSeconds: 1 });
    await asOwner(`update public.auth_sessions set expires_at = now() - interval '1 second' where id = $1`, [phone.sessionId]);
    await asOwner(`update public.notification_outbox set available_at = now() - interval '1 second' where notification_id = $1`, [n]);
    const batch = await store().claim(25);
    expect(batch).toMatchObject({ skippedNoDevice: 1, items: [] });
    expect(await outbox(n)).toMatchObject({ last_error: 'skipped: no live device' });
  });
});
