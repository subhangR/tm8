/**
 * DRAFT — destined for packages/server/test/events/ws-e2e-multi-identity.pg.test.ts
 * (held in scratchpad while the tree is frozen; do not run from here)
 *
 * The properties a single client CANNOT witness: fan-out across members, and
 * the recipient_member_id leak case — a notification addressed to one member
 * must reach ONLY that member's socket, while the space-wide event it rode in
 * with reaches everyone.
 *
 * ## Why this suite does not use bootstrap()
 *
 * Verified against main.ts:167-170 (and confirmed by the server-owner
 * coordinator): under `bootstrap()`, `wsClaimsFor` resolves every WS
 * connection to the loopback owner, so a recipient-targeted event either
 * reaches nobody or legitimately reaches every socket — the leak is
 * structurally unobservable with one identity. This suite therefore composes
 * the SAME production modules `main.ts` composes over the same
 * scratch-database chain, differing in exactly one wire: the PRODUCTION
 * `authorize` seam on createWsServer (ws-server.ts:44) maps a
 * `?testIdentity=` query param to the connection's identity, the way a real
 * auth layer will once one exists. Every event still comes from the capture
 * trigger; nothing publishes by hand.
 *
 * ## Drift containment (control.ts carries a live W5 grant)
 *
 * The composition lives in ws-e2e-harness.ts (composeRealEventPath): ONE
 * factory holds every direct construction of the control.ts types. If
 * control.ts's interface moves, exactly one function needs the matching edit.
 *
 * RUN: cd packages/server && ./node_modules/.bin/vitest run \
 *        --no-file-parallelism test/events/ws-e2e-multi-identity.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { WorkspaceEventSchema } from '@tm8/contract';

import { DbSubscriptionAuthorizer, PgDurableEventLog } from '../../src/events/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createTestDb, type TestDb } from './pg-harness.js';
import {
  addSpaceMember,
  claimsFor,
  collect,
  composeRealEventPath,
  connectWs,
  createSuperuserShapedDb,
  groundTruth,
  postMentioning,
  send,
  spine,
  startComposedWsServer,
  waitFor,
  type ComposedWsServer,
  type FrameCollector,
} from './ws-e2e-harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let database: W1ScratchDatabase;
let db: TestDb;
let composition: ReturnType<typeof composeRealEventPath>;
let composed: ComposedWsServer;
let wsBase = '';

let spaceId = '';
let memberA: { identityId: string; memberId: string };
let memberB: { identityId: string; memberId: string };
/** Identity with a profile but NO membership anywhere. */
let strangerIdentityId = '';
let anchorTaskId = '';

const sockets: WebSocket[] = [];

async function identitySocket(identityId: string): Promise<{ ws: WebSocket; frames: FrameCollector }> {
  const ws = await connectWs(`${wsBase}/v2/ws?testIdentity=${identityId}`);
  sockets.push(ws);
  return { ws, frames: collect(ws) };
}

/**
 * Connect, subscribe, and wait until the subscription is LIVE — i.e. the
 * control channel's asynchronous high-water seed has landed (observed via the
 * harness's instrumented LiveCursor). Mutating before that seed is a race the
 * pump is entitled to lose: a late seed reads a post-mutation high-water mark
 * and correctly starts past it.
 */
async function liveSocket(
  identityId: string,
  spaceIds: readonly string[] = [spaceId],
): Promise<{ ws: WebSocket; frames: FrameCollector }> {
  const baseline = composition.seeds.length;
  const socket = await identitySocket(identityId);
  send(socket.ws, { type: 'subscribe', spaceIds: [...spaceIds] });
  await waitFor(() => composition.seeds.length >= baseline + spaceIds.length);
  return socket;
}

/** Drive delivery deterministically: N explicit ticks, no wall-clock waits. */
async function ticks(n: number): Promise<number> {
  let delivered = 0;
  for (let i = 0; i < n; i += 1) delivered += await composition.pump.tick();
  return delivered;
}

