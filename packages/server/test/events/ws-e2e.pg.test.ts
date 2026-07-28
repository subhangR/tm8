/**
 * DRAFT — destined for packages/server/test/events/ws-e2e.pg.test.ts
 * (held in scratchpad while the tree is frozen; do not run from here)
 *
 * The real thing, end to end: a mutation committed through the public API of a
 * REAL booted node (production `bootstrap()`, scratch database, full migration
 * chain) must come out of a REAL WebSocket as a contract-shaped frame — via the
 * capture trigger, the durable log, the per-connection pump, and the control
 * channel's REAL DbSubscriptionAuthorizer. No fakes, no in-memory stand-ins,
 * no server-side subscription poking: every subscription here is a wire frame.
 *
 * Identity note: `main.ts` resolves every WS connection to the loopback owner
 * (wsClaimsFor), so this suite exercises the single-identity paths — the
 * subscribe/high-water/resume/gap/skip/poll-agreement/coexistence family. The
 * multi-identity properties (fan-out across members, the recipient_member_id
 * leak) are ws-e2e-multi-identity.pg.test.ts, which composes the same real
 * modules with per-connection identities.
 *
 * RUN: cd packages/server && ./node_modules/.bin/vitest run \
 *        --no-file-parallelism test/events/ws-e2e.pg.test.ts
 * (banner must show .../packages/server; PG 18 on 127.0.0.1:5442)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceEventSchema } from '@tm8/contract';

import {
  addSpaceMember,
  closed,
  collect,
  connectWs,
  ownerOfSpace,
  postMentioning,
  send,
  spine,
  startWsE2eNode,
  type WsE2eNode,
} from './ws-e2e-harness.js';

/**
 * A real Postgres, a real server child of this process, a 1s production pump
 * interval, and a teardown that drops a database: none of that fits vitest's
 * 5s test / 10s hook defaults under load. Both knobs, at file top — the two
 * are independent and a generous beforeAll argument covers neither.
 * (Precedent: packages/cli/test/integration/inbox.test.ts:39.)
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/** The production pump ticks at 1s; three ticks of silence is a real "no". */
const QUIET_MS = 3_200;

let node: WsE2eNode;
let spaceId: string;
let owner: { identityId: string; memberId: string };
const sockets: WebSocket[] = [];

/** Open + track a socket so teardown never leaks one. */
async function socket(): Promise<WebSocket> {
  const ws = await connectWs(node.wsUrl);
  sockets.push(ws);
  return ws;
}

/** Every HTTP command needs one (sec1 replay binding — 400 without it). */
const cmid = (): string => `cmid_${randomUUID()}`;

async function createTask(title: string): Promise<string> {
  const res = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId,
    kind: 'task',
    title,
    clientMutationId: cmid(),
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data!.entity.id;
}

/**
 * The FULL poll feed, walked page by page to exhaustion — never a single page.
 *
 * SEEDED-COUNT CONTROL (master ruling, W5 cursor-truncation incident: 9 rows
 * seeded, 3 returned, silent): a single `limit=500` read would silently
 * truncate the moment the log outgrew it, and every "spines agree" assertion
 * downstream would then agree on the truncation. Walking until an empty page
 * makes truncation structurally loud — a wedged cursor fails the bounded-pages
 * guard, a short page mid-walk shows up as a set mismatch against ground
 * truth (see `groundTruthSeqs`).
 */
async function pollSpine(sinceSeq = 0): Promise<Array<[number, string]>> {
  const out: Array<[number, string]> = [];
  let cursor = sinceSeq;
  for (let page = 0; page < 50; page += 1) {
    const res = await node.request<{ items: unknown[]; nextCursor: string }>(
      'GET',
      `/v2/spaces/${spaceId}/events?since=${String(cursor)}&limit=200`,
    );
    expect(res.status).toBe(200);
    if (res.data!.items.length === 0) return out;
    out.push(...spine(res.data!.items));
    cursor = Number(res.data!.nextCursor);
  }
  throw new Error('poll walk did not terminate in 50 pages — cursor is not advancing');
}

