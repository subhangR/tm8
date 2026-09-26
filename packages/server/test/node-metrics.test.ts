/**
 * `node.metrics.get` — the status strip's host read.
 *
 * Two halves: the sampler's arithmetic (CPU delta, the macOS/Linux memory
 * parsers) and the handler's gate (human session AND node admin, with a
 * space-pinned session never holding node admin).
 */
import type { CpuInfo } from 'node:os';

import { getOperation, NodeMetricsViewSchema } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { FacadeDeps } from '../src/facade/deps.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';
import { registerNodeMetricsHandlers } from '../src/node-metrics/handlers.js';
import {
  HostMetricsSampler,
  cpuPercent,
  parseMeminfoUsedBytes,
  parseVmStatUsedBytes,
  sampleCpu,
} from '../src/node-metrics/host-metrics.js';

const cpu = (user: number, idle: number): CpuInfo => ({
  model: 'test',
  speed: 1,
  times: { user, nice: 0, sys: 0, idle, irq: 0 },
});

describe('host metrics sampler', () => {
  it('CPU busy share is the DELTA between two samples, across all cores', () => {
    const a = sampleCpu([cpu(100, 900), cpu(100, 900)], 0);
    const b = sampleCpu([cpu(175, 925), cpu(150, 950)], 1000);
    // busy: 75 + 50 = 125 of 200 elapsed ticks.
    expect(cpuPercent(a, b)).toBe(62.5);
    // No elapsed ticks is "unknown", not 0%.
    expect(cpuPercent(b, b)).toBeNull();
  });

  it('macOS: used = anonymous − purgeable + wired + compressed, in pages', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                2617.',
      'Pages inactive:                          184004.',
      'Pages wired down:                        125694.',
      'Pages purgeable:                              2.',
      'Anonymous pages:                         271046.',
      'Pages occupied by compressor:            509323.',
    ].join('\n');
    expect(parseVmStatUsedBytes(out)).toBe((271046 - 2 + 125694 + 509323) * 16384);
    // Missing the lines it needs is null — the caller falls back, never guesses.
    expect(parseVmStatUsedBytes('Pages free: 1.')).toBeNull();
  });

  it('Linux: used = MemTotal − MemAvailable (not MemFree)', () => {
    const out = 'MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    6000000 kB\n';
    expect(parseMeminfoUsedBytes(out)).toEqual({
      totalBytes: 16000000 * 1024,
      usedBytes: 10000000 * 1024,
    });
    expect(parseMeminfoUsedBytes('MemTotal: 1 kB\n')).toBeNull();
  });

  it('first read takes an in-request window; the next read differences against it', async () => {
    let t = 0;
    let ticks = 0;
    const sleeps: number[] = [];
    const sampler = new HostMetricsSampler({
      now: () => t,
      // Each call advances 100 ticks, half busy.
      cpus: () => {
        ticks += 100;
        return [cpu(ticks / 2, ticks / 2)];
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      readMemory: async () => ({ totalBytes: 100, usedBytes: 40 }),
    });
    const first = await sampler.read();
    expect(sleeps).toHaveLength(1);
    expect(first.cpu).toEqual({ percent: 50, cores: 1 });
    expect(first.memory).toEqual({ totalBytes: 100, usedBytes: 40 });
    // No dataDir → disk is null, never a made-up volume.
    expect(first.disk).toBeNull();
    expect(NodeMetricsViewSchema.safeParse(first).success).toBe(true);

    t += 5_000;
    await sampler.read();
    // A fresh previous sample: no second in-request window.
    expect(sleeps).toHaveLength(1);
  });

  it('reads the real host and answers the strict schema', async () => {
    const view = await new HostMetricsSampler({ dataDir: process.cwd() }).read();
    const parsed = NodeMetricsViewSchema.safeParse(view);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(view.memory.totalBytes).toBeGreaterThan(0);
    expect(view.memory.usedBytes).toBeLessThanOrEqual(view.memory.totalBytes);
    expect(view.disk?.totalBytes).toBeGreaterThan(0);
  });
});

describe('node.metrics.get handler gate', () => {
  const owner = {
    identityId: '00000000-0000-4000-8000-000000000001',
    accountId: '00000000-0000-4000-8000-000000000002',
    username: 'owner',
    isNodeAdmin: true,
    isOwner: true,
  };

  function handler() {
    const registry = new HandlerRegistry();
    const deps = { db: {} as never, config: {} as never, owner: async () => owner } as FacadeDeps;
    registerNodeMetricsHandlers(
      registry,
      deps,
      new HostMetricsSampler({
        sleep: async () => {},
        readMemory: async () => ({ totalBytes: 10, usedBytes: 5 }),
      }),
    );
    const h = registry.get('node.metrics.get');
    if (!h) throw new Error('node.metrics.get was not registered');
    return h;
  }

  function ctx(identity: RequestIdentity): RequestContext {
    return {
      op: getOperation('node.metrics.get'),
      opName: 'node.metrics.get',
      params: {},
      query: new URLSearchParams(),
      body: undefined,
      requestId: 'req_test',
      identity,
      headers: {},
      method: 'GET',
      path: '/v2/node/metrics',
    };
  }

  const bearer = (over: Partial<RequestIdentity>): RequestIdentity => ({
    kind: 'bearer',
    identityId: owner.identityId,
    authKind: 'browser',
    ...over,
  });

  it('the loopback owner (desktop) reads it', async () => {
    const result = (await handler()(ctx({ kind: 'auto-owner', identityId: owner.identityId, authKind: 'browser' }))) as {
      kind: string;
      data: unknown;
    };
    expect(result.kind).toBe('json');
    expect(NodeMetricsViewSchema.safeParse(result.data).success).toBe(true);
  });

  it('a node-admin human bearer reads it', async () => {
    const result = (await handler()(ctx(bearer({ nodeAdmin: true })))) as { kind: string };
    expect(result.kind).toBe('json');
  });

  it('refuses a non-admin, a space-pinned admin, an agent, and anonymous', async () => {
    const h = handler();
    await expect(h(ctx(bearer({ nodeAdmin: false })))).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'node_admin_required' },
    });
    // K6: a pinned session never holds node admin, the owner's included.
    await expect(h(ctx(bearer({ nodeAdmin: true, sessionSpaceId: '00000000-0000-4000-8000-00000000000a' })))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(h(ctx(bearer({ nodeAdmin: true, authKind: 'agent' })))).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'human_session_required' },
    });
    await expect(h(ctx({ kind: 'anonymous' }))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
