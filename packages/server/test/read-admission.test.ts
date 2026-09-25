/**
 * READS MAY NOT TAKE THE WHOLE POOL — the gate, and the gate in the pipeline.
 *
 * The prod failure (2026-09-24): a wave of UI re-reads held all 32 pooled
 * connections for seconds and `execution.spawn` failed its 5s pool-acquire
 * deadline. The pipeline test below is the one that matters: with reads
 * saturated, a COMMAND must still be entered at once, and a queued read must
 * not be entered until a slot frees.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HandlerRegistry } from '../src/facade/index.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { ReadAdmission, readLimitForPool } from '../src/http/read-admission.js';

describe('readLimitForPool', () => {
  it('holds a quarter of the pool (at least 2) back from reads', () => {
    expect(readLimitForPool(32)).toBe(24);
    expect(readLimitForPool(8)).toBe(6);
    expect(readLimitForPool(4)).toBe(2);
    expect(readLimitForPool(2)).toBe(1);
    expect(readLimitForPool(1)).toBe(1);
  });
});

describe('ReadAdmission', () => {
  it('admits up to the limit, queues FIFO past it, hands slots over on release', async () => {
    const gate = new ReadAdmission({ limit: 2, maxWaitMs: 60_000 });
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    const order: number[] = [];
    const p3 = gate.acquire().then((r) => { order.push(3); return r; });
    const p4 = gate.acquire().then((r) => { order.push(4); return r; });
    await Promise.resolve();
    expect(gate.stats()).toMatchObject({ limit: 2, active: 2, queued: 2 });
    expect(order).toEqual([]);

    r1();
    r1(); // a double release must not free a second slot
    const r3 = await p3;
    expect(order).toEqual([3]);
    expect(gate.stats()).toMatchObject({ limit: 2, active: 2, queued: 1 });

    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    expect(gate.stats()).toMatchObject({ limit: 2, active: 0, queued: 0 });
  });

  it('refuses a read that waits past maxWaitMs as a retryable 503 with Retry-After', async () => {
    vi.useFakeTimers();
    try {
      const gate = new ReadAdmission({ limit: 1, maxWaitMs: 1_000 });
      const held = await gate.acquire();
      const waiting = gate.acquire();
      const outcome = waiting.then(() => 'admitted', (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      const err = await outcome as { code?: string; retryable?: boolean; details?: Record<string, unknown> };
      expect(err.code).toBe('upstream_unavailable');
      expect(err.retryable).toBe(true);
      expect(err.details?.reason).toBe('read_admission_timeout');
      expect(err.details?.retryAfterSeconds).toBe(1);
      // The refused waiter left the queue; the holder's release frees the slot.
      expect(gate.stats().queued).toBe(0);
      held();
      expect(gate.stats().active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

const TEST_CONFIG = {
  host: '127.0.0.1',
  port: 0,
  uiDir: undefined,
  maxBodyBytes: 1024 * 1024,
  databaseUrl: undefined,
};

describe('read admission in the HTTP pipeline', () => {
  let server: FacadeServer;
  let base: string;
  let readsEntered = 0;
  let commandsEntered = 0;
  const releaseReads: Array<() => void> = [];

  beforeAll(async () => {
    const registry = new HandlerRegistry();
    // `entities.get` is catalog kind 'read'; `auth.logout` is kind 'command'.
    registry.register('entities.get', async () => {
      readsEntered += 1;
      await new Promise<void>((r) => releaseReads.push(r));
      return { ok: true };
    });
    registry.register('auth.logout', () => {
      commandsEntered += 1;
      return { ok: true };
    });
    server = createFacadeServer({
      config: TEST_CONFIG,
      registry,
      authRateLimiter: null,
      readAdmission: new ReadAdmission({ limit: 2, maxWaitMs: 60_000 }),
    });
    base = (await server.listen()).url;
  });

  afterAll(async () => {
    for (const r of releaseReads) r();
    await server.close();
  });

  it('a command is served while reads are saturated; a queued read waits for a slot', async () => {
    const reads = [1, 2, 3].map((i) => fetch(`${base}/v2/entities/e${i}`));
    await vi.waitFor(() => expect(readsEntered).toBe(2));

    // The CONTROL for the prod failure: this would sit behind the reads if the
    // gate applied to commands, and it must not.
    const command = await fetch(`${base}/v2/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(commandsEntered).toBe(1);
    expect(command.status).toBeLessThan(500);

    // Third read is held at the gate, not in the handler.
    await new Promise((r) => setTimeout(r, 50));
    expect(readsEntered).toBe(2);

    releaseReads.shift()!();
    await vi.waitFor(() => expect(readsEntered).toBe(3));
    while (releaseReads.length > 0) releaseReads.shift()!();
    const statuses = (await Promise.all(reads)).map((r) => r.status);
    expect(statuses).toEqual([200, 200, 200]);
  });
});

/**
 * M2 (PR #769 review): A QUEUED READ WHOSE CLIENT HAS GONE IS NOT WORK.
 *
 * During an incident users reload tabs. Each reload abandons that tab's
 * queued reads and issues fresh ones; if the abandoned waiters stay queued and
 * their handlers still run once admitted, the RLS work in the queue doubles at
 * exactly the moment the gate exists to shed it. And an unbounded queue turns
 * a pile-up into memory and sockets held for up to `maxWaitMs` each.
 */