async function createTaskAsA(title: string): Promise<string> {
  const result = await db.rpc<{ entity: { id: string } }>(
    claimsFor(memberA.identityId),
    'public.create_task',
    [spaceId, title, memberA.memberId, '', null, null, null, 'medium', null, null, null, null, null, 'attached_to', `cmid_${randomUUID()}`],
  );
  return result.entity.id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('wse2e_multi');
  database.apply(migrationFiles());
  db = createTestDb(database.url);

  // Identity A creates the space (becomes owning member/admin).
  memberA = { identityId: `identity_${randomUUID()}`, memberId: '' };
  await db.rpc(claimsFor(memberA.identityId), 'public.upsert_user_profile', ['Member A', null, null]);
  const created = await db.rpc<{ space: { id: string } }>(
    claimsFor(memberA.identityId),
    'public.create_space',
    ['multi-identity space', 'leak proof', 'private', null, null],
  );
  spaceId = created.space.id;
  const rows = await db.query<{ entity_id: string }>(
    claimsFor(memberA.identityId),
    'select entity_id from public.members where space_id = $1 and identity_id = $2',
    [spaceId, memberA.identityId],
  );
  memberA.memberId = rows[0]!.entity_id;

  // Identity B joins through the public invite path.
  memberB = await addSpaceMember(db, spaceId, memberA.identityId, 'Member B');

  // Identity C: a profile, no membership.
  strangerIdentityId = `identity_${randomUUID()}`;
  await db.rpc(claimsFor(strangerIdentityId), 'public.upsert_user_profile', ['Stranger C', null, null]);

  anchorTaskId = await createTaskAsA('anchor task');

  composition = composeRealEventPath(db);
  composed = await startComposedWsServer(composition);
  wsBase = composed.wsBase;
});

afterAll(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await composed?.close();
  await db?.end();
  await database?.destroy();
});

