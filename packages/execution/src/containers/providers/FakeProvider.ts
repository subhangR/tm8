// @tm8/execution — the `fake` provider (TM8-CONTAINERS-DESIGN §5.1, row 1).
//
// A test double AND the opposite of the honest 501: it proves the whole
// service — saga, compensation, replay, cap, reconciliation — WITHOUT a
// runtime. Everything happens in memory; nothing is spawned.
//
// It is a real provider, not a mock: the service holds it through the same
// interface it holds `docker` through, so a test that passes here is a test of
// the service and not of a stub's convenient shape.
//
// It deliberately declares NO screen/browser/adb surface. That is what makes
// `TM8_CONTAINER_PROVIDERS=fake` answer `no_provider` (501) for `attach` and
// `computer` honestly, instead of pretending to serve pixels that do not
// exist.

import { randomUUID } from 'node:crypto';

import type { ContainerSpec, ContainerSurfaceKind } from '@tm8/contract';

import { ContainerError } from '../errors.js';
import {
  TM8_CONTAINER_LABEL,
  TM8_NODE_LABEL,
  TM8_SPACE_LABEL,
  type ContainerProvider,
  type ContainerProviderDescriptor,
  type ExecLaunch,
  type ExecRequest,
  type ProviderCtx,
  type RuntimeHandle,
  type RuntimeInspection,
  type RuntimeListing,
  type RuntimeStatus,
  type SurfaceEndpoint,
} from '../provider.js';

interface FakeRuntime {
  runtimeRef: string;
  labels: Record<string, string>;
  status: RuntimeStatus;
  spec: ContainerSpec;
}

export interface FakeProviderOptions {
  /** Default true. Set false to stand in for a real runtime in policy tests. */
  synthetic?: boolean;
  /** Override the declared isolation class, for policy tests. */
  isolation?: ContainerProviderDescriptor['isolation'];
  /** Override which profiles this stand-in claims to serve. */
  profiles?: ContainerProviderDescriptor['profiles'];
  /** Make a specific call throw, so compensation can be exercised. */
  failOn?: Partial<Record<'create' | 'start' | 'stop' | 'destroy' | 'inspect', ContainerError>>;
  /** Seed runtimes that the graph does not know about, for reconciliation. */
  seed?: Array<{ runtimeRef: string; labels: Record<string, string>; status: RuntimeStatus }>;
  now?: () => Date;
}

export const FAKE_PROVIDER_DESCRIPTOR: ContainerProviderDescriptor = {
  id: 'fake',
  isolation: 'process',
  profiles: ['shell', 'custom'],
  // No `screen`, no `browser`, no `adb`: see the header. `terminal` is real —
  // `exec` returns argv the PTY host can actually run.
  surfaces: ['terminal'],
  features: { pause: true, snapshot: false, fork: false, expose: false, nested: false, gpu: false },
  limits: { maxContainers: 64, maxCpus: 16, maxMemMiB: 65536 },
  probe: { ok: true, detail: 'in-memory test provider', measuredAt: new Date(0).toISOString() },
};

export class FakeProvider implements ContainerProvider {
  readonly descriptor: ContainerProviderDescriptor;

  /** See the note on `ContainerProvider.synthetic`. `fake` is the only one. */
  readonly synthetic: boolean;

  private readonly runtimes = new Map<string, FakeRuntime>();

  private readonly failOn: FakeProviderOptions['failOn'];

  private readonly now: () => Date;

  /** Every call the service made, in order — the assertion surface for tests. */
  readonly calls: string[] = [];

  constructor(options: FakeProviderOptions = {}) {
    // Tests that exercise the isolation POLICY need a provider the floor
    // actually applies to; they set `synthetic: false` (and usually an
    // `isolation`) to stand in for a real runtime.
    this.synthetic = options.synthetic ?? true;
    this.failOn = options.failOn;
    this.now = options.now ?? (() => new Date());
    this.descriptor = {
      ...FAKE_PROVIDER_DESCRIPTOR,
      isolation: options.isolation ?? FAKE_PROVIDER_DESCRIPTOR.isolation,
      profiles: options.profiles ?? FAKE_PROVIDER_DESCRIPTOR.profiles,
      probe: { ...FAKE_PROVIDER_DESCRIPTOR.probe, measuredAt: this.now().toISOString() },
    };
    for (const seeded of options.seed ?? []) {
      this.runtimes.set(seeded.runtimeRef, {
        runtimeRef: seeded.runtimeRef,
        labels: seeded.labels,
        status: seeded.status,
        spec: { profile: 'shell', cpus: 1, memMiB: 512, mounts: [], env: {}, ports: [],
          network: { preset: 'locked', allow: [] }, surfaces: {}, labels: seeded.labels },
      });
    }
  }