/**
 * Ground truth from the table itself (superuser read, NOT through any code
 * under test): every seq this space has ever minted, split into the rows the
 * OWNER connection may see and the recipient-targeted rows it may not. Every
 * exact-set assertion in this suite compares the wire against THIS, so a
 * truncation anywhere on the path (poll page, resume batch, pump tick) is a
 * set mismatch, never a silent pass.
 */
async function groundTruthSeqs(afterSeq = 0): Promise<{ visible: number[]; targeted: number[] }> {
  const rows = await node.database.query<{ seq: string; recipient_member_id: string | null }>(
    `select seq, recipient_member_id from public.workspace_events
      where space_id = $1 and seq > $2 order by seq asc`,
    [spaceId, afterSeq],
  );
  const visible: number[] = [];
  const targeted: number[] = [];
  for (const row of rows) {
    // The owner's connection sees the space feed plus rows addressed to the
    // owner's own member (008:156-161) — the same split RLS enforces.
    if (row.recipient_member_id === null || row.recipient_member_id === owner.memberId) {
      visible.push(Number(row.seq));
    } else {
      targeted.push(Number(row.seq));
    }
  }
  return { visible, targeted };
}

beforeAll(async () => {
  node = await startWsE2eNode('suite_a');
  // The space is created OVER HTTP so it belongs to the loopback owner — the
  // same identity every WS connection resolves to. A space created under a
  // synthetic RPC identity would be invisible to the sockets under test.
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', {
    name: 'ws e2e space',
    clientMutationId: cmid(),
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  spaceId = created.data!.space.id;
  owner = await ownerOfSpace(node.database, spaceId);
});

afterAll(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  await node?.close();
});

