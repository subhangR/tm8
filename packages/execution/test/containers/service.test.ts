// ContainerService against FakeProvider (TM8-CONTAINERS-DESIGN §8.4, §11.3).
//
// The saga's happy path, its compensation, replay, the node cap, and the
// reconciliation direction that ADOPTS an orphan by label — which is the line
// this lane's negative control removes.

import { describe, expect, it } from 'vitest';

import { ContainerError } from '../../src/containers/errors.js';
import { ContainerService } from '../../src/containers/ContainerService.js';
import { ProviderRegistry } from '../../src/containers/ProviderRegistry.js';
import { FakeProvider } from '../../src/containers/providers/FakeProvider.js';
import { TM8_CONTAINER_LABEL } from '../../src/containers/provider.js';
import { FakeContainerGraph } from './fake-graph.js';

const NODE = 'node-a';
const SPACE = 'space-1';

function build(options: {
  provider?: FakeProvider;
  cap?: number;
  keepFailed?: boolean;
} = {}) {
  const graph = new FakeContainerGraph();
  const provider = options.provider ?? new FakeProvider();
  const registry = new ProviderRegistry([provider]);
  const service = new ContainerService({
    graph,
    registry,
    config: {
      nodeId: NODE,
      cap: options.cap ?? 4,
      dataDir: '/tmp/tm8-containers',
      startTimeoutMs: 1000,
      keepFailed: options.keepFailed,
    },
    sleep: async () => {},
  });
  return { graph, provider, registry, service };
}

const createReq = (over: Record<string, unknown> = {}) => ({
  auth: {},
  spaceId: SPACE,
  clientMutationId: `m-${Math.random()}`,
  profile: 'shell' as const,
  // `fake` isolates at `process`, which is below the `container` floor the
  // policy sets for a shell — so every test names the provider explicitly, the
  // way `TM8_CONTAINER_PROVIDERS=fake` does on a test node.
  provider: 'fake',
  ...over,
});

