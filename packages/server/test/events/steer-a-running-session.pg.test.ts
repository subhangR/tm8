/**
 * STEERING A RUNNING WORKER, END TO END, ON A REAL NODE.
 *
 * This file exists because a suite of green unit tests is exactly what the
 * defect survived. On 2026-08-21 a human posted two messages to a running
 * worker — one via `session_followup`, one via `messages.post` with
 * `anchorIds: [<sessionId>]`. Both returned 200 with a durable message entity.
 * Both appeared on the session in the graph. `messages.delivery.get` returned
 * `deliveries: []` for both, the session transcript never changed, and nothing
 * entered the PTY. The only honest path in the stack was `execution.dispatch`,
 * which reported `delivery: "undelivered"` for the identical failure.
 *
 * ROOT CAUSE, proven by invoking the function rather than by reading it:
 * `reserve_session_message_delivery` refused every `team_member`-authored
 * message that carried no `authored_from` edge. TM8 Chat teammates and the
 * forge watcher are authenticated Teammates that do not speak from a work
 * session and never carry that edge. Migration 168 is the repair; this file is
 * the proof it works on the real composition, and the regression net.
 *
 * WHAT THIS ASSERTS THAT THE UNIT TESTS CANNOT:
 *
 *   1. The bytes reach a REAL PTY. Not a recording double — a booted node,
 *      the full migration chain on a scratch database, `execution.spawn`
 *      through the public API, and an attached PTY WebSocket carrying the
 *      injected envelope. That is "appears in that session's transcript".
 *   2. The response TELLS THE TRUTH, in both directions. A steer that lands
 *      says `accepted`; a steer that cannot land says `undelivered` with a
 *      reason. The 200-that-means-nothing is gone.
 *
 * RUN: cd packages/server && ./node_modules/.bin/vitest run \
 *        --no-file-parallelism test/events/steer-a-running-session.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PTY_GRANT_PROTOCOL_PREFIX,
  PTY_WS_PROTOCOL,
  type MessageBatchResult,
  type StreamAttachGrant,
} from '@tm8/contract';

import { connectWs, ownerOfSpace, startWsE2eNode, type WsE2eNode } from './ws-e2e-harness.js';

// A real Postgres, a real server child, a real spawned PTY and a teardown that
// drops a database: none of that fits vitest's 5s test / 10s hook defaults.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let node: WsE2eNode;
let spaceId: string;
let projectId: string;
let teammateId: string;
const sockets: WebSocket[] = [];

const cmid = (): string => `cmid_${randomUUID()}`;

interface SpawnedSession {
  readonly sessionId: string;
  /** Every string frame and decoded binary chunk the PTY has emitted. */
  readonly output: () => string;
}

/**
 * A real worker session with a real attached terminal, and a live view of what
 * that terminal has been shown.
 */
async function spawnAttachedSession(title: string): Promise<SpawnedSession> {
  const task = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId, kind: 'task', title, clientMutationId: cmid(),
  });
  expect(task.status, JSON.stringify(task.error)).toBe(201);

  const spawned = await node.request<{ entity: { id: string } }>('POST', '/v2/execution/spawn', {
    spaceId,
    projectId,
    teamMemberId: teammateId,
    taskIds: [task.data!.entity.id],
    workdir: { mode: 'project' },
    mode: 'worker',
    clientMutationId: cmid(),
  });
  expect(spawned.status, JSON.stringify(spawned.error)).toBe(201);
  const sessionId = spawned.data!.entity.id;

  const granted = await node.request<StreamAttachGrant>(
    'POST',
    `/v2/entities/${sessionId}/commands/streams-attach`,
    { mode: 'drive', clientMutationId: cmid() },
  );
  expect(granted.status, JSON.stringify(granted.error)).toBe(200);
  const grant = granted.data!;

  const pty = new WebSocket(new URL(grant.url, node.wsUrl), [
    PTY_WS_PROTOCOL,
    `${PTY_GRANT_PROTOCOL_PREFIX}${grant.token}`,
  ]);
  sockets.push(pty);

  // Terminal output arrives as binary chunks and control frames as strings;
  // the envelope we are hunting for is echoed back by echo-agent, so both are
  // captured and concatenated rather than filtered.
  const chunks: string[] = [];
  pty.binaryType = 'arraybuffer';
  pty.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent).data;
    if (typeof data === 'string') chunks.push(data);
    else if (data instanceof ArrayBuffer) chunks.push(new TextDecoder().decode(data));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no attached frame')), 30_000);
    pty.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== 'string') return;
      if ((JSON.parse(data) as { type: string }).type === 'attached') {
        clearTimeout(timer);
        resolve();
      }
    });
    pty.addEventListener('error', () => reject(new Error('pty ws errored')), { once: true });
  });

  return { sessionId, output: () => chunks.join('') };
}

/**
 * Poll `probe` until it holds, or fail loudly with what was actually seen.
 * `refresh` runs before each check for probes that read out-of-process state.
 */