describe('mutation → trigger → pump → socket frame (real composition)', () => {
  it('A1: subscribe seeds at the high-water mark — history is NOT replayed, live mutations arrive', async () => {
    // History exists BEFORE the socket does.
    await createTask('pre-existing history');

    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });

    // The contract's "subscribe starts at NOW": nothing of the retained log
    // may arrive. Bounded at three pump ticks so silence is a measurement,
    // not an accident of timing.
    await frames.expectQuiet(QUIET_MS);

    // Now a live mutation. The ONLY thing done to produce a frame is the
    // public API call; if a frame arrives, it arrived through the trigger,
    // the log, the pump, and the socket.
    const title = `live-${randomUUID()}`;
    const taskId = await createTask(title);

    const frame = await frames.next(
      (f) => (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
        && (f as { entity: { title: string } }).entity.title === title,
    );

    // Contract-shaped on the wire, and the seq is the LOG's seq, verbatim.
    const parsed = WorkspaceEventSchema.safeParse(frame);
    expect(parsed.success, 'socket delivered an off-contract event').toBe(true);
    // The capture trigger stores the FLAT entities row image (`row_value :=
    // to_jsonb(new)`, 003:332) — and the entities row has no title column
    // (titles live in the per-kind detail tables), so the probe matches on
    // the entity ID, which the flat image does carry at top level.
    const seqRows = await node.database.query<{ seq: string }>(
      `select seq from public.workspace_events
        where space_id = $1 and event_type = 'entity.upsert'
          and payload->>'id' = $2
        order by seq asc`,
      [spaceId, taskId],
    );
    expect(seqRows.length, 'the mutation must be captured exactly once').toBe(1);
    expect((frame as { seq: number }).seq).toBe(Number(seqRows[0]!.seq));
  });

  it('A2: resume {spaceId, since} replays the log in order, then live delivery continues without gap or duplicate', async () => {
    const ws = await socket();
    const frames = collect(ws);

    // subscribe makes the connection live (registry membership + high-water
    // cursor); resume fills in the past. This is the client flow — resume
    // alone deliberately does not join the live fan-out.
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    send(ws, { type: 'resume', spaceId, since: 0 });

    const expected = await pollSpine();
    expect(expected.length).toBeGreaterThan(0);
    const last = expected[expected.length - 1]![0];
    await frames.next((f) => (f as { seq?: number }).seq === last);

    const replayed = spine(frames.all);
    // Every event exactly once, ascending — the replay agrees with the poll
    // feed about both membership and order.
    expect(replayed).toEqual(expected);

    // SEEDED-COUNT CONTROL: the wire also agrees with the TABLE. Comparing
    // replay-to-poll alone would pass if both truncated identically; the
    // superuser row count cannot.
    const truth = await groundTruthSeqs(0);
    expect(replayed.map(([s]) => s), 'the replay does not carry every row the table holds').toEqual(truth.visible);

    // Handover: exactly the new mutation's rows arrive, and no replayed seq
    // is ever re-delivered. One createTask mints SEVERAL rows (entity.upsert,
    // activity.created, …) delivered across pump ticks, so the wait is for
    // the mutation's FULL row-set (from the table), not for its first frame —
    // waiting on one frame and then demanding silence races the rest of the
    // same mutation.
    const mark = frames.all.length;
    const title = `handover-${randomUUID()}`;
    await createTask(title);
    const handoverTruth = await groundTruthSeqs(last);
    expect(handoverTruth.visible.length).toBeGreaterThan(0);
    const lastMinted = handoverTruth.visible[handoverTruth.visible.length - 1]!;
    await frames.next((f) => (f as { seq?: number }).seq === lastMinted);
    await frames.expectQuiet(QUIET_MS);
    const fresh = spine(frames.since(mark));
    expect(fresh.map(([s]) => s), 'the handover window does not match the table').toEqual(handoverTruth.visible);
    expect(fresh.every(([s]) => s > last), 'a replayed seq was delivered twice across the handover').toBe(true);
    const seqs = spine(frames.all).map(([s]) => s);
    expect(new Set(seqs).size, 'duplicate seq on the wire').toBe(seqs.length);
  });

  it('A3: the cursor advances past rows this connection cannot read (recipient-targeted), and never delivers them', async () => {
    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    await frames.expectQuiet(QUIET_MS);
    const before = await pollSpine();
    const highWater = before.length > 0 ? before[before.length - 1]![0] : 0;

    // A second member to aim a notification at. The owner's socket must never
    // see it (RLS: recipient_member_id belongs to member B).
    const memberB = await addSpaceMember(node.rpcDb, spaceId, owner.identityId, 'Member B');
    const anchor = await createTask('anchor for mention');

    // In seq order: [ …task events…, notification.created@B, …, task T2 ].
    await postMentioning(
      node.rpcDb,
      owner.identityId,
      owner.memberId,
      anchor,
      memberB.memberId,
      `mention-${randomUUID()}`,
    );
    const t2 = `after-the-skip-${randomUUID()}`;
    await createTask(t2);

    // The window's LAST visible row arriving proves the pump advanced PAST
    // the invisible row — a cursor that only advanced past delivered rows
    // would wedge before it. Waiting on the table's own account of the
    // window (not on t2's first frame) also drains the multi-row mutation
    // fully before the quiet check, so the assertion cannot race a tick.
    const windowTruth = await groundTruthSeqs(highWater);
    expect(windowTruth.visible.length).toBeGreaterThan(0);
    await frames.next((f) => (f as { seq?: number }).seq === windowTruth.visible[windowTruth.visible.length - 1]!);
    await frames.expectQuiet(QUIET_MS);

    // The skipped row genuinely exists in the log…
    const targeted = await node.database.query<{ seq: string }>(
      `select seq from public.workspace_events
        where space_id = $1 and recipient_member_id = $2`,
      [spaceId, memberB.memberId],
    );
    expect(targeted.length, 'fixture must produce a recipient-targeted row').toBeGreaterThan(0);
    // …and never reached this socket.
    const deliveredSeqs = new Set(spine(frames.since(0)).map(([s]) => s));
    for (const row of targeted) {
      expect(deliveredSeqs.has(Number(row.seq)), `recipient-targeted seq ${row.seq} leaked to the owner socket`).toBe(false);
    }
    // The owner MAY receive notifications addressed to the owner's own member
    // (e.g. the invite redemption above notifies the space owner) — that is
    // the two-feed contract working, not a leak. What must never appear is a
    // notification whose recipient is someone else.
    for (const f of frames.all) {
      if (!String((f as { type?: string }).type).startsWith('notification.')) continue;
      const recipient = (f as { notification: { recipient: { id: string } } }).notification.recipient.id;
      expect(recipient, "another member's notification reached the owner socket").toBe(owner.memberId);
    }

    // And everything it DID deliver is exactly the owner's poll view of the
    // same window — the two delivery paths share one spine…
    const polled = (await pollSpine(highWater));
    expect(spine(frames.all)).toEqual(polled);
    // …and BOTH match the table's own account of the window (seeded-count
    // control): visible rows all delivered, targeted rows all withheld.
    const truth = await groundTruthSeqs(highWater);
    expect(spine(frames.all).map(([s]) => s)).toEqual(truth.visible);
    expect(truth.targeted.length).toBe(targeted.length);
  });

  it('A4: reconnect after a gap — resume-by-seq recovers exactly the missed events, no loss, no duplicates', async () => {
    // Session 1: subscribe, observe one full mutation, remember the seq, drop.
    // The wait is for the mutation's FULL row-set from the table — one
    // createTask mints several rows across pump ticks, and waiting on the
    // first frame then demanding silence races the rest (the A2 lesson).
    const preMark = await node.database.query<{ seq: string }>(
      'select coalesce(max(seq), 0) as seq from public.workspace_events where space_id = $1',
      [spaceId],
    );
    const markSeq = Number(preMark[0]!.seq);
    const ws1 = await socket();
    const frames1 = collect(ws1);
    send(ws1, { type: 'subscribe', spaceIds: [spaceId] });
    const t0 = `before-drop-${randomUUID()}`;
    await createTask(t0);
    const seenTruth = await groundTruthSeqs(markSeq);
    expect(seenTruth.visible.length).toBeGreaterThan(0);
    const lastSeen = seenTruth.visible[seenTruth.visible.length - 1]!;
    await frames1.next((f) => (f as { seq?: number }).seq === lastSeen);
    await frames1.expectQuiet(QUIET_MS);
    ws1.close();
    await closed(ws1);

    // The gap: mutations while no socket exists.
    const missedA = `missed-${randomUUID()}`;
    const missedB = `missed-${randomUUID()}`;
    await createTask(missedA);
    await createTask(missedB);

    // Session 2: resume from the last seen seq, then subscribe for live.
    const ws2 = await socket();
    const frames2 = collect(ws2);
    send(ws2, { type: 'resume', spaceId, since: lastSeen });
    send(ws2, { type: 'subscribe', spaceIds: [spaceId] });

    const expected = await pollSpine(lastSeen);
    const lastMissed = expected[expected.length - 1]![0];
    await frames2.next((f) => (f as { seq?: number }).seq === lastMissed);
    await frames2.expectQuiet(QUIET_MS);

    // Exactly the missed window: same set, same order, nothing at or below
    // the cursor, no duplicates — against the poll feed AND the table itself
    // (seeded-count control: two seeded tasks, every row they minted).
    expect(spine(frames2.all)).toEqual(expected);
    expect(spine(frames2.all).every(([s]) => s > lastSeen)).toBe(true);
    const truth = await groundTruthSeqs(lastSeen);
    expect(spine(frames2.all).map(([s]) => s), 'resume lost rows the table holds for this window').toEqual(truth.visible);
    const titles = frames2.all
      .filter((f) => (f as { type?: string }).type === 'entity.upsert')
      .map((f) => (f as { entity: { title: string } }).entity.title);
    expect(titles).toContain(missedA);
    expect(titles).toContain(missedB);

    // And live continues on the resumed socket.
    const t1 = `after-recovery-${randomUUID()}`;
    await createTask(t1);
    await frames2.next(
      (f) => (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
        && (f as { entity: { title: string } }).entity.title === t1,
    );
  });

  it('A5: events.poll and the WS stream agree on one seq spine (no renumbering on the way to the socket)', async () => {
    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    send(ws, { type: 'resume', spaceId, since: 0 });

    const expected = await pollSpine();
    const last = expected[expected.length - 1]![0];
    await frames.next((f) => (f as { seq?: number }).seq === last);
    expect(spine(frames.all)).toEqual(expected);

    // Every frame on the wire validates against the contract schema — the
    // client-side tripwire, applied to the live path.
    for (const [i, frame] of frames.all.entries()) {
      if (String((frame as { type?: string }).type).startsWith('control.')) continue;
      const parsed = WorkspaceEventSchema.safeParse(frame);
      expect(parsed.success, `frame[${String(i)}] off-contract: ${JSON.stringify(frame).slice(0, 200)}`).toBe(true);
    }
  });
});