describe('ReadAdmission: abandoned waiters and a bounded queue', () => {
  it('drops a queued waiter whose signal aborts, and never grants it', async () => {
    const gate = new ReadAdmission({ limit: 1, maxWaitMs: 60_000, log: () => {} });
    const held = await gate.acquire();
    const client = new AbortController();
    let granted = false;
    const outcome = gate.acquire(client.signal).then(
      (release) => { granted = true; release(); return 'admitted'; },
      (e: unknown) => e,
    );
    await Promise.resolve();
    expect(gate.stats().queued).toBe(1);

    client.abort();
    expect(gate.stats().queued).toBe(0);
    const err = await outcome as { name?: string };
    expect(err.name).toBe('AbortError');

    // The slot goes back to the pool, not to the ghost.
    held();
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('refuses a waiter whose signal is already aborted without queueing it', async () => {
    const gate = new ReadAdmission({ limit: 1, maxWaitMs: 60_000, log: () => {} });
    const held = await gate.acquire();
    const err = await gate.acquire(AbortSignal.abort()).then(() => 'admitted', (e: unknown) => e) as { name?: string };
    expect(err.name).toBe('AbortError');
    expect(gate.stats().queued).toBe(0);
    held();
  });

  it('refuses at once, retryable with Retry-After, when the queue is full', async () => {
    const gate = new ReadAdmission({ limit: 1, maxQueue: 2, maxWaitMs: 60_000, log: () => {} });
    const held = await gate.acquire();
    const q1 = gate.acquire();
    const q2 = gate.acquire();
    await Promise.resolve();
    expect(gate.stats().queued).toBe(2);

    const err = await gate.acquire().then(() => 'admitted', (e: unknown) => e) as {
      code?: string; retryable?: boolean; details?: Record<string, unknown>;
    };
    expect(err.code).toBe('upstream_unavailable');
    expect(err.retryable).toBe(true);
    expect(err.details?.reason).toBe('read_admission_queue_full');
    expect(err.details?.retryAfterSeconds).toBe(1);
    expect(gate.stats().queued).toBe(2);

    held();
    (await q1)();
    (await q2)();
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('bounds the queue at 4x the read limit by default', () => {
    expect(new ReadAdmission({ limit: 24 }).stats().maxQueue).toBe(96);
    expect(new ReadAdmission({ limit: 1 }).stats().maxQueue).toBe(4);
  });

  it('logs queueing and refusals at most once per interval, with the counts it skipped', async () => {
    let t = 0;
    const lines: string[] = [];
    const gate = new ReadAdmission({
      limit: 1, maxQueue: 1, maxWaitMs: 60_000, now: () => t, log: (line) => lines.push(line),
    });
    const held = await gate.acquire();
    const q1 = gate.acquire();            // queued -> first line
    await gate.acquire().catch(() => {}); // refused, inside the interval -> counted, not logged
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[http\] read admission:/);

    t += 60_000;
    await gate.acquire().catch(() => {}); // refused again, interval elapsed -> second line
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('refused 2 (queue full)');

    held();
    (await q1)();
  });
});

describe('read admission in the HTTP pipeline: a client that leaves', () => {
  let server: FacadeServer;
  let base: string;
  let readsEntered = 0;
  const releaseReads: Array<() => void> = [];
  const gate = new ReadAdmission({ limit: 2, maxQueue: 1, maxWaitMs: 60_000, log: () => {} });

  beforeAll(async () => {
    const registry = new HandlerRegistry();
    registry.register('entities.get', async () => {
      readsEntered += 1;
      await new Promise<void>((r) => releaseReads.push(r));
      return { ok: true };
    });
    server = createFacadeServer({ config: TEST_CONFIG, registry, authRateLimiter: null, readAdmission: gate });
    base = (await server.listen()).url;
  });

  afterAll(async () => {
    for (const r of releaseReads) r();
    await server.close();
  });

  it('a read aborted while queued leaves the queue and its handler never runs', async () => {
    const reads = [1, 2].map((i) => fetch(`${base}/v2/entities/e${i}`));
    await vi.waitFor(() => expect(readsEntered).toBe(2));

    const client = new AbortController();
    const ghost = fetch(`${base}/v2/entities/ghost`, { signal: client.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(gate.stats().queued).toBe(1));

    client.abort();
    await ghost;
    await vi.waitFor(() => expect(gate.stats().queued).toBe(0), { timeout: 2_000 });

    while (releaseReads.length > 0) releaseReads.shift()!();
    expect((await Promise.all(reads)).map((r) => r.status)).toEqual([200, 200]);
    // Give a (wrongly) admitted ghost every chance to be entered.
    await new Promise((r) => setTimeout(r, 100));
    expect(readsEntered).toBe(2);
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('a read past a full queue is refused 503 with Retry-After; /health reports the gate', async () => {
    const reads = [1, 2, 3].map((i) => fetch(`${base}/v2/entities/f${i}`));
    await vi.waitFor(() => expect(gate.stats()).toMatchObject({ active: 2, queued: 1 }));

    const refused = await fetch(`${base}/v2/entities/overflow`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    const body = await refused.json() as { error?: { code?: string; retryable?: boolean } };
    expect(body.error?.code).toBe('upstream_unavailable');

    const health = await (await fetch(`${base}/health`)).json() as { readAdmission?: unknown };
    expect(health.readAdmission).toEqual({ limit: 2, active: 2, queued: 1, maxQueue: 1 });

    releaseReads.shift()!();
    await vi.waitFor(() => expect(releaseReads.length).toBe(2));
    while (releaseReads.length > 0) releaseReads.shift()!();
    expect((await Promise.all(reads)).map((r) => r.status)).toEqual([200, 200, 200]);
  });
});