async function eventually(
  probe: () => boolean,
  describeFailure: () => string,
  timeoutMs = 30_000,
  refresh?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await refresh?.();
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${describeFailure()}`);
}

beforeAll(async () => {
  // `deliveryRuntime` is the whole point: without it `messageDelivery` is
  // undefined and every post here would report `no_delivery_runtime` — a node
  // that cannot steer a worker, which would make these assertions meaningless.
  node = await startWsE2eNode('steer', { deliveryRuntime: true });
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', {
    name: 'steer e2e space', clientMutationId: cmid(),
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  spaceId = created.data!.space.id;
  await ownerOfSpace(node.database, spaceId);

  const workdir = await mkdtemp(join(tmpdir(), 'tm8-steer-proj-'));
  const project = await node.request<{ id: string }>('POST', '/v2/projects', {
    name: `steer-${randomUUID().slice(0, 8)}`,
    workingDir: workdir,
    trust: 'trusted',
    clientMutationId: cmid(),
  });
  expect(project.status, JSON.stringify(project.error)).toBe(201);
  projectId = project.data!.id;
  const link = await node.request('POST', `/v2/spaces/${spaceId}/projects`, {
    projectId, clientMutationId: cmid(),
  });
  expect(link.status, JSON.stringify(link.error)).toBeLessThan(300);

  const member = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId, kind: 'team_member', title: 'steer agent', clientMutationId: cmid(),
  });
  expect(member.status, JSON.stringify(member.error)).toBe(201);
  teammateId = member.data!.entity.id;
});

afterAll(async () => {
  for (const ws of sockets) {
    try { ws.close(); } catch { /* already closed */ }
  }
  await node?.close();
});

describe('a message anchored to a running session reaches that session', () => {
  it('a Teammate steer with NO source session lands on the terminal and is reported accepted', async () => {
    const session = await spawnAttachedSession('steer target');

    // THE EXACT FAILING SHAPE. `actorId` is a `team_member`, and the caller is
    // an HTTP client rather than a work session — so `w2_post_message_batch`
    // writes no `authored_from` edge, which is precisely what the pre-168
    // reservation guard refused. This is what a TM8 Chat teammate posting
    // `message send --to <sessionId>` looks like at the wire.
    const marker = `steer-${randomUUID().slice(0, 8)}`;
    const posted = await node.request<MessageBatchResult>('POST', '/v2/messages', {
      anchorIds: [session.sessionId],
      body: `change of plan: ${marker}`,
      actorId: teammateId,
      clientMutationId: cmid(),
    });
    expect(posted.status, JSON.stringify(posted.error)).toBeLessThan(300);

    // HALF ONE — THE RESPONSE IS HONEST. Before this change the result was a
    // bare {messageBatchId, messages} for both success and total failure.
    expect(posted.data!.delivery, 'the post named a session, so it owes an outcome')
      .toBeDefined();
    expect(posted.data!.delivery).toEqual([
      expect.objectContaining({
        targetWorkSessionId: session.sessionId,
        status: 'accepted',
      }),
    ]);

    // HALF TWO — THE BYTES ARRIVE. This is the assertion the graph could not
    // make: `deliveries: []` and an unchanged transcript was the whole bug.
    await eventually(
      () => session.output().includes(marker),
      () => `the steer never reached the terminal; saw ${session.output().length} bytes`,
    );
    const transcript = session.output();
    expect(transcript).toContain('type="tm8.session-input"');
    expect(transcript).toContain(marker);

    // ...and it is attributed for what it is. The author is a Teammate with no
    // authoring session, so the envelope must say `recorded_only` and must NOT
    // manufacture a source session id.
    expect(transcript).toContain('attribution="recorded_only"');

    // The durable row exists and names no source session — the state that was
    // previously absent entirely.
    const rows = await node.database.query<{ status: string; src: string | null }>(
      `select status, source_work_session_id::text as src
         from public.session_message_deliveries
        where target_work_session_id = $1`,
      [session.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.src).toBeNull();

    await node.request('POST', `/v2/entities/${session.sessionId}/commands/terminate`, {
      clientMutationId: cmid(),
    });
  });

  it('a steer to a session that has exited is reported undelivered, never as success', async () => {
    // THE OTHER HALF OF THE HONESTY PROPERTY. 168 makes the legitimate steer
    // land; it must not make a steer that CANNOT land look like one that did.
    // A dead target still routes (the anchor class has no liveness filter), so
    // this is the shape most likely to be mistaken for success.
    const session = await spawnAttachedSession('steer a corpse');
    await node.request('POST', `/v2/entities/${session.sessionId}/commands/terminate`, {
      clientMutationId: cmid(),
    });

    // Wait for the durable transition rather than guessing at it: reserve()
    // reads `work_sessions.status`, so posting before it settles would test a
    // different branch than the one this case is about.
    let status = '';
    await eventually(
      () => status === 'exited' || status === 'failed',
      () => `the session never reached a terminal status (last saw "${status}")`,
      60_000,
      async () => {
        const rows = await node.database.query<{ status: string }>(
          `select status from public.work_sessions where entity_id = $1`,
          [session.sessionId],
        );
        status = rows[0]?.status ?? '';
      },
    );

    const posted = await node.request<MessageBatchResult>('POST', '/v2/messages', {
      anchorIds: [session.sessionId],
      body: 'anyone there?',
      actorId: teammateId,
      clientMutationId: cmid(),
    });
    expect(posted.status, JSON.stringify(posted.error)).toBeLessThan(300);

    // The message is still STORED — stored-first is deliberate and unchanged.
    expect(posted.data!.messageBatchId).toBeTruthy();
    // And the caller is TOLD nothing landed, instead of reading a bare 200.
    expect(posted.data!.delivery).toEqual([
      expect.objectContaining({
        targetWorkSessionId: session.sessionId,
        status: 'undelivered',
        reason: 'refused_at_reservation',
      }),
    ]);

    // SQL wrote the terminal refusal, which is what `refused_at_reservation`
    // is reporting: a visible failed row, not an absent one.
    const rows = await node.database.query<{ status: string; failure_reason: string | null }>(
      `select status, failure_reason from public.session_message_deliveries
        where target_work_session_id = $1`,
      [session.sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed_permanent');
    expect(rows[0]!.failure_reason).toBe('session_not_live');
  });
});