describe('control channel refusals through the real authorizer', () => {
  it('A8a: a malformed frame is answered control.refused/malformed, and the socket survives', async () => {
    const ws = await socket();
    const frames = collect(ws);
    ws.send('not json at all');
    await frames.next(
      (f) => (f as { type?: string; reason?: string }).type === 'control.refused'
        && (f as { reason: string }).reason === 'malformed',
    );
    // The same socket still works afterwards.
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    const title = `post-refusal-${randomUUID()}`;
    await createTask(title);
    await frames.next(
      (f) => (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
        && (f as { entity: { title: string } }).entity.title === title,
    );
  });

  it('A8b: subscribing to a space that does not exist is refused (DbSubscriptionAuthorizer, RLS-derived), and nothing is ever delivered for it', async () => {
    const ws = await socket();
    const frames = collect(ws);
    const ghost = randomUUID(); // valid uuid, no row — RLS answers "no such row"
    send(ws, { type: 'subscribe', spaceIds: [ghost] });
    const refusal = await frames.next(
      (f) => (f as { type?: string }).type === 'control.refused',
    );
    expect((refusal as { reason: string }).reason).toBe('forbidden');
    expect((refusal as { spaceId?: string }).spaceId).toBe(ghost);
    // A mutation in the REAL space must not arrive on a connection that only
    // asked for the ghost.
    await createTask(`not-for-this-socket-${randomUUID()}`);
    await frames.expectQuiet(QUIET_MS);
  });

  it('A8c: resume for an unreadable space is refused with NO replay frames', async () => {
    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'resume', spaceId: randomUUID(), since: 0 });
    const refusal = await frames.next((f) => (f as { type?: string }).type === 'control.refused');
    expect((refusal as { reason: string }).reason).toBe('forbidden');
    expect(spine(frames.all)).toEqual([]);
  });
});