describe('the provisioning saga — happy path', () => {
  it('reserves, provisions, starts, and lands on running with its surfaces', async () => {
    const { graph, provider, service } = build();

    const result = await service.create(createReq());

    expect(result.status).toBe('running');
    expect(result.replayed).toBe(false);
    expect(result.runtimeRef).toMatch(/^fake:\/\//);
    expect(result.surfaces).toEqual(['terminal']);

    // The ORDER is the saga: create the runtime, record `provisioning` with the
    // ref, start, then `running`. A record that reached `running` without ever
    // passing through `provisioning` would mean the ref was never durable.
    expect(graph.statusWrites.map((w) => w.status)).toEqual(['provisioning', 'running']);
    expect(graph.statusWrites[0].runtimeRef).toBe(result.runtimeRef);
    expect(provider.calls).toEqual(['create', 'start', 'inspect']);
  });

  it('takes the PER-NODE lock, and only around the runtime name space', async () => {
    // The worktree saga's in-process Map is wrong here: several server
    // processes share one node and one daemon in the desktop composition.
    const { graph, service } = build();
    await service.create(createReq());
    expect(graph.lockAcquisitions).toEqual([NODE]);
  });

  it('writes the node-internal transitions with NO ledger op and NO version assert', async () => {
    // provisioning->running is not a user command: there is nothing to replay,
    // and the version the node last read is stale by definition. Passing an
    // operation or a version here is how a reconciler fights a user's verb.
    const { graph, service } = build();
    await service.create(createReq());
    for (const write of graph.statusWrites) {
      expect(write.operation).toBeNull();
      expect(write.clientMutationId).toBeNull();
      expect(write.expectedVersion ?? null).toBeNull();
    }
  });

  it('stops before running when start:false, leaving the record provisioning', async () => {
    const { provider, service } = build();
    const result = await service.create(createReq({ start: false }));
    expect(result.status).toBe('provisioning');
    expect(provider.calls).toEqual(['create']);
  });
});

describe('the provisioning saga — compensation', () => {
  it('moves the record to failed and DESTROYS the runtime when start throws', async () => {
    const provider = new FakeProvider({
      failOn: { start: new ContainerError('the daemon refused', 'runtime') },
    });
    const { graph, service } = build({ provider });

    await expect(service.create(createReq())).rejects.toThrow('the daemon refused');

    const statuses = graph.statusWrites.map((w) => w.status);
    expect(statuses).toEqual(['provisioning', 'failed']);
    // Unlike a worktree, a failed container has nothing worth preserving.
    expect(provider.calls).toContain('destroy');
    expect(await provider.list()).toHaveLength(0);
  });

  it('records the failure REASON, so the panel can say why', async () => {
    const provider = new FakeProvider({
      failOn: { start: new ContainerError('the daemon refused', 'runtime') },
    });
    const { graph, service } = build({ provider });
    await expect(service.create(createReq())).rejects.toThrow();
    const failed = graph.statusWrites.find((w) => w.status === 'failed');
    expect(failed?.error).toContain('the daemon refused');
  });

  it('KEEPS the runtime when keepFailed is set, for debugging', async () => {
    const provider = new FakeProvider({
      failOn: { start: new ContainerError('the daemon refused', 'runtime') },
    });
    const { service } = build({ provider, keepFailed: true });
    await expect(service.create(createReq())).rejects.toThrow();
    expect(provider.calls).not.toContain('destroy');
    expect(await provider.list()).toHaveLength(1);
  });

  it('reports the ORIGINAL failure even when compensation itself fails', async () => {
    // A cleanup error must never mask why provisioning failed — the caller
    // needs the first reason, not the second.
    const provider = new FakeProvider({
      failOn: {
        start: new ContainerError('the daemon refused', 'runtime'),
        destroy: new ContainerError('cleanup exploded', 'runtime'),
      },
    });
    const { service } = build({ provider });
    await expect(service.create(createReq())).rejects.toThrow('the daemon refused');
  });

  it('fails with `timeout` when the surfaces never come up', async () => {
    // "Started" is not "usable": a VNC port that never accepts would otherwise
    // hand a client a socket that closes.
    const provider = new FakeProvider();
    const { service } = build({ provider });
    // Report `created` forever — started, never ready.
    provider.start = async () => { provider.calls.push('start'); };
    await expect(service.create(createReq())).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('replay (§4.4)', () => {
  it('returns the reserved record and NEVER provisions twice', async () => {
    const { graph, provider, service } = build();
    const mutationId = 'same-mutation';

    const first = await service.create(createReq({ clientMutationId: mutationId }));
    const callsAfterFirst = [...provider.calls];

    const second = await service.create(createReq({ clientMutationId: mutationId }));

    expect(second.containerId).toBe(first.containerId);
    expect(second.replayed).toBe(true);
    // The whole point: one runtime, not two.
    expect(provider.calls).toEqual(callsAfterFirst);
    expect(await provider.list()).toHaveLength(1);
    expect(graph.rows.size).toBe(1);
  });

  it('treats a record that is past `requested` as already provisioned, even with no ledger flag', async () => {
    // The status is the more reliable signal: trusting only a `replayed` flag
    // would re-provision whenever the door could not report one.
    const { graph, provider, service } = build();
    const first = await service.create(createReq({ clientMutationId: 'm-1' }));
    graph.ledger.clear();                       // the door forgets the ledger
    const row = graph.rows.get(first.containerId)!;
    graph.ledger.set('m-1', {
      containerId: row.containerId, version: row.version, status: row.status,
      runtimeRef: row.runtimeRef, raw: {},      // note: no `replayed` flag
    });
    const before = [...provider.calls];
    const again = await service.create(createReq({ clientMutationId: 'm-1' }));
    expect(again.replayed).toBe(true);
    expect(provider.calls).toEqual(before);
  });
});

describe('the node cap (§11.4)', () => {
  it('refuses past the cap with `budget`, and the message names the cap', async () => {
    const { service } = build({ cap: 2 });
    await service.create(createReq());
    await service.create(createReq());
    await expect(service.create(createReq())).rejects.toMatchObject({ code: 'budget' });
    await expect(service.create(createReq())).rejects.toThrow(/cap of 2/);
  });

  it('frees a slot once a container is destroyed', async () => {
    const { service } = build({ cap: 1 });
    const first = await service.create(createReq());
    await expect(service.create(createReq())).rejects.toMatchObject({ code: 'budget' });
    await service.destroy({
      auth: {}, containerId: first.containerId, clientMutationId: 'd-1',
      expectedVersion: 3,
    });
    await expect(service.create(createReq())).resolves.toMatchObject({ status: 'running' });
  });
});

describe('lifecycle verbs refuse illegal transitions by name', () => {
  it('cannot start a running container, and says so', async () => {
    const { service } = build();
    const created = await service.create(createReq());
    await expect(service.start({
      auth: {}, containerId: created.containerId, clientMutationId: 's-1', expectedVersion: 3,
    })).rejects.toMatchObject({ code: 'state' });
    await expect(service.start({
      auth: {}, containerId: created.containerId, clientMutationId: 's-2', expectedVersion: 3,
    })).rejects.toThrow(/cannot start a container that is running/);
  });

  it('stop passes through `stopping` before `stopped`', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq());
    graph.statusWrites.length = 0;
    await service.stop({
      auth: {}, containerId: created.containerId, clientMutationId: 'x-1', expectedVersion: 3,
    });
    expect(graph.statusWrites.map((w) => w.status)).toEqual(['stopping', 'stopped']);
    // The USER verb carries the ledger op and the version; the follow-up
    // transition is node-internal and carries neither.
    expect(graph.statusWrites[0].operation).toBe('containers.stop');
    expect(graph.statusWrites[0].expectedVersion).toBe(3);
    expect(graph.statusWrites[1].operation).toBeNull();
  });

  it('destroy is idempotent once the record is destroyed', async () => {
    const { service } = build();
    const created = await service.create(createReq());
    await service.destroy({
      auth: {}, containerId: created.containerId, clientMutationId: 'd-1', expectedVersion: 3,
    });
    await expect(service.destroy({
      auth: {}, containerId: created.containerId, clientMutationId: 'd-2', expectedVersion: 99,
    })).resolves.toBeUndefined();
  });
});

describe('the sweeper honours the guard\'s edge table (§11.1)', () => {
  // 177 has no `running -> stopped` and no `* -> destroyed` edge: both route
  // through an intermediate state. A sweeper that wrote the terminal status
  // directly would take `23514` and leave the machine running.
  it('stops THROUGH `stopping`', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq());
    graph.sweepRows = [{ containerEntityId: created.containerId, action: 'stop', reason: 'ttl' }];
    graph.statusWrites.length = 0;
    await service.sweep({});
    expect(graph.statusWrites.map((w) => w.status)).toEqual(['stopping', 'stopped']);
  });

  it('destroys THROUGH `destroying`', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq());
    graph.sweepRows = [{ containerEntityId: created.containerId, action: 'destroy', reason: 'ttl' }];
    graph.statusWrites.length = 0;
    await service.sweep({});
    expect(graph.statusWrites.map((w) => w.status)).toEqual(['destroying', 'destroyed']);
  });

  it('writes every sweep transition as node-internal — no ledger op, no version', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq());
    graph.sweepRows = [{ containerEntityId: created.containerId, action: 'stop', reason: 'idle' }];
    graph.statusWrites.length = 0;
    await service.sweep({});
    for (const write of graph.statusWrites) {
      expect(write.operation).toBeNull();
      expect(write.clientMutationId).toBeNull();
    }
  });

  it('NEVER THROWS — a failed repair is logged, not propagated', async () => {
    const { graph, service } = build();
    graph.sweepRows = [{ containerEntityId: 'ctr-missing', action: 'stop', reason: 'ttl' }];
    await expect(service.sweep({})).resolves.toEqual([]);
  });
});

