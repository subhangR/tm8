/**
 * W5 DUO E — CAN ANY CLIENT EVER ANNOUNCE PRESENCE ON THIS NODE?
 *
 * ── WHAT QUESTION THIS FILE IS ACTUALLY ASKING ────────────────────────────
 *
 * Duo E was assigned "the half-duplex presence capability": the CLI can RECEIVE
 * presence and can never ANNOUNCE it. That half is TRUE, DELIBERATE, and
 * already settled in source — `commands/event.ts:200-206` declines to bind the
 * `presence.set` frame because `events.subscribe` is `side:'none'` in the
 * projection it must agree with, and `test/event.test.ts:632` already asserts
 * the CLI never emits one. This file does not re-derive that.
 *
 * It asks the question that assignment PRESUPPOSES an answer to, and that
 * nobody in this program has ever run: **when something OTHER than the CLI
 * announces presence, does it work?**
 *
 * That question was never asked because the CLI cannot ask it. Every existing
 * presence test drives the CLI, and the CLI is structurally incapable of
 * producing the state under test. So "presence.get returned empty" has always
 * had two causes — nobody is present, and nothing can ever BE present — and
 * every instrument pointed at it so far could see only the first.
 *
 * ── WHY THE POSITIVE CONTROL IS THE ENTIRE POINT, NOT A PRELUDE ───────────
 *
 * `presence.get` returning `{viewers: [], typingActorIds: []}` is satisfied by
 * ALL of the following, and they are not the same fact:
 *
 *   (a) nobody is present                      <- the reassuring reading
 *   (b) my socket never opened
 *   (c) my frame was refused
 *   (d) my frame was accepted and then DISCARDED at read time
 *
 * A suite that asserts "empty" proves nothing about which of these it is in.
 * So this file establishes, IN ORDER, an instrument control that kills (b), a
 * refusal control that kills (c), and only then reads the product. What is left
 * standing is the finding. Reversing that order would produce a green or a red
 * that is equally uninformative.
 *
 * ── WHAT THIS FILE CANNOT TELL YOU ────────────────────────────────────────
 *
 * It measures ONE node, booted by `main.ts` from `packages/server/dist`, with a
 * `{kind:'auto-owner'}` identity because `main.ts:213` passes no `authorize` to
 * `createWsServer`. A deployment that supplies an `authorize` resolving a real
 * `identityId` is NOT covered by anything here, and the finding below would not
 * apply to it. The claim is about the shipped composition root, not about the
 * `presence` subsystem in the abstract — those are different sentences and only
 * the first is measured.
 *
 * ── ⚠⚠ A GREEN ON THIS FILE AFTER THE `control.ts:246` FIX IS A **PARTIAL**
 *       GREEN. READ THIS BEFORE QUOTING IT AS AN ACCEPTANCE CRITERION. ──────
 *
 * THIS FILE MEASURES THE `presence.get` HALF AND NOTHING ELSE. Repairing
 * `control.ts:246` will make every red below go green, and that green means
 * exactly one thing: **an announcing client becomes visible to `presence.get`.**
 *
 * IT ASSERTS NOTHING WHATSOEVER ABOUT `tm8 event watch --presence`, WHICH IS A
 * SECOND AND INDEPENDENT BREAK IN A DIFFERENT FILE WITH A DIFFERENT CAUSE.
 * Established by Duo E's DEVELOPER and re-verified here against the tree:
 *
 *     emitter.ts:231   `publishPresence` — the ONLY production method that can
 *                      put a presence/typing event on the wire. Complete,
 *                      correct, validated, and with **ZERO callers in
 *                      `packages/server/src`** (it appears there exactly once:
 *                      its own definition). Its seven callers are all TESTS.
 *     ws-server.ts:76,176  `broadcastPresence` declared and implemented, and
 *                      consumed by nothing.
 *     control.ts:118-135   `ControlChannelDeps` has NO PUBLISHER FIELD, so the
 *                      `presence.set` branch is STRUCTURALLY INCAPABLE of
 *                      publishing — the object is not in scope. That is
 *                      stronger than "nobody calls it".
 *
 * POSITIVE CONTROL ON THAT ABSENCE CLAIM, because §7a binds any conclusion
 * resting on nothing being found: the same `rg -a` sweep returns real call
 * sites for `fanOutDurable` in three files and seven for `publishPresence` in
 * the test tree. **The production set is EMPTY, not UNSEARCHED.**
 *
 * So `event watch --presence` receives nothing on this node, ever, REGARDLESS of
 * who writes presence and REGARDLESS of whether `control.ts:246` is repaired.
 * If this file goes green and someone records "presence works", that sentence is
 * false about the channel half — which is precisely the construct this file
 * exists to refuse, committed by way of this file's own green.
 *
 * ── ⚠ ORDER-DEPENDENCE: A DEFECT THIS FILE SHIPPED, AND WHAT IT COST ──────
 *
 * RECORDED RATHER THAN QUIETLY REPAIRED, because it reached a landing gate and
 * was read as a product defect by people acting on it.
 *
 * Two tests here used to read `entityId` WITHOUT OPENING A SOCKET OF THEIR OWN,
 * after the first test had closed ITS socket. Closing a socket correctly evicts
 * the announcement — `main.ts:216-218`, `onDisconnect -> dropConnection`,
 * presence dies with the connection by design. So those two were reading an
 * entity with NO LIVE ANNOUNCER and reporting the correct empty answer as a
 * failure.
 *
 * THE COST, AND IT IS THE REASON THIS NOTE EXISTS: they were RED BEFORE the
 * `control.ts` fix for the RIGHT reason (nothing was ever stored) and RED AFTER
 * it for a COMPLETELY DIFFERENT one (the entry was correctly dropped). **RED IN
 * BOTH WORLDS, CARRYING NO INFORMATION ABOUT WHICH WORLD IT IS IN** — §9's
 * green-in-both-worlds failure inverted, in the file written to refuse exactly
 * that construct. It survived because a red is read as "the defect is still
 * there" without anyone asking WHICH defect. At the gate it was nearly banked as
 * evidence that the repair was incomplete and the defect larger than it is.
 *
 * THE INSTRUMENT LESSON, which generalises past this file: the pre-registered
 * falsifier set for this run had three branches and ALL THREE WERE ABOUT
 * PRODUCT MECHANISMS. **A FALSIFIER SET DRAWN ENTIRELY FROM ONE LAYER CANNOT
 * CATCH A DEFECT IN ANOTHER.** The true cause sat outside the partition
 * entirely, and the only thing that surfaced it was noticing that the observed
 * shape was not in the partition and asking why instead of accepting a
 * convenient enlargement of a real finding.
 *
 * Every test here now opens and HOLDS its own socket for as long as it needs the
 * announcement to be live.
 *
 * ⚠ AND WHETHER THAT SECOND BREAK IS A DEFECT AT ALL IS UNRULED. The contract
 * argues with itself: `contract.ts:329-332` says presence/typing events are
 * "CLIENT-SYNTHESIZED", which would make the absent producer CORRECT; while
 * `contract.ts:414-418` introduces `presence.set` precisely because "a
 * presence-channel TOGGLE with no presence WRITER satisfies the channel and not
 * the requirement". Routed as arbitration, not filed as a defect. Nothing in
 * this file depends on how it is ruled.
 *
 * ── THE MECHANISM, AND THE ONE LINE THAT PROVES IT WAS NOT INTENDED ───────
 *
 * SOURCE-TRACED, not measured by this file — recorded here because a reader who
 * has the red needs the cause, and because the citation is checkable in seconds:
 *
 *     main.ts:213       createWsServer({...})   NO `authorize` — only caller
 *     ws-server.ts:138  identity = opts.authorize === undefined
 *                         ? {kind:'auto-owner'} : ...      -> identityId UNDEFINED
 *     main.ts:167-170   wsClaimsFor = identity.identityId ?? resolved.identityId
 *     control.ts:246    identityId: sink.identity.identityId      <- RAW
 *     presence.ts at()  `if (entry.identityId === undefined) continue;`
 *
 * ⚠ THE PART THAT RULES OUT "undefined WAS INTENDED HERE" — contributed by Duo
 * E's DEVELOPER as second reader, and it is the strongest single fact in the
 * finding. THE SAME `presence.set` CASE BLOCK AUTHORIZES AND STORES UNDER TWO
 * DIFFERENT IDENTITIES, FIVE LINES APART:
 *
 *     control.ts:241  authorized(sink, 'presence.set', frame.spaceId)
 *                       -> DbSubscriptionAuthorizer.canSubscribe
 *                       -> control.ts:90-93  `await this.claimsFor(identity)`
 *                       == wsClaimsFor == THE RESOLVED IDENTITY, fallback applied
 *     control.ts:246  presence.set({... identityId: sink.identity.identityId })
 *                       == THE UNRESOLVED ONE. `undefined` on this node.
 *
 * So the frame is ADMITTED AS THE OWNER AND RECORDED AS NOBODY. If the raw value
 * were the intended notion of "who is present", the authorizer three lines above
 * would have used it too — and would then have REFUSED the frame outright rather
 * than accepting it. The two lines cannot both be right, and the wrong one is
 * the one with no resolver on it.
 *
 * ── ⚠ ONE THING THIS FILE DELIBERATELY DOES NOT ASSERT ────────────────────
 *
 * The developer also observed that `presence.set {viewing:false, typing:false}`
 * is a RETRACTION: `presence.ts set()` takes its first branch, deletes the
 * entry, and NEVER READS `identityId`. So in SOURCE, the only presence operation
 * that works on this node is the one that REMOVES presence.
 *
 * That is a real and useful observation and it is NOT ASSERTED HERE, because it
 * is NOT OBSERVABLE FROM THE WIRE. `presence.get` is the only read, and it
 * filters on `identityId`, so an entry that was deleted and an entry that was
 * stored-then-skipped produce the IDENTICAL empty snapshot. A test claiming to
 * witness "the retraction took effect" would be asserting something its
 * instrument cannot see — the same construct this whole file exists to refuse.
 * It is recorded as a source reading, owned by nobody's green.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bindPath } from '@tm8/contract';
import { assertBuilt, cli, startRealServer, type RealServer } from '../../integration/harness.js';

/**
 * ⚠ BOTH TIMEOUTS, SET EXPLICITLY, AND MUTATION-TESTED RATHER THAN ASSUMED.
 *
 * vitest ships two INDEPENDENT defaults — `testTimeout` 5s and `hookTimeout`
 * 10s — and an argument to `beforeAll` covers NEITHER. This suite spawns a real
 * Server (migrating a fresh database through the whole chain) in its hook and
 * several built-CLI child processes per test, so both ceilings are live.
 *
 * These numbers were mutation-tested during authoring: set to 1ms, the hook
 * aborts with "Hook timed out in 1ms" and the test with "Test timed out in 1ms".
 * A number nothing has ever failed because of is not a number in effect.
 *
 * The host has been measured swinging ~6x on identical trees under wave load
 * (standing orders §3e), so a ceiling that fits on an idle machine is not a
 * ceiling. These are deliberately far above the observed run time.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const EPOCH = '1970-01-01T00:00:00.000Z';

let server: RealServer;
let spaceId = '';
let entityId = '';

/** Everything this suite observed, printed at the end whatever the verdict. */
const measured: Record<string, unknown> = {};

