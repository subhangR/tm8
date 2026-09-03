// @tm8/execution — ContainerService: the provider-agnostic half of the family.
//
// It owns the RECORD and the ORDER OF OPERATIONS; providers own runtimes and
// the graph owns truth. Every status write goes through `set_container_status`
// (the single writer, R29's shape), and every refusal is a `ContainerError`
// with a closed code the handler maps to the taxonomy.
//
// The service deliberately does NOT: touch the database directly (there is no
// driver in this package), interpret a surface protocol, or decide policy on
// its own — `requiredIsolation` and the registry decide that between them, so
// the rule is stated once and enforced at the only door that can enforce it.

import {
  type ContainerLifecycle,
  type ContainerLifecycleInput,
  type ContainerProfile,
  type ContainerProviderDescriptor,
  type ContainerShareMode,
  type ContainerSpec,
  type ContainerSpecInput,
  type ContainerStatus,
  type ContainerSurfaceKind,
} from '@tm8/contract';

import { ContainerError } from './errors.js';
import { requiredIsolation } from './policy.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import type { ContainerProvider, RuntimeHandle } from './provider.js';
import { TM8_CONTAINER_LABEL } from './provider.js';
import { provisionContainer, type ProvisionResult } from './saga.js';
import type {
  ContainerGraphAuth,
  ContainerGraphPort,
  ContainerRecord,
  NodeContainerRow,
} from './types.js';

/** §9: a profile promises surfaces and a default image. */
const PROFILE_DEFAULTS: Record<ContainerProfile, { cpus: number; memMiB: number; surfaces: ContainerSurfaceKind[] }> = {
  shell: { cpus: 1, memMiB: 1024, surfaces: ['terminal'] },
  desktop: { cpus: 2, memMiB: 4096, surfaces: ['terminal', 'screen'] },
  browser: { cpus: 2, memMiB: 4096, surfaces: ['terminal', 'screen', 'browser'] },
  android: { cpus: 4, memMiB: 6144, surfaces: ['terminal', 'screen', 'adb'] },
  ios: { cpus: 4, memMiB: 6144, surfaces: ['terminal', 'screen'] },
  dind: { cpus: 2, memMiB: 4096, surfaces: ['terminal', 'docker'] },
  custom: { cpus: 1, memMiB: 1024, surfaces: ['terminal'] },
};

const DEFAULT_LIFECYCLE: ContainerLifecycle = {
  ephemeral: true,
  ttlSeconds: null,
  idleHibernateSeconds: null,
  graceSeconds: 600,
  snapshotOnStop: false,
};

export interface ContainerServiceConfig {
  nodeId: string;
  /** TM8_CONTAINER_CAP — live containers per node. */
  cap: number;
  /** TM8_CONTAINER_DATA_DIR. */
  dataDir: string;
  /** Node-wide start budget; android overrides to 300_000 (§8.4). */
  startTimeoutMs?: number;
  /** TM8_CONTAINER_KEEP_FAILED=1 keeps a failed runtime for debugging. */
  keepFailed?: boolean;
  /** Docker Desktop's VM is a host boundary Linux nodes do not have (§12.1). */
  hostVmBoundary?: boolean;
}

export interface ContainerServiceDeps {
  graph: ContainerGraphPort;
  registry: ProviderRegistry;
  config: ContainerServiceConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface CreateContainerRequest {
  auth: ContainerGraphAuth;
  spaceId: string;
  clientMutationId: string;
  profile: ContainerProfile;
  title?: string | null;
  provider?: string | null;
  nodeId?: string | null;
  image?: string | null;
  spec?: ContainerSpecInput;
  lifecycle?: ContainerLifecycleInput;
  shareMode?: ContainerShareMode;
  parentId?: string | null;
  templateId?: string | null;
  projectId?: string | null;
  projectTrust?: 'trusted' | 'untrusted' | null;
  confirmUntrusted?: boolean;
  bypassPermissions?: boolean;
  start?: boolean;
  actorId?: string | null;
  spawnedBy?: string | null;
}

export interface LifecycleRequest {
  auth: ContainerGraphAuth;
  containerId: string;
  clientMutationId: string;
  expectedVersion: number;
  timeoutMs?: number;
  actorId?: string | null;
}

export interface ReconcileRepair {
  containerId: string;
  observed: string;
  action: string;
}

export interface ReconcileReport {
  nodeId: string;
  repairs: ReconcileRepair[];
  /** Runtimes carrying our label with no record — adopted or destroyed. */
  orphans: string[];
  /** Runtimes we did not label. RECORDED, NEVER TOUCHED. */
  quarantined: string[];
  failures: Array<{ containerId: string | null; detail: string }>;
}

/** How long a container may sit in `provisioning` before it is declared dead. */
const PROVISIONING_GRACE_MS = 15 * 60 * 1000;

export class ContainerService {
  private readonly graph: ContainerGraphPort;