describe('reconciliation (§11.3)', () => {
  // THE NEGATIVE CONTROL'S TARGET. `tm8.container` on the runtime object is the
  // ONLY key tying a runtime to a record. Remove FakeProvider.create's label
  // and the orphan below can no longer be adopted — it is quarantined instead,
  // which is the correct behaviour for a runtime that is not ours and the
  // wrong outcome for one that is.
  it('ADOPTS a labelled orphan whose status write never landed', async () => {
    const { graph, provider, service } = build();

    // The §8.4 crash window: the runtime exists, the record does not know it.
    const created = await service.create(createReq({ start: false }));
    const row = graph.rows.get(created.containerId)!;
    const runtimeRef = row.runtimeRef!;
    row.runtimeRef = null;
    row.status = 'requested';

    const report = await service.reconcile({});

    expect(report.orphans).toContain(runtimeRef);
    expect(report.quarantined).toEqual([]);
    expect(report.repairs).toContainEqual({
      containerId: created.containerId,
      observed: 'runtime with our label, record had none',
      action: 'adopted the runtime',
    });
    // Adoption means the ref is now durable on the record.
    expect(graph.rows.get(created.containerId)!.runtimeRef).toBe(runtimeRef);

    const listing = (await provider.list()).find((r) => r.runtimeRef === runtimeRef)!;
    expect(listing.labels[TM8_CONTAINER_LABEL]).toBe(created.containerId);
  });

  it('QUARANTINES an unlabelled runtime — records it, never touches it', async () => {
    // The daemon is shared with the user's own containers, the same way the
    // repository is shared with their own git worktrees.
    const provider = new FakeProvider({
      seed: [{ runtimeRef: 'fake://somebody-elses', labels: {}, status: 'running' }],
    });
    const { service } = build({ provider });

    const report = await service.reconcile({});

    expect(report.quarantined).toEqual(['fake://somebody-elses']);
    expect(report.orphans).toEqual([]);
    expect(provider.calls).not.toContain('destroy');
    expect(await provider.list()).toHaveLength(1);
  });

  it('destroys a labelled runtime whose record is gone entirely', async () => {
    const provider = new FakeProvider({
      seed: [{
        runtimeRef: 'fake://ghost',
        labels: { [TM8_CONTAINER_LABEL]: 'ctr-does-not-exist' },
        status: 'running',
      }],
    });
    const { service } = build({ provider });
    const report = await service.reconcile({});
    expect(report.repairs).toContainEqual({
      containerId: 'ctr-does-not-exist',
      observed: 'runtime with our label, no record',
      action: 'destroyed the orphan',
    });
    expect(await provider.list()).toHaveLength(0);
  });

  it('FAILS a record that claims running when the runtime is gone', async () => {
    const { graph, provider, service } = build();
    const created = await service.create(createReq());
    // The runtime disappears underneath a live record.
    await provider.destroy({ runtimeRef: graph.rows.get(created.containerId)!.runtimeRef!, providerState: {} });

    const report = await service.reconcile({});

    expect(graph.rows.get(created.containerId)!.status).toBe('failed');
    expect(report.repairs).toContainEqual({
      containerId: created.containerId,
      observed: 'record running, runtime gone',
      action: 'failed',
    });
  });

  it('NEVER THROWS — a provider that explodes is reported, not propagated', async () => {
    // Reconciliation is cleanup, not a precondition for serving traffic.
    const provider = new FakeProvider();
    provider.list = async () => { throw new Error('daemon unreachable'); };
    const { service } = build({ provider });
    const report = await service.reconcile({});
    expect(report.failures.some((f) => f.detail.includes('daemon unreachable'))).toBe(true);
  });
});