/**
 * One raw WebSocket to the node's event socket, with every frame it receives
 * retained.
 *
 * Raw, not the CLI's socket, because the CLI's socket is the thing under test's
 * blind spot. The URL comes from `bindPath('events.subscribe', {})` — the same
 * catalog binding `commands/event.ts:359` uses — so this is not a hand-written
 * `/v2/ws` literal and cannot drift from the catalog independently.
 *
 * No auth headers, because the standard `WebSocket` constructor accepts none
 * and the CLI does not send any either (`event.ts:343-346`). This connection is
 * therefore identical in identity terms to the one `tm8 event watch` opens,
 * which is what makes it a valid stand-in for "some other client".
 */
async function openSocket(): Promise<{
  send(frame: unknown): void;
  received: string[];
  close(): void;
}> {
  const url = new URL(bindPath('events.subscribe', {}), server.baseUrl);
  url.protocol = 'ws:';
  const ws = new WebSocket(url.href);
  const received: string[] = [];
  ws.addEventListener('message', (e: MessageEvent) => {
    received.push(typeof e.data === 'string' ? e.data : String(e.data));
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`socket did not open at ${url.href}`)), 20_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket error')); }, { once: true });
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    received,
    close: () => ws.close(),
  };
}

/** Give the node time to apply a fire-and-forget control frame. */
async function settle(ms = 1_500): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface Snapshot {
  viewers?: unknown[];
  typingActorIds?: unknown[];
  updatedAt?: string;
}