describe('two-socket fan-out across real identities', () => {
  it('B1: a space-wide event reaches BOTH members, same seq', async () => {
    const a = await liveSocket(memberA.identityId);
    const b = await liveSocket(memberB.identityId);
    const markA = a.frames.all.length;
    const markB = b.frames.all.length;

    const title = `fanout-${randomUUID()}`;
    await createTaskAsA(title);
    await ticks(6);

    const match = (f: unknown): boolean =>
      (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
      && (f as { entity: { title: string } }).entity.title === title;
    const onA = a.frames.since(markA).find(match);
    const onB = b.frames.since(markB).find(match);
    expect(onA, 'member A did not receive the space-wide event').toBeDefined();
    expect(onB, 'member B did not receive the space-wide event').toBeDefined();
    expect((onA as { seq: number }).seq, 'the two sockets disagree about the seq').toBe(
      (onB as { seq: number }).seq,
    );
  });

  it('B2: THE LEAK CASE — a recipient-targeted notification reaches ONLY its member, both directions', async () => {
    const a = await liveSocket(memberA.identityId);
    const b = await liveSocket(memberB.identityId);
    const markA = a.frames.all.length;
    const markB = b.frames.all.length;

    // Direction 1: A mentions B. B gets the notification; A must not.
    const bodyB = `for-b-${randomUUID()}`;
    await postMentioning(db, memberA.identityId, memberA.memberId, anchorTaskId, memberB.memberId, bodyB);
    await ticks(8);

    const isNotification = (f: unknown): boolean =>
      String((f as { type?: string }).type ?? '').startsWith('notification.');
    const isMessage = (body: string) => (f: unknown): boolean =>
      (f as { type?: string }).type === 'message.created'
      && (f as { message?: { content?: { body?: string } } }).message?.content?.body === body;

    // The space-wide half reaches both…
    expect(a.frames.since(markA).some(isMessage(bodyB)), 'A missed the space-wide message').toBe(true);
    expect(b.frames.since(markB).some(isMessage(bodyB)), 'B missed the space-wide message').toBe(true);
    // …the targeted half reaches exactly one.
    const notifB = b.frames.since(markB).filter(isNotification);
    expect(notifB.length, 'B never received their notification').toBeGreaterThan(0);
    expect(
      a.frames.since(markA).filter(isNotification),
      "B's private notification LEAKED to A's socket",
    ).toEqual([]);

    // Direction 2: B mentions A — the mirror image, so the pass cannot be an
    // artifact of who subscribed first or of member creation order.
    const markA2 = a.frames.all.length;
    const markB2 = b.frames.all.length;
    const bodyA = `for-a-${randomUUID()}`;
    await postMentioning(db, memberB.identityId, memberB.memberId, anchorTaskId, memberA.memberId, bodyA);
    await ticks(8);

    expect(a.frames.since(markA2).filter(isNotification).length).toBeGreaterThan(0);
    expect(
      b.frames.since(markB2).filter(isNotification),
      "A's private notification LEAKED to B's socket",
    ).toEqual([]);

    // Every frame either socket ever saw is contract-shaped.
    for (const frame of [...a.frames.all, ...b.frames.all]) {
      if (String((frame as { type?: string }).type).startsWith('control.')) continue;
      expect(WorkspaceEventSchema.safeParse(frame).success).toBe(true);
    }
  });

  it('B2b: interleaved bidirectional targeting in ONE seq run — exact delivered AND excluded sets per socket, zero cross-space bleed on a third socket', async () => {
    // Third socket: identity D, a NON-member of the space under test, owning
    // a DIFFERENT space and subscribed to THAT. Any frame from the main space
    // arriving on D's socket is cross-space bleed.
    const identityD = `identity_${randomUUID()}`;
    await db.rpc(claimsFor(identityD), 'public.upsert_user_profile', ['Member D', null, null]);
    const otherSpace = await db.rpc<{ space: { id: string } }>(
      claimsFor(identityD),
      'public.create_space',
      ['D own space', 'bleed control', 'private', null, null],
    );
    const dMemberRows = await db.query<{ entity_id: string }>(
      claimsFor(identityD),
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [otherSpace.space.id, identityD],
    );
    const dMemberId = dMemberRows[0]!.entity_id;

    const a = await liveSocket(memberA.identityId);
    const b = await liveSocket(memberB.identityId);
    const d = await liveSocket(identityD, [otherSpace.space.id]);
    const markA = a.frames.all.length;
    const markB = b.frames.all.length;
    const markD = d.frames.all.length;
    const markRows = await database.query<{ seq: string }>(
      'select coalesce(max(seq), 0) as seq from public.workspace_events where space_id = $1',
      [spaceId],
    );
    const markSeq = Number(markRows[0]!.seq);

    // ONE interleaved run: space-wide and targeted rows alternating, both
    // directions, so pass/fail cannot depend on targeting order or on which
    // member was minted first.
    await createTaskAsA(`interleave-1-${randomUUID().slice(0, 8)}`);
    await postMentioning(db, memberA.identityId, memberA.memberId, anchorTaskId, memberB.memberId, `to-b-1-${randomUUID().slice(0, 8)}`);
    await createTaskAsA(`interleave-2-${randomUUID().slice(0, 8)}`);
    await postMentioning(db, memberB.identityId, memberB.memberId, anchorTaskId, memberA.memberId, `to-a-1-${randomUUID().slice(0, 8)}`);
    await postMentioning(db, memberA.identityId, memberA.memberId, anchorTaskId, memberB.memberId, `to-b-2-${randomUUID().slice(0, 8)}`);
    await createTaskAsA(`interleave-3-${randomUUID().slice(0, 8)}`);
    await ticks(12);

    // Exact per-socket accounting against the TABLE: delivered == visible,
    // and every excluded seq is proven absent (not merely "no notification
    // type seen" — seq-level exclusion).
    const truthA = await groundTruth(database, spaceId, markSeq, memberA.memberId);
    const truthB = await groundTruth(database, spaceId, markSeq, memberB.memberId);
    expect(truthA.excluded.length, 'fixture must mint rows A cannot see').toBeGreaterThan(0);
    expect(truthB.excluded.length, 'fixture must mint rows B cannot see').toBeGreaterThan(0);

    const gotA = spine(a.frames.since(markA)).map(([s]) => s);
    const gotB = spine(b.frames.since(markB)).map(([s]) => s);
    expect(gotA, "A's delivered set is not exactly A's visible set").toEqual(truthA.visible);
    expect(gotB, "B's delivered set is not exactly B's visible set").toEqual(truthB.visible);
    for (const seq of truthA.excluded) {
      expect(gotA.includes(seq), `excluded seq ${String(seq)} reached A`).toBe(false);
    }
    for (const seq of truthB.excluded) {
      expect(gotB.includes(seq), `excluded seq ${String(seq)} reached B`).toBe(false);
    }

    // Zero cross-space bleed: D saw NOTHING from the main space…
    const mainSpaceFrames = d.frames.since(markD).filter(
      (f) => (f as { spaceId?: string }).spaceId === spaceId,
    );
    expect(mainSpaceFrames, 'cross-space bleed onto a non-member socket').toEqual([]);

    // …and the zero is a live zero, not a dead socket: D's own space delivers
    // (positive control — an unplugged socket also receives nothing).
    const controlTitle = `d-own-space-${randomUUID().slice(0, 8)}`;
    await db.rpc(claimsFor(identityD), 'public.create_task', [
      otherSpace.space.id, controlTitle, dMemberId, '',
      null, null, null, 'medium', null, null, null, null, null, 'attached_to',
      `cmid_${randomUUID()}`,
    ]);
    await ticks(8);
    expect(
      d.frames.since(markD).some(
        (f) => (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
          && (f as { entity: { title: string } }).entity.title === controlTitle,
      ),
      "D's socket is dead — the zero-bleed assertion above is vacuous",
    ).toBe(true);
  });

  it("B5: events.poll agrees per identity — the notification is on B's feed and absent from A's", async () => {
    const log = new PgDurableEventLog(db);
    const forA = await log.since(spaceId, 0, 500, claimsFor(memberA.identityId));
    const forB = await log.since(spaceId, 0, 500, claimsFor(memberB.identityId));
    const notifTo = (items: readonly unknown[], memberId: string): unknown[] =>
      items.filter((e) => {
        const f = e as { type?: string; notification?: { recipient?: { id?: string } } };
        return f.type === 'notification.created' && f.notification?.recipient?.id === memberId;
      });
    expect(notifTo(forB.items, memberB.memberId).length).toBeGreaterThan(0);
    expect(notifTo(forA.items, memberB.memberId)).toEqual([]);
    // And the space-wide spines agree between the two members' feeds.
    const spaceOnly = (items: readonly unknown[]): Array<[number, string]> =>
      spine(items).filter(([, t]) => !t.startsWith('notification.'));
    expect(spaceOnly(forA.items)).toEqual(spaceOnly(forB.items));
  });
});

describe('the REAL DbSubscriptionAuthorizer, under test at last', () => {
  it('B3a: canSubscribe — a member yes, a non-member no (RLS-derived, not restated)', async () => {
    await expect(
      composition.authorizer.canSubscribe({ kind: 'auto-owner', identityId: memberB.identityId }, spaceId),
    ).resolves.toBe(true);
    await expect(
      composition.authorizer.canSubscribe({ kind: 'auto-owner', identityId: strangerIdentityId }, spaceId),
    ).resolves.toBe(false);
  });

  it('B3b: a non-member subscribe over the wire is refused, and mutations never reach that socket', async () => {
    const c = await identitySocket(strangerIdentityId);
    send(c.ws, { type: 'subscribe', spaceIds: [spaceId] });
    const refusal = await c.frames.next((f) => (f as { type?: string }).type === 'control.refused');
    expect((refusal as { reason: string }).reason).toBe('forbidden');

    await createTaskAsA(`invisible-to-c-${randomUUID()}`);
    await ticks(8);
    expect(spine(c.frames.all), 'a non-member received space events').toEqual([]);
  });

  it('B3c: a non-member resume is refused with the log unread on the wire (no replay frames)', async () => {
    const c = await identitySocket(strangerIdentityId);
    send(c.ws, { type: 'resume', spaceId, since: 0 });
    const refusal = await c.frames.next((f) => (f as { type?: string }).type === 'control.refused');
    expect((refusal as { frame: string }).frame).toBe('resume');
    expect((refusal as { reason: string }).reason).toBe('forbidden');
    await ticks(4);
    expect(spine(c.frames.all)).toEqual([]);
  });

  it('B6: SEEDED-COUNT CONTROL at the pump batch boundary — a batch smaller than the backlog loses nothing across ticks', async () => {
    // Master ruling (W5 cursor-truncation incident: 9 seeded, 3 returned,
    // silent): page-boundary loss must be loud. MAX_RESUME_BATCH cannot be
    // injected, but the pump's batch can — so the boundary property is proven
    // here with batch=2 against a backlog several times that size, asserted
    // as an exact seq set against the TABLE, not "the last event appeared".
    const tiny = composeRealEventPath(db, { batch: 2 });
    const tinyServer = await startComposedWsServer(tiny);

    try {
      const ws = await connectWs(`${tinyServer.wsBase}/v2/ws?testIdentity=${memberA.identityId}`);
      sockets.push(ws);
      const frames = collect(ws);
      send(ws, { type: 'subscribe', spaceIds: [spaceId] });
      // The high-water seed must land before the backlog is seeded, so the
      // backlog is entirely ahead of the cursor — observed, not slept for.
      await waitFor(() => tiny.seeds.length >= 1);
      const markRows = await database.query<{ seq: string }>(
        'select coalesce(max(seq), 0) as seq from public.workspace_events where space_id = $1',
        [spaceId],
      );
      const mark = Number(markRows[0]!.seq);

      // Seed a backlog of SEVEN mutations — each mints several rows, so the
      // backlog spans many batch-of-2 pages.
      const seeded: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const title = `batch-boundary-${String(i)}-${randomUUID().slice(0, 8)}`;
        seeded.push(title);
        await createTaskAsA(title);
      }

      // Ground truth: every visible row minted after the mark.
      const truthRows = await database.query<{ seq: string; recipient_member_id: string | null }>(
        `select seq, recipient_member_id from public.workspace_events
          where space_id = $1 and seq > $2 order by seq asc`,
        [spaceId, mark],
      );
      const expected = truthRows.filter((r) => r.recipient_member_id === null).map((r) => Number(r.seq));
      expect(expected.length, 'the backlog must span many batch pages').toBeGreaterThan(6);

      // Enough ticks to drain the backlog at 2/tick, plus slack — then the
      // EXACT set. A pump that skips a page boundary row fails on the set,
      // not on a timeout.
      for (let i = 0; i < expected.length + 8; i += 1) await tiny.pump.tick();
      const got = spine(frames.all).filter(([s]) => s > mark).map(([s]) => s);
      expect(got, 'the pump lost rows at a batch boundary').toEqual(expected);
      const titles = frames.all
        .filter((f) => (f as { type?: string }).type === 'entity.upsert')
        .map((f) => (f as { entity: { title: string } }).entity.title);
      for (const title of seeded) expect(titles).toContain(title);
    } finally {
      await tinyServer.close();
    }
  });

  it('B7: presence control frames are accepted without refusal (delivery is NOT asserted — no production publisher yet)', async () => {
    // Master ruling: presence has no production publisher and a contract
    // contradiction under arbitration. This case asserts ONLY that the
    // control channel accepts the frames — no presence delivery assertions.
    const a = await liveSocket(memberA.identityId);
    const mark = a.frames.all.length;
    send(a.ws, { type: 'presence', on: true });
    send(a.ws, { type: 'presence.set', spaceId, entityId: anchorTaskId, viewing: true, typing: false });
    await ticks(4);
    expect(
      a.frames.since(mark).filter((f) => (f as { type?: string }).type === 'control.refused'),
      'a presence frame was refused',
    ).toEqual([]);
  });

  it('B3d: THE PRODUCTION SHAPE — the authorizer refuses a non-member even on a superuser pool that bypasses RLS', async () => {
    // Suite B's other cases run the authorizer over pg-harness's TestDb,
    // which drops to tm8_app on every call — so they prove the RLS
    // derivation, but under a role discipline the production PgDb does NOT
    // have (client.ts binds claims, never sets role, and the documented
    // deployment user tm8 is rolsuper/rolbypassrls). This case runs the
    // authorizer over a db of exactly that production shape.
    const rawDb = createSuperuserShapedDb(database.url);
    try {
      // THE MECHANISM CONTROL (the pre-fix red, characterized): the
      // authorizer's own membership probe, run WITHOUT the role drop, under
      // the NON-member's claims — the superuser bypass answers the row, i.e.
      // allow-all. This is what canSubscribe itself did before the fix.
      const bypassed = await rawDb.query(
        claimsFor(strangerIdentityId),
        'select 1 from public.spaces where id = $1',
        [spaceId],
      );
      expect(
        bypassed.length,
        'control failed: the bypassing pool no longer sees the row — the mechanism this test guards is gone',
      ).toBeGreaterThan(0);

      // THE FIX under the production shape: same pool, same claims, through
      // the real authorizer — refused for the non-member, allowed for the
      // member. Before control.ts dropped to tm8_app inside its own
      // transaction, the first assertion answered TRUE (allow-all on every
      // existing space); recorded red on the unfixed tree.
      const authorizer = new DbSubscriptionAuthorizer(rawDb, (identity) =>
        Promise.resolve({
          identityId: identity.identityId ?? strangerIdentityId,
          nodeAdmin: false,
          requestId: `req_${randomUUID()}`,
        }),
      );
      await expect(
        authorizer.canSubscribe({ kind: 'auto-owner', identityId: strangerIdentityId }, spaceId),
      ).resolves.toBe(false);
      await expect(
        authorizer.canSubscribe({ kind: 'auto-owner', identityId: memberA.identityId }, spaceId),
      ).resolves.toBe(true);
    } finally {
      await rawDb.end();
    }
  });

  it('B4: FAIL CLOSED — an erroring check refuses, never allows', async () => {
    const before = composition.errors.length;
    // 'not-a-uuid' raises 22P02 inside the authorizer's query; the catch arm
    // must answer false and report the error, not throw and not allow.
    await expect(
      composition.authorizer.canSubscribe(
        { kind: 'auto-owner', identityId: memberA.identityId },
        'not-a-uuid',
      ),
    ).resolves.toBe(false);
    expect(composition.errors.length, 'the failure was swallowed silently').toBeGreaterThan(before);

    // An identity that cannot even produce claims is also a refusal.
    await expect(
      composition.authorizer.canSubscribe({ kind: 'auto-owner' }, spaceId),
    ).resolves.toBe(false);
  });
});