  private readonly registry: ProviderRegistry;

  private readonly config: ContainerServiceConfig;

  private readonly now: () => number;

  private readonly sleep?: (ms: number) => Promise<void>;

  private readonly log?: (message: string, detail?: Record<string, unknown>) => void;

  constructor(deps: ContainerServiceDeps) {
    this.graph = deps.graph;
    this.registry = deps.registry;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep;
    this.log = deps.log;
  }

  providers(): ContainerProviderDescriptor[] {
    return this.registry.descriptors();
  }

  async probeProviders(): Promise<ContainerProviderDescriptor[]> {
    return this.registry.probeAll(() => new Date(this.now()));
  }

  async create(req: CreateContainerRequest): Promise<ProvisionResult> {
    const nodeId = req.nodeId ?? this.config.nodeId;

    // The same gate `execution.spawn` draws. An untrusted project mounted
    // read-write into a machine an agent drives is the exfiltration case, and
    // consent must be explicit rather than implied by having passed an id.
    if (req.projectTrust === 'untrusted' && req.confirmUntrusted !== true) {
      throw new ContainerError(
        'this project is untrusted; pass confirmUntrusted to mount it',
        'forbidden',
        { projectId: req.projectId },
      );
    }

    const spec = this.resolveSpec(req);

    // §12.1, evaluated at create and RECORDED, so a later read reports what was
    // decided rather than what today's policy would decide.
    const policy = requiredIsolation({
      profile: req.profile,
      network: spec.network.preset,
      projectTrust: req.projectTrust ?? null,
      bypassPermissions: req.bypassPermissions,
      hostVmBoundary: this.config.hostVmBoundary,
    });

    const selection = this.registry.select({
      profile: req.profile,
      requested: req.provider,
      minimumIsolation: policy.minimum,
    });

    const lifecycle: ContainerLifecycle = { ...DEFAULT_LIFECYCLE, ...req.lifecycle };

    return provisionContainer(
      { graph: this.graph, now: this.now, sleep: this.sleep, log: this.log },
      {
        auth: req.auth,
        provider: selection.provider,
        startTimeoutMs: this.startBudgetFor(req.profile),
        start: req.start ?? true,
        dataDir: this.config.dataDir,
        actorId: req.actorId,
        keepFailed: this.config.keepFailed === true,
        create: {
          spaceId: req.spaceId,
          title: req.title ?? defaultTitle(req.profile),
          actorId: req.actorId ?? null,
          profile: req.profile,
          provider: selection.descriptor.id,
          isolation: selection.descriptor.isolation,
          nodeId,
          image: req.image ?? spec.image ?? '',
          spec,
          lifecycle,
          shareMode: req.shareMode ?? 'none',
          parentId: req.parentId ?? null,
          projectId: req.projectId ?? null,
          templateId: req.templateId ?? null,
          spawnedBy: req.spawnedBy ?? null,
          // The cap travels to the door, which enforces it INSIDE the
          // transaction. A check here would be advisory: two servers on one
          // node would both read a free slot and both create.
          cap: this.config.cap,
          clientMutationId: req.clientMutationId,
        },
      },
    );
  }