/**
 * Create one entity over raw HTTP and return its id.
 *
 * ⚠ THE DTO SHAPE IS READ, NOT ASSUMED, AND THIS COST A SELF-CAUGHT FALSE RED.
 * The first version of the disclosure test inlined `d['id']` only, got the empty
 * string, and failed with "expected '' to be truthy" — a fixture defect that
 * presented as a product failure in the same run as three real ones. Factoring
 * the extraction into one helper is what stops the two kinds of red from being
 * authored separately and drifting apart.
 */
async function createEntity(title: string): Promise<string> {
  const res = await fetch(new URL(bindPath('entities.create', { spaceId }), server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spaceId, kind: 'task', title, clientMutationId: randomUUID() }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  const d = body.data ?? {};
  const id = (typeof d['id'] === 'string' ? d['id'] : undefined)
    ?? (typeof (d['entity'] as { id?: string })?.id === 'string' ? (d['entity'] as { id: string }).id : '');
  expect(id, `no entity id in ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();
  return id;
}

/** Read presence THROUGH THE BUILT CLI — the artifact an agent actually runs. */
async function presenceOf(id: string): Promise<{ snap: Snapshot; code: number; raw: string }> {
  const r = await cli(['presence', 'get', id, '--format', 'json'], server);
  expect(r.code, `presence get failed: ${r.stderr}`).toBe(0);
  return { snap: JSON.parse(r.stdout) as Snapshot, code: r.code, raw: r.stdout.trim() };
}

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('w5-e-presence');

  const mk = await cli(['space', 'create', 'W5E presence', '--format', 'json'], server);
  expect(mk.code, mk.stderr).toBe(0);
  const created = JSON.parse(mk.stdout) as { id?: string; space?: { id?: string } };
  spaceId = created.space?.id ?? created.id ?? '';
  expect(spaceId, `no space id in ${mk.stdout}`).toBeTruthy();

  // Seeded over raw HTTP rather than through a CLI entity command: this suite
  // owns no claim about `entity create`, and routing the fixture through
  // another duo's surface would make a failure there look like a failure here.
  entityId = await createEntity('presence target');

  measured['fixture'] = { spaceId, entityId, baseUrl: server.baseUrl };
});

afterAll(async () => {
  // Bind coherence BEFORE any number leaves this file: a suite that straddled a
  // migration landing produced a result bound to two different trees, and such a
  // number reads exactly like a good one.
  if (server !== undefined) {
    await server.assertBindCoherent().catch((e: unknown) => {
      measured['bindCoherent'] = `THREW — every number in this file is VOID: ${String(e)}`;
    });
    measured['bindStart'] = server.bindStart;
    await server.stop();
  }
  console.log('[w5-e][presence-write-path]', JSON.stringify(measured, null, 2));
});

// ── CONTROL 1: the instrument, before anything about the product ───────────

describe('CONTROL — this suite can talk to the real control channel', () => {
  /**
   * Kills cause (b). If the socket never opens, or opens somewhere that is not
   * the control channel, every "empty" below is an artifact of this file and
   * not a fact about the node. A malformed frame is used because the contract
   * guarantees an answer to it: `control.ts:261` refuses unparseable input with
   * a `control.refused` ack. Observing that ack proves the socket is connected
   * to a live control channel that is reading and answering this suite's bytes.
   */
  it('a malformed frame answers control.refused — so the socket is real and it replies', async () => {
    const sock = await openSocket();
    sock.send('not-a-frame-at-all');
    await settle();
    measured['control.malformedReply'] = sock.received;
    sock.close();

    expect(sock.received.length, 'no reply at all: this socket is not talking to a control channel').toBeGreaterThan(0);
    const acks = sock.received.map((t) => JSON.parse(t) as { type?: string });
    expect(acks.some((a) => a.type === 'control.refused')).toBe(true);
  });

  /**
   * Kills a subtler form of (b): a socket that replies to garbage but cannot
   * actually subscribe would make the presence probe below meaningless, since
   * `presence.set` is only interesting on a Space the caller may read.
   */
  it('a well-formed subscribe on this Space is NOT refused', async () => {
    const sock = await openSocket();
    sock.send({ type: 'subscribe', spaceIds: [spaceId] });
    await settle();
    measured['control.subscribeReply'] = sock.received;
    sock.close();

    const refusals = sock.received
      .map((t) => JSON.parse(t) as { type?: string; reason?: string })
      .filter((a) => a.type === 'control.refused');
    expect(refusals, `subscribe was refused: ${JSON.stringify(refusals)}`).toEqual([]);
  });
});

// ── CONTROL 2: is presence readable at all, before anyone announces ────────

describe('CONTROL — presence.get is mounted and answers, before any announcement', () => {
  /**
   * `handlers.ts:36-39` says an ABSENT presence source leaves `presence.get`
   * unmounted and the router answering 501. `main.ts:117` constructs the store
   * UNCONDITIONALLY and `main.ts:148` passes it to `registerEventHandlers`, so
   * that 501 branch is dead on any node with a database. This measures which
   * world we are in rather than assuming it — a verdict phrased "presence.get
   * answers 501" is unbound.
   *
   * ⚠ THAT SECOND CITATION READ `main.ts:94` UNTIL IT WAS CORRECTED, AND THE
   * ERROR IS INSTRUCTIVE ENOUGH TO LEAVE RECORDED: 94 is the line in the BUILT
   * `packages/server/dist/main.js`, not in the source. I had verified the claim
   * against the artifact — correctly, and deliberately, to avoid a rebuild — and
   * then cited the artifact's line number as though it were the source's. The
   * claim was true; the citation pointed somewhere that did not contain it.
   * §7b: cite the line, do not be the line — and a line number carries the file
   * it came from whether or not you write that file down.
   *
   * The structural form of this, contributed by Duo F's tester as second reader
   * and stronger than what I originally argued: the control channel IS built
   * conditionally (`main.ts:198-211`), but WHEN it is built, `presence` is a
   * BARE SHORTHAND PROPERTY at `main.ts:206` while its optional neighbours
   * (`cursors`, `highWaterMark`) are conditional spreads. The distinction is
   * structural rather than incidental, and it is the only production
   * construction site in the tree.
   */
  it('answers a real PresenceSnapshot, not a 501', async () => {
    const { snap, raw } = await presenceOf(entityId);
    measured['baseline.snapshot'] = raw;
    expect(Array.isArray(snap.viewers)).toBe(true);
    expect(Array.isArray(snap.typingActorIds)).toBe(true);
    // Nobody has announced yet, so empty here is CORRECT and is not the finding.
    expect(snap.viewers).toEqual([]);
  });
});

// ── THE PRODUCT: does an announcement from a non-CLI client take effect? ───

describe('THE WRITE PATH — a presence.set from a real client', () => {
  /**
   * ⚠ THIS IS THE ASSERTION THE WHOLE FILE EXISTS FOR.
   *
   * A client that is not the CLI announces presence on an entity, correctly, on
   * a Space it has just proven it may subscribe to. The contract's own frame,
   * the node's own socket, no fault injection and no synthetic state.
   *
   * If this passes, the assigned "half-duplex" item is exactly what it says: a
   * CLI expressiveness gap, and the channel works for everyone else.
   *
   * If it fails, the item is misnamed and the defect is larger — presence is
   * not half-duplex, it is unwritable by ANY client, and the CLI's documented
   * inability to announce is what prevented anyone from ever discovering it.
   */
  it('makes the announcing identity visible to presence.get', async () => {
    const sock = await openSocket();
    sock.send({ type: 'subscribe', spaceIds: [spaceId] });
    await settle();
    sock.send({ type: 'presence.set', spaceId, entityId, viewing: true, typing: false });
    await settle(2_500);

    // Kills cause (c) IN THE SAME RUN as the observation, not in a separate one:
    // if the node refused this frame it says so on this socket, and a refusal
    // would make an empty snapshot correct behaviour rather than a defect.
    const refusals = sock.received
      .map((t) => JSON.parse(t) as { type?: string; frame?: string; reason?: string })
      .filter((a) => a.type === 'control.refused');
    measured['presenceSet.refusals'] = refusals;
    measured['presenceSet.allFrames'] = sock.received;

    const { snap, raw } = await presenceOf(entityId);
    measured['presenceSet.snapshotAfter'] = raw;
    sock.close();

    expect(refusals, `the node REFUSED presence.set, so an empty snapshot is correct: ${JSON.stringify(refusals)}`).toEqual([]);

    // The socket held the connection open across the read, so the store cannot
    // have dropped the entry via the close path (`presence.ts dropConnection`).
    expect(
      snap.viewers,
      'presence.set was ACCEPTED (no refusal) and the announcing client is STILL not a viewer',
    ).toHaveLength(1);
  });

  /**
   * ⚠ THE DISCRIMINATOR. This is not a second symptom — it is what rules out
   * the one competing mechanism that would otherwise explain the red above.
   *
   * An empty `viewers` has TWO candidate causes inside the server, and they
   * need different fixes:
   *
   *   (d1) the entry was stored with `identityId: undefined`, so
   *        `presence.ts at()` skips it and never reports it at all.
   *   (d2) the entry was stored WITH an identity, `at()` returned it, and
   *        `handlers.ts readPresence` then filtered it out because that
   *        identity has no `members` row for the Space.
   *
   * `updatedAt` separates them, and it does so because of an ordering detail in
   * `presence.ts at()`: the `identityId === undefined` guard hits `continue`
   * BEFORE `latest` is updated. So an entry that reaches `at()` with a real
   * identity always advances `latest`, and `readPresence` carries `at.updatedAt`
   * through on BOTH of its return paths — the empty one and the filtered one.
   *
   *   observed updatedAt is a real timestamp  =>  (d2). A membership problem.
   *   observed updatedAt is the EPOCH         =>  (d1). Nothing with an identity
   *                                                was ever in the store.
   *
   * ⚠ WHAT THIS CHECK CAN BE SATISFIED BY, stated because it is genuinely
   * weaker in isolation: an entity nobody ever announced at ALSO reports the
   * epoch. This assertion means (d1) only in SEQUENCE — after the frame above
   * was proven un-refused on the same socket in the same run. Read alone it
   * proves nothing, and it must never be quoted alone.
   */
  it('reports updatedAt as the EPOCH even though an announcement was just accepted', async () => {
    // ⚠ THIS TEST OPENS ITS OWN SOCKET AND HOLDS IT, AND THAT IS A REPAIR OF A
    // REAL DEFECT IN THIS FILE — see the ORDER-DEPENDENCE note in the header.
    // It used to read `entityId` with no socket of its own, after the previous
    // test had closed ITS socket, which evicts the entry via
    // `main.ts:216-218 onDisconnect -> presence.dropConnection`. It was
    // therefore measuring an entity with no live announcer and reporting the
    // correct empty answer as a defect.
    const sock = await openSocket();
    sock.send({ type: 'subscribe', spaceIds: [spaceId] });
    await settle();
    sock.send({ type: 'presence.set', spaceId, entityId, viewing: true, typing: false });
    await settle(2_500);

    const { snap } = await presenceOf(entityId);
    measured['presenceSet.updatedAt'] = snap.updatedAt;
    sock.close();

    expect(snap.updatedAt).not.toBe(EPOCH);
  });
});

// ── EVICTION: the control the fix BOUGHT, and that this file could not run ─

describe('EVICTION — presence dies with the connection', () => {
  /**
   * ⚠ THIS ASSERTION WAS IMPOSSIBLE TO WRITE BEFORE `control.ts` WAS REPAIRED,
   * AND IT IS THE BEST CONTROL IN THIS FILE.
   *
   * Duo E's DEVELOPER proposed exactly this early — a retraction that
   * demonstrably takes effect beside an announcement that demonstrably does
   * not. I REFUSED IT AT THE TIME, correctly: with every announcement discarded
   * at read, "entry evicted" and "entry never counted" were byte-identical
   * through `presence.get`, so the assertion would have claimed to witness
   * something the instrument could not see.
   *
   * THE FIX CHANGED THAT. A live announcement is now visible, so eviction is now
   * a REAL TRANSITION between two DISTINGUISHABLE states, and the round trip
   * populated -> evicted is observable end to end for the first time.
   *
   * That it is here at all is a by-product of a DEFECT IN THIS FILE: the
   * order-dependence repaired above was accidentally demonstrating eviction
   * while reporting it as a product failure. The mechanism was real; only its
   * attribution was wrong. Writing it down deliberately is what converts an
   * accident into a control.
   *
   * ⚠ WHAT IT CAN BE SATISFIED BY, stated because "empty" is a weak observation:
   * the post-close read is empty, and empty is ALSO what a never-announced
   * entity returns. This test is only meaningful because the POPULATED read
   * immediately precedes it on the same entity in the same run — the transition
   * is the evidence, never the second reading alone.
   */
  it('a populated snapshot goes empty when the announcing socket closes', async () => {
    const target = await createEntity('eviction target');

    const sock = await openSocket();
    sock.send({ type: 'subscribe', spaceIds: [spaceId] });
    await settle();
    sock.send({ type: 'presence.set', spaceId, entityId: target, viewing: true, typing: false });
    await settle(2_500);

    const live = await presenceOf(target);
    measured['eviction.whileOpen'] = live.raw;
    expect(live.snap.viewers, 'the announcement must land before eviction can mean anything').toHaveLength(1);

    sock.close();
    await settle(2_500);

    const gone = await presenceOf(target);
    measured['eviction.afterClose'] = gone.raw;
    expect(gone.snap.viewers, 'the viewer outlived its connection').toHaveLength(0);
    expect(gone.snap.updatedAt, 'an evicted entry reports the epoch, as an unannounced one does').toBe(EPOCH);
  });
});

// ── THE DISCLOSURE GAP: what an agent can tell from the outside ────────────

describe('DISCLOSURE — what an agent can distinguish', () => {
  /**
   * The operational consequence, and the reason this is worth more than an
   * expressiveness note. `presence.get` is `available` on the availability
   * axis, and it IS available: it is mounted, it answers, it returns a
   * contract-shaped DTO, exit 0. The axis is telling the truth.
   *
   * What no axis anywhere carries is that the WRITE side cannot feed it. So an
   * agent reading `viewers: no one is present` (`commands/presence.ts:83`) is
   * handed the one sentence that file's own header says must never be produced
   * when the truth is something else — and it is produced by the NODE, not by
   * the CLI smoothing anything.
   */
  it('an entity NOBODY announced at is byte-identical to one that WAS announced at', async () => {
    const quiet = await createEntity('never announced');

    // Own socket, held across BOTH reads — same repair as the test above. The
    // comparison is only meaningful while an announcer is live; against an
    // evicted entry both sides are trivially identical and the test would pass
    // its own premise while measuring nothing.
    const sock = await openSocket();
    sock.send({ type: 'subscribe', spaceIds: [spaceId] });
    await settle();
    sock.send({ type: 'presence.set', spaceId, entityId, viewing: true, typing: false });
    await settle(2_500);

    const announced = await presenceOf(entityId);
    const untouched = await presenceOf(quiet);
    sock.close();
    measured['disclosure.announced'] = announced.raw;
    measured['disclosure.untouched'] = untouched.raw;

    // The finding in one line: these two are the same bytes, and they are not
    // the same fact. An agent cannot tell "a client is viewing this" from
    // "nothing on this node can ever be viewing this".
    expect(
      announced.raw,
      'an announced-at entity is indistinguishable from an untouched one',
    ).not.toBe(untouched.raw);
  });
});