describe('provider selection and the isolation policy (§12.1)', () => {
  /** A stand-in for a REAL runtime: the isolation floor applies to it. */
  const realish = (over: { isolation?: 'process' | 'container' | 'gvisor'; profiles?: Array<'shell' | 'browser'> } = {}) =>
    new FakeProvider({
      synthetic: false,
      isolation: over.isolation ?? 'process',
      profiles: over.profiles ?? ['shell'],
    });

  it('refuses a profile no provider serves, with `no_provider` (the honest 501)', async () => {
    const { service } = build();
    await expect(service.create(createReq({ profile: 'android', provider: null })))
      .rejects.toMatchObject({ code: 'no_provider' });
  });

  it('refuses a REAL provider that isolates below the profile floor, with `policy`', async () => {
    // A shell on a balanced network needs `container`; this stand-in is
    // `process`. `policy` is a 403 — the node COULD run it, but not at a class
    // the policy accepts — and is deliberately not the 501 `no_provider`.
    const { service } = build({ provider: realish() });
    await expect(service.create(createReq({ provider: null })))
      .rejects.toMatchObject({ code: 'policy' });
    await expect(service.create(createReq({ provider: 'fake' })))
      .rejects.toMatchObject({ code: 'policy' });
  });

  it('names the class and what would satisfy it, so the refusal is actionable', async () => {
    const { service } = build({ provider: realish() });
    await expect(service.create(createReq({ provider: 'fake' })))
      .rejects.toThrow(/isolates at process, below the container/);
  });

  it('admits a REAL provider that meets the floor', async () => {
    const { service } = build({ provider: realish({ isolation: 'container' }) });
    await expect(service.create(createReq({ provider: null })))
      .resolves.toMatchObject({ status: 'running' });
  });

  it('holds a browser to gvisor even when a container-class provider exists', async () => {
    // §12.1: a browser browses the open web by definition (D3).
    const { service } = build({
      provider: realish({ isolation: 'container', profiles: ['shell', 'browser'] }),
    });
    await expect(service.create(createReq({ profile: 'browser', provider: null })))
      .rejects.toMatchObject({ code: 'policy' });
  });

  it('refuses an untrusted project without explicit consent', async () => {
    const { service } = build();
    await expect(service.create(createReq({
      projectId: 'p-1', projectTrust: 'untrusted',
    }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.create(createReq({
      projectId: 'p-1', projectTrust: 'untrusted', confirmUntrusted: true,
    }))).resolves.toMatchObject({ status: 'running' });
  });

  it('EXEMPTS only the synthetic provider from the floor, and `fake` is the only one', async () => {
    // The exemption exists so `TM8_CONTAINER_PROVIDERS=fake` can run P0's
    // acceptance path at all. This pins that it cannot spread: a second
    // synthetic provider would be a policy hole and must be a deliberate,
    // visible change here.
    const { registry, service } = build();
    expect(registry.syntheticProviderIds()).toEqual(['fake']);
    await expect(service.create(createReq({ provider: 'fake' })))
      .resolves.toMatchObject({ status: 'running' });
  });
});

describe('the spec that reaches the record', () => {
  it('drops the HOST half of every mount (R5) and keeps the guest half', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq({
      spec: { mounts: [{ host: '/Users/me/secrets', guest: '/workspace', ro: true }] },
    }));
    const spec = graph.rows.get(created.containerId)!.spec;
    expect(spec.mounts).toEqual([{ guest: '/workspace', ro: true }]);
    expect(JSON.stringify(spec)).not.toContain('/Users/me/secrets');
  });

  it('fills profile defaults without overwriting what the caller asked for', async () => {
    const { graph, service } = build();
    const created = await service.create(createReq({ spec: { cpus: 4 } }));
    const spec = graph.rows.get(created.containerId)!.spec;
    expect(spec.cpus).toBe(4);
    expect(spec.memMiB).toBe(1024);           // the shell default
    expect(spec.surfaces.terminal).toEqual({ enabled: true });
  });
});

describe('heartbeats never touch the entity (§15)', () => {
  it('records a heartbeat without bumping the version', async () => {
    // A periodic UPDATE on the detail row would emit entity.upsert every 10 s
    // per container and starve live renames — the migration-165 lesson.
    const { graph, service } = build();
    const created = await service.create(createReq());
    const before = graph.rows.get(created.containerId)!.version;
    await graph.recordHeartbeat({}, { containerId: created.containerId, nodeId: NODE });
    expect(graph.rows.get(created.containerId)!.version).toBe(before);
    void service;
  });
});