  private guard(call: NonNullable<keyof NonNullable<FakeProviderOptions['failOn']>>): void {
    const failure = this.failOn?.[call];
    if (failure) throw failure;
  }

  async create(spec: ContainerSpec, ctx: ProviderCtx): Promise<RuntimeHandle> {
    this.calls.push('create');
    this.guard('create');
    const runtimeRef = `fake://${randomUUID()}`;
    // THE LABEL IS THE RECONCILIATION KEY. Without `tm8.container` on the
    // runtime object, `list()` cannot tell the service which entity a runtime
    // belongs to, and reconciliation can neither adopt an orphan nor detect a
    // ghost — it would see an unrecognised runtime and, correctly, refuse to
    // touch it. This one line is what the negative control removes.
    const labels: Record<string, string> = {
      ...spec.labels,
      [TM8_CONTAINER_LABEL]: ctx.containerId,
      [TM8_SPACE_LABEL]: ctx.spaceId,
      [TM8_NODE_LABEL]: ctx.nodeId,
    };
    this.runtimes.set(runtimeRef, { runtimeRef, labels, status: 'created', spec });
    return { runtimeRef, providerState: { dataDir: ctx.dataDir } };
  }

  async start(handle: RuntimeHandle): Promise<void> {
    this.calls.push('start');
    this.guard('start');
    this.mutate(handle, 'running');
  }

  async stop(handle: RuntimeHandle, _opts: { timeoutMs: number }): Promise<void> {
    this.calls.push('stop');
    this.guard('stop');
    this.mutate(handle, 'stopped');
  }

  async pause(handle: RuntimeHandle): Promise<void> {
    this.calls.push('pause');
    this.mutate(handle, 'paused');
  }

  async resume(handle: RuntimeHandle): Promise<void> {
    this.calls.push('resume');
    this.mutate(handle, 'running');
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    this.calls.push('destroy');
    this.guard('destroy');
    // IDEMPOTENT BY CONTRACT: a missing runtime is success. Compensation and
    // the reconciler both call this on things that may already be gone, and a
    // throw here would turn cleanup into a new failure.
    this.runtimes.delete(handle.runtimeRef);
  }

  async inspect(handle: RuntimeHandle): Promise<RuntimeInspection> {
    this.calls.push('inspect');
    this.guard('inspect');
    const runtime = this.runtimes.get(handle.runtimeRef);
    if (!runtime) return { status: 'gone', surfaces: [] };
    return {
      status: runtime.status,
      surfaces: runtime.status === 'running'
        ? [{ kind: 'terminal', transport: 'pty', target: handle.runtimeRef }]
        : [],
      usage: { cpuPct: 0, memMiB: 0, diskMiB: 0 },
    };
  }

  async exec(handle: RuntimeHandle, req: ExecRequest): Promise<ExecLaunch> {
    this.calls.push('exec');
    const runtime = this.runtimes.get(handle.runtimeRef);
    if (!runtime) throw new ContainerError('runtime is gone', 'not_found');
    if (runtime.status !== 'running') {
      throw new ContainerError(`cannot exec in a ${runtime.status} container`, 'state');
    }
    // Argv the NODE runs, per the SPI's second rule — never executed here.
    return { argv: ['sh', '-c', req.argv.join(' ')], cwd: req.cwd, env: req.env };
  }

  async attach(_handle: RuntimeHandle, surface: ContainerSurfaceKind): Promise<SurfaceEndpoint> {
    this.calls.push('attach');
    // The honest refusal: this provider has no screen, so it says so rather
    // than returning an endpoint nothing is listening on.
    throw new ContainerError(
      `the fake provider has no ${surface} surface`,
      'no_provider',
      { surface, provider: 'fake' },
    );
  }

  async list(): Promise<RuntimeListing[]> {
    this.calls.push('list');
    return [...this.runtimes.values()].map((r) => ({
      runtimeRef: r.runtimeRef, labels: r.labels, status: r.status,
    }));
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'in-memory test provider' };
  }

  private mutate(handle: RuntimeHandle, status: RuntimeStatus): void {
    const runtime = this.runtimes.get(handle.runtimeRef);
    if (!runtime) throw new ContainerError('runtime is gone', 'not_found');
    runtime.status = status;
  }
}
