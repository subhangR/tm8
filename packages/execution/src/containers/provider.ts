// @tm8/execution — the container provider SPI (TM8-CONTAINERS-DESIGN §5).
//
// One interface, one implementation per runtime, one registry per node. The
// service above is provider-agnostic and the record below is provider-agnostic;
// only `runtimeRef` and `providerState` are opaque.
//
// THE FOUR RULES THAT KEEP PROVIDERS SIMPLE, and each one is a rule because
// the alternative has already gone wrong somewhere in this repo:
//
//   * THE SERVICE OWNS THE RECORD; THE PROVIDER OWNS THE RUNTIME. A provider
//     never touches the graph. Every status it observes travels back through
//     `set_container_status`, which is the single writer — the same rule as
//     session status (R29). A provider that wrote status directly would race
//     the reconciler and the sweepers, and the guard trigger would refuse it
//     anyway.
//   * `exec` RETURNS ARGV THE NODE'S PTY HOST RUNS. The terminal surface is
//     always a node-side process (`docker exec -it`, `adb shell`, a console
//     client). That is precisely why the whole terminal path — grants, replay,
//     xterm, liveness — is reused with ZERO changes.
//   * `attach` RETURNS AN ENDPOINT ON LOOPBACK OR A UNIX SOCKET. The bridge
//     pipes bytes; it never interprets VNC, CDP or adb.
//   * LABELS ARE THE RECONCILIATION KEY. Every runtime object carries
//     `tm8.container=<entityId>`; `list()` by label is the ONLY way boot
//     reconciliation finds orphans and ghosts. A provider that forgets the
//     label produces runtimes nothing can ever adopt or clean up.

import type {
  ContainerIsolationClass,
  ContainerProfile,
  ContainerProviderDescriptor,
  ContainerSpec,
  ContainerSurfaceKind,
  ContainerUsage,
} from '@tm8/contract';

export type { ContainerProviderDescriptor, ContainerIsolationClass, ContainerProfile, ContainerSurfaceKind };

/** The label every runtime object carries, and reconciliation's only key. */
export const TM8_CONTAINER_LABEL = 'tm8.container';
export const TM8_SPACE_LABEL = 'tm8.space';
export const TM8_NODE_LABEL = 'tm8.node';

/**
 * What a provider observes about a runtime — deliberately NARROWER than
 * `ContainerStatus`. A provider knows whether a thing exists and is executing;
 * it does not know `requested`, `destroying` or `failed`, which are facts
 * about the RECORD's journey and belong to the service.
 */
export type RuntimeStatus = 'created' | 'running' | 'paused' | 'stopped' | 'gone';

export interface RuntimeHandle {
  runtimeRef: string;
  providerState: Record<string, unknown>;
}

export interface SurfaceEndpoint {
  kind: ContainerSurfaceKind;
  transport: 'tcp' | 'unix' | 'pty' | 'ws' | 'https';
  /** '127.0.0.1:59001' | '/run/x.sock' | a vendor wsEndpoint. */
  target: string;
  meta?: Record<string, unknown>;
}

export interface ExecRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  tty: boolean;
  cols?: number;
  rows?: number;
  user?: string;
}

/** What the node's PTY host spawns. Never executed inside this package. */
export interface ExecLaunch {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ProviderCtx {
  containerId: string;
  spaceId: string;
  nodeId: string;
  /** Where a provider may put per-container private state. */
  dataDir: string;
}

export interface RuntimeInspection {
  status: RuntimeStatus;
  surfaces: SurfaceEndpoint[];
  usage?: ContainerUsage;
}

export interface RuntimeListing {
  runtimeRef: string;
  labels: Record<string, string>;
  status: RuntimeStatus;
}

export interface ContainerProvider {
  readonly descriptor: ContainerProviderDescriptor;
  /**
   * THIS PROVIDER MATERIALIZES NO REAL WORKLOAD — it exists to prove the
   * service without a runtime. Only `fake` sets it.
   *
   * It exempts the provider from the isolation floor (§12.1), and that
   * exemption needs justifying rather than assuming. The floor bounds what
   * UNTRUSTED CODE CAN REACH: it demands `gvisor` for a browser because a
   * browser runs the open web, and `microvm` for `dind` because a nested
   * daemon is root-equivalent. A synthetic provider pulls no image, starts no
   * process for the workload and exposes no surface — there is no code to
   * contain, so a floor on the strength of the containment is not a weaker
   * answer to the question, it is not that question at all.
   *
   * Without this, `TM8_CONTAINER_PROVIDERS=fake` could not create so much as a
   * `shell` (the floor is `container`, `fake` is `process`), and P0's whole
   * acceptance path — create, start, stop, destroy against `fake` — would be
   * unreachable.
   *
   * IT IS NOT A POLICY SWITCH AND MUST NEVER BECOME ONE. Every provider that
   * runs anything leaves it false, so it cannot be used to lower the floor for
   * a real runtime; `ProviderRegistry` has a test pinning `fake` as the only
   * synthetic provider, so a second one cannot appear quietly.
   */
  readonly synthetic?: boolean;
  /** Materialize. Does NOT start — the saga starts separately so a create
   *  that succeeds and a start that fails are distinguishable. */
  create(spec: ContainerSpec, ctx: ProviderCtx): Promise<RuntimeHandle>;
  start(handle: RuntimeHandle): Promise<void>;
  stop(handle: RuntimeHandle, opts: { timeoutMs: number }): Promise<void>;
  pause?(handle: RuntimeHandle): Promise<void>;
  resume?(handle: RuntimeHandle): Promise<void>;
  /** IDEMPOTENT. A missing runtime is SUCCESS, not an error — compensation
   *  and the reconciler both call this on things that may already be gone. */
  destroy(handle: RuntimeHandle): Promise<void>;
  inspect(handle: RuntimeHandle): Promise<RuntimeInspection>;
  exec(handle: RuntimeHandle, req: ExecRequest): Promise<ExecLaunch>;
  attach(handle: RuntimeHandle, surface: ContainerSurfaceKind): Promise<SurfaceEndpoint>;
  snapshot?(handle: RuntimeHandle, name: string): Promise<{ image: string }>;
  fork?(handle: RuntimeHandle, spec: ContainerSpec): Promise<RuntimeHandle>;
  expose?(handle: RuntimeHandle, port: number): Promise<SurfaceEndpoint>;
  setPolicy?(handle: RuntimeHandle, network: ContainerSpec['network']): Promise<void>;
  /** BY LABEL. Reconciliation's input; see the label rule in the header. */
  list(): Promise<RuntimeListing[]>;
  events?(): AsyncIterable<{ runtimeRef: string; status: RuntimeStatus }>;
  /** Re-run the descriptor's probe BY DOING (create, run, destroy). */
  probe?(): Promise<{ ok: boolean; detail: string }>;
}