describe('/v2/ws coexistence — events WS and PTY WS on one upgrade path', () => {
  it('A6a: a sessionId-less upgrade is the events socket (control channel answers)', async () => {
    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    const title = `events-side-${randomUUID()}`;
    await createTask(title);
    await frames.next(
      (f) => (f as { type?: string; entity?: { title?: string } }).type === 'entity.upsert'
        && (f as { entity: { title: string } }).entity.title === title,
    );
  });

  it('A6b: ?sessionId= dispatches to the PTY server — the upgrade COMPLETES, then closes 1011 for a ghost session', async () => {
    // The 101 proves the upgrade split routed to the PTY server (the events
    // server would have accepted and then treated frames as control frames);
    // the 1011 close with this reason is PtyWsServer's own ghost answer.
    const ws = await connectWs(`${node.wsUrl}?sessionId=${randomUUID()}`);
    const end = await closed(ws);
    expect(end.code).toBe(1011);
    expect(end.reason).toMatch(/no live PTY/i);
  });

  it('A6c: a REAL echo-agent PTY attach streams alongside a live events socket on the same node', async () => {
    // Events socket first — it must keep working while a PTY socket exists.
    const events = await socket();
    const eventFrames = collect(events);
    send(events, { type: 'subscribe', spaceIds: [spaceId] });

    // Spawn a real PTY through the public API (trusted project, echo agent).
    const workdir = await mkdtemp(join(tmpdir(), 'tm8-wse2e-proj-'));
    const project = await node.request<{ id: string }>('POST', '/v2/projects', {
      name: `e2e-${randomUUID().slice(0, 8)}`,
      workingDir: workdir,
      trust: 'trusted',
      clientMutationId: cmid(),
    });
    expect(project.status, JSON.stringify(project.error)).toBe(201);
    const link = await node.request('POST', `/v2/spaces/${spaceId}/projects`, {
      projectId: project.data!.id,
      clientMutationId: cmid(),
    });
    expect(link.status, JSON.stringify(link.error)).toBeLessThan(300);
    const member = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
      spaceId,
      kind: 'team_member',
      title: 'e2e agent',
      clientMutationId: cmid(),
    });
    const task = await createTask('pty coexistence task');
    const spawned = await node.request<{ entity: { id: string } }>('POST', '/v2/execution/spawn', {
      spaceId,
      projectId: project.data!.id,
      teamMemberId: member.data!.entity.id,
      taskIds: [task],
      workdir: { mode: 'project' },
      mode: 'worker',
      clientMutationId: cmid(),
    });
    expect(spawned.status, JSON.stringify(spawned.error)).toBe(201);
    const sessionId = spawned.data!.entity.id;

    // Attach: handshake-then-replay protocol, `attached` is the proof frame.
    const pty = new WebSocket(`${node.wsUrl}?sessionId=${sessionId}`);
    sockets.push(pty);
    const attached = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no attached frame')), 20_000);
      pty.addEventListener('message', (ev) => {
        const data = (ev as MessageEvent).data;
        if (typeof data !== 'string') return; // binary replay/live output
        const frame = JSON.parse(data) as { type: string };
        if (frame.type === 'attached') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      pty.addEventListener('error', () => reject(new Error('pty ws errored')), { once: true });
    });
    expect(attached.type).toBe('attached');

    // The events socket did not blink: the spawn itself produced durable
    // events (work_session entity), and they arrive while the PTY socket is
    // open.
    await eventFrames.next((f) => {
      const t = (f as { type?: string }).type;
      return t === 'entity.upsert' || t === 'activity.created';
    });

    // Cleanup: terminate the session so teardown is not racing a live PTY.
    await node.request('POST', `/v2/entities/${sessionId}/commands/terminate`, {
      clientMutationId: cmid(),
    });
  });
});