  async start(req: LifecycleRequest): Promise<void> {
    const { record, provider, handle } = await this.resolveRuntime(req.auth, req.containerId);
    this.assertStatus(record, ['stopped'], 'start');
    await provider.start(handle);
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'running',
      runtimeRef: record.runtimeRef,
      actorId: req.actorId ?? null,
      operation: 'containers.start',
      expectedVersion: req.expectedVersion,
      clientMutationId: req.clientMutationId,
    });
  }

  async stop(req: LifecycleRequest): Promise<void> {
    const { record, provider, handle } = await this.resolveRuntime(req.auth, req.containerId);
    this.assertStatus(record, ['running', 'paused'], 'stop');
    // `stopping` first, then `stopped`: the intermediate state is what the
    // panel renders and what stops a second stop from racing this one.
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'stopping',
      actorId: req.actorId ?? null,
      operation: 'containers.stop',
      expectedVersion: req.expectedVersion,
      clientMutationId: req.clientMutationId,
    });
    await provider.stop(handle, { timeoutMs: req.timeoutMs ?? 30_000 });
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'stopped',
      operation: null,
      clientMutationId: null,
    });
  }

  async pause(req: LifecycleRequest): Promise<void> {
    const { record, provider, handle } = await this.resolveRuntime(req.auth, req.containerId);
    this.assertStatus(record, ['running'], 'pause');
    if (!provider.pause) {
      throw new ContainerError(
        `the ${record.provider} provider cannot pause a container`,
        'no_provider',
        { provider: record.provider },
      );
    }
    await provider.pause(handle);
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'paused',
      actorId: req.actorId ?? null,
      operation: 'containers.pause',
      expectedVersion: req.expectedVersion,
      clientMutationId: req.clientMutationId,
    });
  }

  async resume(req: LifecycleRequest): Promise<void> {
    const { record, provider, handle } = await this.resolveRuntime(req.auth, req.containerId);
    this.assertStatus(record, ['paused'], 'resume');
    if (!provider.resume) {
      throw new ContainerError(
        `the ${record.provider} provider cannot resume a container`,
        'no_provider',
        { provider: record.provider },
      );
    }
    await provider.resume(handle);
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'running',
      actorId: req.actorId ?? null,
      operation: 'containers.resume',
      expectedVersion: req.expectedVersion,
      clientMutationId: req.clientMutationId,
    });
  }

  async destroy(req: LifecycleRequest & { force?: boolean }): Promise<void> {
    const { record, provider, handle } = await this.resolveRuntime(req.auth, req.containerId, {
      allowMissingRuntime: true,
    });
    if (record.status === 'destroyed') return;   // terminal and idempotent
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'destroying',
      actorId: req.actorId ?? null,
      operation: 'containers.destroy',
      expectedVersion: req.expectedVersion,
      clientMutationId: req.clientMutationId,
    });
    if (handle) {
      // `destroy` is idempotent by contract — a missing runtime is success —
      // so a record whose runtime is already gone still reaches `destroyed`
      // rather than getting stuck in `destroying` forever.
      await provider.destroy(handle);
    }
    await this.graph.setContainerStatus(req.auth, {
      containerId: req.containerId,
      status: 'destroyed',
      operation: null,
      clientMutationId: null,
    });
  }

  /**
   * Boot reconciliation (§11.3), beside `reconcileNodeGhosts` and
   * `reconcileNodeWorktrees` — and it follows their third rule: IT NEVER
   * THROWS. Reconciliation is cleanup, not a precondition for serving traffic,
   * so every repair is guarded individually and failures are reported in the
   * record instead of aborting the sweep.
   *
   * ADOPTION IS BY LABEL. `provider.list()` returns runtimes with their labels;
   * `tm8.container` is what ties a runtime to a record. A runtime WITHOUT our
   * label is somebody else's and is QUARANTINED — recorded, surfaced, never
   * touched — for the same reason the worktree reconciler refuses to delete an
   * unrecognised git worktree: the daemon is shared with the user's own work.
   */
  async reconcile(auth: ContainerGraphAuth): Promise<ReconcileReport> {
    const nodeId = this.config.nodeId;
    const report: ReconcileReport = {
      nodeId, repairs: [], orphans: [], quarantined: [], failures: [],
    };

    let rows: NodeContainerRow[] = [];
    try {
      rows = await this.graph.nodeContainers(auth, nodeId);
    } catch (err) {
      report.failures.push({ containerId: null, detail: describe(err) });
      return report;
    }

    const byRuntimeRef = new Map<string, NodeContainerRow>();
    for (const row of rows) {
      if (row.runtimeRef) byRuntimeRef.set(row.runtimeRef, row);
    }

    // What the runtimes actually say, per provider.
    const live = new Map<string, { runtimeRef: string; labels: Record<string, string>; status: string; provider: ContainerProvider }>();
    for (const provider of this.registry.list()) {
      try {
        for (const listing of await provider.list()) {
          live.set(listing.runtimeRef, { ...listing, provider });
        }
      } catch (err) {
        report.failures.push({ containerId: null, detail: `${provider.descriptor.id}: ${describe(err)}` });
      }
    }

    // Direction 1: the record says something the runtime does not support.
    for (const row of rows) {
      try {
        const runtime = row.runtimeRef ? live.get(row.runtimeRef) : undefined;

        if ((row.deleted || row.status === 'destroyed') && runtime) {
          await runtime.provider.destroy({ runtimeRef: row.runtimeRef!, providerState: {} });
          report.repairs.push({
            containerId: row.containerEntityId,
            observed: 'record destroyed, runtime alive',
            action: 'destroyed the runtime',
          });
          continue;
        }

        if ((row.status === 'running' || row.status === 'paused') && !runtime) {
          // The runtime went away underneath a record that thought it was
          // live. This is the `runtime_lost` ending: exec sessions in it are
          // ended with that reason rather than looking like clean exits.
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId,
            status: 'failed',
            error: 'the runtime is gone (found by reconciliation)',
            operation: null,
            clientMutationId: null,
          });
          report.repairs.push({
            containerId: row.containerEntityId,
            observed: 'record running, runtime gone',
            action: 'failed',
          });
          continue;
        }

        if (row.status === 'provisioning' && this.olderThanGrace(row.statusChangedAt)) {
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId,
            status: 'failed',
            error: `stuck in provisioning for more than ${PROVISIONING_GRACE_MS / 60000} minutes`,
            operation: null,
            clientMutationId: null,
          });
          if (runtime) {
            await runtime.provider.destroy({ runtimeRef: row.runtimeRef!, providerState: {} });
          }
          report.repairs.push({
            containerId: row.containerEntityId,
            observed: 'stuck provisioning',
            action: 'failed and destroyed the runtime',
          });
        }
      } catch (err) {
        report.failures.push({ containerId: row.containerEntityId, detail: describe(err) });
      }
    }

    // Direction 2: a runtime with no record. THE LABEL IS THE ONLY KEY.
    for (const [runtimeRef, runtime] of live) {
      if (byRuntimeRef.has(runtimeRef)) continue;
      const labelled = runtime.labels[TM8_CONTAINER_LABEL];
      if (!labelled) {
        // Not ours. Record it, surface it, touch nothing.
        report.quarantined.push(runtimeRef);
        continue;
      }
      const adopted = rows.find((row) => row.containerEntityId === labelled);
      if (adopted) {
        // The crash window from §8.4: the runtime was created but the status
        // write did not land. Adopt it by recording the runtime we found.
        try {
          await this.graph.setContainerStatus(auth, {
            containerId: adopted.containerEntityId,
            status: 'provisioning',
            runtimeRef,
            operation: null,
            clientMutationId: null,
          });
          report.orphans.push(runtimeRef);
          report.repairs.push({
            containerId: adopted.containerEntityId,
            observed: 'runtime with our label, record had none',
            action: 'adopted the runtime',
          });
        } catch (err) {
          report.failures.push({ containerId: adopted.containerEntityId, detail: describe(err) });
        }
        continue;
      }
      // Our label, no record at all: the record is gone and the runtime is not.
      try {
        await runtime.provider.destroy({ runtimeRef, providerState: {} });
        report.orphans.push(runtimeRef);
        report.repairs.push({
          containerId: labelled,
          observed: 'runtime with our label, no record',
          action: 'destroyed the orphan',
        });
      } catch (err) {
        report.failures.push({ containerId: labelled, detail: describe(err) });
      }
    }

    return report;
  }

  /** §11.3's TTL/idle sweep. Like reconcile, it never throws. */
  async sweep(auth: ContainerGraphAuth): Promise<ReconcileRepair[]> {
    const done: ReconcileRepair[] = [];
    let due: Awaited<ReturnType<ContainerGraphPort['sweepContainers']>> = [];
    try {
      due = await this.graph.sweepContainers(auth, this.config.nodeId, new Date(this.now()));
    } catch (err) {
      this.log?.('container sweep could not read due rows', { detail: describe(err) });
      return done;
    }
    for (const row of due) {
      try {
        const { record, provider, handle } = await this.resolveRuntime(auth, row.containerEntityId);
        if (row.action === 'stop' && handle) {
          // THROUGH `stopping`, never straight to `stopped`. The guard's edge
          // table (177) has no `running -> stopped` edge, so the direct write
          // is `23514` — and a sweeper that swallowed it would leave the
          // machine running with nothing left to retry the stop.
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId, status: 'stopping',
            operation: null, clientMutationId: null,
          });
          await provider.stop(handle, { timeoutMs: 30_000 });
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId, status: 'stopped',
            operation: null, clientMutationId: null,
          });
        } else if (row.action === 'destroy' && handle) {
          // Likewise: `destroyed` is reachable ONLY through `destroying`
          // (lane A, 177). Design §11.1's ASCII sketch draws a direct
          // `stopped -> destroyed` edge; its transition TABLE does not, and
          // the table is what shipped.
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId, status: 'destroying',
            operation: null, clientMutationId: null,
          });
          await provider.destroy(handle);
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId, status: 'destroyed',
            operation: null, clientMutationId: null,
          });
        } else if (row.action === 'pause' && handle && provider.pause) {
          await provider.pause(handle);
          await this.graph.setContainerStatus(auth, {
            containerId: row.containerEntityId, status: 'paused',
            operation: null, clientMutationId: null,
          });
        } else {
          continue;
        }
        done.push({
          containerId: row.containerEntityId,
          observed: row.reason,
          action: row.action,
        });
        void record;
      } catch (err) {
        this.log?.('container sweep repair failed', {
          containerId: row.containerEntityId, detail: describe(err),
        });
      }
    }
    return done;
  }

  private startBudgetFor(profile: ContainerProfile): number {
    if (this.config.startTimeoutMs) return this.config.startTimeoutMs;
    // An emulator legitimately takes minutes to boot; holding every profile to
    // the android budget would hide a genuinely hung shell for five minutes.
    return profile === 'android' || profile === 'ios' ? 300_000 : 120_000;
  }

  private resolveSpec(req: CreateContainerRequest): ContainerSpec {
    const defaults = PROFILE_DEFAULTS[req.profile];
    const input = req.spec ?? {};
    const surfaces: ContainerSpec['surfaces'] = {};
    for (const kind of defaults.surfaces) surfaces[kind] = { enabled: true };
    return {
      profile: req.profile,
      image: req.image ?? input.image,
      cpus: input.cpus ?? defaults.cpus,
      memMiB: input.memMiB ?? defaults.memMiB,
      diskMiB: input.diskMiB,
      // R5: the HOST half of each mount is dropped here and travels to the
      // door separately, into the server-only `host_spec`. What lands on the
      // record — and therefore reaches every client — is guest-only.
      mounts: (input.mounts ?? []).map((mount) => ({ guest: mount.guest, ro: mount.ro })),
      env: input.env ?? {},
      ports: input.ports ?? [],
      network: input.network ?? { preset: 'balanced', allow: [] },
      surfaces: { ...surfaces, ...input.surfaces },
      labels: input.labels ?? {},
    };
  }

  private assertStatus(record: ContainerRecord, allowed: ContainerStatus[], verb: string): void {
    if (!allowed.includes(record.status)) {
      // The guard trigger would refuse this anyway (23514); refusing here as
      // well gives a message that names the verb and the status rather than a
      // constraint name, and does it without a round trip.
      throw new ContainerError(
        `cannot ${verb} a container that is ${record.status}`,
        'state',
        { status: record.status, allowed },
      );
    }
  }

  private olderThanGrace(statusChangedAt: string | null): boolean {
    if (!statusChangedAt) return false;
    const changed = Date.parse(statusChangedAt);
    if (Number.isNaN(changed)) return false;
    return this.now() - changed > PROVISIONING_GRACE_MS;
  }

  private async resolveRuntime(
    auth: ContainerGraphAuth,
    containerId: string,
    opts: { allowMissingRuntime?: boolean } = {},
  ): Promise<{ record: ContainerRecord; provider: ContainerProvider; handle: RuntimeHandle }> {
    const record = await this.graph.loadContainer(auth, containerId);
    if (!record) throw new ContainerError('container not found', 'not_found', { containerId });
    const provider = this.registry.get(record.provider);
    if (!provider) {
      throw new ContainerError(
        `this node has no ${record.provider} provider, so it cannot act on this container`,
        'no_provider',
        { provider: record.provider, nodeId: this.config.nodeId },
      );
    }
    if (!record.runtimeRef && !opts.allowMissingRuntime) {
      throw new ContainerError(
        'this container has no runtime yet',
        'state',
        { containerId, status: record.status },
      );
    }
    return {
      record,
      provider,
      handle: {
        runtimeRef: record.runtimeRef ?? '',
        providerState: record.providerState ?? {},
      },
    };
  }
}

function defaultTitle(profile: ContainerProfile): string {
  return `${profile} container`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