describe('Delta 1 passthrough (the generic mapper arm, live)', () => {
  /**
   * menu.updated has NO entity row behind it: the RPC (update_space_menu,
   * authored contract-shaped at 031:822-830) writes the event payload
   * directly, and before the Delta 1 passthrough arm the mapper's default
   * case dropped it — written to the log, invisible on poll and socket
   * forever. This asserts the whole path: HTTP command → RPC-authored row →
   * passthrough projection → subscribed socket, envelope stamped and
   * clientMutationId threaded.
   */
  it('A9: menu.updated (RPC-authored, no entity row) reaches a subscribed socket end-to-end', async () => {
    const ws = await socket();
    const frames = collect(ws);
    send(ws, { type: 'subscribe', spaceIds: [spaceId] });
    await frames.expectQuiet(QUIET_MS);

    // Derive the mutation from the server's own menu — current revision,
    // its own groups reordered — so the test invents no payload shape.
    const current = await node.request<{ revision: number; groups: unknown[] }>(
      'GET',
      `/v2/spaces/${spaceId}/menu`,
    );
    expect(current.status, JSON.stringify(current.error)).toBe(200);
    const menuCmid = cmid();
    const updated = await node.request('PUT', `/v2/spaces/${spaceId}/menu`, {
      clientMutationId: menuCmid,
      expectedRevision: current.data!.revision,
      payload: { schemaVersion: 1, groups: [...current.data!.groups].reverse() },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBeLessThan(300);

    const frame = await frames.next(
      (f) => (f as { type?: string }).type === 'menu.updated'
        && (f as { clientMutationId?: string }).clientMutationId === menuCmid,
    );
    // Contract-shaped on the wire, envelope stamped by the log.
    const parsed = WorkspaceEventSchema.safeParse(frame);
    expect(parsed.success, 'menu.updated arrived off-contract').toBe(true);
    expect((frame as { spaceId: string }).spaceId).toBe(spaceId);
    expect(Number.isInteger((frame as { seq: number }).seq)).toBe(true);
    expect((frame as { menu: { revision: number } }).menu.revision).toBe(current.data!.revision + 1);

    // And the poll feed agrees: same row, same seq — the passthrough is one
    // projection serving both delivery paths.
    const polled = await pollSpine();
    expect(polled.some(([s, t]) => t === 'menu.updated' && s === (frame as { seq: number }).seq)).toBe(true);
  });
});
